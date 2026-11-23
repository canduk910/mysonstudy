/**
 * scripts/eval-ja-daily.ts — 🗓️ 오늘의 일본어 오프라인 점검(설계 docs/superpowers/specs/2026-11-15-ja-daily-design.md §9). **실호출 없음 — 오프라인 전용.**
 *
 * 가져오기 계약 반례 · 가져오기 결정 · 과정 엔진(80단위·54회·청해/모의 배정·꼬리 10·늘어남·결정성·다음 회차) · 약한 것 고르기 ·
 * jpack 파서 · 🎤 판정 경계 · 저장 계약 · 채점표 · 회차 풀기 · 스트릭 소스 · 복습 종류 ja-n5-word · 배선 정적 점검.
 * 픽스처는 전부 **지어낸 일본어**다 — 교재 문장·단어·문제를 넣지 않는다(PUBLIC 저장소).
 */
import { jaRomajiToHiragana } from "../lib/ja-romaji";
import { readFileSync } from "node:fs";
import {
  JA_DAILY_IMPORT_FORMAT,
  JA_DAILY_LIMITS,
  isUnderlineMarkupValid,
  jaDailyImportFileSchema,
  splitJaDailyFile,
  type JaDailyImportFile,
  type JaDailyLesson,
} from "../lib/ja-daily-content";
import {
  JA_DAILY_CLOSE_ACCURACY,
  JA_DAILY_PASS_ACCURACY,
  decideJaDailyImport,
  decideJaDailySave,
  jaDailySessionSaveSchema,
  jaDailyVerdictOf,
  judgeJaDailyLine,
  latestJaDailyExamAnswers,
  scoreJaDailyMock,
  toJaDailyContentIndex,
  type JaDailyContentRecord,
  type JaDailySessionRecord,
} from "../lib/ja-daily-contract";
import {
  JA_DAILY_CORE_MIN,
  JA_DAILY_TAIL,
  buildJaDailyCourse,
  buildJaDailyNextCourseUnits,
  chunkJaDailyMockItems,
  jaDailySessionAt,
  naturalCompare,
  nextJaDailySession,
  pickWeakItems,
  pickWeakLessons,
  pickWeakWords,
} from "../lib/ja-daily-plan";
import { jaDailyMockRealAnswers, resolveJaDailySession } from "../lib/ja-daily-session";
import {
  JA_DAILY_VOCAB_CHOICES,
  buildJaDailyShadowItems,
  jaDailyLineGroups,
  flattenJaDailyTipDrills,
  buildJaDailyVocabQuestion,
  buildJaDailyVocabQuestions,
  isJaDailyReadingTrivial,
  jaDailyExamLabel,
  jaDailySameMeaning,
  jaDailySessionSummary,
  jaDailyShadowPauseMs,
  jaDailyVocabLabel,
  splitJaDailyUnderline,
  stripJaDailyUnderline,
} from "../lib/ja-daily-quiz";
import { buildJaPack, jaPackSlice, parseJaPackHeader, parseJaPackIndex, readJaPackIndex } from "../lib/ja-audio-pack";
import { importJaAudioPack } from "../lib/ja-audio-store";
import { isFullJaDailySession, jaDailyDoneTodayN, jaDailyFullRunsOn, jaDailyStreakLabel, jaDailyStreakSessions } from "../lib/ja-daily-streak";
import { jaN5WordItems } from "../lib/review-sources";
import { REVIEW_KIND_AREA, REVIEW_KIND_LABEL_KO, REVIEW_KINDS, parseReviewItemKey } from "../lib/review-schedule";

// 네트워크 차단 — 이 eval은 오프라인 전용이다
globalThis.fetch = (() => {
  throw new Error("eval:ja-daily는 네트워크를 쓰지 않는다");
}) as typeof fetch;

interface CheckResult { area: string; check: string; pass: boolean; detail: string }
const results: CheckResult[] = [];
const add = (area: string, check: string, pass: boolean, detail = "") => results.push({ area, check, pass, detail });
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");
const codeOnly = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const NOW = "2026-11-15T01:00:00.000Z";

// ---------------------------------------------------------------------------
// 지어낸 픽스처
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
/** 지어낸 문장 — 한자 토큰 + 가나 토큰 */
function line(id: string, speaker: string | null = "A") {
  return { id, speaker, ja: "山へ行きます。", tokens: [{ surface: "山", reading: "やま" }, { surface: "へ", reading: null }, { surface: "行", reading: "い" }, { surface: "きます。", reading: null }], ko: "산에 갑니다." };
}
function kanaLesson(step: 1 | 2, lesson: number, tracks: number): JaDailyLesson {
  const id = `s${step}-l${pad(lesson)}`;
  const ts = Array.from({ length: tracks }, (_, i) => ({ audioKey: `${id}-t${i}`, part: "sound" as const, lines: [{ id: `${id}-t${i}-x0`, speaker: null, ja: "あいう", tokens: [{ surface: "あいう", reading: null }], ko: "아이우" }] }));
  return { id, step, lesson, kind: "kana", titleJa: "かな", titleKo: "가나", pointsKo: [], tracks: ts, keyLineIds: [`${id}-t0-x0`] };
}
function dialogLesson(step: 1 | 2 | 3, lesson: number): JaDailyLesson {
  const id = `s${step}-l${pad(lesson)}`;
  const parts = ["kaiwa1", "kaiwa2", "renshu1", "renshu2"] as const;
  return {
    id, step, lesson, kind: "dialog", titleJa: "山の話", titleKo: "산 이야기", pointsKo: ["~へ 行きます: ~에 갑니다"],
    tracks: parts.map((p, i) => ({ audioKey: `${id}-${p}`, part: p, lines: [line(`${id}-${i}-a`), line(`${id}-${i}-b`, "C")] })),
    keyLineIds: [`${id}-0-a`, `${id}-1-b`],
  };
}
function vocabDays(days: number, perDay = 25) {
  return Array.from({ length: days }, (_, d) => ({
    day: d + 1,
    words: Array.from({ length: perDay }, (_, i) => ({ id: `v${pad(d + 1)}-${pad(i + 1)}`, written: i % 3 === 0 ? "山" : i % 3 === 1 ? "テレビ" : "高い", reading: i % 3 === 0 ? "やま" : i % 3 === 1 ? "テレビ" : "たかい", meaningKo: `뜻 ${d + 1}-${i + 1}` })),
  }));
}
function tips(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `tip-${i + 1}`, audioKey: `ck-tip${i + 1}`, titleKo: `요령 ${i + 1}`, pointsKo: ["질문을 먼저 듣는다"] }));
}
function litems(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const mondai = ((i % 4) + 1) as 1 | 2 | 3 | 4;
    const withChoices = mondai >= 3;
    return {
      id: `li-${pad(i + 1)}`, audioKey: `ck-${i + 1}`, mondai, no: Math.floor(i / 4) + 1, ...(i < 4 ? { example: true } : {}),
      situationJa: "店で話しています。", questionJa: mondai === 3 ? null : "何を買いますか。",
      script: mondai === 3 ? [] : [{ speaker: "女", ja: "これをください。", ko: "이걸 주세요." }],
      choices: withChoices ? [{ ja: "はい", ko: "네" }, { ja: "いいえ", ko: "아니요" }, { ja: "どうぞ", ko: "자" }] : null,
      answer: withChoices ? 1 : null,
    };
  });
}
function mock(round: number, items = 67) {
  // 문자 20 · 문법 16 · 독해 7(지문 2개) · 청해 24 → 67
  const sec = (section: "moji" | "bunpou" | "dokkai" | "listening", mondai: number, count: number, startNo: number, points: number, passages?: string[]) => ({
    section, mondai, points,
    ...(passages ? { passages: passages.map((p) => ({ id: p, ja: "わたしは[[毎朝]]山へ行きます。", ko: "나는 매일 아침 산에 갑니다." })) } : {}),
    items: Array.from({ length: count }, (_, i) => ({
      id: `m${round}-${section}-${mondai}-${i + 1}`, no: startNo + i, stemJa: section === "listening" ? "" : "[[山]]へ行きます。",
      choices: ["やま", "かわ", "うみ", "そら"], answer: 1 + (i % 4),
      ...(passages ? { passageId: passages[i % passages.length] } : {}),
      ...(section === "listening" ? { audioKey: `mk${round}-${mondai}-${i + 1}`, choicesAreAudio: true } : {}),
    })),
  });
  const sections = [sec("moji", 1, 12, 1, 1), sec("moji", 2, 8, 13, 1), sec("bunpou", 1, 16, 1, 2), sec("dokkai", 4, 7, 1, 3, [`m${round}-p1`, `m${round}-p2`]), sec("listening", 1, 24, 1, 2)];
  void items;
  return { round, sections };
}
function bigFile(): JaDailyImportFile {
  const lessons: JaDailyLesson[] = [kanaLesson(1, 1, 11), kanaLesson(1, 2, 9)];
  for (let l = 3; l <= 16; l++) lessons.push(dialogLesson(1, l));
  for (let l = 1; l <= 16; l++) lessons.push(dialogLesson(2, l));
  lessons.push(dialogLesson(3, 1));
  return { format: JA_DAILY_IMPORT_FORMAT, presetKey: "ja-daily-test", lessons, vocabDays: vocabDays(18), listening: { tips: tips(7), items: litems(98) }, mocks: [mock(1), mock(2)] };
}
const FILE = bigFile();
const parsedFile = jaDailyImportFileSchema.safeParse(FILE);
const toRecords = (f: JaDailyImportFile): JaDailyContentRecord[] => decideJaDailyImport(f, [], NOW).writes;

