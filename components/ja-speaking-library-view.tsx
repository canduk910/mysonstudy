"use client";

/**
 * 🎙️ 말하기 모의고사 목록 + 새로 만들기 (아빠의 일본어, docs/harness/japanese.md §15-10-2) — 클라이언트 컴포넌트.
 *
 * - **새로 만들기**: JLPT 레벨 **하나**(N5~N1 버튼, 기본 N4) · 파트(기본 다섯 — 유형 하나만도 된다) · 주제(선택 — 프리셋 칩 + 직접 입력, 최대 3)
 *   → `POST /api/japanese/speaking/mocks`(호출 E 파트별 병렬, 20~40초 — 버튼을 눌러야 비용). 성공하면 학습 보기로 옮기고, 그 화면이
 *   Q3–4 사진 2장을 자동 요청한다(pending 칸만).
 * - 응답이 끊기면 서버는 끝까지 만들어 저장했을 수 있다 — 목록을 새로 읽고 알린다(곧장 다시 보내지 않는다 — 한 벌이 더 생길 수 있다).
 * - 관리 모드에서만 삭제·순서변경(공유 프리미티브 `useReorder`). 삭제는 사진·응시 기록까지 지운다(녹음은 기기에만 있어 그대로 남고, 풀마다 최근 5회분 정리로 사라진다).
 * - 모양은 토익 모의고사 목록 스타일 모듈을 그대로 쓴다(새 스타일 없음).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useReorder } from "@/components/use-reorder";
import type { JlptLevel } from "@/lib/ai/japanese/schemas";
import { JA_SPEAKING_DEFAULT_LEVEL, JA_SPEAKING_LEVELS, JA_SPEAKING_PARTS, type JaSpeakingPart } from "@/lib/ja-speaking";
import {
  jaSpeakingMockHref,
  jaSpeakingPartLabelKo,
  type JaSpeakingCreateRequest,
  type JaSpeakingCreateResponse,
  type JaSpeakingMockDeleteResponse,
} from "@/lib/ja-speaking-contract";
import { formatKstDate } from "@/lib/kst";
import s from "./toeic-mock-library-view.module.css";

export interface JaSpeakingLibraryItem {
  id: string;
  titleKo: string;
  level: JlptLevel;
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

const LEVEL_DESC_KO: Record<JlptLevel, string> = {
  N5: "기초 — 짧은 문장",
  N4: "기본 — 일상 표현",
  N3: "중급 — 이유·비교",
  N2: "중상급 — 의견·설명",
  N1: "상급 — 자연스러운 논리",
};

export default function JaSpeakingLibraryView({
  items,
  skippedCount = 0,
  topicChoices,
  hintsMax,
  hintMaxChars,
}: {
  items: JaSpeakingLibraryItem[];
  skippedCount?: number;
  /** 주제 프리셋(JA_VOCAB_TOPIC_PRESETS — 서버가 넘긴다) */
  topicChoices: readonly string[];
  hintsMax: number;
  hintMaxChars: number;
}) {
  const router = useRouter();

  // ── 새로 만들기 ──
  const [formOpen, setFormOpen] = useState(items.length === 0);
  const [level, setLevel] = useState<JlptLevel>(JA_SPEAKING_DEFAULT_LEVEL);
  const [parts, setParts] = useState<Set<JaSpeakingPart>>(() => new Set(JA_SPEAKING_PARTS));
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

  const hintsFull = hints.length >= hintsMax;
  const customHints = hints.filter((h) => !topicChoices.includes(h));

  function toggleHint(h: string) {
    setHints((prev) => (prev.includes(h) ? prev.filter((x) => x !== h) : prev.length >= hintsMax ? prev : [...prev, h]));
  }
  function addCustomHint() {
    const v = Array.from(hintDraft.replace(/\s+/g, " ").trim()).slice(0, hintMaxChars).join("");
    if (!v || hints.includes(v) || hintsFull) {
      setHintDraft("");
      return;
    }
    setHints((prev) => [...prev, v]);
    setHintDraft("");
  }
  function togglePart(p: JaSpeakingPart) {
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
    const body: JaSpeakingCreateRequest = { level, parts: JA_SPEAKING_PARTS.filter((p) => parts.has(p)), topicHints: hints };
    try {
      const res = await fetch("/api/japanese/speaking/mocks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as JaSpeakingCreateResponse | null;
      if (data?.ok) {
        const q = new URLSearchParams({ new: "1" });
        if (data.failedParts.length > 0) q.set("failed", data.failedParts.join(","));
        router.push(`${jaSpeakingMockHref(data.id)}?${q.toString()}`);
        return;
      }
      if (data && !data.ok) {
        setCreate({ phase: "error", message: data.messageKo, retriable: data.retriable === true, cut: false });
      } else {
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
      const res = await fetch("/api/japanese/speaking/mocks/reorder", {
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
  const orderedItems = reorder.order.map((id) => itemById.get(id)).filter((item): item is JaSpeakingLibraryItem => item != null);

  async function runDelete(item: JaSpeakingLibraryItem) {
    setDeletingId(item.id);
    setNoticeKo(null);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/japanese/speaking/mocks/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as JaSpeakingMockDeleteResponse | null;
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

  return (
    <>
      {skippedCount > 0 && (
        <p role="status" className="u-box t-caption mb-4 border border-line-strong">
          ⚠️ 형식이 맞지 않아 열지 못한 모의고사가 {skippedCount}개 있어요. 아래 목록에는 빠져 있어요.
        </p>
      )}

      <section aria-label="새 모의고사 만들기" className={s.createBox}>
        {!formOpen ? (
          <button type="button" className="u-btn u-btn-primary w-full" onClick={() => setFormOpen(true)} data-testid="ja-speaking-open-form">
            <span aria-hidden>✨</span> 새 말하기 모의고사 만들기
          </button>
        ) : (
          <div className={s.form}>
            <h2 className="t-section-title">✨ 새 말하기 모의고사 만들기</h2>

            <fieldset className={s.fieldset} disabled={creating}>
              <legend className={s.legend}>JLPT 레벨 하나 — 지문·질문·모범답변이 그 레벨의 어휘·문형이에요</legend>
              <div className={s.choices}>
                {JA_SPEAKING_LEVELS.map((lv) => (
                  <label key={lv} className={`${s.choice} ${level === lv ? s.choiceOn : ""}`}>
                    <input type="radio" name="ja-speaking-level" value={lv} checked={level === lv} onChange={() => setLevel(lv)} className={s.srOnly} />
                    <span className={s.choiceTitle}>{lv}</span>
                    <span className={s.choiceDesc}>{LEVEL_DESC_KO[lv]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className={s.fieldset} disabled={creating}>
              <legend className={s.legend}>파트 — 기본은 11문항 전부(유형 연습만 하려면 골라요)</legend>
              <div className={s.partList}>
                {JA_SPEAKING_PARTS.map((p) => (
                  <label key={p} className={`${s.partItem} ${parts.has(p) ? s.partOn : ""}`}>
                    <input type="checkbox" checked={parts.has(p)} onChange={() => togglePart(p)} />
                    <span>{jaSpeakingPartLabelKo(p)}</span>
                  </label>
                ))}
              </div>
              {parts.size === 0 && <p className={s.warn}>파트를 하나 이상 골라 주세요.</p>}
            </fieldset>

            <fieldset className={s.fieldset} disabled={creating}>
              <legend className={s.legend}>
                주제(선택) — 고르지 않으면 AI가 다양하게 골라요 ({hints.length}/{hintsMax})
              </legend>
              <div className={s.chips} role="group" aria-label="주제 프리셋">
                {topicChoices.map((t) => {
                  const on = hints.includes(t);
                  return (
                    <button key={t} type="button" aria-pressed={on} onClick={() => toggleHint(t)} disabled={!on && hintsFull} className={`${s.chip} ${on ? s.chipOn : ""}`}>
                      {on ? "✓ " : ""}
                      {t}
                    </button>
                  );
                })}
              </div>
              {customHints.length > 0 && (
                <div className={s.chips} role="group" aria-label="직접 넣은 주제">
                  {customHints.map((h) => (
                    <button key={h} type="button" onClick={() => toggleHint(h)} className={`${s.chip} ${s.chipOn}`} aria-label={`${h} 빼기`}>
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
                  maxLength={hintMaxChars}
                  placeholder="직접 입력 (예: 온천 여행, 회사 회식)"
                  aria-label="주제 직접 입력"
                  className="u-input"
                  disabled={hintsFull}
                />
                <button type="button" className="u-btn u-btn-secondary" onClick={addCustomHint} disabled={hintsFull || hintDraft.trim() === ""}>
                  추가
                </button>
              </div>
            </fieldset>

            <p className={s.info}>🧑‍🏫 AI가 새로 만든 문항이에요(기출이 아니에요). 지시·질문은 일본어, 뜻은 펼쳐 보는 한국어, 모범답변엔 후리가나가 붙어요.</p>
            <p className={s.info}>⏱ 파트마다 따로 동시에 만들어요 — 보통 20~40초. Q3–4 사진 2장(일본 배경)은 만든 뒤 학습 보기에서 따로 그려요.</p>

            <div className={s.actions}>
              <button type="button" className="u-btn u-btn-primary" onClick={() => void runCreate()} disabled={creating || parts.size === 0} data-testid="ja-speaking-create">
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
                  {level} · {parts.size}개 파트를 동시에 만들고 있어요 · {elapsed}초 — 화면을 켜 둔 채 기다려 주세요.
                </p>
                <ul className={s.progressParts}>
                  {JA_SPEAKING_PARTS.filter((p) => parts.has(p)).map((p) => (
                    <li key={p} className="u-chip">
                      ⏳ {jaSpeakingPartLabelKo(p)}
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

      <section aria-label="말하기 모의고사 목록" className="mt-8">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="t-section-title">내 말하기 모의고사</h2>
          {visibleItems.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setManageMode((on) => !on);
                setConfirmId(null);
                setNoticeKo(null);
                setErrorKo(null);
              }}
              aria-pressed={manageMode}
              className={`u-btn flex-none px-3 py-1.5 text-meta-chip ${manageMode ? "u-btn-primary" : "u-btn-secondary"}`}
            >
              {manageMode ? "완료" : "관리"}
            </button>
          )}
        </div>

        {manageMode && (
          <p className="t-caption mb-3 rounded-[var(--radius-box)] border border-dashed border-line px-4 py-3">
            <span className="font-medium text-ink">≡ 손잡이를 끌어</span> 순서를 바꾸거나 <span className="font-medium text-ink">↑ ↓ 버튼</span>으로 옮겨요. 지울 모의고사는{" "}
            <span className="font-medium text-ink">🗑 지우기</span> — 사진과 응시 기록도 함께 지워지고 <span className="font-medium text-ink">되돌릴 수 없어요.</span>
          </p>
        )}

        {visibleItems.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">아직 말하기 모의고사가 없어요. 위에서 첫 모의고사를 만들어 볼까요?</p>
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
                      <button type="button" onClick={() => void runDelete(item)} disabled={deletingId === item.id} className="u-btn flex-1 bg-danger text-bg">
                        {deletingId === item.id ? "지우는 중…" : "지우기"}
                      </button>
                      <button type="button" onClick={() => setConfirmId(null)} disabled={deletingId === item.id} className="u-btn u-btn-secondary flex-1">
                        취소
                      </button>
                    </div>
                  </div>
                </li>
              ) : (
                <li
                  key={item.id}
                  {...reorder.getRowProps(item.id)}
                  className={`flex min-w-0 items-stretch gap-2 rounded-[var(--radius-box)] ${reorder.draggingId === item.id ? "opacity-90 ring-2 ring-accent" : ""}`}
                >
                  {manageMode && (
                    <div
                      {...reorder.getHandleProps(item.id)}
                      className="t-list-title flex w-8 flex-none select-none items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink-3 hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent print:hidden"
                    >
                      <span aria-hidden>≡</span>
                    </div>
                  )}
                  <Link href={jaSpeakingMockHref(item.id)} className="u-item min-w-0 flex-1">
                    <span className="u-item-thumb" aria-hidden>
                      🎙️
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="t-list-title block truncate">{item.titleKo}</span>
                      <span className="t-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="u-chip">{item.level}</span>
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
