"use client";

/**
 * 오늘의 복습 러너 (SPEC §23-2·§23-7) — 힌트 사다리. 클라이언트 컴포넌트, AI 없음.
 *
 * 카드마다: 단서 → 🤔 떠올리기(잠깐 기다림 — 힌트 버튼이 그동안 잠긴다) → 💡 힌트1(첫 글자) → 💡 힌트2(뼈대) → 정답.
 * 어느 단계에서든 "생각났어요 · 정답 확인"을 누를 수 있고, 그때까지 연 힌트 수가 hintLevel(0~2)이다. 힌트2 뒤 "정답 보기"는 hintLevel 3
 * (판정 없이 "몰랐어요"로 적용 — 내일 다시). 정답을 본 뒤 스스로 판정(맞췄어요/헷갈렸어요/몰랐어요 — 은우는 😀🤔😢)하면
 * `POST /api/review/record`로 적용하고 다음 카드로 간다. 판정 규칙(간격)은 서버의 순수 엔진(lib/review-schedule)이 정한다.
 *
 * - 🔊는 정답 공개 뒤 **탭할 때만**(speak — 탭 안 동기 호출). 프리페치하지 않는다(§23-8 비용 0 — 키가 없으면 기기 음성).
 * - 진행 중에는 표현 도우미를 막는다(usePhraseHelperBlock + 경로 판정 두 겹, SPEC §22-3).
 * - 첫 적용 성공 때 스트릭 갱신 이벤트를 한 번 쏜다(§23-9).
 * - 렌더 중 시각·localStorage를 읽지 않는다(hydration). 타이머는 effect에서만.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import JaRuby from "@/components/ja-ruby";
import { usePhraseHelperBlock } from "@/components/use-phrase-helper-block";
import type { ReviewArea, ReviewCard, ReviewErrorResponse, ReviewHintLevel, ReviewJudge, ReviewRecordResponse } from "@/lib/review-contract";
import { reviewIntervalLabelKo, summarizeReviewResults, type ReviewRunResult } from "@/lib/review-schedule";
import { speak, stopSpeaking } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import s from "./review-runner.module.css";

type Tone = "kid" | "adult";

/** 떠올리기 시간(ms) — 처음 단서, 힌트를 연 뒤 */
const THINK_MS: Record<Tone, { first: number; after: number }> = {
  kid: { first: 5000, after: 3000 },
  adult: { first: 4000, after: 2500 },
};

const TEXT: Record<Tone, {
  cueLabel: string;
  think: string;
  thinkDone: string;
  recall: string;
  hint: (n: number) => string;
  reveal: string;
  judge: Record<ReviewJudge, string>;
  forgotOnly: string;
  hintLabel: [string, string];
  empty: string;
  done: string;
  speak: string;
}> = {
  kid: {
    cueLabel: "무슨 단어일까?",
    think: "🤔 머릿속에서 꺼내 보자…",
    thinkDone: "생각이 안 나면 힌트를 열어 봐요",
    recall: "생각났어! 정답 보기 👀",
    hint: (n) => `💡 힌트 ${n}`,
    reveal: "정답 보기",
    judge: { got: "😀 맞혔어", unsure: "🤔 헷갈렸어", forgot: "😢 몰랐어" },
    forgotOnly: "알았어! 내일 또 하자",
    hintLabel: ["첫 글자", "글자 수"],
    empty: "오늘 복습할 단어가 없어요. 단어장 시험을 보면 여기로 와요!",
    done: "오늘 복습 끝! 잘했어요 🎉",
    speak: "🔊 들어 보기",
  },
  adult: {
    cueLabel: "떠올려 보세요",
    think: "🤔 보지 말고 떠올려 보세요",
    thinkDone: "막히면 힌트를 하나씩 여세요",
    recall: "생각났어요 · 정답 확인",
    hint: (n) => `💡 힌트 ${n}`,
    reveal: "정답 보기",
    judge: { got: "맞췄어요", unsure: "헷갈렸어요", forgot: "몰랐어요" },
    forgotOnly: "확인했어요 · 내일 다시",
    hintLabel: ["첫 글자", "뼈대"],
    empty: "오늘 복습할 항목이 없어요. 시험을 본 항목이 여기로 들어와요.",
    done: "오늘의 복습을 마쳤어요.",
    speak: "🔊 발음",
  },
};

