/**
 * lib/toeic-rec-manage.ts — "🎙️ 내 녹음" 목록(`/toeic/recordings`)의 순수 묶음 함수 (docs/harness/toeic.md §14-6, SPEC §20-12)
 *
 * 서버 페이지가 넘긴 응시 요약(서버 메타 — 답변 녹음·고칠 문장 녹음·지운 자리)과 이 기기 IndexedDB 메타(lib/toeic-rec-store
 * listAllToeicRecordingMetas)를 합쳐 **응시별 묶음**을 만든다. 같은 함수가 화면과 eval에 쓰인다.
 * - 답변 녹음 항목: 서버 메타가 있거나 이 기기 사본이 있는 문항(지운 자리가 덮는 이 기기 사본은 빼고 `purgeLocal`에 담는다 — 화면이 지운다).
 * - 고칠 문장 녹음 항목: 서버 메타(fixRecordings)만 — 고칠 문장 녹음은 기기 보관소에 넣지 않는다(§14-5).
 * - 응시 기록이 없는(모의고사를 지웠다) 이 기기 사본은 `orphans` — "이 기기에서만 지우기".
 * - 묶음은 최신 응시 먼저, 항목은 문항 순(같은 문항은 답변 → 고칠 문장 순).
 *
 * - **예전 답 녹음 항목**(2026-10-03, docs/harness/toeic.md §15-8): 다시 풀기로 밀려난 답의 녹음(서버 메타 — 이력 줄의 recording)은 `kind:"history"`
 *   ("Q3 · 다시 풀기 전 답")로 따로 보이고 따로 지운다. 이 기기 사본은 세대(retakeId)로 가른다 — 지금 답 세대의 사본만 답변 항목에, 예전 세대의 사본은
 *   그 이력 항목의 "이 기기" 표시에(lib/toeic-retake toeicLocalCopyRole).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 순수 모듈(lib/toeic-mock·lib/toeic-rec-rules·lib/toeic-retake)뿐. firebase-admin·lib/store·lib/ai 값 import 금지.
 */

import { TOEIC_MOCK_PART_NAME_KO, toeicMaxScore, toeicQuestionFormat } from "./toeic-mock";
import {
  isToeicRecQuestion,
  isToeicRecordingTombstoned,
  type ToeicRecordingDeletion,
  type ToeicStoredFixRecording,
  type ToeicStoredRecording,
} from "./toeic-rec-rules";
import { toeicDeletedHistoryLocalCopies, toeicLocalCopyRole } from "./toeic-retake";

/** 서버 페이지 → 화면(줄인 자료 — 피드백 본문·전사문은 넘기지 않는다) */
export interface ToeicRecAttemptSummary {
  id: string;
  mockId: string;
  /** 모의고사(또는 연습 문서) 제목 */
  titleKo: string;
  /** "실전 응시" · "유형 연습 · …" · "공략 연습 · …" */
  scopeLabelKo: string;
  startedAt: string;
  questions: number[];
  answers: { q: number; recorded: boolean; score: number | null }[];
  recordings: ToeicStoredRecording[];
  fixRecordings: ToeicStoredFixRecording[];
  recordingDeletions: ToeicRecordingDeletion[];
  /**
   * 예전 답 이력(§15-8 — 줄인 자료: 녹음 메타·세대 시작·점수·고칠 문장 녹음 수·녹음 지운 시각만). 없으면 다시 푼 적 없음.
   * `recordingDeletedAt`이 있으면 그 줄의 녹음을 지웠다 — 이 기기 사본도 지운다(purgeLocalHistory, QA rec-retake P2-4).
   */
  answerHistory?: {
    q: number;
    replacedBy: string;
    startedAt: string;
    score: number | null;
    recording: ToeicStoredRecording | null;
    fixCount: number;
    recordingDeletedAt: string | null;
  }[];
}

/** 이 기기 메타(lib/toeic-rec-store ToeicRecordingMeta의 쓰는 부분) */
export interface ToeicRecLocalMetaLike {
  attemptId: string;
  q: number;
  durationMs: number;
  size: number;
  createdAt: number;
  upload?: unknown;
  /** 다시 풀기 세대(§15-4) — 없거나 null이면 처음 응시의 녹음 */
  retakeId?: string | null;
}

export type ToeicRecManageItem =
  | {
      kind: "answer";
      q: number;
      partNameKo: string;
      durationMs: number;
      score: number | null;
      maxScore: number;
      /** 서버 메타가 있다 */
      server: boolean;
      /** 이 기기 사본이 있다 */
      local: boolean;
      /** 이 기기 사본이 아직 서버에 없다(대기열 pending) */
      pending: boolean;
    }
  | {
      kind: "fix";
      q: number;
      fixIndex: number;
      partNameKo: string;
      better: string;
      durationMs: number;
      server: true;
      local: false;
      pending: false;
    }
  | {
      /** 다시 풀기로 밀려난 예전 답의 녹음(§15-8) */
      kind: "history";
      q: number;
      replacedBy: string;
      partNameKo: string;
      /** 그 답 세대의 시작 시각 */
      startedAt: string;
      durationMs: number;
      score: number | null;
      maxScore: number;
      server: boolean;
      local: boolean;
      pending: false;
      /** 그 답의 고칠 문장 녹음 수(함께 지워진다) */
      fixCount: number;
    };

