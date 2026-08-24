/**
 * lib/youtube-search.ts — 책 낭독 영상 후보 검색 (YouTube Data API v3) · 서버 전용
 *
 * 표지 판독으로 제목·저자가 정해지면(/api/identify 이후), 그 값으로 유튜브를 검색해
 * "이 책 낭독 영상" 후보 상위 3개를 부모에게 보여 준다(home-create). 부모가 한 번 탭해
 * 고른 영상 URL이 카드 생성(/api/card)의 youtubeUrl로 들어가면, 서버가 그 자막을
 * 최상위 근거(storySource=transcript)로 실어 카드를 grounding한다 —
 * "첫 결과 무조건"이 엉뚱한 책 영상을 근거로 삼는 위험을 부모의 한 번 탭으로 막는다.
 *
 * ⚠️ 서버 전용. `YOUTUBE_API_KEY`(비밀)를 읽으므로 **클라이언트 컴포넌트에서 import 금지**.
 *   `app/api/youtube-search/route.ts`(route handler = 서버)만 값 import한다.
 *   `lib/ai/*`·`lib/youtube-transcript.ts`를 import하지 않는다(AI·자막 모듈과 분리).
 *   클라이언트는 타입만(`import type { ReadaloudCandidate }`) 가져다 쓴다(런타임 코드 0).
 *
 * graceful 원칙: **절대 throw로 호출 라우트를 죽이지 않는다.** 키 없음(env 미설정)·
 *   검색 실패(네트워크·API·타임아웃)·결과 0을 전부 `{ error, messageKo }`로 되돌린다.
 *   낭독 영상은 선택 근거라, 못 찾아도 카드는 표지 기준으로 만들어져야 한다(비치명).
 *
 * 로깅에 **API 키를 절대 찍지 않는다** — 성공 시 후보 개수·소요시간, 실패 시 사유·소요시간만.
 *
 * YouTube Data API v3:
 *   GET /youtube/v3/search?part=snippet&type=video&maxResults=6&q=…&relevanceLanguage=en
 *       &videoEmbeddable=true&key=…
 *     → { items: [{ id:{videoId}, snippet:{title, channelTitle, thumbnails:{medium:{url}}} }] }
 *   GET /youtube/v3/videos?part=contentDetails&id={ids}&key=…   ← 길이(ISO8601 duration) 보강, 1콜
 *     → { items: [{ id, contentDetails:{ duration:"PT5M30S" } }] }
 */

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

const SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
/** fetch 타임아웃 — 카드 흐름 앞단에서 무한정 매달리지 않게 (identify.ts 선례와 동형) */
const FETCH_TIMEOUT_MS = 10_000;
/** 검색은 넉넉히 6개를 받아 임베드 불가·중복을 흡수하고, 표시는 상위 3개만 한다 */
const SEARCH_MAX_RESULTS = 6;
const TOP_N = 3;

// ---------------------------------------------------------------------------
// 결과 타입
// ---------------------------------------------------------------------------

/** 부모에게 보여 줄 낭독 영상 후보 한 개 (클라이언트가 타입만 재사용) */
export interface ReadaloudCandidate {
  videoId: string;
  /** 카드 생성 입력의 youtubeUrl로 그대로 들어간다 (watch?v= 형식) */
  url: string;
  title: string;
  channel: string;
  /** 영상 길이(초). videos.list가 실패하거나 파싱 불가면 null(비치명) */
  durationSec: number | null;
  thumbnailUrl: string | null;
}

export type ReadaloudSearchReason =
  | "no_key" // YOUTUBE_API_KEY 미설정 (배포 시 Cloud Run env 필요)
  | "invalid_input" // 제목이 비어 있음
  | "no_results" // 검색 결과 0
  | "api_error" // 인증·한도(quota)·기타 API 오류
  | "timeout" // fetch 시간 초과
  | "network"; // 네트워크 오류

export type ReadaloudSearchResult =
  | { results: ReadaloudCandidate[] }
  | { error: ReadaloudSearchReason; messageKo: string };

function fail(error: ReadaloudSearchReason, messageKo: string): ReadaloudSearchResult {
  return { error, messageKo };
}

// ---------------------------------------------------------------------------
// 파싱 헬퍼
// ---------------------------------------------------------------------------

/** 검색 쿼리 — `"{제목}" {저자} read aloud`. 저자가 없으면 저자 토큰만 뺀다 */
function buildQuery(title: string, author: string | null): string {
  const parts = [`"${title}"`];
  const a = author?.trim();
  if (a) parts.push(a);
  parts.push("read aloud");
  return parts.join(" ");
}

/** YouTube snippet의 제목·채널명은 HTML 이스케이프되어 온다(&amp; &#39; 등) — 표시용 복원 */
function decodeHtmlEntities(s: string): string {
  // &amp;는 **맨 마지막**에 푼다 — 먼저 풀면 "&amp;lt;" 같은 이중인코딩이 "<"로 과다디코드된다.
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#0*33;/g, "!")
    .replace(/&amp;/g, "&");
}

/** thumbnails에서 표시에 알맞은 URL 하나를 고른다(medium 우선) */
function pickThumbnail(thumbs: unknown): string | null {
  if (!thumbs || typeof thumbs !== "object") return null;
  const t = thumbs as Record<string, { url?: unknown } | undefined>;
  for (const key of ["medium", "high", "default", "standard", "maxres"]) {
    const url = t[key]?.url;
    if (typeof url === "string" && url) return url;
  }
  return null;
}

interface SearchItem {
  videoId: string;
  title: string;
  channel: string;
  thumbnailUrl: string | null;
}

