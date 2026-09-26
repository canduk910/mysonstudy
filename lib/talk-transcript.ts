/**
 * lib/talk-transcript.ts — 자유대화 **실시간 스크립트 순수 리듀서** + 저장용 턴 변환 + 문장 나누기
 * (docs/harness/english.md §12-2, SPEC §21-2)
 *
 * 화면은 Realtime 서버 이벤트(데이터 채널 `oai-events`의 JSON)를 직접 그리지 않고, 이 리듀서가 접은 `lines`만 그린다.
 *
 * 규칙(§12-2):
 * 1. **자리는 글자 도착 순서가 아니라 항목 연결로 정한다.** 은우 전사는 별도 음성 인식이 비동기로 만들어 선생님 응답보다
 *    늦게 올 수 있다(SDK 주석 "may come before or after the Response events").
 *    - `input_audio_buffer.speech_started{item_id}` → 은우 줄을 맨 뒤에(`listening`).
 *    - `conversation.item.added`(구형 `conversation.item.created`)·`input_audio_buffer.committed`의 `previous_item_id` →
 *      그 항목을 `previous_item_id` 바로 뒤로(모르면 맨 뒤 — 새 줄은 맨 뒤에 붙고, 이미 있는 줄은 제자리).
 * 2. 은우 글자: `...input_audio_transcription.delta` 이어 붙임(`partial`), `.completed` 교체(`final`, 빈 문자열이면 `empty`),
 *    `.failed` → `failed`.
 * 3. 선생님 글자: `response.output_audio_transcript.delta` 이어 붙임, `.done` 교체(`final`).
 * 4. `response.done` status `cancelled`(또는 `failed`) → 그 선생님 줄 `interrupted`(글자는 남긴다). `incomplete` + `content_filter` →
 *    `filtered`. 글자가 하나도 오기 전에 끊긴 줄은 화면에서 숨긴다(`isVisibleTalkLine`).
 * 5. 앱이 넣은 숨은 항목(아이디 접두사 `app_` — 첫 인사·마무리·도움 요청·일러스트 안내 system 메시지, 도구 호출 결과)과
 *    **선생님의 도구 호출 항목(`function_call`, §12-6)**은 줄로 만들지 않는다 — 그 항목을 가리키는 연결은 건너 이어 준다
 *    (도구 호출이 선생님 말 앞뒤에 끼어도 스크립트 순서가 흔들리지 않게).
 * 6. 같은 이벤트가 두 번 와도 결과가 같다(멱등): 연결은 한 번 적용한 것을 기억하고, delta는 event_id로 한 번만 붙인다
 *    (실서버 이벤트는 늘 event_id를 준다 — 개발용 가짜 전송도 event_id를 넣어야 delta 멱등이 성립한다).
 *    모르는 이벤트·모양이 틀린 이벤트는 무시한다(상태 객체를 그대로 돌려준다 — 화면이 다시 그리지 않는다).
 *
 * 이벤트 이름·필드는 설치된 SDK(openai 7.4.0)의 GA 타입과 맞췄다 — `TALK_REALTIME_EVENTS`가 `RealtimeServerEvent["type"]`으로
 * 타입 검사된다(이름을 틀리면 tsc가 잡는다). 입력은 네트워크 JSON이라 필드는 런타임에 다시 확인한다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import 0(타입만). lib/ai의 값·openai 런타임을 import하지 않는다.
 */

import type { ConversationItemCreateEvent, RealtimeServerEvent, ResponseCreateEvent } from "openai/resources/realtime/realtime";
import type { TalkSpeaker, TalkTurn } from "./ai/english/talk-schemas";

// ---------------------------------------------------------------------------
// 모양
// ---------------------------------------------------------------------------

export const TALK_LINE_STATUSES = ["listening", "partial", "final", "interrupted", "failed", "empty"] as const;
/**
 * listening = 은우가 말하는 중(글자 아직 없음, "듣는 중…") · partial = 글자가 오는 중 · final = 확정 ·
 * interrupted = 선생님 말이 끊김(글자는 남김) · failed = 은우 전사 실패("잘 안 들렸어요") · empty = 빈 전사(화면에서 숨김)
 */
export type TalkLineStatus = (typeof TALK_LINE_STATUSES)[number];