// ---------------------------------------------------------------------------
// 1) 가져오기 계약
// ---------------------------------------------------------------------------
{
  const A = "가져오기 계약";
  add(A, "정상 파일(과 33·단어 450·청해 7+98·모의 2×67) 통과", parsedFile.success, parsedFile.success ? "" : JSON.stringify(parsedFile.error.issues.slice(0, 3)));
  const mut = (fn: (f: JaDailyImportFile) => void) => {
    const f = structuredClone(FILE);
    fn(f);
    return jaDailyImportFileSchema.safeParse(f).success;
  };
  add(A, "토큰을 이어도 ja와 다르면 거부", !mut((f) => (f.lessons[2].tracks[0].lines[0].tokens[3].surface = "きました。")));
  add(A, "한자+가나 섞인 토큰에 reading이면 거부(오쿠리가나)", !mut((f) => (f.lessons[2].tracks[0].lines[0].tokens = [{ surface: "山へ", reading: "やまへ" }, { surface: "行", reading: "い" }, { surface: "きます。", reading: null }])));
  add(A, "한자만인 토큰의 reading이 가타카나면 거부", !mut((f) => (f.lessons[2].tracks[0].lines[0].tokens[0].reading = "ヤマ")));
  {
    const f = structuredClone(FILE);
    f.lessons[2].tracks[0].lines[0].tokens[1].reading = "え";
    const r = jaDailyImportFileSchema.safeParse(f);
    add(A, "가나 토큰의 reading은 거부하지 않고 null로 정리(§5 같은 규칙)", r.success && r.data.lessons[2].tracks[0].lines[0].tokens[1].reading === null);
  }
  add(A, "id가 종류를 넘어 겹치면 거부(문장 id = 단어 id)", !mut((f) => (f.vocabDays[0].words[0].id = f.lessons[2].tracks[0].lines[0].id)));
  add(A, "id 형식(대문자) 거부", !mut((f) => (f.listening.tips[0].id = "Tip-1")));
  {
    const drill = (ja: string, tokens: { surface: string; reading: string | null }[]) => ({ no: 1, noteKo: "て ↔ で", items: [{ ja, tokens, ko: "날씨" }] });
    const ok = [{ surface: "天気", reading: "てんき" }];
    add(A, "요령 drills(원음 대본) 선택 필드 — 있으면 통과 · 없던 옛 파일도 통과", mut((f) => (f.listening.tips[0].drills = [drill("天気", ok)])) && jaDailyImportFileSchema.safeParse(FILE).success);
    add(A, "요령 drills — 토큰을 이어도 ja가 안 되면 거부", !mut((f) => (f.listening.tips[0].drills = [drill("電気", ok)])));
    add(A, "요령 drills — 한자+가나 섞인 토큰의 reading 거부", !mut((f) => (f.listening.tips[0].drills = [drill("行きます", [{ surface: "行きます", reading: "いきます" }])])));
    add(A, "요령 drills — items 0개·모르는 키 거부", !mut((f) => (f.listening.tips[0].drills = [{ no: 1, items: [] }])) && !mut((f) => (f.listening.tips[0].drills = [{ ...drill("天気", ok), extra: 1 } as never])));
    add(A, "요령 drills — 상한(번호 수·번호당 문장 수) 초과 거부", !mut((f) => (f.listening.tips[0].drills = Array.from({ length: JA_DAILY_LIMITS.tipDrills + 1 }, (_, i) => ({ ...drill("天気", ok), no: i })))) && !mut((f) => (f.listening.tips[0].drills = [{ no: 1, items: Array.from({ length: JA_DAILY_LIMITS.drillItems + 1 }, () => drill("天気", ok).items[0]) }])));
  }
  add(A, "keyLineIds가 그 과 문장이 아니면 거부", !mut((f) => (f.lessons[2].keyLineIds = [f.lessons[3].tracks[0].lines[0].id])));
  add(A, "청해 answer > 보기 수 거부", !mut((f) => (f.listening.items[2].answer = 4)));
  add(A, "청해 보기 없는데 answer 있으면 거부", !mut((f) => (f.listening.items[0].answer = 1)));
  add(A, "청해 script 빈 배열 허용(문제3 — 상황 문장만)", mut((f) => (f.listening.items[2].script = [])));
  add(A, "모의 answer > 보기 수 거부", !mut((f) => { f.mocks[0].sections[0].items[0].choices = ["やま", "かわ"]; f.mocks[0].sections[0].items[0].answer = 3; }));
  add(A, "모의 passageId가 같은 섹션 지문이 아니면 거부", !mut((f) => (f.mocks[0].sections[3].items[0].passageId = "m1-p9")));
  add(A, "밑줄 [[ ]] 짝이 안 맞으면 거부", !mut((f) => (f.mocks[0].sections[0].items[0].stemJa = "[[山へ行きます。")));
  add(A, "isUnderlineMarkupValid — 정상·빈 표시·중첩", isUnderlineMarkupValid("[[山]]へ[[行]]く") && !isUnderlineMarkupValid("[[]]") && !isUnderlineMarkupValid("[[山[[へ]]]]") && isUnderlineMarkupValid(""));
  add(A, "imageChoicesKo 길이 ≠ 보기 수 거부 · 같으면 통과", !mut((f) => (f.mocks[0].sections[4].items[0].imageChoicesKo = ["가", "나"])) && mut((f) => (f.mocks[0].sections[4].items[0].imageChoicesKo = ["가", "나", "다", "라"])));
  add(A, "선택 필드 introJa·questionJa·choicesAreAudio·script·지문 introJa 통과", mut((f) => { const it = f.mocks[0].sections[4].items[0]; it.introJa = "男の人と女の人が話しています。"; it.questionJa = "どこへ行きますか。"; it.script = [{ speaker: "男", ja: "山へ行きます。" }]; f.mocks[0].sections[3].passages![0].introJa = "メモを読んでください。"; }));
  add(A, "strict — 모르는 키 거부", !mut((f) => ((f.lessons[0] as unknown as Record<string, unknown>).extra = 1)) && !mut((f) => ((f as unknown as Record<string, unknown>).note = "x")));
  add(A, "단어 reading이 가나가 아니면 거부 · 가타카나 reading 허용", !mut((f) => (f.vocabDays[0].words[0].reading = "yama")) && mut((f) => (f.vocabDays[0].words[1].reading = "テレビ")));
  add(A, "format 다르면 거부", !mut((f) => ((f as unknown as Record<string, unknown>).format = "ja-daily/v2")));
  add(A, "DAY 번호 겹침·모의 회차 겹침 거부", !mut((f) => (f.vocabDays[1].day = 1)) && !mut((f) => { f.mocks[1] = structuredClone(f.mocks[1]); f.mocks[1].round = 1; f.mocks[1].sections.forEach((s) => s.items.forEach((it) => (it.id = it.id.replace("m2-", "mx-")))); f.mocks[1].sections[3].passages = undefined; f.mocks[1].sections[3].items.forEach((it) => delete it.passageId); }));
  add(A, "빈 파일(내용 0) 거부", !jaDailyImportFileSchema.safeParse({ format: JA_DAILY_IMPORT_FORMAT, presetKey: "x", lessons: [], vocabDays: [], listening: { tips: [], items: [] }, mocks: [] }).success);
  const maxDocs = JA_DAILY_LIMITS.lessons + JA_DAILY_LIMITS.vocabDays + JA_DAILY_LIMITS.tips + JA_DAILY_LIMITS.litems + JA_DAILY_LIMITS.mocks;
  add(A, "문서 상한 합 ≤ 450 < Firestore 트랜잭션 쓰기 500", maxDocs <= 450, String(maxDocs));
  add(A, "분할 — 과·날(d{n})·요령·청해·모의(r{n}) 한 문서씩", splitJaDailyFile(FILE).length === 33 + 18 + 7 + 98 + 2 && splitJaDailyFile(FILE).some((p) => p.kind === "vocab" && p.contentId === "d1") && splitJaDailyFile(FILE).some((p) => p.kind === "mock" && p.contentId === "r2"));
  const big = Buffer.byteLength(JSON.stringify(FILE));
  add(A, "지어낸 실규모 파일 크기 < 6MB 라우트 상한", big < 6 * 1024 * 1024, `${big}B`);
  // 배열 속 배열 없음(Firestore 거부) — 저장 문서 전부 검사
  const nested = (v: unknown): boolean => Array.isArray(v) ? v.some((x) => Array.isArray(x) || nested(x)) : v !== null && typeof v === "object" ? Object.values(v).some(nested) : false;
  add(A, "저장 문서에 배열 속 배열 0(Firestore)", toRecords(FILE).every((r) => !nested(r)));
}

// ---------------------------------------------------------------------------
// 2) 가져오기 결정
// ---------------------------------------------------------------------------
{
  const A = "가져오기 결정";
  const first = decideJaDailyImport(FILE, [], NOW);
  add(A, "처음 — 전부 added", first.result.lesson.added === 33 && first.result.vocab.added === 18 && first.result.litem.added === 98 && first.result.mock.added === 2 && first.writes.length === 158);
  const again = decideJaDailyImport(FILE, first.writes, NOW);
  add(A, "같은 파일 다시 — 전부 unchanged · 쓰기 0", again.writes.length === 0 && again.result.lesson.unchanged === 33);
  const f2 = structuredClone(FILE);
  f2.vocabDays[0].words[0].meaningKo = "바뀐 뜻";
  const ch = decideJaDailyImport(f2, first.writes, NOW);
  add(A, "한 날만 바뀜 — updated 1 · 쓰기 1", ch.writes.length === 1 && ch.result.vocab.updated === 1 && ch.writes[0].id === "vocab:d1");
  const f3 = structuredClone(FILE);
  f3.lessons = f3.lessons.slice(0, 1);
  const sub = decideJaDailyImport(f3, first.writes, NOW);
  add(A, "파일에 없는 문서는 지우지 않는다(쓰기 목록에 삭제 없음)", sub.writes.length === 0 && !("deleted" in sub.result.lesson));
  add(A, "문서 id = {kind}:{contentId}", first.writes.every((w) => w.id === `${w.kind}:${w.contentId}`));
  const idx = toJaDailyContentIndex([...first.writes].reverse());
  add(A, "색인 — 읽기 순서와 무관하게 같은 색인", JSON.stringify(idx) === JSON.stringify(toJaDailyContentIndex(first.writes)));
}

