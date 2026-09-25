"use client";

/**
 * 모의고사 목록 + 새로 만들기 (아빠의 영어 T3, docs/harness/toeic.md §4-0·§8) — 클라이언트 컴포넌트.
 *
 * - **새 모의고사 만들기**: 목표 등급(IM3 / IH 기본 / AL) · 파트(기본 전부) · 주제 힌트(표현집 주제 칩 + 직접 입력) →
 *   `POST /api/toeic/mocks`(호출 C 파트 5개 병렬, 20~40초). 성공하면 학습 보기(`/toeic/mocks/[id]?new=1`)로 옮기고, 그 화면이
 *   Q3–4 사진 2장을 **병렬로 자동 요청**해 상태를 보인다(§4-10 — 사진은 요청 하나에 한 장).
 * - 응답이 끊기면(게이트웨이 60초·네트워크) 서버는 끝까지 만들어 저장할 수 있다 — 목록을 새로 읽고 그 사실을 알린다
 *   (다시 누르면 한 벌이 더 생길 수 있어 곧장 다시 보내지 않는다).
 * - 관리 모드에서만 삭제·순서변경(표현집 목록 골격, `useReorder`). 삭제는 사진·응시 기록까지 지운다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useReorder } from "@/components/use-reorder";
import { formatKstDate } from "@/lib/kst";
import {
  TOEIC_MOCK_TOPIC_HINTS_MAX,
  TOEIC_MOCK_TOPIC_HINT_MAX_CHARS,
  TOEIC_TARGET_GRADE_DESC_KO,
  toeicMockPartLabelKo,
  type ToeicMockCreateRequest,
  type ToeicMockCreateResponse,
  type ToeicMockDeleteResponse,
} from "@/lib/toeic-mock-contract";
import {
  TOEIC_DEFAULT_TARGET_GRADE,
  TOEIC_MOCK_PARTS,
  TOEIC_TARGET_GRADES,
  type ToeicMockPart,
  type ToeicTargetGrade,
} from "@/lib/toeic-mock";
import s from "./toeic-mock-library-view.module.css";

/** 서버가 목록 줄에 필요한 것만 줄여 넘긴다(파트 본문 X). */
export interface ToeicMockLibraryItem {
  id: string;
  titleKo: string;
  targetGrade: ToeicTargetGrade;
  readyParts: number;
  totalParts: number;
  pictureTotal: number;
  pictureReady: number;
  attemptCount: number;
  createdAt: string;
  sortIndex: number | null;
}

type CreateState =
  | { phase: "idle" }
  | { phase: "creating"; startedAt: number }
  | { phase: "error"; message: string; retriable: boolean; cut: boolean };

