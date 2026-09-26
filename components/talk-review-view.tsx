"use client";

/**
 * components/talk-review-view.tsx — 은우 자유대화 **대화 보기** (SPEC §21-2 6·§21-7, english.md §12-3·§12-6)
 *
 * - 주제 일러스트(있으면 — `GET /api/english/talk/images/[id]`, PIN 게이트 안) · 오늘 본 그림 카드 · 말풍선 스크립트.
 * - **문장 하나를 탭하면** 설명 시트: 탭 핸들러 안에서 **동기로 `unlockSpeechPlayback()`**(설명은 fetch 뒤에 오므로 탭 밖 재생 잠금을
 *   먼저 푼다 — 운동·토익 응시 관용구) → `POST /api/english/talk/[id]/explain {turnIndex, sentenceIndex}`(문장은 서버가 꺼낸다)
 *   → 선생님 말투 말풍선 + `speakQueue` **자동 낭독**(ko → ko-KR, en → en-US, lib/talk-explain-script.ts) + 🔊 다시 듣기 +
 *   더 멋진 문장(은우 문장)·짚은 단어. 한 번 만든 설명은 기록에 저장돼 다시 탭하면 저장된 것을 쓴다(AI 0 — 이미 받은 설명은
 *   네트워크도 없이 바로 읽는다).
 * - 낭독 정지는 **큐가 돌려준 stop 함수만** 쓴다(stopSpeaking은 다른 🔊까지 죽인다 — SPEC §18 관용구). 시트를 닫거나 다른 문장을
 *   누르거나 화면을 떠나면 멈춘다.
 * - 제목 편집(TalkTitleEditor)·삭제(인라인 확인, 그림 연쇄). 긴 문장은 줄바꿈(min-width:0 + overflow-wrap).
 * - 자동으로 도는 비용은 없다(SPEC §21-4) — 프리페치하지 않는다(설명 낭독은 탭한 문장만 합성된다).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import TalkTitleEditor from "@/components/talk-title-editor";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { speakQueue, unlockSpeechPlayback } from "@/lib/speech";
import {
  talkImageHref,
  type TalkCard,
  type TalkDeleteResponse,
  type TalkExplainResponse,
  type TalkExplanation,
  type TalkSpeaker,
  type TalkTurn,
} from "@/lib/talk-contract";
import { buildTalkExplainSpeakQueue } from "@/lib/talk-explain-script";
import { splitTalkSentences } from "@/lib/talk-transcript";
import s from "./talk.module.css";

const HANGUL_RE = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const keyOf = (t: number, si: number) => `${t}:${si}`;

interface SheetState {
  turnIndex: number;
  sentenceIndex: number;
  speaker: TalkSpeaker;
  sentence: string;
  status: "loading" | "ready" | "error";
  explanation: TalkExplanation | null;
  messageKo: string | null;
}

function minutesKo(sec: number): string {
  if (sec < 60) return `${Math.max(1, sec)}초`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return r >= 30 ? `${m}분 반` : `${m}분`;
}

export default function TalkReviewView({
  id,
  titleKo,
  topicLabelKo,
  durationSec,
  childTurnCount,
  sceneImageId,
  sceneEn,
  cards,
  turns,
  explanations,
}: {
  id: string;
  titleKo: string;
  topicLabelKo: string;
  durationSec: number;
  childTurnCount: number;
  sceneImageId: string | null;
  sceneEn: string | null;
  cards: TalkCard[];
  turns: TalkTurn[];
  explanations: TalkExplanation[];
}) {
  const router = useRouter();
  const sentencesByTurn = useMemo(() => turns.map((t) => splitTalkSentences(t.text)), [turns]);
  const [cache, setCache] = useState<Record<string, TalkExplanation>>(() =>
    Object.fromEntries(explanations.map((e) => [keyOf(e.turnIndex, e.sentenceIndex), e])),
  );
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [activePiece, setActivePiece] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const runRef = useRef(0);
  const openRef = useRef(0);

  function haltQueue() {
    runRef.current += 1;
    stopRef.current?.(); // 큐 stop만 — stopSpeaking은 쓰지 않는다
    stopRef.current = null;
    setActivePiece(null);
  }

  function play(exp: TalkExplanation) {
    haltQueue();
    const pieces = buildTalkExplainSpeakQueue(exp.script);
    if (pieces.length === 0) return;
    const token = runRef.current;
    stopRef.current = speakQueue(
      pieces.map((p) => ({ text: p.text, lang: p.lang })),
      {
        onItem: (i) => {
          if (runRef.current === token) setActivePiece(pieces[i]?.pieceIndex ?? null);
        },
        onEnd: () => {
          if (runRef.current !== token) return;
          stopRef.current = null;
          setActivePiece(null);
        },
      },
    );
  }

  // 화면을 떠나면 낭독을 멈춘다
  useEffect(() => () => {
    runRef.current += 1;
    stopRef.current?.();
  }, []);

  // 시트가 열린 동안 스크롤 잠금 + Esc로 닫기
  const sheetOpen = sheet !== null;
  useEffect(() => {
    if (!sheetOpen) return;
    const release = lockBodyScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      release();
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen]);

  function closeSheet() {
    haltQueue();
    openRef.current += 1;
    setSheet(null);
  }

  /** 문장 탭 — **동기로** 재생 잠금을 먼저 푼다(설명이 fetch 뒤에 와도 소리가 나게) */
  function onSentenceTap(turnIndex: number, sentenceIndex: number) {
    unlockSpeechPlayback();
    haltQueue();
    const turn = turns[turnIndex];
    const sentence = sentencesByTurn[turnIndex]?.[sentenceIndex];
    if (!turn || sentence === undefined) return;
    const token = ++openRef.current;
    const cached = cache[keyOf(turnIndex, sentenceIndex)];
    if (cached) {
      setSheet({ turnIndex, sentenceIndex, speaker: turn.speaker, sentence, status: "ready", explanation: cached, messageKo: null });
      play(cached); // 탭 안에서 바로(네트워크·AI 0)
      return;
    }
    setSheet({ turnIndex, sentenceIndex, speaker: turn.speaker, sentence, status: "loading", explanation: null, messageKo: null });
    void (async () => {
      try {
        const res = await fetch(`/api/english/talk/${encodeURIComponent(id)}/explain`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnIndex, sentenceIndex }),
        });
        const data = (await res.json().catch(() => null)) as TalkExplainResponse | null;
        if (openRef.current !== token) return; // 그사이 닫았거나 다른 문장을 눌렀다
        if (data && data.ok) {
          const exp = data.explanation;
          setCache((c) => ({ ...c, [keyOf(turnIndex, sentenceIndex)]: exp }));
          setSheet((cur) => (cur && openRef.current === token ? { ...cur, status: "ready", explanation: exp } : cur));
          play(exp);
        } else {
          const msg = data && !data.ok ? data.messageKo : "설명을 가져오지 못했어요.";
          setSheet((cur) => (cur && openRef.current === token ? { ...cur, status: "error", messageKo: msg } : cur));
        }
      } catch {
        if (openRef.current !== token) return;
        setSheet((cur) => (cur ? { ...cur, status: "error", messageKo: "인터넷 연결을 확인해 주세요." } : cur));
      }
    })();
  }

  async function runDelete() {
    setDeleting(true);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/english/talk/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as TalkDeleteResponse | null;
      if ((res.ok && data?.ok) || res.status === 404) {
        router.push("/english/talk");
        router.refresh();
        return;
      }
      setErrorKo(data && !data.ok ? data.messageKo : "지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 지우지 못했어요.");
    } finally {
      setDeleting(false);
    }
  }

  const exp = sheet?.explanation ?? null;

  return (
    <>
      <TalkTitleEditor id={id} titleKo={titleKo} />
      <p className="t-caption mt-1 flex flex-wrap items-center gap-1.5">
        <span className="u-chip">주제 · {topicLabelKo}</span>
        <span className="u-chip">은우 {childTurnCount}번 말함</span>
        <span className="u-chip">{minutesKo(durationSec)}</span>
      </p>

      {(sceneImageId && !imageFailed) || cards.length > 0 ? (
        <section className="mt-6 flex flex-col gap-5" aria-label="대화에서 본 그림">
          {sceneImageId && !imageFailed && (
            <figure className={s.sceneFigure}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className={s.sceneFigureImg}
                src={talkImageHref(sceneImageId)}
                alt={sceneEn ? `주제 그림: ${sceneEn}` : "주제 그림"}
                loading="lazy"
                onError={() => setImageFailed(true)}
              />
              {sceneEn && (
                <figcaption className={s.sceneCaption} lang="en">
                  {sceneEn}
                </figcaption>
              )}
            </figure>
          )}
          {cards.length > 0 && (
            <div>
              <h2 className="t-section-title mb-2">오늘 본 그림 카드</h2>
              <ul className={s.cardGrid}>
                {cards.map((c) => (
                  <li key={c.en} className={s.cardTile}>
                    <span className={s.cardTileEmoji} aria-hidden>
                      {c.emoji}
                    </span>
                    <span className={s.cardTileEn} lang="en">
                      {c.en}
                    </span>
                    <span className={s.cardTileKo} lang="ko">
                      {c.ko}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : null}

      <section className="mt-6" aria-label="대화 스크립트">
        <h2 className="t-section-title">대화</h2>
        <p className="t-caption mb-3 mt-1">문장을 누르면 선생님이 설명해 줘요. 💬 표시는 이미 들은 설명이에요.</p>
        <ul className={s.bubbles}>
          {turns.map((turn, ti) => {
            const teacher = turn.speaker === "teacher";
            const lang = teacher ? "en" : HANGUL_RE.test(turn.text) ? "ko" : "en";
            return (
              <li key={ti} className={`${s.row} ${teacher ? "" : s.rowChild}`}>
                <div className={`${s.bubble} ${teacher ? s.bubbleTeacher : s.bubbleChild}`}>
                  <span className={s.speaker}>{teacher ? "Sunny 선생님" : "은우"}</span>
                  <p className={s.bubbleText} lang={lang}>
                    {sentencesByTurn[ti].map((sent, si) => {
                      const active = sheet?.turnIndex === ti && sheet.sentenceIndex === si;
                      const done = cache[keyOf(ti, si)] !== undefined;
                      return (
                        <span key={si}>
                          {si > 0 ? " " : ""}
                          <button
                            type="button"
                            className={`${s.sentence} ${active ? s.sentenceActive : ""} ${done ? s.sentenceDone : ""}`}
                            onClick={() => onSentenceTap(ti, si)}
                            aria-label={`설명 듣기: ${sent}`}
                          >
                            {sent}
                          </button>
                        </span>
                      );
                    })}
                  </p>
                  {turn.interrupted && <span className={s.bubbleNote}>끊김</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-10" aria-label="대화 지우기">
        {errorKo && (
          <p role="alert" className="t-question-ko mb-3 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3 text-danger">
            {errorKo}
          </p>
        )}
        {confirmDelete ? (
          <div role="group" aria-label="삭제 확인" className="rounded-[var(--radius-box)] border border-danger bg-danger-soft p-4">
            <p className="t-caption">
              이 대화를 지울까요? 설명·그림도 함께 지워져요. <span className="font-medium text-danger">되돌릴 수 없어요.</span>
            </p>
            <div className="mt-3 flex gap-2">
              <button type="button" className="u-btn flex-1 bg-danger text-bg" onClick={() => void runDelete()} disabled={deleting}>
                {deleting ? "지우는 중…" : "지우기"}
              </button>
              <button type="button" className="u-btn u-btn-secondary flex-1" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                취소
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="u-btn u-btn-secondary w-full" onClick={() => setConfirmDelete(true)}>
            <span aria-hidden>🗑</span> 이 대화 지우기
          </button>
        )}
      </section>

      {sheet && (
        <>
          <div className={s.sheetBackdrop} onClick={closeSheet} aria-hidden />
          <section className={s.sheet} role="dialog" aria-modal="true" aria-label="선생님 설명">
            <div className={s.sheetHead}>
              <div className="min-w-0">
                <p className="t-caption">{sheet.speaker === "teacher" ? "Sunny 선생님이 한 말" : "은우가 한 말"}</p>
                <p className={s.sheetSentence} lang={sheet.speaker === "teacher" ? "en" : HANGUL_RE.test(sheet.sentence) ? "ko" : "en"}>
                  {sheet.sentence}
                </p>
              </div>
              <button type="button" className="u-navbtn flex-none" onClick={closeSheet} aria-label="설명 닫기">
                닫기
              </button>
            </div>

            {sheet.status === "loading" && <p className="t-lead">선생님이 설명을 준비하고 있어요…</p>}
            {sheet.status === "error" && (
              <>
                <p className="t-lead" role="alert">
                  {sheet.messageKo}
                </p>
                <button type="button" className="u-btn u-btn-secondary" onClick={() => onSentenceTap(sheet.turnIndex, sheet.sentenceIndex)}>
                  다시 해 볼까요?
                </button>
              </>
            )}
            {exp && sheet.status === "ready" && (
              <>
                <div className={s.teacherTalk} aria-live="polite">
                  {exp.script.map((p, i) => (
                    <p key={i} className={`${s.piece} ${p.lang === "en" ? s.pieceEn : ""} ${activePiece === i ? s.pieceActive : ""}`} lang={p.lang}>
                      {p.text}
                    </p>
                  ))}
                </div>
                <button
                  type="button"
                  className="u-btn u-btn-primary"
                  onClick={() => {
                    unlockSpeechPlayback();
                    play(exp);
                  }}
                >
                  <span aria-hidden>🔊</span> 다시 듣기
                </button>
                {exp.betterEn && (
                  <div className={s.betterBox}>
                    <span className={s.betterLabel}>이렇게 말하면 더 멋져요</span>
                    <span className={s.betterText} lang="en">
                      {exp.betterEn}
                    </span>
                  </div>
                )}
                {exp.keyWords.length > 0 && (
                  <div>
                    <p className="t-caption mb-1">짚은 단어</p>
                    <ul className={s.hintWords}>
                      {exp.keyWords.map((k) => (
                        <li key={k.en} className={s.hintWord}>
                          <span lang="en">{k.en}</span>
                          <span className={s.hintWordKo} lang="ko">
                            {k.ko}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
