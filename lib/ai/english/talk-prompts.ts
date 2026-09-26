/**
 * lib/ai/english/talk-prompts.ts — 은우 자유대화 원문 상수 (docs/harness/english.md §12-1·§12-3·§12-6, SPEC §21)
 *
 * - §12-1 관문 R(실시간 음성, OpenAI Realtime): 선생님 지시문·수업 블록 2종·첫 인사·마무리 지시. 관문 R은 하네스 밖
 *   (callWithSchema를 지나지 않는다)이지만 **지시문 원문은 spec-sync 대상**이다 — 1학년 눈높이·안전 규칙이 이 문장들에 있다.
 * - §12-6 화면 카드: 지시문 덧붙임(도구 사용 안내)·말문 막힘 도움 요청·주제 일러스트 안내·사진 생성 프롬프트.
 *   도구 정의(TALK_TOOLS, JSON)는 세션 설정과 함께 서버만 쓰므로 lib/ai/english/talk-schemas.ts에 있다.
 * - §12-3 호출 I(문장 설명, 하네스 안): 시스템 프롬프트·사용자 메시지 템플릿·호출 옵션.
 *
 * 앱이 대화 중에 넣는 안내(첫 인사·마무리·도움 요청·일러스트 안내)는 전부 **숨은 system 메시지 항목**(`conversation.item.create`,
 * id 접두사 `app_` — lib/talk-transcript.ts `buildTalkSystemNoteEvent`)으로 넣는다. 응답 단위 `instructions`로 보내지 않는다 —
 * 그 값은 세션 지시문을 **덮어써** 그 응답에서 선생님 성격·안전 규칙이 빠질 수 있다(§12-1 2026-09-26 정정).
 *
 * 모든 상수는 스펙 코드블록과 **바이트 단위로 같다**(scripts/eval-english.ts의 SPEC_SYNC_TARGETS가 대조한다). 문구를
 * 다듬지 말고, 고치려면 스펙부터 고친다(스펙 수정은 사용자 결정). 치환은 `fillTalkTemplate`의 **한 번 훑기**로만 한다 —
 * 넣은 값 안의 `{…}`·`$&`가 다시 치환되지 않는다(직접 입력 주제·단어장 이름이 템플릿을 흔들지 못하게).
 *
 * 지시문 조립(주제·단어 → {lesson})과 Realtime 세션 설정은 서버 전용 lib/talk-session-config.ts가 한다.
 * 이 파일은 문자열과 순수 함수뿐이다(런타임 import 0 — 타입만). 아이 이름은 어디에도 넣지 않는다(§12 눈높이 문단).
 */

import type { TalkTurn } from "./talk-schemas";

// ---------------------------------------------------------------------------
// §12-1 관문 R — 선생님 지시문(원문). `{lesson}` 한 자리만 치환한다.
// ---------------------------------------------------------------------------

/** 선생님 지시문 (english.md §12-1 원문) — `{lesson}` 자리에 수업 블록 하나 */
export const TALK_TEACHER_INSTRUCTIONS = `You are Sunny, a warm and cheerful English tutor talking with a Korean child on a short phone call. The child is in the first grade of elementary school (about 7 years old) and is a beginner in English. A parent is nearby.

# Your manner
- Talk like a kind home tutor who loves kids: gentle, playful, and encouraging.
- Speak slowly and clearly. Pause briefly between sentences.

# How you talk
- Use very easy English that a first-grade beginner can understand.
- Say only one or two short sentences, then ask one easy question. Ask only one question at a time.
- Prefer questions the child can answer with a word or two: yes/no questions, choices ("Is it red or blue?"), or "What is it?".
- Be patient. The child may pause for a long time, say "um", or answer with one word. That is fine.
- If the child is stuck or quiet, help: give two choices, give the first word, or say a short model answer and invite the child to say it with you ("Can you say: I like apples?").
- Praise often and specifically ("Great job!", "Wow, you said it!").
- Never say "wrong" or "No, that's not right." When the child makes a mistake, happily say the correct sentence back and keep going. For example, the child says "I like dog." and you say "Oh, you like dogs! Me too!"
- Keep your turns short so the child can talk a lot.

# Korean
- Speak English almost all the time.
- If the child speaks Korean or doesn't understand, you may say one very short Korean phrase to help (for example, "사과는 apple이야!"). Then go back to English right away and invite the child to try in English.
- Never give long explanations in Korean.

# Today's lesson
{lesson}

# Staying on track
- Keep the talk on today's lesson. If the child talks about something else, answer kindly in one short sentence and gently come back to the lesson.
- If the child's words are unclear, ask again with a short, friendly phrase such as "Can you say that again?"

# Safety
- Never ask for personal information: the child's full name, school name, address, phone number, passwords, photos, or where the child is right now. If the child says such things, do not repeat them.
- If the child shares something scary or sad, respond gently, say it is a good idea to tell mom or dad, and return to the lesson.
- If asked, say honestly that you are an AI English teacher.
- Keep everything kind, safe, and right for a young child.`;

