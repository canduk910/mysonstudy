/**
 * lib/exam-screen.ts — 지금 화면이 **시험 화면**인가(상단 스트릭 헤드라인·"누구 습관" 표시줄을 숨길지)의 단일 정의처.
 *
 * 2026-10-09 사용자 요청("시험 중엔 스트릭 안 보이게 하자"): 시험·응시·떠올리기 화면에서는 상단 두 줄을 내린다.
 * 판정은 표현 도우미가 이미 쓰는 시험 판정(lib/phrase-helper-scope.ts)을 그대로 빌려 쓴다 — 시험 목록을 두 곳에 두지 않는다.
 *
 * - 경로: `isPhraseHelperExamPath(pathname)`(토익 응시·다시 풀기·표현 시험·👀 틀 시험·🧩 틀 테스트·🗣️ 틀 말하기 진행,
 *   일본어 단어·한자 시험, 은우 단어장 시험·그림 보고 말하기, 오늘의 복습 러너 넷) **또는** 아래 `EXAM_SCREEN_EXTRA_PATHS`.
 * - 블록 카운터: 시험 화면이 마운트된 동안 건 블록(`acquirePhraseHelperBlock` — 각 시험 러너·자유대화 통화 오버레이) > 0.
 *
 * `EXAM_SCREEN_EXTRA_PATHS`는 **표현 도우미가 원래 없는 영역**의 시험만 담는다(엄마의 생활영어 주간 테스트 — 도우미 모드가 null이라
 * 도우미 시험 목록에 넣을 이유가 없었다). 도우미의 동작은 넓히지 않는다 — 이 목록은 도우미 판정이 보지 않는다.
 * 엄마의 **오늘의 레슨**(`/mom/lesson/[id]`)은 따라 말하기 연습이라 시험으로 치지 않는다(블록도 걸지 않는다).
 *
 * ⚠️ 런타임 import는 순수 모듈 하나(phrase-helper-scope)뿐·`window` 미사용 — 화면이 값으로 import하고 eval이 그대로 부른다.
 */

import { isPhraseHelperExamPath, normalizePhraseHelperPath } from "./phrase-helper-scope";

/** 표현 도우미 목록 밖의 시험 경로(도우미가 없는 영역). 라벨은 리포트·eval 표에만 쓴다 */
export const EXAM_SCREEN_EXTRA_PATHS: readonly { re: RegExp; labelKo: string }[] = [
  { re: /^\/mom\/test\/[^/]+$/, labelKo: "엄마의 생활영어 주간 테스트(끝낸 뒤 결과 화면 포함)" },
];

/** 경로만으로 시험 화면인가(서버 렌더에서도 같은 답 — 첫 화면부터 깜빡임 없이 숨긴다) */
export function isExamScreenPath(pathname: string | null | undefined): boolean {
  if (isPhraseHelperExamPath(pathname)) return true;
  const path = normalizePhraseHelperPath(pathname);
  return EXAM_SCREEN_EXTRA_PATHS.some((p) => p.re.test(path));
}

/** 경로 + 마운트 블록을 합친 판정 — 헤드라인과 표시줄이 쓰는 것은 이것 하나(components/use-exam-screen.ts) */
export function isExamScreen(input: { pathname: string | null | undefined; blockCount: number }): boolean {
  return isExamScreenPath(input.pathname) || input.blockCount > 0;
}

/** 시험 화면에서 헤드라인 대신 그리는 CSS — `--streak-h`를 0으로 내려 sticky 요소가 빈 칸 없이 맨 위에 붙게 한다 */
export const EXAM_SCREEN_STREAK_H_CSS = ":root{--streak-h:0px}";
