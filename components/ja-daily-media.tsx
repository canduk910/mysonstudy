"use client";

/**
 * components/ja-daily-media.tsx — 🗓️ 오늘의 일본어 **원음 재생**(설계 §2-2 재생) 공용 조각.
 *
 * - `useJaAudioUrls(keys)` — 기기 보관소(IndexedDB `eunwoo-ja-audio`, lib/ja-audio-store)에서 트랙을 꺼내 object URL을 만든다.
 *   보관소는 바이트로 저장하고 꺼낼 때마다 새 메모리 Blob을 준다(IDB 레코드를 가리키는 Blob을 재생에 쓰지 않는다 — app-patterns §8
 *   WebKit Blob 결함). 못 읽으면 그 트랙은 "원음 없음"으로 보고 합성 음성으로 간다. 언마운트·키 변경 때 revoke.
 *   서버로는 아무것도 보내지 않는다.
 * - `JaDailyAudio` — 원음이 있으면 `<audio controls>`, 없으면 "원음 없음 · 합성 음성" 칩 + 대본 합성 이어 읽기(`speakQueue`, ja-JP).
 *   원음과 합성 음성이 겹치지 않게 재생 시작 때 서로를 멈춘다.
 */

import { useEffect, useRef, useState } from "react";
import { getJaAudioTrack } from "@/lib/ja-audio-store";
import { speakQueue, stopSpeaking, unlockSpeechPlayback, type SpeakQueueItem } from "@/lib/speech";

/** 화면의 모든 <audio>를 멈춘다(원음끼리·원음과 합성 음성이 겹치지 않게). except는 남긴다 */
export function pauseAllMedia(except?: HTMLMediaElement | null): void {
  if (typeof document === "undefined") return;
  for (const el of Array.from(document.querySelectorAll("audio"))) {
    if (el !== except && !el.paused) {
      try {
        el.pause();
      } catch {
        /* 무시 */
      }
    }
  }
}

/** key → object URL(없으면 null). 읽는 동안은 키가 없다(undefined) */
export function useJaAudioUrls(keys: readonly string[]): Record<string, string | null> {
  const sig = [...new Set(keys)].sort().join("\n");
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    const list = sig ? sig.split("\n") : [];
    setUrls({});
    void (async () => {
      const out: Record<string, string | null> = {};
      for (const k of list) {
        let url: string | null = null;
        try {
          const t = await getJaAudioTrack(k);
          if (t && t.blob.size > 0) url = URL.createObjectURL(t.blob);
        } catch {
          url = null;
        }
        if (!alive) {
          // 읽는 동안 정리(언마운트·키 변경)가 이미 돌았다 — 방금 만든 URL은 아무도 해제하지 않으니 여기서 놓는다(QA daily-full P3-5)
          if (url) URL.revokeObjectURL(url);
          break;
        }
        if (url) made.push(url);
        out[k] = url;
      }
      if (alive) setUrls(out);
    })();
    return () => {
      alive = false;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [sig]);
  return urls;
}

/** 원음 칩 */
export function NoAudioChip() {
  return (
    <span className="u-chip" data-testid="ja-daily-no-audio">
      원음 없음 · 합성 음성
    </span>
  );
}

/**
 * 원음 ▶ 또는 합성 음성 이어 읽기. url: undefined = 읽는 중, null = 원음 없음.
 * fallback: 원음이 없을 때 읽을 일본어 조각들(비면 버튼을 그리지 않는다).
 */
export function JaDailyAudio({ url, fallback, label = "원음" }: { url: string | null | undefined; fallback: readonly string[]; label?: string }) {
  const [synth, setSynth] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      stopRef.current?.();
      stopRef.current = null;
    },
    [],
  );
  if (url === undefined) return <p className="t-caption text-ink-3">원음 확인 중…</p>;
  if (url) {
    return (
      <audio
        controls
        preload="metadata"
        src={url}
        className="w-full"
        aria-label={label}
        data-testid="ja-daily-audio"
        onPlay={(e) => {
          stopSpeaking();
          pauseAllMedia(e.currentTarget);
        }}
      />
    );
  }
  const items: SpeakQueueItem[] = fallback.map((t) => t.trim()).filter(Boolean).map((text) => ({ text, lang: "ja-JP" }));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NoAudioChip />
      {items.length > 0 ? (
        <button
          type="button"
          className="u-btn u-btn-secondary"
          data-testid="ja-daily-synth"
          onClick={() => {
            if (synth) {
              stopRef.current?.();
              stopRef.current = null;
              setSynth(false);
              return;
            }
            pauseAllMedia();
            unlockSpeechPlayback();
            setSynth(true);
            stopRef.current = speakQueue(items, {
              onEnd: () => {
                stopRef.current = null;
                setSynth(false);
              },
            });
          }}
        >
          {synth ? "⏹ 멈추기" : "▶ 합성 음성으로 듣기"}
        </button>
      ) : null}
    </div>
  );
}
