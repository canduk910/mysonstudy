"use client";

/**
 * 대화 복습 상세 (아빠의 일본어 J3·J4·J5, §8) — 클라이언트. **전사 + 해설을 함께** 보여준다.
 * 말풍선(JaDialogTranscript) → 총평·잘한 점·고칠 점·어휘(담기 J5)·연습(JaDialogCoachingView). 제목 인라인 수정, "해설 다시 만들기".
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { prefetchSpeech } from "@/lib/speech";
import JaDialogTranscript from "@/components/ja-dialog-transcript";
import JaDialogCoachingView from "@/components/ja-dialog-coaching-view";
import { coachingJaTexts } from "@/lib/ja-coaching-script";
import {
  JA_DIALOG_TITLE_MAX,
  type JaDialogCoaching,
  type JaDialogCoachResponse,
  type JaDialogRenameResponse,
  type JaDialogTurn,
} from "@/lib/japanese-dialog-contract";
import s from "./ja-dialog-detail-view.module.css";

export default function JaDialogDetailView({
  id,
  titleKo,
  focusKo,
  turns,
  coaching,
  partial,
}: {
  id: string;
  titleKo: string;
  focusKo: string | null;
  turns: JaDialogTurn[];
  coaching: JaDialogCoaching | null;
  partial: boolean;
}) {
  const router = useRouter();
  // 프리페치(§16·§18-5): 말풍선 문장 + 해설의 일본어 문장을 **한 배열로 한 번에** 미리 캐시 → 🔊 첫 재생 지연 제거.
  // 따로 부르면 prefetchSpeech가 직전 배치를 끊는데 효과는 자식→부모 순이라 해설 쪽이 항상 끊긴다 — 그래서 해설 뷰는
  // prefetch={false}. 의존성은 문자열 키: router.refresh()로 참조만 바뀌면 다시 시작하지 않는다(중단된 합성 요금 낭비 방지).
  // 한국어 해설은 미리 받지 않는다(이어 듣기 look-ahead가 맡는다).
  const prefetchKey = useMemo(
    () => [...turns.map((t) => t.ja), ...(coaching ? coachingJaTexts(coaching) : [])].join("\u0001"),
    [turns, coaching],
  );
  useEffect(() => prefetchSpeech(prefetchKey.split("\u0001"), "ja-JP"), [prefetchKey]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(titleKo);
  const [saving, setSaving] = useState(false);
  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [coachPhase, setCoachPhase] = useState<"idle" | "loading" | "error">("idle");
  const [coachMsg, setCoachMsg] = useState<string | null>(null);

  async function saveTitle() {
    const next = draft.trim();
    if (next === "" || next === titleKo) {
      setEditing(false);
      setDraft(titleKo);
      return;
    }
    setSaving(true);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/japanese/dialog/${id}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titleKo: next }),
      });
      const data = (await res.json()) as JaDialogRenameResponse;
      if (data.ok) {
        setEditing(false);
        router.refresh();
      } else setErrorKo(data.messageKo);
    } catch {
      setErrorKo("이름을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  }

  async function regenerate() {
    if (coachPhase === "loading") return;
    setCoachPhase("loading");
    setCoachMsg(null);
    try {
      const res = await fetch(`/api/japanese/dialog/coach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = (await res.json()) as JaDialogCoachResponse;
      if (data.ok) {
        setCoachPhase("idle");
        router.refresh(); // 서버가 저장한 새 coaching으로 다시 그린다
      } else {
        setCoachPhase("error");
        setCoachMsg(data.error === "no_api_key" ? "API 키가 준비되면 해설을 만들 수 있어요." : data.messageKo);
      }
    } catch {
      setCoachPhase("error");
      setCoachMsg("해설을 만들지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  }

  return (
    <div className={s.wrap}>
      {/* 제목 + 인라인 수정 */}
      <div className={s.titleRow}>
        {editing ? (
          <div className={s.titleEdit}>
            <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={JA_DIALOG_TITLE_MAX} aria-label="대화 이름" className={s.titleInput} autoFocus />
            <div className={s.titleBtns}>
              <button type="button" className="u-btn u-btn-primary" onClick={saveTitle} disabled={saving}>
                {saving ? "저장 중…" : "저장"}
              </button>
              <button type="button" className="u-btn u-btn-secondary" onClick={() => { setEditing(false); setDraft(titleKo); setErrorKo(null); }} disabled={saving}>
                취소
              </button>
            </div>
          </div>
        ) : (
          <div className={s.titleView}>
            <h1 className="t-book-title">{titleKo}</h1>
            <button type="button" className="u-btn u-btn-secondary" onClick={() => setEditing(true)} aria-label="대화 이름 수정">
              <span aria-hidden>✏️</span> 이름
            </button>
          </div>
        )}
      </div>
      {errorKo && <p role="alert" className={s.err}>{errorKo}</p>}
      {focusKo && <p className="t-caption">주제: {focusKo}</p>}
      {partial && <p role="status" className={s.warn}>⚠️ 일부만 읽힌 대화예요.</p>}

      {/* 전사(본체) */}
      <section>
        <h2 className="t-section-title">대화</h2>
        <JaDialogTranscript turns={turns} />
      </section>

      {/* 해설 */}
      <section className={s.coachSection}>
        <div className={s.coachHead}>
          <h2 className="t-section-title">해설</h2>
          <button type="button" className="u-btn u-btn-secondary" onClick={regenerate} disabled={coachPhase === "loading"}>
            {coachPhase === "loading" ? "만드는 중…" : coaching ? "🔁 다시 만들기" : "✨ 해설 만들기"}
          </button>
        </div>
        {coachMsg && <p className={`t-caption ${coachPhase === "error" ? s.err : ""}`}>{coachMsg}</p>}
        {coaching ? (
          <JaDialogCoachingView coaching={coaching} dialogId={id} prefetch={false} />
        ) : (
          <p className={s.noCoach}>아직 해설이 없어요. 위 "해설 만들기"로 잘한 점·고칠 점·어휘·연습을 채워 보세요.</p>
        )}
      </section>
    </div>
  );
}
