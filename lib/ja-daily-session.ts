/**
 * lib/ja-daily-session.ts — 회차 n에 필요한 내용을 한 번에 모은다(GET /api/japanese/daily/session/[n]). 순수 — 저장소·시계 없음.
 *
 * 과정 엔진(lib/ja-daily-plan)이 정한 칸 배정을 실제 내용(과·단어·청해·모의 문항)으로 푼다. "약한 것"(약한 과·단어·문항)은
 * 기록에서 이 자리에서 고른다 — 과정 자체는 내용만으로 정해지고(결정적), 약한 것만 그때의 기록을 본다.
 *
 * - 약한 과 다시 하기: 약한 과 순위에서 (n − 첫 다시 하기 회차) 번째(돌아가며). 과 전체 트랙 + 그 과의 🎤.
 * - 채점표(mockScore): 그 회차 **실전(mockSection) 진도 기록의 답만**으로(`jaDailyMockRealAnswers`).
 * - 오답 다시 풀기(mockReview): 그 회차 문항 중 **최신 답이 틀린 것** + 실전에서 안 풀고 그 뒤로도 맞힌 적 없는 것.
 * - 총정리(final)·약한 문항(weakItems): pickWeakItems가 고른 청해·모의 문항.
 */
import type {
  JaDailyLesson,
  JaDailyListeningItem,
  JaDailyListeningTip,
  JaDailyMock,
  JaDailyVocabDay,
  JaDailyWord,
} from "./ja-daily-content";
import {
  latestJaDailyExamAnswers,
  scoreJaDailyMock,
  toJaDailyContentIndex,
  type JaDailyContentRecord,
  type JaDailyExamView,
  type JaDailyKaiwaView,
  type JaDailyMockItemView,
  type JaDailySessionOk,
  type JaDailySessionRecord,
  type JaDailyVocabView,
} from "./ja-daily-contract";
import {
  buildJaDailyCourse,
  jaDailySessionAt,
  nextJaDailySession,
  pickWeakItems,
  pickWeakLessons,
  pickWeakWords,
  type JaDailySession,
} from "./ja-daily-plan";

export type ResolveJaDailyResult =
  | JaDailySessionOk
  | { ok: false; error: "no_content"; messageKo: string }
  | { ok: false; error: "ahead"; messageKo: string; nextN: number }
  | { ok: false; error: "invalid_input"; messageKo: string };

function mockItemViews(mock: JaDailyMock, keep: (id: string) => boolean): JaDailyMockItemView[] {
  const out: JaDailyMockItemView[] = [];
  for (const s of mock.sections) {
    for (const it of s.items) {
      if (!keep(it.id)) continue;
      const p = it.passageId ? (s.passages ?? []).find((x) => x.id === it.passageId) ?? null : null;
      out.push({
        round: mock.round,
        section: s.section,
        mondai: s.mondai,
        points: s.points,
        instructionJa: s.instructionJa ?? null,
        instructionKo: s.instructionKo ?? null,
        passage: p ? { id: p.id, ja: p.ja, ko: p.ko ?? null, introJa: p.introJa ?? null } : null,
        item: it,
      });
    }
  }
  return out;
}

/** 지정한 id 순서대로 모의 문항 보기를 모은다(여러 회차) */
function mockViewsByIds(mocks: readonly JaDailyMock[], ids: readonly string[]): JaDailyMockItemView[] {
  const want = new Set(ids);
  const all = mocks.flatMap((m) => mockItemViews(m, (id) => want.has(id)));
  const byId = new Map(all.map((v) => [v.item.id, v] as const));
  return ids.map((id) => byId.get(id)).filter((v): v is JaDailyMockItemView => v !== undefined);
}

function vocabPool(days: readonly JaDailyVocabDay[], centerDays: readonly number[]): JaDailyWord[] {
  const sorted = [...days].sort((a, b) => a.day - b.day);
  const want = new Set<number>();
  for (const d of centerDays) {
    const i = sorted.findIndex((x) => x.day === d);
    if (i < 0) continue;
    for (const j of [i - 1, i, i + 1]) if (sorted[j]) want.add(sorted[j].day);
  }
  return sorted.filter((d) => want.has(d.day)).flatMap((d) => d.words);
}

