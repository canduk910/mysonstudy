/**
 * lib/toeic-rec-upload.ts — 내 녹음 **업로드 대기열 비우기** (클라이언트 전용, docs/harness/toeic.md §13-3·§13-6)
 *
 * 기기 보관소(lib/toeic-rec-store)의 "pending" 녹음을 오래된 순으로 하나씩 `PUT /api/toeic/attempts/[id]/recordings/[q]`에 올린다.
 * - **한 번에 하나만** 돈다 — 모듈 안 진행 중 약속 하나(중복 호출은 합류). 동시 업로드 1개(응시 중 질문 음성·녹음과 대역폭을 다투지 않게).
 *   비우는 동안 새 녹음이 대기열에 들어오면 같은 비우기가 이어서 집는다(매 차례 대기열을 새로 읽는다).
 * - 응답 해석은 순수 함수 하나(lib/toeic-rec-rules nextToeicRecUploadAction): done → 기기 메타 "done" · gone → "gone"(캐시로만) ·
 *   retry → 한 번의 비우기 안에서 2초·10초·30초 뒤 최대 3번, 그래도 안 되면 그 항목을 남긴 채 멈춘다(다음 계기에 다시).
 * - **keepalive를 쓰지 않는다** — 오디오 본문은 keepalive 한도(진행 중 합 64KiB)를 넘는다. 화면이 내려가면 남은 항목은 기기에 남아
 *   다음 계기에 간다(계기: 응시 화면의 녹음 저장 직후 · 결과/학습 보기/연습 폴더 화면이 열릴 때와 열려 있는 동안 online·보임 —
 *   components/use-toeic-rec-uploads).
 * - 진행 상황은 window 이벤트 `TOEIC_REC_UPLOAD_EVENT`로 알린다(화면이 문항마다 "서버 ✓ / 올리는 중 / 대기"를 그린다).
 *
 * ⚠️ 모듈 최상위에서 window·indexedDB를 읽지 않는다(서버 렌더 안전). firebase-admin·lib/store·lib/ai 값 import 금지.
 */

import {
  TOEIC_REC_FIELD_AUDIO,
  TOEIC_REC_FIELD_DURATION_MS,
  TOEIC_REC_FIELD_RECORDED_AT,
  toeicAudioBaseType,
  toeicRecordingHref,
  type ToeicRecordingPutResponse,
} from "./toeic-attempt-contract";
import { getToeicRecordingBlob, listPendingToeicRecordings, setToeicRecUploadState, type ToeicRecordingMeta } from "./toeic-rec-store";
import { nextToeicRecUploadAction, toeicRecFamilyOfType, type ToeicStoredRecording } from "./toeic-rec-rules";

/** 진행 이벤트 이름(window CustomEvent) */
export const TOEIC_REC_UPLOAD_EVENT = "toeic-rec-upload";

/** 화면이 보는 문항별 상태 — "uploading"은 지금 올리는 중(기기 메타에는 남기지 않는다) */
export type ToeicRecUploadLiveState = "pending" | "uploading" | "done" | "gone";

export interface ToeicRecUploadEventDetail {
  attemptId: string;
  q: number;
  /** 그 녹음의 기기 저장 시각(같은 문항 다시 녹음과 구별) */
  createdAt: number;
  state: ToeicRecUploadLiveState;
  /** done이면 서버가 돌려준 메타 */
  recording: ToeicStoredRecording | null;
}

/** 한 번의 비우기 안에서 다시 시도하는 간격(ms) — 2초·10초·30초 */
export const TOEIC_REC_UPLOAD_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000];

const FILE_NAME: Record<string, string> = {
  "audio/mp4": "answer.mp4",
  "audio/webm": "answer.webm",
  "audio/ogg": "answer.ogg",
  "audio/wav": "answer.wav",
};

function emit(detail: ToeicRecUploadEventDetail): void {
  try {
    window.dispatchEvent(new CustomEvent<ToeicRecUploadEventDetail>(TOEIC_REC_UPLOAD_EVENT, { detail }));
  } catch {
    // 이벤트 실패는 업로드와 무관
  }
}

/** 재시도 사이 쉬는 중이면 깨우는 함수 — "지금 올리기"·online·보임이 다음 시도를 앞당긴다(새 비우기를 만들지 않고 합류) */
let wake: (() => void) | null = null;
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = window.setTimeout(done, ms);
    function done() {
      window.clearTimeout(t);
      if (wake === done) wake = null;
      r();
    }
    wake = done;
  });

