/**
 * lib/store-firestore.ts — `StudyStore`의 Firestore(Native mode) 구현 (M3·M4)
 *
 * - 컬렉션: books / cards / readings (SPEC §5 필드 그대로 + M1의 추가 필드
 *   coverEmoji·description — 빌드 리포트 M1 §5-2 근거 참조) + explanations
 *   (수학 설명 기록 — math.md §9-1 필드 그대로) … + workoutCycles(아빠의 운동 — SPEC §19-4,
 *   변경 3개만 runTransaction — 이유는 해당 메서드 위 주석)
 * - 인증: Admin SDK + ADC(Application Default Credentials).
 *   Cloud Run에서는 서비스 계정, 로컬에서는 GOOGLE_APPLICATION_CREDENTIALS 키 파일.
 * - 날짜: 파일 스토어와 동일하게 ISO 8601 "문자열"로 저장한다 — 인터페이스가
 *   string을 쓰므로 Timestamp 변환 계층을 두지 않는 편이 단순하다. ISO 문자열은
 *   사전순 = 시간순이라 orderBy도 그대로 동작한다. (손으로 넣은 Timestamp 문서도
 *   읽을 수 있게 읽기 쪽에서만 방어 변환한다)
 * - 쿼리: 복합 인덱스가 필요한 where+orderBy 조합을 피한다 — 필터만 Firestore에
 *   맡기고 정렬·정규화 비교는 메모리에서 한다(가족용 소규모 데이터, 문서 수십 건).
 *
 * 서버 전용 모듈 — 클라이언트 컴포넌트에서 import 금지 (firebase-admin은
 * Next의 기본 serverExternalPackages 목록에 있어 서버 번들에서도 native require).
 */

import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import {
  getFirestore,
  Timestamp,
  type CollectionReference,
  type DocumentData,
  type Firestore,
} from "firebase-admin/firestore";
import { normalizeJaVocabEntry } from "./ai/japanese/vocab";
import type { JaDialogCoaching, JaVocabEntry } from "./ai/japanese/schemas";
import {
  applyVocabLink,
  normalizeJaDialogRecord,
  normalizeJaKanji,
  normalizeJaQuizItem,
  normalizeJaVocabBook,
  normalizeProblem,
  normalizeTitleAuthorKey,
  normalizeVocabEntry,
  normalizeVocabQuizItem,
  JA_COLLECTED_VOCAB_TITLE_KO,
  type AppendJaVocabResult,
  type DeleteJaVocabBookResult,
  type JaDialogRecord,
  type JaKanjiQuizRecord,
  type JaKanjiRecord,
  type JaQuizRecord,
  type JaVocabBookRecord,
  type NewJaDialog,
  type NewJaKanji,
  type NewJaKanjiQuiz,
  type NewJaQuiz,
  type NewJaVocabBook,
  type LegacyOrNewVocabEntry,
  type AppendVocabEntryResult,
  type VocabLinkInput,
  type VocabLinkOp,
  type VocabLinkResult,
  type BookEvidencePatch,
  type BookRecord,
  type CardRecord,
  type CardWithBook,
  type DeleteBookResult,
  type DeleteVocabBookResult,
  type ExplanationRecord,
  type MathProblemInput,
  type NewBook,
  type NewCard,
  type NewExplanation,
  type NewReading,
  type NewVocabBook,
  type NewVocabQuiz,
  type ReadingRecord,
  type StudyStore,
  type VocabBookRecord,
  type VocabQuizItem,
  type VocabQuizRecord,
  type LogWorkoutInput,
  type StartWorkoutInput,
  type StartWorkoutResult,
  type UndoWorkoutInput,
  type WorkoutMutationResult,
  applyAttemptAnswer,
  applyAttemptFinish,
  type DeleteToeicResult,
  type FinishToeicAttemptInput,
  type FinishToeicAttemptResult,
  type ImportToeicSetsResult,
  type MergeToeicSetPointsResult,
  type FillToeicMockPartResult,
  type MarkToeicPictureImageFailedResult,
  type SaveToeicPictureImageInput,
  type SaveToeicPictureImageResult,
  type NewToeicAttempt,
  type NewToeicMock,
  type NewToeicQuiz,
  type NewToeicSet,
  type ToeicAnswerScorePatch,
  type ToeicAttemptRecord,
  type ToeicImageRecord,
  type ToeicMockRecord,
  type ToeicQuizRecord,
  type ToeicSetRecord,
  type AddTalkExplanationResult,
  type CreateTalkSessionResult,
  type DeleteTalkSessionResult,
  type NewTalkSceneImage,
  type NewTalkSession,
  type TalkImageRecord,
  type TalkSessionRecord,
} from "./store";
// 은우 자유대화(english.md §12-4·§12-6) — 정규화·설명 추가 판정은 파일 백엔드와 **같은 함수**(두 백엔드가 안 갈린다).
import { decideTalkExplanation, normalizeTalkImageRecord, normalizeTalkSessionRecord } from "./talk-normalize";
import type { TalkExplanation } from "./ai/english/talk-schemas";
// 아빠의 영어(toeic.md §7) — 정규화·포인트 병합은 파일 백엔드와 **같은 함수**(두 백엔드가 안 갈린다). openai 없음(zod만).
import {
  normalizeToeicAttemptRecord,
  normalizeToeicImageRecord,
  normalizeToeicMockRecord,
  normalizeToeicQuizItem,
  normalizeToeicQuizRecord,
  normalizeToeicSetRecord,
} from "./toeic-normalize";
import { applyPointsResults } from "./ai/toeic/points";
import type { ToeicMockPartRecordMap, ToeicPointsItem } from "./ai/toeic/schemas";
import type { ToeicMockPart } from "./toeic-mock";
// 모의고사 파트 채우기·사진 저장 판정 — 파일 백엔드와 같은 순수 함수(lib/toeic-mock-apply.ts)
import { applyFillPart, applyPictureImage, decideFillPart, decidePictureImage } from "./toeic-mock-apply";
// 응시 끝/그만두기는 한 번만 — 파일 백엔드와 같은 판정(lib/toeic-attempt-rules.ts)
import { decideAttemptFinish } from "./toeic-attempt-rules";
// 아빠의 운동(§19-4) — 판정·정규화는 파일 백엔드(store.ts)와 **같은 순수 함수**라 두 백엔드가 안 갈린다(런타임 의존성 ./kst뿐).
import { decideLog, decideStart, decideUndo, normalizeWorkoutCycle, type WorkoutCycleRecord } from "./workout";
// 단어장 보강(V3) 저장이 받는 완성형 entry 타입 — store는 VocabEntry를 재수출하지 않는다.
import type { VocabEntry } from "./ai/english/vocabbook-schemas";
// enriched 재계산의 단일 정의처(V8) — file 백엔드(store.ts)와 같은 함수로 두 백엔드가 안 갈린다.
import { isVocabBookEnriched } from "./ai/english/vocabbook-enrich";
// "모은 단어" 수집 단어장 마커(dayLabel)·초기 이름(M2) — file 백엔드와 같은 상수로 두 백엔드가 안 갈린다.
import { COLLECTED_VOCAB_DAY_LABEL, COLLECTED_VOCAB_TITLE_KO } from "./collected-vocab-contract";
// 시험(V4) 모드 상수 — 읽기 방어에서 미지 모드를 안전 폴백하는 데 쓴다(순수 모듈, 값 import 안전).
import { VOCAB_QUIZ_MODES } from "./vocab-quiz";
// 설명 기록(M4)이 안는 타입 — 값 import는 `SCENE_TIERS` 하나뿐이다(읽기 방어용 상수).
import type { ExplainVerifyReport } from "./ai/math/pipeline";
import type { Explanation } from "./ai/math/schemas";
import { SCENE_TIERS, type SceneTier } from "./scene/types";
import type { Chapter, ChapterSentence } from "./ai/english/schemas";
import {
  normalizeSceneDigest,
  type Card,
  type SceneDigestItem,
  type SceneSourceKind,
} from "./ai/english/schemas";
// store.ts는 이 파일을 값으로 import하므로(FirestoreStore), 가드는 별도 모듈에 둔다 — 순환 방지
import { assertDestructiveAllowed } from "./prod-guard";
import { isFirestoreDocId } from "./reorder-contract";

// ---------------------------------------------------------------------------
// Admin SDK 초기화 — 지연 + 중복 방지 (dev HMR에서 앱이 이미 있으면 재사용)
// ---------------------------------------------------------------------------

let dbCache: Firestore | null = null;

function getDb(): Firestore {
  if (!dbCache) {
    const app = getApps()[0] ?? initializeApp({ credential: applicationDefault() });
    dbCache = getFirestore(app);
  }
  return dbCache;
}

// ---------------------------------------------------------------------------
// 문서 → 레코드 변환 (읽기 방어: 누락 필드는 null, Timestamp는 ISO 문자열로)
// ---------------------------------------------------------------------------

function toIso(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  return new Date(0).toISOString();
}

function toNullable<T>(v: T | null | undefined): T | null {
  return v ?? null;
}

/**
 * 저장된 장면 메모 읽기 방어 — 이 필드가 없던 시절의 문서를 읽으면 undefined다.
 * 배열이 아니면 null로 내리고, 배열이면 선택 키의 undefined를 null로 정규화한다
 * (다시 쓸 때 Firestore가 undefined를 거부하는 것을 읽기 단계에서 미리 막는다).
 */
function toSceneDigest(v: unknown): SceneDigestItem[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  return normalizeSceneDigest(v as SceneDigestItem[]);
}

function toSceneKind(v: unknown): SceneSourceKind | null {
  return v === "toc" || v === "pages" ? v : null;
}

/**
 * 저장된 챕터 리더 읽기 방어 — 챕터화(호출 F) 이전 문서에는 이 필드가 없다(undefined → null).
 * Chapter/ChapterSentence는 선택 키가 없지만(Firestore undefined 거부 위험 없음), 문서가
 * 손상된 경우를 대비해 문자열/불리언으로 좁혀 다시 굳힌다. 배열이 아니면 null로 내린다.
 */
function toChapters(v: unknown): Chapter[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  return v.map((ch): Chapter => {
    const c = ch as Partial<Chapter>;
    const sentences = Array.isArray(c.sentences)
      ? c.sentences.map((se): ChapterSentence => {
          const s = se as Partial<ChapterSentence>;
          return { en: String(s.en ?? ""), ko: String(s.ko ?? "") };
        })
      : [];
    return {
      titleEn: String(c.titleEn ?? ""),
      matched: Boolean(c.matched),
      sentences,
    };
  });
}

