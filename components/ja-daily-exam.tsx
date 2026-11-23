"use client";

/**
 * components/ja-daily-exam.tsx — 🗓️ 오늘의 일본어 **📝 시험 대비 칸**(설계 §3-1·§4).
 *
 * - tip: 청해 요령(원음 + pointsKo) + **📜 원음 대본** 카드(drills — 회화 트랙과 같은 학습 형태: 해석 숨기기/보기 · 따라 말하기
 *   반복 수(회화와 같은 저장값) · 🗣️ 따라 말하기 ▶/⏸/이어서/⏹(번호 묶음을 넘어 전체 문장 순서대로, `components/use-ja-daily-shadow`)
 *   · 번호별 묶음(번호 + noteKo 머리) · 문장 탭 = 그 문장 일본어 발음) + 같은 원음의 예제 문항(기록하지 않는다)
 * - litems: 청해 문항 — 원음 ▶(없으면 대본 합성). 문제3·4는 보기 3개(보기 글자는 답한 뒤 공개 — 소리로 듣고 번호로 고른다),
 *   문제1·2는 "들었어요 → 대본·해석" 스스로 확인(choice·correct null). 답한 뒤 대본·해석·해설.
 * - mockItems·mockReview·weakItems·final: 모의 문항 연습 — 문제(`[[ ]]` 밑줄) + 보기 4 → 바로 정답·해석·해설. 청해는 원음,
 *   needsImage는 imageChoicesKo 설명으로, choicesAreAudio는 답하기 전 보기 글자를 숨긴다. 독해 지문은 문항 위에.
 * - mockSection: **실전** — 섹션을 이어 풀고 끝에 정답을 한꺼번에 공개(풀이 중에는 표현 도우미·상단 스트릭을 내린다 — usePhraseHelperBlock).
 * - mockScore: 채점표(언어지식·독해 ÷배점합×120, 청해 ÷배점합×60, 합격 기준 종합 80/180 · 기준점 38/120 · 19/60) + 오답 보기(답하지 않는다 —
 *   86회 "오답 다시 풀기"가 이 답들을 그대로 쓴다).
 */

import { useMemo, useState } from "react";
import JaRuby from "@/components/ja-ruby";
import { JaDailyAudio, pauseAllMedia } from "@/components/ja-daily-media";
import { JaDailyShadowControls, JaDailyShadowRepeatSelect, useJaDailyShadow, useJaDailyShadowRepeat } from "@/components/use-ja-daily-shadow";
import { usePhraseHelperBlock } from "@/components/use-phrase-helper-block";
import type { JaDailyExamView, JaDailyMockItemView, JaDailyMockScore } from "@/lib/ja-daily-contract";
import type { JaDailyListeningItem, JaDailyTipDrill } from "@/lib/ja-daily-content";
import { JA_DAILY_SECTION_KO, flattenJaDailyTipDrills, splitJaDailyUnderline, stripJaDailyUnderline } from "@/lib/ja-daily-quiz";
import { speak } from "@/lib/speech";

export type JaDailyExamAnswer = { itemId: string; choice: number | null; correct: boolean | null };
type Urls = Record<string, string | null>;

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥"];

