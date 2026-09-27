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
  JA_INCLUDE_WORD_MAX,
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
  makeJaVocabGenerationSchema,
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
  isSameJaWord,
  normalizeJaVocabEntry,
  normalizeJaWord,
  planIncludeDistribution,
} from "../lib/ai/japanese/vocab";
import {
  JA_INCLUDE_WORD_MAX as JA_INCLUDE_WORD_MAX_CLIENT,
  classifyJaIncludeLine,
  jaIncludeRejectReason,
  normalizeKoInclude,
} from "../lib/japanese-include";
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

/** 유효한 호출 A entry(레벨 없음). 필요한 필드만 덮어쓴다. 기본값은 zod를 통과한다.
 *  definitionTokens는 over가 명시하지 않으면 최종 definitionJa에서 자동 파생한다(정의를 override해도 무결성이 유지되게).
 *  자동 파생은 정의 전체를 reading:null 토큰 1개로 담는다(무결성 통과 — 정의 한자에 읽기가 없는 것도 스키마상 유효). */
function genEntry(over: Partial<JaVocabGenEntry> = {}): JaVocabGenEntry {
  const base: JaVocabGenEntry = {
    fromKo: null,
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
    definitionJa: "ページがたくさんあって、よむもの。",
    definitionTokens: null,
    ...over,
  };
  if (over.definitionTokens === undefined) {
    base.definitionTokens = base.definitionJa === null ? null : [tok(base.definitionJa)];
  }
  return base;
}

