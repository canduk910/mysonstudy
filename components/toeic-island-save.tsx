"use client";

/**
 * 🏝️ 내 섬에 담기 버튼 (docs/harness/toeic.md §21-3, SPEC §20-18) — 결과 화면(틀 말하기·모의고사 첨삭)에 끼우는 작은 덩어리.
 *
 * - `topics`가 없으면 한 번 탭으로 담는다(틀 말하기 — 소재·한국어 단서를 원본이 안다).
 * - `topics`가 있으면 탭하면 패널이 열린다: 소재 칩(추천 소재가 미리 켜짐 · "소재 없음") + 한 줄 한국어 메모 → [담기].
 * - 담기는 `POST /api/toeic/island` {origin, topicKey?, ko?} — 서버가 저장된 원본에서 글자를 만든다. 같은 원본은 문서 id가 같아
 *   두 번 눌러도 한 개(reused). 이미 담긴 원본(`savedInitially`)이면 처음부터 "담았어요 ✓".
 * - AI 호출 0. 소리 없음.
 */

import Link from "next/link";
import { useState } from "react";
import type { ToeicIslandOrigin, ToeicIslandPart } from "@/lib/toeic-island";
import { TOEIC_ISLAND_KO_MAX } from "@/lib/toeic-island";
import { toeicIslandHref, type ToeicIslandCreateResponse, type ToeicIslandTopicChip } from "@/lib/toeic-island-contract";
import s from "./toeic-island.module.css";

type State = { kind: "idle" } | { kind: "open" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; messageKo: string };

export default function ToeicIslandSave({
  origin,
  part,
  savedInitially,
  topics,
  suggestedTopicKey = null,
  label = "🏝️ 내 섬에 담기",
  testId,
}: {
  origin: ToeicIslandOrigin;
  part: ToeicIslandPart;
  savedInitially: boolean;
  /** 주면 소재 칩 패널을 연다(모의고사 결과). 없으면 한 번 탭(틀 말하기) */
  topics?: readonly ToeicIslandTopicChip[] | null;
  suggestedTopicKey?: string | null;
  label?: string;
  testId?: string;
}) {
  const [state, setState] = useState<State>(savedInitially ? { kind: "saved" } : { kind: "idle" });
  const [topicKey, setTopicKey] = useState<string | null>(suggestedTopicKey);
  const [memo, setMemo] = useState("");
  const withPanel = topics !== undefined && topics !== null;

  async function save() {
    setState({ kind: "saving" });
    const body: Record<string, unknown> = { origin };
    if (withPanel) {
      body.topicKey = topicKey;
      if (memo.trim() !== "") body.ko = memo;
    }
    try {
      const res = await fetch("/api/toeic/island", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as ToeicIslandCreateResponse | null;
      if (data?.ok) {
        setState({ kind: "saved" });
        return;
      }
      setState({ kind: "error", messageKo: data && !data.ok ? data.messageKo : "섬에 담지 못했어요." });
    } catch {
      setState({ kind: "error", messageKo: "연결이 끊겨 담지 못했어요." });
    }
  }

  if (state.kind === "saved") {
    return (
      <span className={s.save} data-testid={testId}>
        <span className={`${s.saveBtn} ${s.saved}`} role="status">
          🏝️ 섬에 담았어요 ✓
        </span>
        <Link href={toeicIslandHref(part)} className={s.saveLink}>
          섬 보기
        </Link>
      </span>
    );
  }

  const open = state.kind === "open" || (withPanel && (state.kind === "saving" || state.kind === "error"));

  return (
    <span className={s.save} data-testid={testId}>
      {!open && (
        <button
          type="button"
          className={s.saveBtn}
          disabled={state.kind === "saving"}
          onClick={() => (withPanel ? setState({ kind: "open" }) : void save())}
        >
          {state.kind === "saving" ? "담는 중…" : label}
        </button>
      )}
      {open && withPanel && (
        <span className={s.panel}>
          <span className={s.panelLabel}>어느 소재 섬에 담을까요?</span>
          <span className={s.chips} role="radiogroup" aria-label="소재">
            {(topics ?? []).map((t) => (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={topicKey === t.key}
                className={`${s.chip} ${topicKey === t.key ? s.chipOn : ""}`}
                onClick={() => setTopicKey(t.key)}
              >
                {t.nameKo}
                {t.key === suggestedTopicKey ? " · 추천" : ""}
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={topicKey === null}
              className={`${s.chip} ${topicKey === null ? s.chipOn : ""}`}
              onClick={() => setTopicKey(null)}
            >
              소재 없음
            </button>
          </span>
          <label className={s.panelLabel}>
            한국어 메모(떠올릴 단서 — 선택)
            <input
              className={s.input}
              type="text"
              value={memo}
              maxLength={TOEIC_ISLAND_KO_MAX}
              placeholder="예: 주말에 동네 공원 산책"
              onChange={(e) => setMemo(e.target.value)}
            />
          </label>
          <span className={s.panelRow}>
            <button type="button" className="u-btn u-btn-primary" disabled={state.kind === "saving"} onClick={() => void save()}>
              {state.kind === "saving" ? "담는 중…" : "🏝️ 담기"}
            </button>
            <button type="button" className="u-btn u-btn-secondary" disabled={state.kind === "saving"} onClick={() => setState({ kind: "idle" })}>
              취소
            </button>
          </span>
        </span>
      )}
      {state.kind === "error" && <span className={s.saveErr} role="alert">{state.messageKo}</span>}
    </span>
  );
}