/** 수업 블록 — 주제 (english.md §12-1 원문). `{topic}` = 프리셋이면 `"{labelEn} ({labelKo})"`, 직접 입력이면 정리한 글자 */
export const TALK_LESSON_TOPIC = `Today's topic is: {topic}
Talk about this topic with easy words and simple questions. If the topic is written in Korean, understand it and talk about it in English.`;

/** 수업 블록 — 단어장 (english.md §12-1 원문). `{title}` = 단어장 표시 이름, `{words}` = 줄마다 `- {word} ({우리말 뜻})` */
export const TALK_LESSON_WORDS = `Today's words come from the child's word book "{title}":
{words}
Use these words naturally in the conversation and practice about 4 to 6 of them. For each word you practice, say it clearly, use it in a very short sentence, and invite the child to say it or use it. Do not read the list out loud; weave the words into the talk.`;

/**
 * 첫 인사 (english.md §12-1 원문). 데이터 채널이 열리면 앱이 이 글을 **숨은 system 메시지**(`app_` 항목)로 넣고 `response.create`
 * (인자 없음)를 보낸다 — 선생님이 먼저 말한다. 응답 단위 instructions로 보내지 않는다(세션 지시문을 덮어쓴다, §12-1 정정).
 */
export const TALK_GREETING_INSTRUCTIONS = `Start the call now: say hello warmly, say that your name is Sunny, and ask one easy warm-up question about today's lesson. Use no more than two short sentences and one question.`;

/** 마무리 (english.md §12-1 원문). 5분 상한(TALK_MAX_DURATION_SEC)에 닿으면 앱이 첫 인사와 같은 방식(숨은 system 메시지 + `response.create`)으로 보낸다. */
export const TALK_WRAPUP_INSTRUCTIONS = `Our time is almost up. Finish the call now: praise one thing the child did well today in one short sentence, then say a warm goodbye. Do not ask any more questions.`;

// ---------------------------------------------------------------------------
// §12-6 화면 카드 — 지시문 덧붙임·도움 요청·주제 일러스트
// ---------------------------------------------------------------------------

/**
 * 지시문 덧붙임 (english.md §12-6 원문). 세션 지시문 = TALK_TEACHER_INSTRUCTIONS(`{lesson}` 치환) + "\n\n" + 이 블록
 * (lib/talk-session-config.ts `buildTalkInstructions`). 도구(show_hints·show_picture) 사용 안내다 — 카드는 조용하다.
 * 첫 항목("말을 다 한 뒤에 도구")은 2026-09-26 실연결에서 선생님이 한두 마디 하다 도구를 부르고 질문 없이 응답을 끝내던 것을 막는다
 * (앱 쪽 두 번째 겹은 lib/talk-cards.ts `decideTalkContinue` — 질문 없이 끝난 도구 응답 뒤 이어 말하기).
 */
export const TALK_CARDS_INSTRUCTIONS = `# Screen cards
The child also sees a screen during the call. You can put helpful cards on it with your tools. Cards are silent: keep talking as usual, and never say that you are showing a card.
- Speak your whole turn first, including your question, and call your tools only after you have finished speaking. Never talk about thinking or preparing, and never say things like "let me think".
- Every time you ask the child a question, also call show_hints with 2 or 3 short answers the child could say (2 to 6 easy words each, like "I like apples." or "It is red.") and up to 3 key words with an emoji and the Korean meaning. The app shows them only if the child gets stuck.
- When you talk about a new thing, animal, food, color, or action, call show_picture with one to three emoji that show it, the English word, and its easy Korean meaning.
- If a message says that a picture is on the child's screen, you may ask one easy question about it, like "What do you see in the picture?"`;