function Marked({ text, className }: { text: string; className?: string }) {
  return (
    <span lang="ja" className={className}>
      {splitJaDailyUnderline(text).map((p, i) =>
        p.underline ? (
          <u key={i} className="decoration-2 underline-offset-4">
            {p.text}
          </u>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}

function choiceCls(answered: boolean, isAns: boolean, isPicked: boolean): string {
  if (!answered) return isPicked ? "border-accent bg-accent-soft" : "border-line-strong bg-surface";
  if (isAns) return "border-accent bg-accent-soft";
  if (isPicked) return "border-danger bg-danger-soft";
  return "border-line bg-surface opacity-70";
}

// ---------------------------------------------------------------------------
// 청해 문항
// ---------------------------------------------------------------------------

function litemFallback(it: JaDailyListeningItem): string[] {
  const out: string[] = [];
  if (it.situationJa) out.push(it.situationJa);
  if (it.questionJa) out.push(it.questionJa);
  for (const l of it.script) out.push(l.ja);
  if (it.questionJa && it.script.length > 0) out.push(it.questionJa);
  if (it.choices) it.choices.forEach((c, i) => out.push(`${i + 1}、${c.ja}`));
  return out;
}

function LitemCard({ item, url, onAnswer, label }: { item: JaDailyListeningItem; url: string | null | undefined; onAnswer: ((a: JaDailyExamAnswer) => void) | null; label: string }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const withChoices = item.choices !== null && item.choices.length > 0 && item.answer !== null;
  const done = withChoices ? picked !== null : revealed;
  return (
    <section className="u-card p-4" data-testid="ja-daily-litem">
      <p className="t-caption text-ink-3">
        {label} · 문제 {item.mondai} · {item.no}번
      </p>
      {item.situationJa ? (
        <p lang="ja" className="t-body mt-2">
          {item.situationJa}
        </p>
      ) : null}
      {item.questionJa && (withChoices || done) ? (
        <p lang="ja" className="t-body mt-1 font-bold">
          {item.questionJa}
        </p>
      ) : null}
      <div className="mt-3">
        <JaDailyAudio url={url} fallback={litemFallback(item)} />
      </div>

      {withChoices ? (
        <div className="mt-3 flex flex-col gap-2">
          {item.choices!.map((c, i) => {
            const n = i + 1;
            return (
              <button
                key={i}
                type="button"
                disabled={done}
                className={`min-h-[48px] rounded-[var(--radius-box)] border px-4 py-2 text-left ${choiceCls(done, n === item.answer, n === picked)}`}
                data-testid="ja-daily-litem-choice"
                onClick={() => {
                  setPicked(n);
                  onAnswer?.({ itemId: item.id, choice: n, correct: n === item.answer });
                }}
              >
                {CIRCLED[i] ?? n}{" "}
                {done ? (
                  <>
                    <span lang="ja">{c.ja}</span> <span className="t-caption text-ink-2">— {c.ko}</span>
                    {n === item.answer ? " ✓" : ""}
                  </>
                ) : (
                  <span className="t-caption text-ink-3">(소리로 듣고 고르기)</span>
                )}
              </button>
            );
          })}
        </div>
      ) : !revealed ? (
        <button
          type="button"
          className="u-btn u-btn-primary mt-3"
          data-testid="ja-daily-litem-heard"
          onClick={() => {
            setRevealed(true);
            onAnswer?.({ itemId: item.id, choice: null, correct: null });
          }}
        >
          들었어요 → 대본·해석 보기
        </button>
      ) : null}

      {done ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          {item.answerKo ? <p className="t-body font-bold">정답: {item.answerKo}</p> : null}
          {item.script.length > 0 ? (
            <ol className="flex flex-col gap-1">
              {item.script.map((l, i) => (
                <li key={i} className="t-caption">
                  {l.speaker ? <span className="text-ink-3">{l.speaker} </span> : null}
                  <span lang="ja" className="text-ink">
                    {l.ja}
                  </span>
                  <span className="block text-ink-2">{l.ko}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {item.explanationKo ? <p className="t-caption text-ink-2">💡 {item.explanationKo}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 모의 문항
// ---------------------------------------------------------------------------

function mockFallback(v: JaDailyMockItemView): string[] {
  const it = v.item;
  const out: string[] = [];
  if (it.introJa) out.push(stripJaDailyUnderline(it.introJa));
  if (it.questionJa) out.push(stripJaDailyUnderline(it.questionJa));
  for (const l of it.script ?? []) out.push(l.ja);
  if (it.choicesAreAudio) it.choices.forEach((c, i) => out.push(`${i + 1}、${stripJaDailyUnderline(c)}`));
  return out;
}

/** 문항 머리(섹션·지시문·지문·문제 문장·원음) — 연습·실전·오답 보기 공용 */
function MockHead({ v, url, showPassage, revealScript }: { v: JaDailyMockItemView; url: string | null | undefined; showPassage: boolean; revealScript: boolean }) {
  const it = v.item;
  const [ko, setKo] = useState(false);
  return (
    <>
      <p className="t-caption text-ink-3">
        모의 {v.round}회 · {JA_DAILY_SECTION_KO[v.section]} · 문제 {v.mondai} · {it.no}번
      </p>
      {v.instructionJa || v.instructionKo ? (
        <div className="mt-1">
          {v.instructionJa ? <Marked text={v.instructionJa} className="t-caption block text-ink-2" /> : null}
          {v.instructionKo && ko ? <p className="t-caption text-ink-3">{v.instructionKo}</p> : null}
          {v.instructionKo ? (
            <button type="button" className="t-caption text-ink-3 underline" onClick={() => setKo((x) => !x)}>
              {ko ? "지시문 해석 접기" : "지시문 해석"}
            </button>
          ) : null}
        </div>
      ) : null}
      {v.passage ? (
        <details className="mt-2 rounded-[var(--radius-box)] border border-line bg-surface-2 p-3" open={showPassage}>
          <summary className="t-caption cursor-pointer text-ink-3">지문</summary>
          {v.passage.introJa ? <Marked text={v.passage.introJa} className="t-caption mt-1 block text-ink-2" /> : null}
          <Marked text={v.passage.ja} className="mt-1 block whitespace-pre-wrap leading-relaxed" />
          {v.passage.ko && revealScript ? <p className="t-caption mt-2 whitespace-pre-wrap text-ink-2">{v.passage.ko}</p> : null}
        </details>
      ) : null}
      {it.audioKey ? (
        <div className="mt-3">
          <JaDailyAudio url={url} fallback={mockFallback(v)} />
        </div>
      ) : null}
      {it.introJa ? <Marked text={it.introJa} className="t-body mt-2 block" /> : null}
      {it.questionJa ? <Marked text={it.questionJa} className="t-body mt-1 block font-bold" /> : null}
      {it.stemJa ? <Marked text={it.stemJa} className="mt-2 block text-xl leading-relaxed" /> : null}
      {it.needsImage ? <p className="t-caption mt-2 text-ink-3">🖼️ 그림 문항 — 교재 그림 없이 소리·대본과 아래 그림 설명으로 풀어요.</p> : null}
    </>
  );
}

function MockExplain({ v }: { v: JaDailyMockItemView }) {
  const it = v.item;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
      <p className="t-body font-bold">
        정답: {CIRCLED[it.answer - 1] ?? it.answer} <span lang="ja">{stripJaDailyUnderline(it.choices[it.answer - 1] ?? "")}</span>
      </p>
      {it.script && it.script.length > 0 ? (
        <ol className="flex flex-col gap-1">
          {it.script.map((l, i) => (
            <li key={i} className="t-caption" lang="ja">
              {l.speaker ? <span className="text-ink-3">{l.speaker} </span> : null}
              {l.ja}
            </li>
          ))}
        </ol>
      ) : null}
      {it.translationKo ? <p className="t-caption whitespace-pre-wrap text-ink-2">해석: {it.translationKo}</p> : null}
      {it.explanationKo ? <p className="t-caption whitespace-pre-wrap text-ink-2">💡 {it.explanationKo}</p> : null}
    </div>
  );
}

function MockChoices({ v, picked, answered, onPick }: { v: JaDailyMockItemView; picked: number | null; answered: boolean; onPick: ((n: number) => void) | null }) {
  const it = v.item;
  const hideText = it.choicesAreAudio === true && !answered;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {hideText ? <p className="t-caption text-ink-3">보기는 소리로 나와요 — 듣고 번호를 고르세요.</p> : null}
      {it.choices.map((c, i) => {
        const n = i + 1;
        const img = it.imageChoicesKo?.[i];
        return (
          <button
            key={i}
            type="button"
            disabled={onPick === null}
            className={`min-h-[48px] rounded-[var(--radius-box)] border px-4 py-2 text-left ${choiceCls(answered, n === it.answer, n === picked)}`}
            data-testid="ja-daily-mock-choice"
            onClick={() => onPick?.(n)}
          >
            {CIRCLED[i] ?? n} {hideText ? null : <Marked text={c} />}
            {img && (!it.choicesAreAudio || answered || it.needsImage) ? <span className="t-caption block text-ink-2">🖼️ {img}</span> : null}
            {answered && n === it.answer ? " ✓" : ""}
          </button>
        );
      })}
    </div>
  );
}

/** 연습 — 고르면 바로 정답 */
function MockPracticeCard({ v, url, showPassage, onAnswer }: { v: JaDailyMockItemView; url: string | null | undefined; showPassage: boolean; onAnswer: (a: JaDailyExamAnswer) => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const answered = picked !== null;
  return (
    <section className="u-card p-4" data-testid="ja-daily-mock-item">
      <MockHead v={v} url={url} showPassage={showPassage} revealScript={answered} />
      <MockChoices
        v={v}
        picked={picked}
        answered={answered}
        onPick={
          answered
            ? null
            : (n) => {
                setPicked(n);
                onAnswer({ itemId: v.item.id, choice: n, correct: n === v.item.answer });
              }
        }
      />
      {answered ? <MockExplain v={v} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 실전(mockSection)
// ---------------------------------------------------------------------------

function MockSectionRun({ items, urls, onDone }: { items: JaDailyMockItemView[]; urls: Urls; onDone: (answers: JaDailyExamAnswer[]) => void }) {
  const [i, setI] = useState(0);
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [finished, setFinished] = useState(false);
  usePhraseHelperBlock(!finished);
  if (finished) {
    const right = items.filter((v) => choices[v.item.id] === v.item.answer).length;
    return (
      <div className="flex flex-col gap-3" data-testid="ja-daily-mock-reveal">
        <div className="u-card p-5 text-center">
          <p className="t-caption text-ink-3">실전 결과</p>
          <p className="t-stat-number mt-1">
            {right} / {items.length}
          </p>
          <p className="t-caption text-ink-2">점수 환산은 채점표 회차에서 보여 줘요.</p>
        </div>
        {items.map((v) => {
          const c = choices[v.item.id] ?? null;
          const ok = c === v.item.answer;
          return (
            <details key={v.item.id} className="u-card p-4">
              <summary className="cursor-pointer">
                <span className={ok ? "text-accent-ink" : "text-danger"}>{ok ? "✓" : c === null ? "–" : "✗"}</span> {JA_DAILY_SECTION_KO[v.section]} 문제 {v.mondai} · {v.item.no}번
                {c !== null ? ` · 내 답 ${CIRCLED[c - 1] ?? c}` : " · 안 풂"}
              </summary>
              <MockHead v={v} url={urls[v.item.audioKey ?? ""]} showPassage={false} revealScript />
              <MockChoices v={v} picked={c} answered onPick={null} />
              <MockExplain v={v} />
            </details>
          );
        })}
        <button
          type="button"
          className="u-btn u-btn-primary"
          data-testid="ja-daily-exam-done"
          onClick={() => onDone(items.filter((v) => choices[v.item.id] !== undefined).map((v) => ({ itemId: v.item.id, choice: choices[v.item.id], correct: choices[v.item.id] === v.item.answer })))}
        >
          다음 칸 →
        </button>
      </div>
    );
  }
  const v = items[i];
  const prev = items[i - 1];
  const picked = choices[v.item.id] ?? null;
  const last = i + 1 >= items.length;
  return (
    <div className="flex flex-col gap-3" data-testid="ja-daily-mock-exam">
      <div className="flex items-baseline justify-between">
        <p className="t-section-title">실전 · 정답은 끝에 공개</p>
        <span className="t-caption text-ink-3">
          {i + 1}/{items.length}
        </span>
      </div>
      <section className="u-card p-4" key={v.item.id}>
        <MockHead v={v} url={urls[v.item.audioKey ?? ""]} showPassage={!prev || prev.passage?.id !== v.passage?.id} revealScript={false} />
        <MockChoices v={v} picked={picked} answered={false} onPick={(n) => setChoices((c) => ({ ...c, [v.item.id]: n }))} />
      </section>
      <div className="flex gap-2">
        <button type="button" className="u-btn u-btn-secondary flex-1" disabled={i === 0} onClick={() => setI(i - 1)}>
          ← 이전
        </button>
        <button
          type="button"
          className="u-btn u-btn-primary flex-1"
          data-testid="ja-daily-mock-next"
          onClick={() => {
            if (last) setFinished(true);
            else setI(i + 1);
            window.scrollTo({ top: 0 });
          }}
        >
          {last ? "끝내고 정답 보기" : picked === null ? "건너뛰기 →" : "다음 →"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 채점표
// ---------------------------------------------------------------------------

function ScoreTable({ score }: { score: JaDailyMockScore }) {
  const row = (name: string, s: JaDailyMockScore["langReading"], max: number, cut: number) => (
    <tr>
      <td>{name}</td>
      <td className="text-right tabular-nums">
        {s.scaled} / {max}
      </td>
      <td className="text-right tabular-nums text-ink-3">
        {s.raw}/{s.max}
      </td>
      <td className={s.pass ? "text-accent-ink" : "text-danger"}>{s.pass ? `기준점 ${cut} 통과` : `기준점 ${cut} 미달`}</td>
    </tr>
  );
  return (
    <section className="u-card p-4" data-testid="ja-daily-score">
      <p className="t-section-title">모의 {score.round}회 채점표</p>
      <table className="u-table mt-2 w-full t-caption">
        <thead>
          <tr>
            <th className="text-left">과목</th>
            <th className="text-right">환산</th>
            <th className="text-right">원점수</th>
            <th className="text-left">기준</th>
          </tr>
        </thead>
        <tbody>
          {row("언어지식·독해", score.langReading, 120, 38)}
          {row("청해", score.listening, 60, 19)}
        </tbody>
      </table>
      <p className={`mt-3 text-xl font-bold ${score.pass ? "text-accent-ink" : "text-danger"}`}>
        종합 {score.total} / 180 · {score.pass ? "합격권" : "아직 불합격권"}
      </p>
      <p className="t-caption mt-1 text-ink-3">
        N5 합격 기준: 종합 80/180 이상 + 과목별 기준점(언어지식·독해 38/120, 청해 19/60). 환산은 배점 비율로 어림한 값이에요(실제 시험은 등화 처리).
      </p>
      {score.unansweredItemIds.length > 0 ? <p className="t-caption mt-1 text-ink-3">안 푼 문항 {score.unansweredItemIds.length}개는 틀린 것으로 셌어요.</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 청해 요령 원음 대본
// ---------------------------------------------------------------------------

const DRILLS_KEY = "tip-drills";

type Shadow = ReturnType<typeof useJaDailyShadow>;

/** 📜 원음 대본 — 회화 트랙과 같은 학습 형태. 따라 말하기는 번호 묶음을 넘어 전체 문장을 순서대로 */
function TipDrills({ drills, titleKo, sh, repeat, setRepeat }: { drills: readonly JaDailyTipDrill[]; titleKo: string; sh: Shadow; repeat: number; setRepeat: (v: number) => void }) {
  const [showKo, setShowKo] = useState(true);
  const { lines, offsets } = useMemo(() => flattenJaDailyTipDrills(drills), [drills]);
  const target = { key: DRILLS_KEY, lines, artist: `청해 요령 · ${titleKo}` };
  const active = sh.shadow?.key === DRILLS_KEY ? sh.shadow : null;
  return (
    <section className="u-card p-4" data-testid="ja-daily-tip-drills">
      <p className="t-section-title">📜 원음 대본</p>
      <p className="t-caption mt-1 text-ink-3">위 원음에 나오는 문장이에요. 문장을 누르면 그 문장을 들려줘요.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="u-chip" onClick={() => setShowKo((v) => !v)} aria-pressed={showKo}>
          {showKo ? "해석 숨기기" : "해석 보기"}
        </button>
        <JaDailyShadowRepeatSelect repeat={repeat} onChange={setRepeat} />
      </div>
      <JaDailyShadowControls
        active={active}
        onStart={() => sh.startShadow(target, 0)}
        onPause={sh.pauseShadow}
        onResume={(line) => sh.startShadow(target, line)}
        onStop={() => sh.stopShadow(true)}
        testId="ja-daily-tip-shadow"
      />
      <ol className="mt-3 flex flex-col gap-4">
        {drills.map((d, di) => (
          <li key={`${d.no}-${di}`} data-testid="ja-daily-tip-drill">
            <p className="t-caption text-ink-3">
              <span className="font-bold text-ink-2">{d.no}.</span>
              {d.noteKo ? <span className="ml-1 text-accent-ink">{d.noteKo}</span> : null}
            </p>
            <ol className="mt-1 flex flex-col gap-2">
              {d.items.map((it, i) => {
                const idx = offsets[di] + i;
                return (
                  <li key={`${d.no}-${i}`}>
                    <button
                      type="button"
                      className={`w-full rounded-[var(--radius-box)] border px-3 py-2 text-left ${active && active.line === idx ? "border-accent bg-accent-soft" : "border-line bg-surface"}`}
                      data-testid="ja-daily-tip-line"
                      onClick={() => {
                        if (sh.shadowRef.current) sh.stopShadow(true);
                        pauseAllMedia();
                        speak(it.ja, "ja-JP");
                      }}
                    >
                      <JaRuby tokens={it.tokens} className="text-lg" />
                      {showKo ? <span className="t-caption mt-0.5 block text-ink-2">{it.ko}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 칸
// ---------------------------------------------------------------------------

export default function JaDailyExam({ view, urls, onDone }: { view: JaDailyExamView; urls: Urls; onDone: (answers: JaDailyExamAnswer[]) => void }) {
  const [answers, setAnswers] = useState<JaDailyExamAnswer[]>([]);
  const record = (a: JaDailyExamAnswer) => setAnswers((cur) => [...cur.filter((x) => x.itemId !== a.itemId), a]);
  /** 청해 요령 원음 대본의 따라 말하기 — 칸을 떠나면(언마운트) 훅이, "다음" 탭이면 여기서 멈추고 잠금 화면 바인딩을 푼다 */
  const { repeat, setRepeat } = useJaDailyShadowRepeat();
  const sh = useJaDailyShadow(repeat);
  const finishBtn = (label = "다음 칸 →") => (
    <button
      type="button"
      className="u-btn u-btn-primary"
      data-testid="ja-daily-exam-done"
      onClick={() => {
        sh.stopShadow(true);
        pauseAllMedia();
        onDone(answers);
      }}
    >
      {label}
    </button>
  );

  if (view.type === "empty") {
    return (
      <div className="u-card p-5">
        <p className="t-body">오늘은 시험 대비 칸 내용이 없어요.</p>
        <div className="mt-4">{finishBtn("다음 →")}</div>
      </div>
    );
  }
  if (view.type === "mockSection") {
    if (view.items.length === 0) {
      return (
        <div className="u-card p-5">
          <p className="t-body">이 회차의 실전 문항이 없어요.</p>
          <div className="mt-4">{finishBtn("다음 →")}</div>
        </div>
      );
    }
    return <MockSectionRun items={view.items} urls={urls} onDone={onDone} />;
  }

  const practice = (items: JaDailyMockItemView[]) =>
    items.map((v, i) => <MockPracticeCard key={v.item.id} v={v} url={urls[v.item.audioKey ?? ""]} showPassage={i === 0 || items[i - 1].passage?.id !== v.passage?.id} onAnswer={record} />);

  return (
    <div className="flex flex-col gap-4">
      {view.type === "tip" ? (
        <>
          <section className="u-card p-4" data-testid="ja-daily-tip">
            <p className="t-caption text-ink-3">청해 요령</p>
            <p className="t-list-title mt-1">{view.tip.titleKo}</p>
            <div className="mt-3">
              <JaDailyAudio url={urls[view.tip.audioKey]} fallback={[]} />
            </div>
            <ul className="mt-3 list-disc pl-5 t-body">
              {view.tip.pointsKo.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </section>
          {view.tip.drills && view.tip.drills.length > 0 ? <TipDrills drills={view.tip.drills} titleKo={view.tip.titleKo} sh={sh} repeat={repeat} setRepeat={setRepeat} /> : null}
          {view.examples.map((it) => (
            <LitemCard key={it.id} item={it} url={urls[it.audioKey]} onAnswer={null} label="예제" />
          ))}
        </>
      ) : null}

      {view.type === "litems" ? (
        view.items.length > 0 ? (
          view.items.map((it) => <LitemCard key={it.id} item={it} url={urls[it.audioKey]} onAnswer={record} label="청해 훈련" />)
        ) : (
          <p className="t-body">오늘 청해 문항이 없어요.</p>
        )
      ) : null}

      {view.type === "mockItems" || view.type === "mockReview" ? (
        <>
          {view.type === "mockReview" ? <p className="t-lead">모의 {view.round}회에서 틀린 문항을 다시 풀어요.</p> : null}
          {view.items.length > 0 ? practice(view.items) : <p className="t-body">{view.type === "mockReview" ? "틀린 문항이 없어요 🎉" : "오늘 문항이 없어요."}</p>}
        </>
      ) : null}

      {view.type === "mockScore" ? (
        <>
          <ScoreTable score={view.score} />
          {view.items.length > 0 ? (
            <>
              <p className="t-section-title">틀린·안 푼 문항 보기</p>
              {view.items.map((v) => (
                <details key={v.item.id} className="u-card p-4">
                  <summary className="cursor-pointer t-caption">
                    {JA_DAILY_SECTION_KO[v.section]} 문제 {v.mondai} · {v.item.no}번
                  </summary>
                  <MockHead v={v} url={urls[v.item.audioKey ?? ""]} showPassage revealScript />
                  <MockChoices v={v} picked={null} answered onPick={null} />
                  <MockExplain v={v} />
                </details>
              ))}
            </>
          ) : null}
        </>
      ) : null}

      {view.type === "weakItems" || view.type === "final" ? (
        <>
          <p className="t-lead">{view.type === "final" ? "총정리 — 약한 문항을 다시 풀어요." : "약한 문항을 다시 풀어요."}</p>
          {view.litems.map((it) => (
            <LitemCard key={it.id} item={it} url={urls[it.audioKey]} onAnswer={record} label="청해" />
          ))}
          {practice(view.mockItems)}
          {view.litems.length + view.mockItems.length === 0 ? <p className="t-body">아직 다시 풀 문항이 없어요.</p> : null}
        </>
      ) : null}

      {finishBtn()}
    </div>
  );
}
