/**
 * lib/talk-normalize.ts — 은우 자유대화 저장 레코드(`TalkSessionRecord`) 방어 정규화 + 설명 추가 판정의 **단일 정의처**
 * (docs/harness/english.md §12-4, SPEC §21-3)
 *
 * 두 저장 백엔드(파일 `lib/store.ts`·Firestore `lib/store-firestore.ts`)가 **같은 함수**로 읽고 쓴다 — 정규화가 한쪽에만 있으면
 * 두 백엔드가 같은 문서를 다르게 읽는다(toeic-normalize·normalizeJaDialogRecord 관용구).
 *
 * 규칙(app-patterns §4 normalize 관용구):
 * - **던지지 않는다.** 없는 키는 null·빈 배열·기본값으로 채우고, 깨진 조각(모르는 화자의 턴, 모양이 틀린 설명)은 버린다 —
 *   읽기가 던지면 페이지가 500이 된다.
 * - **글자를 손보지 않는다.** 전사·설명 글자는 저장된 그대로(스크립트가 곧 기록이다). 없는 것을 없음으로 적을 뿐.
 * - **undefined를 남기지 않는다** — Firestore가 거부한다.
 * - `childTurnCount`는 저장값을 믿지 않고 turns에서 **다시 센다**(스트릭 §17-9·저장 조건이 이 값을 본다 — 파생 상태를 저장값과
 *   따로 두면 진실이 둘이 된다. 토익 세트의 enriched와 같은 규약).
 *
 * §12-6 화면 카드 필드: `cards`(모양이 맞는 카드만, 최대 TALK_LIMITS.cards — 글자 검사는 저장 라우트의 sanitizeTalkCards 몫),
 * `sceneImageId`(빈 문자열은 null)·`sceneEn`(그림이 없으면 null). 이 필드가 생기기 전의 기록은 빈 카드·그림 없음으로 읽는다.
 * 주제 일러스트 문서(`talkImages`)는 `normalizeTalkImageRecord` — 같은 규칙(던지지 않음, 없는 키는 빈 값).
 *
 * 설명 추가(`decideTalkExplanation`)는 **같은 키(turnIndex, sentenceIndex)가 없을 때만 append**한다(§12-4 — 두 번 탭해도 한 번
 * 저장). 파일 백엔드는 `mutate` 콜백 **안에서**, Firestore는 `runTransaction` **안에서** 부른다(판정과 쓰기를 한 원자 단위로).
 *
 * 런타임 import는 순수 모듈(`./talk-transcript`의 childTurnCount)과 상한 상수뿐이다. 레코드 타입은 lib/store.ts에 있고 여기서는
 * `import type`만 한다. 서버 전용으로 쓴다(talk-schemas가 zod를 싣는다) — 클라이언트 컴포넌트에서 값으로 import하지 말 것.
 */

import type { TalkCard, TalkExplanation, TalkKeyWord, TalkScriptPiece, TalkTopic, TalkTopicWord, TalkTurn } from "./ai/english/talk-schemas";
import { TALK_LIMITS, TALK_SCRIPT_LANGS, TALK_SPEAKERS, TALK_TOPIC_KINDS } from "./ai/english/talk-schemas";
import { childTurnCount } from "./talk-transcript";
import type { TalkImageRecord, TalkSessionRecord } from "./store";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const strOr = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const intOr = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback);

function normalizeTopicWord(w: unknown): TalkTopicWord | null {
  if (!isRec(w) || typeof w.en !== "string" || w.en.trim() === "") return null;
  return { en: w.en, ko: strOrNull(w.ko) };
}

/** 주제 스냅샷 방어 — 모르는 kind는 custom(글자만 보이는 주제)으로 읽는다(라벨이 곧 표시). */
export function normalizeTalkTopic(t: unknown): TalkTopic {
  const o = isRec(t) ? t : {};
  const kind = (TALK_TOPIC_KINDS as readonly string[]).includes(o.kind as string) ? (o.kind as TalkTopic["kind"]) : "custom";
  const words = Array.isArray(o.words) ? o.words.map(normalizeTopicWord).filter((w): w is TalkTopicWord => w !== null) : [];
  return {
    kind,
    key: strOrNull(o.key),
    labelKo: strOr(o.labelKo, ""),
    labelEn: strOrNull(o.labelEn),
    vocabBookId: strOrNull(o.vocabBookId),
    words,
  };
}

