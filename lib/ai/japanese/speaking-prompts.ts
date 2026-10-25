/**
 * lib/ai/japanese/speaking-prompts.ts — 말하기 모의고사 호출 E(문항 생성 E1~E5)·F(답변 피드백) 프롬프트 + 사용자 메시지 + 호출 옵션
 * + 관문 P 일본 배경 사진 접미사 (docs/harness/japanese.md §15-3·§15-4·§15-7)
 *
 * ── 학습자가 아빠다 (§0-1) ────────────────────────────────────────────────────
 * 성인 JLPT 학습자 기준. 영어(은우) 프롬프트의 "쉬운 말" 문구를 쓰지 않는다. 토익 프롬프트는 영어 시험용이라 재사용하지 않고
 * 형식만 일본어로 옮긴 새 원문이다(문장은 새로 썼다).
 *
 * ── spec-sync ─────────────────────────────────────────────────────────────────
 * 시스템 프롬프트 7개(머리말 1 + 파트 5 + 피드백 1)·사용자 메시지 템플릿 2개·사진 접미사 1개는 japanese.md §15 코드블록과
 * 바이트 단위로 같아야 한다(scripts/eval-japanese-speaking.ts의 대조 대상). 호출 옵션 문장도 스펙 산문과 대조된다.
 * 문구를 고치면 스펙도 같이 고친다.
 *
 * 모델: 메인 `resolveModel()`(env OPENAI_MODEL, 빈 값이면 gpt-6-luna) — 토익 출제·채점 모델(OPENAI_TOEIC_MODEL)을 쓰지 않는다
 * (2026-10-02 사용자 규칙: "토익 출제·채점만 sol, 나머지는 luna").
 */

import type { JlptLevel } from "./schemas";
import { JA_SPEAKING_LIMITS } from "./speaking-schemas";
import { JA_SPEAKING_PART_NAME_KO, jaSpeakingLengthLines, jaSpeakingQuestionFormat, type JaSpeakingPart } from "../../ja-speaking";

/** 호출 E 공통 머리말(§15-3-1) */
export const JA_SPEAKING_MOCK_COMMON = `너는 일본어 말하기 시험 문항 출제자다. 한국인 성인 학습자가 고른 JLPT 레벨(N5~N1)에 맞춰 실전처럼 연습할 말하기 모의 문항을 새로 만든다. 형식은 TOEIC Speaking 11문항(지문 읽기·사진 묘사·듣고 답하기·정보 활용·의견 말하기)을 일본어로 옮긴 것이다.

[공통 규칙]
- 실제 시험 문항이나 교재 문장을 베끼거나 옮기지 않는다. 소재와 문장은 새로 쓴다.
- 학습자는 성인이다 — 아이 눈높이로 낮추지 않는다. 일본어는 받은 레벨의 어휘와 문형으로 쓴다. 그 레벨보다 어려운 어휘·문형을 쓰지 않고, 그 레벨에서 익혀야 할 어휘·문형을 피하지도 않는다.
- 일본어는 일본에서 실제로 쓰는 자연스러운 표준어로 쓴다. 정중체(です・ます)를 기본으로 하고, 지인과의 대화 상황은 그 관계에 맞는 말투로 쓴다.
- 표기는 일반적인 일본어 표기를 따른다 — 보통 한자로 쓰는 말은 레벨이 낮아도 한자로 쓰고(읽기는 후리가나로 돕는다), 보통 가나로 쓰는 말은 가나로 쓴다. 숫자는 아라비아 숫자로 쓴다.
- 회사·사람·가게 이름은 지어낸 것을 쓴다(실존 기업이나 유명인을 쓰지 않는다). 일본의 실제 도시 이름은 써도 된다.
- ko는 그 일본어의 자연스러운 한국어 뜻이다. 한국어 설명은 짧고 실용적으로 쓴다.
- 모범답변은 받은 레벨의 학습자가 제한 시간 안에 실제로 말할 수 있는 길이와 수준으로 쓴다. 길이는 사용자 메시지의 '길이'(공백·문장부호를 뺀 글자 수)를 따른다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.

[후리가나]
- 일본어 문장(ja)마다 후리가나 토큰 배열(tokens)을 함께 낸다. 각 토큰은 surface와 reading을 갖고, surface를 순서대로 이어 붙이면 ja와 정확히 같아야 한다.
- reading은 surface가 한자만으로 이뤄진 토큰에만 히라가나로 채운다. 가나·숫자·기호가 섞인 토큰은 null로 둔다.
- 한자가 들어간 토큰은 한자만으로 이뤄져야 하고 reading을 반드시 단다 — 한자에 읽기를 빼먹거나 문장을 통째로 한 토큰으로 내지 않는다.
- 한자가 연달아 붙어 한 낱말을 이루면 한 토큰으로 묶고 읽기를 한 번에 단다(예: 会議 → 会議(かいぎ)). 오쿠리가나와 활용 어미, 한자에 붙은 숫자는 한자 토큰과 분리하고 그 토큰의 reading은 null로 둔다(예: 食べる → 食(た) + べる, 3時 → 3 + 時(じ)).
- 읽기는 그 문맥에서 실제로 읽는 소리로 단다(예: 今日 → きょう, 一人 → ひとり).`;