export default function ReviewRunner({
  area,
  tone,
  cards,
  doneToday,
  dueCount,
  cap,
  failedSources,
  backHref,
  backLabel,
}: {
  area: ReviewArea;
  tone: Tone;
  cards: ReviewCard[];
  doneToday: number;
  dueCount: number;
  cap: number;
  failedSources: number;
  backHref: string;
  backLabel: string;
}) {
  usePhraseHelperBlock(); // 복습(떠올리기) 중에는 표현 도우미를 띄우지 않는다(SPEC §22-3)
  const t = TEXT[tone];
  const [index, setIndex] = useState(0);
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2>(0);
  const [revealed, setRevealed] = useState<ReviewHintLevel | null>(null);
  const [thinkReady, setThinkReady] = useState(false);
  const [thinkKey, setThinkKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ReviewRunResult[]>([]);
  const [finished, setFinished] = useState(cards.length === 0);
  const streakFired = useRef(false);

  const card = cards[index] ?? null;
  const thinkMs = hintLevel === 0 ? THINK_MS[tone].first : THINK_MS[tone].after;

  // 떠올리기 시간 — 카드·힌트가 바뀔 때마다 다시 잰다. 그동안 힌트 버튼이 잠긴다(쥐어짜기)
  useEffect(() => {
    if (finished || revealed !== null) return;
    setThinkReady(false);
    const id = window.setTimeout(() => setThinkReady(true), thinkMs);
    return () => window.clearTimeout(id);
  }, [index, hintLevel, revealed, finished, thinkMs, thinkKey]);

  useEffect(() => () => stopSpeaking(), []);

  const openHint = () => {
    if (!thinkReady || hintLevel >= 2) return;
    setHintLevel((h) => (h === 0 ? 1 : 2));
    setThinkKey((k) => k + 1);
  };
  const recall = () => setRevealed(hintLevel);
  const giveUp = () => setRevealed(3);

  const submit = useCallback(
    async (judge: ReviewJudge) => {
      if (!card || revealed === null || saving) return;
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/review/record", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ area, itemKey: card.itemKey, hintLevel: revealed, judge }),
        });
        const body = (await res.json().catch(() => null)) as ReviewRecordResponse | ReviewErrorResponse | null;
        if (!res.ok || !body || body.ok !== true) {
          setError(body && body.ok === false ? body.messageKo : "저장하지 못했어요. 다시 눌러 주세요.");
          return;
        }
        setResults((r) => [...r, { judge: body.judge, intervalDays: body.intervalDays }]);
        if (!streakFired.current) {
          streakFired.current = true;
          window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT));
        }
        stopSpeaking();
        if (index + 1 >= cards.length) setFinished(true);
        else {
          setIndex((i) => i + 1);
          setHintLevel(0);
          setRevealed(null);
        }
      } catch {
        setError("연결이 끊겼어요. 다시 눌러 주세요.");
      } finally {
        setSaving(false);
      }
    },
    [area, card, cards.length, index, revealed, saving],
  );

  const kidCls = tone === "kid" ? s.kid : "";

  if (finished) {
    const sum = summarizeReviewResults(results);
    const remaining = Math.max(0, dueCount - results.length);
    const capHit = doneToday + results.length >= cap && remaining > 0;
    return (
      <section className={`${s.summary} ${kidCls}`} data-testid="review-summary">
        <p className="t-section-title">{results.length > 0 ? t.done : t.empty}</p>
        {results.length > 0 && (
          <>
            <div className={s.stats}>
              <div className={s.stat}>
                <span className={s.statNum}>{sum.got}</span>
                <span className={s.statLabel}>{tone === "kid" ? "😀 맞혔어" : "맞힘"}</span>
              </div>
              <div className={s.stat}>
                <span className={s.statNum}>{sum.unsure}</span>
                <span className={s.statLabel}>{tone === "kid" ? "🤔 헷갈렸어" : "헷갈림"}</span>
              </div>
              <div className={s.stat}>
                <span className={s.statNum}>{sum.forgot}</span>
                <span className={s.statLabel}>{tone === "kid" ? "😢 몰랐어" : "몰랐음"}</span>
              </div>
            </div>
            <div>
              <p className="t-caption">다음 복습</p>
              <ul className={s.dist} data-testid="review-dist">
                {sum.byInterval.map((b) => (
                  <li key={b.days} className="u-chip">
                    {reviewIntervalLabelKo(b.days)} {b.count}개
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
        {capHit && <p className="t-caption">하루 {cap}개까지만 해요. 남은 것은 내일 이어서 나와요.</p>}
        {failedSources > 0 && <p className="t-caption">일부 기록을 읽지 못해 빠진 항목이 있어요.</p>}
        <Link href={backHref} className="u-btn u-btn-primary">
          {backLabel}
        </Link>
      </section>
    );
  }

  if (!card) return null;
  const progress = Math.round((index / cards.length) * 100);
  const showRuby = card.answer.ruby !== null && card.answer.ruby.some((r) => r.reading !== null);

  return (
    <section className={`${s.wrap} ${kidCls}`} data-testid="review-runner" data-item-key={card.itemKey}>
      <div className={s.topRow}>
        <span className="t-caption">
          {doneToday > 0 ? `오늘 ${doneToday}개 끝 · ` : ""}하루 {cap}개
        </span>
        <span className={s.counter} data-testid="review-counter">
          {index + 1} / {cards.length}
        </span>
      </div>
      <div className={s.progressTrack} aria-hidden>
        <div className={s.progressFill} style={{ width: `${progress}%` }} />
      </div>

      <div className={s.cue}>
        <p className={s.cueLabel}>{t.cueLabel}</p>
        {card.cue.emoji && (
          <span className={s.cueEmoji} aria-hidden>
            {card.cue.emoji}
          </span>
        )}
        <p className={s.cueMain} lang={card.cue.lang} data-testid="review-cue">
          {card.cue.main}
        </p>
        {card.cue.sub && <p className={s.cueSub}>{card.cue.sub}</p>}
        <p className={s.source}>{card.sourceKo}</p>
      </div>

      {hintLevel >= 1 && (
        <div className={s.hints}>
          <div className={s.hint} data-testid="review-hint1">
            <span className={s.hintLabel}>{card.kind === "toeic-template" || card.kind === "toeic-island" ? "첫 낱말" : t.hintLabel[0]}</span>
            <span className={s.hintText}>{card.hint1}</span>
          </div>
          {hintLevel >= 2 && (
            <div className={s.hint} data-testid="review-hint2">
              <span className={s.hintLabel}>{t.hintLabel[1]}</span>
              <span className={s.hintText}>{card.hint2}</span>
              {card.hint2Note && <span className={s.hintNote}>{card.hint2Note}</span>}
            </div>
          )}
        </div>
      )}

      {revealed === null ? (
        <>
          <div className={s.think} aria-live="polite">
            <p className={s.thinkText}>{thinkReady ? t.thinkDone : t.think}</p>
            <div className={s.thinkTrack} aria-hidden>
              <div key={`${index}-${hintLevel}-${thinkKey}`} className={s.thinkFill} style={{ animationDuration: `${thinkMs}ms` }} />
            </div>
          </div>
          <div className={s.actions}>
            <button type="button" className="u-btn u-btn-primary" onClick={recall} data-testid="review-recall">
              {t.recall}
            </button>
            {hintLevel < 2 ? (
              <button type="button" className="u-btn u-btn-secondary" onClick={openHint} disabled={!thinkReady} data-testid="review-hint-btn">
                {t.hint(hintLevel + 1)}
              </button>
            ) : (
              <button type="button" className="u-btn u-btn-secondary" onClick={giveUp} disabled={!thinkReady} data-testid="review-giveup">
                {t.reveal}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className={s.answer} data-testid="review-answer">
            <p className={s.answerMain} lang={card.speak?.lang ?? undefined}>
              {showRuby && card.answer.ruby ? <JaRuby tokens={card.answer.ruby} /> : card.answer.main}
            </p>
            {card.answer.sub && <p className={s.answerSub}>{card.answer.sub}</p>}
            {card.speak && (
              <button
                type="button"
                className={`u-btn u-btn-secondary ${s.speakBtn}`}
                onClick={() => card.speak && speak(card.speak.text, card.speak.lang)}
                data-testid="review-speak"
              >
                {t.speak}
              </button>
            )}
          </div>
          <div className={s.actions}>
            {revealed === 3 ? (
              <button type="button" className="u-btn u-btn-primary" onClick={() => submit("forgot")} disabled={saving} data-testid="review-judge-forgot">
                {t.forgotOnly}
              </button>
            ) : (
              <div className={s.actionRow}>
                {(["got", "unsure", "forgot"] as const).map((j) => (
                  <button
                    key={j}
                    type="button"
                    className={`u-btn ${j === "got" ? "u-btn-primary" : "u-btn-secondary"}`}
                    onClick={() => submit(j)}
                    disabled={saving}
                    data-testid={`review-judge-${j}`}
                  >
                    {t.judge[j]}
                  </button>
                ))}
              </div>
            )}
            {error && (
              <p className={s.error} role="alert">
                {error}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