function normalizeTurn(t: unknown): TalkTurn | null {
  if (!isRec(t)) return null;
  if (!(TALK_SPEAKERS as readonly string[]).includes(t.speaker as string)) return null;
  if (typeof t.text !== "string") return null;
  const speaker = t.speaker as TalkTurn["speaker"];
  return { speaker, text: t.text, interrupted: speaker === "teacher" && t.interrupted === true };
}

function normalizeScriptPiece(p: unknown): TalkScriptPiece | null {
  if (!isRec(p) || typeof p.text !== "string") return null;
  if (!(TALK_SCRIPT_LANGS as readonly string[]).includes(p.lang as string)) return null;
  return { lang: p.lang as TalkScriptPiece["lang"], text: p.text };
}

function normalizeKeyWord(k: unknown): TalkKeyWord | null {
  if (!isRec(k) || typeof k.en !== "string" || typeof k.ko !== "string") return null;
  return { en: k.en, ko: k.ko };
}

/**
 * 그림 카드 한 장 방어(§12-6) — 세 칸이 비어 있지 않은 문자열이어야 한다. 글자는 손보지 않는다(저장 라우트가 sanitizeTalkCards로
 * 이미 검사한 값이다 — 여기서는 모양만 본다).
 */
function normalizeCard(c: unknown): TalkCard | null {
  if (!isRec(c)) return null;
  if (typeof c.emoji !== "string" || c.emoji === "" || typeof c.en !== "string" || c.en === "" || typeof c.ko !== "string" || c.ko === "") {
    return null;
  }
  return { emoji: c.emoji, en: c.en, ko: c.ko };
}

/** 설명 한 건 방어 — 키(번호)·문장·대본이 없으면 버린다(null). 화면이 읽는 배열은 늘 배열로. */
export function normalizeTalkExplanation(e: unknown): TalkExplanation | null {
  if (!isRec(e)) return null;
  const turnIndex = intOr(e.turnIndex, -1);
  const sentenceIndex = intOr(e.sentenceIndex, -1);
  if (turnIndex < 0 || sentenceIndex < 0) return null;
  if (typeof e.sentence !== "string") return null;
  if (!(TALK_SPEAKERS as readonly string[]).includes(e.speaker as string)) return null;
  const script = Array.isArray(e.script) ? e.script.map(normalizeScriptPiece).filter((p): p is TalkScriptPiece => p !== null) : [];
  if (script.length === 0) return null;
  const speaker = e.speaker as TalkExplanation["speaker"];
  return {
    turnIndex,
    sentenceIndex,
    speaker,
    sentence: e.sentence,
    script,
    // 선생님 문장에는 betterEn이 없다(§12-3) — 저장값이 어긋나 있어도 화면에 보이지 않게 null로
    betterEn: speaker === "teacher" ? null : strOrNull(e.betterEn),
    keyWords: Array.isArray(e.keyWords) ? e.keyWords.map(normalizeKeyWord).filter((k): k is TalkKeyWord => k !== null) : [],
    model: strOr(e.model, ""),
    createdAt: strOr(e.createdAt, new Date(0).toISOString()),
  };
}

/**
 * 대화 기록 방어 정규화(두 백엔드 공유). 없는 키는 기본값, 깨진 턴·설명은 버린다. childTurnCount는 turns에서 다시 센다.
 * 같은 키의 설명이 여럿이면(손으로 넣은 문서 등) 먼저 것만 남긴다 — "처음 한 번만"(§12-4) 규칙을 읽기에서도 지킨다.
 */
