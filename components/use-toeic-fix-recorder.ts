"use client";

/**
 * components/use-toeic-fix-recorder.ts — 결과 화면 **고칠 문장 다시 말하기** 녹음기 (docs/harness/toeic.md §14-5, SPEC §20-12)
 *
 * - 마이크는 lib/mic-session `createMicKeeper({ policy })` 하나를 **결과 화면 세션 동안** 쥔다(2026-10-03 마이크 유지 — 권한을 다시 묻지 않게).
 *   정책은 **기기 설정과 상관없이** `toeicFixRecMicPolicy`(docs/harness/toeic.md §15-13 — 오케스트레이터 결정): Apple WebKit + 오디오 세션 API면
 *   keep(첫 🎤 탭에서 한 번 권한을 받고 이후 문장마다 같은 스트림에 새 녹음기 — 녹음 사이 입력 끔), 그 밖(Chrome·Android 등)은 녹음마다 열고 닫는다.
 *   근거: 이 화면의 녹음은 모두 🎤 탭으로 시작하고 끝나면 바로 ▶로 들을 수 있어 무음을 곧 알아챈다(응시 화면처럼 타이머가 탭 없이 잇는 자리가 아니다).
 *   결과 화면 ⚙️의 "문항마다 마이크 다시 열기"는 응시·다시 풀기 화면용이다(바꿔도 여기 쥔 마이크는 놓지 않는다). 오디오 세션은 mic-session 밖에서 건드리지 않는다.
 * - 업로드에 그 답의 세대(`answerSource` — §15-6)를 싣는다: 그 사이 그 문항을 다시 풀어 피드백이 바뀌었으면 서버가 409 answer_changed로 받지 않는다.
 * - **놓는 때**: 화면을 떠날 때(언마운트)·pagehide·숨김. 돌던 녹음은 버린다.
 * - 🎤는 **탭 안에서 동기로** startRecording을 부른다(권한 창·getUserMedia가 탭 맥락에서). 재생과 캡처를 겹치지 않게, 시작 전에 호출자가
 *   넘긴 stopPlayback()으로 모든 재생을 멈춘다.
 * - 한 번에 하나. 자동 멈춤 TOEIC_FIX_REC_LIMIT_MS(30초).
 * - 끝나면 Blob을 **메모리**에 두고(▶ 내 목소리가 바로 된다) 곧바로 `PUT …/recordings/[q]/fixes/[i]`로 올린다. 기기 대기열(IndexedDB)에는
 *   넣지 않는다 — 응시 녹음 대기열의 보관·정리 규칙(풀마다 최근 5회분·pending 고정)을 연습 녹음이 흔들지 않게. 재시도할 실패는
 *   2·10·30초 뒤 최대 3번(대기열과 같은 간격), 그래도 안 되면 "다시 올리기" 버튼. 화면을 떠나면 올리지 못한 녹음은 사라진다(화면이 알린다).
 * - AI를 부르지 않는다(받아쓰기 비교 없음).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MIC_CHECK_GUM_TIMEOUT_MS, MicError, createMicKeeper, detectMicKeepEnv, toeicFixRecMicPolicy, type MicKeeper, type MicRecording } from "@/lib/mic-session";
import {
  TOEIC_REC_FIELD_AUDIO,
  TOEIC_REC_FIELD_DURATION_MS,
  TOEIC_REC_FIELD_RECORDED_AT,
  TOEIC_REC_FIELD_ANSWER_SOURCE,
  toeicAudioBaseType,
  toeicRecordingHref,
  type ToeicFixRecordingPutResponse,
  type ToeicStoredFixRecording,
} from "@/lib/toeic-attempt-contract";
import { TOEIC_FIX_REC_LIMIT_MS, nextToeicRecUploadAction, toeicRecFamilyOfType } from "@/lib/toeic-rec-rules";
import { TOEIC_REC_UPLOAD_RETRY_DELAYS_MS } from "@/lib/toeic-rec-upload";

/** 고칠 문장 자리 키 */
export const fixSlotKey = (q: number, fixIndex: number) => `${q}:${fixIndex}`;

export interface FixTake {
  url: string;
  blob: Blob;
  mimeType: string;
  size: number;
  durationMs: number;
  recordedAt: number;
  upload: "uploading" | "done" | "failed";
  message: string | null;
}

export type FixRecActive = { key: string; phase: "arming" | "recording"; startedAt: number | null };

const FILE_NAME: Record<string, string> = {
  "audio/mp4": "fix.mp4",
  "audio/webm": "fix.webm",
  "audio/ogg": "fix.ogg",
  "audio/wav": "fix.wav",
};