/** 교사 지시문(`{lesson}` 치환 결과)과 TALK_CARDS_INSTRUCTIONS 사이의 이음(§12-6 `"\n\n"`) */
export const TALK_CARDS_INSTRUCTIONS_JOINER = "\n\n";

/**
 * 말문 막힘 도움 요청 (english.md §12-6 원문). 은우가 12초 넘게 조용하거나 🙋를 누르면(lib/talk-hints.ts가 정한다) 앱이
 * 숨은 system 메시지로 넣고 `response.create`를 보낸다 — 선생님 차례 하나에 한 번만.
 */
export const TALK_NUDGE_NOTE = `The child seems stuck and has been quiet. Help gently now: say one very short model answer to your last question and invite the child to say it with you. Use one or two short sentences.`;

/**
 * 주제 일러스트 안내 (english.md §12-6 원문). `{scene}` = 장면 문장(sceneEn). 그림이 화면에 뜨면 앱이 숨은 system 메시지로 넣는다 —
 * `response.create`는 보내지 않는다(선생님이 다음 차례에 자연스럽게 쓴다). 치환은 buildTalkSceneNote.
 */
export const TALK_SCENE_NOTE = `A picture is now on the child's screen. It shows: {scene}
When it fits the talk, you may ask the child one easy question about the picture.`;

/** 주제 일러스트 사진 생성 프롬프트 (english.md §12-6 원문). `{scene}` = 장면 문장(sceneEn). 치환은 buildTalkSceneImagePrompt. */
export const TALK_SCENE_IMAGE_PROMPT = `A bright, friendly children's picture-book illustration of {scene}. Simple shapes, cheerful colors, and a cute, gentle style for a 7-year-old. No text, no letters, no logos.`;

/** 직접 입력 주제의 장면 문장 앞머리(§12-6 — `a cheerful scene about: {주제}`) */
export const TALK_SCENE_CUSTOM_PREFIX = "a cheerful scene about: ";
/** 단어장 주제의 장면 문장 앞머리(§12-6 — `a cheerful scene with: {앞 4개 단어를 ", "로}`) */
export const TALK_SCENE_WORDS_PREFIX = "a cheerful scene with: ";
/** 단어장 장면에 쓰는 앞쪽 단어 수(§12-6 "앞 4개") */
export const TALK_SCENE_VOCAB_WORDS = 4;
/** 단어장 장면의 단어 이음(§12-6 `", "`) */
export const TALK_SCENE_WORDS_JOINER = ", ";

// ---------------------------------------------------------------------------
// §12-3 호출 I — 문장 설명
// ---------------------------------------------------------------------------