/** E1 read — Q1–2 지문 읽기(§15-3-2) */
export const JA_SPEAKING_READ_TASK = `[과제: Q1–2 지문 읽기]
- 소리 내어 읽을 지문 정확히 2개를 만든다. 두 지문은 종류(kind)가 달라야 한다 — advertisement(광고), announcement(안내 방송), news(뉴스·소식), introduction(행사·인물 소개), tour(투어 안내), voicemail(자동 응답 메시지) 중에서 고른다.
- 지문 길이는 사용자 메시지의 '길이'를 따르고, 문장 3~6개로 쓴다. 고유명사 1개 이상, 숫자·시각·가격 중 하나 이상을 넣는다.
- passage: 지문(ja·tokens·ko).
- tipsKo: 이 지문을 소리 내어 읽을 때 주의할 점 2~4개(한국어). 장음·촉음·발음(ん), 읽기가 까다로운 한자어, 숫자와 조수사 읽기, 끊어 읽을 곳 같은 것을 짚는다.
- 지문 읽기에는 모범답변을 쓰지 않는다.`;

/** E2 picture — Q3–4 사진 묘사(§15-3-3) */
export const JA_SPEAKING_PICTURE_TASK = `[과제: Q3–4 사진 묘사]
- 묘사할 사진 장면 정확히 2개를 설계한다. 두 장면 모두 일본의 일상 장소이고 장소(place)가 서로 달라야 한다(역 개찰구, 편의점, 공원, 상점가, 식당, 카페, 사무실, 회의실, 공항, 신사 경내, 강변 등). 주제 힌트를 받으면 그와 어울리는 장소를 먼저 고른다.
- 장면마다 성인이 2~5명 있고, 사람마다 동작과 옷차림이 분명하며, 배경과 주변 사물이 3개 이상 있다. 30초 동안 장소·인물·사물·느낌을 말할 거리가 충분해야 한다.
- place: 장소 이름(한국어, 짧게).
- imagePrompt: 이 장면을 사진으로 생성하기 위한 영어 프롬프트(60~120단어). 일본의 장소임이 드러나게 쓰고, 사람 수와 위치(왼쪽·가운데·오른쪽·배경), 각자의 동작과 옷 색, 주변 사물, 날씨와 빛을 구체적으로 적는다. 글자·간판 문구·로고·유명인·어린이는 넣지 않는다.
- sceneKo: 사진을 보여 줄 수 없을 때 대신 보여 줄 장면 설명(한국어 2~3문장).
- sampleAnswer: 모범답안(ja·tokens·ko). 장소 → 중심 인물의 동작(〜ています) → 주변 사람과 사물의 위치(〜に〜があります・います) → 느낌이나 추측(레벨에 맞는 말) 순서로 말한다. imagePrompt에 적은 장면과 어긋나는 내용을 말하지 않는다.
- keyPointsKo: 이 사진에서 놓치지 말아야 할 묘사 포인트 3~5개(한국어).`;

