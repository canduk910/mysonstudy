/**
 * lib/talk-fake-transport.ts — 은우 자유대화 **개발 빌드 전용 가짜 전송** (docs/SPEC.md §21-6, docs/harness/english.md §12-2·§12-7)
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
 *   `response.create` → 선생님 응답(마지막 숨은 안내에 따라 인사·도움·마무리) — 오디오 전사 delta·`.done`·`output_audio_buffer.started/
 *   stopped`·`response.done`(사용량 포함). 응답 진행 중 두 번째 response.create는 error 이벤트. **도구 호출은 내지 않는다**(§12-7 — 세션에
 *   도구가 없다). 선생님 응답은 한 차례를 한 번에 말하고(글자 확정 → response.done → 소리 멈춤 — 실서버 순서), 은우가 한 번 말하면
 *   VAD 자동 응답이 **하나** 나간다.
 * - 은우 발화는 조종 손잡이 `window.__talkFake`(개발 전용)로 흘린다: `childSays(text, {late, lateMs, fail, durationMs, commitNewId})` —
 *   speech_started → stopped → committed → item.added(user) → 전사 delta/completed(late면 선생님 응답이 끝난 **뒤에** 도착 — 기본
 *   2.6초, `lateMs`로 바꾼다) → VAD 자동 응답. 선생님이 말하는 중이면 끼어들기(speech_started 뒤 output_audio_buffer.cleared +
 *   response.done cancelled — 실서버 순서). `drop()`은 연결 끊김.
 * - **화면 카드 흉내**(호출 J — `setCards(mode)`, 컨트롤러가 `fetchCards`로 묻는다): `route`(기본 — 가로채지 않고 실제
 *   `/api/english/talk/cards`로. 키가 없으면 501 → 기본 문구, 루프백 스텁이면 스텁 결과) · `local`(이 모듈이 선생님 대사마다 적어 둔 답
 *   예시·핵심 단어·그림을 호출 J 후처리 `sanitizeTalkScreenCards`에 통과시켜 돌려준다 — 말에 없는 그림은 버려진다) · `slow`(local을
 *   2.5초 늦게 — 은우가 먼저 말하면 철 지난 도움이 된다) · `fail`(500 cards_failed). `cardsCalls`에 요청 본문이 쌓인다(e2e).
 * - 끝내기 전 전사 기다림(lib/talk-realtime.ts `finish`)을 태우는 이벤트: `session.update`의 `turn_detection: null` → 턴 감지 끔
 *   (session.updated, 이후 은우 발화·자동 응답 없음 — 다만 끄기 전에 커밋된 발화의 자동 응답은 그대로 나가 앱의 취소 경로를 태운다),
 *   `input_audio_buffer.commit` → 말하는 중인 발화를 그 자리에서 커밋·전사(응답 없음. `commitNewId`면 speech_started와 다른 항목 id로 —
 *   서버가 새 항목을 만드는 경우), 말하는 중이 아니면 error(input_audio_buffer_commit_empty). `output_audio_buffer.clear` → 소리 비움.
 * - 이벤트마다 고유 `event_id`(리듀서의 delta 멱등이 event_id에 기댄다).
 * 대사는 전부 지어낸 쉬운 영어다(실제 아이 발화를 픽스처로 쓰지 않는다).
 */

import type { TalkTopic } from "./ai/english/talk-schemas";
import { sanitizeTalkScreenCards } from "./talk-cards";
import type { TalkCardsRequest, TalkCardsResponse, TalkConnectSuccess, TalkTopicRequest } from "./talk-contract";
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
/** 선생님 응답 하나 — 말(늘 있다)과, 카드 흉내(local)에 쓸 답 예시·그림(호출 J가 이 말에서 만들 법한 값) */
interface FakePlan {
  text: string;
  picture: FakeCard | null;
  hints: FakeHints | null;
}

type Kind = "greet" | "nudge" | "wrapup" | "reply";

/** 화면 카드 흉내 방식(`setCards`) — route = 가로채지 않음(실제 라우트) */
export type FakeCardsMode = "route" | "local" | "slow" | "fail";
/** slow 모드의 지연(ms) — 배율 없음 */
const FAKE_CARDS_SLOW_MS = 2_500;

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
}

