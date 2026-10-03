/**
 * scripts/eval-toeic-guides-s2.ts — 유형별 공략 **S2 앱 층**(T11 🧩 틀 테스트·전사/기록 라우트 · T8 ③ 표현 시험) 오프라인 검증 — scripts/eval-toeic.ts가 부른다.
 *
 * - 테스트 화면 순수 함수(lib/toeic-template-test-view): 주소 풀기·만들기, 범위의 틀, (나) 단서(영어 글자 = 채움뿐), 유효한 시도(words ∧ ¬noSpeech —
 *   기반 QA P3-4), 비용 표시, 저장 항목(그만두기 = 판정 전 answered null)·끝 화면 요약(제안과 다른 판정은 제안이 있던 문항만), 최근 테스트·
 *   모드별 틀린 틀 수, 멱등 키 형식. 공략 세트 "뒤로"(toeicSetBackLink)·유형 판정.
 * - 멱등 저장 판정(lib/store decideToeicQuizWithId) 세 갈래 + **파일 백엔드 실행**(자식 프로세스 — 임시 폴더를 cwd로 둔 새 프로세스에서
 *   getStore()를 돌린다. 이 프로세스는 이미 lib/store를 불러 저장소의 data/db.json을 가리키므로 여기서 스토어를 만들지 않는다 — 저장소 DB 무접촉,
 *   전후 sha로 확인).
 * - 소스 대조(eval은 라우트 핸들러를 부르지 않는다 — §12-10 "템플릿 라우트"): 전사 라우트(키 → content-length 413 → formData 순서·1 MiB·
 *   파일 이름 도우미·prompt 없음·스토어 없음·req.signal), 기록 라우트(본문 zod·setId 고정·멱등 메서드·404), Firestore create·ALREADY_EXISTS,
 *   테스트 화면(🎤 순서·시작 탭·45초·상한·Wake Lock·stopSpeaking 없음·전사 요청에 녹음만), 테스트 페이지·폴더 페이지(testFills를 넘기지 않음),
 *   T8(공략 세트 "뒤로"·상세/시험 페이지 틀 은행 리다이렉트·rename/points 409 is_guide가 키 검사 앞·5지선다 상한 20·말하기 약한 순·이름).
 *
 * 공개 저장소: 픽스처는 전부 **지어낸 영어·한국어**다. 실호출 0.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toeicTemplateSessionBodySchema, type ToeicTemplate, type ToeicTemplateFlow } from "../lib/ai/toeic/schemas";
import { decideToeicQuizWithId } from "../lib/store";
import { TOEIC_TEMPLATE_BANK_ID } from "../lib/toeic-guide";
import { TOEIC_TEMPLATE_SESSION_ID_RE } from "../lib/toeic-guide-contract";
import { toeicGuidePartOfSet, toeicSetBackLink } from "../lib/toeic-guide-view";
import type { ToeicQuizSessionLike } from "../lib/toeic-quiz";
import { buildTemplateTestQuestions, compareTemplateAnswer, normalizeTemplateWords, parseFrame, templateFlowOrder } from "../lib/toeic-template";
import {
  isValidTemplateAttempt,
  maskLatinForTestKo,
  newTemplateSessionId,
  parseTemplateTestParams,
  recentTemplateTests,
  templateSwapClue,
  templateTestCostLabelKo,
  templateTestItems,
  templateTestLeaveSave,
  templateTestPromptMeta,
  templateTestScopeTemplates,
  templateTestSummary,
  templateWrongCountsByMode,
  toeicTemplateTabHref,
  toeicTemplateTestHref,
} from "../lib/toeic-template-test-view";
import type { GuideCheckResult } from "./eval-toeic-guides";

function adder(results: GuideCheckResult[], book: string) {
  return (check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
}
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");
/** 주석을 뺀 코드 */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** 파일의 모든 import 경로(type 포함) */
const allImportPaths = (src: string) => [...src.matchAll(/^(?:import|export)\s+[\s\S]*?\s+from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
/** 런타임 import 경로(import type·전부 type인 named import 제외) */
function runtimeImportPaths(src: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (m[1]) continue;
    const clause = m[2].trim();
    if (/^\{[\s\S]*\}$/.test(clause) && clause.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith("type "))) continue;
    out.push(m[3]);
  }
  return out;
}
/** 함수 본문(대략 — `function name(` 부터 다음 최상위 `\n  function `·`\n  async function `·`\n  // ──` 전까지) */
function fnBody(src: string, name: string): string {
  const at = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (at < 0) return "";
  const rest = src.slice(at + 10);
  const nexts = [rest.indexOf("\n  function "), rest.indexOf("\n  async function "), rest.indexOf("\n  // ──")].filter((i) => i >= 0);
  return src.slice(at, nexts.length > 0 ? at + 10 + Math.min(...nexts) : undefined);
}

// ---------------------------------------------------------------------------
// 픽스처 — 전부 지어낸 것
// ---------------------------------------------------------------------------

function tpl(key: string, groupKo: string, frameEn: string, frameKo: string, parts: string[], fills: string[][], testFills: string[][]): ToeicTemplate {
  const fillFrame = (f: string[]) => {
    let i = 0;
    return frameEn.replace(/\{[^{}]*\}/g, () => f[i++] ?? "");
  };
  return {
    key,
    groupKo,
    frameEn,
    frameKo,
    useKo: "지어낸 쓰임 설명",
    parts: parts as ToeicTemplate["parts"],
    source: "new",
    guideRefs: [],
    examples: fills.map((f) => ({ en: fillFrame(f), ko: "지어낸 해석", fills: f })),
    testFills,
  };
}

// 한국어 어순이 영어와 다르다(자리 이름이 짝을 잇는다)
const T_HELP = tpl("act-helps", "효과", "{활동} helps me {효과}.", "{활동}은 제가 {효과} 데 도움이 돼요.", ["q11"], [["Walking", "think clearly"], ["Cooking", "relax"], ["Reading", "sleep well"]], [["Swimming", "stay calm"], ["Drawing", "focus"]]);
const T_REASON = tpl("mainly-because", "이유", "I prefer it mainly because {이유}.", "제가 그걸 좋아하는 건 주로 {이유} 때문이에요.", ["q11", "q5_7"], [["it is cheap"], ["it saves time"], ["it is quiet"]], [["it feels safe"]]);
const T_FOOD = tpl("often-cook", "음식 소재", "I often cook {음식} at home.", "저는 집에서 자주 {음식}을 요리해요.", ["q11"], [["rice"], ["soup"], ["pasta"]], [["curry"], ["noodles"]]);
const T_OTHER = tpl("other-part", "장면", "The picture shows {장소}.", "사진은 {장소}를 보여 줘요.", ["q3_4"], [["a park"], ["a shop"], ["a lake"]], [["a bus stop"]]);
const FLOW_Q11: ToeicTemplateFlow = { part: "q11", steps: [{ stepKo: "입장", groupsKo: ["효과"] }, { stepKo: "이유", groupsKo: ["이유"] }, { stepKo: "정리", groupsKo: [] }], banksKo: ["음식 소재"] } as unknown as ToeicTemplateFlow;
const ITEMS = [T_HELP, T_REASON, T_FOOD, T_OTHER];
const GROUPS = templateFlowOrder({ flows: [FLOW_Q11], items: ITEMS }, "q11");