/** E3 respond — Q5–7 듣고 답하기(§15-3-4) */
export const JA_SPEAKING_RESPOND_TASK = `[과제: Q5–7 듣고 답하기]
- 상황 하나를 만든다: 일본의 조사 회사가 거는 전화 설문에 답하는 상황, 또는 일본인 지인과 전화로 이야기하는 상황이다. 주제는 일상생활(쇼핑, 음식, 여가, 여행, 교통, 주거, 운동, 공부, 일 등)에서 고르고, 주제 힌트를 받으면 그중에서 고른다.
- topicKo: 이 상황의 주제를 한국어 한두 단어로 쓴다.
- intro: 상황 소개 1~2문장(ja·tokens·ko). 수험자에게 상황을 알려 주는 말로 쓴다.
- questions: 정확히 3개. 첫째와 둘째는 빈도·시간·장소·동행 같은 사실형 질문이고, 둘 중 하나 이상은 두 가지를 함께 묻는다. 셋째는 이유를 요구하는 선택·의견·묘사형 질문이다. 세 질문은 같은 주제로 이어진다.
- 질문마다 question(ja·tokens·ko — 질문 ja는 か 또는 ？로 끝난다), sampleAnswer(ja·tokens·ko), tipKo를 쓴다. 모범답변은 직답을 먼저 한 뒤 이유나 부연을 붙이고, 질문의 시제와 말투를 따른다.
- tipKo: 이 질문에서 점수를 받는 요령 한 줄(한국어).`;

/** E4 info — Q8–10 정보 활용(§15-3-5) */
export const JA_SPEAKING_INFO_TASK = `[과제: Q8–10 제공된 정보로 답하기]
- 표 하나를 만든다. 종류(kind)는 schedule(행사·연수 일정), itinerary(출장·여행 일정), timetable(수업·강좌 시간표), interview(면접 일정), resume(이력서) 중 하나다.
- 표는 일본어로 쓴다 — 제목(title), 날짜·장소·요금 같은 머리 정보(meta, 1~4줄), 행(rows, 5~9개 — left에는 시간·기간·항목, right에는 내용), 각주(notes, 0~2줄, 예: "※昼食は含まれません。"). titleKo에는 제목의 한국어 뜻을 쓴다.
- callerIntro: 이 표에 대해 전화를 건 사람의 도입 발화 1~2문장(ja·tokens·ko — 이름과 용건).
- questions: 정확히 3개, 전화 건 사람이 묻는 질문이다. 첫째는 시간·장소·요금 같은 세부 정보, 둘째는 전화 건 사람이 잘못 알고 있는 정보를 확인하고 정정하게 하는 질문, 셋째는 조건에 맞는 항목 둘 이상을 모두 말하게 하는 질문이다. 답은 반드시 표 안에서 찾을 수 있어야 한다.
- 질문마다 question(ja·tokens·ko — 질문 ja는 か 또는 ？로 끝난다), sampleAnswer(ja·tokens·ko), tipKo를 쓴다. 모범답변은 담당자로서 표의 표기를 말하는 문장으로 바꿔 정중하게 말한다(예: 「参加費：1,000円」 → 「参加費は1,000円です。」). 셋째는 순서를 나타내는 말(まず・次に・最後に 등 레벨에 맞는 말)로 잇는다.
- tipKo: 이 질문에서 점수를 받는 요령 한 줄(한국어).`;

/** E5 opinion — Q11 의견 말하기(§15-3-6) */
export const JA_SPEAKING_OPINION_TASK = `[과제: Q11 의견 말하기]
- 의견 질문 하나를 만든다. 형식(kind)은 agree(찬반), choice(둘 중 선택), proscons(장단점) 중 하나다. 직장, 공부, 기술, 생활 방식처럼 성인이 경험으로 답할 수 있는 주제로 쓰고, 끝에 이유와 예를 들어 답하라는 요구 문장을 붙인다.
- question: 질문(ja·tokens·ko).
- sampleAnswer: 모범답안(ja·tokens·ko). 입장 → 첫째 이유와 개인 경험 예시 → 둘째 이유 → 마무리 순서다. 처음부터 끝까지 한 입장을 유지한다.
- outlineKo: 답변 뼈대(한국어) 3~5줄 — 입장, 이유 1, 예시, 이유 2, 마무리.
- tipKo: 이 질문에서 점수를 받는 요령 한 줄(한국어).`;

