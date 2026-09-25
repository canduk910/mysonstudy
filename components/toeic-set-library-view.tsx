"use client";

/**
 * 표현집 목록 화면 (아빠의 영어 T1, docs/harness/toeic.md §7-6·§8) — 클라이언트 컴포넌트.
 *
 * 서버(`app/toeic/sets/page.tsx`)가 줄여 넘긴 목록을 받아 **고르고·지우고·순서만** 바꾼다(삭제·순서변경은 관리 모드에서만 —
 * 평소 드래그 핸들은 모바일 세로 스크롤과 충돌한다). 일본어 `ja-vocab-library-view` 골격을 따르되 토익 전용으로 새로 둔다(§10).
 *
 * **파일로 가져오기**(§7-6): 사용자가 고른 JSON을 그대로 `POST /api/toeic/sets/import`에 보낸다. 교재 전사본은 저장소 밖
 * 파일이라, 프로덕션에 넣는 것은 이 버튼을 누르는 사람의 행동이다. 결과 `{created, skipped}`를 사실대로 알린다(멱등 — 같은
 * 파일을 다시 넣으면 전부 건너뛴다).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useReorder } from "@/components/use-reorder";
import { formatKstDate } from "@/lib/kst";
import { toeicIssueLineKo, type ToeicImportResponse, type ToeicSetDeleteResponse } from "@/lib/toeic-set-contract";

/** 서버가 목록 줄에 필요한 것만 줄여 넘긴다(entries 전문 X). */
export interface ToeicSetLibraryItem {
  id: string;
  titleKo: string;
  dayNo: number | null;
  topicKo: string | null;
  source: "photo" | "import";
  exprCount: number;
  quizCount: number;
  /** 발화 포인트가 있는 표현 수 */
  pointsCount: number;
  createdAt: string;
  sortIndex: number | null;
}

/** 가져오기 파일 크기 상한(클라이언트 사전 차단) — 10세트 파일이 ~0.3MB라 넉넉한 방어선 */
const IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;

