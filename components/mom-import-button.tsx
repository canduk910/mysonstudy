"use client";

/**
 * 엄마의 생활영어 "📥 파일로 가져오기" 버튼(설계 §6-1) — 클라이언트 컴포넌트.
 *
 * 사용자가 고른 `mom-english/v1` JSON을 그대로 `POST /api/mom/import`에 보낸다(토익 공략 가져오기 버튼과 같은 흐름).
 * 교재 유래 내용은 저장소 밖 파일이라, 프로덕션에 넣는 것은 이 버튼을 누르는 사람의 행동이다.
 * 결과는 "추가 n · 고침 n · 그대로 n", 400은 머리 문구 + 첫 이슈 위치. 성공하면 `router.refresh()`.
 */

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { MomImportResult } from "@/lib/mom-contract";

/** 가져오기 파일 크기 상한(클라이언트 사전 차단 — 라우트와 같은 5MB) */
const MOM_IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;

type MomImportResponse =
  | ({ ok: true } & MomImportResult)
  | { ok: false; error: string; messageKo: string; issues?: { path: string; message: string }[] };

export default function MomImportButton({ label = "📥 파일로 가져오기" }: { label?: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [noticeKo, setNoticeKo] = useState<string | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  async function importFile(file: File) {
    if (busyRef.current) return;
    setNoticeKo(null);
    setErrorKo(null);
    if (file.size > MOM_IMPORT_FILE_MAX_BYTES) {
      setErrorKo("파일이 너무 커요(5MB까지).");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await file.text());
    } catch {
      setErrorKo("JSON 파일이 아니에요.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/mom/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as MomImportResponse | null;
      if (data?.ok) {
        setNoticeKo(`추가 ${data.created.length} · 고침 ${data.updated.length} · 그대로 ${data.unchanged.length}`);
        router.refresh();
        return;
      }
      if (data && !data.ok) {
        const first = data.issues?.[0];
        setErrorKo(first ? `${data.messageKo} (${first.path || "파일"})` : data.messageKo);
        return;
      }
      setErrorKo("가져오지 못했어요. 잠시 뒤 다시 해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 가져오지 못했어요. 연결을 확인하고 다시 해 주세요.");
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
        data-testid="mom-import-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // 같은 파일을 다시 골라도 change가 나게
          if (f) void importFile(f);
        }}
      />
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="u-btn u-btn-secondary">
        {busy ? "가져오는 중…" : label}
      </button>
      {noticeKo && (
        <p role="status" className="u-box-accent t-question-ko text-ink">
          ✅ {noticeKo}
        </p>
      )}
      {errorKo && (
        <p role="alert" className="rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3 t-question-ko text-danger break-all">
          {errorKo}
        </p>
      )}
    </div>
  );
}