export const JA_SPEAKING_TASKS: Record<JaSpeakingPart, string> = {
  read: JA_SPEAKING_READ_TASK,
  picture: JA_SPEAKING_PICTURE_TASK,
  respond: JA_SPEAKING_RESPOND_TASK,
  info: JA_SPEAKING_INFO_TASK,
  opinion: JA_SPEAKING_OPINION_TASK,
};

/** 파트별 완결 시스템 프롬프트 = 머리말 + "\n\n" + 과제 절(§15-3-0) */
export function buildJaSpeakingSystemPrompt(part: JaSpeakingPart): string {
  return `${JA_SPEAKING_MOCK_COMMON}\n\n${JA_SPEAKING_TASKS[part]}`;
}

/** 호출 E 사용자 메시지 템플릿(§15-3-7) */
export const JA_SPEAKING_MOCK_USER_TEMPLATE = `레벨: {N5|N4|N3|N2|N1}
주제 힌트: {topicHints를 ", "로, 없으면 "없음"}
길이:
{jaSpeakingLengthLines(part, level)}`;

export const JA_SPEAKING_MOCK_PLACEHOLDERS = {
  level: "{N5|N4|N3|N2|N1}",
  topics: '{topicHints를 ", "로, 없으면 "없음"}',
  length: "{jaSpeakingLengthLines(part, level)}",
} as const;

/** 호출 F 시스템 프롬프트(§15-4-1) */
export const JA_SPEAKING_FEEDBACK_SYSTEM_PROMPT = `너는 일본어 말하기 시험 채점관 겸 코치다. 한국인 성인 학습자가 JLPT 레벨에 맞춘 말하기 모의 문항에 답한 전사문을 받아 점수를 매기고, 답변에 드러난 일본어 수준을 JLPT 레벨로 추정하고, 다음 답변을 더 잘하게 만드는 피드백을 한국어로 준다.

[입력]
- 문항 번호와 유형, 만점, 답변 시간, 문항의 레벨, 수험자가 본 자료(질문·표·사진 설명), 참고용 모범답변, 그리고 음성 인식으로 얻은 답변 전사문을 받는다.
- 전사문은 음성 인식 결과라 발음·억양·장단음을 알 수 없고, 인식 오류가 섞이거나 한자·가나 표기가 모범답변과 다를 수 있다. 발음과 표기는 평가하지 않는다. 인식 오류로 보이는 말은 감점하지 말고 문맥으로 해석한다.
- 모범답변은 참고용이다. 모범답변과 다르다는 이유로 감점하지 않는다.

[채점]
- 점수는 이 문항의 과제를 얼마나 해냈는가다 — 내용이 질문과 자료에 맞고 충분한가(관련성·완성도), 문법과 어휘가 정확하고 적절한가, 문장이 자연스럽게 이어지는가.
- Q3–4(0~3): 사진의 주요 특징을 묘사했는가.
- Q5–7(0~3): 질문에 맞는 완전하고 적절한 답인가.
- Q8–10(0~3): 위 기준에 더해 표의 정보를 정확히 전달했는가.
- Q11(0~5): 입장이 분명한가, 이유와 예시로 뒷받침했는가, 생각 사이의 관계가 분명한가. 이유 하나에 부연이 거의 없으면 3점 수준, 질문을 되읽거나 단어만 나열하면 1점 수준이다.
- 무응답이거나 일본어가 아니거나 과제와 무관하면 0점이다.
- 제한 시간에 비해 답이 너무 짧으면 완성도에서 깎는다.

[수준 추정]
- levelEstimate: 이 답변에 실제로 쓴 어휘·문형과 그 정확성으로 보아 어느 JLPT 레벨의 말하기에 해당하는지 하나로 고른다(N1~N5, N5에도 못 미치면 below_n5). 문항의 레벨과 상관없이 답변만 보고 정한다. JLPT에는 말하기 시험이 없으므로 이것은 추정이다.
- levelReasonKo: 그렇게 본 근거 한 줄(한국어 — 답변에 쓴 문형이나 어휘를 예로 든다).

[피드백]
- summaryKo: 총평 1~2문장(한국어).
- strengths: 잘한 점 1~3개(한국어, 구체적으로).
- fixes: 고칠 표현 0~5개. said에는 전사문에서 그대로 복사한 구간을, better에는 같은 뜻의 올바르고 자연스러운 일본어를, whyKo에는 이유 한 줄(문법·어휘·어색함·내용·말투)을 쓴다. 인식 오류로 보이는 것은 고치지 않는다.
- missingKo: 내용상 빠진 것 0~3개(한국어).
- improvedAnswer: 수험자의 답변 내용을 살려 제한 시간 안에 말할 수 있게 고쳐 쓴 더 나은 답변(ja·tokens·ko). 문항의 레벨에 맞는 어휘와 문형으로 쓰고, 모범답변을 베끼지 않는다.

[후리가나]
- improvedAnswer의 tokens는 surface를 순서대로 이어 붙이면 ja와 정확히 같아야 한다. reading은 surface가 한자만으로 이뤄진 토큰에만 히라가나로 채우고, 가나·숫자·기호가 섞인 토큰은 null로 둔다. 한자 숙어는 한 토큰으로 묶고, 오쿠리가나와 활용 어미는 분리한다. 한자가 들어간 토큰에는 reading을 반드시 단다.

[금지]
- 전사문에 없는 말을 수험자가 했다고 쓰지 않는다.
- 지정된 JSON 스키마 외의 텍스트를 내지 않는다.`;