/** 화면이 그리는 줄 하나 */
export interface TalkLine {
  itemId: string;
  speaker: TalkSpeaker;
  text: string;
  status: TalkLineStatus;
  /** 선생님 응답이 안전 필터로 잘렸다(response.done incomplete + content_filter) — 화면이 흐리게 그린다 */
  filtered: boolean;
}

/** 리듀서 상태. 화면은 `lines`만 읽는다(나머지는 멱등·연결을 위한 기억). */
export interface TalkTranscriptState {
  lines: readonly TalkLine[];
  /** 줄마다 적용한 자리(바로 앞 항목 id). 같은 연결 정보가 다시 와도 다시 옮기지 않는다(멱등). */
  placedAfter: Readonly<Record<string, string>>;
  /** 줄이 아닌 항목(app_ 숨은 항목·도구 호출 등) → 그 항목의 previous_item_id. 그 뒤에 선 항목의 자리를 이어 준다. */
  hidden: Readonly<Record<string, string | null>>;
  /** 선생님 줄 → 응답 id(response.done이 어느 줄을 끊겼다고 표시할지) */
  responseOf: Readonly<Record<string, string>>;
  /** 전사가 끝난(.done) 선생님 줄 — 늦게 온 delta를 무시한다 */
  textDone: Readonly<Record<string, true>>;
  /** 이미 붙인 delta의 event_id — 같은 delta가 두 번 와도 한 번만 붙인다 */
  seenDeltas: Readonly<Record<string, true>>;
}

/** 앱이 `conversation.item.create`로 넣는 숨은 항목의 아이디 접두사(§12-2 5). 앱은 이 상수로 id를 만든다. */
export const TALK_HIDDEN_ITEM_PREFIX = "app_";

/**
 * 앱이 넣는 항목 id 형식 — `app_` + 영문·숫자·`_`·`-` 1~28자(합계 32자 이하. 클라이언트가 정하는 항목 id의 길이 제한을 보수적으로 잡았다).
 * 예: `app_greet`, `app_nudge_3`, `app_scene`, `app_out_7`.
 */
const TALK_HIDDEN_ITEM_ID_RE = /^app_[A-Za-z0-9_-]{1,28}$/;
export function isTalkHiddenItemId(value: unknown): value is string {
  return typeof value === "string" && TALK_HIDDEN_ITEM_ID_RE.test(value);
}

/** 리듀서가 읽는 GA 서버 이벤트 이름(그 밖은 무시). SDK 타입으로 검사된다. */
export const TALK_REALTIME_EVENTS = {
  speechStarted: "input_audio_buffer.speech_started",
  committed: "input_audio_buffer.committed",
  itemAdded: "conversation.item.added",
  itemCreated: "conversation.item.created",
  inputDelta: "conversation.item.input_audio_transcription.delta",
  inputCompleted: "conversation.item.input_audio_transcription.completed",
  inputFailed: "conversation.item.input_audio_transcription.failed",
  outputDelta: "response.output_audio_transcript.delta",
  outputDone: "response.output_audio_transcript.done",
  responseDone: "response.done",
} as const satisfies Record<string, RealtimeServerEvent["type"]>;

/** 빈 스크립트(대화 시작 상태) */
export function createTalkTranscript(): TalkTranscriptState {
  return { lines: [], placedAfter: {}, hidden: {}, responseOf: {}, textDone: {}, seenDeltas: {} };
}

// ---------------------------------------------------------------------------
// 도우미
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const isHidden = (id: string) => id.startsWith(TALK_HIDDEN_ITEM_PREFIX);

function findIndex(lines: readonly TalkLine[], itemId: string): number {
  return lines.findIndex((l) => l.itemId === itemId);
}

/** 줄이 없으면 맨 뒤에 만든다(있으면 상태 그대로 — 화자는 처음 정한 대로 둔다). */
function ensureLine(s: TalkTranscriptState, itemId: string, speaker: TalkSpeaker): TalkTranscriptState {
  if (findIndex(s.lines, itemId) >= 0) return s;
  const line: TalkLine = {
    itemId,
    speaker,
    text: "",
    status: speaker === "child" ? "listening" : "partial",
    filtered: false,
  };
  return { ...s, lines: [...s.lines, line] };
}

