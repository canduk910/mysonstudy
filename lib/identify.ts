/**
 * lib/identify.ts — 책 식별 단계 (SPEC §3-(2)) — 서버 전용 모듈.
 *
 * 판독·입력된 제목(+저자)으로 Google Books volumes를 검색하고(공식 API),
 * 실패·무결과면 Open Library search.json으로 폴백한다(공식 API).
 * 저작권 절대 원칙(SPEC §1): 크롤링·스크래핑 금지 — 두 공식 API 외에는 쓰지 않는다.
 *
 * 어떤 경우에도 throw하지 않는다 — 식별 실패는 카드 생성을 막지 않는다(SPEC §9).
 * 둘 다 실패하면 모든 필드 null + source: null로 반환한다.
 *
 * 서버 전용인 이유: GOOGLE_BOOKS_API_KEY(선택)를 쿼리에 실을 수 있어
 * 클라이언트 번들에 노출되면 안 된다. 라우트(/api/identify)에서만 호출할 것.
 */

const FETCH_TIMEOUT_MS = 8_000;
/** /api/card 입력 스키마의 description 최대 길이(4000)에 맞춰 자른다 */
const MAX_DESCRIPTION_LEN = 4_000;

export interface IdentifyResult {
  isbn: string | null;
  description: string | null;
  categories: string[] | null;
  coverUrl: string | null;
  googleBooksId: string | null;
  /** 어느 API에서 찾았는지. 둘 다 실패면 null (카드 생성은 계속 진행) */
  source: "google_books" | "open_library" | null;
}

const EMPTY_RESULT: IdentifyResult = {
  isbn: null,
  description: null,
  categories: null,
  coverUrl: null,
  googleBooksId: null,
  source: null,
};

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Google Books description에 간혹 섞이는 HTML 태그 제거 */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 정규화 제목이 일치·포함되는 첫 결과 우선, 없으면 관련도 1위(첫 항목) */
function pickByTitle<T>(items: T[], wanted: string, getTitle: (item: T) => string): T {
  const target = normalize(wanted);
  return (
    items.find((item) => {
      const t = normalize(getTitle(item));
      return t === target || t.startsWith(target) || target.startsWith(t);
    }) ?? items[0]
  );
}

// ---------------------------------------------------------------------------
// Google Books (기본)
// ---------------------------------------------------------------------------

interface GbVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    description?: string;
    categories?: string[];
    industryIdentifiers?: { type?: string; identifier?: string }[];
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
  };
}

async function searchGoogleBooks(
  title: string,
  author?: string | null,
): Promise<IdentifyResult | null> {
  // intitle/inauthor 필드 검색 (ai-harness-impl 스킬 "라우트 연결" 지침)
  const q = `intitle:"${title}"` + (author ? ` inauthor:"${author}"` : "");
  const params = new URLSearchParams({ q, maxResults: "5", printType: "books" });
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (key) params.set("key", key); // 선택 — 없으면 무키 호출(저볼륨 가능, SPEC §11)

  const data = (await fetchJson(
    `https://www.googleapis.com/books/v1/volumes?${params}`,
  )) as { items?: GbVolume[] };

  const items = (data.items ?? []).filter((v) => v.volumeInfo?.title);
  if (items.length === 0) return null;

  const best = pickByTitle(items, title, (v) => v.volumeInfo?.title ?? "");
  const info = best.volumeInfo ?? {};
  const ids = info.industryIdentifiers ?? [];
  const isbn =
    ids.find((x) => x.type === "ISBN_13")?.identifier ??
    ids.find((x) => x.type === "ISBN_10")?.identifier ??
    null;
  const thumb = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail ?? null;

  return {
    isbn,
    description: info.description
      ? stripHtml(info.description).slice(0, MAX_DESCRIPTION_LEN)
      : null,
    categories: info.categories?.length ? info.categories : null,
    // 썸네일이 http로 오는 경우가 있어 https로 통일 (혼합 콘텐츠 방지)
    coverUrl: thumb ? thumb.replace(/^http:\/\//, "https://") : null,
    googleBooksId: best.id ?? null,
    source: "google_books",
  };
}

// ---------------------------------------------------------------------------
// Open Library (폴백)
// ---------------------------------------------------------------------------

interface OlDoc {
  title?: string;
  isbn?: string[];
  cover_i?: number;
  subject?: string[];
}

async function searchOpenLibrary(
  title: string,
  author?: string | null,
): Promise<IdentifyResult | null> {
  const params = new URLSearchParams({
    title,
    limit: "5",
    fields: "title,isbn,cover_i,subject",
  });
  if (author) params.set("author", author);

  const data = (await fetchJson(`https://openlibrary.org/search.json?${params}`)) as {
    docs?: OlDoc[];
  };

  const docs = (data.docs ?? []).filter((d) => d.title);
  if (docs.length === 0) return null;

  const doc = pickByTitle(docs, title, (d) => d.title ?? "");
  return {
    isbn: doc.isbn?.[0] ?? null,
    // search.json에는 소개글이 없다 — 추가 호출 없이 null로 둔다 (확보 실패 폴백, SPEC §3)
    description: null,
    categories: doc.subject?.length ? doc.subject.slice(0, 5) : null,
    coverUrl: doc.cover_i
      ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
      : null,
    googleBooksId: null,
    source: "open_library",
  };
}

// ---------------------------------------------------------------------------
// 공개 함수
// ---------------------------------------------------------------------------

/**
 * 제목(+저자)으로 책을 식별한다. Google Books → (실패·무결과) → Open Library →
 * (둘 다 실패) → 모든 필드 null. 절대 throw하지 않는다.
 */
export async function identifyBook(
  title: string,
  author?: string | null,
): Promise<IdentifyResult> {
  try {
    const g = await searchGoogleBooks(title, author);
    if (g) return g;
    console.warn("[identify] Google Books 무결과 — Open Library 폴백");
  } catch (err) {
    console.warn(
      "[identify] Google Books 실패 — Open Library 폴백:",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    const o = await searchOpenLibrary(title, author);
    if (o) return o;
    console.warn("[identify] Open Library 무결과");
  } catch (err) {
    console.warn("[identify] Open Library 실패:", err instanceof Error ? err.message : err);
  }
  return { ...EMPTY_RESULT };
}
