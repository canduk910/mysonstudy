/**
 * scripts/eval-japanese-speaking.ts — 🎙️ 말하기 모의고사(docs/harness/japanese.md §15) 오프라인 점검 조각
 *
 * `scripts/eval-japanese.ts`가 `runJaSpeakingChecks()`를 불러 한 번에 돈다(단독 실행 진입점 없음). 실호출 0 —
 * 순수 함수·zod·spec-sync·JSON Schema 의미 동치만 본다. 픽스처의 일본어 문장은 전부 지어낸 것이다(교재 원문 없음).
 */

import { readFileSync } from "node:fs";
import {
  JA_SPEAKING_FEEDBACK_SYSTEM_PROMPT,
  JA_SPEAKING_FEEDBACK_USER_TEMPLATE,
  JA_SPEAKING_IMAGE_PROMPT_SUFFIX,
  JA_SPEAKING_INFO_TASK,
  JA_SPEAKING_MOCK_COMMON,
  JA_SPEAKING_MOCK_USER_TEMPLATE,
  JA_SPEAKING_OPINION_TASK,
  JA_SPEAKING_PICTURE_TASK,
  JA_SPEAKING_READ_TASK,
  JA_SPEAKING_RESPOND_TASK,
  buildJaSpeakingFeedbackUserMessage,
  buildJaSpeakingImagePrompt,
  buildJaSpeakingMockUserMessage,
  buildJaSpeakingSystemPrompt,
  fillJaSpeakingTemplate,
  jaSpeakingCallLabel,
  jaSpeakingCallOptionsSentence,
  normalizeJaSpeakingTopicHints,
} from "../lib/ai/japanese/speaking-prompts";
import {
  JA_SPEAKING_FEEDBACK_JSON_SCHEMA,
  JA_SPEAKING_JSON_DEFS,
  JA_SPEAKING_JSON_SCHEMAS,
  JA_SPEAKING_ZOD,
  buildJaSpeakingFeedbackZod,
  isJaQuestionEnding,
  type JaLine,
  type JaSpeakingPartRecordMap,
} from "../lib/ai/japanese/speaking-schemas";
import { buildJaSpeakingFeedbackInput, buildJaSpeakingFeedbackMaterial, toJaSpeakingRecordPart, type JaSpeakingParts } from "../lib/ai/japanese/speaking";
import {
  JA_SPEAKING_ANSWER_CUE,
  JA_SPEAKING_CUE_LISTEN_AGAIN,
  JA_SPEAKING_CUE_PREPARE,
  JA_SPEAKING_PARTS,
  JA_SPEAKING_PART_DIRECTIONS,
  countJaSpeechChars,
  estimateJaSpeakingLevel,
  jaSpeakingAchievement,
  jaSpeakingAnswerRange,
  jaSpeakingCueTexts,
  jaSpeakingLengthLines,
  jaSpeakingPartDirections,
  jaSpeakingPassageRange,
  jaSpeakingPhaseCue,
  jaSpeakingQuestionPieces,
  jaSpeakingQuestionsForParts,
  jaSpeakingZodAnswerBand,
} from "../lib/ja-speaking";
import {
  alignJaReadAloud,
  isJaNoResponseTranscript,
  isSaidInJaTranscript,
  jaReadProxyScore,
  normalizeJaReadChars,
  type JaReadToken,
} from "../lib/ja-speaking-score";
import { TOEIC_MOCK_FORMAT, toeicCueTexts, toeicQuestionsForParts } from "../lib/toeic-mock";
import { jaTokenSchema } from "../lib/ai/japanese/schemas";
import { checkSpecSync, extractSpecBlocks, type SpecSyncOutcome, type SpecSyncTarget } from "./spec-sync";
import { runJaSpeakingAppChecks } from "./eval-japanese-speaking-app";

export interface JaSpeakingCheckResult {
  book: string;
  check: string;
  pass: boolean;
  detail: string;
}

const SPEC_URL = new URL("../docs/harness/japanese.md", import.meta.url);
const PROMPTS = "lib/ai/japanese/speaking-prompts.ts";

/** §15 spec-sync 대상 — 원문 10(block-exact) + 호출 옵션 문장 2(inline) */
export const JA_SPEAKING_SPEC_SYNC_TARGETS: readonly SpecSyncTarget[] = [
  { constName: "JA_SPEAKING_MOCK_COMMON", source: PROMPTS, specLabel: "§15-3-1 호출 E 머리말", text: JA_SPEAKING_MOCK_COMMON, mode: "block-exact" },
  { constName: "JA_SPEAKING_READ_TASK", source: PROMPTS, specLabel: "§15-3-2 E1", text: JA_SPEAKING_READ_TASK, mode: "block-exact" },
  { constName: "JA_SPEAKING_PICTURE_TASK", source: PROMPTS, specLabel: "§15-3-3 E2", text: JA_SPEAKING_PICTURE_TASK, mode: "block-exact" },
  { constName: "JA_SPEAKING_RESPOND_TASK", source: PROMPTS, specLabel: "§15-3-4 E3", text: JA_SPEAKING_RESPOND_TASK, mode: "block-exact" },
  { constName: "JA_SPEAKING_INFO_TASK", source: PROMPTS, specLabel: "§15-3-5 E4", text: JA_SPEAKING_INFO_TASK, mode: "block-exact" },
  { constName: "JA_SPEAKING_OPINION_TASK", source: PROMPTS, specLabel: "§15-3-6 E5", text: JA_SPEAKING_OPINION_TASK, mode: "block-exact" },
  { constName: "JA_SPEAKING_MOCK_USER_TEMPLATE", source: PROMPTS, specLabel: "§15-3-7 호출 E 사용자 메시지", text: JA_SPEAKING_MOCK_USER_TEMPLATE, mode: "block-exact" },
  { constName: "JA_SPEAKING_FEEDBACK_SYSTEM_PROMPT", source: PROMPTS, specLabel: "§15-4-1 호출 F 시스템", text: JA_SPEAKING_FEEDBACK_SYSTEM_PROMPT, mode: "block-exact" },
  { constName: "JA_SPEAKING_FEEDBACK_USER_TEMPLATE", source: PROMPTS, specLabel: "§15-4-2 호출 F 사용자 메시지", text: JA_SPEAKING_FEEDBACK_USER_TEMPLATE, mode: "block-exact" },
  { constName: "JA_SPEAKING_IMAGE_PROMPT_SUFFIX", source: PROMPTS, specLabel: "§15-7 사진 접미사", text: JA_SPEAKING_IMAGE_PROMPT_SUFFIX, mode: "block-exact" },
  { constName: "jaSpeakingCallOptionsSentence(mock)", source: PROMPTS, specLabel: "§15-3-0 호출 옵션 문장", text: jaSpeakingCallOptionsSentence("mock"), mode: "inline" },
  { constName: "jaSpeakingCallOptionsSentence(feedback)", source: PROMPTS, specLabel: "§15-4-0 호출 옵션 문장", text: jaSpeakingCallOptionsSentence("feedback"), mode: "inline" },
];