/** search.list 응답 → 후보 원자료(videoId 없는 항목은 버린다) */
function extractSearchItems(body: unknown): SearchItem[] {
  if (!body || typeof body !== "object") return [];
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: SearchItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as {
      id?: { videoId?: unknown };
      snippet?: { title?: unknown; channelTitle?: unknown; thumbnails?: unknown };
    };
    const videoId = typeof rec.id?.videoId === "string" ? rec.id.videoId : null;
    if (!videoId) continue;
    const title = typeof rec.snippet?.title === "string" ? decodeHtmlEntities(rec.snippet.title) : "";
    const channel =
      typeof rec.snippet?.channelTitle === "string" ? decodeHtmlEntities(rec.snippet.channelTitle) : "";
    out.push({ videoId, title, channel, thumbnailUrl: pickThumbnail(rec.snippet?.thumbnails) });
  }
  return out;
}

/**
 * ISO8601 duration(PT#H#M#S) → 초. 낭독 영상에 사실상 없는 일(D) 단위까지만 방어.
 * 형식이 어긋나면 null(길이 미표시).
 */
function parseIso8601Duration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const h = Number(m[2] ?? 0);
  const min = Number(m[3] ?? 0);
  const s = Number(m[4] ?? 0);
  const total = ((days * 24 + h) * 60 + min) * 60 + s;
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** HTTP 오류 → 사유. 403(quota/키)·400·429·5xx 전부 비치명 → 표지 기준 폴백 */
function mapHttpError(): ReadaloudSearchResult {
  return fail("api_error", "낭독 영상을 찾지 못했어요. 표지 기준으로 만들어요.");
}

/** fetch throw → 타임아웃/네트워크 사유 */
function mapThrown(err: unknown): ReadaloudSearchResult {
  const name = (err as { name?: string })?.name;
  return name === "TimeoutError" || name === "AbortError"
    ? fail("timeout", "낭독 영상을 찾는 데 시간이 너무 오래 걸려요. 표지 기준으로 만들어요.")
    : fail("network", "낭독 영상 검색 서비스에 연결하지 못했어요. 표지 기준으로 만들어요.");
}

// ---------------------------------------------------------------------------
// 길이 보강 (videos.list) — 실패해도 durationSec=null로 비치명 진행
// ---------------------------------------------------------------------------

async function fetchDurations(ids: string[], apiKey: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  try {
    const url = new URL(VIDEOS_ENDPOINT);
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("id", ids.join(","));
    url.searchParams.set("key", apiKey);
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return map; // 길이 못 얻어도 카드 흐름은 계속된다
    const body = (await res.json().catch(() => null)) as { items?: unknown } | null;
    const items = body && Array.isArray(body.items) ? body.items : [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as { id?: unknown; contentDetails?: { duration?: unknown } };
      const id = typeof rec.id === "string" ? rec.id : null;
      const iso =
        typeof rec.contentDetails?.duration === "string" ? rec.contentDetails.duration : null;
      if (id && iso) {
        const sec = parseIso8601Duration(iso);
        if (sec != null) map.set(id, sec);
      }
    }
  } catch {
    // 길이 조회 실패는 비치명 — durationSec=null로 진행
  }
  return map;
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

async function performSearch(title: string, author: string | null): Promise<ReadaloudSearchResult> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return fail("no_key", "낭독 영상 찾기가 아직 준비되지 않았어요. 표지 기준으로 만들어요.");
  }
  const cleanTitle = (title ?? "").trim();
  if (!cleanTitle) {
    return fail("invalid_input", "책 제목이 없어 낭독 영상을 찾지 못했어요. 표지 기준으로 만들어요.");
  }

  // (1) search.list — 후보 목록
  let items: SearchItem[];
  try {
    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", String(SEARCH_MAX_RESULTS));
    url.searchParams.set("q", buildQuery(cleanTitle, author));
    url.searchParams.set("relevanceLanguage", "en");
    url.searchParams.set("videoEmbeddable", "true");
    url.searchParams.set("key", apiKey);
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return mapHttpError();
    items = extractSearchItems(await res.json().catch(() => null));
  } catch (err) {
    return mapThrown(err);
  }

  if (items.length === 0) {
    return fail("no_results", "낭독 영상을 찾지 못했어요. 표지 기준으로 만들어요.");
  }

  // (2) videos.list — 상위 3개의 길이 보강(1콜, 실패해도 비치명)
  const top = items.slice(0, TOP_N);
  const durations = await fetchDurations(
    top.map((it) => it.videoId),
    apiKey,
  );

  const results: ReadaloudCandidate[] = top.map((it) => ({
    videoId: it.videoId,
    url: `https://www.youtube.com/watch?v=${it.videoId}`,
    title: it.title,
    channel: it.channel,
    durationSec: durations.get(it.videoId) ?? null,
    thumbnailUrl: it.thumbnailUrl,
  }));
  return { results };
}

/**
 * 책 제목(+저자)로 유튜브 낭독 영상 후보 상위 3개를 찾는다. 실패는 전부
 * `{ error, messageKo }`로 되돌린다(throw 없음). 성공 시 `{ results }`(0개면 no_results).
 */
export async function searchReadalouds(
  title: string,
  author?: string | null,
): Promise<ReadaloudSearchResult> {
  const started = Date.now();
  const result = await performSearch(title, author ?? null);
  const ms = Date.now() - started;
  // 로깅 — **API 키는 절대 찍지 않는다.** 개수·사유·소요시간만.
  if ("results" in result) {
    console.log(JSON.stringify({ call: "youtube-search", ok: true, count: result.results.length, ms }));
  } else {
    console.log(JSON.stringify({ call: "youtube-search", ok: false, reason: result.error, ms }));
  }
  return result;
}