export function useToeicFixRecorder(
  attemptId: string,
  onStored: (rec: ToeicStoredFixRecording) => void,
  /** 그 문항 답의 세대(§15-6 — 다시 풀기 id, 처음 응시는 null). 없으면 업로드에 싣지 않는다(옛 계약) */
  answerSourceOf?: (q: number) => string | null,
) {
  const keeperRef = useRef<MicKeeper | null>(null);
  const recRef = useRef<{ key: string; rec: MicRecording; q: number; fixIndex: number } | null>(null);
  const timerRef = useRef<number | null>(null);
  const genRef = useRef(0);
  const [active, setActiveState] = useState<FixRecActive | null>(null);
  const activeRef = useRef<FixRecActive | null>(null);
  const setActive = useCallback((a: FixRecActive | null) => {
    activeRef.current = a;
    setActiveState(a);
  }, []);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [takes, setTakes] = useState<Record<string, FixTake>>({});
  const takesRef = useRef(takes);
  useEffect(() => {
    takesRef.current = takes;
  }, [takes]);
  const onStoredRef = useRef(onStored);
  useEffect(() => {
    onStoredRef.current = onStored;
  }, [onStored]);

  const sourceRef = useRef(answerSourceOf);
  useEffect(() => {
    sourceRef.current = answerSourceOf;
  }, [answerSourceOf]);
  // 정책은 기기 설정과 상관없이(§15-13) — 렌더 중이 아니라 첫 🎤 탭에서 만든다(navigator)
  const keeper = () => (keeperRef.current ??= createMicKeeper({ policy: toeicFixRecMicPolicy(detectMicKeepEnv()) }));

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  /** 놓기 — 돌던 녹음은 버리고 마이크를 놓는다(트랙 stop → playback은 mic-session이 순서대로) */
  const release = useCallback(() => {
    genRef.current++;
    clearTimer();
    recRef.current?.rec.abort();
    recRef.current = null;
    keeperRef.current?.release();
    setActive(null);
  }, [setActive]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") release();
    };
    const onPageHide = () => release();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      release();
      for (const t of Object.values(takesRef.current)) URL.revokeObjectURL(t.url);
    };
  }, [release]);

  const patchTake = (key: string, patch: Partial<FixTake>) =>
    setTakes((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], ...patch } } : prev));

  const upload = useCallback(
    async (key: string, q: number, fixIndex: number, take: FixTake) => {
      patchTake(key, { upload: "uploading", message: null });
      const declared = toeicAudioBaseType(take.blob.type) || toeicAudioBaseType(take.mimeType);
      const family = toeicRecFamilyOfType(declared) ?? "audio/webm";
      const once = async (): Promise<{ action: "done" | "gone" | "retry" | "purge"; body: ToeicFixRecordingPutResponse | null }> => {
        const fd = new FormData();
        fd.append(TOEIC_REC_FIELD_AUDIO, take.blob.type ? take.blob : new Blob([take.blob], { type: declared || family }), FILE_NAME[family] ?? "fix.webm");
        fd.append(TOEIC_REC_FIELD_DURATION_MS, String(Math.max(1, Math.round(take.durationMs))));
        fd.append(TOEIC_REC_FIELD_RECORDED_AT, String(Math.round(take.recordedAt)));
        const src = sourceRef.current;
        if (src) fd.append(TOEIC_REC_FIELD_ANSWER_SOURCE, src(q) ?? "");
        let res: Response;
        try {
          res = await fetch(toeicRecordingHref(attemptId, q, fixIndex), { method: "PUT", body: fd });
        } catch {
          return { action: "retry", body: null };
        }
        const body = (await res.json().catch(() => null)) as ToeicFixRecordingPutResponse | null;
        return { action: nextToeicRecUploadAction({ kind: "response", status: res.status, body }), body };
      };
      let r = await once();
      for (let i = 0; r.action === "retry" && i < TOEIC_REC_UPLOAD_RETRY_DELAYS_MS.length; i++) {
        await new Promise((ok) => window.setTimeout(ok, TOEIC_REC_UPLOAD_RETRY_DELAYS_MS[i]));
        if (takesRef.current[key]?.recordedAt !== take.recordedAt) return; // 그 사이 다시 녹음했다 — 새 녹음이 올라간다
        r = await once();
      }
      if (takesRef.current[key]?.recordedAt !== take.recordedAt) return;
      if (r.action === "done" && r.body?.ok) {
        patchTake(key, { upload: "done", message: null });
        onStoredRef.current(r.body.recording);
        return;
      }
      const msg = r.body && !r.body.ok ? r.body.messageKo : "서버에 올리지 못했어요.";
      patchTake(key, { upload: "failed", message: r.action === "retry" ? `${msg} — 다시 올리기를 눌러 주세요(화면을 떠나면 이 녹음은 사라져요).` : msg });
    },
    [attemptId],
  );

  /** 녹음 멈추기(탭) — 결과를 메모리에 두고 바로 올린다 */
  const stop = useCallback(async () => {
    const cur = recRef.current;
    if (!cur) return;
    clearTimer();
    const gen = genRef.current;
    const result = await cur.rec.stop();
    if (recRef.current === cur) recRef.current = null;
    if (genRef.current !== gen) return;
    setActive(null);
    if (!result || result.size === 0) {
      setError({ key: cur.key, message: "녹음이 담기지 않았어요 — 🎤를 다시 눌러 주세요." });
      return;
    }
    const take: FixTake = {
      url: URL.createObjectURL(result.blob),
      blob: result.blob,
      mimeType: result.mimeType,
      size: result.size,
      durationMs: Math.max(1, Math.round(result.durationMs)),
      recordedAt: Date.now(),
      upload: "uploading",
      message: null,
    };
    setTakes((prev) => {
      const old = prev[cur.key];
      if (old) URL.revokeObjectURL(old.url);
      return { ...prev, [cur.key]: take };
    });
    takesRef.current = { ...takesRef.current, [cur.key]: take };
    void upload(cur.key, cur.q, cur.fixIndex, take);
  }, [upload, setActive]);

  /**
   * 🎤 탭 — **탭 안에서 동기로** 부른다. stopPlayback()은 지금 재생을 모두 멈추는 호출자 함수(재생과 캡처를 겹치지 않는다).
   * 이미 그 자리를 녹음 중이면 멈춘다(토글). 다른 자리를 녹음 중이면 그것을 먼저 멈춘다.
   */
  const toggle = useCallback(
    (q: number, fixIndex: number, stopPlayback: () => void) => {
      const key = fixSlotKey(q, fixIndex);
      const cur = activeRef.current;
      if (cur && cur.key !== key) return; // 한 번에 하나 — 다른 자리 🎤는 화면이 막는다
      if (cur) {
        if (recRef.current?.key === key) void stop();
        else {
          // 아직 여는 중(권한 창·start 이벤트 대기) — 취소. 늦게 온 녹음은 세대가 달라 버려진다
          genRef.current++;
          setActive(null);
        }
        return;
      }
      stopPlayback();
      setError(null);
      const gen = ++genRef.current;
      setActive({ key, phase: "arming", startedAt: null });
      const p = keeper().startRecording({ gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS }); // 탭 안 — 권한 창(첫 번째만)
      void (async () => {
        let rec: MicRecording | null = null;
        try {
          rec = await p;
          if (genRef.current !== gen) {
            rec.abort();
            return;
          }
          recRef.current = { key, rec, q, fixIndex };
          const startedAt = await rec.started;
          if (genRef.current !== gen) return;
          setActive({ key, phase: "recording", startedAt });
          timerRef.current = window.setTimeout(() => void stop(), TOEIC_FIX_REC_LIMIT_MS);
        } catch (e) {
          rec?.abort();
          if (recRef.current?.rec === rec) recRef.current = null;
          if (genRef.current !== gen) return;
          setActive(null);
          const err = e instanceof MicError ? e : new MicError("failed", e instanceof Error ? e.message : undefined);
          setError({
            key,
            message:
              err.kind === "denied" || err.kind === "unsupported"
                ? `${err.message} — 고친 문장 🔊 듣기는 그대로 할 수 있어요.`
                : `${err.message} — 🎤를 다시 눌러 주세요.`,
          });
        }
      })();
    },
    [stop, setActive],
  );

  /** 올리지 못한 녹음 다시 올리기(탭) */
  const retryUpload = useCallback(
    (q: number, fixIndex: number) => {
      const key = fixSlotKey(q, fixIndex);
      const t = takesRef.current[key];
      if (t && t.upload === "failed") void upload(key, q, fixIndex, t);
    },
    [upload],
  );

  /** 지운 뒤 — 메모리 사본도 버린다 */
  const forget = useCallback((keys: readonly string[] | "all") => {
    setTakes((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(prev)) {
        if (keys === "all" || keys.includes(k)) {
          URL.revokeObjectURL(prev[k].url);
          delete next[k];
        }
      }
      takesRef.current = next;
      return next;
    });
  }, []);

  /** 쥔 마이크를 놓고 다음 🎤에서 다시 만든다(정책은 기기 설정과 무관 — §15-13. 지금은 화면이 부르지 않는다) */
  const resetMic = useCallback(() => {
    release();
    keeperRef.current = null;
  }, [release]);

  return { active, error, takes, toggle, stop, retryUpload, forget, release, resetMic };
}