// ---------------------------------------------------------------------------
// 3) 과정 엔진
// ---------------------------------------------------------------------------
const INDEX = toJaDailyContentIndex(toRecords(FILE));
const COURSE = buildJaDailyCourse(INDEX);
{
  const A = "과정 엔진";
  add(A, "전체 90회 = 본 과정 80 + 꼬리 10", COURSE.length === 90 && COURSE.filter((s) => s.phase === "core").length === JA_DAILY_CORE_MIN && COURSE.filter((s) => s.phase === "tail").length === JA_DAILY_TAIL, String(COURSE.length));
  const units = COURSE.filter((s) => s.kaiwa.type === "unit");
  add(A, "회화 단위 80(kana 4 + Step1 28 + Step2 48) → 1~80회", units.length === 80 && units.every((s) => s.n <= 80), String(units.length));
  const k = (n: number) => COURSE[n - 1].kaiwa;
  const ku = (n: number) => { const x = k(n); return x.type === "unit" ? x : null; };
  add(A, "kana 1과 11트랙 → 6+5 · 2과 9트랙 → 6+3", ku(1)?.trackKeys.length === 6 && ku(2)?.trackKeys.length === 5 && ku(3)?.trackKeys.length === 6 && ku(4)?.trackKeys.length === 3);
  add(A, "kana 🎤는 그 과 마지막 단위에만", ku(1)?.keyLineIds.length === 0 && ku(2)?.keyLineIds.length === 1);
  const s1A = k(5);
  const s1B = k(6);
  add(A, "Step1 dialog A = 会話1+練習1(🎤 없음) · B = 会話2+練習2+🎤", s1A.type === "unit" && s1A.unit === "A" && s1A.trackKeys.join() === "s1-l03-kaiwa1,s1-l03-renshu1" && s1A.keyLineIds.length === 0 && s1B.type === "unit" && s1B.unit === "B" && s1B.trackKeys.join() === "s1-l03-kaiwa2,s1-l03-renshu2" && s1B.keyLineIds.length === 2);
  const s2 = [k(33), k(34), k(35)];
  add(A, "Step2 dialog A·B·C — C = 과 전체 + 🎤 + 포인트", s2.map((u) => (u.type === "unit" ? u.unit : "?")).join("") === "ABC" && s2[2].type === "unit" && s2[2].trackKeys.length === 4 && s2[2].withPoints && s2[2].keyLineIds.length === 2 && s2[1].type === "unit" && s2[1].keyLineIds.length === 0);
  add(A, "Step3는 이번 과정 큐에 없다(다음 과정 단위로만)", !units.some((s) => s.kaiwa.type === "unit" && s.kaiwa.lessonId.startsWith("s3-")) && buildJaDailyNextCourseUnits(INDEX).length === 3);
  add(A, "81~90 회화 = 약한 과 다시 하기", COURSE.slice(80).every((s) => s.kaiwa.type === "review"));
  const v = (n: number) => COURSE[n - 1].vocab;
  add(A, "단어 DAY 1 = 1회 1~13 · 2회 14~25 · 3회 DAY 시험", JSON.stringify([v(1), v(2), v(3)]) === JSON.stringify([{ type: "cards", day: 1, from: 1, to: 13 }, { type: "cards", day: 1, from: 14, to: 25 }, { type: "dayTest", day: 1 }]));
  add(A, "DAY 18 시험 = 54회 · 55회부터 약한 단어", JSON.stringify(v(54)) === JSON.stringify({ type: "dayTest", day: 18 }) && COURSE.slice(54).every((s) => s.vocab.type === "weak"));
  const e = (n: number) => COURSE[n - 1].exam;
  add(A, "시험 대비 1~7 = 요령 하나씩", [1, 2, 3, 4, 5, 6, 7].every((n) => e(n).type === "tip") && (e(1) as { tipId: string }).tipId === "tip-1");
  const lit = COURSE.filter((s) => s.exam.type === "litems");
  const litIds = lit.flatMap((s) => (s.exam.type === "litems" ? s.exam.itemIds : []));
  add(A, "청해 훈련 — 예제 제외 94문항 · 2개씩 47회 · 문제 1→2→3→4", lit.length === 47 && litIds.length === 94 && !litIds.some((id) => ["li-01", "li-02", "li-03", "li-04"].includes(id)) && lit[0].n === 8, `${lit.length}/${litIds.length}`);
  const mondaiOf = (id: string) => FILE.listening.items.find((x) => x.id === id)!.mondai;
  add(A, "청해 문항 순서 = 문제 번호 오름차순", litIds.every((id, i) => i === 0 || mondaiOf(litIds[i - 1]) <= mondaiOf(id)));
  const mk = COURSE.filter((s) => s.exam.type === "mockItems");
  const mkIds = mk.flatMap((s) => (s.exam.type === "mockItems" ? s.exam.itemIds : []));
  const r1Ids = FILE.mocks[0].sections.flatMap((s) => s.items.map((i) => i.id));
  add(A, "실전모의 1회 67문항 — 빠짐·중복 없이 80회 안", mkIds.length === 67 && new Set(mkIds).size === 67 && r1Ids.every((id) => mkIds.includes(id)) && mk.every((s) => s.n <= 80), `${mk.length}회, 끝 ${mk[mk.length - 1]?.n}`);
  const slots = 80 - (7 + 47);
  const chunk = Math.max(3, Math.ceil(67 / slots));
  add(A, "하루 몫 = max(3, ⌈67 ÷ (80 − 54)⌉) = 3 — 지문 묶음 외에는 몫을 넘지 않는다", chunk === 3 && mk.every((s) => s.exam.type === "mockItems" && s.exam.itemIds.length >= 3 || s === mk[mk.length - 1]), `chunk ${chunk}`);
  add(A, "모의 섹션 순서 문자→문법→독해→청해", mkIds.findIndex((id) => id.includes("-bunpou-")) > mkIds.findIndex((id) => id.includes("-moji-")) && mkIds.findIndex((id) => id.includes("-dokkai-")) > mkIds.lastIndexOf(mkIds.filter((id) => id.includes("-bunpou-")).pop()!) && mkIds.findIndex((id) => id.includes("-listening-")) > mkIds.findIndex((id) => id.includes("-dokkai-")));
  // 지문 묶음 — 같은 지문이 연속하면 한 날
  const grouped = chunkJaDailyMockItems([{ id: "a", passageId: null }, { id: "b", passageId: "p" }, { id: "c", passageId: "p" }, { id: "d", passageId: "p" }, { id: "e", passageId: null }], 2);
  add(A, "chunkJaDailyMockItems — 같은 지문 연속 문항은 한 날(몫을 넘어도)", JSON.stringify(grouped) === JSON.stringify([["a", "b", "c", "d"], ["e"]]), JSON.stringify(grouped));
  const tailTypes = COURSE.slice(80).map((s) => s.exam.type + ("round" in s.exam ? s.exam.round : "") + ("sections" in s.exam ? `(${s.exam.sections.join("+")})` : ""));
  add(A, "꼬리 81~90 = 2회 문자 / 문법+독해 / 청해 / 채점표 / 1회 오답 / 2회 오답 / 총정리×4", tailTypes.join(",") === "mockSection2(moji),mockSection2(bunpou+dokkai),mockSection2(listening),mockScore2,mockReview1,mockReview2,final,final,final,final", tailTypes.join(","));
  add(A, "minutesHint — 평일 30분 · 실전 섹션은 시험 시간", COURSE[0].minutesHint === 30 && COURSE[81].minutesHint === 10 + 8 + 40 + 4, `${COURSE[0].minutesHint}/${COURSE[81].minutesHint}`);
  // 결정성
  const shuffled = toJaDailyContentIndex([...toRecords(FILE)].sort((a, b) => (a.hash < b.hash ? -1 : 1)));
  add(A, "결정성 — 같은 입력 두 번·읽기 순서가 달라도 같은 과정", JSON.stringify(buildJaDailyCourse(INDEX)) === JSON.stringify(COURSE) && JSON.stringify(buildJaDailyCourse(shuffled)) === JSON.stringify(COURSE));
  add(A, "엔진 소스에 Date·Math.random 없음 · 런타임 import 0", !/Date\.now|new Date|Math\.random/.test(codeOnly("../lib/ja-daily-plan.ts")) && [...src("../lib/ja-daily-plan.ts").matchAll(/^import (?!type )/gm)].length === 0);
  // 늘어남
  const more = structuredClone(FILE);
  for (let l = 17; l <= 26; l++) more.lessons.push(dialogLesson(2, l));
  const c2 = buildJaDailyCourse(toJaDailyContentIndex(toRecords(more)));
  add(A, "내용이 늘면 과정이 늘고(80+30=110 단위 → 120회) 꼬리 10은 맨 끝", c2.length === 120 && c2.slice(110).every((s) => s.phase === "tail") && c2[109].kaiwa.type === "unit" && c2[110].exam.type === "mockSection", String(c2.length));
  const small = buildJaDailyCourse(toJaDailyContentIndex(toRecords({ ...FILE, lessons: FILE.lessons.slice(0, 3), mocks: [] })));
  add(A, "내용이 적어도 90회 · 모의가 없으면 꼬리는 총정리", small.length === 90 && small.slice(80).every((s) => s.exam.type === "final"));
  add(A, "내용 0 → 과정 없음", buildJaDailyCourse({ lessons: [], vocabDays: [], tips: [], litems: [], mocks: [] }).length === 0);
  add(A, "과정 뒤 회차 = 반복 모드 · n<1 → null", jaDailySessionAt(COURSE, 91)?.phase === "repeat" && jaDailySessionAt(COURSE, 0) === null);
  add(A, "naturalCompare — tip-2 < tip-10", naturalCompare("tip-2", "tip-10") < 0 && naturalCompare("a", "a") === 0);
}