/**
 * 모의 round 회차의 **실전 답**(채점표 84회·홈 실전 점수의 단일 정의처 — QA daily-full P2-A).
 * 그 round의 mockSection 회차(과정 엔진이 정한 n들)의 **진도 기록**(replay 아님)에 든 답만 쓴다. 85·86 오답 다시 풀기·총정리·다시 하기의
 * 답은 섞지 않는다 — 실전 성적이 복습 결과로 부풀지 않게. 같은 회차를 진도로 두 번 저장했으면 finishedAt 순으로 뒤의 것.
 * hasExam = 그 round에 mockSection 회차가 과정에 있는가(1회처럼 실전 없이 문항 연습만 한 회차면 false).
 */
export function jaDailyMockRealAnswers(
  course: readonly JaDailySession[],
  records: readonly JaDailySessionRecord[],
  round: number,
): { answers: Map<string, { choice: number | null; correct: boolean | null }>; hasExam: boolean } {
  const ns = new Set(course.filter((c) => c.exam.type === "mockSection" && c.exam.round === round).map((c) => c.n));
  const real = records.filter((r) => !r.replay && r.finishedAt !== null && ns.has(r.n));
  const answers = latestJaDailyExamAnswers(real);
  for (const [id, a] of [...answers]) if (a.correct === null) answers.delete(id);
  return { answers, hasExam: ns.size > 0 };
}

