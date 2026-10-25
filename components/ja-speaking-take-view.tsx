"use client";

/**
 * 🎙️ 일본어 말하기 모의고사 응시 화면 (docs/harness/japanese.md §15-10-3) — **토익 응시 화면 + 일본어 시험 프로필**.
 *
 * 응시 화면(components/toeic-take-view.tsx — 오디오 세션 순서·마이크 유지·Wake Lock·무음 질문 안전망·sendBeacon·진단)을 **복제하지 않고**
 * 시험 프로필(components/take-exam-profile.ts)만 넘긴다. 이 파일이 정하는 것:
 * - 지시문·진행 멘트·질문 음성 조각 = lib/ja-speaking의 일본어(`jaSpeakingPartDirections`·`jaSpeakingPhaseCue`·`jaSpeakingCueTexts`·
 *   `jaSpeakingQuestionPieces`), 읽기 언어 ja-JP(일본어 기본 엔진은 기기 음성 — 응시 화면 소리 설정에서 클라우드로 바꿀 수 있다, §15-11-1).
 * - 라우트 접두어 `/api/japanese/speaking/…`, 결과 `/japanese/speaking/attempts/[id]`, 사진 `/api/japanese/speaking/images/[id]`.
 * - 녹음 풀 `"ja"`(기기 전용 — 서버 업로드 끔, §15-9-4), 토익 "Speaking Test Directions" 시작 안내 끔(토익 평가 기준 문장이라).
 * - 시험 창 글(지문 Q1–2·상황 소개·질문)은 **후리가나**(components/ja-ruby)로 — 응시 중 켜고 끌 수 있다(기본 켬). 한국어 뜻(ko)은 응시 중 숨긴다.
 */

import { useMemo, useState } from "react";
import JaRuby from "@/components/ja-ruby";
import ToeicTakeView from "@/components/toeic-take-view";
import { usePhraseHelperBlock } from "@/components/use-phrase-helper-block";
import type { TakeExamProfile } from "@/components/take-exam-profile";
import type { JaLine } from "@/lib/ai/japanese/speaking-schemas";
import {
  JA_SPEAKING_SPEECH_LANG,
  jaSpeakingCueTexts,
  jaSpeakingPartDirections,
  jaSpeakingPhaseCue,
  jaSpeakingQuestionPieces,
  type JaSpeakingPart,
} from "@/lib/ja-speaking";
import {
  JA_SPEAKING_EXAM_LABELS,
  jaSpeakingAttemptHref,
  jaSpeakingAttemptsApi,
  jaSpeakingFinishApi,
  jaSpeakingImageUrl,
  type JaSpeakingParts,
  type JaSpeakingQuestionView,
} from "@/lib/ja-speaking-contract";
import type { ToeicSetBackLink } from "@/lib/toeic-guide-view";
import t from "./toeic-take-view.module.css";
import r from "./ja-speaking.module.css";

type SpeechParts = Pick<JaSpeakingParts, "respond" | "info" | "opinion">;

export default function JaSpeakingTakeView({
  mockId,
  titleKo,
  scope,
  parts,
  scopeLabelKo,
  questions,
  speechParts,
  back,
}: {
  mockId: string;
  titleKo: string;
  scope: "full" | "part";
  parts: JaSpeakingPart[];
  scopeLabelKo: string;
  questions: JaSpeakingQuestionView[];
  /** 질문 음성 조각(jaSpeakingQuestionPieces)의 재료 */
  speechParts: SpeechParts;
  back: ToeicSetBackLink;
}) {
  // 응시 중 표현 도우미를 막는다 — 응시 화면(ToeicTakeView)도 공통 코어로 막는다(두 겹, §15-10-2). 블록은 카운터라 겹쳐도 된다
  usePhraseHelperBlock();
  const [furigana, setFurigana] = useState(true);
  const viewByQ = useMemo(() => new Map(questions.map((v) => [v.q, v] as const)), [questions]);

  // 읽는 글·라우트는 응시 하나 동안 고정(응시 화면 콜백이 의존 목록 없이 쓴다) — 후리가나 토글은 렌더 칸(renderText·extraControls)만 바꾼다
  const base = useMemo(
    () => ({
      brand: "日本語 Speaking",
      speechLang: JA_SPEAKING_SPEECH_LANG,
      textLang: "ja",
      directions: (part: JaSpeakingPart, count: number) => {
        const d = jaSpeakingPartDirections(part, count);
        return { en: d.ja, ko: d.ko };
      },
      phaseCue: jaSpeakingPhaseCue,
      cueTexts: jaSpeakingCueTexts,
      questionTexts: (view: { q: number }, play: number) => jaSpeakingQuestionPieces(speechParts, view.q, play),
      prefetchQuestionTexts: (view: { q: number; questionPlays: number }) => {
        const out: string[] = [];
        for (let play = 0; play < Math.max(1, view.questionPlays); play++) {
          for (const text of jaSpeakingQuestionPieces(speechParts, view.q, play)) if (!out.includes(text)) out.push(text);
        }
        return out;
      },
      attemptsHref: jaSpeakingAttemptsApi,
      finishHref: jaSpeakingFinishApi,
      resultHref: jaSpeakingAttemptHref,
      imageUrl: jaSpeakingImageUrl,
      serverUpload: false,
      testDirections: false,
      examLabels: JA_SPEAKING_EXAM_LABELS,
      recLeadKo: "녹음은 이 기기에만 저장해요(서버에 올리지 않아요) — 끝난 뒤 이 기기의 결과 화면에서 다시 듣고 AI 채점을 받을 수 있어요.",
    }),
    [speechParts],
  );

  const profile: TakeExamProfile = useMemo(() => {
    const lineOf = (kind: "passage" | "intro" | "question", q: number): JaLine | null => {
      const v = viewByQ.get(q);
      if (!v) return null;
      return kind === "passage" ? v.ja.passage : kind === "intro" ? v.ja.intro : v.ja.question;
    };
    return {
      ...base,
      renderText: (kind, view) => {
        const line = lineOf(kind, view.q);
        if (!line) return kind === "passage" ? view.passage : kind === "intro" ? view.intro : view.question;
        return <JaRuby tokens={line.tokens} className={furigana ? undefined : r.noRuby} />;
      },
      extraControls: (
        <button
          type="button"
          className={t.barBtn}
          onClick={() => setFurigana((on) => !on)}
          aria-pressed={furigana}
          data-testid="ja-furigana-toggle"
        >
          {furigana ? "ふりがな 끄기" : "ふりがな 켜기"}
        </button>
      ),
    };
  }, [base, furigana, viewByQ]);

  return (
    <ToeicTakeView
      mockId={mockId}
      titleKo={titleKo}
      scope={scope}
      parts={parts}
      scopeLabelKo={scopeLabelKo}
      questions={questions}
      back={back}
      recPool="ja"
      profile={profile}
    />
  );
}