// ---------------------------------------------------------------------------
// 도우미
// ---------------------------------------------------------------------------

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

const DEFS_PLACEHOLDER = { line: { "…": "ja_speaking_read와 동일" }, tokens: { "…": "ja_speaking_read와 동일" } };
function withDefsPlaceholder(schemaConst: unknown): unknown {
  const c = JSON.parse(JSON.stringify(schemaConst)) as { schema: { $defs?: unknown } };
  c.schema.$defs = DEFS_PLACEHOLDER;
  return c;
}

/** strict 모양 — 모든 객체 additionalProperties:false·properties 키 = required, minItems/maxItems 없음 */
function strictShapeIssues(node: unknown, path = "$"): string[] {
  if (node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n, i) => strictShapeIssues(n, `${path}[${i}]`));
  const o = node as Record<string, unknown>;
  const out: string[] = [];
  if ("minItems" in o || "maxItems" in o) out.push(`${path}: minItems/maxItems 금지`);
  if (o.type === "object") {
    if (o.additionalProperties !== false) out.push(`${path}: additionalProperties:false 아님`);
    const props = Object.keys((o.properties as Record<string, unknown>) ?? {});
    const req = (o.required as string[]) ?? [];
    if (props.length !== req.length || !props.every((p) => req.includes(p))) out.push(`${path}: required ≠ properties`);
  }
  for (const [k, v] of Object.entries(o)) out.push(...strictShapeIssues(v, `${path}.${k}`));
  return out;
}

/**
 * 후리가나를 단 일본어 줄 — 주석 문법 `漢字{よみ}`(한자 덩어리 바로 뒤에 읽기). 그 밖의 글자는 reading null 토큰.
 * 말하기 토큰 규칙(§15-3-9 — 한자가 든 토큰은 한자만 + reading 필수)을 지키는 정상 모양이다. 지어낸 문장.
 */
function L(annot: string, ko = "뜻입니다"): JaLine {
  const tokens: { surface: string; reading: string | null }[] = [];
  const re = /([一-鿿㐀-䶿々]+)\{([぀-ゟー]+)\}/g;
  let last = 0;
  for (const m of annot.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) tokens.push({ surface: annot.slice(last, i), reading: null });
    tokens.push({ surface: m[1], reading: m[2] });
    last = i + m[0].length;
  }
  if (last < annot.length) tokens.push({ surface: annot.slice(last), reading: null });
  return { ja: tokens.map((t) => t.surface).join(""), tokens, ko };
}
/** 통째 한 토큰(reading null) — 말하기 토큰 규칙 반례용 */
const L1 = (ja: string, ko = "뜻입니다"): JaLine => ({ ja, tokens: [{ surface: ja, reading: null }], ko });
const rep = (s: string, n: number) => Array.from({ length: n }, () => s).join("");

const PASSAGE_A = "皆様{みなさま}、本日{ほんじつ}はさくら市民{しみん}ホールにお越{こ}しいただき、ありがとうございます。午後{ごご}2時{じ}から、ピアノとバイオリンのコンサートが始{はじ}まります。会場内{かいじょうない}での飲食{いんしょく}はご遠慮{えんりょ}ください。";
const PASSAGE_B = "こちらは山川{やまかわ}旅行{りょこう}です。ただいま電話{でんわ}に出{で}ることができません。営業{えいぎょう}時間{じかん}は午前{ごぜん}9時{じ}から午後{ごご}6時{じ}までです。お名前{なまえ}とお電話{でんわ}番号{ばんごう}を残{のこ}してください。後{のち}ほどこちらからお電話{でんわ}します。";
const ANS15 = "週{しゅう}に2回{かい}ぐらい行{い}きます。会社{かいしゃ}の友達{ともだち}と一緒{いっしょ}に行{い}くことが多{おお}いです。";
const ANS30 = rep("駅{えき}の近{ちか}くの店{みせ}でよく買{か}い物{もの}をします。安{やす}くて便利{べんり}だからです。", 2);
const ANS60 = rep("私{わたし}は在宅{ざいたく}勤務{きんむ}に賛成{さんせい}です。通勤{つうきん}の時間{じかん}がなくなって、朝{あさ}の時間{じかん}を勉強{べんきょう}に使{つか}えるからです。", 3);
const IMG_PROMPT =
  "A busy convenience store in Tokyo in the evening. On the left, a woman in a gray coat is paying at the counter. In the center, a man in a blue suit is looking at drinks in a tall refrigerator. On the right, a young clerk in a green uniform is stocking shelves with snacks. Bright ceiling lights, a magazine rack near the window, and rain outside the glass door.";

