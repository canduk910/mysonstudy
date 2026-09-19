"use client";

/**
 * 한자 시험 진행 화면 (아빠의 일본어 JK, §12-4) — 클라이언트. 단어 시험 러너 관용구 재사용(같은 CSS 모듈).
 *
 * 서버가 `buildJaKanjiQuizQuestions`로 조립해 넘긴다(lib/ai 경계 → 서버 조립, hydration 안전). 문제(prompt)는 한자 1자.
 * 🔊·정답 발음은 표기(한자)를 `speak(kanji,"ja-JP")`. 저장은 **콘텐츠 모드별로 갈라** /api/japanese/kanji/quiz로(모드 무오염).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { prefetchSpeech, speak, stopSpeaking } from "@/lib/speech";
import {
  JA_KANJI_QUIZ_MODE_LABELS_KO,
  type JaKanjiQuizMode,
  type JaKanjiQuizQuestion,
  type JaKanjiQuizSubmitResponse,
} from "@/lib/japanese-kanji-contract";
import s from "./ja-quiz-runner.module.css";

/** 피드백에 보여줄 한자 정보(조회용). */
export interface JaKanjiFeedback {
  kanji: string;
  koReading: string | null;
  onyomi: string[];
  meaningKo: string;
}

function speakJa(text: string) {
  if (text.trim()) speak(text, "ja-JP");
}
type SaveState = "idle" | "saving" | "saved" | "error";

