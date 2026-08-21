/**
 * lib/math-explain-contract.ts — `POST /api/math/explain`의 요청·응답 계약 (M1)
 *
 * 한 곳에 모아 둔 이유: 라우트가 내려주는 shape과 화면이 기대하는 shape이 서로 다른 파일에
 * 따로 적히면 반드시 어긋난다. qa-inspector가 경계면을 교차 검증할 때 볼 단일 정의처다.
 *
 * **클라이언트에서 import해도 안전하다.** 타입 3개는 `import type`이라 완전히 지워지고,
 * 값은 `MATH_EXPLAIN_LIMITS`(순수 숫자) 하나뿐이다 — 런타임 의존성이 없다.
 * (`lib/ai/*`는 openai·API 키를 건드리므로 클라이언트에서 절대 import하지 않는다 —
 * 이 파일이 그 경계를 대신 서는 자리다. 그 성질은 값 하나가 늘어도 그대로다.)
 *
 * **길이 상한이 여기 사는 이유**(QA F3): 상한은 타입만큼이나 계약의 일부다. 라우트 zod에만
 * 적어 두면 화면은 무엇이 거절될지 모른 채 보내고, 사용자는 이유 없는 400만 본다.
 * 실제로 판독(호출 A)에는 문장 길이 상한이 없어서 긴 서술형 하나가 그대로 400이 됐다.
 *
 * 참조: `docs/harness/math.md` §3-2(호출 B 입력) · §5-3(explainProblem 반환)
 */

import type { ExplainVerifyReport } from "./ai/math/pipeline";
import type { Explanation } from "./ai/math/schemas";
import type { SceneTier } from "./scene/types";

/**
 * 요청 필드 길이 상한 — **라우트 zod와 화면이 같은 숫자를 본다.**
 *
 * 이 숫자들은 품질 기준이 아니라 **프롬프트 폭주 방지용 안전장치**다. 초등 문제 문장은
 * 길어야 몇 줄이라 2,000자면 서술형까지 넉넉히 덮는다. 판독이 이보다 긴 문장을 내놓았다면
 * 대개 문제 분리가 어긋나 두세 문제가 한 덩어리로 붙은 것이라, 그대로 보내면 설명도 엉킨다.
 *
 * 화면은 이 값으로 ① 입력창 `maxLength`를 걸고 ② 보내기 **전에** 넘치는 문제를 짚어
 * 줄이도록 안내한다. 라우트는 같은 값으로 zod 상한을 짓는다. 숫자를 여기서 바꾸면
 * 양쪽이 함께 움직인다 — 한쪽에만 적으면 "왜 안 보내지는지 모르겠다"가 다시 생긴다.
 */
export const MATH_EXPLAIN_LIMITS = {
  text: 2000,
  number: 20,
  figureDesc: 2000,
  /** `givens` 배열의 최대 항목 수 */
  givens: 30,
  givenLabel: 100,
  givenUnit: 20,
  childAnswer: 500,
  childWork: 2000,
  childNote: 500,
} as const;

/**
 * 요청 본문 — HARNESS §3-2 사용자 메시지 템플릿이 받는 값 그대로.
 *
 * **`retryNote`는 여기 없다(의도).** 재시도 지시문은 `explainProblem()`이 답 불일치·장면
 * 검산 실패를 보고 스스로 만드는 파이프라인 내부 값이다. 클라이언트가 넣을 수 있게 열어 두면
 * 프롬프트 주입 통로가 되고, "이전 답이 틀렸다"는 거짓 맥락으로 모델을 흔들 수 있다.
 * 라우트의 zod 스키마도 이 키를 받지 않는다(unknown key는 조용히 버려진다).
 */
