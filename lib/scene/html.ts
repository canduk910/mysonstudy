/**
 * lib/scene/html.ts — 2단 플레이어 HTML의 정적 검사 · 답 태그 대조 · iframe 조립
 * (docs/harness/math.md §3-4 "앱 측 처리")
 *
 * 이 앱에서 **AI가 짠 코드를 실제로 실행하는** 유일한 경로다. 그래서 방어가 두 겹이고,
 * 두 겹의 순서가 이 파일의 전부다:
 *
 *   1차 — **격리**: iframe `sandbox="allow-scripts"`(allow-same-origin 없음) + CSP `default-src 'none'`
 *          + **부모 문서의 CSP `frame-src 'self'`**. 앞의 둘은 프레임이 스스로 외부 주소로
 *          이동하는 것을 막지 못한다 — 그 구멍은 부모 쪽 헤더만 닫는다(`SCENE_IFRAME_CSP` 주석).
 *   2차 — **정적 검사 + 답 태그 대조**: 명백한 것을 일찍 걸러 재생성 기회를 준다.
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ **정적 검사는 안전을 보증하지 않는다.** 차단 목록이라 목록에 없는 수법은 늘   │
 * │ 있다(문자열 이어 붙이기, 대괄호 접근, 유니코드 이스케이프…). 이 파일의 목록을  │
 * │ 아무리 늘려도 그 사실은 변하지 않는다. 진짜 방어선은 격리다.                 │
 * │                                                                            │
 * │ **`sandbox`에서 `allow-same-origin`을 빼는 것이 이 설계의 핵심이다.**          │
 * │ `allow-scripts`와 `allow-same-origin`을 함께 주면 iframe이 부모와 같은 출처가  │
 * │ 되어 샌드박스가 사실상 해제된다 — 안에서 스스로 sandbox 속성을 지울 수 있다.   │
 * │ 이 조합을 바꾸라는 요청은 근거를 따져 물어라.                                │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * **이 파일은 `lib/ai/`를 import하지 않는다.** 두 가지를 지키기 위해서다:
 * (1) 화면(클라이언트 컴포넌트)이 `buildSceneSrcdoc`을 쓰는데, 여기서 OpenAI SDK가 딸려 오면
 *     서버 전용 모듈이 클라이언트 번들에 실린다.
 * (2) 검사 로직이 호출 구현에 묶이지 않아 실호출 없이 반례를 먹여 볼 수 있다.
 * 호출 E의 실행과 이 파일의 조립은 `lib/ai/math/player.ts`가 잇는다.
 */

import type { AnswerItem } from "./types";
// 라벨 정규화는 §5-2 `compare()`를 **그대로 재사용한다.** 답 비교 구현이 두 곳에 생기면
// 언젠가 두 판정이 갈리고, 그때 어느 쪽이 옳은지 아무도 모른다 (§3-4 명시).
import { compare, formatAnswer } from "./verify";

// ---------------------------------------------------------------------------
// 1. 정적 검사 (§3-4 앱 측 처리 1번)
// ---------------------------------------------------------------------------

/**
 * 금지 문자열 — §3-4 원문 목록 그대로.
 *
 * 이 목록의 역할은 **명백한 위반을 일찍 잡아 재생성 기회를 주는 것**이다. 여기 걸리는 HTML은
 * 어차피 CSP(`default-src 'none'`)에 막혀 조용히 죽으므로, 아이에게 반쯤 그려진 화면을 보여주느니
 * 다시 만드는 편이 낫다. **보안 경계가 아니다.**
 *
 * 목록을 늘리고 싶어지면 먼저 물어라 — "이걸 막으면 무엇이 안전해지는가?" 대개 답은
 * "아무것도. 격리가 이미 막고 있다"이고, 그때 늘려야 할 것은 목록이 아니라 격리에 대한 확신이다.
 */
export const FORBIDDEN_STRINGS = [
  "<link",
  "<iframe",
  "fetch(",
  "XMLHttpRequest",
  "WebSocket",
  "localStorage",
  "document.cookie",
  "eval(",
  "new Function",
  "document.write",
  "http://",
  "https://",
] as const;

export type ForbiddenString = (typeof FORBIDDEN_STRINGS)[number];