export interface ToeicRecManageGroup {
  attemptId: string;
  mockId: string;
  titleKo: string;
  scopeLabelKo: string;
  startedAt: string;
  items: ToeicRecManageItem[];
  answerCount: number;
  fixCount: number;
  /** 예전 답 녹음 수(§15-8) */
  historyCount: number;
  totalMs: number;
}

export interface ToeicRecManageView {
  groups: ToeicRecManageGroup[];
  /** 응시 기록이 없는 이 기기 사본(attemptId별 문항) */
  orphans: { attemptId: string; qs: number[]; totalMs: number; latestAt: number }[];
  /** 지운 자리가 덮는 이 기기 사본 — 화면이 지운다(다른 기기·목록에서 지운 녹음) */
  purgeLocal: { attemptId: string; qs: number[] }[];
  /**
   * 지운 예전 답(이력 줄 recordingDeletedAt)의 이 기기 사본 — 화면이 `deleteToeicRecordingsLocal(attemptId, [q], { keepGeneration })`로 지운다
   * (예전 답 지우기는 지운 자리를 남기지 않아 purgeLocal이 못 본다 — QA rec-retake P2-4).
   */
  purgeLocalHistory: { attemptId: string; q: number; keepGeneration: string | null }[];
}

function partNameOf(q: number): string {
  return isToeicRecQuestion(q) ? TOEIC_MOCK_PART_NAME_KO[toeicQuestionFormat(q).part] : "";
}