export interface MathExplainRequest {
  /** 문제 문장 (필수) */
  text: string;
  /** 문제 번호 — M1 폼에는 없다. M3(사진 판독)이 채워 보낼 자리 */
  number?: string | null;
  /** 그림·표 설명 (선택) */
  figureDesc?: string | null;
  /** 주어진 숫자 — M1 폼에는 없다(문장 안에 숫자가 있다). M3용 자리 */
  givens?: { label: string; value: number; unit?: string | null }[] | null;
  /** 아이가 쓴 최종 답 (선택). 이 값의 유무가 `childGrade` 검증을 가른다 */
  childAnswer?: string | null;
  /** 아이가 쓴 풀이·낙서 (선택) */
  childWork?: string | null;
  /** 아이에 대한 추가 메모 (선택) */
  childNote?: string | null;
  /**
   * 판독에 쓴 문제집 사진 — **크롭하지 않은 페이지 전체**의 base64 data URL (선택, §12-3).
   *
   * 있으면 호출 B(설명 설계)와 호출 C(독립 검산)가 **둘 다** 이 사진을 본다(§12-2).
   * 도형·점판·보조선·색칠된 영역처럼 `figureDesc` 한 줄로 옮겨지지 않는 그림이
   * B에게 도달하는 유일한 경로다. 어느 문제인지는 `number` 필드가 지목한다 —
   * 그래서 크롭이 필요 없고, **크롭하면 안 된다**(좌표가 어긋나면 도형이 잘린다).
   *
   * **없어도 정상이다**(§12-4). `/math/new`(직접 입력)와 저장된 기록에는 사진이 없고,
   * 그때는 M6 이전과 똑같이 텍스트만으로 돈다.
   *
   * 길이 상한이 `MATH_EXPLAIN_LIMITS`에 없는 이유: 사진 상한의 단일 정의처는
   * `lib/upload-limits.ts`의 `MAX_IMAGE_DATA_URL_CHARS`이고, `/api/math/extract`가
   * 이미 그 숫자로 같은 사진을 받는다. 여기에 별도 숫자를 만들면 **같은 사진이
   * 판독은 되고 설명은 거절되는** 상태가 생긴다 — 사용자에게는 원인 불명의 400이다.
   *
   * **저장되지 않는다**(§9-1). 라우트는 이 값을 프롬프트로만 보내고 기록에는 남기지 않는다.
   */
  imageDataUrl?: string | null;
}

/**
 * 200 성공. **`verify.status === 'held'`도 여기로 온다 — held는 실패가 아니라 정직한 보류다.**
 * 3막 설명은 온전하고 답만 접어 두면 되므로 오류 응답으로 만들지 않는다(§5-3).
 */
export interface MathExplainSuccess {
  ok: true;
  /**
   * 저장된 설명 기록의 id (M4, §9-3). `/math/problem/[id]`로 여는 주소가 된다.
   *
   * **null일 수 있다 — 저장은 best-effort다.** 스토어가 실패해도 설명은 이미 만들어졌고
   * 사용자에게는 그것이 본체라, 화면을 죽이는 대신 "이번 건은 보관하지 못했다"만 알린다.
   * `/math/problem/[id]`가 저장된 레코드를 되살릴 때는 그 레코드의 id가 들어온다.
   */
  id: string | null;
  /** 호출 B의 3막 설명. 장면 검산이 실패했으면 `content.scene`은 null이다(텍스트는 살아 있다) */
  content: Explanation;
  /**
   * 2단 플레이어 HTML (§3-4). `<body>` 안에 들어갈 조각이고, 화면은 이것을
   * `buildSceneSrcdoc()`으로 감싸 sandbox iframe에 띄운다 —
   * **`dangerouslySetInnerHTML`로 본문에 직접 붙이면 안 된다.** AI가 쓴 코드라
   * 격리(iframe sandbox + CSP)가 유일한 방어선이다.
   *
   * null인 경우: 1단 장면이 있었거나(`'typed'`), `held`라 만들지 않았거나,
   * 호출 E가 검사를 두 번 다 못 넘겼거나(§3-4 1~2번). 셋 다 정상 흐름이다.
   */
  sceneHtml: string | null;
  /** 'typed'(1단 장면 있음) | 'html'(2단 HTML 있음) | 'none'(그림 없음) */
  sceneTier: SceneTier;
  verify: ExplainVerifyReport;
}

/** 오류 코드. `locked`·`not_configured`는 proxy.ts(PIN 게이트)가 내려보낸다 */
export type MathExplainErrorCode =
  | "invalid_input" // 400 — zod 검증 실패
  | "no_api_key" // 501 — OPENAI_API_KEY 미설정
  | "ai_failed" // 500 — 재시도 소진(throw). 화면은 '재시도' 버튼을 띄운다
  | "locked" // 401 — PIN 잠금 (proxy.ts)
  | "not_configured"; // 503 — 프로덕션인데 APP_PIN 없음 (proxy.ts)

export interface MathExplainFailure {
  ok: false;
  error: MathExplainErrorCode;
  messageKo: string;
  /** invalid_input일 때만 */
  issues?: { path: string; message: string }[];
  /** true면 같은 입력으로 다시 눌러 볼 만하다 */
  retriable?: boolean;
}

export type MathExplainResponse = MathExplainSuccess | MathExplainFailure;