function sess(id: string, mode: "tpl-recall" | "tpl-swap", startedAt: string, items: [string, boolean | null][], finishedAt: string | null = startedAt): ToeicQuizSessionLike {
  return {
    id,
    setId: TOEIC_TEMPLATE_BANK_ID,
    mode,
    startedAt,
    finishedAt,
    items: items.map(([k, c]) => ({ word: `tpl:${k}`, correct: c === true, answered: c === null ? null : true })),
  };
}

// ---------------------------------------------------------------------------
// 1. 테스트 화면 순수 함수
// ---------------------------------------------------------------------------

function runTestViewChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "틀 테스트 화면 순수 함수");

  // 주소
  const def = parseTemplateTestParams({});
  const full = parseTemplateTestParams({ mode: "swap", scope: "step", group: "효과", step: "입장" });
  const junk = parseTemplateTestParams({ mode: "speak", scope: "bogus", group: "  " });
  add(
    "주소 풀기: 없음 → (가)·묶음, swap·step·group·step 그대로, 모르는 값 → 기본(빈 칸은 null)",
    eqJson(def, { mode: "tpl-recall", scope: "group", group: null, step: null }) &&
      eqJson(full, { mode: "tpl-swap", scope: "step", group: "효과", step: "입장" }) &&
      eqJson(junk, { mode: "tpl-recall", scope: "group", group: null, step: null }),
    JSON.stringify({ def, full, junk }),
  );
  const href = toeicTemplateTestHref("q11", { mode: "tpl-swap", scope: "group", group: "소재 & 묶음" });
  const back = new URL(href, "http://x");
  const round = parseTemplateTestParams(Object.fromEntries(back.searchParams.entries()));
  add(
    "주소 만들기 → 풀기 왕복(한글·기호 묶음 이름 인코딩) · 경로 /toeic/guides/{part}/templates/test",
    back.pathname === "/toeic/guides/q11/templates/test" && eqJson(round, { mode: "tpl-swap", scope: "group", group: "소재 & 묶음", step: null }),
    href,
  );
  add(
    "② 탭 주소: ?tab=templates(+tpl·range=wrong)",
    toeicTemplateTabHref("q3_4") === "/toeic/guides/q3_4?tab=templates" &&
      toeicTemplateTabHref("q3_4", { tpl: "scene-set" }) === "/toeic/guides/q3_4?tab=templates&tpl=scene-set" &&
      toeicTemplateTabHref("q11", { range: "wrong" }) === "/toeic/guides/q11?tab=templates&range=wrong",
  );

  // 범위
  const keysOf = (r: { templates: ToeicTemplate[] }) => r.templates.map((t) => t.key).join(",");
  const g = templateTestScopeTemplates(GROUPS, { scope: "group", group: "이유", step: null });
  const st = templateTestScopeTemplates(GROUPS, { scope: "step", group: null, step: "입장" });
  const stFromGroup = templateTestScopeTemplates(GROUPS, { scope: "step", group: "이유", step: null });
  const bank = templateTestScopeTemplates(GROUPS, { scope: "step", group: "음식 소재", step: null });
  const all = templateTestScopeTemplates(GROUPS, { scope: "all", group: null, step: null });
  const miss = templateTestScopeTemplates(GROUPS, { scope: "group", group: "없는 묶음", step: null });
  add(
    "범위: 묶음·단계(step 또는 묶음의 단계)·소재 묶음 전체·유형 전체(흐름 순서, 다른 유형 틀 없음)·못 찾으면 빈 목록",
    keysOf(g) === "mainly-because" &&
      keysOf(st) === "act-helps" &&
      keysOf(stFromGroup) === "mainly-because" &&
      keysOf(bank) === "often-cook" &&
      bank.labelKo === "소재 묶음 전체" &&
      keysOf(all) === "act-helps,mainly-because,often-cook" &&
      miss.templates.length === 0,
    JSON.stringify({ g: keysOf(g), st: keysOf(st), bank: keysOf(bank), all: keysOf(all) }),
  );

  // (나) 단서 — 한국어 틀 + 영어 채움 칩(자리 이름으로 짝), 영어 고정 글은 없다
  const clue = templateSwapClue(T_HELP.frameKo, T_HELP.frameEn, ["Swimming", "stay calm"]);
  const clueText = clue.map((c) => c.text).join("");
  const fixedLatin = clue.filter((c) => c.slot === null).some((c) => /[A-Za-z]/.test(c.text));
  add(
    "(나) 단서: 한국어 틀의 자리마다 영어 채움(자리 순서 색 = 영어 틀 자리 순서) · 고정 조각에 라틴 0 · 영어 틀 고정 낱말(helps) 없음",
    clueText === "Swimming은 제가 stay calm 데 도움이 돼요." &&
      clue.filter((c) => c.slot !== null).map((c) => c.slot).join(",") === "0,1" &&
      !fixedLatin &&
      !/helps/.test(clueText),
    clueText,
  );
  // 한국어 어순이 뒤집힌 틀 — 이름으로 짝을 찾는다
  const rev = templateSwapClue("{효과}에 {활동}이 좋아요.", "{활동} helps me {효과}.", ["Jogging", "clear my head"]);
  add("(나) 단서: 한국어 자리 순서가 영어와 달라도 이름으로 짝(색 = 영어 자리 순서)", rev.filter((c) => c.slot !== null).map((c) => `${c.slot}:${c.text}`).join("|") === "1:clear my head|0:Jogging");

  // 문제 머리 줄(묶음 이름 · 쓰임) — 라틴 0(QA S2 P2-1: useKo가 그 틀의 영어 고정 낱말을 담아 (나) "영어 글자 0"을 깨뜨렸다)
  const LATIN = /\p{Script=Latin}/u;
  const headerLine = (m: { groupKo: string | null; useKo: string | null }) => [m.groupKo, m.useKo].filter((x) => x !== null).join(" · ");
  const leak = templateTestPromptMeta({ groupKo: "효과 (effect)", useKo: "helps me 뒤에 효과를 붙여 말할 때" });
  add(
    "머리 줄 반례: useKo가 틀 고정 낱말(helps me)을 담아도 라틴 0 — 이어진 영어 구간은 \"…\" 하나, 한글·괄호는 그대로",
    eqJson(leak, { groupKo: "효과 (…)", useKo: "… 뒤에 효과를 붙여 말할 때" }) && !LATIN.test(headerLine(leak)) && !/helps/.test(headerLine(leak)),
    JSON.stringify(leak),
  );
  const maskCases: [string, string][] = [
    ["prefer it over the other one로 비교할 때", "…로 비교할 때"], // 여러 낱말 → 한 자리
    ["A·B 비교 — prefer A to B", "… 비교 — …"], // 문장부호·공백만 사이에 있으면 접는다, 한글 사이는 둔다
    ["Q9 끝에 in short로 정리", "… 끝에 …로 정리"], // 붙은 숫자까지("…9"로 반쯤 남지 않게)
    ["can't 대신 cannot도 괜찮아요", "… 대신 …도 괜찮아요"], // 아포스트로피 낱말
    ["{도구} makes it easy로 편리함", "{도구} …로 편리함"], // 자리 중괄호는 그대로
    ["ＴＶ 보면서 쉬는 이야기", "… 보면서 쉬는 이야기"], // 전각 라틴도
    ["영어 없는 설명 (괄호) 그대로", "영어 없는 설명 (괄호) 그대로"], // 라틴이 없으면 그대로
  ];
  const maskBad = maskCases.filter(([src, want]) => maskLatinForTestKo(src) !== want || LATIN.test(maskLatinForTestKo(src)));
  add("maskLatinForTestKo: 라틴 낱말·구간 → \"…\"(접기) · 한글·중괄호·괄호·라틴 없는 글은 그대로", maskBad.length === 0, JSON.stringify(maskBad.map(([src]) => [src, maskLatinForTestKo(src)])));
  add(
    "머리 줄: 가리고 나서 글자가 남지 않는 칸은 null(\"· …\"만 보이지 않게) · 공백 다듬기",
    eqJson(templateTestPromptMeta({ groupKo: "  효과  묶음 ", useKo: "only English words" }), { groupKo: "효과 묶음", useKo: null }),
  );
  // 문항 조립 → 머리 줄: 쓰임에 영어(그 틀의 고정 낱말 포함)가 든 틀로 두 모드 한 판씩 — 머리 줄 라틴 0, 틀 고정 낱말 0
  const leaky = ITEMS.map((t) => {
    const fixed = parseFrame(t.frameEn).filter((x) => x.kind === "fixed").map((x) => (x.kind === "fixed" ? x.text.trim() : "")).filter(Boolean).join(" ");
    return { ...t, groupKo: `${t.groupKo} group`, useKo: `${fixed} 로 말할 때 — e.g. ${t.examples[0].en}` };
  });
  let headerLatin = 0;
  let headerFixed = 0;
  let headerCount = 0;
  for (const mode of ["tpl-recall", "tpl-swap"] as const) {
    for (const q of buildTemplateTestQuestions(leaky, [], { mode, rng: () => 0.5 })) {
      const line = headerLine(templateTestPromptMeta(q.template));
      headerCount += 1;
      if (LATIN.test(line)) headerLatin += 1;
      const lineWords = new Set(normalizeTemplateWords(line));
      const fixedWords = parseFrame(q.template.frameEn).flatMap((x) => (x.kind === "fixed" ? normalizeTemplateWords(x.text) : []));
      if (fixedWords.some((w) => lineWords.has(w))) headerFixed += 1;
    }
  }
  add(
    "문항 조립 → 머리 줄(두 모드): 쓰임·묶음 이름에 영어가 든 틀이어도 라틴 0 · 틀 고정 낱말 0",
    headerCount === ITEMS.length * 2 && headerLatin === 0 && headerFixed === 0,
    `문항 ${headerCount} · 라틴 ${headerLatin} · 고정 낱말 ${headerFixed}`,
  );
  // (나) 단서 — 한국어 틀의 고정 조각에 라틴이 있어도 가린다(영어 글자 = 채움 칩뿐)
  const tvClue = templateSwapClue("{활동}은 TV 보면서 {효과} 데 도움이 돼요.", T_HELP.frameEn, ["Swimming", "stay calm"]);
  add(
    "(나) 단서: 한국어 틀 고정 조각의 라틴도 \"…\" — 라틴은 채움 칩(slot ≠ null)에만",
    tvClue.filter((c) => c.slot === null).every((c) => !LATIN.test(c.text)) &&
      tvClue.filter((c) => c.slot === null).map((c) => c.text).join("|") === "은 … 보면서 | 데 도움이 돼요." &&
      tvClue.filter((c) => c.slot !== null).map((c) => c.text).join("|") === "Swimming|stay calm",
    JSON.stringify(tvClue),
  );

  // 유효한 시도 — words와 noSpeech 둘 다(기반 QA P3-4)
  const c1 = compareTemplateAnswer(T_HELP.frameEn, ["Walking", "think clearly"], "...");
  const c2 = compareTemplateAnswer(T_HELP.frameEn, ["Walking", "think clearly"], "Walking helps me think clearly.");
  add(
    "유효한 시도: words 0 → 무효 · words 1인데 정규화 낱말 0(\"...\") → 무효 · 들은 낱말 있음 → 유효",
    !isValidTemplateAttempt({ words: 0 }, c2) && !isValidTemplateAttempt({ words: 1 }, c1) && isValidTemplateAttempt({ words: 5 }, c2) && c1.noSpeech,
  );

  add(
    "비용 표시: \"받아쓰기 n/20 · 이 판 최대 약 1센트\"(0~20으로 자름)",
    templateTestCostLabelKo(0) === "받아쓰기 0/20 · 이 판 최대 약 1센트" && templateTestCostLabelKo(7) === "받아쓰기 7/20 · 이 판 최대 약 1센트" && templateTestCostLabelKo(99) === "받아쓰기 20/20 · 이 판 최대 약 1센트",
  );

  // 저장 항목·요약
  const keys = ["act-helps", "mainly-because", "often-cook"];
  const verdicts = [{ correct: true, suggest: "fail" as const }, { correct: false, suggest: null }, null];
  const items = templateTestItems(keys, verdicts);
  add(
    "저장 항목: tpl:{key}, 판정한 문항 answered true, 판정 전(그만두기) answered null·correct false",
    eqJson(items, [
      { word: "tpl:act-helps", correct: true, answered: true },
      { word: "tpl:mainly-because", correct: false, answered: true },
      { word: "tpl:often-cook", correct: false, answered: null },
    ]),
  );
  const body = { clientSessionId: newTemplateSessionId(), mode: "tpl-swap", startedAt: new Date(Date.UTC(2026, 8, 27, 1)).toISOString(), finishedAt: null, items };
  add("저장 본문이 기록 라우트 zod를 통과한다(멱등 키·시각·항목)", toeicTemplateSessionBodySchema.safeParse(body).success);
  const sum = templateTestSummary(keys, verdicts);
  add(
    "끝 화면 요약: ○ 1 / 판정 2 · 제안이 있던 1문항 중 다르게 판정 1 · ✕ 틀 [mainly-because]",
    sum.correct === 1 && sum.answered === 2 && sum.suggested === 1 && sum.mismatched === 1 && eqJson(sum.wrongKeys, ["mainly-because"]),
    JSON.stringify(sum),
  );

  // 문항 → 저장 본문 — 한 판 한 틀(중복 키 없음)이라 기록 zod의 "세션 안 중복 거부"에 걸리지 않는다
  const qs = buildTemplateTestQuestions(all.templates, [], { mode: "tpl-swap", rng: () => 0.3 });
  const qItems = templateTestItems(qs.map((q) => q.key), qs.map(() => ({ correct: true, suggest: "pass" as const })));
  add(
    "문항 조립 → 저장: 키 중복 없음 · 본문 zod 통과 · (나) 정답 문장은 예문과 다르다",
    new Set(qs.map((q) => q.key)).size === qs.length &&
      toeicTemplateSessionBodySchema.safeParse({ ...body, items: qItems }).success &&
      qs.every((q) => !q.template.examples.some((e) => e.en === q.answerEn)),
  );

  // 최근 테스트·틀린 틀 수
  const partKeys = new Set(GROUPS.flatMap((x) => x.templates.map((t) => t.key)));
  const sessions: ToeicQuizSessionLike[] = [
    sess("s1", "tpl-recall", "2026-09-20T01:00:00.000Z", [["act-helps", true], ["mainly-because", false]]),
    sess("s2", "tpl-swap", "2026-09-21T01:00:00.000Z", [["other-part", true]]), // 다른 유형 틀만 — 뺀다
    sess("s3", "tpl-swap", "2026-09-22T01:00:00.000Z", [["often-cook", null]], null), // 판정 0 — 뺀다
    sess("s4", "tpl-swap", "2026-09-23T01:00:00.000Z", [["often-cook", false], ["act-helps", true]], null),
    { ...sess("s5", "tpl-recall", "2026-09-24T01:00:00.000Z", [["act-helps", true]]), mode: "speak" as const }, // 표현 시험 모드 — 뺀다
  ];
  const recent = recentTemplateTests(sessions, partKeys);
  add(
    "최근 테스트: 그 유형 틀이 든 틀 세션만·판정 0 제외·최신 먼저·○/판정·그만둠 표시·KST 시각",
    eqJson(
      recent.map((r) => [r.id, r.mode, r.correct, r.answered, r.finished, r.whenKo]),
      [
        ["s4", "tpl-swap", 1, 2, false, "2026.09.23 10:00"],
        ["s1", "tpl-recall", 1, 2, true, "2026.09.20 10:00"],
      ],
    ),
    JSON.stringify(recent),
  );
  const many = Array.from({ length: 13 }, (_x, i) => sess(`m${i}`, "tpl-recall", `2026-09-${String(10 + i).padStart(2, "0")}T01:00:00.000Z`, [["act-helps", true]]));
  add("최근 테스트: 최대 10개", recentTemplateTests(many, partKeys).length === 10 && recentTemplateTests(many, partKeys)[0].id === "m12");
  const wc = templateWrongCountsByMode(sessions, partKeys);
  add("모드별 틀린 틀 수(그 유형 틀만 — 틀렸고 미졸업)", wc["tpl-recall"] === 1 && wc["tpl-swap"] === 1, JSON.stringify(wc));

  // 멱등 키
  const viaUuid = newTemplateSessionId({ randomUUID: () => "0F8B6C2A-1D3E-4A5B-9C7D-112233445566" });
  const viaBytes = newTemplateSessionId({ getRandomValues: <T extends ArrayBufferView>(a: T) => { new Uint8Array(a.buffer).fill(0xab); return a; } });
  const viaNone = newTemplateSessionId({});
  add(
    "멱등 키: randomUUID(소문자로) · getRandomValues 폴백 · 둘 다 없어도 소문자 UUID v4 모양(TOEIC_TEMPLATE_SESSION_ID_RE)",
    TOEIC_TEMPLATE_SESSION_ID_RE.test(viaUuid) && TOEIC_TEMPLATE_SESSION_ID_RE.test(viaBytes) && TOEIC_TEMPLATE_SESSION_ID_RE.test(viaNone) && viaBytes.charAt(14) === "4",
    `${viaUuid} ${viaBytes} ${viaNone}`,
  );

  // 화면 이탈 저장(★4) — 진행 중이면 그만두기 모양, 끝 화면 저장이 실패한 채 떠나면 그 판 본문 그대로(QA S2 P3-4)
  const ISO = "2026-09-27T01:02:03.000Z";
  const base = { saved: false, saving: false, answered: 2, hasSessionId: true, finishedAt: undefined as string | null | undefined };
  const leaveCases: [string, Parameters<typeof templateTestLeaveSave>[0], { finishedAt: string | null } | null][] = [
    ["시작 화면", { ...base, stage: "intro", answered: 0 }, null],
    ["진행 중 · 판정 2", { ...base, stage: "run" }, { finishedAt: null }],
    ["진행 중 · 판정 0", { ...base, stage: "run", answered: 0 }, null],
    ["진행 중 · 이미 저장", { ...base, stage: "run", saved: true }, null],
    ["끝 화면 · 저장 실패(끝까지)", { ...base, stage: "done", finishedAt: ISO }, { finishedAt: ISO }],
    ["끝 화면 · 저장 실패(그만두기)", { ...base, stage: "done", finishedAt: null }, { finishedAt: null }],
    ["끝 화면 · 저장됨", { ...base, stage: "done", saved: true, finishedAt: ISO }, null],
    ["끝 화면 · 저장 중", { ...base, stage: "done", saving: true, finishedAt: ISO }, null],
    ["끝 화면 · 판정 0", { ...base, stage: "done", answered: 0, finishedAt: null }, null],
    ["멱등 키 없음", { ...base, stage: "run", hasSessionId: false }, null],
  ];
  const leaveBad = leaveCases.filter(([, input, want]) => !eqJson(templateTestLeaveSave(input), want));
  add(
    "이탈 저장 templateTestLeaveSave: 진행 중 판정 ≥1 → finishedAt null · 끝 화면 저장 실패 → 그 판 finishedAt 그대로 · 시작/저장됨/저장 중/판정 0/키 없음 → 안 함",
    leaveBad.length === 0,
    leaveBad.map(([name]) => name).join(", "),
  );
  return results;
}