export interface FakeTalkControls {
  readonly mark: string;
  childSays(text: string, opts?: FakeChildOpts): void;
  drop(): void;
  /** 화면 카드 흉내 방식(기본 route) */
  setCards(mode: FakeCardsMode): void;
  /** 앱이 보낸 클라이언트 이벤트(모양 그대로) */
  readonly sent: readonly Record<string, unknown>[];
  /** 흘려보낸 서버 이벤트 */
  readonly emitted: readonly Record<string, unknown>[];
  /** 컨트롤러가 물은 카드 요청(본문 그대로 + 그때의 방식) — route 모드여도 쌓인다 */
  readonly cardsCalls: readonly { mode: FakeCardsMode; body: TalkCardsRequest }[];
  state(): {
    open: boolean;
    teacherSpeaking: boolean;
    responseActive: boolean;
    /** 은우 발화가 아직 말하는 중(커밋 전) */
    childSpeaking: boolean;
    teacherTurns: number;
    topicKind: string | null;
    cardsMode: FakeCardsMode;
    /** 앱이 보낸 response.create 수(인사·도움 요청·마무리뿐이어야 한다) */
    appResponseCreates: number;
    /** 은우 발화 뒤 서버 자동 응답 수 */
    autoReplies: number;
  };
}

declare global {
  interface Window {
    __talkFake?: FakeTalkControls;
  }
}

/**
 * 보통 차례 대사(한 차례를 한 번에 — 반응 한 마디 + 질문 하나, §12-7 차례 규칙). picture·hints는 카드 흉내(local)용 —
 * 셋째 줄의 pizza는 말에 없어서 호출 J 후처리가 버린다(근거 없는 그림 카드).
 */
