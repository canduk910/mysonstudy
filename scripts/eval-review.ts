/**
 * scripts/eval-review.ts — 오늘의 복습(간격 반복 + 힌트 사다리) 회귀 가드 (docs/SPEC.md §23). **실호출 0회 · 네트워크 0 · 저장소 쓰기 0.**
 *
 * 대상: 순수 엔진 lib/review-schedule.ts(간격 전이·판정·큐·스트릭 입력·요약·정규화·문서 id), 어댑터 lib/review-sources.ts
 * (단서·힌트·정답·발음 재료, 시험 본 항목만), 공개 기록 함수 lib/review-server.ts recordReview(가짜 저장소 주입),
 * 배선 정적 점검(저장소 두 백엔드·시드·스트릭 라우트·표현 도우미 차단·러너 비용 0·번들 경계).
 * 데이터는 전부 지어낸 것이다(교재 문장 없음). "오늘"은 인자로 주입한다(시계 의존 없음 — 결정성).
 */

import { readFileSync } from "node:fs";
import {
  REVIEW_AREAS,
  REVIEW_DAILY_CAP,
  REVIEW_HISTORY_MAX,
  REVIEW_INTERVAL_DAYS,
  REVIEW_KINDS,
  REVIEW_KIND_AREA,
  REVIEW_MAX_STEP,
  buildReviewQueue,
  decideReview,
  effectiveJudge,
  isReviewItemKeyOfArea,
  nextReviewStep,
  normalizeReviewSchedule,
  parseReviewItemKey,
  reviewDocId,
  reviewIntervalLabelKo,
  reviewItemKey,
  reviewScheduleData,
  reviewStreakSessions,
  reviewTodayLabel,
  summarizeReviewResults,
  type ReviewHintLevel,
  type ReviewJudge,
  type ReviewQueueCandidate,
  type ReviewScheduleRecord,
} from "../lib/review-schedule";
import {
  englishWordItems,
  firstLetterHint,
  frameForDisplay,
  japaneseKanjiItems,
  japaneseWordItems,
  kanaSkeleton,
  latinSkeleton,
  maskAnswerInCue,
  toeicExpressionItems,
  toeicTemplateItems,
  toeicIslandItems,
  islandFrameSkeleton,
  wordUnderscores,
  type QuizSessionLike,
} from "../lib/review-sources";
import { computeStreak } from "../lib/streak";
import { kstDateString, kstTodayString, shiftDateString } from "../lib/kst";
import { PHRASE_HELPER_EXAM_PATHS, isPhraseHelperExamPath } from "../lib/phrase-helper-scope";

// 네트워크 차단 — 이 eval은 어떤 요청도 보내지 않는다(두 겹 방어)
globalThis.fetch = (() => {
  throw new Error("eval:review는 네트워크를 쓰지 않는다");
}) as typeof fetch;

interface CheckResult {
  area: string;
  check: string;
  pass: boolean;
  detail: string;
}
const results: CheckResult[] = [];
const add = (area: string, check: string, pass: boolean, detail = "") => results.push({ area, check, pass, detail });
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");

const TODAY = "2026-10-03";
const NOW = "2026-10-03T03:00:00.000Z";
const HL: ReviewHintLevel[] = [0, 1, 2, 3];
const JG: ReviewJudge[] = ["got", "unsure", "forgot"];

// ---------------------------------------------------------------------------
// 1) 상수·키
// ---------------------------------------------------------------------------
{
  const A = "상수·키";
  add(A, "간격 사다리 1 → 3 → 7 → 14 → 30 · 하루 상한 20", JSON.stringify(REVIEW_INTERVAL_DAYS) === "[1,3,7,14,30]" && REVIEW_DAILY_CAP === 20 && REVIEW_MAX_STEP === 4, `${REVIEW_INTERVAL_DAYS} cap=${REVIEW_DAILY_CAP}`);
  add(A, "종류마다 영역이 있다(세 영역 모두 출처 ≥ 1)", REVIEW_KINDS.every((k) => REVIEW_AREAS.includes(REVIEW_KIND_AREA[k])) && REVIEW_AREAS.every((a) => REVIEW_KINDS.some((k) => REVIEW_KIND_AREA[k] === a)));
  const k = reviewItemKey("toeic-expr", " hand out / flyers ");
  add(A, "항목 키 = `{종류}:{원본}`(trim) · 왕복", k === "toeic-expr:hand out / flyers" && parseReviewItemKey(k)?.raw === "hand out / flyers" && parseReviewItemKey(k)?.kind === "toeic-expr", k);
  const bad = ["", "en-word:", "nope:x", ":x", "en-word: x", "en-word:x\n", "en-word:" + "a".repeat(400), 42, null];
  add(A, "깨진 항목 키는 거부(빈 원본·모르는 종류·앞뒤 공백·제어 문자·길이 초과·비문자열)", bad.every((b) => parseReviewItemKey(b) === null));
  add(A, "영역 소속 판정 — 일본어 키는 토익 영역이 아니다", isReviewItemKeyOfArea("ja-word:猫", "japanese") && !isReviewItemKeyOfArea("ja-word:猫", "toeic") && isReviewItemKeyOfArea("toeic-template:t1", "toeic"));
  const ids = ["toeic-expr:a/b", "toeic-expr:a b", "toeic-expr:A b", "ja-word:猫", "ja-kanji:猫"].map((x) => reviewDocId(REVIEW_KIND_AREA[parseReviewItemKey(x)!.kind], x));
  add(A, "문서 id — 결정적·서로 다름·`/` 없음·Firestore 예약형 아님", new Set(ids).size === ids.length && ids.every((i) => !i.includes("/") && !/^__.*__$/.test(i) && i.length < 80) && reviewDocId("toeic", "toeic-expr:a/b") === ids[0], ids.join(" "));
}

