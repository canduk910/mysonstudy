/**
 * lib/toeic-frame-drill.ts — 토익 유형별 공략 **소재별 틀 말하기**(Q5–7·Q11) 순수 층 (docs/harness/toeic.md §20, SPEC §20-17)
 *
 * 한국어 문장을 보고 외운 영어 틀로 말하는 연습기. 이 모듈은 값을 만드는 **유일한 곳**이다 — 화면·라우트·스토어·eval이 같은 판정을
 * 한 벌 더 갖지 않는다.
 * - 데이터 모양: 문제 은행(소재·틀·문항)과 **따로 저장하는** 문항별 통계, 연습 한 판 기록.
 * - 범위: 폴더(Q5–7·Q11) → 소재(+ 질문 유형으로 좁히기) → 틀(소재를 고르면 그 소재 틀이 다 켜지고 뺄 틀만 끈다).
 * - 틀마다 출처 태그(bank·drill·new·audio:{파일})·질문 유형·자리 채움 후보(확장 표현 — 시드와 보충 출제가 조합을 늘린다).
 * - 출제 순서: 오답률 높은 것·덜 연습한 것 가중 + 무작위(시드 주입), 같은 판 중복 없음, 같은 틀이 이어지지 않게.
 * - 통계 갱신·오답률·보충 출제 판정(평균 오답률 < 20% → 범위의 10% 새로 출제)·보충 계획·보충 결과 합치기(중복 거르기·안정 id).
 * - 가져오기 병합(다시 가져와도 통계가 지워지지 않는다 — 통계는 문항 id로 따로 산다).
 * - 말 끝 판정: 레벨 표본 → 말 시작·무음 1.5초·문항 상한 20초·시작 대기 10초(무응답).
 * - 판정 결과 합치기(무응답은 AI 없이 wrong). 스트릭 입력은 lib/toeic-streak.ts(toeicStreakSessions 세 번째 인자)가 단일 정의처다.
 *
 * ⚠️ 클라이언트·eval 안전: 런타임 import는 lib/toeic-template·lib/toeic-text·lib/toeic-mic-health·lib/toeic-score뿐(전부 클라이언트 안전).
 * lib/ai·store·openai·zod 값 import 금지, 정규식 lookbehind 금지(구형 iOS Safari). 모듈 최상위에서 브라우저 전역을 읽지 않는다.
 * 공개 저장소: 이 파일의 예시·주석에 교재·틀 원본 문장을 적지 않는다.
 */

import { fillFrame, frameSlotNames, frameToExpression } from "./toeic-template";
import { collapseSpaces, countWords, matchKey } from "./toeic-text";
import { TOEIC_MIC_CHECK_OK_LEVEL, TOEIC_SILENT_PEAK_LEVEL } from "./toeic-mic-health";
import { TOEIC_MIN_TRANSCRIPT_WORDS } from "./toeic-score";

// ===========================================================================
// 상수 (단일 정의)
// ===========================================================================

/** 이 연습이 있는 유형 폴더 — 두 폴더가 **같은 은행**을 쓰고 틀의 parts로 거른다 */
export const TOEIC_FRAME_DRILL_PARTS = ["q5_7", "q11"] as const;
export type ToeicFrameDrillPart = (typeof TOEIC_FRAME_DRILL_PARTS)[number];

/** 가져오기 파일 형식 */
export const TOEIC_FRAME_DRILL_FORMAT = "toeic-frame-drill/v1";

/** 한 판 문항 수 — 시작 전에 입력(1~20, 기본 10). 상한은 호출 E 한 번(요청 하나가 60초 안)에서 왔다 */
export const TOEIC_FRAME_DRILL_COUNT_MIN = 1;
export const TOEIC_FRAME_DRILL_COUNT_MAX = 20;
export const TOEIC_FRAME_DRILL_COUNT_DEFAULT = 10;

/** 말 끝 판정(앱 쪽 로컬 무음 감지) — 무음이 이만큼 이어지면 말이 끝났다 */
export const TOEIC_FRAME_DRILL_SILENCE_END_MS = 1500;
/** 한 문항 녹음 상한(말이 안 끝나도 여기서 끊는다) — 틀 테스트 녹음 상한과 같은 값 */
export const TOEIC_FRAME_DRILL_MAX_ANSWER_MS = 20_000;
/** 한국어 문장이 뜬 뒤 말을 시작하지 않고 이만큼 지나면 무응답 */
export const TOEIC_FRAME_DRILL_START_WAIT_MS = 10_000;
/** 말을 시작했다고 볼 최소 길이 — 기침·딸깍 한 번을 말로 보지 않는다 */
export const TOEIC_FRAME_DRILL_VOICE_MIN_MS = 300;
/** 말소리 문턱(레벨 0..1 — lib/mic-session level() 척도). 시작은 마이크 점검 ✓ 문턱, 끝(무음)은 그보다 낮은 문턱(되먹임 방지 히스테리시스) */
export const TOEIC_FRAME_DRILL_VOICE_ON_LEVEL = TOEIC_MIC_CHECK_OK_LEVEL;
export const TOEIC_FRAME_DRILL_VOICE_OFF_LEVEL = (TOEIC_MIC_CHECK_OK_LEVEL + TOEIC_SILENT_PEAK_LEVEL) / 2;
/** 말이 끝난 뒤 모범 영어를 보여 주는 시간 — 지나면 자동으로 다음, 탭하면 바로 다음 */
export const TOEIC_FRAME_DRILL_REVEAL_MS = 4000;

/** 출제 가중치 — w = base + wrong × 오답률 + fresh ÷ (1 + 시도 수) */
export const TOEIC_FRAME_DRILL_WEIGHT = { base: 1, wrong: 3, fresh: 2 } as const;

/** 보충 출제 — 범위의 평균 오답률이 이 값 **미만**이면(경계 20%는 보충하지 않는다) */
export const TOEIC_FRAME_DRILL_SUPPLY_RATE_BELOW = 0.2;
/** 보충 개수 = ceil(범위 문항 수 × 비율), 최소 1·상한 10 */
export const TOEIC_FRAME_DRILL_SUPPLY_RATIO = 0.1;
export const TOEIC_FRAME_DRILL_SUPPLY_MIN = 1;
export const TOEIC_FRAME_DRILL_SUPPLY_MAX = 10;
/** 표본 — 시도 ≥1인 범위 문항이 min(이 값, 범위 문항 수)개 이상이어야 오답률을 믿는다 */
export const TOEIC_FRAME_DRILL_SUPPLY_MIN_SAMPLE = 10;
/** 보충이 "진행 중"으로 잡힌 뒤 이 시간이 지나면 다시 잡을 수 있다(탭이 죽은 경우) */
export const TOEIC_FRAME_DRILL_SUPPLY_STALE_MS = 120_000;
/** 호출 F에 "이미 있는 한국어 문장"으로 넘기는 상한(범위 문항, 최근 것부터) */
export const TOEIC_FRAME_DRILL_SUPPLY_EXISTING_MAX = 200;

