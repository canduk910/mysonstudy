"use client";

/**
 * components/toeic-recordings-view.tsx — "🎙️ 내 녹음" 목록 (docs/harness/toeic.md §14-6, SPEC §20-12) — 클라이언트 컴포넌트.
 *
 * - 서버 요약(응시별 서버 메타·지운 자리) + 이 기기 IndexedDB 메타를 lib/toeic-rec-manage `buildToeicRecManageView`로 합친다.
 *   지운 자리가 덮는 이 기기 사본(다른 기기에서 지운 녹음)은 열 때 지운다.
 * - 묶음: 날짜 · 모의고사/연습 이름 · 범위 · 녹음 n개 · 고칠 문장 m개 · 합계 길이 + "결과 보기 →" + "🗑 이 응시 녹음 모두 지우기".
 *   항목: Q · 유형 · 길이 · 점수(답변) / 고친 문장(고칠 문장 녹음) · 서버 ✓ / 이 기기에만(올리는 중) · ▶ 듣기 · 🗑.
 * - ▶ 듣기: 이 기기 사본 → 서버 사본(fetch → Blob → objectURL — API 주소를 `<audio src>`에 넣지 않는다, §13-4). 받은 뒤 재생기를 보인다
 *   (iOS는 탭 안 await 뒤 play()를 막으므로 재생기의 ▶를 한 번 더 누른다).
 * - 🗑: 확인 창(되돌릴 수 없음) → **서버 먼저**(DELETE — 보관소 → 메타·지운 자리) → 성공하면 이 기기 사본·대기열(업로드 취소) → 목록.
 *   서버가 실패하면 아무것도 지우지 않는다(상태 일관). 응시 기록이 없는 이 기기 사본은 "이 기기에서 지우기"(서버 호출 없음).
 * - AI 0. 이 화면도 업로드 대기열 계기다(토익 화면).
 * - 예전 답 녹음(2026-10-03, docs/harness/toeic.md §15-8): 다시 풀기로 밀려난 답의 녹음이 "다시 풀기 전 답"으로 따로 보인다 — ▶는 이 기기 사본(그 세대) →
 *   서버 사본(`…/recordings/[q]/history/[rid]`), 🗑은 그 답의 답변 녹음 + 고칠 문장 녹음만(지금 답 녹음·점수는 그대로).
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatKst } from "@/lib/kst";
import {
  toeicAttemptRecordingsHref,
  toeicRecordingHistoryHref,
  toeicRecordingHref,
  type ToeicRecordingDeleteResponse,
  type ToeicRecordingGetErrorResponse,
} from "@/lib/toeic-attempt-contract";
import {
  buildToeicRecManageView,
  withoutToeicRecGroup,
  withoutToeicRecItem,
  type ToeicRecAttemptSummary,
  type ToeicRecManageItem,
  type ToeicRecManageView,
} from "@/lib/toeic-rec-manage";
import { deleteToeicRecordingsLocal, getToeicRecording, listAllToeicRecordingMetas } from "@/lib/toeic-rec-store";
import { useToeicRecUploadDrain } from "@/components/use-toeic-rec-uploads";
import s from "./toeic-recordings-view.module.css";

type Player = { status: "loading" } | { status: "ready"; url: string } | { status: "error"; message: string };

const itemKey = (attemptId: string, it: ToeicRecManageItem) =>
  it.kind === "answer" ? `${attemptId}:a:${it.q}` : it.kind === "fix" ? `${attemptId}:f:${it.q}:${it.fixIndex}` : `${attemptId}:h:${it.q}:${it.replacedBy}`;

/** 항목 → 서버 주소(▶·🗑) */
const itemHref = (attemptId: string, it: ToeicRecManageItem) =>
  it.kind === "answer"
    ? toeicRecordingHref(attemptId, it.q)
    : it.kind === "fix"
      ? toeicRecordingHref(attemptId, it.q, it.fixIndex)
      : toeicRecordingHistoryHref(attemptId, it.q, it.replacedBy);