// ---------------------------------------------------------------------------
// 2) 간격 전이 — 전수(단계 5 × 연속 3 × 힌트 4 × 판정 3 = 180), 독립 참조 표와 대조
// ---------------------------------------------------------------------------
{
  const A = "간격 전이";
  // 독립 참조 모델(스펙 §23-3 표를 그대로 옮김 — 엔진 코드를 보지 않고 쓴 것)
  const ref = (step: number, streak: number, h: ReviewHintLevel, j: ReviewJudge) => {
    if (h === 3 || j === "forgot") return { step: 0, streak: 0, judge: "forgot" as ReviewJudge };
    let d = 0;
    let st = 0;
    if (j === "got") {
      if (h === 0) {
        d = streak >= 1 ? 2 : 1;
        st = streak + 1;
      } else if (h === 1) d = 1;
    } else if (h === 0) d = 1;
    return { step: Math.min(4, step + d), streak: st, judge: j };
  };
  let n = 0;
  const bad: string[] = [];
  for (let step = 0; step <= 4; step++)
    for (const streak of [0, 1, 2])
      for (const h of HL)
        for (const j of JG) {
          n += 1;
          const got = nextReviewStep({ step, streak }, { hintLevel: h, judge: j });
          const want = ref(step, streak, h, j);
          if (got.step !== want.step || got.streak !== want.streak || got.judge !== want.judge) bad.push(`s${step}/k${streak}/h${h}/${j}: ${JSON.stringify(got)}≠${JSON.stringify(want)}`);
        }
  add(A, `전수 ${n}조합이 참조 표와 같다`, n === 180 && bad.length === 0, bad.slice(0, 4).join(" · "));
  add(A, "정답 봄(힌트 단계 3)은 판정과 무관하게 몰랐어요", JG.every((j) => effectiveJudge({ hintLevel: 3, judge: j }) === "forgot"));
  add(A, "힌트 없이 맞힘 → 처음 +1(3일), 연속이면 +2", nextReviewStep({ step: 0, streak: 0 }, { hintLevel: 0, judge: "got" }).step === 1 && nextReviewStep({ step: 1, streak: 1 }, { hintLevel: 0, judge: "got" }).step === 3);
  add(A, "힌트1 → 한 칸 · 힌트2 → 그대로 · 몰랐어요 → 0(1일)", nextReviewStep({ step: 2, streak: 3 }, { hintLevel: 1, judge: "got" }).step === 3 && nextReviewStep({ step: 2, streak: 3 }, { hintLevel: 2, judge: "got" }).step === 2 && nextReviewStep({ step: 4, streak: 3 }, { hintLevel: 0, judge: "forgot" }).step === 0);
  add(A, "30일에서 더 가도 30일 유지(단계 4 고정)", nextReviewStep({ step: 4, streak: 5 }, { hintLevel: 0, judge: "got" }).step === 4 && nextReviewStep({ step: 3, streak: 1 }, { hintLevel: 0, judge: "got" }).step === 4);
  add(A, "깨진 이전 단계(음수·NaN·99)는 0..4로 자른다", nextReviewStep({ step: -3, streak: -1 }, { hintLevel: 1, judge: "got" }).step === 1 && nextReviewStep({ step: Number.NaN, streak: 0 }, { hintLevel: 2, judge: "got" }).step === 0 && nextReviewStep({ step: 99, streak: 0 }, { hintLevel: 2, judge: "got" }).step === 4);
  // 사다리를 끝까지: 힌트 없이 계속 맞히면 1 → 3 → 14 → 30 → 30
  let rec: ReviewScheduleRecord | null = null;
  let day = TODAY;
  const path: number[] = [];
  for (let i = 0; i < 5; i++) {
    const d = decideReview(rec, { area: "english", itemKey: "en-word:apple", outcome: { hintLevel: 0, judge: "got" }, todayKst: day, nowIso: `${day}T03:00:00.000Z` });
    rec = d.record;
    path.push(REVIEW_INTERVAL_DAYS[rec.step]);
    day = rec.dueOn;
  }
  add(A, "힌트 없이 연속 맞힘 사다리 = 3 → 14 → 30 → 30 → 30(첫 +1, 이후 +2)", path.join(",") === "3,14,30,30,30", path.join(","));
}

// ---------------------------------------------------------------------------
// 3) 판정 적용 — decideReview
// ---------------------------------------------------------------------------
{
  const A = "판정 적용";
  const first = decideReview(null, { area: "japanese", itemKey: "ja-word:猫", outcome: { hintLevel: 1, judge: "got" }, todayKst: TODAY, nowIso: NOW });
  const r = first.record;
  add(A, "처음 들어오는 항목: 단계 0에서 출발 → 힌트1 맞힘 = 단계 1 · 다음 복습 3일 뒤", first.kind === "applied" && r.step === 1 && r.dueOn === "2026-10-06" && r.lastReviewedOn === TODAY && r.reviewCount === 1 && r.history.length === 1 && r.createdAt === NOW && r.id === reviewDocId("japanese", "ja-word:猫"), JSON.stringify({ s: r.step, d: r.dueOn }));
  const again = decideReview(r, { area: "japanese", itemKey: "ja-word:猫", outcome: { hintLevel: 0, judge: "got" }, todayKst: TODAY, nowIso: "2026-10-03T05:00:00.000Z" });
  add(A, "같은 날 같은 항목 두 번째 → already_today, 레코드 그대로(이중 적용 0)", again.kind === "already_today" && JSON.stringify(again.record) === JSON.stringify(normalizeReviewSchedule(r)));
  const next = decideReview(r, { area: "japanese", itemKey: "ja-word:猫", outcome: { hintLevel: 3, judge: "got" }, todayKst: "2026-10-06", nowIso: "2026-10-06T03:00:00.000Z" });
  add(A, "다음 복습일에 정답 봄 → 1일(내일)·연속 0·이력 2줄·createdAt 유지", next.kind === "applied" && next.record.step === 0 && next.record.dueOn === "2026-10-07" && next.record.lastJudge === "forgot" && next.record.history.length === 2 && next.record.createdAt === NOW && next.record.reviewCount === 2);
  let thrown = 0;
  for (const bad of [
    { area: "toeic" as const, itemKey: "ja-word:猫" },
    { area: "japanese" as const, itemKey: "nope" },
  ]) {
    try {
      decideReview(null, { ...bad, outcome: { hintLevel: 0, judge: "got" }, todayKst: TODAY, nowIso: NOW });
    } catch (e) {
      if (e instanceof RangeError) thrown += 1;
    }
  }
  try {
    decideReview(null, { area: "japanese", itemKey: "ja-word:猫", outcome: { hintLevel: 0, judge: "got" }, todayKst: "2026-02-30", nowIso: NOW });
  } catch (e) {
    if (e instanceof RangeError) thrown += 1;
  }
  add(A, "영역·키 불일치·깨진 키·달력 밖 오늘은 RangeError(프로그래밍 오류)", thrown === 3, `${thrown}/3`);
  // 이력 상한
  let rec: ReviewScheduleRecord | null = null;
  let day = TODAY;
  for (let i = 0; i < REVIEW_HISTORY_MAX + 7; i++) {
    rec = decideReview(rec, { area: "english", itemKey: "en-word:cat", outcome: { hintLevel: 3, judge: "forgot" }, todayKst: day, nowIso: `${day}T03:00:00.000Z` }).record;
    day = shiftDateString(day, 1);
  }
  add(A, `이력은 최근 ${REVIEW_HISTORY_MAX}줄만(reviewCount는 전체)`, rec!.history.length === REVIEW_HISTORY_MAX && rec!.reviewCount === REVIEW_HISTORY_MAX + 7 && rec!.history[0].on === shiftDateString(TODAY, 7));
}

// ---------------------------------------------------------------------------
// 4) KST 경계 — 자정 전후는 다른 날
// ---------------------------------------------------------------------------
{
  const A = "KST 경계";
  const t1 = kstTodayString(new Date("2026-10-03T14:59:59.000Z")); // 23:59:59 KST
  const t2 = kstTodayString(new Date("2026-10-03T15:00:00.000Z")); // 다음날 00:00 KST
  const a = decideReview(null, { area: "english", itemKey: "en-word:moon", outcome: { hintLevel: 2, judge: "got" }, todayKst: t1, nowIso: "2026-10-03T14:59:59.000Z" });
  const b = decideReview(a.record, { area: "english", itemKey: "en-word:moon", outcome: { hintLevel: 2, judge: "got" }, todayKst: t2, nowIso: "2026-10-03T15:00:00.000Z" });
  add(A, "23:59 KST와 00:00 KST는 다른 날 — 두 번째도 적용(UTC 날짜는 같아도)", t1 === "2026-10-03" && t2 === "2026-10-04" && a.kind === "applied" && b.kind === "applied" && b.record.dueOn === "2026-10-05", `${t1}→${t2} due ${b.record.dueOn}`);
  const c = decideReview(a.record, { area: "english", itemKey: "en-word:moon", outcome: { hintLevel: 0, judge: "got" }, todayKst: kstTodayString(new Date("2026-10-02T15:00:00.000Z")), nowIso: "2026-10-02T15:00:00.000Z" });
  add(A, "00:00 KST(전날 15:00Z)도 같은 KST 날이면 already_today", c.kind === "already_today");
  const sess = reviewStreakSessions([b.record]);
  add(A, "스트릭 입력 startedAt은 그날 KST 00:00 — kstDateString이 그날로 접는다", sess.length === 2 && sess.every((x, i) => kstDateString(x.startedAt) === [t1, t2][i]), sess.map((x) => x.startedAt).join(" "));
  add(A, "월말·연말 경계 다음 복습일", decideReview(null, { area: "english", itemKey: "en-word:x", outcome: { hintLevel: 1, judge: "got" }, todayKst: "2026-12-30", nowIso: NOW }).record.dueOn === "2027-01-02");
}

