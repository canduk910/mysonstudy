/**
 * lib/store.ts — 저장 계층 (books / cards / readings)
 *
 * [M3 교체 예정 인터페이스]
 * `BookCardStore`는 M3에서 Firestore(Admin SDK, 서버 전용) 구현으로 교체된다.
 * 라우트·페이지는 반드시 `getStore()`가 돌려주는 인터페이스만 사용할 것 —
 * 그래야 Firestore 전환 시 이 파일의 구현만 바뀌고 라우트 코드는 그대로 남는다.
 *
 * M1 구현: JSON 파일(data/db.json). 이유: 로컬 데모(키·GCP 없이)와 M1 검증을
 * 가능하게 하기 위함. data/는 .gitignore에 포함되어 커밋되지 않는다.
 *
 * 서버 전용 모듈이다(node:fs 사용) — 클라이언트 컴포넌트에서 값 import 금지.
 * (타입만 필요하면 `import type`으로 가져올 것: 빌드 시 제거되어 안전하다)
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Card } from "./ai/schemas";

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

/** 제목+저자 정규화 키 — 공백 합치기 + 소문자 비교 */
function normalizeKey(title: string, author: string): string {
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
    const key = normalizeKey(title, author);
    const db = await readDb();
    return db.books.find((b) => normalizeKey(b.title, b.author) === key) ?? null;
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
// 싱글턴 접근자 — M3에서는 이 함수가 Firestore 구현을 돌려주도록 바뀐다
// ---------------------------------------------------------------------------

declare global {
  // dev(HMR)에서 모듈 재평가로 인스턴스가 늘어나는 것을 막기 위한 전역 캐시
  var __bookcardStore: BookCardStore | undefined;
}

export function getStore(): BookCardStore {
  if (!globalThis.__bookcardStore) {
    globalThis.__bookcardStore = new JsonFileStore();
  }
  return globalThis.__bookcardStore;
}

/**
 * 시드 전용 — db.json 전체를 주어진 데이터로 교체한다 (scripts/seed.ts에서만 사용).
 * JSON 파일 구현에 종속적인 유틸이므로 BookCardStore 인터페이스에는 넣지 않는다.
 */
export async function replaceDbForSeed(db: DbShape): Promise<void> {
  await writeDb(db);
}
