/**
 * scripts/eval-japanese.ts — 아빠의 일본어 오프라인 검증 + spec-sync (docs/harness/japanese.md §9)
 *
 * J1 범위: 호출 A(JLPT 단어 생성)의 zod·후처리 순수 함수·프롬프트↔스펙 대조를 **실호출 0회**로 잠근다.
 * - 오프라인(기본, 무비용): 토큰 무결성·제외 재적용·include 우선·포함 이행 보고·중복 접기·레벨 태깅·
 *   include 배분 계획·zod 거부 케이스.
 * - spec-sync: JA_VOCAB_SYSTEM_PROMPT·JA_VOCAB_USER_TEMPLATE ↔ japanese.md 바이트 대조(공통 spec-sync 재사용),
 *   JSON Schema는 스펙 §2-3 코드블록을 JSON으로 파싱해 **의미 동치**로 대조(문자열 포맷차에 취약한 대조보다 강하다).
 * - 실호출 점검은 게이트(EVAL_JAPANESE=1)로 **자리만** 있고 J1에서는 실행하지 않는다(§9, HARNESS 규약).
 *
 * 안전: EVAL_OFFLINE_ONLY=1이면 네트워크 자체를 막는다(eval-english와 같은 2차 방어선).
 */

import {
  JA_ENTRIES_MAX,
  JA_POS,
  JA_VOCAB_GENERATION_JSON_SCHEMA,
  JA_VOCAB_TOPIC_PRESETS,
  JLPT_LEVELS,
  jaVocabGenerationSchema,
  resolveJaGlyph,
  type JaToken,
  type JaVocabGenEntry,
} from "../lib/ai/japanese/schemas";
import {
  JA_VOCAB_SYSTEM_PROMPT,
  JA_VOCAB_USER_TEMPLATE,
  buildJaVocabUserMessage,
} from "../lib/ai/japanese/prompts";
import {
  applyVocabPostprocess,
  normalizeJaWord,
  planIncludeDistribution,
} from "../lib/ai/japanese/vocab";
import {
  aggregateJaStatsByMode,
  buildJaQuizQuestions,
  buildJaReviewCandidatesByMode,
  type JaQuizSessionLike,
  type JaQuizSourceEntry,
} from "../lib/ai/japanese/quiz";
import {
  checkSpecSync,
  extractSpecBlocks,
  printSpecSyncDetails,
  type SpecSyncOutcome,
  type SpecSyncTarget,
} from "./spec-sync";

// .env.local / .env 로드 (없으면 무시). 이미 설정된 환경 변수가 우선한다.
for (const envFile of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // 파일이 없으면 건너뛴다
  }
}

// 비용 게이트 — EVAL_OFFLINE_ONLY=1이면 네트워크 자체를 막는다(eval-english와 같은 관용구).
if (process.env.EVAL_OFFLINE_ONLY === "1") {
  const blocked = () => {
    throw new Error("EVAL_OFFLINE_ONLY=1 — 네트워크 호출이 차단됐습니다. 오프라인 점검 앞에 실호출 코드가 들어왔습니다.");
  };
  globalThis.fetch = blocked as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// 결과 표
// ---------------------------------------------------------------------------

interface CheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
}