function validRead() {
  return { items: [{ kind: "announcement", passage: L(PASSAGE_A), tipsKo: ["장음에 주의하세요", "숫자 읽기"] }, { kind: "voicemail", passage: L(PASSAGE_B), tipsKo: ["촉음", "끊어 읽기"] }] };
}
function validPicture() {
  return {
    items: [
      { place: "편의점", imagePrompt: IMG_PROMPT, sceneKo: "저녁의 편의점 장면이다.", sampleAnswer: L(ANS30), keyPointsKo: ["계산하는 여자", "음료를 고르는 남자", "진열하는 점원"] },
      { place: "역 개찰구", imagePrompt: IMG_PROMPT, sceneKo: "아침의 역 개찰구다.", sampleAnswer: L(ANS30), keyPointsKo: ["개찰구", "서두르는 사람", "안내판"] },
    ],
  };
}
function validRespond() {
  const q = (question: string, ans: string) => ({ question: L(question), sampleAnswer: L(ans), tipKo: "직답부터 하세요" });
  return {
    topicKo: "운동",
    intro: L("日本{にほん}の調査{ちょうさ}会社{がいしゃ}から電話{でんわ}がかかってきました。運動{うんどう}についてのアンケートに答{こた}えることにしました。"),
    questions: [q("どのくらい運動{うんどう}しますか。", ANS15), q("いつ、だれと運動{うんどう}しますか？", ANS15), q("ジムと公園{こうえん}、どちらで運動{うんどう}したいですか。理由{りゆう}も教{おし}えてもらえますか。", ANS30)],
  };
}
function validInfo() {
  const q = (question: string, ans: string) => ({ question: L(question), sampleAnswer: L(ans), tipKo: "표에서 찾아 말하세요" });
  return {
    table: {
      kind: "schedule",
      title: "新入社員研修",
      titleKo: "신입사원 연수",
      meta: ["4月10日（月）", "本社5階 会議室A"],
      rows: [
        { left: "9:00", right: "あいさつ" },
        { left: "9:30", right: "会社の歴史" },
        { left: "11:00", right: "ビジネスマナー" },
        { left: "13:00", right: "パソコン研修" },
        { left: "15:00", right: "質問の時間" },
      ],
      notes: ["※昼食は含まれません。"],
    },
    callerIntro: L("もしもし、新入{しんにゅう}社員{しゃいん}の田中{たなか}です。研修{けんしゅう}について聞{き}きたいことがあります。"),
    questions: [q("研修{けんしゅう}は何時{なんじ}に始{はじ}まりますか。", ANS15), q("昼食{ちゅうしょく}は出{で}ると聞{き}きましたが、本当{ほんとう}ですか。", ANS15), q("午後{ごご}の研修{けんしゅう}を全部{ぜんぶ}教{おし}えてもらえますか。", ANS30)],
  };
}
function validOpinion() {
  return {
    kind: "agree",
    question: L("会社{かいしゃ}は社員{しゃいん}の在宅{ざいたく}勤務{きんむ}を認{みと}めるべきだという意見{いけん}に賛成{さんせい}ですか。理由{りゆう}と例{れい}を挙{あ}げて答{こた}えてください。"),
    sampleAnswer: L(ANS60),
    outlineKo: ["입장: 찬성", "이유 1: 통근 시간", "예시: 아침 공부", "마무리"],
    tipKo: "입장을 처음에 말하세요",
  };
}

