/**
 * lib/talk-fake-transport.ts — 은우 자유대화 **개발 빌드 전용 가짜 전송** (docs/SPEC.md §21-6, docs/harness/english.md §12-2·§12-6)
 *
 * 실제 연결(WebRTC·음성)은 오프라인으로 검증할 수 없어서, 화면 흐름을 **합성 이벤트**로 돌리는 대역이다. `lib/talk-realtime.ts`의
 * `createTalkTransport`가 `process.env.NODE_ENV !== "production"` + localStorage `talk-debug-fake`="1"일 때만 **동적 import**한다 —
 * production 번들에는 이 모듈이 실리지 않는다(빌드 산출물 grep으로 확인: 표식 문자열 `TALK_FAKE_TRANSPORT_MARK`).
 *
 * 하는 일:
 * - 연결: 실제 `/api/english/talk/connect`를 **가짜 offer SDP**로 부른다(주제 스냅샷·단어장 단어를 서버가 해석 — 로컬 e2e는 루프백 스텁이
 *   `/v1/realtime/calls`에 가짜 SDP·Location을 준다). 키가 없거나(501) 연결이 거부되면(500) 화면 확인용 로컬 스냅샷으로 이어 간다.
 *   ⚠️ 실제 키가 있는 dev 서버에서 켜면 OpenAI에 통화 생성 요청 1회가 나간다(미디어·응답은 없고 끝낼 때 hangup) — e2e는 스텁으로.
 * - 앱이 보내는 이벤트에 반응한다: `conversation.item.create` → `conversation.item.added` 되돌림(숨은 `app_` 항목 포함),
 *   `response.create` → 선생님 응답(마지막 숨은 안내에 따라 인사·도움·마무리·이어 말하기) — 오디오 전사 delta·도구 호출(show_hints·
 *   show_picture)·`output_audio_buffer.started/stopped`·`response.done`(사용량 포함). 응답 진행 중 두 번째 response.create는 error 이벤트.
 * - 은우 발화는 조종 손잡이 `window.__talkFake`(개발 전용)로 흘린다: `childSays(text, {late, lateMs, fail, durationMs, commitNewId})` —
 *   speech_started → stopped → committed → item.added(user) → 전사 delta/completed(late면 선생님 응답이 끝난 **뒤에** 도착 — 기본
 *   2.6초, `lateMs`로 바꾼다) → VAD 자동 응답. 선생님이 말하는 중이면 끼어들기(speech_started 뒤 output_audio_buffer.cleared +
 *   response.done cancelled — 실서버 순서). `drop()`은 연결 끊김. 첫 은우 발화 뒤 응답은 **도구만 부르는 응답**
 *   (오디오 없음) — 앱의 function_call_output + 이어 말하기 경로를 태운다.
 * - **말만 하고 질문 없이 도구로 끝나는 응답**(2026-09-26 실연결에서 본 모양 — "Nice, that's a lovely choice." + show_hints로 응답 끝):
 *   `childSays(text, {noQuestionReplies: n})`이면 그 발화의 VAD 자동 응답부터 **n개 응답**(자동 응답 + 앱이 보낸 이어 말하기)이
 *   이 모양이다. 앱은 질문이 없으니 이어 말하기(response.create)를 보내고, 연속 상한(2)에 닿으면 멈춘다 — n=1이면 이어 말하기 응답이
 *   질문하는 보통 차례, n=3이면 이어 말하기 2번 뒤 앱이 더 보내지 않는다(도움 카드·12초 요청 경로로). 기본(옵션 없음) 흐름은 그대로다.
 * - 끝내기 전 전사 기다림(lib/talk-realtime.ts `finish`)을 태우는 이벤트: `session.update`의 `turn_detection: null` → 턴 감지 끔
 *   (session.updated, 이후 은우 발화·자동 응답 없음 — 다만 끄기 전에 커밋된 발화의 자동 응답은 그대로 나가 앱의 취소 경로를 태운다),
 *   `input_audio_buffer.commit` → 말하는 중인 발화를 그 자리에서 커밋·전사(응답 없음. `commitNewId`면 speech_started와 다른 항목 id로 —
 *   서버가 새 항목을 만드는 경우), 말하는 중이 아니면 error(input_audio_buffer_commit_empty). `output_audio_buffer.clear` → 소리 비움.
 * - 이벤트마다 고유 `event_id`(리듀서의 delta 멱등이 event_id에 기댄다).
 * 대사는 전부 지어낸 쉬운 영어다(실제 아이 발화를 픽스처로 쓰지 않는다).
 */