// ---------------------------------------------------------------------------
// 4) 다음 회차 · 약한 것
// ---------------------------------------------------------------------------
const rec = (n: number, over: Partial<JaDailySessionRecord> = {}): JaDailySessionRecord => ({
  id: `r${n}${over.replay ? "-re" : ""}`, n, replay: false, startedAt: `2026-11-${pad(10 + (n % 15))}T00:00:00.000Z`, finishedAt: `2026-11-${pad(10 + (n % 15))}T00:30:00.000Z`,
  steps: { kaiwa: "done", vocab: "done", exam: "done", review: "skipped" }, kaiwaChecks: [], vocabAnswers: [], examAnswers: [], ...over,
});
{
  const A = "다음 회차·약한 것";
  add(A, "기록 0 → Day 1", nextJaDailySession(COURSE, []).n === 1);
  add(A, "기록 1·2·5 → Day 6(최댓값 기준)", nextJaDailySession(COURSE, [rec(1), rec(2), rec(5)]).n === 6);
  add(A, "replay 기록은 진도를 움직이지 않는다", nextJaDailySession(COURSE, [rec(1), rec(9, { replay: true })]).n === 2);
  add(A, "90 끝내면 courseDone", nextJaDailySession(COURSE, [rec(90)]).courseDone && nextJaDailySession(COURSE, [rec(90)]).session?.phase === "repeat");
  const recs = [
    rec(1, { vocabAnswers: [{ wordId: "v01-02", mode: "meaning", correct: false }, { wordId: "v01-01", mode: "meaning", correct: true }, { wordId: "v01-03", mode: "reading", correct: false }, { wordId: "v01-03", mode: "meaning", correct: true }] }),
    rec(2, { vocabAnswers: [{ wordId: "v01-02", mode: "reading", correct: false }] }),
  ];
  add(A, "약한 단어 — 정답률 낮은 순, 틀린 것 먼저, 나머지 뒤", pickWeakWords(recs).join() === "v01-02,v01-03,v01-01", pickWeakWords(recs).join());
  const items = [rec(3, { examAnswers: [{ itemId: "li-09", choice: 2, correct: false }, { itemId: "li-05", choice: null, correct: null }, { itemId: "li-07", choice: 1, correct: true }] })];
  add(A, "약한 문항 — 스스로 확인(null)은 빠진다", pickWeakItems(items).join() === "li-09,li-07");
  const lessonsRec = [rec(6, { kaiwaChecks: [{ lineId: "s1-l03-0-a", accuracy: 0.9, verdict: "pass", transcript: null }, { lineId: "s1-l04-0-a", accuracy: 0.4, verdict: "retry", transcript: null }, { lineId: "s1-l05-0-a", accuracy: null, verdict: "skipped", transcript: null }] })];
  const weak = pickWeakLessons(lessonsRec, INDEX.lessons);
  add(A, "약한 과 — 평균 낮은 과부터, 기록 없는 과는 뒤(과 순서), Step3 제외", weak[0] === "s1-l04" && weak[1] === "s1-l03" && weak[2] === "s1-l01" && !weak.some((x) => x.startsWith("s3-")) && weak.length === 32, weak.slice(0, 3).join());
  add(A, "약한 것 고르기 결정적(두 번 같다)", pickWeakWords(recs).join() === pickWeakWords(recs).join() && pickWeakLessons(lessonsRec, INDEX.lessons).join() === weak.join());
}

