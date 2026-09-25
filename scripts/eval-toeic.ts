/**
 * scripts/eval-toeic.ts — 아빠의 영어(토익스피킹) 오프라인 검증 + spec-sync (docs/harness/toeic.md §9)
 *
 * - 오프라인(기본, 무비용): zod 반례(호출 A·B·C1~C5·D)·후처리(keyExpressions 정리·DAY 묶기·번호 병합·usedExpressions 정리·
 *   빈 자리만 채우기)·시험 출제(모드별 조건·보기·cloze 가림·speak 키)·**모드별 숙련도 분리**(반례로 잠금)·형식표·단계 전이·
 *   Q1–2 대조·추정 총점·전체 듣기 대본·가져오기 파일 검증.
 * - spec-sync: 호출 A·B·C(머리말 + 파트 5)·D 시스템 프롬프트·사용자 메시지 형식·사진 프롬프트 접미사 ↔ toeic.md 바이트 대조,
 *   JSON Schema 8개는 스펙 코드블록을 파싱해 **의미 동치**로 대조(일본어 관용구). 호출 옵션 숫자도 스펙 문장에서 읽어 대조.
 * - 실호출 점검은 게이트(EVAL_TOEIC=1)일 때만 — 비용이 드는 검증은 사용자 동의 후 오케스트레이터가 실행한다.
 *
 * 픽스처는 전부 **지어낸 영어 표현**이다(공개 저장소 — 교재 원문을 옮기지 않는다). 교재 가져오기 파일
 * (data/private/, git 밖)은 있으면 zod·개수만 확인하고 내용은 출력하지 않는다.
 *
 * 안전: EVAL_OFFLINE_ONLY=1이면 네트워크 자체를 막는다(eval-english·eval-japanese와 같은 2차 방어선).
 */

import { existsSync, readFileSync } from "node:fs";
import {
  TOEIC_ANSWER_FEEDBACK_JSON_SCHEMA,
  TOEIC_CONFIDENCES,
  TOEIC_EXPR_EXTRACTION_JSON_SCHEMA,
  TOEIC_EXTRACT_ENTRIES_MAX,
  TOEIC_INFO_KINDS,
  TOEIC_MOCK_INFO_JSON_SCHEMA,
  TOEIC_MOCK_OPINION_JSON_SCHEMA,
  TOEIC_MOCK_PARTS,
  TOEIC_MOCK_PICTURE_JSON_SCHEMA,
  TOEIC_MOCK_READ_JSON_SCHEMA,
  TOEIC_MOCK_RESPOND_JSON_SCHEMA,
  TOEIC_OPINION_KINDS,
  TOEIC_PARTS,
  TOEIC_READ_KINDS,
  TOEIC_SPEAKING_POINTS_JSON_SCHEMA,
  buildFeedbackZod,
  buildPointsZod,
  toeicExprExtractionSchema,
  toeicImportFileSchema,
  toeicMockInfoSchema,
  toeicMockOpinionSchema,
  toeicMockPictureSchema,
  toeicMockReadSchema,
  toeicMockRespondSchema,
  type ToeicBookQuiz,
  type ToeicExprEntry,
  type ToeicExprExtraction,
  type ToeicExtractEntry,
  type ToeicFeedback,
  type ToeicInfoPart,
  type ToeicMockParts,
  type ToeicOpinionPart,
  type ToeicPictureGeneration,
  type ToeicPointsInput,
  type ToeicPointsItem,
  type ToeicReadPart,
  type ToeicRespondPart,
  type ToeicSpeakingPoints,
} from "../lib/ai/toeic/schemas";
import {
  TOEIC_EXTRACT_CALL_OPTIONS,
  TOEIC_EXTRACT_SYSTEM_PROMPT,
  TOEIC_EXTRACT_USER_TEXT,
  TOEIC_FEEDBACK_CALL_OPTIONS,
  TOEIC_FEEDBACK_SYSTEM_PROMPT,
  TOEIC_FEEDBACK_USER_TEMPLATE,
  TOEIC_IMAGE_PROMPT_SUFFIX,
  TOEIC_MOCK_CALL_OPTIONS,
  TOEIC_MOCK_COMMON,
  TOEIC_MOCK_INFO_TASK,
  TOEIC_MOCK_OPINION_TASK,
  TOEIC_MOCK_PICTURE_TASK,
  TOEIC_MOCK_READ_TASK,
  TOEIC_MOCK_RESPOND_TASK,
  TOEIC_MOCK_TASKS,
  TOEIC_MOCK_USER_TEMPLATE,
  TOEIC_POINTS_CALL_OPTIONS,
  TOEIC_POINTS_SYSTEM_PROMPT,
  TOEIC_POINTS_USER_TEMPLATE,
  buildFeedbackUserMessage,
  buildMockSystemPrompt,
  buildMockUserMessage,
  buildPointsUserMessage,
  buildSceneImagePrompt,
  normalizeMockExpressions,
  toeicMockCallLabel,
} from "../lib/ai/toeic/prompts";
import { cleanKeyExpressions, cleanToeicExtraction, mergeToeicExtractions } from "../lib/ai/toeic/extract-merge";
import { applyPointsResults, isToeicSetEnriched, planPointsChunks } from "../lib/ai/toeic/points";
import {
  buildFeedbackInput,
  buildFeedbackMaterial,
  cleanUsedExpressions,
  pickExpressionsForMock,
  postprocessFeedback,
  toMockRecordPart,
} from "../lib/ai/toeic/mock";
import {
  TOEIC_CHOICE_MIN,
  TOEIC_CLOZE_BLANK,
  TOEIC_SPEAK_SESSION_MAX,
  aggregateToeicStatsByMode,
  buildToeicChoiceQuestions,
  buildToeicReviewCandidatesByMode,
  buildToeicSpeakSession,
  maskCloze,
  speakKeyForBookQuiz,
  splitToeicItemsByMode,
  toeicWrongKeys,
  type ToeicQuizSessionLike,
} from "../lib/toeic-quiz";
import {
  TOEIC_MOCK_FORMAT,
  TOEIC_PART_DIRECTIONS,
  beginAnswer,
  firstPhase,
  nextPhase,
  remainingSec,
  toeicQuestionsForParts,
  toeicSpeechOutcome,
  type ToeicPhaseState,
} from "../lib/toeic-mock";
import {
  alignReadAloud,
  estimateToeicTotal,
  isNoResponseTranscript,
  normalizeReadWords,
  readProxyScore,
  toeicBandForScaled,
} from "../lib/toeic-score";
import { buildToeicListenScript } from "../lib/toeic-listen";
import { computeStreak } from "../lib/streak";
import { toeicStreakSessions } from "../lib/toeic-streak";
import {
  TOEIC_DUPLICATE_EXPRESSION_MESSAGE_KO,
  containsWordSequence,
  countWords,
  findDuplicateExpressionIndexes,
  matchKey,
} from "../lib/toeic-text";
import { applyFillPart, applyPictureImage, decideFillPart, decidePictureImage } from "../lib/toeic-mock-apply";
import {
  missingToeicMockParts,
  nextToeicMockTitle,
  segmentStressWords,
  segmentUsedExpressions,
  toeicImageUrl,
  toeicMockPartLabelKo,
  toeicTakeHref,
} from "../lib/toeic-mock-contract";
import { normalizeToeicMockRecord } from "../lib/toeic-normalize";
import { isRenderableToeicMock } from "../lib/toeic-record";
import {
  DEFAULT_TOEIC_IMAGE_MODEL,
  DEFAULT_TOEIC_IMAGE_QUALITY,
  generateSceneImage,
  resolveToeicImageModel,
  resolveToeicImageQuality,
} from "../lib/toeic-image";
import { applyAttemptAnswer, applyAttemptFinish, type ToeicMockRecord } from "../lib/store";
import {
  completeFinishAnswers,
  decideAttemptFinish,
  decideAttemptScope,
  isScorableToeicAnswer,
  isToeicAttemptClosed,
  maxToeicRecordingMs,
  recordedToeicCount,
  scoredToeicCount,
  toeicAttemptQuestions,
} from "../lib/toeic-attempt-rules";
import {
  TOEIC_SCORE_AUDIO_MAX_BYTES,
  TOEIC_SCORE_CONCURRENCY,
  buildToeicQuestionView,
  buildToeicQuestionViews,
  isAcceptedToeicAudioType,
  toeicAttemptHref,
  toeicAudioBaseType,
  toeicAudioFileName,
  toeicAudioTypeFromName,
  toeicScopeLabelKo,
} from "../lib/toeic-attempt-contract";
import {
  MIC_CHECK_GUM_TIMEOUT_MS,
  MIC_GUM_TIMEOUT_MS,
  MicError,
  encodeWavPcm16,
  mixToMono,
  pickMimeTypeFrom,
  resampleLinear,
  setAudioSessionPlayback,
  startRecording,
} from "../lib/mic-session";
import { pickAttemptsToEvict, toeicRecKey } from "../lib/toeic-rec-store";
import { markReadAloud } from "../lib/toeic-read-marks";
import {
  DEFAULT_TOEIC_TRANSCRIBE_MODEL,
  TOEIC_TRANSCRIBE_LANGUAGE,
  resolveToeicTranscribeModel,
  transcribeAnswer,
} from "../lib/toeic-transcribe";
import { splitForTts as splitFromShared } from "../lib/tts-split";
import { splitForTts as splitFromJa } from "../lib/ja-coaching-script";
import { TTS_TEXT_MAX_CHARS } from "../lib/tts-shared";
import {
  checkSpecSync,
  extractSpecBlocks,
  printSpecSyncDetails,
  type SpecSyncOutcome,
  type SpecSyncTarget,
} from "./spec-sync";

// .env.local / .env 로드 (없으면 무시). 이미 설정된 환경 변수가 우선한다(빈 값으로 미리 둔 키는 덮지 않는다).
for (const envFile of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // 파일이 없으면 건너뛴다
  }
}

// 비용 게이트 — EVAL_OFFLINE_ONLY=1이면 네트워크 자체를 막는다(eval-japanese와 같은 관용구).
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
  /** 조건이 없어 건너뜀 — 실패로 세지 않는다 */
  skip?: boolean;
}

function printTable(results: CheckResult[]): void {
  console.log("");
  console.log(`| 결과 | ${"영역".padEnd(16)} | 점검 항목 | 상세 |`);
  console.log(`|------|------------------|-----------|------|`);
  for (const r of results) {
    const tag = r.skip ? "SKIP" : r.pass ? "PASS" : "FAIL";
    console.log(`| ${tag} | ${r.book.padEnd(16)} | ${r.check} | ${r.detail} |`);
  }
  console.log("");
}

function makeAdder(results: CheckResult[], book: string) {
  return (check: string, pass: boolean, detail: string) => results.push({ book, check, pass, detail });
}

/** 결정적 rng — 셔플 결과를 고정해 값으로 단언한다 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * cloze 불변 점검(QA P2-1) — 가린 문제 문장에 정답이 **단어로** 남아 있는가(대소문자 무시).
 * maskCloze와 다른 방식(lookbehind 정규식 — Node 전용이라 eval에서만)으로 독립 구현한다.
 */
function answerVisibleInPrompt(prompt: string, answer: string): boolean {
  if (answer.trim() === "") return false;
  const esc = answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = /^[\p{L}\p{N}]/u.test(answer) ? "(?<![\\p{L}\\p{N}])" : "";
  const right = /[\p{L}\p{N}]$/u.test(answer) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${left}${esc}${right}`, "iu").test(prompt);
}

/** zod 실패 요약 — 경로·메시지만(값은 찍지 않는다) */
function issuesOf(r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): string {
  if (r.success || !r.error) return "통과";
  return r.error.issues
    .slice(0, 4)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join(" / ");
}

// ---------------------------------------------------------------------------
// 픽스처 — 전부 지어낸 표현·문장(교재 원문 아님)
// ---------------------------------------------------------------------------

interface FixtureRow {
  expression: string;
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
  span: string | null;
}

const ROWS: FixtureRow[] = [
  { expression: "hand out flyers", meaningKo: "전단지를 나눠 주다", example: "A man is handing out flyers near the station exit.", exampleKo: "한 남자가 역 출구 근처에서 전단지를 나눠 주고 있다.", span: "handing out flyers" },
  { expression: "wipe down a table", meaningKo: "테이블을 닦다", example: "A waiter is wiping down a table by the window.", exampleKo: "웨이터가 창가 테이블을 닦고 있다.", span: "wiping down a table" },
  { expression: "be lined up along", meaningKo: "~을 따라 줄지어 있다", example: "Bicycles are lined up along the fence.", exampleKo: "자전거들이 울타리를 따라 줄지어 있다.", span: "lined up along" },
  { expression: "grab a quick bite", meaningKo: "간단히 요기하다", example: "I usually grab a quick bite before my evening class.", exampleKo: "나는 보통 저녁 수업 전에 간단히 요기한다.", span: "grab a quick bite" },
  { expression: "free of charge", meaningKo: "무료로", example: "Parking is available free of charge for all guests.", exampleKo: "모든 투숙객은 무료로 주차할 수 있다.", span: "free of charge" },
  { expression: "in the long run", meaningKo: "장기적으로", example: "Working from home saves money in the long run.", exampleKo: "재택근무는 장기적으로 돈을 아껴 준다.", span: "in the long run" },
  { expression: "sign up for", meaningKo: "~에 등록하다", example: null, exampleKo: null, span: null },
];

function fixturePoints(row: FixtureRow): ToeicSpeakingPoints {
  return {
    exampleSpan: row.span,
    coreKo: "사진 묘사와 일상 질문에서 동작을 말할 때 점수가 된다",
    useIn: [
      { part: "q3_4", sentence: `In the middle of the picture, I can see someone who is about to ${row.expression}.`, sentenceKo: "사진 가운데에 막 그 동작을 하려는 사람이 보인다." },
      { part: "q5_7", sentence: `On busy weekdays, I sometimes ${row.expression} with my coworkers.`, sentenceKo: "바쁜 평일에는 가끔 동료들과 그렇게 한다." },
    ],
    frames: ["Near the entrance, a woman is ___.", "I think ___ because ___."],
    variations: [
      { en: `${row.expression} again`, ko: "다시 하다" },
      { en: `${row.expression} often`, ko: "자주 하다" },
    ],
    pronunciationKo: "단어를 끊지 말고 한 덩어리로 이어 말한다",
    pitfallKo: null,
    grammarKo: null,
    followUp: { en: "It looks like a very busy afternoon for everyone there.", ko: "모두에게 아주 바쁜 오후인 것 같다." },
  };
}

function fixtureEntry(row: FixtureRow, i: number, withPoints = true): ToeicExprEntry {
  return {
    no: i + 1,
    expression: row.expression,
    meaningKo: row.meaningKo,
    example: row.example,
    exampleKo: row.exampleKo,
    points: withPoints ? fixturePoints(row) : null,
    confidence: "high",
    partial: false,
  };
}

const FIXTURE_QUIZ: ToeicBookQuiz[] = [
  { no: 1, promptKo: "그는 역 앞에서 전단지를 나눠 주고 있어요.", hint: "역: station", modelAnswer: "He is handing out flyers in front of the station.", keyExpressions: ["hand out flyers"] },
  { no: 2, promptKo: "주차는 무료예요.", hint: null, modelAnswer: "Parking is free of charge.", keyExpressions: [] },
];

function fixtureSet(withPoints = true) {
  return { entries: ROWS.map((r, i) => fixtureEntry(r, i, withPoints)), quiz: clone(FIXTURE_QUIZ) };
}

function extractEntry(over: Partial<ToeicExtractEntry> = {}): ToeicExtractEntry {
  const r = ROWS[0];
  return { no: 1, expression: r.expression, meaningKo: r.meaningKo, example: r.example, exampleKo: r.exampleKo, partial: false, confidence: "high", ...over };
}

function extraction(over: Partial<ToeicExprExtraction> = {}): ToeicExprExtraction {
  return { isExpressionPage: true, dayNo: 3, topicKo: "장보기", entries: [extractEntry()], quiz: [clone(FIXTURE_QUIZ[0])], ...over };
}

/** 단어 배열을 n개씩 묶어 chunks로 — 공백 하나로 이으면 원문과 같다 */
function chunkWords(text: string, n: number): string[] {
  const w = text.split(" ");
  const out: string[] = [];
  for (let i = 0; i < w.length; i += n) out.push(w.slice(i, i + n).join(" "));
  return out;
}

const READ_TEXT_1 =
  "Are you looking for a relaxing weekend getaway? Visit Maple Grove Lodge, just forty minutes from downtown Brookfield. Our cozy cabins come with fireplaces, private decks, and free breakfast every morning. This month only, guests who book two nights will receive a third night at half price. You can also enjoy guided hikes, canoe rentals, and live music on Saturday evenings. Rooms fill up quickly during the autumn season, so reserve your stay today. Call us at 555-0142 or visit our website to see photos of every cabin.";
const READ_TEXT_2 =
  "Attention, passengers traveling to Riverside on the six fifteen express. Due to a signal problem near Oakdale Station, this train will depart from platform nine instead of platform four. We expect a delay of about twenty minutes. Passengers with reserved seats should keep their tickets, as seat numbers will not change. Coffee, sandwiches, and bottled water are available at the kiosk next to the main entrance. We apologize for the inconvenience and thank you for your patience. Please listen for further announcements as we receive more information from the operations team.";

function readFixture(): ToeicReadPart {
  return {
    items: [
      { kind: "advertisement", text: READ_TEXT_1, chunks: chunkWords(READ_TEXT_1, 5), stressWords: ["relaxing", "Maple", "cabins", "fireplaces", "breakfast", "half"], tipsKo: ["나열(A, B, and C)은 앞 항목을 올리고 마지막을 내려 읽는다.", "전화번호는 숫자를 끊어서 또박또박 읽는다."] },
      { kind: "announcement", text: READ_TEXT_2, chunks: chunkWords(READ_TEXT_2, 4), stressWords: ["Riverside", "signal", "platform", "nine", "delay", "twenty"], tipsKo: ["고유명사는 첫 음절에 힘을 준다.", "숫자와 시각은 천천히 끊어 읽는다."] },
    ],
  };
}

function pictureFixture(): ToeicPictureGeneration {
  return {
    items: [
      {
        place: "park",
        imagePrompt:
          "A sunny public park in the afternoon. On the left, a woman in a yellow jacket is walking a small brown dog along a paved path. In the center, two men in gray sweaters are sitting on a wooden bench, reading newspapers. On the right, an older man in a blue cap is feeding pigeons near a fountain. In the background there are tall green trees, a red brick building, and several parked bicycles. Soft natural light, clear sky, realistic colors.",
        sceneKo: "햇살 좋은 공원 오후 풍경이다. 왼쪽에는 노란 재킷을 입은 여자가 개를 산책시키고, 가운데 벤치에 두 남자가 신문을 읽고 있다.",
        sampleAnswer:
          "This picture was taken in a park on a sunny afternoon. On the left side of the picture, a woman in a yellow jacket is walking her dog along the path. In the middle, two men are sitting on a bench and reading newspapers. On the right, an older man is feeding some pigeons near a fountain. In the background, there are tall trees and a few bicycles are parked next to a building. Overall, it looks like a peaceful day.",
        keyPointsKo: ["장소와 날씨를 먼저 말한다", "가운데 두 남자의 동작을 현재진행형으로", "배경의 나무와 자전거를 There are로"],
        usedExpressions: [{ expression: "Be Lined Up Along", span: "bicycles are parked" }],
      },
      {
        place: "Cafe",
        imagePrompt:
          "A busy cafe interior in the morning. Near the counter on the left, a barista in a black apron is pouring milk into a cup. In the center, a young woman in a white shirt is typing on a laptop at a round table. On the right, two coworkers in suits are talking over coffee by a large window. Shelves with jars and plants line the back wall. Warm indoor lighting, realistic photo.",
        sceneKo: "아침의 붐비는 카페 안이다. 왼쪽 카운터에서 바리스타가 우유를 따르고, 가운데 여자가 노트북으로 작업하고 있다.",
        sampleAnswer:
          "This picture was taken inside a cafe. On the left, a barista wearing a black apron is pouring milk into a cup. In the center of the picture, a woman is typing on her laptop at a round table. On the right side, two people in suits are having a conversation by the window. There are some shelves with jars and plants on the back wall. It seems like a busy but cozy morning.",
        keyPointsKo: ["카운터의 바리스타 동작", "노트북으로 일하는 여자", "창가에서 대화하는 두 사람"],
        usedExpressions: [],
      },
    ],
  };
}

function respondFixture(): ToeicRespondPart {
  return {
    topicKo: "운동",
    intro: "Imagine that a marketing firm is doing research in your area. You have agreed to take part in a telephone interview about exercise.",
    questions: [
      { question: "How often do you exercise, and where do you usually do it?", sampleAnswer: "I exercise about three times a week. I usually go to a gym near my office because it is convenient, and I can work out right after work.", tipKo: "빈도와 장소를 둘 다 말한다", usedExpressions: [] },
      { question: "Who do you usually exercise with, and why?", sampleAnswer: "I usually exercise with my coworker. We keep each other motivated, so it is much easier to stick to our routine.", tipKo: "누구와 하는지 먼저 말하고 이유를 붙인다", usedExpressions: [{ expression: "in the long run", span: "keep fit in winter" }] },
      { question: "Which do you prefer, exercising indoors or outdoors? Why?", sampleAnswer: "I prefer exercising outdoors. First, fresh air makes me feel more energetic than the air in a crowded gym. Also, I can enjoy the scenery while I am jogging along the river, so I never get bored. For example, last weekend I ran for an hour without noticing the time. That is why I like working out outside.", tipKo: "선택을 먼저 밝히고 이유 두 개를 든다", usedExpressions: [] },
    ],
  };
}

function infoFixture(): ToeicInfoPart {
  return {
    table: {
      kind: "schedule",
      title: "Greenfield Business Forum",
      meta: ["Date: Friday, June 12", "Location: Harbor Hall, Room 300", "Registration fee: $45"],
      rows: [
        { left: "9:00 - 9:30", right: "Registration and coffee" },
        { left: "9:30 - 10:30", right: "Keynote: Growing a Small Business (Laura Kim)" },
        { left: "10:30 - 11:30", right: "Workshop: Social Media Marketing" },
        { left: "11:30 - 1:00", right: "Lunch break" },
        { left: "1:00 - 2:00", right: "Panel: Hiring Your First Employees" },
        { left: "2:00 - 3:00", right: "Workshop: Managing Cash Flow (Daniel Ortiz)" },
      ],
      notes: ["* Lunch is not included."],
    },
    callerIntro: "Hi, this is Mark Allen. I signed up for the business forum, and I have a few questions about the schedule.",
    questions: [
      { question: "What time does the forum start, and where is it held?", sampleAnswer: "The forum starts at 9 A.M. with registration and coffee. It will be held in Room 300 at Harbor Hall.", tipKo: "시간과 장소를 표에서 찾아 문장으로 바꾼다", usedExpressions: [] },
      { question: "I heard that lunch is provided for all participants. Is that right?", sampleAnswer: "I'm sorry, but that's not correct. Lunch is not included, so you will need to have lunch on your own during the break.", tipKo: "잘못 안 정보를 정중하게 정정한다", usedExpressions: [] },
      { question: "Could you tell me about all the workshops on the schedule?", sampleAnswer: "Sure. There are two workshops. First, at 10:30 A.M., there is a workshop on social media marketing. Then, after the lunch break, at 2 P.M., Daniel Ortiz will lead a workshop on managing cash flow. You can attend both of them.", tipKo: "해당 항목을 시간 순서 연결어로 모두 말한다", usedExpressions: [] },
    ],
  };
}

const OPINION_ANSWER =
  "I agree that it is better for employees to work from home a few days a week. First, working from home saves a lot of time. Without a long commute, people can start work earlier and feel less tired. For example, when my company allowed remote work twice a week, I used the extra hour to exercise in the morning, and I became more focused during the day. Second, it helps people balance work and family life. Parents can take care of their children more easily, which reduces stress and improves their performance. Of course, meeting in person is still important, so a mix of office days and home days works best. For these reasons, I think working from home a few days a week is a good idea.";

function opinionFixture(): ToeicOpinionPart {
  return {
    kind: "agree",
    question: "Do you agree or disagree with the following statement? It is better for employees to work from home a few days a week. Use specific reasons and examples to support your answer.",
    sampleAnswer: OPINION_ANSWER,
    outlineKo: ["입장: 찬성", "이유 1: 출퇴근 시간 절약", "예시: 아침 운동으로 집중력 향상", "이유 2: 일과 가정의 균형", "마무리: 혼합 근무가 최선"],
    tipKo: "입장을 처음부터 끝까지 유지한다",
    usedExpressions: [{ expression: "in the long run", span: "saves a lot of time" }],
  };
}

const TRANSCRIPT_Q11 =
  "I agree working from home is good because I can save time and I can sleep more in the morning so I am not tired in the office";

function feedbackFixture(): ToeicFeedback {
  return {
    score: 3,
    summaryKo: "입장은 분명하지만 이유를 뒷받침하는 예시가 부족해요.",
    strengths: ["첫 문장에서 입장을 바로 밝혔어요"],
    fixes: [{ said: "I can sleep more in the morning", better: "I can get more sleep in the morning", whyKo: "get more sleep이 더 자연스럽다" }],
    missingKo: ["구체적인 개인 경험 예시"],
    improvedAnswer: "I agree that working from home a few days a week is better, because I can save commuting time and get more sleep.",
    tryExpressions: ["in the long run"],
  };
}

// ---------------------------------------------------------------------------
// 1. 상수 정합 + 호출 옵션 ↔ 스펙 문장
// ---------------------------------------------------------------------------

const TOEIC_SPEC_URL = new URL("../docs/harness/toeic.md", import.meta.url);

function schemaAt(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const k of path) cur = (cur as Record<string, unknown> | undefined)?.[k];
  return cur;
}

function runConstantChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "상수 정합");
  const enumEq = (name: string, schema: { schema: unknown }, path: string[], expected: readonly string[]) => {
    const e = schemaAt(schema.schema, path) as string[] | undefined;
    add(`JSON Schema enum == 상수: ${name}`, Array.isArray(e) && e.join(",") === expected.join(","), `schema=[${e?.join(",")}]`);
  };
  enumEq("useIn.part == TOEIC_PARTS", TOEIC_SPEAKING_POINTS_JSON_SCHEMA, ["properties", "items", "items", "properties", "useIn", "items", "properties", "part", "enum"], TOEIC_PARTS);
  enumEq("confidence == TOEIC_CONFIDENCES", TOEIC_EXPR_EXTRACTION_JSON_SCHEMA, ["properties", "entries", "items", "properties", "confidence", "enum"], TOEIC_CONFIDENCES);
  enumEq("read.kind == TOEIC_READ_KINDS", TOEIC_MOCK_READ_JSON_SCHEMA, ["properties", "items", "items", "properties", "kind", "enum"], TOEIC_READ_KINDS);
  enumEq("info.table.kind == TOEIC_INFO_KINDS", TOEIC_MOCK_INFO_JSON_SCHEMA, ["properties", "table", "properties", "kind", "enum"], TOEIC_INFO_KINDS);
  enumEq("opinion.kind == TOEIC_OPINION_KINDS", TOEIC_MOCK_OPINION_JSON_SCHEMA, ["properties", "kind", "enum"], TOEIC_OPINION_KINDS);
  add("파트 5개 순서(read·picture·respond·info·opinion)", TOEIC_MOCK_PARTS.join(",") === "read,picture,respond,info,opinion", TOEIC_MOCK_PARTS.join(","));

  // 호출 옵션 — 스펙 문장 "temperature X, maxOutputTokens Y, call 라벨 `Z`"를 읽어 대조(숫자 드리프트 방지)
  const spec = readFileSync(TOEIC_SPEC_URL, "utf-8");
  const found = new Map<string, { t: number; max: number }>();
  for (const m of spec.matchAll(/temperature ([\d.]+), maxOutputTokens (\d+), call 라벨 `([^`]+)`/g)) {
    found.set(m[3], { t: Number(m[1]), max: Number(m[2]) });
  }
  const opt = (label: string, specLabel: string, t: number, max: number) => {
    const s = found.get(specLabel);
    add(`호출 옵션 == 스펙: ${specLabel}`, !!s && s.t === t && s.max === max && (specLabel.includes("<part>") || label === specLabel), s ? `스펙 t=${s.t} max=${s.max} · 코드 t=${t} max=${max} label=${label}` : "스펙 문장을 못 찾음");
  };
  opt(TOEIC_EXTRACT_CALL_OPTIONS.call, "toeic_extract", TOEIC_EXTRACT_CALL_OPTIONS.temperature, TOEIC_EXTRACT_CALL_OPTIONS.maxOutputTokens);
  opt(TOEIC_POINTS_CALL_OPTIONS.call, "toeic_points", TOEIC_POINTS_CALL_OPTIONS.temperature, TOEIC_POINTS_CALL_OPTIONS.maxOutputTokens);
  opt(toeicMockCallLabel("read"), "toeic_mock_<part>", TOEIC_MOCK_CALL_OPTIONS.temperature, TOEIC_MOCK_CALL_OPTIONS.maxOutputTokens);
  opt(TOEIC_FEEDBACK_CALL_OPTIONS.call, "toeic_feedback", TOEIC_FEEDBACK_CALL_OPTIONS.temperature, TOEIC_FEEDBACK_CALL_OPTIONS.maxOutputTokens);
  add("호출 C 라벨 toeic_mock_<part>", TOEIC_MOCK_PARTS.every((p) => toeicMockCallLabel(p) === `toeic_mock_${p}`), TOEIC_MOCK_PARTS.map(toeicMockCallLabel).join(","));
  return results;
}

