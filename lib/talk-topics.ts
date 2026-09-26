/**
 * lib/talk-topics.ts — 은우 자유대화 **시작 화면 선택지의 단일 정의처** (docs/harness/english.md §12-1, SPEC §21-2)
 *
 * - 주제 프리셋 10개(키·한국어 라벨·영어 라벨·이모지·장면 문장)를 **여기 한 곳에만** 둔다. 시작 화면(칩)·서버(지시문 조립·
 *   주제 스냅샷·주제 일러스트 장면)·eval이 모두 이 배열을 본다. 서버는 여기 있는 키만 받는다(§12-1 입력 정리).
 *   키와 장면 문장은 english.md §12-6 "프리셋 장면 문장" 표 그대로다(eval이 표를 읽어 대조한다).
 * - 직접 입력 주제의 글자 상한, 말 빠르기 선택지 키(천천히·보통), 대화 한 번의 시간 상한(5분, SPEC §21-1)도 화면이 알아야 하는
 *   값이라 여기 둔다. 서버 쪽 상한 묶음(`TALK_LIMITS`, lib/ai/english/talk-schemas.ts)은 이 값들을 **가져다 쓴다**(두 번 정의하지 않는다).
 * - 말 빠르기의 실제 배속(0.85 / 1.0)은 서버 전용 lib/talk-session-config.ts에 있다 — 화면은 키만 보낸다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import 0(값·타입뿐, 부작용 없음). lib/ai·openai·zod를 import하지 않는다.
 */

/** 주제 프리셋 한 칸 */
export interface TalkTopicPreset {
  /** 저장·요청에 쓰는 키(바꾸지 않는다 — 옛 대화 기록의 topic.key가 이 값을 가리킨다) */
  key: string;
  /** 화면 라벨(한국어) */
  labelKo: string;
  /** 선생님 지시문에 들어가는 영어 라벨(`{labelEn} ({labelKo})`) */
  labelEn: string;
  /** 칩 이모지(장식) */
  emoji: string;
  /** 주제 일러스트 장면 문장(영어, §12-6 표) — 사진 생성 프롬프트와 선생님 안내(TALK_SCENE_NOTE)의 `{scene}` */
  sceneEn: string;
}

/** 주제 프리셋 10개(§12-1 — 동물·음식·가족·학교와 친구·놀이·날씨·색깔과 모양·오늘 하루·공룡·생일). 순서 = 화면 순서. 키·장면은 §12-6 표. */
export const TALK_TOPIC_PRESETS = [
  { key: "animals", labelKo: "동물", labelEn: "Animals", emoji: "🐶", sceneEn: "a sunny farm with a dog, a cat, a cow, and a duck" },
  { key: "food", labelKo: "음식", labelEn: "Food", emoji: "🍎", sceneEn: "a picnic blanket with apples, bananas, sandwiches, and juice" },
  { key: "family", labelKo: "가족", labelEn: "Family", emoji: "👨‍👩‍👧", sceneEn: "a happy family of four eating dinner together at home" },
  { key: "school", labelKo: "학교와 친구", labelEn: "School and friends", emoji: "🏫", sceneEn: "a bright classroom with desks, books, crayons, and a smiling teacher" },
  { key: "play", labelKo: "놀이", labelEn: "Playing", emoji: "🧸", sceneEn: "a playroom with blocks, a ball, a teddy bear, and a toy car" },
  { key: "weather", labelKo: "날씨", labelEn: "Weather", emoji: "⛅", sceneEn: "a park with a rainbow, a few clouds, trees, and puddles" },
  { key: "colors", labelKo: "색깔과 모양", labelEn: "Colors and shapes", emoji: "🎨", sceneEn: "red, blue, yellow, and green balloons and blocks" },
  { key: "myday", labelKo: "오늘 하루", labelEn: "My day", emoji: "📅", sceneEn: "a cozy morning with a bed, an alarm clock, and breakfast on the table" },
  { key: "dinosaurs", labelKo: "공룡", labelEn: "Dinosaurs", emoji: "🦖", sceneEn: "friendly cartoon dinosaurs in a green jungle with a volcano far away" },
  { key: "birthday", labelKo: "생일", labelEn: "Birthdays", emoji: "🎂", sceneEn: "a birthday party with a cake, candles, balloons, and presents" },
] as const satisfies readonly TalkTopicPreset[];

export type TalkTopicPresetKey = (typeof TALK_TOPIC_PRESETS)[number]["key"];

/** 프리셋 키인가(서버가 받은 키 검증·화면 복원 공용) */
export function isTalkTopicPresetKey(key: unknown): key is TalkTopicPresetKey {
  return typeof key === "string" && TALK_TOPIC_PRESETS.some((p) => p.key === key);
}

/** 키 → 프리셋(없으면 null) */
export function findTalkTopicPreset(key: unknown): TalkTopicPreset | null {
  if (typeof key !== "string") return null;
  return TALK_TOPIC_PRESETS.find((p) => p.key === key) ?? null;
}

/** 직접 입력 주제의 글자 상한(코드 포인트 기준, §12-1 "1~30자"). 입력창 maxLength와 서버 정리가 같은 값을 본다. */
export const TALK_CUSTOM_TOPIC_MAX_CHARS = 30;

/** 선생님 말 빠르기 선택지(§12-1 — 서버는 이 두 키만 받는다). 기본은 천천히. */
export const TALK_SPEEDS = ["slow", "normal"] as const;
export type TalkSpeed = (typeof TALK_SPEEDS)[number];
export const TALK_DEFAULT_SPEED: TalkSpeed = "slow";
export const TALK_SPEED_LABELS_KO: Record<TalkSpeed, string> = {
  slow: "천천히",
  normal: "보통",
};

/** 말 빠르기 키인가 */
export function isTalkSpeed(value: unknown): value is TalkSpeed {
  return typeof value === "string" && (TALK_SPEEDS as readonly string[]).includes(value);
}

/** 대화 한 번의 시간 상한(초) — 5분(SPEC §21-1). 닿으면 앱이 마무리 지시(TALK_WRAPUP_INSTRUCTIONS)를 보낸다. */
export const TALK_MAX_DURATION_SEC = 300;
