"use client";

/**
 * 일본어 시험 진행 화면 (아빠의 일본어 J2, §6) — 클라이언트 컴포넌트.
 *
 * 서버(`quiz/page.tsx`)가 `buildJaQuizQuestions`로 **세션을 조립해 넘긴다**(lib/ai/japanese/quiz는 클라 번들 경계라
 * 서버에서 만든다 — 서버 1회 조립 → props 고정이라 hydration도 안전). 여기선 진행·즉시 피드백·발음·저장만 한다.
 *
 * ── 모드별 규약(§6) ────────────────────────────────────────────────────────────
 * - **문제(prompt)는 평문 문자열**이라 후리가나를 달지 않는다 → `kanji-to-kana`(표기를 보고 읽기를 맞히는 모드)에서도
 *   정답(읽기)이 노출되지 않는다. 정답을 고른 **뒤 피드백**에서만 표기를 `ja-ruby`로 보여준다(모든 모드 공통, 노출 없음).
 * - **정답 발음**: 모드마다 `answer`가 뜻(한국어)·읽기(가나)·표기로 제각각이라, 발음은 항상 **표제어(word) 표기**를
 *   `speak(word,"ja-JP")`로 읽는다. ja-JP TTS가 한자를 자연히 읽어 주고, word-to-ko에서 한국어를 잘못 읽는 사고도 막는다.
 * - **모드별 무오염 저장**: 혼합 세션을 콘텐츠 모드별로 갈라 모드마다 한 레코드로 저장한다(§6-2). 오답복습(단일 모드)도
 *   그 콘텐츠 모드로 저장돼 재시도가 그 모드의 streak를 밀어 올린다(졸업 성립).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import JaRuby from "@/components/ja-ruby";
import { speak, stopSpeaking } from "@/lib/speech";
import {
  JA_QUIZ_MODE_LABELS_KO,
  type JaQuizContentMode,
  type JaQuizQuestion,
  type JaVocabEntry,
} from "@/lib/japanese-vocab-contract";
import type { JaQuizSubmitResponse } from "@/lib/japanese-vocab-contract";
import s from "./ja-quiz-runner.module.css";

function speakJa(text: string) {
  if (text.trim()) speak(text, "ja-JP");
}

type SaveState = "idle" | "saving" | "saved" | "error";

export default function JaQuizRunner({
  id,
  titleKo,
  questions,
  skipped,
  entries,
  retryHref,
  isReview,
}: {
  id: string;
  titleKo: string;
  /** 서버가 조립한 세션 문항(고정). 각 문항에 mode가 있어 저장 시 모드별로 가른다 */
  questions: JaQuizQuestion[];
  /** 출제 불가로 건너뛴 (엔트리,모드) 수 — 사실대로 안내 */
  skipped: number;
  /** 피드백에 표기 후리가나·뜻을 보여주려는 조회용(word → 엔트리) */
  entries: JaVocabEntry[];
  /** "다시 풀기"가 갈 주소(모드 파라미터 포함). 뒤에 &t= 를 붙여 서버 재조립을 강제한다 */
  retryHref: string;
  /** 오답복습 세션이면 문구를 "다시 풀기" 톤으로 */
  isReview: boolean;
}) {
  const router = useRouter();
  const entryByWord = useRef(new Map(entries.map((e) => [e.word, e])));
  const [startedAt, setStartedAt] = useState("");
  const [answers, setAnswers] = useState<(boolean | null)[]>(() => new Array(questions.length).fill(null));
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<"quiz" | "results">("quiz");
  const [completed, setCompleted] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const submittedRef = useRef(false);

  // 세션 시작 시각은 마운트 후 1회(렌더 중 new Date()면 SSR↔CSR 불일치). 문항은 서버가 이미 고정했다.
  useEffect(() => setStartedAt(new Date().toISOString()), []);
  useEffect(() => () => stopSpeaking(), []);

  // 새 문항마다 문제를 자동 낭독 — kanji-to-kana는 표기(word)를 읽어야 자연스럽고, 다른 모드도 표제어를 들려준다.
  useEffect(() => {
    if (phase !== "quiz") return;
    const q = questions[current];
    if (!q) return;
    speakJa(q.word);
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

    // §6-2 무오염: 콘텐츠 모드별로 갈라 모드마다 한 레코드. answers 3상태를 그대로 옮긴다.
    const byMode = new Map<JaQuizContentMode, { word: string; correct: boolean; answered: boolean | null }[]>();
    questions.forEach((q, i) => {
      const arr = byMode.get(q.mode) ?? [];
      arr.push({ word: q.word, correct: answers[i] === true, answered: answers[i] === null ? null : true });
      byMode.set(q.mode, arr);
    });

    try {
      const results = await Promise.all(
        [...byMode].map(async ([mode, items]) => {
          const res = await fetch(`/api/japanese/vocab/${id}/quiz`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode, startedAt, finishedAt, items }),
          });
          return (await res.json()) as JaQuizSubmitResponse;
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
    speakJa(q.word); // 맞든 틀리든 표제어(표기)를 ja-JP로 — answer가 아니라 word를 읽는다(위 규약)
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

  const backToBook = (
    <Link href={`/japanese/vocab/${id}`} className="u-btn u-btn-secondary">
      <span aria-hidden>📖</span> 단어장으로
    </Link>
  );

  // ── 결과 화면 ──────────────────────────────────────────────────────────────
  if (phase === "results") {
    return (
      <div className={s.wrap}>
        <div className={s.results}>
          <p className="t-caption">{completed ? (isReview ? "복습 끝!" : "시험 끝!") : "여기까지 풀었어요"}</p>
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
                <button type="button" className={s.retryBtn} onClick={() => submitSession(completed)}>
                  다시 저장
                </button>
              ) : null}
            </p>
          ) : null}
          <div className={s.resultActions}>
            <button type="button" className="u-btn u-btn-primary" onClick={retry}>
              <span aria-hidden>🔁</span> 다시 풀기
            </button>
            <Link href={`/japanese/vocab/${id}/history`} className="u-btn u-btn-secondary">
              <span aria-hidden>📊</span> 시험 기록
            </Link>
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
  const entry = entryByWord.current.get(q.word);
  const promptIsJa = q.mode !== "ko-to-word" && q.mode !== "word-to-ko"; // 문제 텍스트가 일본어인 모드

  return (
    <div className={s.wrap}>
      <div className={s.topRow}>
        <p className="t-caption">{titleKo}</p>
        <p className={s.counter} aria-live="polite">
          {current + 1} / {total}
        </p>
      </div>
      <div className={s.progressTrack} aria-hidden>
        <div className={s.progressFill} style={{ width: `${progress}%` }} />
      </div>

      {skipped > 0 && (
        <p className={`t-caption ${s.skipped}`}>
          이 조건에서 낼 수 없는 문항 {skipped}개는 뺐어요.
        </p>
      )}

      <div className={s.prompt}>
        <p className={s.promptLabel}>
          <span className={s.modeBadge}>{JA_QUIZ_MODE_LABELS_KO[q.mode]}</span>
          {q.mode === "kanji-to-kana"
            ? "이 표기의 읽기는?"
            : q.mode === "ko-to-word"
              ? "이 뜻의 표기는?"
              : q.mode === "word-to-ko"
                ? "이 단어의 뜻은?"
                : "빈칸에 들어갈 표기는?"}
        </p>
        <div className={s.promptBody}>
          {/* 문제는 평문(후리가나 없음) — kanji-to-kana에서도 읽기가 노출되지 않는다 */}
          <p className={s.promptText} lang={promptIsJa ? "ja" : "ko"}>
            {q.prompt}
          </p>
          {promptIsJa && (
            <button type="button" className={s.speaker} onClick={() => speakJa(q.word)} aria-label="문제 듣기" title="듣기">
              🔊
            </button>
          )}
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
          // 보기 언어: 뜻(word-to-ko)은 한국어, 그 외는 일본어(표기·가나)
          const choiceLang = q.mode === "word-to-ko" ? "ko" : "ja";
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

      {/* 즉시 피드백 — 정답 뒤에만 표기(후리가나)·읽기·뜻을 보여준다(노출 없음). 🔊는 표제어. */}
      {answered ? (
        <div className={`${s.feedback} ${answers[current] ? s.feedbackCorrect : s.feedbackWrong}`} role="status">
          <div className={s.feedbackHead}>
            <span className={s.feedbackText}>{answers[current] ? "정답이에요! 🎉" : "아쉬워요"}</span>
            <button type="button" className={s.speaker} onClick={() => speakJa(q.word)} aria-label={`${q.word} 발음 듣기`}>
              🔊
            </button>
          </div>
          <div className={s.feedbackEntry}>
            <JaRuby
              tokens={entry && entry.wordTokens.length > 0 ? entry.wordTokens : [{ surface: q.word, reading: null }]}
              className={s.feedbackWord}
            />
            {entry && entry.kana && entry.kana !== q.word && (
              <span className={s.feedbackKana} lang="ja">
                {entry.kana}
              </span>
            )}
            {entry && entry.meaningsKo.length > 0 && <span className={s.feedbackMeaning}>{entry.meaningsKo.join(", ")}</span>}
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