/** 은행 상한 — 시드 + AI 문항 합. 넘을 보충은 하지 않는다(full) */
export const TOEIC_FRAME_DRILL_ITEMS_MAX = 1500;
export const TOEIC_FRAME_DRILL_TOPICS_MAX = 40;
export const TOEIC_FRAME_DRILL_FRAMES_MAX = 400;
/** 은행 문서 크기 상한(UTF-8 바이트 — Firestore 문서 1MB) — 틀 은행과 같은 값 */
export const TOEIC_FRAME_DRILL_MAX_BYTES = 900_000;

/** 키 — 소재·틀 key(틀 은행 key와 같은 문법), 문항 id(시드), AI 문항 id 접두어 */
export const TOEIC_FRAME_DRILL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const TOEIC_FRAME_DRILL_ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const TOEIC_FRAME_DRILL_AI_ID_PREFIX = "ai-";

/** 저장 문서 id(app-builder가 쓰는 결정적 id) */
export const TOEIC_FRAME_DRILL_BANK_ID = "frame-drill-bank";
export const TOEIC_FRAME_DRILL_STATS_ID = "frame-drill-stats";
/** 연습 한 판 문서 id = 접두어 + 화면이 만든 clientSessionId(멱등) */
export const TOEIC_FRAME_DRILL_SESSION_PREFIX = "fd-";
export const TOEIC_FRAME_DRILL_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 판정 */
export const TOEIC_FRAME_DRILL_VERDICTS = ["correct", "close", "wrong"] as const;
export type ToeicFrameDrillVerdict = (typeof TOEIC_FRAME_DRILL_VERDICTS)[number];
export const TOEIC_FRAME_DRILL_VERDICT_KO: Record<ToeicFrameDrillVerdict, string> = { correct: "맞음", close: "아깝다", wrong: "다시" };

/** 문항 결과 — spoken(말했고 전사됨) · no_speech(말 시작 없음 또는 전사 단어 < 2 — AI 없이 wrong) · transcribe_failed(전사 실패 — 판정·통계 밖) */
export const TOEIC_FRAME_DRILL_OUTCOMES = ["spoken", "no_speech", "transcribe_failed"] as const;
export type ToeicFrameDrillOutcome = (typeof TOEIC_FRAME_DRILL_OUTCOMES)[number];

// ===========================================================================
// 데이터 모양
// ===========================================================================

/** 소재 — 고르면 그 소재 틀이 다 켜진다. 소재가 걸친 폴더는 틀의 parts에서 나온다(두 곳에 적지 않는다) */
export interface ToeicFrameDrillTopic {
  key: string;
  nameKo: string;
}

/**
 * 틀 출처 태그(1~4개) — `bank`(틀 은행 templates.json — 템플릿 암기장·핵심틀의 원본) · `drill`(drill.md) · `new`(새로 씀) ·
 * `audio:{파일 이름}`(강의 음성 전사 — 예 `audio:PB03`). 표시·감사용이고 판정에 쓰지 않는다.
 */
export const TOEIC_FRAME_DRILL_SOURCE_RE = /^(bank|drill|new|audio:[A-Za-z0-9][A-Za-z0-9_-]{0,19})$/;
export const TOEIC_FRAME_DRILL_SOURCES_MAX = 4;
/** 틀 하나의 자리 채움 후보 상한 */
export const TOEIC_FRAME_DRILL_FILL_OPTIONS_MAX = 40;
/** 질문 유형(Q5–7 의문사 — 누구와·어디서·언제 …) 상한 · 틀 하나에 붙는 질문 유형 상한 */
export const TOEIC_FRAME_DRILL_QUESTION_TYPES_MAX = 20;
export const TOEIC_FRAME_DRILL_FRAME_QUESTION_TYPES_MAX = 4;

/** 질문 유형 — 소재와 별개의 분류(주로 Q5–7 의문사). 고르기 화면에서 범위를 좁히는 데 쓴다(§20-1) */
export interface ToeicFrameDrillQuestionType {
  key: string;
  nameKo: string;
}

/**
 * 자리 채움 후보(확장 표현) — 그 자리에 바꿔 끼울 영어와 한국어 뜻 한 쌍. 시드 문항을 만들 때(데이터 단계)와 보충 출제(호출 F)가
 * 이 후보를 조합해 문항을 늘린다. 화면은 결과의 "이 틀에 넣어 볼 말"로 보일 수 있다.
 */
export interface ToeicFrameDrillFillOption {
  /** 틀 frameEn의 자리 이름 하나 */
  slot: string;
  en: string;
  ko: string;
}

export interface ToeicFrameDrillFrame {
  key: string;
  topicKey: string;
  /** 고정 부분 + {자리 이름} — 틀 은행 frameEn과 같은 문법 */
  frameEn: string;
  /** 같은 자리 이름을 한국어 어순대로 */
  frameKo: string;
  useKo: string | null;
  parts: ToeicFrameDrillPart[];
  /** 틀 은행(guide-templates)의 같은 틀 key — 있으면 ② 카드로 잇는다(글자는 그 틀 그대로 옮긴다) */
  bankKey: string | null;
  /** 출처 태그 1~4(TOEIC_FRAME_DRILL_SOURCE_RE) */
  sources: string[];
  /** 질문 유형 key 0~4(파일의 questionTypes) — 소재와 별개 */
  questionTypes: string[];
  /** 자리 채움 후보 0~40 */
  fillOptions: ToeicFrameDrillFillOption[];
}

/** 가져오기 파일의 문항 — en = fillFrame(frameEn, fills) 글자까지 */
export interface ToeicFrameDrillItemFile {
  id: string;
  frameKey: string;
  ko: string;
  fills: string[];
  en: string;
}

/** 은행의 문항 — 소재는 틀에서 읽는다(topicKey를 문항에 두지 않는다 — 틀이 소재를 옮겨도 어긋나지 않게) */
export interface ToeicFrameDrillItem extends ToeicFrameDrillItemFile {
  source: "seed" | "ai";
  createdAt: string;
}

