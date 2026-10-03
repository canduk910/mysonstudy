"use client";

/**
 * components/use-toeic-rec-uploads.ts — 내 녹음 업로드 대기열 **계기**와 진행 상태 구독 (docs/harness/toeic.md §13-3)
 *
 * - `useToeicRecUploadDrain()`: 화면이 열릴 때 한 번 + 열려 있는 동안 `online`·`visibilitychange`(보임)마다 대기열을 비운다.
 *   응시 결과 화면·모의고사 학습 보기·한 문제 연습 폴더(④ 탭)가 부른다. 토익 밖 화면에서는 돌지 않는다.
 * - `useToeicRecUploadStates(attemptId)`: 그 응시의 문항별 업로드 진행 상태(이벤트 구독 — "올리는 중"·"서버 ✓"·"대기").
 */

import { useEffect, useState } from "react";
import {
  TOEIC_REC_UPLOAD_EVENT,
  drainToeicRecUploads,
  type ToeicRecUploadEventDetail,
  type ToeicRecUploadLiveState,
} from "@/lib/toeic-rec-upload";
import type { ToeicStoredRecording } from "@/lib/toeic-rec-rules";

export function useToeicRecUploadDrain(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    void drainToeicRecUploads();
    const onOnline = () => void drainToeicRecUploads();
    const onVisible = () => {
      if (document.visibilityState === "visible") void drainToeicRecUploads();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
}

export interface ToeicRecLive {
  state: ToeicRecUploadLiveState;
  createdAt: number;
  recording: ToeicStoredRecording | null;
}

/** 그 응시의 문항별 업로드 진행 상태(q → 마지막 이벤트). attemptId가 null이면 빈 표. */
export function useToeicRecUploadStates(attemptId: string | null): Record<number, ToeicRecLive> {
  const [states, setStates] = useState<Record<number, ToeicRecLive>>({});
  useEffect(() => {
    setStates({});
    if (!attemptId) return;
    const onEvent = (e: Event) => {
      const d = (e as CustomEvent<ToeicRecUploadEventDetail>).detail;
      if (!d || d.attemptId !== attemptId) return;
      setStates((prev) => {
        const cur = prev[d.q];
        // 더 이른 녹음의 늦은 이벤트가 새 녹음 상태를 덮지 않게
        if (cur && cur.createdAt > d.createdAt) return prev;
        return { ...prev, [d.q]: { state: d.state, createdAt: d.createdAt, recording: d.recording } };
      });
    };
    window.addEventListener(TOEIC_REC_UPLOAD_EVENT, onEvent);
    return () => window.removeEventListener(TOEIC_REC_UPLOAD_EVENT, onEvent);
  }, [attemptId]);
  return states;
}
