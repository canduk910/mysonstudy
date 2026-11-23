"use client";

/**
 * components/use-ja-daily-shadow.tsx — 🗓️ 오늘의 일본어 **🗣️ 따라 말하기** 공용 조각(회화 칸 트랙 · 시험 대비 칸 청해 요령 원음 대본).
 *
 * - `useJaDailyShadowRepeat()` — 일본어 반복 수(1·2·3번, 기본 2). 기기에 저장(`REPEAT_KEY`) — 회화와 대본이 같은 값을 쓴다.
 * - `useJaDailyShadow(repeat)` — 한국어 1번 → 일본어 N번 큐(`buildJaDailyShadowItems` + `speakQueue`, 일본어 뒤 따라 말할 틈).
 *   대상(target)은 key·문장 목록·잠금 화면 부제. ⏸은 바인딩을 풀지 않고 그 문장에서 멈추고, ▶(이어서·잠금 화면)로 그 문장부터 잇는다.
 *   시작할 때 원음(`pauseAllMedia`)을 멈추고, 원음 ▶가 `stopSpeaking`으로 큐를 끊으면 외부 멈춤으로 보고 이어서를 남긴다.
 *   잠금 화면 조작은 `lib/media-session` 관문. 언마운트에서 큐·바인딩을 정리한다. 마운트만으로는 아무 합성도 미리 받지 않는다.
 * - `JaDailyShadowRepeatSelect` · `JaDailyShadowControls` — 반복 수 선택과 ▶/⏸/이어서/⏹ + "따라 말해 보세요" 칩.
 */

import { useEffect, useRef, useState } from "react";
import type { JaDailyLine } from "@/lib/ja-daily-content";
import { JA_DAILY_SHADOW_REPEATS, buildJaDailyShadowItems } from "@/lib/ja-daily-quiz";
import { bindMediaSession, setMediaSessionPlaybackState } from "@/lib/media-session";
import { speakQueue, unlockSpeechPlayback } from "@/lib/speech";
import { pauseAllMedia } from "@/components/ja-daily-media";

const REPEAT_KEY = "ja-daily-shadow-repeat";

function readRepeat(): number {
  try {
    const v = Number(window.localStorage.getItem(REPEAT_KEY));
    return (JA_DAILY_SHADOW_REPEATS as readonly number[]).includes(v) ? v : 2;
  } catch {
    return 2;
  }
}

/** 반복 수 — 기기 저장값(없으면 2). 바꾸면 저장한다 */
export function useJaDailyShadowRepeat(): { repeat: number; setRepeat: (v: number) => void } {
  const [repeat, setRepeatState] = useState(2);
  useEffect(() => setRepeatState(readRepeat()), []);
  function setRepeat(v: number) {
    setRepeatState(v);
    try {
      window.localStorage.setItem(REPEAT_KEY, String(v));
    } catch {
      /* 무시 */
    }
  }
  return { repeat, setRepeat };
}

export type JaDailyShadowState = { key: string; line: number; state: "playing" | "paused"; cue: boolean };

export interface JaDailyShadowTarget {
  /** 어느 묶음인지(회화 = 트랙 audioKey) — 화면이 활성 묶음을 가린다 */
  key: string;
  lines: readonly Pick<JaDailyLine, "ja" | "ko">[];
  /** 잠금 화면 부제 */
  artist: string;
}

export function useJaDailyShadow(repeat: number) {
  /** 따라 말하기: 어느 묶음의 몇 번째 문장 · 재생/멈춤 */
  const [shadow, setShadow] = useState<JaDailyShadowState | null>(null);
  const shadowRef = useRef(shadow);
  useEffect(() => {
    shadowRef.current = shadow;
  }, [shadow]);
  const stopRef = useRef<(() => void) | null>(null);
  const unbindRef = useRef<(() => void) | null>(null);
  const runRef = useRef(0);

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
  function playFrom(target: JaDailyShadowTarget, from: number) {
    const run = ++runRef.current;
    stopRef.current?.();
    const items = buildJaDailyShadowItems(target.lines, repeat, from);
    if (items.length === 0) return;
    setShadow({ key: target.key, line: items[0].line, state: "playing", cue: false });
    setMediaSessionPlaybackState("playing");
    stopRef.current = speakQueue(
      items.map(({ text, lang, pauseAfterMs }) => (pauseAfterMs ? { text, lang, pauseAfterMs } : { text, lang })),
      {
        onItem: (i) => {
          if (runRef.current !== run) return;
          setShadow({ key: target.key, line: items[i].line, state: "playing", cue: false });
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

  function startShadow(target: JaDailyShadowTarget, from = 0) {
    pauseAllMedia();
    unlockSpeechPlayback();
    unbindRef.current?.();
    unbindRef.current = bindMediaSession({
      title: "따라 말하기",
      artist: target.artist,
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
          // 원음 <audio>가 그사이 재생 중이면 겹치지 않게 먼저 멈춘다(화면 ▶와 같은 규칙)
          pauseAllMedia();
          playFrom(target, s.line);
        },
      },
    });
    playFrom(target, from);
  }

  /** 화면 ⏸ — 바인딩은 남기고 그 문장에서 멈춘다 */
  function pauseShadow() {
    stopShadow(false);
    setShadow((s) => (s ? { ...s, state: "paused", cue: false } : s));
    setMediaSessionPlaybackState("paused");
  }

  return { shadow, shadowRef, startShadow, pauseShadow, stopShadow };
}

export function JaDailyShadowRepeatSelect({ repeat, onChange }: { repeat: number; onChange: (v: number) => void }) {
  return (
    <label className="t-caption flex items-center gap-1 text-ink-2">
      따라 말하기 일본어
      <select className="u-input !w-auto !py-1" value={repeat} onChange={(e) => onChange(Number(e.target.value))}>
        {JA_DAILY_SHADOW_REPEATS.map((r) => (
          <option key={r} value={r}>
            {r}번
          </option>
        ))}
      </select>
    </label>
  );
}

/** ▶ / ⏸ / 이어서 + ⏹ / "따라 말해 보세요" 칩. active = 이 묶음의 따라 말하기 상태(아니면 null) */
export function JaDailyShadowControls({
  active,
  onStart,
  onPause,
  onResume,
  onStop,
  testId,
}: {
  active: JaDailyShadowState | null;
  onStart: () => void;
  onPause: () => void;
  onResume: (line: number) => void;
  onStop: () => void;
  testId: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {active?.state === "playing" ? (
        <button type="button" className="u-btn u-btn-secondary" onClick={onPause}>
          ⏸ 따라 말하기 멈춤
        </button>
      ) : active?.state === "paused" ? (
        <>
          <button type="button" className="u-btn u-btn-secondary" onClick={() => onResume(active.line)}>
            ▶ 이어서 따라 말하기
          </button>
          <button type="button" className="u-btn u-btn-secondary" onClick={onStop}>
            ⏹ 그만
          </button>
        </>
      ) : (
        <button type="button" className="u-btn u-btn-secondary" onClick={onStart} data-testid={testId}>
          🗣️ 따라 말하기 ▶
        </button>
      )}
      {active?.cue ? (
        <span className="u-chip u-chip-accent" role="status">
          🗣️ 따라 말해 보세요
        </span>
      ) : null}
    </div>
  );
}