import type { TalkTopic } from "./ai/english/talk-schemas";
import type { TalkConnectSuccess, TalkTopicRequest } from "./talk-contract";
import { findTalkTopicPreset } from "./talk-topics";
import { TalkConnectError, postTalkConnect, type TalkConnectArgs, type TalkTransport, type TalkTransportHandlers } from "./talk-realtime";

/** 번들 확인용 표식 — production 산출물에 이 글자가 없어야 한다 */
export const TALK_FAKE_TRANSPORT_MARK = "talk-fake-transport:dev-only";

/** 스텁·서버가 받는 가짜 offer(모양만 SDP) */
const FAKE_OFFER_SDP = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=talk-fake\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=sendrecv\r\n";

/** 선생님 오디오 한 글자당 가짜 재생 시간(ms) — 짧게 */
const MS_PER_CHAR = 22;
const DELTA_GAP_MS = 60;
const AUDIO_TAIL_MS = 350;

interface FakeCard {
  emoji: string;
  en: string;
  ko: string;
}
interface FakeHints {
  answers: string[];
  words: FakeCard[];
}
interface FakePlan {
  text: string | null; // null = 오디오 없음(도구만)
  picture: FakeCard | null;
  hints: FakeHints | null;
  /** 도움 도구를 오디오 전에 부를지(순서 두 가지를 다 태운다) */
  hintsFirst: boolean;
  /** 그림 도구도 말한 **뒤에** 부른다(실연결 순서 — noQuestionReplies). 없으면 그림은 말하기 전 */
  toolsAfterSpeech?: boolean;
}

type Kind = "greet" | "nudge" | "wrapup" | "continue" | "reply";

/** 가짜 은우 발화 옵션 */
export interface FakeChildOpts {
  /** 전사가 선생님 응답 뒤에 늦게 온다(기본 2,600ms 뒤) */
  late?: boolean;
  /** 커밋 뒤 전사가 도착하기까지(ms) — late보다 우선 */
  lateMs?: number;
  /** 전사 실패 */
  fail?: boolean;
  /** 말하는 시간(ms, 기본 700) — 끝나면 VAD가 커밋한다 */
  durationMs?: number;
  /** 수동 커밋(input_audio_buffer.commit)이 speech_started와 **다른** 항목 id로 커밋한다 */
  commitNewId?: boolean;
  /**
   * 이 발화의 VAD 자동 응답부터 n개 응답(자동 응답 + 앱이 보낸 이어 말하기)을 **말만 하고 질문 없이 도구로 끝나는 응답**으로 한다
   * (도구는 말한 뒤에 — 실연결 순서). 앱의 이어 말하기·연속 상한 경로를 태운다.
   */
  noQuestionReplies?: number;
}

export interface FakeTalkControls {
  readonly mark: string;
  childSays(text: string, opts?: FakeChildOpts): void;
  drop(): void;
  /** 앱이 보낸 클라이언트 이벤트(모양 그대로) */
  readonly sent: readonly Record<string, unknown>[];
  /** 흘려보낸 서버 이벤트 */
  readonly emitted: readonly Record<string, unknown>[];
  state(): { open: boolean; teacherSpeaking: boolean; responseActive: boolean; teacherTurns: number; topicKind: string | null };
}

declare global {
  interface Window {
    __talkFake?: FakeTalkControls;
  }
}

/** 말만 하고 질문 없이 도구로 끝나는 응답의 대사(질문 표시 `?` 없음) — noQuestionReplies */
const NO_QUESTION_LINES: { text: string; picture: FakeCard | null; hints: FakeHints }[] = [
  {
    text: "Nice, that is a lovely answer.",
    picture: null,
    hints: { answers: ["Yes, I do.", "No, I don't."], words: [{ emoji: "👍", en: "yes", ko: "네" }] },
  },
  {
    text: "Great sentence! You are doing so well.",
    picture: { emoji: "⭐", en: "star", ko: "별" },
    hints: { answers: ["Thank you!", "I like it."], words: [{ emoji: "⭐", en: "star", ko: "별" }] },
  },
  {
    text: "Wow, good job. Let's keep going.",
    picture: null,
    hints: { answers: ["Okay!", "Yes!"], words: [] },
  },
];

