"use client";

/**
 * 단어장 시험 화면 (단어장 정복 V4) — 클라이언트 컴포넌트.
 *
 * 서버(`app/english/vocab/[id]/quiz/page.tsx`)는 데이터 로딩·게이트(정의 5개 미만이면 못 냄)만
 * 하고, 문제 진행·채점·피드백은 전부 여기서(브라우저 상태) 돈다. **AI 호출·비용은 없다.**
 *
 * ── 흐름 (계획 §V4) ─────────────────────────────────────────────────────────
 * 영영 정의(definitionEn) 제시 → 영단어 5지선다(정답1 + 같은 DAY 오답4, buildChoices) → 고르면
 * **즉시 피드백**(정답/오답 표시) + 🔊 정답 단어 발음(lib/speech `speak`) → 다음.
 *
 * ── 세션 규약 ───────────────────────────────────────────────────────────────
 * - **셔플은 세션 시작 1회.** `buildQuizQuestions`를 useEffect에서 한 번만 돌려 고정한다
 *   (Math.random을 렌더 중에 쓰면 SSR↔CSR hydration mismatch가 난다 — 마운트 후 조립).
 * - 틀린 문항을 같은 세션에서 다시 내지 않는다(문제 배열이 고정이라 자연히 보장).
 * - `그만하기` = 부분 결과 저장(finishedAt: null). 끝까지 = 완료(finishedAt 채움).
 * - 끝/중단 시 **1회** POST `/api/english/vocab/[id]/quiz`. 진행 중 상태는 전부 클라이언트.
 *
 * 저장 문항(answered/correct)의 뜻은 `VocabQuizItem`(lib/store.ts) JSDoc 참고 — 여기서 만든
 * `answers` 3상태(true/false/null)를 그대로 옮긴다: 맞힘/틀림/미응답.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  buildChoices,
  buildQuizQuestions,
  DEFAULT_CHOICE_COUNT,
  type QuizPoolItem,
  type QuizQuestion,
  type VocabQuizMode,
} from "@/lib/vocab-quiz";
import type { ReviewQuestion } from "@/lib/vocab-review";
import { speak, stopSpeaking } from "@/lib/speech";
import type { VocabQuizItem } from "@/lib/store";
import type { VocabQuizSubmitRequest, VocabQuizSubmitResponse } from "@/lib/vocab-quiz-contract";
import s from "./vocab-quiz-view.module.css";

interface VocabQuizViewProps {
  /** 시험 결과를 저장할 단어장 id (POST URL) */
  id: string;
  titleKo: string;
  dayLabel: string | null;
  /** 문제가 되는 단어(정의가 있는 단어만) — 서버가 걸러 넘긴다 */
  pool: QuizPoolItem[];
  /** 오답 후보 = 같은 DAY의 모든 단어(정답·중복은 buildChoices가 걸러낸다) */
  dayWords: string[];
  /**
   * 저장 레코드에 남길 모드(계획 §V4·§V5). 일반 시험은 `"def-to-word"`(기본), 오답노트의 재시험은
   * `"wrong-review"`. 진행·채점·보기 생성은 모드와 무관하게 같다 — 저장 태그와 안내 문구만 다르다.
   */
  mode?: VocabQuizMode;
  /**
   * 복습 리마인드(V6) — 다른 DAY에서 끼워 넣을 복습 문제들(서버가 가중 선택해 넘긴다, ≤5).
   * 이 문제들은 **이 DAY 문제 앞에** 배치되고, 보기는 각자의 source DAY 단어로 만든다(같은-DAY 계약).
   * 저장은 현재 DAY의 레코드에 함께 담기고, 문항 word로 전역 집계(mastery·복습 후보)가 반영한다.
   * 비었으면(콜드 스타트·후보 0) 기존 DAY 시험 그대로다(회귀 0). 오답복습 모드에는 넘기지 않는다.
   */
  reviewQuestions?: ReviewQuestion[];
}

/** 세션 결과 저장 상태 — 끝/중단 시 1회 POST의 진행을 화면에 표시한다 */
type SaveState = "idle" | "saving" | "saved" | "error";