function printTable(results: CheckResult[]): void {
  console.log("");
  console.log(`| ${"결과".padEnd(4)} | ${"영역".padEnd(16)} | 점검 항목 | 상세 |`);
  console.log(`|------|------------------|-----------|------|`);
  for (const r of results) {
    console.log(`| ${r.pass ? "PASS" : "FAIL"} | ${r.book.padEnd(16)} | ${r.check} | ${r.detail} |`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// 픽스처 헬퍼
// ---------------------------------------------------------------------------

const tok = (surface: string, reading: string | null = null): JaToken => ({ surface, reading });

/** 유효한 호출 A entry(레벨 없음). 필요한 필드만 덮어쓴다. 기본값은 zod를 통과한다. */
function genEntry(over: Partial<JaVocabGenEntry> = {}): JaVocabGenEntry {
  return {
    word: "本",
    kana: "ほん",
    pos: ["명사"],
    meaningsKo: ["책"],
    example: {
      ja: "本を読む。",
      ko: "책을 읽는다.",
      tokens: [tok("本", "ほん"), tok("を"), tok("読", "よ"), tok("む"), tok("。")],
    },
    wordTokens: [tok("本", "ほん")],
    imageEmoji: "📖",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// zod 검증 (§2-4)
// ---------------------------------------------------------------------------

function runZodChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "호출 A zod(§2-4)";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  // 정상 통과
  {
    const r = jaVocabGenerationSchema.safeParse({ entries: [genEntry(), genEntry({ word: "水", kana: "みず", meaningsKo: ["물"], example: { ja: "水を飲む。", ko: "물을 마신다.", tokens: [tok("水", "みず"), tok("を"), tok("飲", "の"), tok("む"), tok("。")] }, wordTokens: [tok("水", "みず")] })] });
    add("정상 2개 통과", r.success, r.success ? "통과" : JSON.stringify(r.error?.issues?.slice(0, 3)));
  }

  // reading 정리(거부 아님) — 가나 토큰에 reading이 붙어도 통과하고 null로 정리된다
  {
    const r = jaVocabGenerationSchema.safeParse({
      entries: [genEntry({ wordTokens: [tok("本", "ほん")], example: { ja: "本を読む。", ko: "책을 읽는다.", tokens: [tok("本", "ほん"), tok("を", "を"), tok("読", "よ"), tok("む", "む"), tok("。", "。")] } })],
    });
    const readings = r.success ? r.data.entries[0].example.tokens.map((t) => t.reading) : [];
    // 한자 토큰(本·読)만 reading 유지, 가나·기호(を·む·。)는 null로 정리
    const ok = r.success && readings[0] === "ほん" && readings[1] === null && readings[2] === "よ" && readings[3] === null && readings[4] === null;
    add("reading 정리: 가나 토큰 reading→null(거부 아님)", ok, `readings=${JSON.stringify(readings)}`);
  }

  // 거부 케이스
  const reject: { name: string; input: unknown }[] = [
    { name: "토큰 무결성: wordTokens가 word와 불일치", input: { entries: [genEntry({ word: "本", wordTokens: [tok("木", "き")] })] } },
    { name: "토큰 무결성: example.tokens가 ja와 불일치", input: { entries: [genEntry({ example: { ja: "本を読む。", ko: "책을 읽는다.", tokens: [tok("水", "みず")] } })] } },
    { name: "kana 가타카나", input: { entries: [genEntry({ kana: "ホン" })] } },
    { name: "kana 로마자", input: { entries: [genEntry({ kana: "hon" })] } },
    { name: "reading 히라가나 아님(한자 토큰)", input: { entries: [genEntry({ wordTokens: [tok("本", "ホン")] })] } },
    { name: "meaningsKo 한글 없음(일본어만)", input: { entries: [genEntry({ meaningsKo: ["ほん"] })] } },
    { name: "meaningsKo 0개", input: { entries: [genEntry({ meaningsKo: [] })] } },
    { name: "meaningsKo 4개(>3)", input: { entries: [genEntry({ meaningsKo: ["가", "나", "다", "라"] })] } },
    { name: "example.ko 한글 없음", input: { entries: [genEntry({ example: { ja: "本を読む。", ko: "hon wo yomu", tokens: [tok("本", "ほん"), tok("を"), tok("読", "よ"), tok("む"), tok("。")] } })] } },
    { name: "example.ja 5자 미만", input: { entries: [genEntry({ word: "手", kana: "て", wordTokens: [tok("手", "て")], example: { ja: "手。", ko: "손.", tokens: [tok("手", "て"), tok("。")] } })] } },
    { name: "표제어 중복", input: { entries: [genEntry(), genEntry()] } },
    { name: "entries 0개", input: { entries: [] } },
    { name: `entries ${JA_ENTRIES_MAX + 1}개(초과)`, input: { entries: Array.from({ length: JA_ENTRIES_MAX + 1 }, (_, i) => genEntry({ word: `語${i}`, kana: "ご", wordTokens: [tok("語", "ご"), tok(String(i))] })) } },
    { name: "pos enum 밖", input: { entries: [genEntry({ pos: ["형용사"] as unknown as JaVocabGenEntry["pos"] })] } },
  ];
  for (const rc of reject) {
    const rejected = !jaVocabGenerationSchema.safeParse(rc.input).success;
    add(`거부: ${rc.name}`, rejected, rejected ? "거부됨" : "통과되면 안 됨");
  }

  return results;
}

// ---------------------------------------------------------------------------
// 오쿠리가나 토큰화 회귀 가드 (§2-1-11·P1) — reading을 단 토큰은 surface가 한자만이어야 한다.
// 값으로 못박는다: 규칙(schemas.ts jaTokenSchema의 mixed 거부)을 지우면 묶음 케이스가 통과돼 FAIL 난다.
// ---------------------------------------------------------------------------

function runOkuriganaChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "오쿠리가나(§2-1-11)";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  // 促す를 促(うなが)+す(null)로 올바르게 가른 entry(다른 필드는 전부 유효)
  const promptSplit = () =>
    genEntry({
      word: "促す",
      kana: "うながす",
      pos: ["동사(타)"],
      meaningsKo: ["재촉하다"],
      wordTokens: [tok("促", "うなが"), tok("す")],
      example: { ja: "彼を促す。", ko: "그를 재촉한다.", tokens: [tok("彼", "かれ"), tok("を"), tok("促", "うなが"), tok("す"), tok("。")] },
    });

  // 통과 1 — 올바른 분리(促す·食べる·ご飯 경계·一日 한자만)
  {
    const r = jaVocabGenerationSchema.safeParse({
      entries: [
        promptSplit(),
        genEntry({ word: "食べる", kana: "たべる", pos: ["동사(타)"], meaningsKo: ["먹다"], wordTokens: [tok("食", "た"), tok("べる")], example: { ja: "ご飯を食べる。", ko: "밥을 먹는다.", tokens: [tok("ご"), tok("飯", "はん"), tok("を"), tok("食", "た"), tok("べる"), tok("。")] } }),
        genEntry({ word: "一日", kana: "いちにち", pos: ["명사"], meaningsKo: ["하루"], wordTokens: [tok("一日", "いちにち")], example: { ja: "一日が長い。", ko: "하루가 길다.", tokens: [tok("一日", "いちにち"), tok("が"), tok("長", "なが"), tok("い"), tok("。")] } }),
      ],
    });
    add("통과: 올바른 분리(促→促(うなが)+す · 食べる · ご飯 경계 · 一日 한자만)", r.success, r.success ? "통과" : JSON.stringify(r.error?.issues?.slice(0, 4)));
  }

  // 거부 1 — wordTokens를 통째로 묶고 reading이 오쿠리가나까지 덮음: 促す(うながす)
  {
    const bad = promptSplit();
    const input = { entries: [{ ...bad, wordTokens: [tok("促す", "うながす")] }] };
    add("거부: wordTokens 묶음(促す(うながす)) — 오쿠리가나에 reading", !jaVocabGenerationSchema.safeParse(input).success, "묶음이면 거부되어야 함");
  }

  // 거부 2 — example.tokens를 통째로 묶음: 食べる(たべる)
  {
    const input = {
      entries: [genEntry({ word: "食べる", kana: "たべる", pos: ["동사(타)"], meaningsKo: ["먹다"], wordTokens: [tok("食", "た"), tok("べる")], example: { ja: "ご飯を食べる。", ko: "밥을 먹는다.", tokens: [tok("ご"), tok("飯", "はん"), tok("を"), tok("食べる", "たべる"), tok("。")] } })],
    };
    add("거부: example.tokens 묶음(食べる(たべる))", !jaVocabGenerationSchema.safeParse(input).success, "묶음이면 거부되어야 함");
  }

  // 거부 3 — 활용형 묶음: 広がった(ひろがった)
  {
    const input = { entries: [genEntry({ word: "広がった", kana: "ひろがった", pos: ["동사(자)"], meaningsKo: ["넓어졌다"], wordTokens: [tok("広がった", "ひろがった")], example: { ja: "空が広がった。", ko: "하늘이 넓어졌다.", tokens: [tok("空", "そら"), tok("が"), tok("広", "ひろ"), tok("がった"), tok("。")] } })] };
    add("거부: 활용형 묶음(広がった(ひろがった))", !jaVocabGenerationSchema.safeParse(input).success, "묶음이면 거부되어야 함");
  }

  return results;
}

// ---------------------------------------------------------------------------
// 후처리 순수 함수 (§2-4 1~5, §2-0)
// ---------------------------------------------------------------------------

function runPostprocessChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "후처리(§2-4)";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  const hon = genEntry({ word: "本", kana: "ほん" });
  const mizu = genEntry({ word: "水", kana: "みず" });

  // 1) 제외 재적용 — word 일치
  {
    const r = applyVocabPostprocess({ entries: [hon, mizu], level: "N3", include: [], exclude: [{ word: "水", kana: "みず" }] });
    const ok = r.entries.length === 1 && r.entries[0].word === "本" && r.filteredCount === 1;
    add("제외 재적용: word 일치 제거", ok, `남은=[${r.entries.map((e) => e.word).join(",")}] filtered=${r.filteredCount}`);
  }

  // 1) 제외 재적용 — kana 일치(표기 달라도)
  {
    const r = applyVocabPostprocess({ entries: [hon], level: "N3", include: [], exclude: [{ word: "冊", kana: "ほん" }] });
    add("제외 재적용: kana 일치 제거(표기 달라도)", r.entries.length === 0 && r.filteredCount === 1, `남은=${r.entries.length} filtered=${r.filteredCount}`);
  }

  // include 우선 — 제외에 있어도 include면 살아남는다
  {
    const yakusoku = genEntry({ word: "約束", kana: "やくそく", wordTokens: [tok("約", "やく"), tok("束", "そく")] });
    const r = applyVocabPostprocess({ entries: [yakusoku], level: "N3", include: ["約束"], exclude: [{ word: "約束", kana: "やくそく" }] });
    const ok = r.entries.length === 1 && r.entries[0].word === "約束" && r.filteredCount === 0 && r.missingIncludes.length === 0;
    add("include 우선: 제외에 있어도 include면 살아남음", ok, `남은=[${r.entries.map((e) => e.word).join(",")}] missing=[${r.missingIncludes.join(",")}]`);
  }

  // 2) 포함 이행 보고 — 못 넣은 include는 오류가 아니라 missingIncludes로 보고
  {
    const r = applyVocabPostprocess({ entries: [hon], level: "N3", include: ["水"], exclude: [] });
    const ok = r.entries.length === 1 && r.missingIncludes.length === 1 && r.missingIncludes[0] === "水";
    add("포함 이행 보고: 빠진 include는 오류 아니라 보고", ok, `남은=${r.entries.length} missing=[${r.missingIncludes.join(",")}]`);
  }

  // 2) 포함 이행 — kana 일치도 이행으로 본다
  {
    const r = applyVocabPostprocess({ entries: [mizu], level: "N3", include: ["みず"], exclude: [] });
    add("포함 이행: kana 일치도 이행(missing 없음)", r.missingIncludes.length === 0, `missing=[${r.missingIncludes.join(",")}]`);
  }

  // 3) 중복 접기 — kana 기준, include 쪽을 남긴다
  {
    const hon2 = genEntry({ word: "夲", kana: "ほん", wordTokens: [tok("夲", "ほん")] }); // 같은 kana, 다른 표기
    const r = applyVocabPostprocess({ entries: [hon, hon2], level: "N3", include: ["夲"], exclude: [] });
    const ok = r.entries.length === 1 && r.entries[0].word === "夲" && r.filteredCount === 1;
    add("중복 접기: kana 기준·include 쪽 유지", ok, `남은=[${r.entries.map((e) => e.word).join(",")}] filtered=${r.filteredCount}`);
  }

  // 3) 중복 접기 — include 없으면 첫 등장 유지
  {
    const hon2 = genEntry({ word: "夲", kana: "ほん", wordTokens: [tok("夲", "ほん")] });
    const r = applyVocabPostprocess({ entries: [hon, hon2], level: "N3", include: [], exclude: [] });
    add("중복 접기: include 없으면 첫 등장 유지", r.entries.length === 1 && r.entries[0].word === "本", `남은=[${r.entries.map((e) => e.word).join(",")}]`);
  }

  // 4) 레벨 태깅 — 코드가 붙인다
  {
    const r = applyVocabPostprocess({ entries: [hon, mizu], level: "N2", include: [], exclude: [] });
    add("레벨 태깅: 모든 entry에 호출 레벨(N2)", r.entries.every((e) => e.level === "N2"), `levels=[${r.entries.map((e) => e.level).join(",")}]`);
  }

  // 5) 부분 성공 — 제외로 다 걸러져도 성공(빈 배열 + 보고)
  {
    const r = applyVocabPostprocess({ entries: [hon], level: "N3", include: [], exclude: [{ word: "本", kana: "ほん" }] });
    add("부분 성공: 다 걸러져도 성공(빈 배열·filtered 보고)", r.entries.length === 0 && r.filteredCount === 1, `남은=${r.entries.length} filtered=${r.filteredCount}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// include 배분 계획 (§2-0)
// ---------------------------------------------------------------------------

function runPlanChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "배분 계획(§2-0)";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  // N2+N3, include 3개 → N2(신규 7), N3(신규 10). 합계 20, include는 첫 레벨에만.
  {
    const plan = planIncludeDistribution(["N2", "N3"], ["約束", "水", "本"], 10);
    const n2New = plan[0].count - plan[0].include.length;
    const n3New = plan[1].count - plan[1].include.length;
    const ok =
      plan.length === 2 &&
      plan[0].level === "N2" && plan[0].count === 10 && plan[0].include.length === 3 && n2New === 7 &&
      plan[1].level === "N3" && plan[1].count === 10 && plan[1].include.length === 0 && n3New === 10;
    add("N2+N3·include 3 → 신규 7+10, include는 첫 레벨에만", ok, `N2(신규 ${n2New}), N3(신규 ${n3New})`);
  }

  // 단일 레벨·include 없음
  {
    const plan = planIncludeDistribution(["N5"], [], 10);
    add("단일 레벨·include 없음 → 1계획·신규 10", plan.length === 1 && plan[0].level === "N5" && plan[0].include.length === 0 && plan[0].count === 10, JSON.stringify(plan));
  }

  // include 정규화·중복 제거가 계획에 반영(전각/중복)
  {
    const plan = planIncludeDistribution(["N4"], ["約束", "約束", " 水 "], 10);
    const inc = plan[0].include;
    add("include 정규화·중복 제거(전각/중복 정리)", inc.length === 2 && inc[0] === "約束" && inc[1] === normalizeJaWord(" 水 "), `include=[${inc.join(",")}]`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// 사용자 메시지 빌더 (§2-2) — 템플릿 치환이 옳은지
// ---------------------------------------------------------------------------

function runUserMessageChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "사용자 메시지(§2-2)";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  {
    const msg = buildJaVocabUserMessage({ level: "N2", topic: "여행(호텔)", count: 10, include: ["約束", "水"], exclude: [{ word: "本", kana: "ほん" }] });
    const ok =
      msg.includes("레벨: N2") &&
      msg.includes("주제: 여행(호텔)") &&
      msg.includes("개수: 10") &&
      msg.includes("꼭 넣을 단어(표기 그대로, 읽기·뜻·예문은 네가 채운다): 約束, 水") &&
      msg.includes("이미 가지고 있는 단어(내지 말 것): 本(ほん)") &&
      !msg.includes("{"); // 플레이스홀더가 남지 않았다
    add("치환: 레벨·주제·개수·include·exclude 채움, 플레이스홀더 잔존 없음", ok, ok ? "정상" : JSON.stringify(msg));
  }

  {
    const msg = buildJaVocabUserMessage({ level: "N5", topic: null, count: 10, include: [], exclude: [] });
    const ok = msg.includes("주제: 없음(레벨 전반)") && msg.includes("꼭 넣을 단어(표기 그대로, 읽기·뜻·예문은 네가 채운다): 없음") && msg.includes("이미 가지고 있는 단어(내지 말 것): 없음");
    add("치환: 주제/​include/​exclude 없음 폴백", ok, ok ? "정상" : JSON.stringify(msg));
  }

  return results;
}

// ---------------------------------------------------------------------------
// 상수 정합 — 스펙과 코드 상수가 어긋나지 않는지(가벼운 자기점검)
// ---------------------------------------------------------------------------

function runConstantChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "상수 정합";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  add("JLPT_LEVELS = N1~N5", JLPT_LEVELS.join(",") === "N1,N2,N3,N4,N5", JLPT_LEVELS.join(","));
  add("JA_POS 10종(§2-3 enum)", JA_POS.length === 10, JA_POS.join("·"));
  add("주제 프리셋(§8-2): 여행(호텔)·음식점·취미·상점·가족", JA_VOCAB_TOPIC_PRESETS.join(",") === "여행(호텔),음식점,취미,상점,가족", JA_VOCAB_TOPIC_PRESETS.join(","));
  // JSON Schema enum과 JA_POS 상수가 같은지(4중 정의 어긋남 방지)
  const schemaEnum = ((((JA_VOCAB_GENERATION_JSON_SCHEMA.schema as Record<string, unknown>).properties as Record<string, unknown>).entries as Record<string, unknown>).items as Record<string, unknown>);
  const posEnum = (((schemaEnum.properties as Record<string, unknown>).pos as Record<string, unknown>).items as Record<string, unknown>).enum as string[];
  add("JSON Schema pos enum == JA_POS 상수", Array.isArray(posEnum) && posEnum.join(",") === JA_POS.join(","), `schema=[${posEnum?.join(",")}]`);

  return results;
}

// ---------------------------------------------------------------------------
// spec-sync — 프롬프트(문자열) 바이트 대조 + JSON Schema 의미 동치
// ---------------------------------------------------------------------------

const JAPANESE_SPEC_URL = new URL("../docs/harness/japanese.md", import.meta.url);

const SPEC_SYNC_TARGETS: readonly SpecSyncTarget[] = [
  {
    constName: "JA_VOCAB_SYSTEM_PROMPT",
    source: "lib/ai/japanese/prompts.ts",
    specLabel: "§2-1 호출 A 시스템 프롬프트",
    text: JA_VOCAB_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "JA_VOCAB_USER_TEMPLATE",
    source: "lib/ai/japanese/prompts.ts",
    specLabel: "§2-2 사용자 메시지 템플릿",
    text: JA_VOCAB_USER_TEMPLATE,
    mode: "block",
  },
];

const specSyncOutcomes: SpecSyncOutcome[] = [];

function runSpecSyncChecks(): CheckResult[] {
  specSyncOutcomes.length = 0;
  specSyncOutcomes.push(...checkSpecSync(JAPANESE_SPEC_URL, SPEC_SYNC_TARGETS));
  return specSyncOutcomes.map((o) => ({
    book: "프롬프트 ↔ 스펙",
    check: `${o.constName}이 japanese.md 원문 그대로`,
    pass: o.ok,
    detail: o.summary,
  }));
}

/** 순서 무관 깊은 동치 — JSON Schema 의미 비교용(키 순서·포맷 차이를 무시한다). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

/**
 * JSON Schema 의미 동치 대조 — 스펙 §2-3의 코드블록을 JSON으로 파싱해 코드 상수와 deep-equal.
 * 문자열 spec-sync는 포맷(들여쓰기·키 순서·인라인 공백) 차이에 취약하다. JSON 의미 비교가 더 강하고
 * "스펙 §2-3 == JSON Schema 상수"를 정확히 잠근다.
 */
function runJsonSchemaSyncChecks(): CheckResult[] {
  const book = "프롬프트 ↔ 스펙";
  try {
    const blocks = extractSpecBlocks(JAPANESE_SPEC_URL);
    let specSchema: unknown = null;
    for (const b of blocks) {
      try {
        const parsed = JSON.parse(b.text) as { name?: unknown };
        if (parsed && typeof parsed === "object" && parsed.name === "ja_vocab_generation") {
          specSchema = parsed;
          break;
        }
      } catch {
        // JSON 아닌 블록은 건너뛴다
      }
    }
    if (specSchema === null) {
      return [{ book, check: "JA JSON Schema ↔ §2-3 의미 동치", pass: false, detail: "스펙에서 ja_vocab_generation JSON 블록을 찾지 못함" }];
    }
    const ok = deepEqual(specSchema, JA_VOCAB_GENERATION_JSON_SCHEMA as unknown);
    return [{ book, check: "JA_VOCAB_GENERATION_JSON_SCHEMA ↔ §2-3 의미 동치", pass: ok, detail: ok ? "의미 일치" : "스펙 §2-3과 코드 상수가 다름" }];
  } catch (e) {
    return [{ book, check: "JA JSON Schema ↔ §2-3 의미 동치", pass: false, detail: `스펙 파싱 실패: ${e instanceof Error ? e.message : String(e)}` }];
  }
}

// ---------------------------------------------------------------------------
// 이모지 (§작업1) — zod 통과/거부 + resolveJaGlyph 우선순위
// ---------------------------------------------------------------------------

function runEmojiChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "이모지(호출 A)";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  const one = (imageEmoji: unknown) => jaVocabGenerationSchema.safeParse({ entries: [{ ...genEntry(), imageEmoji }] }).success;

  add("zod 통과: 이모지 1개(📖)", one("📖"), "통과");
  add("zod 통과: null(추상어·문법어)", one(null), "통과");
  add("zod 통과: 변형 선택자 포함 1자(❤️)", one("❤️"), "통과");
  add("zod 거부: 글자(本)", !one("本"), "거부");
  add("zod 거부: 로마자(A)", !one("A"), "거부");
  add("zod 거부: 이모지 2개(📖📚)", !one("📖📚"), "거부");
  add("zod 거부: 빈 문자열", !one(""), "거부");

  // resolveJaGlyph 우선순위: 이모지 > 첫 글자 배지
  {
    const g1 = resolveJaGlyph({ word: "本", imageEmoji: "📖" });
    const g2 = resolveJaGlyph({ word: "本", imageEmoji: null });
    const g3 = resolveJaGlyph({ word: "食べる" }); // imageEmoji 없음(구 레코드) → 첫 글자
    const ok = g1.kind === "emoji" && g1.emoji === "📖" && g2.kind === "letter" && g2.letter === "本" && g3.kind === "letter" && g3.letter === "食";
    add("resolveJaGlyph: 이모지 > 첫 글자 배지(null·undefined 폴백)", ok, `g1=${JSON.stringify(g1)} g2=${JSON.stringify(g2)} g3=${JSON.stringify(g3)}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// 시험 4모드 (§6-1) — buildJaQuizQuestions
// ---------------------------------------------------------------------------

/** 결정적 rng — 셔플 결과를 고정해 값으로 단언한다. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 시험 픽스처 — 명사 5개(같은 품사 충분) + 동사 1개 + 가나 단어 1개. genEntry가 JaQuizSourceEntry를 구조적으로 만족. */
function quizEntries(): JaQuizSourceEntry[] {
  return [
    genEntry({ word: "本", kana: "ほん", pos: ["명사"], meaningsKo: ["책"], example: { ja: "本を読む。", ko: "책을 읽는다.", tokens: [tok("本", "ほん"), tok("を"), tok("読", "よ"), tok("む"), tok("。")] } }),
    genEntry({ word: "水", kana: "みず", pos: ["명사"], meaningsKo: ["물"], example: { ja: "水を飲む。", ko: "물을 마신다.", tokens: [tok("水", "みず"), tok("を"), tok("飲", "の"), tok("む"), tok("。")] } }),
    genEntry({ word: "山", kana: "やま", pos: ["명사"], meaningsKo: ["산"], example: { ja: "山に登る。", ko: "산에 오른다.", tokens: [tok("山", "やま"), tok("に"), tok("登", "のぼ"), tok("る"), tok("。")] } }),
    genEntry({ word: "川", kana: "かわ", pos: ["명사"], meaningsKo: ["강"], example: { ja: "川が流れる。", ko: "강이 흐른다.", tokens: [tok("川", "かわ"), tok("が"), tok("流", "なが"), tok("れる"), tok("。")] } }),
    genEntry({ word: "空", kana: "そら", pos: ["명사"], meaningsKo: ["하늘"], example: { ja: "空を見る。", ko: "하늘을 본다.", tokens: [tok("空", "そら"), tok("を"), tok("見", "み"), tok("る"), tok("。")] } }),
    genEntry({ word: "見る", kana: "みる", pos: ["동사(타)"], meaningsKo: ["보다"], example: { ja: "映画を見る。", ko: "영화를 본다.", tokens: [tok("映画", "えいが"), tok("を"), tok("見", "み"), tok("る"), tok("。")] } }),
    genEntry({ word: "すし", kana: "すし", pos: ["명사"], meaningsKo: ["초밥"], example: { ja: "すしを食べる。", ko: "초밥을 먹는다.", tokens: [tok("すし"), tok("を"), tok("食", "た"), tok("べる"), tok("。")] } }),
  ];
}

function runQuizChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "시험 4모드(§6-1)";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });
  const entries = quizEntries();
  const posByWord = new Map(entries.map((e) => [e.word, e.pos] as const));

  // 전 모드: 정답 포함 · 보기 전부 상이 · 개수 5(단어장 충분)
  {
    const { questions } = buildJaQuizQuestions(entries, { count: 5, rng: makeRng(7) });
    const ok = questions.every((q) => q.choices.includes(q.answer) && new Set(q.choices).size === q.choices.length && q.choices.length === 5);
    add("전 모드: 정답 포함·보기 전부 상이·5개", ok, `문항=${questions.length}`);
  }

  // kanji-to-kana: 가나 단어(すし·word===kana)·동사 아닌 가나… 한자 없는 단어는 안 나온다
  {
    const { questions } = buildJaQuizQuestions(entries, { modes: ["kanji-to-kana"], count: 5, rng: makeRng(11) });
    const words = questions.map((q) => q.word);
    // 本·水·山·川·空·見る = 6개(한자 포함), すし 제외
    const ok = questions.every((q) => q.mode === "kanji-to-kana") && !words.includes("すし") && questions.length === 6 && questions.every((q) => q.answer !== q.prompt);
    add("kanji-to-kana: 가나 단어(すし) 제외·정답=읽기", ok, `출제=[${words.join(",")}] (기대 6개, すし 없음)`);
  }

  // ko-to-word: 문제=뜻, 정답=표기
  {
    const { questions } = buildJaQuizQuestions(entries, { modes: ["ko-to-word"], count: 5, rng: makeRng(3) });
    const q = questions.find((x) => x.word === "本");
    add("ko-to-word: 문제=뜻·정답=표기", q?.prompt === "책" && q?.answer === "本" && (q?.choices.includes("本") ?? false), `q=${JSON.stringify(q)}`);
  }

  // word-to-ko: 문제=표기+읽기, 정답=뜻
  {
    const { questions } = buildJaQuizQuestions(entries, { modes: ["word-to-ko"], count: 5, rng: makeRng(5) });
    const q = questions.find((x) => x.word === "本");
    add("word-to-ko: 문제=표기(읽기)·정답=뜻", q?.prompt === "本(ほん)" && q?.answer === "책", `q=${JSON.stringify(q)}`);
  }

  // cloze: 표제어를 ___로 1회 치환, 표제어 미포함 예문은 미출제
  {
    const { questions } = buildJaQuizQuestions(entries, { modes: ["cloze"], count: 5, rng: makeRng(9) });
    const q = questions.find((x) => x.word === "本");
    const clozeOk = q?.prompt === "___を読む。" && !q.prompt.includes("本") && q.answer === "本";
    add("cloze: 표기 기준 ___ 1회 치환·정답=표기", !!clozeOk, `prompt=${q?.prompt}`);

    // 같은 품사 오답 우선 — 명사 cloze의 오답은 전부 명사(명사 4개로 충분)
    const distractors = (q?.choices ?? []).filter((c) => c !== "本");
    const allNoun = distractors.length > 0 && distractors.every((w) => posByWord.get(w)?.includes("명사"));
    add("cloze: 같은 품사(명사) 오답 우선", allNoun, `오답=[${distractors.join(",")}]`);
  }

  // 미출제 보고 — kanji-to-kana만 요청하면 가나 단어 すし 1개가 skip
  {
    const { skipped } = buildJaQuizQuestions([genEntry({ word: "すし", kana: "すし", example: { ja: "すしを食べる。", ko: "초밥.", tokens: [tok("すし"), tok("を"), tok("食", "た"), tok("べる"), tok("。")] } })], { modes: ["kanji-to-kana"], count: 5, rng: makeRng(1) });
    add("미출제 보고: 가나 단어의 kanji-to-kana는 skip 카운트", skipped === 1, `skipped=${skipped}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// 모드별 숙련도 분리 회귀 가드 (§6-2) — 반례로 잠근다
// 값으로 못박는다: aggregateJaStatsByMode가 모드별로 안 가르면(합치면) 아래 값이 어긋나 FAIL.
// ---------------------------------------------------------------------------

function runQuizModeSeparationChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "모드 분리(§6-2)";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  const session = (mode: JaQuizSessionLike["mode"], startedAt: string, items: JaQuizSessionLike["items"]): JaQuizSessionLike => ({
    id: startedAt, bookId: "b1", mode, startedAt, finishedAt: startedAt, items,
  });

  // 本: kanji-to-kana에서 틀림(독음 모름), ko-to-word에서 맞음(뜻 앎) — 두 통계가 섞이면 안 된다
  const quizzes = [
    session("ko-to-word", "2026-09-18T01:00:00.000Z", [{ word: "本", correct: true, answered: true }]),
    session("kanji-to-kana", "2026-09-18T02:00:00.000Z", [{ word: "本", correct: false, answered: true }]),
  ];

  {
    const byMode = aggregateJaStatsByMode(quizzes);
    const ko = byMode["ko-to-word"]?.["本"];
    const kk = byMode["kanji-to-kana"]?.["本"];
    // 무오염: ko-to-word는 total1·wrong0·streak1(뜻 앎), kanji-to-kana는 total1·wrong1·streak0(독음 모름)
    const ok = ko?.total === 1 && ko?.wrong === 0 && ko?.streak === 1 && kk?.total === 1 && kk?.wrong === 1 && kk?.streak === 0;
    add("aggregateJaStatsByMode: 뜻(정답)·독음(오답)이 안 섞임", ok, `ko=${JSON.stringify(ko)} kk=${JSON.stringify(kk)}`);
  }

  {
    // 복습도 모드별: kanji-to-kana 복습엔 本이 오답 후보로, ko-to-word 복습엔 오답 아님
    const kkReview = buildJaReviewCandidatesByMode(quizzes, "kanji-to-kana").find((c) => c.word === "本");
    const koReview = buildJaReviewCandidatesByMode(quizzes, "ko-to-word").find((c) => c.word === "本");
    const ok = kkReview?.wrong === 1 && koReview?.wrong === 0;
    add("buildJaReviewCandidatesByMode: 모드별 오답이 안 섞임", ok, `kk=${JSON.stringify(kkReview)} ko=${JSON.stringify(koReview)}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const all: CheckResult[] = [];
  all.push(...runConstantChecks());
  all.push(...runZodChecks());
  all.push(...runOkuriganaChecks());
  all.push(...runEmojiChecks());
  all.push(...runPostprocessChecks());
  all.push(...runPlanChecks());
  all.push(...runUserMessageChecks());
  all.push(...runQuizChecks());
  all.push(...runQuizModeSeparationChecks());
  all.push(...runSpecSyncChecks());
  all.push(...runJsonSchemaSyncChecks());

  printTable(all);
  printSpecSyncDetails(specSyncOutcomes);

  const failed = all.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`FAIL — 오프라인 ${failed.length}개 항목 실패.`);
    process.exit(1);
  }

  if (process.env.EVAL_JAPANESE === "1") {
    // 실호출 점검 자리 — J1에서는 구현·실행하지 않는다(§9). 비용 검증은 오케스트레이터가 동의 후 돌린다.
    console.log(
      "EVAL_JAPANESE=1 — 실호출 점검은 J1에서 자리만 만들어 두었습니다(호출 A 레벨 준수·제외 위반 여부 등). 오케스트레이터가 동의 후 구현·실행합니다. 실호출은 하지 않았습니다.",
    );
  }

  console.log(`PASS — 오프라인 ${all.length}개 항목 통과 (실호출 미실행).`);
}

void main();
