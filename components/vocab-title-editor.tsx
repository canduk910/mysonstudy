"use client";

/**
 * components/vocab-title-editor.tsx — 단어장 상세 헤더의 이름(titleKo) 인라인 편집 (클라이언트)
 *
 * 상세 페이지(`app/english/vocab/[id]/page.tsx`, 서버 컴포넌트)의 정적 `<h1>{titleKo}</h1>`를
 * 대체한다. 기본은 제목 텍스트 + ✏️ 버튼이고, 누르면 인라인 입력창(현재 이름 채워짐) + 저장/취소로
 * 바뀐다. 저장하면 `POST /api/english/vocab/[id]/rename` → 성공 시 `router.refresh()`로 서버를
 * 다시 그린다 — 목록·헤더·카드 chrome 제목까지 한 번에 갱신된다(entries·정의는 서버가 그대로 준다).
 *
 * hydration mismatch 방지: 초기 렌더는 항상 **보기 모드**(SSR과 첫 클라이언트 렌더가 같다).
 * 접근성: ✏️/저장/취소에 aria-label, 입력창에서 Enter=저장·Esc=취소.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { VOCAB_LIMITS } from "@/lib/vocab-create-contract";
import type { VocabRenameResponse } from "@/lib/vocab-rename-contract";

interface VocabTitleEditorProps {
  id: string;
  titleKo: string;
}

type Phase = "idle" | "saving" | "error";

export default function VocabTitleEditor({ id, titleKo }: VocabTitleEditorProps) {
  const router = useRouter();
  // 화면에 뜨는 이름 — prop을 거울처럼 따라간다(refresh 뒤 서버 값으로 갱신). 저장 성공 시 낙관적으로 먼저 바꾼다.
  const [displayTitle, setDisplayTitle] = useState(titleKo);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(titleKo);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // refresh로 서버가 새 titleKo를 내려주면 그대로 반영한다(다른 탭·경합에도 표시가 어긋나지 않는다).
  useEffect(() => {
    setDisplayTitle(titleKo);
  }, [titleKo]);

  // 편집 모드로 들어가면 입력창에 포커스 + 전체 선택(바로 고쳐 쓰기 좋게).
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEditing() {
    setDraft(displayTitle);
    setErrorMsg(null);
    setPhase("idle");
    setEditing(true);
  }

  function cancel() {
    if (phase === "saving") return; // 저장 중엔 취소로 어긋나지 않게
    setEditing(false);
    setErrorMsg(null);
    setPhase("idle");
  }

  async function save() {
    const next = draft.trim();
    if (next === "") {
      setErrorMsg("단어장 이름을 입력해 주세요.");
      setPhase("error");
      return;
    }
    // 바뀐 게 없으면 호출 없이 닫는다.
    if (next === displayTitle) {
      setEditing(false);
      setPhase("idle");
      return;
    }
    setPhase("saving");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/english/vocab/${id}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titleKo: next }),
      });
      const data = (await res.json()) as VocabRenameResponse;
      if (data.ok) {
        setDisplayTitle(data.titleKo); // 낙관적 반영 — refresh가 완료되면 서버 값으로 다시 확정된다
        setEditing(false);
        setPhase("idle");
        router.refresh(); // 목록·헤더·카드 chrome 제목까지 서버 재조회로 갱신
      } else {
        setErrorMsg(data.messageKo);
        setPhase("error");
      }
    } catch {
      setErrorMsg("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
      setPhase("error");
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  // ── 보기 모드 ──
  if (!editing) {
    return (
      <div className="mt-4 flex items-start justify-between gap-2">
        <h1 className="t-book-title">{displayTitle}</h1>
        <button
          type="button"
          className="u-navbtn flex-none"
          onClick={startEditing}
          aria-label="단어장 이름 바꾸기"
        >
          <span aria-hidden="true">✏️</span>
          <span>이름 바꾸기</span>
        </button>
      </div>
    );
  }

  // ── 편집 모드 ──
  const saving = phase === "saving";
  return (
    <div className="mt-4">
      <label className="u-label" htmlFor="vocab-title-input">
        단어장 이름
      </label>
      <div className="flex items-center gap-2">
        <input
          id="vocab-title-input"
          ref={inputRef}
          type="text"
          className="u-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={VOCAB_LIMITS.titleKo}
          disabled={saving}
          aria-label="단어장 이름"
          aria-invalid={phase === "error"}
          placeholder="단어장 이름"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="u-btn u-btn-primary"
          onClick={() => void save()}
          disabled={saving || draft.trim() === ""}
          aria-label="이름 저장"
        >
          {saving ? "저장 중…" : "저장"}
        </button>
        <button
          type="button"
          className="u-btn u-btn-secondary"
          onClick={cancel}
          disabled={saving}
          aria-label="이름 바꾸기 취소"
        >
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