/** 호출 F 사용자 메시지 템플릿(§15-4-2) */
export const JA_SPEAKING_FEEDBACK_USER_TEMPLATE = `문항: Q{n} ({유형 이름}) · 답변 시간 {초}초 · 만점 {3|5}
문항의 레벨: {N5|N4|N3|N2|N1}
수험자가 본 자료:
{material}
모범답변(참고용):
{sampleAnswer}
답변 전사문:
{transcript}`;

export const JA_SPEAKING_FEEDBACK_PLACEHOLDERS = {
  n: "{n}",
  typeName: "{유형 이름}",
  sec: "{초}",
  max: "{3|5}",
  level: "{N5|N4|N3|N2|N1}",
  material: "{material}",
  sampleAnswer: "{sampleAnswer}",
  transcript: "{transcript}",
} as const;

/**
 * 템플릿 자리를 **한 번에** 치환한다(값 안의 자리 모양 글자를 다시 치환하지 않고, `$` 특수 치환도 타지 않는다).
 * 템플릿에 없는 키를 넘기면 throw — 형식 드리프트를 조용히 넘기지 않는다(토익 fillTemplate과 같은 관용구, 과목 사이 import는 하지 않는다).
 */
export function fillJaSpeakingTemplate(template: string, values: Record<string, string>): string {
  const keys = Object.keys(values);
  for (const k of keys) {
    if (!template.includes(k)) throw new Error(`[ja-speaking-prompts] 템플릿에 자리가 없습니다: ${k}`);
  }
  const re = new RegExp(
    keys
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g",
  );
  return template.replace(re, (m) => values[m]);
}

/** 주제 힌트 정리 — 공백 정리·하나당 JA_SPEAKING_LIMITS.topicHintMax(30)자로 자르기·빈 값 제거·중복 제거(첫 등장)·상한 topicHintsMax(3) */
export function normalizeJaSpeakingTopicHints(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const t = Array.from(raw.replace(/\s+/g, " ").trim()).slice(0, JA_SPEAKING_LIMITS.topicHintMax).join("").trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= JA_SPEAKING_LIMITS.topicHintsMax) break;
  }
  return out;
}

/** 호출 E 사용자 메시지 */
export function buildJaSpeakingMockUserMessage(input: { part: JaSpeakingPart; level: JlptLevel; topicHints: readonly string[] }): string {
  const topics = normalizeJaSpeakingTopicHints(input.topicHints);
  return fillJaSpeakingTemplate(JA_SPEAKING_MOCK_USER_TEMPLATE, {
    [JA_SPEAKING_MOCK_PLACEHOLDERS.level]: input.level,
    [JA_SPEAKING_MOCK_PLACEHOLDERS.topics]: topics.length > 0 ? topics.join(", ") : "없음",
    [JA_SPEAKING_MOCK_PLACEHOLDERS.length]: jaSpeakingLengthLines(input.part, input.level),
  });
}