// ---------------------------------------------------------------------------
// 5) 오늘 큐 — 정렬·상한·중복·고아·처음 들어오는 항목
// ---------------------------------------------------------------------------
function sched(itemKey: string, dueOn: string, extra: Partial<ReviewScheduleRecord> = {}): ReviewScheduleRecord {
  const p = parseReviewItemKey(itemKey)!;
  return {
    id: reviewDocId(REVIEW_KIND_AREA[p.kind], itemKey),
    area: REVIEW_KIND_AREA[p.kind],
    kind: p.kind,
    itemKey,
    step: 1,
    dueOn,
    streak: 0,
    lastJudge: "got",
    lastHintLevel: 1,
    lastReviewedOn: shiftDateString(dueOn, -3),
    reviewCount: 1,
    history: [{ on: shiftDateString(dueOn, -3), at: NOW, hintLevel: 1, judge: "got", step: 1 }],
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}
const cand = (itemKey: string, attempts = 1, wrongCount = 0, lastTestedAt: string | null = "2026-09-01T00:00:00.000Z"): ReviewQueueCandidate => ({ itemKey, attempts, wrongCount, lastTestedAt });
{
  const A = "오늘 큐";
  const schedules = [
    sched("en-word:b", "2026-09-30"),
    sched("en-word:a", "2026-09-28"),
    sched("en-word:c", TODAY, { lastJudge: "forgot" }),
    sched("en-word:d", TODAY),
    sched("en-word:future", "2026-10-04"),
    sched("en-word:done", "2026-10-10", { lastReviewedOn: TODAY }),
    sched("en-word:orphan", "2026-09-01"),
  ];
  const candidates = [
    cand("en-word:d"),
    cand("en-word:new-ok", 2, 0, "2026-08-01T00:00:00.000Z"),
    cand("en-word:new-wrong", 2, 1),
    cand("en-word:new-untested", 0, 0, null),
    cand("en-word:a"),
    cand("en-word:b"),
    cand("en-word:c"),
    cand("en-word:future"),
    cand("en-word:done"),
    cand("en-word:a"), // 중복
    cand("bad key"),
  ];
  const q = buildReviewQueue({ candidates, schedules, todayKst: TODAY });
  const order = q.entries.map((e) => e.itemKey.slice(8)).join(",");
  add(A, "순서: 밀린 것 오래된 순 → 오늘(틀린 기록 먼저 → 일정 있는 것 → 처음 들어오는 것 중 틀린 것 → 오래 전에 시험 본 것)", order === "a,b,c,new-wrong,d,new-ok", order);
  add(A, "제외: 미래 복습일·오늘 이미 한 것·고아 일정·시험 안 본 새 항목·깨진 키·중복", !/future|done|orphan|untested/.test(order) && q.entries.length === new Set(q.entries.map((e) => e.itemKey)).size);
  add(A, "doneToday = 오늘 복습한 일정 수(1) · dueCount 6 · 처음 들어오는 항목은 dueOn=오늘·overdue 0", q.doneToday === 1 && q.dueCount === 6 && q.entries.find((e) => e.itemKey === "en-word:new-ok")?.dueOn === TODAY && q.entries[0].overdueDays === 5);
  // 상한 20 — 35개 후보, 오늘 이미 3개 함 → 17개
  const many = Array.from({ length: 35 }, (_, i) => cand(`en-word:w${String(i).padStart(2, "0")}`, 1, i % 3, `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`));
  const doneS = [0, 1, 2].map((i) => sched(`en-word:x${i}`, "2026-10-20", { lastReviewedOn: TODAY }));
  const q2 = buildReviewQueue({ candidates: many, schedules: doneS, todayKst: TODAY });
  const q3 = buildReviewQueue({ candidates: many, schedules: [], todayKst: TODAY });
  const q4 = buildReviewQueue({ candidates: many, schedules: Array.from({ length: 21 }, (_, i) => sched(`en-word:y${i}`, "2026-10-20", { lastReviewedOn: TODAY })), todayKst: TODAY });
  add(A, "하루 상한 20: 새로 35개 → 20 · 오늘 3개 했으면 17 · 21개 했으면 0(음수 아님)", q3.entries.length === 20 && q3.dueCount === 35 && q2.entries.length === 17 && q4.entries.length === 0, `${q3.entries.length}/${q2.entries.length}/${q4.entries.length}`);
  add(A, "상한 안 = 틀린 기록이 있는 것부터(처음 들어오는 35개 중 틀린 23개 먼저)", q3.entries.slice(0, 20).every((e) => e.priority));
  // 결정성 — 입력 순서를 뒤섞어도 같은 큐
  const shuffled = [...candidates].reverse();
  const qs = buildReviewQueue({ candidates: shuffled, schedules: [...schedules].reverse(), todayKst: TODAY });
  add(A, "결정성: 후보·일정 순서를 뒤집어도 같은 큐", JSON.stringify(qs.entries) === JSON.stringify(q.entries));
  add(A, "다음 날(시계 주입) — 오늘 한 것은 내일 큐에 다시 오지 않는다(dueOn ≥ 내일인 것은 그날부터)", buildReviewQueue({ candidates: [cand("en-word:done")], schedules: [sched("en-word:done", "2026-10-04", { lastReviewedOn: TODAY })], todayKst: "2026-10-04" }).entries.length === 1 && buildReviewQueue({ candidates: [cand("en-word:done")], schedules: [sched("en-word:done", "2026-10-04", { lastReviewedOn: TODAY })], todayKst: TODAY }).entries.length === 0);
}

// ---------------------------------------------------------------------------
// 6) 정규화 — 두 백엔드 공유, 던지지 않는다
// ---------------------------------------------------------------------------
{
  const A = "정규화";
  const good = sched("ja-kanji:猫", TODAY);
  const n = normalizeReviewSchedule({ ...good, id: "tampered", step: 9, streak: -2, history: [...good.history, { on: "x" }, null, { on: TODAY, at: NOW, hintLevel: 7, judge: "got", step: 0 }] });
  add(A, "id는 키에서 다시 계산 · 단계 0..4로 자름 · 음수 연속 0 · 깨진 이력 줄 버림", n !== null && n.id === good.id && n.step === 4 && n.streak === 0 && n.history.length === 1);
  const broken = [null, 3, {}, { ...good, itemKey: "nope" }, { ...good, area: "toeic" }, { ...good, dueOn: "2026-02-30" }, { ...good, dueOn: undefined }];
  add(A, "핵심이 깨진 문서는 null(영역·키·다음 복습일) — 그 항목은 처음 들어오는 항목으로 다시 계산", broken.every((b) => normalizeReviewSchedule(b) === null));
  const data = reviewScheduleData({ ...good, lastJudge: undefined as unknown as null });
  add(A, "쓰기 본문: id 없음 · undefined 0(Firestore 거부 방지)", !("id" in data) && !JSON.stringify(data, (_k, v) => (v === undefined ? "__U__" : v)).includes("__U__") && data.lastJudge === null);
}

// ---------------------------------------------------------------------------
// 7) 힌트 재료
// ---------------------------------------------------------------------------
{
  const A = "힌트 재료";
  const rows: [string, string][] = [
    ["apple", "a____"],
    ["hand out flyers", "h___ o__ f_____"],
    ["I'd like to ~", "I'_ l___ t_ ~"],
    ["well-known  place.", "w___-_____ p____."],
    ["  Take a look at ~ ", "T___ a l___ a_ ~"],
  ];
  const bad = rows.filter(([i, o]) => latinSkeleton(i) !== o).map(([i]) => `${i}→${latinSkeleton(i)}`);
  add(A, "영어 뼈대: 낱말마다 첫 글자 + 밑줄, 공백·~·구두점 유지, 낱말 안 '·- 이어짐", bad.length === 0, bad.join(" / "));
  add(A, "첫 글자: 라틴 첫 글자(앞 기호 건너뜀)", firstLetterHint("~ take") === "t" && firstLetterHint("apple") === "a");
  add(A, "가나 뼈대: 첫 글자 + ○(작은 가나·장음도 한 칸)", kanaSkeleton("きょう") === "き○○" && kanaSkeleton("コーヒー") === "コ○○○" && kanaSkeleton("") === "");
  add(A, "단서 속 정답 가리기 — 낱말 경계(복수형 Apples는 가리고 pineapple 속은 그대로)", maskAnswerInCue("An apple is red. Apples grow. pineapple", "apple") === "An _____ is red. ______ grow. pineapple" && maskAnswerInCue("APPLE pie", "apple") === "_____ pie", maskAnswerInCue("An apple is red. Apples grow. pineapple", "apple"));
  add(A, "틀 자리 표시 {이름} → [이름]", frameForDisplay("I like {place} because {reason}.") === "I like [place] because [reason].");
}

// ---------------------------------------------------------------------------
// 8) 어댑터 — 지어낸 데이터
// ---------------------------------------------------------------------------
const ses = (startedAt: string, items: [string, boolean, boolean | null][]): QuizSessionLike => ({ startedAt, items: items.map(([word, correct, answered]) => ({ word, correct, answered })) });
{
  const A = "어댑터·은우";
  const books = [
    { id: "b1", titleKo: "DAY 01", createdAt: "2026-09-01T00:00:00.000Z", entries: [
      { word: "Apple", meanings: [{ ko: "사과" }], definitionEn: "A red or green fruit. An apple grows on a tree.", imageEmoji: "🍎" },
      { word: "river", meanings: [{ ko: "강" }], definitionEn: null, imageEmoji: "🏞️" },
      { word: "sea", meanings: [{ ko: "바다" }], definitionEn: null, imageEmoji: null },
      { word: "cloud", meanings: [{ ko: "구름" }], definitionEn: "White thing in the sky.", imageEmoji: "☁️" },
    ] },
    { id: "b2", titleKo: "DAY 02", createdAt: "2026-09-05T00:00:00.000Z", entries: [{ word: "apple", meanings: [{ ko: "사과(새 뜻)" }], definitionEn: "A round fruit.", imageEmoji: "🍏" }] },
  ];
  const quizzes = [ses("2026-09-02T00:00:00.000Z", [["apple", false, true], ["river", true, true], ["sea", true, true], ["cloud", false, null]]), ses("2026-09-06T00:00:00.000Z", [["Apple", true, true]])];
  const items = englishWordItems(books, quizzes);
  const keys = items.map((i) => i.card.itemKey);
  const apple = items.find((i) => i.card.itemKey === "en-word:apple");
  const river = items.find((i) => i.card.itemKey === "en-word:river");
  add(A, "시험에서 답한 단어만(미응답 cloud 제외) · 같은 단어(대소문자)는 한 항목 · 정의도 이모지도 없는 sea는 들이지 않음(번역 없이 떠올릴 단서 없음)", keys.length === 2 && keys.includes("en-word:apple") && keys.includes("en-word:river"), keys.join(","));
  add(A, "가장 최근 단어장 뜻 · 통계 합산(답 2·틀림 1·마지막 시험)", apple?.card.sourceKo === "DAY 02" && apple.card.cue.emoji === "🍏" && apple.stats.attempts === 2 && apple.stats.wrongCount === 1 && apple.stats.lastTestedAt === "2026-09-06T00:00:00.000Z");
  add(A, "단서 = 이모지 + 영영 정의(한국어 없음 — 정답 공개 쪽 answer.sub에만), 힌트1 첫 글자, 힌트2 `a____` + 5글자, 발음 en-US", apple?.card.cue.main === "A round fruit." && apple.card.cue.sub === null && apple.card.answer.sub === "사과(새 뜻)" && apple.card.hint1 === "a" && apple.card.hint2 === "a____" && apple.card.hint2Note === "5글자" && apple.card.speak?.lang === "en-US");
  add(A, "영영 정의가 없으면 이모지만 단서(한국어 뜻 아님) · 한국어는 정답 쪽", river?.card.cue.emoji === "🏞️" && river.card.cue.main === "그림을 보고 영어로 떠올려 봐요" && river.card.cue.sub === null && river.card.answer.sub === "강");
  const hangul = /[\uAC00-\uD7A3]/;
  add(A, "P2-A: 은우 카드 단서(이모지·main·sub)에 한국어 뜻 0 — 뜻 글자가 단서 어디에도 없다", items.every((i) => !["사과", "강"].some((ko) => `${i.card.cue.main} ${i.card.cue.sub ?? ""}`.includes(ko)) && (i.card.cue.sub === null || !hangul.test(i.card.cue.sub))));
  const masked = englishWordItems([books[0]], [ses("2026-09-02T00:00:00.000Z", [["Apple", true, true]])])[0];
  add(A, "영영 정의 속 표제어는 밑줄로 가린다(단서가 곧 정답 아님)", masked.card.cue.main === "A red or green fruit. An _____ grows on a tree.", masked.card.cue.main);
}
{
  const A = "어댑터·일본어";
  const books = [{ id: "j1", titleKo: "N5 · 동물", createdAt: "2026-09-01T00:00:00.000Z", entries: [
    { word: "猫", kana: "ねこ", meaningsKo: ["고양이"], imageEmoji: "🐱", wordTokens: [{ surface: "猫", reading: "ねこ" }] },
    { word: "犬", kana: "いぬ", meaningsKo: ["개"], imageEmoji: "🐶", wordTokens: [{ surface: "犬", reading: "いぬ" }] },
  ] }];
  const items = japaneseWordItems(books, [ses("2026-09-02T00:00:00.000Z", [["猫", true, true], ["犬", false, null]])]);
  const c = items[0]?.card;
  add(A, "단어: 시험 본 것만 · 단서 = 한국어 뜻 · 힌트1 읽기 첫 글자 · 힌트2 `ね○` · 정답 루비 · 발음 ja-JP", items.length === 1 && c.itemKey === "ja-word:猫" && c.cue.main === "고양이" && c.hint1 === "ね" && c.hint2 === "ね○" && c.answer.sub === "ねこ" && c.answer.ruby?.[0].reading === "ねこ" && c.speak?.lang === "ja-JP");
  const kanji = japaneseKanjiItems(
    [{ kanji: "学", koReading: "학", onyomi: ["がく"], kunyomi: ["まなぶ"], meaningKo: "배우다" }, { kanji: "水", koReading: "수", onyomi: ["すい"], kunyomi: ["みず"], meaningKo: "물" }],
    [ses("2026-09-03T00:00:00.000Z", [["学", false, true]])],
  );
  const k = kanji[0]?.card;
  add(A, "한자: 시험 본 한자만 · 단서 = 뜻 + 한국 한자음 · 힌트1 음독 첫 글자 · 힌트2 음·훈", kanji.length === 1 && k.itemKey === "ja-kanji:学" && k.cue.main === "배우다" && (k.cue.sub ?? "").includes("학") && k.hint1 === "が" && k.hint2 === "음 がく · 훈 まなぶ" && kanji[0].stats.wrongCount === 1);
}
{
  const A = "어댑터·토익";
  const sets = [
    { id: "s1", titleKo: "DAY 1 출근", createdAt: "2026-09-01T00:00:00.000Z", entries: [
      { expression: "Hand out  flyers", meaningKo: "전단지를 나눠 주다", example: "They hand out flyers at the gate.", exampleKo: "그들은 문 앞에서 전단지를 나눠 준다." },
      { expression: "be in charge of ~", meaningKo: "~을 맡다", example: null, exampleKo: null },
      { expression: "untested", meaningKo: "안 본 것", example: null, exampleKo: null },
    ] },
  ];
  const quizzes = [ses("2026-09-02T00:00:00.000Z", [["hand out flyers", true, true], ["be in charge of ~", false, true], ["tpl:intro", true, true], ["quiz:3", true, true]])];
  const ex = toeicExpressionItems(sets, quizzes);
  const h = ex.find((i) => i.card.itemKey === "toeic-expr:hand out flyers")?.card;
  add(A, "표현: 시험 본 것만 · 대소문자·공백 무시 같은 표현 · tpl:·quiz: 키 무시", ex.length === 2 && !!h && !ex.some((i) => i.card.itemKey.includes("tpl")), ex.map((i) => i.card.itemKey).join(","));
  add(A, "표현 카드: 단서 = 한국어 뜻(+예문 해석) · 힌트2 낱말 첫 글자 뼈대 · 정답 아래 예문 · 발음은 ~ 없이", h?.cue.main === "전단지를 나눠 주다" && h.hint2 === "H___ o__ f_____" && h.answer.sub === "They hand out flyers at the gate." && ex.find((i) => i.card.itemKey.includes("charge"))?.card.speak?.text === "be in charge of");
  const templates = [
    { key: "intro", frameEn: "I'd like to talk about {topic}.", frameKo: "{topic}에 대해 말하고 싶어요.", useKo: "말 꺼내기", examples: [{ en: "I'd like to talk about my weekend.", ko: "주말에 대해 말하고 싶어요." }] },
    { key: "reason", frameEn: "{Reason} is the main reason.", frameKo: "{Reason}이 주된 이유예요.", useKo: "이유", examples: [] },
    { key: "never", frameEn: "Never {x}.", frameKo: "{x} 절대.", useKo: "-", examples: [] },
  ];
  const tq = [ses("2026-09-04T00:00:00.000Z", [["tpl:intro", false, true]])];
  const drills = [{ startedAt: "2026-09-10T00:00:00.000Z", items: [{ frameKey: "fd-reason", outcome: "spoken", verdict: "close" }, { frameKey: "fd-free", outcome: "spoken", verdict: "wrong" }, { frameKey: "fd-intro", outcome: "no_speech", verdict: null }] }];
  const links = [{ key: "fd-reason", bankKey: "reason" }, { key: "fd-free", bankKey: null }, { key: "fd-intro", bankKey: "intro" }];
  const tp = toeicTemplateItems(templates, tq, drills, links);
  const intro = tp.find((i) => i.card.itemKey === "toeic-template:intro");
  const reason = tp.find((i) => i.card.itemKey === "toeic-template:reason");
  add(A, "틀: 틀 시험 기록 또는 틀 말하기(은행 틀과 이어진 말한 문항)만 · 무응답·이어지지 않은 틀은 세지 않음", tp.length === 2 && !!intro && !!reason && intro.stats.attempts === 1 && reason.stats.wrongCount === 1 && reason.stats.lastTestedAt === "2026-09-10T00:00:00.000Z", tp.map((i) => i.card.itemKey).join(","));
  add(A, "틀 카드: 단서 = 한국어 틀([자리]) · 힌트1 첫 낱말 · 힌트2 `~` 자리만 보이는 뼈대 · 발음 = 예문", intro?.card.cue.main === "[topic]에 대해 말하고 싶어요." && intro.card.hint1 === "I'd" && intro.card.hint2 === "I'_ l___ t_ t___ a____ ~" && intro.card.answer.main === "I'd like to talk about [topic]." && intro.card.speak?.text === "I'd like to talk about my weekend." && reason?.card.speak === null, intro?.card.hint2 ?? "");
}

// ---------------------------------------------------------------------------
// 8a) QA common_review_1 수정 — 굴절형 가리기(C) · 섬 뼈대 = 정답이면 밑줄로(B) · 다른 항목의 일정을 받지 않음(F)
// ---------------------------------------------------------------------------
{
  const A = "QA 수정";
  const rows: [string, string, string][] = [
    ["He runs and running is fun.", "run", "He ____ and _______ is fun."],
    ["Yesterday she ran home.", "run", "Yesterday she ___ home."],
    ["The babies cried.", "baby", "The ______ cried."],
    ["She is hopping and hopped.", "hop", "She is _______ and ______."],
    ["We baked a cake while baking.", "bake", "We _____ a cake while ______."],
    ["Two mice ran.", "mouse", "Two ____ ran."],
    ["Children play.", "child", "________ play."],
    ["The wolves howl; leaves fall.", "leaf", "The wolves howl; ______ fall."],
    ["A rerun is not run-down.", "run", "A rerun is not ___-down."],
    ["He went and has gone.", "go", "He ____ and has ____."],
  ];
  const bad = rows.filter(([cue, ans, want]) => maskAnswerInCue(cue, ans) !== want).map(([cue, ans]) => `${ans}: ${maskAnswerInCue(cue, ans)}`);
  add(A, "C: 단서 가리기가 규칙 굴절(-s/-ing/-ed/y→ies/자음 겹침/e 탈락/f→ves)과 흔한 불규칙(ran·went·gone·mice·children)을 가린다 — 다른 낱말 속은 그대로", bad.length === 0, bad.join(" / "));
  add(A, "C: 여러 낱말 정답은 그대로 일치만", maskAnswerInCue("Please pick up the pace now.", "pick up") === "Please _______ the pace now.");
  const frames = [{ key: "fx", frameEn: "On top of that, it is really convenient." }];
  const full = toeicIslandItems([{ id: "isl-m-full0001", en: "On top of that, it is really convenient.", ko: "게다가 정말 편해요.", topicNameKo: null, question: null, frameKey: null, createdAt: NOW }], frames)[0].card;
  add(A, "B: 틀 고정 부분이 문장을 다 덮으면(뼈대 = 정답) 낱말 수 밑줄로 떨어진다", islandFrameSkeleton("On top of that, it is really convenient.", frames) === null && full.hint2 !== full.answer.main && full.hint2Note === "8낱말" && !/[A-Za-z]/.test(full.hint2), full.hint2);
  const other = decideReview(null, { area: "english", itemKey: "en-word:cat", outcome: { hintLevel: 0, judge: "got" }, todayKst: "2026-10-01", nowIso: NOW }).record;
  const d = decideReview(other, { area: "english", itemKey: "en-word:dog", outcome: { hintLevel: 2, judge: "got" }, todayKst: "2026-10-01", nowIso: NOW });
  add(A, "F: 다른 항목 키의 일정을 받으면 쓰지 않고 새 항목으로(이중 적용 판정·단계가 섞이지 않음)", d.kind === "applied" && d.record.itemKey === "en-word:dog" && d.record.reviewCount === 1 && d.record.step === 0 && d.record.id === reviewDocId("english", "en-word:dog"));
  const otherArea = { ...other, area: "japanese" } as unknown as ReviewScheduleRecord;
  add(A, "F: 영역이 다른 일정도 새 항목으로", decideReview(otherArea, { area: "english", itemKey: "en-word:cat", outcome: { hintLevel: 0, judge: "got" }, todayKst: "2026-10-01", nowIso: NOW }).kind === "applied");
  const islandRoute = src("../app/api/toeic/island/route.ts");
  const st = src("../lib/store.ts");
  add(A, "E: 섬 상한 검사는 저장소 원자 단위 안(라우트는 목록 길이를 세지 않고 createToeicIslandEntry(entry, 상한)의 full을 본다)", !/listToeicIslandEntries\(\)/.test(islandRoute) && /createToeicIslandEntry\(entry, TOEIC_ISLAND_ENTRIES_MAX\)/.test(islandRoute) && /if \(max !== undefined && db\.toeicIsland\.length >= max\) return \{ record, reused: false, full: true \}/.test(st) && /tx\.get\(this\.toeicIsland\(\)\.count\(\)\)/.test(src("../lib/store-firestore.ts")));
}

// ---------------------------------------------------------------------------
// 8b) 연결 출처 — 은우 그림 보고 말하기(같은 단어 항목에 합침) · 토익 나만의 답변 섬(담음 = 입장)
// ---------------------------------------------------------------------------
{
  const A = "연결·그림 말하기";
  const book = { id: "pb", titleKo: "DAY 05", createdAt: "2026-09-01T00:00:00.000Z", entries: [
    { word: "kite", meanings: [{ ko: "연" }], definitionEn: "a toy that flies in the wind on a string", imageEmoji: "🪁" },
    { word: "drum", meanings: [{ ko: "북" }], definitionEn: "you hit it to make music", imageEmoji: "🥁" },
  ] };
  // kite: 5지선다(맞힘)+그림 말하기(못 떠올림) · drum: 그림 말하기만(맞힘)
  const quizzes = [
    { startedAt: "2026-09-02T00:00:00.000Z", mode: "def-to-word", items: [{ word: "kite", correct: true, answered: true }] },
    { startedAt: "2026-09-03T00:00:00.000Z", mode: "picture-speak", items: [{ word: "kite", correct: false, answered: true }, { word: "drum", correct: true, answered: true }] },
  ];
  const items = englishWordItems([book], quizzes);
  const kite = items.find((i) => i.card.itemKey === "en-word:kite");
  add(A, "그림 말하기만 본 단어도 들어오고, 두 모드 기록은 같은 단어 한 항목(새 종류 없음 · 중복 0)", items.length === 2 && new Set(items.map((i) => i.card.itemKey)).size === 2 && items.every((i) => i.card.kind === "en-word"), items.map((i) => i.card.itemKey).join(","));
  add(A, "그림 말하기 틀림이 틀린 기록 우선에 반영(kite 틀림 1 · 마지막 시험 = 그림 말하기 날)", kite?.stats.attempts === 2 && kite.stats.wrongCount === 1 && kite.stats.lastTestedAt === "2026-09-03T00:00:00.000Z");
  const q = buildReviewQueue({ candidates: items.map((i) => ({ itemKey: i.card.itemKey, ...i.stats })), schedules: [], todayKst: TODAY });
  add(A, "큐: 그림 말하기에서 못 떠올린 kite가 먼저", q.entries.map((e) => e.itemKey).join(",") === "en-word:kite,en-word:drum");
}
{
  const A = "연결·답변 섬";
  const frames = [{ key: "fd-like", frameEn: "What I like most about {thing} is {reason}.", frameKo: "{thing}에서 가장 좋은 점은 {reason}이에요." }];
  const entries = [
    { id: "isl-m-a1", en: "What I like most about my town is the quiet park.", ko: "우리 동네에서 가장 좋은 점은 조용한 공원이에요.", topicNameKo: "동네", question: null, frameKey: "fd-like", createdAt: "2026-10-02T03:00:00.000Z" },
    { id: "isl-m-b2", en: "I usually walk there after dinner.", ko: null, topicNameKo: "운동", question: null, frameKey: "fd-like", createdAt: "2026-10-03T01:00:00.000Z" },
    { id: "isl-m-c3", en: "Honestly, it depends on the weather.", ko: null, topicNameKo: null, question: "How often do you go outside?", frameKey: null, createdAt: "2026-09-20T03:00:00.000Z" },
    { id: "isl-m-a1", en: "dup", ko: null, topicNameKo: null, question: null, frameKey: null, createdAt: "2026-09-01T00:00:00.000Z" },
  ];
  const items = toeicIslandItems(entries, frames);
  const a = items.find((i) => i.card.itemKey === "toeic-island:isl-m-a1")?.card;
  const b = items.find((i) => i.card.itemKey === "toeic-island:isl-m-b2")?.card;
  const c = items.find((i) => i.card.itemKey === "toeic-island:isl-m-c3")?.card;
  add(A, "담긴 문장 전부(시험 기록 없이) · 같은 id 한 항목 · 첫 복습일 = 담은 KST 날 + 1", items.length === 3 && items[0].stats.attempts === 0 && items[0].stats.firstDueOn === "2026-10-03" && items[1].stats.firstDueOn === "2026-10-04", items.map((i) => i.stats.firstDueOn).join(","));
  add(A, "단서: 한국어 단서 → (없으면) 소재 + 한국어 틀 → (없으면) 질문", a?.cue.main === "우리 동네에서 가장 좋은 점은 조용한 공원이에요." && a.cue.sub === "소재 · 동네" && b?.cue.main === "소재 · 운동" && b.cue.sub === "[thing]에서 가장 좋은 점은 [reason]이에요." && c?.cue.main === "How often do you go outside?" && c.cue.lang === "en");
  add(A, "힌트1 첫 낱말 · 힌트2 쓰인 틀 고정 부분(두 낱말 이상 조각 — templateRunSpans 규칙)만 보이는 뼈대(틀이 없으면 낱말 수 밑줄)", a?.hint1 === "What" && a.hint2 === "What I like most about __ ____ __ ___ _____ ____." && a.hint2Note === "쓰인 틀" && c?.hint2 === "________, __ _______ __ ___ _______." && c.hint2Note === "6낱말", `${a?.hint2} / ${c?.hint2}`);
  add(A, "뼈대 함수: 틀 못 찾으면 null · 밑줄은 첫 글자까지 가림", islandFrameSkeleton("Nothing here.", frames) === null && wordUnderscores("Go on!") === "__ __!");
  const cands = items.map((i) => ({ itemKey: i.card.itemKey, ...i.stats }));
  const q1 = buildReviewQueue({ candidates: cands, schedules: [], todayKst: "2026-10-03" });
  add(A, "담은 날 당일은 아직 · 다음 날부터 들어옴 · 오래 전에 담은 것이 먼저(밀린 순)", q1.entries.map((e) => e.itemKey.slice(13)).join(",") === "isl-m-c3,isl-m-a1" && buildReviewQueue({ candidates: cands, schedules: [], todayKst: "2026-10-04" }).entries.length === 3, q1.entries.map((e) => e.itemKey).join(","));
  const del = buildReviewQueue({ candidates: cands.filter((x) => !x.itemKey.endsWith("a1")), schedules: [sched("toeic-island:isl-m-a1", "2026-10-01")], todayKst: "2026-10-04" });
  add(A, "섬에서 지운 문장은 큐에서 빠진다(일정은 고아로 무해)", !del.entries.some((e) => e.itemKey.endsWith("a1")) && del.entries.length === 2);
  const applied = decideReview(null, { area: "toeic", itemKey: "toeic-island:isl-m-a1", outcome: { hintLevel: 1, judge: "got" }, todayKst: "2026-10-04", nowIso: NOW });
  const q3 = buildReviewQueue({ candidates: cands, schedules: [applied.record], todayKst: "2026-10-05" });
  add(A, "판정 뒤에는 일정이 이긴다(담은 날 규칙 대신 다음 복습일)", applied.record.dueOn === "2026-10-07" && !q3.entries.some((e) => e.itemKey.endsWith("a1")) && q3.entries.length === 2);
  const deCands = [...cands, ...cands];
  add(A, "같은 섬 항목 후보가 둘이어도 큐 중복 0", buildReviewQueue({ candidates: deCands, schedules: [], todayKst: "2026-10-04" }).entries.length === 3);
  const srv = src("../lib/review-server.ts");
  add(A, "등록부: toeic-island 출처 한 줄(listToeicIslandEntries) · 종류 표 세 곳", /kind: "toeic-island"[\s\S]{0,400}listToeicIslandEntries\(\)/.test(srv) && REVIEW_KIND_AREA["toeic-island"] === "toeic");
}

// ---------------------------------------------------------------------------
// 9) 스트릭·요약
// ---------------------------------------------------------------------------
{
  const A = "스트릭·요약";
  const s1 = sched("en-word:a", "2026-10-06", { lastReviewedOn: TODAY, history: [{ on: "2026-10-01", at: NOW, hintLevel: 0, judge: "got", step: 1 }, { on: "2026-10-02", at: NOW, hintLevel: 0, judge: "got", step: 1 }, { on: TODAY, at: NOW, hintLevel: 0, judge: "got", step: 1 }] });
  const s2 = sched("en-word:b", "2026-10-06", { lastReviewedOn: TODAY, history: [{ on: TODAY, at: NOW, hintLevel: 1, judge: "got", step: 1 }] });
  const info = computeStreak(reviewStreakSessions([s1, s2]), TODAY);
  add(A, "복습한 날(같은 날 여러 항목은 하루) → 연속 3일·오늘 함", info.current === 3 && info.doneToday && info.best === 3, JSON.stringify(info));
  add(A, "라벨 `오늘의 복습 · 2개` · 오늘 안 했으면 null", reviewTodayLabel([s1, s2], TODAY) === "오늘의 복습 · 2개" && reviewTodayLabel([s1], "2026-10-04") === null);
  const sum = summarizeReviewResults([{ judge: "got", intervalDays: 3 }, { judge: "forgot", intervalDays: 1 }, { judge: "unsure", intervalDays: 3 }, { judge: "got", intervalDays: 14 }]);
  add(A, "끝 요약: 맞힘 2·헷갈림 1·몰랐음 1 · 다음 복습 분포(간격 오름차순)", sum.got === 2 && sum.unsure === 1 && sum.forgot === 1 && JSON.stringify(sum.byInterval) === '[{"days":1,"count":1},{"days":3,"count":2},{"days":14,"count":1}]' && reviewIntervalLabelKo(1) === "내일" && reviewIntervalLabelKo(7) === "7일 뒤");
}

// ---------------------------------------------------------------------------
// 10) 공개 기록 함수 recordReview — 가짜 저장소(직렬화 맵)로 같은 날 이중 적용·영역 가드
// ---------------------------------------------------------------------------
async function recordChecks(): Promise<void> {
  const A = "recordReview";
  const { recordReview } = await import("../lib/review-server");
  const map = new Map<string, ReviewScheduleRecord>();
  let chain: Promise<unknown> = Promise.resolve();
  const fakeStore = {
    applyReviewOutcome: (input: Parameters<typeof decideReview>[1]) => {
      const run = chain.then(() => {
        const d = decideReview(map.get(input.itemKey) ?? null, input);
        if (d.kind === "applied") map.set(input.itemKey, d.record);
        return d;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  } as unknown as Parameters<typeof recordReview>[3] extends { store?: infer S } ? S : never;
  const now = new Date("2026-10-03T05:00:00.000Z");
  const [r1, r2] = await Promise.all([
    recordReview("toeic", "toeic-expr:hand out flyers", { hintLevel: 0, judge: "got" }, { now, store: fakeStore }),
    recordReview("toeic", "toeic-expr:hand out flyers", { hintLevel: 0, judge: "got" }, { now, store: fakeStore }),
  ]);
  add(A, "동시 두 번(연타·두 탭) → 하나만 applied, 다른 하나 already_today · 간격 3일", [r1.decision.kind, r2.decision.kind].sort().join(",") === "already_today,applied" && r1.intervalDays === 3 && map.get("toeic-expr:hand out flyers")?.reviewCount === 1);
  let guarded = false;
  try {
    await recordReview("english", "toeic-expr:x", { hintLevel: 0, judge: "got" }, { now, store: fakeStore });
  } catch (e) {
    guarded = e instanceof RangeError;
  }
  add(A, "다른 영역의 항목 키는 RangeError(저장소에 닿지 않음)", guarded && map.size === 1);
}

// ---------------------------------------------------------------------------
// 11) 배선 정적 점검 — 저장소·시드·스트릭·표현 도우미·비용 0·번들 경계
// ---------------------------------------------------------------------------
{
  const A = "배선";
  const store = src("../lib/store.ts");
  const fs = src("../lib/store-firestore.ts");
  const seed = src("../scripts/seed.ts");
  add(A, "파일 백엔드: DbShape·emptyDb·readDb(정규화)·mergeDbForSeed(mergeById)·mutate 안에서 decideReview", /reviewSchedules: ReviewScheduleRecord\[\];/.test(store) && /reviewSchedules: \[\],/.test(store) && /reviewSchedules: \(parsed\.reviewSchedules \?\? \[\]\)\.map\(\(d\) => normalizeReviewSchedule\(d\)\)/.test(store) && /reviewSchedules: mergeById\(cur\.reviewSchedules, seed\.reviewSchedules\)/.test(store) && /this\.mutate\(\(db\) => \{\s*const i = db\.reviewSchedules[\s\S]{0,200}decideReview\(/.test(store) && /reviewSchedules: \[\],/.test(seed));
  add(A, "Firestore: runTransaction 안에서 tx.get 뒤 decideReview → applied일 때만 tx.set · 문서 id = reviewDocId · 읽기는 area where 하나", /async applyReviewOutcome[\s\S]{0,200}reviewDocId\(input\.area, input\.itemKey\)[\s\S]{0,120}runTransaction[\s\S]{0,200}tx\.get\(ref\)[\s\S]{0,200}decideReview\(prev, input\)[\s\S]{0,80}if \(decision\.kind === "applied"\) tx\.set/.test(fs) && /where\("area", "==", area\)\.get\(\)/.test(fs) && !/reviewSchedules\(\)[^;]*orderBy/.test(fs));
  const streak = src("../app/api/streak/route.ts");
  add(A, "스트릭 라우트: 세 트랙에 각자 영역 복습만(english→은우·japanese→일본어·toeic→영어) · 못 읽으면 복습만 빼고 · 라벨은 다른 기록이 없을 때만", /listReviewSchedules\(\)\.catch/.test(streak) && /\.\.\.talkStreakSessions\(talks\), \.\.\.reviewStreakSessions\(reviewsOf\("english"\)\)/.test(streak) && /\.\.\.jaKanji, \.\.\.reviewStreakSessions\(reviewsOf\("japanese"\)\)/.test(streak) && /reviewStreakSessions\(reviewsOf\("toeic"\)\)/.test(streak) && /if \(eunwoo\.todayLabel === null\) eunwoo\.todayLabel = reviewTodayLabel\(reviewsOf\("english"\)/.test(streak) && !/reviewsOf\("japanese"\)[^\n]*eunwoo/.test(streak));
  const examRows: [string, boolean][] = [["/english/review", true], ["/japanese/review", true], ["/toeic/review", true], ["/toeic/review?x=1", true], ["/english/reviews", false], ["/english/review/x", false]];
  add(A, "표현 도우미: 러너 경로 세 곳은 시험 경로(막힘) — 비슷한 경로는 아님", examRows.every(([p, b]) => isPhraseHelperExamPath(p) === b) && PHRASE_HELPER_EXAM_PATHS.some((x) => x.re.source.includes("review")));
  const runner = src("../components/review-runner.tsx");
  const card = src("../components/review-today-card.tsx");
  add(A, "러너: usePhraseHelperBlock · 🔊는 onClick 안 speak만 · 프리페치·speakQueue·/api/tts 직접 호출 0 · 첫 적용 때 스트릭 이벤트", /usePhraseHelperBlock\(\)/.test(runner) && /onClick=\{\(\) => card\.speak && speak\(card\.speak\.text, card\.speak\.lang\)\}/.test(runner) && !/prefetchSpeech|speakQueue|prepareSpeech|\/api\/tts/.test(runner + card) && /STREAK_REFRESH_EVENT/.test(runner) && (runner.match(/speak\(/g) ?? []).length === 1);
  const reviewFiles = ["../lib/review-schedule.ts", "../lib/review-sources.ts", "../lib/review-server.ts", "../lib/review-contract.ts", "../app/api/review/[area]/route.ts", "../app/api/review/record/route.ts", "../components/review-runner.tsx", "../components/review-today-card.tsx"].map(src);
  add(A, "AI 0: 복습 파일 어디에도 lib/ai·openai·callWithSchema·OPENAI_API_KEY 없음", reviewFiles.every((f) => !/from "[^"]*\/ai\/|from "openai"|callWithSchema|OPENAI_API_KEY/.test(f)));
  const eng = src("../lib/review-schedule.ts");
  const imports = [...eng.matchAll(/^import[^;]*from "([^"]+)"/gm)].map((m) => m[1]);
  add(A, "번들 경계: 엔진의 런타임 import는 ./kst뿐(러너가 값으로 import)", imports.length === 1 && imports[0] === "./kst", imports.join(","));
  const contract = src("../lib/review-contract.ts");
  add(A, "계약: 타입 전용(import type만)", [...contract.matchAll(/^import (?!type )/gm)].length === 0);
  const pages = ["../app/english/review/page.tsx", "../app/japanese/review/page.tsx", "../app/toeic/review/page.tsx"].map(src);
  add(A, "러너 페이지 셋: force-dynamic · loadReviewQueue · 영역 맞음", pages.every((p) => /export const dynamic = "force-dynamic"/.test(p) && /loadReviewQueue\(/.test(p)) && /loadReviewQueue\("english"/.test(pages[0]) && /loadReviewQueue\("japanese"/.test(pages[1]) && /loadReviewQueue\("toeic"/.test(pages[2]) && /tone="kid"/.test(pages[0]));
  const hubs = ["../app/english/page.tsx", "../app/japanese/page.tsx", "../app/toeic/page.tsx"].map(src);
  add(A, "허브 셋에 오늘의 복습 카드(영역·말투 맞음)", /<ReviewTodayCard area="english" tone="kid" \/>/.test(hubs[0]) && /<ReviewTodayCard area="japanese" tone="adult" \/>/.test(hubs[1]) && /<ReviewTodayCard area="toeic" tone="adult" \/>/.test(hubs[2]));
  const rec = src("../app/api/review/record/route.ts");
  add(A, "기록 라우트: 키 검사 없음 · zod 양방향 계약 · 영역-키 불일치 400", !/OPENAI_API_KEY/.test(rec) && /requestMatchesSchema/.test(rec) && /isReviewItemKeyOfArea\(v\.itemKey, v\.area\)/.test(rec));
}

// ---------------------------------------------------------------------------
// 12) 결정성 — 같은 입력이면 같은 출력(두 번 돌려 비교)
// ---------------------------------------------------------------------------
{
  const A = "결정성";
  const run = () => {
    const cands = Array.from({ length: 40 }, (_, i) => cand(`ja-word:w${(i * 7) % 40}`, (i % 4) + 1, i % 5 === 0 ? 1 : 0));
    let schedules: ReviewScheduleRecord[] = [];
    let day = TODAY;
    const log: string[] = [];
    for (let d = 0; d < 10; d++) {
      const q = buildReviewQueue({ candidates: cands, schedules, todayKst: day });
      for (const [i, e] of q.entries.entries()) {
        const prev = schedules.find((s) => s.itemKey === e.itemKey) ?? null;
        const out = decideReview(prev, { area: "japanese", itemKey: e.itemKey, outcome: { hintLevel: (i % 4) as ReviewHintLevel, judge: JG[i % 3] }, todayKst: day, nowIso: `${day}T03:00:00.000Z` });
        schedules = [...schedules.filter((s) => s.itemKey !== e.itemKey), out.record];
      }
      log.push(`${day}:${q.entries.length}:${q.dueCount}`);
      day = shiftDateString(day, 1);
    }
    return { log: log.join("|"), state: JSON.stringify(schedules.map((s) => [s.itemKey, s.step, s.dueOn]).sort()) };
  };
  const a = run();
  const b = run();
  add(A, "10일 시뮬레이션 두 번 → 같은 큐·같은 일정", a.log === b.log && a.state === b.state, a.log.slice(0, 80));
  add(A, "시뮬레이션: 매일 상한 20 이하 · 첫날 40개 중 20개", a.log.split("|").every((x) => Number(x.split(":")[1]) <= 20) && a.log.startsWith(`${TODAY}:20:40`), a.log.slice(0, 40));
}

// ---------------------------------------------------------------------------
void (async () => {
await recordChecks();

console.log("");
console.log("| 결과 | 영역 | 점검 항목 | 상세 |");
console.log("|------|------|-----------|------|");
for (const r of results) console.log(`| ${r.pass ? "PASS" : "FAIL"} | ${r.area} | ${r.check} | ${r.detail.replace(/\|/g, "\\|").slice(0, 160)} |`);
console.log("");
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`FAIL — 오늘의 복습 ${failed.length}개 항목 실패.`);
  process.exit(1);
}
console.log(`PASS — 오늘의 복습 ${results.length}개 항목 통과 (실호출 0회 · 네트워크 0 · 저장소 쓰기 0).`);
})();