export function normalizeTalkSessionRecord(d: unknown): TalkSessionRecord {
  const o = isRec(d) ? d : {};
  const turns = Array.isArray(o.turns) ? o.turns.map(normalizeTurn).filter((t): t is TalkTurn => t !== null) : [];
  const seen = new Set<string>();
  const explanations: TalkExplanation[] = [];
  if (Array.isArray(o.explanations)) {
    for (const raw of o.explanations) {
      const e = normalizeTalkExplanation(raw);
      if (!e) continue;
      const key = talkExplanationKey(e.turnIndex, e.sentenceIndex);
      if (seen.has(key)) continue;
      seen.add(key);
      explanations.push(e);
    }
  }
  const createdAt = strOr(o.createdAt, new Date(0).toISOString());
  const startedAt = strOr(o.startedAt, createdAt);
  const cards = Array.isArray(o.cards)
    ? o.cards
        .map(normalizeCard)
        .filter((c): c is TalkCard => c !== null)
        .slice(0, TALK_LIMITS.cards)
    : [];
  const sceneImageId = typeof o.sceneImageId === "string" && o.sceneImageId !== "" ? o.sceneImageId : null;
  return {
    id: strOr(o.id, ""),
    titleKo: strOr(o.titleKo, ""),
    topic: normalizeTalkTopic(o.topic),
    turns,
    explanations,
    startedAt,
    endedAt: strOr(o.endedAt, startedAt),
    durationSec: Math.max(0, intOr(o.durationSec, 0)),
    childTurnCount: childTurnCount(turns),
    model: strOr(o.model, ""),
    voice: strOr(o.voice, ""),
    // §12-6 — 이 필드들이 생기기 전의 기록(없음)은 빈 카드·그림 없음으로 읽는다
    cards,
    sceneImageId,
    sceneEn: sceneImageId === null ? null : strOrNull(o.sceneEn),
    createdAt,
    sortIndex: typeof o.sortIndex === "number" && Number.isFinite(o.sortIndex) ? o.sortIndex : null,
  };
}

/** 주제 일러스트 한 장 방어 정규화(§12-6 — 두 백엔드 공유). 없는 키는 빈 문자열(이미지 라우트가 data URL 모양을 다시 본다). */
export function normalizeTalkImageRecord(d: unknown): TalkImageRecord {
  const o = isRec(d) ? d : {};
  return {
    id: strOr(o.id, ""),
    dataUrl: strOr(o.dataUrl, ""),
    sceneEn: strOr(o.sceneEn, ""),
    model: strOr(o.model, ""),
    createdAt: strOr(o.createdAt, new Date(0).toISOString()),
  };
}

/** 설명의 키 — (turnIndex, sentenceIndex) */
export function talkExplanationKey(turnIndex: number, sentenceIndex: number): string {
  return `${turnIndex}:${sentenceIndex}`;
}

/** 대화 기록에서 그 문장의 설명을 찾는다(없으면 null) */
export function findTalkExplanation(
  record: Pick<TalkSessionRecord, "explanations">,
  turnIndex: number,
  sentenceIndex: number,
): TalkExplanation | null {
  return record.explanations.find((e) => e.turnIndex === turnIndex && e.sentenceIndex === sentenceIndex) ?? null;
}

/**
 * 설명 추가 판정(순수) — 원자 단위(파일 mutate / Firestore 트랜잭션) **안에서** 최신 레코드로 부른다.
 * - exists: 같은 키가 이미 있다 → 쓰지 않고 그 설명을 돌려준다(두 번 탭해도 한 번 저장 — 먼저 저장된 것이 이긴다)
 * - full: 설명이 상한(TALK_LIMITS.explanations)만큼 있다 → 쓰지 않는다
 * - added: 맨 뒤에 붙인 새 레코드
 */
export type TalkExplanationDecision =
  | { outcome: "added"; record: TalkSessionRecord; explanation: TalkExplanation }
  | { outcome: "exists"; record: TalkSessionRecord; explanation: TalkExplanation }
  | { outcome: "full"; record: TalkSessionRecord };

export function decideTalkExplanation(record: TalkSessionRecord, explanation: TalkExplanation): TalkExplanationDecision {
  const existing = findTalkExplanation(record, explanation.turnIndex, explanation.sentenceIndex);
  if (existing) return { outcome: "exists", record, explanation: existing };
  if (record.explanations.length >= TALK_LIMITS.explanations) return { outcome: "full", record };
  const next = normalizeTalkSessionRecord({ ...record, explanations: [...record.explanations, explanation] });
  const saved = findTalkExplanation(next, explanation.turnIndex, explanation.sentenceIndex);
  // normalize가 설명을 버렸다면(모양이 틀린 입력 — 라우트가 zod를 거친 값만 넘기므로 실제로는 없다) 쓰지 않는다
  if (!saved) return { outcome: "full", record };
  return { outcome: "added", record: next, explanation: saved };
}