// ---------------------------------------------------------------------------
// 2. 호출 A zod (§2-4)
// ---------------------------------------------------------------------------

function runExtractZodChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "호출 A zod(§2-4)");
  const ok = (x: unknown) => toeicExprExtractionSchema.safeParse(x);

  {
    const r = ok(extraction({ entries: ROWS.map((row, i) => extractEntry({ no: i + 1, expression: row.expression, meaningKo: row.meaningKo, example: row.example, exampleKo: row.exampleKo })) }));
    add("정상 통과(예문 없는 항목 포함)", r.success, issuesOf(r));
  }
  {
    const r = ok(extraction({ entries: [extractEntry({ no: null }), extractEntry({ no: null, expression: "wipe down a table" })] }));
    add("통과: no가 null인 항목끼리는 중복으로 보지 않음", r.success, issuesOf(r));
  }
  {
    const r = ok(extraction({ isExpressionPage: false, dayNo: null, topicKo: null, entries: [], quiz: [] }));
    add("통과: 표현 페이지 아님 + 빈 배열", r.success, issuesOf(r));
  }
  {
    // QA P2-2 — 잘린 항목은 뜻이 사진 밖일 수 있다. 판독 zod는 partial 항목의 빈 뜻을 받는다(검토 화면에서 사람이 채운다)
    const r = ok(extraction({ entries: [extractEntry({ partial: true, meaningKo: "", confidence: "low" })] }));
    add("통과: partial=true 항목은 meaningKo가 비어도 됨(P2-2 — 판독 zod만)", r.success, issuesOf(r));
    const merged = mergeToeicExtractions([{ photoIndex: 0, extraction: extraction({ entries: [extractEntry({ partial: true, meaningKo: "  " })] }) }]);
    add("판독 초안: 빈 뜻 partial 항목은 초안에 빈칸으로 남음(저장 zod가 1자 이상을 강제)", merged.drafts[0]?.entries[0]?.meaningKo === "" && merged.drafts[0].entries[0].partial, `meaningKo=${JSON.stringify(merged.drafts[0]?.entries[0]?.meaningKo)}`);
  }
  {
    // 판독은 사진에 있는 그대로 — 표현 중복은 거부하지 않는다(재요청을 태우지 않음). 검토 화면 표시 + 저장·가져오기 zod가 거부(§7-1)
    const r = ok(extraction({ entries: [extractEntry({ no: 1 }), extractEntry({ no: 2, expression: "Hand Out  Flyers" })] }));
    add("통과: 판독 zod는 같은 사진 안 표현 중복을 거부하지 않음(저장 쪽이 거부)", r.success, issuesOf(r));
  }
  const reject: { name: string; input: unknown }[] = [
    { name: "isExpressionPage=false인데 entries 있음", input: extraction({ isExpressionPage: false }) },
    { name: "expression에 한글", input: extraction({ entries: [extractEntry({ expression: "hand out 전단" })] }) },
    { name: "expression에 라틴 없음", input: extraction({ entries: [extractEntry({ expression: "123" })] }) },
    { name: "expression 81자", input: extraction({ entries: [extractEntry({ expression: "a".repeat(81) })] }) },
    { name: "meaningKo에 한글 없음", input: extraction({ entries: [extractEntry({ meaningKo: "to give out" })] }) },
    { name: "partial=false인데 meaningKo 빈 문자열(P2-2 — 빈 뜻은 잘린 항목만)", input: extraction({ entries: [extractEntry({ partial: false, meaningKo: "" })] }) },
    { name: "partial=true여도 비어 있지 않은 meaningKo는 한글 포함(P2-2)", input: extraction({ entries: [extractEntry({ partial: true, meaningKo: "to give out" })] }) },
    { name: "example null인데 exampleKo 있음", input: extraction({ entries: [extractEntry({ example: null, exampleKo: "해석" })] }) },
    { name: "example에 한글", input: extraction({ entries: [extractEntry({ example: "A man is 전단 handing out." })] }) },
    { name: "example 2자", input: extraction({ entries: [extractEntry({ example: "Hi" })] }) },
    { name: "exampleKo에 한글 없음", input: extraction({ entries: [extractEntry({ exampleKo: "A man is handing out flyers." })] }) },
    { name: "같은 사진 안 no 중복", input: extraction({ entries: [extractEntry({ no: 2 }), extractEntry({ no: 2, expression: "wipe down a table" })] }) },
    { name: "no 0", input: extraction({ entries: [extractEntry({ no: 0 })] }) },
    { name: "dayNo 1000", input: extraction({ dayNo: 1000 }) },
    { name: `entries ${TOEIC_EXTRACT_ENTRIES_MAX + 1}개`, input: extraction({ entries: Array.from({ length: TOEIC_EXTRACT_ENTRIES_MAX + 1 }, (_, i) => extractEntry({ no: i + 1 })) }) },
    { name: "quiz 7개", input: extraction({ quiz: Array.from({ length: 7 }, (_, i) => ({ ...FIXTURE_QUIZ[0], no: i + 1 })) }) },
    { name: "quiz.modelAnswer에 한글", input: extraction({ quiz: [{ ...FIXTURE_QUIZ[0], modelAnswer: "He is 전단 handing." }] }) },
    { name: "quiz.promptKo에 한글 없음", input: extraction({ quiz: [{ ...FIXTURE_QUIZ[0], promptKo: "He is handing out flyers." }] }) },
    { name: "quiz.hint 61자", input: extraction({ quiz: [{ ...FIXTURE_QUIZ[0], hint: "가".repeat(61) }] }) },
    { name: "confidence enum 밖", input: extraction({ entries: [extractEntry({ confidence: "unsure" as ToeicExtractEntry["confidence"] })] }) },
  ];
  for (const rc of reject) add(`거부: ${rc.name}`, !ok(rc.input).success, "거부되어야 함");
  return results;
}

// ---------------------------------------------------------------------------
// 3. 호출 B zod (§3-4)
// ---------------------------------------------------------------------------

function pointsInputs(): ToeicPointsInput[] {
  return ROWS.map((r, i) => ({ index: i, expression: r.expression, meaningKo: r.meaningKo, example: r.example, exampleKo: r.exampleKo }));
}

function pointsItems(): ToeicPointsItem[] {
  return ROWS.map((r, i) => ({ index: i, ...fixturePoints(r) }));
}

function runPointsZodChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "호출 B zod(§3-4)");
  const schema = buildPointsZod(pointsInputs());
  {
    const r = schema.safeParse({ items: pointsItems() });
    add("정상 통과(7개, 예문 없는 항목 exampleSpan null)", r.success, issuesOf(r));
  }
  {
    const items = pointsItems();
    items[0].pitfallKo = "flyer는 셀 수 있는 명사라 복수형으로 쓴다";
    items[0].grammarKo = null;
    const r = schema.safeParse({ items });
    add("통과: pitfallKo 있음·grammarKo null", r.success, issuesOf(r));
  }
  const mut = (name: string, f: (items: ToeicPointsItem[]) => void) => {
    const items = pointsItems();
    f(items);
    add(`거부: ${name}`, !schema.safeParse({ items }).success, "거부되어야 함");
  };
  mut("exampleSpan이 예문 밖", (it) => { it[0].exampleSpan = "handing out coupons"; });
  mut("exampleSpan 대소문자 다름(대소문자 구분)", (it) => { it[0].exampleSpan = "Handing out flyers"; });
  mut("예문 있는데 exampleSpan null", (it) => { it[1].exampleSpan = null; });
  mut("예문 null인데 exampleSpan 있음", (it) => { it[6].exampleSpan = "sign up for"; });
  mut("index 누락", (it) => { it.pop(); });
  mut("index 중복", (it) => { it[6] = { ...it[5] }; });
  mut("모르는 index", (it) => { it[6] = { ...it[6], index: 99 }; });
  mut("useIn part 중복", (it) => { it[0].useIn[1].part = "q3_4"; });
  mut("useIn 1개", (it) => { it[0].useIn = [it[0].useIn[0]]; });
  mut("useIn 4개", (it) => { it[0].useIn = [...it[0].useIn, { ...it[0].useIn[0], part: "q8_10" }, { ...it[0].useIn[0], part: "q11" }]; });
  mut("useIn.sentence 5단어", (it) => { it[0].useIn[0].sentence = "I hand out flyers daily."; });
  mut("useIn.sentence 33단어", (it) => { it[0].useIn[0].sentence = Array.from({ length: 33 }, () => "word").join(" "); });
  mut("useIn.sentence에 한글", (it) => { it[0].useIn[0].sentence = "In the picture, a man is handing out 전단지 near the exit."; });
  mut("useIn.sentence가 교재 예문과 같음", (it) => { it[0].useIn[0].sentence = ROWS[0].example!; });
  mut("useIn.sentenceKo에 한글 없음", (it) => { it[0].useIn[0].sentenceKo = "A man hands out flyers."; });
  mut('frames에 "___" 없음', (it) => { it[0].frames = ["Near the entrance, a woman is waiting."]; });
  mut("frames 0개", (it) => { it[0].frames = []; });
  mut("frames 4개", (it) => { it[0].frames = ["a ___ b", "c ___ d", "e ___ f", "g ___ h"]; });
  mut("variations 1개", (it) => { it[0].variations = [it[0].variations[0]]; });
  mut("variations.en에 한글", (it) => { it[0].variations[0].en = "hand out 쿠폰"; });
  mut("variations.ko에 한글 없음", (it) => { it[0].variations[0].ko = "again"; });
  mut("coreKo에 한글 없음", (it) => { it[0].coreKo = "useful in picture tasks"; });
  mut("pronunciationKo 5자", (it) => { it[0].pronunciationKo = "이어말한다"; });
  mut("pitfallKo 3자", (it) => { it[0].pitfallKo = "관사다"; });
  mut("followUp.en에 한글", (it) => { it[0].followUp.en = "It looks like a busy 오후 for everyone."; });
  mut("followUp.ko에 한글 없음", (it) => { it[0].followUp.ko = "busy afternoon"; });
  return results;
}

// ---------------------------------------------------------------------------
// 4. 호출 C zod (§4-9) — 파트별
// ---------------------------------------------------------------------------

function runMockZodChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "호출 C zod(§4-9)");

  // C1
  {
    const r = toeicMockReadSchema.safeParse(readFixture());
    add(`C1 정상 통과(지문 ${countWords(READ_TEXT_1)}·${countWords(READ_TEXT_2)}단어)`, r.success, issuesOf(r));
    const t60 = Array.from({ length: 60 }, () => "go").join(" ");
    const edge = readFixture();
    edge.items[0] = { ...edge.items[0], text: t60, chunks: chunkWords(t60, 6), stressWords: ["go", "go", "go", "go"] };
    const r2 = toeicMockReadSchema.safeParse(edge);
    add("C1 넓은 폭: 60단어 지문 통과(프롬프트 80~110 < zod 60~130)", r2.success, issuesOf(r2));
  }
  const readMut = (name: string, f: (p: ToeicReadPart) => void) => {
    const p = readFixture();
    f(p);
    add(`C1 거부: ${name}`, !toeicMockReadSchema.safeParse(p).success, "거부되어야 함");
  };
  readMut("chunks 불일치(단어 하나 빠짐)", (p) => { p.items[0].chunks[0] = p.items[0].chunks[0].split(" ").slice(1).join(" "); });
  readMut("stressWord가 지문에 없음", (p) => { p.items[0].stressWords[0] = "swimming"; });
  readMut("stressWord가 단어 경계 아님(Riverside 속 side)", (p) => { p.items[1].stressWords[0] = "side"; });
  readMut("items 1개", (p) => { p.items = [p.items[0]]; });
  readMut("두 지문 kind 같음", (p) => { p.items[1].kind = "advertisement"; });
  readMut("지문 59단어", (p) => { const t = Array.from({ length: 59 }, () => "go").join(" "); p.items[0] = { ...p.items[0], text: t, chunks: [t], stressWords: ["go", "go", "go", "go"] }; });
  readMut("tipsKo에 한글 없음", (p) => { p.items[0].tipsKo[0] = "read the list with rising tone"; });
  readMut("stressWords 3개", (p) => { p.items[0].stressWords = p.items[0].stressWords.slice(0, 3); });
  {
    // 연속 공백을 접은 뒤 비교 — 줄바꿈이 섞여도 같은 지문이면 통과
    const p = readFixture();
    p.items[0].text = p.items[0].text.replace("getaway? Visit", "getaway?\n  Visit");
    const r = toeicMockReadSchema.safeParse(p);
    add("C1 통과: 연속 공백을 접으면 chunks 이음 = text", r.success, issuesOf(r));
  }

  // C2
  {
    const r = toeicMockPictureSchema.safeParse(pictureFixture());
    add("C2 정상 통과", r.success, issuesOf(r));
  }
  const picMut = (name: string, f: (p: ToeicPictureGeneration) => void) => {
    const p = pictureFixture();
    f(p);
    add(`C2 거부: ${name}`, !toeicMockPictureSchema.safeParse(p).success, "거부되어야 함");
  };
  picMut("place 같음(대소문자 무시)", (p) => { p.items[1].place = "PARK"; });
  picMut("imagePrompt 39단어", (p) => { p.items[0].imagePrompt = Array.from({ length: 39 }, () => "tree").join(" "); });
  picMut("sampleAnswer에 한글", (p) => { p.items[0].sampleAnswer += " 평화로운 날이다."; });
  picMut("keyPointsKo 2개", (p) => { p.items[0].keyPointsKo = p.items[0].keyPointsKo.slice(0, 2); });
  picMut("sceneKo에 한글 없음", (p) => { p.items[0].sceneKo = "A sunny park."; });

  // C3
  {
    const r = toeicMockRespondSchema.safeParse(respondFixture());
    add("C3 정상 통과", r.success, issuesOf(r));
  }
  const resMut = (name: string, f: (p: ToeicRespondPart) => void) => {
    const p = respondFixture();
    f(p);
    add(`C3 거부: ${name}`, !toeicMockRespondSchema.safeParse(p).success, "거부되어야 함");
  };
  resMut("질문이 ?로 안 끝남", (p) => { p.questions[0].question = "Tell me how often you exercise."; });
  resMut("questions 2개", (p) => { p.questions = p.questions.slice(0, 2); });
  resMut("셋째 답 34단어(<35)", (p) => { p.questions[2].sampleAnswer = Array.from({ length: 34 }, () => "yes").join(" "); });
  resMut("첫째 답 14단어(<15)", (p) => { p.questions[0].sampleAnswer = Array.from({ length: 14 }, () => "yes").join(" "); });
  resMut("topicKo에 한글 없음", (p) => { p.topicKo = "exercise"; });

  // C4
  {
    const r = toeicMockInfoSchema.safeParse(infoFixture());
    add("C4 정상 통과(시간 칸은 숫자만이어도 허용)", r.success, issuesOf(r));
  }
  const infMut = (name: string, f: (p: ToeicInfoPart) => void) => {
    const p = infoFixture();
    f(p);
    add(`C4 거부: ${name}`, !toeicMockInfoSchema.safeParse(p).success, "거부되어야 함");
  };
  infMut("rows 3개", (p) => { p.table.rows = p.table.rows.slice(0, 3); });
  infMut("meta 0개", (p) => { p.table.meta = []; });
  infMut("notes 4개", (p) => { p.table.notes = ["* a", "* b", "* c", "* d"]; });
  infMut("rows.left에 한글", (p) => { p.table.rows[0].left = "오전 9:00"; });
  infMut("questions 4개", (p) => { p.questions = [...p.questions, p.questions[0]]; });
  infMut("셋째 답 24단어(<25)", (p) => { p.questions[2].sampleAnswer = Array.from({ length: 24 }, () => "yes").join(" "); });

  // C5
  {
    const r = toeicMockOpinionSchema.safeParse(opinionFixture());
    add(`C5 정상 통과(모범답변 ${countWords(OPINION_ANSWER)}단어)`, r.success, issuesOf(r));
  }
  const opMut = (name: string, f: (p: ToeicOpinionPart) => void) => {
    const p = opinionFixture();
    f(p);
    add(`C5 거부: ${name}`, !toeicMockOpinionSchema.safeParse(p).success, "거부되어야 함");
  };
  opMut("sampleAnswer 79단어(<80)", (p) => { p.sampleAnswer = Array.from({ length: 79 }, () => "yes").join(" "); });
  opMut("outlineKo 2개", (p) => { p.outlineKo = p.outlineKo.slice(0, 2); });
  opMut("kind enum 밖", (p) => { p.kind = "debate" as ToeicOpinionPart["kind"]; });
  opMut("tipKo에 한글 없음", (p) => { p.tipKo = "keep one position"; });
  return results;
}

// ---------------------------------------------------------------------------
// 5. 호출 D zod (§5-3)
// ---------------------------------------------------------------------------

function runFeedbackZodChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "호출 D zod(§5-3)");
  const q11 = buildFeedbackZod({ maxScore: 5, transcript: TRANSCRIPT_Q11 });
  const q3 = buildFeedbackZod({ maxScore: 3, transcript: TRANSCRIPT_Q11 });
  {
    const r = q11.safeParse(feedbackFixture());
    add("정상 통과", r.success, issuesOf(r));
  }
  {
    const fb = feedbackFixture();
    fb.fixes[0].said = "i  CAN sleep   more in the MORNING";
    fb.score = 5;
    const r = q11.safeParse(fb);
    add("통과: said 대소문자·연속 공백 무시 / Q11 만점 5", r.success, issuesOf(r));
  }
  const mut = (name: string, schema: typeof q11, f: (fb: ToeicFeedback) => void) => {
    const fb = feedbackFixture();
    f(fb);
    add(`거부: ${name}`, !schema.safeParse(fb).success, "거부되어야 함");
  };
  mut("fixes.said가 전사문 밖(환각)", q11, (fb) => { fb.fixes[0].said = "I really love my long commute"; });
  {
    // QA P2-3 — 문장부호는 무시하되(쉼표 하나 빠진 인용 통과) 단어 순서·단어 경계는 그대로(환각 가드 유지)
    const punctuated = "I agree, working from home is good because I can save time, and I can sleep more in the morning.";
    const zp = buildFeedbackZod({ maxScore: 5, transcript: punctuated });
    const withSaid = (said: string) => {
      const fb = feedbackFixture();
      fb.fixes[0].said = said;
      return zp.safeParse(fb);
    };
    for (const [name, said] of [
      ["쉼표 하나 빠진 said", "I agree working from home is good"],
      ["전사문에 없는 마침표를 붙인 said", "I can save time."],
      ["문장부호·대소문자·연속 공백이 다른 said", "i CAN save   time,  and i can SLEEP"],
    ] as const) {
      const r = withSaid(said);
      add(`통과: ${name}(P2-3 문장부호 무시)`, r.success, issuesOf(r));
    }
    for (const [name, said] of [
      ["순서를 바꾼 said", "working from home I agree"],
      ["사이 단어를 뺀 이어 붙이기", "I agree from home"],
      ["단어 조각으로 시작하는 said(단어 경계)", "gree working from home"],
      ["문장부호뿐인 said", ", ."],
    ] as const) {
      add(`거부: ${name}(P2-3 — 환각 가드 유지)`, !withSaid(said).success, "거부되어야 함");
    }
    add(
      "containsWordSequence: 아포스트로피는 단어 안에서 유지(can't ≠ cant)·둥근 따옴표 통일",
      containsWordSequence("I can’t go today.", "can't go") && !containsWordSequence("I can't go today.", "cant go"),
      "",
    );
  }
  mut("score 4 (Q3 만점 3 초과)", q3, (fb) => { fb.score = 4; });
  mut("score 6 (Q11 만점 5 초과)", q11, (fb) => { fb.score = 6; });
  mut("score -1", q11, (fb) => { fb.score = -1; });
  mut("score 2.5 (정수 아님)", q11, (fb) => { fb.score = 2.5; });
  mut("strengths 0개", q11, (fb) => { fb.strengths = []; });
  mut("strengths 4개", q11, (fb) => { fb.strengths = ["가", "나", "다", "라"]; });
  mut("fixes 6개", q11, (fb) => { fb.fixes = Array.from({ length: 6 }, () => ({ ...fb.fixes[0] })); });
  mut("missingKo 4개", q11, (fb) => { fb.missingKo = ["가", "나", "다", "라"]; });
  mut("improvedAnswer에 한글", q11, (fb) => { fb.improvedAnswer = "I agree 재택근무 is better."; });
  mut("summaryKo에 한글 없음", q11, (fb) => { fb.summaryKo = "Good answer."; });
  return results;
}

// ---------------------------------------------------------------------------
// 6. 호출 A 후처리 (§2-4 1~5)
// ---------------------------------------------------------------------------

function runExtractMergeChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "판독 후처리(§2-4)");
  const e = (no: number | null, i: number, over: Partial<ToeicExtractEntry> = {}) =>
    extractEntry({ no, expression: ROWS[i].expression, meaningKo: ROWS[i].meaningKo, example: ROWS[i].example, exampleKo: ROWS[i].exampleKo, ...over });

  // 1. 공백 정리
  {
    const c = cleanToeicExtraction(extraction({ topicKo: "  장보기 ", entries: [e(1, 0, { expression: "hand   out\nflyers", example: "A man is handing\n out flyers." })] }));
    const ok = c.topicKo === "장보기" && c.entries[0].expression === "hand out flyers" && c.entries[0].example === "A man is handing out flyers.";
    add("공백 정리: 연속 공백·줄바꿈을 하나로, 앞뒤 제거", ok, JSON.stringify({ topic: c.topicKo, expr: c.entries[0].expression }));
  }

  // 2. keyExpressions 정리 — 대소문자 무시 일치·표기 맞춤·불일치 버림(거부 아님)
  {
    const r = cleanKeyExpressions(["HAND OUT FLYERS", "hand out flyers", "throw a party"], [{ expression: "hand out flyers" }, { expression: "free of charge" }]);
    add("keyExpressions: 대소문자 무시 일치→항목 표기, 불일치 버림, 중복 1회", r.kept.join("|") === "hand out flyers" && r.dropped === 1, `kept=${JSON.stringify(r.kept)} dropped=${r.dropped}`);
  }

  // 3·4. DAY 묶기 + 번호 병합
  const photos = [
    // 사진 0: DAY 3 앞쪽(2번 항목이 잘림)
    { photoIndex: 0, extraction: extraction({ dayNo: 3, topicKo: "장보기", entries: [e(1, 0), e(2, 1, { partial: true, confidence: "low", example: "A waiter is wiping down", exampleKo: null })], quiz: [] }) },
    // 사진 1: DAY 3 뒤쪽(2번 완전본·3·5번 + QUIZ — QUIZ가 1번 항목(사진 0에만 있음)을 가리킨다)
    { photoIndex: 1, extraction: extraction({ dayNo: 3, topicKo: "장보기", entries: [e(2, 1, { confidence: "medium" }), e(3, 2, { partial: true }), e(5, 4)], quiz: [{ ...FIXTURE_QUIZ[0], keyExpressions: ["Hand Out Flyers", "not in this set"] }] }) },
    // 사진 2: DAY 없음
    { photoIndex: 2, extraction: extraction({ dayNo: null, topicKo: null, entries: [e(null, 3)], quiz: [] }) },
    // 사진 3: DAY 1
    { photoIndex: 3, extraction: extraction({ dayNo: 1, topicKo: "여행", entries: [e(1, 5)], quiz: [] }) },
    // 사진 4: 표현 페이지 아님
    { photoIndex: 4, extraction: extraction({ isExpressionPage: false, dayNo: null, topicKo: null, entries: [], quiz: [] }) },
  ];
  const m = mergeToeicExtractions(photos);
  const day3 = m.drafts.find((d) => d.dayNo === 3);
  add(
    "DAY별 묶기: DAY1·DAY3(2장 병합)·DAY 없음(각자) 순, 비표현 사진 보고",
    m.drafts.map((d) => String(d.dayNo)).join(",") === "1,3,null" && JSON.stringify(m.notExpressionPhotoIndexes) === "[4]" && JSON.stringify(day3?.photoIndexes) === "[0,1]",
    `drafts=${m.drafts.map((d) => `${d.dayNo}:[${d.photoIndexes}]`).join(" ")} not=${JSON.stringify(m.notExpressionPhotoIndexes)}`,
  );
  {
    const two = day3?.entries.find((x) => x.no === 2);
    const three = day3?.entries.find((x) => x.no === 3);
    const ok =
      day3 !== undefined &&
      day3.entries.map((x) => x.no).join(",") === "1,2,3,5" &&
      two?.partial === false && two?.example === ROWS[1].example && two?.confidence === "medium" &&
      three?.partial === true &&
      day3.mergedCount === 1 &&
      JSON.stringify(day3.missingNos) === "[4]" &&
      day3.entries.every((x) => x.points === null);
    add("번호 병합: 완전본 대표·confidence 최고값·전부 partial일 때만 partial·no 정렬·빠진 번호", ok, `nos=${day3?.entries.map((x) => x.no)} missing=${JSON.stringify(day3?.missingNos)} merged=${day3?.mergedCount}`);
  }
  {
    const q = day3?.quiz[0];
    const ok = q !== undefined && JSON.stringify(q.keyExpressions) === JSON.stringify(["hand out flyers"]) && day3!.droppedKeyExpressions === 1;
    add("keyExpressions: 묶음 전체 항목과 대조(다른 사진의 항목도 인정)·표기 맞춤·불일치 버림", ok, `keys=${JSON.stringify(q?.keyExpressions)} dropped=${day3?.droppedKeyExpressions}`);
  }
  add("기본 제목: DAY 3 장보기 / DAY 없음·주제 없음 → 표현 모음", day3?.titleKo === "DAY 3 장보기" && m.drafts[2].titleKo === "표현 모음", `${day3?.titleKo} / ${m.drafts[2].titleKo}`);
  {
    // QUIZ 병합 — 같은 no가 두 사진에 → 하나(내용 긴 쪽)
    const qm = mergeToeicExtractions([
      { photoIndex: 0, extraction: extraction({ dayNo: 7, quiz: [{ ...FIXTURE_QUIZ[0], hint: null }] }) },
      { photoIndex: 1, extraction: extraction({ dayNo: 7, quiz: [{ ...FIXTURE_QUIZ[0] }, { ...FIXTURE_QUIZ[1], keyExpressions: [] }] }) },
    ]).drafts[0];
    add("QUIZ 병합: 같은 no는 하나(내용 긴 쪽)·no 정렬", qm.quiz.length === 2 && qm.quiz[0].hint === FIXTURE_QUIZ[0].hint && qm.quiz[1].no === 2, `quiz=${qm.quiz.map((q) => q.no)} hint0=${qm.quiz[0].hint !== null}`);
  }
  return results;
}

// ---------------------------------------------------------------------------
// 7. 발화 포인트 병합 (§3-4)
// ---------------------------------------------------------------------------

function runPointsMergeChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "포인트 병합(§3-4)");
  const many: ToeicExprEntry[] = Array.from({ length: 15 }, (_, i) => fixtureEntry(ROWS[i % ROWS.length], i, false));

  {
    const chunks = planPointsChunks(many, { force: false });
    add("묶음: 15개 → 7·7·1, index는 세트 전체 위치", chunks.map((c) => c.length).join(",") === "7,7,1" && chunks[1][0].index === 7 && chunks[2][0].index === 14, `sizes=${chunks.map((c) => c.length)} first=${chunks.map((c) => c[0].index)}`);
    const msg = buildPointsUserMessage("장보기", chunks[1]);
    add("사용자 메시지: index가 묶음 안 위치가 아니라 세트 위치(7부터)", msg.startsWith("주제: 장보기\n표현 목록(JSON):\n[{\"index\":7,") && !msg.includes("{topicKo"), JSON.stringify(msg.slice(0, 60)));
    add("사용자 메시지: 주제 없으면 \"없음\"", buildPointsUserMessage(null, chunks[2]).startsWith("주제: 없음\n"), "");
  }
  {
    const withSome = many.map((e, i) => (i === 0 ? fixtureEntry(ROWS[0], 0, true) : e));
    const chunks = planPointsChunks(withSome, { force: false });
    add("빈 자리만: 이미 포인트 있는 항목은 계획에서 빠짐(14개)", chunks.flat().length === 14 && !chunks.flat().some((c) => c.index === 0), `planned=${chunks.flat().length}`);
    const forced = planPointsChunks(withSome, { force: true });
    add("force: 전부 계획(15개)", forced.flat().length === 15, `planned=${forced.flat().length}`);
  }
  {
    // 빈 자리만 채우기 — 기존 포인트는 덮지 않는다
    const entries = [fixtureEntry(ROWS[0], 0, true), fixtureEntry(ROWS[1], 1, false)];
    const original = entries[0].points!.coreKo;
    const newItems: ToeicPointsItem[] = [
      { index: 0, ...fixturePoints(ROWS[0]), coreKo: "새로 만든 포인트 문장이다" },
      { index: 1, ...fixturePoints(ROWS[1]) },
    ];
    const r = applyPointsResults(entries, newItems, { force: false });
    add("빈 자리만: 기존 포인트 유지·빈 것만 채움", r.entries[0].points!.coreKo === original && r.entries[1].points !== null && r.filled === 1 && r.remaining === 0 && r.enriched, `filled=${r.filled} remaining=${r.remaining} enriched=${r.enriched}`);
    const f = applyPointsResults(entries, newItems, { force: true });
    add("force: 기존 포인트도 갈아 끼움", f.entries[0].points!.coreKo === "새로 만든 포인트 문장이다" && f.filled === 2, `filled=${f.filled}`);
    add("저장 모양: index를 떼어 낸다", !("index" in (r.entries[1].points as object)), "");
  }
  {
    // 부분 성공 — 한 묶음 실패
    const chunks = planPointsChunks(many, { force: false });
    const ok = chunks[0].map((c) => ({ index: c.index, ...fixturePoints(ROWS[c.index % ROWS.length]) }));
    const r = applyPointsResults(many, ok, { force: false });
    add("부분 성공: 실패 묶음은 null 유지·remaining 보고·enriched=false", r.filled === 7 && r.remaining === 8 && !r.enriched && r.entries[14].points === null, `filled=${r.filled} remaining=${r.remaining}`);
    add("enriched = 전부 points !== null", isToeicSetEnriched(fixtureSet(true).entries) && !isToeicSetEnriched(many), "");
  }
  return results;
}

// ---------------------------------------------------------------------------
// 8. 호출 C·D 전후 (§4-9·§5-2·§5-3)
// ---------------------------------------------------------------------------

function mockParts(): ToeicMockParts {
  const exprs = ["be lined up along", "in the long run"];
  return {
    read: readFixture(),
    picture: toMockRecordPart("picture", pictureFixture(), exprs),
    respond: toMockRecordPart("respond", respondFixture(), exprs),
    info: toMockRecordPart("info", infoFixture(), exprs),
    opinion: toMockRecordPart("opinion", opinionFixture(), exprs),
  };
}

function runMockPostChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "모의고사 후처리");
  const answer = "On the right side, bicycles are   PARKED next to a building.";
  {
    const r = cleanUsedExpressions(
      [
        { expression: "BE LINED UP ALONG", span: "bicycles are parked" },
        { expression: "throw a party", span: "next to a building" },
        { expression: "in the long run", span: "saves a lot of money" },
        { expression: "be lined up along", span: "Bicycles are parked" },
      ],
      ["be lined up along", "in the long run"],
      answer,
    );
    add(
      "usedExpressions: 목록 밖 표현·모범답변 밖 구간 버림, 표기는 목록·답변 쪽으로, 중복 1회",
      r.length === 1 && r[0].expression === "be lined up along" && r[0].span === "bicycles are   PARKED",
      JSON.stringify(r),
    );
  }
  {
    const parts = mockParts();
    const pic = parts.picture!;
    add("C2 레코드: items[i].image = {pending, null}", pic.items.every((it) => it.image.status === "pending" && it.image.imageId === null), JSON.stringify(pic.items.map((i) => i.image)));
    add("C2 레코드: usedExpressions 정리(목록 표기로)", pic.items[0].usedExpressions.length === 1 && pic.items[0].usedExpressions[0].expression === "be lined up along", JSON.stringify(pic.items[0].usedExpressions));
    add("C3 레코드: 모범답변에 없는 구간 버림", parts.respond!.questions[1].usedExpressions.length === 0 && parts.opinion!.usedExpressions.length === 1, `respond=${parts.respond!.questions[1].usedExpressions.length} opinion=${parts.opinion!.usedExpressions.length}`);
  }
  // 피드백 자료 (§5-2)
  {
    const parts = mockParts();
    const m3 = buildFeedbackMaterial(parts, 3) ?? "";
    const m6 = buildFeedbackMaterial(parts, 6) ?? "";
    const m9 = buildFeedbackMaterial(parts, 9) ?? "";
    const m11 = buildFeedbackMaterial(parts, 11) ?? "";
    add("자료 Q3 = sceneKo + keyPointsKo", m3.includes(parts.picture!.items[0].sceneKo) && m3.includes(`- ${parts.picture!.items[0].keyPointsKo[0]}`), m3.slice(0, 40));
    add("자료 Q6 = intro + 둘째 질문", m6.includes(parts.respond!.intro) && m6.includes(parts.respond!.questions[1].question) && !m6.includes(parts.respond!.questions[0].question), "");
    add("자료 Q9 = 표(제목·meta·rows \"left — right\"·notes) + callerIntro + 둘째 질문", m9.includes("Greenfield Business Forum") && m9.includes("Registration fee: $45") && m9.includes("11:30 - 1:00 — Lunch break") && m9.includes("* Lunch is not included.") && m9.includes(parts.info!.callerIntro) && m9.includes(parts.info!.questions[1].question), "");
    add("자료 Q11 = 질문", m11.includes(parts.opinion!.question) && !m11.includes(parts.opinion!.sampleAnswer), "");
    add("자료 Q1–2·빠진 파트 → null", buildFeedbackMaterial(parts, 1) === null && buildFeedbackMaterial({ ...parts, info: null }, 8) === null, "");
    const input = buildFeedbackInput({ parts, expressionsUsed: ["in the long run"] }, 11, TRANSCRIPT_Q11);
    add("buildFeedbackInput: Q11 모범답변·표현·전사문 묶음 / Q2 null", input?.sampleAnswer === OPINION_ANSWER && input.expressions.join() === "in the long run" && buildFeedbackInput({ parts, expressionsUsed: [] }, 2, "x y") === null, "");

    const msg = buildFeedbackUserMessage({ q: 9, material: m9, sampleAnswer: "S {transcript} S", expressions: [], transcript: "T {material} T" });
    add(
      "D 사용자 메시지: Q9 (정보 활용) · 답변 시간 15초 · 만점 3, 표현 없으면 \"없음\", 단일 패스 치환",
      msg.startsWith("문항: Q9 (정보 활용) · 답변 시간 15초 · 만점 3\n수험자가 본 자료:\n") && msg.includes("활용할 표현: 없음\n") && msg.includes("모범답변(참고용):\nS {transcript} S\n") && msg.endsWith("답변 전사문:\nT {material} T"),
      JSON.stringify(msg.split("\n")[0]),
    );
    const msg11 = buildFeedbackUserMessage({ q: 11, material: m11, sampleAnswer: OPINION_ANSWER, expressions: ["in the long run", "free of charge"], transcript: TRANSCRIPT_Q11 });
    add("D 사용자 메시지: Q11 답변 60초·만점 5·표현 \" / \"로", msg11.startsWith("문항: Q11 (의견 말하기) · 답변 시간 60초 · 만점 5") && msg11.includes("활용할 표현: in the long run / free of charge"), JSON.stringify(msg11.split("\n")[0]));
  }
  {
    const fb = postprocessFeedback({ ...feedbackFixture(), tryExpressions: ["IN THE LONG RUN", "made up", "in the long run", "free of charge", "grab a quick bite", "hand out flyers"] }, ["in the long run", "free of charge", "grab a quick bite", "hand out flyers"]);
    add("D 후처리: tryExpressions 목록 안만·표기 맞춤·중복 제거·최대 3", fb.tryExpressions.join("|") === "in the long run|free of charge|grab a quick bite", JSON.stringify(fb.tryExpressions));
  }
  // 사용자 메시지 C (§4-7)
  {
    const msg = buildMockUserMessage({ targetGrade: "IH", topicHints: ["장보기", " 여행 ", "장보기"], expressions: ["free of charge", "in  the long run"] });
    add("C 사용자 메시지: 등급·주제 \", \"·표현 \" / \"", msg === "목표 등급: IH\n주제 힌트: 장보기, 여행\n활용할 표현: free of charge / in the long run", JSON.stringify(msg));
    const none = buildMockUserMessage({ targetGrade: "AL", topicHints: [], expressions: [] });
    add("C 사용자 메시지: 없으면 \"없음\"", none === "목표 등급: AL\n주제 힌트: 없음\n활용할 표현: 없음", JSON.stringify(none));
    const many = Array.from({ length: 30 }, (_, i) => `expression number ${i}`);
    add("normalizeMockExpressions: 상한 24·멱등", normalizeMockExpressions(many).length === 24 && normalizeMockExpressions(normalizeMockExpressions(many)).join() === normalizeMockExpressions(many).join(), "");
  }
  // 활용할 표현 고르기 (§4-0)
  {
    const sets = [fixtureSet(true), { entries: [fixtureEntry({ ...ROWS[0], expression: "HAND OUT FLYERS" }, 0)] }];
    const sessions: ToeicQuizSessionLike[] = [
      // free of charge: 뜻→표현 졸업(2연속), grab a quick bite: 말하기 오답(약함), wipe down a table: 빈칸 2회 오답(더 약함)
      { id: "a", setId: "s", mode: "ko-to-expr", startedAt: "2026-09-20T01:00:00Z", finishedAt: null, items: [{ word: "free of charge", correct: true, answered: true }] },
      { id: "b", setId: "s", mode: "ko-to-expr", startedAt: "2026-09-21T01:00:00Z", finishedAt: null, items: [{ word: "free of charge", correct: true, answered: true }] },
      { id: "c", setId: "s", mode: "speak", startedAt: "2026-09-21T02:00:00Z", finishedAt: null, items: [{ word: "grab a quick bite", correct: false, answered: true }] },
      { id: "d", setId: "s", mode: "cloze", startedAt: "2026-09-22T02:00:00Z", finishedAt: null, items: [{ word: "wipe down a table", correct: false, answered: true }, { word: "wipe down a table", correct: false, answered: true }] },
    ];
    const picked = pickExpressionsForMock(sets, sessions, { rng: makeRng(3) });
    add(
      "고르기: 약함(오답 많은 순) 먼저 → 보통 → 졸업 마지막, 대소문자 중복 접기",
      picked.length === 7 && picked[0] === "wipe down a table" && picked[1] === "grab a quick bite" && picked[picked.length - 1] === "free of charge" && picked.filter((p) => p.toLowerCase() === "hand out flyers").length === 1,
      JSON.stringify(picked),
    );
    const many = [{ entries: Array.from({ length: 30 }, (_, i) => ({ expression: `made up phrase ${i}` })) }];
    const r1 = pickExpressionsForMock(many, [], { rng: makeRng(1) });
    const r2 = pickExpressionsForMock(many, [], { rng: makeRng(2) });
    add("고르기: 통계 없으면 무작위·최대 24·중복 없음", r1.length === 24 && new Set(r1).size === 24 && r1.join() !== r2.join(), `len=${r1.length}`);
    add("고르기: 표현집 비면 []", pickExpressionsForMock([], []).length === 0, "");
  }
  return results;
}

// ---------------------------------------------------------------------------
// 9. 표현 시험 (§6-1) + 모드별 숙련도 분리 (§6-2)
// ---------------------------------------------------------------------------

function runQuizChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "표현 시험(§6-1)");
  const set = fixtureSet(true);
  {
    const { questions, skipped } = buildToeicChoiceQuestions(set, { rng: makeRng(7) });
    const ok = questions.every((q) => q.choices.includes(q.answer) && new Set(q.choices).size === q.choices.length && q.choices.length === 5);
    add("5지선다 세 모드: 정답 포함·보기 5개 전부 상이", ok, `문항=${questions.length} skipped=${skipped}`);
    add("cloze 출제 조건: 예문·exampleSpan 없는 항목(sign up for)은 skip 1", skipped === 1 && !questions.some((q) => q.mode === "cloze" && q.key === "sign up for"), `skipped=${skipped}`);
    add("항목 키 = 표현(세 모드 모두)", questions.every((q) => q.key === set.entries[q.entryIndex].expression), "");
  }
  {
    const { questions } = buildToeicChoiceQuestions(set, { modes: ["cloze"], rng: makeRng(5) });
    const q = questions.find((x) => x.key === "hand out flyers");
    const ok = q?.prompt === `A man is ${TOEIC_CLOZE_BLANK} near the station exit.` && q.answer === "handing out flyers" && q.promptSubKo === ROWS[0].exampleKo && !q.prompt.includes("handing out flyers");
    add("cloze: exampleSpan을 _____로 가림·정답=exampleSpan·예문 해석 함께", ok, `prompt=${q?.prompt}`);
    const pool = new Set(set.entries.map((e) => e.points?.exampleSpan ?? e.expression));
    add("cloze 오답: 같은 세트의 다른 exampleSpan(없으면 표현)", questions.every((x) => x.choices.every((c) => pool.has(c))), "");
    add("maskCloze: span이 예문에 없으면 null", maskCloze("A man is here.", "not here") === null, "");
    // QA P2-1 — 가린 문제에 정답이 남지 않는다(두 번 등장·대소문자 차이), 단어 안의 부분 일치는 가리지 않는다
    const twice = maskCloze("A clerk is stacking boxes, and a guard is stacking boxes too.", "stacking boxes");
    add("maskCloze: 두 번 나오면 둘 다 가림", twice === `A clerk is ${TOEIC_CLOZE_BLANK}, and a guard is ${TOEIC_CLOZE_BLANK} too.`, `${twice}`);
    const cased = maskCloze("Free of charge! Parking is free of charge for guests.", "free of charge");
    add("maskCloze: 문장 첫머리 대문자 형태도 가림", cased === `${TOEIC_CLOZE_BLANK}! Parking is ${TOEIC_CLOZE_BLANK} for guests.`, `${cased}`);
    const inner = maskCloze("Her skirt got wet on the ski slope.", "ski");
    add("maskCloze: 단어 안 부분 일치(skirt)는 건너뛰고 단어 경계 등장만 가림", inner === `Her skirt got wet on the ${TOEIC_CLOZE_BLANK} slope.`, `${inner}`);
    add("maskCloze: 단어 경계 등장이 없으면 null(단어 조각만 가린 문제 금지)", maskCloze("He is skiing downhill today.", "ski") === null, "");
    const poss = maskCloze("The dog's bowl is next to the dog.", "dog");
    add("maskCloze: 아포스트로피는 경계(dog's → _____'s)", poss === `The ${TOEIC_CLOZE_BLANK}'s bowl is next to the ${TOEIC_CLOZE_BLANK}.`, `${poss}`);
    const overlapped = maskCloze("xab ab ab", "ab ab");
    add("maskCloze: 경계 실패 뒤 겹친 올바른 등장을 놓치지 않음", overlapped === `xab ${TOEIC_CLOZE_BLANK}`, `${overlapped}`);
    const allCloze = buildToeicChoiceQuestions(set, { modes: ["cloze"], rng: makeRng(11) }).questions;
    add("cloze 불변: 가린 문제에 정답이 단어로 남지 않음(픽스처 전 문항)", allCloze.length > 0 && allCloze.every((x) => !answerVisibleInPrompt(x.prompt, x.answer)), `문항=${allCloze.length}`);
  }
  {
    const { questions } = buildToeicChoiceQuestions(set, { modes: ["ko-to-expr", "expr-to-ko"], rng: makeRng(9) });
    const k = questions.find((x) => x.mode === "ko-to-expr" && x.key === "free of charge");
    const e = questions.find((x) => x.mode === "expr-to-ko" && x.key === "free of charge");
    add("ko-to-expr: 문제=뜻·정답=표현 / expr-to-ko: 문제=표현·정답=뜻", k?.prompt === "무료로" && k.answer === "free of charge" && e?.prompt === "free of charge" && e.answer === "무료로", "");
    const only = buildToeicChoiceQuestions(set, { modes: ["ko-to-expr"], onlyKeys: new Set(["free of charge"]), rng: makeRng(1) }).questions;
    add("오답 재시험(onlyKeys): 그 키만 출제", only.length === 1 && only[0].key === "free of charge", `n=${only.length}`);
  }
  // QA P2-7 — 맞는 답이 오답 보기로 나와 틀린 것으로 채점되는 경로(뜻이 같은 두 표현·대소문자만 다른 보기)
  {
    const extra = (row: FixtureRow, i: number) => fixtureEntry(row, i);
    // 지어낸 쌍둥이: "at no cost"의 뜻이 "free of charge"(무료로)와 같다(공백만 다름 — 정규화로 같은 뜻)
    const twin: FixtureRow = { expression: "at no cost", meaningKo: " 무료로  ", example: "Members can use the pool at no cost on weekdays.", exampleKo: "회원은 평일에 무료로 수영장을 이용할 수 있다.", span: "at no cost" };
    // 지어낸 대소문자 쌍: 두 항목의 exampleSpan이 대소문자만 다르다
    const sortA: FixtureRow = { expression: "sort the mail", meaningKo: "우편물을 분류하다", example: "A clerk is sorting the mail behind the counter.", exampleKo: "직원이 카운터 뒤에서 우편물을 분류하고 있다.", span: "sorting the mail" };
    const sortB: FixtureRow = { expression: "go through the mail", meaningKo: "우편물 정리하다", example: "Sorting the mail takes an hour.", exampleKo: "우편물 분류는 한 시간이 걸린다.", span: "Sorting the mail" };
    const twinSet = { entries: [...set.entries, extra(twin, 7), extra(sortA, 8), extra(sortB, 9)] };
    const freeIdx = twinSet.entries.findIndex((e) => e.expression === "free of charge");
    const twinIdx = twinSet.entries.findIndex((e) => e.expression === "at no cost");
    let koLeak = 0;
    let clozeLeak = 0;
    let exprLeak = 0;
    let caseDup = 0;
    let n = 0;
    for (let seed = 1; seed <= 200; seed++) {
      for (const q of buildToeicChoiceQuestions(twinSet, { rng: makeRng(seed) }).questions) {
        n += 1;
        const pair = q.entryIndex === freeIdx ? twinIdx : q.entryIndex === twinIdx ? freeIdx : -1;
        if (pair >= 0 && q.mode === "ko-to-expr" && q.choices.includes(twinSet.entries[pair].expression)) koLeak += 1;
        if (pair >= 0 && q.mode === "cloze" && q.choices.includes(twinSet.entries[pair].points!.exampleSpan!)) clozeLeak += 1;
        if (q.mode === "expr-to-ko" && q.choices.filter((c) => matchKey(c) === matchKey(q.answer)).length !== 1) exprLeak += 1;
        if (new Set(q.choices.map(matchKey)).size !== q.choices.length) caseDup += 1;
      }
    }
    add("P2-7 ko-to-expr: 뜻이 같은(공백 무시) 다른 표현은 오답 보기에서 빠짐", n > 0 && koLeak === 0, `문항=${n} 쌍둥이 노출=${koLeak}`);
    add("P2-7 cloze: 뜻이 같은 항목의 구간은 오답 보기에서 빠짐", clozeLeak === 0, `노출=${clozeLeak}`);
    add("P2-7 expr-to-ko: 정답과 같은 뜻(공백 무시)은 보기에 한 번만", exprLeak === 0, `위반=${exprLeak}`);
    add("P2-7 보기 중복 제거: 대소문자·공백만 다른 보기 두 개가 함께 나오지 않음(cloze 구간 포함)", caseDup === 0, `위반=${caseDup}`);
    {
      // 쌍둥이를 뺀 뒤에도 후보가 넉넉하면 보기 5개 그대로
      const q = buildToeicChoiceQuestions(twinSet, { modes: ["ko-to-expr"], onlyKeys: new Set(["free of charge"]), rng: makeRng(3) }).questions[0];
      add("P2-7: 거른 뒤에도 후보가 넉넉하면 보기 5개", q?.choices.length === 5 && q.choices.includes("free of charge"), `보기=${q?.choices.length}`);
    }
    {
      // 같은 표현(대소문자만 다름)이 두 항목이면(옛 데이터) 서로의 보기가 되지 않는다 — 같은 항목이다
      // [0]과 [1]은 같은 표현(대소문자·공백만 다름), [2]만 다른 표현
      const dupSet = { entries: [extra(ROWS[0], 0), extra({ ...ROWS[1], expression: "Hand Out  Flyers", meaningKo: "전단을 돌리다" }, 1), extra(ROWS[4], 2)] };
      const qs = buildToeicChoiceQuestions(dupSet, { modes: ["ko-to-expr", "expr-to-ko"], rng: makeRng(6) }).questions;
      const third = dupSet.entries[2];
      const pairOk = qs
        .filter((q) => q.entryIndex !== 2)
        .every((q) => q.choices.length === 2 && q.choices.includes(q.answer) && q.choices.includes(q.mode === "ko-to-expr" ? third.expression : third.meaningKo));
      const thirdKo = qs.find((q) => q.entryIndex === 2 && q.mode === "ko-to-expr");
      add(
        "P2-7: 같은 표현(대소문자·공백 무시) 항목은 서로의 오답 보기가 아님 + 보기에서도 한 번만",
        qs.length === 6 && pairOk && thirdKo?.choices.length === 2,
        `문항=${qs.length} 쌍 문항 정상=${pairOk} 셋째 ko-to-expr 보기=${thirdKo?.choices.length}`,
      );
    }
    {
      // 보기가 최소 2개가 안 되면 출제하지 않는다 — 보기가 정답 하나뿐인 문항은 무조건 맞아 숙련도를 거짓으로 채운다
      const one = buildToeicChoiceQuestions({ entries: [extra(ROWS[0], 0)] }, { rng: makeRng(1) });
      add(`최소 보기 ${TOEIC_CHOICE_MIN}개: 표현 1개 세트는 세 모드 모두 출제 불가(skipped 3)`, one.questions.length === 0 && one.skipped === 3, `문항=${one.questions.length} skipped=${one.skipped}`);
      const twins = buildToeicChoiceQuestions({ entries: [extra(ROWS[4], 0), extra(twin, 1)] }, { rng: makeRng(1) });
      add("최소 보기: 뜻이 같은 두 표현뿐인 세트는 출제 불가(쌍둥이를 빼면 후보 0)", twins.questions.length === 0 && twins.skipped === 6, `문항=${twins.questions.length} skipped=${twins.skipped}`);
      const two = buildToeicChoiceQuestions({ entries: [extra(ROWS[0], 0), extra(ROWS[4], 1)] }, { rng: makeRng(1) });
      add("최소 보기: 뜻이 다른 두 표현이면 보기 2개로 출제(있는 만큼)", two.questions.length === 6 && two.questions.every((q) => q.choices.length === 2 && q.choices.includes(q.answer)), `문항=${two.questions.length}`);
    }
  }
  // speak
  {
    const speak = buildToeicSpeakSession(set, [], { rng: makeRng(4) });
    const keys = speak.map((q) => q.key);
    add("speak: 교재 QUIZ 먼저(2개)", speak[0].source === "quiz" && speak[1].source === "quiz" && speak.slice(2).every((q) => q.source === "useIn"), keys.join(" | "));
    add("speak 키: QUIZ 첫 keyExpressions / 없으면 quiz:{no}", keys[0] === "hand out flyers" && keys[1] === "quiz:2", `${keys[0]} / ${keys[1]}`);
    add("speak: 같은 키는 한 번(QUIZ가 쓴 표현의 useIn은 건너뜀)·useIn 키=표현", new Set(keys).size === keys.length && keys.filter((k) => k === "hand out flyers").length === 1 && speak.filter((q) => q.source === "useIn").every((q) => q.entryIndex !== null && set.entries[q.entryIndex].expression === q.key), `${speak.length}문항`);
    add("speak: 모범 문장(영어)·문제(한국어)", speak.every((q) => /[A-Za-z]/.test(q.answer) && /[가-힣]/.test(q.promptKo)), "");
    add("speakKeyForBookQuiz: 번호도 없으면 quiz:{promptKo}", speakKeyForBookQuiz({ no: null, promptKo: "주차는 무료예요.", keyExpressions: [] }) === "quiz:주차는 무료예요.", "");
    const big = { entries: Array.from({ length: 14 }, (_, i) => fixtureEntry({ ...ROWS[i % 6], expression: `made up phrase ${i}` }, i)), quiz: set.quiz };
    add(`speak: 한 세션 최대 ${TOEIC_SPEAK_SESSION_MAX}문항`, buildToeicSpeakSession(big, [], { rng: makeRng(2) }).length === TOEIC_SPEAK_SESSION_MAX, "");
    // 숙련도 낮은 것 우선 — speak에서 틀린 grab a quick bite가 QUIZ 다음 첫 useIn, 다른 모드 세션은 무시
    const sessions: ToeicQuizSessionLike[] = [
      { id: "1", setId: "s", mode: "speak", startedAt: "2026-09-20T01:00:00Z", finishedAt: null, items: [{ word: "grab a quick bite", correct: false, answered: true }, { word: "in the long run", correct: true, answered: true }] },
      { id: "2", setId: "s", mode: "speak", startedAt: "2026-09-21T01:00:00Z", finishedAt: null, items: [{ word: "in the long run", correct: true, answered: true }] },
      { id: "3", setId: "s", mode: "ko-to-expr", startedAt: "2026-09-21T02:00:00Z", finishedAt: null, items: [{ word: "wipe down a table", correct: false, answered: true }] },
    ];
    const ranked = buildToeicSpeakSession(set, sessions, { rng: makeRng(8) }).filter((q) => q.source === "useIn").map((q) => q.key);
    add("speak 순서: 말하기 오답 먼저·졸업(2연속)은 맨 뒤·다른 모드 통계 무시", ranked[0] === "grab a quick bite" && ranked[ranked.length - 1] === "in the long run", JSON.stringify(ranked));
  }
  return results;
}

function runModeSeparationChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "모드 분리(§6-2)");
  // free of charge: 뜻→표현 두 번 맞음(졸업), 말하기 한 번 틀림 — 두 통계가 섞이면 "안다"가 거짓이 된다
  const sessions: ToeicQuizSessionLike[] = [
    { id: "1", setId: "s1", mode: "ko-to-expr", startedAt: "2026-09-20T01:00:00Z", finishedAt: "2026-09-20T01:05:00Z", items: [{ word: "free of charge", correct: true, answered: true }] },
    { id: "2", setId: "s1", mode: "ko-to-expr", startedAt: "2026-09-21T01:00:00Z", finishedAt: "2026-09-21T01:05:00Z", items: [{ word: "free of charge", correct: true, answered: true }] },
    { id: "3", setId: "s1", mode: "speak", startedAt: "2026-09-22T01:00:00Z", finishedAt: "2026-09-22T01:05:00Z", items: [{ word: "free of charge", correct: false, answered: true }, { word: "hand out flyers", correct: true, answered: null }] },
  ];
  const by = aggregateToeicStatsByMode(sessions);
  const ko = by["ko-to-expr"]["free of charge"];
  const sp = by["speak"]["free of charge"];
  add("집계: 뜻→표현(2연속 정답)과 말하기(오답)가 안 섞임", ko?.total === 2 && ko.wrong === 0 && ko.streak === 2 && sp?.total === 1 && sp.wrong === 1 && sp.streak === 0, `ko=${JSON.stringify(ko)} speak=${JSON.stringify(sp)}`);
  add("집계: 네 모드 키가 모두 있음·안 푼 모드는 빈 객체", Object.keys(by).join(",") === "ko-to-expr,expr-to-ko,cloze,speak" && Object.keys(by["cloze"]).length === 0, Object.keys(by).join(","));
  add("집계: 그만하기(answered null)는 시도가 아님", by["speak"]["hand out flyers"] === undefined, "");
  add("오답 재시험 키: speak엔 있고 ko-to-expr엔 없음", toeicWrongKeys(sessions, "speak").has("free of charge") && !toeicWrongKeys(sessions, "ko-to-expr").has("free of charge"), "");
  {
    const sp = buildToeicReviewCandidatesByMode(sessions, "speak").find((c) => c.word === "free of charge");
    const k = buildToeicReviewCandidatesByMode(sessions, "ko-to-expr").find((c) => c.word === "free of charge");
    add("오답 후보(buildReviewCandidates 재사용)도 모드별", sp?.wrong === 1 && k?.wrong === 0 && k.mastered === true, `speak=${sp?.wrong} ko=${k?.wrong}/${k?.mastered}`);
  }
  {
    const split = splitToeicItemsByMode([
      { mode: "ko-to-expr", key: "a", correct: true, answered: true },
      { mode: "cloze", key: "b", correct: false, answered: true },
      { mode: "ko-to-expr", key: "c", correct: false, answered: null },
    ]);
    add("혼합 세션 → 모드별 items(POST 1건씩)", split["ko-to-expr"]?.map((i) => i.word).join() === "a,c" && split["cloze"]?.length === 1 && split["expr-to-ko"] === undefined, JSON.stringify(Object.keys(split)));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 10. 형식표·단계 전이 (§6-4)
// ---------------------------------------------------------------------------

function runPhaseChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "형식표·단계(§6-4)");
  const F = TOEIC_MOCK_FORMAT;
  add("형식표 11문항·만점 합 35", F.length === 11 && F.reduce((s, f) => s + f.maxScore, 0) === 35, `n=${F.length}`);
  add(
    "준비·답변 시간(45/45·45/30·3/15,15,30·3/15,15,30·45/60)",
    F.map((f) => `${f.prepSec}/${f.answerSec}`).join(" ") === "45/45 45/45 45/30 45/30 3/15 3/15 3/30 3/15 3/15 3/30 45/60",
    F.map((f) => `${f.prepSec}/${f.answerSec}`).join(" "),
  );
  add("질문 재생: Q1–4 0회, Q10 2회, 나머지 1회", F.map((f) => f.questionPlays).join("") === "00001111121", F.map((f) => f.questionPlays).join(""));
  add("Q8–10은 질문 텍스트 숨김, Q5–7·Q11은 보임", F.filter((f) => f.showQuestionText).map((f) => f.q).join(",") === "5,6,7,11", "");

  // 전체 응시를 끝까지 돌려 단계 순서를 본다
  const qs = toeicQuestionsForParts(TOEIC_MOCK_PARTS);
  let now = 1_000_000;
  let s: ToeicPhaseState = firstPhase(qs, now);
  const trace: string[] = [];
  let guard = 0;
  let q1Prep: number | null = null;
  let q1AnswerBefore: number | null | undefined;
  let q1AnswerAfter: number | null = null;
  let q8Reading: number | null = null;
  while (s.phase !== "done" && guard++ < 200) {
    trace.push(`${s.q}:${s.phase}${s.phase === "question" ? s.play : ""}`);
    if (s.q === 1 && s.phase === "prep") q1Prep = remainingSec(s, now);
    if (s.q === 8 && s.phase === "reading") q8Reading = remainingSec(s, now);
    if (s.q === 1 && s.phase === "answer") {
      q1AnswerBefore = s.endsAt;
      const started = beginAnswer(s, now + 250);
      q1AnswerAfter = remainingSec(started, now + 250);
    }
    now += 1000;
    s = nextPhase(qs, s, now);
  }
  const dirs = trace.filter((t) => t.endsWith(":directions")).map((t) => t.split(":")[0]);
  add("지시문은 파트 첫 문항만(Q1·3·5·8·11)", dirs.join(",") === "1,3,5,8,11", dirs.join(","));
  add("표 읽기 45초는 Q8 앞 1회뿐·질문 전", trace.filter((t) => t.endsWith(":reading")).join() === "8:reading" && trace.indexOf("8:reading") + 1 === trace.indexOf("8:question0") && q8Reading === 45, `reading=${q8Reading}`);
  add("Q10 질문 2회 재생 후 준비", trace.includes("10:question0") && trace.includes("10:question1") && trace.indexOf("10:question1") + 1 === trace.indexOf("10:prep"), "");
  add("Q1–4는 질문 단계 없음(지문·사진은 화면으로)", !trace.some((t) => /^[1-4]:question/.test(t)), "");
  add("문항 단계 순서 prep → beep → answer", trace.indexOf("5:prep") + 1 === trace.indexOf("5:beep") && trace.indexOf("5:beep") + 1 === trace.indexOf("5:answer"), "");
  add("타이머: Q1 준비 45초(종료 시각 기반)", q1Prep === 45, `q1Prep=${q1Prep}`);
  add("타이머: answer 종료 시각은 녹음 시작(beginAnswer)부터 45초", q1AnswerBefore === null && q1AnswerAfter === 45, `before=${q1AnswerBefore} after=${q1AnswerAfter}`);
  add("마지막 answer 다음은 done", s.phase === "done" && trace[trace.length - 1] === "11:answer", trace[trace.length - 1]);
  {
    const part = toeicQuestionsForParts(["info"]);
    const f0 = firstPhase(part, 0);
    add("유형 연습(info): Q8·9·10, 첫 단계는 지시문", part.join(",") === "8,9,10" && f0.q === 8 && f0.phase === "directions", `${part} ${f0.phase}`);
  }
  add("지시문 숫자는 형식표에서(info: 45초·두 번)", TOEIC_PART_DIRECTIONS.info.en.includes("45 seconds") && TOEIC_PART_DIRECTIONS.info.en.includes("twice") && TOEIC_PART_DIRECTIONS.opinion.ko.includes("60초"), "");

  // ── 음성 큐가 끝난 뒤: 다음 단계 vs 일시정지("다시 듣기"/"질문 보기") — QA m2 P2-A ──
  // speakQueue는 무음 연속 3조각부터 "stopped"라, 1~2조각 질문 큐가 전부 무음이면 "done"·sounded 0으로 끝난다.
  {
    const cases: [Parameters<typeof toeicSpeechOutcome>, "advance" | "pause", string][] = [
      [["question", "done", 1, 1], "advance", "질문 1조각 소리 냄"],
      [["question", "done", 0, 1], "pause", "질문 1조각 무음(done·0) — P2-A 재현 조건"],
      [["question", "done", 0, 2], "pause", "도입+질문 둘 다 무음(Q5·Q8)"],
      [["question", "done", 1, 2], "pause", "도입만 들리고 질문 무음(Q5·Q8)"],
      [["question", "done", 2, 2], "advance", "도입+질문 소리 냄"],
      [["question", "stopped", 2, 2], "pause", "외부 pause(stopped)"],
      [["directions", "done", 0, 1], "pause", "지시문 전부 무음"],
      [["directions", "done", 1, 2], "advance", "지시문 일부만 소리(캡션이 있다)"],
      [["directions", "stopped", 0, 3], "pause", "지시문 stopped"],
      [["question", "done", 0, 0], "advance", "빈 큐(화면은 넘기지 않고 바로 다음)"],
    ];
    const bad = cases.filter(([args, want]) => toeicSpeechOutcome(...args) !== want).map(([, , label]) => label);
    add("음성 큐 끝 판정(toeicSpeechOutcome): 짧은 큐 무음(done·sounded 부족) → 일시정지, 소리 냄 → 다음 단계 — 10케이스", bad.length === 0, bad.join(" / ") || "10/10");
  }
  return results;
}

// ---------------------------------------------------------------------------
// 11. Q1–2 대조·추정 총점 (§5-4·§5-5)
// ---------------------------------------------------------------------------

function runScoreChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "대조·총점(§5-4·5)");
  const n1 = normalizeReadWords("Twenty-five percent OFF & free, don't miss it!");
  const n2 = normalizeReadWords("25% off and free dont miss it");
  add("숫자 표기 통일: twenty-five ↔ 25, % ↔ percent, & ↔ and, 문장부호·대소문자", n1.join(" ") === n2.join(" ") && n1.join(" ") === "25 percent off and free dont miss it", n1.join(" "));
  add("숫자 표기 통일: one hundred ↔ 100, seven ↔ 7, 05 ↔ 5", normalizeReadWords("one hundred seven 05").join(" ") === normalizeReadWords("100 7 5").join(" "), normalizeReadWords("one hundred seven 05").join(" "));
  {
    // QA P2-5 — 글자 사이 마침표는 삭제(공백이 아니다): "7 p.m." ↔ "7 PM" ↔ "7pm"이 같은 단어열
    const forms = ["The doors open at 7 p.m. sharp on Friday.", "the doors open at 7 PM sharp on friday", "The doors open at 7pm sharp on Friday"].map((t) => normalizeReadWords(t).join(" "));
    add("약어 마침표: 7 p.m. = 7 PM = 7pm (P2-5)", forms.every((f) => f === "the doors open at 7 pm sharp on friday"), forms.join(" / "));
    const d = alignReadAloud("The doors open at 7 p.m. sharp on Friday.", "the doors open at 7 PM sharp on friday");
    add("대조: p.m. 지문 ↔ PM 전사 → accuracy 1(치환·덧붙임 0)", d.accuracy === 1 && d.substituted.length === 0 && d.extra.length === 0, JSON.stringify(d));
    add("약어 마침표: U.S. → us, a.m. → am", normalizeReadWords("U.S. offices open at 9 a.m.").join(" ") === "us offices open at 9 am", normalizeReadWords("U.S. offices open at 9 a.m.").join(" "));
    add("약어 마침표: 문장 끝 마침표 뒤 띄어 쓴 한 글자는 붙이지 않음(Plan A. B → a b)", normalizeReadWords("Plan A. B is next").join(" ") === "plan a b is next", normalizeReadWords("Plan A. B is next").join(" "));
  }
  {
    const d = alignReadAloud("Tickets cost 15 dollars at the gate.", "tickets cost fifteen dollars at the gate");
    add("대조: 숫자만 다르게 적힌 완벽 낭독 → accuracy 1", d.accuracy === 1 && d.missing.length === 0 && d.substituted.length === 0, JSON.stringify(d));
  }
  {
    const d = alignReadAloud("Visit our new store on Main Street today.", "visit our store on main street today");
    add("대조: 빠짐 1개(new) → accuracy 1−1/8", d.missing.join() === "new" && Math.abs(d.accuracy - 7 / 8) < 1e-9 && d.extra.length === 0, JSON.stringify(d));
  }
  {
    const d = alignReadAloud("Visit our new store on Main Street today.", "visit our new shop on main street today please");
    add("대조: 치환 1개(store→shop)·덧붙인 말(please)은 accuracy를 깎지 않음", d.substituted.length === 1 && d.substituted[0].expected === "store" && d.substituted[0].heard === "shop" && d.extra.join() === "please" && Math.abs(d.accuracy - 7 / 8) < 1e-9, JSON.stringify(d));
  }
  {
    const d = alignReadAloud("One two three.", "apple banana cherry date egg fig grape");
    add("대조: accuracy 0 미만은 0", d.accuracy === 0, `acc=${d.accuracy}`);
  }
  add("참고 점수 경계: 0.95→3·0.9499→2·0.85→2·0.8499→1·0.6→1·0.5999→0", [0.95, 0.9499, 0.85, 0.8499, 0.6, 0.5999].map(readProxyScore).join("") === "322110", [0.95, 0.9499, 0.85, 0.8499, 0.6, 0.5999].map(readProxyScore).join(""));
  add("무응답: 단어 2개 미만(빈 문자열·\"um\"·null) / 2개 이상은 아님", isNoResponseTranscript("") && isNoResponseTranscript("um") && isNoResponseTranscript(null) && !isNoResponseTranscript("I think"), "");

  const all = (q11: number, rest: number) => Array.from({ length: 11 }, (_, i) => ({ q: i + 1, score: i === 10 ? q11 : rest }));
  {
    const e = estimateToeicTotal(all(5, 3));
    add("추정: 만점 35 → 200 · AH", e.complete && e.raw === 35 && e.scaled === 200 && e.band === "AH" && e.labelKo === "추정(참고용)", JSON.stringify(e));
  }
  {
    const e = estimateToeicTotal(all(3, 2));
    add("추정: raw 23 → round10(131.4)=130 · IM", e.complete && e.raw === 23 && e.scaled === 130 && e.band === "IM", JSON.stringify(e));
  }
  {
    const partial = all(3, 2).map((a) => (a.q === 4 ? { ...a, score: null } : a));
    const e = estimateToeicTotal(partial);
    add("추정: 한 문항이라도 없으면 null + \"10문항 채점됨\"", !e.complete && e.scoredCount === 10 && e.messageKo === "10문항 채점됨", JSON.stringify(e));
    const bad = estimateToeicTotal(all(3, 2).map((a) => (a.q === 1 ? { ...a, score: 4 } : a)));
    add("추정: 범위 밖 점수(Q1=4)는 채점 안 된 것으로", !bad.complete && bad.scoredCount === 10, JSON.stringify(bad));
  }
  {
    // QA P2-8 — raw 0..35 전 구간을 **리터럴 표**로 잠근다(round10을 floor·ceil로 바꾸면 raw 24가 IH 140 → IM 130으로 틀어진다).
    // 표는 구현과 독립으로(분수 raw×4/7 반올림) 계산해 적었다: "raw:scaled:band"
    const EXPECTED =
      "0:0:NM/NL 1:10:NM/NL 2:10:NM/NL 3:20:NM/NL 4:20:NM/NL 5:30:NM/NL 6:30:NM/NL 7:40:NM/NL 8:50:NM/NL 9:50:NM/NL " +
      "10:60:NH 11:60:NH 12:70:NH 13:70:NH 14:80:NH 15:90:IL 16:90:IL 17:100:IL 18:100:IL 19:110:IM 20:110:IM 21:120:IM " +
      "22:130:IM 23:130:IM 24:140:IH 25:140:IH 26:150:IH 27:150:IH 28:160:AL 29:170:AL 30:170:AL 31:180:AM 32:180:AM " +
      "33:190:AM 34:190:AM 35:200:AH";
    /** raw를 Q11(최대 5) → Q1..Q10(각 최대 3) 순으로 나눠 채운 11문항 */
    const answersForRaw = (raw: number) => {
      let left = raw;
      const q11 = Math.min(5, left);
      left -= q11;
      return Array.from({ length: 11 }, (_, i) => {
        if (i === 10) return { q: 11, score: q11 };
        const v = Math.min(3, left);
        left -= v;
        return { q: i + 1, score: v };
      });
    };
    const got = Array.from({ length: 36 }, (_, raw) => {
      const e = estimateToeicTotal(answersForRaw(raw));
      return e.complete ? `${e.raw}:${e.scaled}:${e.band}` : `${raw}:incomplete`;
    }).join(" ");
    const diff = got.split(" ").filter((g, i) => g !== EXPECTED.split(" ")[i]);
    add("추정 총점 raw 0..35 전 구간 = 리터럴 표(round10·ACTFL, P2-8)", got === EXPECTED, diff.length === 0 ? "36/36 일치" : `어긋남: ${diff.join(" ")}`);
  }
  {
    // QA P2-9 — 정수가 아닌 q(1.5)·범위 밖 q(0·12)는 던지지 않고 채점 안 된 것으로 센다
    let threw = false;
    let e: ReturnType<typeof estimateToeicTotal> | null = null;
    try {
      e = estimateToeicTotal([{ q: 1.5, score: 2 }, { q: 0, score: 1 }, { q: 12, score: 1 }, ...all(3, 2).filter((a) => a.q !== 5)]);
    } catch {
      threw = true;
    }
    add("추정: q 1.5·0·12는 던지지 않고 무시(10문항 채점됨, P2-9)", !threw && e !== null && !e.complete && e.scoredCount === 10, threw ? "throw" : JSON.stringify(e));
  }
  add(
    "ACTFL 구간 경계: 200 AH·190/180 AM·170/160 AL·150/140 IH·130/110 IM·100/90 IL·80/60 NH·50/0 NM/NL",
    [200, 190, 180, 170, 160, 150, 140, 130, 110, 100, 90, 80, 60, 50, 0].map(toeicBandForScaled).join(" ") === "AH AM AM AL AL IH IH IM IM IL IL NH NH NM/NL NM/NL",
    [200, 190, 180, 170, 160, 150, 140, 130, 110, 100, 90, 80, 60, 50, 0].map(toeicBandForScaled).join(" "),
  );
  return results;
}

// ---------------------------------------------------------------------------
// 12. 전체 듣기 대본 (§6-3) + splitForTts 공용화
// ---------------------------------------------------------------------------

function runListenChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "전체 듣기(§6-3)");
  const set = fixtureSet(true);
  const basic = buildToeicListenScript(set, "basic");
  const first = basic.filter((p) => p.entryIndex === 0);
  add("① 표현(en) → 뜻(ko) → 예문(en)", first.map((p) => p.lang).join(",") === "en-US,ko-KR,en-US" && first[0].text === "hand out flyers" && first[2].text === ROWS[0].example, first.map((p) => p.lang).join(","));
  add("① 예문 없는 항목은 표현·뜻만", basic.filter((p) => p.entryIndex === 6).length === 2, "");
  add("한국어 뜻의 물결표 제거(~을 따라 → 을 따라)", basic.find((p) => p.entryIndex === 2 && p.lang === "ko-KR")?.text === "을 따라 줄지어 있다", basic.find((p) => p.entryIndex === 2 && p.lang === "ko-KR")?.text ?? "");
  const withUse = buildToeicListenScript(set, "with-use").filter((p) => p.entryIndex === 0);
  add("② ①에 useIn 문장(en) 추가", withUse.length === 5 && withUse.slice(3).every((p) => p.lang === "en-US" && set.entries[0].points!.useIn.some((u) => u.sentence === p.text)), `${withUse.length}조각`);
  const en = buildToeicListenScript(set, "english-only");
  add("③ 영어만: 한국어 없음·followUp 포함", en.every((p) => p.lang === "en-US") && en.some((p) => p.text === set.entries[0].points!.followUp.en), `${en.length}조각`);
  {
    const long = "This is a sentence that keeps going for quite a while. ".repeat(8).trim();
    const s = { entries: [{ ...set.entries[0], example: long }] };
    const pieces = buildToeicListenScript(s, "basic").filter((p) => p.lang === "en-US" && p.text !== "hand out flyers");
    add(`300자 넘는 조각은 문장 단위로 쪼갬(원문 ${long.length}자)`, pieces.length >= 2 && pieces.every((p) => p.text.length <= TTS_TEXT_MAX_CHARS && p.entryIndex === 0), `${pieces.length}조각`);
  }
  add("splitForTts 공용화: ja-coaching-script 재수출 = lib/tts-split 같은 함수", splitFromShared === splitFromJa, "");
  return results;
}

// ---------------------------------------------------------------------------
// 13. 가져오기 파일 (§7-6)
// ---------------------------------------------------------------------------

const PRESET_PATH = new URL("../data/private/toeic-preset-hackers-core.json", import.meta.url);

function runImportChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "가져오기(§7-6)");
  const good = () => ({
    format: "toeic-sets/v1",
    source: "지어낸 픽스처",
    sets: [{ presetKey: "made-up-day01", titleKo: "DAY 1 장보기", dayNo: 1, topicKo: "장보기", ...fixtureSet(true) }],
  });
  {
    const r = toeicImportFileSchema.safeParse(good());
    add("지어낸 파일 통과(모르는 최상위 키는 버림)", r.success && !("source" in (r.data as object)), issuesOf(r));
    const noPts = good();
    noPts.sets[0].entries[1].points = null;
    add("통과: points null 허용(best-effort)", toeicImportFileSchema.safeParse(noPts).success, "");
  }
  const mut = (name: string, f: (x: ReturnType<typeof good>) => void) => {
    const x = good();
    f(x);
    add(`거부: ${name}`, !toeicImportFileSchema.safeParse(x).success, "거부되어야 함");
  };
  mut("format 다름", (x) => { x.format = "toeic-sets/v2"; });
  mut("presetKey 대문자", (x) => { x.sets[0].presetKey = "Made-Up-Day01"; });
  mut("presetKey 중복", (x) => { x.sets.push({ ...x.sets[0] }); });
  mut("keyExpressions가 entries 표현과 다름", (x) => { x.sets[0].quiz[0].keyExpressions = ["Hand Out Flyers"]; });
  mut("points.exampleSpan이 예문 밖(호출 B 규칙)", (x) => { x.sets[0].entries[0].points!.exampleSpan = "passing out flyers"; });
  mut("points.frames에 ___ 없음(호출 B 규칙)", (x) => { x.sets[0].entries[0].points!.frames = ["No slot here at all."]; });
  mut("expression에 한글(호출 A 규칙)", (x) => { x.sets[0].entries[0].expression = "전단 hand out"; });
  mut("entries 0개", (x) => { x.sets[0].entries = []; });
  mut("titleKo 빈 문자열", (x) => { x.sets[0].titleKo = " "; });
  mut("partial=true여도 meaningKo 빈 문자열(P2-2 — 빈 뜻은 판독 초안에만)", (x) => { x.sets[0].entries[1].partial = true; x.sets[0].entries[1].meaningKo = ""; });
  // QA m1 P2-3 — 세트 안 표현 중복(대소문자·연속 공백 무시). 거부 이유가 **중복**인지까지 본다(다른 규칙에 걸려 거부된 게 아님)
  const dupRejected = (name: string, f: (x: ReturnType<typeof good>) => void) => {
    const x = good();
    f(x);
    const r = toeicImportFileSchema.safeParse(x);
    const hit = !r.success && r.error.issues.some((i) => i.message === TOEIC_DUPLICATE_EXPRESSION_MESSAGE_KO && i.path.join(".") === "sets.0.entries.1.expression");
    const others = r.success ? 0 : r.error.issues.filter((i) => i.message !== TOEIC_DUPLICATE_EXPRESSION_MESSAGE_KO).length;
    add(`거부: ${name}(P2-3 — 두 번째 항목 expression 경로·중복 문구)`, hit && others === 0, r.success ? "통과해 버림" : issuesOf(r));
  };
  dupRejected("같은 세트 안 표현 중복(글자 그대로)", (x) => { x.sets[0].entries[1].expression = x.sets[0].entries[0].expression; });
  dupRejected("대소문자·공백만 다른 표현 중복", (x) => { x.sets[0].entries[1].expression = "  Hand OUT   flyers "; });
  add(
    "findDuplicateExpressionIndexes: 첫 등장은 빼고 두 번째부터·빈 표현은 세지 않음",
    findDuplicateExpressionIndexes([{ expression: "Sort the mail" }, { expression: "sort  THE mail " }, { expression: "at no cost" }, { expression: "" }, { expression: " " }, { expression: "SORT the mail" }]).join(",") === "1,5",
    findDuplicateExpressionIndexes([{ expression: "Sort the mail" }, { expression: "sort  THE mail " }, { expression: "at no cost" }, { expression: "" }, { expression: " " }, { expression: "SORT the mail" }]).join(","),
  );

  // 실제 교재 가져오기 파일 — git 밖(data/private). 내용은 찍지 않는다(개수·경로만)
  if (!existsSync(PRESET_PATH)) {
    results.push({ book: "가져오기(§7-6)", check: "교재 가져오기 파일 검증", pass: true, skip: true, detail: "data/private/toeic-preset-hackers-core.json 없음 — 공개 저장소 기준 SKIP" });
    return results;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(PRESET_PATH, "utf-8"));
  } catch (e) {
    add("교재 가져오기 파일: JSON 파싱", false, e instanceof Error ? e.name : "parse error");
    return results;
  }
  const r = toeicImportFileSchema.safeParse(parsed);
  add("교재 가져오기 파일: zod 통과(호출 A·B 규칙)", r.success, r.success ? "통과" : issuesOf(r));
  if (r.success) {
    const sets = r.data.sets;
    const entries = sets.reduce((n, s) => n + s.entries.length, 0);
    const quiz = sets.reduce((n, s) => n + s.quiz.length, 0);
    add("교재 가져오기 파일: 10세트·140표현·20 QUIZ", sets.length === 10 && entries === 140 && quiz === 20, `sets=${sets.length} entries=${entries} quiz=${quiz}`);
    // cloze 불변을 실제 교재 데이터로 — 내용은 찍지 않는다(개수만)
    let clozeCount = 0;
    let leaks = 0;
    let clozeSkipped = 0;
    sets.forEach((s, si) => {
      const { questions } = buildToeicChoiceQuestions({ entries: s.entries }, { modes: ["cloze"], rng: makeRng(100 + si) });
      clozeCount += questions.length;
      leaks += questions.filter((x) => answerVisibleInPrompt(x.prompt, x.answer)).length;
      clozeSkipped += s.entries.length - questions.length;
    });
    add("교재 가져오기 파일: cloze 가린 문제에 정답이 남지 않음", clozeCount > 0 && leaks === 0, `cloze=${clozeCount} 정답잔존=${leaks} 출제불가=${clozeSkipped}`);
  }
  return results;
}

// ---------------------------------------------------------------------------
// 14. 스트릭 트랙 분리 (§9) — 영어 트랙(app-builder T0, lib/toeic-streak.ts)이 생겨 자리를 채웠다.
// 세는 규칙·라우트 배선의 반례 묶음은 공통 기능 eval(eval:streak "영어 트랙")이 주 잠금이고, 여기서는 과목 eval이 같은 불변을
// 한 번 더 본다 — 토익 기록만으로 계산하고, 다른 트랙 날짜를 섞으면 값이 달라진다.
// ---------------------------------------------------------------------------

function runStreakTrackChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "스트릭 트랙");
  const today = "2026-09-21";
  const q = (d: string, answered: boolean | null) => ({ startedAt: `${d}T03:00:00.000Z`, items: [{ answered }] });
  const a = (d: string, recorded: boolean[]) => ({ startedAt: `${d}T03:00:00.000Z`, answers: recorded.map((r) => ({ recorded: r })) });
  // 영어: 그제 표현 시험(답함)만 → 끊김(0). 은우(오늘)·일본어(어제) 날짜를 섞으면 3연속으로 이어져 보인다.
  const en = computeStreak(toeicStreakSessions([q("2026-09-19", true)], [a("2026-09-21", [false])]), today);
  const mixed = computeStreak(
    [...toeicStreakSessions([q("2026-09-19", true)], []), { startedAt: "2026-09-21T03:00:00.000Z", items: [{ answered: true }] }, { startedAt: "2026-09-20T03:00:00.000Z", items: [{ answered: true }] }],
    today,
  );
  add(
    "영어 트랙 분리(은우·일본어·운동·영어) — 녹음 0 응시는 세지 않고, 다른 트랙 날짜를 섞으면 값이 달라진다",
    en.current === 0 && !en.doneToday && mixed.current === 3 && mixed.doneToday,
    `영어=${JSON.stringify(en)} 섞음=${JSON.stringify(mixed)}`,
  );
  return results;
}

// ---------------------------------------------------------------------------
// 14-2. 모의고사 저장 판정·관문 P 설정·화면 도우미 (app-builder T3 — docs/harness/toeic.md §4-0·§4-10·§7-2)
//   두 백엔드가 같은 판정 함수(lib/toeic-mock-apply.ts)를 부른다 — 여기서 반례로 잠근다:
//   빈 파트만 채우기, 먼저 준비된 사진이 이긴다(ready는 ready·failed로 안 바뀐다), 장면이 바뀌면 쓰지 않는다.
// ---------------------------------------------------------------------------

function mockRecordFixture(): ToeicMockRecord {
  return normalizeToeicMockRecord({
    id: "mock-1",
    titleKo: "모의고사 1",
    targetGrade: "IH",
    expressionsUsed: ["be lined up along", "in the long run"],
    topicHints: ["운동"],
    parts: { ...mockParts(), info: null },
    model: "stub",
    createdAt: "2026-09-26T00:00:00.000Z",
    sortIndex: null,
  });
}

