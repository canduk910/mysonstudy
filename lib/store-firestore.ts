/**
 * lib/store-firestore.ts — `BookCardStore`의 Firestore(Native mode) 구현 (M3)
 *
 * - 컬렉션: books / cards / readings (SPEC §5 필드 그대로 + M1의 추가 필드
 *   coverEmoji·description — 빌드 리포트 M1 §5-2 근거 참조)
 * - 인증: Admin SDK + ADC(Application Default Credentials).
 *   Cloud Run에서는 서비스 계정, 로컬에서는 GOOGLE_APPLICATION_CREDENTIALS 키 파일.
 * - 날짜: 파일 스토어와 동일하게 ISO 8601 "문자열"로 저장한다 — 인터페이스가
 *   string을 쓰므로 Timestamp 변환 계층을 두지 않는 편이 단순하다. ISO 문자열은
 *   사전순 = 시간순이라 orderBy도 그대로 동작한다. (손으로 넣은 Timestamp 문서도
 *   읽을 수 있게 읽기 쪽에서만 방어 변환한다)
 * - 쿼리: 복합 인덱스가 필요한 where+orderBy 조합을 피한다 — 필터만 Firestore에
 *   맡기고 정렬·정규화 비교는 메모리에서 한다(가족용 소규모 데이터, 문서 수십 건).
 *
 * 서버 전용 모듈 — 클라이언트 컴포넌트에서 import 금지 (firebase-admin은
 * Next의 기본 serverExternalPackages 목록에 있어 서버 번들에서도 native require).
 */

import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import {
  getFirestore,
  Timestamp,
  type CollectionReference,
  type DocumentData,
  type Firestore,
} from "firebase-admin/firestore";
import {
  normalizeTitleAuthorKey,
  type BookCardStore,
  type BookEvidencePatch,
  type BookRecord,
  type CardRecord,
  type CardWithBook,
  type DeleteBookResult,
  type NewBook,
  type NewCard,
  type NewReading,
  type ReadingRecord,
} from "./store";
import {
  normalizeSceneDigest,
  type Card,
  type SceneDigestItem,
  type SceneSourceKind,
} from "./ai/schemas";

// ---------------------------------------------------------------------------
// Admin SDK 초기화 — 지연 + 중복 방지 (dev HMR에서 앱이 이미 있으면 재사용)
// ---------------------------------------------------------------------------

let dbCache: Firestore | null = null;

function getDb(): Firestore {
  if (!dbCache) {
    const app = getApps()[0] ?? initializeApp({ credential: applicationDefault() });
    dbCache = getFirestore(app);
  }
  return dbCache;
}

// ---------------------------------------------------------------------------
// 문서 → 레코드 변환 (읽기 방어: 누락 필드는 null, Timestamp는 ISO 문자열로)
// ---------------------------------------------------------------------------

function toIso(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  return new Date(0).toISOString();
}

function toNullable<T>(v: T | null | undefined): T | null {
  return v ?? null;
}

/**
 * 저장된 장면 메모 읽기 방어 — 이 필드가 없던 시절의 문서를 읽으면 undefined다.
 * 배열이 아니면 null로 내리고, 배열이면 선택 키의 undefined를 null로 정규화한다
 * (다시 쓸 때 Firestore가 undefined를 거부하는 것을 읽기 단계에서 미리 막는다).
 */
function toSceneDigest(v: unknown): SceneDigestItem[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  return normalizeSceneDigest(v as SceneDigestItem[]);
}

function toSceneKind(v: unknown): SceneSourceKind | null {
  return v === "toc" || v === "pages" ? v : null;
}