/** 후처리 픽스처 — 표기·읽기만 다른 entry(후처리는 zod를 다시 돌리지 않으므로 토큰은 표기 한 덩어리로 둔다). */
function jw(word: string, kana: string, over: Partial<JaVocabGenEntry> = {}): JaVocabGenEntry {
  return genEntry({ word, kana, wordTokens: [tok(word)], ...over });
}
/** 남은 표기 목록 "a,b" — 후처리 결과 비교용 */
const words = (xs: readonly { word: string }[]) => xs.map((e) => e.word).join(",");

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

  // 일일정의(definitionJa) — null 허용·일본문자·표제어 미포함·길이(§작업1). definitionTokens는 값에 맞춰 일관 파생.
  const oneDef = (definitionJa: unknown) => {
    const definitionTokens = typeof definitionJa === "string" ? [tok(definitionJa)] : null;
    return jaVocabGenerationSchema.safeParse({ entries: [{ ...genEntry(), definitionJa, definitionTokens }] }).success;
  };
  add("definitionJa 통과: null(쉽게 못 풀면)", oneDef(null), "통과");
  add("definitionJa 통과: 일본어 정의(표제어 미포함)", oneDef("ページがたくさんあって、よむもの。"), "통과");
  // P0 회귀 가드 — 짧은 정의가 더 좋은 출력이다. 15자 하한을 강제하면 N5 생성이 throw됐다(min 4로 낮춤).
  add("definitionJa 통과: 짧은 정의(7자, 出口→外に出るところ 급)", oneDef("よむための かみ。"), "통과");
  add("definitionJa 통과: 아주 짧은 정의(4자, 水→のむもの 급)", oneDef("のむもの"), "통과");
  add("definitionJa 거부: 표제어(本) 포함(정답 노출)", !oneDef("本はよむものです。とてもたのしい。"), "거부");
  add("definitionJa 거부: 3자 이하(너무 짧음)", !oneDef("みず"), "거부");
  add("definitionJa 거부: 일본 문자 없음", !oneDef("a thing for reading many pages."), "거부");

  // definitionTokens — 후리가나 토큰(§작업: 정의에도 루비). 무결성·오쿠리가나 분리·null 일관성
  const defEntry = (over: Partial<JaVocabGenEntry>) => jaVocabGenerationSchema.safeParse({ entries: [genEntry(over)] }).success;
  add("definitionTokens 통과: 한자에 읽기(外に出るところ, 出口)", defEntry({
    word: "出口", kana: "でぐち", wordTokens: [tok("出", "で"), tok("口", "ぐち")],
    definitionJa: "外に出るところ",
    definitionTokens: [tok("外", "そと"), tok("に"), tok("出", "で"), tok("る"), tok("と"), tok("こ"), tok("ろ")],
  }), "통과");
  add("definitionTokens 거부: 무결성 위반(이으면 definitionJa와 다름)", !defEntry({
    definitionJa: "そとに出るところ", definitionTokens: [tok("水", "みず")],
  }), "거부");
  add("definitionTokens 거부: 오쿠리가나 묶음(出る에 reading)", !defEntry({
    definitionJa: "そとに出る。", definitionTokens: [tok("そとに"), tok("出る", "でる"), tok("。")],
  }), "거부");
  add("definitionTokens 거부: definitionJa null인데 토큰 있음(고아)", !defEntry({
    definitionJa: null, definitionTokens: [tok("あ")],
  }), "거부");
  add("definitionTokens 거부: definitionJa 있는데 토큰 null", !defEntry({
    definitionJa: "のむもの", definitionTokens: null,
  }), "거부");

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

  // 통과 2 — 숙어 묶기(目標→目標(もくひょう) 한 토큰). 한자 덩어리는 묶는다(§5 규칙, zod가 허용).
  {
    const ok = jaVocabGenerationSchema.safeParse({
      entries: [
        genEntry({
          word: "目標", kana: "もくひょう", pos: ["명사"], meaningsKo: ["목표"],
          wordTokens: [tok("目標", "もくひょう")], // 目·標로 쪼개지 않고 한 덩어리
          example: { ja: "目標を立てる。", ko: "목표를 세운다.", tokens: [tok("目標", "もくひょう"), tok("を"), tok("立", "た"), tok("てる"), tok("。")] },
          definitionJa: "やりたいこと。", definitionTokens: [tok("やりたいこと。")],
        }),
        // 気持ち — 숙어(気持)는 묶고 오쿠리가나(ち)는 분리. 두 규칙이 한 단어에서 함께.
        genEntry({
          word: "気持ち", kana: "きもち", pos: ["명사"], meaningsKo: ["기분"],
          wordTokens: [tok("気持", "きも"), tok("ち")],
          example: { ja: "気持ちがいい。", ko: "기분이 좋다.", tokens: [tok("気持", "きも"), tok("ち"), tok("がいい"), tok("。")] },
          definitionJa: "こころのようす。", definitionTokens: [tok("こころのようす。")],
        }),
      ],
    }).success;
    add("통과: 숙어 묶기(目標(もくひょう) 한 토큰) + 気持(きも)+ち 분리 공존", ok, "통과");
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

  // 1) 제외 재적용 — 같은 단어 판정(isSameJaWord, 2026-09-27 정정): 표기가 같거나, 읽기가 같고 한쪽이 가나 표기.
  //    표기 흔들림(本/ほん, 林檎/りんご, りんご/リンゴ)은 여전히 거르고, 동음이의어(箸/橋)는 이제 통과한다.
  {
    const r = applyVocabPostprocess({ entries: [hon], level: "N3", include: [], exclude: [{ word: "ほん", kana: "ほん" }] });
    add("제외 재적용: 표기 흔들림(가진 ほん ↔ 새 本) 제거", r.entries.length === 0 && r.filteredCount === 1, `남은=${r.entries.length} filtered=${r.filteredCount}`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("りんご", "りんご")], level: "N5", include: [], exclude: [{ word: "林檎", kana: "りんご" }] });
    add("제외 재적용: 표기 흔들림(가진 林檎 ↔ 새 りんご) 제거", r.entries.length === 0 && r.filteredCount === 1, `남은=[${words(r.entries)}]`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("リンゴ", "りんご")], level: "N5", include: [], exclude: [{ word: "りんご", kana: "りんご" }] });
    add("제외 재적용: 가나 표기 흔들림(가진 りんご ↔ 새 リンゴ) 제거", r.entries.length === 0 && r.filteredCount === 1, `남은=[${words(r.entries)}]`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("橋", "はし"), hon], level: "N4", include: [], exclude: [{ word: "箸", kana: "はし" }] });
    const ok = words(r.entries) === "橋,本" && r.filteredCount === 0;
    add("제외 재적용(정정): 동음이의어(가진 箸 ↔ 새 橋)는 거르지 않음", ok, `남은=[${words(r.entries)}] filtered=${r.filteredCount}`);
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

  // 3) 중복 접기 — 같은 단어(표기 흔들림)끼리, include 쪽을 남긴다
  {
    const honKana = jw("ほん", "ほん"); // 같은 kana, 가나 표기(本의 표기 흔들림)
    const r = applyVocabPostprocess({ entries: [hon, honKana], level: "N3", include: ["ほん"], exclude: [] });
    const ok = words(r.entries) === "ほん" && r.filteredCount === 1;
    add("중복 접기: 표기 흔들림(本/ほん)·include 쪽 유지", ok, `남은=[${words(r.entries)}] filtered=${r.filteredCount}`);
  }

  // 3) 중복 접기 — include 없으면 첫 등장 유지
  {
    const r = applyVocabPostprocess({ entries: [hon, jw("ほん", "ほん")], level: "N3", include: [], exclude: [] });
    add("중복 접기: include 없으면 첫 등장 유지", words(r.entries) === "本", `남은=[${words(r.entries)}]`);
  }

  // 3) 중복 접기 — 가나 표기 흔들림(りんご/リンゴ)과 한자/가나(林檎/りんご)는 여전히 접힌다(기존 목적)
  {
    const r = applyVocabPostprocess({ entries: [jw("りんご", "りんご"), jw("リンゴ", "りんご"), mizu], level: "N5", include: [], exclude: [] });
    add("중복 접기: 가나 표기 흔들림(りんご/リンゴ) 접힘", words(r.entries) === "りんご,水" && r.filteredCount === 1, `남은=[${words(r.entries)}] filtered=${r.filteredCount}`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("林檎", "りんご"), jw("りんご", "りんご")], level: "N5", include: [], exclude: [] });
    add("중복 접기: 한자/가나 표기(林檎/りんご) 접힘", words(r.entries) === "林檎" && r.filteredCount === 1, `남은=[${words(r.entries)}]`);
  }

  // 3) 중복 접기(정정) — 동음이의어(kana만 같고 둘 다 한자 표기)는 새 단어끼리도 접지 않는다
  {
    const r = applyVocabPostprocess({ entries: [jw("暑い", "あつい"), jw("熱い", "あつい")], level: "N5", include: [], exclude: [] });
    add("중복 접기(정정): 동음이의어(暑い/熱い)는 둘 다 남음", words(r.entries) === "暑い,熱い" && r.filteredCount === 0, `남은=[${words(r.entries)}] filtered=${r.filteredCount}`);
  }

  // 3) 중복 접기 — 비추이성: 見る·観る(동음이의어)가 먼저 서면 둘 다 남고, 가나 표기 みる만 첫 대표(見る)에 접힌다
  {
    const r = applyVocabPostprocess({ entries: [jw("見る", "みる"), jw("観る", "みる"), jw("みる", "みる")], level: "N5", include: [], exclude: [] });
    add("중복 접기: 대표끼리는 다른 단어(見る·観る 남고 みる만 접힘)", words(r.entries) === "見る,観る" && r.filteredCount === 1, `남은=[${words(r.entries)}]`);
  }

  // 3) 중복 접기 — 남은 항목은 그 묶음에서 가장 먼저 나온 자리에 선다(접기 전 순서 유지 — 우선순위 순으로 줄 세우지 않는다)
  {
    const a = applyVocabPostprocess({ entries: [jw("ほん", "ほん"), mizu, hon], level: "N3", include: ["本"], exclude: [] });
    const b = applyVocabPostprocess({ entries: [mizu, hon], level: "N3", include: ["本"], exclude: [] });
    const ok = words(a.entries) === "本,水" && words(b.entries) === "水,本";
    add("중복 접기: 남은 include(本)는 묶음의 첫 자리(ほん 자리)에, 다른 묶음은 입력 순서대로", ok, `a=[${words(a.entries)}] b=[${words(b.entries)}]`);
  }

  // isSameJaWord 단위 — 표기 같음 / 읽기 같음+한쪽 가나 / 동음이의어 / 읽기 다름
  {
    const cases: { a: [string, string]; b: [string, string]; want: boolean }[] = [
      { a: ["本", "ほん"], b: ["本", "ほん"], want: true },
      { a: ["見る", "みる"], b: ["みる", "みる"], want: true },
      { a: ["りんご", "りんご"], b: ["リンゴ", "りんご"], want: true },
      { a: ["ｶﾞｲﾄﾞ", "がいど"], b: ["ガイド", "がいど"], want: true }, // 반각 → NFKC
      { a: ["暑い", "あつい"], b: ["熱い", "あつい"], want: false },
      { a: ["箸", "はし"], b: ["橋", "はし"], want: false },
      { a: ["雨", "あめ"], b: ["飴", "あめ"], want: false },
      { a: ["本", "ほん"], b: ["ほん", "ほんや"], want: false }, // 읽기가 다르면 가나 표기여도 다른 단어
    ];
    const bad = cases.filter((c) => isSameJaWord({ word: c.a[0], kana: c.a[1] }, { word: c.b[0], kana: c.b[1] }) !== c.want);
    add("isSameJaWord: 표기 같음·가나 표기 흔들림은 같음, 동음이의어·읽기 다름은 다름(8건)", bad.length === 0, bad.length === 0 ? "8/8" : bad.map((c) => `${c.a[0]}~${c.b[0]}`).join(","));
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

  // 하위호환: 구 레코드(imageEmoji·definitionJa 없음)를 normalizeJaVocabEntry가 null로 채운다(§작업3)
  {
    const legacy = { word: "本", kana: "ほん", wordTokens: [tok("本", "ほん")], pos: ["명사" as const], meaningsKo: ["책"], example: { ja: "本を読む。", ko: "책을 읽는다.", tokens: [tok("本", "ほん")] } };
    const n = normalizeJaVocabEntry(legacy);
    const ok = n.imageEmoji === null && n.definitionJa === null && n.definitionTokens === null && n.level === null && n.word === "本";
    add("하위호환: normalizeJaVocabEntry가 imageEmoji·definitionJa·definitionTokens·level을 null로 채움", ok, `imageEmoji=${n.imageEmoji} definitionJa=${n.definitionJa} definitionTokens=${n.definitionTokens} level=${n.level}`);
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

  // 한국어 섞임(2026-09-27) — 줄을 일본어/한국어로 가르고, 둘 다 첫 레벨에만. 한국어도 새 단어 수를 줄인다.
  {
    const plan = planIncludeDistribution(["N2", "N3"], ["約束", "여권", "水", " 여권 ", "비상구"], 10);
    const n2New = plan[0].count - plan[0].include.length - plan[0].includeKo.length;
    const ok =
      plan[0].include.join(",") === "約束,水" &&
      plan[0].includeKo.join(",") === "여권,비상구" &&
      n2New === 6 &&
      plan[1].include.length === 0 && plan[1].includeKo.length === 0;
    add("한국어 섞임: 일본어/한국어로 가름·중복 제거·첫 레벨에만·신규 10−4=6", ok, `N2 include=[${plan[0].include.join(",")}] includeKo=[${plan[0].includeKo.join(",")}] 신규=${n2New}`);
  }

  // 상한은 일본어+한국어 **합쳐** perLevelCount — 입력 순서대로 10개까지
  {
    const lines = ["一", "하나", "二", "둘", "三", "셋", "四", "넷", "五", "다섯", "六", "여섯"];
    const plan = planIncludeDistribution(["N5"], lines, 10);
    const ok = plan[0].include.join(",") === "一,二,三,四,五" && plan[0].includeKo.join(",") === "하나,둘,셋,넷,다섯";
    add("상한: 일본어+한국어 합쳐 10개(입력 순서)", ok, `include=[${plan[0].include.join(",")}] includeKo=[${plan[0].includeKo.join(",")}]`);
  }

  // 판별 불가 줄(섞임·라틴)은 계획에서 버린다(라우트가 400으로 먼저 막는 것의 방어) + 한국어 공백 정규화 중복
  {
    const plan = planIncludeDistribution(["N3"], ["여권パス", "passport", "水", "여권 사진", " 여권   사진 "], 10);
    const ok = plan[0].include.join(",") === "水" && plan[0].includeKo.join("|") === "여권 사진";
    add("섞인 줄·라틴 버림 + 한국어 공백 정규화 중복 제거", ok, `include=[${plan[0].include.join(",")}] includeKo=[${plan[0].includeKo.join("|")}]`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// 한국어 꼭 넣을 단어 (2026-09-27) — 줄 판별 · fromKo zod · 후처리(koConverted/koExcluded/접기/누락)
// ---------------------------------------------------------------------------

function runKoIncludeClassifierChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "한국어 include 판별";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });

  const cases: { line: string; want: "ja" | "ko" | null; name: string }[] = [
    { line: "여권", want: "ko", name: "한국어 한 낱말" },
    { line: "여권 사진", want: "ko", name: "한국어 낱말 사이 공백 허용" },
    { line: "  여권   사진  ", want: "ko", name: "앞뒤·연속 공백 정규화 후 한국어" },
    { line: "パスポート", want: "ja", name: "가타카나" },
    { line: "約束", want: "ja", name: "한자" },
    { line: "ｶﾞｲﾄﾞ", want: "ja", name: "반각 가나(NFKC 후 일본어)" },
    { line: "여권パスポート", want: null, name: "한 줄에 한글+일본 문자 섞임 거부" },
    { line: "パスポート 여권", want: null, name: "일본 문자+공백+한글 섞임 거부" },
    { line: "여권 passport", want: null, name: "한글+라틴 거부" },
    { line: "passport", want: null, name: "라틴만 거부" },
    { line: "여권2", want: null, name: "숫자 섞임 거부" },
    { line: "여권!", want: null, name: "문장부호 거부" },
    { line: "ㅋㅋ", want: null, name: "자모 단독 거부" },
    { line: "   ", want: null, name: "빈 줄 거부" },
    { line: "約束 する", want: null, name: "일본어 줄 안쪽 공백 거부(기존 규칙 유지)" },
    { line: "가".repeat(JA_INCLUDE_WORD_MAX), want: "ko", name: `한국어 ${JA_INCLUDE_WORD_MAX}자 통과` },
    { line: "가".repeat(JA_INCLUDE_WORD_MAX + 1), want: null, name: `한국어 ${JA_INCLUDE_WORD_MAX + 1}자 거부` },
    { line: "あ".repeat(JA_INCLUDE_WORD_MAX), want: "ja", name: `일본어 ${JA_INCLUDE_WORD_MAX}자 통과` },
    { line: "あ".repeat(JA_INCLUDE_WORD_MAX + 1), want: null, name: `일본어 ${JA_INCLUDE_WORD_MAX + 1}자 거부` },
  ];
  for (const c of cases) {
    const got = classifyJaIncludeLine(c.line);
    add(`classifyJaIncludeLine: ${c.name}`, got === c.want, `"${c.line}" → ${got} (기대 ${c.want})`);
  }

  add("normalizeKoInclude: 앞뒤 제거·연속 공백 한 칸", normalizeKoInclude("  여권   사진 ") === "여권 사진", JSON.stringify(normalizeKoInclude("  여권   사진 ")));
  // 길이 상한은 클라이언트 안전 모듈이 단일 정의, schemas.ts는 재수출(같은 값)
  add("JA_INCLUDE_WORD_MAX 단일 정의(japanese-include ↔ schemas 재수출)", JA_INCLUDE_WORD_MAX === JA_INCLUDE_WORD_MAX_CLIENT && JA_INCLUDE_WORD_MAX === 20, `${JA_INCLUDE_WORD_MAX}/${JA_INCLUDE_WORD_MAX_CLIENT}`);

  // 거부 이유(문구만 가른다 — 라우트 400 문구·만들기 화면 칩이 같은 함수). QA 3회차 P3-D: 여러 단어를 한 줄에 이어 쓴 줄은
  // "섞임"이 아니라 "한 줄에 하나씩"(listed). 판정은 그대로다 — reason null ⇔ classify non-null.
  type Reason = ReturnType<typeof jaIncludeRejectReason>;
  const reasonCases: { line: string; want: Reason; name: string }[] = [
    { line: "여권, 비자", want: "listed", name: "한국어 쉼표 나열" },
    { line: "여권·비자", want: "listed", name: "한국어 가운뎃점(U+00B7) 나열" },
    { line: "여권ㆍ비자", want: "listed", name: "한국어 천지인 가운뎃점(U+318D) 나열" },
    { line: "여권・비자", want: "listed", name: "한국어 + 가타카나 가운뎃점(U+30FB) 나열" },
    { line: "約束、水", want: "listed", name: "일본어 、 나열" },
    { line: "約束 水", want: "listed", name: "일본어 공백 나열" },
    { line: "約束/水", want: "listed", name: "일본어 빗금 나열" },
    { line: "여권, 비자, 호텔, 공항, 기차표, 택시, 식당", want: "listed", name: "20자 넘는 나열도 '한 줄에 하나씩'(너무 김보다 먼저)" },
    { line: "約束・水", want: null, name: "가타카나 가운뎃점 일본어 한 줄은 그대로 통과" },
    { line: "여권 사진", want: null, name: "한국어 낱말 사이 공백은 그대로 통과" },
    { line: "ボール·ペン", want: "mixed", name: "가운뎃점으로만 이은 가타카나는 복합어로 보고 나열 아님" },
    { line: "約束 약속", want: "mixed", name: "언어가 갈린 조각은 나열 아님(섞임)" },
    { line: "여권,", want: "mixed", name: "조각 하나 + 쉼표는 나열 아님(기호)" },
    { line: "か゛", want: "mixed", name: "U+309B(NFKC 공백 + 결합 탁점)는 나열 아님" },
    { line: "여권パスポート", want: "mixed", name: "한 줄에 한글+일본 문자" },
    { line: "가".repeat(JA_INCLUDE_WORD_MAX + 1), want: "too_long", name: `한국어 ${JA_INCLUDE_WORD_MAX + 1}자` },
    { line: "   ", want: "empty", name: "공백만" },
    { line: "여권", want: null, name: "받아들여지는 줄은 null" },
  ];
  for (const c of reasonCases) {
    const got = jaIncludeRejectReason(c.line);
    add(`jaIncludeRejectReason: ${c.name}`, got === c.want, `"${c.line}" → ${got} (기대 ${c.want})`);
  }
  const allLines = [...cases.map((c) => c.line), ...reasonCases.map((c) => c.line)];
  const invBroken = allLines.filter((l) => (jaIncludeRejectReason(l) === null) !== (classifyJaIncludeLine(l) !== null));
  add("jaIncludeRejectReason: 판정 불변(reason null ⇔ classify non-null)", invBroken.length === 0, `${allLines.length}줄 중 위반 ${invBroken.length}${invBroken.length ? ` [${invBroken.join(" | ")}]` : ""}`);

  return results;
}

/** 여권 → パスポート 픽스처(fromKo 기본 "여권"). ー는 히라가나 kana에서 허용된다. */
function passportEntry(over: Partial<JaVocabGenEntry> = {}): JaVocabGenEntry {
  return genEntry({
    fromKo: "여권",
    word: "パスポート",
    kana: "ぱすぽーと",
    pos: ["명사"],
    meaningsKo: ["여권"],
    wordTokens: [tok("パスポート")],
    example: { ja: "パスポートを見せる。", ko: "여권을 보여 준다.", tokens: [tok("パスポートを"), tok("見", "み"), tok("せる"), tok("。")] },
    ...over,
  });
}
/** 見る(보다) 픽스처 */
function miruEntry(over: Partial<JaVocabGenEntry> = {}): JaVocabGenEntry {
  return genEntry({
    word: "見る",
    kana: "みる",
    pos: ["동사(타)"],
    meaningsKo: ["보다"],
    wordTokens: [tok("見", "み"), tok("る")],
    example: { ja: "空を見る。", ko: "하늘을 본다.", tokens: [tok("空", "そら"), tok("を"), tok("見", "み"), tok("る"), tok("。")] },
    ...over,
  });
}
/** みる(가나 표기 — 見る와 kana가 같은 다른 표기) 픽스처 */
function miruKanaEntry(over: Partial<JaVocabGenEntry> = {}): JaVocabGenEntry {
  return miruEntry({ word: "みる", wordTokens: [tok("みる")], example: { ja: "空をみる。", ko: "하늘을 본다.", tokens: [tok("空", "そら"), tok("をみる。")] }, ...over });
}

function runKoIncludeZodChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "한국어 include zod";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });
  const hon = genEntry();
  const withKo = makeJaVocabGenerationSchema({ includeKo: ["여권", "비상구"] });

  {
    const r = withKo.safeParse({ entries: [passportEntry(), hon] });
    add("통과: fromKo=받은 한국어 + 나머지 null", r.success, r.success ? "통과" : JSON.stringify(r.error?.issues?.slice(0, 3)));
  }
  {
    const r = withKo.safeParse({ entries: [passportEntry({ fromKo: "  여권 " })] });
    add("통과: fromKo 공백 차이는 흡수(정규화 → 여권)", r.success && r.data.entries[0].fromKo === "여권", r.success ? `fromKo=${r.data.entries[0].fromKo}` : JSON.stringify(r.error?.issues?.slice(0, 2)));
  }
  {
    const r = withKo.safeParse({ entries: [passportEntry({ fromKo: "" })] });
    add("정리: fromKo 빈 문자열 → null(거부 아님)", r.success && r.data.entries[0].fromKo === null, r.success ? `fromKo=${r.data.entries[0].fromKo}` : "거부됨");
  }
  const reject: { name: string; schema: typeof withKo; input: unknown }[] = [
    { name: "fromKo가 입력에 없음(비자)", schema: withKo, input: { entries: [passportEntry({ fromKo: "비자" })] } },
    {
      name: "fromKo 중복(여권 두 번)",
      schema: withKo,
      input: { entries: [passportEntry(), genEntry({ fromKo: "여권", word: "旅券", kana: "りょけん", wordTokens: [tok("旅券", "りょけん")], meaningsKo: ["여권"] })] },
    },
    { name: "한국어 include 없는데 fromKo", schema: jaVocabGenerationSchema, input: { entries: [passportEntry()] } },
    { name: "한국어 include 없는 팩토리([])인데 fromKo", schema: makeJaVocabGenerationSchema({ includeKo: [] }), input: { entries: [passportEntry()] } },
    { name: "fromKo 항목의 word가 한국어(바꾸지 않고 되받음)", schema: withKo, input: { entries: [passportEntry({ word: "여권", wordTokens: [tok("여권")] })] } },
    { name: "fromKo 항목의 word에 일본 문자 없음(라틴 passport)", schema: withKo, input: { entries: [passportEntry({ word: "passport", wordTokens: [tok("passport")] })] } },
    { name: "fromKo null 항목의 word에 한글", schema: withKo, input: { entries: [genEntry({ word: "本여", wordTokens: [tok("本", "ほん"), tok("여")] })] } },
  ];
  for (const rc of reject) {
    const rejected = !rc.schema.safeParse(rc.input).success;
    add(`거부: ${rc.name}`, rejected, rejected ? "거부됨" : "통과되면 안 됨");
  }
  return results;
}

function runKoIncludePostprocessChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "한국어 include 후처리";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });
  const hon = genEntry();
  const map = (xs: { ko: string; word: string }[]) => xs.map((x) => `${x.ko}→${x.word}`).join(",");
  const passportExclude = [{ word: "パスポート", kana: "ぱすぽーと" }];

  // 정상 → koConverted
  {
    const r = applyVocabPostprocess({ entries: [passportEntry(), hon], level: "N4", include: [], includeKo: ["여권"], exclude: [] });
    const ok = r.entries.length === 2 && map(r.koConverted) === "여권→パスポート" && r.koConverted[0].kana === "ぱすぽーと" && r.koExcluded.length === 0 && r.missingIncludes.length === 0;
    add("정상: 여권 → パスポート가 koConverted", ok, `entries=${r.entries.length} converted=[${map(r.koConverted)}] excluded=[${map(r.koExcluded)}]`);
  }

  // 한국어에서 온 단어가 제외 목록에 있음 → 빼고 koExcluded (include 우선 아님)
  {
    const r = applyVocabPostprocess({ entries: [passportEntry(), hon], level: "N4", include: [], includeKo: ["여권"], exclude: passportExclude });
    const ok =
      r.entries.length === 1 && r.entries[0].word === "本" &&
      map(r.koExcluded) === "여권→パスポート" && r.koConverted.length === 0 &&
      r.missingIncludes.length === 0 && r.filteredCount === 1;
    add("제외 목록 단어 → 빼고 koExcluded(한국어는 include 우선 아님)", ok, `남은=[${r.entries.map((e) => e.word).join(",")}] excluded=[${map(r.koExcluded)}] missing=[${r.missingIncludes.join(",")}] filtered=${r.filteredCount}`);
  }

  // 제외 판정은 kana로도(표기가 달라도 읽기가 같으면 이미 있는 단어)
  {
    const r = applyVocabPostprocess({ entries: [passportEntry()], level: "N4", include: [], includeKo: ["여권"], exclude: [{ word: "ぱすぽーと", kana: "ぱすぽーと" }] });
    add("제외: kana 일치로도 koExcluded", r.entries.length === 0 && map(r.koExcluded) === "여권→パスポート", `excluded=[${map(r.koExcluded)}]`);
  }

  // 일본어 include와 같은 항목(모델이 한 번만 냄) → 일본어 include 우선으로 남고 koConverted
  {
    const r = applyVocabPostprocess({ entries: [passportEntry()], level: "N4", include: ["パスポート"], includeKo: ["여권"], exclude: passportExclude });
    const ok = r.entries.length === 1 && map(r.koConverted) === "여권→パスポート" && r.koExcluded.length === 0 && r.missingIncludes.length === 0;
    add("일본어 include와 같은 항목 → 제외에 있어도 남고 koConverted", ok, `entries=${r.entries.length} converted=[${map(r.koConverted)}] excluded=[${map(r.koExcluded)}]`);
  }

  // 일본어 include와 겹침(두 항목·같은 kana) → 하나로 접고(일본어 include 쪽) 매핑은 남은 표기로. 한국어 쪽이 먼저 와도 include가 이긴다.
  {
    const r = applyVocabPostprocess({ entries: [miruKanaEntry({ fromKo: "보다" }), miruEntry()], level: "N5", include: ["見る"], includeKo: ["보다"], exclude: [] });
    const ok = r.entries.length === 1 && r.entries[0].word === "見る" && map(r.koConverted) === "보다→見る" && r.filteredCount === 1 && r.missingIncludes.length === 0;
    add("일본어 include와 겹침(같은 kana) → 접고 보다→見る(include 우선)", ok, `남은=[${r.entries.map((e) => e.word).join(",")}] converted=[${map(r.koConverted)}] filtered=${r.filteredCount}`);
  }

  // 일본어 include와 겹치는데 한국어 쪽 항목이 제외에 걸림 → 제외가 아니라 하나로 접힌 것(koConverted)
  {
    const kanaWord = passportEntry({ word: "ぱすぽーと", wordTokens: [tok("ぱすぽーと")], example: { ja: "ぱすぽーとを見せる。", ko: "여권을 보여 준다.", tokens: [tok("ぱすぽーとを"), tok("見", "み"), tok("せる"), tok("。")] } });
    const r = applyVocabPostprocess({ entries: [passportEntry({ fromKo: null }), kanaWord], level: "N4", include: ["パスポート"], includeKo: ["여권"], exclude: passportExclude });
    const ok = r.entries.length === 1 && r.entries[0].word === "パスポート" && map(r.koConverted) === "여권→パスポート" && r.koExcluded.length === 0;
    add("일본어 include와 겹침 + 한국어 쪽이 제외 대상 → koConverted(접힘)", ok, `남은=[${r.entries.map((e) => e.word).join(",")}] converted=[${map(r.koConverted)}] excluded=[${map(r.koExcluded)}]`);
  }

  // 한국어에서 온 것 > 새로 고른 것(같은 kana) — 새 단어가 먼저 와도 한국어 쪽을 남긴다
  {
    const r = applyVocabPostprocess({ entries: [miruKanaEntry(), miruEntry({ fromKo: "보다" })], level: "N5", include: [], includeKo: ["보다"], exclude: [] });
    const ok = r.entries.length === 1 && r.entries[0].word === "見る" && map(r.koConverted) === "보다→見る";
    add("접기 우선순위: 한국어에서 온 것 > 새 단어", ok, `남은=[${r.entries.map((e) => e.word).join(",")}] converted=[${map(r.koConverted)}]`);
  }

  // 한국어 두 줄이 같은 kana로 바뀜 → 하나로 접히고 두 줄 모두 남은 표기로 매핑
  {
    const r = applyVocabPostprocess({ entries: [miruEntry({ fromKo: "보다" }), miruKanaEntry({ fromKo: "구경하다" })], level: "N5", include: [], includeKo: ["보다", "구경하다"], exclude: [] });
    const ok = r.entries.length === 1 && map(r.koConverted) === "보다→見る,구경하다→見る" && r.missingIncludes.length === 0;
    add("한국어 두 줄이 같은 단어로 → 접고 둘 다 매핑", ok, `converted=[${map(r.koConverted)}]`);
  }

  // ---- 동음이의어 반례(QA korean-include_1 실패 1·2) — kana만 같은 다른 단어는 접지도·제외하지도 않고, 매핑은 실제로 남은 항목 ----
  const atsui = (ko: string | null) => jw("暑い", "あつい", { fromKo: ko });
  const atsui2 = (ko: string | null) => jw("熱い", "あつい", { fromKo: ko });
  const hashiChopsticks = (ko: string | null) => jw("箸", "はし", { fromKo: ko });
  const hashiBridge = (ko: string | null) => jw("橋", "はし", { fromKo: ko });
  const hashiExclude = [{ word: "箸", kana: "はし" }];

  // C3: 덥다·뜨겁다 → 暑い·熱い(같은 あつい) — 둘 다 남고 각자 매핑
  {
    const r = applyVocabPostprocess({ entries: [atsui("덥다"), atsui2("뜨겁다")], level: "N5", include: [], includeKo: ["덥다", "뜨겁다"], exclude: [] });
    const ok = words(r.entries) === "暑い,熱い" && map(r.koConverted) === "덥다→暑い,뜨겁다→熱い" && r.koExcluded.length === 0 && r.missingIncludes.length === 0 && r.filteredCount === 0;
    add("동음이의어 C3: 덥다→暑い·뜨겁다→熱い 둘 다 남고 매핑 정확", ok, `남은=[${words(r.entries)}] converted=[${map(r.koConverted)}] missing=[${r.missingIncludes.join(",")}]`);
  }
  // C3 순서 뒤집기 — 먼저 온 쪽이 이기는 게 아니라 둘 다 남는다
  {
    const r = applyVocabPostprocess({ entries: [atsui2("뜨겁다"), atsui("덥다")], level: "N5", include: [], includeKo: ["덥다", "뜨겁다"], exclude: [] });
    const ok = words(r.entries) === "熱い,暑い" && map(r.koConverted) === "덥다→暑い,뜨겁다→熱い";
    add("동음이의어 C3′: 순서를 뒤집어도 둘 다 남고 매핑은 한국어 입력 순서", ok, `남은=[${words(r.entries)}] converted=[${map(r.koConverted)}]`);
  }
  // C4: 일본어 include 箸 + 한국어 다리 → 橋 — 橋가 남고 다리→橋(箸로 거짓 보고하지 않음)
  {
    const r = applyVocabPostprocess({ entries: [hashiChopsticks(null), hashiBridge("다리")], level: "N4", include: ["箸"], includeKo: ["다리"], exclude: [] });
    const ok = words(r.entries) === "箸,橋" && map(r.koConverted) === "다리→橋" && r.missingIncludes.length === 0 && r.filteredCount === 0;
    add("동음이의어 C4: 箸 include + 다리→橋 → 橋 남고 다리→橋", ok, `남은=[${words(r.entries)}] converted=[${map(r.koConverted)}] missing=[${r.missingIncludes.join(",")}]`);
  }
  // C5(실패 2): 가진 단어 箸 + 다리 → 橋 — 동음이의어라 제외하지 않는다
  {
    const r = applyVocabPostprocess({ entries: [hashiBridge("다리"), hon], level: "N4", include: [], includeKo: ["다리"], exclude: hashiExclude });
    const ok = words(r.entries) === "橋,本" && map(r.koConverted) === "다리→橋" && r.koExcluded.length === 0 && r.filteredCount === 0;
    add("동음이의어 C5: 가진 箸 + 다리→橋 → 제외 안 됨(koConverted)", ok, `남은=[${words(r.entries)}] converted=[${map(r.koConverted)}] excluded=[${map(r.koExcluded)}]`);
  }
  // C6: C4 + 가진 단어 橋 — 다리→橋는 이미 있어서 뺐고(koExcluded), 箸로 접혔다고 보고하지 않는다
  {
    const r = applyVocabPostprocess({ entries: [hashiChopsticks(null), hashiBridge("다리")], level: "N4", include: ["箸"], includeKo: ["다리"], exclude: [{ word: "橋", kana: "はし" }] });
    const ok = words(r.entries) === "箸" && map(r.koExcluded) === "다리→橋" && r.koConverted.length === 0 && r.missingIncludes.length === 0;
    add("동음이의어 C6: 箸 include + 가진 橋 + 다리→橋 → koExcluded 다리→橋", ok, `남은=[${words(r.entries)}] converted=[${map(r.koConverted)}] excluded=[${map(r.koExcluded)}]`);
  }
  // C7(비교, 기존 일본어 경로): include 橋·箸 둘 다 남고 누락 보고 없음
  {
    const r = applyVocabPostprocess({ entries: [hashiBridge(null), hashiChopsticks(null)], level: "N4", include: ["橋", "箸"], exclude: [] });
    add("동음이의어 C7: 일본어 include 橋·箸 둘 다 남음(누락 없음)", words(r.entries) === "橋,箸" && r.missingIncludes.length === 0, `남은=[${words(r.entries)}] missing=[${r.missingIncludes.join(",")}]`);
  }
  // 한국어 줄 둘이 같은 단어(표기 흔들림)면 여전히 접힌다 — 暑い(덥다) + あつい(뜨겁다, 가나 표기) → 暑い 하나, 둘 다 暑い로 매핑
  {
    const r = applyVocabPostprocess({ entries: [atsui("덥다"), jw("あつい", "あつい", { fromKo: "뜨겁다" })], level: "N5", include: [], includeKo: ["덥다", "뜨겁다"], exclude: [] });
    const ok = words(r.entries) === "暑い" && map(r.koConverted) === "덥다→暑い,뜨겁다→暑い";
    add("표기 흔들림은 한국어 줄끼리도 접힘(暑い/あつい → 둘 다 暑い)", ok, `남은=[${words(r.entries)}] converted=[${map(r.koConverted)}]`);
  }
  // 가나 표기 하나가 동음이의어 둘을 잇는 경우 — 한국어 쪽 はし(젓가락)가 가진 箸에 걸려 빠지고, 남은 일본어 include 橋는
  // 제외 목록의 단어가 아니므로 "橋로 접혔다"고 보고하지 않는다(koExcluded 젓가락→はし로 사실대로)
  {
    const r = applyVocabPostprocess({ entries: [hashiBridge(null), jw("はし", "はし", { fromKo: "젓가락" })], level: "N4", include: ["橋"], includeKo: ["젓가락"], exclude: hashiExclude });
    const ok = words(r.entries) === "橋" && map(r.koExcluded) === "젓가락→はし" && r.koConverted.length === 0;
    add("가나 표기 다리(はし)가 箸·橋를 이어도 거짓 koConverted 없음", ok, `남은=[${words(r.entries)}] converted=[${map(r.koConverted)}] excluded=[${map(r.koExcluded)}]`);
  }

  // 누락 보고 — 일본어 먼저, 이어서 한국어(한국어 그대로)
  {
    const r = applyVocabPostprocess({ entries: [passportEntry(), hon], level: "N4", include: ["水"], includeKo: ["여권", "비자"], exclude: [] });
    const ok = r.missingIncludes.join(",") === "水,비자" && map(r.koConverted) === "여권→パスポート";
    add("누락 보고: 못 넣은 한국어는 missingIncludes에 한국어 그대로(일본어 다음)", ok, `missing=[${r.missingIncludes.join(",")}] converted=[${map(r.koConverted)}]`);
  }

  // 방어: 받지 않은 한국어를 적은 fromKo는 없는 것으로(새 단어 취급 — 매핑 보고 없음)
  {
    const r = applyVocabPostprocess({ entries: [passportEntry()], level: "N4", include: [], exclude: [] });
    const ok = r.entries.length === 1 && r.koConverted.length === 0 && r.koExcluded.length === 0 && r.missingIncludes.length === 0;
    add("방어: 받지 않은 fromKo는 무시(includeKo 생략 = 빈 배열)", ok, `entries=${r.entries.length} converted=${r.koConverted.length}`);
  }

  // 회귀: 한국어가 없으면 기존 결과 그대로 + 저장 엔트리에 fromKo가 새지 않는다
  {
    const r = applyVocabPostprocess({ entries: [passportEntry(), hon], level: "N4", include: [], includeKo: ["여권"], exclude: [] });
    const leaked = r.entries.some((e) => Object.prototype.hasOwnProperty.call(e, "fromKo"));
    add("저장 엔트리(JaVocabEntry)에 fromKo 없음", !leaked, leaked ? "fromKo가 저장 엔트리에 샜음" : "없음");
  }

  return results;
}

