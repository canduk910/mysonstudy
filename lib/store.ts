/**
 * lib/store.ts — 저장 계층 (books / cards / readings)
 *
 * [M3] 두 가지 `BookCardStore` 구현을 인터페이스 뒤에서 선택한다:
 * - Firestore(Native mode, Admin SDK + ADC) — `lib/store-firestore.ts` (운영)
 * - JSON 파일(data/db.json, 이 파일) — 로컬 데모·키 없는 개발용
 *
 * 선택 규칙(`resolveStoreBackend`):
 * 1) env `STORE_BACKEND=firestore|file`이 있으면 그대로 따른다 (모르는 값은 경고 후 자동 감지)
 * 2) 없으면 자동 감지 — GCP 자격증명 신호(GOOGLE_APPLICATION_CREDENTIALS /
 *    K_SERVICE(Cloud Run) / GOOGLE_CLOUD_PROJECT)가 있으면 firestore, 없으면 file.
 *    Cloud Run에서는 설정 없이 Firestore, 로컬 무자격 환경에서는 설정 없이 파일이 된다.
 *
 * 라우트·페이지는 반드시 `getStore()`가 돌려주는 인터페이스만 사용할 것 —
 * 구현 선택이 이 파일 안에서 끝나야 라우트 코드가 백엔드를 모른 채 남는다.
 *
 * 서버 전용 모듈이다(node:fs·firebase-admin 사용) — 클라이언트 컴포넌트에서 값
 * import 금지. (타입만 필요하면 `import type`으로 가져올 것: 빌드 시 제거되어 안전하다)
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Card } from "./ai/schemas";
import { FirestoreStore } from "./store-firestore";

// ---------------------------------------------------------------------------
// 레코드 타입 (SPEC §5 데이터 모델)
// ---------------------------------------------------------------------------

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  series: string | null;
  isbn: string | null;
  arLevel: number | null;
  lexile: number | null;
  wordCount: number | null;
  arQuizNo: string | null;
  isFiction: boolean;
  topic: string;
  coverUrl: string | null;
  googleBooksId: string | null;
  /**
   * SPEC §5에는 없는 추가 필드 — §8이 "이모지 커버"를 요구하고 M2 판독 결과에
   * coverEmoji가 있어 저장할 곳이 필요하다. 빌드 리포트에 판단 근거 기록.
   */
  coverEmoji: string | null;
  /**
   * SPEC §5에는 없는 추가 필드 — 소개글(공개 description). "다시 생성" 시
   * 같은 입력(§3-2 템플릿의 googleBooksDescription)을 재사용하기 위해 보관한다.
   */
  description: string | null;
  levelEstimated: boolean;
  createdAt: string; // ISO 8601
}

export interface CardRecord {
  id: string;
  bookId: string;
  content: Card; // SPEC §6 학습 카드 JSON
  model: string;
  createdAt: string; // ISO 8601
}

/** readings — M3(서재·읽음 기록)에서 사용. M1에서는 자리만 잡아 둔다. */
export interface ReadingRecord {
  id: string;
  bookId: string;
  readAt: string; // ISO 8601
  rating: number | null; // 1~5
  noteKo: string | null;
}

export type NewBook = Omit<BookRecord, "id" | "createdAt">;
export type NewCard = Omit<CardRecord, "id" | "createdAt">;
export type NewReading = Omit<ReadingRecord, "id">;

/** 책 삭제로 함께 지워진 개수 — 삭제 완료 안내에 그대로 쓴다 */
export interface DeleteBookResult {
  cards: number;
  readings: number;
}

export interface CardWithBook {
  card: CardRecord;
  book: BookRecord;
}

// ---------------------------------------------------------------------------
// 저장 계층 인터페이스 — 라우트·페이지가 의존하는 유일한 면
// ---------------------------------------------------------------------------

