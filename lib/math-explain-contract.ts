/**
 * lib/math-explain-contract.ts — `POST /api/math/explain`의 요청·응답 타입 (M1)
 *
 * **타입만 있는 모듈이다.** 값 export가 하나도 없으므로 `import type`으로 가져가면
 * 서버(route handler)와 클라이언트 컴포넌트가 같은 정의를 보면서도 클라이언트 번들에는
 * 아무것도 들어가지 않는다. (`lib/ai/*`는 openai·API 키를 건드리므로 클라이언트에서
 * 절대 import하지 않는다 — 이 파일이 그 경계를 대신 서는 자리다.)
 *
 * 한 곳에 모아 둔 이유: 라우트가 내려주는 shape과 화면이 기대하는 shape이 서로 다른 파일에
 * 따로 적히면 반드시 어긋난다. qa-inspector가 경계면을 교차 검증할 때 볼 단일 정의처다.
 *
 * 참조: `docs/harness/math.md` §3-2(호출 B 입력) · §5-3(explainProblem 반환)
 */

import type { ExplainVerifyReport } from "./ai/math/pipeline";
import type { Explanation } from "./ai/math/schemas";
import type { SceneTier } from "./scene/types";

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