const zodOk = (part: keyof typeof JA_SPEAKING_ZOD, v: unknown) => JA_SPEAKING_ZOD[part].safeParse(v).success;

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export function runJaSpeakingChecks(): { results: JaSpeakingCheckResult[]; specSyncOutcomes: SpecSyncOutcome[] } {
  const results: JaSpeakingCheckResult[] = [];
  const push = (book: string, check: string, pass: boolean, detail = pass ? "OK" : "불일치") => results.push({ book, check, pass, detail });

  // ── spec-sync ──
  const outcomes = checkSpecSync(SPEC_URL, JA_SPEAKING_SPEC_SYNC_TARGETS);
  for (const o of outcomes) push("말하기 ↔ 스펙", `${o.constName}이 japanese.md §15 원문 그대로`, o.ok, o.summary);

  // ── JSON Schema 의미 동치 + strict 모양 ──
  {
    const book = "말하기 ↔ 스펙";
    const parsed = new Map<string, unknown>();
    try {
      for (const b of extractSpecBlocks(SPEC_URL)) {
        try {
          const j = JSON.parse(b.text) as { name?: unknown };
          if (j && typeof j === "object" && typeof j.name === "string") parsed.set(j.name, j);
        } catch {
          // JSON 아닌 블록
        }
      }
    } catch (e) {
      push(book, "스펙 파싱", false, String(e));
    }
    const all = [...JA_SPEAKING_PARTS.map((p) => JA_SPEAKING_JSON_SCHEMAS[p]), JA_SPEAKING_FEEDBACK_JSON_SCHEMA];
    all.forEach((s, i) => {
      const spec = parsed.get(s.name);
      const mine = i === 0 ? s : withDefsPlaceholder(s);
      push(book, `${s.name} JSON Schema ↔ §15 의미 동치`, spec !== undefined && deepEqual(spec, mine), spec === undefined ? "스펙 블록 없음" : deepEqual(spec, mine) ? "의미 일치" : "스펙과 다름");
      const issues = strictShapeIssues(s.schema);
      push(book, `${s.name} strict 모양(additionalProperties·required·개수 제약 없음)`, issues.length === 0, issues.join("; ") || "OK");
      push(book, `${s.name} $defs가 공유 객체와 같다`, deepEqual((s.schema as { $defs?: unknown }).$defs, JA_SPEAKING_JSON_DEFS));
    });
  }

  // ── 형식·지시문·멘트 ──
  {
    const book = "말하기 형식";
    const all = jaSpeakingQuestionsForParts(JA_SPEAKING_PARTS);
    push(book, "문항 목록이 토익 형식표와 같다(11문항)", deepEqual(all, toeicQuestionsForParts(JA_SPEAKING_PARTS)) && all.length === 11);
    push(book, "파트 하나 문항(info → 8,9,10)", deepEqual(jaSpeakingQuestionsForParts(["info"]), [8, 9, 10]));
    const d = JA_SPEAKING_PART_DIRECTIONS;
    push(book, "지시문 숫자가 형식표에서 — read 45초·45초", d.read.ja.includes("45秒で目を通して") && d.read.ja.includes("45秒で声に出して") && d.read.ko.includes("45초"));
    push(book, "지시문 숫자 — info 표 읽기 45초·Q10 2회", d.info.ja.includes("45秒で表を見て") && d.info.ja.includes("2回聞こえます") && d.info.ko.includes("2번"));
    push(book, "지시문 숫자 — respond 3초·15초·30초", d.respond.ja.includes("3秒で準備") && d.respond.ja.includes("15秒ずつ") && d.respond.ja.includes("30秒で答えて"));
    push(book, "지시문 ja에 한글 없음·ko에 한글 있음", JA_SPEAKING_PARTS.every((p) => !/[가-힣]/.test(d[p].ja) && /[가-힣]/.test(d[p].ko)));
    push(book, "사진 1장 지시문은 한 장 문장, 2장이면 같은 객체", jaSpeakingPartDirections("picture", 1).ja.includes("1枚") && jaSpeakingPartDirections("picture", 2) === d.picture);
    push(book, "멘트 — prep·reading은 準備", jaSpeakingPhaseCue({ phase: "prep", q: 3, play: 0 }) === JA_SPEAKING_CUE_PREPARE && jaSpeakingPhaseCue({ phase: "reading", q: 8, play: 0 }) === JA_SPEAKING_CUE_PREPARE);
    push(book, "멘트 — beep은 파트별 답변 멘트", jaSpeakingPhaseCue({ phase: "beep", q: 1, play: 0 }) === JA_SPEAKING_ANSWER_CUE.read && jaSpeakingPhaseCue({ phase: "beep", q: 11, play: 0 }) === JA_SPEAKING_ANSWER_CUE.opinion);
    push(book, "멘트 — Q10 두 번째 재생만 もう一度", jaSpeakingPhaseCue({ phase: "question", q: 10, play: 1 }) === JA_SPEAKING_CUE_LISTEN_AGAIN && jaSpeakingPhaseCue({ phase: "question", q: 10, play: 0 }) === null);
    const cues = jaSpeakingCueTexts(all);
    push(book, "미리 받기 멘트 수 = 토익과 같은 자리 수(5)", cues.length === 5 && cues.length === toeicCueTexts(all).length, `${cues.length}`);
    const parts = { respond: validRespond(), info: validInfo(), opinion: validOpinion() } as unknown as Parameters<typeof jaSpeakingQuestionPieces>[0];
    push(book, "질문 조각 — Q5 첫 재생은 소개 + 질문", jaSpeakingQuestionPieces(parts, 5, 0).length === 2 && jaSpeakingQuestionPieces(parts, 6, 0).length === 1);
    push(book, "질문 조각 — Q8 첫 재생은 도입 + 질문, Q10 두 번째 재생은 질문만", jaSpeakingQuestionPieces(parts, 8, 0).length === 2 && jaSpeakingQuestionPieces(parts, 10, 1).length === 1);
    push(book, "질문 조각 — Q1–4는 빈 배열, Q11은 질문", jaSpeakingQuestionPieces(parts, 1, 0).length === 0 && jaSpeakingQuestionPieces(parts, 4, 0).length === 0 && jaSpeakingQuestionPieces(parts, 11, 0).length === 1);
    push(book, "질문 조각 — 파트가 없으면 빈 배열", jaSpeakingQuestionPieces({ respond: null, info: null, opinion: null }, 5, 0).length === 0);
    push(book, "형식표 파트 키 = 토익 파트 키", deepEqual([...new Set(TOEIC_MOCK_FORMAT.map((f) => f.part))], [...JA_SPEAKING_PARTS]));
  }

  // ── 길이 계산·사용자 메시지 ──
  {
    const book = "말하기 길이·메시지";
    push(book, "N4 15초 → 23~42자", deepEqual(jaSpeakingAnswerRange("N4", 15), [23, 42]), String(jaSpeakingAnswerRange("N4", 15)));
    push(book, "N4 60초 → 90~168자", deepEqual(jaSpeakingAnswerRange("N4", 60), [90, 168]));
    push(book, "N5 지문 → 72~122자, N1 지문 → 144~203자", deepEqual(jaSpeakingPassageRange("N5"), [72, 122]) && deepEqual(jaSpeakingPassageRange("N1"), [144, 203]));
    push(book, "zod 폭 15초 12~90 · 60초 48~360", deepEqual(jaSpeakingZodAnswerBand(15), [12, 90]) && deepEqual(jaSpeakingZodAnswerBand(60), [48, 360]));
    const levels = ["N5", "N4", "N3", "N2", "N1"] as const;
    const insideZod = levels.every((lv) =>
      [15, 30, 60].every((s) => {
        const [a, b] = jaSpeakingAnswerRange(lv, s);
        const [za, zb] = jaSpeakingZodAnswerBand(s);
        return a >= za && b <= zb;
      }),
    );
    push(book, "모든 레벨·초의 안내 범위가 zod 폭 안", insideZod);
    push(book, "글자 수 — 공백·문장부호 제외, ー 포함", countJaSpeechChars("コーヒー、ください。 3杯") === 10, String(countJaSpeechChars("コーヒー、ください。 3杯")));
    const msg = buildJaSpeakingMockUserMessage({ part: "respond", level: "N4", topicHints: [] });
    push(book, "E 사용자 메시지 — 주제 없음·길이 두 줄", msg === "레벨: N4\n주제 힌트: 없음\n길이:\n- 질문 1·2 모범답변(15초): 23~42자\n- 질문 3 모범답변(30초): 45~84자", JSON.stringify(msg));
    const msg2 = buildJaSpeakingMockUserMessage({ part: "read", level: "N5", topicHints: [" 여행 ", "여행", "음식", "", "쇼핑", "운동"] });
    push(book, "E 사용자 메시지 — 주제 정리(중복·빈 값·상한 3)·지문 길이", msg2 === "레벨: N5\n주제 힌트: 여행, 음식, 쇼핑\n길이:\n- 지문: 72~122자", JSON.stringify(msg2));
    push(book, "주제 정리 단독", deepEqual(normalizeJaSpeakingTopicHints(["  a  b ", "a b"]), ["a b"]));
    push(book, "주제 힌트 하나는 30자로 자른다", normalizeJaSpeakingTopicHints(["가".repeat(500)])[0]?.length === 30);
    push(book, "길이 줄 — opinion 60초", jaSpeakingLengthLines("opinion", "N3") === "- 모범답변(60초): 108~192자", jaSpeakingLengthLines("opinion", "N3"));
    let threw = false;
    try {
      fillJaSpeakingTemplate("A {x}", { "{y}": "1" });
    } catch {
      threw = true;
    }
    push(book, "템플릿에 없는 자리는 throw", threw);
    push(book, "치환은 한 번에 — 값 안의 자리 모양 글자를 다시 치환하지 않는다", fillJaSpeakingTemplate("{a}{b}", { "{a}": "{b}", "{b}": "x" }) === "{b}x");
    const fmsg = buildJaSpeakingFeedbackUserMessage({ q: 11, level: "N3", material: "질문: X", sampleAnswer: "S", transcript: "T" });
    push(book, "F 사용자 메시지 — 형식표 숫자(Q11 60초 만점 5)", fmsg.startsWith("문항: Q11 (의견 말하기) · 답변 시간 60초 · 만점 5\n문항의 레벨: N3\n수험자가 본 자료:\n질문: X\n"), JSON.stringify(fmsg.slice(0, 60)));
    push(book, "시스템 프롬프트 조립 = 머리말 + 빈 줄 + 과제", buildJaSpeakingSystemPrompt("info") === `${JA_SPEAKING_MOCK_COMMON}\n\n${JA_SPEAKING_INFO_TASK}`);
    push(book, "로그 라벨 ja_speaking_<part>", jaSpeakingCallLabel("picture") === "ja_speaking_picture");
    push(book, "사진 프롬프트 = trim + 공백 + 접미사", buildJaSpeakingImagePrompt("  A park.  ") === `A park. ${JA_SPEAKING_IMAGE_PROMPT_SUFFIX}`);
    push(book, "프롬프트에 토익 출제 모델 env를 쓰지 않는다(메인 모델)", jaSpeakingCallOptionsSentence("mock").includes("resolveModel()") && jaSpeakingCallOptionsSentence("feedback").includes("resolveModel()"));
  }

  // ── zod (호출 E) ──
  {
    const book = "말하기 zod(E)";
    push(book, "E1 통과 픽스처", zodOk("read", validRead()));
    push(book, "E2 통과 픽스처", zodOk("picture", validPicture()));
    push(book, "E3 통과 픽스처", zodOk("respond", validRespond()));
    push(book, "E4 통과 픽스처", zodOk("info", validInfo()));
    push(book, "E5 통과 픽스처", zodOk("opinion", validOpinion()));
    const r1 = validRead();
    r1.items[1].kind = "announcement";
    push(book, "E1 kind 같음 → 거부", !zodOk("read", r1));
    const r2 = validRead();
    r2.items.pop();
    push(book, "E1 지문 1개 → 거부", !zodOk("read", r2));
    const r3 = validRead();
    r3.items[0].passage = { ...r3.items[0].passage, tokens: [{ surface: "皆様", reading: "みなさま" }] };
    push(book, "토큰 무결성 깨짐 → 거부", !zodOk("read", r3));
    const r4 = validRead();
    const pa = L(PASSAGE_A).ja;
    r4.items[0].passage = { ja: pa, tokens: [{ surface: pa, reading: "みなさま" }], ko: "뜻" };
    push(book, "reading을 단 한자+가나 토큰 → 거부", !zodOk("read", r4));
    const r5 = validRead();
    r5.items[0].passage = L(PASSAGE_A + "한글");
    push(book, "일본어 칸에 한글 → 거부", !zodOk("read", r5));
    const r6 = validRead();
    r6.items[0].passage = L(PASSAGE_A, "Japanese only");
    push(book, "ko에 한글 없음 → 거부", !zodOk("read", r6));
    const r7 = validRead();
    r7.items[0].passage = L("短{みじか}い文{ぶん}です。");
    push(book, "지문 글자 수 폭 밖(짧음) → 거부", !zodOk("read", r7));
    const p1 = validPicture();
    p1.items[1].place = " 편의점 ";
    push(book, "E2 place 같음(공백 무시) → 거부", !zodOk("picture", p1));
    const p2 = validPicture();
    p2.items[0].imagePrompt = "편의점 사진";
    push(book, "E2 imagePrompt 한글 → 거부", !zodOk("picture", p2));
    const p3 = validPicture();
    p3.items[0].sampleAnswer = L("店{みせ}です。");
    push(book, "E2 모범답변 30초 폭 밖 → 거부", !zodOk("picture", p3));
    const s1 = validRespond();
    s1.questions.pop();
    push(book, "E3 질문 2개 → 거부", !zodOk("respond", s1));
    const s2 = validRespond();
    s2.questions[0].question = L("運動{うんどう}について話{はな}してください。");
    push(book, "E3 질문 끝맺음(か/？ 아님) → 거부", !zodOk("respond", s2));
    const s3 = validRespond();
    s3.questions[2].sampleAnswer = L("週{しゅう}に2回{かい}です。");
    push(book, "E3 Q7 모범답변 30초 폭 밖 → 거부", !zodOk("respond", s3));
    push(book, "질문 끝맺음 판정 — か。·？·?", isJaQuestionEnding("行きますか。") && isJaQuestionEnding("本当？") && isJaQuestionEnding("いいですか?") && !isJaQuestionEnding("教えてください。"));
    const i1 = validInfo();
    i1.table.rows[0].right = "인사";
    push(book, "E4 표 칸 한글 → 거부", !zodOk("info", i1));
    const i2 = validInfo();
    i2.table.rows[0].left = "9:00";
    push(book, "E4 표 칸 시각(일본 문자 없음) → 통과", zodOk("info", i2));
    const i3 = validInfo();
    i3.table.rows = i3.table.rows.slice(0, 3);
    push(book, "E4 rows 3개 → 거부", !zodOk("info", i3));
    const o1 = validOpinion();
    o1.outlineKo = ["입장"];
    push(book, "E5 outlineKo 1개 → 거부", !zodOk("opinion", o1));
    const o2 = validOpinion();
    o2.sampleAnswer = L(ANS15);
    push(book, "E5 모범답변 60초 폭 밖 → 거부", !zodOk("opinion", o2));
    // 말하기 토큰 규칙(§15-3-9 — QA speaking-ai 1 P2-A): 한자가 든 토큰은 한자만 + reading 필수
    const k1 = validRead();
    k1.items[0].passage = L1(L(PASSAGE_A).ja);
    push(book, "지문 통째 한 토큰(reading null) → 거부", !zodOk("read", k1));
    const k2 = validRead();
    k2.items[0].passage = { ...k2.items[0].passage, tokens: k2.items[0].passage.tokens.map((t) => (t.surface === "本日" ? { surface: "本日", reading: null } : t)) };
    push(book, "한자 토큰 reading null → 거부", !zodOk("read", k2));
    const k3 = validRead();
    {
      const ts = k3.items[0].passage.tokens;
      const at = ts.findIndex((t) => t.surface === "2");
      const merged = [...ts.slice(0, at), { surface: "2時", reading: null }, ...ts.slice(at + 2)];
      k3.items[0].passage = { ...k3.items[0].passage, tokens: merged };
    }
    push(book, "3時처럼 숫자+한자 한 토큰 → 거부", k3.items[0].passage.tokens.some((t) => t.surface === "2時") && !zodOk("read", k3));
    const k4 = validOpinion();
    k4.sampleAnswer = L1(L(ANS60).ja);
    push(book, "모범답변도 같은 규칙(통째 한 토큰 → 거부)", !zodOk("opinion", k4));
    push(book, "통과 픽스처는 한자 토큰마다 reading이 있다", L(PASSAGE_A).tokens.every((t) => !/[一-鿿]/.test(t.surface) || t.reading !== null));
    push(book, "단어장 공용 jaTokenSchema는 그대로(한자 토큰 reading null 통과)", jaTokenSchema.safeParse({ surface: "本日", reading: null }).success);
    const pic = toJaSpeakingRecordPart("picture", JA_SPEAKING_ZOD.picture.parse(validPicture()));
    push(book, "후처리 — E2 image pending", pic.items.every((it) => it.image.status === "pending" && it.image.imageId === null));
    const rd = validRead() as unknown as JaSpeakingPartRecordMap["read"];
    push(book, "후처리 — E1은 그대로", toJaSpeakingRecordPart("read", rd) === rd);
  }

  // ── zod (호출 F) ──
  {
    const book = "말하기 zod(F)";
    const transcript = "えっと、毎週土曜日に友達とテニスをします。楽しいです。";
    const base = {
      score: 2,
      levelEstimate: "N4",
      levelReasonKo: "〜ます형을 정확히 썼다",
      summaryKo: "질문에 맞게 답했어요.",
      strengths: ["직답을 먼저 했어요"],
      fixes: [{ said: "毎週土曜日に友達と", better: "毎週土曜日に友達とテニスをしています。", whyKo: "습관은 〜ています가 자연스러워요" }],
      missingKo: [],
      improvedAnswer: L("毎週{まいしゅう}土曜日{どようび}に友達{ともだち}とテニスをしています。とても楽{たの}しいです。", "매주 토요일에 친구와 테니스를 칩니다."),
    };
    const z5 = buildJaSpeakingFeedbackZod({ q: 5, transcript });
    push(book, "F 통과 픽스처", z5.safeParse(base).success);
    push(book, "said 문장부호·공백만 다름 → 통과", z5.safeParse({ ...base, fixes: [{ ...base.fixes[0], said: "毎週 土曜日に、友達と" }] }).success);
    push(book, "said가 전사문 밖 → 거부", !z5.safeParse({ ...base, fixes: [{ ...base.fixes[0], said: "毎週日曜日に" }] }).success);
    push(book, "said 2글자 미만 → 거부", !z5.safeParse({ ...base, fixes: [{ ...base.fixes[0], said: "楽" }] }).success);
    push(book, "Q5 4점 → 거부", !z5.safeParse({ ...base, score: 4 }).success);
    push(book, "Q11 5점 → 통과", buildJaSpeakingFeedbackZod({ q: 11, transcript }).safeParse({ ...base, score: 5 }).success);
    push(book, "Q11 6점 → 거부", !buildJaSpeakingFeedbackZod({ q: 11, transcript }).safeParse({ ...base, score: 6 }).success);
    push(book, "levelEstimate 모르는 값 → 거부", !z5.safeParse({ ...base, levelEstimate: "N6" }).success);
    push(book, "better 한글 → 거부", !z5.safeParse({ ...base, fixes: [{ ...base.fixes[0], better: "테니스를 칩니다" }] }).success);
    push(book, "improvedAnswer 통째 한 토큰 → 거부", !z5.safeParse({ ...base, improvedAnswer: L1(base.improvedAnswer.ja, "뜻") }).success);
    push(book, "improvedAnswer 무결성 깨짐 → 거부", !z5.safeParse({ ...base, improvedAnswer: { ...base.improvedAnswer, tokens: [{ surface: "毎週", reading: "まいしゅう" }] } }).success);
    push(book, "strengths 0개 → 거부", !z5.safeParse({ ...base, strengths: [] }).success);
    push(book, "said 대조 단독 — 카나 종류는 바꾸지 않는다", !isSaidInJaTranscript("テニス", "てにすをします"));
  }

  // ── 피드백 자료 ──
  {
    const book = "말하기 피드백 자료";
    const parts: JaSpeakingParts = {
      read: validRead() as unknown as JaSpeakingPartRecordMap["read"],
      picture: toJaSpeakingRecordPart("picture", JA_SPEAKING_ZOD.picture.parse(validPicture())),
      respond: validRespond() as unknown as JaSpeakingPartRecordMap["respond"],
      info: validInfo() as unknown as JaSpeakingPartRecordMap["info"],
      opinion: validOpinion() as unknown as JaSpeakingPartRecordMap["opinion"],
    };
    push(book, "Q1–2 자료 null", buildJaSpeakingFeedbackMaterial(parts, 1) === null && buildJaSpeakingFeedbackInput({ level: "N4", parts }, 2, "x") === null);
    const m3 = buildJaSpeakingFeedbackMaterial(parts, 3) ?? "";
    push(book, "Q3 자료 서식", m3.startsWith("사진 설명: 저녁의 편의점 장면이다.\n묘사 포인트:\n- 계산하는 여자"), JSON.stringify(m3.slice(0, 40)));
    const m6 = buildJaSpeakingFeedbackMaterial(parts, 6) ?? "";
    push(book, "Q6 자료 = 상황 + 둘째 질문", m6 === `상황: ${parts.respond!.intro.ja}\n질문: ${parts.respond!.questions[1].question.ja}`);
    const m9 = buildJaSpeakingFeedbackMaterial(parts, 9) ?? "";
    push(book, "Q9 자료 = 표 + 도입 + 질문", m9.startsWith("표: 新入社員研修\n4月10日（月）\n本社5階 会議室A\n9:00 — あいさつ") && m9.endsWith(`전화 건 사람: ${parts.info!.callerIntro.ja}\n질문: ${parts.info!.questions[1].question.ja}`));
    push(book, "Q11 자료 = 질문", buildJaSpeakingFeedbackMaterial(parts, 11) === `질문: ${parts.opinion!.question.ja}`);
    const inp = buildJaSpeakingFeedbackInput({ level: "N3", parts }, 7, "とても");
    push(book, "입력 — 레벨·모범답변 ja·전사문", inp !== null && inp.level === "N3" && inp.sampleAnswer === parts.respond!.questions[2].sampleAnswer.ja && inp.transcript === "とても");
    push(book, "파트가 없으면 입력 null", buildJaSpeakingFeedbackInput({ level: "N3", parts: { ...parts, info: null } }, 8, "x") === null);
  }

  // ── Q1–2 대조 ──
  {
    const book = "말하기 Q1–2 대조";
    const T = (surface: string, reading: string | null = null): JaReadToken => ({ surface, reading });
    const toks = [T("今日", "きょう"), T("は"), T("3"), T("時", "じ"), T("に"), T("会議", "かいぎ"), T("が"), T("あります"), T("。")];
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    const same = alignJaReadAloud(toks, "今日は3時に会議があります。");
    push(book, "그대로 읽음 = 1.0", near(same.accuracy, 1) && same.missing.length === 0 && same.substituted.length === 0 && same.extra.length === 0);
    push(book, "한자어를 가나로 적은 전사 = 1.0", near(alignJaReadAloud(toks, "きょうは3時にかいぎがあります").accuracy, 1));
    push(book, "가타카나·전각 숫자 = 1.0", near(alignJaReadAloud(toks, "キョウハ３時ニ会議ガアリマス").accuracy, 1));
    const miss = alignJaReadAloud(toks, "今日は3時にがあります。");
    push(book, "토큰 빠짐 → missing·정확도 1−2/13", deepEqual(miss.missing, ["会議"]) && near(miss.accuracy, 1 - 2 / 13), JSON.stringify(miss));
    const sub = alignJaReadAloud(toks, "今日は3時に開議があります。");
    push(book, "다른 한자 → substituted", deepEqual(sub.substituted, [{ expected: "会議", heard: "開議" }]) && near(sub.accuracy, 1 - 1 / 13), JSON.stringify(sub));
    const ext = alignJaReadAloud(toks, "えーと今日は3時に会議があります");
    push(book, "군말 → extra, 정확도 불변", deepEqual(ext.extra, ["えーと"]) && near(ext.accuracy, 1), JSON.stringify(ext));
    const empty = alignJaReadAloud(toks, "");
    push(book, "빈 전사 = 0, 전부 missing", empty.accuracy === 0 && empty.missing.length === 8);
    const kanaPassage = [T("わたし"), T("は"), T("学生", "がくせい"), T("です")];
    push(book, "한계 잠금 — 지문 가나 ↔ 전사 한자는 틀림으로 센다", alignJaReadAloud(kanaPassage, "私は学生です").substituted.length === 1);
    push(book, "한계 잠금 — 숫자 3 ↔ 三은 틀림으로 센다", alignJaReadAloud(toks, "今日は三時に会議があります").substituted.some((s) => s.expected === "3"));
    push(book, "정규화 — 문장부호·공백 제거·카타카나→히라가나", normalizeJaReadChars("テスト、 です！").join("") === "てすとです");
    push(book, "참고 점수 문턱 0.95/0.85/0.6", jaReadProxyScore(0.95) === 3 && jaReadProxyScore(0.949) === 2 && jaReadProxyScore(0.85) === 2 && jaReadProxyScore(0.6) === 1 && jaReadProxyScore(0.59) === 0 && jaReadProxyScore(Number.NaN) === 0);
    const long = alignJaReadAloud(toks, "今日は3時に会議があります" + "あ".repeat(20000));
    push(book, "격자 상한 — 긴 반복 전사도 정확도 1.0, 덧붙음은 잘린 만큼만", near(long.accuracy, 1) && long.extra.join("").length <= 60, String(long.extra.join("").length));
    push(book, "무응답 — 4글자 미만", isJaNoResponseTranscript("はい。") && isJaNoResponseTranscript(null) && !isJaNoResponseTranscript("はい、そうです"));
  }

  // ── 추정 수준·달성도 ──
  {
    const book = "말하기 추정 수준";
    const est = (xs: (string | null)[]) => estimateJaSpeakingLevel(xs.map((levelEstimate) => ({ levelEstimate })));
    push(book, "아래쪽 중앙값(짝수 → 낮은 쪽)", est(["N3", "N4", "N2", "N5"])?.level === "N4");
    push(book, "홀수 중앙값", est(["N3", "N1", "N5"])?.level === "N3");
    push(book, "유효 3 미만 → null(모르는 값·null 무시)", est(["N3", "N9", null]) === null);
    push(book, "below_n5가 가장 낮다", est(["below_n5", "below_n5", "N5"])?.level === "below_n5");
    const qs = jaSpeakingQuestionsForParts(JA_SPEAKING_PARTS);
    const full = qs.map((q) => ({ q, score: q === 11 ? 4 : 3 }));
    const a1 = jaSpeakingAchievement(qs, full);
    push(book, "달성도 — 전부 채점 34/35 reached", a1.ok && a1.raw === 34 && a1.max === 35 && a1.band === "reached");
    const a2 = jaSpeakingAchievement(qs, full.slice(0, 10));
    push(book, "달성도 — 하나 빠지면 ok:false + 채점 수", !a2.ok && a2.scoredCount === 10 && a2.total === 11);
    const a3 = jaSpeakingAchievement(qs, full.map((a) => (a.q === 3 ? { q: 3, score: 4 } : a)));
    push(book, "달성도 — 만점 밖 점수는 채점 안 된 것", !a3.ok);
    const a4 = jaSpeakingAchievement([3, 4], [{ q: 3, score: 2 }, { q: 4, score: 2 }]);
    push(book, "달성도 — 4/6 = near", a4.ok && a4.band === "near");
    const a5 = jaSpeakingAchievement([3, 4], [{ q: 3, score: 1 }, { q: 4, score: 2 }, { q: 99, score: 3 }]);
    push(book, "달성도 — 3/6 = below, 범위 밖 무시", a5.ok && a5.band === "below");
  }

  // ── 번들 경계 ──
  {
    const book = "말하기 번들 경계";
    for (const f of ["lib/ja-speaking.ts", "lib/ja-speaking-score.ts"]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf-8");
      const valueImports = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
      const bad = valueImports.filter((p) => p !== "./toeic-mock");
      push(book, `${f} 런타임 import는 ./toeic-mock뿐`, bad.length === 0, bad.join(", ") || "OK");
      push(book, `${f} 정규식 lookbehind 없음`, !/\(\?<[=!]/.test(src));
    }
  }

  // ── 앱 층(JS1~JS3 — 저장·라우트·응시 화면 재사용·채점) — 조각 파일 scripts/eval-japanese-speaking-app.ts ──
  results.push(...runJaSpeakingAppChecks());

  return { results, specSyncOutcomes: outcomes };
}