export interface BookCardStore {
  createBook(input: NewBook): Promise<BookRecord>;
  getBook(id: string): Promise<BookRecord | null>;
  listBooks(): Promise<BookRecord[]>;
  /** 동일 책 재등록 감지용(SPEC §9) — 제목+저자 정규화(공백·대소문자 무시) 일치 */
  findBookByTitleAuthor(title: string, author: string): Promise<BookRecord | null>;
  /**
   * 책 삭제 — 그 책의 카드와 읽음 기록까지 **연쇄 삭제**하고 지운 개수를 돌려준다.
   * 되돌릴 수 없다(휴지통 없음 — 가족용 소규모 앱, 단순함 우선).
   * 없는 bookId면 아무것도 지우지 않고 {cards:0, readings:0}을 돌려준다
   * (존재 확인·404는 호출측 라우트의 몫 — 스토어는 "그 책과 딸린 것이 없는 상태"만 보장).
   */
  deleteBook(bookId: string): Promise<DeleteBookResult>;

  createCard(input: NewCard): Promise<CardRecord>;
  getCard(id: string): Promise<CardRecord | null>;
  /** 해당 책의 카드 목록 — 최신순 */
  listCardsForBook(bookId: string): Promise<CardRecord[]>;
  /** 홈 미리보기용 — 최신 카드 + 책 조인, 최신순 */
  listRecentCards(limit: number): Promise<CardWithBook[]>;

  // readings — M3에서 구현·사용할 자리. 인터페이스만 먼저 고정한다.
  addReading(input: NewReading): Promise<ReadingRecord>;
  listReadings(bookId?: string): Promise<ReadingRecord[]>;
}

// ---------------------------------------------------------------------------
// JSON 파일 구현 (M1 — data/db.json)
// ---------------------------------------------------------------------------

export interface DbShape {
  books: BookRecord[];
  cards: CardRecord[];
  readings: ReadingRecord[];
}

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "db.json");

function emptyDb(): DbShape {
  return { books: [], cards: [], readings: [] };
}

