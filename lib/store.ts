/**
 * lib/store.ts — 저장 계층 (books / cards / readings / explanations)
 *
 * [M4] 수학 설명 기록(`explanations`)이 더해졌다 — 영어 3종과 같은 백엔드,
 * 같은 인터페이스 뒤에 산다(docs/harness/math.md §9-2).
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
import type { Card, SceneDigestItem, SceneSourceKind } from "./ai/english/schemas";
// 수학 설명 기록(M4)이 통째로 안는 타입들 — **전부 `import type`이다.**
// `lib/ai/math/pipeline.ts`는 openai 클라이언트를 값으로 끌고 오므로 값 import를
// 하면 저장 계층이 AI 모듈에 묶인다. 타입만 가져오면 빌드에서 지워진다.
import type { ExplainVerifyReport } from "./ai/math/pipeline";
import type { Explanation } from "./ai/math/schemas";
import type { SceneTier } from "./scene/types";
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

  /**
   * --- 줄거리 근거 3필드 (SPEC §5) ---
   *
   * 사진 원본을 저장하지 않으므로(§1) 이 요약이 **유일한 사본**이다. "다시 생성"이
   * 사진 재업로드 없이 같은 근거로 돌아야 하고, 그러지 못하면 storySource가
   * metadata로 떨어져 줄거리가 3~4문장으로 조용히 퇴화한다(QA F7).
   *
   * 선택(?)이 아니라 **필수 nullable**로 둔 것은 의도다 — book을 만드는 곳에서
   * 빠뜨리면 컴파일이 깨져야 근거 유실을 사람이 아니라 타입이 막는다.
   */
  /** 호출 A가 뒤표지·책날개에서 판독한 출판사 소개글 */
  blurbText: string | null;
  /** sceneDigest의 출처. 빠뜨리면 배지가 "목차 기반" 대신 "본문 확인"으로 오표기된다 */
  sceneKind: SceneSourceKind | null;
  /** 호출 A′의 장면별 요약. 저장 전 normalizeSceneDigest()를 통과시킬 것(Firestore는 undefined 거부) */
  sceneDigest: SceneDigestItem[] | null;
}

/**
 * 근거 3필드만 갱신하는 패치 — `/api/pages`가 기존 책에 장면 메모를 붙일 때 쓴다.
 * 지정한 키만 덮어쓴다(생략한 키는 보존).
 */
export interface BookEvidencePatch {
  blurbText?: string | null;
  sceneKind?: SceneSourceKind | null;
  sceneDigest?: SceneDigestItem[] | null;
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

/**
 * 호출 B에 넣은 입력 그대로 (= `MathExplainRequest`의 정규화된 형태, math.md §9-1).
 *
 * **선택(?)이 아니라 필수 nullable이다** — BookRecord의 근거 3필드와 같은 이유로,
 * 만드는 쪽에서 빠뜨리면 타입이 먼저 막는다. Firestore는 undefined를 거부하기도 한다.
 */
export interface MathProblemInput {
  number: string | null;
  text: string;
  figureDesc: string | null;
  givens: { label: string; value: number; unit: string | null }[] | null;
  childAnswer: string | null;
  childWork: string | null;
  childNote: string | null;
}

/**
 * 설명 1건 = 문서 1개 (math.md §9-1). 목록·통계용 요약 인덱스를 따로 두지 않는다 —
 * 필요한 값(problemPattern·childGrade·verify.status)이 전부 이 문서 안에 있고,
 * 가족용 규모(수백 건)에서는 전문을 읽어도 무겁지 않다. `CardRecord`가 `content: Card`를
 * 통째로 안는 것과 같은 규약이다.
 */
export interface ExplanationRecord {
  id: string;
  /** 무엇을 물었는가 — 다시 보기 화면과 재생성·연습문제(호출 D)가 같은 입력을 다시 쓴다 */
  problem: MathProblemInput;
  /** 3막 설명 전문. 장면 검산이 실패했으면 `content.scene`은 null이다 */
  content: Explanation;
  /** 호출 E 결과 — M4 시점에는 항상 null (M2.5에서 채워진다) */
  sceneHtml: string | null;
  sceneTier: SceneTier;
  /** §8이 요구하는 {problemPattern, status, attempts} 집계의 원천 */
  verify: ExplainVerifyReport;
  /** 설명을 만든 모델 ID */
  model: string;
  createdAt: string; // ISO 8601
}

export type NewBook = Omit<BookRecord, "id" | "createdAt">;
export type NewCard = Omit<CardRecord, "id" | "createdAt">;
export type NewReading = Omit<ReadingRecord, "id">;
export type NewExplanation = Omit<ExplanationRecord, "id" | "createdAt">;

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

export interface StudyStore {
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
  /**
   * 줄거리 근거 3필드만 갱신한다 (`/api/pages`가 본문·목차 판독 결과를 붙일 때).
   * 없는 bookId면 null — 404 판단은 호출측 라우트의 몫.
   */
  updateBookEvidence(bookId: string, patch: BookEvidencePatch): Promise<BookRecord | null>;