export default function JaKanjiQuizRunner({
  questions,
  skipped,
  cards,
  retryHref,
}: {
  questions: JaKanjiQuizQuestion[];
  skipped: number;
  cards: JaKanjiFeedback[];
  retryHref: string;
}) {
  const router = useRouter();
  const cardByKanji = useRef(new Map(cards.map((c) => [c.kanji, c])));
  const [startedAt, setStartedAt] = useState("");
  const [answers, setAnswers] = useState<(boolean | null)[]>(() => new Array(questions.length).fill(null));
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<"quiz" | "results">("quiz");
  const [completed, setCompleted] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const submittedRef = useRef(false);

  useEffect(() => setStartedAt(new Date().toISOString()), []);
  useEffect(() => () => stopSpeaking(), []);
  // 프리페치(§16): 문제 한자들의 발음을 미리 캐시 → 정답 피드백이 즉시 소리 난다.
  useEffect(() => prefetchSpeech(questions.map((q) => q.word), "ja-JP"), [questions]);
  useEffect(() => {
    if (phase !== "quiz") return;
    const q = questions[current];
    if (!q) return;
    speakJa(q.word); // 문제 한자를 읽어 준다
    return () => stopSpeaking();
  }, [current, phase, questions]);

  const total = questions.length;
  const answeredCount = answers.filter((a) => a !== null).length;
  const correctCount = answers.filter((a) => a === true).length;

  async function submitSession(complete: boolean) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSaveState("saving");
    setSaveMsg(null);
    const finishedAt = complete ? new Date().toISOString() : null;

    const byMode = new Map<JaKanjiQuizMode, { word: string; correct: boolean; answered: boolean | null }[]>();
    questions.forEach((q, i) => {
      const arr = byMode.get(q.mode) ?? [];
      arr.push({ word: q.word, correct: answers[i] === true, answered: answers[i] === null ? null : true });
      byMode.set(q.mode, arr);
    });

    try {
      const results = await Promise.all(
        [...byMode].map(async ([mode, items]) => {
          const res = await fetch("/api/japanese/kanji/quiz", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode, startedAt, finishedAt, items }),
          });
          return (await res.json()) as JaKanjiQuizSubmitResponse;
        }),
      );
      const failed = results.find((d) => !d.ok);
      if (!failed) {
        setSaveState("saved");
        setSaveMsg(complete ? "시험 결과를 저장했어요!" : "여기까지 푼 결과를 저장했어요.");
      } else {
        setSaveState("error");
        setSaveMsg(failed.ok ? "결과를 저장하지 못했어요." : failed.messageKo);
      }
    } catch {
      setSaveState("error");
      setSaveMsg("연결이 끊겼어요. 결과를 저장하지 못했어요.");
    }
  }

  function choose(choice: string) {
    if (selected !== null) return;
    const q = questions[current];
    const isCorrect = choice === q.answer;
    setSelected(choice);
    setAnswers((prev) => {
      const next = [...prev];
      next[current] = isCorrect;
      return next;
    });
    speakJa(q.word);
  }

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

  function stop() {
    stopSpeaking();
    setCompleted(false);
    setPhase("results");
    if (answeredCount > 0) void submitSession(false);
    else {
      setSaveState("idle");
      setSaveMsg("아직 푼 문항이 없어 저장하지 않았어요.");
    }
  }

  function retry() {
    router.push(`${retryHref}${retryHref.includes("?") ? "&" : "?"}t=${Date.now()}`);
  }

  if (phase === "results") {
    return (
      <div className={s.wrap}>
        <div className={s.results}>
          <p className="t-caption">{completed ? "시험 끝!" : "여기까지 풀었어요"}</p>
          <p className={s.scoreBig}>
            {correctCount} <span className={s.scoreSlash}>/</span> {answeredCount}
          </p>
          <p className="t-lead">
            {answeredCount > 0 ? `${answeredCount}문제 중 ${correctCount}개를 맞혔어요.` : "푼 문제가 없어요."}
          </p>
          {saveState === "saving" ? (
            <p role="status" className={s.saveMsg}>결과를 저장하는 중이에요…</p>
          ) : saveMsg ? (
            <p role="status" className={`${s.saveMsg} ${saveState === "error" ? s.saveMsgError : ""}`}>
              {saveMsg}
              {saveState === "error" ? (
                <button type="button" className={s.retryBtn} onClick={() => submitSession(completed)}>다시 저장</button>
              ) : null}
            </p>
          ) : null}
          <div className={s.resultActions}>
            <button type="button" className="u-btn u-btn-primary" onClick={retry}>
              <span aria-hidden>🔁</span> 다시 풀기
            </button>
            <Link href="/japanese/kanji" className="u-btn u-btn-secondary">🈳 한자 목록</Link>
          </div>
        </div>
      </div>
    );
  }

  const q = questions[current];
  const answered = selected !== null;
  const progress = total > 0 ? ((current + (answered ? 1 : 0)) / total) * 100 : 0;
  const card = cardByKanji.current.get(q.word);

  return (
    <div className={s.wrap}>
      <div className={s.topRow}>
        <p className="t-caption">한자 시험</p>
        <p className={s.counter} aria-live="polite">
          {current + 1} / {total}
        </p>
      </div>
      <div className={s.progressTrack} aria-hidden>
        <div className={s.progressFill} style={{ width: `${progress}%` }} />
      </div>
      {skipped > 0 && <p className={`t-caption ${s.skipped}`}>낼 수 없는 문항 {skipped}개는 뺐어요.</p>}

      <div className={s.prompt}>
        <p className={s.promptLabel}>
          <span className={s.modeBadge}>{JA_KANJI_QUIZ_MODE_LABELS_KO[q.mode]}</span>
          {q.mode === "kanji-to-on" ? "이 한자의 음독은?" : "이 한자의 뜻은?"}
        </p>
        <div className={s.promptBody}>
          <p className={s.promptText} lang="ja" style={{ fontSize: 44 }}>
            {q.prompt}
          </p>
          <button type="button" className={s.speaker} onClick={() => speakJa(q.word)} aria-label="문제 듣기" title="듣기">
            🔊
          </button>
        </div>
      </div>

      <div className={s.choices} role="group" aria-label="보기">
        {q.choices.map((choice) => {
          const isCorrectChoice = choice === q.answer;
          const isPicked = choice === selected;
          let stateClass = "";
          if (answered) {
            if (isCorrectChoice) stateClass = s.choiceCorrect;
            else if (isPicked) stateClass = s.choiceWrong;
            else stateClass = s.choiceDim;
          }
          const choiceLang = q.mode === "kanji-to-meaning" ? "ko" : "ja";
          return (
            <button
              key={choice}
              type="button"
              className={`${s.choice} ${stateClass}`}
              onClick={() => choose(choice)}
              disabled={answered}
              aria-pressed={isPicked}
              lang={choiceLang}
            >
              <span className={s.choiceText}>{choice}</span>
              {answered && isCorrectChoice ? <span aria-hidden className={s.mark}>○</span> : null}
              {answered && isPicked && !isCorrectChoice ? <span aria-hidden className={s.mark}>✕</span> : null}
            </button>
          );
        })}
      </div>

      {answered ? (
        <div className={`${s.feedback} ${answers[current] ? s.feedbackCorrect : s.feedbackWrong}`} role="status">
          <div className={s.feedbackHead}>
            <span className={s.feedbackText}>{answers[current] ? "정답이에요! 🎉" : "아쉬워요"}</span>
            <button type="button" className={s.speaker} onClick={() => speakJa(q.word)} aria-label={`${q.word} 발음 듣기`}>
              🔊
            </button>
          </div>
          <div className={s.feedbackEntry}>
            <span className={s.feedbackWord} lang="ja">
              {q.word}
            </span>
            {card?.koReading && <span className={s.feedbackKana}>{card.koReading}</span>}
            {card && card.onyomi.length > 0 && (
              <span className={s.feedbackKana} lang="ja">
                {card.onyomi.join(" · ")}
              </span>
            )}
            {card?.meaningKo && <span className={s.feedbackMeaning}>{card.meaningKo}</span>}
          </div>
        </div>
      ) : (
        <p className={`t-caption ${s.hint}`}>보기를 골라 보세요.</p>
      )}

      <div className={s.actions}>
        <button type="button" className="u-btn u-btn-primary" onClick={next} disabled={!answered}>
          {current + 1 >= total ? "끝내기" : "다음 →"}
        </button>
        <button type="button" className="u-btn u-btn-secondary" onClick={stop}>
          그만하기
        </button>
      </div>
    </div>
  );
}