export interface ToeicFrameDrillFile {
  format: typeof TOEIC_FRAME_DRILL_FORMAT;
  presetKey: string;
  topics: ToeicFrameDrillTopic[];
  questionTypes: ToeicFrameDrillQuestionType[];
  frames: ToeicFrameDrillFrame[];
  items: ToeicFrameDrillItemFile[];
}

/** 문제 은행 문서(id TOEIC_FRAME_DRILL_BANK_ID) — 통계는 여기 없다 */
export interface ToeicFrameDrillBank {
  presetKey: string;
  topics: ToeicFrameDrillTopic[];
  questionTypes: ToeicFrameDrillQuestionType[];
  frames: ToeicFrameDrillFrame[];
  items: ToeicFrameDrillItem[];
  updatedAt: string;
}

/** 문항 하나의 통계 — 오답 = verdict ≠ correct(무응답 포함) */
export interface ToeicFrameDrillStat {
  attempts: number;
  wrong: number;
  lastAt: string;
}

/** 통계 문서(id TOEIC_FRAME_DRILL_STATS_ID) — 문항 id → 통계. 은행에서 빠진 문항의 통계도 지우지 않는다(다시 들어오면 이어진다) */
export interface ToeicFrameDrillStatsDoc {
  items: Record<string, ToeicFrameDrillStat>;
  updatedAt: string;
}

/** 한 판의 문항 기록 — 출제 때의 글자를 그대로 남긴다(은행이 나중에 바뀌어도 결과 화면이 같다) */
export interface ToeicFrameDrillSessionItem {
  itemId: string;
  frameKey: string;
  ko: string;
  en: string;
  /** frameToExpression(frameEn) — 호출 E에 보낸 틀 글자 */
  frame: string;
  outcome: ToeicFrameDrillOutcome;
  transcript: string | null;
  verdict: ToeicFrameDrillVerdict | null;
  reasonKo: string | null;
  fixedEn: string | null;
}

export interface ToeicFrameDrillReview {
  summaryKo: string;
  improvements: string[];
  strongFrameKeys: string[];
  weakFrameKeys: string[];
  /** 호출 E를 부르지 않은 판(모두 무응답)은 null */
  model: string | null;
  at: string;
}

export interface ToeicFrameDrillSupplyMark {
  status: "running" | "added" | "skipped" | "failed";
  /** skipped 이유 또는 failed 오류 이름 — 없으면 null */
  reason: string | null;
  added: number;
  at: string;
}

/** 연습 한 판(문서 id = TOEIC_FRAME_DRILL_SESSION_PREFIX + clientSessionId) */
export interface ToeicFrameDrillSession {
  part: ToeicFrameDrillPart;
  topicKeys: string[];
  /** 질문 유형으로 좁혔으면 그 key들(안 좁혔으면 []) */
  questionTypeKeys: string[];
  excludedFrameKeys: string[];
  /** 시작 전에 입력한 문항 수 */
  requested: number;
  startedAt: string;
  finishedAt: string;
  /** done = 끝까지 · quit = 그만두기(답한 문항까지만 남는다) */
  ended: "done" | "quit";
  items: ToeicFrameDrillSessionItem[];
  review: ToeicFrameDrillReview | null;
  statsAppliedAt: string | null;
  supply: ToeicFrameDrillSupplyMark | null;
}

// ===========================================================================
// 무작위 — 시드 주입(eval·재현)
// ===========================================================================

export type Rng = () => number;