export default function ToeicSetLibraryView({ items, skippedCount = 0 }: { items: ToeicSetLibraryItem[]; skippedCount?: number }) {
  const router = useRouter();
  const [manageMode, setManageMode] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [noticeKo, setNoticeKo] = useState<string | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);

  const visibleItems = items.filter((item) => !deletedIds.includes(item.id));

  const reorder = useReorder({
    ids: visibleItems.map((item) => item.id),
    enabled: manageMode,
    onPersist: async (orderedIds) => {
      const res = await fetch("/api/toeic/sets/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      });
      if (!res.ok) throw new Error("reorder failed");
      setErrorKo(null);
      router.refresh();
    },
    onError: () => setErrorKo("순서를 저장하지 못했어요. 잠시 후 다시 시도해 주세요."),
  });

  const itemById = new Map(visibleItems.map((item) => [item.id, item]));
  const orderedItems = reorder.order.map((id) => itemById.get(id)).filter((item): item is ToeicSetLibraryItem => item != null);

  function clearStatus() {
    setNoticeKo(null);
    setErrorKo(null);
    setIssues([]);
  }

  function toggleManage() {
    setManageMode((on) => !on);
    setConfirmId(null);
    clearStatus();
  }

  async function runDelete(item: ToeicSetLibraryItem) {
    setDeletingId(item.id);
    clearStatus();
    try {
      const res = await fetch(`/api/toeic/sets/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as ToeicSetDeleteResponse | null;
      if (res.ok && data?.ok) {
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        setNoticeKo("표현집 하나를 지웠어요.");
        router.refresh();
        return;
      }
      if (res.status === 404) {
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        setNoticeKo("이미 지워져 있었어요.");
        router.refresh();
        return;
      }
      setErrorKo(data && !data.ok ? data.messageKo : "지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 지우지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setDeletingId(null);
    }
  }

  async function importFile(file: File) {
    if (importingRef.current) return;
    clearStatus();
    if (file.size > IMPORT_FILE_MAX_BYTES) {
      setErrorKo("파일이 너무 커요. 표현집 가져오기용 JSON 파일을 골라 주세요.");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await file.text());
    } catch {
      setErrorKo("JSON 파일이 아니에요. 표현집 가져오기용 파일(.json)을 골라 주세요.");
      return;
    }
    importingRef.current = true;
    setImporting(true);
    try {
      const res = await fetch("/api/toeic/sets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as ToeicImportResponse | null;
      if (data?.ok) {
        const parts: string[] = [];
        if (data.created > 0) parts.push(`${data.created}개를 새로 넣었어요`);
        if (data.skipped > 0) parts.push(`${data.skipped}개는 이미 있어 건너뛰었어요`);
        setNoticeKo(parts.length > 0 ? `${parts.join(", ")}.` : "넣을 표현집이 없었어요.");
        router.refresh();
        return;
      }
      setErrorKo(data && !data.ok ? data.messageKo : "가져오지 못했어요. 잠시 후 다시 시도해 주세요.");
      // 위치는 한국어로("세트 3 › 표현 6 › 뜻") — 점 표기 경로·영어 필드명을 그대로 보이지 않는다
      setIssues(data && !data.ok ? (data.issues ?? []).slice(0, 5).map((i) => toeicIssueLineKo(i)) : []);
    } catch {
      setErrorKo("네트워크 문제로 가져오지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }

  return (
    <>
      {skippedCount > 0 && (
        <p role="status" className="u-box t-caption mb-4 border border-line-strong">
          ⚠️ 형식이 맞지 않아 열지 못한 표현집이 {skippedCount}개 있어요. 아래 목록에는 빠져 있어요.
        </p>
      )}

      {/* 숨은 파일 입력 — 가져오기 JSON만 */}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        data-testid="toeic-import-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // 같은 파일을 다시 골라도 change가 나게
          if (f) void importFile(f);
        }}
      />

      <div className="flex flex-col gap-2 sm:flex-row">
        <Link href="/toeic/sets/new" className="u-btn u-btn-primary flex-1">
          <span aria-hidden>📷</span> 사진으로 추가
        </Link>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          className="u-btn u-btn-secondary flex-1"
        >
          <span aria-hidden>📂</span> {importing ? "가져오는 중…" : "파일로 가져오기"}
        </button>
      </div>

      {noticeKo && (
        <p role="status" className="u-box-accent t-question-ko mt-4 text-ink">
          ✅ {noticeKo}
        </p>
      )}
      {errorKo && (
        <div role="alert" className="mt-4 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3">
          <p className="t-question-ko text-danger">{errorKo}</p>
          {issues.length > 0 && (
            <ul className="t-caption mt-2 list-disc pl-5">
              {issues.map((m, i) => (
                <li key={i} className="break-all">
                  {m}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section aria-label="표현집 목록" className="mt-8">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="t-section-title">내 표현집</h2>
          {visibleItems.length > 0 && (
            <button
              type="button"
              onClick={toggleManage}
              aria-pressed={manageMode}
              className={`u-btn flex-none px-3 py-1.5 text-meta-chip ${manageMode ? "u-btn-primary" : "u-btn-secondary"}`}
            >
              {manageMode ? "완료" : "관리"}
            </button>
          )}
        </div>

        {manageMode && (
          <p className="t-caption mb-3 rounded-[var(--radius-box)] border border-dashed border-line px-4 py-3">
            <span className="font-medium text-ink">≡ 손잡이를 끌어</span> 순서를 바꾸거나{" "}
            <span className="font-medium text-ink">↑ ↓ 버튼</span>으로 옮겨요. 지울 표현집은{" "}
            <span className="font-medium text-ink">🗑 지우기</span> — 시험 기록도 함께 지워지고{" "}
            <span className="font-medium text-ink">되돌릴 수 없어요.</span>
          </p>
        )}

        {visibleItems.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            아직 표현집이 없어요. 표현 암기장을 사진으로 찍거나, 가져오기 파일을 넣어 볼까요?
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {orderedItems.map((item) =>
              confirmId === item.id ? (
                <li key={item.id}>
                  <div role="group" aria-label="삭제 확인" className="rounded-[var(--radius-box)] border border-danger bg-danger-soft p-4">
                    <p className="t-list-title">{item.titleKo}</p>
                    <p className="t-caption mt-1">
                      이 표현집과 시험 기록을 지울까요? <span className="font-medium text-danger">되돌릴 수 없어요.</span>
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void runDelete(item)}
                        disabled={deletingId === item.id}
                        className="u-btn flex-1 bg-danger text-bg"
                      >
                        {deletingId === item.id ? "지우는 중…" : "지우기"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        disabled={deletingId === item.id}
                        className="u-btn u-btn-secondary flex-1"
                      >
                        취소
                      </button>
                    </div>
                  </div>
                </li>
              ) : (
                <li
                  key={item.id}
                  {...reorder.getRowProps(item.id)}
                  className={`flex min-w-0 items-stretch gap-2 rounded-[var(--radius-box)] ${
                    reorder.draggingId === item.id ? "opacity-90 ring-2 ring-accent" : ""
                  }`}
                >
                  {manageMode && (
                    <div
                      {...reorder.getHandleProps(item.id)}
                      className="t-list-title flex w-8 flex-none select-none items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink-3 hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent print:hidden"
                    >
                      <span aria-hidden>≡</span>
                    </div>
                  )}
                  <Link href={`/toeic/sets/${item.id}`} className="u-item min-w-0 flex-1">
                    <span className="u-item-thumb" aria-hidden>
                      📒
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="t-list-title block truncate">{item.titleKo}</span>
                      <span className="t-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="u-chip">표현 {item.exprCount}개</span>
                        {item.quizCount > 0 && <span className="u-chip">QUIZ {item.quizCount}</span>}
                        <span className={`u-chip ${item.pointsCount === item.exprCount ? "u-chip-accent" : ""}`}>
                          {item.pointsCount === item.exprCount ? "✓ 발화 포인트" : `발화 포인트 ${item.pointsCount}/${item.exprCount}`}
                        </span>
                        {item.source === "import" && <span className="u-chip">📂 가져옴</span>}
                        <span className="t-caption">{formatKstDate(item.createdAt)}</span>
                      </span>
                    </span>
                  </Link>

                  {manageMode && (
                    <div className="flex w-9 flex-none flex-col gap-1 print:hidden">
                      <button
                        type="button"
                        onClick={() => reorder.moveUp(item.id)}
                        disabled={!reorder.canMoveUp(item.id) || reorder.saving}
                        aria-label={`${item.titleKo} 위로`}
                        className="t-list-title flex flex-1 items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink disabled:opacity-30 hover:enabled:border-line-strong"
                      >
                        <span aria-hidden>↑</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => reorder.moveDown(item.id)}
                        disabled={!reorder.canMoveDown(item.id) || reorder.saving}
                        aria-label={`${item.titleKo} 아래로`}
                        className="t-list-title flex flex-1 items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink disabled:opacity-30 hover:enabled:border-line-strong"
                      >
                        <span aria-hidden>↓</span>
                      </button>
                    </div>
                  )}

                  {manageMode && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmId(item.id);
                        clearStatus();
                      }}
                      aria-label="이 표현집 지우기"
                      className="t-meta-chip flex w-14 flex-none flex-col items-center justify-center gap-0.5 rounded-[var(--radius-box)] border border-danger bg-bg text-danger transition hover:bg-danger-soft print:hidden"
                    >
                      <span aria-hidden>🗑</span>
                      지우기
                    </button>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </>
  );
}