function toBook(id: string, d: DocumentData): BookRecord {
  return {
    id,
    title: String(d.title ?? ""),
    author: String(d.author ?? "미상"),
    series: toNullable(d.series as string | null),
    isbn: toNullable(d.isbn as string | null),
    arLevel: toNullable(d.arLevel as number | null),
    lexile: toNullable(d.lexile as number | null),
    wordCount: toNullable(d.wordCount as number | null),
    arQuizNo: toNullable(d.arQuizNo as string | null),
    isFiction: Boolean(d.isFiction),
    topic: String(d.topic ?? ""),
    coverUrl: toNullable(d.coverUrl as string | null),
    googleBooksId: toNullable(d.googleBooksId as string | null),
    coverEmoji: toNullable(d.coverEmoji as string | null),
    description: toNullable(d.description as string | null),
    levelEstimated: Boolean(d.levelEstimated),
    createdAt: toIso(d.createdAt),
    // 줄거리 근거 3필드 — 이 필드들이 없던 기존 문서는 전부 null로 읽힌다(하위 호환)
    blurbText: toNullable(d.blurbText as string | null),
    sceneKind: toSceneKind(d.sceneKind),
    sceneDigest: toSceneDigest(d.sceneDigest),
  };
}

function toCard(id: string, d: DocumentData): CardRecord {
  return {
    id,
    bookId: String(d.bookId ?? ""),
    content: d.content as Card, // 쓰기 시 zod 통과분만 저장된다 (/api/card)
    model: String(d.model ?? ""),
    createdAt: toIso(d.createdAt),
  };
}

function toReading(id: string, d: DocumentData): ReadingRecord {
  return {
    id,
    bookId: String(d.bookId ?? ""),
    readAt: toIso(d.readAt),
    rating: toNullable(d.rating as number | null),
    noteKo: toNullable(d.noteKo as string | null),
  };
}

function byCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/**
 * 한 배치에 담는 최대 작업 수. Firestore WriteBatch의 상한은 500 —
 * 가족용 규모(책당 카드 몇 장·기록 수십 건)에서는 넘칠 일이 없지만,
 * 넘치면 커밋 전체가 실패하므로 여유를 두고 나눠 커밋한다.
 */
const BATCH_LIMIT = 450;

// ---------------------------------------------------------------------------
// 구현
// ---------------------------------------------------------------------------

export class FirestoreStore implements BookCardStore {
  private books(): CollectionReference {
    return getDb().collection("books");
  }
  private cards(): CollectionReference {
    return getDb().collection("cards");
  }
  private readings(): CollectionReference {
    return getDb().collection("readings");
  }

  async createBook(input: NewBook): Promise<BookRecord> {
    const ref = this.books().doc();
    const record: BookRecord = {
      ...input,
      // 방어적 정규화 — 장면 항목의 선택 키가 undefined면 Firestore가 쓰기를 거부한다.
      // 라우트도 통과시키지만, 저장 계층이 마지막 관문이라 여기서 한 번 더 조인다.
      sceneDigest: input.sceneDigest?.length ? normalizeSceneDigest(input.sceneDigest) : null,
      id: ref.id,
      createdAt: new Date().toISOString(),
    };
    const { id: _id, ...data } = record; // 문서 ID가 곧 id — 본문에 중복 저장하지 않는다
    await ref.set(data);
    return record;
  }

  async getBook(id: string): Promise<BookRecord | null> {
    const snap = await this.books().doc(id).get();
    return snap.exists ? toBook(snap.id, snap.data()!) : null;
  }

  async listBooks(): Promise<BookRecord[]> {
    const snap = await this.books().orderBy("createdAt", "desc").get();
    return snap.docs.map((d) => toBook(d.id, d.data()));
  }

  async findBookByTitleAuthor(title: string, author: string): Promise<BookRecord | null> {
    // Firestore는 대소문자 무시 비교를 못 한다 — 정규화 키 필드를 추가하는 대신
    // (SPEC §5 스키마를 지키기 위해) 전체를 읽어 메모리에서 비교한다. 가족용
    // 소규모 데이터(수십 권)라 충분하다.
    const key = normalizeTitleAuthorKey(title, author);
    const books = await this.listBooks();
    return books.find((b) => normalizeTitleAuthorKey(b.title, b.author) === key) ?? null;
  }

