"use client";

/**
 * components/ja-daily-kaiwa.tsx — 🗓️ 오늘의 일본어 **🗣️ 회화 칸**(설계 §4).
 *
 * 트랙마다: 원음 ▶(기기 보관소 — 없으면 "원음 없음 · 합성 음성" 칩 + 문장 합성 이어 읽기) · 문장 목록(후리가나 `components/ja-ruby.tsx`,
 * 한국어 해석 접기/펴기, 문장 탭 = 그 문장 합성 음성) · **따라 말하기 ▶**(한국어 1번 → 일본어 N번, 일본어 뒤 따라 말할 틈 —
 * `speakQueue` `pauseAfterMs`, 전역 속도는 speech가 따른다, 잠금 화면 조작은 `lib/media-session` 관문 — ⏸에서 바인딩을 풀지 않고
 * ▶로 그 문장부터 잇는다 — 큐·잠금 화면·반복 수는 청해 요령 원음 대본과 같이 쓰는 `components/use-ja-daily-shadow`).
 * 단위에 🎤 문장(keyLineIds)이 있으면 마지막에 핵심 문장 체크. withPoints면 과 포인트(pointsKo)를 보인다.
 * 대본 조각은 lib/ja-daily-quiz `buildJaDailyShadowItems`(순수)가 만든다.
 */

import { useMemo, useState } from "react";
import JaRuby from "@/components/ja-ruby";
import JaDailyLineCheck from "@/components/ja-daily-line-check";
import { JaDailyAudio, pauseAllMedia } from "@/components/ja-daily-media";
import { JaDailyShadowControls, JaDailyShadowRepeatSelect, useJaDailyShadow, useJaDailyShadowRepeat, type JaDailyShadowTarget } from "@/components/use-ja-daily-shadow";
import type { JaDailyKaiwaCheck, JaDailyKaiwaView } from "@/lib/ja-daily-contract";
import type { JaDailyTrack } from "@/lib/ja-daily-content";
import { JA_DAILY_PART_KO, jaDailyLineGroups } from "@/lib/ja-daily-quiz";
import { speak } from "@/lib/speech";

type Unit = Extract<JaDailyKaiwaView, { type: "unit" }>;

export default function JaDailyKaiwa({ view, urls, onDone }: { view: Unit; urls: Record<string, string | null>; onDone: (checks: JaDailyKaiwaCheck[]) => void }) {
  const [showKo, setShowKo] = useState(true);
  const { repeat, setRepeat } = useJaDailyShadowRepeat();
  const [stage, setStage] = useState<"listen" | "check">("listen");
  const { shadow, shadowRef, startShadow, pauseShadow, stopShadow } = useJaDailyShadow(repeat);
  const target = (track: JaDailyTrack): JaDailyShadowTarget => ({
    key: track.audioKey,
    lines: track.lines,
    artist: `${view.lesson.titleJa} · ${JA_DAILY_PART_KO[track.part]}`,
  });

  const keyLines = useMemo(() => {
    const all = view.tracks.flatMap((t) => t.lines);
    return view.keyLineIds.map((id) => all.find((l) => l.id === id)).filter((l): l is NonNullable<typeof l> => l !== undefined);
  }, [view]);
  const keySet = useMemo(() => new Set(view.keyLineIds), [view.keyLineIds]);
  /** 회화 연습 트랙의 번호 묶음 머리(例·1番…) — 묶음이 시작하는 문장 index → 이름 */
  const groupStarts = useMemo(() => {
    const m = new Map<string, Map<number, string>>();
    for (const t of view.tracks) {
      const g = jaDailyLineGroups(t.part, t.lines);
      if (g) m.set(t.audioKey, new Map(g.map((x) => [x.start, x.label])));
    }
    return m;
  }, [view.tracks]);
  const groupAt = (t: JaDailyTrack, i: number) => groupStarts.get(t.audioKey)?.get(i) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <header className="u-card p-4">
        <p className="t-caption text-ink-3">
          {view.review ? "약한 과 다시 하기" : `${view.lesson.step}단계 ${view.lesson.lesson}과 · ${view.unit}`}
        </p>
        <p lang="ja" className="t-list-title mt-1">
          {view.lesson.titleJa}
        </p>
        <p className="t-caption text-ink-2">{view.lesson.titleKo}</p>
        {view.withPoints && view.lesson.pointsKo.length > 0 ? (
          <ul className="mt-3 list-disc pl-5 t-caption text-ink-2" data-testid="ja-daily-points">
            {view.lesson.pointsKo.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        ) : null}
      </header>

      {stage === "listen" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="u-chip" onClick={() => setShowKo((v) => !v)} aria-pressed={showKo}>
              {showKo ? "해석 숨기기" : "해석 보기"}
            </button>
            <JaDailyShadowRepeatSelect repeat={repeat} onChange={setRepeat} />
          </div>

          {view.tracks.map((t) => {
            const active = shadow?.key === t.audioKey ? shadow : null;
            return (
              <section key={t.audioKey} className="u-card p-4" data-testid="ja-daily-track">
                <p className="t-section-title mb-2">{JA_DAILY_PART_KO[t.part]}</p>
                <JaDailyAudio url={urls[t.audioKey]} fallback={t.lines.map((l) => l.ja)} />
                <JaDailyShadowControls
                  active={active}
                  onStart={() => startShadow(target(t), 0)}
                  onPause={pauseShadow}
                  onResume={(line) => startShadow(target(t), line)}
                  onStop={() => stopShadow(true)}
                  testId="ja-daily-shadow"
                />
                <ol className="mt-3 flex flex-col gap-2">
                  {t.lines.map((l, i) => (
                    <li key={l.id}>
                      {groupAt(t, i) ? (
                        <p lang="ja" className={`t-caption font-semibold text-accent-ink ${i > 0 ? "mt-3" : ""}`} data-testid="ja-daily-line-group">
                          {groupAt(t, i)}
                          {groupAt(t, i) === "例" ? <span lang="ko"> · 예시</span> : null}
                        </p>
                      ) : null}
                      <button
                        type="button"
                        className={`w-full rounded-[var(--radius-box)] border px-3 py-2 text-left ${active && active.line === i ? "border-accent bg-accent-soft" : "border-line bg-surface"}`}
                        onClick={() => {
                          if (shadowRef.current) stopShadow(true);
                          pauseAllMedia();
                          speak(l.ja, "ja-JP");
                        }}
                      >
                        <span className="flex items-start gap-2">
                          {l.speaker ? <span className="t-caption mt-1 flex-none text-ink-3">{l.speaker}</span> : null}
                          <span className="min-w-0 flex-1">
                            <JaRuby tokens={l.tokens} className="text-lg" />
                            {keySet.has(l.id) ? <span className="ml-1 t-caption text-accent-ink">🎤</span> : null}
                            {showKo ? <span className="t-caption mt-0.5 block text-ink-2">{l.ko}</span> : null}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            );
          })}

          <button
            type="button"
            className="u-btn u-btn-primary"
            data-testid="ja-daily-kaiwa-next"
            onClick={() => {
              stopShadow(true);
              pauseAllMedia();
              if (keyLines.length > 0) {
                setStage("check");
                window.scrollTo({ top: 0 });
              } else onDone([]);
            }}
          >
            {keyLines.length > 0 ? `🎤 핵심 문장 체크로 (${keyLines.length}문장) →` : "회화 끝 →"}
          </button>
        </>
      ) : (
        <JaDailyLineCheck lines={keyLines} onFinish={onDone} />
      )}
    </div>
  );
}