/** 서버 요약 + 이 기기 메타 → 응시별 묶음(순수) */
export function buildToeicRecManageView(summaries: readonly ToeicRecAttemptSummary[], localMetas: readonly ToeicRecLocalMetaLike[]): ToeicRecManageView {
  const byAttempt = new Map<string, ToeicRecLocalMetaLike[]>();
  for (const m of localMetas) {
    if (!isToeicRecQuestion(m.q)) continue;
    const list = byAttempt.get(m.attemptId) ?? [];
    list.push(m);
    byAttempt.set(m.attemptId, list);
  }
  const known = new Set(summaries.map((a) => a.id));
  const purgeLocal: ToeicRecManageView["purgeLocal"] = [];
  const purgeLocalHistory: ToeicRecManageView["purgeLocalHistory"] = [];
  const groups: ToeicRecManageGroup[] = [];
  for (const a of summaries) {
    const locals = byAttempt.get(a.id) ?? [];
    const gone = locals.filter((m) => isToeicRecordingTombstoned(a.recordingDeletions, m.q, null, m.createdAt));
    if (gone.length > 0) purgeLocal.push({ attemptId: a.id, qs: [...new Set(gone.map((m) => m.q))].sort((x, y) => x - y) });
    // 세대로 가른다(§15-8) — 지금 답 세대의 사본만 답변 항목에, 예전 세대 사본은 그 이력 항목에
    const hist = a.answerHistory ?? [];
    const roleOf = (m: ToeicRecLocalMetaLike) => toeicLocalCopyRole({ answerHistory: hist }, m.q, m.retakeId ?? null);
    // 지운 예전 답의 이 기기 사본 — 목록에서 빼고 화면이 지운다(지금 답 세대 사본은 keepGeneration으로 남긴다)
    const histGone = toeicDeletedHistoryLocalCopies(
      { answerHistory: hist },
      locals.filter((m) => !gone.includes(m)),
    );
    for (const p of histGone) purgeLocalHistory.push({ attemptId: a.id, q: p.q, keepGeneration: p.keepGeneration });
    const histGoneQ = new Set(histGone.map((p) => p.q));
    const liveLocal = new Map(locals.filter((m) => !gone.includes(m) && roleOf(m).role === "current").map((m) => [m.q, m] as const));
    // 예전 세대 사본 — 키는 `${q}:${replacedBy}`(결과 화면과 같다 — replacedBy만 보면 다른 문항의 사본을 이 줄 것으로 착각한다, QA rec-retake P2-3)
    const histLocal = new Set(
      locals
        .filter((m) => !gone.includes(m))
        .flatMap((m) => {
          const r = roleOf(m);
          return r.role === "history" && !histGoneQ.has(m.q) ? [`${m.q}:${r.replacedBy}`] : [];
        }),
    );
    const serverByQ = new Map(a.recordings.map((r) => [r.q, r] as const));
    const items: ToeicRecManageItem[] = [];
    const qs = [...new Set([...serverByQ.keys(), ...liveLocal.keys()])].filter(isToeicRecQuestion).sort((x, y) => x - y);
    for (const q of qs) {
      const srv = serverByQ.get(q) ?? null;
      const loc = liveLocal.get(q) ?? null;
      const ans = a.answers.find((x) => x.q === q);
      items.push({
        kind: "answer",
        q,
        partNameKo: partNameOf(q),
        durationMs: srv?.durationMs ?? loc?.durationMs ?? 0,
        score: ans?.score ?? null,
        maxScore: toeicMaxScore(q),
        server: srv !== null,
        local: loc !== null,
        pending: srv === null && loc !== null && loc.upload !== "done" && loc.upload !== "gone",
      });
    }
    for (const f of a.fixRecordings) {
      if (!isToeicRecQuestion(f.q)) continue;
      items.push({ kind: "fix", q: f.q, fixIndex: f.fixIndex, partNameKo: partNameOf(f.q), better: f.better, durationMs: f.durationMs, server: true, local: false, pending: false });
    }
    for (const h of hist) {
      if (!isToeicRecQuestion(h.q)) continue;
      const local = histLocal.has(`${h.q}:${h.replacedBy}`);
      if (!h.recording && !local) continue;
      items.push({
        kind: "history",
        q: h.q,
        replacedBy: h.replacedBy,
        partNameKo: partNameOf(h.q),
        startedAt: h.startedAt,
        durationMs: h.recording?.durationMs ?? 0,
        score: h.score,
        maxScore: toeicMaxScore(h.q),
        server: h.recording !== null,
        local,
        pending: false,
        fixCount: h.fixCount,
      });
    }
    if (items.length === 0) continue;
    const kindRank = (k: ToeicRecManageItem["kind"]) => (k === "answer" ? 0 : k === "fix" ? 1 : 2);
    items.sort(
      (x, y) =>
        x.q - y.q ||
        kindRank(x.kind) - kindRank(y.kind) ||
        (x.kind === "fix" && y.kind === "fix" ? x.fixIndex - y.fixIndex : 0) ||
        (x.kind === "history" && y.kind === "history" ? (x.startedAt < y.startedAt ? -1 : x.startedAt > y.startedAt ? 1 : 0) : 0),
    );
    groups.push({
      attemptId: a.id,
      mockId: a.mockId,
      titleKo: a.titleKo,
      scopeLabelKo: a.scopeLabelKo,
      startedAt: a.startedAt,
      items,
      answerCount: items.filter((i) => i.kind === "answer").length,
      fixCount: items.filter((i) => i.kind === "fix").length,
      historyCount: items.filter((i) => i.kind === "history").length,
      totalMs: items.reduce((s, i) => s + (Number.isFinite(i.durationMs) ? i.durationMs : 0), 0),
    });
  }
  groups.sort((x, y) => (x.startedAt < y.startedAt ? 1 : x.startedAt > y.startedAt ? -1 : x.attemptId < y.attemptId ? -1 : 1));
  const orphans: ToeicRecManageView["orphans"] = [];
  for (const [attemptId, list] of byAttempt) {
    if (known.has(attemptId)) continue;
    orphans.push({
      attemptId,
      qs: [...new Set(list.map((m) => m.q))].sort((x, y) => x - y),
      totalMs: list.reduce((s, m) => s + (Number.isFinite(m.durationMs) ? m.durationMs : 0), 0),
      latestAt: Math.max(...list.map((m) => m.createdAt)),
    });
  }
  orphans.sort((x, y) => y.latestAt - x.latestAt);
  return { groups, orphans, purgeLocal, purgeLocalHistory };
}

/** 묶음 하나를 지운 뒤(응시 통째) — 화면 상태에서 그 응시 묶음을 뺀다 */
export function withoutToeicRecGroup(view: ToeicRecManageView, attemptId: string): ToeicRecManageView {
  return { ...view, groups: view.groups.filter((g) => g.attemptId !== attemptId) };
}

/** 항목 하나를 지운 뒤 — 그 항목을 빼고, 항목이 0이면 묶음도 뺀다(합계 다시 셈) */
export function withoutToeicRecItem(
  view: ToeicRecManageView,
  attemptId: string,
  item: { kind: "answer"; q: number } | { kind: "fix"; q: number; fixIndex: number } | { kind: "history"; q: number; replacedBy: string },
): ToeicRecManageView {
  const groups: ToeicRecManageGroup[] = [];
  for (const g of view.groups) {
    if (g.attemptId !== attemptId) {
      groups.push(g);
      continue;
    }
    const same = (i: ToeicRecManageItem) =>
      i.kind === item.kind &&
      i.q === item.q &&
      (i.kind !== "fix" || (item.kind === "fix" && i.fixIndex === item.fixIndex)) &&
      (i.kind !== "history" || (item.kind === "history" && i.replacedBy === item.replacedBy));
    const items = g.items.filter((i) => !same(i));
    if (items.length === 0) continue;
    groups.push({
      ...g,
      items,
      answerCount: items.filter((i) => i.kind === "answer").length,
      fixCount: items.filter((i) => i.kind === "fix").length,
      historyCount: items.filter((i) => i.kind === "history").length,
      totalMs: items.reduce((s, i) => s + i.durationMs, 0),
    });
  }
  return { ...view, groups };
}