function secs(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}초`;
}
function totalLabel(ms: number): string {
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
}

export default function ToeicRecordingsView({ summaries }: { summaries: ToeicRecAttemptSummary[] }) {
  useToeicRecUploadDrain();
  const [view, setView] = useState<ToeicRecManageView | null>(null);
  const [players, setPlayers] = useState<Record<string, Player>>({});
  const urlsRef = useRef<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void listAllToeicRecordingMetas().then((metas) => {
      if (!alive) return;
      const v = buildToeicRecManageView(summaries, metas);
      // 다른 기기·결과 화면에서 지운 녹음의 이 기기 사본 — 여기서 지운다(§14-4)
      for (const p of v.purgeLocal) void deleteToeicRecordingsLocal(p.attemptId, p.qs);
      // 다른 기기·목록에서 지운 예전 답(이력 줄 recordingDeletedAt)의 이 기기 사본 — 지금 답 세대 사본은 남긴다(§15-8, QA rec-retake P2-4)
      for (const p of v.purgeLocalHistory) void deleteToeicRecordingsLocal(p.attemptId, [p.q], { keepGeneration: p.keepGeneration });
      setView(v);
    });
    return () => {
      alive = false;
    };
  }, [summaries]);

  useEffect(
    () => () => {
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    },
    [],
  );

  const load = useCallback(async (attemptId: string, it: ToeicRecManageItem) => {
    const key = itemKey(attemptId, it);
    setPlayers((prev) => ({ ...prev, [key]: { status: "loading" } }));
    let blob: Blob | null = null;
    if ((it.kind === "answer" || it.kind === "history") && it.local) blob = (await getToeicRecording(attemptId, it.q))?.blob ?? null;
    if (!blob && it.server) {
      try {
        const res =
          it.kind === "history"
            ? await fetch(toeicRecordingHistoryHref(attemptId, it.q, it.replacedBy), { cache: "no-store" })
            : await fetch(toeicRecordingHref(attemptId, it.q, it.kind === "fix" ? it.fixIndex : undefined), { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as ToeicRecordingGetErrorResponse | null;
          setPlayers((prev) => ({ ...prev, [key]: { status: "error", message: body?.messageKo ?? `불러오지 못했어요(${res.status}).` } }));
          return;
        }
        blob = await res.blob();
      } catch {
        setPlayers((prev) => ({ ...prev, [key]: { status: "error", message: "네트워크 문제로 불러오지 못했어요." } }));
        return;
      }
    }
    if (!blob) {
      setPlayers((prev) => ({ ...prev, [key]: { status: "error", message: "소리를 찾지 못했어요." } }));
      return;
    }
    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    setPlayers((prev) => ({ ...prev, [key]: { status: "ready", url } }));
  }, []);

  function pauseAll() {
    for (const el of Array.from(document.querySelectorAll("audio"))) el.pause();
  }

  async function serverDelete(href: string): Promise<{ ok: true } | { ok: false; message: string; gone: boolean }> {
    try {
      const res = await fetch(href, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as ToeicRecordingDeleteResponse | null;
      if (data?.ok) return { ok: true };
      // 응시 기록이 이미 없다 — 서버에 지울 것이 없으니 이 기기 사본만 지우면 된다
      if (res.status === 404 && data && !data.ok && data.error === "attempt_not_found") return { ok: false, message: data.messageKo, gone: true };
      return { ok: false, message: data && !data.ok ? data.messageKo : `지우지 못했어요(${res.status}). 다시 눌러 주세요.`, gone: false };
    } catch {
      return { ok: false, message: "네트워크 문제로 지우지 못했어요. 다시 눌러 주세요.", gone: false };
    }
  }

  async function deleteItem(attemptId: string, it: ToeicRecManageItem) {
    const key = itemKey(attemptId, it);
    const what =
      it.kind === "answer"
        ? `Q${it.q} 내 답변 녹음`
        : it.kind === "fix"
          ? `Q${it.q} 고칠 문장 ${it.fixIndex + 1} 다시 말한 녹음`
          : `Q${it.q} 다시 풀기 전 답 녹음${it.fixCount > 0 ? `(고칠 문장 녹음 ${it.fixCount}개 포함)` : ""}`;
    const tail =
      it.kind === "answer" && it.score !== null
        ? " 점수·전사·피드백은 남지만 이 문항은 다시 채점할 수 없어요."
        : it.kind === "history"
          ? " 그 답의 점수·전사는 다시 풀기 기록에 남고, 지금 답 녹음은 그대로예요."
          : " 점수·전사·피드백은 남아요.";
    if (!window.confirm(`${what}을 지울까요?\n서버와 이 기기에서 모두 지워지고 되돌릴 수 없어요.${tail}`)) return;
    pauseAll();
    setBusy(key);
    setErrors((prev) => ({ ...prev, [key]: "" }));
    const r = await serverDelete(itemHref(attemptId, it));
    if (!r.ok && !r.gone) {
      setErrors((prev) => ({ ...prev, [key]: r.message }));
      setBusy(null);
      return;
    }
    // 서버 먼저 → 이 기기 사본(대기열에 있던 것은 업로드도 취소)
    if (it.kind === "answer") await deleteToeicRecordingsLocal(attemptId, [it.q]);
    // 예전 답 — 이 기기 사본이 그 세대일 때만 지운다(지금 답 세대의 사본은 남긴다)
    if (it.kind === "history" && it.local) await deleteToeicRecordingsLocal(attemptId, [it.q], { keepGeneration: currentGenOf(attemptId, it.q) });
    setView((v) =>
      v
        ? withoutToeicRecItem(
            v,
            attemptId,
            it.kind === "answer" ? { kind: "answer", q: it.q } : it.kind === "fix" ? { kind: "fix", q: it.q, fixIndex: it.fixIndex } : { kind: "history", q: it.q, replacedBy: it.replacedBy },
          )
        : v,
    );
    setNotice(`${what}을 지웠어요.`);
    setBusy(null);
  }

  async function deleteGroup(attemptId: string, label: string, count: number) {
    const key = `${attemptId}:all`;
    if (!window.confirm(`${label}의 녹음 ${count}개를 모두 지울까요?\n서버와 이 기기에서 모두 지워지고 되돌릴 수 없어요. 응시 기록·점수·전사·피드백은 남아요.`)) return;
    pauseAll();
    setBusy(key);
    setErrors((prev) => ({ ...prev, [key]: "" }));
    const r = await serverDelete(toeicAttemptRecordingsHref(attemptId));
    if (!r.ok && !r.gone) {
      setErrors((prev) => ({ ...prev, [key]: r.message }));
      setBusy(null);
      return;
    }
    await deleteToeicRecordingsLocal(attemptId, "all");
    setView((v) => (v ? withoutToeicRecGroup(v, attemptId) : v));
    setNotice(`${label}의 녹음을 모두 지웠어요.`);
    setBusy(null);
  }

  async function deleteOrphan(attemptId: string, count: number) {
    if (!window.confirm(`응시 기록이 없는 이 기기 녹음 ${count}개를 지울까요? 되돌릴 수 없어요.`)) return;
    pauseAll();
    await deleteToeicRecordingsLocal(attemptId, "all");
    setView((v) => (v ? { ...v, orphans: v.orphans.filter((o) => o.attemptId !== attemptId) } : v));
  }

  /** 그 응시·문항의 지금 답 세대(§15-1 — 이력 마지막 줄의 replacedBy, 없으면 null) */
  function currentGenOf(attemptId: string, q: number): string | null {
    const rows = (summaries.find((a) => a.id === attemptId)?.answerHistory ?? []).filter((h) => h.q === q);
    return rows.length > 0 ? rows[rows.length - 1].replacedBy : null;
  }

  if (view === null) return <p className="t-caption">녹음을 모으는 중…</p>;
  const answerTotal = view.groups.reduce((n, g) => n + g.answerCount, 0);
  const fixTotal = view.groups.reduce((n, g) => n + g.fixCount, 0);

  return (
    <div className={s.wrap}>
      <p className={s.summary} data-testid="rec-manage-summary">
        응시 {view.groups.length}개 · 답변 녹음 {answerTotal}개 · 고칠 문장 녹음 {fixTotal}개
      </p>
      {notice && (
        <p className={s.notice} role="status">
          {notice}
        </p>
      )}
      {view.groups.length === 0 && view.orphans.length === 0 && (
        <p className="t-caption">아직 보관된 녹음이 없어요. 모의고사나 한 문제 연습을 녹음하며 응시하면 여기에 모여요.</p>
      )}

      {view.groups.map((g) => {
        const gKey = `${g.attemptId}:all`;
        const label = `${formatKst(g.startedAt)} ${g.titleKo}`;
        return (
          <section key={g.attemptId} className={s.group} aria-label={`${label} 녹음`} data-testid={`rec-group-${g.attemptId}`}>
            <div className={s.groupHead}>
              <p className={s.date}>{formatKst(g.startedAt)}</p>
              <p className={s.title}>{g.titleKo}</p>
              <p className={s.meta}>
                <span className="u-chip">{g.scopeLabelKo}</span>
                <span>
                  녹음 {g.answerCount}개{g.fixCount > 0 ? ` · 고칠 문장 ${g.fixCount}개` : ""} · {totalLabel(g.totalMs)}
                </span>
              </p>
              <div className={s.groupTools}>
                <Link href={`/toeic/attempts/${encodeURIComponent(g.attemptId)}`} className={s.link}>
                  결과 보기 →
                </Link>
                <button
                  type="button"
                  className={s.del}
                  data-testid={`rec-group-delete-${g.attemptId}`}
                  disabled={busy !== null}
                  onClick={() => void deleteGroup(g.attemptId, label, g.items.length)}
                >
                  {busy === gKey ? "지우는 중…" : "🗑 이 응시 녹음 모두 지우기"}
                </button>
              </div>
              {errors[gKey] && <p className={s.error}>{errors[gKey]}</p>}
            </div>
            <ul className={s.items}>
              {g.items.map((it) => {
                const key = itemKey(g.attemptId, it);
                const p = players[key];
                return (
                  <li key={key} className={s.item} data-testid={`rec-item-${key}`}>
                    <div className={s.itemHead}>
                      <span className={s.q}>Q{it.q}</span>
                      <span className={s.part}>
                        {it.kind === "answer" ? it.partNameKo : it.kind === "fix" ? `고칠 문장 ${it.fixIndex + 1}` : `다시 풀기 전 답 · ${formatKst(it.startedAt)}`}
                      </span>
                      <span className={s.dim}>{secs(it.durationMs)}</span>
                      {(it.kind === "answer" || it.kind === "history") && (
                        <span className={s.dim}>{it.score !== null ? `${it.score} / ${it.maxScore}점` : "채점 전"}</span>
                      )}
                      <span className={s.dim}>{it.server ? "서버 ✓" : it.pending ? "이 기기에만(올리는 중)" : "이 기기에만"}</span>
                    </div>
                    {it.kind === "fix" && (
                      <p className={s.better} lang="en">
                        {it.better}
                      </p>
                    )}
                    <div className={s.tools}>
                      {p?.status === "ready" ? (
                        <audio className={s.audio} controls preload="metadata" src={p.url}>
                          <track kind="captions" />
                        </audio>
                      ) : (
                        <button type="button" className={s.play} disabled={p?.status === "loading"} onClick={() => void load(g.attemptId, it)}>
                          {p?.status === "loading" ? "불러오는 중…" : "▶ 듣기"}
                        </button>
                      )}
                      <button
                        type="button"
                        className={s.del}
                        data-testid={`rec-item-delete-${key}`}
                        disabled={busy !== null}
                        onClick={() => void deleteItem(g.attemptId, it)}
                      >
                        {busy === key ? "지우는 중…" : "🗑 지우기"}
                      </button>
                    </div>
                    {p?.status === "error" && <p className={s.error}>{p.message}</p>}
                    {errors[key] && <p className={s.error}>{errors[key]}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {view.orphans.length > 0 && (
        <section className={s.group} aria-label="응시 기록이 없는 이 기기 녹음">
          <div className={s.groupHead}>
            <p className={s.title}>응시 기록이 없는 이 기기 녹음</p>
            <p className={s.meta}>모의고사를 지워 응시 기록이 없는 녹음이에요. 이 기기에만 남아 있어요.</p>
          </div>
          <ul className={s.items}>
            {view.orphans.map((o) => (
              <li key={o.attemptId} className={s.item}>
                <div className={s.itemHead}>
                  <span className={s.part}>{o.qs.map((q) => `Q${q}`).join(" · ")}</span>
                  <span className={s.dim}>{totalLabel(o.totalMs)}</span>
                </div>
                <div className={s.tools}>
                  <button type="button" className={s.del} onClick={() => void deleteOrphan(o.attemptId, o.qs.length)}>
                    🗑 이 기기에서 지우기
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