// ---------------------------------------------------------------------------
// 2. 공략 세트 "뒤로"·멱등 저장 판정 (순수)
// ---------------------------------------------------------------------------

function runPureStoreAndBackChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "공략 표현 시험·멱등 저장");
  const book = toeicSetBackLink({ id: "set-1", guide: null });
  const part = toeicSetBackLink({ id: "guide-q3_4", guide: { kind: "part", part: "q3_4", sections: [] } });
  const legacy = toeicSetBackLink({ id: "guide-q11", guide: { part: "q11", sections: [] } });
  const bank = toeicSetBackLink({ id: "guide-templates", guide: { kind: "templates", flows: [], items: [] } });
  const broken = toeicSetBackLink({ id: "guide-x", guide: { kind: "part", part: "q1_2" } });
  add(
    "\"뒤로\": 표현집 → 표현집 상세(문구 그대로) · 유형 공략 → 그 폴더 ③ 탭 \"← Q3–4 공략\" · kind 없는 공략도 · 틀 은행·깨진 공략 → 폴더 목록",
    book.href === "/toeic/sets/set-1" &&
      book.labelKo === "← 표현집으로" &&
      book.buttonKo === "📒 표현집으로" &&
      part.href === "/toeic/guides/q3_4?tab=quiz" &&
      part.labelKo === "← Q3–4 공략" &&
      legacy.href === "/toeic/guides/q11?tab=quiz" &&
      bank.href === "/toeic/guides" &&
      broken.href === "/toeic/guides",
    JSON.stringify({ book, part, legacy, bank, broken }),
  );
  add(
    "유형 판정: part 네 값·kind 없음은 part·틀 은행/표현집/유형 밖은 null",
    toeicGuidePartOfSet({ guide: { kind: "part", part: "q8_10" } }) === "q8_10" &&
      toeicGuidePartOfSet({ guide: { part: "q5_7" } }) === "q5_7" &&
      toeicGuidePartOfSet({ guide: { kind: "templates" } }) === null &&
      toeicGuidePartOfSet({ guide: null }) === null &&
      toeicGuidePartOfSet({ guide: { kind: "part", part: "q1_2" } }) === null,
  );
  const same = { mode: "tpl-swap" as const, startedAt: "2026-09-27T01:00:00.000Z" };
  add(
    "멱등 판정 decideToeicQuizWithId: 없음 → create · 같은 판(mode·startedAt) → reuse · 시작 시각 다름 → create_new_id · 모드 다름 → create_new_id",
    decideToeicQuizWithId(null, same) === "create" &&
      decideToeicQuizWithId(same, same) === "reuse" &&
      decideToeicQuizWithId({ ...same, startedAt: "2026-09-27T01:00:00.001Z" }, same) === "create_new_id" &&
      decideToeicQuizWithId({ ...same, mode: "tpl-recall" }, same) === "create_new_id",
  );
  return results;
}

