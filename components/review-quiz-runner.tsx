"use client";

/**
 * 은우 오늘의 복습 — **문제 맞히기 러너** (SPEC §23-11). 클라이언트 컴포넌트, AI 없음.
 *
 * 단어장 시험 화면(components/vocab-quiz-view)과 같은 모양·느낌 — 같은 CSS 모듈(진행 막대·문제 상자·5지선다·즉시 피드백·다음/그만하기)을 쓴다.
 * 문제 = 단서(이모지 + 정답을 가린 영영 정의 — 한국어 뜻은 답한 뒤에만), 보기 = 서버가 만든 영단어 2~5지(lib/review-sources
 * `buildEnglishReviewQuiz`, 순서·보기 고정). **첫 선택**으로 앱이 채점한다(lib/review-quiz `reviewQuizOutcome` — 맞힘 = 힌트 없이 got,
 * 틀림 = 정답 봄 forgot)하고 그 자리에서 `POST /api/review/record`로 한 항목씩 적용한다(간격 규칙은 서버 엔진 그대로).
 * 힌트 사다리·스스로 판정 버튼은 없다. 틀리면 정답을 칠하고 🔊 발음 + 한국어 뜻을 보인 뒤 "다음".
 *
 * - 🔊: 보기를 고르는 탭 안에서 정답 단어 1회(단어장 시험과 같다) + 피드백의 🔊 탭. 문제(가린 정의) 자동 낭독·프리페치는 없다
 *   (가린 글자를 읽을 수 없고, 가리지 않은 정의를 읽으면 답이 샌다 — 비용도 카드당 최대 1조각).
 * - 저장이 끝나야 "다음"이 열린다(실패하면 "다시 저장"). 같은 날 같은 항목은 서버가 already_today로 막는다(성공으로 본다).
 * - 진행 중에는 표현 도우미를 막는다(usePhraseHelperBlock + 경로 판정 두 겹, SPEC §22-3). 첫 적용 성공 때 스트릭 이벤트 1회(§23-9).
 * - 렌더 중 시각·난수·localStorage를 읽지 않는다(hydration — 보기·순서는 서버가 정해 왔다).
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePhraseHelperBlock } from "@/components/use-phrase-helper-block";
import type { ReviewErrorResponse, ReviewRecordRequest, ReviewRecordResponse } from "@/lib/review-contract";
import { isReviewQuizCorrect, reviewQuizOutcome, type ReviewQuizQuestion } from "@/lib/review-quiz";
import { reviewIntervalLabelKo, summarizeReviewResults, type ReviewRunResult } from "@/lib/review-schedule";
import { speak, stopSpeaking } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import s from "./vocab-quiz-view.module.css";
import r from "./review-quiz-runner.module.css";

type SaveState = "idle" | "saving" | "saved" | "error";

export default function ReviewQuizRunner({
  questions,
  skipped,
  doneToday,
  dueCount,
  cap,
  failedSources,
  backHref,
  backLabel,
}: {
  questions: ReviewQuizQuestion[];
  skipped: number;
  doneToday: number;
  dueCount: number;
  cap: number;
  failedSources: number;
  backHref: string;
  backLabel: string;
}) {
  usePhraseHelperBlock(); // 복습(문제 맞히기) 중에는 표현 도우미를 띄우지 않는다(SPEC §22-3)
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<(ReviewRunResult & { correct: boolean })[]>([]);
  const [finished, setFinished] = useState(questions.length === 0);
  const streakFired = useRef(false);
  const savingRef = useRef(false);

  useEffect(() => () => stopSpeaking(), []);

  const q = questions[index] ?? null;

  const record = useCallback(async (question: ReviewQuizQuestion, choice: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveState("saving");
    setError(null);
    const outcome = reviewQuizOutcome(choice, question.card.answer.main);
    const req: ReviewRecordRequest = { area: "english", itemKey: question.card.itemKey, ...outcome };
    try {
      const res = await fetch("/api/review/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      const body = (await res.json().catch(() => null)) as ReviewRecordResponse | ReviewErrorResponse | null;
      if (!res.ok || !body || body.ok !== true) {
        setSaveState("error");
        setError(body && body.ok === false ? body.messageKo : "저장하지 못했어요. 다시 눌러 주세요.");
        return;
      }
      setResults((prev) => [...prev, { judge: body.judge, intervalDays: body.intervalDays, correct: outcome.judge === "got" }]);
      setSaveState("saved");
      if (!streakFired.current) {
        streakFired.current = true;
        window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT));
      }
    } catch {
      setSaveState("error");
      setError("연결이 끊겼어요. 다시 눌러 주세요.");
    } finally {
      savingRef.current = false;
    }
  }, []);

  // 보기를 골랐을 때 — 첫 선택만 채점(다시 못 고친다) + 정답 발음(탭 안 동기 호출) + 그 자리에서 기록
  const choose = (choice: string) => {
    if (!q || selected !== null) return;
    setSelected(choice);
    speak(q.card.answer.main, "en-US");
    void record(q, choice);
  };

  const next = () => {
    if (saveState !== "saved") return;
    stopSpeaking();
    if (index + 1 >= questions.length) {
      setFinished(true);
      return;
    }
    setIndex((i) => i + 1);
    setSelected(null);
    setSaveState("idle");
    setError(null);
  };

  // 그만하기 — 기록은 문항마다 이미 저장됐다. 저장 중에는 막는다
  const stop = () => {
    if (saveState === "saving") return;
    stopSpeaking();
    setFinished(true);
  };

  if (finished) {
    const sum = summarizeReviewResults(results);
    const correct = results.filter((x) => x.correct).length;
    const remaining = Math.max(0, dueCount - results.length);
    const capHit = doneToday + results.length >= cap && remaining > 0;
    const title =
      results.length > 0
        ? results.length >= questions.length
          ? "오늘 복습 끝! 잘했어요 🎉"
          : "여기까지 했어요! 남은 단어는 다시 열면 이어서 나와요"
        : questions.length === 0 && skipped > 0
          ? "아직 복습 문제를 낼 수 없어요"
          : doneToday > 0 && questions.length === 0
            ? "오늘 복습은 다 했어요! 🎉"
            : questions.length === 0
              ? "오늘 복습할 단어가 없어요"
              : "여기까지 했어요";
    return (
      <div className={s.wrap}>
        <section className={s.results} data-testid="review-summary">
          <p className="t-section-title">{title}</p>
          {results.length > 0 && (
            <>
              <p className={s.scoreBig}>
                {correct} <span className={s.scoreSlash}>/</span> {results.length}
              </p>
              <p className="t-lead">
                {results.length}문제 중 {correct}개를 맞혔어요.
                {sum.forgot > 0 ? " 틀린 단어는 내일 다시 나와요." : ""}
              </p>
              <div>
                <p className="t-caption">다음 복습</p>
                <ul className={r.dist} data-testid="review-dist">
                  {sum.byInterval.map((b) => (
                    <li key={b.days} className="u-chip">
                      {reviewIntervalLabelKo(b.days)} {b.count}개
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
          {results.length === 0 && questions.length === 0 && skipped === 0 && doneToday === 0 && (
            <p className="t-lead">단어장 시험을 보면 그 단어들이 여기로 와요!</p>
          )}
          {skipped > 0 && (
            <p className="t-caption" data-testid="review-skipped">
              단어장에 단어가 하나뿐이라 보기를 만들 수 없는 단어 {skipped}개는 빠졌어요. 단어장에 단어를 더 담으면 나와요.
            </p>
          )}
          {capHit && <p className="t-caption">하루 {cap}개까지만 해요. 남은 것은 내일 이어서 나와요.</p>}
          {failedSources > 0 && <p className="t-caption">일부 기록을 읽지 못해 빠진 단어가 있어요.</p>}
          <div className={s.resultActions}>
            <Link href={backHref} className="u-btn u-btn-primary">
              {backLabel}
            </Link>
          </div>
        </section>
      </div>
    );
  }

  if (!q) return null;
  const answer = q.card.answer.main;
  const answered = selected !== null;
  const isCorrect = answered && isReviewQuizCorrect(selected, answer);
  const total = questions.length;
  const progress = ((index + (answered ? 1 : 0)) / total) * 100;
  const hasDef = q.cue !== null;
  const lastResult = saveState === "saved" ? results[results.length - 1] : null;

  return (
    <div className={s.wrap} data-testid="review-quiz" data-item-key={q.card.itemKey}>
      <div className={s.topRow}>
        <p className="t-caption">
          {doneToday > 0 ? `오늘 ${doneToday}개 끝 · ` : ""}하루 {cap}개
        </p>
        <p className={s.counter} aria-live="polite" data-testid="review-counter">
          {index + 1} / {total}
        </p>
      </div>
      <div className={s.progressTrack} aria-hidden>
        <div className={s.progressFill} style={{ width: `${progress}%` }} />
      </div>

      {/* 문제 — 이모지 + 정답을 가린 영영 정의(정의가 없으면 그림만). 한국어 뜻은 답한 뒤 피드백에만 */}
      <div className={s.prompt}>
        <p className={s.promptLabel}>
          <span className={s.reviewBadge}>복습</span>
          {hasDef ? "이 뜻에 맞는 단어는?" : "이 그림에 맞는 단어는?"}
        </p>
        {q.card.cue.emoji && (
          <p className={r.emoji} aria-hidden>
            {q.card.cue.emoji}
          </p>
        )}
        {hasDef && (
          <p className={s.promptText} lang="en" data-testid="review-cue">
            {q.cue}
          </p>
        )}
      </div>

      <div className={s.choices} role="group" aria-label="보기">
        {q.choices.map((choice) => {
          const isCorrectChoice = isReviewQuizCorrect(choice, answer);
          const isPicked = choice === selected;
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
              data-testid="review-choice"
            >
              <span className={s.choiceWord} lang="en">
                {choice}
              </span>
              {answered && isCorrectChoice ? <span aria-hidden className={s.mark}>○</span> : null}
              {answered && isPicked && !isCorrectChoice ? <span aria-hidden className={s.mark}>✕</span> : null}
            </button>
          );
        })}
      </div>

      {answered ? (
        <div className={`${s.feedback} ${isCorrect ? s.feedbackCorrect : s.feedbackWrong}`} role="status" data-testid="review-feedback">
          <div className={r.feedbackBody}>
            <span className={s.feedbackText}>{isCorrect ? "정답이에요! 🎉" : `아쉬워요 — 정답은 "${answer}"예요.`}</span>
            {q.card.answer.sub && <span className={r.meaning}>{q.card.answer.sub}</span>}
            {lastResult && lastResult.intervalDays !== null && (
              <span className={r.nextDue}>다음 복습: {reviewIntervalLabelKo(lastResult.intervalDays)}</span>
            )}
          </div>
          <button type="button" className={s.speaker} onClick={() => speak(answer, "en-US")} aria-label={`${answer} 발음 듣기`} data-testid="review-speak">
            🔊
          </button>
        </div>
      ) : (
        <p className={`t-caption ${s.hint}`}>{hasDef ? "뜻을 읽고 알맞은 단어를 골라 보세요." : "그림을 보고 알맞은 단어를 골라 보세요."}</p>
      )}

      {saveState === "error" && q && selected !== null && (
        <p className={s.saveMsg + " " + s.saveMsgError} role="alert">
          {error}
          <button type="button" className={s.retryBtn} onClick={() => void record(q, selected)}>
            다시 저장
          </button>
        </p>
      )}

      <div className={s.actions}>
        <button type="button" className="u-btn u-btn-primary" onClick={next} disabled={saveState !== "saved"} data-testid="review-next">
          {saveState === "saving" ? "저장하는 중…" : index + 1 >= total ? "끝내기" : "다음 →"}
        </button>
        <button type="button" className="u-btn u-btn-secondary" onClick={stop} disabled={saveState === "saving"}>
          그만하기
        </button>
      </div>
    </div>
  );
}