/** 줄 하나를 고친다(바뀐 게 없으면 상태 그대로). */
function patchLine(s: TalkTranscriptState, itemId: string, patch: Partial<Omit<TalkLine, "itemId">>): TalkTranscriptState {
  const i = findIndex(s.lines, itemId);
  if (i < 0) return s;
  const cur = s.lines[i];
  const next: TalkLine = { ...cur, ...patch };
  if (next.speaker === cur.speaker && next.text === cur.text && next.status === cur.status && next.filtered === cur.filtered) return s;
  const lines = s.lines.slice();
  lines[i] = next;
  return { ...s, lines };
}

/**
 * itemId 줄을 prev 바로 뒤로 옮긴다(§12-2 1). prev가 숨은 항목이면 그 항목의 앞 항목으로 거슬러 간다.
 * prev가 없거나(null·undefined) 모르는 항목이면 옮기지 않는다 — 새 줄은 이미 맨 뒤에 있고, 이미 있는 줄은 먼저 받은 연결이 정한 자리를 지킨다.
 * 한 번 적용한 연결(같은 줄·같은 앞 항목)은 다시 적용하지 않는다(멱등 — 그사이 다른 항목이 끼어들었어도 되돌리지 않는다).
 */
function placeAfter(s: TalkTranscriptState, itemId: string, rawPrev: unknown): TalkTranscriptState {
  let prev = str(rawPrev);
  for (let guard = 0; prev !== null && Object.prototype.hasOwnProperty.call(s.hidden, prev) && guard < 1000; guard++) {
    prev = s.hidden[prev];
  }
  if (prev === null || prev === itemId) return s;
  if (s.placedAfter[itemId] === prev) return s;
  const from = findIndex(s.lines, itemId);
  if (from < 0 || findIndex(s.lines, prev) < 0) return s;
  const lines = s.lines.slice();
  const [moving] = lines.splice(from, 1);
  lines.splice(findIndex(lines, prev) + 1, 0, moving);
  return { ...s, lines, placedAfter: { ...s.placedAfter, [itemId]: prev } };
}

// ---------------------------------------------------------------------------
// 이벤트별 처리
// ---------------------------------------------------------------------------

/** 줄이 아닌 항목: 줄을 만들지 않고 연결만 기억한다(뒤 항목의 previous_item_id가 이것을 가리킬 수 있다) */
function rememberPassThrough(s: TalkTranscriptState, id: string, rawPrev: unknown): TalkTranscriptState {
  const prev = str(rawPrev);
  let next = s;
  if (!Object.prototype.hasOwnProperty.call(s.hidden, id) || s.hidden[id] !== prev) {
    next = { ...next, hidden: { ...next.hidden, [id]: prev } };
  }
  if (findIndex(next.lines, id) >= 0) next = { ...next, lines: next.lines.filter((l) => l.itemId !== id) };
  return next;
}

function onItemAdded(s: TalkTranscriptState, ev: Rec): TalkTranscriptState {
  const item = ev.item;
  if (!isRec(item)) return s;
  const id = str(item.id);
  if (id === null) return s;
  // 앱이 넣은 숨은 항목(app_ — system 메시지·도구 호출 결과)
  if (isHidden(id)) return rememberPassThrough(s, id, ev.previous_item_id);
  // 선생님의 도구 호출(function_call, §12-6)·그 밖의 메시지 아닌 항목 — 스크립트에 안 보인다
  if (item.type !== "message") return rememberPassThrough(s, id, ev.previous_item_id);
  const speaker: TalkSpeaker | null = item.role === "user" ? "child" : item.role === "assistant" ? "teacher" : null;
  // system 메시지(앱은 늘 app_ id를 쓰지만, 그렇지 않은 것이 와도) — 줄이 아니다
  if (speaker === null) return rememberPassThrough(s, id, ev.previous_item_id);
  return placeAfter(ensureLine(s, id, speaker), id, ev.previous_item_id);
}

function onCommitted(s: TalkTranscriptState, ev: Rec): TalkTranscriptState {
  const id = str(ev.item_id);
  if (id === null || isHidden(id)) return s;
  return placeAfter(ensureLine(s, id, "child"), id, ev.previous_item_id);
}

function onSpeechStarted(s: TalkTranscriptState, ev: Rec): TalkTranscriptState {
  const id = str(ev.item_id);
  if (id === null || isHidden(id)) return s;
  return ensureLine(s, id, "child");
}

function markDeltaSeen(s: TalkTranscriptState, eventId: string | null): TalkTranscriptState {
  return eventId === null ? s : { ...s, seenDeltas: { ...s.seenDeltas, [eventId]: true } };
}