const NORMAL_LINES: FakePlan[] = [
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
  private autoReplies = 0;
  private appResponseCreates = 0;
  private topic: TalkTopic | null = null;
  private cardsMode: FakeCardsMode = "route";
  /** 선생님 대사 → 그 대사의 카드 흉내 값(local) */
  private cardsByText = new Map<string, FakePlan>();
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
  readonly cardsCalls: { mode: FakeCardsMode; body: TalkCardsRequest }[] = [];

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
      setCards: (mode) => {
        this.cardsMode = mode;
      },
      sent: this.sent,
      emitted: this.emitted,
      cardsCalls: this.cardsCalls,
      state: () => ({
        open: this.open,
        teacherSpeaking: this.speakingResponseId !== null,
        responseActive: this.active !== null && !this.active.done,
        childSpeaking: this.utterance !== null,
        teacherTurns: this.teacherTurns,
        topicKind: this.topic?.kind ?? null,
        cardsMode: this.cardsMode,
        appResponseCreates: this.appResponseCreates,
        autoReplies: this.autoReplies,
      }),
    };
  }

  // ---- 화면 카드 흉내(호출 J) ----

  /**
   * 컨트롤러가 카드를 청할 때 묻는다(TalkTransport.fetchCards). route면 null(실제 라우트). 닫힌 뒤에도 기록은 남긴다.
   * local·slow는 그 대사에 적어 둔 값을 호출 J 후처리(sanitizeTalkScreenCards)에 통과시킨다 — 실제 라우트가 주는 모양 그대로.
   */
  fetchCards(body: TalkCardsRequest, signal: AbortSignal): Promise<TalkCardsResponse> | null {
    const mode = this.cardsMode;
    this.cardsCalls.push({ mode, body });
    if (mode === "route") return null;
    if (mode === "fail") return Promise.resolve({ ok: false, error: "cards_failed", messageKo: "가짜 전송: 카드 실패" });
    const plan = this.cardsByText.get(body.teacherLine) ?? null;
    const cards = sanitizeTalkScreenCards(
      { answers: plan?.hints?.answers ?? [], words: plan?.hints?.words ?? [], picture: plan?.picture ?? null },
      { teacherLine: body.teacherLine, words: body.words, shown: body.shown },
    );
    const result: TalkCardsResponse = { ok: true, ...cards };
    if (mode === "local") return Promise.resolve(result);
    return new Promise<TalkCardsResponse>((resolve, reject) => {
      const t = setTimeout(() => resolve(result), FAKE_CARDS_SLOW_MS);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
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
      this.appResponseCreates += 1;
      if (this.active && !this.active.done) {
        this.emit({ type: "error", error: { type: "invalid_request_error", code: "conversation_already_has_active_response", message: "fake: active response" } });
        return;
      }
      const note = this.lastNoteId ?? "";
      this.lastNoteId = null;
      // 앱이 response.create를 보내는 경우는 인사·도움 요청·마무리뿐이다(§12-7). 안내 없는 create는 보통 차례로 답한다
      const kind: Kind = note.startsWith("app_greet") ? "greet" : note.startsWith("app_wrapup") ? "wrapup" : note.startsWith("app_nudge") ? "nudge" : "reply";
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
    // 두 번째 단어부터는 복수형으로 — ✓ 매칭(끝의 s)까지 태운다. 이모지는 단어장 이모지(스냅샷 emoji), 없으면 ⭐
    return { emoji: w.emoji ?? "⭐", en: i === 0 ? w.en : `${w.en}s`, ko: koOrDefault(w.ko) };
  }

  private plan(kind: Kind): FakePlan {
    const label = this.topic?.labelEn ?? "today's topic";
    if (kind === "greet") {
      const vocab = this.vocabCard(0);
      return vocab
        ? {
            text: `Hi! I'm Sunny. Let's play with some words. Do you know ${vocab.en}?`,
            picture: vocab,
            hints: { answers: ["Yes, I do.", "No, I don't."], words: [vocab] },
          }
        : {
            text: `Hi! I'm Sunny. Let's talk about ${label}. Do you like dogs?`,
            picture: { emoji: "🐶", en: "dog", ko: "강아지" },
            hints: { answers: ["Yes, I do.", "I like dogs."], words: [{ emoji: "🐶", en: "dog", ko: "강아지" }] },
          };
    }
    if (kind === "nudge") {
      return {
        text: "You can say: Yes, I do. Can you say it with me?",
        picture: null,
        hints: { answers: ["Yes, I do.", "I can say it."], words: [] },
      };
    }
    if (kind === "wrapup") {
      // 마무리 응답에도 그림 값을 둔다 — 앱이 마무리 중에는 카드를 청하지 않는지(§12-7) 보려고
      return { text: "You did so well today! Goodbye, my friend!", picture: { emoji: "👋", en: "friend", ko: "친구" }, hints: null };
    }
    // 보통 차례 — 대사는 순서대로(도움 요청 응답·인사는 세지 않는다 → 첫 보통 차례는 늘 "A cat!")
    const idx = this.normalTurns;
    this.normalTurns += 1;
    const line = NORMAL_LINES[idx % NORMAL_LINES.length];
    const vocab = this.vocabCard(idx + 1);
    return { text: line.text, picture: vocab ?? line.picture, hints: line.hints };
  }

  private startResponse(kind: Kind): void {
    this.respSeq += 1;
    const id = `resp_fake_${this.respSeq}`;
    const bucket = new Set<ReturnType<typeof setTimeout>>();
    const p = this.plan(kind);
    this.teacherTurns += 1;
    this.cardsByText.set(p.text, p);
    const itemId = `item_t${++this.itemSeq}`;
    this.active = { id, itemId, timers: bucket, audio: true, done: false };
    const output: Record<string, unknown>[] = [];
    const mine = this.active;
    this.emit({ type: "response.created", response: { id, status: "in_progress", output: [] } });
    // 앱이 created를 받자마자(같은 호출 안에서) 취소했으면(끝내기 전 기다림) 더 흘리지 않는다
    if (this.active !== mine || mine.done) return;

    // 한 차례를 한 번에: 항목·소리 시작 → 전사 delta → 전사 .done → response.done → (재생이 늦게 끝나) 소리 멈춤 — 실서버 순서
    let t = 60;
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
    output.push(msg);
    t += 40;
    this.later(t, () => this.finishResponse(id, output), bucket);
    // 오디오 재생은 글자보다 늦게 끝난다(버퍼 비움) — stopped는 response.done 뒤
    const audioMs = Math.max(600, text.length * MS_PER_CHAR);
    this.later(Math.max(t + AUDIO_TAIL_MS, audioMs), () => {
      if (this.speakingResponseId !== id) return;
      this.speakingResponseId = null;
      this.emit({ type: "output_audio_buffer.stopped", response_id: id });
    }, bucket);
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
    // VAD 자동 응답(create_response: true) — 커밋 순간 정해진다(그 뒤에 턴 감지를 꺼도 나간다 → 앱이 취소해야 한다).
    // 은우의 한 번 대답에 선생님 응답은 이것 **하나**다(§12-7 — 앱은 이어 말하기를 보내지 않는다)
    this.later(200, () => {
      if (this.active && !this.active.done) return;
      this.autoReplies += 1;
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