const NORMAL_LINES: { text: string; picture: FakeCard | null; hints: FakeHints }[] = [
  {
    text: "A cat! Cats are so cute. What color is your cat?",
    picture: null,
    hints: { answers: ["It is white.", "It is black.", "It is orange."], words: [{ emoji: "⚪", en: "white", ko: "하얀색" }, { emoji: "⚫", en: "black", ko: "까만색" }] },
  },
  {
    text: "Great job! Do you like apples?",
    picture: { emoji: "🍎", en: "apple", ko: "사과" },
    hints: { answers: ["Yes, I do.", "No, I don't."], words: [{ emoji: "🍎", en: "apple", ko: "사과" }] },
  },
  {
    text: "Wow, you said it! What is your favorite food?",
    picture: { emoji: "🍕", en: "pizza", ko: "피자" },
    hints: { answers: ["I like pizza.", "I like rice."], words: [{ emoji: "🍕", en: "pizza", ko: "피자" }, { emoji: "🍚", en: "rice", ko: "밥" }] },
  },
  {
    text: "Me too! Is the sky blue or red?",
    picture: { emoji: "🌤️", en: "sky", ko: "하늘" },
    hints: { answers: ["It is blue.", "Blue!"], words: [{ emoji: "🔵", en: "blue", ko: "파란색" }] },
  },
];

function koOrDefault(ko: string | null | undefined): string {
  const v = (ko ?? "").trim();
  if (/[가-힣]/.test(v)) return Array.from(v).slice(0, 20).join("");
  return "오늘의 단어";
}

/** 로컬 스냅샷(연결 라우트가 501·500일 때 화면 확인용) */
function localTopic(req: TalkTopicRequest): TalkTopic {
  if (req.kind === "preset") {
    const p = findTalkTopicPreset(req.key);
    return { kind: "preset", key: p?.key ?? req.key, labelKo: p?.labelKo ?? req.key, labelEn: p?.labelEn ?? null, vocabBookId: null, words: [] };
  }
  if (req.kind === "custom") return { kind: "custom", key: null, labelKo: req.text.trim() || "자유", labelEn: null, vocabBookId: null, words: [] };
  return { kind: "vocab", key: null, labelKo: "단어장", labelEn: null, vocabBookId: req.vocabBookId, words: [] };
}

class FakeTalkTransport implements TalkTransport {
  readonly kind = "fake" as const;
  private handlers: TalkTransportHandlers | null = null;
  private open = false;
  private closed = false;
  private seq = 0;
  private itemSeq = 0;
  private respSeq = 0;
  private lastItemId: string | null = null;
  private lastNoteId: string | null = null;
  private teacherTurns = 0;
  private normalTurns = 0;
  private replies = 0;
  /** 남은 '말만 하고 질문 없이 도구로 끝나는 응답' 수(noQuestionReplies) · 지금까지 낸 수(대사 순환) */
  private noQuestionLeft = 0;
  private noQuestionSeq = 0;
  private topic: TalkTopic | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** 진행 중 응답(선생님 오디오 포함) — 끼어들기·취소가 이것을 끊는다 */
  private active: { id: string; itemId: string | null; timers: Set<ReturnType<typeof setTimeout>>; audio: boolean; done: boolean } | null = null;
  private speakingResponseId: string | null = null;
  /** 턴 감지가 꺼졌다(session.update turn_detection null) — 은우 발화·자동 응답을 더 만들지 않는다 */
  private vadOff = false;
  /** 말하는 중인 은우 발화(speech_started ~ 커밋 전) */
  private utterance: { itemId: string; text: string; opts: FakeChildOpts; bucket: Set<ReturnType<typeof setTimeout>> } | null = null;
  readonly sent: Record<string, unknown>[] = [];
  readonly emitted: Record<string, unknown>[] = [];