export function resolveJaDailySession(n: number, content: readonly JaDailyContentRecord[], sessions: readonly JaDailySessionRecord[]): ResolveJaDailyResult {
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: "invalid_input", messageKo: "회차 번호가 올바르지 않아요." };
  const index = toJaDailyContentIndex(content);
  const course = buildJaDailyCourse(index);
  if (course.length === 0) return { ok: false, error: "no_content", messageKo: "먼저 내용 파일을 가져와 주세요." };
  const next = nextJaDailySession(course, sessions);
  if (n > next.n) return { ok: false, error: "ahead", messageKo: `아직 그 회차 차례가 아니에요 — 지금은 Day ${next.n} 차례예요.`, nextN: next.n };
  const session = jaDailySessionAt(course, n) as JaDailySession;

  const lessons = content.filter((r) => r.kind === "lesson").map((r) => r.data as JaDailyLesson);
  const days = content.filter((r) => r.kind === "vocab").map((r) => r.data as JaDailyVocabDay);
  const tips = content.filter((r) => r.kind === "tip").map((r) => r.data as JaDailyListeningTip);
  const litems = content.filter((r) => r.kind === "litem").map((r) => r.data as JaDailyListeningItem);
  const mocks = content.filter((r) => r.kind === "mock").map((r) => r.data as JaDailyMock).sort((a, b) => a.round - b.round);
  const finished = sessions.filter((s) => s.finishedAt !== null);

  // ── 🗣️ 회화 ──
  let kaiwa: JaDailyKaiwaView = { type: "empty" };
  const lessonHead = (l: JaDailyLesson) => ({ id: l.id, step: l.step, lesson: l.lesson, kind: l.kind, titleJa: l.titleJa, titleKo: l.titleKo, pointsKo: l.pointsKo });
  if (session.kaiwa.type === "unit") {
    const slot = session.kaiwa;
    const l = lessons.find((x) => x.id === slot.lessonId);
    if (l) {
      const keys = new Set(slot.trackKeys);
      kaiwa = { type: "unit", lesson: lessonHead(l), unit: slot.unit, tracks: l.tracks.filter((t) => keys.has(t.audioKey)), keyLineIds: slot.keyLineIds, withPoints: slot.withPoints, review: false };
    }
  } else {
    const ranking = pickWeakLessons(finished, index.lessons);
    if (ranking.length > 0) {
      const firstReview = course.find((s) => s.kaiwa.type === "review")?.n ?? n;
      const k = ((n - firstReview) % ranking.length + ranking.length) % ranking.length;
      const l = lessons.find((x) => x.id === ranking[k]);
      if (l) kaiwa = { type: "unit", lesson: lessonHead(l), unit: "다시", tracks: l.tracks, keyLineIds: [...l.keyLineIds], withPoints: true, review: true };
    }
  }

  // ── 📚 단어 ──
  let vocab: JaDailyVocabView;
  const v = session.vocab;
  if (v.type === "cards" || v.type === "dayTest") {
    const d = days.find((x) => x.day === v.day);
    const words = d ? (v.type === "cards" ? d.words.slice(v.from - 1, v.to) : d.words) : [];
    vocab = { mode: v.type, day: v.day, words, pool: vocabPool(days, [v.day]) };
  } else {
    const ids = pickWeakWords(finished);
    const byId = new Map(days.flatMap((d) => d.words.map((w) => [w.id, { w, day: d.day }] as const)));
    const picked = ids.map((id) => byId.get(id)).filter((x): x is { w: JaDailyWord; day: number } => x !== undefined);
    vocab = { mode: "weak", day: null, words: picked.map((x) => x.w), pool: vocabPool(days, [...new Set(picked.map((x) => x.day))]) };
  }

  // ── 📝 시험 대비 ──
  const e = session.exam;
  let exam: JaDailyExamView = { type: "empty" };
  const latest = latestJaDailyExamAnswers(finished);
  if (e.type === "tip") {
    const tip = tips.find((t) => t.id === e.tipId);
    if (tip) exam = { type: "tip", tip, examples: litems.filter((it) => it.example === true && it.audioKey === tip.audioKey) };
  } else if (e.type === "litems") {
    const byId = new Map(litems.map((it) => [it.id, it] as const));
    exam = { type: "litems", items: e.itemIds.map((id) => byId.get(id)).filter((x): x is JaDailyListeningItem => x !== undefined) };
  } else if (e.type === "mockItems") {
    exam = { type: "mockItems", round: e.round, items: mockViewsByIds(mocks, e.itemIds) };
  } else if (e.type === "mockSection") {
    const m = mocks.find((x) => x.round === e.round);
    const secs = new Set<string>(e.sections);
    if (m) exam = { type: "mockSection", round: e.round, items: mockItemViews({ ...m, sections: m.sections.filter((s) => secs.has(s.section)) }, () => true) };
  } else if (e.type === "mockScore" || e.type === "mockReview") {
    const m = mocks.find((x) => x.round === e.round);
    if (m) {
      const real = jaDailyMockRealAnswers(course, finished, e.round);
      if (e.type === "mockScore") {
        const score = scoreJaDailyMock(m, real.answers);
        const show = new Set([...score.wrongItemIds, ...score.unansweredItemIds]);
        exam = { type: "mockScore", round: e.round, score, items: mockItemViews(m, (id) => show.has(id)) };
      } else {
        // 최신 답이 틀린 문항 + (실전이 있던 회차면) 실전에서 안 풀고 그 뒤로도 맞힌 적 없는 문항(QA daily-full P3-4)
        const keep = (id: string) => latest.get(id)?.correct === false || (real.hasExam && !real.answers.has(id) && latest.get(id)?.correct !== true);
        exam = { type: "mockReview", round: e.round, items: mockItemViews(m, keep) };
      }
    }
  } else {
    const ids = pickWeakItems(finished);
    const lById = new Map(litems.map((it) => [it.id, it] as const));
    exam = {
      type: e.type,
      litems: ids.map((id) => lById.get(id)).filter((x): x is JaDailyListeningItem => x !== undefined),
      mockItems: mockViewsByIds(mocks, ids.filter((id) => !lById.has(id))),
    };
  }

  return {
    ok: true,
    n,
    total: course.length,
    nextN: next.n,
    replay: n < next.n,
    session,
    kaiwa,
    vocab,
    exam,
  };
}