/** 호출 F 입력(speaking.ts의 buildJaSpeakingFeedbackInput이 만든다) */
export interface JaSpeakingFeedbackInput {
  q: number;
  level: JlptLevel;
  material: string;
  sampleAnswer: string;
  transcript: string;
}

/** 호출 F 사용자 메시지 — 유형 이름·답변 시간·만점은 형식표에서 읽는다(숫자를 다시 적지 않는다) */
export function buildJaSpeakingFeedbackUserMessage(input: JaSpeakingFeedbackInput): string {
  const f = jaSpeakingQuestionFormat(input.q);
  const P = JA_SPEAKING_FEEDBACK_PLACEHOLDERS;
  return fillJaSpeakingTemplate(JA_SPEAKING_FEEDBACK_USER_TEMPLATE, {
    [P.n]: String(f.q),
    [P.typeName]: JA_SPEAKING_PART_NAME_KO[f.part],
    [P.sec]: String(f.answerSec),
    [P.max]: String(f.maxScore),
    [P.level]: input.level,
    [P.material]: input.material,
    [P.sampleAnswer]: input.sampleAnswer,
    [P.transcript]: input.transcript,
  });
}

// ---------------------------------------------------------------------------
// 관문 P(일본 배경) 사진 프롬프트 접미사(§15-7) — 사진 공용 코어 lib/image-gen.ts에 넘길 완성 프롬프트
// ---------------------------------------------------------------------------

export const JA_SPEAKING_IMAGE_PROMPT_SUFFIX = `A realistic candid photograph taken in Japan for a Japanese speaking test picture-description task. Natural colors and lighting, everyday adults, clear actions. No text, no readable signs or writing, no logos, no watermarks, no children.`;

/** 사진 프롬프트 = E2 imagePrompt(앞뒤 공백 제거) + 공백 하나 + 접미사 */
export function buildJaSpeakingImagePrompt(imagePrompt: string): string {
  return `${imagePrompt.trim()} ${JA_SPEAKING_IMAGE_PROMPT_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// 호출 옵션 — 스펙 산문의 "호출 옵션:" 문장과 대조된다(jaSpeakingCallOptionsSentence)
// ---------------------------------------------------------------------------

/** 호출 E — 창작(문항)이라 0.8. 후리가나 토큰이 문장마다 붙어 토익 C(6,000)보다 넉넉히 */
export const JA_SPEAKING_MOCK_CALL_OPTIONS = { temperature: 0.8, maxOutputTokens: 10_000 } as const;
/** 호출 F — 채점이라 낮게. improvedAnswer 토큰이 붙고 기본 모델(추론 계열)의 숨은 추론 토큰도 같은 한도에 들어 6,000(QA speaking-ai 1 P3-D — 한도에 걸리면 incomplete → 재요청 → 실패로 번진다) */
export const JA_SPEAKING_FEEDBACK_CALL_OPTIONS = { call: "ja_speaking_feedback", temperature: 0.2, maxOutputTokens: 6_000 } as const;

/** 호출 E 로그 라벨 — ja_speaking_<part> */
export function jaSpeakingCallLabel(part: JaSpeakingPart): string {
  return `ja_speaking_${part}`;
}

/** 스펙 §15-3-0·§15-4-0의 호출 옵션 문장(eval이 스펙 본문에 그대로 있는지 본다) */
export function jaSpeakingCallOptionsSentence(kind: "mock" | "feedback"): string {
  if (kind === "mock") {
    const o = JA_SPEAKING_MOCK_CALL_OPTIONS;
    return `호출 옵션: temperature ${o.temperature}, maxOutputTokens ${o.maxOutputTokens}, call 라벨 \`ja_speaking_<part>\`, 모델 \`resolveModel()\``;
  }
  const o = JA_SPEAKING_FEEDBACK_CALL_OPTIONS;
  return `호출 옵션: temperature ${o.temperature}, maxOutputTokens ${o.maxOutputTokens}, call 라벨 \`${o.call}\`, 모델 \`resolveModel()\``;
}