// ---------------------------------------------------------------------------
// 같은 단어 판정 — 한자 뼈대 규칙 (§2-4 "같은 단어 판정" 3번, QA korean-include_2 P3-1)
// 배터리 넷: H 동음이의어(접히면 안 됨) · V 같은 단어의 표기 변형(접혀야 함, 한계 2쌍) · D 異字同訓(따로 둔다) ·
// X 부분열 규칙이 접을 위험이 있는 동음이의어 탐침(접히면 안 됨). 한계 잠금 하나: 오쿠리가나 ↔ 덧붙은 한자
// 동음이의어(지금은 접힌다 — 현재 동작을 잠근다)와 그 대조군. 그리고 독립 참조 모델·무작위 불변식.
// ---------------------------------------------------------------------------

/** [표기 a, 표기 b, 공통 읽기] */
type JaPair = readonly [string, string, string];
const SAME_WORD_H: readonly JaPair[] = [
  ["箸", "橋", "はし"], ["暑い", "熱い", "あつい"], ["雨", "飴", "あめ"], ["紙", "髪", "かみ"], ["着る", "切る", "きる"],
  ["花", "鼻", "はな"], ["木", "気", "き"], ["目", "芽", "め"], ["帰る", "変える", "かえる"], ["会う", "合う", "あう"],
  ["橋", "端", "はし"], ["雲", "蜘蛛", "くも"], ["柿", "牡蠣", "かき"], ["神", "紙", "かみ"], ["火", "日", "ひ"],
  ["酒", "鮭", "さけ"], ["私立", "市立", "しりつ"], ["科学", "化学", "かがく"], ["意外", "以外", "いがい"], ["医師", "意志", "いし"],
  ["期間", "機関", "きかん"], ["公園", "講演", "こうえん"], ["感心", "関心", "かんしん"], ["習慣", "週刊", "しゅうかん"], ["回答", "解答", "かいとう"],
  ["講義", "抗議", "こうぎ"], ["機会", "機械", "きかい"], ["地震", "自信", "じしん"], ["保証", "保障", "ほしょう"], ["石", "医師", "いし"],
];
/** 같은 단어의 표기 변형 — 마지막 2쌍(한자 자체가 다름)은 알려진 한계라 다른 단어로 남는다 */
const SAME_WORD_V: readonly JaPair[] = [
  ["子供", "子ども", "こども"], ["友達", "友だち", "ともだち"], ["私達", "私たち", "わたしたち"],
  ["申し込む", "申込む", "もうしこむ"], ["取り消す", "取消す", "とりけす"], ["受け付け", "受付", "うけつけ"],
  ["引っ越し", "引越し", "ひっこし"], ["終わる", "終る", "おわる"], ["行う", "行なう", "おこなう"],
  ["表す", "表わす", "あらわす"], ["飲み物", "飲物", "のみもの"], ["乗り換え", "乗換え", "のりかえ"],
  ["売り場", "売場", "うりば"], ["付き合う", "付合う", "つきあう"], ["見つける", "見付ける", "みつける"],
  ["お茶", "御茶", "おちゃ"], ["ご飯", "御飯", "ごはん"], ["お金", "御金", "おかね"],
  ["綺麗", "奇麗", "きれい"], ["分かる", "解る", "わかる"],
];
const SAME_WORD_V_LIMITS = new Set(["綺麗/奇麗", "分かる/解る"]);
const SAME_WORD_D: readonly JaPair[] = [
  ["見る", "観る", "みる"], ["聞く", "聴く", "きく"], ["早い", "速い", "はやい"], ["暖かい", "温かい", "あたたかい"],
  ["硬い", "固い", "かたい"], ["計る", "測る", "はかる"], ["作る", "造る", "つくる"], ["上る", "登る", "のぼる"],
  ["始め", "初め", "はじめ"], ["会う", "遭う", "あう"],
];
/** 한쪽 뼈대가 다른 쪽의 부분열인 동음이의어 — "순서 있는 부분열이면 같은 단어"로만 넓히면 접힌다 */
const SAME_WORD_X: readonly JaPair[] = [
  ["風", "風邪", "かぜ"], ["ご本", "五本", "ごほん"], ["ご用", "誤用", "ごよう"], ["ご入力", "誤入力", "ごにゅうりょく"],
  ["ご記入", "誤記入", "ごきにゅう"], ["ご送信", "誤送信", "ごそうしん"], ["ご回答", "誤回答", "ごかいとう"],
  ["見方", "味方", "みかた"], ["見かた", "味方", "みかた"],
];
/**
 * 알려진 한계(§2-4, QA korean-include_3 P3-A) — 다른 단어인데 같은 단어로 보는 동음이의어. 오쿠리가나가 덧붙은
 * 한자의 읽기와 우연히 같은 쌍이다: 짧은 쪽은 "한자 + 오쿠리가나", 긴 쪽은 "같은 한자 + 그 가나로 읽히는 한자"라
 * 뼈대 ②의 交ぜ書き(빠진 한자 자리에 가나)와 모양이 같다. **지금은 같은 단어로 본다** — 이 배터리는 그 현재 동작을
 * 잠가, 규칙을 바꾸면 드러나게 한다. 고칠 때는 아래 대조군(같은 모양의 참 변형)을 함께 본다.
 */
