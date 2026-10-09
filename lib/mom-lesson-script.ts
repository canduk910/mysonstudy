/**
 * lib/mom-lesson-script.ts — 엄마의 생활영어 하루 레슨 대본(설계 §4). 순수 — 화면이 `speakQueue`에 그대로 넘긴다.
 * 교재 문장은 여기 없다 — 문장은 모두 가져온 파일(스토어)에서 온다.
 */
import type { SpeakQueueItem } from "./speech";

const EN = "en-US";
const KO = "ko-KR";

/** 소리 듣기 덩어리 뒤 쉼(ms) */
export const MOM_LISTEN_CHUNK_PAUSE_MS = 600;
/** 따라 말하기 — 한국어 뜻 뒤 쉼(ms) */
export const MOM_SHADOW_KO_PAUSE_MS = 400;
/** 따라 말하기 — 영어 뒤 쉼 = 낱말 수 × 이 값, 최소 MOM_SHADOW_MIN_PAUSE_MS */
export const MOM_SHADOW_MS_PER_WORD = 450;
export const MOM_SHADOW_MIN_PAUSE_MS = 1500;

function words(en: string): string[] {
  return en.trim().split(/\s+/).filter(Boolean);
}

/** ② 소리 듣기 — 덩어리마다(뒤에 쉼) → 마지막에 전체 문장 한 번 */
export function momListenScript(s: { en: string; chunks: string[] }): SpeakQueueItem[] {
  const chunks = s.chunks.map((c) => c.trim()).filter(Boolean);
  return [...chunks.map((text) => ({ text, lang: EN, pauseAfterMs: MOM_LISTEN_CHUNK_PAUSE_MS })), { text: s.en, lang: EN }];
}

/** ③ 따라 말하기 — 문장마다 한국어 1번 → 영어 × repeat(뒤에 따라 말할 틈) */
export function momShadowScript(sentences: readonly { ko: string; en: string }[], repeat: number): SpeakQueueItem[] {
  const n = Math.max(1, Math.floor(repeat));
  return sentences.flatMap((s) => {
    const pause = Math.max(MOM_SHADOW_MIN_PAUSE_MS, words(s.en).length * MOM_SHADOW_MS_PER_WORD);
    return [{ text: s.ko, lang: KO, pauseAfterMs: MOM_SHADOW_KO_PAUSE_MS }, ...Array.from({ length: n }, () => ({ text: s.en, lang: EN, pauseAfterMs: pause }))];
  });
}

/** 따라 말하기 반복 수 — 0~2단계 3번, 3~4단계 2번 */
export function momShadowRepeat(stage: 0 | 1 | 2 | 3 | 4): number {
  return stage >= 3 ? 2 : 3;
}

/** 힌트 사다리 — 1 첫 낱말, 2 첫 덩어리, 3 전체 문장 */
export function momHintText(en: string, level: 1 | 2 | 3, chunks: string[]): string {
  const full = en.trim();
  if (level === 3) return full;
  const head = level === 1 ? (words(full)[0] ?? "") : (chunks.map((c) => c.trim()).find(Boolean) ?? "");
  if (!head || head === full) return full;
  return `${head} …`;
}