// ---------------------------------------------------------------------------
// 3. 파일 백엔드 실행 — 자식 프로세스(임시 cwd)에서 getStore().addToeicQuizWithId
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const store = await import(process.env.EVAL_STORE_URL);
const st = store.getStore();
const T0 = "2026-09-27T01:00:00.000Z";
const input = (startedAt, mode, correct) => ({ setId: "guide-templates", mode, startedAt, finishedAt: null, items: [{ word: "tpl:alpha", correct, answered: true }] });
const id = "tpl-0f8b6c2a-1d3e-4a5b-9c7d-112233445566";
const a = await st.addToeicQuizWithId(id, input(T0, "tpl-recall", true));
const b = await st.addToeicQuizWithId(id, input(T0, "tpl-recall", false));
const c = await st.addToeicQuizWithId(id, input("2026-09-27T02:00:00.000Z", "tpl-recall", true));
const d = await st.addToeicQuizWithId(id, input(T0, "tpl-swap", true));
const id2 = "tpl-11111111-2222-4333-8444-555555555555";
const [e1, e2] = await Promise.all([st.addToeicQuizWithId(id2, input(T0, "tpl-swap", true)), st.addToeicQuizWithId(id2, input(T0, "tpl-swap", true))]);
const list = await st.listToeicQuizzes("guide-templates");
const orig = list.find((q) => q.id === id);
console.log("@@RESULT@@" + JSON.stringify({
  cwd: process.cwd(),
  a: [a.record.id === id, a.reused],
  b: [b.record.id === id, b.reused, b.record.items[0].correct],
  c: [c.record.id !== id, c.reused],
  d: [d.record.id !== id && d.record.id !== c.record.id, d.reused],
  e: [e1.reused !== e2.reused, e1.record.id === id2 && e2.record.id === id2],
  count: list.length,
  origIntact: !!orig && orig.mode === "tpl-recall" && orig.startedAt === T0 && orig.items[0].correct === true,
}));
`;

function sha(file: string): string | null {
  return existsSync(file) ? createHash("sha1").update(readFileSync(file)).digest("hex") : null;
}

function runFileStoreChildChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "멱등 저장 — 파일 백엔드 실행");
  const repoDb = path.join(ROOT, "data", "db.json");
  const before = sha(repoDb);
  const dir = mkdtempSync(path.join(tmpdir(), "eval-toeic-s2-"));
  try {
    const script = path.join(dir, "child.mts");
    writeFileSync(script, CHILD_SCRIPT);
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const r = spawnSync(tsx, [script], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        STORE_BACKEND: "file",
        GOOGLE_APPLICATION_CREDENTIALS: "",
        GOOGLE_CLOUD_PROJECT: "",
        K_SERVICE: "",
        OPENAI_API_KEY: "",
        EVAL_STORE_URL: pathToFileURL(path.join(ROOT, "lib", "store.ts")).href,
      },
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT@@"));
    if (!line) {
      add("자식 프로세스 실행", false, `status=${r.status} ${(r.stderr ?? "").slice(0, 300)}`);
      return results;
    }
    const out = JSON.parse(line.slice("@@RESULT@@".length)) as Record<string, unknown>;
    const cwd = realpathSync(String(out.cwd));
    add("자식 프로세스 cwd = 임시 폴더(저장소 data/db.json이 아니다) · STORE_BACKEND=file", cwd === realpathSync(dir) && cwd !== realpathSync(ROOT), "임시 폴더");
    add("없으면 그 id로 만든다(reused false)", eqJson(out.a, [true, false]), JSON.stringify(out.a));
    add("같은 id·같은 판 두 번 → 쓰지 않고 그 문서(reused true — 둘째 본문은 버린다)", eqJson(out.b, [true, true, true]), JSON.stringify(out.b));
    add("같은 id·다른 시작 시각 → 덮지 않고 새 id(reused false)", eqJson(out.c, [true, false]), JSON.stringify(out.c));
    add("같은 id·다른 모드 → 덮지 않고 새 id", eqJson(out.d, [true, false]), JSON.stringify(out.d));
    add("같은 키 동시 두 요청 → 한 건(하나는 reused)", eqJson(out.e, [true, true]), JSON.stringify(out.e));
    add("최종 문서 수 4 · 원 문서 그대로", out.count === 4 && out.origIntact === true, `count=${out.count}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  add("저장소 data/db.json 무접촉(전후 sha 같음)", sha(repoDb) === before, String(before));
  return results;
}