function onInputDelta(s: TalkTranscriptState, ev: Rec): TalkTranscriptState {
  const id = str(ev.item_id);
  if (id === null || isHidden(id)) return s;
  const eventId = str(ev.event_id);
  if (eventId !== null && s.seenDeltas[eventId]) return s;
  const delta = typeof ev.delta === "string" ? ev.delta : "";
  let next = ensureLine(s, id, "child");
  const line = next.lines[findIndex(next.lines, id)];
  if (line.speaker !== "child" || line.status === "final" || line.status === "empty" || line.status === "failed") return next;
  if (delta === "") return next;
  next = patchLine(next, id, { text: line.text + delta, status: "partial" });
  return markDeltaSeen(next, eventId);
}

function onInputCompleted(s: TalkTranscriptState, ev: Rec): TalkTranscriptState {
  const id = str(ev.item_id);
  if (id === null || isHidden(id)) return s;
  const next = ensureLine(s, id, "child");
  const text = (typeof ev.transcript === "string" ? ev.transcript : "").trim();
  return patchLine(next, id, { text, status: text === "" ? "empty" : "final" });
}

function onInputFailed(s: TalkTranscriptState, ev: Rec): TalkTranscriptState {
  const id = str(ev.item_id);
  if (id === null || isHidden(id)) return s;
  const next = ensureLine(s, id, "child");
  const line = next.lines[findIndex(next.lines, id)];
  if (line.status === "final" || line.status === "empty") return next; // 확정 전사가 이미 있으면 그쪽이 이긴다(순서 무관)
  return patchLine(next, id, { status: "failed" });
}

function rememberResponse(s: TalkTranscriptState, itemId: string, responseId: string | null): TalkTranscriptState {
  if (responseId === null || s.responseOf[itemId] === responseId) return s;
  return { ...s, responseOf: { ...s.responseOf, [itemId]: responseId } };
}

function onOutputDelta(s: TalkTranscriptState, ev: Rec): TalkTranscriptState {
  const id = str(ev.item_id);
  if (id === null || isHidden(id)) return s;
  const eventId = str(ev.event_id);
  if (eventId !== null && s.seenDeltas[eventId]) return s;
  let next = rememberResponse(ensureLine(s, id, "teacher"), id, str(ev.response_id));
  const delta = typeof ev.delta === "string" ? ev.delta : "";
  if (next.textDone[id] || delta === "") return next;
  const line = next.lines[findIndex(next.lines, id)];
  if (line.speaker !== "teacher") return next;
  next = patchLine(next, id, { text: line.text + delta, status: line.status === "interrupted" ? "interrupted" : "partial" });
  return markDeltaSeen(next, eventId);
}

function onOutputDone(s: TalkTranscriptState, ev: Rec): TalkTranscriptState {
  const id = str(ev.item_id);
  if (id === null || isHidden(id)) return s;
  let next = rememberResponse(ensureLine(s, id, "teacher"), id, str(ev.response_id));
  const line = next.lines[findIndex(next.lines, id)];
  if (line.speaker !== "teacher") return next;
  const text = (typeof ev.transcript === "string" ? ev.transcript : line.text).trim();
  next = patchLine(next, id, { text, status: line.status === "interrupted" ? "interrupted" : "final" });
  return next.textDone[id] ? next : { ...next, textDone: { ...next.textDone, [id]: true } };
}