export default function ToeicMockLibraryView({
  items,
  skippedCount = 0,
  topicChoices,
  setCount,
  expressionCount,
  expressionsMax,
}: {
  items: ToeicMockLibraryItem[];
  skippedCount?: number;
  topicChoices: string[];
  setCount: number;
  expressionCount: number;
  expressionsMax: number;
}) {
  const router = useRouter();

  // ── 새로 만들기 ──
  const [formOpen, setFormOpen] = useState(items.length === 0);
  const [grade, setGrade] = useState<ToeicTargetGrade>(TOEIC_DEFAULT_TARGET_GRADE);
  const [parts, setParts] = useState<Set<ToeicMockPart>>(() => new Set(TOEIC_MOCK_PARTS));
  const [hints, setHints] = useState<string[]>([]);
  const [hintDraft, setHintDraft] = useState("");
  const [create, setCreate] = useState<CreateState>({ phase: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const creatingRef = useRef(false);

  const creating = create.phase === "creating";
  useEffect(() => {
    if (create.phase !== "creating") return;
    const started = create.startedAt;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [create]);

  const hintKeys = new Set(hints.map((h) => h.toLowerCase()));
  const hintsFull = hints.length >= TOEIC_MOCK_TOPIC_HINTS_MAX;
  const customHints = hints.filter((h) => !topicChoices.some((t) => t.toLowerCase() === h.toLowerCase()));

  function toggleHint(h: string) {
    setHints((prev) => {
      const k = h.toLowerCase();
      if (prev.some((x) => x.toLowerCase() === k)) return prev.filter((x) => x.toLowerCase() !== k);
      if (prev.length >= TOEIC_MOCK_TOPIC_HINTS_MAX) return prev;
      return [...prev, h];
    });
  }

  function addCustomHint() {
    const v = hintDraft.replace(/\s+/g, " ").trim().slice(0, TOEIC_MOCK_TOPIC_HINT_MAX_CHARS);
    if (!v || hintKeys.has(v.toLowerCase()) || hintsFull) {
      setHintDraft("");
      return;
    }
    setHints((prev) => [...prev, v]);
    setHintDraft("");
  }

  function togglePart(p: ToeicMockPart) {
    setParts((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function runCreate() {
    if (creatingRef.current || parts.size === 0) return;
    creatingRef.current = true;
    setElapsed(0);
    setCreate({ phase: "creating", startedAt: Date.now() });
    const body: ToeicMockCreateRequest = {
      targetGrade: grade,
      parts: TOEIC_MOCK_PARTS.filter((p) => parts.has(p)),
      topicHints: hints,
    };
    try {
      const res = await fetch("/api/toeic/mocks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as ToeicMockCreateResponse | null;
      if (data?.ok) {
        const q = new URLSearchParams({ new: "1" });
        if (data.failedParts.length > 0) q.set("failed", data.failedParts.join(","));
        router.push(`/toeic/mocks/${encodeURIComponent(data.id)}?${q.toString()}`);
        return; // creatingRef는 이동하며 사라진다 — 두 번 누르기 방지 유지
      }
      if (data && !data.ok) {
        setCreate({ phase: "error", message: data.messageKo, retriable: data.retriable === true, cut: false });
      } else {
        // 우리 JSON이 아니다(게이트웨이 시간 초과 등) — 서버는 끝까지 만들어 저장했을 수 있다
        router.refresh();
        setCreate({
          phase: "error",
          message: "응답이 중간에 끊겼어요. 서버에서 만들어졌을 수 있어 목록을 새로 읽었어요 — 새 모의고사가 보이면 그것을 쓰세요.",
          retriable: true,
          cut: true,
        });
      }
    } catch {
      router.refresh();
      setCreate({
        phase: "error",
        message: "네트워크가 끊겼어요. 서버에서 만들어졌을 수 있어 목록을 새로 읽었어요 — 새 모의고사가 보이면 그것을 쓰세요.",
        retriable: true,
        cut: true,
      });
    }
    creatingRef.current = false;
  }

  // ── 목록 · 관리 ──
  const [manageMode, setManageMode] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [noticeKo, setNoticeKo] = useState<string | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  const visibleItems = items.filter((item) => !deletedIds.includes(item.id));
  const reorder = useReorder({
    ids: visibleItems.map((item) => item.id),
    enabled: manageMode,
    onPersist: async (orderedIds) => {
      const res = await fetch("/api/toeic/mocks/reorder", {
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
  const orderedItems = reorder.order.map((id) => itemById.get(id)).filter((item): item is ToeicMockLibraryItem => item != null);

  function toggleManage() {
    setManageMode((on) => !on);
    setConfirmId(null);
    setNoticeKo(null);
    setErrorKo(null);
  }

  async function runDelete(item: ToeicMockLibraryItem) {
    setDeletingId(item.id);
    setNoticeKo(null);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/toeic/mocks/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as ToeicMockDeleteResponse | null;
      if ((res.ok && data?.ok) || res.status === 404) {
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        setNoticeKo(res.status === 404 ? "이미 지워져 있었어요." : "모의고사 하나를 지웠어요.");
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

  const exprInfo =
    expressionCount > 0
      ? `표현집 ${setCount}세트의 표현 ${expressionCount}개 중 최대 ${expressionsMax}개(시험에서 약한 것부터)를 모범답변에 자연스럽게 녹여요.`
      : "표현집이 비어 있어 활용할 표현 없이 만들어요. 표현집을 먼저 채우면 모범답변에 녹여 드려요.";

  return (
    <>
      {skippedCount > 0 && (
        <p role="status" className="u-box t-caption mb-4 border border-line-strong">
          ⚠️ 형식이 맞지 않아 열지 못한 모의고사가 {skippedCount}개 있어요. 아래 목록에는 빠져 있어요.
        </p>
      )}

      {/* ── 새 모의고사 만들기 ── */}
      <section aria-label="새 모의고사 만들기" className={s.createBox}>
        {!formOpen ? (
          <button type="button" className="u-btn u-btn-primary w-full" onClick={() => setFormOpen(true)}>
            <span aria-hidden>✨</span> 새 모의고사 만들기
          </button>
        ) : (
          <div className={s.form}>
            <h2 className="t-section-title">✨ 새 모의고사 만들기</h2>

            <fieldset className={s.fieldset} disabled={creating}>
              <legend className={s.legend}>목표 등급 — 모범답변의 길이·수준이 달라져요</legend>
              <div className={s.choices}>
                {TOEIC_TARGET_GRADES.map((g) => (
                  <label key={g} className={`${s.choice} ${grade === g ? s.choiceOn : ""}`}>
                    <input
                      type="radio"
                      name="toeic-grade"
                      value={g}
                      checked={grade === g}
                      onChange={() => setGrade(g)}
                      className={s.srOnly}
                    />
                    <span className={s.choiceTitle}>{g}</span>
                    <span className={s.choiceDesc}>{TOEIC_TARGET_GRADE_DESC_KO[g]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className={s.fieldset} disabled={creating}>
              <legend className={s.legend}>파트 — 기본은 11문항 전부(유형 연습만 하려면 골라요)</legend>
              <div className={s.partList}>
                {TOEIC_MOCK_PARTS.map((p) => (
                  <label key={p} className={`${s.partItem} ${parts.has(p) ? s.partOn : ""}`}>
                    <input type="checkbox" checked={parts.has(p)} onChange={() => togglePart(p)} />
                    <span>{toeicMockPartLabelKo(p)}</span>
                  </label>
                ))}
              </div>
              {parts.size === 0 && <p className={s.warn}>파트를 하나 이상 골라 주세요.</p>}
            </fieldset>

            <fieldset className={s.fieldset} disabled={creating}>
              <legend className={s.legend}>
                주제 힌트 — 고르지 않으면 AI가 다양하게 골라요 ({hints.length}/{TOEIC_MOCK_TOPIC_HINTS_MAX})
              </legend>
              {topicChoices.length > 0 && (
                <div className={s.chips} role="group" aria-label="표현집 주제">
                  {topicChoices.map((t) => {
                    const on = hintKeys.has(t.toLowerCase());
                    return (
                      <button
                        key={t}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleHint(t)}
                        disabled={!on && hintsFull}
                        className={`${s.chip} ${on ? s.chipOn : ""}`}
                      >
                        {on ? "✓ " : ""}
                        {t}
                      </button>
                    );
                  })}
                </div>
              )}
              {customHints.length > 0 && (
                <div className={s.chips} role="group" aria-label="직접 넣은 주제">
                  {customHints.map((h) => (
                    <button
                      key={h}
                      type="button"
                      onClick={() => toggleHint(h)}
                      className={`${s.chip} ${s.chipOn}`}
                      aria-label={`${h} 빼기`}
                    >
                      {h} ✕
                    </button>
                  ))}
                </div>
              )}
              <div className={s.hintRow}>
                <input
                  type="text"
                  value={hintDraft}
                  onChange={(e) => setHintDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      addCustomHint();
                    }
                  }}
                  maxLength={TOEIC_MOCK_TOPIC_HINT_MAX_CHARS}
                  placeholder="직접 입력 (예: 출장, 헬스장)"
                  aria-label="주제 직접 입력"
                  className="u-input"
                  disabled={hintsFull}
                />
                <button type="button" className="u-btn u-btn-secondary" onClick={addCustomHint} disabled={hintsFull || hintDraft.trim() === ""}>
                  추가
                </button>
              </div>
            </fieldset>

            <p className={s.info}>📒 {exprInfo}</p>
            <p className={s.info}>⏱ 파트마다 따로 동시에 만들어요 — 보통 20~40초. Q3–4 사진 2장은 만든 뒤 학습 보기에서 따로 그려요.</p>

            <div className={s.actions}>
              <button type="button" className="u-btn u-btn-primary" onClick={() => void runCreate()} disabled={creating || parts.size === 0}>
                {creating ? `만드는 중… ${elapsed}초` : "✨ 모의고사 만들기"}
              </button>
              {!creating && items.length > 0 && (
                <button type="button" className="u-btn u-btn-secondary" onClick={() => setFormOpen(false)}>
                  접기
                </button>
              )}
            </div>

            {creating && (
              <div role="status" className={s.progress}>
                <p className={s.progressText}>
                  {parts.size}개 파트를 동시에 만들고 있어요 · {elapsed}초 — 화면을 켜 둔 채 기다려 주세요.
                </p>
                <ul className={s.progressParts}>
                  {TOEIC_MOCK_PARTS.filter((p) => parts.has(p)).map((p) => (
                    <li key={p} className="u-chip">
                      ⏳ {toeicMockPartLabelKo(p)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {create.phase === "error" && (
              <div role="alert" className="rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3">
                <p className="t-question-ko text-danger">{create.message}</p>
                {create.retriable && (
                  <button type="button" className="u-btn u-btn-secondary mt-2" onClick={() => void runCreate()}>
                    {create.cut ? "그래도 다시 만들기" : "🔄 다시 만들기"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {noticeKo && (
        <p role="status" className="u-box-accent t-question-ko mt-4 text-ink">
          ✅ {noticeKo}
        </p>
      )}
      {errorKo && (
        <p role="alert" className="t-question-ko mt-4 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3 text-danger">
          {errorKo}
        </p>
      )}

      {/* ── 목록 ── */}
      <section aria-label="모의고사 목록" className="mt-8">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="t-section-title">내 모의고사</h2>
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
            <span className="font-medium text-ink">↑ ↓ 버튼</span>으로 옮겨요. 지울 모의고사는{" "}
            <span className="font-medium text-ink">🗑 지우기</span> — 사진과 응시 기록도 함께 지워지고{" "}
            <span className="font-medium text-ink">되돌릴 수 없어요.</span>
          </p>
        )}

        {visibleItems.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            아직 모의고사가 없어요. 위에서 첫 모의고사를 만들어 볼까요?
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {orderedItems.map((item) =>
              confirmId === item.id ? (
                <li key={item.id}>
                  <div role="group" aria-label="삭제 확인" className="rounded-[var(--radius-box)] border border-danger bg-danger-soft p-4">
                    <p className="t-list-title">{item.titleKo}</p>
                    <p className="t-caption mt-1">
                      이 모의고사와 사진·응시 기록을 지울까요? <span className="font-medium text-danger">되돌릴 수 없어요.</span>
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
                  <Link href={`/toeic/mocks/${item.id}`} className="u-item min-w-0 flex-1">
                    <span className="u-item-thumb" aria-hidden>
                      🧑‍💼
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="t-list-title block truncate">{item.titleKo}</span>
                      <span className="t-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="u-chip">목표 {item.targetGrade}</span>
                        <span className={`u-chip ${item.readyParts === item.totalParts ? "u-chip-accent" : ""}`}>
                          {item.readyParts === item.totalParts ? "✓ 11문항" : `파트 ${item.readyParts}/${item.totalParts}`}
                        </span>
                        {item.pictureTotal > 0 && (
                          <span className="u-chip">
                            📷 {item.pictureReady}/{item.pictureTotal}
                          </span>
                        )}
                        {item.attemptCount > 0 && <span className="u-chip">응시 {item.attemptCount}회</span>}
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
                        setNoticeKo(null);
                        setErrorKo(null);
                      }}
                      aria-label="이 모의고사 지우기"
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
