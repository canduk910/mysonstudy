/**
 * lib/toeic-frame-drill-view.ts — 소재별 틀 말하기 **화면 판단** 순수 함수 (docs/harness/toeic.md §20-1·§20-7, SPEC §20-17)
 *
 * 화면(폴더 탭·진행·결과)이 같은 판단을 한 벌 더 갖지 않게 여기 둔다. eval이 그대로 부른다.
 * - 탭 자료: 폴더(Q5–7·Q11) 소재 → 틀 목록(문항 수·오답률) · 질문 유형 · 범위 문항 수.
 * - 지난 판 요약(목록 한 줄).
 * - 진행: 녹음을 전사로 보낼지(무응답 판정이 믿을 만한가) · 전사 응답 → 문항 결과.
 *
 * ⚠️ 클라이언트·eval 안전: 런타임 import는 ./toeic-frame-drill·./toeic-text뿐. store·lib/ai·openai·zod 값 import 금지, lookbehind 금지.
 */

import {
  TOEIC_FRAME_DRILL_MAX_ANSWER_MS,
  frameDrillFramesForPart,
  frameDrillOutcomeOf,
  frameDrillScopeFrameKeys,
  frameDrillSessionCounts,
  frameDrillTopicsForPart,
  frameDrillQuestionTypesForPart,
  frameDrillWrongRate,
  type ToeicFrameDrillBank,
  type ToeicFrameDrillOutcome,
  type ToeicFrameDrillPart,
  type ToeicFrameDrillQuestionType,
  type ToeicFrameDrillSession,
  type ToeicFrameDrillStat,
  type ToeicFrameDrillVoiceEnd,
} from "./toeic-frame-drill";

// ===========================================================================
// 폴더 탭 자료(서버 페이지가 만들어 props로)
// ===========================================================================

export interface ToeicFrameDrillTabFrame {
  key: string;
  topicKey: string;
  frameEn: string;
  frameKo: string;
  useKo: string | null;
  questionTypes: string[];
  /** 이 틀의 은행 문항 수 */
  itemCount: number;
  /** 이 틀 문항 중 한 번이라도 연습한 문항의 평균 오답률(없으면 null) */
  wrongRate: number | null;
}

export interface ToeicFrameDrillTabTopic {
  key: string;
  nameKo: string;
  frames: ToeicFrameDrillTabFrame[];
}

export interface ToeicFrameDrillRecent {
  id: string;
  startedAt: string;
  ended: "done" | "quit";
  topicNamesKo: string[];
  total: number;
  answered: number;
  correct: number;
  close: number;
  wrong: number;
  /** 판정을 받았는가(아니면 결과 화면이 판정을 요청한다) */
  judged: boolean;
}

export interface ToeicFrameDrillTabData {
  part: ToeicFrameDrillPart;
  /** none = 은행 문서 없음(가져오기 먼저) · broken = 있는데 깨졌다 · empty = 이 폴더 틀이 0 · ready */
  bankState: "none" | "broken" | "empty" | "ready";
  topics: ToeicFrameDrillTabTopic[];
  questionTypes: ToeicFrameDrillQuestionType[];
  recent: ToeicFrameDrillRecent[];
  /** 은행 전체 문항 수(이 폴더 밖 포함) */
  bankItems: number;
}

/** 지난 판 목록 상한 */
export const TOEIC_FRAME_DRILL_RECENT_MAX = 10;

/** 평균 오답률(시도 ≥1 문항만) — 없으면 null */
function meanWrongRate(ids: readonly string[], stats: Readonly<Record<string, ToeicFrameDrillStat>>): number | null {
  const rates = ids.map((id) => frameDrillWrongRate(stats[id])).filter((r): r is number => r !== null);
  return rates.length > 0 ? rates.reduce((s, r) => s + r, 0) / rates.length : null;
}

/** 폴더 탭 자료 — 서버 페이지가 은행·통계·판 목록으로 만든다(교재 유래 글은 그 페이지에만) */
export function buildFrameDrillTabData(args: {
  part: ToeicFrameDrillPart;
  bank: ToeicFrameDrillBank | null;
  bankExists: boolean;
  stats: Readonly<Record<string, ToeicFrameDrillStat>>;
  sessions: readonly (ToeicFrameDrillSession & { id: string })[];
}): ToeicFrameDrillTabData {
  const { part, bank, stats } = args;
  const topicName = new Map((bank?.topics ?? []).map((t) => [t.key, t.nameKo] as const));
  const recent: ToeicFrameDrillRecent[] = args.sessions
    .filter((s) => s.part === part)
    .slice(0, TOEIC_FRAME_DRILL_RECENT_MAX)
    .map((s) => {
      const c = frameDrillSessionCounts(s.items);
      return {
        id: s.id,
        startedAt: s.startedAt,
        ended: s.ended,
        topicNamesKo: s.topicKeys.map((k) => topicName.get(k)).filter((n): n is string => n !== undefined),
        total: c.total,
        answered: c.answered,
        correct: c.correct,
        close: c.close,
        wrong: c.wrong,
        judged: s.review !== null,
      };
    });
  if (!bank) {
    return { part, bankState: args.bankExists ? "broken" : "none", topics: [], questionTypes: [], recent, bankItems: 0 };
  }
  const idsByFrame = new Map<string, string[]>();
  for (const it of bank.items) {
    const a = idsByFrame.get(it.frameKey);
    if (a) a.push(it.id);
    else idsByFrame.set(it.frameKey, [it.id]);
  }
  const topics: ToeicFrameDrillTabTopic[] = frameDrillTopicsForPart(bank, part).map((v) => ({
    key: v.topic.key,
    nameKo: v.topic.nameKo,
    frames: v.frames.map((f) => {
      const ids = idsByFrame.get(f.key) ?? [];
      return {
        key: f.key,
        topicKey: f.topicKey,
        frameEn: f.frameEn,
        frameKo: f.frameKo,
        useKo: f.useKo,
        questionTypes: [...f.questionTypes],
        itemCount: ids.length,
        wrongRate: meanWrongRate(ids, stats),
      };
    }),
  }));
  return {
    part,
    bankState: frameDrillFramesForPart(bank, part).length === 0 ? "empty" : "ready",
    topics,
    questionTypes: frameDrillQuestionTypesForPart(bank, part),
    recent,
    bankItems: bank.items.length,
  };
}

