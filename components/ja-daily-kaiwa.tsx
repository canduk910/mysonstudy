"use client";

/**
 * components/ja-daily-kaiwa.tsx — 🗓️ 오늘의 일본어 **🗣️ 회화 칸**(설계 §4).
 *
 * 트랙마다: 원음 ▶(기기 보관소 — 없으면 "원음 없음 · 합성 음성" 칩 + 문장 합성 이어 읽기) · 문장 목록(후리가나 `components/ja-ruby.tsx`,
 * 한국어 해석 접기/펴기, 문장 탭 = 그 문장 합성 음성) · **따라 말하기 ▶**(한국어 1번 → 일본어 N번, 일본어 뒤 따라 말할 틈 —
 * `speakQueue` `pauseAfterMs`, 전역 속도는 speech가 따른다, 잠금 화면 조작은 `lib/media-session` 관문 — ⏸에서 바인딩을 풀지 않고
 * ▶로 그 문장부터 잇는다). 단위에 🎤 문장(keyLineIds)이 있으면 마지막에 핵심 문장 체크. withPoints면 과 포인트(pointsKo)를 보인다.
 * 대본 조각은 lib/ja-daily-quiz `buildJaDailyShadowItems`(순수)가 만든다.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import JaRuby from "@/components/ja-ruby";
import JaDailyLineCheck from "@/components/ja-daily-line-check";
import { JaDailyAudio, pauseAllMedia } from "@/components/ja-daily-media";
import type { JaDailyKaiwaCheck, JaDailyKaiwaView } from "@/lib/ja-daily-contract";
import type { JaDailyTrack } from "@/lib/ja-daily-content";
import { JA_DAILY_PART_KO, JA_DAILY_SHADOW_REPEATS, buildJaDailyShadowItems } from "@/lib/ja-daily-quiz";
import { bindMediaSession, setMediaSessionPlaybackState } from "@/lib/media-session";
import { speak, speakQueue, unlockSpeechPlayback } from "@/lib/speech";

type Unit = Extract<JaDailyKaiwaView, { type: "unit" }>;

const REPEAT_KEY = "ja-daily-shadow-repeat";

function readRepeat(): number {
  try {
    const v = Number(window.localStorage.getItem(REPEAT_KEY));
    return (JA_DAILY_SHADOW_REPEATS as readonly number[]).includes(v) ? v : 2;
  } catch {
    return 2;
  }
}

export default function JaDailyKaiwa({ view, urls, onDone }: { view: Unit; urls: Record<string, string | null>; onDone: (checks: JaDailyKaiwaCheck[]) => void }) {
  const [showKo, setShowKo] = useState(true);
  const [repeat, setRepeat] = useState(2);
  useEffect(() => setRepeat(readRepeat()), []);
  const [stage, setStage] = useState<"listen" | "check">("listen");
  /** 따라 말하기: 어느 트랙의 몇 번째 문장 · 재생/멈춤 */
  const [shadow, setShadow] = useState<{ track: string; line: number; state: "playing" | "paused"; cue: boolean } | null>(null);
  const shadowRef = useRef(shadow);
  useEffect(() => {
    shadowRef.current = shadow;
  }, [shadow]);
  const stopRef = useRef<(() => void) | null>(null);
  const unbindRef = useRef<(() => void) | null>(null);
  const runRef = useRef(0);

  const keyLines = useMemo(() => {
    const all = view.tracks.flatMap((t) => t.lines);
    return view.keyLineIds.map((id) => all.find((l) => l.id === id)).filter((l): l is NonNullable<typeof l> => l !== undefined);
  }, [view]);
  const keySet = useMemo(() => new Set(view.keyLineIds), [view.keyLineIds]);

  function stopShadow(unbind: boolean) {
    runRef.current += 1;
    const st = stopRef.current;
    stopRef.current = null;
    st?.();
    if (unbind) {
      unbindRef.current?.();
      unbindRef.current = null;
      setShadow(null);
    }
  }

  useEffect(
    () => () => {
      runRef.current += 1;
      stopRef.current?.();
      stopRef.current = null;
      unbindRef.current?.();
      unbindRef.current = null;
    },
    [],
  );

  /** 큐 시작 — ▶ 탭(동기) 또는 잠금 화면 ▶에서 */
  function playFrom(track: JaDailyTrack, from: number) {
    const run = ++runRef.current;
    stopRef.current?.();
    const items = buildJaDailyShadowItems(track.lines, repeat, from);
    if (items.length === 0) return;
    setShadow({ track: track.audioKey, line: items[0].line, state: "playing", cue: false });
    setMediaSessionPlaybackState("playing");
    stopRef.current = speakQueue(
      items.map(({ text, lang, pauseAfterMs }) => (pauseAfterMs ? { text, lang, pauseAfterMs } : { text, lang })),
      {
        onItem: (i) => {
          if (runRef.current !== run) return;
          setShadow({ track: track.audioKey, line: items[i].line, state: "playing", cue: false });
        },
        onPause: () => {
          if (runRef.current !== run) return;
          setShadow((s) => (s ? { ...s, cue: true } : s));
        },
        onEnd: (reason) => {
          if (runRef.current !== run) return;
          stopRef.current = null;
          if (reason === "done") {
            unbindRef.current?.();
            unbindRef.current = null;
            setShadow(null);
          } else {
            // 외부 멈춤(잠금 화면 ⏸·다른 소리) — 그 문장에서 이어 들을 수 있게 남긴다
            setShadow((s) => (s ? { ...s, state: "paused", cue: false } : s));
            setMediaSessionPlaybackState("paused");
          }
        },
      },
    );
  }

  function startShadow(track: JaDailyTrack, from = 0) {
    pauseAllMedia();
    unlockSpeechPlayback();
    unbindRef.current?.();
    unbindRef.current = bindMediaSession({
      title: "따라 말하기",
      artist: `${view.lesson.titleJa} · ${JA_DAILY_PART_KO[track.part]}`,
      actions: {
        pause: () => {
          if (shadowRef.current?.state !== "playing") return;
          stopShadow(false);
          setShadow((s) => (s ? { ...s, state: "paused", cue: false } : s));
          setMediaSessionPlaybackState("paused");
        },
        play: () => {
          const s = shadowRef.current;
          if (!s || s.state === "playing") return;
          playFrom(track, s.line);
        },
      },
    });
    playFrom(track, from);
  }

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
            <label className="t-caption flex items-center gap-1 text-ink-2">
              따라 말하기 일본어
              <select
                className="u-input !w-auto !py-1"
                value={repeat}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setRepeat(v);
                  try {
                    window.localStorage.setItem(REPEAT_KEY, String(v));
                  } catch {
                    /* 무시 */
                  }
                }}
              >
                {JA_DAILY_SHADOW_REPEATS.map((r) => (
                  <option key={r} value={r}>
                    {r}번
                  </option>
                ))}
              </select>
            </label>
          </div>

          {view.tracks.map((t) => {
            const active = shadow?.track === t.audioKey ? shadow : null;
            return (
              <section key={t.audioKey} className="u-card p-4" data-testid="ja-daily-track">
                <p className="t-section-title mb-2">{JA_DAILY_PART_KO[t.part]}</p>
                <JaDailyAudio url={urls[t.audioKey]} fallback={t.lines.map((l) => l.ja)} />
                <div className="mt-3 flex flex-wrap gap-2">
                  {active?.state === "playing" ? (
                    <button
                      type="button"
                      className="u-btn u-btn-secondary"
                      onClick={() => {
                        stopShadow(false);
                        setShadow((s) => (s ? { ...s, state: "paused", cue: false } : s));
                        setMediaSessionPlaybackState("paused");
                      }}
                    >
                      ⏸ 따라 말하기 멈춤
                    </button>
                  ) : active?.state === "paused" ? (
                    <>
                      <button type="button" className="u-btn u-btn-secondary" onClick={() => startShadow(t, active.line)}>
                        ▶ 이어서 따라 말하기
                      </button>
                      <button type="button" className="u-btn u-btn-secondary" onClick={() => stopShadow(true)}>
                        ⏹ 그만
                      </button>
                    </>
                  ) : (
                    <button type="button" className="u-btn u-btn-secondary" onClick={() => startShadow(t, 0)} data-testid="ja-daily-shadow">
                      🗣️ 따라 말하기 ▶
                    </button>
                  )}
                  {active?.cue ? (
                    <span className="u-chip u-chip-accent" role="status">
                      🗣️ 따라 말해 보세요
                    </span>
                  ) : null}
                </div>
                <ol className="mt-3 flex flex-col gap-2">
                  {t.lines.map((l, i) => (
                    <li key={l.id}>
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