async function readDb(): Promise<DbShape> {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbShape>;
    return {
      books: parsed.books ?? [],
      cards: parsed.cards ?? [],
      readings: parsed.readings ?? [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyDb();
    throw err;
  }
}

async function writeDb(db: DbShape): Promise<void> {
  await fs.mkdir(DB_DIR, { recursive: true });
  const tmpPath = `${DB_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(tmpPath, DB_PATH); // 임시 파일 → 원자적 교체 (쓰다 만 파일 방지)
}

/**
 * 제목+저자 정규화 키 — 공백 합치기 + 소문자 비교.
 * 두 구현(파일·Firestore)이 같은 중복 판정을 하도록 여기서만 정의한다.
 */
export function normalizeTitleAuthorKey(title: string, author: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(title)}|${norm(author)}`;
}

function byCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

class JsonFileStore implements BookCardStore {
  /** 쓰기 직렬화 큐 — 동시 요청이 db.json을 서로 덮어쓰지 않게 한다 */
  private queue: Promise<unknown> = Promise.resolve();

  private mutate<T>(fn: (db: DbShape) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const db = await readDb();
      const result = fn(db);
      await writeDb(db);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async createBook(input: NewBook): Promise<BookRecord> {
    const record: BookRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.mutate((db) => {
      db.books.push(record);
      return record;
    });
  }

  async getBook(id: string): Promise<BookRecord | null> {
    const db = await readDb();
    return db.books.find((b) => b.id === id) ?? null;
  }

  async listBooks(): Promise<BookRecord[]> {
    const db = await readDb();
    return [...db.books].sort(byCreatedAtDesc);
  }

  async findBookByTitleAuthor(title: string, author: string): Promise<BookRecord | null> {
    const key = normalizeTitleAuthorKey(title, author);
    const db = await readDb();
    return db.books.find((b) => normalizeTitleAuthorKey(b.title, b.author) === key) ?? null;
  }

  async deleteBook(bookId: string): Promise<DeleteBookResult> {
    // 한 번의 mutate(= 읽기→변경→원자적 쓰기) 안에서 셋을 함께 지운다 —
    // 카드만 지워지고 책이 남는 중간 상태가 파일에 남지 않는다.
    return this.mutate((db) => {
      const cardsBefore = db.cards.length;
      const readingsBefore = db.readings.length;
      db.books = db.books.filter((b) => b.id !== bookId);
      db.cards = db.cards.filter((c) => c.bookId !== bookId);
      db.readings = db.readings.filter((r) => r.bookId !== bookId);
      return {
        cards: cardsBefore - db.cards.length,
        readings: readingsBefore - db.readings.length,
      };
    });
  }

  async createCard(input: NewCard): Promise<CardRecord> {
    const record: CardRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.mutate((db) => {
      db.cards.push(record);
      return record;
    });
  }

  async getCard(id: string): Promise<CardRecord | null> {
    const db = await readDb();
    return db.cards.find((c) => c.id === id) ?? null;
  }

  async listCardsForBook(bookId: string): Promise<CardRecord[]> {
    const db = await readDb();
    return db.cards.filter((c) => c.bookId === bookId).sort(byCreatedAtDesc);
  }

  async listRecentCards(limit: number): Promise<CardWithBook[]> {
    const db = await readDb();
    const books = new Map(db.books.map((b) => [b.id, b]));
    return [...db.cards]
      .sort(byCreatedAtDesc)
      .flatMap((card) => {
        const book = books.get(card.bookId);
        return book ? [{ card, book }] : [];
      })
      .slice(0, limit);
  }

  async addReading(input: NewReading): Promise<ReadingRecord> {
    const record: ReadingRecord = { ...input, id: randomUUID() };
    return this.mutate((db) => {
      db.readings.push(record);
      return record;
    });
  }

  async listReadings(bookId?: string): Promise<ReadingRecord[]> {
    const db = await readDb();
    const list = bookId ? db.readings.filter((r) => r.bookId === bookId) : db.readings;
    return [...list].sort((a, b) => (a.readAt < b.readAt ? 1 : -1));
  }
}

// ---------------------------------------------------------------------------
// 백엔드 선택 + 싱글턴 접근자 (M3)
// ---------------------------------------------------------------------------

export type StoreBackend = "firestore" | "file";

/** 파일 상단 주석의 선택 규칙 — env 명시 > 자격증명 자동 감지 > file */
function resolveStoreBackend(): StoreBackend {
  const env = process.env.STORE_BACKEND;
  if (env === "firestore" || env === "file") return env;
  if (env) {
    console.warn(
      `[store] STORE_BACKEND="${env}"는 알 수 없는 값이에요 (firestore|file) — 자동 감지로 진행합니다.`,
    );
  }
  const hasGcpCredentials = Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || // 로컬: 서비스 계정 키 파일 경로
      process.env.K_SERVICE || // Cloud Run이 주입 — 서비스 계정 ADC 사용 가능
      process.env.GOOGLE_CLOUD_PROJECT, // 그 외 GCP 환경 일반 신호
  );
  return hasGcpCredentials ? "firestore" : "file";
}

declare global {
  // dev(HMR)에서 모듈 재평가로 인스턴스가 늘어나는 것을 막기 위한 전역 캐시
  var __bookcardStore: BookCardStore | undefined;
}

export function getStore(): BookCardStore {
  if (!globalThis.__bookcardStore) {
    const backend = resolveStoreBackend();
    globalThis.__bookcardStore = backend === "firestore" ? new FirestoreStore() : new JsonFileStore();
    console.log(
      `[store] backend=${backend} (${process.env.STORE_BACKEND ? "STORE_BACKEND 명시" : "자동 감지"})`,
    );
  }
  return globalThis.__bookcardStore;
}

/**
 * 시드 전용 — db.json 전체를 주어진 데이터로 교체한다 (scripts/seed.ts에서만 사용).
 * JSON 파일 구현에 종속적인 유틸이므로 BookCardStore 인터페이스에는 넣지 않는다.
 */
export async function mergeDbForSeed(seed: DbShape): Promise<void> {
  // 시드는 기존 데이터를 절대 지우지 않는다 — 같은 id만 덮어쓰는 머지(upsert).
  // (전체 덮어쓰기였을 때 검증 중 seed 실행이 실사용 카드를 지운 사고가 있었다)
  const cur = await readDb();
  const mergeById = <T extends { id: string }>(base: T[], add: T[]): T[] => {
    const map = new Map(base.map((r) => [r.id, r] as const));
    for (const r of add) map.set(r.id, r);
    return [...map.values()];
  };
  await writeDb({
    books: mergeById(cur.books, seed.books),
    cards: mergeById(cur.cards, seed.cards),
    readings: mergeById(cur.readings, seed.readings),
  });
}