  async connect(args: TalkConnectArgs, handlers: TalkTransportHandlers): Promise<TalkConnectSuccess> {
    this.handlers = handlers;
    let info: TalkConnectSuccess;
    try {
      info = await postTalkConnect({ sdp: FAKE_OFFER_SDP, topic: args.topic, speed: args.speed });
    } catch (err) {
      if (!(err instanceof TalkConnectError) || (err.code !== "no_api_key" && err.code !== "connect_failed" && err.code !== "network")) throw err;
      info = { ok: true, sdp: "v=0", callId: null, topic: localTopic(args.topic), model: "fake-realtime", voice: "fake" };
    }
    this.topic = info.topic;
    if (typeof window !== "undefined") window.__talkFake = this.controls();
    this.later(150, () => {
      this.open = true;
      this.emit({ type: "session.created", session: { type: "realtime" } });
      this.handlers?.onOpen();
    });
    return info;
  }

  // ---- 조종 손잡이 ----

  private controls(): FakeTalkControls {
    return {
      mark: TALK_FAKE_TRANSPORT_MARK,
      childSays: (text, opts) => this.childSays(text, opts ?? {}),
      drop: () => {
        if (this.closed) return;
        this.clearAll();
        this.handlers?.onDisconnect("fake_drop");
      },
      sent: this.sent,
      emitted: this.emitted,
      state: () => ({
        open: this.open,
        teacherSpeaking: this.speakingResponseId !== null,
        responseActive: this.active !== null && !this.active.done,
        teacherTurns: this.teacherTurns,
        topicKind: this.topic?.kind ?? null,
      }),
    };
  }

  // ---- 도우미 ----