function toBook(id: string, d: DocumentData): BookRecord {
  return {
    id,
    title: String(d.title ?? ""),
    author: String(d.author ?? "미상"),
    series: toNullable(d.series as string | null),
    isbn: toNullable(d.isbn as string | null),
    arLevel: toNullable(d.arLevel as number | null),
    lexile: toNullable(d.lexile as number | null),
    wordCount: toNullable(d.wordCount as number | null),
    arQuizNo: toNullable(d.arQuizNo as string | null),
    isFiction: Boolean(d.isFiction),
    topic: String(d.topic ?? ""),
    coverUrl: toNullable(d.coverUrl as string | null),
    googleBooksId: toNullable(d.googleBooksId as string | null),
    coverEmoji: toNullable(d.coverEmoji as string | null),
    description: toNullable(d.description as string | null),
    levelEstimated: Boolean(d.levelEstimated),
    createdAt: toIso(d.createdAt),
    // 줄거리 근거 3필드 — 이 필드들이 없던 기존 문서는 전부 null로 읽힌다(하위 호환)
    blurbText: toNullable(d.blurbText as string | null),
    sceneKind: toSceneKind(d.sceneKind),
    sceneDigest: toSceneDigest(d.sceneDigest),
    // 유튜브 낭독 자막 근거 — transcript grounding 이전 문서는 null로 읽힌다(하위 호환)
    transcript: toNullable(d.transcript as string | null),
    youtubeUrl: toNullable(d.youtubeUrl as string | null),
    // 챕터 리더(호출 F) — 챕터화 이전 문서는 null로 읽힌다(하위 호환)
    chapters: toChapters(d.chapters),
    // 수동 정렬 인덱스 — 이 필드가 없던 기존 문서는 null(=미정렬, 맨 위)로 읽힌다(하위 호환)
    sortIndex: toNullable(d.sortIndex as number | null),
  };
}

function toCard(id: string, d: DocumentData): CardRecord {
  return {
    id,
    bookId: String(d.bookId ?? ""),
    content: d.content as Card, // 쓰기 시 zod 통과분만 저장된다 (/api/card)
    model: String(d.model ?? ""),
    createdAt: toIso(d.createdAt),
  };
}

/**
 * 설명 기록 읽기 방어 (M4).
 *
 * `problem`·`content`·`verify`는 **쓰기 시 zod·파이프라인을 통과한 값만** 저장되므로
 * `toCard`가 `content`를 다루는 것과 같은 방식으로 캐스팅한다. 문서마다 다시 검증하면
 * 목록 한 번에 수백 번 zod를 돌리게 되고, 그래 봐야 고칠 수 있는 것이 없다.
 * 스칼라 필드만 누락·오염을 흡수한다 — 그 자리는 화면이 곧바로 쓰는 값이라서다.
 */
function toSceneTier(v: unknown): SceneTier {
  return (SCENE_TIERS as readonly string[]).includes(v as string) ? (v as SceneTier) : "none";
}

function toExplanation(id: string, d: DocumentData): ExplanationRecord {
  return {
    id,
    problem: d.problem as MathProblemInput,
    content: d.content as Explanation,
    sceneHtml: toNullable(d.sceneHtml as string | null),
    sceneTier: toSceneTier(d.sceneTier),
    verify: d.verify as ExplainVerifyReport,
    model: String(d.model ?? ""),
    createdAt: toIso(d.createdAt),
    // 수동 정렬 이전 문서는 null(=미정렬)로 읽힌다(하위 호환, toBook과 같은 방어)
    sortIndex: toNullable(d.sortIndex as number | null),
  };
}

function toReading(id: string, d: DocumentData): ReadingRecord {
  return {
    id,
    bookId: String(d.bookId ?? ""),
    readAt: toIso(d.readAt),
    rating: toNullable(d.rating as number | null),
    noteKo: toNullable(d.noteKo as string | null),
  };
}

/**
 * 단어장 읽기 방어 (V1). `entries`는 **쓰기 시 zod·정규화를 통과한 값만** 저장되므로
 * `toCard`가 `content`를 다루듯 통째로 캐스팅하되, `normalizeVocabEntry`를 한 번 더 태운다 —
 * 이 필드가 없던 시절(혹은 손으로 넣은) 문서를 읽으면 undefined가 섞여 있을 수 있고, 그대로
 * 다시 쓰면 Firestore가 거부한다. 배열이 아니면 빈 배열로 내린다(표가 `.map`을 태우는 자리).
 */
function toVocabBook(id: string, d: DocumentData): VocabBookRecord {
  const entries = Array.isArray(d.entries)
    ? // 옛 문서는 meanings 대신 meaningsKo를 갖는다 — 느슨한 타입으로 받아 normalizeVocabEntry가 승격한다
      (d.entries as LegacyOrNewVocabEntry[]).map(normalizeVocabEntry)
    : [];
  return {
    id,
    titleKo: String(d.titleKo ?? ""),
    dayLabel: toNullable(d.dayLabel as string | null),
    entries,
    photoCount: typeof d.photoCount === "number" ? d.photoCount : 0,
    enriched: Boolean(d.enriched),
    model: String(d.model ?? ""),
    createdAt: toIso(d.createdAt),
    // 수동 정렬 이전 문서는 null(=미정렬)로 읽힌다(하위 호환, toBook과 같은 방어)
    sortIndex: toNullable(d.sortIndex as number | null),
  };
}

function byCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}
/** createdAt 오름차순(수집 순서) — 한자 목록(JK). 파일 백엔드와 같은 규약. */
function byCreatedAtAsc(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/**
 * 일본어 단어장 읽기 방어 변환 (아빠의 일본어 §7-1) — `toCard`가 content를 다루듯 통째로 담되, 파일 백엔드와
 * **같은 함수**(normalizeJaVocabBook)를 한 번 더 태운다(두 백엔드가 안 갈리게). createdAt은 toIso로 조인다.
 */
function toJaVocabBook(id: string, d: DocumentData): JaVocabBookRecord {
  return normalizeJaVocabBook({ ...(d as JaVocabBookRecord), id, createdAt: toIso(d.createdAt) });
}

/** 대화 복습 읽기 방어 변환(J3) — normalizeJaDialogRecord로 조인다(파일 백엔드와 같은 규약). */
function toJaDialog(id: string, d: DocumentData): JaDialogRecord {
  return normalizeJaDialogRecord({ ...(d as JaDialogRecord), id, createdAt: toIso(d.createdAt) });
}

/**
 * 운동 사이클 읽기 방어 변환(§19-4) — 파일 백엔드와 **같은 함수**(normalizeWorkoutCycle)로 조인다. 엔진 정규화는
 * 문자열 시각만 인정하므로, 손으로 넣은 Timestamp 문서도 읽히게 createdAt·endedAt을 toIso로 먼저 바꾼다.
 */
function toWorkoutCycle(id: string, d: DocumentData): WorkoutCycleRecord {
  return normalizeWorkoutCycle({
    ...d,
    id,
    createdAt: toIso(d.createdAt),
    endedAt: d.endedAt == null ? null : toIso(d.endedAt),
  });
}

/**
 * 운동 사이클 저장 본문 — 저장 계층이 마지막 관문이라 normalizeWorkoutCycle을 한 번 더 태워 undefined를 없애고
 * (Firestore는 undefined를 거부한다 — failed·endedAt은 반드시 null), 문서 ID가 곧 id라 본문에서 뺀다.
 */
function workoutCycleData(record: WorkoutCycleRecord): Omit<WorkoutCycleRecord, "id"> {
  const { id: _id, ...data } = normalizeWorkoutCycle(record);
  return data;
}

// ---- 아빠의 영어(toeic.md §7) 읽기 변환·쓰기 본문 — 파일 백엔드와 같은 정규화(lib/toeic-normalize.ts). ----
// 읽기: 손으로 넣은 Timestamp 문서도 읽히게 시각을 toIso로 먼저 바꾼다. 쓰기: normalize를 한 번 더 태워 undefined를 없애고
// (Firestore 거부), 문서 ID가 곧 id라 본문에서 뺀다(workoutCycleData 관용구).

function toToeicSet(id: string, d: DocumentData): ToeicSetRecord {
  return normalizeToeicSetRecord({ ...d, id, createdAt: toIso(d.createdAt) });
}
function toeicSetData(r: ToeicSetRecord): Omit<ToeicSetRecord, "id"> {
  const { id: _id, ...data } = normalizeToeicSetRecord(r);
  return data;
}
/** 모르는 mode면 null — 호출측이 버린다(모드별 숙련도 무오염, §6-2). */
function toToeicQuiz(id: string, d: DocumentData): ToeicQuizRecord | null {
  return normalizeToeicQuizRecord({ ...d, id, startedAt: toIso(d.startedAt) });
}
function toToeicMock(id: string, d: DocumentData): ToeicMockRecord {
  return normalizeToeicMockRecord({ ...d, id, createdAt: toIso(d.createdAt) });
}
function toeicMockData(r: ToeicMockRecord): Omit<ToeicMockRecord, "id"> {
  const { id: _id, ...data } = normalizeToeicMockRecord(r);
  return data;
}
function toToeicImage(id: string, d: DocumentData): ToeicImageRecord {
  return normalizeToeicImageRecord({ ...d, id, createdAt: toIso(d.createdAt) });
}
function toToeicAttempt(id: string, d: DocumentData): ToeicAttemptRecord {
  return normalizeToeicAttemptRecord({ ...d, id, startedAt: toIso(d.startedAt) });
}
function toeicAttemptData(r: ToeicAttemptRecord): Omit<ToeicAttemptRecord, "id"> {
  const { id: _id, ...data } = normalizeToeicAttemptRecord(r);
  return data;
}

// ---- 은우 자유대화(english.md §12-4·§12-6) 읽기 변환·쓰기 본문 — 파일 백엔드와 같은 정규화(lib/talk-normalize.ts). ----
// 시각 필드는 손으로 넣은 Timestamp 문서도 읽히게 있을 때만 toIso로 바꾼다(없으면 정규화가 createdAt으로 채운다).

function isoIfPresent(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : toIso(v);
}
function toTalkSession(id: string, d: DocumentData): TalkSessionRecord {
  return normalizeTalkSessionRecord({
    ...d,
    id,
    createdAt: toIso(d.createdAt),
    startedAt: isoIfPresent(d.startedAt),
    endedAt: isoIfPresent(d.endedAt),
  });
}
function talkSessionData(r: TalkSessionRecord): Omit<TalkSessionRecord, "id"> {
  const { id: _id, ...data } = normalizeTalkSessionRecord(r);
  return data;
}
function toTalkImage(id: string, d: DocumentData): TalkImageRecord {
  return normalizeTalkImageRecord({ ...d, id, createdAt: toIso(d.createdAt) });
}

/** 한자 정보 읽기 방어 변환(JK) — normalizeJaKanji로 조인다(파일 백엔드와 같은 규약). */
function toJaKanji(id: string, d: DocumentData): JaKanjiRecord {
  return normalizeJaKanji({ ...(d as JaKanjiRecord), id, createdAt: toIso(d.createdAt) });
}

/** 한자 시험 세션 읽기 방어 변환(JK) — items는 normalizeJaQuizItem으로 조인다. */
function toJaKanjiQuiz(id: string, d: DocumentData): JaKanjiQuizRecord {
  return {
    id,
    scope: "kanji",
    mode: d.mode as JaKanjiQuizRecord["mode"],
    startedAt: toIso(d.startedAt),
    finishedAt: toNullable(d.finishedAt as string | null),
    items: Array.isArray(d.items) ? d.items.map(normalizeJaQuizItem) : [],
  };
}

/** 일본어 시험 세션 읽기 방어 변환(J2) — items는 normalizeJaQuizItem으로 조인다(파일 백엔드와 같은 규약, toVocabQuiz 선례). */
function toJaQuiz(id: string, d: DocumentData): JaQuizRecord {
  const items = Array.isArray(d.items) ? d.items.map(normalizeJaQuizItem) : [];
  return {
    id,
    bookId: String(d.bookId ?? ""),
    // 미지값(옛/손입력)은 안전 폴백 없이 그대로 — JaQuizMode 유효성은 저장 라우트 zod가 보장한다.
    mode: d.mode as JaQuizRecord["mode"],
    startedAt: toIso(d.startedAt),
    finishedAt: toNullable(d.finishedAt as string | null),
    items,
  };
}

/** 시험 세션 정렬 — startedAt 오름차순(오래된 순). 파일 백엔드와 같은 규약(V5 streak가 이 순서를 읽는다) */
function byStartedAtAsc(a: { startedAt: string }, b: { startedAt: string }): number {
  return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
}

/**
 * 시험 세션 읽기 방어 (V4). `items`는 쓰기 시 `normalizeVocabQuizItem`을 통과하지만, 이 필드가
 * 없던 시절(혹은 손으로 넣은) 문서를 읽으면 undefined가 섞일 수 있어 한 번 더 조인다(toVocabBook과 같은 규약).
 * `finishedAt`은 완료면 ISO, 부분 결과면 null이다 — toNullable로 undefined를 null로 떨군다.
 */
function toVocabQuiz(id: string, d: DocumentData): VocabQuizRecord {
  const items = Array.isArray(d.items)
    ? (d.items as Partial<VocabQuizItem>[]).map(normalizeVocabQuizItem)
    : [];
  return {
    id,
    bookId: String(d.bookId ?? ""),
    // 미지값(옛/손입력 문서)은 기본 모드(def-to-word)로 안전 폴백한다
    mode: (VOCAB_QUIZ_MODES as readonly string[]).includes(d.mode as string)
      ? (d.mode as VocabQuizRecord["mode"])
      : "def-to-word",
    startedAt: toIso(d.startedAt),
    finishedAt: toNullable(d.finishedAt as string | null),
    items,
  };
}

/**
 * 한 배치에 담는 최대 작업 수. Firestore WriteBatch의 상한은 500 —
 * 가족용 규모(책당 카드 몇 장·기록 수십 건)에서는 넘칠 일이 없지만,
 * 넘치면 커밋 전체가 실패하므로 여유를 두고 나눠 커밋한다.
 */
const BATCH_LIMIT = 450;

// ---------------------------------------------------------------------------
// 목록 수동 정렬 — 다섯 reorder<X>의 공유 본체 (SPEC §15-1)
// ---------------------------------------------------------------------------

/** gRPC NOT_FOUND — `update` 대상 문서가 없으면 commit이 이 코드로 **배치 전체를** 거부한다. */
const GRPC_NOT_FOUND = 5;
/** gRPC ALREADY_EXISTS — `create` 대상 문서가 이미 있으면 commit이 이 코드로 **배치 전체를** 거부한다(자유대화 저장 멱등). */
const GRPC_ALREADY_EXISTS = 6;

/**
 * reorderBySortIndex가 쓰는 Firestore의 최소 면. 실제 `Firestore`·`WriteBatch`·`CollectionReference`가 구조적으로
 * 만족한다. 에뮬레이터 없이 가짜 db를 주입해 "없는 id 거르기"를 검증하려고 좁혀 둔 것이다(다른 의도는 없다).
 */
export interface SortIndexDb<Ref> {
  /** 결과 순서 = 넘긴 참조 순서(SDK DocumentReader가 요청 순서로 되돌린다). 마지막 인자는 ReadOptions. */
  getAll(...refsOrOptions: Array<Ref | { fieldMask: string[] }>): Promise<Array<{ readonly exists: boolean }>>;
  batch(): {
    update(ref: Ref, data: { sortIndex: number }): unknown;
    commit(): Promise<unknown>;
  };
}

/**
 * 넘어온 id 순서대로 컬렉션 문서의 `sortIndex`를 매긴다 — **존재하는 문서만.** 쓴 문서 수를 돌려준다.
 *
 * 왜 거르나: `WriteBatch.update`는 문서가 없으면 **배치 전체**를 거부한다. 그래서 다른 탭에서 지운 항목이 남은
 * 화면에서 재배치하면 라우트가 500 `save_failed`를 줬다. 계약(`lib/reorder-contract.ts` "존재하지 않는 id는 스토어가
 * 조용히 건너뛴다")과 파일 백엔드(`rank.get(id)`가 있는 레코드만 바꾼다)는 건너뛴다 — 두 백엔드를 여기서 맞춘다.
 *
 * 인덱스 규칙은 파일 백엔드와 **같다**(`new Map(orderedIds.map((id, i) => [id, i]))`): 넘어온 **위치** 그대로 0..n이고,
 * 없는 id의 자리는 당기지 않고 비워 둔다(정렬은 오름차순이라 빈 번호는 무해하다). 같은 id가 두 번 오면 마지막 위치가
 * 이긴다(라우트 zod가 중복을 400으로 막지만 스토어 단독 호출도 같은 결과를 낸다). 목록에 없는 문서는 건드리지 않는다.
 * 수정이라 prod-guard 대상이 아니다.
 */
export async function reorderBySortIndex<Ref>(
  db: SortIndexDb<Ref>,
  col: { doc(id: string): Ref },
  orderedIds: readonly string[],
): Promise<number> {
  const rank = new Map(orderedIds.map((id, i) => [id, i] as const));
  const targets: { ref: Ref; sortIndex: number }[] = [];
  for (const [id, sortIndex] of rank) {
    // Firestore 문서 id가 될 수 없는 id는 존재할 수 없는 문서다 → 건너뛴다(파일 백엔드에서 "없는 id"와 같은 결과).
    // doc()에 넘기면 안 된다 — `"a/"`·`"/a"`는 빈 세그먼트가 버려져 **다른 문서 `a`**를 가리키고, `"a/b"`는 던진다.
    // 판정은 계약과 같은 함수(라우트 zod가 이미 400으로 막는다 — 여기는 스토어 단독 호출의 방어선).
    if (!isFirestoreDocId(id)) continue;
    targets.push({ ref: col.doc(id), sortIndex });
  }
  let written = 0;
  for (let i = 0; i < targets.length; i += BATCH_LIMIT) {
    written += await commitExistingSortIndexes(db, targets.slice(i, i + BATCH_LIMIT));
  }
  return written;
}

/** 한 청크: 존재 확인 → 있는 문서만 batch.update → commit. 확인~커밋 사이에 지워졌으면 한 번만 다시 거른다. */
async function commitExistingSortIndexes<Ref>(
  db: SortIndexDb<Ref>,
  chunk: { ref: Ref; sortIndex: number }[],
  retried = false,
): Promise<number> {
  // sortIndex만 마스크로 받는다 — 존재 여부만 필요하고 본문(챕터·단어 배열)을 내려받을 이유가 없다
  const snaps = await db.getAll(...chunk.map((t) => t.ref), { fieldMask: ["sortIndex"] });
  const live = chunk.filter((_, k) => snaps[k]?.exists === true);
  if (live.length === 0) return 0; // 전부 없다 — 빈 배치는 커밋하지 않는다
  const batch = db.batch();
  for (const t of live) batch.update(t.ref, { sortIndex: t.sortIndex });
  try {
    await batch.commit();
  } catch (err) {
    // 배치는 원자적이라 NOT_FOUND면 아무것도 써지지 않았다. 쓰는 값이 고정이라 다시 걸러 쓰는 것은 멱등이다.
    if (!retried && (err as { code?: unknown } | null)?.code === GRPC_NOT_FOUND) {
      return commitExistingSortIndexes(db, chunk, true);
    }
    throw err;
  }
  return live.length;
}

// ---------------------------------------------------------------------------
// 구현
// ---------------------------------------------------------------------------

export class FirestoreStore implements StudyStore {
  private books(): CollectionReference {
    return getDb().collection("books");
  }
  private cards(): CollectionReference {
    return getDb().collection("cards");
  }
  private readings(): CollectionReference {
    return getDb().collection("readings");
  }
  private explanations(): CollectionReference {
    return getDb().collection("explanations");
  }
  private vocabBooks(): CollectionReference {
    return getDb().collection("vocabBooks");
  }
  private vocabQuizzes(): CollectionReference {
    return getDb().collection("vocabQuizzes");
  }
  private jaVocabBooks(): CollectionReference {
    return getDb().collection("jaVocabBooks");
  }
  private jaQuizzes(): CollectionReference {
    return getDb().collection("jaQuizzes");
  }
  private jaKanji(): CollectionReference {
    return getDb().collection("jaKanji");
  }
  private jaKanjiQuizzes(): CollectionReference {
    return getDb().collection("jaKanjiQuizzes");
  }
  private jaDialogs(): CollectionReference {
    return getDb().collection("jaDialogs");
  }
  private workoutCycles(): CollectionReference {
    return getDb().collection("workoutCycles");
  }
  // 아빠의 영어(toeic.md §7) — 컬렉션 5개. 은우·일본어 컬렉션과 섞지 않는다.
  private toeicSets(): CollectionReference {
    return getDb().collection("toeicSets");
  }
  private toeicQuizzes(): CollectionReference {
    return getDb().collection("toeicQuizzes");
  }
  private toeicMocks(): CollectionReference {
    return getDb().collection("toeicMocks");
  }
  private toeicImages(): CollectionReference {
    return getDb().collection("toeicImages");
  }
  private toeicAttempts(): CollectionReference {
    return getDb().collection("toeicAttempts");
  }
  // 은우 자유대화(english.md §12-4·§12-6) — 은우 단어장 컬렉션과 섞지 않는다
  private talkSessions(): CollectionReference {
    return getDb().collection("talkSessions");
  }
  private talkImages(): CollectionReference {
    return getDb().collection("talkImages");
  }

  async createBook(input: NewBook): Promise<BookRecord> {
    const ref = this.books().doc();
    const record: BookRecord = {
      ...input,
      // 방어적 정규화 — 장면 항목의 선택 키가 undefined면 Firestore가 쓰기를 거부한다.
      // 라우트도 통과시키지만, 저장 계층이 마지막 관문이라 여기서 한 번 더 조인다.
      sceneDigest: input.sceneDigest?.length ? normalizeSceneDigest(input.sceneDigest) : null,
      // 챕터는 신규 book 생성 시엔 항상 null(챕터화는 별도 /api/chapterize 경로) — 방어적으로 좁힌다.
      chapters: toChapters(input.chapters),
      // 신규 책은 미정렬(맨 위)로 시작 — reorderBooks로만 값이 박힌다. Firestore는 undefined를
      // 거부하므로 명시적 null로 쓴다(NewBook엔 이 키가 없다).
      sortIndex: null,
      id: ref.id,
      createdAt: new Date().toISOString(),
    };
    const { id: _id, ...data } = record; // 문서 ID가 곧 id — 본문에 중복 저장하지 않는다
    await ref.set(data);
    return record;
  }

  async reorderBooks(orderedIds: string[]): Promise<void> {
    // 넘어온 순서 = 최종 순서. 각 book 문서의 sortIndex를 0..n으로 갱신한다.
    // **수정이라 prod-guard를 걸지 않는다**(updateBookEvidence와 같은 규약 — 삭제가 아니다).
    // 목록에 없는 book은 건드리지 않고, 없는(지워진) id는 건너뛴다 — reorderBySortIndex(BATCH_LIMIT 단위 커밋).
    await reorderBySortIndex(getDb(), this.books(), orderedIds);
  }

  async getBook(id: string): Promise<BookRecord | null> {
    const snap = await this.books().doc(id).get();
    return snap.exists ? toBook(snap.id, snap.data()!) : null;
  }

  async listBooks(): Promise<BookRecord[]> {
    const snap = await this.books().orderBy("createdAt", "desc").get();
    return snap.docs.map((d) => toBook(d.id, d.data()));
  }

  async findBookByTitleAuthor(title: string, author: string): Promise<BookRecord | null> {
    // Firestore는 대소문자 무시 비교를 못 한다 — 정규화 키 필드를 추가하는 대신
    // (SPEC §5 스키마를 지키기 위해) 전체를 읽어 메모리에서 비교한다. 가족용
    // 소규모 데이터(수십 권)라 충분하다.
    const key = normalizeTitleAuthorKey(title, author);
    const books = await this.listBooks();
    return books.find((b) => normalizeTitleAuthorKey(b.title, b.author) === key) ?? null;
  }

  async deleteBook(bookId: string): Promise<DeleteBookResult> {
    // 개발 환경에서 실데이터를 지우는 것을 막는다 (2026-08-17 사고 — lib/prod-guard.ts)
    assertDestructiveAllowed("deleteBook");
    // where 필터만 쿼리(복합 인덱스 불필요) → 문서 참조를 모아 batch로 지운다.
    const [cardSnap, readingSnap] = await Promise.all([
      this.cards().where("bookId", "==", bookId).get(),
      this.readings().where("bookId", "==", bookId).get(),
    ]);

    // 책 문서를 **마지막에** 지운다 — 중간에 실패해도 "카드 없는 책"(다시 지우면 되는 상태)이
    // 남을 뿐, "책 없는 유령 카드"는 남지 않는다.
    const refs = [
      ...cardSnap.docs.map((d) => d.ref),
      ...readingSnap.docs.map((d) => d.ref),
      this.books().doc(bookId),
    ];

    const db = getDb();
    for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const ref of refs.slice(i, i + BATCH_LIMIT)) batch.delete(ref);
      await batch.commit();
    }

    return { cards: cardSnap.size, readings: readingSnap.size };
  }

  async updateBookEvidence(
    bookId: string,
    patch: BookEvidencePatch,
  ): Promise<BookRecord | null> {
    const ref = this.books().doc(bookId);
    const snap = await ref.get();
    if (!snap.exists) return null;

    // Firestore는 undefined를 거부한다 — 지정한 키만, 전부 null 정규화해서 쓴다.
    const data: Record<string, unknown> = {};
    if ("blurbText" in patch) data.blurbText = patch.blurbText ?? null;
    if ("sceneKind" in patch) data.sceneKind = patch.sceneKind ?? null;
    if ("sceneDigest" in patch) {
      data.sceneDigest = patch.sceneDigest?.length
        ? normalizeSceneDigest(patch.sceneDigest)
        : null;
    }
    if ("transcript" in patch) data.transcript = patch.transcript ?? null;
    if ("youtubeUrl" in patch) data.youtubeUrl = patch.youtubeUrl ?? null;
    // 챕터화 결과 붙이기/다시 나누기 — Chapter는 선택 키가 없어 그대로 써도 안전하나
    // 손상 방어를 위해 toChapters로 좁혀 쓴다(빈 결과는 null).
    if ("chapters" in patch) data.chapters = toChapters(patch.chapters);
    if (Object.keys(data).length > 0) await ref.update(data);

    const updated = await ref.get();
    return toBook(updated.id, updated.data()!);
  }

  async createCard(input: NewCard): Promise<CardRecord> {
    const ref = this.cards().doc();
    const record: CardRecord = { ...input, id: ref.id, createdAt: new Date().toISOString() };
    const { id: _id, ...data } = record;
    await ref.set(data);
    return record;
  }

  async getCard(id: string): Promise<CardRecord | null> {
    const snap = await this.cards().doc(id).get();
    return snap.exists ? toCard(snap.id, snap.data()!) : null;
  }

  async deleteCard(cardId: string): Promise<boolean> {
    // 개발 환경에서 실데이터를 지우는 것을 막는다 (2026-08-17 사고 — lib/prod-guard.ts)
    assertDestructiveAllowed("deleteCard");
    // 연쇄 삭제가 없으므로 batch도 필요 없다 — 문서 1개만 지운다.
    // (deleteBook은 카드·읽음 기록을 함께 지우느라 batch를 쓴다)
    const ref = this.cards().doc(cardId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
  }

  async listCardsForBook(bookId: string): Promise<CardRecord[]> {
    // where + orderBy(다른 필드)는 복합 인덱스가 필요 — 필터만 쿼리, 정렬은 메모리
    const snap = await this.cards().where("bookId", "==", bookId).get();
    return snap.docs.map((d) => toCard(d.id, d.data())).sort(byCreatedAtDesc);
  }

  async listRecentCards(limit: number): Promise<CardWithBook[]> {
    const snap = await this.cards().orderBy("createdAt", "desc").limit(limit).get();
    const cards = snap.docs.map((d) => toCard(d.id, d.data()));
    if (cards.length === 0) return [];

    const bookIds = [...new Set(cards.map((c) => c.bookId))];
    const bookSnaps = await getDb().getAll(...bookIds.map((id) => this.books().doc(id)));
    const bookMap = new Map(
      bookSnaps.filter((s) => s.exists).map((s) => [s.id, toBook(s.id, s.data()!)]),
    );

    return cards.flatMap((card) => {
      const book = bookMap.get(card.bookId);
      return book ? [{ card, book }] : []; // 책이 사라진 카드는 건너뜀 (파일 구현과 동일)
    });
  }

  async addReading(input: NewReading): Promise<ReadingRecord> {
    const ref = this.readings().doc();
    const record: ReadingRecord = { ...input, id: ref.id };
    const { id: _id, ...data } = record;
    await ref.set(data);
    return record;
  }

  async listReadings(bookId?: string): Promise<ReadingRecord[]> {
    const snap = bookId
      ? await this.readings().where("bookId", "==", bookId).get()
      : await this.readings().get();
    return snap.docs
      .map((d) => toReading(d.id, d.data()))
      .sort((a, b) => (a.readAt < b.readAt ? 1 : a.readAt > b.readAt ? -1 : 0));
  }

  // ---- explanations (M4, math.md §9-2) ----

  async createExplanation(input: NewExplanation): Promise<ExplanationRecord> {
    const ref = this.explanations().doc();
    const record: ExplanationRecord = {
      ...input,
      problem: normalizeProblem(input.problem),
      // 신규 설명은 미정렬(맨 위)로 시작 — Firestore는 undefined를 거부하므로 명시적 null.
      sortIndex: null,
      id: ref.id,
      createdAt: new Date().toISOString(),
    };
    const { id: _id, ...data } = record; // 문서 ID가 곧 id — 본문에 중복 저장하지 않는다
    await ref.set(data);
    return record;
  }

  async reorderExplanations(orderedIds: string[]): Promise<void> {
    // reorderBooks의 explanations판 — 공유 본체 reorderBySortIndex(없는 id 건너뜀). 수정이라 prod-guard 무관.
    await reorderBySortIndex(getDb(), this.explanations(), orderedIds);
  }

  async getExplanation(id: string): Promise<ExplanationRecord | null> {
    const snap = await this.explanations().doc(id).get();
    return snap.exists ? toExplanation(snap.id, snap.data()!) : null;
  }

  async listExplanations(limit?: number): Promise<ExplanationRecord[]> {
    // createdAt은 ISO 문자열이라 사전순 = 시간순 — 단일 필드 정렬이라 복합 인덱스가 없다
    const base = this.explanations().orderBy("createdAt", "desc");
    const snap = await (limit == null ? base.get() : base.limit(limit).get());
    return snap.docs.map((d) => toExplanation(d.id, d.data()));
  }

  async deleteExplanation(id: string): Promise<boolean> {
    // 개발 환경에서 실데이터를 지우는 것을 막는다 (2026-08-17 사고 — lib/prod-guard.ts)
    assertDestructiveAllowed("deleteExplanation");
    // 연쇄 삭제 없음 — 설명에 딸린 것이 없다(§9-5). deleteCard와 같은 모양.
    const ref = this.explanations().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
  }

  // ---- vocabBooks (V1, english.md §7-6) ----

  async createVocabBook(input: NewVocabBook): Promise<VocabBookRecord> {
    const ref = this.vocabBooks().doc();
    const record: VocabBookRecord = {
      ...input,
      // 저장 계층이 마지막 관문 — 라우트도 통과시키지만 여기서 한 번 더 조인다(createBook 선례).
      // (B) 창작 필드(V1에서 null)와 중첩 배열의 undefined가 새면 Firestore가 쓰기를 거부한다.
      entries: input.entries.map(normalizeVocabEntry),
      // 신규 단어장은 미정렬(맨 위)로 시작 — Firestore는 undefined를 거부하므로 명시적 null.
      sortIndex: null,
      id: ref.id,
      createdAt: new Date().toISOString(),
    };
    const { id: _id, ...data } = record; // 문서 ID가 곧 id — 본문에 중복 저장하지 않는다
    await ref.set(data);
    return record;
  }

  async reorderVocabBooks(orderedIds: string[]): Promise<void> {
    // reorderBooks의 vocab판 — 공유 본체 reorderBySortIndex(없는 id 건너뜀). 수정이라 prod-guard 무관.
    await reorderBySortIndex(getDb(), this.vocabBooks(), orderedIds);
  }

  async getVocabBook(id: string): Promise<VocabBookRecord | null> {
    const snap = await this.vocabBooks().doc(id).get();
    return snap.exists ? toVocabBook(snap.id, snap.data()!) : null;
  }

  async getOrCreateCollectedVocabBook(): Promise<VocabBookRecord> {
    // 단일 필드 등가 쿼리라 복합 인덱스가 필요 없다(Firestore 자동 단일 필드 인덱스). 정렬은 메모리에서.
    const snap = await this.vocabBooks().where("dayLabel", "==", COLLECTED_VOCAB_DAY_LABEL).get();
    if (!snap.empty) {
      // 첫 담기 경합으로 둘이 만들어졌어도 "가장 먼저 만든 것"으로 수렴시킨다(file 백엔드와 같은 규칙).
      const books = snap.docs.map((d) => toVocabBook(d.id, d.data()));
      let picked = books[0];
      for (const b of books) if (b.createdAt < picked.createdAt) picked = b;
      return picked;
    }
    return this.createVocabBook({
      titleKo: COLLECTED_VOCAB_TITLE_KO,
      dayLabel: COLLECTED_VOCAB_DAY_LABEL,
      entries: [],
      photoCount: 0,
      enriched: false,
      model: "",
    });
  }

  async listVocabBooks(limit?: number): Promise<VocabBookRecord[]> {
    // createdAt은 ISO 문자열이라 사전순 = 시간순 — 단일 필드 정렬이라 복합 인덱스가 없다
    const base = this.vocabBooks().orderBy("createdAt", "desc");
    const snap = await (limit == null ? base.get() : base.limit(limit).get());
    return snap.docs.map((d) => toVocabBook(d.id, d.data()));
  }

  async updateVocabBookEnrichment(
    id: string,
    entries: VocabEntry[],
    enriched: boolean,
  ): Promise<VocabBookRecord | null> {
    // **삭제가 아니라 수정**이라 assertDestructiveAllowed를 걸지 않는다(updateBookEvidence와 같은 규약).
    const ref = this.vocabBooks().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    // Firestore는 undefined를 거부한다 — normalizeVocabEntry로 조인 뒤 entries·enriched만 갈아끼운다.
    // 정의 불변은 호출측 mergeEnrichment가 이미 지켰다(여기선 받은 값을 그대로 굳힌다).
    await ref.update({ entries: entries.map(normalizeVocabEntry), enriched });
    const updated = await ref.get();
    return toVocabBook(updated.id, updated.data()!);
  }

  async appendVocabEntry(id: string, entry: VocabEntry): Promise<AppendVocabEntryResult> {
    // **삭제가 아니라 수정**이라 assertDestructiveAllowed를 걸지 않는다(updateVocabBookEnrichment와 같은 규약).
    const ref = this.vocabBooks().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { record: null, appended: false };
    // 읽기 정규화(toVocabBook)로 옛 문서도 안전하게 다룬다 — 이 위에서 중복 검사·append를 한다.
    const current = toVocabBook(snap.id, snap.data()!);
    const key = entry.word.trim().toLowerCase();
    if (current.entries.some((e) => e.word.trim().toLowerCase() === key)) {
      return { record: current, appended: false };
    }
    // undefined는 Firestore가 거부한다 — 붙이는 단어까지 normalizeVocabEntry로 마지막에 조인다.
    const nextEntries = [...current.entries, entry].map(normalizeVocabEntry);
    const enriched = isVocabBookEnriched(nextEntries);
    await ref.update({ entries: nextEntries, enriched });
    const updated = await ref.get();
    return { record: toVocabBook(updated.id, updated.data()!), appended: true };
  }

  async linkVocabRelated(id: string, input: VocabLinkInput): Promise<VocabLinkResult> {
    return this.applyLink(id, input, "link");
  }

  async unlinkVocabRelated(id: string, input: VocabLinkInput): Promise<VocabLinkResult> {
    return this.applyLink(id, input, "unlink");
  }

  /**
   * link/unlink 공용 — 읽기 정규화(toVocabBook)로 옛 문서도 안전히 다룬 뒤, 파일 백엔드와 **같은 순수
   * 함수**(applyVocabLink)로 새 entries를 만들어 entries만 update한다. undefined는 Firestore가 거부하므로
   * normalizeVocabEntry로 마지막에 조인다. **수정이라 assertDestructiveAllowed 무관**(필드 편집).
   */
  private async applyLink(id: string, input: VocabLinkInput, op: VocabLinkOp): Promise<VocabLinkResult> {
    const ref = this.vocabBooks().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { status: "not_found" };
    const current = toVocabBook(snap.id, snap.data()!);
    const result = applyVocabLink(current.entries, input, op);
    if (result.status === "invalid") return { status: "invalid" };
    const nextEntries = result.entries.map(normalizeVocabEntry);
    await ref.update({ entries: nextEntries });
    const updated = await ref.get();
    return { status: "ok", record: toVocabBook(updated.id, updated.data()!) };
  }

  async updateVocabBookTitle(id: string, titleKo: string): Promise<VocabBookRecord | null> {
    // **삭제가 아니라 수정**이라 assertDestructiveAllowed를 걸지 않는다(updateVocabBookEnrichment와 같은 규약).
    // titleKo 한 필드만 update한다 — entries·enriched·dayLabel은 문서에 그대로 남는다.
    const ref = this.vocabBooks().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    await ref.update({ titleKo });
    const updated = await ref.get();
    // 읽기 정규화(toVocabBook)로 entries는 getVocabBook과 같은 모양으로 돌려준다.
    return toVocabBook(updated.id, updated.data()!);
  }

  async deleteVocabBook(id: string): Promise<DeleteVocabBookResult> {
    // 개발 환경에서 실데이터를 지우는 것을 막는다 (2026-08-17 사고 — lib/prod-guard.ts)
    assertDestructiveAllowed("deleteVocabBook");
    const ref = this.vocabBooks().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false };

    // 그 단어장의 시험 세션(V4)까지 함께 지운다 — deleteBook과 같은 규약(where 필터만 쿼리, batch 삭제).
    // 단어장 문서를 **마지막에** 지워 중간 실패 시 "단어장 없는 유령 퀴즈"가 남지 않게 한다.
    const quizSnap = await this.vocabQuizzes().where("bookId", "==", id).get();
    const refs = [...quizSnap.docs.map((d) => d.ref), ref];
    const db = getDb();
    for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const r of refs.slice(i, i + BATCH_LIMIT)) batch.delete(r);
      await batch.commit();
    }
    return { ok: true };
  }

  // ---- vocabQuizzes (V4, 계획 §V4) ----

  async addVocabQuiz(input: NewVocabQuiz): Promise<VocabQuizRecord> {
    const ref = this.vocabQuizzes().doc();
    const record: VocabQuizRecord = {
      ...input,
      // 저장 계층이 마지막 관문 — items의 undefined를 조인다(파일 백엔드와 같은 정규화, Firestore 거부 방어).
      items: input.items.map(normalizeVocabQuizItem),
      id: ref.id,
    };
    const { id: _id, ...data } = record; // 문서 ID가 곧 id — 본문에 중복 저장하지 않는다
    await ref.set(data);
    return record;
  }

  async listVocabQuizzes(bookId: string): Promise<VocabQuizRecord[]> {
    // where + orderBy(다른 필드)는 복합 인덱스가 필요 — 필터만 쿼리, 정렬은 메모리(listCardsForBook과 같은 규약)
    const snap = await this.vocabQuizzes().where("bookId", "==", bookId).get();
    return snap.docs.map((d) => toVocabQuiz(d.id, d.data())).sort(byStartedAtAsc);
  }
  async listAllVocabQuizzes(): Promise<VocabQuizRecord[]> {
    // 전역 조회(where 없음) — 정렬은 메모리에서 startedAt 오름차순(층2가 bookId별로 다시 가른다).
    // 가족용 규모라 컬렉션 전체를 읽어도 문제 없다(listVocabBooks가 전체를 읽는 것과 같은 판단).
    const snap = await this.vocabQuizzes().get();
    return snap.docs.map((d) => toVocabQuiz(d.id, d.data())).sort(byStartedAtAsc);
  }

  // ---- jaVocabBooks — 아빠의 일본어 JLPT 단어장 (J1, §7-1) ----

  async createJaVocabBook(input: NewJaVocabBook): Promise<JaVocabBookRecord> {
    const ref = this.jaVocabBooks().doc();
    // 저장 계층이 마지막 관문 — normalizeJaVocabBook으로 undefined를 조인다(Firestore 거부 방어). 신규는 sortIndex null.
    const record = normalizeJaVocabBook({
      ...(input as JaVocabBookRecord),
      sortIndex: null,
      id: ref.id,
      createdAt: new Date().toISOString(),
    });
    const { id: _id, ...data } = record; // 문서 ID가 곧 id — 본문에 중복 저장하지 않는다
    await ref.set(data);
    return record;
  }

  async getJaVocabBook(id: string): Promise<JaVocabBookRecord | null> {
    const snap = await this.jaVocabBooks().doc(id).get();
    return snap.exists ? toJaVocabBook(snap.id, snap.data()!) : null;
  }

  async listJaVocabBooks(limit?: number): Promise<JaVocabBookRecord[]> {
    const base = this.jaVocabBooks().orderBy("createdAt", "desc");
    const snap = await (limit == null ? base : base.limit(limit)).get();
    return snap.docs.map((d) => toJaVocabBook(d.id, d.data()));
  }

  async deleteJaVocabBook(id: string): Promise<DeleteJaVocabBookResult> {
    // 개발 환경에서 실데이터를 지우는 것을 막는다(2026-08-17 사고).
    assertDestructiveAllowed("deleteJaVocabBook");
    const ref = this.jaVocabBooks().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false };
    // 그 단어장의 시험 세션(J2)까지 함께 지운다(영어 deleteVocabBook 규약). 단어장 문서를 마지막에 지워
    // 중간 실패 시 "단어장 없는 유령 세션"이 남지 않게 한다. where 필터만 쿼리, BATCH_LIMIT 단위 삭제.
    const quizSnap = await this.jaQuizzes().where("bookId", "==", id).get();
    const refs = [...quizSnap.docs.map((d) => d.ref), ref];
    const db = getDb();
    for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const r of refs.slice(i, i + BATCH_LIMIT)) batch.delete(r);
      await batch.commit();
    }
    return { ok: true };
  }

  async reorderJaVocabBooks(orderedIds: string[]): Promise<void> {
    // reorderVocabBooks의 일본어판 — 공유 본체 reorderBySortIndex(없는 id 건너뜀). 수정이라 prod-guard 무관.
    await reorderBySortIndex(getDb(), this.jaVocabBooks(), orderedIds);
  }

  async updateJaVocabBookTitle(id: string, titleKo: string): Promise<JaVocabBookRecord | null> {
    // titleKo 한 필드만 update — entries·levels·topic은 문서에 그대로 남는다. 수정이라 prod-guard 무관.
    const ref = this.jaVocabBooks().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    await ref.update({ titleKo });
    const updated = await ref.get();
    return toJaVocabBook(updated.id, updated.data()!);
  }

  // ---- jaQuizzes (J2) ----

  async addJaQuiz(input: NewJaQuiz): Promise<JaQuizRecord> {
    const ref = this.jaQuizzes().doc();
    const record: JaQuizRecord = {
      ...input,
      items: input.items.map(normalizeJaQuizItem), // 저장 계층 마지막 관문(파일 백엔드와 동일 정규화)
      id: ref.id,
    };
    const { id: _id, ...data } = record; // 문서 ID가 곧 id — 본문에 중복 저장하지 않는다
    await ref.set(data);
    return record;
  }

  async listJaQuizzes(bookId: string): Promise<JaQuizRecord[]> {
    // where + orderBy(다른 필드)는 복합 인덱스 필요 — 필터만 쿼리, 정렬은 메모리(listVocabQuizzes 규약).
    const snap = await this.jaQuizzes().where("bookId", "==", bookId).get();
    return snap.docs.map((d) => toJaQuiz(d.id, d.data())).sort(byStartedAtAsc);
  }
  async listAllJaQuizzes(): Promise<JaQuizRecord[]> {
    // 전역 조회(where 없음) — 정렬은 메모리에서 startedAt 오름차순. 가족용 규모라 전체를 읽어도 된다(listAllVocabQuizzes 규약).
    const snap = await this.jaQuizzes().get();
    return snap.docs.map((d) => toJaQuiz(d.id, d.data())).sort(byStartedAtAsc);
  }

  // ---- jaKanji · jaKanjiQuizzes (JK) ----

  async saveJaKanji(records: NewJaKanji[]): Promise<number> {
    if (records.length === 0) return 0;
    // 기존 한자 문자 → 문서 참조 맵(전역 소규모라 한 번에 읽는다). **이미 있는 한자는 건너뛴다**(§12-2 불변).
    const existing = await this.jaKanji().get();
    const byKanji = new Map(existing.docs.map((d) => [String(d.data().kanji ?? ""), d.ref] as const));
    const now = new Date().toISOString();
    const db = getDb();
    let added = 0;
    // BATCH_LIMIT 단위로 쓴다(가족용 규모엔 사실상 1배치).
    for (let i = 0; i < records.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const rec of records.slice(i, i + BATCH_LIMIT)) {
        const norm = normalizeJaKanji({ ...rec, id: "x", createdAt: now });
        const { id: _id, ...data } = norm;
        // 이미 있으면 **덮어쓰지 않는다** — 시험이 저장된 음독·뜻에 매달리므로 값이 바뀌면
        // 외운 것과 문제가 어긋난다(파일 백엔드와 같은 규약, 영어 "정의 불변"과 같은 자리).
        if (byKanji.has(norm.kanji)) continue;
        batch.set(this.jaKanji().doc(), data); // 새 문서
        added += 1;
      }
      await batch.commit();
    }
    return added;
  }

  async listJaKanji(): Promise<JaKanjiRecord[]> {
    const snap = await this.jaKanji().get();
    return snap.docs.map((d) => toJaKanji(d.id, d.data())).sort(byCreatedAtAsc);
  }

  async addJaKanjiQuiz(input: NewJaKanjiQuiz): Promise<JaKanjiQuizRecord> {
    const ref = this.jaKanjiQuizzes().doc();
    const record: JaKanjiQuizRecord = { ...input, items: input.items.map(normalizeJaQuizItem), id: ref.id };
    const { id: _id, ...data } = record;
    await ref.set(data);
    return record;
  }

  async listJaKanjiQuizzes(): Promise<JaKanjiQuizRecord[]> {
    const snap = await this.jaKanjiQuizzes().get();
    return snap.docs.map((d) => toJaKanjiQuiz(d.id, d.data())).sort(byStartedAtAsc);
  }

  // ---- jaDialogs (J3~J5) ----

  async createJaDialog(input: NewJaDialog): Promise<JaDialogRecord> {
    const ref = this.jaDialogs().doc();
    const record = normalizeJaDialogRecord({ ...(input as JaDialogRecord), sortIndex: null, id: ref.id, createdAt: new Date().toISOString() });
    const { id: _id, ...data } = record;
    await ref.set(data);
    return record;
  }

  async getJaDialog(id: string): Promise<JaDialogRecord | null> {
    const snap = await this.jaDialogs().doc(id).get();
    return snap.exists ? toJaDialog(snap.id, snap.data()!) : null;
  }

  async listJaDialogs(limit?: number): Promise<JaDialogRecord[]> {
    const base = this.jaDialogs().orderBy("createdAt", "desc");
    const snap = await (limit == null ? base : base.limit(limit)).get();
    return snap.docs.map((d) => toJaDialog(d.id, d.data()));
  }

  async deleteJaDialog(id: string): Promise<DeleteJaVocabBookResult> {
    assertDestructiveAllowed("deleteJaVocabBook"); // 대화도 같은 파괴적 op 이름으로 묶어 막는다(딸린 것 없음)
    const ref = this.jaDialogs().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false };
    await ref.delete();
    return { ok: true };
  }

  async reorderJaDialogs(orderedIds: string[]): Promise<void> {
    // reorderBooks의 대화판 — 공유 본체 reorderBySortIndex(없는 id 건너뜀). 수정이라 prod-guard 무관.
    await reorderBySortIndex(getDb(), this.jaDialogs(), orderedIds);
  }

  async updateJaDialogTitle(id: string, titleKo: string): Promise<JaDialogRecord | null> {
    const ref = this.jaDialogs().doc(id);
    if (!(await ref.get()).exists) return null;
    await ref.update({ titleKo });
    const updated = await ref.get();
    return toJaDialog(updated.id, updated.data()!);
  }

  async updateJaDialogCoaching(id: string, coaching: JaDialogCoaching): Promise<JaDialogRecord | null> {
    const ref = this.jaDialogs().doc(id);
    if (!(await ref.get()).exists) return null;
    // 해설만 갈아끼운다 — 전사·제목은 그대로. undefined 거부 방어는 normalizeJaDialogRecord가 읽을 때 한다.
    await ref.update({ coaching });
    const updated = await ref.get();
    return toJaDialog(updated.id, updated.data()!);
  }

  // ---- 대화에서 모은 단어 (J5) ----

  async getOrCreateJaCollectedVocabBook(): Promise<JaVocabBookRecord> {
    const snap = await this.jaVocabBooks().where("kind", "==", "collected").get();
    if (!snap.empty) {
      // 가장 먼저 만든 것을 정본으로(경합 최소화, 가족용 규모)
      const books = snap.docs.map((d) => toJaVocabBook(d.id, d.data())).sort(byCreatedAtAsc);
      return books[0];
    }
    return this.createJaVocabBook({
      titleKo: JA_COLLECTED_VOCAB_TITLE_KO,
      kind: "collected",
      entries: [],
      levels: [],
      topic: null,
      model: "",
    });
  }

  async appendJaVocabEntry(id: string, entry: JaVocabEntry): Promise<AppendJaVocabResult> {
    const ref = this.jaVocabBooks().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { record: null, appended: false };
    const current = toJaVocabBook(snap.id, snap.data()!);
    const key = entry.kana.trim();
    if (key !== "" && current.entries.some((e) => e.kana.trim() === key)) {
      return { record: current, appended: false };
    }
    const nextEntries = [...current.entries, entry].map(normalizeJaVocabEntry);
    await ref.update({ entries: nextEntries });
    const updated = await ref.get();
    return { record: toJaVocabBook(updated.id, updated.data()!), appended: true };
  }

  // ---- workoutCycles — 아빠의 운동 (§19-4) ----
  //
  // ⚠️ 이 저장소에서 **처음으로 트랜잭션(getDb().runTransaction)을 쓴다.** 이유:
  // 위의 다른 수정 메서드는 전부 `get → 메모리에서 판정 → update` 관용구다. 운동 기록에 그걸 그대로 쓰면 두 요청
  // (연타·폰과 PC·Cloud Run 인스턴스 여럿 — deploy에 max-instances 제한이 없다)이 같은 rev를 읽고 둘 다 통과해,
  // 뒤 쓰기가 앞 쓰기를 덮는다(사건 유실·같은 Day 이중 기록·활성 사이클 2개). rev·활성 id 대조가 그걸 막으려면
  // **읽기·판정·쓰기가 한 원자 단위**여야 한다. 트랜잭션은 경합하면 콜백을 다시 돌리는데, 판정 함수(decide*)가
  // 순수·결정적이고 todayKst·nowIso(라우트)·newId(여기, 트랜잭션 밖)를 밖에서 한 번 정하므로 재시도해도 같은 답이다.
  // 규칙: 콜백 안에서 **읽기를 모두 끝낸 뒤** 쓴다(Firestore 트랜잭션 제약). 콜백이 던지면(RangeError·prod-guard)
  // 쓰기 없이 롤백되고 그 에러가 그대로 올라간다(재시도 대상 아님).

  async listWorkoutCycles(): Promise<WorkoutCycleRecord[]> {
    // orderBy("createdAt") 대신 전체를 읽어 메모리에서 정렬한다 — orderBy는 그 필드가 없는 문서를 결과에서 빼 버려,
    // 페이지가 고른 활성 사이클과 트랜잭션(start)이 컬렉션 전체에서 고른 활성이 달라질 수 있다(→ 영영 conflict).
    // 사이클은 한 달에 1개꼴이라 전체 읽기로 충분하다(listJaKanji와 같은 판단).
    const snap = await this.workoutCycles().get();
    return snap.docs.map((d) => toWorkoutCycle(d.id, d.data())).sort(byCreatedAtDesc);
  }

  async getWorkoutCycle(id: string): Promise<WorkoutCycleRecord | null> {
    const snap = await this.workoutCycles().doc(id).get();
    return snap.exists ? toWorkoutCycle(snap.id, snap.data()!) : null;
  }

  async startWorkoutCycle(input: StartWorkoutInput): Promise<StartWorkoutResult> {
    const col = this.workoutCycles();
    // 새 문서 id는 트랜잭션 **밖에서** 한 번 정한다 — 경합으로 콜백이 다시 돌아도 같은 id로 판정·쓰기(결정성).
    const newId = col.doc().id;
    return getDb().runTransaction(async (tx): Promise<StartWorkoutResult> => {
      // 컬렉션 전체를 트랜잭션으로 읽는다 — 활성 대조·cycleNo(max+1)·닫기가 모두 이 한 번의 읽기에 기댄다.
      // (활성이 없을 때 두 요청이 겹치면 잠글 활성 문서가 없다 — 이때는 트랜잭션 쿼리 읽기의 직렬화에 기대고,
      //  그래도 둘이 생기면 다음 시작이 pickActiveWorkoutCycle로 하나만 남기고 닫는다.)
      const snap = await tx.get(col);
      const all = snap.docs.map((d) => toWorkoutCycle(d.id, d.data()));
      const r = decideStart(all, input, newId);
      if (r.status === "conflict") return { status: "conflict", activeCycleId: r.activeCycleId };
      // 사건 있는 활성 사이클을 닫는 것은 가족 기록을 되돌릴 수 없게 바꾸는 일이다 — prod-guard(§19-4).
      // 닫을지는 트랜잭션 안에서 읽어야 알 수 있어 여기서 판정한다 — 아래 tx.set **전**이라 던지면 아무것도 쓰이지 않는다.
      if (r.closedHadEvents) assertDestructiveAllowed("closeWorkoutCycle");
      // writes = 닫은 사이클 + 새로 만든/제자리 교체한 사이클 — id 지정 문서로 upsert(한 커밋에 함께 반영).
      for (const w of r.writes) tx.set(col.doc(w.id), workoutCycleData(w));
      return { status: "ok", record: normalizeWorkoutCycle(r.record), mode: r.mode, closed: r.closed };
    });
  }

  async logWorkoutEvent(cycleId: string, input: LogWorkoutInput): Promise<WorkoutMutationResult> {
    // 기록(append)은 가드 대상이 아니다(§19-4) — 되돌리기(undo)만 가드한다.
    const ref = this.workoutCycles().doc(cycleId);
    return getDb().runTransaction(async (tx): Promise<WorkoutMutationResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { status: "not_found" };
      const current = toWorkoutCycle(snap.id, snap.data()!);
      const r = decideLog(current, input);
      if (r.status !== "ok") return { status: r.status, record: current };
      const next = normalizeWorkoutCycle(r.next);
      // 바뀌는 두 필드만 쓴다 — events는 normalize를 통과한 값(undefined 없음).
      tx.update(ref, { rev: next.rev, events: next.events });
      return { status: "ok", record: next };
    });
  }

  async undoWorkoutEvent(cycleId: string, input: UndoWorkoutInput): Promise<WorkoutMutationResult> {
    // 개발 환경에서 실데이터(운동 기록)를 되돌릴 수 없게 빼는 것을 막는다(2026-08-17 사고 — lib/prod-guard.ts, §19-4).
    assertDestructiveAllowed("undoWorkoutEvent");
    const ref = this.workoutCycles().doc(cycleId);
    return getDb().runTransaction(async (tx): Promise<WorkoutMutationResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { status: "not_found" };
      const current = toWorkoutCycle(snap.id, snap.data()!);
      const r = decideUndo(current, input);
      if (r.status !== "ok") return { status: r.status, record: current };
      const next = normalizeWorkoutCycle(r.next);
      tx.update(ref, { rev: next.rev, events: next.events });
      return { status: "ok", record: next };
    });
  }

  // ---- 아빠의 영어(토익스피킹) — toeic.md §7 ----
  //
  // 트랜잭션(runTransaction)을 쓰는 곳 — 모두 "지금 문서를 읽고 그 위에 합친다"라서, 두 요청이 같은 문서를
  // 읽고 둘 다 쓰면 뒤 쓰기가 앞 쓰기를 덮는다(운동 절 주석과 같은 이유):
  //   - importToeicSets: presetKey 확인 + 생성(두 번 눌러도 한 번만 — 멱등, §7-6)
  //   - mergeToeicSetPoints: 최신 entries 위에 "빈 자리만" 병합(자동 호출과 버튼이 겹쳐도 먼저 채운 포인트 보존, §3-4)
  //   - fillToeicMockPart: 빈 파트만 채운다(두 요청이 겹쳐도 먼저 커밋한 파트가 남는다, §4-0)
  //   - saveToeicPictureImage·markToeicPictureImageFailed: picture.items[slot]만 — 사진 문서 생성과 칸 갱신을 한 커밋으로,
  //     먼저 ready가 된 사진은 다른 ready·failed로 덮지 않는다(두 장을 동시에 만들어도·늦은 실패가 와도, §4-10)
  //   - finishToeicAttempt: 끝/그만두기는 한 번만(이미 닫힌 응시는 쓰지 않는다 — decideAttemptFinish, 재시도·다른 탭 방어)
  //   - updateToeicAttemptAnswer: 그 문항만(동시 채점 2개가 서로 덮지 않게, §7-5)
  // 콜백 안에서 읽기를 모두 끝낸 뒤 쓴다(Firestore 트랜잭션 제약). 새 문서 id·시각은 트랜잭션 밖에서 한 번만 정한다.
  // 삭제(세트·모의고사)는 prod-guard를 첫 줄에 — 딸린 문서를 먼저 지우고 본 문서를 마지막에(중간 실패 시 유령 문서 방지).

  async createToeicSet(input: NewToeicSet): Promise<ToeicSetRecord> {
    const ref = this.toeicSets().doc();
    const record = normalizeToeicSetRecord({ ...input, id: ref.id, createdAt: new Date().toISOString(), sortIndex: null });
    await ref.set(toeicSetData(record));
    return record;
  }

  async getToeicSet(id: string): Promise<ToeicSetRecord | null> {
    const snap = await this.toeicSets().doc(id).get();
    return snap.exists ? toToeicSet(snap.id, snap.data()!) : null;
  }

  async listToeicSets(limit?: number): Promise<ToeicSetRecord[]> {
    // 단일 필드 orderBy — createdAt은 모든 문서에 쓴다(생성·가져오기 둘 다). 복합 인덱스 없음.
    const base = this.toeicSets().orderBy("createdAt", "desc");
    const snap = await (limit == null ? base : base.limit(limit)).get();
    return snap.docs.map((d) => toToeicSet(d.id, d.data()));
  }

  async findToeicSetByPresetKey(presetKey: string): Promise<ToeicSetRecord | null> {
    const snap = await this.toeicSets().where("presetKey", "==", presetKey).limit(1).get();
    return snap.empty ? null : toToeicSet(snap.docs[0].id, snap.docs[0].data());
  }

  async importToeicSets(inputs: NewToeicSet[]): Promise<ImportToeicSetsResult> {
    const col = this.toeicSets();
    const base = Date.now();
    // 새 문서 id는 트랜잭션 밖에서 한 번 — 경합으로 콜백이 다시 돌아도 같은 id로 쓴다(결정성).
    const prepared = inputs.map((input, i) =>
      normalizeToeicSetRecord({ ...input, id: col.doc().id, createdAt: new Date(base - i).toISOString(), sortIndex: null }),
    );
    const keys = [...new Set(prepared.map((r) => r.presetKey).filter((k): k is string => k !== null))];
    return getDb().runTransaction(async (tx): Promise<ImportToeicSetsResult> => {
      // `in`은 한 번에 30개까지 — 나눠 읽는다. 읽기를 모두 끝낸 뒤 쓴다.
      const have = new Set<string>();
      for (let i = 0; i < keys.length; i += 30) {
        const snap = await tx.get(col.where("presetKey", "in", keys.slice(i, i + 30)));
        for (const d of snap.docs) {
          const k = d.data().presetKey;
          if (typeof k === "string") have.add(k);
        }
      }
      const created: ToeicSetRecord[] = [];
      const skippedKeys: string[] = [];
      for (const record of prepared) {
        const key = record.presetKey;
        if (key !== null && have.has(key)) {
          skippedKeys.push(key);
          continue;
        }
        if (key !== null) have.add(key);
        tx.set(col.doc(record.id), toeicSetData(record));
        created.push(record);
      }
      return { created, skippedKeys };
    });
  }

  async deleteToeicSet(id: string): Promise<DeleteToeicResult> {
    assertDestructiveAllowed("deleteToeicSet");
    const ref = this.toeicSets().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false };
    const quizSnap = await this.toeicQuizzes().where("setId", "==", id).get();
    const refs = [...quizSnap.docs.map((d) => d.ref), ref]; // 세트 문서를 **마지막에**
    const db = getDb();
    for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const r of refs.slice(i, i + BATCH_LIMIT)) batch.delete(r);
      await batch.commit();
    }
    return { ok: true };
  }

  async updateToeicSetTitle(id: string, titleKo: string): Promise<ToeicSetRecord | null> {
    const ref = this.toeicSets().doc(id);
    if (!(await ref.get()).exists) return null;
    await ref.update({ titleKo });
    const updated = await ref.get();
    return toToeicSet(updated.id, updated.data()!);
  }

  async reorderToeicSets(orderedIds: string[]): Promise<void> {
    await reorderBySortIndex(getDb(), this.toeicSets(), orderedIds);
  }

  async mergeToeicSetPoints(
    id: string,
    items: ToeicPointsItem[],
    opts: { force: boolean },
  ): Promise<MergeToeicSetPointsResult | null> {
    const ref = this.toeicSets().doc(id);
    return getDb().runTransaction(async (tx): Promise<MergeToeicSetPointsResult | null> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const current = toToeicSet(snap.id, snap.data()!);
      const merged = applyPointsResults(current.entries, items, opts);
      const record = normalizeToeicSetRecord({ ...current, entries: merged.entries });
      // 바뀌는 두 필드만 쓴다 — entries는 normalize를 통과한 값(undefined 없음)
      tx.update(ref, { entries: record.entries, enriched: record.enriched });
      return { record, filled: merged.filled, remaining: merged.remaining };
    });
  }

  async addToeicQuiz(input: NewToeicQuiz): Promise<ToeicQuizRecord> {
    const ref = this.toeicQuizzes().doc();
    const record: ToeicQuizRecord = { ...input, items: input.items.map(normalizeToeicQuizItem), id: ref.id };
    const { id: _id, ...data } = record;
    await ref.set(data);
    return record;
  }

  /** 모르는 mode 문서는 버리고 경고한다(파일 백엔드 normalizeToeicQuizList와 같은 규약). */
  private toToeicQuizList(docs: { id: string; data(): DocumentData }[]): ToeicQuizRecord[] {
    const out: ToeicQuizRecord[] = [];
    let dropped = 0;
    for (const d of docs) {
      const q = toToeicQuiz(d.id, d.data());
      if (q) out.push(q);
      else dropped += 1;
    }
    if (dropped > 0) console.warn(`[store] 모르는 mode의 토익 시험 세션 ${dropped}건을 건너뛰었어요.`);
    return out.sort(byStartedAtAsc);
  }

  async listToeicQuizzes(setId: string): Promise<ToeicQuizRecord[]> {
    // where + 다른 필드 orderBy는 복합 인덱스가 필요 — 필터만 쿼리, 정렬은 메모리(listJaQuizzes 규약)
    const snap = await this.toeicQuizzes().where("setId", "==", setId).get();
    return this.toToeicQuizList(snap.docs);
  }

  async listAllToeicQuizzes(): Promise<ToeicQuizRecord[]> {
    const snap = await this.toeicQuizzes().get();
    return this.toToeicQuizList(snap.docs);
  }

  async createToeicMock(input: NewToeicMock): Promise<ToeicMockRecord> {
    const ref = this.toeicMocks().doc();
    const record = normalizeToeicMockRecord({ ...input, id: ref.id, createdAt: new Date().toISOString(), sortIndex: null });
    await ref.set(toeicMockData(record));
    return record;
  }

  async getToeicMock(id: string): Promise<ToeicMockRecord | null> {
    const snap = await this.toeicMocks().doc(id).get();
    return snap.exists ? toToeicMock(snap.id, snap.data()!) : null;
  }

  async listToeicMocks(limit?: number): Promise<ToeicMockRecord[]> {
    const base = this.toeicMocks().orderBy("createdAt", "desc");
    const snap = await (limit == null ? base : base.limit(limit)).get();
    return snap.docs.map((d) => toToeicMock(d.id, d.data()));
  }

  async deleteToeicMock(id: string): Promise<DeleteToeicResult> {
    assertDestructiveAllowed("deleteToeicMock");
    const ref = this.toeicMocks().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false };
    const [imageSnap, attemptSnap] = await Promise.all([
      this.toeicImages().where("mockId", "==", id).get(),
      this.toeicAttempts().where("mockId", "==", id).get(),
    ]);
    const refs = [...imageSnap.docs.map((d) => d.ref), ...attemptSnap.docs.map((d) => d.ref), ref]; // 모의고사를 **마지막에**
    const db = getDb();
    for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const r of refs.slice(i, i + BATCH_LIMIT)) batch.delete(r);
      await batch.commit();
    }
    return { ok: true };
  }

  async updateToeicMockTitle(id: string, titleKo: string): Promise<ToeicMockRecord | null> {
    const ref = this.toeicMocks().doc(id);
    if (!(await ref.get()).exists) return null;
    await ref.update({ titleKo });
    const updated = await ref.get();
    return toToeicMock(updated.id, updated.data()!);
  }

  async reorderToeicMocks(orderedIds: string[]): Promise<void> {
    await reorderBySortIndex(getDb(), this.toeicMocks(), orderedIds);
  }

  async fillToeicMockPart<P extends ToeicMockPart>(
    id: string,
    part: P,
    value: ToeicMockPartRecordMap[P],
  ): Promise<FillToeicMockPartResult | null> {
    const ref = this.toeicMocks().doc(id);
    // 판정(빈 자리인가)과 쓰기를 한 트랜잭션에 — 두 요청이 같은 빈 파트를 채우려 해도 먼저 커밋한 쪽만 남는다.
    return getDb().runTransaction(async (tx): Promise<FillToeicMockPartResult | null> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const current = toToeicMock(snap.id, snap.data()!);
      if (decideFillPart(current, part) === "exists") return { outcome: "exists", record: current };
      const record = normalizeToeicMockRecord(applyFillPart(current, part, value));
      tx.update(ref, { parts: record.parts });
      return { outcome: "filled", record };
    });
  }

  async saveToeicPictureImage(input: SaveToeicPictureImageInput): Promise<SaveToeicPictureImageResult> {
    const mockRef = this.toeicMocks().doc(input.mockId);
    // 새 사진 문서 id·시각은 트랜잭션 밖에서 한 번만 — 재시도돼도 같은 문서에 같은 값을 쓴다(멱등).
    const imageRef = this.toeicImages().doc();
    const image = normalizeToeicImageRecord({
      id: imageRef.id,
      mockId: input.mockId,
      slot: input.slot,
      dataUrl: input.dataUrl,
      model: input.model,
      createdAt: new Date().toISOString(),
    });
    return getDb().runTransaction(async (tx): Promise<SaveToeicPictureImageResult> => {
      const snap = await tx.get(mockRef);
      if (!snap.exists) return { outcome: "missing", record: null };
      const current = toToeicMock(snap.id, snap.data()!);
      const decision = decidePictureImage(current, input.slot, input.imagePrompt);
      if (decision === "missing") return { outcome: "missing", record: current };
      if (decision !== "apply") return { outcome: decision, record: current };
      const record = normalizeToeicMockRecord(applyPictureImage(current, input.slot, { status: "ready", imageId: image.id }));
      const { id: _id, ...data } = image;
      // 읽기를 모두 끝낸 뒤 쓴다: 사진 문서 생성 + 모의고사 칸 갱신이 함께 커밋된다(한쪽만 남는 고아 0)
      tx.set(imageRef, data);
      tx.update(mockRef, { parts: record.parts });
      return { outcome: "saved", record, image };
    });
  }

  async markToeicPictureImageFailed(mockId: string, slot: 0 | 1, imagePrompt: string): Promise<MarkToeicPictureImageFailedResult> {
    const ref = this.toeicMocks().doc(mockId);
    return getDb().runTransaction(async (tx): Promise<MarkToeicPictureImageFailedResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { outcome: "missing", record: null };
      const current = toToeicMock(snap.id, snap.data()!);
      const decision = decidePictureImage(current, slot, imagePrompt);
      if (decision === "missing") return { outcome: "missing", record: current };
      if (decision !== "apply") return { outcome: decision, record: current };
      const record = normalizeToeicMockRecord(applyPictureImage(current, slot, { status: "failed", imageId: null }));
      tx.update(ref, { parts: record.parts });
      return { outcome: "marked", record };
    });
  }

  async getToeicImage(id: string): Promise<ToeicImageRecord | null> {
    const snap = await this.toeicImages().doc(id).get();
    return snap.exists ? toToeicImage(snap.id, snap.data()!) : null;
  }

  async createToeicAttempt(input: NewToeicAttempt): Promise<ToeicAttemptRecord> {
    const ref = this.toeicAttempts().doc();
    const record = normalizeToeicAttemptRecord({ ...input, id: ref.id });
    await ref.set(toeicAttemptData(record));
    return record;
  }

  async getToeicAttempt(id: string): Promise<ToeicAttemptRecord | null> {
    const snap = await this.toeicAttempts().doc(id).get();
    return snap.exists ? toToeicAttempt(snap.id, snap.data()!) : null;
  }

  async listToeicAttemptsByMock(mockId: string): Promise<ToeicAttemptRecord[]> {
    const snap = await this.toeicAttempts().where("mockId", "==", mockId).get();
    return snap.docs.map((d) => toToeicAttempt(d.id, d.data())).sort(byStartedAtAsc);
  }

  async listAllToeicAttempts(): Promise<ToeicAttemptRecord[]> {
    const snap = await this.toeicAttempts().get();
    return snap.docs.map((d) => toToeicAttempt(d.id, d.data())).sort(byStartedAtAsc);
  }

  async finishToeicAttempt(id: string, input: FinishToeicAttemptInput): Promise<FinishToeicAttemptResult | null> {
    const ref = this.toeicAttempts().doc(id);
    // 판정(한 번만 — decideAttemptFinish)과 쓰기를 한 트랜잭션으로: 두 요청이 겹쳐도 먼저 커밋한 끝/그만두기만 남는다.
    return getDb().runTransaction(async (tx): Promise<FinishToeicAttemptResult | null> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const current = toToeicAttempt(snap.id, snap.data()!);
      if (decideAttemptFinish(current) === "already_closed") return { outcome: "already_closed", record: current };
      const next = applyAttemptFinish(current, input);
      tx.update(ref, { finishedAt: next.finishedAt, answers: next.answers });
      return { outcome: "finished", record: next };
    });
  }

  async updateToeicAttemptAnswer(id: string, q: number, patch: ToeicAnswerScorePatch): Promise<ToeicAttemptRecord | null> {
    const ref = this.toeicAttempts().doc(id);
    return getDb().runTransaction(async (tx): Promise<ToeicAttemptRecord | null> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const next = applyAttemptAnswer(toToeicAttempt(snap.id, snap.data()!), q, patch);
      tx.update(ref, { answers: next.answers });
      return next;
    });
  }

  // ---- talkSessions·talkImages — 은우 자유대화 (english.md §12-4·§12-6) ----

  async createTalkSession(input: NewTalkSession, scene: NewTalkSceneImage | null, saveId: string): Promise<CreateTalkSessionResult> {
    // 시각은 한 번만 정한다. 대화 + 주제 일러스트를 **한 배치**로 커밋 — 한쪽만 남는 고아가 없다(생성이라 prod-guard 무관).
    // 멱등(QA english_talk_1 P2-1): 문서 id = 저장 키(그림 문서 id도 같은 값), 쓰기는 `create` — 이미 있으면 ALREADY_EXISTS로
    // 배치 전체가 거부되어(원자적) 아무것도 써지지 않는다. 그때 그 대화를 읽어 돌려준다(같은 대화 = 같은 시작 시각).
    const createdAt = new Date().toISOString();
    const write = async (id: string): Promise<TalkSessionRecord> => {
      const image = scene
        ? normalizeTalkImageRecord({ id, dataUrl: scene.dataUrl, sceneEn: scene.sceneEn, model: scene.model, createdAt })
        : null;
      const record = normalizeTalkSessionRecord({
        ...input,
        explanations: [],
        sceneImageId: image ? image.id : null,
        sceneEn: image ? image.sceneEn : null,
        id,
        createdAt,
        sortIndex: null,
      });
      const batch = getDb().batch();
      if (image) {
        const { id: _imageId, ...imageData } = image;
        batch.create(this.talkImages().doc(id), imageData);
      }
      batch.create(this.talkSessions().doc(id), talkSessionData(record));
      await batch.commit();
      return record;
    };
    try {
      return { record: await write(saveId), created: true };
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== GRPC_ALREADY_EXISTS) throw err;
      const snap = await this.talkSessions().doc(saveId).get();
      if (snap.exists) {
        const current = toTalkSession(snap.id, snap.data()!);
        if (current.startedAt === input.startedAt) return { record: current, created: false };
      }
      // 키 충돌(같은 키에 다른 대화)이나 같은 id의 그림만 남은 경우 — 남의 문서를 덮지 않고 자동 id로 새로 만든다
      return { record: await write(this.talkSessions().doc().id), created: true };
    }
  }

  async getTalkSession(id: string): Promise<TalkSessionRecord | null> {
    const snap = await this.talkSessions().doc(id).get();
    return snap.exists ? toTalkSession(snap.id, snap.data()!) : null;
  }

  async getTalkImage(id: string): Promise<TalkImageRecord | null> {
    const snap = await this.talkImages().doc(id).get();
    return snap.exists ? toTalkImage(snap.id, snap.data()!) : null;
  }

  async listTalkSessions(limit?: number): Promise<TalkSessionRecord[]> {
    // 필터 없는 단일 필드 orderBy — 모든 대화 문서는 생성 때 createdAt을 갖는다(복합 인덱스 불필요)
    const base = this.talkSessions().orderBy("createdAt", "desc");
    const snap = await (limit == null ? base : base.limit(limit)).get();
    return snap.docs.map((d) => toTalkSession(d.id, d.data()));
  }

  async listAllTalkSessions(): Promise<TalkSessionRecord[]> {
    // 스트릭(§17-9) — 전체를 읽어 메모리에서 startedAt 오름차순(날짜 필터 쿼리 없음)
    const snap = await this.talkSessions().get();
    return snap.docs
      .map((d) => toTalkSession(d.id, d.data()))
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  }

  async deleteTalkSession(id: string): Promise<DeleteTalkSessionResult> {
    assertDestructiveAllowed("deleteTalkSession"); // 대화 + 주제 일러스트 연쇄를 이 op 하나로 막는다
    const ref = this.talkSessions().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false };
    const record = toTalkSession(snap.id, snap.data()!);
    const batch = getDb().batch();
    if (record.sceneImageId) batch.delete(this.talkImages().doc(record.sceneImageId)); // 딸린 그림을 **먼저**
    batch.delete(ref); // 대화를 마지막에
    await batch.commit();
    return { ok: true };
  }

  async updateTalkSessionTitle(id: string, titleKo: string): Promise<TalkSessionRecord | null> {
    // 수정이라 prod-guard 무관 — 제목만 바꾼다(스크립트·설명·그림 불변)
    const ref = this.talkSessions().doc(id);
    if (!(await ref.get()).exists) return null;
    await ref.update({ titleKo });
    const updated = await ref.get();
    return toTalkSession(updated.id, updated.data()!);
  }

  async reorderTalkSessions(orderedIds: string[]): Promise<void> {
    // 공유 본체 reorderBySortIndex(없는 id 건너뜀). 수정이라 prod-guard 무관.
    await reorderBySortIndex(getDb(), this.talkSessions(), orderedIds);
  }

  async addTalkExplanation(id: string, explanation: TalkExplanation): Promise<AddTalkExplanationResult | null> {
    const ref = this.talkSessions().doc(id);
    // 트랜잭션 — "같은 키가 없을 때만 append"는 지금 문서를 읽고 판정해야 한다. 두 탭·연타가 같은 문장을 동시에 저장하려 해도
    // 먼저 커밋한 설명만 남고 뒤 요청은 exists로 그 설명을 받는다(설명 한 번 = 과금 한 번의 기록). append라 prod-guard 무관.
    return getDb().runTransaction(async (tx): Promise<AddTalkExplanationResult | null> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const decision = decideTalkExplanation(toTalkSession(snap.id, snap.data()!), explanation);
      if (decision.outcome === "added") tx.update(ref, { explanations: decision.record.explanations });
      return decision;
    });
  }
}
