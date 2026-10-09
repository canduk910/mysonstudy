/**
 * scripts/eval-phrase-helper.ts — 표현 도우미(과목 공통 — toeic·japanese·english-kid) 오프라인 검증 + spec-sync
 * (docs/harness/phrase-helper.md §11)
 *
 * - 오프라인(기본, 무비용): 상수·모델·입력 정리·로컬 판정·모드별 zod 반례·출력 다듬기·예문 포함 알림·진입 함수(입력 거부·로컬 판정은
 *   실제로 부른다 — 네트워크 0)·배선 소스 대조·신호 합치기·요청 옵션·JSON Schema strict 모양·번들 경계.
 * - spec-sync: 원문 4개(시스템 프롬프트 3 + 사용자 메시지 형식) block-exact 바이트 대조, JSON Schema 2개 의미 동치, 호출 옵션 문장.
 * - 실호출 점검은 게이트(EVAL_PHRASE=1)일 때만 — 모드마다 지어낸 입력 1개(3회). 비용이 드는 검증은 사용자 동의 후 오케스트레이터가 실행한다.
 *
 * 픽스처는 전부 지어낸 문장이다(공개 저장소 — 교재 원문을 옮기지 않는다).
 * 안전: EVAL_OFFLINE_ONLY=1이면 네트워크 자체를 막는다(다른 eval과 같은 2차 방어선).
 *
 * 실행(오프라인):
 *   OPENAI_API_KEY= STORE_BACKEND=file GOOGLE_APPLICATION_CREDENTIALS= GOOGLE_CLOUD_PROJECT= EVAL_OFFLINE_ONLY=1 npm run eval:phrase
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  PHRASE_HELPER_INPUT_MAX,
  PHRASE_HELPER_INPUT_MESSAGES_KO,
  PHRASE_HELPER_JA_REGISTERS,
  PHRASE_HELPER_JA_REGISTER_LABELS_KO,
  PHRASE_HELPER_LOCAL_NOTES_KO,
  PHRASE_HELPER_MODES,
  PHRASE_HELPER_STATUSES,
  isPhraseHelperMode,
  normalizePhraseHelperInput,
  phraseHelperExampleCoverage,
  phraseHelperLocalResult,
  phraseHelperSpeechLang,
  type PhraseHelperEnOutput,
  type PhraseHelperJaOutput,
  type PhraseHelperMode,
  type PhraseHelperResult,
} from "../lib/phrase-helper";
import {
  PHRASE_HELPER_CALL_OPTIONS,
  PHRASE_HELPER_JAPANESE_SYSTEM_PROMPT,
  PHRASE_HELPER_KID_SYSTEM_PROMPT,
  PHRASE_HELPER_SDK_MAX_RETRIES,
  PHRASE_HELPER_SYSTEM_PROMPTS,
  PHRASE_HELPER_TIMEOUT_MS,
  PHRASE_HELPER_TOEIC_SYSTEM_PROMPT,
  PHRASE_HELPER_USER_TEMPLATE,
  PHRASE_HELPER_REASK_NOT_KOREAN_NOTE,
  PHRASE_HELPER_REASK_OUT_OF_SCOPE_NOTE,
  buildPhraseHelperReaskUserMessage,
  buildPhraseHelperUserMessage,
  phraseHelperReaskCallLabel,
  phraseHelperReaskReason,
  phraseHelperAbortSignal,
  phraseHelperCallLabel,
} from "../lib/ai/phrase-helper/prompts";
import {
  PHRASE_HELPER_EN_JSON_SCHEMA,
  PHRASE_HELPER_JA_JSON_SCHEMA,
  PHRASE_HELPER_JSON_SCHEMAS,
  PHRASE_HELPER_LIMITS,
  buildPhraseHelperEnZod,
  buildPhraseHelperJaZod,
  checkJaReading,
  finalizePhraseHelperEnOutput,
  finalizePhraseHelperJaOutput,
} from "../lib/ai/phrase-helper/schemas";
import { DEFAULT_PHRASE_HELPER_MODEL, resolvePhraseHelperModel } from "../lib/ai/phrase-helper/model";
import {
  PHRASE_HELPER_EXAM_PATHS,
  acquirePhraseHelperBlock,
  getPhraseHelperBlockCount,
  isPhraseHelperExamPath,
  phraseHelperModeForPath,
  phraseHelperVisibility,
  subscribePhraseHelperBlock,
} from "../lib/phrase-helper-scope";
import {
  PHRASE_HELPER_AUDIO_MAX_BYTES,
  PHRASE_HELPER_BODY_MAX_BYTES,
  PHRASE_HELPER_CLIENT_TIMEOUT_MS,
  PHRASE_HELPER_REC_MAX_MS,
  PHRASE_HELPER_REC_MIN_MS,
} from "../lib/phrase-helper-contract";
import {
  PHRASE_HELPER_TRANSCRIBE_LANGUAGE,
  PHRASE_HELPER_TRANSCRIBE_SDK_MAX_RETRIES,
  resolvePhraseHelperTranscribeModel,
  transcribeKorean,
} from "../lib/phrase-helper-transcribe";
import { resolveToeicTranscribeModel } from "../lib/toeic-transcribe";
import { checkSpecSync, extractSpecBlocks, printSpecSyncDetails, type SpecSyncOutcome, type SpecSyncTarget } from "./spec-sync";

// .env.local / .env 로드 (없으면 무시). 이미 설정된 환경 변수가 우선한다(빈 값으로 미리 둔 키는 덮지 않는다).
for (const envFile of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // 파일이 없으면 건너뛴다
  }
}

// 비용 게이트 — EVAL_OFFLINE_ONLY=1이면 네트워크 자체를 막는다.
if (process.env.EVAL_OFFLINE_ONLY === "1") {
  const blocked = () => {
    throw new Error("EVAL_OFFLINE_ONLY=1 — 네트워크 호출이 차단됐습니다. 오프라인 점검 앞에 실호출 코드가 들어왔습니다.");
  };
  globalThis.fetch = blocked as unknown as typeof fetch;
}

const SPEC_URL = new URL("../docs/harness/phrase-helper.md", import.meta.url);
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf-8");

// ---------------------------------------------------------------------------
// 결과 표
// ---------------------------------------------------------------------------

interface CheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
  skip?: boolean;
}

function printTable(results: CheckResult[]): void {
  console.log("");
  console.log(`| 결과 | ${"영역".padEnd(14)} | 점검 항목 | 상세 |`);
  console.log(`|------|----------------|-----------|------|`);
  for (const r of results) {
    const tag = r.skip ? "SKIP" : r.pass ? "PASS" : "FAIL";
    console.log(`| ${tag} | ${r.book.padEnd(14)} | ${r.check} | ${r.detail} |`);
  }
  console.log("");
}

function makeAdder(results: CheckResult[], book: string) {
  return (check: string, pass: boolean, detail = "") => results.push({ book, check, pass, detail });
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---------------------------------------------------------------------------
// 픽스처 (지어낸 것)
// ---------------------------------------------------------------------------

function toeicFixture(): PhraseHelperEnOutput {
  return {
    status: "ok",
    noteKo: null,
    main: { expression: "push the meeting back", usageKo: "회의 일정을 뒤로 미룰 때 가장 흔히 쓰는 말이에요." },
    alternatives: [{ expression: "postpone the meeting", noteKo: "조금 더 격식 있는 말이에요." }],
    examples: [
      { en: "We had to push the meeting back to next Tuesday afternoon.", ko: "회의를 다음 주 화요일 오후로 미뤄야 했어요." },
      { en: "Could we push the meeting back an hour because of the traffic?", ko: "차가 막혀서 회의를 한 시간 미룰 수 있을까요?" },
    ],
  };
}

function kidFixture(): PhraseHelperEnOutput {
  return {
    status: "ok",
    noteKo: null,
    main: { expression: "I really like it!", usageKo: "좋아하는 걸 말할 때 써요." },
    alternatives: [],
    examples: [
      { en: "I really like my new red bike.", ko: "나는 새 빨간 자전거가 정말 좋아." },
      { en: "I really like ice cream with my dad.", ko: "아빠랑 먹는 아이스크림이 정말 좋아." },
    ],
  };
}

function jaFixture(): PhraseHelperJaOutput {
  return {
    status: "ok",
    noteKo: null,
    main: { expression: "ちょっと待ってください", reading: "ちょっとまってください", register: "polite", usageKo: "상대에게 잠깐 기다려 달라고 정중하게 말할 때 써요." },
    alternatives: [{ expression: "ちょっと待って", reading: "ちょっとまって", register: "casual", noteKo: "친구나 가족에게 쓰는 반말이에요." }],
    examples: [
      { ja: "すみません、ちょっと待ってください。", reading: "すみません、ちょっとまってください。", ko: "죄송해요, 잠깐 기다려 주세요." },
      { ja: "店員さん、ちょっと待ってください。", reading: "てんいんさん、ちょっとまってください。", ko: "점원분, 잠깐만 기다려 주세요." },
    ],
  };
}

function notOk(status: "not_korean" | "out_of_scope", noteKo: string | null): PhraseHelperEnOutput {
  return { status, noteKo, main: null, alternatives: [], examples: [] };
}

// ---------------------------------------------------------------------------
// 1. 상수 · 모델
// ---------------------------------------------------------------------------

async function runConstantChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "상수·모델");
  add("모드 셋 순서(toeic·japanese·english-kid)", PHRASE_HELPER_MODES.join(",") === "toeic,japanese,english-kid", PHRASE_HELPER_MODES.join(","));
  add("isPhraseHelperMode: 셋만 참", PHRASE_HELPER_MODES.every(isPhraseHelperMode) && !isPhraseHelperMode("english") && !isPhraseHelperMode(null) && !isPhraseHelperMode("TOEIC"), "");
  add("🔊 언어: japanese → ja-JP, 나머지 en-US", phraseHelperSpeechLang("japanese") === "ja-JP" && phraseHelperSpeechLang("toeic") === "en-US" && phraseHelperSpeechLang("english-kid") === "en-US", "");
  add("call 라벨: phrase_helper_toeic·phrase_helper_japanese·phrase_helper_english_kid", PHRASE_HELPER_MODES.map(phraseHelperCallLabel).join(",") === "phrase_helper_toeic,phrase_helper_japanese,phrase_helper_english_kid", PHRASE_HELPER_MODES.map(phraseHelperCallLabel).join(","));
  add("모드 → 시스템 프롬프트(서로 다름)", PHRASE_HELPER_SYSTEM_PROMPTS.toeic === PHRASE_HELPER_TOEIC_SYSTEM_PROMPT && PHRASE_HELPER_SYSTEM_PROMPTS.japanese === PHRASE_HELPER_JAPANESE_SYSTEM_PROMPT && PHRASE_HELPER_SYSTEM_PROMPTS["english-kid"] === PHRASE_HELPER_KID_SYSTEM_PROMPT && new Set(Object.values(PHRASE_HELPER_SYSTEM_PROMPTS)).size === 3, "");
  add("모드 → JSON Schema(영어 둘 = phrase_helper_en, 일본어 = phrase_helper_ja)", PHRASE_HELPER_JSON_SCHEMAS.toeic === PHRASE_HELPER_EN_JSON_SCHEMA && PHRASE_HELPER_JSON_SCHEMAS["english-kid"] === PHRASE_HELPER_EN_JSON_SCHEMA && PHRASE_HELPER_JSON_SCHEMAS.japanese === PHRASE_HELPER_JA_JSON_SCHEMA, "");
  add("말투 넷 + 표시 이름", PHRASE_HELPER_JA_REGISTERS.join(",") === "casual,polite,formal,neutral" && PHRASE_HELPER_JA_REGISTERS.every((r) => PHRASE_HELPER_JA_REGISTER_LABELS_KO[r].length > 0), PHRASE_HELPER_JA_REGISTERS.map((r) => PHRASE_HELPER_JA_REGISTER_LABELS_KO[r]).join("·"));
  add("시간 상한 30초 · SDK 재시도 0", PHRASE_HELPER_TIMEOUT_MS === 30_000 && PHRASE_HELPER_SDK_MAX_RETRIES === 0, `${PHRASE_HELPER_TIMEOUT_MS} · ${PHRASE_HELPER_SDK_MAX_RETRIES}`);

  // 폭 ↔ 프롬프트 문장(개수) — 프롬프트 숫자와 zod 개수가 같은 값을 말하는가
  const countLine = (mode: PhraseHelperMode) => {
    const lim = PHRASE_HELPER_LIMITS[mode];
    const p = PHRASE_HELPER_SYSTEM_PROMPTS[mode];
    const alt = p.includes(`[alternatives — 다른 표현 0~${lim.alternativesMax}개]`);
    // zod 하한은 일부러 0이다(빈 예문을 거부하면 재요청 때 모델이 out_of_scope로 빠져나간다 — phrase-helper.md §15). 프롬프트 머리는 요청 개수를 말하고, 상한만 zod와 같아야 한다
    const ex = lim.examplesMin === 0 && (p.includes(`[examples — 예문 정확히 ${lim.examplesMax}개]`) || p.includes(`[examples — 예문 2~${lim.examplesMax}개]`));
    return alt && ex;
  };
  for (const m of PHRASE_HELPER_MODES) add(`개수 폭 == 프롬프트 머리(${m})`, countLine(m), JSON.stringify({ alt: PHRASE_HELPER_LIMITS[m].alternativesMax, ex: [PHRASE_HELPER_LIMITS[m].examplesMin, PHRASE_HELPER_LIMITS[m].examplesMax] }));

  // 모델 — 기본 gpt-6-luna, env 미설정·빈 값·공백 → 기본, OPENAI_MODEL을 따르지 않음
  const saved = process.env.OPENAI_PHRASE_HELPER_MODEL;
  const savedMain = process.env.OPENAI_MODEL;
  try {
    const got: string[] = [];
    process.env.OPENAI_MODEL = "gpt-x-main";
    for (const v of [undefined, "", "   "]) {
      if (v === undefined) delete process.env.OPENAI_PHRASE_HELPER_MODEL;
      else process.env.OPENAI_PHRASE_HELPER_MODEL = v;
      got.push(resolvePhraseHelperModel());
    }
    process.env.OPENAI_PHRASE_HELPER_MODEL = " gpt-x-phrase ";
    got.push(resolvePhraseHelperModel());
    add(
      "모델: 기본 gpt-6-luna · 미설정·빈 값·공백 → 기본(OPENAI_MODEL로 폴백 안 함) · 값은 앞뒤 공백을 걷어 그대로",
      DEFAULT_PHRASE_HELPER_MODEL === "gpt-6-luna" && got.join("|") === "gpt-6-luna|gpt-6-luna|gpt-6-luna|gpt-x-phrase",
      got.join("|"),
    );
  } finally {
    if (saved === undefined) delete process.env.OPENAI_PHRASE_HELPER_MODEL;
    else process.env.OPENAI_PHRASE_HELPER_MODEL = saved;
    if (savedMain === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = savedMain;
  }
  const { isKnownTemperatureRejectingModel, buildCallRequestOptions } = await import("../lib/ai/client");
  add("기본 모델은 temperature 자동 생략 대상(공유 래퍼가 처음부터 뺀다)", isKnownTemperatureRejectingModel(DEFAULT_PHRASE_HELPER_MODEL), "");
  const ac = new AbortController();
  const opts = buildCallRequestOptions({ signal: ac.signal, maxRetries: PHRASE_HELPER_SDK_MAX_RETRIES });
  add("요청 옵션 조립: maxRetries 0이 빠지지 않고 신호와 함께 실린다", !!opts && opts.maxRetries === 0 && opts.signal === ac.signal, JSON.stringify({ maxRetries: opts?.maxRetries, signal: !!opts?.signal }));

  // .env.example · SPEC §11 — env 한 줄
  add(".env.example에 OPENAI_PHRASE_HELPER_MODEL 줄", /^OPENAI_PHRASE_HELPER_MODEL=.*gpt-6-luna/m.test(read(".env.example")), "");
  add("SPEC §11 env 표에 OPENAI_PHRASE_HELPER_MODEL 줄", /^OPENAI_PHRASE_HELPER_MODEL=.*gpt-6-luna/m.test(read("docs/SPEC.md")), "");
  return results;
}

// ---------------------------------------------------------------------------
// 2. 입력 정리 · 로컬 판정 · 사용자 메시지
// ---------------------------------------------------------------------------

function runInputChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "입력 정리");
  const ok = (raw: unknown, want: string) => {
    const r = normalizePhraseHelperInput(raw);
    return r.ok && r.text === want;
  };
  const bad = (raw: unknown, reason: string) => {
    const r = normalizePhraseHelperInput(raw);
    return !r.ok && r.reason === reason && r.messageKo === PHRASE_HELPER_INPUT_MESSAGES_KO[r.reason];
  };
  add("앞뒤 공백·줄바꿈·탭 → 공백 하나", ok("  회의를\n다음 주로\t미루다  ", "회의를 다음 주로 미루다"), "");
  add("연속 공백 접기", ok("잠깐만    기다려", "잠깐만 기다려"), "");
  add("너비 0 문자·BOM 삭제", ok("\uFEFF회\u200B의\u200D", "회의"), "");
  add("제어문자 → 공백(삭제 아님 — 낱말이 붙지 않게)", ok("사과\u0007주스", "사과 주스") && ok("\u0000종", "종"), "");
  add("NFD 한글 → NFC", ok("회의".normalize("NFD"), "회의"), "");
  add("빈 값·공백만·보이지 않는 문자만 → empty", bad("", "empty") && bad("   \n\t ", "empty") && bad("\u200B\uFEFF", "empty"), "");
  add("문자열 아님 → not_text", bad(123, "not_text") && bad(null, "not_text") && bad(undefined, "not_text") && bad({ text: "a" }, "not_text"), "");
  add(`상한 ${PHRASE_HELPER_INPUT_MAX}자 통과 · ${PHRASE_HELPER_INPUT_MAX + 1}자 too_long(자르지 않는다)`, ok("가".repeat(PHRASE_HELPER_INPUT_MAX), "가".repeat(PHRASE_HELPER_INPUT_MAX)) && bad("가".repeat(PHRASE_HELPER_INPUT_MAX + 1), "too_long"), "");
  add("이모지는 코드 포인트 한 글자(200개 통과 — 문자열 길이 400)", ok("😀".repeat(200), "😀".repeat(200)) && bad("😀".repeat(201), "too_long"), "");
  add("정리 뒤에 잰다(공백 덩어리 때문에 거부되지 않는다)", ok(`${" ".repeat(300)}가${" ".repeat(300)}`, "가"), "");
  add("멱등 — 정리한 글을 다시 정리해도 같다", (() => {
    const a = normalizePhraseHelperInput("  a\n\nb \u200B c ");
    if (!a.ok) return false;
    const b = normalizePhraseHelperInput(a.text);
    return b.ok && b.text === a.text;
  })(), "");
  add("입력 거부 문구 셋(빈 값 없음)", Object.values(PHRASE_HELPER_INPUT_MESSAGES_KO).every((s) => s.length > 0) && PHRASE_HELPER_INPUT_MESSAGES_KO.too_long.includes(String(PHRASE_HELPER_INPUT_MAX)), "");

  const add2 = makeAdder(results, "로컬 판정");
  for (const m of PHRASE_HELPER_MODES) {
    const r = phraseHelperLocalResult(m, "hello there");
    add2(
      `한글 없음 → not_korean·local·model null·빈 결과·모드 안내(${m})`,
      !!r && r.mode === m && r.status === "not_korean" && r.source === "local" && r.model === null && r.main === null && r.alternatives.length === 0 && r.examples.length === 0 && r.noteKo === PHRASE_HELPER_LOCAL_NOTES_KO[m] && r.input === "hello there",
      r ? r.noteKo ?? "" : "null",
    );
  }
  add2("한자만(勉強)·숫자만도 한글이 없으면 로컬", phraseHelperLocalResult("japanese", "勉強")?.status === "not_korean" && phraseHelperLocalResult("toeic", "12345")?.status === "not_korean", "");
  add2("한글이 섞이면 모델(회의 reschedule)·자모만(ㅋㅋ)도 모델·완성형 한 글자도 모델", phraseHelperLocalResult("toeic", "회의 reschedule") === null && phraseHelperLocalResult("english-kid", "ㅋㅋ") === null && phraseHelperLocalResult("japanese", "밥") === null, "");
  const spec = readFileSync(SPEC_URL, "utf-8");
  add2("모드별 안내 문구 == 스펙 §2-2 표 글자", PHRASE_HELPER_MODES.every((m) => spec.includes(`| \`${m}\` | ${PHRASE_HELPER_LOCAL_NOTES_KO[m]} |`)), "");

  const add3 = makeAdder(results, "사용자 메시지");
  add3("입력: {input} 치환", buildPhraseHelperUserMessage("회의를 미루다") === "입력: 회의를 미루다", "");
  add3("한 번만 치환·$ 패턴 해석 안 함", buildPhraseHelperUserMessage("a {input} $& $1 b") === "입력: a {input} $& $1 b", buildPhraseHelperUserMessage("a {input} $& $1 b"));
  add3("템플릿 자리 하나뿐", (PHRASE_HELPER_USER_TEMPLATE.match(/\{[a-zA-Z]+\}/g) ?? []).join(",") === "{input}", "");
  return results;
}

// ---------------------------------------------------------------------------
// 3. zod 반례 (모드별)
// ---------------------------------------------------------------------------

type Mut<T> = (v: T) => void;

function runZodChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const toeicZ = buildPhraseHelperEnZod("toeic");
  const kidZ = buildPhraseHelperEnZod("english-kid");
  const jaZ = buildPhraseHelperJaZod();

  const caseEn = (book: string, z: typeof toeicZ, base: () => PhraseHelperEnOutput) => {
    const add = makeAdder(results, book);
    const passes = (name: string, mut: Mut<PhraseHelperEnOutput> = () => {}) => {
      const v = base();
      mut(v);
      const r = z.safeParse(v);
      add(`통과: ${name}`, r.success, r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    };
    const rejects = (name: string, mut: Mut<PhraseHelperEnOutput>, pathHint?: string) => {
      const v = base();
      mut(v);
      const r = z.safeParse(v);
      const hit = !r.success && (!pathHint || r.error.issues.some((i) => i.path.join(".").startsWith(pathHint)));
      add(`거부: ${name}`, hit, r.success ? "통과해 버림" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 3).join("; "));
    };
    return { passes, rejects };
  };

  // ── toeic ──
  {
    const { passes, rejects } = caseEn("zod toeic", toeicZ, toeicFixture);
    passes("픽스처");
    passes("예문 3개", (v) => v.examples.push({ en: "I'd like to push the meeting back until the report is ready.", ko: "보고서가 준비될 때까지 회의를 미루고 싶어요." }));
    passes("대안 0개", (v) => (v.alternatives = []));
    passes("대안 2개", (v) => v.alternatives.push({ expression: "move the meeting to later", noteKo: "일정을 옮긴다는 느낌이 더 강해요." }));
    passes("뜻이 갈린 입력의 noteKo(한글)", (v) => (v.noteKo = "과일 뜻으로 풀었어요."));
    passes("예문에 main이 그대로 없어도(활용형) 통과 — 강제하지 않는다", (v) => (v.examples[0].en = "They pushed our meeting back again this morning, sadly."));
    passes("not_korean + 안내", (v) => Object.assign(v, notOk("not_korean", "한국어로 넣어 주세요.")));
    passes("out_of_scope + 안내", (v) => Object.assign(v, notOk("out_of_scope", "이 도우미는 한국어를 영어 표현으로 바꿔 줘요.")));
    passes("빈 examples도 통과(ok인데 예문을 빠뜨린 응답 — 거부하면 재요청 때 거절로 빠진다)", (v) => (v.examples = []));
    passes("예문 1개도 통과", (v) => v.examples.pop());
    rejects("예문 4개", (v) => {
      v.examples.push({ en: "Let's push the meeting back so everyone can join us.", ko: "모두 올 수 있게 회의를 미뤄요." });
      v.examples.push({ en: "My boss asked me to push the meeting back a little.", ko: "상사가 회의를 조금 미뤄 달라고 했어요." });
    }, "examples");
    rejects("대안 3개", (v) => {
      v.alternatives.push({ expression: "move the meeting", noteKo: "옮긴다는 느낌이에요." });
      v.alternatives.push({ expression: "delay the meeting", noteKo: "늦춘다는 느낌이에요." });
    }, "alternatives");
    rejects("main 표현 빈 문자열", (v) => (v.main!.expression = "  "), "main.expression");
    rejects("main 표현에 한글", (v) => (v.main!.expression = "push the 회의 back"), "main.expression");
    rejects("main 표현이 라틴 없음", (v) => (v.main!.expression = "!!!"), "main.expression");
    rejects("자리 표시 ~", (v) => (v.main!.expression = "look forward to ~"), "main.expression");
    rejects("자리 표시 sb", (v) => (v.main!.expression = "give sb a hand"), "main.expression");
    rejects("자리 표시 sth(대안)", (v) => (v.alternatives[0].expression = "put sth off"), "alternatives.0.expression");
    rejects("main 41단어", (v) => (v.main!.expression = Array.from({ length: 41 }, () => "word").join(" ")), "main.expression");
    rejects("usageKo 한글 없음", (v) => (v.main!.usageKo = "used when delaying"), "main.usageKo");
    rejects("usageKo 빈 값", (v) => (v.main!.usageKo = ""), "main.usageKo");
    rejects("usageKo 121자", (v) => (v.main!.usageKo = "가".repeat(121)), "main.usageKo");
    rejects("예문 너무 김(26단어)", (v) => (v.examples[0].en = Array.from({ length: 26 }, () => "meeting").join(" ")), "examples.0.en");
    rejects("예문 너무 짧음(4단어)", (v) => (v.examples[0].en = "Push it back, please."), "examples.0.en");
    rejects("예문 빈 문자열", (v) => (v.examples[1].en = ""), "examples.1.en");
    rejects("예문에 한글", (v) => (v.examples[0].en = "We had to push the 회의 back to next Tuesday."), "examples.0.en");
    rejects("예문 해석 한글 없음", (v) => (v.examples[0].ko = "We delayed it."), "examples.0.ko");
    rejects("같은 예문 되풀이(대소문자·문장부호만 다름)", (v) => (v.examples[1].en = v.examples[0].en.toUpperCase().replace(".", "!")), "examples.1");
    rejects("대안이 main과 같음(대소문자만 다름)", (v) => (v.alternatives[0].expression = "Push the meeting back."), "alternatives.0.expression");
    rejects("대안 noteKo 한글 없음", (v) => (v.alternatives[0].noteKo = "more formal"), "alternatives.0.noteKo");
    rejects("ok인데 main null", (v) => (v.main = null), "main");
    rejects("ok인데 noteKo가 영어만", (v) => (v.noteKo = "fruit sense"), "noteKo");
    rejects("ok인데 noteKo 빈 문자열", (v) => (v.noteKo = ""), "noteKo");
    rejects("not_korean인데 main 있음", (v) => { v.status = "not_korean"; v.noteKo = "한국어로 넣어 주세요."; }, "main");
    rejects("not_korean인데 noteKo null", (v) => Object.assign(v, notOk("not_korean", null)), "noteKo");
    rejects("out_of_scope인데 예문 남음", (v) => { Object.assign(v, notOk("out_of_scope", "도와줄 수 없어요.")); v.examples = toeicFixture().examples; }, "examples");
    rejects("out_of_scope 안내 151자", (v) => Object.assign(v, notOk("out_of_scope", "가".repeat(151))), "noteKo");
    rejects("JSON Schema 밖 키(strict)", (v) => ((v as unknown as Record<string, unknown>).extra = 1));
    rejects("status 모르는 값", (v) => ((v as unknown as Record<string, unknown>).status = "maybe"));
  }

  // ── english-kid ──
  {
    const { passes, rejects } = caseEn("zod kid", kidZ, kidFixture);
    passes("픽스처");
    passes("대안 1개", (v) => v.alternatives.push({ expression: "I love it!", noteKo: "더 많이 좋아할 때 써요." }));
    passes("out_of_scope + 부드러운 안내", (v) => Object.assign(v, notOk("out_of_scope", "이 말은 도와줄 수 없어요. 다른 말을 넣어 볼까요?")));
    rejects("대안 2개", (v) => {
      v.alternatives.push({ expression: "I love it!", noteKo: "더 많이 좋아할 때 써요." });
      v.alternatives.push({ expression: "It's my favorite!", noteKo: "제일 좋아할 때 써요." });
    }, "alternatives");
    rejects("예문 3개(정확히 2)", (v) => v.examples.push({ en: "I really like playing with my puppy.", ko: "강아지랑 노는 게 정말 좋아." }), "examples");
    passes("예문 1개도 통과(하한 0)", (v) => v.examples.pop());
    rejects("예문 13단어(아이에게 김)", (v) => (v.examples[0].en = "I really like it when we all go to the big park together."), "examples.0.en");
    rejects("main 21단어", (v) => (v.main!.expression = Array.from({ length: 21 }, () => "fun").join(" ")), "main.expression");
    rejects("usageKo 81자", (v) => (v.main!.usageKo = "가".repeat(81)), "main.usageKo");
    rejects("안내 101자", (v) => Object.assign(v, notOk("out_of_scope", "가".repeat(101))), "noteKo");
  }

  // ── japanese ──
  {
    const add = makeAdder(results, "zod japanese");
    const passes = (name: string, mut: Mut<PhraseHelperJaOutput> = () => {}) => {
      const v = jaFixture();
      mut(v);
      const r = jaZ.safeParse(v);
      add(`통과: ${name}`, r.success, r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    };
    const rejects = (name: string, mut: Mut<PhraseHelperJaOutput>, pathHint?: string) => {
      const v = jaFixture();
      mut(v);
      const r = jaZ.safeParse(v);
      const hit = !r.success && (!pathHint || r.error.issues.some((i) => i.path.join(".").startsWith(pathHint)));
      add(`거부: ${name}`, hit, r.success ? "통과해 버림" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 3).join("; "));
    };
    passes("픽스처");
    passes("가타카나는 그대로 둔 읽기(コーヒーをください)", (v) => { v.main!.expression = "コーヒーをください"; v.main!.reading = "コーヒーをください"; });
    passes("한자+가타카나 섞임 — 가타카나 그대로(駅のトイレ → えきのトイレ)", (v) => { v.main!.expression = "駅のトイレ"; v.main!.reading = "えきのトイレ"; v.main!.register = "neutral"; });
    passes("숫자가 든 표현은 읽기를 히라가나로(3時 → さんじ)", (v) => { v.main!.expression = "3時に会いましょう"; v.main!.reading = "さんじにあいましょう"; });
    passes("가나만인 표현의 읽기 — 공백·문장부호 차이는 무시", (v) => { v.alternatives[0].expression = "はい、そうです。"; v.alternatives[0].reading = "はい そうです"; });
    passes("not_korean + 안내", (v) => Object.assign(v, { status: "not_korean", noteKo: "한국어로 넣어 주세요.", main: null, alternatives: [], examples: [] }));
    rejects("읽기에 한자", (v) => (v.main!.reading = "ちょっと待ってください"), "main.reading");
    rejects("읽기에 로마자(가나와 섞임)", (v) => (v.main!.reading = "ちょっと matte ください"), "main.reading");
    rejects("읽기에 숫자", (v) => { v.main!.expression = "3時に会いましょう"; v.main!.reading = "3じにあいましょう"; }, "main.reading");
    rejects("읽기에 한글", (v) => (v.main!.reading = "ちょっと마떼"), "main.reading");
    rejects("읽기 빈 값", (v) => (v.main!.reading = " "), "main.reading");
    rejects("가타카나를 히라가나로 바꾼 읽기(コーヒー → こーひー)", (v) => { v.main!.expression = "コーヒーをください"; v.main!.reading = "こーひーをください"; }, "main.reading");
    rejects("가나만인 표현의 다른 읽기", (v) => { v.alternatives[0].expression = "ありがとう"; v.alternatives[0].reading = "ありがと"; }, "alternatives.0.reading");
    rejects("예문 읽기에 한자", (v) => (v.examples[1].reading = "店員さん、ちょっとまってください。"), "examples.1.reading");
    rejects("표현에 한글", (v) => (v.main!.expression = "ちょっと기다려"), "main.expression");
    rejects("표현이 일본어 아님(영어)", (v) => { v.main!.expression = "wait a moment"; v.main!.reading = "うぇいと"; }, "main.expression");
    rejects("자리 표시 ～", (v) => { v.main!.expression = "～てください"; v.main!.reading = "～てください"; }, "main.expression");
    rejects("말투 모르는 값", (v) => ((v.main as unknown as Record<string, unknown>).register = "rude"));
    rejects("예문 4개", (v) => {
      v.examples.push({ ja: "先生、ちょっと待ってください。", reading: "せんせい、ちょっとまってください。", ko: "선생님, 잠깐 기다려 주세요." });
      v.examples.push({ ja: "駅で、ちょっと待ってください。", reading: "えきで、ちょっとまってください。", ko: "역에서 잠깐 기다려 주세요." });
    }, "examples");
    passes("빈 examples도 통과(하한 0)", (v) => (v.examples = []));
    rejects("대안 3개", (v) => {
      v.alternatives.push({ expression: "少々お待ちください", reading: "しょうしょうおまちください", register: "formal", noteKo: "가게 직원이 쓰는 공손한 말이에요." });
      v.alternatives.push({ expression: "待ってね", reading: "まってね", register: "casual", noteKo: "부드러운 반말이에요." });
    }, "alternatives");
    rejects("대안이 main과 같음(문장부호만 다름)", (v) => { v.alternatives[0].expression = "ちょっと待ってください。"; v.alternatives[0].reading = "ちょっとまってください。"; }, "alternatives.0.expression");
    rejects("예문 61자", (v) => { v.examples[0].ja = "あ".repeat(61); v.examples[0].reading = "あ".repeat(61); }, "examples.0.ja");
    rejects("예문 3자", (v) => { v.examples[0].ja = "待って"; v.examples[0].reading = "まって"; }, "examples.0.ja");
    rejects("예문에 한글", (v) => { v.examples[0].ja = "すみません、잠깐 待ってください。"; }, "examples.0.ja");
    rejects("같은 예문 되풀이", (v) => { v.examples[1] = clone(v.examples[0]); }, "examples.1");
    rejects("usageKo 한글 없음", (v) => (v.main!.usageKo = "polite request"), "main.usageKo");
    rejects("ok인데 main null", (v) => (v.main = null), "main");
  }

  // 판정 함수 직접(읽기)
  const add = makeAdder(results, "일본어 읽기 판정");
  add("checkJaReading: 한자 표현 + 히라가나 읽기 → null", checkJaReading("勉強します", "べんきょうします") === null, "");
  add("checkJaReading: 반각 가타카나 표현은 그대로 같은 글자면 통과", checkJaReading("ｺｰﾋｰ", "ｺｰﾋｰ") === null, String(checkJaReading("ｺｰﾋｰ", "ｺｰﾋｰ")));
  add("checkJaReading: 전각 숫자도 숫자", checkJaReading("３時", "３じ") !== null, "");
  add("checkJaReading: 전각 로마자도 로마자", checkJaReading("ＯＫです", "ＯＫです") !== null, "");
  return results;
}

// ---------------------------------------------------------------------------
// 4. 출력 다듬기 · 예문 포함 알림
// ---------------------------------------------------------------------------

function runPostChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "다듬기·알림");
  const messy = toeicFixture();
  messy.main!.expression = "  push   the meeting\nback ";
  messy.examples[0].ko = " 회의를  미뤘어요. ";
  messy.noteKo = "  과일 뜻으로  풀었어요 ";
  const f = finalizePhraseHelperEnOutput(messy);
  add("영어: 앞뒤 공백·연속 공백 정리, 구조·개수 그대로", f.main!.expression === "push the meeting back" && f.examples[0].ko === "회의를 미뤘어요." && f.noteKo === "과일 뜻으로 풀었어요" && f.examples.length === 2 && f.alternatives.length === 1, JSON.stringify(f.main));
  const j = jaFixture();
  j.main!.reading = " ちょっと まってください ";
  const fj = finalizePhraseHelperJaOutput(j);
  add("일본어: 읽기 다듬기·말투 보존", fj.main!.reading === "ちょっと まってください" && fj.main!.register === "polite" && fj.alternatives[0].register === "casual", fj.main!.reading);
  add("다듬기는 null noteKo를 그대로 둔다", finalizePhraseHelperEnOutput(toeicFixture()).noteKo === null, "");
  add("다듬은 결과도 zod 통과(멱등)", buildPhraseHelperEnZod("toeic").safeParse(f).success && buildPhraseHelperJaZod().safeParse(fj).success, "");

  const asResult = (mode: PhraseHelperMode, out: PhraseHelperEnOutput | PhraseHelperJaOutput): PhraseHelperResult =>
    ({ ...out, mode, input: "x", source: "ai", model: "m" }) as PhraseHelperResult;
  const cov = (mode: PhraseHelperMode, main: string, examples: string[]) => {
    if (mode === "japanese") {
      const out = jaFixture();
      out.main!.expression = main;
      out.examples = examples.map((ja) => ({ ja, reading: "あ", ko: "가" }));
      return phraseHelperExampleCoverage(asResult(mode, out));
    }
    const out = toeicFixture();
    out.main!.expression = main;
    out.examples = examples.map((en) => ({ en, ko: "가" }));
    return phraseHelperExampleCoverage(asResult(mode, out));
  };
  const c1 = cov("toeic", "push the meeting back", ["We had to push the meeting back again.", "Let's talk about it later today."]);
  add("영어: 그대로 든 예문만 센다", c1.covered === 1 && c1.total === 2, JSON.stringify(c1));
  const c2 = cov("toeic", "look forward to it", ["I'm really looking forward to the trip.", "I look forward to it every week."]);
  add("영어: 활용형(looking forward)도 담은 것으로 본다", c2.covered === 2, JSON.stringify(c2));
  const c3 = cov("english-kid", "I really like it!", ["I like my dog a lot."]);
  add("영어: 핵심 낱말(really)이 빠지면 담지 않은 것", c3.covered === 0, JSON.stringify(c3));
  const c4 = cov("japanese", "待つ", ["ここで待ってね。", "駅に行きます。"]);
  add("일본어: 활용(待つ → 待って)은 끝 글자를 뗀 앞부분으로 본다", c4.covered === 1 && c4.total === 2, JSON.stringify(c4));
  const c5 = cov("japanese", "ちょっと待ってください", ["すみません、ちょっと待ってください。"]);
  add("일본어: 문장부호를 걷고 그대로 포함", c5.covered === 1, JSON.stringify(c5));
  const local = phraseHelperLocalResult("toeic", "hello");
  add("ok가 아닌 결과는 {0, 0}", !!local && JSON.stringify(phraseHelperExampleCoverage(local)) === JSON.stringify({ covered: 0, total: 0 }), "");
  return results;
}

// ---------------------------------------------------------------------------
// 5. 진입 함수 — 네트워크 없이 도는 갈래를 실제로 부른다 + 배선 소스 대조 + 신호
// ---------------------------------------------------------------------------

async function runEntryChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "진입 함수");
  const { explainPhrase, isPhraseHelperInputError } = await import("../lib/ai/phrase-helper/calls");

  for (const [raw, code] of [["   ", "empty"], ["가".repeat(201), "too_long"]] as const) {
    try {
      await explainPhrase("toeic", raw);
      add(`입력 거부(${code}) → PhraseHelperInputError(AI 0)`, false, "던지지 않음");
    } catch (e) {
      add(`입력 거부(${code}) → PhraseHelperInputError(AI 0)`, isPhraseHelperInputError(e) && e.code === code && e.messageKo === PHRASE_HELPER_INPUT_MESSAGES_KO[code], e instanceof Error ? e.message : String(e));
    }
  }
  for (const m of PHRASE_HELPER_MODES) {
    try {
      const r = await explainPhrase(m, "  see you\nlater ");
      add(`한글 없음 → 키 없이도 로컬 결과(${m})`, r.source === "local" && r.status === "not_korean" && r.mode === m && r.input === "see you later" && r.model === null, `${r.source} ${r.status}`);
    } catch (e) {
      add(`한글 없음 → 키 없이도 로컬 결과(${m})`, false, e instanceof Error ? e.message : String(e));
    }
  }
  if (!process.env.OPENAI_API_KEY) {
    try {
      await explainPhrase("toeic", "회의를 미루다");
      add("한글 입력 + 키 없음 → 던진다(네트워크 전 — 라우트는 그 전에 501)", false, "던지지 않음");
    } catch (e) {
      add("한글 입력 + 키 없음 → 던진다(네트워크 전 — 라우트는 그 전에 501)", e instanceof Error && /OPENAI_API_KEY/.test(e.message), e instanceof Error ? e.message : String(e));
    }
  } else {
    results.push({ book: "진입 함수", check: "한글 입력 + 키 없음 → 던진다", pass: true, skip: true, detail: "OPENAI_API_KEY가 있어 건너뜀(실호출 방지 — 안전 접두어로 키를 비우고 돌린다)" });
  }

  // 배선(소스 대조) — 오프라인 게이트가 fetch를 막아 AI 갈래를 태울 수 없어서 소스로 잠근다
  const src = read("lib/ai/phrase-helper/calls.ts");
  const body = src.slice(src.indexOf("export async function explainPhrase"));
  const iNorm = body.indexOf("normalizePhraseHelperInput(input)");
  const iLocal = body.indexOf("phraseHelperLocalResult(mode, text)");
  const iCall = body.indexOf("await ask(common)");
  add("순서: 입력 정리 → 로컬 판정 → 첫 호출(ask) · 운영 진입 함수는 explainPhraseWith(callWithSchema, …)", iNorm > 0 && iLocal > iNorm && iCall > iLocal && /return explainPhraseWith\(callWithSchema, mode, input, options\);/.test(body), `${iNorm}/${iLocal}/${iCall}`);
  add("모델 = resolvePhraseHelperModel()(resolveModel 안 씀)", /const model = resolvePhraseHelperModel\(\);/.test(body) && !/resolveModel\(/.test(src), "");
  add("신호 = phraseHelperAbortSignal(options.signal) · maxRetries = PHRASE_HELPER_SDK_MAX_RETRIES", /const signal = phraseHelperAbortSignal\(options\.signal\);/.test(body) && (body.match(/phraseHelperAbortSignal\(/g) ?? []).length === 1 && /\n    signal,\n/.test(body) && /maxRetries: PHRASE_HELPER_SDK_MAX_RETRIES/.test(body), "");
  add("모드별: system = PHRASE_HELPER_SYSTEM_PROMPTS[mode] · call = phraseHelperCallLabel(mode) · 사용자 메시지 = buildPhraseHelperUserMessage(text)", /system: PHRASE_HELPER_SYSTEM_PROMPTS\[mode\]/.test(body) && /call: phraseHelperCallLabel\(mode\)/.test(body) && /buildPhraseHelperUserMessage\(text\)/.test(body), "");
  add("일본어 = JA 스키마·JA zod·JA 다듬기 / 영어 = EN 스키마·buildPhraseHelperEnZod(mode)·EN 다듬기", /jsonSchema: PHRASE_HELPER_JA_JSON_SCHEMA, zodSchema: buildPhraseHelperJaZod\(\)/.test(body) && /finalizePhraseHelperJaOutput\(out\)/.test(body) && /jsonSchema: PHRASE_HELPER_EN_JSON_SCHEMA, zodSchema: buildPhraseHelperEnZod\(mode\)/.test(body) && /finalizePhraseHelperEnOutput\(out\)/.test(body), "");
  add("결과 = 다듬은 출력 + mode·input(정리한 글)·source ai·model", (body.match(/mode, input: text, source: "ai", model \}/g) ?? []).length === 2, "");
  const clientSrc = read("lib/ai/client.ts");
  add("lib/ai/client.ts에 표현 도우미 분기·진입 함수 없음(과목 공유 래퍼 불변)", !/phrase/i.test(clientSrc), "");
  const promptsSrc = read("lib/ai/phrase-helper/prompts.ts");
  const modelSrc = read("lib/ai/phrase-helper/model.ts");
  const schemasSrc = read("lib/ai/phrase-helper/schemas.ts");
  add("prompts·model·schemas는 openai·client.ts를 import하지 않는다(eval이 정적으로 import)", [promptsSrc, modelSrc, schemasSrc].every((s) => !/from\s+["'](openai|\.\.\/client)["']/.test(s)), "");

  // 신호 합치기
  const ac = new AbortController();
  const combined = phraseHelperAbortSignal(ac.signal, 60_000);
  const before = combined.aborted;
  ac.abort();
  add("요청 취소 신호가 끊기면 합친 신호도 끊긴다", !before && combined.aborted, "");
  const short = phraseHelperAbortSignal(null, 10);
  await new Promise((r) => setTimeout(r, 40));
  add("시간 상한이 지나면 끊긴다(외부 신호 없음)", short.aborted, "");
  return results;
}

// ---------------------------------------------------------------------------
// 5-1. 다시 묻기 (§14 — 2026-10-03 버그 수정) — 조건 표 + 가짜 호출 주입으로 결정 경로
// ---------------------------------------------------------------------------

async function runReaskChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "다시 묻기");
  const { explainPhraseWith } = await import("../lib/ai/phrase-helper/calls");

  // ① 조건 표 — 독립 참조 모델(스펙 §14-1 표를 그대로 옮긴 것)과 행마다 대조
  const inputs: [string, string][] = [["성수기", "완성형 한글"], ["ㅋㅋ", "자모만"], ["peak season", "한글 없음"]];
  const statuses = ["ok", "not_korean", "out_of_scope"] as const;
  const expected = (mode: PhraseHelperMode, kind: string, status: string): string | null => {
    if (kind !== "완성형 한글") return null;
    if (status === "not_korean") return "not_korean";
    if (status === "out_of_scope") return mode === "english-kid" ? null : "out_of_scope";
    return null;
  };
  const bad: string[] = [];
  let rows = 0;
  for (const m of PHRASE_HELPER_MODES) for (const [text, kind] of inputs) for (const st of statuses) {
    rows++;
    const got = phraseHelperReaskReason(m, text, st);
    if (got !== expected(m, kind, st)) bad.push(`${m}/${kind}/${st}: ${got}`);
  }
  add(`조건 표 ${rows}행(모드 3 × 입력 3 × status 3) == 스펙 §14-1`, bad.length === 0 && rows === 27, bad.join("; "));
  add("kid out_of_scope는 어떤 한국어 입력에도 되묻지 않는다", ["성수기", "나쁜 말", "무서운 꿈을 꿨어"].every((t) => phraseHelperReaskReason("english-kid", t, "out_of_scope") === null), "");
  add("되묻기 메시지 = §4 형식 + 빈 줄 + 이유별 덧붙임", buildPhraseHelperReaskUserMessage("출장", "not_korean") === `입력: 출장\n\n${PHRASE_HELPER_REASK_NOT_KOREAN_NOTE}` && buildPhraseHelperReaskUserMessage("출장", "out_of_scope") === `입력: 출장\n\n${PHRASE_HELPER_REASK_OUT_OF_SCOPE_NOTE}`, "");
  add("되묻기 라벨 phrase_helper_<mode>_reask", PHRASE_HELPER_MODES.map(phraseHelperReaskCallLabel).join(",") === "phrase_helper_toeic_reask,phrase_helper_japanese_reask,phrase_helper_english_kid_reask", "");
  add("out_of_scope 덧붙임은 안전 문장(남을 해치거나 괴롭히는 말)을 지닌다 · not_korean 덧붙임은 ok를 지시하지 않는다", PHRASE_HELPER_REASK_OUT_OF_SCOPE_NOTE.includes("남을 해치거나 괴롭히는 말이 아니면") && !/ok/.test(PHRASE_HELPER_REASK_NOT_KOREAN_NOTE), "");

  // ② 가짜 호출 주입 — 호출 기록과 응답 순서
  type Rec = { call: string; user: string; signal: AbortSignal | undefined; schema: string };
  const okEn = toeicFixture();
  const okKid = kidFixture();
  const okJa = jaFixture();
  const refuse = (status: "not_korean" | "out_of_scope") => ({ status, noteKo: "이 도우미는 한국어를 바꿔 줘요.", main: null, alternatives: [], examples: [] });
  const fake = (queue: unknown[], recs: Rec[]) =>
    (async (args: { call: string; user: { type: string; text?: string }[]; signal?: AbortSignal; jsonSchema: { name: string } }) => {
      recs.push({ call: args.call, user: args.user.map((u) => u.text ?? "").join(""), signal: args.signal, schema: args.jsonSchema.name });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("가짜 응답이 모자람 — 예상보다 많이 불렀다");
      return clone(next);
    }) as unknown as Parameters<typeof explainPhraseWith>[0];
  const run = async (mode: PhraseHelperMode, text: string, queue: unknown[], opts: { signal?: AbortSignal | null } = {}) => {
    const recs: Rec[] = [];
    try {
      const r = await explainPhraseWith(fake(queue, recs), mode, text, opts);
      return { r, recs, err: null as unknown };
    } catch (e) {
      return { r: null, recs, err: e };
    }
  };

  {
    const { r, recs } = await run("toeic", "성수기", [okEn]);
    add("toeic ok → 1회", recs.length === 1 && r?.status === "ok" && recs[0].call === "phrase_helper_toeic" && recs[0].user === "입력: 성수기", `${recs.length}`);
  }
  {
    const { r, recs } = await run("toeic", "성수기", [refuse("out_of_scope"), okEn]);
    add("toeic out_of_scope → 되묻기 1회 → ok를 보인다(덧붙임·라벨·같은 신호·같은 스키마)",
      recs.length === 2 && r?.status === "ok" && recs[1].call === "phrase_helper_toeic_reask" && recs[1].user.endsWith(PHRASE_HELPER_REASK_OUT_OF_SCOPE_NOTE) && recs[0].signal !== undefined && recs[0].signal === recs[1].signal && recs[0].schema === recs[1].schema && recs[1].schema === "phrase_helper_en",
      recs.map((x) => x.call).join(","));
  }
  {
    const { r, recs } = await run("toeic", "비수기", [refuse("not_korean"), okEn]);
    add("toeic not_korean(한글 입력) → 되묻기(not_korean 덧붙임) → ok", recs.length === 2 && r?.status === "ok" && recs[1].user.endsWith(PHRASE_HELPER_REASK_NOT_KOREAN_NOTE), "");
  }
  {
    const { r, recs } = await run("japanese", "출장", [refuse("out_of_scope"), okJa]);
    add("japanese out_of_scope → 되묻기 → ok(JA 스키마 두 번)", recs.length === 2 && r?.status === "ok" && r?.mode === "japanese" && recs.every((x) => x.schema === "phrase_helper_ja") && recs[1].call === "phrase_helper_japanese_reask", "");
  }
  {
    const { r, recs } = await run("japanese", "출장", [refuse("out_of_scope"), refuse("out_of_scope")]);
    add("되물은 결과가 또 거절이면 그대로 보인다(최대 1회 — 3번째 호출 없음)", recs.length === 2 && r?.status === "out_of_scope" && r?.main === null, `${recs.length}`);
  }
  {
    const { r, recs } = await run("toeic", "성수기", [refuse("not_korean"), refuse("out_of_scope")]);
    add("not_korean → 되물어 out_of_scope가 와도 더 묻지 않는다", recs.length === 2 && r?.status === "out_of_scope", `${recs.length}`);
  }
  {
    const { r, recs } = await run("english-kid", "나쁜 말", [refuse("out_of_scope")]);
    add("kid out_of_scope → 되묻지 않는다(1회 — 아이 안전 판정 불변)", recs.length === 1 && r?.status === "out_of_scope", `${recs.length}`);
  }
  {
    const { r, recs } = await run("english-kid", "성수기", [refuse("not_korean"), okKid]);
    add("kid not_korean(한글 입력) → 되묻기 → ok", recs.length === 2 && r?.status === "ok" && recs[1].call === "phrase_helper_english_kid_reask" && recs[1].user.endsWith(PHRASE_HELPER_REASK_NOT_KOREAN_NOTE), "");
  }
  {
    const { r, recs } = await run("english-kid", "성수기", [refuse("not_korean"), refuse("out_of_scope")]);
    add("kid 되물은 결과가 out_of_scope면 그대로(되묻기 1회뿐)", recs.length === 2 && r?.status === "out_of_scope", "");
  }
  {
    const { r, recs } = await run("toeic", "ㅋㅋ", [refuse("out_of_scope")]);
    add("자모만(ㅋㅋ) out_of_scope → 되묻지 않는다", recs.length === 1 && r?.status === "out_of_scope", "");
  }
  {
    const { r, recs, err } = await run("toeic", "성수기", [refuse("out_of_scope"), new Error("upstream 503")]);
    add("되묻기 실패 → 첫 응답을 돌려준다(던지지 않음)", err === null && recs.length === 2 && r?.status === "out_of_scope", String(err ?? ""));
  }
  {
    const ac = new AbortController();
    const recs: Rec[] = [];
    const calls = fake([refuse("out_of_scope")], recs);
    let err: unknown = null;
    try {
      await explainPhraseWith(
        (async (a: Parameters<typeof calls>[0]) => {
          if (recs.length === 1) {
            ac.abort();
            throw new Error("aborted");
          }
          return calls(a);
        }) as unknown as typeof calls,
        "toeic",
        "성수기",
        { signal: ac.signal },
      );
    } catch (e) {
      err = e;
    }
    add("되묻기 중 요청 취소 신호가 끊기면 던진다(라우트 499)", err instanceof Error && err.message === "aborted", String(err));
  }
  {
    const { err, recs } = await run("toeic", "성수기", [new Error("first failed")]);
    add("첫 호출 실패는 그대로 던진다(되묻지 않음)", err instanceof Error && err.message === "first failed" && recs.length === 1, "");
  }
  {
    const { r, recs } = await run("toeic", "hello", []);
    add("한글 없음은 여전히 AI 0(로컬)", recs.length === 0 && r?.source === "local", "");
  }
  return results;
}

// ---------------------------------------------------------------------------
// 6. JSON Schema strict 모양 · 번들 경계
// ---------------------------------------------------------------------------

function strictProblems(node: unknown, path = "$"): string[] {
  const out: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((n, i) => out.push(...strictProblems(n, `${path}[${i}]`)));
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const o = node as Record<string, unknown>;
  if ("minItems" in o || "maxItems" in o) out.push(`${path}: 개수 제약`);
  const t = o.type;
  const isObject = t === "object" || (Array.isArray(t) && t.includes("object"));
  if (isObject && o.properties) {
    if (o.additionalProperties !== false) out.push(`${path}: additionalProperties`);
    const keys = Object.keys(o.properties as object).sort().join(",");
    const req = Array.isArray(o.required) ? [...(o.required as string[])].sort().join(",") : "";
    if (keys !== req) out.push(`${path}: required ≠ 키`);
  }
  for (const [k, v] of Object.entries(o)) out.push(...strictProblems(v, `${path}.${k}`));
  return out;
}

function runShapeChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "스키마·번들");
  for (const s of [PHRASE_HELPER_EN_JSON_SCHEMA, PHRASE_HELPER_JA_JSON_SCHEMA]) {
    const p = strictProblems(s.schema);
    add(`${s.name}: strict 모양(모든 객체 additionalProperties false·required = 키·개수 제약 없음)`, s.strict === true && p.length === 0, p.join(" / "));
  }
  const statusEnum = (s: typeof PHRASE_HELPER_EN_JSON_SCHEMA) => ((s.schema as { properties: { status: { enum: string[] } } }).properties.status.enum).join(",");
  add("status enum == PHRASE_HELPER_STATUSES(두 스키마)", statusEnum(PHRASE_HELPER_EN_JSON_SCHEMA) === PHRASE_HELPER_STATUSES.join(",") && statusEnum(PHRASE_HELPER_JA_JSON_SCHEMA) === PHRASE_HELPER_STATUSES.join(","), "");

  const src = read("lib/phrase-helper.ts");
  const imports = src.split("\n").filter((l) => /^\s*import\s/.test(l));
  add("lib/phrase-helper.ts: 런타임 import 0(lib/ai·store·openai·zod 없음)", imports.length === 0, imports.join(" / "));
  add("lib/phrase-helper.ts: 정규식 lookbehind 없음(구형 iOS Safari)", !/\(\?<[=!]/.test(src), "");
  const clientImports = (() => {
    try {
      const out: string[] = [];
      const hits = execSync(`grep -arl '"use client"' components app || true`, { cwd: new URL("..", import.meta.url).pathname, encoding: "utf-8" })
        .split("\n")
        .filter(Boolean);
      for (const f of hits) {
        const s = readFileSync(new URL(`../${f}`, import.meta.url), "utf-8");
        if (/from\s+["']@\/lib\/ai\/phrase-helper/.test(s)) out.push(f);
      }
      return out;
    } catch {
      return ["(검사 실패)"];
    }
  })();
  add('"use client" 컴포넌트가 @/lib/ai/phrase-helper를 import하지 않는다', clientImports.length === 0, clientImports.join(", "));
  return results;
}

// ---------------------------------------------------------------------------
// 6-1. 앱 — 경로→모드 · 시험 차단 · 블록 카운터 · 라우트·관문 K·화면 배선 (§13, SPEC §22-2·§22-3)
// ---------------------------------------------------------------------------

/** 시험 러너 전수(SPEC §22-3 — 마운트 동안 usePhraseHelperBlock을 건다). 이름 규칙으로도 새 러너를 잡는다(아래 검사) */
const RUNNER_COMPONENTS: readonly string[] = [
  "components/toeic-take-view.tsx",
  "components/toeic-quiz-runner.tsx",
  "components/toeic-template-quiz.tsx",
  "components/toeic-template-test.tsx",
  "components/ja-quiz-runner.tsx",
  "components/ja-kanji-quiz-runner.tsx",
  "components/vocab-quiz-view.tsx",
  "components/vocab-speak-quiz-runner.tsx",
  "components/talk-call-overlay.tsx",
];