function onResponseDone(s: TalkTranscriptState, ev: Rec): TalkTranscriptState {
  const resp = ev.response;
  if (!isRec(resp)) return s;
  const responseId = str(resp.id);
  const status = resp.status;
  const reason = isRec(resp.status_details) ? resp.status_details.reason : undefined;
  const outputIds = new Set<string>();
  if (Array.isArray(resp.output)) {
    for (const it of resp.output) {
      const oid = isRec(it) ? str(it.id) : null;
      if (oid !== null) outputIds.add(oid);
    }
  }
  let next = s;
  for (const line of s.lines) {
    if (line.speaker !== "teacher") continue;
    const mine = outputIds.has(line.itemId) || (responseId !== null && s.responseOf[line.itemId] === responseId);
    if (!mine) continue;
    if (status === "cancelled" || status === "failed") {
      // 끊겼거나(은우가 끼어듦) 실패로 멈췄다 — 말이 중간에 멈춘 것이라 끊김으로 둔다(글자는 남긴다)
      next = patchLine(next, line.itemId, { status: "interrupted" });
    } else if (status === "completed" || status === "incomplete") {
      // 응답이 끝났다 — 전사 .done이 빠졌어도 줄을 확정한다(글자는 더 오지 않는다)
      if (line.status === "partial") next = patchLine(next, line.itemId, { status: "final" });
      if (status === "incomplete" && reason === "content_filter") next = patchLine(next, line.itemId, { filtered: true });
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// 리듀서
// ---------------------------------------------------------------------------

/**
 * 서버 이벤트 하나를 접는다(순수·멱등). `event`는 데이터 채널에서 받은 JSON 그대로 넘긴다 — 모르는 이벤트·모양이 틀린 이벤트는
 * 상태를 **그대로(같은 객체로)** 돌려준다.
 */
export function reduceTalkTranscript(state: TalkTranscriptState, event: unknown): TalkTranscriptState {
  if (!isRec(event)) return state;
  const E = TALK_REALTIME_EVENTS;
  switch (event.type) {
    case E.speechStarted:
      return onSpeechStarted(state, event);
    case E.committed:
      return onCommitted(state, event);
    case E.itemAdded:
    case E.itemCreated:
      return onItemAdded(state, event);
    case E.inputDelta:
      return onInputDelta(state, event);
    case E.inputCompleted:
      return onInputCompleted(state, event);
    case E.inputFailed:
      return onInputFailed(state, event);
    case E.outputDelta:
      return onOutputDelta(state, event);
    case E.outputDone:
      return onOutputDone(state, event);
    case E.responseDone:
      return onResponseDone(state, event);
    default:
      return state;
  }
}

/** 여러 이벤트를 차례로 접는다(eval·개발용 가짜 전송·재생 공용) */
export function reduceTalkTranscriptEvents(events: readonly unknown[], state: TalkTranscriptState = createTalkTranscript()): TalkTranscriptState {
  return events.reduce<TalkTranscriptState>((s, ev) => reduceTalkTranscript(s, ev), state);
}

/**
 * 화면에 보일 줄인가 — 말풍선은 **이 함수로만** 거른다.
 * - 빈 전사(`empty`)는 숨긴다(§12-2 2).
 * - 글자 없이 끝난 줄(`interrupted`·`final`인데 글자가 비었다 — 글자가 오기 전에 끊긴 선생님 응답)도 숨긴다(빈 말풍선에 끊김 표시가 뜨지 않게).
 * - "듣는 중…"(`listening`)·글자가 오는 중(`partial`)·전사 실패(`failed`, "잘 안 들렸어요")는 글자가 없어도 보인다.
 */
export function isVisibleTalkLine(line: TalkLine): boolean {
  if (line.status === "empty") return false;
  if ((line.status === "interrupted" || line.status === "final") && line.text.trim() === "") return false;
  return true;
}

// ---------------------------------------------------------------------------
// 앱이 보내는 이벤트 (§12-1·§12-6) — 숨은 system 메시지 + response.create
// ---------------------------------------------------------------------------

/**
 * 숨은 system 메시지 항목(§12-1 첫 인사·마무리, §12-6 도움 요청·일러스트 안내). 응답 단위 `instructions`로 보내지 않는다 —
 * 그 값은 세션 지시문을 덮어써 그 응답에서 선생님 성격·안전 규칙이 빠질 수 있다(§12-1 2026-09-26 정정).
 * id는 `app_` 형식이어야 한다(리듀서가 줄로 만들지 않는다) — 아니면 던진다.
 */
export function buildTalkSystemNoteEvent(itemId: string, text: string): ConversationItemCreateEvent {
  if (!isTalkHiddenItemId(itemId)) {
    throw new Error(`[talk] 앱이 넣는 항목 id는 ${TALK_HIDDEN_ITEM_PREFIX}로 시작하는 형식이어야 합니다: ${itemId}`);
  }
  return {
    type: "conversation.item.create",
    item: { id: itemId, type: "message", role: "system", content: [{ type: "input_text", text }] },
  };
}

/** 선생님이 말하게 하는 `response.create` — **인자 없음**(세션 지시문·도구가 그대로 적용된다). 첫 인사·마무리·도움 요청·질문 없이 끝난 도구 응답 뒤 이어 말하기에 쓴다. */
export function buildTalkResponseCreateEvent(): ResponseCreateEvent {
  return { type: "response.create" };
}

// ---------------------------------------------------------------------------
// 저장용 변환 (§12-2 7)
// ---------------------------------------------------------------------------

/** 줄 → 저장용 턴. `empty`·`failed`·글자 없는 줄을 뺀다. 은우 턴의 interrupted는 늘 false. */
export function toTalkTurns(lines: readonly TalkLine[]): TalkTurn[] {
  const out: TalkTurn[] = [];
  for (const l of lines) {
    if (l.status === "empty" || l.status === "failed") continue;
    const text = l.text.trim();
    if (text === "") continue;
    out.push({ speaker: l.speaker, text, interrupted: l.speaker === "teacher" && l.status === "interrupted" });
  }
  return out;
}

/** 은우 턴 수(스트릭 §17-9·저장 조건 ≥ 1) */
export function childTurnCount(turns: readonly { speaker: TalkSpeaker }[]): number {
  return turns.reduce((n, t) => (t.speaker === "child" ? n + 1 : n), 0);
}

// ---------------------------------------------------------------------------
// 문장 나누기 (§12-2 8) — 설명의 키는 (turnIndex, sentenceIndex)라 결정적이어야 한다
// ---------------------------------------------------------------------------

/** 문장 끝 부호 — 반각 `.?!`, 말줄임 `…`, 전각 `。？！`(한국어·일본어 입력기 문장 끝) */
const SENTENCE_END = new Set([".", "?", "!", "…", "。", "？", "！"]);
/** 끝 부호 바로 뒤에 붙는 닫는 기호 — 앞 문장에 붙인다(`"Hi!" she said`의 `"`) */
const SENTENCE_CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "」", "』", "）"]);
/** 뒤에 마침표가 와도 문장 끝이 아닌 호칭 약어(선생님이 "Mr. Bear"라고 부를 때 문장이 쪼개지지 않게) */
const TITLE_ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr"]);

/**
 * 문장 나누기(결정적 — 같은 글자는 늘 같게 나뉜다). 문장 끝 부호(연속 부호·닫는 기호 포함) **뒤에 공백이 올 때만** 자른다 —
 * 숫자 속 마침표("3.5")·약어 속 마침표("a.m.")처럼 뒤가 바로 글자인 자리는 자르지 않는다. 호칭 약어(Mr. Mrs. Ms. Dr.) 뒤도 자르지 않는다.
 * 각 문장은 앞뒤 공백을 걷고, 빈 조각은 버린다. 부호가 없으면 통째로 한 문장이다.
 */
export function splitTalkSentences(text: string): string[] {
  const t = typeof text === "string" ? text : "";
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < t.length) {
    if (!SENTENCE_END.has(t[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < t.length && (SENTENCE_END.has(t[j]) || SENTENCE_CLOSERS.has(t[j]))) j++;
    if (j < t.length && !/\s/.test(t[j])) {
      i = j; // 뒤가 바로 글자 — 문장 끝이 아니다(3.5, a.m.)
      continue;
    }
    if (t[i] === "." && j === i + 1) {
      const word = /([A-Za-z]+)$/.exec(t.slice(start, i));
      if (word && TITLE_ABBREVIATIONS.has(word[1].toLowerCase())) {
        i = j;
        continue;
      }
    }
    const piece = t.slice(start, j).trim();
    if (piece !== "") out.push(piece);
    start = j;
    i = j;
  }
  const rest = t.slice(start).trim();
  if (rest !== "") out.push(rest);
  return out;
}

/**
 * 저장된 턴에서 (turnIndex, sentenceIndex) 문장을 꺼낸다. 번호가 정수가 아니거나 범위 밖이면 null(라우트 400).
 * 설명 라우트는 이것으로 문장을 **서버에서** 꺼낸다(클라이언트는 번호만 보낸다, §12-3 경계면).
 */
export function pickTalkSentence(
  turns: readonly TalkTurn[],
  turnIndex: number,
  sentenceIndex: number,
): { speaker: TalkSpeaker; sentence: string } | null {
  if (!Number.isInteger(turnIndex) || !Number.isInteger(sentenceIndex)) return null;
  if (turnIndex < 0 || turnIndex >= turns.length || sentenceIndex < 0) return null;
  const turn = turns[turnIndex];
  const sentences = splitTalkSentences(turn.text);
  if (sentenceIndex >= sentences.length) return null;
  return { speaker: turn.speaker, sentence: sentences[sentenceIndex] };
}