  async deleteBook(bookId: string): Promise<DeleteBookResult> {
    // where 필터만 쿼리(복합 인덱스 불필요) → 문서 참조를 모아 batch로 지운다.
    const [cardSnap, readingSnap] = await Promise.all([
      this.cards().where("bookId", "==", bookId).get(),
      this.readings().where("bookId", "==", bookId).get(),
    ]);

    // 책 문서를 **마지막에** 지운다 — 중간에 실패해도 "카드 없는 책"(다시 지우면 되는 상태)이
    // 남을 뿐, "책 없는 유령 카드"는 남지 않는다.
    const refs = [
      ...cardSnap.docs.map((d) => d.ref),
      ...readingSnap.docs.map((d) => d.ref),
      this.books().doc(bookId),
    ];

    const db = getDb();
    for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const ref of refs.slice(i, i + BATCH_LIMIT)) batch.delete(ref);
      await batch.commit();
    }

    return { cards: cardSnap.size, readings: readingSnap.size };
  }

  async updateBookEvidence(
    bookId: string,
    patch: BookEvidencePatch,
  ): Promise<BookRecord | null> {
    const ref = this.books().doc(bookId);
    const snap = await ref.get();
    if (!snap.exists) return null;

    // Firestore는 undefined를 거부한다 — 지정한 키만, 전부 null 정규화해서 쓴다.
    const data: Record<string, unknown> = {};
    if ("blurbText" in patch) data.blurbText = patch.blurbText ?? null;
    if ("sceneKind" in patch) data.sceneKind = patch.sceneKind ?? null;
    if ("sceneDigest" in patch) {
      data.sceneDigest = patch.sceneDigest?.length
        ? normalizeSceneDigest(patch.sceneDigest)
        : null;
    }
    if (Object.keys(data).length > 0) await ref.update(data);

    const updated = await ref.get();
    return toBook(updated.id, updated.data()!);
  }

  async createCard(input: NewCard): Promise<CardRecord> {
    const ref = this.cards().doc();
    const record: CardRecord = { ...input, id: ref.id, createdAt: new Date().toISOString() };
    const { id: _id, ...data } = record;
    await ref.set(data);
    return record;
  }

  async getCard(id: string): Promise<CardRecord | null> {
    const snap = await this.cards().doc(id).get();
    return snap.exists ? toCard(snap.id, snap.data()!) : null;
  }

  async listCardsForBook(bookId: string): Promise<CardRecord[]> {
    // where + orderBy(다른 필드)는 복합 인덱스가 필요 — 필터만 쿼리, 정렬은 메모리
    const snap = await this.cards().where("bookId", "==", bookId).get();
    return snap.docs.map((d) => toCard(d.id, d.data())).sort(byCreatedAtDesc);
  }

  async listRecentCards(limit: number): Promise<CardWithBook[]> {
    const snap = await this.cards().orderBy("createdAt", "desc").limit(limit).get();
    const cards = snap.docs.map((d) => toCard(d.id, d.data()));
    if (cards.length === 0) return [];

    const bookIds = [...new Set(cards.map((c) => c.bookId))];
    const bookSnaps = await getDb().getAll(...bookIds.map((id) => this.books().doc(id)));
    const bookMap = new Map(
      bookSnaps.filter((s) => s.exists).map((s) => [s.id, toBook(s.id, s.data()!)]),
    );

    return cards.flatMap((card) => {
      const book = bookMap.get(card.bookId);
      return book ? [{ card, book }] : []; // 책이 사라진 카드는 건너뜀 (파일 구현과 동일)
    });
  }

  async addReading(input: NewReading): Promise<ReadingRecord> {
    const ref = this.readings().doc();
    const record: ReadingRecord = { ...input, id: ref.id };
    const { id: _id, ...data } = record;
    await ref.set(data);
    return record;
  }

  async listReadings(bookId?: string): Promise<ReadingRecord[]> {
    const snap = bookId
      ? await this.readings().where("bookId", "==", bookId).get()
      : await this.readings().get();
    return snap.docs
      .map((d) => toReading(d.id, d.data()))
      .sort((a, b) => (a.readAt < b.readAt ? 1 : a.readAt > b.readAt ? -1 : 0));
  }
}