export default function VocabQuizView({
  id,
  titleKo,
  dayLabel,
  pool,
  dayWords,
  mode = "def-to-word",
  reviewQuestions,
}: VocabQuizViewProps) {
  const isReview = mode === "wrong-review"; // 오답복습이면 문구를 "다시 풀기" 톤으로 바꾼다
  // 문제는 마운트 후 1회만 조립한다(hydration mismatch 회피). null = 아직 준비 중.
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null);
  const [startedAt, setStartedAt] = useState<string>("");
  // 문항별 결과: true=맞힘, false=틀림, null=미응답. 길이는 questions와 같다.
  const [answers, setAnswers] = useState<(boolean | null)[]>([]);
  const [current, setCurrent] = useState(0);
  // 현재 문항에서 사용자가 고른 보기(null = 아직 안 고름). 고르면 즉시 피드백이 뜬다.
  const [selected, setSelected] = useState<string | null>(null);
  // "results" = 결과 화면(완료 또는 그만하기 후)
  const [phase, setPhase] = useState<"quiz" | "results">("quiz");
  const [completed, setCompleted] = useState(false); // 끝까지 풀었나(부분 중단과 구분)
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  // 세션당 저장은 1회 — 완료 자동 저장과 그만하기가 겹쳐도 중복 POST를 막는다.
  const submittedRef = useRef(false);

  // 세션 시작(또는 "다시 풀기") — 문제를 새로 섞고 상태를 초기화한다.
  function startSession() {
    // V6 복습 문항: 다른 DAY에서 온 단어라 보기는 **각자의 source DAY 단어**로 만든다(같은-DAY 계약).
    // 마운트 후(useEffect)에서 buildChoices의 Math.random을 쓰므로 hydration mismatch가 없다.
    const reviewBuilt: QuizQuestion[] = (reviewQuestions ?? []).map((r) => ({
      word: r.word,
      definitionEn: r.definitionEn,
      choices: buildChoices(r.word, r.sourceDayWords, DEFAULT_CHOICE_COUNT),
      isReview: true,
    }));
    // 복습 먼저, 그다음 이 DAY의 새 단어(계획 §V6).
    const built = [...reviewBuilt, ...buildQuizQuestions(pool, dayWords, DEFAULT_CHOICE_COUNT)];
    setQuestions(built);
    setAnswers(new Array(built.length).fill(null));
    setStartedAt(new Date().toISOString());
    setCurrent(0);
    setSelected(null);
    setPhase("quiz");
    setCompleted(false);
    setSaveState("idle");
    setSaveMessage(null);
    submittedRef.current = false;
  }

  // 마운트 시 첫 세션을 조립한다(1회). pool·dayWords는 서버가 준 고정값이라 의존성에 안 넣는다.
  useEffect(() => {
    startSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 화면을 떠나거나 다음으로 넘어갈 때 재생 중인 발음을 멈춘다.
  useEffect(() => () => stopSpeaking(), []);

  // 아직 문제 조립 전 — 짧은 준비 화면(hydration 일치용: 서버·첫 클라 렌더가 모두 이 화면)
  if (!questions) {
    return (
      <div className={s.wrap}>
        <p className="t-lead">시험을 준비하고 있어요…</p>
      </div>
    );
  }

  const total = questions.length;
  const answeredCount = answers.filter((a) => a !== null).length;
  const correctCount = answers.filter((a) => a === true).length;

  // ── 끝/중단 시 1회 저장 ────────────────────────────────────────────────────
  async function submitSession(complete: boolean) {
    if (submittedRef.current) return; // 이미 저장함(중복 방어)
    submittedRef.current = true;
    setSaveState("saving");
    setSaveMessage(null);

    const qs = questions as QuizQuestion[];
    // answers 3상태를 저장 문항으로 옮긴다: null=미응답(answered:null), 그 외=답함(answered:true).
    const items: VocabQuizItem[] = qs.map((q, i) => ({
      word: q.word,
      correct: answers[i] === true,
      answered: answers[i] === null ? null : true,
    }));
    const body: VocabQuizSubmitRequest = {
      mode,
      startedAt,
      finishedAt: complete ? new Date().toISOString() : null, // 완료면 시각, 중단이면 null
      items,
    };

    try {
      const res = await fetch(`/api/english/vocab/${id}/quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as VocabQuizSubmitResponse;
      if (data.ok) {
        setSaveState("saved");
        setSaveMessage(complete ? "시험 결과를 저장했어요!" : "여기까지 푼 결과를 저장했어요.");
      } else {
        setSaveState("error");
        setSaveMessage(data.messageKo);
      }
    } catch {
      setSaveState("error");
      setSaveMessage("연결이 끊겼어요. 결과를 저장하지 못했어요.");
    }
  }

  // 보기를 골랐을 때 — 즉시 채점 + 정답 발음. 이미 고른 문항은 다시 못 고친다(즉시 피드백 규약).
  function choose(choice: string) {
    if (selected !== null) return; // 이 문항은 이미 답함
    const q = questions![current];
    const isCorrect = choice === q.word;
    setSelected(choice);
    setAnswers((prev) => {
      const next = [...prev];
      next[current] = isCorrect;
      return next;
    });
    speak(q.word); // 🔊 정답 단어 발음(맞든 틀리든 올바른 소리를 들려준다)
  }

  // "다음" — 마지막 문항이면 완료로 넘어가며 1회 저장한다.
  function next() {
    stopSpeaking();
    if (current + 1 >= total) {
      setCompleted(true);
      setPhase("results");
      void submitSession(true);
      return;
    }
    setCurrent((c) => c + 1);
    setSelected(null);
  }

  // "그만하기" — 답한 게 있으면 부분 결과를 저장하고, 하나도 없으면 그냥 결과 화면으로(빈 세션 저장 안 함).
  function stop() {
    stopSpeaking();
    setCompleted(false);
    setPhase("results");
    if (answeredCount > 0) {
      void submitSession(false);
    } else {
      setSaveState("idle");
      setSaveMessage("아직 푼 문항이 없어 저장하지 않았어요.");
    }
  }

  const backToBook = (
    <Link href={`/english/vocab/${id}`} className="u-btn u-btn-secondary">
      <span aria-hidden>📖</span> 단어장으로
    </Link>
  );

  // ── 결과 화면 ──────────────────────────────────────────────────────────────
  if (phase === "results") {
    return (
      <div className={s.wrap}>
        <div className={s.results}>
          <p className="t-caption">
            {completed ? (isReview ? "복습 끝!" : "시험 끝!") : "여기까지 풀었어요"}
          </p>
          <p className={s.scoreBig}>
            {correctCount} <span className={s.scoreSlash}>/</span> {answeredCount}
          </p>
          <p className="t-lead">
            {answeredCount > 0
              ? `${answeredCount}문제 중 ${correctCount}개를 맞혔어요.`
              : "푼 문제가 없어요."}
            {!completed && answeredCount > 0 && total > answeredCount
              ? ` (남은 ${total - answeredCount}문제는 다음에!)`
              : ""}
          </p>

          {saveState === "saving" ? (
            <p role="status" className={s.saveMsg}>
              결과를 저장하는 중이에요…
            </p>
          ) : saveMessage ? (
            <p
              role="status"
              className={`${s.saveMsg} ${saveState === "error" ? s.saveMsgError : ""}`}
            >
              {saveMessage}
              {saveState === "error" ? (
                <button type="button" className={s.retryBtn} onClick={() => submitSession(completed)}>
                  다시 저장
                </button>
              ) : null}
            </p>
          ) : null}

          <div className={s.resultActions}>
            <button type="button" className="u-btn u-btn-primary" onClick={startSession}>
              <span aria-hidden>🔁</span> 다시 풀기
            </button>
            {backToBook}
          </div>
        </div>
      </div>
    );
  }

  // ── 문제 화면 ──────────────────────────────────────────────────────────────
  const q = questions[current];
  const answered = selected !== null;
  const progress = total > 0 ? ((current + (answered ? 1 : 0)) / total) * 100 : 0;

  return (
    <div className={s.wrap}>
      {/* 진행 표시 */}
      <div className={s.topRow}>
        <p className="t-caption">
          {titleKo}
          {dayLabel && dayLabel !== titleKo ? ` · ${dayLabel}` : ""}
        </p>
        <p className={s.counter} aria-live="polite">
          {current + 1} / {total}
        </p>
      </div>
      <div className={s.progressTrack} aria-hidden>
        <div className={s.progressFill} style={{ width: `${progress}%` }} />
      </div>

      {/* 문제 = 영영 정의 */}
      <div className={s.prompt}>
        <p className={s.promptLabel}>
          {q.isReview ? <span className={s.reviewBadge}>복습</span> : null}
          이 뜻에 맞는 단어는?
        </p>
        <p className={s.promptText}>{q.definitionEn}</p>
      </div>

      {/* 5지선다 */}
      <div className={s.choices} role="group" aria-label="보기">
        {q.choices.map((choice) => {
          const isCorrectChoice = choice === q.word;
          const isPicked = choice === selected;
          // 답한 뒤에만 색을 칠한다: 정답은 항상 강조, 내가 고른 오답은 빨강, 나머지는 흐리게.
          let stateClass = "";
          if (answered) {
            if (isCorrectChoice) stateClass = s.choiceCorrect;
            else if (isPicked) stateClass = s.choiceWrong;
            else stateClass = s.choiceDim;
          }
          return (
            <button
              key={choice}
              type="button"
              className={`${s.choice} ${stateClass}`}
              onClick={() => choose(choice)}
              disabled={answered}
              aria-pressed={isPicked}
            >
              <span className={s.choiceWord}>{choice}</span>
              {answered && isCorrectChoice ? <span aria-hidden className={s.mark}>○</span> : null}
              {answered && isPicked && !isCorrectChoice ? (
                <span aria-hidden className={s.mark}>✕</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* 즉시 피드백 + 🔊 정답 발음 */}
      {answered ? (
        <div
          className={`${s.feedback} ${answers[current] ? s.feedbackCorrect : s.feedbackWrong}`}
          role="status"
        >
          <span className={s.feedbackText}>
            {answers[current] ? "정답이에요! 🎉" : `아쉬워요 — 정답은 "${q.word}"예요.`}
          </span>
          <button
            type="button"
            className={s.speaker}
            onClick={() => speak(q.word)}
            aria-label={`${q.word} 발음 듣기`}
          >
            🔊
          </button>
        </div>
      ) : (
        <p className={`t-caption ${s.hint}`}>뜻을 읽고 알맞은 단어를 골라 보세요.</p>
      )}

      {/* 다음 / 그만하기 */}
      <div className={s.actions}>
        <button
          type="button"
          className="u-btn u-btn-primary"
          onClick={next}
          disabled={!answered}
        >
          {current + 1 >= total ? "끝내기" : "다음 →"}
        </button>
        <button type="button" className="u-btn u-btn-secondary" onClick={stop}>
          그만하기
        </button>
      </div>
    </div>
  );
}
