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
  JA_DIALOG_COACHING_JSON_SCHEMA,
  JA_DIALOG_EXTRACTION_JSON_SCHEMA,
  JA_KANJI_INFO_JSON_SCHEMA,
  JA_VOCAB_GENERATION_JSON_SCHEMA,
  JA_VOCAB_TOPIC_PRESETS,
  JLPT_LEVELS,
  jaDialogCoachingSchema,
  jaDialogExtractionSchema,
  jaKanjiInfoGenerationSchema,
  jaVocabGenerationSchema,
  resolveJaGlyph,
  type JaDialogExtraction,
  type JaKanjiInfo,
  type JaToken,
  type JaVocabGenEntry,
} from "../lib/ai/japanese/schemas";
import {
  JA_DIALOG_COACH_SYSTEM_PROMPT,
  JA_DIALOG_EXTRACT_SYSTEM_PROMPT,
  JA_DIALOG_EXTRACT_USER_TEXT,
  JA_KANJI_SYSTEM_PROMPT,
  JA_VOCAB_SYSTEM_PROMPT,
  JA_VOCAB_USER_TEMPLATE,
  buildJaVocabUserMessage,
} from "../lib/ai/japanese/prompts";
import { mergeJaDialogBatches, planJaDialogBatches } from "../lib/ai/japanese/dialog";
import {
  applyKanjiPostprocess,
  collectKanjiFromBooks,
  selectKanjiToEnrich,
} from "../lib/ai/japanese/kanji";
import {
  applyVocabPostprocess,
  normalizeJaWord,
  planIncludeDistribution,
} from "../lib/ai/japanese/vocab";
import {
  aggregateJaStatsByMode,
  buildJaKanjiQuizQuestions,
  buildJaQuizQuestions,
  buildJaReviewCandidatesByMode,
  type JaKanjiQuizSource,
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
  {
    constName: "JA_KANJI_SYSTEM_PROMPT",
    source: "lib/ai/japanese/prompts.ts",
    specLabel: "§12-2-1 호출 D 시스템 프롬프트",
    text: JA_KANJI_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "JA_DIALOG_EXTRACT_SYSTEM_PROMPT",
    source: "lib/ai/japanese/prompts.ts",
    specLabel: "§3-1 호출 B 시스템 프롬프트",
    text: JA_DIALOG_EXTRACT_SYSTEM_PROMPT,
    mode: "block",
  },
  {
    constName: "JA_DIALOG_EXTRACT_USER_TEXT",
    source: "lib/ai/japanese/prompts.ts",
    specLabel: "§3-2 사용자 메시지",
    text: JA_DIALOG_EXTRACT_USER_TEXT,
    mode: "block",
  },
  {
    constName: "JA_DIALOG_COACH_SYSTEM_PROMPT",
    source: "lib/ai/japanese/prompts.ts",
    specLabel: "§4-1 호출 C 시스템 프롬프트",
    text: JA_DIALOG_COACH_SYSTEM_PROMPT,
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
 * JSON Schema 의미 동치 대조 — 스펙의 코드블록을 JSON으로 파싱해 코드 상수와 deep-equal.
 * 문자열 spec-sync는 포맷(들여쓰기·키 순서·인라인 공백) 차이에 취약하다. JSON 의미 비교가 더 강하고
 * "스펙 == JSON Schema 상수"를 정확히 잠근다. 이름으로 찾아 각 스키마를 대조한다.
 */
/** 스펙 §3-3·§4-3은 tokens $defs를 "…§2-3과 동일" 플레이스홀더로 줄여 적는다. 대조 전 상수의 $defs.tokens도
 *  같은 플레이스홀더로 바꿔 구조만 비교한다(tokens 자체는 §2-3 deep-equal이 잠근다). */
function withTokensPlaceholder(schemaConst: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(schemaConst)) as { schema?: { $defs?: Record<string, unknown> } };
  if (clone.schema?.$defs && "tokens" in clone.schema.$defs) {
    clone.schema.$defs.tokens = { "…": "§2-3과 동일" };
  }
  return clone;
}

function runJsonSchemaSyncChecks(): CheckResult[] {
  const book = "프롬프트 ↔ 스펙";
  const targets: { name: string; constName: string; value: unknown; label: string }[] = [
    { name: "ja_vocab_generation", constName: "JA_VOCAB_GENERATION_JSON_SCHEMA", value: JA_VOCAB_GENERATION_JSON_SCHEMA, label: "§2-3" },
    { name: "ja_kanji_info", constName: "JA_KANJI_INFO_JSON_SCHEMA", value: JA_KANJI_INFO_JSON_SCHEMA, label: "§12-2-2" },
    { name: "ja_dialog_extraction", constName: "JA_DIALOG_EXTRACTION_JSON_SCHEMA", value: withTokensPlaceholder(JA_DIALOG_EXTRACTION_JSON_SCHEMA), label: "§3-3" },
    { name: "ja_dialog_coaching", constName: "JA_DIALOG_COACHING_JSON_SCHEMA", value: withTokensPlaceholder(JA_DIALOG_COACHING_JSON_SCHEMA), label: "§4-3" },
  ];
  let blocks: ReturnType<typeof extractSpecBlocks>;
  try {
    blocks = extractSpecBlocks(JAPANESE_SPEC_URL);
  } catch (e) {
    return targets.map((t) => ({ book, check: `${t.constName} ↔ ${t.label} 의미 동치`, pass: false, detail: `스펙 파싱 실패: ${e instanceof Error ? e.message : String(e)}` }));
  }
  const parsedByName = new Map<string, unknown>();
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b.text) as { name?: unknown };
      if (parsed && typeof parsed === "object" && typeof parsed.name === "string") parsedByName.set(parsed.name, parsed);
    } catch {
      // JSON 아닌 블록은 건너뛴다
    }
  }
  return targets.map((t) => {
    const specSchema = parsedByName.get(t.name);
    if (specSchema === undefined) {
      return { book, check: `${t.constName} ↔ ${t.label} 의미 동치`, pass: false, detail: `스펙에서 ${t.name} JSON 블록을 찾지 못함` };
    }
    const ok = deepEqual(specSchema, t.value);
    return { book, check: `${t.constName} ↔ ${t.label} 의미 동치`, pass: ok, detail: ok ? "의미 일치" : `스펙 ${t.label}과 코드 상수가 다름` };
  });
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
// 한자 (JK, §12) — 수집·선별·후처리·zod·2모드·모드 무오염
// ---------------------------------------------------------------------------

function runKanjiChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "한자(§12)";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  // 수집: 한자만·중복 제거·역인덱스(등장 순서)
  {
    const collected = collectKanjiFromBooks([
      { entries: [{ word: "本" }, { word: "日本" }, { word: "水" }, { word: "すし" }, { word: "見る" }] },
    ]);
    const kanjiList = collected.map((c) => c.kanji).join(",");
    const hon = collected.find((c) => c.kanji === "本");
    const ok = kanjiList === "本,日,水,見" && hon?.words.join(",") === "本,日本" && !collected.some((c) => c.kanji === "す");
    add("collectKanjiFromBooks: 한자만·중복제거·역인덱스", ok, `한자=[${kanjiList}] 本→[${hon?.words.join(",")}]`);
  }

  // 선별: 이미 정보 있는 한자(水)는 요청에서 제외(불변)
  {
    const collected = collectKanjiFromBooks([{ entries: [{ word: "本" }, { word: "水" }, { word: "見る" }] }]);
    const req = selectKanjiToEnrich(collected, ["水"]);
    const ok = req.map((r) => r.kanji).join(",") === "本,見" && req[0].sampleWords.includes("本");
    add("selectKanjiToEnrich: 정보 있는 한자 제외(불변)·예시 단어 부착", ok, `요청=[${req.map((r) => r.kanji).join(",")}]`);
  }

  // 후처리: 요청 밖 버리기·중복 접기·빠진 한자 보고(부분 성공)
  {
    const info = (kanji: string): JaKanjiInfo => ({ kanji, koReading: null, onyomi: [], kunyomi: [], meaningKo: "뜻" });
    const r = applyKanjiPostprocess([info("本"), info("火"), info("本")], ["本", "日"]);
    const ok = r.items.length === 1 && r.items[0].kanji === "本" && r.droppedCount === 2 && r.missingKanji.join(",") === "日";
    add("applyKanjiPostprocess: 요청 밖 버림·중복 접음·빠진 한자 보고", ok, `남음=${r.items.length} dropped=${r.droppedCount} missing=[${r.missingKanji.join(",")}]`);
  }

  // zod: 정상 통과 + koReading null + kunyomi 빈배열
  {
    const okCase = jaKanjiInfoGenerationSchema.safeParse({ items: [
      { kanji: "本", koReading: "본", onyomi: ["ほん"], kunyomi: ["もと"], meaningKo: "책, 근본" },
      { kanji: "畑", koReading: null, onyomi: [], kunyomi: ["はたけ"], meaningKo: "밭" },
    ] });
    add("zod 통과: 정상·koReading null(국자)·kunyomi", okCase.success, okCase.success ? "통과" : JSON.stringify(okCase.error?.issues?.slice(0, 3)));
  }
  const kbad: { name: string; item: unknown }[] = [
    { name: "kanji 2글자", item: { kanji: "日本", koReading: "일", onyomi: ["にほん"], kunyomi: [], meaningKo: "일본" } },
    { name: "kanji 가나", item: { kanji: "ほ", koReading: "본", onyomi: ["ほん"], kunyomi: [], meaningKo: "책" } },
    { name: "koReading 2글자", item: { kanji: "本", koReading: "본본", onyomi: ["ほん"], kunyomi: [], meaningKo: "책" } },
    { name: "koReading 한글 아님", item: { kanji: "本", koReading: "ホ", onyomi: ["ほん"], kunyomi: [], meaningKo: "책" } },
    { name: "onyomi 가타카나", item: { kanji: "本", koReading: "본", onyomi: ["ホン"], kunyomi: [], meaningKo: "책" } },
    { name: "onyomi 4개(>3)", item: { kanji: "生", koReading: "생", onyomi: ["せい", "しょう", "じょう", "ぜい"], kunyomi: [], meaningKo: "날 생" } },
    { name: "meaningKo 한글 없음", item: { kanji: "本", koReading: "본", onyomi: ["ほん"], kunyomi: [], meaningKo: "book" } },
    { name: "meaningKo 21자(>20)", item: { kanji: "本", koReading: "본", onyomi: ["ほん"], kunyomi: [], meaningKo: "가".repeat(21) } },
  ];
  for (const b of kbad) {
    const rejected = !jaKanjiInfoGenerationSchema.safeParse({ items: [b.item] }).success;
    add(`zod 거부: ${b.name}`, rejected, rejected ? "거부됨" : "통과되면 안 됨");
  }

  // 시험 2모드: 정답 포함·전부 상이·음독 없는 한자는 kanji-to-on 제외
  {
    const items: JaKanjiQuizSource[] = [
      { kanji: "本", onyomi: ["ほん"], meaningKo: "책" },
      { kanji: "水", onyomi: ["すい"], meaningKo: "물" },
      { kanji: "火", onyomi: ["か"], meaningKo: "불" },
      { kanji: "木", onyomi: ["もく"], meaningKo: "나무" },
      { kanji: "金", onyomi: ["きん"], meaningKo: "금" },
      { kanji: "畑", onyomi: [], meaningKo: "밭" }, // 음독 없음 → kanji-to-on 제외
    ];
    const on = buildJaKanjiQuizQuestions(items, { modes: ["kanji-to-on"], count: 5, rng: makeRng(2) });
    const onOk = on.questions.every((q) => q.choices.includes(q.answer) && new Set(q.choices).size === q.choices.length) && !on.questions.some((q) => q.word === "畑") && on.questions.length === 5 && on.skipped === 1;
    add("kanji-to-on: 정답 포함·상이·음독 없는 한자(畑) 제외", onOk, `출제=${on.questions.length}(기대 5) skip=${on.skipped}`);

    const me = buildJaKanjiQuizQuestions(items, { modes: ["kanji-to-meaning"], count: 5, rng: makeRng(4) });
    const q = me.questions.find((x) => x.word === "本");
    add("kanji-to-meaning: 문제=한자·정답=뜻", q?.prompt === "本" && q?.answer === "책" && (q?.choices.includes("책") ?? false), `q=${JSON.stringify(q)}`);
  }

  // 모드 무오염: 한자 모드(kanji-to-on)가 단어 모드(ko-to-word) 통계에 안 섞임(같은 표기 "本")
  {
    const session = (mode: JaQuizSessionLike["mode"], startedAt: string, items: JaQuizSessionLike["items"]): JaQuizSessionLike => ({ id: startedAt, bookId: "b1", mode, startedAt, finishedAt: startedAt, items });
    const quizzes = [
      session("ko-to-word", "2026-09-18T01:00:00.000Z", [{ word: "本", correct: true, answered: true }]),
      session("kanji-to-on", "2026-09-18T02:00:00.000Z", [{ word: "本", correct: false, answered: true }]),
    ];
    const byMode = aggregateJaStatsByMode(quizzes);
    const ko = byMode["ko-to-word"]?.["本"];
    const on = byMode["kanji-to-on"]?.["本"];
    const ok = ko?.wrong === 0 && ko?.total === 1 && on?.wrong === 1 && on?.total === 1;
    add("모드 무오염: 한자 모드가 단어 모드 통계에 안 섞임", ok, `ko=${JSON.stringify(ko)} on=${JSON.stringify(on)}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// 대화 전사(호출 B, §3) / 학습 해설(호출 C, §4) — 병합·배치 계획·zod
// ---------------------------------------------------------------------------

// 발화 픽스처 — 私は学生です。(私·学生에 후리가나, 토큰 무결성 통과)
function dTurn(speaker: "partner" | "me" | "unknown", ja: string, tokens: JaToken[], feedback: JaDialogExtraction["turns"][number]["feedback"] = null) {
  return { speaker, ja, tokens, feedback };
}
const WATASHI = () => [tok("私", "わたし"), tok("は"), tok("学生", "がくせい"), tok("です"), tok("。")];

function runDialogChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "대화(§3·§4)";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  // 병합: 경계 겹침(연속 ja 완전 일치) 접기·순서 보존·partial OR·focusKo 첫 non-null·allUnknown
  {
    const batches: JaDialogExtraction[] = [
      { focusKo: "자기소개", turns: [dTurn("partner", "こんにちは。", [tok("こんにちは。")]), dTurn("me", "私は学生です。", WATASHI())], partial: false },
      { focusKo: null, turns: [dTurn("me", "私は学生です。", WATASHI(), { kind: "praise", textKo: "좋아요" }), dTurn("partner", "よろしく。", [tok("よろしく。")])], partial: true },
    ];
    const m = mergeJaDialogBatches(batches);
    const order = m.turns.map((t) => t.ja).join(" | ");
    const folded = m.turns.find((t) => t.ja === "私は学生です。");
    const ok = m.turns.length === 3 && m.mergedCount === 1 && m.focusKo === "자기소개" && m.partial === true && !m.allUnknown && folded?.feedback?.kind === "praise";
    add("병합: 경계 겹침 접기·순서·partial OR·focusKo·접힌 쪽 피드백 살림", ok, `순서=[${order}] merged=${m.mergedCount} focus=${m.focusKo} partial=${m.partial}`);
  }
  {
    const m = mergeJaDialogBatches([{ focusKo: null, turns: [dTurn("unknown", "あ。", [tok("あ。")]), dTurn("unknown", "え。", [tok("え。")])], partial: false }]);
    add("병합: 전부 unknown 화자면 allUnknown 경고", m.allUnknown === true, `allUnknown=${m.allUnknown}`);
  }
  {
    // 유사도 추정 금지 — ja가 다르면(한 글자만 달라도) 접지 않는다
    const m = mergeJaDialogBatches([{ focusKo: null, turns: [dTurn("me", "はい。", [tok("はい。")]), dTurn("me", "はい!", [tok("はい!")])], partial: false }]);
    add("병합: 완전 일치만 접음(다르면 안 접음)", m.turns.length === 2 && m.mergedCount === 0, `turns=${m.turns.length} merged=${m.mergedCount}`);
  }

  // 배치 계획
  {
    const p1 = planJaDialogBatches(6, 4);
    const p2 = planJaDialogBatches(3, 4);
    const ok = JSON.stringify(p1) === "[[0,1,2,3],[4,5]]" && JSON.stringify(p2) === "[[0,1,2]]";
    add("planJaDialogBatches: batchSize 단위로 인덱스 묶음", ok, `6→${JSON.stringify(p1)} 3→${JSON.stringify(p2)}`);
  }

  // zod B: 정상 통과 + 거부
  {
    const good = jaDialogExtractionSchema.safeParse({ focusKo: "요점", turns: [dTurn("me", "私は学生です。", WATASHI())], partial: false });
    add("zod B: 정상 통과", good.success, good.success ? "통과" : JSON.stringify(good.error?.issues?.slice(0, 2)));
  }
  const bReject: { name: string; input: unknown }[] = [
    { name: "turns 0개", input: { focusKo: null, turns: [], partial: false } },
    { name: "토큰 무결성 위반", input: { focusKo: null, turns: [dTurn("me", "私は学生です。", [tok("私", "わたし")])], partial: false } },
    { name: "speaker enum 밖", input: { focusKo: null, turns: [{ speaker: "teacher", ja: "はい。", tokens: [tok("はい。")], feedback: null }], partial: false } },
    { name: "feedback kind 밖", input: { focusKo: null, turns: [dTurn("me", "はい。", [tok("はい。")], { kind: "warn", textKo: "x" } as unknown as null)], partial: false } },
  ];
  for (const rc of bReject) add(`zod B 거부: ${rc.name}`, !jaDialogExtractionSchema.safeParse(rc.input).success, "거부");

  // zod C: 정상 통과 + 거부
  const item = (word: string, kana: string, wt: JaToken[]) => ({ word, kana, meaningKo: "뜻", usageKo: "대화에서 이렇게 씀", example: { ja: "私は学生です。", ko: "나는 학생입니다.", tokens: WATASHI() }, wordTokens: wt });
  const practice = () => ({ ja: "よろしくお願いします。", ko: "잘 부탁합니다.", tokens: [tok("よろしくお"), tok("願", "ねが"), tok("いします"), tok("。")] });
  const goodCoaching = {
    summaryKo: "전반적으로 좋았어요. 조사 사용이 자연스러웠습니다.",
    goods: [{ quoteJa: "私は学生です。", whyKo: "は를 올바르게 썼어요." }],
    fixes: [{ originalJa: "私は学生です。", betterJa: "私は学生でした。", whyKo: "과거는 でした。", grammarKo: "과거형" }],
    items: [item("学生", "がくせい", [tok("学生", "がくせい")]), item("先生", "せんせい", [tok("先生", "せんせい")])],
    practice: [practice()],
  };
  {
    const good = jaDialogCoachingSchema.safeParse(goodCoaching);
    add("zod C: 정상 통과(총평·goods·fixes·items 2개·practice)", good.success, good.success ? "통과" : JSON.stringify(good.error?.issues?.slice(0, 3)));
  }
  const cReject: { name: string; mutate: (c: typeof goodCoaching) => unknown }[] = [
    { name: "items 1개(<2)", mutate: (c) => ({ ...c, items: [c.items[0]] }) },
    { name: "practice 0개", mutate: (c) => ({ ...c, practice: [] }) },
    { name: "goods 7개(>6)", mutate: (c) => ({ ...c, goods: Array.from({ length: 7 }, () => c.goods[0]) }) },
    { name: "summaryKo 한글 없음", mutate: (c) => ({ ...c, summaryKo: "good job" }) },
    { name: "item.kana 가타카나", mutate: (c) => ({ ...c, items: [item("学生", "ガクセイ", [tok("学生", "がくせい")]), c.items[1]] }) },
    { name: "fix.originalJa 일본문자 없음", mutate: (c) => ({ ...c, fixes: [{ ...c.fixes[0], originalJa: "hello" }] }) },
    { name: "item.wordTokens 무결성 위반", mutate: (c) => ({ ...c, items: [item("学生", "がくせい", [tok("生", "せい")]), c.items[1]] }) },
  ];
  for (const rc of cReject) add(`zod C 거부: ${rc.name}`, !jaDialogCoachingSchema.safeParse(rc.mutate(goodCoaching)).success, "거부");

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
  all.push(...runKanjiChecks());
  all.push(...runDialogChecks());
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