async function runMockStoreRuleChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "모의고사 저장·화면");
  const m = mockRecordFixture();
  const prompt0 = m.parts.picture!.items[0].imagePrompt;
  const prompt1 = m.parts.picture!.items[1].imagePrompt;

  // 빈 파트만 채우기
  add(
    "decideFillPart: null 파트 = fill, 있는 파트 = exists(덮지 않는다)",
    decideFillPart(m, "info") === "fill" && decideFillPart(m, "read") === "exists" && decideFillPart(m, "opinion") === "exists",
    "",
  );
  const filled = applyFillPart(m, "info", infoFixture());
  add("applyFillPart: 그 파트만 바뀐다(다른 파트 참조 그대로)", filled.parts.info !== null && filled.parts.read === m.parts.read && filled.parts.picture === m.parts.picture, "");

  // 사진 판정 — 상태별
  add("decidePictureImage: pending = apply", decidePictureImage(m, 0, prompt0) === "apply", "");
  const ready0 = applyPictureImage(m, 0, { status: "ready", imageId: "img-a" });
  add(
    "applyPictureImage: 그 칸만 바뀐다(다른 칸·imagePrompt 그대로)",
    ready0.parts.picture!.items[0].image.imageId === "img-a" &&
      ready0.parts.picture!.items[1].image.status === "pending" &&
      ready0.parts.picture!.items[0].imagePrompt === prompt0,
    "",
  );
  add("먼저 준비된 사진이 이긴다: ready 칸에 새 ready = kept", decidePictureImage(ready0, 0, prompt0) === "kept", "");
  add("늦은 실패가 준비된 사진을 내리지 않는다: ready 칸에 failed 판정 = kept", decidePictureImage(ready0, 0, prompt0) === "kept", "");
  const failed1 = applyPictureImage(ready0, 1, { status: "failed", imageId: null });
  add("failed 칸은 다시 만들 수 있다(= apply)", decidePictureImage(failed1, 1, prompt1) === "apply", "");
  add("ready인데 imageId가 없으면(깨진 문서) 다시 만들 수 있다", decidePictureImage(applyPictureImage(m, 0, { status: "ready", imageId: null }), 0, prompt0) === "apply", "");
  add("장면이 바뀌었으면 stale(다른 장면 사진을 붙이지 않는다)", decidePictureImage(m, 0, `${prompt0} changed`) === "stale" && decidePictureImage(m, 1, prompt0) === "stale", "");
  const noPic = { ...m, parts: { ...m.parts, picture: null } };
  const onePic = { ...m, parts: { ...m.parts, picture: { items: [m.parts.picture!.items[0]] } } };
  add("picture 없음·칸 없음 = missing", decidePictureImage(noPic, 0, prompt0) === "missing" && decidePictureImage(onePic, 1, prompt1) === "missing", "");

  // 두 요청이 같은 칸을 동시에 — 순서대로 판정을 흉내 낸다(원자 단위 = 판정 + 적용이 한 번에)
  let rec = m;
  const log: string[] = [];
  for (const [who, img] of [
    ["A", { status: "ready" as const, imageId: "img-A" }],
    ["B", { status: "ready" as const, imageId: "img-B" }],
    ["C", { status: "failed" as const, imageId: null }],
  ] as const) {
    const d = decidePictureImage(rec, 0, prompt0);
    log.push(`${who}:${d}`);
    if (d === "apply") rec = applyPictureImage(rec, 0, img);
  }
  add("동시 3요청(성공 A·성공 B·늦은 실패 C) → A만 남는다", rec.parts.picture!.items[0].image.imageId === "img-A" && log.join(",") === "A:apply,B:kept,C:kept", log.join(","));

  // 하위 호환·렌더 판정
  const old = normalizeToeicMockRecord({ ...m, topicHints: undefined });
  add("topicHints 없는 이전 문서 → 빈 배열(렌더 가능)", Array.isArray(old.topicHints) && old.topicHints.length === 0 && isRenderableToeicMock(old), "");
  add("isRenderableToeicMock: 픽스처 통과, 파트 null은 정상", isRenderableToeicMock(m) && isRenderableToeicMock({ ...m, parts: { read: null, picture: null, respond: null, info: null, opinion: null } }), "");
  const brokenRead = { ...m, parts: { ...m.parts, read: { items: [{ kind: "news", text: "x" }] } } } as unknown as ToeicMockRecord;
  const brokenInfo = { ...m, parts: { ...m.parts, info: { table: { title: "t" }, callerIntro: "c", questions: [] } } } as unknown as ToeicMockRecord;
  add("isRenderableToeicMock: 화면이 순회하는 배열이 없는 파트는 거부", !isRenderableToeicMock(brokenRead) && !isRenderableToeicMock(brokenInfo), "");

  // 화면 도우미
  add("missingToeicMockParts: 형식표 순서의 빈 파트", missingToeicMockParts(m.parts).join() === "info", "");
  add(
    "toeicMockPartLabelKo: 형식표에서 문항 범위 계산",
    toeicMockPartLabelKo("read") === "Q1–2 지문 읽기" && toeicMockPartLabelKo("info") === "Q8–10 정보 활용" && toeicMockPartLabelKo("opinion") === "Q11 의견 말하기",
    "",
  );
  add(
    "nextToeicMockTitle: 개수와 기존 번호 중 큰 값 + 1(지운 뒤에도 안 겹침)",
    nextToeicMockTitle([]) === "모의고사 1" && nextToeicMockTitle(["모의고사 3", "내 연습"]) === "모의고사 4" && nextToeicMockTitle(["a", "b"]) === "모의고사 3",
    "",
  );
  const url = toeicImageUrl("a/b c");
  add("toeicImageUrl: 확장자 없음(proxy 정적 예외 우회 금지)·id 인코딩", url === "/api/toeic/images/a%2Fb%20c" && !/\.(jpe?g|png|webp)$/i.test(url), url);
  add(
    "toeicTakeHref: 실전 scope=full · 유형 연습 scope=part&part=",
    toeicTakeHref("m1", "full") === "/toeic/mocks/m1/take?scope=full" && toeicTakeHref("m1", "part", "info") === "/toeic/mocks/m1/take?scope=part&part=info",
    "",
  );

  const answer = "In the long run, I think the bikes are parked in a row.";
  const segs = segmentUsedExpressions(answer, [
    { expression: "in the long run", span: "in the  LONG run" },
    { expression: "x", span: "not in the answer" },
    { expression: "be parked", span: "are parked" },
    { expression: "overlap", span: "long run, I" },
  ]);
  const marked = segs.filter((g) => g.mark).map((g) => g.text);
  add(
    "segmentUsedExpressions: 대소문자·공백 무시로 찾고, 없는 span은 건너뛰고, 겹치면 먼저 시작한 것만, 조각을 이으면 원문",
    segs.map((g) => g.text).join("") === answer && marked.join("|") === "In the long run|are parked" && segs.find((g) => g.mark)?.expression === "in the long run",
    marked.join("|"),
  );
  const chunk = "Riverside Station trains to Riverside depart at side gate; SIDE entrance.";
  const st = segmentStressWords(chunk, ["side", "riverside"]);
  const stressed = st.filter((g) => g.mark).map((g) => g.text);
  add(
    "segmentStressWords: 단어 경계·대소문자 무시·여러 번 모두, 원문 보존",
    st.map((g) => g.text).join("") === chunk && stressed.join("|") === "Riverside|Riverside|side|SIDE",
    stressed.join("|"),
  );

  // 관문 P 설정 — 빈 값 폴백·키 없으면 네트워크 없이 no_api_key
  const saved = { m: process.env.OPENAI_IMAGE_MODEL, q: process.env.OPENAI_IMAGE_QUALITY, k: process.env.OPENAI_API_KEY };
  try {
    process.env.OPENAI_IMAGE_MODEL = "   ";
    process.env.OPENAI_IMAGE_QUALITY = "";
    const m1 = resolveToeicImageModel();
    const q1 = resolveToeicImageQuality();
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-1.5";
    process.env.OPENAI_IMAGE_QUALITY = "HIGH";
    const m2 = resolveToeicImageModel();
    const q2 = resolveToeicImageQuality();
    process.env.OPENAI_IMAGE_QUALITY = "ultra";
    const q3 = resolveToeicImageQuality();
    add(
      "관문 P 설정: 빈 값 → gpt-image-2·medium, 지정값 사용, 모르는 품질 → medium",
      m1 === DEFAULT_TOEIC_IMAGE_MODEL && m1 === "gpt-image-2" && q1 === DEFAULT_TOEIC_IMAGE_QUALITY && q1 === "medium" && m2 === "gpt-image-1.5" && q2 === "high" && q3 === "medium",
      `${m1}/${q1} ${m2}/${q2} ${q3}`,
    );
    delete process.env.OPENAI_API_KEY;
    const r = await generateSceneImage("A quiet park.");
    add("관문 P: 키가 없으면 호출 없이 no_api_key", !r.ok && r.error === "no_api_key", r.ok ? "ok?" : r.error);
  } finally {
    for (const [k, v] of [["OPENAI_IMAGE_MODEL", saved.m], ["OPENAI_IMAGE_QUALITY", saved.q], ["OPENAI_API_KEY", saved.k]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // 번들 경계 — 화면이 import하는 계약·판정 모듈
  for (const f of ["toeic-mock-contract.ts", "toeic-mock-apply.ts"]) {
    const src = readFileSync(new URL(`../lib/${f}`, import.meta.url), "utf-8");
    const bad = src.split("\n").filter((l) => /^\s*import\s+(?!type\b)[^;]*from\s+["'][^"']*(\/ai\/|\/store|openai|zod)["']/.test(l));
    const lookbehind = /\(\?<[=!]/.test(src);
    add(`lib/${f}: lib/ai·store·openai·zod 값 import 없음 + lookbehind 없음`, bad.length === 0 && !lookbehind, bad.join(" / "));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 14-3. 모의고사 응시·채점 (app-builder T4·T5 — docs/harness/toeic.md §5-0·§5-4·§6-4·§7-5)
//   응시 기록 판정(범위·닫힘·끝은 한 번만·빠진 문항 채우기), 녹음 정규화 순수 함수(mono·선형 보간·16-bit WAV 헤더),
//   기기 보관 정리(최근 5회분), 녹음 형식 고르기, Q1–2 지문 표시(개수가 alignReadAloud와 같다), 업로드 형식 계약,
//   관문 T 설정(빈 값 폴백·키 없으면 호출 없음·기대 문장 prompt 없음), 문항 화면 자료, 개발용 시간 배율 가드.
// ---------------------------------------------------------------------------

async function runAttemptChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "응시·채점");

  // ── 응시 범위 ──
  const full = mockParts();
  const noInfo = { ...full, info: null };
  const allParts = ["read", "picture", "respond", "info", "opinion"] as const;
  const r1 = decideAttemptScope("full", [...allParts].reverse(), full);
  const r2 = decideAttemptScope("full", [...allParts], noInfo);
  const r3 = decideAttemptScope("full", ["read", "picture"], full);
  const r4 = decideAttemptScope("part", ["info"], noInfo);
  const r5 = decideAttemptScope("part", ["respond"], noInfo);
  const r6 = decideAttemptScope("part", ["respond", "opinion"], full);
  const r7 = decideAttemptScope("full", ["read", "read", "picture", "respond", "info"], full);
  add(
    "decideAttemptScope: full=다섯 파트(형식표 순서로)·완전해야 · part=한 파트·있어야 · 중복 거부",
    r1.ok && r1.parts.join(",") === allParts.join(",") && !r2.ok && r2.reason === "incomplete_mock" && !r3.ok && r3.reason === "scope_parts_mismatch" &&
      !r4.ok && r4.reason === "part_missing" && r5.ok && r5.parts.join(",") === "respond" && !r6.ok && r6.reason === "scope_parts_mismatch" &&
      !r7.ok && r7.reason === "scope_parts_mismatch",
    "",
  );
  add(
    "toeicAttemptQuestions: 실전 11문항·유형 연습은 그 파트 문항만(형식표 순서)",
    toeicAttemptQuestions([...allParts]).join(",") === "1,2,3,4,5,6,7,8,9,10,11" && toeicAttemptQuestions(["info"]).join(",") === "8,9,10" &&
      toeicAttemptQuestions(["opinion", "read"]).join(",") === "1,2,11",
    "",
  );

  // ── 닫힘·끝은 한 번만 ──
  const open = { finishedAt: null, answers: [] as { q: number; recorded: boolean; score: number | null }[] };
  add("시작 직후(answers 빈 배열·finishedAt null)는 열린 응시", !isToeicAttemptClosed(open) && decideAttemptFinish(open) === "finish", "");
  const filled = completeFinishAnswers([5, 6, 7], [{ q: 6, recorded: true, durationMs: 14_000 }]);
  add(
    "completeFinishAnswers: 범위의 모든 문항을 채운다(안 보낸 문항 = recorded:false·null), q 오름차순",
    filled.map((a) => `${a.q}:${a.recorded}:${a.durationMs}`).join(",") === "5:false:null,6:true:14000,7:false:null",
    JSON.stringify(filled),
  );
  const attemptBase = {
    id: "att-1",
    mockId: "mock-1",
    scope: "part" as const,
    parts: ["respond" as const],
    startedAt: "2026-09-26T00:00:00.000Z",
    finishedAt: null,
    answers: [],
  };
  const quit = applyAttemptFinish(attemptBase, { finishedAt: null, answers: filled });
  add(
    "그만둠(finishedAt null)도 닫힌 응시 — 두 번째 끝/그만두기는 already_closed(재시도·다른 탭이 결과를 뒤집지 못한다)",
    isToeicAttemptClosed(quit) && decideAttemptFinish(quit) === "already_closed" && quit.answers.length === 3,
    "",
  );
  const scored = applyAttemptAnswer(quit, 6, { transcript: "I usually go jogging.", readDiff: null, feedback: null, score: 2, scoredAt: "2026-09-26T00:10:00.000Z" });
  add(
    "채점은 그 문항만 바꾸고 recorded·durationMs를 보존한다",
    scored.answers.find((a) => a.q === 6)?.recorded === true && scored.answers.find((a) => a.q === 6)?.durationMs === 14000 && scored.answers.find((a) => a.q === 5)?.score === null,
    "",
  );
  add(
    "isScorableToeicAnswer: 녹음됐고 점수 없음만(점수 있음·녹음 없음은 제외)",
    isScorableToeicAnswer({ recorded: true, score: null }) && !isScorableToeicAnswer({ recorded: true, score: 0 }) && !isScorableToeicAnswer({ recorded: false, score: null }),
    "",
  );
  add(
    "maxToeicRecordingMs: 답변 시간 + 여유(Q11 60초 → 75초, Q5 15초 → 30초)",
    maxToeicRecordingMs(11) === 75_000 && maxToeicRecordingMs(5) === 30_000,
    `${maxToeicRecordingMs(11)} ${maxToeicRecordingMs(5)}`,
  );
  add(
    "recordedToeicCount·scoredToeicCount",
    recordedToeicCount(scored.answers) === 1 && scoredToeicCount(scored.answers) === 1,
    "",
  );

  // ── WAV 정규화 순수 함수 ──
  const wav = new DataView(encodeWavPcm16(Float32Array.from([0, 0.5, -0.5, 1.5, -1.5]), 16_000));
  const tag = (off: number) => String.fromCharCode(wav.getUint8(off), wav.getUint8(off + 1), wav.getUint8(off + 2), wav.getUint8(off + 3));
  add(
    "encodeWavPcm16: RIFF/WAVE/fmt/data · PCM(1)·mono(1)·16kHz·byteRate 32000·blockAlign 2·16bit · 길이 44+2n",
    tag(0) === "RIFF" && wav.getUint32(4, true) === 36 + 10 && tag(8) === "WAVE" && tag(12) === "fmt " && wav.getUint32(16, true) === 16 &&
      wav.getUint16(20, true) === 1 && wav.getUint16(22, true) === 1 && wav.getUint32(24, true) === 16_000 && wav.getUint32(28, true) === 32_000 &&
      wav.getUint16(32, true) === 2 && wav.getUint16(34, true) === 16 && tag(36) === "data" && wav.getUint32(40, true) === 10 && wav.byteLength === 54,
    `bytes=${wav.byteLength}`,
  );
  add(
    "encodeWavPcm16: 샘플 값(0·±0.5·범위 밖은 ±1로 자름 → 32767·-32768)",
    wav.getInt16(44, true) === 0 && wav.getInt16(46, true) === 16384 && wav.getInt16(48, true) === -16384 && wav.getInt16(50, true) === 32767 && wav.getInt16(52, true) === -32768,
    [44, 46, 48, 50, 52].map((o) => wav.getInt16(o, true)).join(","),
  );
  const ramp = Float32Array.from({ length: 48_000 }, (_, i) => i / 48_000);
  const down = resampleLinear(ramp, 48_000, 16_000);
  const dc = resampleLinear(new Float32Array(44_100).fill(0.25), 44_100, 16_000);
  add(
    "resampleLinear: 48k→16k 길이 1/3·선형 신호 보존, 44.1k→16k 길이 반올림·DC 보존, 같은 레이트는 복사본",
    down.length === 16_000 && Math.abs(down[8000] - 0.5) < 1e-6 && Math.abs(down[1] - 3 / 48_000) < 1e-9 && dc.length === 16_000 &&
      dc.every((x) => Math.abs(x - 0.25) < 1e-6) && resampleLinear(ramp, 16_000, 16_000) !== ramp && resampleLinear(ramp, 16_000, 16_000).length === ramp.length,
    `len=${down.length}/${dc.length}`,
  );
  const up = resampleLinear(Float32Array.from([0, 1]), 8_000, 16_000);
  add("resampleLinear: 올림 보간(0,1 → 0,0.5,1,1)", up.length === 4 && up[0] === 0 && Math.abs(up[1] - 0.5) < 1e-9 && up[2] === 1 && up[3] === 1, Array.from(up).join(","));
  const mono = mixToMono([Float32Array.from([1, 0, 0.5]), Float32Array.from([0, 1])]);
  add("mixToMono: 채널 평균·짧은 채널 길이", mono.length === 2 && mono[0] === 0.5 && mono[1] === 0.5, Array.from(mono).join(","));

  // ── 녹음 형식 ──
  const only = (ok: string[]) => (t: string) => ok.includes(t);
  add(
    "pickMimeTypeFrom: Apple(iOS·Safari)은 audio/mp4 우선, 그 밖은 webm/opus 우선, 하나도 없으면 null(기본값)",
    pickMimeTypeFrom(true, only(["audio/mp4", "audio/webm;codecs=opus"])) === "audio/mp4" &&
      pickMimeTypeFrom(false, only(["audio/mp4", "audio/webm;codecs=opus"])) === "audio/webm;codecs=opus" &&
      pickMimeTypeFrom(true, only(["audio/webm"])) === "audio/webm" &&
      pickMimeTypeFrom(false, () => false) === null &&
      pickMimeTypeFrom(false, () => {
        throw new Error("x");
      }) === null,
    "",
  );

  // ── 기기 보관(최근 5회분) ──
  const entries = ["a", "b", "c", "d", "e", "f", "g"].flatMap((id, i) => [
    { attemptId: id, createdAt: 1000 + i * 10 },
    { attemptId: id, createdAt: 1000 + i * 10 + 5 },
  ]);
  const evict = pickAttemptsToEvict(entries, 5);
  const evictKeepA = pickAttemptsToEvict(entries, 5, "a");
  const tie = pickAttemptsToEvict([{ attemptId: "y", createdAt: 1 }, { attemptId: "x", createdAt: 1 }], 1);
  add(
    "pickAttemptsToEvict: 가장 최근 녹음 시각으로 5회분만 남긴다·지금 응시는 늘 남긴다·동률은 id 순(결정적)",
    evict.sort().join(",") === "a,b" && evictKeepA.sort().join(",") === "b" && tie.join(",") === "y" && pickAttemptsToEvict(entries.slice(0, 6), 5).length === 0,
    `${evict.join(",")} | ${evictKeepA.join(",")} | ${tie.join(",")}`,
  );
  add("toeicRecKey: {attemptId}:{q}", toeicRecKey("att-9", 11) === "att-9:11", "");

  // ── Q1–2 지문 표시 — 개수는 alignReadAloud와 같아야 한다 ──
  const text = "Doors open at 7 p.m. and twenty-five guests, twenty five staff, and one hundred fans will enter the U.S. hall.";
  const cases: [string, string][] = [
    [text, "Doors open at 7 PM and 25 guests twenty five staff and 100 fans will enter the us hall"],
    [text, "doors at seven pm and twenty guests 25 staff fans will enter hall now"],
    [text, ""],
    ["Please keep your tickets.", "please hold your ticket thanks"],
  ];
  const rng = makeRng(7);
  const vocab = ["the", "train", "will", "leave", "at", "nine", "platform", "four", "twenty", "five", "tickets", "please", "a", "hundred"];
  for (let k = 0; k < 150; k++) {
    const pick = (n: number) => Array.from({ length: n }, () => vocab[Math.floor(rng() * vocab.length)]).join(" ");
    cases.push([pick(3 + Math.floor(rng() * 12)), pick(Math.floor(rng() * 14))]);
  }
  let mismatch = 0;
  let joinBroken = 0;
  for (const [t, tr] of cases) {
    const d = alignReadAloud(t, tr);
    const m = markReadAloud(t, tr);
    if (m.missingCount !== d.missing.length || m.substitutedCount !== d.substituted.length || m.extra.join(" ") !== d.extra.join(" ")) mismatch++;
    if (m.segments.map((g) => g.text).join("") !== t) joinBroken++;
  }
  add("markReadAloud: 빠짐·치환·더 말함 개수가 alignReadAloud와 같다(고정 4 + 무작위 150쌍)", mismatch === 0, `어긋남 ${mismatch}`);
  add("markReadAloud: 조각을 이어 붙이면 지문 원문 그대로", joinBroken === 0, `깨짐 ${joinBroken}`);
  const m1 = markReadAloud(text, cases[0][1]);
  add(
    "markReadAloud: 표기만 다른 읽기(7 p.m.=7 PM, twenty-five=25, one hundred=100, U.S.=us)는 표시 없음",
    m1.segments.every((g) => g.status === "ok"),
    m1.segments.filter((g) => g.status !== "ok").map((g) => g.text).join("|"),
  );
  const m2 = markReadAloud("Please keep your tickets.", "please hold your ticket");
  const st = (w: string) => m2.segments.find((g) => g.text === w);
  const m2b = markReadAloud("Please keep your tickets.", "please keep your tickets thanks");
  add(
    "markReadAloud: 바뀐 단어에 들린 말(문장부호 붙은 조각도), 더 말한 단어는 지문 표시 없이 따로",
    st("keep")?.status === "substituted" && st("keep")?.heard === "hold" && st("tickets.")?.status === "substituted" && st("tickets.")?.heard === "ticket" &&
      st("Please")?.status === "ok" && m2.extra.length === 0 && m2b.segments.every((g) => g.status === "ok") && m2b.extra.join(",") === "thanks",
    JSON.stringify(m2.segments.filter((g) => !g.space)),
  );
  const m3 = markReadAloud("Twenty five people came.", "people came");
  add(
    "markReadAloud: 두 조각이 한 단어로 접히면(twenty five → 25) 두 조각이 같은 판정",
    m3.segments.filter((g) => !g.space).slice(0, 2).every((g) => g.status === "missing") && m3.missingCount === 1,
    JSON.stringify(m3.segments.filter((g) => !g.space).map((g) => g.status)),
  );

  // ── 업로드 형식 계약 ──
  add(
    "업로드 형식: 파라미터 무시(audio/webm;codecs=opus)·wav·mp4·m4a 받음, ogg·빈 값 거부, 확장자 폴백",
    isAcceptedToeicAudioType("audio/webm;codecs=opus") && isAcceptedToeicAudioType("AUDIO/WAV") && isAcceptedToeicAudioType("audio/mp4") &&
      isAcceptedToeicAudioType("audio/x-m4a") && !isAcceptedToeicAudioType("audio/ogg") && !isAcceptedToeicAudioType("") &&
      toeicAudioFileName("audio/mp4;codecs=mp4a.40.2") === "answer.mp4" && toeicAudioFileName("audio/wav") === "answer.wav" && toeicAudioFileName("audio/ogg") === null &&
      toeicAudioTypeFromName("answer.M4A") === "audio/m4a" && toeicAudioTypeFromName("x.ogg") === "" && toeicAudioBaseType(" Audio/WebM ; codecs=opus") === "audio/webm",
    "",
  );
  add("업로드 상한 4MB(60초 16kHz WAV ≈ 1.92MB보다 크다)", TOEIC_SCORE_AUDIO_MAX_BYTES === 4 * 1024 * 1024 && 16_000 * 2 * 60 + 44 < TOEIC_SCORE_AUDIO_MAX_BYTES, "");
  add("결과 화면 동시 채점 2개(§5-0)", TOEIC_SCORE_CONCURRENCY === 2, "");
  add("응시 결과 주소", toeicAttemptHref("a b") === "/toeic/attempts/a%20b", toeicAttemptHref("a b"));

  // ── 문항 화면 자료 ──
  const parts = mockParts();
  const views = buildToeicQuestionViews(parts, toeicAttemptQuestions([...allParts]));
  const v = (q: number) => views.find((x) => x.q === q)!;
  add(
    "문항 화면 자료: Q5·Q8만 도입 음성(상황 소개·전화 도입), Q8–10 질문 글 숨김, Q10 두 번 재생, 파트 첫 문항만 지시문",
    v(5).spokenIntro === parts.respond!.intro && v(6).spokenIntro === null && v(8).spokenIntro === parts.info!.callerIntro && v(9).spokenIntro === null &&
      !v(8).showQuestionText && !v(10).showQuestionText && v(11).showQuestionText && v(10).questionPlays === 2 &&
      views.filter((x) => x.directions).map((x) => x.q).join(",") === "1,3,5,8,11",
    "",
  );
  add(
    "문항 화면 자료: Q1 지문·Q3 사진(pending이면 imageId null → 장면 설명)·Q11 질문·모범답변, 파트가 없으면 available:false",
    v(1).passage === parts.read!.items[0].text && v(3).picture?.imageId === null && v(3).picture?.sceneKo === parts.picture!.items[0].sceneKo &&
      v(11).question === parts.opinion!.question && v(11).sampleAnswer === parts.opinion!.sampleAnswer && v(1).sampleAnswer === null &&
      buildToeicQuestionView({ ...parts, info: null }, 9).available === false,
    "",
  );
  add(
    "응시 범위 라벨",
    toeicScopeLabelKo("full", [...allParts]) === "실전 응시" && toeicScopeLabelKo("part", ["info"]) === "유형 연습 · Q8–10 정보 활용",
    toeicScopeLabelKo("part", ["info"]),
  );

  // ── 관문 T(전사) — 빈 값 폴백·키 없으면 호출 없음·기대 문장 prompt 없음 ──
  const saved = { m: process.env.OPENAI_TRANSCRIBE_MODEL, k: process.env.OPENAI_API_KEY };
  try {
    process.env.OPENAI_TRANSCRIBE_MODEL = "  ";
    const m1v = resolveToeicTranscribeModel();
    process.env.OPENAI_TRANSCRIBE_MODEL = "whisper-1";
    const m2v = resolveToeicTranscribeModel();
    add(
      "관문 T 설정: 빈 값 → gpt-4o-mini-transcribe, 지정값 사용, language en",
      m1v === DEFAULT_TOEIC_TRANSCRIBE_MODEL && m1v === "gpt-4o-mini-transcribe" && m2v === "whisper-1" && TOEIC_TRANSCRIBE_LANGUAGE === "en",
      `${m1v} ${m2v}`,
    );
    delete process.env.OPENAI_API_KEY;
    const r = await transcribeAnswer({ bytes: new ArrayBuffer(8), fileName: "answer.wav", type: "audio/wav" });
    add("관문 T: 키가 없으면 호출 없이 no_api_key", !r.ok && r.error === "no_api_key", r.ok ? "ok?" : r.error);
  } finally {
    for (const [k, val] of [["OPENAI_TRANSCRIBE_MODEL", saved.m], ["OPENAI_API_KEY", saved.k]] as const) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  }
  const tSrc = readFileSync(new URL("../lib/toeic-transcribe.ts", import.meta.url), "utf-8");
  const createCall = tSrc.slice(tSrc.indexOf("transcriptions.create("), tSrc.indexOf("transcriptions.create(") + 240);
  add(
    "관문 T: 기대 문장을 prompt로 넣지 않는다(전사 호출 인자에 prompt 없음·함수가 prompt를 받지 않는다) + signal 전달",
    tSrc.includes("transcriptions.create(") && !/\bprompt\s*:/.test(createCall) && !/prompt\??\s*:/.test(tSrc.slice(tSrc.indexOf("interface TranscribeAudioInput"), tSrc.indexOf("export type TranscribeResult"))) &&
      /\{\s*signal\s*\}/.test(createCall) && /language:\s*TOEIC_TRANSCRIBE_LANGUAGE/.test(createCall) && /response_format:\s*"json"/.test(createCall),
    createCall.replace(/\s+/g, " ").slice(0, 160),
  );
  const routeSrc = readFileSync(new URL("../app/api/toeic/attempts/[id]/score/route.ts", import.meta.url), "utf-8");
  const keyAt = routeSrc.indexOf("if (!process.env.OPENAI_API_KEY)");
  add(
    "채점 라우트: 키 검사(501)가 전사·호출 D보다 먼저, 전사에 req.signal 전달",
    keyAt > 0 &&
      keyAt < routeSrc.indexOf("await transcribeAnswer(") &&
      keyAt < routeSrc.indexOf("await generateFeedback(") &&
      routeSrc.slice(routeSrc.indexOf("await transcribeAnswer("), routeSrc.indexOf("await transcribeAnswer(") + 160).includes("req.signal)"),
    "",
  );

  // ── 개발용 시간 배율은 production에서 읽지 않는다 ──
  const takeSrc = readFileSync(new URL("../components/toeic-take-view.tsx", import.meta.url), "utf-8");
  const fnAt = takeSrc.indexOf("function readDebugTimescale");
  const body = takeSrc.slice(fnAt, fnAt + 400);
  add(
    "응시 화면: 시간 배율은 NODE_ENV=production이면 localStorage를 읽기 전에 1",
    fnAt > 0 && body.indexOf('process.env.NODE_ENV === "production"') > 0 && body.indexOf('process.env.NODE_ENV === "production"') < body.indexOf("localStorage"),
    "",
  );

  // ── 번들 경계 — 응시·결과 화면이 import하는 모듈 ──
  for (const f of ["mic-session.ts", "toeic-rec-store.ts", "toeic-audio-cue.ts", "toeic-read-marks.ts", "toeic-attempt-rules.ts", "toeic-attempt-contract.ts"]) {
    const src = readFileSync(new URL(`../lib/${f}`, import.meta.url), "utf-8");
    const bad = src.split("\n").filter((l) => /^\s*import\s+(?!type\b)[^;]*from\s+["'][^"']*(\/ai\/|\/store|openai|zod)["']/.test(l));
    const lookbehind = /\(\?<[=!]/.test(src);
    add(`lib/${f}: lib/ai·store·openai·zod 값 import 없음 + lookbehind 없음`, bad.length === 0 && !lookbehind, bad.join(" / "));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 14-4. 녹음 세션 상한 (QA m2 P2-B — lib/mic-session.ts startRecording)
//   가짜 navigator(audioSession·mediaDevices)·MediaRecorder·트랙을 전역에 잠깐 깔고 실제 startRecording을 돌린다.
//   getUserMedia 무응답 → 상한 뒤 timeout·activeCaptures 복구·playback / 늦은 스트림 트랙 stop / 무응답 뒤 정상 녹음은 끝나면
//   playback / 거부 → denied / start 이벤트 무응답 → 스스로 버림·abort 멱등(다른 캡처 보호 유지). 상수는 한 곳(화면이 import).
// ---------------------------------------------------------------------------

async function runMicSessionChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "녹음 세션 상한");
  const g = globalThis as unknown as Record<string, unknown>;
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const hadWindow = Object.prototype.hasOwnProperty.call(g, "window");
  const prevWindow = g.window;
  const hadRecorder = Object.prototype.hasOwnProperty.call(g, "MediaRecorder");
  const prevRecorder = g.MediaRecorder;

  const log: string[] = [];
  type GumMode = { kind: "ok"; delayMs: number } | { kind: "hang" } | { kind: "reject"; name: string };
  let gumMode: GumMode = { kind: "ok", delayMs: 1 };
  let recorderStarts = true;
  let trackSeq = 0;
  const session = {
    _t: "playback",
    get type(): string {
      return this._t;
    },
    set type(v: string) {
      this._t = v;
      log.push(`session=${v}`);
    },
  };
  class FakeTrack {
    stopped = false;
    constructor(readonly id: string) {}
    stop(): void {
      if (this.stopped) return;
      this.stopped = true;
      log.push(`track.stop:${this.id}`);
    }
  }
  const tracks = new Map<string, FakeTrack>();
  const mediaDevices = {
    getUserMedia: (): Promise<unknown> => {
      log.push("gUM");
      const m = gumMode;
      if (m.kind === "hang") return new Promise(() => {}); // 끝내 답하지 않는다(iPhone 탭 밖 권한 창 등)
      if (m.kind === "reject") return Promise.reject(new DOMException("denied", m.name));
      return new Promise((resolve) =>
        setTimeout(() => {
          const t = new FakeTrack(`t${++trackSeq}`);
          tracks.set(t.id, t);
          log.push(`gUM.resolve:${t.id}`);
          resolve({ getTracks: () => [t] });
        }, m.delayMs),
      );
    },
  };
  class FakeRecorder {
    static isTypeSupported(t: string): boolean {
      return t.startsWith("audio/webm");
    }
    state: "inactive" | "recording" = "inactive";
    mimeType: string;
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ondataavailable: ((ev: { data: Blob }) => void) | null = null;
    constructor(_stream: unknown, opts?: { mimeType?: string }) {
      this.mimeType = opts?.mimeType ?? "audio/webm";
    }
    start(): void {
      this.state = "recording";
      log.push("rec.start");
      if (recorderStarts) setTimeout(() => this.onstart?.(), 1);
    }
    stop(): void {
      if (this.state === "inactive") return;
      this.state = "inactive";
      log.push("rec.stop");
      setTimeout(() => {
        this.ondataavailable?.({ data: new Blob(["x"], { type: this.mimeType }) });
        this.onstop?.();
      }, 1);
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0", platform: "Linux", maxTouchPoints: 0, mediaDevices, audioSession: session },
  });
  g.window = { isSecureContext: true, MediaRecorder: FakeRecorder };
  g.MediaRecorder = FakeRecorder;
  const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const lastSession = () => [...log].reverse().find((l) => l.startsWith("session=")) ?? "(없음)";
  /** 거부 값을 돌려준다(성공이면 null). 1초 안에 끝나지 않으면 "HANG" — 상한이 사라지는 회귀가 eval을 멈추지 않고 FAIL로 나오게. */
  const catchErr = async (p: Promise<unknown>): Promise<unknown> => {
    const hang = new Promise<string>((r) => setTimeout(() => r("HANG"), 1000));
    try {
      const v = await Promise.race([p.then(() => null), hang]);
      return v;
    } catch (e) {
      return e;
    }
  };

  try {
    // M1 무응답 → 상한 뒤 timeout, activeCaptures 복구(=playback 전환이 다시 먹는다), 세션 playback
    {
      log.length = 0;
      gumMode = { kind: "hang" };
      const t0 = Date.now();
      const err = await catchErr(startRecording({ gumTimeoutMs: 40 }));
      const el = Date.now() - t0;
      const canPlayback = setAudioSessionPlayback();
      add(
        "M1 getUserMedia 무응답 → 상한(40ms) 뒤 MicError('timeout') · play-and-record → playback · activeCaptures 0(playback 전환이 다시 먹음)",
        err instanceof MicError && err.kind === "timeout" && el >= 35 && log.join(",") === "session=play-and-record,gUM,session=playback" && canPlayback,
        `${el}ms kind=${err instanceof MicError ? err.kind : String(err)} log=${log.join(",")} playback=${canPlayback}`,
      );
    }
    // M2 늦게 도착한 스트림 → 트랙 즉시 stop, 세션은 playback 그대로(다시 play-and-record로 안 감)
    {
      log.length = 0;
      gumMode = { kind: "ok", delayMs: 80 };
      const err = await catchErr(startRecording({ gumTimeoutMs: 30 }));
      await sleepMs(120);
      const id = log.find((l) => l.startsWith("gUM.resolve:"))?.split(":")[1] ?? "";
      add(
        "M2 상한 뒤 늦게 온 스트림 → 트랙 즉시 stop · 녹음 시작 안 함 · 세션 playback 유지",
        err instanceof MicError && err.kind === "timeout" && !!id && tracks.get(id)?.stopped === true && log.indexOf(`track.stop:${id}`) > log.indexOf(`gUM.resolve:${id}`) && !log.includes("rec.start") && lastSession() === "session=playback" && setAudioSessionPlayback(),
        `log=${log.join(",")}`,
      );
    }
    // M3 무응답 한 번 뒤의 정상 녹음 — QA S3(이후 녹음이 정상 종료돼도 playback이 한 번도 안 걸림)의 반례
    {
      log.length = 0;
      gumMode = { kind: "hang" };
      await catchErr(startRecording({ gumTimeoutMs: 20 }));
      gumMode = { kind: "ok", delayMs: 1 };
      const rec = await startRecording({ gumTimeoutMs: 1000, startTimeoutMs: 500 });
      await rec.started;
      const guardDuring = setAudioSessionPlayback(); // 녹음 중 — 바꾸면 트랙이 끝난다 → false여야
      const result = await rec.stop();
      const id = log.filter((l) => l.startsWith("gUM.resolve:")).pop()?.split(":")[1] ?? "";
      const iTrack = log.indexOf(`track.stop:${id}`);
      const iLast = log.lastIndexOf("session=playback");
      add(
        "M3 무응답 뒤 정상 녹음 → 녹음 중 playback 전환 거부 · 끝나면 rec.stop → 트랙 stop → **그다음** playback",
        guardDuring === false && !!result && log.indexOf("rec.stop") < iTrack && iTrack < iLast && lastSession() === "session=playback",
        `during=${guardDuring} log=${log.join(",")}`,
      );
    }
    // M4 거부 → denied, playback 복귀
    {
      log.length = 0;
      gumMode = { kind: "reject", name: "NotAllowedError" };
      const err = await catchErr(startRecording());
      add(
        "M4 권한 거부 → MicError('denied') · play-and-record → playback · activeCaptures 0",
        err instanceof MicError && err.kind === "denied" && log.join(",") === "session=play-and-record,gUM,session=playback" && setAudioSessionPlayback(),
        `log=${log.join(",")}`,
      );
    }
    // M5 start 이벤트 무응답 → started 거부 + 스스로 버림. 호출부 abort는 멱등 — 동시에 도는 다른 녹음(B)의 보호를 깨지 않는다
    {
      log.length = 0;
      gumMode = { kind: "ok", delayMs: 1 };
      recorderStarts = true;
      const recB = await startRecording({ startTimeoutMs: 500 });
      await recB.started;
      const idB = log.filter((l) => l.startsWith("gUM.resolve:")).pop()?.split(":")[1] ?? "";
      recorderStarts = false;
      const recA = await startRecording({ startTimeoutMs: 30 });
      const idA = log.filter((l) => l.startsWith("gUM.resolve:")).pop()?.split(":")[1] ?? "";
      const errA = await catchErr(recA.started);
      const selfReleased = tracks.get(idA)?.stopped === true;
      recA.abort();
      recA.abort();
      const stopA = await recA.stop();
      const guardB = setAudioSessionPlayback(); // B는 아직 녹음 중 → false여야(이중 감소가 없다)
      const playbackWhileB = log.slice(log.indexOf(`gUM.resolve:${idB}`)).includes("session=playback");
      recorderStarts = true;
      const resB = await recB.stop();
      add(
        "M5 start 이벤트 무응답 → started 거부('failed') · 호출부 abort 없이도 트랙 stop · abort 두 번·stop 모두 멱등 · 녹음 중인 B의 세션 보호 유지 → B 끝나면 playback",
        errA instanceof MicError && errA.kind === "failed" && selfReleased && stopA === null && guardB === false && !playbackWhileB && !!resB && tracks.get(idB)?.stopped === true && lastSession() === "session=playback" && setAudioSessionPlayback(),
        `errA=${errA instanceof MicError ? errA.kind : String(errA)} self=${selfReleased} guardB=${guardB} log=${log.join(",")}`,
      );
    }
  } finally {
    if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
    else delete g.navigator;
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
    if (hadRecorder) g.MediaRecorder = prevRecorder;
    else delete g.MediaRecorder;
  }

  // 상한 상수는 한 곳 — 응시 화면이 lib/mic-session에서 import한다(숫자를 다시 적지 않는다)
  const takeSrc = readFileSync(new URL("../components/toeic-take-view.tsx", import.meta.url), "utf-8");
  const checkAt = takeSrc.indexOf("async function checkMic");
  const checkBody = takeSrc.slice(checkAt, takeSrc.indexOf("function start()", checkAt));
  add(
    "상한 상수 한 곳: getUserMedia 8초(답변)·점검은 그보다 길게(권한 창 응답) · 화면 감시 타이머 = MIC_GUM_TIMEOUT_MS",
    MIC_GUM_TIMEOUT_MS === 8000 && MIC_CHECK_GUM_TIMEOUT_MS > MIC_GUM_TIMEOUT_MS && /const MIC_START_WATCHDOG_MS = MIC_GUM_TIMEOUT_MS;/.test(takeSrc),
    `gum=${MIC_GUM_TIMEOUT_MS} check=${MIC_CHECK_GUM_TIMEOUT_MS}`,
  );
  add(
    "마이크 점검: 점검 상한(gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS)을 넘기고, 시작 실패(catch)에서 abort — 트랙·activeCaptures 누수 없음",
    checkAt > 0 && checkBody.includes("gumTimeoutMs: MIC_CHECK_GUM_TIMEOUT_MS") && /catch \(e\) \{\s*rec\?\.abort\(\);/.test(checkBody),
    "",
  );
  return results;
}

// ---------------------------------------------------------------------------
// 15. 번들 경계 — 클라이언트 import 가능 모듈은 lib/ai를 런타임 import하지 않는다
// ---------------------------------------------------------------------------

function runBundleBoundaryChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "번들 경계");
  const files = ["toeic-quiz.ts", "toeic-mock.ts", "toeic-score.ts", "toeic-listen.ts", "toeic-text.ts", "tts-split.ts"];
  for (const f of files) {
    const src = readFileSync(new URL(`../lib/${f}`, import.meta.url), "utf-8");
    const bad = src.split("\n").filter((l) => /^\s*import\s+(?!type\b)[^;]*from\s+["'][^"']*(\/ai\/|\/store|openai|zod)["']/.test(l));
    add(`lib/${f}: lib/ai·store·openai·zod 값 import 없음`, bad.length === 0, bad.length === 0 ? "type만" : bad.join(" / "));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 16. spec-sync — 프롬프트(문자열) 바이트 대조 + JSON Schema 의미 동치
// ---------------------------------------------------------------------------

const SRC = "lib/ai/toeic/prompts.ts";
const SPEC_SYNC_TARGETS: readonly SpecSyncTarget[] = [
  { constName: "TOEIC_EXTRACT_SYSTEM_PROMPT", source: SRC, specLabel: "§2-1 호출 A 시스템 프롬프트", text: TOEIC_EXTRACT_SYSTEM_PROMPT, mode: "block" },
  { constName: "TOEIC_EXTRACT_USER_TEXT", source: SRC, specLabel: "§2-2 호출 A 사용자 메시지", text: TOEIC_EXTRACT_USER_TEXT, mode: "block" },
  { constName: "TOEIC_POINTS_SYSTEM_PROMPT", source: SRC, specLabel: "§3-1 호출 B 시스템 프롬프트", text: TOEIC_POINTS_SYSTEM_PROMPT, mode: "block" },
  { constName: "TOEIC_POINTS_USER_TEMPLATE", source: SRC, specLabel: "§3-2 호출 B 사용자 메시지 형식", text: TOEIC_POINTS_USER_TEMPLATE, mode: "block" },
  { constName: "TOEIC_MOCK_COMMON", source: SRC, specLabel: "§4-1 호출 C 공통 머리말", text: TOEIC_MOCK_COMMON, mode: "block" },
  { constName: "TOEIC_MOCK_READ_TASK", source: SRC, specLabel: "§4-2 C1 read", text: TOEIC_MOCK_READ_TASK, mode: "block" },
  { constName: "TOEIC_MOCK_PICTURE_TASK", source: SRC, specLabel: "§4-3 C2 picture", text: TOEIC_MOCK_PICTURE_TASK, mode: "block" },
  { constName: "TOEIC_MOCK_RESPOND_TASK", source: SRC, specLabel: "§4-4 C3 respond", text: TOEIC_MOCK_RESPOND_TASK, mode: "block" },
  { constName: "TOEIC_MOCK_INFO_TASK", source: SRC, specLabel: "§4-5 C4 info", text: TOEIC_MOCK_INFO_TASK, mode: "block" },
  { constName: "TOEIC_MOCK_OPINION_TASK", source: SRC, specLabel: "§4-6 C5 opinion", text: TOEIC_MOCK_OPINION_TASK, mode: "block" },
  { constName: "TOEIC_MOCK_USER_TEMPLATE", source: SRC, specLabel: "§4-7 호출 C 사용자 메시지 형식", text: TOEIC_MOCK_USER_TEMPLATE, mode: "block" },
  { constName: "TOEIC_IMAGE_PROMPT_SUFFIX", source: SRC, specLabel: "§4-10 사진 프롬프트 접미사", text: TOEIC_IMAGE_PROMPT_SUFFIX, mode: "block" },
  { constName: "TOEIC_FEEDBACK_SYSTEM_PROMPT", source: SRC, specLabel: "§5-1 호출 D 시스템 프롬프트", text: TOEIC_FEEDBACK_SYSTEM_PROMPT, mode: "block" },
  { constName: "TOEIC_FEEDBACK_USER_TEMPLATE", source: SRC, specLabel: "§5-2 호출 D 사용자 메시지 형식", text: TOEIC_FEEDBACK_USER_TEMPLATE, mode: "block" },
];

const specSyncOutcomes: SpecSyncOutcome[] = [];

function runSpecSyncChecks(): CheckResult[] {
  specSyncOutcomes.length = 0;
  specSyncOutcomes.push(...checkSpecSync(TOEIC_SPEC_URL, SPEC_SYNC_TARGETS));
  const results: CheckResult[] = specSyncOutcomes.map((o) => ({
    book: "프롬프트 ↔ 스펙",
    check: `${o.constName}이 toeic.md 원문 그대로`,
    pass: o.ok,
    detail: o.summary,
  }));
  const add = makeAdder(results, "프롬프트 ↔ 스펙");
  add(
    "호출 C 조립 = TOEIC_MOCK_COMMON + \"\\n\\n\" + 파트 과제 절(5개)",
    TOEIC_MOCK_PARTS.every((p) => buildMockSystemPrompt(p) === `${TOEIC_MOCK_COMMON}\n\n${TOEIC_MOCK_TASKS[p]}`) && new Set(Object.values(TOEIC_MOCK_TASKS)).size === 5,
    "",
  );
  add("관문 P 프롬프트 = imagePrompt + 접미사", buildSceneImagePrompt("  A park.  ") === `A park. ${TOEIC_IMAGE_PROMPT_SUFFIX}`, "");
  return results;
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

function runJsonSchemaSyncChecks(): CheckResult[] {
  const book = "프롬프트 ↔ 스펙";
  const targets: { name: string; constName: string; value: unknown; label: string }[] = [
    { name: "toeic_expr_extraction", constName: "TOEIC_EXPR_EXTRACTION_JSON_SCHEMA", value: TOEIC_EXPR_EXTRACTION_JSON_SCHEMA, label: "§2-3" },
    { name: "toeic_speaking_points", constName: "TOEIC_SPEAKING_POINTS_JSON_SCHEMA", value: TOEIC_SPEAKING_POINTS_JSON_SCHEMA, label: "§3-3" },
    { name: "toeic_mock_read", constName: "TOEIC_MOCK_READ_JSON_SCHEMA", value: TOEIC_MOCK_READ_JSON_SCHEMA, label: "§4-8 read" },
    { name: "toeic_mock_picture", constName: "TOEIC_MOCK_PICTURE_JSON_SCHEMA", value: TOEIC_MOCK_PICTURE_JSON_SCHEMA, label: "§4-8 picture" },
    { name: "toeic_mock_respond", constName: "TOEIC_MOCK_RESPOND_JSON_SCHEMA", value: TOEIC_MOCK_RESPOND_JSON_SCHEMA, label: "§4-8 respond" },
    { name: "toeic_mock_info", constName: "TOEIC_MOCK_INFO_JSON_SCHEMA", value: TOEIC_MOCK_INFO_JSON_SCHEMA, label: "§4-8 info" },
    { name: "toeic_mock_opinion", constName: "TOEIC_MOCK_OPINION_JSON_SCHEMA", value: TOEIC_MOCK_OPINION_JSON_SCHEMA, label: "§4-8 opinion" },
    { name: "toeic_answer_feedback", constName: "TOEIC_ANSWER_FEEDBACK_JSON_SCHEMA", value: TOEIC_ANSWER_FEEDBACK_JSON_SCHEMA, label: "§5-3" },
  ];
  let blocks: ReturnType<typeof extractSpecBlocks>;
  try {
    blocks = extractSpecBlocks(TOEIC_SPEC_URL);
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
  const out: CheckResult[] = targets.map((t) => {
    const specSchema = parsedByName.get(t.name);
    if (specSchema === undefined) {
      return { book, check: `${t.constName} ↔ ${t.label} 의미 동치`, pass: false, detail: `스펙에서 ${t.name} JSON 블록을 찾지 못함` };
    }
    const ok = deepEqual(specSchema, t.value);
    return { book, check: `${t.constName} ↔ ${t.label} 의미 동치`, pass: ok, detail: ok ? "의미 일치" : `스펙 ${t.label}과 코드 상수가 다름` };
  });
  out.push({ book, check: "스펙의 JSON Schema 블록 수 = 8", pass: [...parsedByName.keys()].filter((k) => k.startsWith("toeic_")).length === 8, detail: [...parsedByName.keys()].join(",") });
  return out;
}

// ---------------------------------------------------------------------------
// 실호출 점검 (게이트 EVAL_TOEIC=1) — 에이전트는 실행하지 않는다. 오케스트레이터가 사용자 동의 후 돌린다.
// ---------------------------------------------------------------------------

async function runLiveChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = makeAdder(results, "실호출(게이트)");
  if (!process.env.OPENAI_API_KEY) {
    add("OPENAI_API_KEY", false, "키가 없어 실호출을 할 수 없습니다");
    return results;
  }
  // 게이트 안에서만 로드한다 — 오프라인 경로는 openai 클라이언트 모듈을 건드리지 않는다
  const calls = await import("../lib/ai/toeic/calls");

  // A — 사진 1장(EVAL_TOEIC_PHOTO). 결과 내용은 찍지 않고 개수만(교재 원문이 로그에 남지 않게)
  const photo = process.env.EVAL_TOEIC_PHOTO;
  if (photo && existsSync(photo)) {
    try {
      const mime = /\.png$/i.test(photo) ? "image/png" : "image/jpeg";
      const dataUrl = `data:${mime};base64,${readFileSync(photo).toString("base64")}`;
      const x = await calls.extractToeicPage(dataUrl);
      add("A 판독(사진 1장)", x.isExpressionPage && x.entries.length > 0, `isPage=${x.isExpressionPage} entries=${x.entries.length} quiz=${x.quiz.length}`);
    } catch (e) {
      add("A 판독(사진 1장)", false, e instanceof Error ? e.message : String(e));
    }
  } else {
    results.push({ book: "실호출(게이트)", check: "A 판독", pass: true, skip: true, detail: "EVAL_TOEIC_PHOTO(사진 경로)가 없어 건너뜀" });
  }

  // B — 지어낸 표현 7개
  try {
    const items = await calls.generatePointsChunk("장보기", pointsInputs());
    add("B 발화 포인트(7개)", items.length === 7, `items=${items.length}`);
  } catch (e) {
    add("B 발화 포인트(7개)", false, e instanceof Error ? e.message : String(e));
  }

  // C — 파트 1개(EVAL_TOEIC_PART, 기본 opinion)
  const part = (TOEIC_MOCK_PARTS as readonly string[]).includes(process.env.EVAL_TOEIC_PART ?? "") ? (process.env.EVAL_TOEIC_PART as (typeof TOEIC_MOCK_PARTS)[number]) : "opinion";
  try {
    const r = await calls.generateMockPart(part, { targetGrade: "IH", topicHints: ["직장 생활"], expressions: ["in the long run", "free of charge"] });
    add(`C 문항 생성(${part})`, r !== null, "zod 통과");
  } catch (e) {
    add(`C 문항 생성(${part})`, false, e instanceof Error ? e.message : String(e));
  }

  // D — 픽스처 전사문 1개(Q11)
  try {
    const input = buildFeedbackInput({ parts: mockParts(), expressionsUsed: ["in the long run"] }, 11, TRANSCRIPT_Q11)!;
    const fb = await calls.generateFeedback(input);
    add("D 피드백(Q11 픽스처)", fb.score >= 0 && fb.score <= 5, `score=${fb.score} fixes=${fb.fixes.length}`);
  } catch (e) {
    add("D 피드백(Q11 픽스처)", false, e instanceof Error ? e.message : String(e));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const all: CheckResult[] = [];
  all.push(...runConstantChecks());
  all.push(...runExtractZodChecks());
  all.push(...runPointsZodChecks());
  all.push(...runMockZodChecks());
  all.push(...runFeedbackZodChecks());
  all.push(...runExtractMergeChecks());
  all.push(...runPointsMergeChecks());
  all.push(...runMockPostChecks());
  all.push(...runQuizChecks());
  all.push(...runModeSeparationChecks());
  all.push(...runPhaseChecks());
  all.push(...runScoreChecks());
  all.push(...runListenChecks());
  all.push(...runImportChecks());
  all.push(...runStreakTrackChecks());
  all.push(...(await runMockStoreRuleChecks()));
  all.push(...(await runAttemptChecks()));
  all.push(...(await runMicSessionChecks()));
  all.push(...runBundleBoundaryChecks());
  all.push(...runSpecSyncChecks());
  all.push(...runJsonSchemaSyncChecks());

  printTable(all);
  printSpecSyncDetails(specSyncOutcomes);

  const failed = all.filter((r) => !r.pass && !r.skip);
  const skipped = all.filter((r) => r.skip).length;
  if (failed.length > 0) {
    console.error(`FAIL — 오프라인 ${failed.length}개 항목 실패.`);
    process.exit(1);
  }

  if (process.env.EVAL_TOEIC === "1") {
    if (process.env.EVAL_OFFLINE_ONLY === "1") {
      console.log("EVAL_TOEIC=1이지만 EVAL_OFFLINE_ONLY=1 — 실호출 점검을 건너뜁니다(네트워크 차단).");
    } else {
      const live = await runLiveChecks();
      printTable(live);
      const liveFailed = live.filter((r) => !r.pass && !r.skip);
      if (liveFailed.length > 0) {
        console.error(`FAIL — 실호출 ${liveFailed.length}개 항목 실패.`);
        process.exit(1);
      }
      console.log(`PASS — 실호출 ${live.length}개 항목(건너뜀 ${live.filter((r) => r.skip).length}).`);
    }
  }

  console.log(`PASS — 오프라인 ${all.length - skipped}개 항목 통과, ${skipped}개 SKIP (실호출 ${process.env.EVAL_TOEIC === "1" && process.env.EVAL_OFFLINE_ONLY !== "1" ? "실행" : "미실행"}).`);
}

void main();