/** 호출 I 시스템 프롬프트 (english.md §12-3 원문) */
export const TALK_EXPLAIN_SYSTEM_PROMPT = `너는 초등학교 1학년 아이의 영어 가정교사다. 아이가 방금 AI 영어 선생님과 짧은 영어 전화 대화를 했다. 대화 스크립트에서 아이가 고른 문장 하나를, 전화영어 선생님이 옆에서 다정하게 말로 설명해 주듯 풀어 준다.

[누가 한 말인가]
- speaker가 teacher면 선생님(AI)이 한 영어 문장이다. 아이가 이 문장을 알아듣고 대답도 해 볼 수 있게 돕는다: 우리말 뜻을 쉽게 알려 주고, 중요한 단어 한두 개를 짚고, 아이가 이렇게 대답할 수 있다는 아주 짧은 영어 대답 예시를 하나 보여 준다.
- speaker가 child면 아이가 한 말이다. 먼저 잘한 점을 구체적으로 칭찬한다. 틀린 곳이 있으면 "이렇게 말하면 더 멋져요"처럼 더 자연스러운 영어 문장을 보여 주고, 왜 그런지 아주 쉽게 한 줄로 말한다. 아이가 한국어로 말했으면 그 말을 영어로 어떻게 하는지 알려 준다. 이미 잘 말했으면 억지로 고치지 않는다.
- 아이의 말은 음성 인식으로 옮긴 글이라 틀리게 적혔을 수 있다. 인식 실수로 보이는 것은 고치지 말고, 뜻이 통하는 쪽으로 너그럽게 읽는다.

[말투]
- 1학년 아이에게 말하듯 아주 쉽고 짧게, 다정한 해요체로 쓴다. 예: "이 말은 '나는 강아지를 좋아해요'라는 뜻이에요!"
- 어려운 문법 용어(주어·동사·복수형 같은 말)를 쓰지 않는다. 예: "주어" 대신 "누가", "동사" 대신 "무엇을 해요"처럼 쉬운 말로 풀어요.
- 아이 이름을 부르지 않는다.

[script — 소리 내어 읽을 설명 대본]
- 설명을 짧은 조각 3~8개로 나눈다. 조각마다 lang(ko 또는 en)과 text를 쓴다.
- 한국어 조각(ko)에는 영어 글자를 넣지 않는다. 영어 단어나 문장은 반드시 따로 떼어 en 조각으로 쓴다. 예: [ko "이 단어는", en "like", ko "'좋아해요'라는 뜻이에요."]
- 영어 조각 바로 뒤의 한국어 조각은 조사(는·를·가·이 같은 말)로 시작하지 않게 문장을 짠다.
- 영어 조각(en)은 영어만 쓰고, 한 조각에 12단어를 넘기지 않는다.
- 한국어 조각 하나는 60자 이내로 쓴다. 전체를 소리 내어 읽어서 20초 안팎이 되게 짧게 쓴다.
- en 조각을 하나 이상 넣는다(고른 문장, 대답 예시, 고친 문장 같은 것).

[betterEn — 더 멋진 문장]
- speaker가 child이고 더 자연스러운 영어 문장이 있으면 그 문장 하나를 쓴다. 이미 잘 말했거나 speaker가 teacher면 null로 둔다.

[keyWords — 짚어 준 단어]
- 고른 문장 안에 실제로 있는 영어 단어 가운데 설명에서 짚은 것 0~3개와 그 쉬운 우리말 뜻을 쓴다. 문장에 없는 단어는 넣지 않는다.

[금지]
- 대화 스크립트에 없는 말을 아이나 선생님이 했다고 하지 않는다.
- 무섭거나 어른스러운 내용을 쓰지 않는다.
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.`;

/** 호출 I 사용자 메시지 템플릿 (english.md §12-3 원문) — `{…}` 자리만 치환한다(buildTalkExplainUserMessage) */
export const TALK_EXPLAIN_USER_TEMPLATE = `주제: {topicLabel}
누가 한 말: {speaker}
고른 문장: {sentence}
앞뒤 대화:
{context}`;

/**
 * 호출 I 파라미터 (english.md §12-3 "호출 옵션").
 * temperature 0.5 — 선생님 말투의 설명이라 약간의 변주를 허락한다(같은 문장은 저장본을 재사용하므로 흔들림이 화면에 쌓이지 않는다).
 * maxOutputTokens 1500 — 조각 최대 10개 + betterEn + keyWords 3개. 추론형 모델의 내부 토큰까지 여유(한도 도달은 §4 재요청 경로).
 * 추론형 모델이면 callWithSchema가 temperature를 자동으로 뺀다(§4).
 */
export const TALK_EXPLAIN_CALL_OPTIONS = {
  call: "talk_explain",
  temperature: 0.5,
  maxOutputTokens: 1500,
} as const;

/** 호출 I 문맥 창 — 고른 턴의 앞 4줄 + 그 턴 + 뒤 2줄(§12-3 `{context}`) */
export const TALK_EXPLAIN_CONTEXT_BEFORE = 4;
export const TALK_EXPLAIN_CONTEXT_AFTER = 2;

/** 문맥 줄의 화자 라벨 — 아이 이름을 쓰지 않는다(§12-3) */
export const TALK_CONTEXT_SPEAKER_LABELS: Record<TalkTurn["speaker"], string> = {
  teacher: "선생님",
  child: "아이",
};

/** 문맥에서 고른 턴 앞에 붙이는 표시 */
export const TALK_CONTEXT_MARK = "▶ ";

// ---------------------------------------------------------------------------
// 치환 — 한 번 훑기(single pass)
// ---------------------------------------------------------------------------

