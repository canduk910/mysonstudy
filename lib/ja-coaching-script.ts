/**
 * lib/ja-coaching-script.ts — 대화 해설 → **낭독 대본**(재생할 조각 배열) (docs/SPEC.md §18-1)
 *
 * 해설(호출 C 결과)을 "무엇을 어느 언어로 어떤 순서로 읽을지"로 바꾸는 일은 화면이 아니라 이 **순수 함수**가 한다.
 * 화면은 대본을 speakQueue에 넘기고 onItem 인덱스로 카드를 강조할 뿐이다. 오프라인 eval(eval-speech.ts)로 잠근다.
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 `./tts-shared`의 상수와 `./tts-split`(순수 쪼개기)뿐, 타입은 `import type`.
 * 서버 전용 `lib/tts.ts`(openai)를 절대 import하지 않는다(speech.ts와 같은 규약).
 */

import { TTS_TEXT_MAX_CHARS } from "./tts-shared";
import { splitForTts } from "./tts-split";
import type { JaDialogCoaching } from "./japanese-dialog-contract";

export type ScriptSection = "summary" | "goods" | "fixes" | "items" | "practice";

/** 재생할 조각 하나. */
export interface ScriptPiece {
  /** 읽을 텍스트(trim됨, 비어 있지 않음, length ≤ TTS_TEXT_MAX_CHARS) */
  text: string;
  lang: "ko-KR" | "ja-JP";
  section: ScriptSection;
  /** 하이라이트 대상 카드 번호. 섹션 제목 조각은 null, 총평 본문은 0 */
  item: number | null;
}

/** 섹션 제목(한국어로 읽는다). 끝의 마침표는 낭독에서 짧게 쉬게 하려는 것. */
const SECTION_TITLE: Record<ScriptSection, string> = {
  summary: "총평.",
  goods: "잘한 점.",
  fixes: "고칠 점.",
  items: "어휘.",
  practice: "다음 연습.",
};

// ───────────────────────── 한국어 정리 ─────────────────────────

/** 이모지 한 덩어리(ZWJ 결합·스킨톤·변형 선택자 U+FE0F 포함). */
const EMOJI_RE = /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

/**
 * 한국어 조각만, **쪼개기 전에** 적용한다: `→`·`⇒`는 `, `로, `〜`·`～`는 제거, 이모지 제거, 연속 공백은 하나로.
 * TTS가 기호를 "화살표"·"물결"로 읽거나 멈칫하지 않게 한다. 일본어 조각은 정리하지 않는다(🔊·프리페치 캐시 키 일치).
 * 키캡 이모지(`1️⃣` = 숫자 + U+FE0F + U+20E3)는 숫자가 그림 문자가 아니라 위 정규식에 안 걸린다 — 결합 기호만 지워 숫자를 남긴다.
 */
export function normalizeKoForTts(text: string): string {
  return (text ?? "")
    .replace(/\s*[→⇒]\s*/g, ", ")
    .replace(/[〜～]/g, "")
    .replace(EMOJI_RE, "")
    .replace(/[\uFE0F\u200D\u20E3]/g, "") // 떨어져 남은 변형 선택자·ZWJ·키캡 결합 기호
    .replace(/\s+([.,!?。、，])/g, "$1") // 지운 이모지 자리에 남은 "요 ." 같은 공백을 부호에 붙인다
    .replace(/\s+/g, " ")
    .trim();
}

// ───────────────────────── 쪼개기 ─────────────────────────

/**
 * 쪼개기(splitForTts)는 공용 모듈 lib/tts-split.ts로 옮겼다(토익 전체 듣기도 같은 규칙을 쓴다 — toeic.md §6-3).
 * 기존 import 경로(`@/lib/ja-coaching-script`의 splitForTts)가 깨지지 않게 재수출한다. 동작 변화 0.
 */
export { splitForTts };

// ───────────────────────── 대본 ─────────────────────────

/**
 * 해설 → 낭독 대본(§18-1 표 순서). 빈 섹션은 제목까지 통째로 건너뛴다. 각 필드는 `(s ?? "").trim()`, 비면 조각 없음.
 * 한국어는 정리(normalizeKoForTts) 후 쪼개고, 일본어는 원문 trim 그대로(≤300이면 한 조각). 쪼갠 조각은 같은 section·item.
 */
export function buildCoachingScript(c: JaDialogCoaching): ScriptPiece[] {
  const out: ScriptPiece[] = [];

  const section = (sec: ScriptSection, fill: (push: (text: string | null | undefined, lang: ScriptPiece["lang"], item: number) => void) => void) => {
    const body: ScriptPiece[] = [];
    fill((raw, lang, item) => {
      const trimmed = (raw ?? "").trim();
      if (!trimmed) return;
      const src = lang === "ko-KR" ? normalizeKoForTts(trimmed) : trimmed;
      for (const text of splitForTts(src, TTS_TEXT_MAX_CHARS)) body.push({ text, lang, section: sec, item });
    });
    if (body.length === 0) return; // 빈 섹션 → 제목도 없음
    out.push({ text: SECTION_TITLE[sec], lang: "ko-KR", section: sec, item: null }, ...body);
  };

  section("summary", (push) => push(c.summaryKo, "ko-KR", 0));

  section("goods", (push) =>
    (c.goods ?? []).forEach((g, i) => {
      push(g.quoteJa, "ja-JP", i);
      push(g.whyKo, "ko-KR", i);
    }),
  );

  section("fixes", (push) =>
    (c.fixes ?? []).forEach((f, i) => {
      push(f.originalJa, "ja-JP", i);
      // "고치면,"은 고친 문장이 있을 때만 — 없는 문장을 예고하지 않는다.
      if ((f.betterJa ?? "").trim()) push("고치면,", "ko-KR", i);
      push(f.betterJa, "ja-JP", i);
      push(f.whyKo, "ko-KR", i);
      const grammar = (f.grammarKo ?? "").trim();
      if (grammar) push(`문법: ${grammar}`, "ko-KR", i);
    }),
  );

  section("items", (push) =>
    (c.items ?? []).forEach((it, i) => {
      push(it.word, "ja-JP", i);
      push(it.meaningKo, "ko-KR", i);
      push(it.usageKo, "ko-KR", i);
    }),
  );

  section("practice", (push) =>
    (c.practice ?? []).forEach((p, i) => {
      push(p.ja, "ja-JP", i);
      push(p.ko, "ko-KR", i);
    }),
  );

  return out;
}

/**
 * 해설 속 일본어 문장 목록(프리페치용) — 잘한 점 인용·고칠 점 원문/고친 문장·어휘·다음 연습.
 * trim만 하고 빈 것은 뺀다 — 대본의 일본어 조각·🔊 speak(ja, "ja-JP")와 글자까지 같아야 캐시가 맞는다.
 */
export function coachingJaTexts(c: JaDialogCoaching): string[] {
  return [
    ...(c.goods ?? []).map((g) => g.quoteJa),
    ...(c.fixes ?? []).flatMap((f) => [f.originalJa, f.betterJa]),
    ...(c.items ?? []).map((i) => i.word),
    ...(c.practice ?? []).map((p) => p.ja),
  ]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0);
}