// ---------------------------------------------------------------------------
// 4. 소스 대조 — 라우트·스토어·화면·페이지
// ---------------------------------------------------------------------------

function runS2SourceChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = adder(results, "S2 소스 대조");

  // 전사 라우트
  const tr = read("app/api/toeic/guides/templates/transcribe/route.ts");
  const trc = codeOnly(tr);
  const iKey = trc.indexOf("hasToeicTranscribeApiKey()");
  const iLen = trc.indexOf('req.headers.get("content-length")');
  const iForm = trc.indexOf("req.formData()");
  add("전사 라우트: runtime nodejs", /export const runtime = "nodejs"/.test(tr));
  add("전사 라우트: 키 검사(501) → content-length 413 → formData 순서", iKey > 0 && iKey < iLen && iLen < iForm, `${iKey} < ${iLen} < ${iForm}`);
  // 선검사 조건식의 모양 그대로(QA S2 P3-1 M2 — `if (false && …)`처럼 조건을 꺼도 순서 대조는 통과했다)
  add(
    "전사 라우트: 선검사 = `if (Number.isFinite(declared) && declared > 상한 + 여유) { … return tooLarge(); }` 그대로(조건을 끄거나 바꾸면 FAIL)",
    /const declared = Number\(req\.headers\.get\("content-length"\)\);\s*if \(Number\.isFinite\(declared\) && declared > TOEIC_TEMPLATE_AUDIO_MAX_BYTES \+ TOEIC_TEMPLATE_AUDIO_MULTIPART_SLACK_BYTES\) \{\s*console\.warn\([^;]*\);\s*return tooLarge\(\);\s*\}/.test(trc),
  );
  add(
    "전사 라우트: 선검사 상한 = 1 MiB + multipart 여유, 파일 상한 1 MiB(계약 상수)",
    /declared > TOEIC_TEMPLATE_AUDIO_MAX_BYTES \+ TOEIC_TEMPLATE_AUDIO_MULTIPART_SLACK_BYTES/.test(trc) && /audio\.size > TOEIC_TEMPLATE_AUDIO_MAX_BYTES/.test(trc) && /413/.test(trc),
  );
  add(
    "전사 라우트: 형식·이름 도우미(toeicAudioBaseType·toeicAudioTypeFromName·isAcceptedToeicAudioType·toeicAudioFileName)",
    /declaredType && declaredType !== "application\/octet-stream" \? declaredType : toeicAudioTypeFromName\(uploadedName\)/.test(trc) && /isAcceptedToeicAudioType\(type\)/.test(trc) && /toeicAudioFileName\(type\)/.test(trc),
  );
  add(
    "전사 라우트: transcribeAnswer({ bytes, fileName, type }, req.signal) — 기대 문장·prompt 없음",
    /transcribeAnswer\(\{ bytes: await audio\.arrayBuffer\(\), fileName, type \}, req\.signal\)/.test(trc) && !/prompt|answerEn|frameEn|expected/.test(trc),
  );
  add("전사 라우트: 스토어·lib/ai import 없음(저장 없음)", !allImportPaths(tr).some((p) => /\/store|lib\/ai/.test(p)), allImportPaths(tr).join(","));
  add("전사 라우트: 200 words = countWords(text) · 499 client_closed · 500 transcribe_failed retriable", /words: countWords\(r\.text\)/.test(trc) && /client_closed[\s\S]*499/.test(trc) && /transcribe_failed[\s\S]*retriable: true[\s\S]*500/.test(trc));
  add("전사 라우트: 전사문을 로그에 찍지 않는다", !/console\.[a-z]+\([^;]*r\.text/.test(trc));

  // 기록 라우트
  const se = read("app/api/toeic/guides/templates/sessions/route.ts");
  const sec = codeOnly(se);
  add("기록 라우트: 본문 zod = toeicTemplateSessionBodySchema(값 없는 issues)", /toeicTemplateSessionBodySchema\.safeParse\(raw, \{ error: toeicZodErrorKo \}\)/.test(sec) && /toToeicIssues\(parsed\.error\.issues\)/.test(sec));
  add("기록 라우트: setId는 틀 은행 id로 고정(본문 값을 믿지 않는다)", /setId: TOEIC_TEMPLATE_BANK_ID/.test(sec) && !/parsed\.data\.setId|raw\.setId/.test(sec));
  add("기록 라우트: 멱등 저장 addToeicQuizWithId(toeicTemplateSessionDocId(clientSessionId), …)", /addToeicQuizWithId\(toeicTemplateSessionDocId\(clientSessionId\), \{/.test(sec) && !/addToeicQuiz\(/.test(sec));
  add("기록 라우트: 틀 은행 렌더 판정 → 404 bank_not_found", /isRenderableToeicTemplateBank\(bank\)/.test(sec) && /bank_not_found[\s\S]*404/.test(sec));
  add("기록 라우트: AI·키 검사·prod-guard 없음", !/OPENAI_API_KEY|assertDestructiveAllowed|prod-guard|lib\/ai\/client/.test(sec));
  add(
    "기록 라우트: 틀 은행 읽기도 try 안 — 읽기·저장 예외는 계약의 500 save_failed JSON(QA S2 P3-2)",
    /try \{\s*const store = getStore\(\);\s*const bank = await store\.getToeicSet\(TOEIC_TEMPLATE_BANK_ID\);/.test(sec) &&
      (sec.match(/getStore\(\)/g) ?? []).length === 1 &&
      /\} catch \(err\) \{[\s\S]*?error: "save_failed"[\s\S]*?\}, 500\);\s*\}\s*\}$/.test(sec.trimEnd()),
  );

  // 스토어
  const st = read("lib/store.ts");
  const fileBody = st.slice(st.indexOf("async addToeicQuizWithId("), st.indexOf("async listToeicQuizzes("));
  add("스토어 인터페이스: addToeicQuizWithId(id, input): Promise<AddToeicQuizWithIdResult>", /addToeicQuizWithId\(id: string, input: NewToeicQuiz\): Promise<AddToeicQuizWithIdResult>;/.test(st));
  add("파일 백엔드: 판정(decideToeicQuizWithId)이 mutate 안에서", /return this\.mutate\([\s\S]*decideToeicQuizWithId\(found, input\)/.test(fileBody));
  const fs = read("lib/store-firestore.ts");
  const fsBody = fs.slice(fs.indexOf("async addToeicQuizWithId("), fs.indexOf("/** 모르는 mode 문서는 버리고 경고한다"));
  add(
    "Firestore: create(원자) → ALREADY_EXISTS면 읽어 decideToeicQuizWithId — reuse 아니면 자동 id로(덮지 않는다)",
    /await ref\.create\(data\)/.test(fsBody) && /GRPC_ALREADY_EXISTS/.test(fsBody) && /decideToeicQuizWithId\(existing, input\) === "reuse"/.test(fsBody) && /this\.toeicQuizzes\(\)\.doc\(\)\)/.test(fsBody) && !/\.set\(/.test(fsBody),
  );

  // 테스트 화면
  const tc = read("components/toeic-template-test.tsx");
  const tcc = codeOnly(tc);
  const badImports = allImportPaths(tc).filter((p) => /(lib\/ai|\/store|openai|zod)/.test(p));
  add(`테스트 화면: "use client" · lib/ai·store·openai·zod import 없음 · stopSpeaking·Media Session 없음`, /^"use client";/.test(tc) && badImports.length === 0 && !/stopSpeaking|bindMediaSession/.test(tcc), badImports.join(","));
  const mic = fnBody(tcc, "onMic");
  const iStop = mic.indexOf("stopSound()");
  const iUnlock = mic.indexOf("unlockSpeechPlayback()");
  const iRec = mic.indexOf("startRecording(");
  add("🎤 탭: 큐 멈춤 → unlockSpeechPlayback() → startRecording() 순서", iStop > 0 && iStop < iUnlock && iUnlock < iRec, `${iStop} < ${iUnlock} < ${iRec}`);
  // 2026-10-03 마이크 유지(SPEC §20-4): 녹음은 keeper.startRecording — 마이크를 (다시) 여는 때(첫 🎤·keep인데 놓인 뒤)만 15초
  add(
    "🎤 마이크를 (다시) 여는 때만 권한 창 시간(MIC_CHECK_GUM_TIMEOUT_MS — 첫 🎤 또는 keep인데 놓인 뒤), 녹음은 마이크 유지(keeper.startRecording), 상한 판정은 canTranscribeAgain",
    /const needsPrompt = firstMicRef\.current \|\| \(keeper\.policy === "keep" && !keeper\.holding\(\)\);/.test(mic) &&
      /keeper\s*\.startRecording\(needsPrompt \? \{ gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS \} : \{\}\)/.test(mic) &&
      !/(^|[^.\w])startRecording\(/.test(mic) &&
      /canTranscribeAgain\(countsRef\.current\)/.test(mic),
  );
  const startFn = fnBody(tcc, "start");
  add("시작 탭: unlockSpeechPlayback · 멱등 키(newTemplateSessionId) · startedAt · 첫 문항 열기", /unlockSpeechPlayback\(\)/.test(startFn) && /newTemplateSessionId\(\)/.test(startFn) && /startedAtRef\.current = new Date\(\)\.toISOString\(\)/.test(startFn) && /openQuestion\(0\)/.test(startFn));
  const trFn = fnBody(tcc, "transcribe");
  add("받아쓰기: 요청마다 45초 AbortController(TOEIC_TEMPLATE_TRANSCRIBE_CLIENT_TIMEOUT_MS)", /setTimeout\(\(\) => ac\.abort\(\), TOEIC_TEMPLATE_TRANSCRIBE_CLIENT_TIMEOUT_MS\)/.test(trFn) && /signal: ac\.signal/.test(trFn));
  add(
    "받아쓰기: 녹음 하나만 보낸다(정답·틀을 싣지 않는다) · WAV 변환 · 1 MiB 안",
    (trFn.match(/fd\.append\(/g) ?? []).length === 1 && /fd\.append\(TOEIC_TEMPLATE_TRANSCRIBE_FIELD_AUDIO,/.test(trFn) && /toWav16kMono\(rec\.blob\)/.test(trFn) && /TOEIC_TEMPLATE_AUDIO_MAX_BYTES/.test(trFn),
  );
  add("받아쓰기: 유효한 첫 시도 판정 isValidTemplateAttempt · (가)만 같은 뜻 교재 틀 대조", /isValidTemplateAttempt\(data, check\.check\)/.test(trFn) && /mode === "tpl-recall"\s*\?\s*compareWithAlternatives\(/.test(trFn));
  add("받아쓰기: 0.6초 미만은 보내지 않는다(isSendableTemplateRecording)", /isSendableTemplateRecording\(result\.durationMs\)/.test(fnBody(tcc, "finishRecording")));
  // (가)만 같은 뜻 교재 틀 대조(QA S2 P3-1 M18) — 화면의 대조 호출은 한 곳, (나) 갈래는 물은 틀만
  add(
    "받아쓰기: 대안 대조는 (가) 갈래 한 곳뿐 · (나) 갈래는 compareTemplateAnswer(물은 틀)·viaAlternative false",
    (tcc.match(/compareWithAlternatives\(/g) ?? []).length === 1 &&
      /mode === "tpl-recall"\s*\?\s*compareWithAlternatives\([^;]*\)\s*:\s*\{ check: compareTemplateAnswer\(cur\.frameEn, cur\.answerFills, data\.text\), matchedKey: cur\.key, viaAlternative: false \};/.test(trFn),
  );
  // 받아쓰기 수 = 보낸 요청(★6) — 수는 요청 바로 앞에서 올린다(QA S2 P3-3: WAV 변환 중 끊기면 보내지 않았는데 1이 남았다)
  const iWav = trFn.indexOf("toWav16kMono(");
  const iTok = trFn.indexOf("if (runRef.current !== token) return;", iWav);
  const iType = trFn.indexOf("isAcceptedToeicAudioType(type)");
  const iBefore = trFn.indexOf("const before = countsRef.current;");
  const iInc = trFn.indexOf("setCounts({ perQuestion: before.perQuestion + 1, perSession: before.perSession + 1 });");
  const iFetch = trFn.indexOf("await fetch(");
  add(
    "받아쓰기 수: WAV 변환 → 끊김 확인 → 보낼 수 없음(세지 않음) → 수 올리기 → 요청 순서 · 올리기는 한 곳 · 그 앞에 수를 건드리는 곳 없음",
    iWav > 0 && iWav < iTok && iTok < iType && iType < iBefore && iBefore < iInc && iInc < iFetch &&
      (trFn.match(/setCounts\(\{[^}]*\+ 1/g) ?? []).length === 1 &&
      !/setCounts\(/.test(trFn.slice(0, iBefore)),
    `${iWav} < ${iTok} < ${iType} < ${iBefore} < ${iInc} < ${iFetch}`,
  );
  add(
    "받아쓰기 501(키 없음): 올린 수를 되돌린다(setCounts(before)) → 자기 판정(nokey)(QA S2 P3-1 M17)",
    /data\.error === "no_api_key"\) \{\s*setCounts\(before\);[^\n]*\n\s*setSelfReason\("nokey"\);/.test(trFn),
  );
  // 문제 머리 줄(P2-1) — 묶음·쓰임은 templateTestPromptMeta를 지나서만 보인다(q.useKo·q.groupKo를 그대로 그리지 않는다)
  add(
    "문제 머리 줄: templateTestPromptMeta(q)로만 — q.useKo·{q.groupKo}를 그대로 그리지 않는다(두 모드 공통)",
    /const meta = templateTestPromptMeta\(q\);/.test(tcc) && /\{meta\.useKo\}/.test(tcc) && /\{meta\.groupKo\}/.test(tcc) && !/q\.useKo|\{q\.groupKo\}/.test(tcc),
  );
  add("판정 탭이 다음 문항을 연다(openQuestion(i + 1)) · 마지막이면 끝", /if \(i \+ 1 >= total\) finish\(true\);\s*else openQuestion\(i \+ 1\);/.test(fnBody(tcc, "judge")));
  add("Wake Lock은 테스트 진행 동안 · 녹음 중 숨김 → 문항을 탭으로 다시(interrupted)", /useToeicWakeLock\(stage === "run"\)/.test(tcc) && /visibilitychange/.test(tcc) && /kind: "interrupted"/.test(tcc));
  add("저장: 기록 라우트 · 판정 0이면 저장하지 않음 · 성공하면 스트릭 갱신 신호 · 이탈 저장은 keepalive", /\/api\/toeic\/guides\/templates\/sessions/.test(tcc) && /STREAK_REFRESH_EVENT/.test(tcc) && /keepalive: true/.test(tcc) && /판정한 문항이 없어 저장하지 않았어요/.test(tcc));
  // 이탈 저장(★4) — pagehide는 bfcache 아닌 이탈만(QA S2 P3-1 M14), 판단은 templateTestLeaveSave(끝 화면 저장 실패도 — P3-4)
  add(
    "이탈 저장: pagehide는 `if (!e.persisted)`일 때만 · 언마운트도 같은 함수 · 판단 templateTestLeaveSave → buildBody(plan.finishedAt) keepalive",
    /const onPageHide = \(e: PageTransitionEvent\) => \{\s*if \(!e\.persisted\) leaveSaveRef\.current\(\);/.test(tcc) &&
      /window\.addEventListener\("pagehide", onPageHide\)/.test(tcc) &&
      /\(\) => \(\) => \{\s*leaveSaveRef\.current\(\);/.test(tcc) &&
      /const plan = templateTestLeaveSave\(\{[\s\S]*?\}\);\s*if \(plan === null\) return;/.test(tcc) &&
      /body: JSON\.stringify\(buildBody\(plan\.finishedAt\)\),\s*keepalive: true,/.test(tcc) &&
      !/stageRef\.current !== "run"/.test(tcc),
  );

  // 테스트 페이지·폴더 페이지
  const tp = read("app/toeic/guides/[part]/templates/test/page.tsx");
  add("테스트 페이지: force-dynamic · 네 유형 밖 404 · 문항은 서버가 buildTemplateTestQuestions(onlyWrong = scope wrong)", /export const dynamic = "force-dynamic"/.test(tp) && /if \(!isToeicGuidePart\(part\)\) notFound\(\)/.test(tp) && /buildTemplateTestQuestions\(scoped\.templates, sessions, \{ mode: p\.mode, onlyWrong: p\.scope === "wrong" \}\)/.test(tp));
  add("테스트 페이지: 화면에 틀 객체·testFills를 넘기지 않는다(문항 칸만)", !/testFills|template: q\.template/.test(codeOnly(tp)));
  add(
    "테스트 페이지: 같은 뜻 교재 틀(alternatives)은 (가)에만 — (나)는 빈 배열(QA S2 P3-1 M18)",
    /alternatives: p\.mode === "tpl-recall" \? templateAlternatives\(q\.template, templates\)\.map\([^)]*\) => \(\{ key: a\.key, frameEn: a\.frameEn, frameKo: a\.frameKo \}\)\) : \[\],/.test(codeOnly(tp)) &&
      (codeOnly(tp).match(/templateAlternatives\(/g) ?? []).length === 1,
  );
  const fp = read("app/toeic/guides/[part]/page.tsx");
  add("폴더 페이지: ② 탭에 넘기는 틀의 testFills를 비운다(S1 QA P3-6)", /templates: templates\.map\(\(t\) => \(\{ \.\.\.t, testFills: \[\] \}\)\)/.test(fp));
  add("폴더 페이지: 최근 테스트·모드별 틀린 틀 수(서버 요약)", /recentTemplateTests\(bankSessions, partKeys\)/.test(fp) && /templateWrongCountsByMode\(bankSessions, partKeys\)/.test(fp));
  const tv = read("components/toeic-template-view.tsx");
  add("② 탭: 🧩 틀 테스트 입구(이어서 하기·묶음·틀린 틀만) + 최근 테스트 + ?range=wrong", /toeicTemplateTestHref\(part, \{ mode: "tpl-recall", scope: "group", group: next\.groupKo \}\)/.test(tv) && /scope: "wrong"/.test(tv) && /최근 테스트/.test(tv) && /initialRange === "wrong"/.test(tv));
  add("② 탭: 재생 시작 때 설정 접기(S1 QA P3-1)", /if \(settingsRef\.current\) settingsRef\.current\.open = false;/.test(fnBody(tv, "startWith")));

  // T8
  const qp = read("app/toeic/sets/[id]/quiz/page.tsx");
  // 2026-10-02(docs/harness/toeic.md §12-13-2): 유형 공략의 교재 표현 시험을 닫았다 — 옛 공략 갈래 3건(상한 20·말하기 weakness·공략 안내
  // 문구)은 페이지가 폴더 ③ 👀 틀 시험으로 보내므로 리다이렉트 대조로 교체했다(§12-13-5 퇴역·교체).
  add(
    "시험 페이지: 틀 은행 → /toeic/guides · 유형 공략 세트 → 그 유형 폴더 ?tab=quiz(틀 은행 리다이렉트와 같은 자리, notFound보다 앞) · \"뒤로\" = toeicSetBackLink",
    /isToeicTemplateBankSet\(record\)\) redirect\("\/toeic\/guides"\)/.test(qp) &&
      /if \(record && isToeicGuidePartSet\(record\)\) redirect\(guideQuizHref\(record\)\);/.test(qp) &&
      /return part \? toeicGuideFolderHref\(part, \{ tab: "quiz" \}\) : "\/toeic\/guides";/.test(qp) &&
      qp.indexOf("isToeicGuidePartSet(record)) redirect(") < qp.indexOf("notFound();") &&
      /toeicSetBackLink\(record\)/.test(qp) &&
      !/href=\{`\/toeic\/sets\/\$\{id\}`\}/.test(qp),
  );
  add(
    "시험 페이지: 공략 갈래 퇴역 — isGuide·TOEIC_GUIDE_CHOICE_SESSION_MAX·\"교재 문장 말하기\"가 페이지에 없다(표현집 시험 동작은 그대로)",
    !/isGuide|TOEIC_GUIDE_CHOICE_SESSION_MAX|교재 문장 말하기/.test(codeOnly(qp)) && /buildToeicChoiceQuestions\(record, \{ modes \}\)/.test(qp),
  );
  for (const f of ["app/toeic/sets/[id]/wrong/page.tsx", "app/toeic/sets/[id]/history/page.tsx"]) {
    const src = read(f);
    add(
      `${f}: 틀 은행 → /toeic/guides · 유형 공략 세트 → 폴더 ?tab=quiz(2026-10-02 §12-13-2) · "뒤로" = toeicSetBackLink · 하드코딩 표현집 링크 없음`,
      /isToeicTemplateBankSet\(record\)\) redirect\("\/toeic\/guides"\)/.test(src) &&
        /if \(record && isToeicGuidePartSet\(record\)\) \{[\s\S]*?redirect\(part \? toeicGuideFolderHref\(part, \{ tab: "quiz" \}\) : "\/toeic\/guides"\);/.test(src) &&
        src.indexOf("isToeicGuidePartSet(record)") < src.indexOf("notFound();") &&
        /toeicSetBackLink\(record\)/.test(src) &&
        !/href=\{`\/toeic\/sets\/\$\{id\}`\}/.test(src),
    );
  }
  const dp = read("app/toeic/sets/[id]/page.tsx");
  add("표현집 상세: 공략 계열이면 리다이렉트(유형 공략 → 폴더 ③ 탭, 틀 은행 → 폴더 목록)", /isToeicGuideSet\(record\)/.test(dp) && /redirect\(part \? toeicGuideFolderHref\(part, \{ tab: "quiz" \}\) : "\/toeic\/guides"\)/.test(dp));
  const runner = read("components/toeic-quiz-runner.tsx");
  add("시험 러너 끝 화면: \"뒤로\"는 페이지가 넘긴 back(하드코딩 표현집 링크 없음)", /<Link href=\{back\.href\}/.test(runner) && !/href=\{`\/toeic\/sets\/\$\{id\}`\}/.test(runner));
  for (const f of ["app/api/toeic/sets/[id]/rename/route.ts", "app/api/toeic/sets/[id]/points/route.ts"]) {
    const src = codeOnly(read(f));
    const iGuide = src.indexOf("isToeicGuideSet(");
    const iRender = src.indexOf("isRenderableToeicSet(");
    const iKey2 = src.indexOf("OPENAI_API_KEY");
    const iPlan = src.indexOf("planPointsChunks(");
    add(
      `${f}: 공략 계열 → 409 is_guide(렌더 판정·키 검사·AI 앞)`,
      iGuide > 0 && /error: "is_guide"[\s\S]{0,120}409/.test(src) && iGuide < iRender && (iKey2 < 0 || iGuide < iKey2) && (iPlan < 0 || iGuide < iPlan),
      `${iGuide} ${iRender} ${iKey2} ${iPlan}`,
    );
  }
  // 2026-10-02(§12-13-2): ③ 탭은 👀 틀 시험(ToeicTemplateQuizTab) — 교재 표현 목록은 ① 끝 읽기 전용(시험·오답노트·기록 버튼 없음)
  const ex = read("components/toeic-guide-expr-list.tsx");
  const fv = codeOnly(read("components/toeic-guide-folder-view.tsx"));
  add(
    "③ 탭: 👀 틀 시험(ToeicTemplateQuizTab — 틀 0이면 빈 상태) · 폴더 탭이 표현 목록 컴포넌트를 쓰지 않는다 · 표현 목록에 /toeic/sets/guide-… 시험·오답노트·기록 링크 없음",
    /tab === "quiz" &&\s*\(data\.templates\.length > 0 \? \(\s*<ToeicTemplateQuizTab/.test(fv) &&
      !/ToeicGuideExprList/.test(fv) &&
      !/\/toeic\/sets\/|toeicGuideSetId|교재 문장 말하기|quiz\?modes/.test(codeOnly(ex)),
  );

  // 새 클라이언트 안전 모듈
  const tvm = read("lib/toeic-template-test-view.ts");
  const allowed = ["./kst", "./toeic-guide-view", "./toeic-quiz", "./toeic-template"];
  const extra = runtimeImportPaths(tvm).filter((p) => !allowed.includes(p));
  add("lib/toeic-template-test-view.ts: 런타임 import 허용 목록 · lookbehind 없음 · window/localStorage 없음", extra.length === 0 && !/\(\?<[=!]/.test(tvm) && !/\bwindow\.|localStorage/.test(codeOnly(tvm)), extra.join(","));
  const lines = read("components/toeic-template-lines.tsx");
  add("틀 줄 조각(components/toeic-template-lines.tsx): ② 탭과 테스트가 같이 쓴다(한 벌)", /from "@\/components\/toeic-template-lines"/.test(tv) && /from "@\/components\/toeic-template-lines"/.test(tc) && !/function FrameLine\(/.test(tv) && /export function FrameLine\(/.test(lines));
  return results;
}

export function runToeicGuideS2Checks(): GuideCheckResult[] {
  return [...runTestViewChecks(), ...runPureStoreAndBackChecks(), ...runFileStoreChildChecks(), ...runS2SourceChecks()];
}
