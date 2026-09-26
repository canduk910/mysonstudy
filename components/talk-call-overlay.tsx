"use client";

/**
 * components/talk-call-overlay.tsx — 은우 자유대화 **대화 화면**(전면 오버레이) (SPEC §21-2 3~5·§21-7, english.md §12-2·§12-6)
 *
 * 동작은 전부 lib/talk-realtime.ts의 `TalkCallController`가 한다 — 여기는 스냅숏(useSyncExternalStore)을 그리고 버튼을 잇는다.
 *
 * 배치(폰 기준, 위에서 아래):
 * - 머리: 주제 · 상태(연결 중 · 선생님이 말하는 중 · 은우 차례예요 · 마무리하는 중)
 * - 위쪽: 주제 일러스트 칸(도착 전 자리 표시 "그림을 그리는 중…", 실패하면 칸을 숨긴다) + 최근 그림 카드(큰 카드 1 + 칩 6) +
 *   단어장 모드 "오늘의 단어" 접이식 목록(그림 카드로 나온 단어에 ✓)
 * - 가운데: 말풍선 스크립트 — 선생님 왼쪽("Sunny 선생님"), 은우 오른쪽("은우"), "듣는 중…", 끊김, 흐림(안전 필터). 말풍선은
 *   `isVisibleTalkLine`으로만 거른다(리듀서 계약).
 * - 아래: 도움 카드("이렇게 말해 볼까요?" — 답 예시 큰 글씨 + 단어 이모지·영어·뜻, 은우가 말을 시작하면 접힌다) + 🙋 도와줘요 +
 *   남은 시간 + 끝내기. **카드에는 🔊가 없다** — 대화 중에는 마이크가 열려 있어 앱이 소리를 내면 선생님이 그 소리를 은우 말로 듣는다.
 *
 * 몰입: z 20 + lockBodyScroll(스트릭 헤드라인·셸을 덮는 것이 의도), Wake Lock(대화 중 화면 꺼짐 방지).
 * 화면이 숨겨지면(잠금·앱 전환·탭 닫힘) **즉시 끝내고 저장**한다(과금 중지, 스크립트 보존 — §21-2 4).
 * **화면이 사라져도 끝낸다(QA english_talk_1 P1-1)**: 대화 중 뒤로가기(iPhone 가장자리 스와이프·안드로이드 뒤로)로 이 컴포넌트가
 * 언마운트되면 컨트롤러를 끝내고(전송 close → 마이크 release → hangup) 저장을 한 번 보낸다. 언마운트 정리는 한 틱 미뤄 개발
 * StrictMode의 "정리 → 재실행" 흉내에는 끝내지 않는다. 문서가 내려가는 중(pagehide)이면 keepalive 한도 안의 본문으로 저장한다
 * (넘으면 그림을 뺀다 — 그림보다 대화). keepalive 한도는 **바이트**로 잰다(`planTalkSaveBody` — QA english_talk_2 P2-A).
 * keepalive 요청이 거부되면(TypeError) 문서가 내려가는 중이 아닐 때 keepalive 없이 한 번 더 보낸다.
 * 저장은 몇 번을 보내도 대화 하나다 — 본문의 멱등 키(clientSessionId, 컨트롤러 saveId)로 서버가 이미 저장된 대화를 돌려준다(P2-1).
 * **끝내기 버튼**은 `controller.finish("user")` — 은우 줄이 아직 전사 중이면 최대 2.5초 기다렸다 끝낸다(그동안 상태 "은우 말을 받아
 * 적는 중…", 버튼 "끝내는 중…"으로 잠김, 도움 카드 숨김 — lib/talk-realtime.ts `finish`). 숨김·pagehide·언마운트는 `end()`로 즉시 끝낸다.
 * 끝나면: 은우 발화 ≥ 1이면 저장(POST /api/english/talk) → 성공 시 STREAK_REFRESH_EVENT(§17-9) · 0이면 "다음엔 한마디 해 볼까요?" —
 * 다만 선생님이 한마디도 하기 전에 끝났으면(연결 중 끝내기·첫 인사 전 끊김) "연결되기 전에 끝났어요 — 다시 시작해 볼까요?".
 * 끝난 뒤에는 전사가 끝내 오지 않은 "듣는 중…" 줄을 그리지 않는다(연결이 닫혀 더는 오지 않는다 — 저장에서도 빠진다).
 * 작은 폰(P2-2): 도움 카드가 뜨면 "오늘의 단어" 목록을 접는다 — 스크립트와 끝내기가 늘 보이게(나머지는 CSS가 줄인다).
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import { TALK_CARD_LIMITS } from "@/lib/talk-cards";
import { planTalkSaveBody, talkSessionHref, type TalkSaveResponse } from "@/lib/talk-contract";
import type { TalkCallController, TalkSnapshot } from "@/lib/talk-realtime";
import { isVisibleTalkLine, toTalkTurns, type TalkLine } from "@/lib/talk-transcript";
import { useToeicWakeLock } from "@/components/use-toeic-wake-lock";
import s from "./talk.module.css";

type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved"; id: string; sceneSaved: boolean }
  | { phase: "skipped" }
  | { phase: "failed"; messageKo: string };

const HANGUL_RE = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

function statusText(snap: TalkSnapshot): { text: string; live: boolean; pulse: boolean } {
  if (snap.phase === "connecting") return { text: "연결 중…", live: false, pulse: true };
  if (snap.phase === "wrapping") return { text: "마무리하는 중", live: true, pulse: true };
  if (snap.phase === "finishing") return { text: "은우 말을 받아 적는 중…", live: false, pulse: true };
  if (snap.phase === "ended") return { text: "끝났어요", live: false, pulse: false };
  if (snap.teacherSpeaking) return { text: "선생님이 말하는 중", live: true, pulse: true };
  if (snap.childSpeaking) return { text: "은우가 말하는 중", live: true, pulse: true };
  if (snap.responding) return { text: "선생님이 생각하는 중…", live: true, pulse: true };
  return { text: "은우 차례예요", live: true, pulse: false };
}

function clock(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function Bubble({ line }: { line: TalkLine }) {
  const teacher = line.speaker === "teacher";
  let body: React.ReactNode;
  if (line.status === "listening") body = <p className={`${s.bubbleText} ${s.bubbleMuted}`}>듣는 중…</p>;
  else if (line.status === "failed") body = <p className={`${s.bubbleText} ${s.bubbleMuted}`}>잘 안 들렸어요</p>;
  else {
    const lang = teacher ? "en" : HANGUL_RE.test(line.text) ? "ko" : "en";
    body = (
      <p className={`${s.bubbleText} ${line.status === "partial" ? s.typing : ""}`} lang={lang}>
        {line.text}
      </p>
    );
  }
  return (
    <li className={`${s.row} ${teacher ? "" : s.rowChild}`}>
      <div className={`${s.bubble} ${teacher ? s.bubbleTeacher : s.bubbleChild} ${line.filtered ? s.bubbleFaded : ""}`}>
        <span className={s.speaker}>{teacher ? "Sunny 선생님" : "은우"}</span>
        {body}
        {line.status === "interrupted" && <span className={s.bubbleNote}>끊김</span>}
        {line.filtered && <span className={s.bubbleNote}>선생님이 다른 이야기를 할게요</span>}
      </div>
    </li>
  );
}

export default function TalkCallOverlay({ controller, onClose }: { controller: TalkCallController; onClose: () => void }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  const [save, setSave] = useState<SaveState>({ phase: "idle" });
  const [wordsOpen, setWordsOpen] = useState(false);
  const scriptRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  /** 저장 단계의 거울(언마운트 뒤·이벤트 처리기에서 최신 값을 읽는다) */
  const savePhaseRef = useRef<SaveState["phase"]>("idle");
  /** 진행 중인 저장 요청 수 */
  const inflightRef = useRef(0);
  /** 언마운트 정리 대기(StrictMode 재실행이면 취소) */
  const leaveRef = useRef<{ controller: TalkCallController; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** 문서가 내려가는 중(pagehide ~ pageshow) — keepalive 거부 뒤 일반 요청으로 다시 보낼지 판정한다(내려가는 중이면 끊기니 보내지 않는다) */
  const unloadingRef = useRef(false);

  // 몰입 — 스크롤 잠금·화면 꺼짐 방지
  useEffect(() => lockBodyScroll(), []);
  useToeicWakeLock(snap.phase !== "ended");

  // 남은 시간 시계(화면용 — 상한 판정은 컨트롤러가 한다)
  useEffect(() => {
    if (snap.phase === "ended") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [snap.phase]);

  /**
   * 저장 — 은우 발화 0이면 저장하지 않는다. 멱등 키가 실려 있어 여러 번 보내도 대화는 하나다(P2-1).
   * `unloading`(pagehide — 문서가 내려가는 중): 진행 중인 저장이 있어도 keepalive로 한 번 더 보낸다(진행 중 요청은 끊긴다).
   * keepalive 본문 한도(바이트)를 넘으면 그림을 뺀 본문으로 — 그림보다 대화가 남아야 한다. 본문·keepalive 판정은 `planTalkSaveBody` 한 곳.
   * keepalive 요청이 TypeError로 거부되면(본문·진행 중 keepalive 합산이 브라우저 한도를 넘었거나 연결이 끊겼다) 문서가 내려가는 중이
   * 아닐 때만 keepalive 없이 한 번 더 보낸다 — 멱등 키가 같아 첫 요청이 사실 저장됐어도 대화는 하나다.
   * 언마운트 뒤에도 불린다(setState는 조용히 무시되고, 스트릭 갱신 신호는 다음 화면의 헤드라인이 받는다).
   */
  const runSave = useCallback(
    async (opts: { unloading?: boolean } = {}) => {
      const update = (next: SaveState) => {
        savePhaseRef.current = next.phase;
        setSave(next);
      };
      // await 사이에 다른 요청이 단계를 바꾼다 — 좁히기 없이 늘 지금 값을 읽는다
      const phaseNow = (): SaveState["phase"] => savePhaseRef.current;
      if (phaseNow() === "saved") return;
      if (inflightRef.current > 0 && !opts.unloading) return;
      const payload = controller.getSavePayload();
      if (!payload) {
        update({ phase: "skipped" });
        return;
      }
      const plan = planTalkSaveBody(payload, { unloading: opts.unloading === true });
      const post = (keepalive: boolean) =>
        fetch("/api/english/talk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: plan.body,
          // 화면이 숨겨지는 중에도 끝까지 가게 — keepalive는 본문 64KiB(바이트) 이하만 허용된다(그림이 실리면 대개 일반 요청)
          keepalive,
        });
      // 실패는 다른 요청이 진행 중이 아니고 아직 저장되지 않았을 때만 보인다(겹친 요청 중 하나라도 저장되면 저장된 것이다)
      const fail = (messageKo: string) => {
        if (phaseNow() !== "saved" && inflightRef.current <= 1) update({ phase: "failed", messageKo });
      };
      inflightRef.current += 1;
      if (phaseNow() !== "saving") update({ phase: "saving" });
      try {
        let res: Response;
        try {
          res = await post(plan.keepalive);
        } catch (err) {
          // keepalive 거부(TypeError) — 문서가 내려가는 중이 아니면 keepalive 없이 한 번 더(P2-A). 내려가는 중이면 일반 요청은 끊기니
          // 보내지 않는다(pagehide 경로가 한도 안의 본문으로 따로 보낸다). 그 사이 다른 요청이 저장했으면 그만둔다.
          const retry = plan.keepalive && err instanceof TypeError && !opts.unloading && !unloadingRef.current && phaseNow() !== "saved";
          if (!retry) throw err;
          res = await post(false);
        }
        const data = (await res.json().catch(() => null)) as TalkSaveResponse | null;
        if (data && data.ok) {
          if (phaseNow() !== "saved") {
            update({ phase: "saved", id: data.id, sceneSaved: data.sceneSaved });
            window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT)); // 은우 스트릭 즉시 갱신(§17-9)
          }
        } else if (data && !data.ok && data.error === "no_child_turn") {
          if (phaseNow() !== "saved") update({ phase: "skipped" });
        } else {
          fail(data && !data.ok ? data.messageKo : "대화를 저장하지 못했어요.");
        }
      } catch {
        fail("인터넷 연결을 확인해 주세요. 대화를 저장하지 못했어요.");
      } finally {
        inflightRef.current -= 1;
      }
    },
    [controller],
  );

  // 화면이 숨겨지면 즉시 끝내고 저장한다(과금 중지 — §21-2 4). 탭 닫힘(pagehide)도 같다(hangup은 sendBeacon, 저장은 keepalive).
  // 저장을 다음 렌더의 효과까지 미루지 않는다 — 숨겨진 뒤 렌더가 늦어도 요청이 먼저 나가게.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      controller.end("hidden");
      void runSave();
    };
    const onPageHide = () => {
      unloadingRef.current = true;
      controller.end("hidden");
      void runSave({ unloading: true });
    };
    // bfcache에서 되살아나면 문서는 다시 살아 있다(이후 저장은 keepalive 거부 뒤 재시도할 수 있다)
    const onPageShow = () => {
      unloadingRef.current = false;
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [controller, runSave]);

  // 화면이 사라지면(대화 중 뒤로가기 등 — 언마운트) 끝내고 저장한다(QA english_talk_1 P1-1). 끝내기는 멱등이라 이미 끝났으면
  // 저장만(아직 안 했거나 실패했을 때) 한다. 개발 StrictMode는 마운트 직후 정리 → 재실행을 흉내 내므로 한 틱 미루고,
  // 같은 컨트롤러로 재실행되면 취소한다(진짜 언마운트에만 끝낸다).
  useEffect(() => {
    const pending = leaveRef.current;
    if (pending && pending.controller === controller) {
      clearTimeout(pending.timer);
      leaveRef.current = null;
    }
    return () => {
      const timer = setTimeout(() => {
        if (leaveRef.current?.timer === timer) leaveRef.current = null;
        controller.end("user");
        const phase = savePhaseRef.current;
        if (phase === "idle" || phase === "failed") void runSave();
      }, 0);
      leaveRef.current = { controller, timer };
    };
  }, [controller, runSave]);

  // 새 줄이 오면 아래로(사용자가 위로 올려 읽는 중이면 따라가지 않는다). 끝난 뒤의 "듣는 중…"은 전사가 더는 오지 않으므로 그리지 않는다
  const visibleLines = snap.lines.filter((l) => isVisibleTalkLine(l) && !(snap.phase === "ended" && l.status === "listening"));
  const lastKey = visibleLines.length > 0 ? `${visibleLines.length}:${visibleLines[visibleLines.length - 1].text.length}` : "0";
  useEffect(() => {
    const el = scriptRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lastKey, snap.hints.visible]);

  // 끝나면 저장(한 번) — 은우 발화 0이면 저장하지 않는다
  const ended = snap.phase === "ended";
  useEffect(() => {
    if (ended && savePhaseRef.current === "idle") void runSave();
  }, [ended, runSave]);

  // 숨김으로 끝나 저장이 실패했으면 화면이 돌아올 때 한 번 더(멱등 키 — 첫 요청이 사실 저장됐어도 하나로 남는다)
  useEffect(() => {
    if (save.phase !== "failed") return;
    const onVis = () => {
      if (document.visibilityState === "visible") void runSave();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [save.phase, runSave]);

  const st = statusText(snap);
  const remaining = snap.capAtMs !== null ? snap.capAtMs - now : null;
  const vocabMode = snap.todayWords.length > 0;
  const practicedSet = new Set(snap.practiced);
  // 주제 일러스트 칸 — 도착해 띄운 그림(shown), 또는 대화 중·마무리 전의 자리 표시. 마무리 중에 도착한 그림은 띄우지 않는다(§12-6)
  const sceneMode: "image" | "pending" | null =
    snap.scene.status === "ready"
      ? snap.scene.shown && snap.scene.dataUrl
        ? "image"
        : null
      : snap.scene.status === "loading" && (snap.phase === "connecting" || snap.phase === "live")
        ? "pending"
        : null;
  // 끝내는 중(전사 기다림)에는 도움 카드를 거둔다 — 더 말할 차례가 없다
  const hints = snap.hints.visible && snap.phase !== "finishing" ? snap.hints.hints : null;

  // 도움 카드가 뜨면 "오늘의 단어" 목록을 접는다(작은 폰에서 스크립트·끝내기를 밀어내지 않게 — P2-2). 다시 펼치는 것은 사용자가.
  const hintsShown = !ended && hints !== null;
  useEffect(() => {
    if (hintsShown) setWordsOpen(false);
  }, [hintsShown]);

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-label="Sunny 선생님과 영어 대화">
      <div className={s.frame}>
        <header className={s.head}>
          <h2 className={s.headTitle}>💬 {snap.topicLabelKo ?? "자유대화"}</h2>
          <span className={`${s.status} ${st.live ? s.statusLive : ""} ${st.pulse ? s.statusPulse : ""}`} role="status" aria-live="polite">
            <span className={s.statusDot} aria-hidden />
            {st.text}
          </span>
        </header>

        {/* 위쪽 — 주제 일러스트 + 그림 카드 */}
        <div className={s.top}>
          {sceneMode && (
            <div className={s.sceneBox}>
              {sceneMode === "image" && snap.scene.dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={s.sceneImg} src={snap.scene.dataUrl} alt={`주제 그림: ${snap.scene.sceneEn ?? ""}`} />
              ) : (
                <span className={s.scenePending}>그림을 그리는 중…</span>
              )}
            </div>
          )}
          <div className={s.pictureCol}>
            {snap.picture ? (
              <div className={s.bigCard} aria-live="polite">
                <span className={s.bigEmoji} aria-hidden>
                  {snap.picture.emoji}
                </span>
                <span className={s.bigText}>
                  <span className={s.bigEn} lang="en">
                    {snap.picture.en}
                  </span>
                  <span className={s.bigKo} lang="ko">
                    {snap.picture.ko}
                  </span>
                </span>
              </div>
            ) : (
              <div className={`${s.bigCard} ${s.bigCardEmpty}`}>선생님이 이야기하는 것을 그림 카드로 보여 줄 거예요.</div>
            )}
            {snap.recentCards.length > 0 && (
              <ul className={s.chips} aria-label="지난 그림 카드">
                {snap.recentCards.slice(0, TALK_CARD_LIMITS.recentChips).map((c) => (
                  <li key={c.en} className={s.chip}>
                    <span aria-hidden>{c.emoji}</span>
                    <span lang="en">{c.en}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {vocabMode && (
          <details className={s.words} open={wordsOpen} onToggle={(e) => setWordsOpen(e.currentTarget.open)}>
            <summary className={s.wordsSummary}>
              <span>📓 오늘의 단어</span>
              <span className="t-caption">
                ✓ {snap.practiced.length}/{snap.todayWords.length}
              </span>
            </summary>
            <ul className={s.wordsList}>
              {snap.todayWords.map((w) => {
                const done = practicedSet.has(w.en);
                return (
                  <li key={w.en} className={`${s.wordItem} ${done ? s.wordDone : ""}`}>
                    <span className={s.wordMark} aria-hidden>
                      {done ? "✓" : "·"}
                    </span>
                    <span className={s.wordEn} lang="en">
                      {w.en}
                    </span>
                    {w.ko && (
                      <span className={s.wordKo} lang="ko">
                        {w.ko}
                      </span>
                    )}
                    {done && <span className={s.srOnly}>연습했어요</span>}
                  </li>
                );
              })}
            </ul>
          </details>
        )}

        {/* 가운데 — 실시간 스크립트 */}
        <div
          ref={scriptRef}
          className={s.script}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          aria-label="대화 스크립트"
        >
          {visibleLines.length === 0 ? (
            <p className="t-caption px-2 py-6 text-center">
              {snap.phase === "connecting" ? "Sunny 선생님을 부르고 있어요…" : "선생님이 먼저 인사할 거예요."}
            </p>
          ) : (
            <ul className={s.bubbles}>
              {visibleLines.map((line) => (
                <Bubble key={line.itemId} line={line} />
              ))}
            </ul>
          )}
        </div>

        {/* 아래 — 도움 카드 · 조작 · 결과 */}
        <div className={s.bottom}>
          {!ended && hints && (
            <section className={s.hintCard} aria-live="polite" aria-label="이렇게 말해 볼까요?">
              <p className={s.hintTitle}>이렇게 말해 볼까요?</p>
              <ul className={`${s.hintAnswers} ${hints.source === "fallback" ? s.hintAnswersFallback : ""}`}>
                {hints.answers.map((a) => (
                  <li key={a.en} className={s.hintAnswer}>
                    <span lang="en">{a.en}</span>
                    {a.ko && (
                      <span className={s.hintAnswerKo} lang="ko">
                        {a.ko}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {hints.words.length > 0 && (
                <ul className={s.hintWords}>
                  {hints.words.map((w) => (
                    <li key={w.en} className={s.hintWord}>
                      <span aria-hidden>{w.emoji}</span>
                      <span lang="en">{w.en}</span>
                      <span className={s.hintWordKo} lang="ko">
                        {w.ko}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {process.env.NODE_ENV !== "production" && snap.fake && !ended && <FakePanel />}

          {!ended ? (
            <div className={s.controls}>
              <button
                type="button"
                className={`u-btn u-btn-secondary ${s.helpBtn}`}
                onClick={() => controller.helpTapped()}
                disabled={snap.phase !== "live"}
              >
                <span aria-hidden>🙋</span> 도와줘요
              </button>
              <span className={s.timer} aria-label="남은 시간">
                {remaining !== null ? clock(remaining) : "--:--"}
              </span>
              <button
                type="button"
                className={`u-btn u-btn-primary ${s.endBtn}`}
                onClick={() => controller.finish("user")}
                disabled={snap.phase === "finishing"}
              >
                {snap.phase === "finishing" ? "끝내는 중…" : "끝내기"}
              </button>
            </div>
          ) : (
            <ResultPanel snap={snap} save={save} onRetry={() => void runSave()} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}

function ResultPanel({
  snap,
  save,
  onRetry,
  onClose,
}: {
  snap: TalkSnapshot;
  save: SaveState;
  onRetry: () => void;
  onClose: () => void;
}) {
  const reasonNote =
    snap.endReason === "hidden"
      ? "화면이 꺼져서 대화를 끝냈어요."
      : snap.endReason === "disconnected"
        ? "연결이 끊겨서 대화를 끝냈어요."
        : snap.endReason === "time"
          ? "5분이 다 됐어요."
          : null;
  const u = snap.usage;
  // 선생님이 한마디도 하기 전에 끝났다(연결 중 끝내기·첫 인사 전 끊김) — 은우에게 "한마디 해 볼까요?"는 맞지 않는다
  const beforeTeacher = !toTalkTurns(snap.lines).some((t) => t.speaker === "teacher");
  return (
    <section className={s.result} aria-live="polite">
      {snap.errorKo && save.phase !== "saved" ? (
        <>
          <p className={s.resultTitle}>대화를 시작하지 못했어요</p>
          <p className="t-lead">{snap.errorKo}</p>
        </>
      ) : save.phase === "saving" || save.phase === "idle" ? (
        <p className={s.resultTitle}>대화를 저장하는 중…</p>
      ) : save.phase === "saved" ? (
        <>
          <p className={s.resultTitle}>잘했어요! 대화를 저장했어요 🎉</p>
          <p className="t-lead">문장을 누르면 선생님이 하나씩 설명해 줘요.</p>
        </>
      ) : save.phase === "skipped" && beforeTeacher ? (
        <>
          <p className={s.resultTitle}>연결되기 전에 끝났어요 — 다시 시작해 볼까요?</p>
          <p className="t-lead">선생님이 인사하기 전에 끝나서 이번 대화는 저장하지 않았어요.</p>
        </>
      ) : save.phase === "skipped" ? (
        <>
          <p className={s.resultTitle}>다음엔 한마디 해 볼까요?</p>
          <p className="t-lead">은우가 말한 게 없어서 이번 대화는 저장하지 않았어요.</p>
        </>
      ) : (
        <>
          <p className={s.resultTitle}>저장하지 못했어요</p>
          <p className="t-lead">{save.messageKo}</p>
        </>
      )}
      {reasonNote && !snap.errorKo && <p className="t-caption">{reasonNote}</p>}
      <div className={s.resultRow}>
        {save.phase === "saved" && (
          <Link href={talkSessionHref(save.id)} className="u-btn u-btn-primary flex-1" onClick={onClose}>
            대화 보기 →
          </Link>
        )}
        {save.phase === "failed" && (
          <button type="button" className="u-btn u-btn-primary flex-1" onClick={onRetry}>
            다시 저장
          </button>
        )}
        <button type="button" className="u-btn u-btn-secondary flex-1" onClick={onClose}>
          닫기
        </button>
      </div>
      {u.responses > 0 && (
        <details className={s.diag}>
          <summary>진단</summary>
          응답 {u.responses}회 · 입력 토큰 {u.inputTokens}(캐시 {u.cachedTokens}) · 출력 토큰 {u.outputTokens}
          {snap.fake ? " · 가짜 전송" : ""}
          {snap.timescale !== 1 ? ` · 시간 배율 ${snap.timescale}` : ""}
        </details>
      )}
    </section>
  );
}

/** 개발 빌드 전용 — 가짜 전송 조종 버튼(production에서는 이 컴포넌트를 부르는 분기가 컴파일 때 접힌다) */
function FakePanel() {
  const say = (text: string, opts?: { late?: boolean; fail?: boolean }) => window.__talkFake?.childSays(text, opts);
  return (
    <div className={s.fakePanel} aria-label="개발용 가짜 전송">
      <span>가짜:</span>
      <button type="button" onClick={() => say("I like dogs.")}>
        은우: I like dogs.
      </button>
      <button type="button" onClick={() => say("It is white.", { late: true })}>
        은우(늦은 전사)
      </button>
      <button type="button" onClick={() => say("")}>
        잡음
      </button>
      <button type="button" onClick={() => say("", { fail: true })}>
        전사 실패
      </button>
      <button type="button" onClick={() => window.__talkFake?.drop()}>
        끊기
      </button>
    </div>
  );
}
