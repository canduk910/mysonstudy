/**
 * lib/youtube-transcript.ts — 유튜브 낭독 자막 fetch (Supadata) · 서버 전용
 *
 * 부모가 넣은 "책 낭독 영상" URL에서 자막 전문을 받아, 카드 생성(호출 B)의 최우선
 * 근거(storySource=transcript, 배지 "낭독 확인")로 쓴다. 아이가 읽는 실제 책과 카드가
 * 어긋나는 환각을 막는 게 목적이다(docs/harness/english.md §1 grounding).
 *
 * ⚠️ 서버 전용. `SUPADATA_API_KEY`(비밀)를 읽으므로 **클라이언트 컴포넌트에서 import 금지**.
 *   `app/api/transcript/route.ts`와 `app/api/card/route.ts`(둘 다 route handler = 서버)만
 *   쓴다. `lib/ai/*`를 import하지 않는다(AI 모듈과 분리 — client.ts 무영향).
 *
 * graceful 원칙: **절대 throw로 호출 라우트를 죽이지 않는다.** 키 없음·잘못된 URL·자막 없음·
 *   네트워크/API 오류·시간 초과를 전부 `{ ok:false, reason, messageKo }`로 되돌린다. 자막은
 *   선택 근거라 실패해도 표지 기준으로 카드가 만들어져야 한다(비치명).
 *
 * 로깅에 **자막 본문을 찍지 않는다** — 성공 시 길이·언어·소요시간만, 실패 시 사유·상태만 남긴다.
 *
 * Supadata GET /v1/transcript?url=…&text=true (헤더 x-api-key):
 *   200 { content: string, lang, availableLangs }         ← text=true면 content가 평문
 *   202 { jobId }                                          ← 긴 영상은 비동기 → /v1/transcript/{jobId} 폴링
 *   4xx/5xx { error, message, details, documentationUrl }  ← error는 enum(transcript-unavailable 등)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

const SUPADATA_ENDPOINT = "https://api.supadata.ai/v1/transcript";
/** 한 번의 fetch 타임아웃 — 카드 라우트 앞단에서 무한정 매달리지 않게 */
const FETCH_TIMEOUT_MS = 15_000;
/** 비동기 잡(202) 폴링 — 간격·최대 횟수(총 ~24s 예산). 초과하면 graceful 포기 */
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 12;
/**
 * 저장·전달 방어 상한 — 자막은 근거 저장분이라 무한정 커지면 Firestore 문서를 압박한다.
 * 프롬프트는 별도로 TRANSCRIPT_MAX_CHARS(16000)로 앞부분만 쓰지만, 여기서도 안전 상한을 둔다.
 */
const TRANSCRIPT_CLEAN_MAX = 200_000;

// ---------------------------------------------------------------------------
// 결과 타입
// ---------------------------------------------------------------------------

export type TranscriptFailReason =
  | "no_key" // SUPADATA_API_KEY 미설정 (배포 시 Cloud Run env 필요)
  | "invalid_url" // youtube.com/youtu.be 형식이 아님
  | "no_transcript" // 영상에 자막 없음 / 비공개 / transcript-unavailable
  | "api_error" // 인증·한도·기타 API 오류
  | "timeout" // fetch/폴링 시간 초과
  | "network" // 네트워크 오류
  | "empty"; // 응답은 왔지만 자막 본문이 비어 있음

export type YoutubeTranscriptResult =
  | { ok: true; text: string; lang: string | null }
  | { ok: false; reason: TranscriptFailReason; messageKo: string };

function fail(reason: TranscriptFailReason, messageKo: string): YoutubeTranscriptResult {
  return { ok: false, reason, messageKo };
}

// ---------------------------------------------------------------------------
// URL 검증 (youtube.com / youtu.be)
// ---------------------------------------------------------------------------

function isYoutubeUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  return (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtu.be"
  );
}

/** 라우트 zod가 그대로 재사용하도록 export — URL 형식 검증의 단일 정의처 */
export const youtubeUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(isYoutubeUrl, "유튜브(youtube.com / youtu.be) 영상 주소를 넣어 주세요");

// ---------------------------------------------------------------------------
// 자막 정리 — 타임스탬프·[Music]·[Applause] 등 비발화 표기 제거
// ---------------------------------------------------------------------------

/** [Music] / [박수] 같은 대괄호 비발화 표기와 WebVTT/SRT 잔재를 걷어낸다 */
function cleanTranscript(raw: string): string {
  let t = raw;
  // WebVTT 헤더·NOTE·큐 번호
  t = t.replace(/^WEBVTT.*$/gim, " ");
  // 타임스탬프 라인 (00:00:01.000 --> 00:00:03.000 등)과 화살표
  t = t.replace(/\d{1,2}:\d{2}(?::\d{2})?[.,]?\d{0,3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[.,]?\d{0,3}/g, " ");
  // 줄머리에 남은 단독 타임스탬프
  t = t.replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?[.,]?\d{0,3}\s*$/gm, " ");
  // 대괄호 비발화 표기 — 낭독 자막의 [...]는 사실상 전부 음향 큐다([Music], [Applause], [음악] 등)
  t = t.replace(/\[[^\]\n]{0,40}\]/g, " ");
  // 괄호 안 대표 음향 큐(영/한) — 괄호는 서술에도 쓰일 수 있어 알려진 단어만 제거
  t = t.replace(
    /\((?:music|applause|laughter|cheering|noise|silence|inaudible|sound\s?effects?|음악|박수|웃음|소음)\)/gi,
    " ",
  );
  // 공백 정리
  t = t.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

