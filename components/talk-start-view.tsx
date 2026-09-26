"use client";

/**
 * components/talk-start-view.tsx — 은우 자유대화 **시작 화면** (SPEC §21-2 1~2, english.md §12-1)
 *
 * 주제 칩(프리셋 10개 — lib/talk-topics.ts 단일 정의) 또는 직접 입력, **또는** 단어장 하나(서버가 준 줄 정보만 — 단어는 서버가
 * id로 읽는다). 선생님 말 빠르기(천천히·보통). 안내문. 📞 대화 시작. 아래에 지난 대화 목록(관리 모드).
 *
 * 📞 탭 핸들러 안에서 **동기로**(첫 await 전에): 발음 큐 정지 → `unlockSpeechPlayback()`(대화 뒤 설명 낭독이 탭 밖에서도 나게) →
 * 원격 소리 요소 `play()`(재생 준비 — iOS 탭 밖 재생 잠금) → `acquireMicStream()`(getUserMedia 요청이 탭 안에서 나간다 — 권한 창).
 * 그다음 컨트롤러가 주제 일러스트(`/scene`)와 연결(`/connect`)을 **병렬로** 시작한다.
 *
 * 프롬프트 원문(첫 인사·마무리·도움 요청)은 서버 컴포넌트가 props(`notes`)로 내린다 — 이 파일은 lib/ai를 값으로 import하지 않는다.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import TalkCallOverlay from "@/components/talk-call-overlay";
import TalkHistoryList from "@/components/talk-history-list";
import { acquireMicStream } from "@/lib/mic-session";
import { stopSpeaking, unlockSpeechPlayback } from "@/lib/speech";
import type { TalkHistoryItem, TalkTopicRequest, TalkVocabBookOption } from "@/lib/talk-contract";
import { TalkCallController, type TalkAppNotes } from "@/lib/talk-realtime";
import {
  TALK_CUSTOM_TOPIC_MAX_CHARS,
  TALK_DEFAULT_SPEED,
  TALK_SPEEDS,
  TALK_SPEED_LABELS_KO,
  TALK_TOPIC_PRESETS,
  type TalkSpeed,
} from "@/lib/talk-topics";
import s from "./talk.module.css";

type Choice = { kind: "preset"; key: string } | { kind: "custom" } | { kind: "vocab"; id: string } | null;

export default function TalkStartView({
  vocabBooks,
  history,
  notes,
}: {
  vocabBooks: TalkVocabBookOption[];
  history: TalkHistoryItem[];
  notes: TalkAppNotes;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<Choice>(null);
  const [customText, setCustomText] = useState("");
  const [speed, setSpeed] = useState<TalkSpeed>(TALK_DEFAULT_SPEED);
  const [call, setCall] = useState<TalkCallController | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const customRef = useRef<HTMLInputElement>(null);

  const customLen = Array.from(customText.trim()).length;
  const topic: TalkTopicRequest | null =
    choice?.kind === "preset"
      ? { kind: "preset", key: choice.key }
      : choice?.kind === "custom"
        ? customLen >= 1 && customLen <= TALK_CUSTOM_TOPIC_MAX_CHARS
          ? { kind: "custom", text: customText.trim() }
          : null
        : choice?.kind === "vocab"
          ? { kind: "vocab", vocabBookId: choice.id }
          : null;
  const labelKo =
    choice?.kind === "preset"
      ? (TALK_TOPIC_PRESETS.find((p) => p.key === choice.key)?.labelKo ?? "")
      : choice?.kind === "custom"
        ? customText.trim()
        : choice?.kind === "vocab"
          ? (vocabBooks.find((b) => b.id === choice.id)?.titleKo ?? "단어장")
          : "";

  function onStart() {
    const audio = audioRef.current;
    if (!topic || !audio || call) return;
    // ── 탭 안에서 동기로(첫 await 전에) ──
    stopSpeaking(); // 설명 낭독 등 앱 소리를 멈춘다(선생님 목소리와 겹치지 않게)
    unlockSpeechPlayback(); // 대화 뒤 설명 낭독이 탭 밖에서도 나게(운동·토익 응시 관용구)
    try {
      const p = audio.play(); // 원격 소리 요소 재생 준비(소스는 연결 뒤에 붙는다)
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* noop */
    }
    const micPromise = acquireMicStream(); // getUserMedia 요청이 이 탭 안에서 나간다(권한 창)
    micPromise.catch(() => {}); // 실패는 컨트롤러가 받아 화면에 보인다
    const controller = new TalkCallController({ topic, speed, notes, micPromise, audio, labelKo });
    setCall(controller);
    void controller.start();
  }

  function onCloseCall() {
    call?.dispose();
    setCall(null);
    router.refresh(); // 지난 대화 목록 갱신
  }

  return (
    <>
      {/* 원격(선생님) 소리 — 연결 뒤 srcObject가 붙는다. 탭 안에서 play()로 재생 준비를 해 둔다 */}
      <audio ref={audioRef} autoPlay playsInline className="hidden" />

      <section aria-labelledby="talk-topic-title">
        <h2 id="talk-topic-title" className="t-section-title mb-3">
          무엇에 대해 이야기할까요?
        </h2>
        <div className={s.topicGrid} role="group" aria-label="주제">
          {TALK_TOPIC_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={s.topicChip}
              aria-pressed={choice?.kind === "preset" && choice.key === p.key}
              onClick={() => setChoice({ kind: "preset", key: p.key })}
            >
              <span className={s.topicEmoji} aria-hidden>
                {p.emoji}
              </span>
              <span className={s.topicChipLabel}>{p.labelKo}</span>
            </button>
          ))}
        </div>

        <label className="u-label mt-4 block" htmlFor="talk-custom-topic">
          직접 적기
        </label>
        <input
          id="talk-custom-topic"
          ref={customRef}
          type="text"
          className="u-input"
          placeholder="예: 우주, 바다, 로봇"
          maxLength={TALK_CUSTOM_TOPIC_MAX_CHARS}
          value={customText}
          onFocus={() => setChoice({ kind: "custom" })}
          onChange={(e) => {
            setCustomText(e.target.value);
            setChoice({ kind: "custom" });
          }}
          aria-describedby="talk-custom-help"
        />
        <p id="talk-custom-help" className="t-caption mt-1">
          {TALK_CUSTOM_TOPIC_MAX_CHARS}자까지 · 한국어로 적어도 선생님이 영어로 이야기해요.
        </p>
      </section>

      <section aria-labelledby="talk-vocab-title" className="mt-6">
        <h2 id="talk-vocab-title" className="t-section-title mb-2">
          또는 단어장으로
        </h2>
        {vocabBooks.length === 0 ? (
          <p className="t-caption">아직 단어장이 없어요. 단어장 정복에서 만들면 여기서 고를 수 있어요.</p>
        ) : (
          <select
            className="u-input"
            aria-label="단어장 고르기"
            value={choice?.kind === "vocab" ? choice.id : ""}
            onChange={(e) => setChoice(e.target.value ? { kind: "vocab", id: e.target.value } : null)}
          >
            <option value="">단어장 고르기…</option>
            {vocabBooks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.collected ? "⭐ " : ""}
                {b.dayLabel && b.dayLabel !== b.titleKo ? `${b.dayLabel} · ` : ""}
                {b.titleKo} ({b.wordCount}단어)
              </option>
            ))}
          </select>
        )}
      </section>

      <section aria-labelledby="talk-speed-title" className="mt-6">
        <h2 id="talk-speed-title" className="t-section-title mb-2">
          선생님 말 빠르기
        </h2>
        <div className={s.speedRow} role="group" aria-label="선생님 말 빠르기">
          {TALK_SPEEDS.map((sp) => (
            <button key={sp} type="button" className={s.speedBtn} aria-pressed={speed === sp} onClick={() => setSpeed(sp)}>
              {TALK_SPEED_LABELS_KO[sp]}
            </button>
          ))}
        </div>
      </section>

      <div className="mt-6 flex flex-col gap-3">
        <div className={s.notice}>
          <ul className={s.noticeList}>
            <li>어른과 함께 해요.</li>
            <li>이름·학교·주소는 말하지 않아요.</li>
            <li>이어폰이 있으면 더 잘 들려요.</li>
          </ul>
        </div>
        <button type="button" className={`u-btn u-btn-primary ${s.startBtn}`} onClick={onStart} disabled={!topic || call !== null}>
          <span aria-hidden>📞</span> 대화 시작{labelKo ? ` · ${labelKo}` : ""}
        </button>
        {!topic && <p className="t-caption text-center">주제를 고르거나 적으면 시작할 수 있어요. 한 번에 5분까지 이야기해요.</p>}
      </div>

      <TalkHistoryList items={history} />

      {call && <TalkCallOverlay controller={call} onClose={onCloseCall} />}
    </>
  );
}
