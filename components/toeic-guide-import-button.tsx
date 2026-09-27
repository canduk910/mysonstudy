"use client";

/**
 * 유형별 공략 "📂 파일로 가져오기" 버튼 (docs/harness/toeic.md §12-2·§12-8) — 클라이언트 컴포넌트.
 *
 * 폴더 목록(`/toeic/guides`)과 폴더의 빈 상태(📖·🧩 탭)가 같은 버튼을 쓴다. 사용자가 고른 JSON을 그대로
 * `POST /api/toeic/guides/import`에 보낸다(표현집 `toeic-set-library-view`의 `file.text()` → fetch 관용구). 교재 전사·틀은 저장소 밖
 * 파일이라, 프로덕션에 넣는 것은 이 버튼을 누르는 사람의 행동이다.
 *
 * 결과는 "추가 n · 고침 n · 그대로 n"(틀 모음도 한 칸으로 센다), 409는 충돌 키와 이유, 400은 위치(경로 + 규칙 — 값 없음)로 알린다.
 * 성공하면 `router.refresh()`로 서버 컴포넌트를 다시 읽는다(응답에 목록을 싣지 않는다 — app-patterns §1).
 */

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { ToeicGuideConflict, ToeicGuideConflictReason, ToeicGuideImportResponse } from "@/lib/toeic-guide-contract";
import { toeicIssueLineKo } from "@/lib/toeic-set-contract";

/** 가져오기 파일 크기 상한(클라이언트 사전 차단) — 유형 4개 + 틀 모음 파일이 약 0.6MB라 넉넉한 방어선 */
const GUIDE_IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;

const REASON_KO: Record<ToeicGuideConflictReason, string> = {
  preset_key_is_book: "표현집이 같은 키를 씀",
  part_mismatch: "같은 키가 다른 유형에 있음",
  part_taken: "다른 키가 그 유형을 차지함",
};

function conflictLine(c: ToeicGuideConflict): string {
  const where = c.part === "templates" ? "틀 모음" : c.part.replace("_", "–").toUpperCase();
  return `${c.presetKey} (${where}) — ${REASON_KO[c.reason] ?? c.reason}`;
}

export default function ToeicGuideImportButton({ className = "", label = "파일로 가져오기" }: { className?: string; label?: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [noticeKo, setNoticeKo] = useState<string | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);

  function clearStatus() {
    setNoticeKo(null);
    setErrorKo(null);
    setDetails([]);
  }

  async function importFile(file: File) {
    if (busyRef.current) return;
    clearStatus();
    if (file.size > GUIDE_IMPORT_FILE_MAX_BYTES) {
      setErrorKo("파일이 너무 커요. 공략 가져오기용 JSON 파일을 골라 주세요.");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await file.text());
    } catch {
      setErrorKo("JSON 파일이 아니에요. 공략 가져오기용 파일(.json)을 골라 주세요.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/toeic/guides/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as ToeicGuideImportResponse | null;
      if (data?.ok) {
        const n = (a: string[]) => a.length;
        setNoticeKo(`추가 ${n(data.created)} · 고침 ${n(data.updated)} · 그대로 ${n(data.unchanged)}`);
        if (n(data.created) + n(data.updated) > 0) router.refresh();
        return;
      }
      if (data && !data.ok) {
        setErrorKo(data.messageKo);
        // 위치 줄 — 문구가 머리 문구와 같은 것(형식 오류)은 겹쳐 보이지 않게 뺀다
        if (data.error === "invalid_input") setDetails(data.issues.filter((i) => i.message !== data.messageKo).slice(0, 5).map((i) => toeicIssueLineKo(i)));
        else if (data.error === "guide_conflict") setDetails(data.conflicts.slice(0, 5).map(conflictLine));
        return;
      }
      setErrorKo("가져오지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 가져오지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className={`flex min-w-0 flex-col gap-3 ${className}`}>
      {/* 숨은 파일 입력 — 가져오기 JSON만 */}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        data-testid="toeic-guide-import-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // 같은 파일을 다시 골라도 change가 나게
          if (f) void importFile(f);
        }}
      />
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="u-btn u-btn-secondary">
        <span aria-hidden>📂</span> {busy ? "가져오는 중…" : label}
      </button>
      {noticeKo && (
        <p role="status" className="u-box-accent t-question-ko text-ink">
          ✅ {noticeKo}
        </p>
      )}
      {errorKo && (
        <div role="alert" className="rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3">
          <p className="t-question-ko text-danger">{errorKo}</p>
          {details.length > 0 && (
            <ul className="t-caption mt-2 list-disc pl-5">
              {details.map((m, i) => (
                <li key={i} className="break-all">
                  {m}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