  createCard(input: NewCard): Promise<CardRecord>;
  getCard(id: string): Promise<CardRecord | null>;
  /**
   * 카드 1장만 지운다 — **연쇄 삭제가 없다.** 읽음 기록은 bookId에 매달려 있어
   * 카드와 무관하고(SPEC §5), 책은 그대로 남는다.
   *
   * 지웠으면 true, 없는 id였으면 false. 존재 확인·404는 호출측 라우트의 몫이다
   * (deleteBook과 같은 규약 — 스토어는 "그 카드가 없는 상태"만 보장한다).
   *
   * 주의: 그 책의 마지막 카드인지는 스토어가 따지지 않는다. 카드 없는 유령 책을
   * 막는 것은 라우트의 정책이다(app/api/cards/[id]/route.ts).
   */
  deleteCard(cardId: string): Promise<boolean>;
  /** 해당 책의 카드 목록 — 최신순 */
  listCardsForBook(bookId: string): Promise<CardRecord[]>;
  /** 홈 미리보기용 — 최신 카드 + 책 조인, 최신순 */
  listRecentCards(limit: number): Promise<CardWithBook[]>;

  // readings — M3(서재·읽음 기록).
  addReading(input: NewReading): Promise<ReadingRecord>;
  listReadings(bookId?: string): Promise<ReadingRecord[]>;

  // ---- explanations — 수학 설명 기록 (M4, math.md §9-2) ----
  // 백엔드가 하나이므로 인터페이스를 쪼개지 않고 여기에 네 개를 더한다.
  createExplanation(input: NewExplanation): Promise<ExplanationRecord>;
  getExplanation(id: string): Promise<ExplanationRecord | null>;
  /** 최신순. 가족용 규모라 전체 조회로 충분하다 */
  listExplanations(limit?: number): Promise<ExplanationRecord[]>;
  /** 지웠으면 true, 없는 id였으면 false — deleteCard와 같은 규약 */
  deleteExplanation(id: string): Promise<boolean>;
}

/**
 * 예전 이름. 과목이 영어뿐이던 시절의 이름이라 수학 기록까지 안는 지금은 좁게 읽히지만,
 * **별칭으로 남겨 기존 import를 하나도 깨지 않는다**(math.md §9-2).
 * 새 코드는 `StudyStore`를 쓸 것.
 */
export type BookCardStore = StudyStore;

// ---------------------------------------------------------------------------
// JSON 파일 구현 (M1 — data/db.json)
// ---------------------------------------------------------------------------

export interface DbShape {
  books: BookRecord[];
  cards: CardRecord[];
  readings: ReadingRecord[];
  explanations: ExplanationRecord[];
}

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "db.json");

function emptyDb(): DbShape {
  return { books: [], cards: [], readings: [], explanations: [] };
}

