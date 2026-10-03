"use client";

/**
 * 소재별 틀 말하기 "📂 문제 파일 가져오기" 버튼 (docs/harness/toeic.md §20-3, SPEC §20-17) — 클라이언트 컴포넌트.
 *
 * 사용자가 고른 `toeic-frame-drill/v1` JSON을 그대로 `POST /api/toeic/frame-drill/import`에 보낸다(공략 가져오기 버튼 관용구 —
 * `file.text()` → fetch). 교재 유래 은행은 저장소 밖 파일이라, 프로덕션에 넣는 것은 이 버튼을 누르는 사람의 행동이다.
 * 결과는 "추가 n · 고침 n · 지움 n · 그대로"(통계는 이어진다), 400은 위치(경로 + 규칙 — 값 없음). 바뀌었으면 `router.refresh()`.
 */

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { ToeicFrameDrillImportResponse } from "@/lib/toeic-frame-drill-contract";
import { toeicIssueLineKo } from "@/lib/toeic-set-contract";

/** 클라이언트 사전 차단 — 은행 문서 상한(0.9MB)보다 넉넉한 방어선 */
const FRAME_IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;

export default function ToeicFrameDrillImportButton({ label = "문제 파일 가져오기" }: { label?: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [noticeKo, setNoticeKo] = useState<string | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);

  async function importFile(file: File) {
    if (busyRef.current) return;
    setNoticeKo(null);
    setErrorKo(null);
    setDetails([]);
    if (file.size > FRAME_IMPORT_FILE_MAX_BYTES) {
      setErrorKo("파일이 너무 커요. 틀 말하기 문제 파일(.json)을 골라 주세요.");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await file.text());
    } catch {
      setErrorKo("JSON 파일이 아니에요. 틀 말하기 문제 파일(.json)을 골라 주세요.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/toeic/frame-drill/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as ToeicFrameDrillImportResponse | null;
      if (data?.ok) {
        setNoticeKo(
          data.unchanged
            ? `그대로예요 — 소재 ${data.topics} · 틀 ${data.frames} · 문항 ${data.items}`
            : `추가 ${data.created} · 고침 ${data.updated} · 지움 ${data.removed}${data.aiKept + data.aiDropped > 0 ? ` · 새 문제 유지 ${data.aiKept}` : ""} — 문항 ${data.items}개(오답 통계는 이어져요)`,
        );
        if (!data.unchanged) router.refresh();
        return;
      }
      if (data && !data.ok) {
        setErrorKo(data.messageKo);
        if (data.error === "invalid_input") setDetails(data.issues.filter((i) => i.message !== data.messageKo).slice(0, 5).map((i) => toeicIssueLineKo(i)));
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
    <div className="flex min-w-0 flex-col gap-3">
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        data-testid="toeic-frame-drill-import-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
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