/** 주석을 걷은 소스(문구가 주석에 있어도 코드 대조가 흔들리지 않게 — 문자열 안의 //는 URL이 없는 파일에만 쓴다) */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

async function runAppChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "앱 경로·차단");

  // ── 경로 → 모드 ──
  const modeRows: [string | null, PhraseHelperMode | null][] = [
    ["/toeic", "toeic"],
    ["/toeic/", "toeic"],
    ["/toeic/sets/abc", "toeic"],
    ["/toeic/mocks/abc", "toeic"],
    ["/toeic/attempts/abc", "toeic"],
    ["/toeic/guides/q3-4", "toeic"],
    ["/toeic/recordings", "toeic"],
    ["/japanese", "japanese"],
    ["/japanese/vocab/abc", "japanese"],
    ["/japanese/dialog/abc", "japanese"],
    ["/japanese/kanji", "japanese"],
    ["/english", "english-kid"],
    ["/english/books", "english-kid"],
    ["/english/vocab", "english-kid"],
    ["/english/vocab/abc/wrong", "english-kid"],
    ["/english/talk", "english-kid"],
    ["/english/talk/abc", "english-kid"],
    ["/library", "english-kid"],
    ["/card/abc", "english-kid"],
    ["/english?tab=1", "english-kid"],
    ["/", null],
    ["", null],
    [null, null],
    ["/math", null],
    ["/math/problem/abc", null],
    ["/workout", null],
    ["/unlock", null],
    ["/api/phrase-helper", null],
    ["/toeicx", null],
    ["/englishy", null],
  ];
  const badMode = modeRows.filter(([p, m]) => phraseHelperModeForPath(p) !== m).map(([p, m]) => `${p}→${phraseHelperModeForPath(p)}(기대 ${m})`);
  add(`경로→모드 표 ${modeRows.length}행(토익·일본어·은우 영어만, 홈·수학·운동·잠금 화면 null)`, badMode.length === 0, badMode.join(" / "));

  // ── 시험 경로 ──
  const examRows: [string, boolean][] = [
    ["/toeic/mocks/m1/take", true],
    ["/toeic/mocks/m1/take/", true],
    ["/toeic/mocks/m1/take?scope=part&part=q3", true],
    ["/toeic/attempts/a1/retake", true],
    ["/toeic/sets/s1/quiz", true],
    ["/toeic/sets/s1/quiz?wrong=meaning", true],
    ["/toeic/guides/q3-4/templates/quiz", true],
    ["/toeic/guides/q11/templates/test", true],
    ["/toeic/guides/q5_7/frame-drill/take", true],
    ["/toeic/guides/q11/frame-drill/take?topics=a&n=10&t=1", true],
    ["/toeic/guides/q11/frame-drill/fd-abc12345", false],
    ["/japanese/vocab/v1/quiz", true],
    ["/japanese/vocab/v1/quiz?wrong=reading", true],
    ["/japanese/kanji/quiz", true],
    ["/english/vocab/v1/quiz", true],
    ["/english/vocab/v1/quiz?mode=wrong", true],
    ["/english/vocab/v1/speak", true],
    ["/english/vocab/v1/speak?mode=wrong", true],
    ["/english/vocab/v1/speaker", false],
    // 📅 오늘의 복습 러너(SPEC §23 — 가린 채 떠올리기 중에는 도우미가 답을 알려 주면 안 된다)
    ["/english/review", true],
    ["/japanese/review", true],
    ["/toeic/review", true],
    ["/toeic/review/", true],
    ["/english/review?x=1", true],
    ["/english/reviews", false],
    ["/toeic/review/x", false],
    ["/toeic/mocks/m1", false],
    ["/toeic/attempts/a1", false],
    ["/toeic/sets/s1", false],
    ["/toeic/sets/s1/wrong", false],
    ["/toeic/sets/s1/history", false],
    ["/toeic/guides/q3-4", false],
    ["/toeic/recordings", false],
    ["/japanese/vocab/v1", false],
    ["/japanese/vocab/v1/wrong", false],
    ["/japanese/kanji", false],
    ["/english/vocab/v1", false],
    ["/english/vocab/v1/wrong", false],
    ["/english/vocab/wrong", false],
    ["/english/talk", false],
    ["/english/talk/t1", false],
    ["/english/vocab/v1/quizzes", false],
  ];
  const badExam = examRows.filter(([p, b]) => isPhraseHelperExamPath(p) !== b).map(([p, b]) => `${p}→${!b}`);
  add(`시험 경로 판정 ${examRows.length}행(응시·다시 풀기·표현 시험·틀 시험·틀 테스트·틀 말하기 진행·일본어 단어/한자 시험·은우 단어장 시험·오늘의 복습 러너 / 목록·오답노트·결과는 아님)`, badExam.length === 0, badExam.join(" / "));
  add("시험 경로 정규식은 모두 ^…$로 닫혔다(앞뒤 덧붙은 경로를 잘못 막지 않게)", PHRASE_HELPER_EXAM_PATHS.every((x) => x.re.source.startsWith("^") && x.re.source.endsWith("$")), "");

  // app/의 시험 라우트 파일이 전부 시험 경로로 판정되는가(새 시험 라우트를 만들고 표에 안 넣으면 FAIL)
  const root = new URL("..", import.meta.url).pathname;
  const pages = execSync(`find app -name page.tsx`, { cwd: root, encoding: "utf-8" }).split("\n").filter(Boolean);
  const routeOf = (f: string) => "/" + f.replace(/^app\//, "").replace(/\/?page\.tsx$/, "").replace(/\[[^\]]+\]/g, "x");
  const examLike = pages.filter((f) => /\/(quiz|test|take|retake|speak)\/page\.tsx$/.test(f));
  const missedExam = examLike.filter((f) => !isPhraseHelperExamPath(routeOf(f)));
  add(`app/의 시험 라우트(quiz·test·take·retake) ${examLike.length}개가 전부 시험 경로`, examLike.length >= 8 && missedExam.length === 0, missedExam.join(", "));
  const helperPages = pages.filter((f) => phraseHelperModeForPath(routeOf(f)) !== null);
  const noHelper = pages.filter((f) => phraseHelperModeForPath(routeOf(f)) === null).map(routeOf);
  add(
    "도우미가 없는 페이지 = 홈·사람 고르기(은우·엄마·아빠)·가족 보드·수학·운동·엄마의 생활영어·잠금 화면뿐",
    noHelper.every(
      (r) =>
        r === "/" ||
        r === "/eunwoo" ||
        r === "/mama" ||
        r === "/appa" ||
        r === "/family" ||
        r.startsWith("/family/") ||
        r.startsWith("/math") ||
        r === "/workout" ||
        r === "/mom" ||
        r.startsWith("/mom/") ||
        r === "/unlock",
    ) && helperPages.length > 30,
    noHelper.join(", "),
  );

  // ── 합친 판정 ──
  const v1 = phraseHelperVisibility({ pathname: "/math", blockCount: 3 });
  const v2 = phraseHelperVisibility({ pathname: "/english/talk", blockCount: 0 });
  const v3 = phraseHelperVisibility({ pathname: "/english/talk", blockCount: 1 });
  const v4 = phraseHelperVisibility({ pathname: "/toeic/mocks/m1/take", blockCount: 0 });
  add(
    "합친 판정: 모드 없음 → show null·blocked false / 블록 0 → show / 블록 ≥1 → 막힘 / 시험 경로 → 막힘",
    v1.show === null && !v1.blocked && v2.show === "english-kid" && !v2.blocked && v3.show === null && v3.blocked && v3.mode === "english-kid" && v4.show === null && v4.blocked,
    JSON.stringify([v1, v2, v3, v4]),
  );

  // ── 블록 카운터 ──
  const base = getPhraseHelperBlockCount();
  let notified = 0;
  const unsub = subscribePhraseHelperBlock(() => (notified += 1));
  const r1 = acquirePhraseHelperBlock();
  const r2 = acquirePhraseHelperBlock();
  const afterTwo = getPhraseHelperBlockCount();
  r1();
  r1(); // 멱등
  const afterDouble = getPhraseHelperBlockCount();
  r2();
  const afterAll = getPhraseHelperBlockCount();
  unsub();
  acquirePhraseHelperBlock()(); // 해제한 구독자는 알림을 받지 않는다
  add(
    "블록 카운터: 참조 카운트·해제 멱등(두 번 불러도 한 번)·알림 4회·해제 뒤 알림 없음",
    afterTwo === base + 2 && afterDouble === base + 1 && afterAll === base && notified === 4 && getPhraseHelperBlockCount() === base,
    `${afterTwo}/${afterDouble}/${afterAll} notified=${notified}`,
  );

  // ── 시험 러너 전수 — 마운트 동안 블록 ──
  const missingHook = RUNNER_COMPONENTS.filter((f) => {
    const src = read(f);
    return !/import \{ usePhraseHelperBlock \} from "@\/components\/use-phrase-helper-block";/.test(src) || !/\n\s+usePhraseHelperBlock\(\);/.test(src);
  });
  add(`시험 러너 ${RUNNER_COMPONENTS.length}곳이 usePhraseHelperBlock()을 건다(경로 차단과 두 겹)`, missingHook.length === 0, missingHook.join(", "));
  const runnerLike = execSync(`ls components`, { cwd: root, encoding: "utf-8" })
    .split("\n")
    .filter((f) => /\.tsx$/.test(f) && /(quiz-runner|quiz-view|take-view|template-test|template-quiz|call-overlay)\.tsx$/.test(f))
    .map((f) => `components/${f}`);
  const unlisted = runnerLike.filter((f) => !RUNNER_COMPONENTS.includes(f));
  add("이름이 러너 모양인 컴포넌트가 전부 목록에 있다(새 러너 누락 탐지)", unlisted.length === 0, unlisted.join(", "));
  const toeicRunner = read("components/toeic-quiz-runner.tsx");
  add("토익 표현 시험: 고르기·말하기 러너 둘 다 블록", (toeicRunner.match(/\n\s+usePhraseHelperBlock\(\);/g) ?? []).length === 2, "");

  // ── 라우트 — 물어보기 ──
  const route = read("app/api/phrase-helper/route.ts");
  const keyAt = route.indexOf("if (!process.env.OPENAI_API_KEY)");
  add(
    "라우트: 키 검사(501)가 본문 읽기·explainPhrase보다 먼저, req.signal 전달, 본문 바이트 상한(413)",
    keyAt > 0 &&
      keyAt < route.indexOf("await req.text()") &&
      keyAt < route.indexOf("await explainPhrase(") &&
      /explainPhrase\(parsed\.data\.mode, parsed\.data\.input, \{ signal: req\.signal \}\)/.test(route) &&
      route.includes("PHRASE_HELPER_BODY_MAX_BYTES") &&
      route.indexOf("TextEncoder") < route.indexOf("JSON.parse"),
    "",
  );
  const logs = route.match(/console\.\w+\([^\n]*/g) ?? [];
  add("라우트: 로그에 입력·결과 글이 없다(모드·오류 이름·ms만)", logs.length > 0 && logs.every((l) => !/input\b(?!Error)|result|rawText/.test(l.replace(/isPhraseHelperInputError/g, ""))), logs.join(" / "));
  add("라우트: 저장소를 import하지 않는다(저장 없음)", !/@\/lib\/store/.test(route), "");

  // ── 라우트 — 전사(마이크 모드) ──
  const tr = read("app/api/phrase-helper/transcribe/route.ts");
  const tKey = tr.indexOf("if (!hasPhraseHelperTranscribeApiKey())");
  const tLen = tr.indexOf('req.headers.get("content-length")');
  add(
    "전사 라우트: 키(501)가 본문보다 먼저 → 선언 길이 413 → multipart → 크기 413 → transcribeKorean(…, req.signal), 저장소 import 없음",
    tKey > 0 &&
      tKey < tLen &&
      tLen < tr.indexOf("await readBodyCapped(req,") &&
      tr.indexOf("await readBodyCapped(req,") < tr.indexOf(".formData()") &&
      !/await req\.formData\(\)/.test(tr) &&
      tr.indexOf("audio.size > PHRASE_HELPER_AUDIO_MAX_BYTES") < tr.indexOf("await transcribeKorean(") &&
      /transcribeKorean\(\{ bytes: await audio\.arrayBuffer\(\), fileName, type \}, req\.signal\)/.test(tr) &&
      !/@\/lib\/store/.test(tr),
    "",
  );

  // ── 관문 K ──
  const k = read("lib/phrase-helper-transcribe.ts");
  const kCall = k.slice(k.indexOf("transcriptions.create("), k.indexOf("transcriptions.create(") + 240);
  add(
    "관문 K: language ko · prompt 없음(호출 인자·입력 타입) · signal 전달 · SDK 재시도 0 · json",
    PHRASE_HELPER_TRANSCRIBE_LANGUAGE === "ko" &&
      /language:\s*PHRASE_HELPER_TRANSCRIBE_LANGUAGE/.test(kCall) &&
      !/\bprompt\s*:/.test(kCall) &&
      !/prompt/.test(k.slice(k.indexOf("interface KoreanAudioInput"), k.indexOf("export type KoreanTranscribeResult"))) &&
      /\{\s*signal\s*\}/.test(kCall) &&
      /response_format:\s*"json"/.test(kCall) &&
      PHRASE_HELPER_TRANSCRIBE_SDK_MAX_RETRIES === 0,
    kCall.replace(/\s+/g, " ").slice(0, 160),
  );
  const savedEnv = { m: process.env.OPENAI_TRANSCRIBE_MODEL, key: process.env.OPENAI_API_KEY };
  try {
    process.env.OPENAI_TRANSCRIBE_MODEL = "  ";
    const m1 = resolvePhraseHelperTranscribeModel();
    process.env.OPENAI_TRANSCRIBE_MODEL = "whisper-1";
    const m2 = resolvePhraseHelperTranscribeModel();
    add("관문 K 모델 = 관문 T와 같은 env·같은 기본값", m1 === "gpt-4o-mini-transcribe" && m2 === "whisper-1" && m2 === resolveToeicTranscribeModel(), `${m1} ${m2}`);
    delete process.env.OPENAI_API_KEY;
    const r = await transcribeKorean({ bytes: new ArrayBuffer(8), fileName: "speech.wav", type: "audio/wav" });
    add("관문 K: 키가 없으면 네트워크 없이 no_api_key", !r.ok && r.error === "no_api_key", r.ok ? "ok?" : r.error);
  } finally {
    for (const [name, val] of [["OPENAI_TRANSCRIBE_MODEL", savedEnv.m], ["OPENAI_API_KEY", savedEnv.key]] as const) {
      if (val === undefined) delete process.env[name];
      else process.env[name] = val;
    }
  }
  add("관문 T(토익) 원본은 그대로 — language en·prompt 없음 유지", /language:\s*TOEIC_TRANSCRIBE_LANGUAGE/.test(read("lib/toeic-transcribe.ts")) && !/phrase/i.test(read("lib/toeic-transcribe.ts")), "");

  // ── 계약 상수 ──
  const wav30 = (PHRASE_HELPER_REC_MAX_MS / 1000) * 16_000 * 2 + 44;
  add(
    "계약: 녹음 30초·업로드 상한 ≥ 30초 16kHz WAV·본문 상한 ≥ 200자×4바이트+껍데기·화면 대기 > 서버 30초",
    PHRASE_HELPER_REC_MAX_MS === 30_000 && PHRASE_HELPER_AUDIO_MAX_BYTES >= wav30 && PHRASE_HELPER_BODY_MAX_BYTES >= PHRASE_HELPER_INPUT_MAX * 4 + 200 && PHRASE_HELPER_CLIENT_TIMEOUT_MS > PHRASE_HELPER_TIMEOUT_MS && PHRASE_HELPER_REC_MIN_MS > 0,
    `wav30=${wav30} max=${PHRASE_HELPER_AUDIO_MAX_BYTES}`,
  );
  for (const f of ["lib/phrase-helper-contract.ts", "lib/phrase-helper-scope.ts"]) {
    const src = read(f);
    const runtimeImports = src.split("\n").filter((l) => /^\s*import\s/.test(l) && !/^\s*import type\s/.test(l));
    add(`${f}: 런타임 import 0(타입만)·lookbehind 없음`, runtimeImports.length === 0 && !/\(\?<[=!]/.test(src), runtimeImports.join(" / "));
  }

  // ── 화면 배선 ──
  const ui = read("components/phrase-helper.tsx");
  const uiCode = codeOnly(ui);
  add("화면: lib/ai·openai·store를 import하지 않는다", !/from\s+["'](@\/lib\/ai|openai|@\/lib\/store)/.test(ui), "");
  add("화면: 프리페치 없음 — 🔊는 speakQueue 하나(탭 핸들러 play)뿐, speak·prefetchSpeech 미사용", !/prefetchSpeech|prepareSpeech|\bspeak\(/.test(uiCode) && (uiCode.match(/speakQueue\(/g) ?? []).length === 1, "");
  add("화면: 녹음은 lib/mic-session startRecording(점검 대기 상한)만 — getUserMedia·audioSession 직접 호출 없음", /startRecording\(\{ audioContext: ctx, gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS, owner: PHRASE_HELPER_MIC_OWNER \}\)/.test(ui) && !/getUserMedia|audioSession/.test(uiCode), "");
  const trBlock = ui.slice(ui.indexOf("fetch(PHRASE_HELPER_TRANSCRIBE_ENDPOINT"), ui.indexOf("finishMicRef.current = finishMic"));
  add("화면: 전사 결과는 입력 칸에 채우기만(전사 처리 안에서 ask·전송 없음)", trBlock.includes("setText(heard)") && !/\bask\(|PHRASE_HELPER_ENDPOINT/.test(trBlock), "");
  add("화면: 호스트는 막혔거나 모드가 없으면 아무것도 그리지 않는다", /if \(vis\.show === null\) return null;/.test(ui), "");
  add("화면: 대기 중 보내기 잠금(pendingRef 검사 + 보내기 disabled)", /if \(pendingRef\.current \|\| micRef\.current !== "idle"\) return;/.test(ui) && /disabled=\{pending \|\| micBusy/.test(ui), "");
  add("화면: 한글 없는 입력은 요청 없이 로컬 안내(phraseHelperLocalResult가 fetch보다 먼저)", ui.indexOf("phraseHelperLocalResult(mode, v.text)") > 0 && ui.indexOf("phraseHelperLocalResult(mode, v.text)") < ui.indexOf("fetch(PHRASE_HELPER_ENDPOINT"), "");
  const unmount = ui.slice(ui.indexOf("aliveRef.current = false;"), ui.indexOf("aliveRef.current = false;") + 900);
  add("화면: 언마운트에서 물어보기 abort·녹음 abort·전사 abort·도우미 🔊만 멈춤(stopSpeaking 미사용)", /askAcRef\.current\?\.abort\(\)/.test(unmount) && /recRef\.current\?\.abort\(\)/.test(unmount) && /trAcRef\.current\?\.abort\(\)/.test(unmount) && /speechStopRef\.current\?\.\(\)/.test(unmount) && !/stopSpeaking/.test(uiCode), "");
  // ── QA 1 P3 수정(2026-10-03) ──
  const pathEff = uiCode.slice(uiCode.indexOf("const pathRef = useRef(pathname);"), uiCode.indexOf("const pathRef = useRef(pathname);") + 420);
  add(
    "P3-A: 경로가 바뀌면(같은 영역 안 이동 포함) 시작 중·녹음 중 녹음을 버린다 — cancelMic(전사 안 함), finishMic 아님",
    pathEff.length > 0 && /if \(pathRef\.current === pathname\) return;/.test(pathEff) && /micRef\.current === "starting" \|\| micRef\.current === "recording"/.test(pathEff) && /cancelMic\(\)/.test(pathEff) && !/finishMic/.test(pathEff),
    "",
  );
  const css = read("components/phrase-helper.module.css");
  const narrow = css.slice(css.indexOf("@media (max-width: 1023px)"), css.indexOf("@media (max-width: 1023px)") + 700);
  add(
    "P3-B: 폰(lg 미만) 버튼 = 글자 없는 44px 동그라미 · 오른쪽 위(헤드라인 아래) · 아래로 스크롤하는 동안 숨김",
    narrow.length > 0 && /top: calc\(var\(--streak-h, 0px\) \+ 8px\)/.test(narrow) && /bottom: auto/.test(narrow) && /width: 44px/.test(narrow) && /\.fabLabel \{\s*display: none;/.test(narrow) && /\.fabHidden \{[^}]*pointer-events: none/.test(narrow) && /window\.addEventListener\("scroll", onScroll, \{ passive: true \}\)/.test(uiCode),
    "",
  );
  const mic = read("lib/mic-session.ts");
  const micCode = codeOnly(mic);
  const recOn = micCode.slice(micCode.indexOf("function recordOn("), micCode.indexOf("function recordOn(") + 9000);
  add(
    "P3-C: lib/mic-session 공유 신호 — 녹음기 start 뒤 +1·놓을 때 -1(recordOn 한 곳, owner 실음)",
    /export function getLiveRecordingOwners\(\)/.test(micCode) && /export function subscribeMicRecording\(/.test(micCode) &&
      /const owner = opts\.owner \?\? null;/.test(recOn) && /liveRecordings\.splice\(i, 1\);\s*emitRecording\("end", owner\);/.test(recOn) &&
      recOn.indexOf("recorder.start();") < recOn.indexOf('emitRecording("start", owner)'),
    "",
  );
  const startMicSrc = uiCode.slice(uiCode.indexOf("const startMic = () => {"), uiCode.indexOf("const startMic = () => {") + 2600);
  add(
    "P3-C: 도우미 🎤 — 남의 녹음이 돌면 시작하지 않음 · 자기 녹음에 owner · 남의 녹음이 시작되면 자기 녹음을 버림",
    startMicSrc.indexOf("getLiveRecordingOwners().some((o) => o !== PHRASE_HELPER_MIC_OWNER)") > 0 &&
      startMicSrc.indexOf("getLiveRecordingOwners()") < startMicSrc.indexOf("startRecording(") &&
      /owner: PHRASE_HELPER_MIC_OWNER/.test(startMicSrc) &&
      /subscribeMicRecording\(\(ev\) => \{\s*if \(ev\.type !== "start" \|\| ev\.owner === PHRASE_HELPER_MIC_OWNER\) return;[\s\S]{0,160}cancelMic\(\);/.test(uiCode),
    "",
  );
  add("P3-D: 스펙 앱 절에 '도우미 🔊·🎤는 화면 재생을 멈춘다' 한 줄", /도우미 🔊·🎤는 화면 재생을 멈춘다/.test(readFileSync(SPEC_URL, "utf-8")), "");
  // P3-E: 실제로 라우트를 불러 chunked 본문을 상한에서 끊는지 본다(키는 가짜 값 — 413·400 경로는 네트워크 전에 끝난다)
  {
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-eval-offline";
    try {
      const { POST } = await import("../app/api/phrase-helper/transcribe/route");
      let pulled = 0;
      const chunk = new Uint8Array(64 * 1024);
      const big = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 1;
          if (pulled > 64) c.close(); // 4 MiB까지 줄 수 있는 스트림
          else c.enqueue(chunk);
        },
      });
      const r1 = await POST(new Request("http://x/api/phrase-helper/transcribe", { method: "POST", body: big, headers: { "content-type": "multipart/form-data; boundary=zz" }, duplex: "half" } as RequestInit));
      const fd = new FormData();
      fd.append("other", "x");
      const r2 = await POST(new Request("http://x/api/phrase-helper/transcribe", { method: "POST", body: fd }));
      const b2 = (await r2.json()) as { error?: string };
      add(
        `P3-E: content-length 없는(chunked) 본문은 읽는 중 상한을 넘는 순간 413 — 끝까지 읽지 않는다(당긴 조각 ${pulled}/64) · 작은 본문은 그대로 multipart 해석(audio 없음 400)`,
        r1.status === 413 && pulled < 40 && r2.status === 400 && b2.error === "invalid_input",
        `${r1.status} pulled=${pulled} ${r2.status}`,
      );
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  }

  const layout = read("app/layout.tsx");
  add("레이아웃: 호스트를 VersionWatch(마지막 자식) 앞에 한 번", (layout.match(/<PhraseHelperHost \/>/g) ?? []).length === 1 && layout.indexOf("<PhraseHelperHost />") < layout.indexOf("<VersionWatch />"), "");
  return results;
}

// ---------------------------------------------------------------------------
// 7. spec-sync — 원문 바이트 대조 + JSON Schema 의미 동치 + 호출 옵션 문장
// ---------------------------------------------------------------------------

const SRC = "lib/ai/phrase-helper/prompts.ts";
const SPEC_SYNC_TARGETS: readonly SpecSyncTarget[] = [
  { constName: "PHRASE_HELPER_TOEIC_SYSTEM_PROMPT", source: SRC, specLabel: "§3-1 toeic 시스템 프롬프트", text: PHRASE_HELPER_TOEIC_SYSTEM_PROMPT, mode: "block-exact" },
  { constName: "PHRASE_HELPER_JAPANESE_SYSTEM_PROMPT", source: SRC, specLabel: "§3-2 japanese 시스템 프롬프트", text: PHRASE_HELPER_JAPANESE_SYSTEM_PROMPT, mode: "block-exact" },
  { constName: "PHRASE_HELPER_KID_SYSTEM_PROMPT", source: SRC, specLabel: "§3-3 english-kid 시스템 프롬프트", text: PHRASE_HELPER_KID_SYSTEM_PROMPT, mode: "block-exact" },
  { constName: "PHRASE_HELPER_USER_TEMPLATE", source: SRC, specLabel: "§4 사용자 메시지 형식", text: PHRASE_HELPER_USER_TEMPLATE, mode: "block-exact" },
  { constName: "PHRASE_HELPER_REASK_NOT_KOREAN_NOTE", source: SRC, specLabel: "§14-2 not_korean 덧붙임", text: PHRASE_HELPER_REASK_NOT_KOREAN_NOTE, mode: "block-exact" },
  { constName: "PHRASE_HELPER_REASK_OUT_OF_SCOPE_NOTE", source: SRC, specLabel: "§14-2 out_of_scope 덧붙임", text: PHRASE_HELPER_REASK_OUT_OF_SCOPE_NOTE, mode: "block-exact" },
];

const specSyncOutcomes: SpecSyncOutcome[] = [];

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
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function runSpecSyncChecks(): CheckResult[] {
  specSyncOutcomes.length = 0;
  specSyncOutcomes.push(...checkSpecSync(SPEC_URL, SPEC_SYNC_TARGETS));
  const book = "프롬프트 ↔ 스펙";
  const results: CheckResult[] = specSyncOutcomes.map((o) => ({ book, check: `${o.constName}이 phrase-helper.md 원문 그대로`, pass: o.ok, detail: o.summary }));
  const add = makeAdder(results, book);
  add("spec-sync 원문 대상 = 6개(시스템 프롬프트 3 + 사용자 메시지 형식 + 되묻기 덧붙임 2)", SPEC_SYNC_TARGETS.length === 6, String(SPEC_SYNC_TARGETS.length));

  // JSON Schema 의미 동치
  const blocks = extractSpecBlocks(SPEC_URL);
  const parsed = new Map<string, unknown>();
  for (const b of blocks) {
    try {
      const j = JSON.parse(b.text) as { name?: unknown };
      if (j && typeof j === "object" && typeof j.name === "string") parsed.set(j.name, j);
    } catch {
      // JSON 아닌 블록
    }
  }
  for (const [name, value, label] of [["phrase_helper_en", PHRASE_HELPER_EN_JSON_SCHEMA, "§5-1"], ["phrase_helper_ja", PHRASE_HELPER_JA_JSON_SCHEMA, "§5-2"]] as const) {
    const s = parsed.get(name);
    add(`${name} ↔ ${label} 의미 동치`, s !== undefined && deepEqual(s, value), s === undefined ? "스펙 블록 없음" : "");
  }
  add("스펙의 JSON Schema 블록 수 = 2", [...parsed.keys()].filter((k) => k.startsWith("phrase_helper_")).length === 2, [...parsed.keys()].join(","));

  // 호출 옵션 문장
  const spec = readFileSync(SPEC_URL, "utf-8");
  const m = spec.match(/temperature ([\d.]+), maxOutputTokens (\d+), call 라벨 `([^`]+)`/);
  add(
    "호출 옵션 == 스펙 §7 문장(temperature·maxOutputTokens·call 라벨)",
    !!m && Number(m[1]) === PHRASE_HELPER_CALL_OPTIONS.temperature && Number(m[2]) === PHRASE_HELPER_CALL_OPTIONS.maxOutputTokens && m[3] === "phrase_helper_<mode>",
    m ? `스펙 t=${m[1]} max=${m[2]} label=${m[3]}` : "스펙 문장을 못 찾음",
  );
  add("스펙 §7 시간 상한 30초·재시도 0 문장", /\*\*시간 상한 30초\*\*/.test(spec) && /\*\*SDK 자동 재시도 0\*\*/.test(spec), "");
  add(`스펙 §2-1 상한 ${PHRASE_HELPER_INPUT_MAX}자 문장`, spec.includes(`**코드 포인트 ${PHRASE_HELPER_INPUT_MAX}자**`), "");
  return results;
}

// ---------------------------------------------------------------------------
// 실호출 점검 (게이트 EVAL_PHRASE=1) — 에이전트는 실행하지 않는다. 오케스트레이터가 사용자 동의 후 돌린다.
// ---------------------------------------------------------------------------

/** 모드마다 지어낸 입력 하나 */
const LIVE_INPUTS: Readonly<Record<PhraseHelperMode, string>> = {
  toeic: "회의를 다음 주로 미루다",
  japanese: "잠깐만 기다려 주세요",
  "english-kid": "나 이거 진짜 좋아해",
};

async function runLiveChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "실호출(게이트)");
  if (!process.env.OPENAI_API_KEY) {
    add("OPENAI_API_KEY", false, "키가 없어 실호출을 할 수 없습니다");
    return results;
  }
  const { explainPhrase } = await import("../lib/ai/phrase-helper/calls");
  const only = process.env.EVAL_PHRASE_MODE;
  const modes = isPhraseHelperMode(only) ? [only] : [...PHRASE_HELPER_MODES];
  for (const mode of modes) {
    const t0 = Date.now();
    try {
      const r = await explainPhrase(mode, LIVE_INPUTS[mode]);
      const ms = Date.now() - t0;
      add(`${mode}: status ok·AI 결과`, r.status === "ok" && r.source === "ai" && r.main !== null, `status=${r.status} · ${ms}ms · model=${r.model}`);
      const cov = phraseHelperExampleCoverage(r);
      const sizes =
        r.mode === "japanese"
          ? r.examples.map((x) => [...x.ja.replace(/\s+/g, "")].length).join("/") + "자"
          : r.examples.map((x) => x.en.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length).join("/") + "단어";
      // 알림 — 실패 아님(예문 글은 찍지 않는다)
      results.push({ book: "실호출(게이트)", check: `${mode}: 알림`, pass: true, detail: `대안 ${r.alternatives.length} · 예문 ${r.examples.length}(${sizes}) · 예문에 main 포함 ${cov.covered}/${cov.total} · noteKo ${r.noteKo === null ? "없음" : "있음"}` });
    } catch (e) {
      add(`${mode}: status ok·AI 결과`, false, e instanceof Error ? e.message : String(e));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const all: CheckResult[] = [];
  all.push(...(await runConstantChecks()));
  all.push(...runInputChecks());
  all.push(...runZodChecks());
  all.push(...runPostChecks());
  all.push(...(await runEntryChecks()));
  all.push(...(await runReaskChecks()));
  all.push(...runShapeChecks());
  all.push(...(await runAppChecks()));
  all.push(...runSpecSyncChecks());

  printTable(all);
  printSpecSyncDetails(specSyncOutcomes);

  const failed = all.filter((r) => !r.pass && !r.skip);
  const skipped = all.filter((r) => r.skip).length;
  if (failed.length > 0) {
    console.error(`FAIL — 오프라인 ${failed.length}개 항목 실패.`);
    process.exit(1);
  }

  if (process.env.EVAL_PHRASE === "1") {
    if (process.env.EVAL_OFFLINE_ONLY === "1") {
      console.log("EVAL_PHRASE=1이지만 EVAL_OFFLINE_ONLY=1 — 실호출 점검을 건너뜁니다(네트워크 차단).");
    } else {
      const live = await runLiveChecks();
      printTable(live);
      const liveFailed = live.filter((r) => !r.pass && !r.skip);
      if (liveFailed.length > 0) {
        console.error(`FAIL — 실호출 ${liveFailed.length}개 항목 실패.`);
        process.exit(1);
      }
      console.log(`PASS — 실호출 ${live.length}개 항목.`);
    }
  }

  console.log(`PASS — 오프라인 ${all.length - skipped}개 항목 통과, ${skipped}개 SKIP (실호출 ${process.env.EVAL_PHRASE === "1" && process.env.EVAL_OFFLINE_ONLY !== "1" ? "실행" : "미실행"}).`);
}

void main();
