"use client";

/**
 * components/talk-title-editor.tsx — 자유대화 보기 헤더의 이름(titleKo) 인라인 편집 (SPEC §21-2 6 "제목 편집")
 *
 * 단어장 이름 편집(components/vocab-title-editor.tsx)과 같은 관용구: 초기 렌더는 항상 보기 모드(hydration 안전), ✏️ → 입력창
 * (Enter 저장·Esc 취소) → `POST /api/english/talk/[id]/rename` → 성공 시 router.refresh. 상한은 계약의 TALK_TITLE_MAX_CHARS.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TALK_TITLE_MAX_CHARS, type TalkRenameResponse } from "@/lib/talk-contract";

type Phase = "idle" | "saving" | "error";

export default function TalkTitleEditor({ id, titleKo }: { id: string; titleKo: string }) {
  const router = useRouter();
  const [displayTitle, setDisplayTitle] = useState(titleKo);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(titleKo);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDisplayTitle(titleKo);
  }, [titleKo]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function cancel() {
    if (phase === "saving") return;
    setEditing(false);
    setErrorMsg(null);
    setPhase("idle");
  }

  async function save() {
    const next = draft.trim();
    if (next === "") {
      setErrorMsg("대화 이름을 입력해 주세요.");
      setPhase("error");
      return;
    }
    if (next === displayTitle) {
      setEditing(false);
      setPhase("idle");
      return;
    }
    setPhase("saving");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/english/talk/${encodeURIComponent(id)}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titleKo: next }),
      });
      const data = (await res.json().catch(() => null)) as TalkRenameResponse | null;
      if (data?.ok) {
        setDisplayTitle(data.titleKo);
        setEditing(false);
        setPhase("idle");
        router.refresh();
      } else {
        setErrorMsg(data && !data.ok ? data.messageKo : "이름을 저장하지 못했어요.");
        setPhase("error");
      }
    } catch {
      setErrorMsg("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
      setPhase("error");
    }
  }

  if (!editing) {
    return (
      <div className="mt-2 flex items-start justify-between gap-2">
        <h1 className="t-book-title min-w-0" style={{ overflowWrap: "anywhere" }}>
          {displayTitle}
        </h1>
        <button
          type="button"
          className="u-navbtn flex-none"
          onClick={() => {
            setDraft(displayTitle);
            setErrorMsg(null);
            setPhase("idle");
            setEditing(true);
          }}
          aria-label="대화 이름 바꾸기"
        >
          <span aria-hidden="true">✏️</span>
          <span>이름 바꾸기</span>
        </button>
      </div>
    );
  }

  const saving = phase === "saving";
  return (
    <div className="mt-2">
      <label className="u-label" htmlFor="talk-title-input">
        대화 이름
      </label>
      <input
        id="talk-title-input"
        ref={inputRef}
        type="text"
        className="u-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        maxLength={TALK_TITLE_MAX_CHARS}
        disabled={saving}
        aria-invalid={phase === "error"}
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className="u-btn u-btn-primary" onClick={() => void save()} disabled={saving || draft.trim() === ""}>
          {saving ? "저장 중…" : "저장"}
        </button>
        <button type="button" className="u-btn u-btn-secondary" onClick={cancel} disabled={saving}>
          취소
        </button>
      </div>
      {errorMsg && (
        <p className="t-caption mt-2" role="alert" style={{ color: "var(--danger)" }}>
          {errorMsg}
        </p>
      )}
    </div>
  );
}