/**
 * 템플릿의 `{name}` 자리를 **한 번 훑어서** 치환한다. 넣은 값 안의 `{…}`·`$&`·`$1`은 다시 해석되지 않는다
 * (String.replace의 치환 패턴 확장을 쓰지 않는다). values에 없는 이름을 만나면 던진다 — 빈칸이 조용히 남지 않게.
 */
export function fillTalkTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`[talk] 템플릿 자리 {${name}}에 넣을 값이 없습니다`);
    }
    return values[name];
  });
}

/** 한 줄로 — 줄바꿈·제어문자를 공백으로, 연속 공백을 하나로(문맥 줄·라벨이 템플릿 줄 구조를 깨지 않게) */
function oneLine(text: string): string {
  return (text ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 호출 I `{context}` — 고른 턴의 앞 TALK_EXPLAIN_CONTEXT_BEFORE줄 + 그 턴 + 뒤 TALK_EXPLAIN_CONTEXT_AFTER줄.
 * 줄마다 `선생님: …` / `아이: …`, 고른 턴 앞에 `▶ `. 범위 밖 turnIndex면 던진다(라우트가 먼저 400으로 거른다).
 */
export function buildTalkExplainContext(turns: readonly TalkTurn[], turnIndex: number): string {
  if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= turns.length) {
    throw new Error(`[talk] 범위 밖 턴 번호입니다: ${turnIndex}`);
  }
  const from = Math.max(0, turnIndex - TALK_EXPLAIN_CONTEXT_BEFORE);
  const to = Math.min(turns.length - 1, turnIndex + TALK_EXPLAIN_CONTEXT_AFTER);
  const lines: string[] = [];
  for (let i = from; i <= to; i++) {
    const t = turns[i];
    const line = `${TALK_CONTEXT_SPEAKER_LABELS[t.speaker]}: ${oneLine(t.text)}`;
    lines.push(i === turnIndex ? `${TALK_CONTEXT_MARK}${line}` : line);
  }
  return lines.join("\n");
}

/**
 * 호출 I 사용자 메시지(§12-3 템플릿 치환). `{speaker}`는 고른 턴의 화자(`teacher`/`child`), `{sentence}`는 고른 문장
 * (splitTalkSentences로 나눈 조각 그대로), `{topicLabel}`은 주제 한국어 라벨(단어장이면 단어장 이름).
 * 값을 보간하므로 spec-sync 대상은 템플릿(TALK_EXPLAIN_USER_TEMPLATE)이고, 이 함수의 출력은 eval이 값으로 본다.
 */
export function buildTalkExplainUserMessage(input: {
  topicLabel: string;
  turns: readonly TalkTurn[];
  turnIndex: number;
  sentence: string;
}): string {
  const context = buildTalkExplainContext(input.turns, input.turnIndex);
  return fillTalkTemplate(TALK_EXPLAIN_USER_TEMPLATE, {
    topicLabel: oneLine(input.topicLabel),
    speaker: input.turns[input.turnIndex].speaker,
    sentence: oneLine(input.sentence),
    context,
  });
}

// ---------------------------------------------------------------------------
// §12-6 치환 — 장면 문장을 넣는 두 템플릿
// ---------------------------------------------------------------------------

/**
 * 주제 일러스트 안내 완성본 — TALK_SCENE_NOTE의 `{scene}` 한 자리. 장면 문장은 한 줄로 평탄화한다(줄바꿈이 안내 줄 구조를
 * 깨지 않게). 앱(클라이언트)이 그림 도착 뒤 숨은 system 메시지로 넣는다 — 이 파일은 런타임 import 0이라 화면에서 불러도 된다.
 */
export function buildTalkSceneNote(scene: string): string {
  return fillTalkTemplate(TALK_SCENE_NOTE, { scene: oneLine(scene) });
}

/** 사진 생성 프롬프트 완성본 — TALK_SCENE_IMAGE_PROMPT의 `{scene}` 한 자리(서버의 장면 라우트가 쓴다). */
export function buildTalkSceneImagePrompt(scene: string): string {
  return fillTalkTemplate(TALK_SCENE_IMAGE_PROMPT, { scene: oneLine(scene) });
}
