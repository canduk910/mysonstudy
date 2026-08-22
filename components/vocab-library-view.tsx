"use client";

/**
 * 단어장 목록 화면 (단어장 정복 V1) — 클라이언트 컴포넌트.
 *
 * 서버(`app/english/vocab/page.tsx`)가 읽어 줄인 목록을 받아 **고르고 지우는 일만** 한다.
 * 클라이언트인 이유: 관리 모드·인라인 삭제 확인 — 서버 왕복 없이 즉시 반응한다.
 *
 * 삭제는 `window.confirm` 대신 그 항목 자리에서 인라인 확인을 거친다(수학 서재와 같은 규약).
 * 관리 모드를 켜야 삭제 버튼이 나타난다(아이가 눌러 지우는 사고 방지).
 *
 * 디자인: 새 CSS 없음 — `app/globals.css`의 토큰(`u-*`·`t-*`)만. 위계는 글자 크기로(DESIGN §4).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** 서버가 목록 줄에 필요한 것만 줄여 넘긴다 (레코드 전문 X — entries 배열이 무겁다) */
export interface VocabLibraryItem {
  id: string;
  titleKo: string;
  dayLabel: string | null;
  wordCount: number;
  photoCount: number;
  createdAt: string; // ISO 8601
}

/** 만든 날짜 표시 — 타임존 계산 없이 ISO 날짜부만 (SSR/클라이언트 동일 출력) */
function formatDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, ".");
}

export default function VocabLibraryView({
  items,
  skippedCount = 0,
}: {
  items: VocabLibraryItem[];
  /** 서버가 읽지 못해 건너뛴 레코드 수 — 조용히 사라지게 두지 않는다(수학 서재와 같은 안내) */
  skippedCount?: number;
}) {
  const router = useRouter();
  const [manageMode, setManageMode] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [noticeKo, setNoticeKo] = useState<string | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  const visibleItems = items.filter((item) => !deletedIds.includes(item.id));

  function toggleManage() {
    setManageMode((on) => !on);
    setConfirmId(null);
    setErrorKo(null);
    setNoticeKo(null);
  }

  async function runDelete(item: VocabLibraryItem) {
    setDeletingId(item.id);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/english/vocab/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; messageKo?: string }
        | null;

      if (res.ok && data?.ok) {
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        setNoticeKo("단어장 하나를 지웠어요.");
        router.refresh();
        return;
      }

      if (res.status === 404) {
        // 이미 지워진 것(다른 기기·중복 클릭) — 목록에서 빼는 것이 맞다
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        setNoticeKo("이미 지워져 있었어요.");
        router.refresh();
        return;
      }

      setErrorKo(data?.messageKo ?? "지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 지우지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      {skippedCount > 0 && (
        <p role="status" className="u-box t-caption mb-4 border border-line-strong">
          ⚠️ 예전 형식이라 열지 못한 단어장이 {skippedCount}개 있어요. 아래 목록에는 빠져 있어요.
        </p>
      )}

      {/* 새로 만들기 — 이 화면의 주요 행동 */}
      <Link href="/english/vocab/new" className="u-btn u-btn-primary w-full">
        <span aria-hidden>📷</span> 사진으로 단어장 만들기
      </Link>

      <section aria-label="단어장 목록" className="mt-8">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="t-section-title">내 단어장</h2>
          {visibleItems.length > 0 && (
            <button
              type="button"
              onClick={toggleManage}
              aria-pressed={manageMode}
              className={`u-btn flex-none px-3 py-1.5 text-meta-chip ${
                manageMode ? "u-btn-primary" : "u-btn-secondary"
              }`}
            >
              {manageMode ? "완료" : "관리"}
            </button>
          )}
        </div>

        {manageMode && (
          <p className="t-caption mb-3 rounded-[var(--radius-box)] border border-dashed border-line px-4 py-3">
            지울 단어장의 <span className="font-medium text-ink">🗑 지우기</span> 버튼을 누르세요.{" "}
            <span className="font-medium text-ink">되돌릴 수 없어요.</span>
          </p>
        )}

        {noticeKo && (
          <p role="status" className="u-box-accent t-question-ko mb-3 text-ink">
            ✅ {noticeKo}
          </p>
        )}
        {errorKo && (
          <p
            role="alert"
            className="t-question-ko mb-3 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3 text-danger"
          >
            {errorKo}
          </p>
        )}

        {visibleItems.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            아직 만든 단어장이 없어요. 위 버튼으로 첫 단어장을 만들어 볼까요?
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleItems.map((item) =>
              confirmId === item.id ? (
                /* 인라인 확인 — 그 자리에서 묻는다 (window.confirm 금지) */
                <li key={item.id}>
                  <div
                    role="group"
                    aria-label="삭제 확인"
                    className="rounded-[var(--radius-box)] border border-danger bg-danger-soft p-4"
                  >
                    <p className="t-list-title">{item.titleKo}</p>
                    <p className="t-caption mt-1">
                      이 단어장을 지울까요?{" "}
                      <span className="font-medium text-danger">되돌릴 수 없어요.</span>
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
                <li key={item.id} className="flex min-w-0 items-stretch gap-2">
                  <Link href={`/english/vocab/${item.id}`} className="u-item min-w-0 flex-1">
                    <span className="u-item-thumb" aria-hidden>
                      📓
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="t-list-title block truncate">{item.titleKo}</span>
                      <span className="t-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="u-chip">단어 {item.wordCount}개</span>
                        {item.dayLabel && item.dayLabel !== item.titleKo && (
                          <span className="u-chip">{item.dayLabel}</span>
                        )}
                        <span className="t-caption">{formatDate(item.createdAt)}</span>
                      </span>
                    </span>
                  </Link>

                  {manageMode && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmId(item.id);
                        setErrorKo(null);
                        setNoticeKo(null);
                      }}
                      aria-label="이 단어장 지우기"
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