async function readDb(): Promise<DbShape> {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbShape>;
    return {
      books: parsed.books ?? [],
      cards: parsed.cards ?? [],
      readings: parsed.readings ?? [],
      // M4 이전에 만들어진 db.json에는 이 키가 없다 — 마이그레이션 없이 그대로 열린다
      explanations: parsed.explanations ?? [],
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

/**
 * 설명 기록의 문제 입력 정규화 — 저장 직전에 `givens[].unit`의 `undefined`를 `null`로 조인다.
 * (요청 zod가 `nullish`라 undefined로 들어올 수 있고, Firestore는 undefined를 아예 거부한다.)
 *
 * **두 백엔드가 같은 것을 저장하도록 여기서만 정의한다** — `normalizeTitleAuthorKey`와 같은 자리,
 * 같은 이유다. 예전에는 Firestore 구현에만 있어서, 파일 백엔드는 `unit` 키가 통째로 사라진
 * 레코드를 남겼다(타입은 `string | null`인데 읽으면 `undefined`).
 */
export function normalizeProblem(problem: MathProblemInput): MathProblemInput {
  return {
    ...problem,
    givens:
      problem.givens?.map((g) => ({ label: g.label, value: g.value, unit: g.unit ?? null })) ??
      null,
  };
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

  async updateBookEvidence(
    bookId: string,
    patch: BookEvidencePatch,
  ): Promise<BookRecord | null> {
    return this.mutate((db) => {
      const book = db.books.find((b) => b.id === bookId);
      if (!book) return null;
      // 지정한 키만 덮어쓴다 — undefined는 "건드리지 않음"이지 "null로 지움"이 아니다
      if ("blurbText" in patch) book.blurbText = patch.blurbText ?? null;
      if ("sceneKind" in patch) book.sceneKind = patch.sceneKind ?? null;
      if ("sceneDigest" in patch) book.sceneDigest = patch.sceneDigest ?? null;
      return book;
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

  async deleteCard(cardId: string): Promise<boolean> {
    return this.mutate((db) => {
      const before = db.cards.length;
      db.cards = db.cards.filter((c) => c.id !== cardId);
      return db.cards.length < before;
    });
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

  // ---- explanations (M4) ----

  async createExplanation(input: NewExplanation): Promise<ExplanationRecord> {
    const record: ExplanationRecord = {
      ...input,
      // Firestore 구현과 같은 정규화를 태운다 — 두 백엔드가 같은 것을 저장해야 한다
      problem: normalizeProblem(input.problem),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.mutate((db) => {
      db.explanations.push(record);
      return record;
    });
  }

  async getExplanation(id: string): Promise<ExplanationRecord | null> {
    const db = await readDb();
    return db.explanations.find((e) => e.id === id) ?? null;
  }

  async listExplanations(limit?: number): Promise<ExplanationRecord[]> {
    const db = await readDb();
    const sorted = [...db.explanations].sort(byCreatedAtDesc);
    return limit == null ? sorted : sorted.slice(0, limit);
  }

  async deleteExplanation(id: string): Promise<boolean> {
    return this.mutate((db) => {
      const before = db.explanations.length;
      db.explanations = db.explanations.filter((e) => e.id !== id);
      return db.explanations.length < before;
    });
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
  var __bookcardStore: StudyStore | undefined;
}

export function getStore(): StudyStore {
  if (!globalThis.__bookcardStore) {
    const backend = resolveStoreBackend();
    globalThis.__bookcardStore = backend === "firestore" ? new FirestoreStore() : new JsonFileStore();
    console.log(
      `[store] backend=${backend} (${process.env.STORE_BACKEND ? "STORE_BACKEND 명시" : "자동 감지"})`,
    );
    // 개발 환경인데 Firestore를 잡았다 = 로컬 실행이 **프로덕션 실데이터**를 향한다.
    // 2026-08-17에 이 상태로 삭제 기능을 테스트하다 가족 데이터가 전부 지워졌다.
    // 삭제는 lib/prod-guard.ts가 막지만, 읽기·쓰기는 그대로 통하므로 눈에 띄게 알린다.
    if (backend === "firestore" && process.env.NODE_ENV !== "production") {
      console.warn(
        "[store] ⚠️  개발 환경인데 **프로덕션 Firestore**에 연결했어요.\n" +
          "         여기서 만든 카드·읽음 기록은 실제 가족 데이터에 그대로 남습니다.\n" +
          "         삭제는 prod-guard가 막습니다(ALLOW_PROD_DESTRUCTIVE=1로만 해제).\n" +
          "         로컬 테스트라면 STORE_BACKEND=file 로 돌리세요.",
      );
    }
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
    explanations: mergeById(cur.explanations, seed.explanations),
  });
}
