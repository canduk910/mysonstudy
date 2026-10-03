"use client";

/**
 * 🗣️ 틀 말하기 결과 화면 (docs/harness/toeic.md §20-1 5·§20-10, SPEC §20-17) — 클라이언트 컴포넌트.
 *
 * - 판정이 없으면 열리자마자 `POST /sessions/[id]/judge`(호출 E 또는 AI 0 — 판정·통계가 한 원자 단위). 실패하면 "다시 판정 받기"
 *   (말한 기록은 이미 저장돼 있다), 키 없음(501)은 안내만.
 * - 판정이 있으면 `POST /sessions/[id]/supply`를 한 번(best-effort — 실패해도 결과는 그대로). 새 문제가 더해졌으면 알린다.
 *   재방문은 서버가 표시만 돌려준다(호출 F 0회).
 * - 총평·개선점·잘 쓴/약한 틀(판 기록의 틀 글자 사본)·문항별 판정(✓ 맞음 · △ 아깝다 · ✕ 다시)·내 말·고친 문장·이유.
 *   🔊는 탭할 때만(모범 영어·고친 문장 — 기존 발음 엔진 speak). 자동 재생 없음.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { speak } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import { TOEIC_FRAME_DRILL_VERDICT_KO, frameDrillSessionCounts, type ToeicFrameDrillVerdict } from "@/lib/toeic-frame-drill";
import {
  TOEIC_FRAME_DRILL_SUPPLY_REASON_KO,
  type ToeicFrameDrillJudgeResponse,
  type ToeicFrameDrillSessionView,
  type ToeicFrameDrillSupplyResponse,
} from "@/lib/toeic-frame-drill-contract";
import { formatKst } from "@/lib/kst";
import s from "./toeic-frame-drill.module.css";

const EN = "en-US";

type JudgeState = { kind: "idle" } | { kind: "loading" } | { kind: "error"; messageKo: string; retriable: boolean };

const VERDICT_ICON: Record<ToeicFrameDrillVerdict, string> = { correct: "✓", close: "△", wrong: "✕" };

export default function ToeicFrameDrillResult({
  initial,
  topicNamesKo,
  backHref,
  retryHref,
}: {
  initial: ToeicFrameDrillSessionView;
  topicNamesKo: string[];
  backHref: string;
  retryHref: string;
}) {
  const [session, setSession] = useState(initial);
  const [judge, setJudge] = useState<JudgeState>({ kind: "idle" });
  const [supplyNote, setSupplyNote] = useState<string | null>(null);
  const judgeStartedRef = useRef(false);
  const supplyStartedRef = useRef(false);

  async function requestJudge() {
    setJudge({ kind: "loading" });
    try {
      const res = await fetch(`/api/toeic/frame-drill/sessions/${encodeURIComponent(session.id)}/judge`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as ToeicFrameDrillJudgeResponse | null;
      if (data?.ok) {
        setSession(data.session);
        setJudge({ kind: "idle" });
        return;
      }
      if (data && !data.ok) {
        setJudge({ kind: "error", messageKo: data.messageKo, retriable: data.error !== "no_api_key" && data.error !== "not_found" });
        return;
      }
      setJudge({ kind: "error", messageKo: "판정을 받지 못했어요.", retriable: true });
    } catch {
      setJudge({ kind: "error", messageKo: "연결이 끊겨 판정을 받지 못했어요.", retriable: true });
    }
  }

  // 판정이 없으면 한 번 요청(StrictMode 두 번 실행에도 한 번 — ref)
  useEffect(() => {
    if (session.review !== null || judgeStartedRef.current) return;
    judgeStartedRef.current = true;
    void requestJudge();
  }, [session.review]); // 처음 한 번만(requestJudge는 렌더마다 새 함수 — 의존성에 넣지 않는다)

  // 판정이 있으면 보충을 한 번(best-effort)
  useEffect(() => {
    if (session.review === null || supplyStartedRef.current) return;
    supplyStartedRef.current = true;
    void (async () => {
      try {
        const res = await fetch(`/api/toeic/frame-drill/sessions/${encodeURIComponent(session.id)}/supply`, { method: "POST" });
        const data = (await res.json().catch(() => null)) as ToeicFrameDrillSupplyResponse | null;
        if (!data) return;
        if (data.ok) {
          if (data.status === "added" && data.added > 0) {
            setSupplyNote(data.fresh ? `🆕 오답률이 내려가 이 범위에 새 문제 ${data.added}개를 더했어요.` : `🆕 이 판 뒤에 새 문제 ${data.added}개를 더했어요.`);
          } else if (data.status === "skipped" && data.reason && data.reason !== "rate" && data.reason !== "sample") {
            setSupplyNote(TOEIC_FRAME_DRILL_SUPPLY_REASON_KO[data.reason] ?? null);
          }
          return;
        }
        if (data.error === "ai_failed" || data.error === "no_api_key") setSupplyNote(TOEIC_FRAME_DRILL_SUPPLY_REASON_KO[data.error] ?? null);
      } catch {
        /* best-effort */
      }
    })();
  }, [session.review, session.id]);

  // 판정이 막 저장됐으면 스트릭은 바뀌지 않지만(저장 때 이미 셌다) 헤드라인을 맞춘다 — 비용 0
  useEffect(() => {
    if (session.review === null) return;
    try {
      window.dispatchEvent(new Event(STREAK_REFRESH_EVENT));
    } catch {
      /* noop */
    }
  }, [session.review]);

  const counts = frameDrillSessionCounts(session.items);
  const frameText = new Map(session.items.map((it) => [it.frameKey, it.frame] as const));
  const review = session.review;

  return (
    <div className={s.wrap}>
      <section className={s.box} aria-label="한 판 요약">
        <p className={s.caption}>
          {topicNamesKo.length > 0 ? topicNamesKo.join(" · ") : "틀 말하기"} · {formatKst(session.startedAt)}
          {session.ended === "quit" ? " · 그만둠" : ""}
        </p>
        {review ? (
          <p className={s.scoreBig}>
            ✓ {counts.correct}
            <span className={s.scoreSub}>
              / {counts.total} · △ {counts.close} · ✕ {counts.wrong}
              {counts.unjudged > 0 ? ` · 인식 실패 ${counts.unjudged}` : ""}
            </span>
          </p>
        ) : (
          <p className={s.status}>
            {judge.kind === "error" ? judge.messageKo : `AI가 ${counts.answered}문항을 판정하는 중이에요…`}
          </p>
        )}
        {judge.kind === "error" && judge.retriable && (
          <div>
            <button type="button" className="u-btn u-btn-primary" onClick={() => void requestJudge()}>
              다시 판정 받기
            </button>
          </div>
        )}
        {supplyNote && <p className={s.notice}>{supplyNote}</p>}
      </section>

      {review && (
        <section className={s.box} aria-label="총평">
          <h2 className={s.boxTitle}>총평</h2>
          <p className={s.summary}>{review.summaryKo}</p>
          {review.improvements.length > 0 && (
            <>
              <p className={s.rowLabel}>개선점</p>
              <ul className={s.bullets}>
                {review.improvements.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          )}
          {review.strongFrameKeys.length > 0 && (
            <>
              <p className={s.rowLabel}>잘 쓴 틀</p>
              <ul className={s.bullets}>
                {review.strongFrameKeys.map((k) => (
                  <li key={k} lang="en">
                    {frameText.get(k) ?? k}
                  </li>
                ))}
              </ul>
            </>
          )}
          {review.weakFrameKeys.length > 0 && (
            <>
              <p className={s.rowLabel}>더 연습할 틀</p>
              <ul className={s.bullets}>
                {review.weakFrameKeys.map((k) => (
                  <li key={k} lang="en">
                    {frameText.get(k) ?? k}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className={s.box} aria-label="문항별 판정">
        <h2 className={s.boxTitle}>문항별</h2>
        <ol className={s.itemList}>
          {session.items.map((it, i) => {
            const v = it.verdict;
            const badgeCls = v === "correct" ? s.badgeCorrect : v === "wrong" ? s.badgeWrong : "";
            const badge = v ? `${VERDICT_ICON[v]} ${TOEIC_FRAME_DRILL_VERDICT_KO[v]}` : it.outcome === "transcribe_failed" ? "인식 실패" : "판정 전";
            return (
              <li key={i} className={s.item}>
                <div className={s.itemHead}>
                  <span className={`${s.badge} ${badgeCls}`}>{badge}</span>
                  <p className={s.itemKo}>
                    {i + 1}. {it.ko}
                  </p>
                </div>
                <p className={s.line}>
                  <span className={s.lineLabel}>모범</span>
                  <span className={s.lineText} lang="en">
                    {it.en}
                  </span>
                  <button type="button" className={s.speakBtn} aria-label="모범 영어 듣기" onClick={() => speak(it.en, EN)}>
                    🔊
                  </button>
                </p>
                <p className={s.line}>
                  <span className={s.lineLabel}>내 말</span>
                  <span className={s.lineText} lang="en">
                    {it.outcome === "transcribe_failed" ? "인식 실패" : it.transcript ?? "답이 들리지 않았어요"}
                  </span>
                </p>
                {it.fixedEn && it.verdict !== "correct" && it.fixedEn !== it.en && (
                  <p className={s.line}>
                    <span className={s.lineLabel}>고친 말</span>
                    <span className={`${s.lineText} ${s.fixed}`} lang="en">
                      {it.fixedEn}
                    </span>
                    <button type="button" className={s.speakBtn} aria-label="고친 문장 듣기" onClick={() => speak(it.fixedEn!, EN)}>
                      🔊
                    </button>
                  </p>
                )}
                {it.reasonKo && it.outcome !== "no_speech" && (
                  <p className={s.line}>
                    <span className={s.lineLabel}>이유</span>
                    <span className={s.lineText}>{it.reasonKo}</span>
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <div className={s.actions}>
        <Link href={`${retryHref}&t=${encodeURIComponent(session.id)}`} className="u-btn u-btn-primary">
          같은 범위로 한 판 더
        </Link>
        <Link href={backHref} className="u-btn u-btn-secondary">
          ← 틀 말하기
        </Link>
      </div>
    </div>
  );
}