// ---------------------------------------------------------------------------
// 5) jpack 파서
// ---------------------------------------------------------------------------
void (async () => {
  {
    const A = "jpack 파서";
    const t1 = new Uint8Array([1, 2, 3, 4, 5]);
    const t2 = new Uint8Array(1000).map((_, i) => i % 251);
    const pack = buildJaPack([{ key: "Step1_01", type: "audio/mp4", bytes: t1 }, { key: "ck-1", type: "audio/mp4", bytes: t2 }]);
    const blob = new Blob([pack]);
    const idx = await readJaPackIndex(blob);
    add(A, "만들고 읽기 — 트랙 2 · 키·길이", idx.ok && idx.value.length === 2 && idx.value[0].key === "Step1_01" && idx.value[1].length === 1000);
    if (idx.ok) {
      const b1 = new Uint8Array(await jaPackSlice(blob, idx.value[0]));
      const b2 = new Uint8Array(await jaPackSlice(blob, idx.value[1]));
      add(A, "조각 경계 — 바이트가 그대로(앞뒤 1바이트도 안 섞임)", b1.join() === t1.join() && b2.length === 1000 && b2[0] === 0 && b2[999] === 999 % 251);
    }
    const bad = pack.slice();
    bad[0] = 0x58;
    add(A, "머리 글자 다르면 bad_magic", (await readJaPackIndex(new Blob([bad]))).ok === false && parseJaPackHeader(bad, bad.length).ok === false && (parseJaPackHeader(bad, bad.length) as { error: string }).error === "bad_magic");
    const longIdx = pack.slice();
    longIdx[9] = 0x7f;
    add(A, "색인 길이가 파일을 넘으면 bad_index_length", (parseJaPackHeader(longIdx, longIdx.length) as { error?: string }).error === "bad_index_length");
    add(A, "10바이트 미만 too_small", (parseJaPackHeader(pack.slice(0, 5), 5) as { error?: string }).error === "too_small");
    const ok = (s: string, len = 200, size = 10000) => parseJaPackIndex(s, len, size);
    add(A, "겹치는 조각 overlap", (ok(JSON.stringify([{ key: "a", type: "audio/mp4", offset: 300, length: 100 }, { key: "b", type: "audio/mp4", offset: 350, length: 10 }])) as { error?: string }).error === "overlap");
    add(A, "색인 안을 가리키면 out_of_range", (ok(JSON.stringify([{ key: "a", type: "audio/mp4", offset: 100, length: 10 }])) as { error?: string }).error === "out_of_range");
    add(A, "파일 끝을 넘으면 out_of_range", (ok(JSON.stringify([{ key: "a", type: "audio/mp4", offset: 9995, length: 10 }])) as { error?: string }).error === "out_of_range");
    add(A, "같은 키 두 번 duplicate_key", (ok(JSON.stringify([{ key: "a", type: "audio/mp4", offset: 300, length: 1 }, { key: "a", type: "audio/mp4", offset: 400, length: 1 }])) as { error?: string }).error === "duplicate_key");
    add(A, "모르는 형식·음수 길이·키 형식 bad_entry", ["audio/ogg"].every((t) => (ok(JSON.stringify([{ key: "a", type: t, offset: 300, length: 1 }])) as { error?: string }).error === "bad_entry") && (ok(JSON.stringify([{ key: "a", type: "audio/mp4", offset: 300, length: -1 }])) as { error?: string }).error === "bad_entry" && (ok(JSON.stringify([{ key: "../x", type: "audio/mp4", offset: 300, length: 1 }])) as { error?: string }).error === "bad_entry");
    add(A, "깨진 JSON bad_index_json · 빈 배열 empty", (ok("{nope") as { error?: string }).error === "bad_index_json" && (ok("[]") as { error?: string }).error === "empty");
    const brokenUtf8 = pack.slice();
    brokenUtf8[12] = 0xff;
    add(A, "색인 UTF-8이 깨지면 거부(fatal)", (await readJaPackIndex(new Blob([brokenUtf8]))).ok === false);
    const store = src("../lib/ja-audio-store.ts");
    add(A, "기기 보관소 — fetch 0 · DB eunwoo-ja-audio · store tracks · 최상위 indexedDB 접근 없음", !/fetch\(/.test(codeOnly("../lib/ja-audio-store.ts")) && /"eunwoo-ja-audio"/.test(store) && /const STORE = "tracks"/.test(store) && /typeof indexedDB === "undefined"/.test(store));
    add(A, "기기 보관소 — 서버(app/api·lib/store*)에서 import 0", !/ja-audio-store/.test(src("../lib/store.ts") + src("../lib/store-firestore.ts") + src("../app/api/japanese/daily/route.ts") + src("../app/api/japanese/daily/import/route.ts")));
    {
      // P2-B(QA daily-full) — 파일 읽기 실패(NotReadableError)는 던지지 않고 read_failed를 돌려준다
      const notReadable = () => Promise.reject(Object.assign(new Error("gone"), { name: "NotReadableError" }));
      const deadHead = { size: pack.length, slice: () => ({ arrayBuffer: notReadable }) };
      const r1 = await importJaAudioPack(deadHead).catch((e: unknown) => ({ threw: String(e) }));
      // 색인은 읽히고 트랙 조각에서 끊기는 경우 — 최소 가짜 IndexedDB(쓰기 성공)를 깔고 본다
      const put: string[] = [];
      const fakeIdb = {
        open() {
          const req: Record<string, unknown> = {};
          const db = {
            objectStoreNames: { contains: () => true },
            transaction() {
              const t: Record<string, unknown> = {};
              const store = { put(v: { key: string }) { put.push(v.key); const q: Record<string, unknown> = { result: v.key }; setTimeout(() => { (q.onsuccess as (() => void) | undefined)?.(); (t.oncomplete as () => void)(); }, 0); return q; } };
              t.objectStore = () => store;
              return t;
            },
            close() {},
          };
          req.result = db;
          setTimeout(() => (req.onsuccess as () => void)(), 0);
          return req;
        },
      };
      (globalThis as { indexedDB?: unknown }).indexedDB = fakeIdb;
      let reads = 0;
      const midDead = { size: pack.length, slice: (a?: number, b?: number) => ({ arrayBuffer: () => (a !== undefined && a >= 10 + 0 && reads++ >= 2 ? notReadable() : blob.slice(a, b).arrayBuffer()) }) };
      const r2 = await importJaAudioPack(midDead).catch((e: unknown) => ({ threw: String(e) }));
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
      add(A, "가져오기 중 파일 읽기 실패 → 던지지 않고 read_failed(색인 단계 saved 0 · 트랙 단계는 들어간 수 유지)", "ok" in r1 && r1.ok === false && r1.error === "read_failed" && r1.saved === 0 && "ok" in r2 && r2.ok === false && r2.error === "read_failed" && r2.saved === 1 && r2.total === 2 && put.length === 1, JSON.stringify([r1, r2, put]));
      const home = codeOnly("../components/ja-daily-home.tsx");
      add(A, "홈 원음 가져오기 — try/finally로 진행 막대 정리(setProg(null)) · 다시 가져오기 안내", /try \{\s*const r = await importJaAudioPack[\s\S]*finally \{[\s\S]*setProg\(null\)/.test(home) && /다시 가져오세요/.test(home));
    }
  }
  report();
})();

// ---------------------------------------------------------------------------
// 6) 🎤 판정 · 저장 계약 · 채점표
// ---------------------------------------------------------------------------
{
  const A = "판정";
  add(A, "문턱 상수 0.8 · 0.5", JA_DAILY_PASS_ACCURACY === 0.8 && JA_DAILY_CLOSE_ACCURACY === 0.5);
  add(A, "경계 — 0.8 맞음 · 0.7999 아깝다 · 0.5 아깝다 · 0.4999 다시 · NaN 다시", jaDailyVerdictOf(0.8) === "pass" && jaDailyVerdictOf(0.7999) === "close" && jaDailyVerdictOf(0.5) === "close" && jaDailyVerdictOf(0.4999) === "retry" && jaDailyVerdictOf(Number.NaN) === "retry");
  const toks = line("x").tokens;
  add(A, "같은 문장 → 맞음 1.0", judgeJaDailyLine(toks, "山へ行きます。").verdict === "pass" && judgeJaDailyLine(toks, "山へ行きます").accuracy === 1);
  add(A, "한자를 가나로 받아써도 맞음(읽기 갈래)", judgeJaDailyLine(toks, "やまへいきます").verdict === "pass");
  add(A, "빈 받아쓰기 → 0 · 다시", judgeJaDailyLine(toks, "  ").accuracy === 0 && judgeJaDailyLine(toks, "").verdict === "retry");
  add(A, "다른 문장 → 다시", judgeJaDailyLine(toks, "海で泳ぎました").verdict === "retry");
  {
    // 받아쓰기가 로마자로 와도 가나로 바꿔 대조(2026-11-18 실기기 "gadko sakka" → 0%)
    const wt = [{ surface: "がっこう", reading: null }, { surface: "さっか", reading: null }];
    add(A, "로마자 받아쓰기 → 가나로 바꿔 맞음(gakkou sakka · 장음 기호 gakkō)", judgeJaDailyLine(wt, "gakkou sakka").verdict === "pass" && judgeJaDailyLine(wt, "Gakkō Sakka").verdict === "pass");
    add(A, "로마자 → 한자 문장의 읽기 갈래로도 맞음(yama e ikimasu)", judgeJaDailyLine(toks, "yama e ikimasu").verdict === "pass");
    add(A, "로마자가 달라도 그대로 틀림(umi de oyogimashita → 다시)", judgeJaDailyLine(toks, "umi de oyogimashita").verdict === "retry");
    add(A, "로마자 변환 — ん·っ·拗音", jaRomajiToHiragana("konnichiwa onna sanpo kitte matcha shinbun kyou") === "こんにちわ おんな さんぽ きって まっちゃ しんぶん きょう");
  }
  add(A, "판정은 alignJaReadAloud 재사용(새 대조 없음)", /alignJaReadAloud\(tokens, transcript\)/.test(codeOnly("../lib/ja-daily-judge.ts")) && /from "\.\/ja-daily-judge"/.test(src("../lib/ja-daily-contract.ts")));
}
{
  const A = "저장 계약";
  const good = rec(1, { kaiwaChecks: [{ lineId: "s1-l03-0-a", accuracy: 0.9, verdict: "pass", transcript: "山へ行きます" }], vocabAnswers: [{ wordId: "v01-01", mode: "meaning", correct: true }], examAnswers: [{ itemId: "tip-1", choice: null, correct: null }] });
  add(A, "정상 기록 통과", jaDailySessionSaveSchema.safeParse(good).success);
  add(A, "finishedAt null·없음 거부(끝까지 한 회차만)", !jaDailySessionSaveSchema.safeParse({ ...good, finishedAt: null }).success);
  add(A, "steps 값이 done/skipped 밖이면 거부", !jaDailySessionSaveSchema.safeParse({ ...good, steps: { ...good.steps, exam: "half" } }).success);
  add(A, "choice·correct 한쪽만 null 거부", !jaDailySessionSaveSchema.safeParse({ ...good, examAnswers: [{ itemId: "li-05", choice: 1, correct: null }] }).success);
  add(A, "accuracy 1 초과 거부 · strict", !jaDailySessionSaveSchema.safeParse({ ...good, kaiwaChecks: [{ ...good.kaiwaChecks[0], accuracy: 1.2 }] }).success && !jaDailySessionSaveSchema.safeParse({ ...good, extra: 1 }).success);
  const existing = [rec(1), rec(2)];
  add(A, "같은 id → reused", decideJaDailySave({ id: "r2", n: 2, replay: false }, existing).kind === "reused");
  add(A, "다음 회차(3) 저장 ok · 4는 앞질러 저장 ahead(next 3)", decideJaDailySave({ id: "n3", n: 3, replay: false }, existing).kind === "ok" && JSON.stringify(decideJaDailySave({ id: "n4", n: 4, replay: false }, existing)) === JSON.stringify({ kind: "ahead", next: 3 }));
  add(A, "replay — 끝낸 n(2)만 ok · 안 한 n(3)은 replay_not_done", decideJaDailySave({ id: "re2", n: 2, replay: true }, existing).kind === "ok" && decideJaDailySave({ id: "re3", n: 3, replay: true }, existing).kind === "replay_not_done");
  add(A, "같은 id·같은 본문(키 순서만 다름) → reused · 다른 본문 → conflict(409)", decideJaDailySave(JSON.parse(JSON.stringify({ ...rec(2), steps: { review: "skipped", exam: "done", vocab: "done", kaiwa: "done" } })), existing).kind === "reused" && decideJaDailySave({ ...rec(2), steps: { ...rec(2).steps, review: "done" } }, existing).kind === "conflict" && decideJaDailySave({ id: "r2", n: 3, replay: false }, existing).kind === "conflict");
  add(A, "replay 기록만 있는 n은 진도로 치지 않는다", decideJaDailySave({ id: "n2", n: 2, replay: false }, [rec(1, { replay: true })]).kind === "ahead");
  const route = codeOnly("../app/api/japanese/daily/sessions/route.ts");
  add(A, "라우트 — reused 200 · conflict 409 · ahead/replay 400 · 실제 바이트 상한 · 키 검사 없음", /decision\.kind === "conflict"\)[^\n]*409/.test(route) && /Buffer\.byteLength\(text, "utf8"\) > MAX_BYTES/.test(route) && /decision\.kind === "reused"\) return json\(\{ ok: true, reused: true \}\)/.test(route) && /decision\.kind === "ahead"\)[^\n]*400/.test(route) && /replay_not_done"\)[^\n]*400/.test(route) && !/OPENAI_API_KEY/.test(route));
}
{
  const A = "채점표";
  const m = FILE.mocks[0];
  const answers = new Map<string, { correct: boolean | null }>();
  for (const s of m.sections) for (const it of s.items) answers.set(it.id, { correct: true });
  const full = scoreJaDailyMock(m, answers);
  add(A, "만점 — 언어지식·독해 120 · 청해 60 · 합격", full.langReading.scaled === 120 && full.listening.scaled === 60 && full.total === 180 && full.pass, JSON.stringify([full.langReading, full.listening]));
  add(A, "배점 합 = 섹션 points × 문항(지어낸 파일: 20+32+21=73 · 48)", full.langReading.max === 73 && full.listening.max === 48);
  for (const s of m.sections) if (s.section === "listening") for (const it of s.items.slice(0, 17)) answers.set(it.id, { correct: false });
  const low = scoreJaDailyMock(m, answers);
  add(A, "청해 기준점 미달(14/48 → 18/60 < 19)이면 총점이 넘어도 불합격", low.listening.scaled === 18 && !low.listening.pass && low.total >= 80 && !low.pass && low.wrongItemIds.length === 17, JSON.stringify(low.listening));
  const latest = latestJaDailyExamAnswers([rec(1, { finishedAt: "2026-11-02T00:00:00.000Z", examAnswers: [{ itemId: "a", choice: 1, correct: true }] }), rec(2, { finishedAt: "2026-11-01T00:00:00.000Z", examAnswers: [{ itemId: "a", choice: 2, correct: false }] })]);
  add(A, "최신 답 = finishedAt이 늦은 기록", latest.get("a")?.correct === true);
}

// ---------------------------------------------------------------------------
// 7) 회차 풀기
// ---------------------------------------------------------------------------
{
  const A = "회차 풀기";
  const content = toRecords(FILE);
  const d1 = resolveJaDailySession(1, content, []);
  add(A, "Day 1 — kana 단위 6트랙 · 단어 13 · 요령 1", d1.ok && d1.kaiwa.type === "unit" && d1.kaiwa.tracks.length === 6 && d1.vocab.words.length === 13 && d1.vocab.mode === "cards" && d1.exam.type === "tip" && !d1.replay);
  add(A, "단어 보기 재료 = 같은 DAY + 다음 DAY(1일차엔 앞 DAY 없음)", d1.ok && d1.vocab.pool.length === 50);
  add(A, "앞질러 열기 → ahead(nextN)", (() => { const r = resolveJaDailySession(3, content, [rec(1)]); return !r.ok && r.error === "ahead" && r.nextN === 2; })());
  add(A, "끝낸 회차 다시 열기 → replay true", (() => { const r = resolveJaDailySession(1, content, [rec(1)]); return r.ok && r.replay; })());
  add(A, "내용 없음 → no_content", (() => { const r = resolveJaDailySession(1, [], []); return !r.ok && r.error === "no_content"; })());
  const done = Array.from({ length: 85 }, (_, i) => rec(i + 1));
  const wrongId = FILE.mocks[0].sections[0].items[0].id;
  done[59] = rec(60, { examAnswers: [{ itemId: wrongId, choice: 2, correct: false }] });
  const r85 = resolveJaDailySession(85, content, done);
  add(A, "85회 1회 오답 다시 — 최신 답이 틀린 문항만", r85.ok && r85.exam.type === "mockReview" && r85.exam.items.length === 1 && r85.exam.items[0].item.id === wrongId);
  const r84 = resolveJaDailySession(84, content, done);
  add(A, "84회 채점표 — 2회 점수 · 미응답 문항 보기", r84.ok && r84.exam.type === "mockScore" && r84.exam.round === 2 && r84.exam.score.unansweredItemIds.length === 67);
  {
    // P2-A(QA daily-full) — 84회 채점표·홈 실전 점수는 81~83회 실전 진도 기록의 답만. 85·86·총정리·다시 하기 뒤에도 그대로
    const m2 = FILE.mocks[1].sections.flatMap((x) => x.items.map((it) => ({ id: it.id, answer: it.answer })));
    const [a, b] = m2;
    const base = Array.from({ length: 85 }, (_, i) => rec(i + 1));
    base[80] = rec(81, { examAnswers: [{ itemId: a.id, choice: a.answer, correct: true }, { itemId: b.id, choice: (b.answer % 4) + 1, correct: false }] });
    const before = resolveJaDailySession(84, content, base);
    const allRight = m2.map((x) => ({ itemId: x.id, choice: x.answer, correct: true }));
    const later = [
      ...base,
      rec(86, { finishedAt: "2026-12-30T00:30:00.000Z", examAnswers: allRight }),
      { ...rec(81, { replay: true, finishedAt: "2026-12-31T00:30:00.000Z", examAnswers: allRight }), id: "r81-replay" },
      rec(87, { finishedAt: "2027-01-01T00:30:00.000Z", examAnswers: allRight }),
    ];
    const after = resolveJaDailySession(84, content, later);
    const sc = (r: ReturnType<typeof resolveJaDailySession>) => (r.ok && r.exam.type === "mockScore" ? r.exam.score : null);
    const s0 = sc(before);
    const s1 = sc(after);
    add(A, "84회 채점표 = 실전(81~83 진도) 답만 — 86·다시 하기·총정리 뒤에도 점수 불변", !!s0 && !!s1 && JSON.stringify(s0) === JSON.stringify(s1) && s0.wrongItemIds.length === 1 && s0.unansweredItemIds.length === m2.length - 2 && s0.total < 10, JSON.stringify([s0?.total, s1?.total]));
    const real = jaDailyMockRealAnswers(buildJaDailyCourse(toJaDailyContentIndex(content)), later, 2);
    add(A, "실전 답 정의처 jaDailyMockRealAnswers — 2회 실전 있음 · replay·86·87 답 제외(2문항만)", real.hasExam && real.answers.size === 2 && !jaDailyMockRealAnswers(buildJaDailyCourse(toJaDailyContentIndex(content)), later, 1).hasExam);
    const r86 = resolveJaDailySession(86, content, base);
    add(A, "86회 2회 오답 다시 = 틀린 문항 + 실전에서 안 푼 문항(QA P3-4) · 85회(실전 없는 1회)는 틀린 것만", r86.ok && r86.exam.type === "mockReview" && r86.exam.items.length === m2.length - 1 && !r86.exam.items.some((v) => v.item.id === a.id));
  }
  const r82 = resolveJaDailySession(82, content, done);
  add(A, "82회 실전 — 2회 문법+독해 섹션 문항(지문 붙음)", r82.ok && r82.exam.type === "mockSection" && r82.exam.items.length === 23 && r82.exam.items.some((v) => v.passage !== null));
  const r81 = resolveJaDailySession(81, content, done);
  add(A, "81회 회화 = 약한 과(과 전체 트랙 + 🎤)", r81.ok && r81.kaiwa.type === "unit" && r81.kaiwa.review && r81.kaiwa.tracks.length >= 4);
  add(A, "소스 — Date·Math.random 없음", !/Date\.now|new Date|Math\.random/.test(codeOnly("../lib/ja-daily-session.ts")));
}

// ---------------------------------------------------------------------------
// 8) 스트릭 소스
// ---------------------------------------------------------------------------
{
  const A = "스트릭";
  add(A, "한 판 = 끝낸 회차 + done ≥ 1 · 전부 건너뜀은 아님", isFullJaDailySession(rec(1)) && !isFullJaDailySession(rec(2, { steps: { kaiwa: "skipped", vocab: "skipped", exam: "skipped", review: "skipped" } })));
  add(A, "replay 회차도 한 판", isFullJaDailySession(rec(3, { replay: true })));
  {
    // 홈 "오늘 완료"와 스트릭은 같은 판정(startedAt KST + 한 판) — QA daily1 P2-A
    // 23:40 KST(14:40Z) 시작 → 00:10 KST(다음 날 15:10Z) 끝: 스트릭에선 시작한 날(11-14)의 한 판
    const midnight = rec(5, { startedAt: "2026-11-14T14:40:00.000Z", finishedAt: "2026-11-14T15:10:00.000Z" });
    const allSkipped = rec(6, { startedAt: "2026-11-15T01:00:00.000Z", finishedAt: "2026-11-15T01:30:00.000Z", steps: { kaiwa: "skipped", vocab: "skipped", exam: "skipped", review: "skipped" } });
    const replayToday = rec(2, { replay: true, startedAt: "2026-11-15T02:00:00.000Z", finishedAt: "2026-11-15T02:30:00.000Z" });
    add(A, "자정 넘긴 회차 — '오늘 완료'는 시작한 날(11-14)에만, 끝난 날(11-15)엔 아님(스트릭과 같은 날)", jaDailyDoneTodayN([midnight], "2026-11-14") === 5 && jaDailyDoneTodayN([midnight], "2026-11-15") === null && jaDailyFullRunsOn([midnight], "2026-11-14").length === 1);
    add(A, "전부 건너뛴 회차는 '오늘 완료'가 아니다 · replay는 진도 완료로 치지 않는다(한 판으로는 센다)", jaDailyDoneTodayN([allSkipped], "2026-11-15") === null && jaDailyDoneTodayN([replayToday], "2026-11-15") === null && jaDailyFullRunsOn([replayToday], "2026-11-15").length === 1);
    const rt = codeOnly("../app/api/japanese/daily/route.ts");
    add(A, "홈 색인·스트릭 라벨이 같은 함수 — route doneTodayN = jaDailyDoneTodayN · streak-server aDaily = jaDailyFullRunsOn", /doneTodayN: jaDailyDoneTodayN\(sessions, today\)/.test(rt) && !/finishedAt\) === today/.test(rt) && /aDaily = jaDailyFullRunsOn\(jaDaily, today\)\[0\]/.test(src("../lib/streak-server.ts")));
  }
  add(A, "옛 세션 — 칸 4 · done = 답함", JSON.stringify(jaDailyStreakSessions([rec(1)])[0].items) === JSON.stringify([{ answered: true }, { answered: true }, { answered: true }, { answered: false }]));
  add(A, "라벨 `오늘의 일본어 · Day n`", jaDailyStreakLabel({ n: 7 }) === "오늘의 일본어 · Day 7");
  const ss = src("../lib/streak-server.ts");
  add(A, "streak-server 배선 — 일본어 세션·v2 한 판·라벨·읽기 실패 격리", /\.\.\.jaDailyStreakSessions\(jaDaily\)\];/.test(ss) && /addRuns\(m, jaDaily\.filter\(isFullJaDailySession\)\.map\(\(r\) => r\.startedAt\)\)/.test(ss) && /jaDailyStreakLabel\(aDaily\)/.test(ss) && /store\.listJaDailySessions\(\)\.catch\(/.test(ss));
  add(A, "은우·토익 트랙에 섞이지 않는다", !/eunwooT[\s\S]{0,400}jaDaily/.test(ss) && !/toeicStreakSessions\([^)]*jaDaily/.test(ss) && !/computeStreak\(\[\.\.\.vocab[^\]]*jaDaily/.test(ss));
}

// ---------------------------------------------------------------------------
// 9) 복습 ja-n5-word
// ---------------------------------------------------------------------------
{
  const A = "복습 ja-n5-word";
  add(A, "종류 등록 — 영역 japanese · 라벨", REVIEW_KINDS.includes("ja-n5-word") && REVIEW_KIND_AREA["ja-n5-word"] === "japanese" && REVIEW_KIND_LABEL_KO["ja-n5-word"] === "N5 단어" && parseReviewItemKey("ja-n5-word:v01-01")?.kind === "ja-n5-word");
  const days = vocabDays(2, 3);
  // KST 11-15 23:30 = UTC 14:30 → 첫 복습일 11-16
  const ses = [
    rec(1, { startedAt: "2026-11-15T14:00:00.000Z", finishedAt: "2026-11-15T14:30:00.000Z", vocabAnswers: [{ wordId: "v01-01", mode: "meaning", correct: true }, { wordId: "v01-02", mode: "reading", correct: false }] }),
    rec(2, { startedAt: "2026-11-15T15:30:00.000Z", finishedAt: "2026-11-15T16:00:00.000Z", vocabAnswers: [{ wordId: "v01-03", mode: "meaning", correct: true }, { wordId: "v01-01", mode: "reading", correct: true }] }),
  ];
  const items = jaN5WordItems(days, ses);
  const byKey = new Map(items.map((i) => [i.card.itemKey, i] as const));
  add(A, "회차에서 답한 단어만(DAY 2 단어 0)", items.length === 3 && !items.some((i) => i.card.itemKey.includes("v02-")));
  add(A, "첫 복습일 = 처음 답한 끝낸 회차(KST) + 1 — 자정 넘어 끝낸 회차는 그다음 날", byKey.get("ja-n5-word:v01-01")?.stats.firstDueOn === "2026-11-16" && byKey.get("ja-n5-word:v01-03")?.stats.firstDueOn === "2026-11-17");
  add(A, "모드 합산 통계 — v01-01 시도 2 · v01-02 틀림 1", byKey.get("ja-n5-word:v01-01")?.stats.attempts === 2 && byKey.get("ja-n5-word:v01-02")?.stats.wrongCount === 1);
  const c = byKey.get("ja-n5-word:v01-01")!.card;
  add(A, "사다리 — 단서 = 한국어 뜻 · 힌트1 = 읽기 첫 글자 · 힌트2 = 읽기 뼈대 · 한자 표기 루비", c.cue.main === "뜻 1-1" && c.cue.lang === "ko" && c.hint1 === "や" && c.hint2 === "や○" && c.answer.main === "山" && c.answer.ruby?.[0].reading === "やま" && c.speak?.lang === "ja-JP");
  const k = byKey.get("ja-n5-word:v01-02")!.card;
  add(A, "가타카나 단어 — sub·루비 없음", k.answer.main === "テレビ" && k.answer.sub === null && k.answer.ruby === null);
  add(A, "끝내지 않은 회차는 입장 조건이 아니다", jaN5WordItems(days, [{ startedAt: NOW, finishedAt: null, vocabAnswers: [{ wordId: "v01-01", correct: true }] }]).length === 0);
  add(A, "서버 등록부 — japanese 영역에 ja-n5-word(vocab 종류만 읽기)", /kind: "ja-n5-word"/.test(src("../lib/review-server.ts")) && /listJaDailyContent\("vocab"\)/.test(src("../lib/review-server.ts")));
}

// ---------------------------------------------------------------------------
// 10) 배선 정적 점검 — 라우트·저장소
// ---------------------------------------------------------------------------
{
  const A = "배선";
  const routes = ["route.ts", "import/route.ts", "session/[n]/route.ts", "sessions/route.ts", "transcribe/route.ts"].map((r) => [r, src(`../app/api/japanese/daily/${r}`)] as const);
  add(A, "라우트 다섯 — runtime nodejs", routes.every(([, s]) => /export const runtime = "nodejs"/.test(s)));
  add(A, "AI 0 — 받아쓰기 말고는 openai·lib/ai/client·관문 import 없음", routes.filter(([r]) => r !== "transcribe/route.ts").every(([, s]) => !/openai|lib\/ai\/client|transcribe/.test(s.replace(/\/\*[\s\S]*?\*\//g, ""))));
  const tr = codeOnly("../app/api/japanese/daily/transcribe/route.ts");
  add(A, "받아쓰기 — 관문 T-ja 재사용 · 키 검사(501)가 본문 읽기보다 먼저 · 1MiB · 실제 바이트 상한(읽으며 센다)", /transcribeJaDailyLine\(/.test(tr) && tr.indexOf("hasJaSpeakingTranscribeApiKey()") < tr.indexOf("await readCappedBody(req") && /1024 \* 1024/.test(tr) && /total > max/.test(tr) && !/req\.formData\(\)/.test(tr));
  add(A, "받아쓰기 — 기대 문장(expected·tokens·ja·lineId)을 받지 않는다 · 저장소 import 0", !/form\.get\("(?!audio)/.test(tr) && !/getStore|lib\/store/.test(tr));
  const im = codeOnly("../app/api/japanese/daily/import/route.ts");
  add(A, "가져오기 — 6MB 상한(선언·실제 바이트 두 번) · 키 검사 없음", /6 \* 1024 \* 1024/.test(im) && /Buffer\.byteLength\(text, "utf8"\) > JA_DAILY_IMPORT_MAX_BYTES/.test(im) && !/OPENAI_API_KEY/.test(im));
  const st = src("../lib/store.ts");
  add(A, "file 백엔드 — DbShape·emptyDb·readDb·mergeDbForSeed·seed.ts 모두", /jaDailyContent: JaDailyContentRecord\[\];/.test(st) && /jaDailyContent: \[\], jaDailySessions: \[\],/.test(st) && /parsed\.jaDailyContent/.test(st) && /jaDailyContent: mergeById\(cur\.jaDailyContent/.test(st) && /jaDailyContent: \[\],/.test(src("../scripts/seed.ts")));
  const fs = src("../lib/store-firestore.ts");
  add(A, "Firestore — 가져오기 트랜잭션(읽기 먼저) · 기록 ref.create 멱등 · where 하나", /async importJaDailyContent[\s\S]{0,600}runTransaction[\s\S]{0,300}tx\.getAll/.test(fs) && /async saveJaDailySession[\s\S]{0,200}ref\.create\(/.test(fs) && /where\("kind", "==", kind\)/.test(fs));
  add(A, "삭제 경로 없음(prod-guard 무관 — 지우지 않는다)", !/deleteJaDaily/.test(st + fs));
  add(A, "계약 파일 — 화면 타입 정의처(색인·회차·가져오기·저장·받아쓰기)", ["JaDailyIndexResponse", "JaDailySessionResponse", "JaDailyImportResponse", "JaDailySaveResponse", "JaDailyTranscribeResponse"].every((t) => new RegExp(`export type ${t}`).test(src("../lib/ja-daily-contract.ts"))));
}

function report() {
  console.log("");
  console.log("| 결과 | 영역 | 점검 항목 | 상세 |");
  console.log("|------|------|-----------|------|");
  for (const r of results) console.log(`| ${r.pass ? "PASS" : "FAIL"} | ${r.area} | ${r.check} | ${r.detail.replace(/\|/g, "\\|").slice(0, 160)} |`);
  console.log("");
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`FAIL — 오늘의 일본어 ${failed.length}개 항목 실패.`);
    process.exit(1);
  }
  console.log(`PASS — 오늘의 일본어 ${results.length}개 항목 통과 (실호출 0회 · 네트워크 0 · 저장소 쓰기 0).`);
}

// ---------------------------------------------------------------------------
// 11) 화면(2단계) — 단어 5지선다 보기 · 따라 말하기 대본 · 밑줄 · 칸 이름 · 배선
// ---------------------------------------------------------------------------
{
  const A = "화면 순수 함수";
  const w = (id: string, written: string, reading: string, meaningKo: string) => ({ id, written, reading, meaningKo });
  // 지어낸 단어 — 같은 뜻(산)·같은 읽기(やま) 함정을 일부러 넣는다
  const words = [w("q1", "山", "やま", "산"), w("q2", "川", "かわ", "강"), w("q3", "テレビ", "テレビ", "텔레비전"), w("q4", "高い", "たかい", "높다, 비싸다")];
  const pool = [
    ...words,
    w("p1", "やま", "やま", "산; 더미"), // 같은 뜻 조각(산)·같은 읽기 — 둘 다 오답 보기로 나오면 정답이 둘
    w("p2", "海", "うみ", "바다"),
    w("p3", "空", "そら", "하늘"),
    w("p4", "安い", "やすい", "싸다"),
    w("p5", "高価", "こうか", "비싸다"), // q4의 뜻 조각 '비싸다'와 겹침
    w("p6", "木", "き", "나무"),
    w("p7", "花", "はな", "꽃"),
    w("p8", "川", "カワ", "개울"), // q2 읽기와 가나 종류만 다름
  ];
  const qs = buildJaDailyVocabQuestions(words, pool);
  const again = buildJaDailyVocabQuestions(words, pool);
  add(A, "결정적 — 같은 입력이면 같은 보기·같은 정답 자리(Math.random 없음)", JSON.stringify(qs) === JSON.stringify(again) && !/Math\.random|Date\.now|new Date/.test(codeOnly("../lib/ja-daily-quiz.ts")));
  add(A, "런타임 import 0(타입만) — 화면 번들에 zod·스키마가 끌려오지 않는다", [...src("../lib/ja-daily-quiz.ts").matchAll(/^import (?!type )/gm)].length === 0);
  add(A, "보기 5개 · 정답이 정확히 한 자리 · 보기 중복 없음", qs.every((q) => q.choices.length === JA_DAILY_VOCAB_CHOICES && new Set(q.choices).size === q.choices.length && q.choices[q.answerIndex] === (q.mode === "meaning" ? words.find((x) => x.id === q.wordId)!.meaningKo : words.find((x) => x.id === q.wordId)!.reading)));
  add(A, "모드 — 짝수 번째 뜻 · 홀수 번째 읽기 · 가나뿐인 단어(テレビ)는 뜻으로", qs.map((q) => q.mode).join(",") === "meaning,reading,meaning,reading" && buildJaDailyVocabQuestions([words[0], words[2]], pool)[1]?.mode === "meaning");
  const q1 = qs.find((q) => q.wordId === "q1")!;
  const P = (id: string) => pool.find((x) => x.id === id)!;
  const tight1 = buildJaDailyVocabQuestion(words[0], "meaning", [words[0], P("p1"), P("p2")])!;
  add(A, "같은 뜻 제외 — '산'의 보기에 '산; 더미' 없음(보기가 적어도 넣지 않는다)", !q1.choices.includes("산; 더미") && tight1.choices.length === 2 && !tight1.choices.includes("산; 더미"));
  const q4 = qs.find((q) => q.wordId === "q4")!;
  add(A, "읽기 고르기 — 오답 보기끼리·정답과 읽기가 겹치지 않는다", q4.mode === "reading" && new Set(q4.choices).size === q4.choices.length);
  const q2read = buildJaDailyVocabQuestion(words[1], "reading", [words[1], P("p8"), P("p2")])!;
  add(A, "같은 읽기 제외(가타카나 カワ = かわ)", q2read.choices.length === 2 && !q2read.choices.includes("カワ"));
  const q4mean = buildJaDailyVocabQuestion(words[3], "meaning", [words[3], P("p5"), P("p2")])!;
  add(A, "뜻 조각이 겹치는 보기 제외('높다, 비싸다' ↔ '비싸다')", q4mean.choices.length === 2 && !q4mean.choices.includes("비싸다"));
  add(A, "오답 보기가 없으면 null · 목록에서 빠진다", buildJaDailyVocabQuestion(words[0], "meaning", [words[0]]) === null && buildJaDailyVocabQuestions([words[0]], [words[0]]).length === 0);
  const day25 = Array.from({ length: 25 }, (_, i) => w(`d${i}`, "日本", "にほん", `뜻${i}`));
  const dq = buildJaDailyVocabQuestions(day25, day25);
  add(A, "DAY 시험 25문항 = 뜻 13 + 읽기 12(읽기 보기가 없으면 뜻으로 대체)", dq.length === 25 && dq.filter((q) => q.mode === "meaning").length >= 13);
  const day25b = Array.from({ length: 25 }, (_, i) => w(`e${i}`, `語${i}`, `ご${"あいうえおかきくけこさしすせそたちつてとなにぬねの"[i]}`, `뜻${i}`));
  const dq2 = buildJaDailyVocabQuestions(day25b, day25b);
  add(A, "읽기가 모두 다르면 정확히 뜻 13 + 읽기 12", dq2.filter((q) => q.mode === "meaning").length === 13 && dq2.filter((q) => q.mode === "reading").length === 12);
  add(A, "isJaDailyReadingTrivial — 가나뿐(가타카나도) = 거저 · 한자 = 아님", isJaDailyReadingTrivial(w("t", "テレビ", "てれび", "x")) && !isJaDailyReadingTrivial(w("t", "山", "やま", "x")));

  const sh = buildJaDailyShadowItems([{ ja: "山へ行きます。", ko: "산에 갑니다." }, { ja: " ", ko: "빈 문장" }, { ja: "川です。", ko: "" }], 2);
  add(A, "따라 말하기 — 문장마다 한국어 1번 → 일본어 N번(일본어 뒤에만 틈) · 빈 문장 건너뜀 · 한국어 없으면 일본어만", sh.map((x) => `${x.lang}:${x.line}:${x.pauseAfterMs ? "p" : "-"}`).join(",") === "ko-KR:0:-,ja-JP:0:p,ja-JP:0:p,ja-JP:2:p,ja-JP:2:p");
  add(A, "따라 말하기 — from부터 · 반복 1~5로 자른다 · 일본어 조각은 trim만(캐시 키 = 🔊 단발과 같은 글)", buildJaDailyShadowItems([{ ja: "a", ko: "가" }, { ja: " 川です。 ", ko: "강" }], 9, 1).filter((x) => x.lang === "ja-JP").length === 5 && buildJaDailyShadowItems([{ ja: " 川です。 ", ko: "강" }], 1)[1].text === "川です。");
  const sp = (s: string) => [...s].map((c) => ({ speaker: c === "-" ? null : c }));
  const g16 = jaDailyLineGroups("renshu1", sp("ABBAABBAABBAABBA"));
  add(A, "회화 연습 번호 묶음 — 4로 나뉘고 화자 순서가 네 번 같으면 例·1番·2番·3番 4등분", JSON.stringify(g16) === JSON.stringify([{ label: "例", start: 0, end: 4 }, { label: "1番", start: 4, end: 8 }, { label: "2番", start: 8, end: 12 }, { label: "3番", start: 12, end: 16 }]) && jaDailyLineGroups("renshu2", sp("ABABBABABBABABBABABB"))?.[3].start === 15);
  add(A, "회화 연습 번호 묶음 — 회화·소리 칸 · 4로 안 나뉨 · 화자 순서가 어긋남 · 8문장 미만 · 화자 정보 없음/한 사람 · 첫 묶음만 어긋남은 null(한 덩어리)", jaDailyLineGroups("kaiwa1", sp("ABBAABBAABBAABBA")) === null && jaDailyLineGroups("sound", sp("--------")) === null && jaDailyLineGroups("renshu1", sp("ABABABABABAB-")) === null && jaDailyLineGroups("renshu1", sp("ABBAABBAABBAABAB")) === null && jaDailyLineGroups("renshu1", sp("ABAB")) === null && jaDailyLineGroups("renshu1", sp("--------")) === null && jaDailyLineGroups("renshu1", sp("AAAAAAAAAAAA")) === null && jaDailyLineGroups("renshu1", sp("ABAABBABABABABAB")) === null);
  add(A, "회화 칸이 번호 묶음 머리를 그린다(jaDailyLineGroups · testid ja-daily-line-group)", /jaDailyLineGroups\(t\.part, t\.lines\)/.test(codeOnly("../components/ja-daily-kaiwa.tsx")) && /data-testid="ja-daily-line-group"/.test(src("../components/ja-daily-kaiwa.tsx")));
  add(A, "틈 길이 1.5~8초 · 길수록 길다", jaDailyShadowPauseMs("あ") === 1500 && jaDailyShadowPauseMs("あ".repeat(100)) === 8000 && jaDailyShadowPauseMs("あいうえおかきくけこ") > jaDailyShadowPauseMs("あいう"));
  add(A, "밑줄 [[ ]] 쪼개기 · 떼기", JSON.stringify(splitJaDailyUnderline("わたしは[[毎朝]]行く")) === JSON.stringify([{ text: "わたしは", underline: false }, { text: "毎朝", underline: true }, { text: "行く", underline: false }]) && stripJaDailyUnderline("[[山]]と[[川]]") === "山と川");
  add(A, "칸 이름 — 시험 칸 여덟 종류 전부 · 단어 셋", ["tip", "litems", "mockItems", "mockSection", "mockScore", "mockReview", "weakItems", "final"].every((t) => jaDailyExamLabel({ type: t, round: 2, itemIds: [], sections: ["moji"], tipId: "x" } as never).length > 0) && jaDailyVocabLabel({ type: "cards", day: 3, from: 1, to: 13 }) === "단어 DAY 3 (1~13)");
  const sum = jaDailySessionSummary(COURSE[0], INDEX.lessons);
  add(A, "요약 한 줄 — Day n · 회화 · 단어 · 시험 칸 · 약 n분", /^Day 1 · 회화 1-1과 .+ · 단어 DAY 1 \(1~13\) · 청해 요령 · 약 \d+분$/.test(sum), sum);

  // 배선(화면)
  const ex = src("../components/ja-daily-exam.tsx");
  add(A, "실전(mockSection) 풀이 중 블록 → 상단 스트릭·도우미 숨김(isExamScreen의 blockCount) · 끝나면 풂", /usePhraseHelperBlock\(!finished\)/.test(ex));
  add(A, "채점표 오답 보기는 답하지 않는다(86회 오답 다시 풀기를 지킨다)", /view\.type === "mockScore"[\s\S]{0,900}onPick=\{null\}/.test(ex));
  const kw = codeOnly("../components/ja-daily-kaiwa.tsx");
  const shd = codeOnly("../components/use-ja-daily-shadow.tsx");
  add(A, "따라 말하기는 한 곳(use-ja-daily-shadow) — 회화·요령 대본이 같이 쓰고 각자 큐를 만들지 않는다", /useJaDailyShadow\(repeat\)/.test(kw) && /useJaDailyShadow\(repeat\)/.test(ex) && !/speakQueue|bindMediaSession/.test(kw) && !/speakQueue|bindMediaSession/.test(codeOnly("../components/ja-daily-exam.tsx")) && /buildJaDailyShadowItems\(target\.lines, repeat, from\)/.test(shd) && /pauseAllMedia\(\);\s*unlockSpeechPlayback\(\);/.test(shd));
  const it = (ja: string) => ({ ja, tokens: [{ surface: ja, reading: null }], ko: `뜻${ja}` });
  const fl = flattenJaDailyTipDrills([{ items: [it("あ"), it("い")] }, { items: [it("う")] }, { items: [it("え"), it("お"), it("か")] }]);
  add(A, "요령 대본 평탄화 — 묶음을 넘어 전체 순서 · offsets = 묶음 첫 문장의 전체 index(강조와 큐 line이 같은 기준)", fl.lines.map((x) => x.ja).join("") === "あいうえおか" && JSON.stringify(fl.offsets) === "[0,2,3]" && fl.lines[5].ko === "뜻か" && flattenJaDailyTipDrills([]).lines.length === 0);
  const exc = codeOnly("../components/ja-daily-exam.tsx");
  add(A, "요령 대본 화면이 평탄화 함수를 쓰고 강조 index = offsets[di] + i", /flattenJaDailyTipDrills\(drills\)/.test(exc) && /const idx = offsets\[di\] \+ i;/.test(exc) && /active\.line === idx/.test(exc));
  add(A, "문장 탭(회화·요령 대본) — 따라 말하기 중이면 멈추고 바인딩을 푼 뒤 원음 정지 → 그 문장 발음", /if \(shadowRef\.current\) stopShadow\(true\);\s*pauseAllMedia\(\);\s*speak\(l\.ja, "ja-JP"\)/.test(kw) && /if \(sh\.shadowRef\.current\) sh\.stopShadow\(true\);\s*pauseAllMedia\(\);\s*speak\(it\.ja, "ja-JP"\)/.test(exc));
  add(A, "칸을 떠나면(언마운트) 큐를 멈추고 잠금 화면 바인딩을 푼다", /useEffect\(\s*\(\) => \(\) => \{\s*runRef\.current \+= 1;\s*stopRef\.current\?\.\(\);\s*stopRef\.current = null;\s*unbindRef\.current\?\.\(\);\s*unbindRef\.current = null;\s*\},\s*\[\],?\s*\)/.test(shd));
  add(A, "잠금 화면 ⏸/▶ 가드 — ⏸는 재생 중일 때만, ▶는 멈춘 따라 말하기가 있을 때만(끝난 뒤·재생 중 ▶는 무시)", /pause: \(\) => \{\s*if \(shadowRef\.current\?\.state !== "playing"\) return;/.test(shd) && /play: \(\) => \{\s*const s = shadowRef\.current;\s*if \(!s \|\| s\.state === "playing"\) return;/.test(shd));
  add(A, "잠금 화면 ▶(이어 듣기)도 원음 <audio>를 먼저 멈춘다 — 원음과 따라 말하기가 겹치지 않는다", /play: \(\) => \{[\s\S]{0,200}?state === "playing"\) return;\s*pauseAllMedia\(\);\s*playFrom\(target, s\.line\)/.test(shd));
  add(A, "요령 원음 대본은 접지 않은 독립 카드(📜 원음 대본) · \"다음\"에서 따라 말하기를 멈추고 바인딩을 푼다", /data-testid="ja-daily-tip-drills"/.test(ex) && !/<details[^>]*ja-daily-tip-drills/.test(ex) && /sh\.stopShadow\(true\);\s*pauseAllMedia\(\);\s*onDone\(answers\)/.test(ex));
  add(A, "따라 말하기 마운트만으로 합성을 미리 받지 않는다(prefetch 없음)", !/prefetchSpeech/.test(shd + kw + codeOnly("../components/ja-daily-exam.tsx")));
  const lc = codeOnly("../components/ja-daily-line-check.tsx");
  add(A, "🎤 — 판정은 lib/ja-daily-judge(계약 파일 값 import 없음) · 받아쓰기에 기대 문장 안 보냄 · 501이면 스스로 판정", /from "@\/lib\/ja-daily-judge"/.test(lc) && !/import \{[^}]*\} from "@\/lib\/ja-daily-contract"/.test(lc) && /fd\.append\("audio"/.test(lc) && !/fd\.append\("(?!audio)/.test(lc) && /status === 501/.test(lc));
  add(A, "🎤 결과를 보고 넘어가도 잰 정확도를 남긴다(QA daily-full P3-2)", /accuracy: p\.kind === "result" \? p\.accuracy : null, verdict: "skipped"/.test(lc));
  const sv = codeOnly("../components/ja-daily-session-view.tsx");
  add(A, "저장 409 id_conflict → 새 클라이언트 id로 바꿔 둔다(같은 409 반복 없음, QA P3-4)", /body\.error === "id_conflict"[\s\S]{0,200}recordRef\.current = \{ \.\.\.rec, id: newClientId\(\) \}/.test(sv));
  const md = codeOnly("../components/ja-daily-media.tsx");
  add(A, "원음 URL — 읽는 도중 정리됐으면 방금 만든 URL을 놓는다(QA P3-5)", /if \(!alive\) \{\s*if \(url\) URL\.revokeObjectURL\(url\);\s*break;/.test(md));
  const comps = ["ja-daily-home", "ja-daily-hub-card", "ja-daily-session-view", "ja-daily-kaiwa", "ja-daily-vocab", "ja-daily-exam", "ja-daily-line-check", "ja-daily-media", "use-ja-daily-shadow"].map((f) => codeOnly(`../components/${f}.tsx`)).join("\n");
  add(A, "화면은 계약·내용 모듈을 타입으로만(zod·일본어 스키마가 폰 번들로 안 감)", !/import \{[^}]*\} from "@\/lib\/ja-daily-(contract|content|session|plan)"/.test(comps));
  add(A, "원음은 서버로 보내지 않는다 — 화면에서 jpack·원음을 fetch body로 보내는 곳 없음", !/fetch\([^)]*import[^)]*jpack/.test(comps) && !/body: file\b/.test(comps));
  const st = codeOnly("../lib/ja-audio-store.ts");
  add(A, "기기 보관소 — IndexedDB에 Blob을 넣지 않는다(바이트 저장, 꺼낼 때 새 Blob) · 닫힌 연결은 캐시 비움(QA P3-e)", /data, bytes: track\.bytes/.test(st) && !/put\(track\)/.test(st) && /new Blob\(\[data\]/.test(st) && /db\.onclose = /.test(st) && /db\.onversionchange = /.test(st));
  add(A, "허브 맨 위 primary 카드 · 단어장은 secondary", /<JaDailyHubCard \/>[\s\S]*<ReviewTodayCard/.test(src("../app/japanese/page.tsx")) && /href="\/japanese\/vocab" className="u-entry u-entry-secondary"/.test(src("../app/japanese/page.tsx")));
}