/**
 * 정적 검사. 걸린 금지 문자열을 돌려준다(빈 배열이면 통과).
 *
 * 두 번 훑는다:
 *   1) **대소문자 무시** 단순 포함 — HTML 태그 이름은 대소문자를 가리지 않으므로 `<LINK`도
 *      브라우저에는 똑같이 동작한다. 목록을 문자 그대로만 보면 그것을 놓친다.
 *   2) **공백 제거 후** 다시 포함 — `fetch (`, `new  Function`, `document . cookie`처럼
 *      공백 하나로 목록을 비껴가는 형태를 잡는다. 이것은 보안 강화가 아니라
 *      **조기 실패 감지**다(어차피 CSP에 막힐 코드를 미리 걸러 재생성한다).
 *
 * 두 훑기 모두 **우회 가능하다** — 문자열 이어 붙이기(`"fet"+"ch"`), 대괄호 접근
 * (`globalThis["fetch"]`), 유니코드 이스케이프(`eval`), 프로토콜 상대 URL(`//호스트/`) 등은
 * 그대로 통과한다. **그것이 정상이다.** 통과해도 iframe 격리와 CSP가 막는다.
 */
export function runStaticCheck(html: string): ForbiddenString[] {
  const lower = html.toLowerCase();
  const squeezed = lower.replace(/\s+/g, "");
  const hits: ForbiddenString[] = [];
  for (const needle of FORBIDDEN_STRINGS) {
    const n = needle.toLowerCase();
    if (lower.includes(n) || squeezed.includes(n.replace(/\s+/g, ""))) hits.push(needle);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 2. 답 태그 대조 (§3-4 앱 측 처리 2번)
// ---------------------------------------------------------------------------

/**
 * 답 태그를 찾는 정규식.
 *
 * `id="answer"`만으로 찾고 `type="application/json"`은 요구하지 않는다. 답을 실제로 읽는 것은
 * 이 코드이지 브라우저가 아니고(그 태그는 `display:none`이라 화면에도 안 나온다), type 하나가
 * 어긋났다고 8,000토큰짜리 재생성을 태우는 것은 비싸다. 속성 순서·따옴표 종류는 가리지 않는다.
 */
const ANSWER_TAG_RE =
  /<script\b[^>]*\bid\s*=\s*(?:"answer"|'answer'|answer)[^>]*>([\s\S]*?)<\/script\s*>/i;

/** 답 태그 판정 실패 종류 — 재생성 지시문과 로그가 이 코드로 갈린다 */
export type SceneHtmlFailure =
  /** 금지 문자열에 걸렸다 */
  | "static-check"
  /** `<script id="answer">`가 없다 */
  | "answer-tag-missing"
  /** 태그는 있는데 JSON이 아니거나 모양이 다르다 */
  | "answer-tag-invalid"
  /** 값이 호출 B의 answer와 다르다 — **그림이 틀린 답을 주장하는 경우다** */
  | "answer-mismatch";

export interface AnswerTagParse {
  ok: boolean;
  answer: AnswerItem[] | null;
  failure: Extract<SceneHtmlFailure, "answer-tag-missing" | "answer-tag-invalid"> | null;
  reason: string | null;
}

/** 본문에서 `<script type="application/json" id="answer">`의 값을 꺼낸다 */
export function parseAnswerTag(html: string): AnswerTagParse {
  const m = ANSWER_TAG_RE.exec(html);
  if (!m) {
    return {
      ok: false,
      answer: null,
      failure: "answer-tag-missing",
      reason: 'answer tag: <script type="application/json" id="answer">가 본문에 없다',
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch (err) {
    return {
      ok: false,
      answer: null,
      failure: "answer-tag-invalid",
      reason: `answer tag: JSON 파싱 실패 (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      answer: null,
      failure: "answer-tag-invalid",
      reason: "answer tag: 비어 있지 않은 배열이어야 한다",
    };
  }
  const answer: AnswerItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") {
      return { ok: false, answer: null, failure: "answer-tag-invalid", reason: `answer tag: [${i}]가 객체가 아니다` };
    }
    if (typeof item.label !== "string" || typeof item.value !== "number" || !Number.isFinite(item.value)) {
      return {
        ok: false,
        answer: null,
        failure: "answer-tag-invalid",
        reason: `answer tag: [${i}]에 label(문자열)·value(숫자)가 필요하다`,
      };
    }
    // unit은 없어도 된다 — `compare()`가 단위를 비교하지 않으므로(§5-2) null로 맞춰 둔다.
    answer.push({
      label: item.label,
      value: item.value,
      unit: typeof item.unit === "string" ? item.unit : null,
    });
  }
  return { ok: true, answer, failure: null, reason: null };
}

// ---------------------------------------------------------------------------
// 판정 — 정적 검사 + 답 대조를 한 번에
// ---------------------------------------------------------------------------

export interface SceneHtmlInspection {
  /** 두 검사를 모두 통과했는가 */
  ok: boolean;
  failures: SceneHtmlFailure[];
  /** 사람이 읽고 재생성 프롬프트에 그대로 실을 사유. 모호하면 재생성이 같은 실수를 반복한다 */
  reasons: string[];
  /** 답 태그에서 읽어 낸 값 (못 읽었으면 null) */
  answer: AnswerItem[] | null;
  /** 걸린 금지 문자열 */
  forbidden: ForbiddenString[];
}

/**
 * 2단 HTML 판정 (§3-4 1~2번).
 *
 * **답 태그 대조가 마지막 그물이다.** 정적 검사는 "그림이 맞는지"까지 보지 못하고,
 * 답의 정확성은 심판 1(호출 C)이 이미 보증했다. 여기서 막는 것은 **그림이 그 답과 다른
 * 이야기를 하는 것** 하나다. 이것마저 없으면 아이가 화면에서 틀린 숫자를 보게 된다.
 */
export function inspectSceneHtml(html: string, expected: readonly AnswerItem[]): SceneHtmlInspection {
  const failures: SceneHtmlFailure[] = [];
  const reasons: string[] = [];

  const forbidden = runStaticCheck(html);
  if (forbidden.length > 0) {
    failures.push("static-check");
    reasons.push(`정적 검사: 금지 문자열이 들어 있다 — ${forbidden.join(", ")}`);
  }

  const parsed = parseAnswerTag(html);
  if (!parsed.ok) {
    failures.push(parsed.failure!);
    reasons.push(parsed.reason!);
  } else if (!compare(parsed.answer!, expected)) {
    failures.push("answer-mismatch");
    reasons.push(
      `답 대조: 그림의 답 ${formatAnswer(parsed.answer!)}가 확정된 답 ${formatAnswer(expected)}와 다르다`,
    );
  }

  return { ok: failures.length === 0, failures, reasons, answer: parsed.answer, forbidden };
}

/** 재생성 지시문 (§3-4 "걸리면 재생성 1회"). 사유를 그대로 실어 같은 실수를 되풀이하지 않게 한다 */
export function buildRegenerateNote(inspection: SceneHtmlInspection): string {
  return [
    "이전에 만든 HTML이 앱 검사를 통과하지 못했다:",
    ...inspection.reasons.map((r) => `- ${r}`),
    "위 문제를 고쳐서 처음부터 다시 만들어라. 답 태그의 label·value는 주어진 answer와 글자·숫자까지 같아야 한다.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 3. iframe 조립 (§3-4 앱 측 처리 3번)
// ---------------------------------------------------------------------------

/**
 * iframe sandbox 값. **`allow-same-origin`을 절대 넣지 마라.**
 * `allow-scripts`와 함께 주면 iframe이 부모와 같은 출처가 되어 자기 sandbox 속성을 지울 수 있고,
 * 그러면 격리가 사실상 없다. 이 파일 머리의 경고 상자를 먼저 읽어라.
 */
export const SCENE_IFRAME_SANDBOX = "allow-scripts";

/**
 * iframe 안에서 적용할 CSP (§3-4 원문).
 *
 * **막는 것 — 이 문서에서 나가는 요청.** `fetch`·XHR·WebSocket·EventSource·`sendBeacon`
 * (connect-src가 `default-src 'none'`으로 떨어진다), 외부 `<script src>`·`<link rel=stylesheet>`·
 * 폰트·미디어, `data:` 아닌 이미지, 중첩 `<iframe>`(frame-src도 default-src로 떨어진다),
 * `eval`·`new Function`·문자열 `setTimeout`(script-src에 `'unsafe-eval'`이 없다).
 * `sandbox="allow-scripts"`가 더해서 막는 것: 부모 DOM·쿠키·스토리지 접근, 최상위 창 이동
 * (`allow-top-navigation` 없음), 팝업(`allow-popups` 없음), 폼 제출(`allow-forms` 없음).
 *
 * **못 막는 것 — 이 프레임 자신의 이동이다.** `location.href = "//호스트/"`,
 * `<a href="//호스트/">` 클릭, `<meta http-equiv="refresh" content="0;url=//호스트/">` 세 경로가
 * 실측으로 열려 있다(QA 리포트 1 P1). CSP는 **문서 단위**라 이동하는 순간 이 정책도 srcdoc과 함께
 * 사라지고, 그 자리의 외부 문서는 아무 제약 없이 네트워크를 쓰며 **같은 프레임에서** postMessage를
 * 보내므로 `event.source` 판별까지 통과한다(가짜 `ready`로 폴백을 무력화한다).
 * 자기 문서의 이동을 막는 CSP 지시어(`navigate-to`)는 표준에서 빠졌다 — **여기에 무엇을 더해도
 * 이 구멍은 닫히지 않는다.**
 *
 * **그것을 막는 것은 부모 문서의 CSP `frame-src 'self'`다**(`next.config.ts` 응답 헤더, app-builder 소관).
 * 부모의 `frame-src`는 자식 프레임의 **최초 로드뿐 아니라 이후의 모든 이동**에 걸리므로 srcdoc의
 * CSP가 사라진 뒤에도 유효하다. 이 상수를 근거로 "프레임은 밖으로 못 나간다"고 판단하지 마라.
 */
export const SCENE_IFRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

/** 3초 안에 'ready'가 없으면 플레이어를 숨기고 텍스트 3막만 보여준다 (§3-4 4번) */
export const SCENE_READY_TIMEOUT_MS = 3_000;

/** 키트 정적 자원 경로 — 화면이 fetch해서 `buildSceneSrcdoc`에 넘긴다 */
export const PLAYER_KIT_CSS_URL = "/player-kit/kit.css";
export const PLAYER_KIT_JS_URL = "/player-kit/kit.js";

export interface PlayerKitSource {
  css: string;
  js: string;
}

/**
 * 키트 두 파일을 읽어 온다. 부모 문서에서 부르는 것이라 iframe의 CSP와는 무관하다.
 * (iframe 안에서는 `default-src 'none'`이라 어떤 요청도 나가지 못한다 — 그래서 **미리 넣어** 준다.)
 */
export async function loadPlayerKit(fetchImpl: typeof fetch = fetch): Promise<PlayerKitSource> {
  const [css, js] = await Promise.all([
    fetchImpl(PLAYER_KIT_CSS_URL).then((r) => r.text()),
    fetchImpl(PLAYER_KIT_JS_URL).then((r) => r.text()),
  ]);
  return { css, js };
}

/**
 * 키트 소스가 자기 `<style>`·`<script>`를 조기에 닫아 문서를 망가뜨리지 않게 한다.
 * 우리 파일에는 이런 문자열이 없지만, 나중에 누가 넣어도 조용히 깨지지 않도록 남긴다.
 * (AI가 쓴 `html`에는 손대지 않는다 — 자기 태그를 자기가 닫는 것은 정상이고, 여기서 고치면
 *  멀쩡한 코드가 망가진다.)
 */
function sealTag(source: string, tag: "style" | "script"): string {
  return source.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);
}

export interface BuildSceneSrcdocInput {
  /** 호출 E가 만든 `<body>` 안 조각 */
  html: string;
  /** `public/player-kit/kit.css` 내용 */
  kitCss: string;
  /** `public/player-kit/kit.js` 내용 */
  kitJs: string;
  /** 문서 제목 (스크린리더용). 기본값 "설명 플레이어" */
  title?: string;
}

/**
 * iframe `srcdoc`에 넣을 완성 문서를 만든다 (§3-4 3번).
 *
 * 순서가 의미를 갖는다:
 *   1. **CSP meta가 맨 앞** — 뒤따르는 어떤 것보다 먼저 걸려야 한다.
 *   2. **kit.css → kit.js가 `<head>`** — AI 조각 안의 `<script>`가 실행될 때 전역 `Kit`이 이미 있어야
 *      한다. 뒤에 두면 AI가 짠 첫 줄에서 `Kit is not defined`로 죽는다.
 *   3. **AI 조각은 `<body>`** — `Kit.mount`는 DOM이 다 만들어진 뒤로 미뤄지므로, 조각 안에서
 *      스크립트가 마크업보다 앞에 있어도 안전하다(kit.js의 `whenReady`).
 *
 * 반환값은 **문자열**이다. 붙일 때는 `iframe.srcdoc = value`(또는 React `srcDoc={value}`)처럼
 * **속성이 아니라 프로퍼티로** 넣어라. HTML 문자열을 손으로 조립해 넣으면 따옴표 이스케이프가
 * 어긋나 문서가 깨진다.
 */
export function buildSceneSrcdoc(input: BuildSceneSrcdocInput): string {
  const title = input.title ?? "설명 플레이어";
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${SCENE_IFRAME_CSP}">
<title>${title}</title>
<style>
${sealTag(input.kitCss, "style")}
</style>
<script>
${sealTag(input.kitJs, "script")}
</script>
</head>
<body>
${input.html}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 4. 생성 → 판정 → 재생성 1회 (§3-4 1~2번의 "걸리면 재생성 1회")
// ---------------------------------------------------------------------------

/**
 * 호출 E를 한 번 실행하는 함수. `retryNote`가 null이면 1차 호출이다.
 *
 * 이 자리를 함수로 받는 이유: 이 파일이 `lib/ai/`를 몰라도 되고(파일 머리 참고),
 * 실호출 없이 스텁으로 재생성 흐름을 그대로 돌려 볼 수 있다.
 */
export type SceneHtmlGenerate = (retryNote: string | null) => Promise<string>;

/** 시도 상한. §5-3의 "재시도는 1회"와 같은 잣대다 — 아래 주석 참고 */
export const SCENE_HTML_MAX_ATTEMPTS = 2;

export interface SceneHtmlAttemptLog {
  attempt: number;
  ok: boolean;
  failures: SceneHtmlFailure[];
  reasons: string[];
}

export interface SceneHtmlOutcome {
  /** 통과한 HTML. 두 번 다 실패하면 null — 그림 없이 텍스트 3막으로 내려간다 */
  html: string | null;
  attempts: SceneHtmlAttemptLog[];
}

/**
 * 호출 E를 돌리고 §3-4의 검사를 붙인다. 통과하면 HTML, 두 번 다 실패하면 null.
 *
 * **재생성은 전부 합쳐 1회다.** §3-4는 정적 검사와 답 대조를 각각 "재생성 1회"로 적었지만,
 * 그것을 단계마다 1회로 읽으면 한 문제에 호출 E가 최대 3번 나간다 — 출력 한도 8,000짜리
 * **이 하네스에서 가장 비싼 호출**이고, §5-3이 같은 이유로 재시도를 1회로 못 박았다.
 * 두 번 실패한 생성은 세 번째도 대개 실패한다. 그래서 시도 2회(=재생성 1회)로 맞췄다.
 *
 * 실패해도 던지지 않는다 — **그림이 없다고 설명까지 잃지 않는다.** 사유는 호출자가 로그로 남긴다.
 */
export async function resolveSceneHtml(generate: SceneHtmlGenerate, expected: readonly AnswerItem[]): Promise<SceneHtmlOutcome> {
  const attempts: SceneHtmlAttemptLog[] = [];
  let note: string | null = null;

  for (let attempt = 1; attempt <= SCENE_HTML_MAX_ATTEMPTS; attempt++) {
    const html = await generate(note);
    const inspection = inspectSceneHtml(html, expected);
    attempts.push({
      attempt,
      ok: inspection.ok,
      failures: inspection.failures,
      reasons: inspection.reasons,
    });
    if (inspection.ok) return { html, attempts };
    note = buildRegenerateNote(inspection);
  }

  return { html: null, attempts };
}