/**
 * 고르기 → 범위 틀 key와 범위 문항 수(화면 표시 — 시작 버튼을 막을지). 범위 판정은 순수 층 frameDrillScopeFrameKeys 그대로
 * (탭 자료에서 틀·질문 유형만 가진 은행 모양을 만들어 부른다 — 같은 규칙을 두 벌 갖지 않는다).
 */
export function frameDrillTabScope(
  data: Pick<ToeicFrameDrillTabData, "part" | "topics" | "questionTypes">,
  sel: { topicKeys: readonly string[]; excludedFrameKeys: readonly string[]; questionTypeKeys: readonly string[] },
): { frameKeys: string[]; itemCount: number } {
  const frames = data.topics.flatMap((t) => t.frames);
  const pseudo: ToeicFrameDrillBank = {
    presetKey: "",
    topics: data.topics.map((t) => ({ key: t.key, nameKo: t.nameKo })),
    questionTypes: data.questionTypes,
    frames: frames.map((f) => ({ ...f, parts: [data.part], bankKey: null, sources: [], fillOptions: [] })),
    items: [],
    updatedAt: "",
  };
  const frameKeys = frameDrillScopeFrameKeys(pseudo, data.part, sel.topicKeys, sel.excludedFrameKeys, sel.questionTypeKeys);
  const counts = new Map(frames.map((f) => [f.key, f.itemCount] as const));
  return { frameKeys, itemCount: frameKeys.reduce((s, k) => s + (counts.get(k) ?? 0), 0) };
}

// ===========================================================================
// 진행 — 녹음을 전사로 보낼지 · 전사 응답 → 결과
// ===========================================================================

/** 녹음이 이보다 짧으면 보내지 않는다(틀 테스트와 같은 0.6초 — 딸깍 한 번) */
export const TOEIC_FRAME_DRILL_SEND_MIN_MS = 600;

/**
 * 말 끝 판정이 끝난 녹음을 전사로 보낼까. 보내지 않으면 그 문항은 무응답(no_speech — 비용 0).
 * - "다 말했어요"(manual)·silence·max → 보낸다(녹음이 0.6초 이상이면).
 * - no_speech → 레벨 표본이 **모두 믿을 만했을 때만** 보내지 않는다. 믿을 수 없는 표본이 있었으면(분석기 없음·컨텍스트 멈춤) 무음을
 *   알 수 없으니 보내서 전사 낱말 수로 가른다(멈춘 분석기의 0으로 말한 답을 버리지 않게 — §20-7 reliable 관용구).
 */
export function frameDrillShouldSend(args: { end: ToeicFrameDrillVoiceEnd | "manual"; sawUnreliable: boolean; durationMs: number }): boolean {
  if (args.durationMs < TOEIC_FRAME_DRILL_SEND_MIN_MS) return false;
  if (args.end === "no_speech") return args.sawUnreliable;
  return true;
}

/** 녹음기 안전 상한 — 상태 기계 상한(20초)에 표본 간격 여유를 더한 타이머(표본이 멈춰도 녹음이 끝나게) */
export const TOEIC_FRAME_DRILL_REC_HARD_STOP_MS = TOEIC_FRAME_DRILL_MAX_ANSWER_MS + 500;

/**
 * 전사 응답 → 문항 결과. ok면 frameDrillOutcomeOf(text) — 단어 < 2면 no_speech. 키 없음·실패·시간 초과는 transcribe_failed.
 * 보내지 않은 문항(sent=false)은 no_speech.
 */
export function frameDrillItemResult(r: { sent: false } | { sent: true; ok: true; text: string } | { sent: true; ok: false }): {
  outcome: ToeicFrameDrillOutcome;
  transcript: string | null;
} {
  if (!r.sent) return { outcome: "no_speech", transcript: null };
  if (!r.ok) return frameDrillOutcomeOf(null, true);
  return frameDrillOutcomeOf(r.text, false);
}