// ---------------------------------------------------------------------------
// 응답 본문 → 결과
// ---------------------------------------------------------------------------

interface TranscriptChunk {
  text?: unknown;
}

/** content(평문 or 세그먼트 배열) + lang을 뽑아 정리 후 결과로 변환 */
function fromContent(body: unknown): YoutubeTranscriptResult {
  if (!body || typeof body !== "object") {
    return fail("empty", "자막을 가져오지 못했어요. 표지 기준으로 만들어요.");
  }
  const rec = body as { content?: unknown; lang?: unknown };
  let raw = "";
  if (typeof rec.content === "string") {
    raw = rec.content;
  } else if (Array.isArray(rec.content)) {
    // text 파라미터 없이 온 경우(방어) — 세그먼트의 text만 이어 붙인다
    raw = (rec.content as TranscriptChunk[])
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join(" ");
  }
  const cleaned = cleanTranscript(raw);
  if (!cleaned) return fail("no_transcript", "이 영상에는 자막이 없어요. 표지 기준으로 만들어요.");
  const text = cleaned.length > TRANSCRIPT_CLEAN_MAX ? cleaned.slice(0, TRANSCRIPT_CLEAN_MAX) : cleaned;
  const lang = typeof rec.lang === "string" ? rec.lang : null;
  return { ok: true, text, lang };
}

/** HTTP 오류 → 사유. error enum(transcript-unavailable/not-found)이면 자막없음으로 본다 */
function mapHttpError(status: number, body: unknown): YoutubeTranscriptResult {
  const code =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? ((body as { error: string }).error)
      : null;
  if (code === "transcript-unavailable" || code === "not-found" || status === 404) {
    return fail("no_transcript", "이 영상에서 자막을 찾지 못했어요. 표지 기준으로 만들어요.");
  }
  if (status === 401 || status === 403 || code === "unauthorized" || code === "forbidden") {
    return fail("api_error", "자막 서비스 인증에 실패했어요. 표지 기준으로 만들어요.");
  }
  if (status === 429 || code === "limit-exceeded" || code === "upgrade-required") {
    return fail("api_error", "자막 서비스 사용량이 초과됐어요. 잠시 뒤 다시 시도해 주세요.");
  }
  return fail("api_error", "자막을 가져오지 못했어요. 표지 기준으로 만들어요.");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 202 비동기 잡 폴링 — completed면 본문 추출, failed/시간초과면 graceful 포기 */
async function pollJob(jobId: string, apiKey: string): Promise<YoutubeTranscriptResult> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    let res: Response;
    try {
      res = await fetch(`${SUPADATA_ENDPOINT}/${encodeURIComponent(jobId)}`, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      continue; // 일시 오류 — 다음 폴링에서 회복될 수 있다
    }
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
    const status = body && typeof body.status === "string" ? body.status : null;
    if (status === "completed") return fromContent(body);
    if (status === "failed") {
      return fail("no_transcript", "자막을 만드는 데 실패했어요. 표지 기준으로 만들어요.");
    }
    // queued / active → 계속 폴링
  }
  return fail("timeout", "자막을 가져오는 데 시간이 너무 오래 걸려요. 표지 기준으로 만들었어요.");
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * 유튜브 낭독 영상 URL → 자막 전문. 실패는 전부 `{ ok:false, … }`로 되돌린다(throw 없음).
 * 성공 시 text는 정리된 평문(타임스탬프·음향큐 제거, 안전 상한 절단).
 */
export async function fetchYoutubeTranscript(rawUrl: string): Promise<YoutubeTranscriptResult> {
  const started = Date.now();
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) {
    return fail("no_key", "자막 기능이 아직 준비되지 않았어요. 표지 기준으로 만들어요.");
  }

  const parsed = youtubeUrlSchema.safeParse(rawUrl);
  if (!parsed.success) {
    return fail("invalid_url", "유튜브(youtube.com / youtu.be) 영상 주소를 넣어 주세요.");
  }
  const url = parsed.data;

  let result: YoutubeTranscriptResult;
  try {
    const endpoint = `${SUPADATA_ENDPOINT}?url=${encodeURIComponent(url)}&text=true`;
    const res = await fetch(endpoint, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });

    if (res.status === 202) {
      const body = (await res.json().catch(() => null)) as { jobId?: unknown } | null;
      const jobId = body && typeof body.jobId === "string" ? body.jobId : null;
      result = jobId
        ? await pollJob(jobId, apiKey)
        : fail("api_error", "자막을 가져오지 못했어요. 표지 기준으로 만들어요.");
    } else if (!res.ok) {
      result = mapHttpError(res.status, await res.json().catch(() => null));
    } else {
      result = fromContent(await res.json().catch(() => null));
    }
  } catch (err) {
    const name = (err as { name?: string })?.name;
    result =
      name === "TimeoutError" || name === "AbortError"
        ? fail("timeout", "자막을 가져오는 데 시간이 너무 오래 걸려요. 표지 기준으로 만들어요.")
        : fail("network", "자막 서비스에 연결하지 못했어요. 표지 기준으로 만들어요.");
  }

  // 로깅 — **본문은 절대 찍지 않는다.** 길이·언어·사유·소요시간만.
  const ms = Date.now() - started;
  if (result.ok) {
    console.log(JSON.stringify({ call: "transcript", ok: true, chars: result.text.length, lang: result.lang, ms }));
  } else {
    console.log(JSON.stringify({ call: "transcript", ok: false, reason: result.reason, ms }));
  }
  return result;
}
