/**
 * lib/talk-gateway.ts — 관문 R(OpenAI Realtime) **서버 쪽 호출** — 연결(SDP 교환)·끊기(hangup) (서버 전용)
 * (docs/harness/english.md §12-1, SPEC §21-3)
 *
 * **하네스 밖 관문**이다(lib/tts.ts·토익 관문 P/T와 같은 부류) — `callWithSchema`를 지나지 않고, 키 규약(없으면 부르지 않는다)만
 * 공유한다. 세션 설정 조립은 lib/talk-session-config.ts(순수)가 하고, 여기는 네트워크만 한다.
 *
 * - **통합 인터페이스**: 브라우저의 SDP offer를 받아 서버가 표준 키로 `POST {base}/realtime/calls`에 multipart `sdp` + `session`
 *   (세션 설정 JSON)을 보낸다 → 응답 본문 = answer SDP, `Location` 헤더 마지막 조각 = callId. 브라우저에는 SDP answer와 callId만
 *   간다(키 노출 없음, §21-3). SDK 7.4.0에는 WebRTC call 생성이 없어 fetch로 직접 부른다.
 * - `{base}` = env `OPENAI_BASE_URL`(openai SDK와 같은 env — 로컬 e2e 루프백 스텁이 이 값을 가로챈다), 비었으면 `https://api.openai.com/v1`.
 * - 끊기: `POST {base}/realtime/calls/{callId}/hangup`. 실패해도 무시한다(이미 끊겼을 수 있다, §12-1).
 * - 로그에는 SDP·지시문·전사를 남기지 않는다 — 상태·ms만(§12-1).
 * - 실패는 throw하지 않고 결과 값으로 돌려준다(새 관문의 관용구, app-patterns §15).
 */

import type { RealtimeSessionCreateRequest } from "openai/resources/realtime/realtime";
import { parseTalkCallId } from "./talk-session-config";

/** 연결 한 번의 상한(ms) — SDP 교환은 보통 1~2초. 넘으면 실패로 돌려준다 */
export const TALK_CONNECT_TIMEOUT_MS = 20_000;
/** hangup 한 번의 상한(ms) */
export const TALK_HANGUP_TIMEOUT_MS = 8_000;

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Realtime REST 기준 주소 — env `OPENAI_BASE_URL`(빈 값·공백이면 기본값), 끝의 `/`는 걷는다 */
export function talkRealtimeBaseUrl(): string {
  const base = process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL;
  return base.replace(/\/+$/, "");
}

export type TalkConnectCallResult =
  | { ok: true; sdp: string; callId: string | null; status: number }
  | { ok: false; error: "no_api_key" | "failed"; status: number | null; detail: string };

/** 두 신호 중 하나라도 끝나면 끝나는 신호(AbortSignal.any가 없는 런타임 대비) */
function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(list);
  const ctrl = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/**
 * SDP offer + 세션 설정 → OpenAI Realtime 통화 하나. 키가 없으면 **네트워크 호출 없이** no_api_key.
 * @param signal 요청 끊김(브라우저가 연결을 포기했으면 상류도 멈춘다) — 서버 상한(TALK_CONNECT_TIMEOUT_MS)은 여기서 더한다
 */
export async function connectTalkCall(args: {
  sdp: string;
  session: RealtimeSessionCreateRequest;
  signal?: AbortSignal;
}): Promise<TalkConnectCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key", status: null, detail: "OPENAI_API_KEY 없음 — 호출하지 않음" };

  const started = Date.now();
  const form = new FormData();
  form.set("sdp", args.sdp);
  form.set("session", JSON.stringify(args.session));
  try {
    const res = await fetch(`${talkRealtimeBaseUrl()}/realtime/calls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: anySignal([args.signal, AbortSignal.timeout(TALK_CONNECT_TIMEOUT_MS)]),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) {
      console.error(`[talk] connect model=${args.session.model ?? "?"} status=${res.status} ms=${ms} 실패`);
      // 상류 오류 본문은 로그에만(짧게) — SDP·지시문은 담기지 않는다
      return { ok: false, error: "failed", status: res.status, detail: text.slice(0, 300) };
    }
    if (!/^v=0/.test(text.trimStart())) {
      console.error(`[talk] connect model=${args.session.model ?? "?"} status=${res.status} ms=${ms} answer가 SDP 모양이 아님`);
      return { ok: false, error: "failed", status: res.status, detail: "answer가 SDP 모양이 아님" };
    }
    const callId = parseTalkCallId(res.headers.get("location"));
    if (callId === null) console.warn(`[talk] connect status=${res.status} ms=${ms} Location에서 callId를 못 읽음 — 서버 hangup 없이 진행`);
    console.log(`[talk] connect model=${args.session.model ?? "?"} status=${res.status} ms=${ms}`);
    return { ok: true, sdp: text, callId, status: res.status };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.error(`[talk] connect ms=${Date.now() - started} 실패: ${name}`);
    return { ok: false, error: "failed", status: null, detail: name };
  }
}

/** 통화 끊기(서버 이중 안전장치). 성공하면 true, 실패·키 없음이면 false — 던지지 않는다. callId 형식은 호출부가 먼저 본다. */
export async function hangupTalkCall(callId: string): Promise<boolean> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return false;
  const started = Date.now();
  try {
    const res = await fetch(`${talkRealtimeBaseUrl()}/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TALK_HANGUP_TIMEOUT_MS),
    });
    await res.text().catch(() => "");
    console.log(`[talk] hangup status=${res.status} ms=${Date.now() - started}`);
    return res.ok;
  } catch (err) {
    console.warn(`[talk] hangup ms=${Date.now() - started} 실패(무시): ${err instanceof Error ? err.name : "Error"}`);
    return false;
  }
}