  private later(ms: number, fn: () => void, bucket?: Set<ReturnType<typeof setTimeout>>): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      bucket?.delete(t);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(t);
    bucket?.add(t);
  }

  private clearAll(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private emit(ev: Record<string, unknown>): void {
    if (this.closed) return;
    this.seq += 1;
    const full = { event_id: `evt_fake_${this.seq}`, ...ev };
    this.emitted.push(full);
    this.handlers?.onEvent(full);
  }

  // ---- 앱 → 가짜 서버 ----

  send(event: object): void {
    if (this.closed || !this.open) return;
    const ev = event as Record<string, unknown>;
    this.sent.push(ev);
    if (ev.type === "conversation.item.create") {
      const item = (ev.item ?? {}) as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : `item_x${++this.itemSeq}`;
      this.emit({ type: "conversation.item.added", previous_item_id: this.lastItemId, item: { ...item, id, status: "completed" } });
      this.lastItemId = id;
      if (item.type === "message" && item.role === "system") this.lastNoteId = id;
      return;
    }
    if (ev.type === "response.create") {
      if (this.active && !this.active.done) {
        this.emit({ type: "error", error: { type: "invalid_request_error", code: "conversation_already_has_active_response", message: "fake: active response" } });
        return;
      }
      const note = this.lastNoteId ?? "";
      this.lastNoteId = null;
      const kind: Kind = note.startsWith("app_greet")
        ? "greet"
        : note.startsWith("app_wrapup")
          ? "wrapup"
          : note.startsWith("app_nudge")
            ? "nudge"
            : "continue";
      this.startResponse(kind);
      return;
    }
    if (ev.type === "response.cancel") {
      this.cancelActive("client_cancelled");
      return;
    }
    if (ev.type === "session.update") {
      const session = (ev.session ?? {}) as Record<string, unknown>;
      const audio = (session.audio ?? {}) as Record<string, unknown>;
      const input = (audio.input ?? {}) as Record<string, unknown>;
      if ("turn_detection" in input && input.turn_detection === null) this.vadOff = true;
      this.emit({ type: "session.updated", session: { type: "realtime" } });
      return;
    }
    if (ev.type === "input_audio_buffer.commit") {
      if (this.utterance) this.endUtterance("manual");
      else this.emit({ type: "error", error: { type: "invalid_request_error", code: "input_audio_buffer_commit_empty", message: "fake: buffer empty" } });
      return;
    }
    if (ev.type === "output_audio_buffer.clear") {
      if (this.speakingResponseId !== null) {
        const id = this.speakingResponseId;
        this.speakingResponseId = null;
        this.emit({ type: "output_audio_buffer.cleared", response_id: id });
      }
      return;
    }
  }

  // ---- 선생님 응답 ----

  private vocabCard(i: number): FakeCard | null {
    const words = this.topic?.kind === "vocab" ? this.topic.words : [];
    if (words.length === 0) return null;
    const w = words[i % words.length];
    // 두 번째 단어부터는 복수형으로 — ✓ 매칭(끝의 s)까지 태운다
    return { emoji: "⭐", en: i === 0 ? w.en : `${w.en}s`, ko: koOrDefault(w.ko) };
  }

  private plan(kind: Kind): FakePlan {
    const label = this.topic?.labelEn ?? "today's topic";
    if (kind === "greet") {
      const vocab = this.vocabCard(0);
      return {
        text: vocab
          ? `Hi! I'm Sunny. Let's play with some words. Do you know ${vocab.en}?`
          : `Hi! I'm Sunny. Let's talk about ${label}. Do you like animals?`,
        picture: vocab ?? { emoji: "🐶", en: "dog", ko: "강아지" },
        hints: { answers: ["Yes, I do.", "I like dogs."], words: [{ emoji: "🐶", en: "dog", ko: "강아지" }] },
        hintsFirst: false,
      };
    }
    if (kind === "nudge") {
      return { text: "You can say: Yes, I do. Can you say it with me?", picture: null, hints: null, hintsFirst: false };
    }
    if (kind === "wrapup") {
      // 마무리 응답에도 도구 호출을 하나 섞는다 — 앱이 무시하는지(§12-6)
      return { text: "You did so well today! Goodbye, my friend!", picture: { emoji: "👋", en: "bye", ko: "안녕" }, hints: null, hintsFirst: false };
    }
    if ((kind === "reply" || kind === "continue") && this.noQuestionLeft > 0) {
      // 말만 하고 질문 없이 도구로 끝나는 응답 — 도구는 말한 뒤에(hintsFirst false)
      this.noQuestionLeft -= 1;
      const line = NO_QUESTION_LINES[this.noQuestionSeq % NO_QUESTION_LINES.length];
      this.noQuestionSeq += 1;
      return { text: line.text, picture: line.picture, hints: line.hints, hintsFirst: false, toolsAfterSpeech: true };
    }
    if (kind === "reply" && this.replies === 1) {
      // 첫 은우 발화 뒤: 오디오 없이 도구만 부르는 응답(이어 말하기 경로)
      const vocab = this.vocabCard(1);
      return { text: null, picture: vocab ?? { emoji: "🐱", en: "cat", ko: "고양이" }, hints: null, hintsFirst: false };
    }
    // 보통 차례 — 대사는 순서대로(도움 요청 응답·인사는 세지 않는다 → 첫 보통 차례는 늘 "A cat!")
    const idx = this.normalTurns;
    this.normalTurns += 1;
    const line = NORMAL_LINES[idx % NORMAL_LINES.length];
    const vocab = this.vocabCard(idx + 2);
    return { text: line.text, picture: vocab ?? line.picture, hints: line.hints, hintsFirst: idx % 2 === 1 };
  }

  private fcItem(name: string, args: unknown): Record<string, unknown> {
    this.itemSeq += 1;
    return {
      id: `item_fc${this.itemSeq}`,
      type: "function_call",
      status: "completed",
      name,
      call_id: `call_fake_${this.itemSeq}`,
      arguments: JSON.stringify(args),
    };
  }

  private startResponse(kind: Kind): void {
    this.respSeq += 1;
    const id = `resp_fake_${this.respSeq}`;
    const bucket = new Set<ReturnType<typeof setTimeout>>();
    const p = this.plan(kind);
    if (p.text !== null) this.teacherTurns += 1;
    const itemId = p.text !== null ? `item_t${++this.itemSeq}` : null;
    this.active = { id, itemId, timers: bucket, audio: p.text !== null, done: false };
    const output: Record<string, unknown>[] = [];
    const mine = this.active;
    this.emit({ type: "response.created", response: { id, status: "in_progress", output: [] } });
    // 앱이 created를 받자마자(같은 호출 안에서) 취소했으면(끝내기 전 기다림) 더 흘리지 않는다
    if (this.active !== mine || mine.done) return;

    let t = 60;
    const addTool = (name: string, args: unknown) => {
      const fc = this.fcItem(name, args);
      output.push(fc);
      const at = t;
      this.later(
        at,
        () => {
          this.emit({ type: "conversation.item.added", previous_item_id: this.lastItemId, item: fc });
          this.lastItemId = fc.id as string;
          this.emit({ type: "response.output_item.done", response_id: id, output_index: output.indexOf(fc), item: fc });
        },
        bucket,
      );
      t += 40;
    };

    if (p.picture && !(p.toolsAfterSpeech && p.text !== null)) addTool("show_picture", p.picture);
    if (p.hints && p.hintsFirst) addTool("show_hints", p.hints);

    if (p.text !== null && itemId) {
      const text = p.text;
      const msg = { id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_audio", transcript: text }] };
      this.later(
        t,
        () => {
          this.emit({ type: "conversation.item.added", previous_item_id: this.lastItemId, item: { ...msg, status: "in_progress", content: [] } });
          this.lastItemId = itemId;
          this.speakingResponseId = id; // 먼저 세운다 — 앱이 started를 받자마자 output_audio_buffer.clear를 보내도 비울 소리가 있게
          this.emit({ type: "output_audio_buffer.started", response_id: id });
        },
        bucket,
      );
      t += 60;
      const words = text.split(/(\s+)/).filter((w) => w !== "");
      for (const w of words) {
        this.later(t, () => this.emit({ type: "response.output_audio_transcript.delta", response_id: id, item_id: itemId, delta: w }), bucket);
        t += DELTA_GAP_MS;
      }
      this.later(t, () => this.emit({ type: "response.output_audio_transcript.done", response_id: id, item_id: itemId, transcript: text }), bucket);
      output.unshift(msg);
      if (p.picture && p.toolsAfterSpeech) addTool("show_picture", p.picture);
      if (p.hints && !p.hintsFirst) addTool("show_hints", p.hints);
      t += 40;
      this.later(t, () => this.finishResponse(id, output), bucket);
      // 오디오 재생은 글자보다 늦게 끝난다(버퍼 비움) — stopped는 response.done 뒤
      const audioMs = Math.max(600, text.length * MS_PER_CHAR);
      this.later(Math.max(t + AUDIO_TAIL_MS, audioMs), () => {
        if (this.speakingResponseId !== id) return;
        this.speakingResponseId = null;
        this.emit({ type: "output_audio_buffer.stopped", response_id: id });
      }, bucket);
    } else {
      if (p.hints && !p.hintsFirst) addTool("show_hints", p.hints);
      this.later(t + 40, () => this.finishResponse(id, output), bucket);
    }
  }

  private finishResponse(id: string, output: Record<string, unknown>[]): void {
    if (!this.active || this.active.id !== id || this.active.done) return;
    this.active.done = true;
    this.emit({
      type: "response.done",
      response: {
        id,
        status: "completed",
        output,
        usage: { input_tokens: 400 + this.respSeq * 120, output_tokens: 180, total_tokens: 580 + this.respSeq * 120, input_token_details: { cached_tokens: 256 } },
      },
    });
  }

  /** 진행 중 응답을 끊는다(끼어들기·response.cancel) — 소리 버퍼 비움 + response.done cancelled */
  private cancelActive(reason: "turn_detected" | "client_cancelled"): void {
    const a = this.active;
    if (!a) return;
    for (const t of a.timers) {
      clearTimeout(t);
      this.timers.delete(t);
    }
    a.timers.clear();
    if (this.speakingResponseId === a.id) {
      this.speakingResponseId = null;
      this.emit({ type: "output_audio_buffer.cleared", response_id: a.id });
    }
    if (!a.done) {
      a.done = true;
      this.emit({
        type: "response.done",
        response: {
          id: a.id,
          status: "cancelled",
          status_details: { type: "cancelled", reason },
          output: a.itemId ? [{ id: a.itemId, type: "message", role: "assistant", status: "incomplete", content: [] }] : [],
        },
      });
    }
  }

  // ---- 은우 발화 ----

  private childSays(text: string, opts: FakeChildOpts): void {
    if (this.closed || !this.open || this.vadOff) return; // 턴 감지가 꺼지면 서버는 말하기 시작·끝을 알리지 않는다
    if (this.utterance) this.endUtterance("vad"); // 앞 발화가 아직 말하는 중이면 먼저 끝낸다
    const itemId = `item_c${++this.itemSeq}`;
    const u = { itemId, text, opts, bucket: new Set<ReturnType<typeof setTimeout>>() };
    this.utterance = u; // 끼어들기 처리 중에 앱이 곧바로 커밋할 수 있다(끝내기 전 기다림) — 먼저 세워 둔다
    this.emit({ type: "input_audio_buffer.speech_started", item_id: itemId, audio_start_ms: this.seq * 10 });
    // 선생님이 말하는 중이면 끼어들기(실서버처럼 speech_started 뒤에)
    if (this.speakingResponseId !== null || (this.active && !this.active.done)) this.cancelActive("turn_detected");
    if (this.utterance === u) this.later(opts.durationMs ?? 700, () => this.endUtterance("vad"), u.bucket);
  }

  /** 말하는 중인 발화를 커밋한다 — vad: 말이 끝나 서버가 커밋(+ 자동 응답) · manual: 앱의 input_audio_buffer.commit(응답 없음) */
  private endUtterance(how: "vad" | "manual"): void {
    const u = this.utterance;
    if (!u) return;
    this.utterance = null;
    for (const t of u.bucket) {
      clearTimeout(t);
      this.timers.delete(t);
    }
    const { text, opts } = u;
    const itemId = how === "manual" && opts.commitNewId ? `item_c${++this.itemSeq}` : u.itemId;
    if (how === "vad") this.emit({ type: "input_audio_buffer.speech_stopped", item_id: itemId, audio_end_ms: this.seq * 10 });
    const prev = this.lastItemId;
    this.emit({ type: "input_audio_buffer.committed", item_id: itemId, previous_item_id: prev });
    this.emit({
      type: "conversation.item.added",
      previous_item_id: prev,
      item: { id: itemId, type: "message", role: "user", status: "completed", content: [{ type: "input_audio", transcript: null }] },
    });
    this.lastItemId = itemId;

    const deliver = () => {
      if (opts.fail) {
        this.emit({ type: "conversation.item.input_audio_transcription.failed", item_id: itemId, content_index: 0, error: { type: "fake", message: "fake failure" } });
        return;
      }
      const words = text.split(/(\s+)/).filter((w) => w !== "");
      for (const w of words) this.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: itemId, content_index: 0, delta: w });
      this.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, content_index: 0, transcript: text });
    };
    // 늦은 전사: 선생님 응답이 다 끝난 뒤에 도착(§12-2 1 — 그래도 은우 줄이 위에 서야 한다)
    this.later(typeof opts.lateMs === "number" ? opts.lateMs : opts.late ? 2_600 : 120, deliver);

    if (how === "manual" || this.vadOff) return; // 수동 커밋은 응답을 만들지 않는다(SDK 주석) · 턴 감지가 꺼졌으면 자동 응답 없음
    if (text.trim() === "" && !opts.fail) return; // 잡음 커밋 — 응답을 만들지 않는다
    // VAD 자동 응답(create_response: true) — 커밋 순간 정해진다(그 뒤에 턴 감지를 꺼도 나간다 → 앱이 취소해야 한다)
    this.later(200, () => {
      if (this.active && !this.active.done) return;
      this.replies += 1;
      if (typeof opts.noQuestionReplies === "number" && opts.noQuestionReplies > 0) this.noQuestionLeft = Math.floor(opts.noQuestionReplies);
      this.startResponse("reply");
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.clearAll();
    // 조종 손잡이(window.__talkFake)는 남긴다 — 끝난 뒤에도 e2e가 앱이 보낸 이벤트(sent)를 읽을 수 있게. 발화는 closed라 무시된다.
  }
}

export function createFakeTalkTransport(): TalkTransport {
  return new FakeTalkTransport();
}
