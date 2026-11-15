"use client";

/**
 * components/ja-daily-vocab.tsx — 🗓️ 오늘의 일본어 **📚 N5 단어 칸**(설계 §4 단어).
 *
 * - cards: 새 단어 카드(표기 + 읽기 + 뜻 + 🔊 ja-JP) → 5지선다 → 결과
 * - dayTest: 그 DAY 25단어 시험(뜻 13 + 읽기 12) — 카드 없이 바로
 * - weak: 약한 단어 시험(최대 20)
 * 보기는 lib/ja-daily-quiz `buildJaDailyVocabQuestions`(순수·결정적, 같은 뜻 제외). 읽기 고르기에서는 답하기 전에 🔊·후리가나를 숨긴다
 * (소리가 곧 정답이라). 결과는 `{wordId, mode, correct}`로 회차 기록에 들어간다(저장은 회차 끝에 한 번).
 */

import { useMemo, useState } from "react";
import type { JaDailyVocabView } from "@/lib/ja-daily-contract";
import { buildJaDailyVocabQuestions } from "@/lib/ja-daily-quiz";
import { speak } from "@/lib/speech";

type Answer = { wordId: string; mode: "meaning" | "reading"; correct: boolean };

export default function JaDailyVocab({ view, onDone }: { view: JaDailyVocabView; onDone: (answers: Answer[]) => void }) {
  const questions = useMemo(() => buildJaDailyVocabQuestions(view.words, view.pool), [view]);
  const [stage, setStage] = useState<"cards" | "quiz" | "result">(view.mode === "cards" ? "cards" : "quiz");
  const [ci, setCi] = useState(0);
  const [qi, setQi] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);

  if (view.words.length === 0 || questions.length === 0) {
    return (
      <div className="u-card p-5">
        <p className="t-body">{view.mode === "weak" ? "아직 약한 단어가 없어요 — 틀린 단어가 생기면 여기서 다시 나와요." : "오늘은 단어 칸 내용이 없어요."}</p>
        <button type="button" className="u-btn u-btn-primary mt-4" onClick={() => onDone([])}>
          다음 →
        </button>
      </div>
    );
  }

  if (stage === "cards") {
    const w = view.words[ci];
    return (
      <div className="flex flex-col gap-4" data-testid="ja-daily-cards">
        <p className="t-caption text-ink-3">
          DAY {view.day} · 새 단어 {ci + 1}/{view.words.length}
        </p>
        <section className="u-card flex flex-col items-center gap-2 p-6 text-center">
          <p lang="ja" className="text-4xl font-bold">
            {w.written}
          </p>
          {w.reading !== w.written ? (
            <p lang="ja" className="text-xl text-ink-2">
              {w.reading}
            </p>
          ) : null}
          <p className="t-body mt-1">{w.meaningKo}</p>
          <button type="button" className="u-btn u-btn-secondary mt-2" onClick={() => speak(w.written, "ja-JP")}>
            🔊 듣기
          </button>
        </section>
        <div className="flex gap-2">
          <button type="button" className="u-btn u-btn-secondary flex-1" disabled={ci === 0} onClick={() => setCi(ci - 1)}>
            ← 이전
          </button>
          {ci + 1 < view.words.length ? (
            <button type="button" className="u-btn u-btn-primary flex-1" onClick={() => setCi(ci + 1)} data-testid="ja-daily-card-next">
              다음 →
            </button>
          ) : (
            <button type="button" className="u-btn u-btn-primary flex-1" onClick={() => setStage("quiz")} data-testid="ja-daily-quiz-start">
              퀴즈 →
            </button>
          )}
        </div>
        <button type="button" className="t-caption self-start text-ink-3 underline" onClick={() => setStage("quiz")}>
          카드 건너뛰고 퀴즈로
        </button>
      </div>
    );
  }

  if (stage === "result") {
    const right = answers.filter((a) => a.correct).length;
    return (
      <div className="u-card p-5 text-center" data-testid="ja-daily-vocab-result">
        <p className="t-caption text-ink-3">단어 결과</p>
        <p className="t-stat-number mt-1">
          {right} / {answers.length}
        </p>
        {answers.some((a) => !a.correct) ? (
          <ul className="mt-3 text-left t-caption text-ink-2">
            {questions
              .filter((q) => answers.find((a) => a.wordId === q.wordId && a.mode === q.mode)?.correct === false)
              .map((q) => (
                <li key={q.wordId + q.mode}>
                  <span lang="ja">{q.written}</span>
                  {q.reading !== q.written ? <span lang="ja"> ({q.reading})</span> : null} — {q.meaningKo}
                </li>
              ))}
          </ul>
        ) : null}
        <button type="button" className="u-btn u-btn-primary mt-4 w-full" onClick={() => onDone(answers)} data-testid="ja-daily-vocab-done">
          다음 칸 →
        </button>
      </div>
    );
  }

  const q = questions[qi];
  const answered = picked !== null;
  const reading = q.mode === "reading";
  return (
    <div className="flex flex-col gap-4" data-testid="ja-daily-quiz">
      <div className="flex items-baseline justify-between">
        <p className="t-caption text-ink-3">
          {view.mode === "dayTest" ? `DAY ${view.day} 시험` : view.mode === "weak" ? "약한 단어" : "퀴즈"} · {qi + 1}/{questions.length}
        </p>
        <span className="u-chip u-chip-accent">{reading ? "읽기 고르기" : "뜻 고르기"}</span>
      </div>
      <section className="u-card flex items-center justify-between gap-3 p-5">
        <div className="min-w-0">
          <p lang="ja" className="text-3xl font-bold break-all">
            {q.written}
          </p>
          {answered ? (
            <p className="t-caption mt-1 text-ink-2">
              <span lang="ja">{q.reading}</span> · {q.meaningKo}
            </p>
          ) : null}
        </div>
        {!reading || answered ? (
          <button type="button" className="u-btn u-btn-secondary flex-none" onClick={() => speak(q.written, "ja-JP")} aria-label="발음 듣기">
            🔊
          </button>
        ) : null}
      </section>
      <div className="flex flex-col gap-2">
        {q.choices.map((c, i) => {
          const isAns = i === q.answerIndex;
          const cls = !answered
            ? "border-line-strong bg-surface"
            : isAns
              ? "border-accent bg-accent-soft"
              : i === picked
                ? "border-danger bg-danger-soft"
                : "border-line bg-surface opacity-70";
          return (
            <button
              key={i}
              type="button"
              disabled={answered}
              lang={reading ? "ja" : undefined}
              className={`min-h-[52px] rounded-[var(--radius-box)] border px-4 py-2 text-left text-lg ${cls}`}
              data-testid="ja-daily-choice"
              onClick={() => {
                setPicked(i);
                setAnswers((a) => [...a, { wordId: q.wordId, mode: q.mode, correct: i === q.answerIndex }]);
              }}
            >
              {c}
              {answered && isAns ? " ✓" : ""}
            </button>
          );
        })}
      </div>
      {answered ? (
        <button
          type="button"
          className="u-btn u-btn-primary"
          data-testid="ja-daily-quiz-next"
          onClick={() => {
            setPicked(null);
            if (qi + 1 < questions.length) setQi(qi + 1);
            else setStage("result");
          }}
        >
          {qi + 1 < questions.length ? "다음 문제 →" : "결과 보기 →"}
        </button>
      ) : null}
    </div>
  );
}