const SAME_WORD_LIMIT_OKURI: readonly JaPair[] = [
  ["長い", "長居", "ながい"], ["赤み", "赤身", "あかみ"], ["白み", "白身", "しろみ"], ["黄み", "黄身", "きみ"],
];
/** 대조군 — 위 한계와 같은 모양의 참 변형(같은 단어). 구조로 가를 수 없어, 한계를 막는 규칙은 이 쌍도 잃는다 */
const SAME_WORD_LIMIT_OKURI_CONTROL: readonly JaPair[] = [
  ["甘み", "甘味", "あまみ"], ["苦み", "苦味", "にがみ"], ["弱み", "弱味", "よわみ"], ["強み", "強味", "つよみ"],
  ["寿し", "寿司", "すし"], ["住まい", "住居", "すまい"], ["出し", "出汁", "だし"], ["眠け", "眠気", "ねむけ"],
];

const HAN_RE = /\p{Script=Han}/u;
const KANA_ONLY_RE = /^[぀-ゟ゠-ヿ]+$/;
const HAS_KANA_RE = /[぀-ゟ゠-ヿ]/;

/**
 * 독립 참조 모델 — §2-4 "같은 단어 판정"을 문장 그대로, 구현(되돌아가며 맞추기)과 다른 방식(긴 쪽 한자 index 조합을
 * 비트마스크로 전부 나열)으로 다시 쓴 것. 짧은 표기에만 쓴다(긴 쪽 한자 16자 이하).
 */
function referenceSameJaWord(a: { word: string; kana: string }, b: { word: string; kana: string }): boolean {
  const aw = normalizeJaWord(a.word);
  const bw = normalizeJaWord(b.word);
  if (aw !== "" && aw === bw) return true;
  const ak = normalizeJaWord(a.kana);
  if (ak === "" || ak !== normalizeJaWord(b.kana)) return false;
  if (KANA_ONLY_RE.test(aw) || KANA_ONLY_RE.test(bw)) return true;
  const split = (w: string) => {
    const chars = [...w];
    const kanji = chars.filter((c) => HAN_RE.test(c));
    // gap[i] = i번째 한자 앞의 한자 아닌 글자들(마지막은 꼬리)
    const gap: string[] = [];
    let cur = "";
    for (const c of chars) {
      if (HAN_RE.test(c)) {
        gap.push(cur);
        cur = "";
      } else cur += c;
    }
    gap.push(cur);
    return { kanji, gap };
  };
  const x = split(aw);
  const y = split(bw);
  if (x.kanji.length === 0 || y.kanji.length === 0) return false;
  const s = x.kanji.length <= y.kanji.length ? x : y;
  const l = s === x ? y : x;
  if (s.kanji.length === l.kanji.length) return s.kanji.join("") === l.kanji.join("");
  const n = l.kanji.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const pos: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) pos.push(i);
    if (pos.length !== s.kanji.length) continue;
    if (pos.some((p, j) => l.kanji[p] !== s.kanji[j])) continue;
    let ok = true;
    for (let j = 0; j <= s.kanji.length && ok; j++) {
      const from = j === 0 ? 0 : pos[j - 1] + 1;
      const to = j === s.kanji.length ? n : pos[j];
      const missing = l.kanji.slice(from, to);
      if (missing.length === 0) continue;
      if (!HAS_KANA_RE.test(s.gap[j])) ok = false;
      else if (j === 0 && missing.some((k) => k !== "御")) ok = false;
    }
    if (ok) return true;
  }
  return false;
}

function runSameWordVariantChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const book = "같은 단어 판정";
  const add = (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });
  const same = (a: string, b: string, k: string) => {
    const ab = isSameJaWord({ word: a, kana: k }, { word: b, kana: k });
    const ba = isSameJaWord({ word: b, kana: k }, { word: a, kana: k });
    return { ab, ba };
  };
  const map = (xs: { ko: string; word: string }[]) => xs.map((x) => `${x.ko}→${x.word}`).join(",");

  // ---- 배터리 — 판정(양방향)과 후처리(누적 제외·같은 배치 접기)를 함께 ----
  /** 판정 결과가 want와 다른 쌍, 비대칭 쌍, 후처리가 판정과 어긋난 쌍을 모은다 */
  const battery = (list: readonly JaPair[], want: (a: string, b: string) => boolean) => {
    const wrong: string[] = [];
    const asym: string[] = [];
    const ppWrong: string[] = [];
    let sameCount = 0;
    for (const [a, b, k] of list) {
      const { ab, ba } = same(a, b, k);
      if (ab !== ba) asym.push(`${a}/${b}`);
      if (ab !== want(a, b)) wrong.push(`${a}/${b}`);
      if (ab) sameCount++;
      // 누적 제외: 가진 a + 새 b → 같은 단어면 걸러지고 아니면 남는다
      const ex = applyVocabPostprocess({ entries: [jw(b, k)], level: "N4", include: [], exclude: [{ word: a, kana: k }] });
      // 같은 배치 접기: 새 a, b → 같은 단어면 첫 등장(a) 하나
      const fold = applyVocabPostprocess({ entries: [jw(a, k), jw(b, k)], level: "N4", include: [], exclude: [] });
      const exOk = ab ? ex.entries.length === 0 && ex.filteredCount === 1 : words(ex.entries) === b;
      const foldOk = ab ? words(fold.entries) === a && fold.filteredCount === 1 : words(fold.entries) === `${a},${b}`;
      if (!exOk || !foldOk) ppWrong.push(`${a}/${b}`);
    }
    return { wrong, asym, ppWrong, sameCount };
  };

  {
    const r = battery(SAME_WORD_H, () => false);
    add(
      `H 동음이의어 ${SAME_WORD_H.length}쌍: 전부 다른 단어(양방향) — 暑い/熱い·箸/橋·石/医師`,
      r.wrong.length === 0 && r.asym.length === 0,
      `같은 단어로 본 쌍 ${r.sameCount}/${SAME_WORD_H.length}${r.wrong.length ? ` [${r.wrong.join(" ")}]` : ""}${r.asym.length ? ` 비대칭 [${r.asym.join(" ")}]` : ""}`,
    );
    add(`H 동음이의어 ${SAME_WORD_H.length}쌍: 누적 제외 0/30·같은 배치 접기 0/30`, r.ppWrong.length === 0, r.ppWrong.length ? `어긋남 [${r.ppWrong.join(" ")}]` : "0/30 · 0/30");
  }
  {
    const r = battery(SAME_WORD_V, (a, b) => !SAME_WORD_V_LIMITS.has(`${a}/${b}`));
    const want = SAME_WORD_V.length - SAME_WORD_V_LIMITS.size;
    add(
      `V 표기 변형 ${SAME_WORD_V.length}쌍: ${want}쌍 같은 단어(子ども/子供·申込む/申し込む·お茶/御茶), 한계 2쌍(綺麗/奇麗·分かる/解る)만 다른 단어`,
      r.wrong.length === 0 && r.asym.length === 0 && r.sameCount === want,
      `같은 단어 ${r.sameCount}/${SAME_WORD_V.length}${r.wrong.length ? ` 기대와 다름 [${r.wrong.join(" ")}]` : ""}${r.asym.length ? ` 비대칭 [${r.asym.join(" ")}]` : ""}`,
    );
    add(`V 표기 변형: 누적 제외·같은 배치 접기가 판정대로(${want}/20 거름·${want}/20 접힘)`, r.ppWrong.length === 0, r.ppWrong.length ? `어긋남 [${r.ppWrong.join(" ")}]` : `${want}/20 · ${want}/20`);
  }
  {
    const r = battery(SAME_WORD_D, () => false);
    add(`D 異字同訓 ${SAME_WORD_D.length}쌍: 다른 단어로 둔다(見る/観る·早い/速い — JLPT 목록이 따로 싣는다)`, r.wrong.length === 0 && r.asym.length === 0 && r.ppWrong.length === 0, `같은 단어로 본 쌍 ${r.sameCount}/${SAME_WORD_D.length}${r.wrong.length ? ` [${r.wrong.join(" ")}]` : ""}`);
  }
  {
    const r = battery(SAME_WORD_X, () => false);
    add(
      `X 부분열 동음이의어 탐침 ${SAME_WORD_X.length}쌍: 전부 다른 단어(風/風邪 — 빠진 자리에 가나 없음 · ご本/五本·ご用/誤用 — 머리 가나는 御만 대신)`,
      r.wrong.length === 0 && r.asym.length === 0 && r.ppWrong.length === 0,
      `같은 단어로 본 쌍 ${r.sameCount}/${SAME_WORD_X.length}${r.wrong.length ? ` [${r.wrong.join(" ")}]` : ""}`,
    );
  }
  // ---- 알려진 한계 잠금(§2-4 "다른 단어인데 같은 단어로 보는 동음이의어") — 현재 동작이 기대값이다 ----
  // 이 세 행이 깨지면 규칙이 바뀐 것이다. 한계를 고친 것이면 스펙 §2-4 "알려진 한계"·측정 문단과 함께 기대값을 옮기고,
  // 대조군 행이 같이 깨졌으면 참 변형을 잃은 것이다(QA 측정: 좁히는 안은 대조군 7/8과 語彙/語い·危惧/危ぐ를 잃는다).
  {
    const n = SAME_WORD_LIMIT_OKURI.length;
    const r = battery(SAME_WORD_LIMIT_OKURI, () => true);
    add(
      `한계 — 오쿠리가나 ↔ 덧붙은 한자 동음이의어 ${n}쌍(長い/長居·赤み/赤身·白み/白身·黄み/黄身): 지금은 같은 단어로 봄(양방향 · 누적 제외 ${n}/${n} · 같은 배치 접기 ${n}/${n})`,
      r.wrong.length === 0 && r.asym.length === 0 && r.ppWrong.length === 0,
      `같은 단어로 본 쌍 ${r.sameCount}/${n}${r.wrong.length ? ` 다른 단어로 봄 [${r.wrong.join(" ")}] — 규칙이 바뀌었다: §2-4 알려진 한계·대조군 행 확인` : ""}${r.asym.length ? ` 비대칭 [${r.asym.join(" ")}]` : ""}${r.ppWrong.length ? ` 후처리 어긋남 [${r.ppWrong.join(" ")}]` : ""}`,
    );
  }
  {
    const n = SAME_WORD_LIMIT_OKURI_CONTROL.length;
    const r = battery(SAME_WORD_LIMIT_OKURI_CONTROL, () => true);
    add(
      `한계 대조군 — 같은 모양의 참 변형 ${n}쌍(甘み/甘味·寿し/寿司·眠け/眠気 …): 같은 단어(양방향 · 누적 제외 · 같은 배치 접기) — 위 한계와 구조로 못 가른다`,
      r.wrong.length === 0 && r.asym.length === 0 && r.ppWrong.length === 0,
      `같은 단어 ${r.sameCount}/${n}${r.wrong.length ? ` 다른 단어로 봄 [${r.wrong.join(" ")}]` : ""}${r.asym.length ? ` 비대칭 [${r.asym.join(" ")}]` : ""}${r.ppWrong.length ? ` 후처리 어긋남 [${r.ppWrong.join(" ")}]` : ""}`,
    );
  }
  {
    // 한국어 경로에서 보이는 결과(스펙 §2-4 한계 문구): 가진 赤み + 살코기→赤身 → 가진 적 없는 赤身를 koExcluded로,
    // 붉은 기→赤み·살코기→赤身 → 하나로 접혀 둘 다 赤み로 보고(거짓 매핑)
    const ex = applyVocabPostprocess({ entries: [jw("赤身", "あかみ", { fromKo: "살코기" })], level: "N2", include: [], includeKo: ["살코기"], exclude: [{ word: "赤み", kana: "あかみ" }] });
    const fold = applyVocabPostprocess({ entries: [jw("赤み", "あかみ", { fromKo: "붉은 기" }), jw("赤身", "あかみ", { fromKo: "살코기" })], level: "N2", include: [], includeKo: ["붉은 기", "살코기"], exclude: [] });
    const exOk = ex.entries.length === 0 && map(ex.koExcluded) === "살코기→赤身" && ex.koConverted.length === 0;
    const foldOk = words(fold.entries) === "赤み" && map(fold.koConverted) === "붉은 기→赤み,살코기→赤み" && fold.filteredCount === 1;
    add(
      "한계 — 한국어 경로: 가진 赤み + 살코기→赤身 → koExcluded · 붉은 기→赤み·살코기→赤身 → 하나로 접혀 둘 다 赤み",
      exOk && foldOk,
      `제외: 남은=[${words(ex.entries)}] excluded=[${map(ex.koExcluded)}] · 접기: 남은=[${words(fold.entries)}] converted=[${map(fold.koConverted)}]`,
    );
  }

  // ---- 대표 사례 — 후처리 경로 ----
  // 기존 일본어 경로: 가진 子供 + 새로 고른 子ども → 걸러진다(P3-1 이전에는 남았다)
  {
    const r = applyVocabPostprocess({ entries: [jw("子ども", "こども"), jw("水", "みず")], level: "N5", include: [], exclude: [{ word: "子供", kana: "こども" }] });
    add("누적 제외: 가진 子供 ↔ 새 子ども(한자 일부를 가나로) 걸러짐", words(r.entries) === "水" && r.filteredCount === 1, `남은=[${words(r.entries)}] filtered=${r.filteredCount}`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("申込む", "もうしこむ")], level: "N3", include: [], exclude: [{ word: "申し込む", kana: "もうしこむ" }] });
    add("누적 제외: 가진 申し込む ↔ 새 申込む(오쿠리가나만 다름) 걸러짐", r.entries.length === 0 && r.filteredCount === 1, `남은=[${words(r.entries)}]`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("お茶", "おちゃ")], level: "N5", include: [], exclude: [{ word: "御茶", kana: "おちゃ" }] });
    add("누적 제외: 가진 御茶 ↔ 새 お茶(머리 御를 가나로) 걸러짐", r.entries.length === 0, `남은=[${words(r.entries)}]`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("風邪", "かぜ"), jw("五本", "ごほん")], level: "N5", include: [], exclude: [{ word: "風", kana: "かぜ" }, { word: "ご本", kana: "ごほん" }] });
    add("누적 제외: 가진 風·ご本이 있어도 새 風邪·五本은 남음(동음이의어)", words(r.entries) === "風邪,五本" && r.filteredCount === 0, `남은=[${words(r.entries)}] filtered=${r.filteredCount}`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("受付", "うけつけ"), jw("水", "みず"), jw("受け付け", "うけつけ")], level: "N3", include: [], exclude: [] });
    add("같은 배치 접기: 受付/受け付け → 첫 등장(受付) 하나", words(r.entries) === "受付,水" && r.filteredCount === 1, `남은=[${words(r.entries)}]`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("見付ける", "みつける"), jw("見つける", "みつける"), jw("みつける", "みつける")], level: "N4", include: [], exclude: [] });
    add("같은 배치 접기: 見付ける/見つける/みつける → 하나", words(r.entries) === "見付ける" && r.filteredCount === 2, `남은=[${words(r.entries)}]`);
  }
  // 한국어 경로(QA B-V1·B-V2): 가진 子供 + 아이 → 子ども는 koExcluded, 두 줄이 子供·子ども로 바뀌면 하나로 접고 둘 다 子供로
  {
    const r = applyVocabPostprocess({ entries: [jw("子ども", "こども", { fromKo: "아이" })], level: "N5", include: [], includeKo: ["아이"], exclude: [{ word: "子供", kana: "こども" }] });
    add("한국어 경로: 가진 子供 + 아이→子ども → koExcluded", r.entries.length === 0 && map(r.koExcluded) === "아이→子ども" && r.koConverted.length === 0, `excluded=[${map(r.koExcluded)}] converted=[${map(r.koConverted)}]`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("子供", "こども", { fromKo: "아이" }), jw("子ども", "こども", { fromKo: "어린이" })], level: "N5", include: [], includeKo: ["아이", "어린이"], exclude: [] });
    add("한국어 경로: 아이→子供·어린이→子ども → 하나로 접고 둘 다 子供", words(r.entries) === "子供" && map(r.koConverted) === "아이→子供,어린이→子供" && r.filteredCount === 1, `남은=[${words(r.entries)}] converted=[${map(r.koConverted)}]`);
  }
  {
    const r = applyVocabPostprocess({ entries: [jw("子ども", "こども", { fromKo: "어린이" }), jw("子供", "こども")], level: "N5", include: ["子供"], includeKo: ["어린이"], exclude: [] });
    add("한국어 경로: include 子供 + 어린이→子ども → include 쪽(子供)이 남고 어린이→子供", words(r.entries) === "子供" && map(r.koConverted) === "어린이→子供" && r.missingIncludes.length === 0, `남은=[${words(r.entries)}] converted=[${map(r.koConverted)}] missing=[${r.missingIncludes.join(",")}]`);
  }

  // ---- 규칙 모양 단위 ----
  {
    const cases: { a: string; b: string; k: string; want: boolean; why: string }[] = [
      { a: "ｺﾞ飯", b: "御飯", k: "ごはん", want: true, why: "반각 가나 → NFKC 뒤 판정" },
      { a: "人びと", b: "人々", k: "ひとびと", want: true, why: "々 표기(人々)와 가나로 푼 표기(人びと)" },
      { a: "一ヶ月", b: "一箇月", k: "いっかげつ", want: true, why: "ヶ는 가나 블록 — 箇 자리를 ヶ로" },
      { a: "一ヶ月", b: "一か月", k: "いっかげつ", want: true, why: "뼈대 一月 같음" },
      { a: "子ども", b: "子供", k: "こども", want: true, why: "꼬리 빈칸 ども가 供 자리" },
      { a: "子ども達", b: "子供たち", k: "こどもたち", want: false, why: "양쪽이 서로 다른 한자를 풂 — 한계" },
      { a: "お子", b: "御子", k: "おこ", want: true, why: "머리 お가 御 자리" },
      { a: "ご本", b: "五本", k: "ごほん", want: false, why: "머리 가나는 御만 대신" },
      { a: "風", b: "風邪", k: "かぜ", want: false, why: "빠진 邪 자리에 가나 없음" },
    ];
    const bad = cases.filter((c) => same(c.a, c.b, c.k).ab !== c.want || same(c.a, c.b, c.k).ba !== c.want);
    // 읽기가 다르면 뼈대가 맞아도 다른 단어(子供(こども) / 子ども(こどもら))
    const kanaDiff = isSameJaWord({ word: "子供", kana: "こども" }, { word: "子ども", kana: "こどもら" });
    if (kanaDiff) bad.push({ a: "子供", b: "子ども", k: "こども/こどもら", want: false, why: "읽기가 다르면 다른 단어" });
    add(`규칙 모양 단위 ${cases.length + 1}건(NFKC·々·ヶ·머리 御·빈 빈칸·양쪽 풂·읽기 다름)`, bad.length === 0, bad.length === 0 ? `${cases.length + 1}/${cases.length + 1}` : bad.map((c) => `${c.a}~${c.b}(${c.why})`).join(", "));
  }

  // ---- 무작위 1: 구현 ↔ 독립 참조 모델 (합성 표기 — 같은 한자가 여러 번 나오는 되돌아가기 경우까지) ----
  {
    const rng = makeRng(20260927);
    const alphabet = ["子", "供", "御", "風", "邪", "五", "本", "子", "ど", "も", "お", "ご", "ー"];
    const randWord = () => {
      const len = 1 + Math.floor(rng() * 6);
      let w = "";
      for (let i = 0; i < len; i++) w += alphabet[Math.floor(rng() * alphabet.length)];
      return w;
    };
    const TRIALS = 20000;
    let mismatch = 0;
    let first = "";
    let sameSeen = 0;
    let subseqSeen = 0;
    for (let t = 0; t < TRIALS; t++) {
      const a = randWord();
      const b = randWord();
      const x = { word: a, kana: "かな" };
      const y = { word: b, kana: "かな" };
      const got = isSameJaWord(x, y);
      const ref = referenceSameJaWord(x, y);
      if (got) sameSeen++;
      const ka = [...a].filter((c) => HAN_RE.test(c)).length;
      const kb = [...b].filter((c) => HAN_RE.test(c)).length;
      if (got && ka !== kb && ka > 0 && kb > 0) subseqSeen++;
      if (got !== ref || got !== isSameJaWord(y, x)) {
        mismatch++;
        if (!first) first = `${a}/${b} 구현=${got} 참조=${ref}`;
      }
    }
    add(
      `무작위 ${TRIALS}쌍(합성 표기): 구현 = 독립 참조 모델, 양방향 같음`,
      mismatch === 0 && subseqSeen > 0,
      `불일치 ${mismatch}${first ? ` 첫 사례 ${first}` : ""} · 같은 단어 ${sameSeen} · 그중 뼈대 길이가 다른 쌍 ${subseqSeen}`,
    );
  }

  // ---- 무작위 2: 실제 단어 풀의 모든 쌍 — 대칭·읽기 다름·한자 겹침 없음·이전 규칙 포함 ----
  const pool: { word: string; kana: string }[] = [];
  {
    const seen = new Set<string>();
    const push = (word: string, kana: string) => {
      const key = `${word}|${kana}`;
      if (!seen.has(key)) {
        seen.add(key);
        pool.push({ word, kana });
      }
    };
    for (const [a, b, k] of [...SAME_WORD_H, ...SAME_WORD_V, ...SAME_WORD_D, ...SAME_WORD_X]) {
      push(a, k);
      push(b, k);
      push(k, k); // 가나 표기
    }
    for (const [w, k] of [["本", "ほん"], ["林檎", "りんご"], ["リンゴ", "りんご"], ["一日", "いちにち"], ["一日", "ついたち"], ["約束", "やくそく"], ["パスポート", "ぱすぽーと"]] as const) push(w, k);
  }
  {
    const viol: Record<string, string[]> = { 비대칭: [], "읽기·표기 다른데 같음": [], "한자 겹침 없는데 같음": [], "이전 규칙이 같다던 쌍을 다르다 함": [] };
    const kanjiSet = (w: string) => new Set([...normalizeJaWord(w)].filter((c) => HAN_RE.test(c)));
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const a = pool[i];
        const b = pool[j];
        const ab = isSameJaWord(a, b);
        const tag = `${a.word}(${a.kana})/${b.word}(${b.kana})`;
        if (ab !== isSameJaWord(b, a)) viol["비대칭"].push(tag);
        const wordEq = normalizeJaWord(a.word) === normalizeJaWord(b.word);
        const kanaEq = normalizeJaWord(a.kana) === normalizeJaWord(b.kana);
        if (ab && !wordEq && !kanaEq) viol["읽기·표기 다른데 같음"].push(tag);
        const sa = kanjiSet(a.word);
        const sb = kanjiSet(b.word);
        const disjoint = sa.size > 0 && sb.size > 0 && ![...sa].some((c) => sb.has(c));
        if (ab && !wordEq && disjoint) viol["한자 겹침 없는데 같음"].push(tag);
        const oldRule = wordEq || (kanaEq && (KANA_ONLY_RE.test(normalizeJaWord(a.word)) || KANA_ONLY_RE.test(normalizeJaWord(b.word))));
        if (oldRule && !ab) viol["이전 규칙이 같다던 쌍을 다르다 함"].push(tag);
      }
    }
    const pairs = (pool.length * (pool.length - 1)) / 2;
    for (const [name, list] of Object.entries(viol)) {
      add(`단어 풀 ${pool.length}개의 모든 쌍(${pairs}): ${name} 0건`, list.length === 0, list.length === 0 ? "0" : `${list.length}건 — ${list.slice(0, 5).join(" ")}`);
    }
  }

  // ---- 무작위 3: 후처리 불변식 (zod 제약 — 같은 배치 표기 중복 없음 — 을 지키는 입력) ----
  {
    const rng = makeRng(927);
    const pick = <T,>(xs: readonly T[], n: number): T[] => {
      const a = [...xs];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a.slice(0, n);
    };
    const KO = ["가", "나", "다", "라"];
    const TRIALS = 5000;
    const viol: Record<string, string> = {};
    const note = (k: string, d: string) => {
      if (!(k in viol)) viol[k] = d;
    };
    for (let t = 0; t < TRIALS; t++) {
      // 같은 표기는 한 번만(zod가 같은 word를 거부한다)
      const chosen: { word: string; kana: string }[] = [];
      for (const p of pick(pool, 1 + Math.floor(rng() * 8))) if (!chosen.some((c) => normalizeJaWord(c.word) === normalizeJaWord(p.word))) chosen.push(p);
      const koLines = rng() < 0.5 ? pick(KO, 1 + Math.floor(rng() * 3)) : [];
      const koAt = pick(chosen.map((_, i) => i), koLines.length);
      const entries = chosen.map((p, i) => {
        const kj = koAt.indexOf(i);
        return jw(p.word, p.kana, { fromKo: kj >= 0 && rng() < 0.85 ? koLines[kj] : null });
      });
      const include = pick(pool.map((p) => p.word), Math.floor(rng() * 3));
      const exclude = pick(pool, Math.floor(rng() * 6));
      const r = applyVocabPostprocess({ entries, level: "N4", include, includeKo: koLines, exclude });
      const d = `in=[${words(entries)}] inc=[${include}] ko=[${koLines}] ex=[${words(exclude)}] → [${words(r.entries)}]`;
      const inc = new Set(include.map(normalizeJaWord));
      for (let i = 0; i < r.entries.length; i++) for (let j = i + 1; j < r.entries.length; j++) if (isSameJaWord(r.entries[i], r.entries[j])) note("I1 남은 항목끼리 같은 단어", d);
      for (const e of r.entries) if (!inc.has(normalizeJaWord(e.word)) && exclude.some((x) => isSameJaWord(e, x))) note("I2 일본어 include 아닌 제외 대상이 남음", d);
      for (const k of koLines) {
        const c = r.koConverted.filter((m) => m.ko === k).length + r.koExcluded.filter((m) => m.ko === k).length + r.missingIncludes.filter((m) => m === k).length;
        if (c !== 1) note("I3 한국어 줄이 정확히 한 곳에 보고되지 않음", d);
      }
      for (const m of r.koConverted) {
        const src = entries.find((e) => e.fromKo === m.ko);
        if (!r.entries.some((e) => e.word === m.word && e.kana === m.kana)) note("I4a koConverted가 결과에 없는 항목을 가리킴", d);
        if (src && !isSameJaWord(src, m)) note("I4b koConverted가 다른 단어를 가리킴", d);
      }
      for (const m of r.koExcluded) if (!exclude.some((x) => isSameJaWord(m, x))) note("I5 koExcluded인데 제외 목록에 같은 단어 없음", d);
      if (r.filteredCount !== entries.length - r.entries.length) note("I6 filteredCount ≠ 입력 − 출력", d);
      for (const e of entries) {
        if (r.entries.some((x) => x.word === e.word && x.kana === e.kana)) continue;
        const byEx = !inc.has(normalizeJaWord(e.word)) && exclude.some((x) => isSameJaWord(e, x));
        const byFold = r.entries.some((x) => isSameJaWord(e, x));
        if (!byEx && !byFold) note("I7 이유 없이 빠진 항목", d);
      }
      for (const e of entries) if (inc.has(normalizeJaWord(e.word)) && !r.entries.some((x) => isSameJaWord(e, x))) note("I8 일본어 include가 사라짐", d);
    }
    const keys = Object.keys(viol);
    add(`무작위 후처리 ${TRIALS}회(실제 단어 풀·한국어 줄·include·제외): 불변식 I1~I8 위반 0`, keys.length === 0, keys.length === 0 ? "0" : keys.map((k) => `${k}: ${viol[k]}`).join(" | "));
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
    const msg = buildJaVocabUserMessage({ level: "N2", topic: "여행(호텔)", count: 10, include: ["約束", "水"], includeKo: [], exclude: [{ word: "本", kana: "ほん" }] });
    const ok =
      msg.includes("레벨: N2") &&
      msg.includes("주제: 여행(호텔)") &&
      msg.includes("개수: 10") &&
      msg.includes("꼭 넣을 단어(일본어 표기 그대로, 읽기·뜻·예문은 네가 채운다): 約束, 水") &&
      msg.includes("꼭 넣을 단어(한국어 뜻 — 이 뜻의 일본어 단어로 바꿔 넣는다): 없음") &&
      msg.includes("이미 가지고 있는 단어(내지 말 것): 本(ほん)") &&
      !msg.includes("{"); // 플레이스홀더가 남지 않았다
    add("치환: 레벨·주제·개수·include·exclude 채움, 플레이스홀더 잔존 없음", ok, ok ? "정상" : JSON.stringify(msg));
  }

  {
    const msg = buildJaVocabUserMessage({ level: "N5", topic: null, count: 10, include: [], includeKo: [], exclude: [] });
    const ok = msg.includes("주제: 없음(레벨 전반)") && msg.includes("꼭 넣을 단어(일본어 표기 그대로, 읽기·뜻·예문은 네가 채운다): 없음") && msg.includes("꼭 넣을 단어(한국어 뜻 — 이 뜻의 일본어 단어로 바꿔 넣는다): 없음") && msg.includes("이미 가지고 있는 단어(내지 말 것): 없음");
    add("치환: 주제/​include/​includeKo/​exclude 없음 폴백", ok, ok ? "정상" : JSON.stringify(msg));
  }

  // 한국어 꼭 넣을 단어(2026-09-27) — 일본어 줄과 나뉜 한국어 줄에 쉼표로 들어간다(낱말 사이 공백 보존)
  {
    const msg = buildJaVocabUserMessage({ level: "N4", topic: null, count: 10, include: ["約束"], includeKo: ["여권", "비상구 표시"], exclude: [] });
    const ok =
      msg.includes("꼭 넣을 단어(일본어 표기 그대로, 읽기·뜻·예문은 네가 채운다): 約束") &&
      msg.includes("꼭 넣을 단어(한국어 뜻 — 이 뜻의 일본어 단어로 바꿔 넣는다): 여권, 비상구 표시") &&
      !msg.includes("{");
    add("치환: 한국어 include는 한국어 줄에(일본어 줄과 분리)", ok, ok ? "정상" : JSON.stringify(msg));
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
  // fromKo(2026-09-27): 첫 필드·required·["string","null"] — strict 모드 규약(선택 필드는 null 유니온)
  const required = schemaEnum.required as string[];
  const fromKoType = ((schemaEnum.properties as Record<string, unknown>).fromKo as Record<string, unknown> | undefined)?.type;
  add("JSON Schema fromKo: 첫 필드·required·string|null", required[0] === "fromKo" && Object.keys(schemaEnum.properties as object)[0] === "fromKo" && JSON.stringify(fromKoType) === JSON.stringify(["string", "null"]), `required[0]=${required[0]} type=${JSON.stringify(fromKoType)}`);

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

  // def-to-word: 문제=일일정의, 정답=표기. definitionJa null인 단어는 출제 제외(skip). 정의에 표제어 없음(듣기 안전)
  {
    const defEntries = [
      genEntry({ word: "本", kana: "ほん", definitionJa: "ページがたくさんあって、よむもの。" }),
      genEntry({ word: "水", kana: "みず", definitionJa: "のむための、つめたいもの。" }),
      genEntry({ word: "山", kana: "やま", definitionJa: null }), // 정의 없음 → 제외
    ];
    const { questions, skipped } = buildJaQuizQuestions(defEntries, { modes: ["def-to-word"], count: 5, rng: makeRng(6) });
    const q = questions.find((x) => x.word === "本");
    const ok =
      questions.length === 2 && // 山 제외
      skipped === 1 &&
      !questions.some((x) => x.word === "山") &&
      q?.prompt === "ページがたくさんあって、よむもの。" &&
      q?.answer === "本" &&
      (q?.choices.includes("本") ?? false) &&
      questions.every((x) => x.choices.includes(x.answer) && new Set(x.choices).size === x.choices.length) &&
      questions.every((x) => !x.prompt.includes(x.answer)); // 정의에 정답 표기 없음(듣기 안전)
    add("def-to-word: 문제=정의·정답=표기·null 제외(skip)·정답 미노출", ok, `출제=${questions.length}(기대 2) skip=${skipped}`);
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
  all.push(...runKoIncludeClassifierChecks());
  all.push(...runKoIncludeZodChecks());
  all.push(...runKoIncludePostprocessChecks());
  all.push(...runSameWordVariantChecks());
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
