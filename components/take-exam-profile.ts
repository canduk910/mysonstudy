/**
 * components/take-exam-profile.ts — 응시 화면(components/toeic-take-view.tsx)의 **시험 프로필** (docs/harness/japanese.md §15-10-3)
 *
 * 토익 응시 화면(오디오 세션 순서·마이크 유지·Wake Lock·무음 질문 안전망·sendBeacon·진단 — 실기기 검증을 마친 코어)을 **복제하지 않고**
 * 일본어 말하기 모의고사가 같은 컴포넌트를 쓰게 하는 인자. **프로필을 넘기지 않으면 토익 그대로**다(지시문·멘트·질문 조각이 바이트까지 같다 —
 * 클라우드 TTS 영구 캐시가 그대로 맞는다, §15-10-3 불변 조건 1).
 *
 * 프로필로 바꿀 수 있는 것: 읽는 글(지시문·멘트·질문 조각)·읽기 언어·라우트 접두어(시작·끝·사진·결과)·서버 녹음 업로드 켬/끔·시작 안내 화면·
 * 시험 창 글(후리가나 렌더)·앱 띠 덧붙임 컨트롤. **바꿀 수 없는 것**(공통 코어): 단계 전이(형식표)·오디오 세션 순서·마이크 유지 정책·대기 상한·
 * 무음 안전망(toeicSpeechOutcome)·표현 도우미 막기(usePhraseHelperBlock)·끝내기 한 번만·녹음 기기 저장(풀은 recPool 인자).
 */

import type { ReactNode } from "react";
import type { ToeicMockPart, ToeicPhaseState } from "@/lib/toeic-mock";
import type { ToeicQuestionView } from "@/lib/toeic-attempt-contract";
import type { ToeicExamTimerLabel } from "@/lib/toeic-exam-screen";

/** 시험 창(실제 시험 화면 모양)의 화면 글자 — 토익은 영어 그대로(프로필이 없으면 쓰지 않는다) */
export interface TakeExamLabels {
  /** 머리 띠 가운데 문항 제목(토익 "Question 3 of 11") */
  bandTitle(q: number): string;
  /** 지시문 화면 제목(토익 "Questions 1-2: Read a text aloud") */
  directionsTitle(part: ToeicMockPart, attemptQs: readonly number[]): string;
  /** 지시문 앞 굵은 라벨(토익 "Directions:") */
  directionsLabel: string;
  /** 머리 띠 버튼(토익 "CONTINUE") */
  continueLabel: string;
  /** 머리 띠 소리 버튼(토익 "VOLUME") */
  volumeLabel: string;
  /** 타이머 상자 머리(토익 "PREPARATION TIME"·"RESPONSE TIME") */
  timerLabel(label: ToeicExamTimerLabel): string;
}

export interface TakeExamProfile {
  /** 시험 창 머리 띠 왼쪽 위 글 */
  brand: string;
  /** 지시문·멘트·질문을 읽는 언어(speakQueue·프리페치·소리 설정 컨트롤 — lang은 항상 명시) */
  speechLang: string;
  /** 시험 창 글의 lang 속성 */
  textLang: string;
  /**
   * 파트 지시문(응시하는 그 파트 문항 수로). `en` = **읽는 글**(speechLang — 필드 이름은 토익 시절 그대로), `ko` = 앱 띠 한국어 캡션(읽지 않는다).
   * 읽기·프리페치·화면 글 세 곳이 이 함수 하나를 본다(캐시 글자가 맞는다).
   */
  directions(part: ToeicMockPart, count: number): { en: string; ko: string };
  /** 그 단계에 들어갈 때 먼저 읽는 진행 멘트(없으면 null) — 토익 toeicPhaseCue와 같은 자리 */
  phaseCue(st: Pick<ToeicPhaseState, "phase" | "q" | "play">): string | null;
  /** 이번 응시의 멘트 전부(시작 탭 미리 받기 맨 앞) */
  cueTexts(qs: readonly number[]): string[];
  /** question 단계 play번째 재생에서 읽을 글(조각 나누기 전) — 없으면 [] */
  questionTexts(view: ToeicQuestionView, play: number): string[];
  /** 시작 탭 미리 받기의 질문 글(조각 나누기 전) */
  prefetchQuestionTexts(view: ToeicQuestionView): string[];
  /** `POST` 응시 시작 주소 */
  attemptsHref(mockId: string): string;
  /** `POST` 끝/그만두기 주소(비콘·keepalive도 같은 주소) */
  finishHref(attemptId: string): string;
  /** 결과 화면 주소 */
  resultHref(attemptId: string): string;
  /** 사진 바이트 주소 */
  imageUrl(imageId: string): string;
  /** 녹음 서버 보관(업로드 대기열 비우기·"서버 ✓" 표시) — 기기 전용 풀이면 false */
  serverUpload: boolean;
  /** 실전 전체 응시의 시작 안내 화면(토익 "Speaking Test Directions") */
  testDirections: boolean;
  /** 준비 화면 안내문의 녹음 보관 문장 */
  recLeadKo: string;
  /** 시험 창 글 렌더(후리가나 등). null이면 글 그대로 */
  renderText: ((kind: "passage" | "intro" | "question", view: ToeicQuestionView) => ReactNode) | null;
  /** 앱 띠·준비 화면 소리 설정 옆에 덧붙이는 컨트롤(후리가나 켜고 끄기 등) */
  extraControls: ReactNode;
  /** 시험 창 화면 글자(문항 제목·지시문 제목·라벨·버튼·타이머) */
  examLabels: TakeExamLabels;
}