/** mulberry32 — 같은 시드면 같은 수열. 화면은 Math.random을 넘겨도 된다 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================
// 정규화 키
// ===========================================================================

/** 한국어 문장 중복 키 — 공백·문장부호(.,?!…·"'“”‘’)를 지우고 비교 */
export function frameDrillKoKey(ko: string): string {
  return collapseSpaces(ko).replace(/[\s.,?!…·"'“”‘’]/g, "");
}

/** 영어 문장 중복 키 — 대소문자·연속 공백 무시, 끝 문장부호 무시 */
export function frameDrillEnKey(en: string): string {
  return matchKey(en).replace(/[.?!]+$/, "");
}

/** 틀 → 호출 E에 보내는 `~` 글자(틀 은행과 같은 함수) */
export function frameDrillFrameText(frame: Pick<ToeicFrameDrillFrame, "frameEn">): string {
  return frameToExpression(frame.frameEn);
}

/** 32비트 FNV-1a — AI 문항 id용(결정적, node:crypto 없이) */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * AI 문항 id — `ai-` + FNV(틀 key · 영어 키) 8자리. 같은 보충 결과면 같은 id(합치기가 멱등). 이미 쓰인 id와 부딪치면 `-2`·`-3`…을 붙인다.
 */
export function frameDrillAiItemId(frameKey: string, en: string, taken: ReadonlySet<string>): string {
  const base = `${TOEIC_FRAME_DRILL_AI_ID_PREFIX}${fnv1a(`${frameKey}\u0000${frameDrillEnKey(en)}`)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

// ===========================================================================
// 범위 — 폴더 → 소재 → 틀
// ===========================================================================

/** 문항 수 입력 정리 — 정수로 내리고 1~20 안으로 */
export function clampFrameDrillCount(n: number): number {
  if (!Number.isFinite(n)) return TOEIC_FRAME_DRILL_COUNT_DEFAULT;
  return Math.min(TOEIC_FRAME_DRILL_COUNT_MAX, Math.max(TOEIC_FRAME_DRILL_COUNT_MIN, Math.floor(n)));
}

function frameDrillable(f: ToeicFrameDrillFrame): boolean {
  const n = frameSlotNames(f.frameEn).length;
  return n >= 1;
}

/** 이 폴더에 보이는 틀(파일 순서) — 자리가 없는 깨진 틀은 뺀다 */
export function frameDrillFramesForPart(bank: Pick<ToeicFrameDrillBank, "frames">, part: ToeicFrameDrillPart): ToeicFrameDrillFrame[] {
  return bank.frames.filter((f) => f.parts.includes(part) && frameDrillable(f));
}

export interface ToeicFrameDrillTopicView {
  topic: ToeicFrameDrillTopic;
  frames: ToeicFrameDrillFrame[];
  /** 이 소재 틀들의 문항 수(은행 전체) */
  itemCount: number;
}

/** 폴더의 소재 목록(파일 순서) — 이 폴더 틀이 0인 소재는 뺀다 */
export function frameDrillTopicsForPart(bank: ToeicFrameDrillBank, part: ToeicFrameDrillPart): ToeicFrameDrillTopicView[] {
  const frames = frameDrillFramesForPart(bank, part);
  const counts = itemCountByFrame(bank.items);
  return bank.topics
    .map((topic) => {
      const fs = frames.filter((f) => f.topicKey === topic.key);
      return { topic, frames: fs, itemCount: fs.reduce((s, f) => s + (counts.get(f.key) ?? 0), 0) };
    })
    .filter((v) => v.frames.length > 0);
}

function itemCountByFrame(items: readonly Pick<ToeicFrameDrillItem, "frameKey">[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(it.frameKey, (m.get(it.frameKey) ?? 0) + 1);
  return m;
}

/**
 * 고른 범위의 틀 key(파일 순서) — 소재를 고르면 그 소재의 이 폴더 틀이 다 켜지고, `excludedFrameKeys`에 든 틀만 빠진다.
 * `questionTypeKeys`가 비어 있지 않으면 그중 하나라도 붙은 틀만 남긴다(소재 AND 질문 유형 — 질문 유형은 좁히기만 한다).
 * 모르는 소재·질문 유형·틀 key는 조용히 무시한다(은행이 바뀐 뒤 옛 선택이 와도 깨지지 않게).
 */
export function frameDrillScopeFrameKeys(
  bank: ToeicFrameDrillBank,
  part: ToeicFrameDrillPart,
  topicKeys: readonly string[],
  excludedFrameKeys: readonly string[],
  questionTypeKeys: readonly string[] = [],
): string[] {
  const topics = new Set(topicKeys);
  const excluded = new Set(excludedFrameKeys);
  const known = new Set(bank.questionTypes.map((q) => q.key));
  const qtypes = new Set(questionTypeKeys.filter((k) => known.has(k)));
  return frameDrillFramesForPart(bank, part)
    .filter((f) => topics.has(f.topicKey) && !excluded.has(f.key))
    .filter((f) => qtypes.size === 0 || f.questionTypes.some((q) => qtypes.has(q)))
    .map((f) => f.key);
}

/** 폴더의 질문 유형 목록(파일 순서) — 이 폴더 틀에 붙은 것만 */
export function frameDrillQuestionTypesForPart(bank: ToeicFrameDrillBank, part: ToeicFrameDrillPart): ToeicFrameDrillQuestionType[] {
  const used = new Set(frameDrillFramesForPart(bank, part).flatMap((f) => f.questionTypes));
  return bank.questionTypes.filter((q) => used.has(q.key));
}

/** 범위 문항(은행 순서) */
export function frameDrillScopeItems(bank: Pick<ToeicFrameDrillBank, "items">, scopeFrameKeys: readonly string[]): ToeicFrameDrillItem[] {
  const keys = new Set(scopeFrameKeys);
  return bank.items.filter((it) => keys.has(it.frameKey));
}

// ===========================================================================
// 통계
// ===========================================================================

/** 오답률 = wrong / attempts (시도 0이면 null) */
export function frameDrillWrongRate(stat: ToeicFrameDrillStat | undefined | null): number | null {
  if (!stat || stat.attempts <= 0) return null;
  return Math.min(1, Math.max(0, stat.wrong / stat.attempts));
}

/** 출제 가중치 — 오답률 높을수록·덜 연습했을수록 크다 */
export function frameDrillWeight(stat: ToeicFrameDrillStat | undefined | null): number {
  const attempts = stat && stat.attempts > 0 ? stat.attempts : 0;
  const rate = frameDrillWrongRate(stat) ?? 0;
  const w = TOEIC_FRAME_DRILL_WEIGHT;
  return w.base + w.wrong * rate + w.fresh / (1 + attempts);
}

/** 문항 하나가 통계에서 오답인가 — verdict ≠ correct. 무응답(no_speech)은 wrong, 전사 실패·판정 없음은 통계 밖(null) */
export function frameDrillItemIsWrong(it: Pick<ToeicFrameDrillSessionItem, "outcome" | "verdict">): boolean | null {
  if (it.outcome === "transcribe_failed") return null;
  if (it.outcome === "no_speech") return true;
  if (it.verdict === null) return null;
  return it.verdict !== "correct";
}

/**
 * 판정이 끝난 한 판을 통계에 더한다(순수 — 새 객체). 통계 밖 문항(전사 실패·판정 없음)은 건너뛴다.
 * **한 판에 한 번만** — 호출측은 `session.statsAppliedAt === null`일 때만 부르고 같은 원자 단위 안에서 표시를 남긴다(`decideFrameDrillStatsApply`).
 */
export function applyFrameDrillStats(
  stats: Readonly<Record<string, ToeicFrameDrillStat>>,
  items: readonly Pick<ToeicFrameDrillSessionItem, "itemId" | "outcome" | "verdict">[],
  at: string,
): Record<string, ToeicFrameDrillStat> {
  const out: Record<string, ToeicFrameDrillStat> = { ...stats };
  for (const it of items) {
    const wrong = frameDrillItemIsWrong(it);
    if (wrong === null) continue;
    const prev = out[it.itemId] ?? { attempts: 0, wrong: 0, lastAt: at };
    out[it.itemId] = { attempts: prev.attempts + 1, wrong: prev.wrong + (wrong ? 1 : 0), lastAt: at };
  }
  return out;
}

/** 통계를 더할까 — 판정이 있고(review ≠ null) 아직 더하지 않았을 때만 */
export function decideFrameDrillStatsApply(session: Pick<ToeicFrameDrillSession, "review" | "statsAppliedAt">): "apply" | "already" | "not_judged" {
  if (session.statsAppliedAt !== null) return "already";
  if (session.review === null) return "not_judged";
  return "apply";
}

// ===========================================================================
// 출제 순서
// ===========================================================================

export interface ToeicFrameDrillOrder {
  items: ToeicFrameDrillItem[];
  /** 요청 수 - 낸 수(범위 문항이 모자라면 > 0 → 화면 안내 "범위에 문항이 n개뿐이에요") */
  shortBy: number;
}

/**
 * 한 판 문항 고르기 — 가중 무작위 비복원 추출(Efraimidis–Spirakis: 열쇠 u^(1/w) 큰 순) → 같은 틀이 이어지지 않게 재배치.
 * 같은 판에 같은 문항은 한 번만. 범위 문항이 요청보다 적으면 가능한 만큼(shortBy). 같은 rng 수열이면 같은 결과(결정적).
 */
export function buildFrameDrillOrder(
  scopeItems: readonly ToeicFrameDrillItem[],
  stats: Readonly<Record<string, ToeicFrameDrillStat>>,
  count: number,
  rng: Rng = Math.random,
): ToeicFrameDrillOrder {
  const want = clampFrameDrillCount(count);
  const seen = new Set<string>();
  const unique = scopeItems.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  const keyed = unique.map((it, i) => {
    const u = Math.min(1 - 1e-12, Math.max(1e-12, rng()));
    return { it, i, key: Math.log(u) / frameDrillWeight(stats[it.id]) };
  });
  keyed.sort((a, b) => b.key - a.key || a.i - b.i);
  const picked = keyed.slice(0, want).map((k) => k.it);
  return { items: spreadFrames(picked), shortBy: Math.max(0, want - picked.length) };
}

/**
 * 같은 틀이 연달아 나오지 않게 재배치 — 매 자리에서 직전과 다른 틀 중 **남은 문항이 가장 많은 틀**(같으면 다음 문항이 앞선 틀)의
 * 맨 앞 문항을 둔다(남은 수가 많은 틀을 먼저 풀어야 끝에 한 틀만 몰리지 않는다). 다른 틀이 없으면 남은 맨 앞 문항.
 * 가능하기만 하면(가장 많은 틀의 문항 ≤ ⌈n/2⌉) 연속이 0이다. 틀 안 순서는 뽑힌 순서 그대로.
 */
function spreadFrames(items: readonly ToeicFrameDrillItem[]): ToeicFrameDrillItem[] {
  const queues = new Map<string, { first: number; items: ToeicFrameDrillItem[] }>();
  items.forEach((it, i) => {
    const q = queues.get(it.frameKey);
    if (q) q.items.push(it);
    else queues.set(it.frameKey, { first: i, items: [it] });
  });
  const order = new Map(items.map((it, i) => [it, i] as const));
  const out: ToeicFrameDrillItem[] = [];
  let prev: string | null = null;
  while (out.length < items.length) {
    let best: string | null = null;
    for (const [key, q] of queues) {
      if (q.items.length === 0 || key === prev) continue;
      if (best === null) {
        best = key;
        continue;
      }
      const b = queues.get(best)!;
      const head = order.get(q.items[0])!;
      const bHead = order.get(b.items[0])!;
      if (q.items.length > b.items.length || (q.items.length === b.items.length && head < bHead)) best = key;
    }
    if (best === null) {
      // 남은 것이 직전 틀뿐 — 그대로 잇는다
      const q = queues.get(prev as string)!;
      out.push(q.items.shift()!);
      continue;
    }
    out.push(queues.get(best)!.items.shift()!);
    prev = best;
  }
  return out;
}

/** 출제한 문항 → 한 판 기록의 문항(아직 답 없음) */
export function toFrameDrillSessionItem(item: ToeicFrameDrillItem, frame: Pick<ToeicFrameDrillFrame, "frameEn">): ToeicFrameDrillSessionItem {
  return {
    itemId: item.id,
    frameKey: item.frameKey,
    ko: item.ko,
    en: item.en,
    frame: frameDrillFrameText(frame),
    outcome: "no_speech",
    transcript: null,
    verdict: null,
    reasonKo: null,
    fixedEn: null,
  };
}

/** 전사 결과 → 문항 결과. 전사 실패면 transcribe_failed, 단어 < TOEIC_MIN_TRANSCRIPT_WORDS(2)면 no_speech, 그 밖 spoken */
export function frameDrillOutcomeOf(transcript: string | null, failed: boolean): { outcome: ToeicFrameDrillOutcome; transcript: string | null } {
  if (failed) return { outcome: "transcribe_failed", transcript: null };
  const t = transcript === null ? "" : collapseSpaces(transcript);
  if (countWords(t) < TOEIC_MIN_TRANSCRIPT_WORDS) return { outcome: "no_speech", transcript: t === "" ? null : t };
  return { outcome: "spoken", transcript: t };
}

// ===========================================================================
// 말 끝 판정 — 레벨 표본 상태 기계(앱 쪽 로컬 무음 감지)
// ===========================================================================

export type ToeicFrameDrillVoiceEnd = "silence" | "max" | "no_speech";

export interface ToeicFrameDrillVoiceState {
  /** 한국어 문장이 뜨고 듣기를 시작한 시각 */
  startedAt: number;
  /** 문턱을 넘은 소리가 시작된 시각(말로 확정 전) — 확정 뒤에도 남긴다 */
  voiceSince: number | null;
  /** 말 시작으로 확정한 시각 */
  speechAt: number | null;
  /** 말 확정 뒤 무음이 시작된 시각 */
  quietSince: number | null;
  ended: ToeicFrameDrillVoiceEnd | null;
  endedAt: number | null;
}

export function initialFrameDrillVoice(at: number): ToeicFrameDrillVoiceState {
  return { startedAt: at, voiceSince: null, speechAt: null, quietSince: null, ended: null, endedAt: null };
}

/**
 * 표본 하나(순수). `reliable`이 false(분석기 없음·컨텍스트 멈춤)면 소리 판정을 바꾸지 않고 시간 상한만 본다 —
 * 멈춘 분석기의 0을 무음으로 보면 말하는 중에 끊긴다.
 * - 말 시작: 레벨 ≥ ON 문턱이 VOICE_MIN_MS 이상 이어지면(그 시작 시각이 speechAt).
 * - 말 끝: 말 시작 뒤 레벨 < OFF 문턱이 SILENCE_END_MS 이어지면 silence.
 * - 상한: 듣기 시작부터 MAX_ANSWER_MS면 max(말 시작이 없었으면 no_speech).
 * - 무응답: 말 시작 없이 START_WAIT_MS면 no_speech.
 * 끝난 상태에 표본을 더 넣어도 바뀌지 않는다.
 */
export function stepFrameDrillVoice(s: ToeicFrameDrillVoiceState, sample: { at: number; level: number; reliable: boolean }): ToeicFrameDrillVoiceState {
  if (s.ended !== null) return s;
  const at = sample.at;
  let next = s;
  if (sample.reliable && Number.isFinite(sample.level)) {
    const level = Math.max(0, Math.min(1, sample.level));
    if (next.speechAt === null) {
      if (level >= TOEIC_FRAME_DRILL_VOICE_ON_LEVEL) {
        const since = next.voiceSince ?? at;
        next = { ...next, voiceSince: since };
        if (at - since >= TOEIC_FRAME_DRILL_VOICE_MIN_MS) next = { ...next, speechAt: since, quietSince: null };
      } else if (level < TOEIC_FRAME_DRILL_VOICE_OFF_LEVEL) {
        next = { ...next, voiceSince: null };
      }
    } else if (level < TOEIC_FRAME_DRILL_VOICE_OFF_LEVEL) {
      next = { ...next, quietSince: next.quietSince ?? at };
    } else if (level >= TOEIC_FRAME_DRILL_VOICE_ON_LEVEL) {
      next = { ...next, quietSince: null };
    }
  }
  if (next.speechAt !== null && next.quietSince !== null && at - next.quietSince >= TOEIC_FRAME_DRILL_SILENCE_END_MS) {
    return { ...next, ended: "silence", endedAt: at };
  }
  if (at - next.startedAt >= TOEIC_FRAME_DRILL_MAX_ANSWER_MS) {
    return { ...next, ended: next.speechAt === null ? "no_speech" : "max", endedAt: at };
  }
  if (next.speechAt === null && at - next.startedAt >= TOEIC_FRAME_DRILL_START_WAIT_MS) {
    return { ...next, ended: "no_speech", endedAt: at };
  }
  return next;
}

// ===========================================================================
// 판정 합치기 — 호출 E 결과 + 무응답(AI 없이 wrong)
// ===========================================================================

/** 호출 E로 보낼 문항(spoken만) — no는 한 판 안 1부터의 순번(기록 순서) */
export function frameDrillJudgeTargets(items: readonly ToeicFrameDrillSessionItem[]): { no: number; item: ToeicFrameDrillSessionItem }[] {
  return items.map((item, i) => ({ no: i + 1, item })).filter((x) => x.item.outcome === "spoken" && x.item.transcript !== null);
}

/** 판정을 어떻게 할까 — already(이미 review 있음) · no_ai(보낼 문항 0 — 모두 무응답·전사 실패) · call */
export function decideFrameDrillJudge(session: Pick<ToeicFrameDrillSession, "review" | "items">): "already" | "no_ai" | "call" {
  if (session.review !== null) return "already";
  return frameDrillJudgeTargets(session.items).length === 0 ? "no_ai" : "call";
}

export interface ToeicFrameDrillJudgeItemOut {
  no: number;
  verdict: ToeicFrameDrillVerdict;
  reasonKo: string | null;
  fixedEn: string | null;
}

/**
 * 문항 판정 합치기(순수). spoken은 호출 E의 같은 no 결과, no_speech는 AI 없이 wrong("답이 들리지 않았어요" + 모범 영어),
 * transcribe_failed는 판정 없음(null). `judged`가 null이면(no_ai) spoken이 없어야 한다.
 */
export function mergeFrameDrillVerdicts(
  items: readonly ToeicFrameDrillSessionItem[],
  judged: readonly ToeicFrameDrillJudgeItemOut[] | null,
): ToeicFrameDrillSessionItem[] {
  const byNo = new Map((judged ?? []).map((j) => [j.no, j] as const));
  return items.map((it, i) => {
    if (it.outcome === "no_speech") return { ...it, verdict: "wrong", reasonKo: TOEIC_FRAME_DRILL_NO_SPEECH_KO, fixedEn: it.en };
    if (it.outcome === "transcribe_failed") return { ...it, verdict: null, reasonKo: null, fixedEn: null };
    const j = byNo.get(i + 1);
    if (!j) return { ...it, verdict: null, reasonKo: null, fixedEn: null };
    return { ...it, verdict: j.verdict, reasonKo: j.reasonKo, fixedEn: j.verdict === "correct" ? null : j.fixedEn };
  });
}

export const TOEIC_FRAME_DRILL_NO_SPEECH_KO = "답이 들리지 않았어요";

/** 호출 E 없이 끝나는 판(모두 무응답·전사 실패)의 총평 — AI 0 */
export function frameDrillNoAiReview(items: readonly ToeicFrameDrillSessionItem[], at: string): ToeicFrameDrillReview {
  const noSpeech = items.filter((it) => it.outcome === "no_speech").length;
  const failed = items.filter((it) => it.outcome === "transcribe_failed").length;
  const parts: string[] = [];
  if (noSpeech > 0) parts.push(`${noSpeech}문항은 답이 들리지 않았어요.`);
  if (failed > 0) parts.push(`${failed}문항은 녹음을 글자로 옮기지 못했어요.`);
  return {
    summaryKo: `${parts.join(" ")} 판정할 답이 없어 AI 총평을 만들지 않았어요.`.trim(),
    improvements: ["한국어 문장이 뜨면 틀의 첫 낱말부터 소리 내어 바로 시작해 보세요", "마이크 점검에서 ✓가 뜨는지 먼저 확인해 보세요"],
    strongFrameKeys: [],
    weakFrameKeys: [],
    model: null,
    at,
  };
}

/** 한 판 요약 — 결과 화면 머리 줄과 스트릭 */
export function frameDrillSessionCounts(items: readonly Pick<ToeicFrameDrillSessionItem, "outcome" | "verdict">[]): {
  total: number;
  answered: number;
  correct: number;
  close: number;
  wrong: number;
  unjudged: number;
} {
  let answered = 0;
  let correct = 0;
  let close = 0;
  let wrong = 0;
  let unjudged = 0;
  for (const it of items) {
    if (it.outcome === "spoken") answered += 1;
    if (it.verdict === "correct") correct += 1;
    else if (it.verdict === "close") close += 1;
    else if (it.verdict === "wrong") wrong += 1;
    else unjudged += 1;
  }
  return { total: items.length, answered, correct, close, wrong, unjudged };
}

// ===========================================================================
// 보충 출제 — 판정 · 계획 · 합치기
// ===========================================================================

export type ToeicFrameDrillSupplySkip = "already" | "no_scope" | "sample" | "rate" | "full";

export type ToeicFrameDrillSupplyDecision =
  | { kind: "supply"; count: number; rate: number; sample: number; scopeItems: number }
  | { kind: "skip"; reason: ToeicFrameDrillSupplySkip; rate: number | null; sample: number; scopeItems: number };

/**
 * 보충할까(순수) — 결과를 볼 때 한 판에 한 번.
 * - 범위 문항 = 이 판의 범위 틀의 은행 문항. 표본 = 그중 시도 ≥1인 문항(통계는 이 판을 더한 뒤의 것).
 * - 표본 수 < min(SUPPLY_MIN_SAMPLE, 범위 문항 수)면 skip(sample). 범위 문항 0이면 no_scope.
 * - 평균 오답률(표본 문항의 오답률 평균) ≥ 20%면 skip(rate) — **미만일 때만** 보충.
 * - 개수 = clamp(ceil(범위 문항 수 × 10%), 1, 10), 은행 남은 자리(ITEMS_MAX - 은행 문항 수)로 자르고 0이면 skip(full).
 */
export function decideFrameDrillSupply(args: {
  bankItemCount: number;
  scopeItems: readonly Pick<ToeicFrameDrillItem, "id">[];
  stats: Readonly<Record<string, ToeicFrameDrillStat>>;
  alreadySupplied: boolean;
}): ToeicFrameDrillSupplyDecision {
  const scope = args.scopeItems.length;
  const rates = args.scopeItems.map((it) => frameDrillWrongRate(args.stats[it.id])).filter((r): r is number => r !== null);
  const sample = rates.length;
  const rate = sample > 0 ? rates.reduce((s, r) => s + r, 0) / sample : null;
  if (args.alreadySupplied) return { kind: "skip", reason: "already", rate, sample, scopeItems: scope };
  if (scope === 0) return { kind: "skip", reason: "no_scope", rate, sample, scopeItems: scope };
  if (sample < Math.min(TOEIC_FRAME_DRILL_SUPPLY_MIN_SAMPLE, scope)) return { kind: "skip", reason: "sample", rate, sample, scopeItems: scope };
  if (rate === null || rate >= TOEIC_FRAME_DRILL_SUPPLY_RATE_BELOW) return { kind: "skip", reason: "rate", rate, sample, scopeItems: scope };
  const room = Math.max(0, TOEIC_FRAME_DRILL_ITEMS_MAX - args.bankItemCount);
  const count = Math.min(frameDrillSupplyCount(scope), room);
  if (count <= 0) return { kind: "skip", reason: "full", rate, sample, scopeItems: scope };
  return { kind: "supply", count, rate, sample, scopeItems: scope };
}

/** 보충 개수 = clamp(ceil(범위 문항 수 × 10%), 1, 10) — 범위 0이면 0 */
export function frameDrillSupplyCount(scopeItemCount: number): number {
  if (scopeItemCount <= 0) return 0;
  // 부동소수 오차(예: 30 × 0.1 = 3.0000000000000004)로 한 개 더 올리지 않게 조금 깎고 올림
  const raw = Math.ceil(scopeItemCount * TOEIC_FRAME_DRILL_SUPPLY_RATIO - 1e-9);
  return Math.min(TOEIC_FRAME_DRILL_SUPPLY_MAX, Math.max(TOEIC_FRAME_DRILL_SUPPLY_MIN, raw));
}

/** 보충 표시를 잡을까 — 이미 끝났으면(added·skipped) already, 진행 중이 오래되지 않았으면 running, 그 밖(없음·failed·오래된 running) claim */
export function decideFrameDrillSupplyClaim(mark: ToeicFrameDrillSupplyMark | null, now: number): "claim" | "already" | "running" {
  if (mark === null || mark.status === "failed") return "claim";
  if (mark.status === "added" || mark.status === "skipped") return "already";
  const at = Date.parse(mark.at);
  return Number.isFinite(at) && now - at < TOEIC_FRAME_DRILL_SUPPLY_STALE_MS ? "running" : "claim";
}

export interface ToeicFrameDrillSupplyPlanFrame {
  frame: ToeicFrameDrillFrame;
  topicNameKo: string;
  /** 그 틀에 붙은 질문 유형 이름(파일 순서) — 없으면 [] */
  questionTypeNamesKo: string[];
  want: number;
}

export interface ToeicFrameDrillSupplyPlan {
  count: number;
  frames: ToeicFrameDrillSupplyPlanFrame[];
  /** 호출 F의 "이미 있는 한국어 문장"(범위 문항, 은행 뒤쪽 = 최근 것부터, 상한 200) */
  existingKo: string[];
}

/**
 * 보충 계획(순수) — 개수를 범위 틀에 나눈다: 문항이 적은 틀부터 하나씩 돌아가며(같으면 범위 순서). 계획에 든 틀만 호출 F에 간다.
 */
export function planFrameDrillSupply(
  bank: Pick<ToeicFrameDrillBank, "topics" | "questionTypes" | "frames" | "items">,
  scopeFrameKeys: readonly string[],
  count: number,
): ToeicFrameDrillSupplyPlan {
  const frames = scopeFrameKeys
    .map((k) => bank.frames.find((f) => f.key === k))
    .filter((f): f is ToeicFrameDrillFrame => f !== undefined && frameDrillable(f));
  const counts = itemCountByFrame(bank.items);
  const load = frames.map((f, i) => ({ f, i, n: counts.get(f.key) ?? 0, want: 0 }));
  for (let k = 0; k < count && load.length > 0; k++) {
    load.sort((a, b) => a.n + a.want - (b.n + b.want) || a.i - b.i);
    load[0].want += 1;
  }
  load.sort((a, b) => a.i - b.i);
  const topicName = new Map(bank.topics.map((t) => [t.key, t.nameKo] as const));
  const scope = frameDrillScopeItems(bank, scopeFrameKeys);
  const existingKo = scope
    .slice()
    .reverse()
    .map((it) => collapseSpaces(it.ko))
    .slice(0, TOEIC_FRAME_DRILL_SUPPLY_EXISTING_MAX);
  const qtypeName = new Map(bank.questionTypes.map((q) => [q.key, q.nameKo] as const));
  const planned = load
    .filter((x) => x.want > 0)
    .map((x) => ({
      frame: x.f,
      topicNameKo: topicName.get(x.f.topicKey) ?? x.f.topicKey,
      questionTypeNamesKo: x.f.questionTypes.map((q) => qtypeName.get(q)).filter((n): n is string => n !== undefined),
      want: x.want,
    }));
  return { count: planned.reduce((s, x) => s + x.want, 0), frames: planned, existingKo };
}

export interface ToeicFrameDrillSupplyOut {
  frameKey: string;
  ko: string;
  fills: string[];
}

/**
 * 보충 결과 합치기(순수) — zod를 통과한 출력에서 **은행과 겹치는 것만** 거르고 새 문항으로 만든다.
 * - en = fillFrame(frameEn, fills)(앱이 만든다 — 틀 글자는 모델이 아니라 코드가 쓴다).
 * - 은행의 영어 키(frameDrillEnKey)나 한국어 키(frameDrillKoKey)와 같으면 버린다(dropped). 출력끼리 겹침은 zod가 이미 거부했다.
 * - id = frameDrillAiItemId(결정적). source "ai", createdAt = at.
 * 은행 상한을 넘기지 않는다(넘치는 뒤쪽은 dropped).
 */
export function acceptFrameDrillSupply(
  bank: Pick<ToeicFrameDrillBank, "items" | "frames">,
  out: readonly ToeicFrameDrillSupplyOut[],
  at: string,
): { added: ToeicFrameDrillItem[]; dropped: number } {
  const enKeys = new Set(bank.items.map((it) => frameDrillEnKey(it.en)));
  const koKeys = new Set(bank.items.map((it) => frameDrillKoKey(it.ko)));
  const ids = new Set(bank.items.map((it) => it.id));
  const frames = new Map(bank.frames.map((f) => [f.key, f] as const));
  const added: ToeicFrameDrillItem[] = [];
  let dropped = 0;
  for (const o of out) {
    const frame = frames.get(o.frameKey);
    if (!frame || bank.items.length + added.length >= TOEIC_FRAME_DRILL_ITEMS_MAX) {
      dropped += 1;
      continue;
    }
    const fills = o.fills.map((x) => x.trim());
    const en = fillFrame(frame.frameEn, fills);
    const ko = collapseSpaces(o.ko);
    const ek = frameDrillEnKey(en);
    const kk = frameDrillKoKey(ko);
    if (enKeys.has(ek) || koKeys.has(kk)) {
      dropped += 1;
      continue;
    }
    const id = frameDrillAiItemId(frame.key, en, ids);
    ids.add(id);
    enKeys.add(ek);
    koKeys.add(kk);
    added.push({ id, frameKey: frame.key, ko, fills, en, source: "ai", createdAt: at });
  }
  return { added, dropped };
}

// ===========================================================================
// 가져오기 병합 — 통계를 지우지 않는다(통계는 따로, 문항 id로)
// ===========================================================================

export interface ToeicFrameDrillImportResult {
  bank: ToeicFrameDrillBank;
  /** 새로 생긴 시드 문항 수 */
  created: number;
  /** 같은 id인데 글자가 바뀐 시드 문항 수(교정 — 통계는 이어진다) */
  updated: number;
  /** 파일에서 빠져 은행에서 지운 시드 문항 수(통계 문서의 줄은 남는다) */
  removed: number;
  /** 남긴 AI 문항 수 / 시드와 겹쳐 버린 AI 문항 수 */
  aiKept: number;
  aiDropped: number;
  /** 은행이 글자 하나 바뀌지 않았다(같은 파일 다시 가져오기) */
  unchanged: boolean;
}

/**
 * 파일 → 은행(순수). zod(`toeicFrameDrillFileSchema`)를 통과한 파일만 넘긴다.
 * - 소재·틀·시드 문항은 파일이 정한다(파일 순서). 시드 문항은 **id가 정체성** — 같은 id면 createdAt을 이어받고(글자가 바뀌면 updated),
 *   새 id면 created, 파일에서 빠진 id는 removed. 통계는 문항 id로 따로 살아 다시 가져오기가 지우지 않는다.
 * - AI 문항(source "ai")은 파일이 건드리지 않는다. 그 틀이 파일에서 빠졌거나 시드와 영어·한국어 키가 겹치면 버린다(aiDropped).
 * - 같은 파일을 다시 가져오면 unchanged(updatedAt도 그대로).
 */
export function mergeFrameDrillImport(existing: ToeicFrameDrillBank | null, file: ToeicFrameDrillFile, at: string): ToeicFrameDrillImportResult {
  const prevSeed = new Map((existing?.items ?? []).filter((it) => it.source === "seed").map((it) => [it.id, it] as const));
  let created = 0;
  let updated = 0;
  const seed: ToeicFrameDrillItem[] = file.items.map((f) => {
    const prev = prevSeed.get(f.id);
    const item: ToeicFrameDrillItem = { id: f.id, frameKey: f.frameKey, ko: f.ko, fills: [...f.fills], en: f.en, source: "seed", createdAt: prev?.createdAt ?? at };
    if (!prev) created += 1;
    else if (prev.frameKey !== f.frameKey || prev.ko !== f.ko || prev.en !== f.en || prev.fills.join("\u0000") !== f.fills.join("\u0000")) updated += 1;
    return item;
  });
  const fileIds = new Set(file.items.map((f) => f.id));
  const removed = [...prevSeed.keys()].filter((id) => !fileIds.has(id)).length;
  const frameKeys = new Set(file.frames.map((f) => f.key));
  const enKeys = new Set(seed.map((it) => frameDrillEnKey(it.en)));
  const koKeys = new Set(seed.map((it) => frameDrillKoKey(it.ko)));
  const ai: ToeicFrameDrillItem[] = [];
  let aiDropped = 0;
  for (const it of existing?.items ?? []) {
    if (it.source !== "ai") continue;
    if (!frameKeys.has(it.frameKey) || fileIds.has(it.id) || enKeys.has(frameDrillEnKey(it.en)) || koKeys.has(frameDrillKoKey(it.ko))) {
      aiDropped += 1;
      continue;
    }
    ai.push(it);
  }
  const items = [...seed, ...ai].slice(0, TOEIC_FRAME_DRILL_ITEMS_MAX);
  aiDropped += seed.length + ai.length - items.length;
  const next: Omit<ToeicFrameDrillBank, "updatedAt"> = {
    presetKey: file.presetKey,
    topics: file.topics.map((t) => ({ key: t.key, nameKo: t.nameKo })),
    questionTypes: file.questionTypes.map((q) => ({ key: q.key, nameKo: q.nameKo })),
    frames: file.frames.map((f) => ({
      ...f,
      parts: [...f.parts],
      sources: [...f.sources],
      questionTypes: [...f.questionTypes],
      fillOptions: f.fillOptions.map((o) => ({ slot: o.slot, en: o.en, ko: o.ko })),
    })),
    items,
  };
  const unchanged = existing !== null && sameBankContent(existing, next);
  return {
    bank: { ...next, updatedAt: unchanged && existing ? existing.updatedAt : at },
    created,
    updated,
    removed,
    aiKept: ai.length,
    aiDropped,
    unchanged,
  };
}

function sameBankContent(a: Omit<ToeicFrameDrillBank, "updatedAt">, b: Omit<ToeicFrameDrillBank, "updatedAt">): boolean {
  const pick = (x: Omit<ToeicFrameDrillBank, "updatedAt">) => JSON.stringify([x.presetKey, x.topics, x.questionTypes, x.frames, x.items]);
  return pick(a) === pick(b);
}

/** 은행 문서 크기(UTF-8 바이트) — 상한 TOEIC_FRAME_DRILL_MAX_BYTES */
export function frameDrillBankBytes(bank: Pick<ToeicFrameDrillBank, "topics" | "questionTypes" | "frames" | "items">): number {
  return new TextEncoder().encode(JSON.stringify({ topics: bank.topics, questionTypes: bank.questionTypes, frames: bank.frames, items: bank.items })).length;
}