type OneResult = { action: "done"; recording: ToeicStoredRecording | null } | { action: "gone" } | { action: "retry" };

async function putOnce(meta: ToeicRecordingMeta, blob: Blob): Promise<OneResult> {
  const declared = toeicAudioBaseType(blob.type) || toeicAudioBaseType(meta.mimeType);
  const family = toeicRecFamilyOfType(declared) ?? "audio/webm";
  const fd = new FormData();
  fd.append(TOEIC_REC_FIELD_AUDIO, blob.type ? blob : new Blob([blob], { type: declared || family }), FILE_NAME[family] ?? "answer.webm");
  fd.append(TOEIC_REC_FIELD_DURATION_MS, String(Math.max(1, Math.round(meta.durationMs))));
  fd.append(TOEIC_REC_FIELD_RECORDED_AT, String(Math.round(meta.createdAt)));
  let res: Response;
  try {
    res = await fetch(toeicRecordingHref(meta.attemptId, meta.q), { method: "PUT", body: fd });
  } catch {
    return { action: "retry" };
  }
  const body = (await res.json().catch(() => null)) as ToeicRecordingPutResponse | null;
  const action = nextToeicRecUploadAction({ kind: "response", status: res.status, body });
  if (action === "done") return { action, recording: body && body.ok ? body.recording : null };
  return { action };
}

let running: Promise<{ uploaded: number; remaining: number }> | null = null;

async function drainOnce(): Promise<{ uploaded: number; remaining: number }> {
  let uploaded = 0;
  // 이번 비우기에서 이미 다룬 녹음 — 기기 메타 쓰기가 조용히 실패해 "pending"으로 남아도 같은 녹음을 끝없이 다시 올리지 않게
  const seen = new Set<string>();
  for (;;) {
    const pending = (await listPendingToeicRecordings()).filter((m) => !seen.has(`${m.attemptId}:${m.q}:${m.createdAt}`));
    const meta = pending[0];
    if (!meta) return { uploaded, remaining: 0 };
    seen.add(`${meta.attemptId}:${meta.q}:${meta.createdAt}`);
    const blob = await getToeicRecordingBlob(meta.attemptId, meta.q, meta.createdAt);
    if (!blob || blob.size === 0) {
      // 바이트가 없다(정리됐거나 다시 녹음으로 바뀌었다) — 이 메타는 더 올릴 것이 없다
      await setToeicRecUploadState(meta.attemptId, meta.q, meta.createdAt, "gone", null);
      continue;
    }
    const base = { attemptId: meta.attemptId, q: meta.q, createdAt: meta.createdAt };
    emit({ ...base, state: "uploading", recording: null });
    let result = await putOnce(meta, blob);
    for (let i = 0; result.action === "retry" && i < TOEIC_REC_UPLOAD_RETRY_DELAYS_MS.length; i++) {
      await sleep(TOEIC_REC_UPLOAD_RETRY_DELAYS_MS[i]);
      result = await putOnce(meta, blob);
    }
    if (result.action === "retry") {
      emit({ ...base, state: "pending", recording: null });
      return { uploaded, remaining: pending.length };
    }
    if (result.action === "done") {
      await setToeicRecUploadState(meta.attemptId, meta.q, meta.createdAt, "done", Date.now());
      uploaded += 1;
      emit({ ...base, state: "done", recording: result.recording });
    } else {
      await setToeicRecUploadState(meta.attemptId, meta.q, meta.createdAt, "gone", null);
      emit({ ...base, state: "gone", recording: null });
    }
  }
}

/** 대기열 비우기 — 진행 중이면 그 약속에 합류한다. 던지지 않는다. */
export function drainToeicRecUploads(): Promise<{ uploaded: number; remaining: number }> {
  if (typeof window === "undefined") return Promise.resolve({ uploaded: 0, remaining: 0 });
  if (running) {
    wake?.(); // 재시도 대기 중이면 바로 다시 해 본다
    return running;
  }
  running = drainOnce()
    .catch(() => ({ uploaded: 0, remaining: -1 }))
    .finally(() => {
      running = null;
    });
  return running;
}

/** 지금 비우는 중인가 */
export function isDrainingToeicRecUploads(): boolean {
  return running !== null;
}
