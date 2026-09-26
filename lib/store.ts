/**
 * lib/store.ts — 저장 계층 (books / cards / readings / explanations)
 *
 * [M4] 수학 설명 기록(`explanations`)이 더해졌다 — 영어 3종과 같은 백엔드,
 * 같은 인터페이스 뒤에 산다(docs/harness/math.md §9-2).
 *
 * [§19] 아빠의 운동 사이클(`workoutCycles`) — 변경 세 개(시작·기록·취소)만 **원자 단위(파일 mutate /
 * Firestore 트랜잭션) 안에서 순수 판정 함수를 부르는** 구조다(docs/SPEC.md §19-4).
 *
 * [M3] 두 가지 `BookCardStore` 구현을 인터페이스 뒤에서 선택한다:
 * - Firestore(Native mode, Admin SDK + ADC) — `lib/store-firestore.ts` (운영)
 * - JSON 파일(data/db.json, 이 파일) — 로컬 데모·키 없는 개발용
 *
 * 선택 규칙(`resolveStoreBackend`):
 * 1) env `STORE_BACKEND=firestore|file`이 있으면 그대로 따른다 (모르는 값은 경고 후 자동 감지)
 * 2) 없으면 자동 감지 — GCP 자격증명 신호(GOOGLE_APPLICATION_CREDENTIALS /
 *    K_SERVICE(Cloud Run) / GOOGLE_CLOUD_PROJECT)가 있으면 firestore, 없으면 file.
 *    Cloud Run에서는 설정 없이 Firestore, 로컬 무자격 환경에서는 설정 없이 파일이 된다.
 *
 * 라우트·페이지는 반드시 `getStore()`가 돌려주는 인터페이스만 사용할 것 —
 * 구현 선택이 이 파일 안에서 끝나야 라우트 코드가 백엔드를 모른 채 남는다.
 *
 * 서버 전용 모듈이다(node:fs·firebase-admin 사용) — 클라이언트 컴포넌트에서 값
 * import 금지. (타입만 필요하면 `import type`으로 가져올 것: 빌드 시 제거되어 안전하다)
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Card, Chapter, SceneDigestItem, SceneSourceKind } from "./ai/english/schemas";
// 수학 설명 기록(M4)이 통째로 안는 타입들 — **전부 `import type`이다.**
// `lib/ai/math/pipeline.ts`는 openai 클라이언트를 값으로 끌고 오므로 값 import를
// 하면 저장 계층이 AI 모듈에 묶인다. 타입만 가져오면 빌드에서 지워진다.
import type { ExplainVerifyReport } from "./ai/math/pipeline";
import type { Explanation } from "./ai/math/schemas";
// 단어장 정복(V1) 완성형 항목 — **`import type`이다.** `vocabbook-schemas.ts`는 zod를
// 값으로 끌고 오지만, 타입만 가져오면 빌드에서 지워져 저장 계층이 AI 모듈에 묶이지 않는다.
import type { VocabEntry, VocabMeaning, VocabRelated } from "./ai/english/vocabbook-schemas";
import { normalizeRelated } from "./ai/english/vocabbook-schemas";
// 아빠의 일본어 J1/J2/J3 — 완성형 단어 항목·레벨·대화 타입(**타입만** import). 값 정규화는 ai-engineer의 단일 정의처를 쓴다.
import type {
  JaVocabEntry,
  JlptLevel,
  JaDialogTurn,
  JaDialogCoaching,
  JaToken,
  JaDialogFeedback,
} from "./ai/japanese/schemas";
// 저장 방어 정규화 단일 정의처(lib/ai/japanese/vocab.ts) — store가 이 헬퍼를 호출한다(인계 #1, 영어 normalizeRelated 관용구).
// 순수 함수라 값 import여도 저장 계층이 OpenAI에 묶이지 않는다(isVocabBookEnriched·normalizeRelated와 같은 갈래).
import { normalizeJaVocabEntry } from "./ai/japanese/vocab";
// 시험 모드 유니온(J2·JK) — 단일 정의처(lib/ai/japanese/quiz.ts). **타입만** import(재정의 금지).
import type { JaQuizMode, JaKanjiQuizMode } from "./ai/japanese/quiz";
// enriched 재계산의 단일 정의처(V8). 순수 함수라(타입만 import) 값으로 끌어와도 저장 계층이
// openai/client에 묶이지 않는다 — appendVocabEntry가 새 단어를 붙일 때 enriched를 다시 굳힌다.
import { isVocabBookEnriched } from "./ai/english/vocabbook-enrich";
// 시험(V4) 모드 유니온 — 순수 모듈이라 값 import여도 저장 계층이 AI에 묶이지 않는다(타입만 쓴다).
import type { VocabQuizMode } from "./vocab-quiz";
// "모은 단어" 수집 단어장의 안정 마커(dayLabel)·초기 이름. 타입 없는 상수 모듈이라 값으로 끌어와도
// 저장 계층이 AI에 묶이지 않는다(M2 챕터 리더 더블탭 담기).
import { COLLECTED_VOCAB_DAY_LABEL, COLLECTED_VOCAB_TITLE_KO } from "./collected-vocab-contract";
import type { SceneTier } from "./scene/types";
// 아빠의 운동(SPEC §19-4) — 타입의 **단일 정의처는 순수 엔진 lib/workout.ts**다. store는 `import type`으로 가져와
// 재수출만 한다. 판정(decide*)·정규화는 순수 함수라 값 import여도 저장 계층이 AI에 묶이지 않는다(런타임 의존성 ./kst뿐).
// ⚠️ 방향은 store → workout 한쪽뿐 — 엔진이 store를 import하면 node:fs·firebase-admin이 클라이언트·eval로 샌다.
import type {
  ClosedCycleStatus,
  DecideLogInput,
  DecideStartInput,
  DecideUndoInput,
  FailedAt,
  WorkoutCycleRecord,
  WorkoutEvent,
  WorkoutRm,
} from "./workout";
import { decideLog, decideStart, decideUndo, normalizeWorkoutCycle } from "./workout";
// 아빠의 영어(토익스피킹, docs/harness/toeic.md §7) — 하위 타입의 단일 정의처는 lib/ai/toeic/schemas(**타입만** import).
// 정규화는 두 백엔드 공유 단일 정의처(lib/toeic-normalize.ts), 포인트 병합은 순수 함수(lib/ai/toeic/points.ts)를 부른다
// — 둘 다 openai를 끌고 오지 않는다(zod만). 시험 모드 유니온은 클라이언트 안전 순수 모듈 lib/toeic-quiz.ts가 정의처다.
import type {
  ToeicAnswer,
  ToeicAttemptScope,
  ToeicBookQuiz,
  ToeicExprEntry,
  ToeicMockParts,
  ToeicMockPartRecordMap,
  ToeicPointsItem,
  ToeicSetSource,
} from "./ai/toeic/schemas";
import type { ToeicMockPart, ToeicTargetGrade } from "./toeic-mock";
import type { ToeicQuizMode } from "./toeic-quiz";
import { applyPointsResults } from "./ai/toeic/points";
// 모의고사 파트 채우기·사진 저장 판정 — 두 백엔드가 같은 함수로(lib/toeic-mock-apply.ts, 런타임 import 0)
import { applyFillPart, applyPictureImage, decideFillPart, decidePictureImage } from "./toeic-mock-apply";
// 응시 끝/그만두기는 한 번만 — 두 백엔드가 같은 판정으로(lib/toeic-attempt-rules.ts, 런타임 import는 순수 lib/toeic-mock뿐)
import { decideAttemptFinish } from "./toeic-attempt-rules";
import {
  normalizeToeicAnswer,
  normalizeToeicAttemptRecord,
  normalizeToeicImageRecord,
  normalizeToeicMockRecord,
  normalizeToeicQuizItem,
  normalizeToeicQuizRecord,
  normalizeToeicSetRecord,
} from "./toeic-normalize";
// 은우 자유대화(docs/harness/english.md §12-4·§12-6) — 하위 타입의 단일 정의처는 lib/ai/english/talk-schemas(**타입만** import).
// 정규화·설명 추가 판정은 두 백엔드 공유 단일 정의처(lib/talk-normalize.ts — openai 없음).
import type { TalkCard, TalkExplanation, TalkTopic, TalkTurn } from "./ai/english/talk-schemas";
import { decideTalkExplanation, normalizeTalkImageRecord, normalizeTalkSessionRecord } from "./talk-normalize";
import { FirestoreStore } from "./store-firestore";

export type { ClosedCycleStatus, FailedAt, WorkoutCycleRecord, WorkoutEvent, WorkoutRm };

// ---------------------------------------------------------------------------
// 레코드 타입 (SPEC §5 데이터 모델)
// ---------------------------------------------------------------------------

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  series: string | null;
  isbn: string | null;
  arLevel: number | null;
  lexile: number | null;
  wordCount: number | null;
  arQuizNo: string | null;
  isFiction: boolean;
  topic: string;
  coverUrl: string | null;
  googleBooksId: string | null;
  /**
   * SPEC §5에는 없는 추가 필드 — §8이 "이모지 커버"를 요구하고 M2 판독 결과에
   * coverEmoji가 있어 저장할 곳이 필요하다. 빌드 리포트에 판단 근거 기록.
   */
  coverEmoji: string | null;
  /**
   * SPEC §5에는 없는 추가 필드 — 소개글(공개 description). "다시 생성" 시
   * 같은 입력(§3-2 템플릿의 googleBooksDescription)을 재사용하기 위해 보관한다.
   */
  description: string | null;
  levelEstimated: boolean;
  createdAt: string; // ISO 8601

  /**
   * --- 줄거리 근거 3필드 (SPEC §5) ---
   *
   * 사진 원본을 저장하지 않으므로(§1) 이 요약이 **유일한 사본**이다. "다시 생성"이
   * 사진 재업로드 없이 같은 근거로 돌아야 하고, 그러지 못하면 storySource가
   * metadata로 떨어져 줄거리가 3~4문장으로 조용히 퇴화한다(QA F7).
   *
   * 선택(?)이 아니라 **필수 nullable**로 둔 것은 의도다 — book을 만드는 곳에서
   * 빠뜨리면 컴파일이 깨져야 근거 유실을 사람이 아니라 타입이 막는다.
   */
  /** 호출 A가 뒤표지·책날개에서 판독한 출판사 소개글 */
  blurbText: string | null;
  /** sceneDigest의 출처. 빠뜨리면 배지가 "목차 기반" 대신 "본문 확인"으로 오표기된다 */
  sceneKind: SceneSourceKind | null;
  /** 호출 A′의 장면별 요약. 저장 전 normalizeSceneDigest()를 통과시킬 것(Firestore는 undefined 거부) */
  sceneDigest: SceneDigestItem[] | null;

  /**
   * --- 유튜브 낭독 자막 근거 (transcript grounding) ---
   *
   * 부모가 넣은 "책 낭독 영상"에서 받은 자막 전문. **최상위 근거 티어**(storySource=transcript,
   * 배지 "낭독 확인")로 카드가 자막 밖을 지어내지 못하게 하는 grounding이다. sceneDigest와 같은
   * 격의 **내부 근거** — 화면에 원문을 표시하지 않고(SPEC §1 본문 재현 금지), "다시 생성"이 사진·
   * 영상 재입력 없이 같은 근거로 돌도록 보관한다. 여기가 비면 재생성 시 storySource가 강등된다.
   */
  transcript: string | null;
  /** 자막을 받아 온 유튜브 영상 URL — 재생성·표기용(자막 본문은 transcript에 별도 보관) */
  youtubeUrl: string | null;

  /**
   * --- 챕터 리더 (호출 F · 챕터화, docs/harness/english.md §9) ---
   *
   * 낭독 자막(transcript)이 있을 때 채워진다(목차는 선택). 목차(sceneKind='toc') 챕터 제목이
   * 있으면 챕터별로, 없으면 자막 전체를 "전체" 단일 챕터로 나눈다.
   * `chapterizeTranscript()`가 자막을 챕터별 영어 원문(en)/우리말 해석(ko) 문장으로 나눈 결과다.
   *
   * **이 필드에 한해 영어 원문을 그대로 저장·표시한다** — 가족 전용 챕터 리더로, §9 서두가
   * SPEC §1 "본문 재현 금지"를 이 결과에만 완화했다(사용자 확정). 저장되는 모든 en은
   * groundChapters()를 지나 자막 부분문자열임이 보장된다.
   *
   * 옛 레코드(챕터화 이전)에는 이 키가 없다 — 읽을 때 null로 메운다(하위호환). null이면
   * 챕터 리더 섹션을 통째로 생략하므로 목차/자막 없는 카드 흐름은 바이트 동일하다(회귀 0).
   */
  chapters: Chapter[] | null;

  /**
   * --- 서재 수동 정렬 인덱스 ---
   *
   * 사용자가 서재 관리 모드에서 드래그·↑/↓로 맞춘 순서. 재배치하면 그 시점 목록 **전체**가
   * 0..n으로 재색인돼 여기에 박힌다(reorderBooks). 아직 손대지 않은 책은 null이다.
   *
   * 정렬 규칙(app/library/page.tsx): **null이 먼저**(createdAt 역순 = 최신이 위) → 그다음
   * sortIndex 있는 항목(오름차순). 즉 새로 만든 책(sortIndex=null)은 늘 맨 위에 뜨고, 사용자가
   * 맞춘 정렬 블록은 그 아래에 고정된다.
   *
   * 선택(?)이 아니라 **필수 nullable**로 둔 것은 근거 3필드와 같은 이유다 — 옛 레코드·신규
   * 생성에서 빠뜨리면 타입이 막는다. 생성 경로(createBook)는 항상 null로 시작한다(NewBook에서 제외).
   */
  sortIndex: number | null;
}

/**
 * 근거 필드만 갱신하는 패치 — `/api/pages`가 기존 책에 장면 메모를 붙이거나, 같은 책을
 * "그래도 새로 만들기"로 재사용할 때 이번에 새로 얻은 근거를 덮어쓴다.
 * 지정한 키만 덮어쓴다(생략한 키는 보존).
 */
export interface BookEvidencePatch {
  blurbText?: string | null;
  sceneKind?: SceneSourceKind | null;
  sceneDigest?: SceneDigestItem[] | null;
  transcript?: string | null;
  youtubeUrl?: string | null;
  /** 챕터화(호출 F) 결과 — /api/chapterize가 목차+자막으로 만들어 붙인다(재나누기 시 덮어씀) */
  chapters?: Chapter[] | null;
}

/**
 * 챕터 리더를 열 수 있는 책인가 — **낭독 자막(transcript)이 있으면** 된다(docs/harness/english.md §9).
 * 목차(sceneKind='toc')는 선택이다: 있으면 챕터별로 나누고, 없으면 자막 전체를 "전체" 단일 챕터로
 * 만든다(chapterizeTranscript에 빈 배열을 넘기면 됨). 자막이 이 리더의 유일한 필수 입력이다.
 *
 * 챕터 리더 노출(서버 페이지)과 /api/chapterize의 전제조건이 **같은 정의**를 봐야 서로
 * 어긋나지 않는다(QA F12식 드리프트 방지). 자막 없으면 false → 리더 미노출(회귀 0).
 */
export function canChapterizeBook(book: Pick<BookRecord, "transcript">): boolean {
  return (book.transcript?.trim() ?? "") !== "";
}

export interface CardRecord {
  id: string;
  bookId: string;
  content: Card; // SPEC §6 학습 카드 JSON
  model: string;
  createdAt: string; // ISO 8601
}

/** readings — M3(서재·읽음 기록)에서 사용. M1에서는 자리만 잡아 둔다. */
export interface ReadingRecord {
  id: string;
  bookId: string;
  readAt: string; // ISO 8601
  rating: number | null; // 1~5
  noteKo: string | null;
}

/**
 * 호출 B에 넣은 입력 그대로 (= `MathExplainRequest`의 정규화된 형태, math.md §9-1).
 *
 * **선택(?)이 아니라 필수 nullable이다** — BookRecord의 근거 3필드와 같은 이유로,
 * 만드는 쪽에서 빠뜨리면 타입이 먼저 막는다. Firestore는 undefined를 거부하기도 한다.
 */
export interface MathProblemInput {
  number: string | null;
  text: string;
  figureDesc: string | null;
  givens: { label: string; value: number; unit: string | null }[] | null;
  childAnswer: string | null;
  childWork: string | null;
  childNote: string | null;
}

/**
 * 설명 1건 = 문서 1개 (math.md §9-1). 목록·통계용 요약 인덱스를 따로 두지 않는다 —
 * 필요한 값(problemPattern·childGrade·verify.status)이 전부 이 문서 안에 있고,
 * 가족용 규모(수백 건)에서는 전문을 읽어도 무겁지 않다. `CardRecord`가 `content: Card`를
 * 통째로 안는 것과 같은 규약이다.
 */
export interface ExplanationRecord {
  id: string;
  /** 무엇을 물었는가 — 다시 보기 화면과 재생성·연습문제(호출 D)가 같은 입력을 다시 쓴다 */
  problem: MathProblemInput;
  /** 3막 설명 전문. 장면 검산이 실패했으면 `content.scene`은 null이다 */
  content: Explanation;
  /** 호출 E 결과 — M4 시점에는 항상 null (M2.5에서 채워진다) */
  sceneHtml: string | null;
  sceneTier: SceneTier;
  /** §8이 요구하는 {problemPattern, status, attempts} 집계의 원천 */
  verify: ExplainVerifyReport;
  /** 설명을 만든 모델 ID */
  model: string;
  createdAt: string; // ISO 8601

  /**
   * 수학 서재 수동 정렬 인덱스 — 서재(BookRecord.sortIndex)와 **같은 규약**이다.
   * 사용자가 관리 모드에서 맞춘 순서. 재배치하면 그 시점 목록 전체가 0..n으로 재색인된다
   * (reorderExplanations). 아직 손대지 않은 기록은 null(=미정렬, 맨 위 블록).
   * 필수 nullable — 생성 경로(createExplanation)는 항상 null로 시작한다(NewExplanation에서 제외).
   */
  sortIndex: number | null;
}

/**
 * 단어장 한 DAY = 문서 1개 (단어장 정복 V1, english.md §7-6).
 *
 * DAY 하나를 사진 2~4장으로 판독→병합한 결과를 `entries` 배열로 통째로 안는다 —
 * `CardRecord.content`가 학습 카드를, `ExplanationRecord.content`가 3막 설명을 통째로
 * 안는 것과 같은 규약이다. 단어 하나하나를 따로 문서로 쪼개지 않는다(목록·표가 DAY 단위).
 *
 * **원본 사진은 저장하지 않는다**(SPEC §5·§7-6). 병합된 `entries`만 남긴다.
 * `photoCount`는 판독에 쓴 사진 수(사진 자체가 아니라 개수만) — "몇 장으로 만들었나" 표시용.
 */
export interface VocabBookRecord {
  id: string;
  /** 화면·목록에 뜨는 이름. 페이지 사진에 책 제목이 없을 수 있어 엄빠가 정하거나 dayLabel로 채운다 */
  titleKo: string;
  /** 판독된 단원 표기(예: "DAY 01"). 없으면 null */
  dayLabel: string | null;
  /** 병합·정렬된 단어 목록 (호출 C → mergeVocabPages 결과) */
  entries: VocabEntry[];
  /** 판독에 쓴 사진 수 */
  photoCount: number;
  /** 영영 정의·이모지(호출 D, V3)를 채웠는지. V1에서는 항상 false */
  enriched: boolean;
  /** 판독한 모델 ID */
  model: string;
  createdAt: string; // ISO 8601

  /**
   * 단어장 목록 수동 정렬 인덱스 — 서재(BookRecord.sortIndex)와 **같은 규약**이다.
   * 사용자가 관리 모드에서 맞춘 순서. 재배치하면 그 시점 목록 전체가 0..n으로 재색인된다
   * (reorderVocabBooks). 아직 손대지 않은 단어장은 null(=미정렬, 맨 위 블록).
   * 필수 nullable — 생성 경로(createVocabBook)는 항상 null로 시작한다(NewVocabBook에서 제외).
   */
  sortIndex: number | null;
}

/** 단어장 삭제 결과 — `{ ok }` 하나면 충분하다(연쇄로 지운 퀴즈 수는 안내에 쓰지 않는다) */
export interface DeleteVocabBookResult {
  ok: boolean;
}

/**
 * 일본어 JLPT 단어장 레코드 (아빠의 일본어 §7-1). **전부 필수 nullable — 선택(?) 키 금지**(store 규약).
 * - `kind`: "jlpt"(호출 A 생성분) 또는 "collected"(대화에서 모은 단어, J5). JLPT 단어장과 섞지 않는다(§7-5).
 * - `levels`: 이 단어장이 다루는 레벨들(collected면 빈 배열). `topic`: 주제(없으면 null).
 * - `entries`: 후처리(applyVocabPostprocess) 완료된 저장용 항목. `model`: 생성 모델 id.
 */
export interface JaVocabBookRecord {
  id: string;
  titleKo: string;
  kind: "jlpt" | "collected";
  entries: JaVocabEntry[];
  levels: JlptLevel[];
  topic: string | null;
  model: string;
  createdAt: string; // ISO 8601
  /** 목록 수동 정렬 인덱스 — 서재와 같은 규약. 미정렬은 null(맨 위 블록). 생성부는 항상 null로 시작. */
  sortIndex: number | null;
}

/** 일본어 단어장 삭제 결과 — deleteVocabBook과 같은 규약 */
export interface DeleteJaVocabBookResult {
  ok: boolean;
}

/**
 * 일본어 시험 문항 결과 하나 (J2, §7-3). 영어 `VocabQuizItem`과 같은 3상태(맞힘/틀림/미응답).
 * `word`는 엔트리 정체(표기) — 모드가 달라도 채점·집계는 word로 잇는다.
 */
export interface JaQuizItem {
  word: string;
  correct: boolean;
  /** 답을 골랐으면 true, 이 세션에서 답 못 했으면(그만하기) null */
  answered: boolean | null;
}

/**
 * 일본어 시험 세션 한 판 (J2, §7-3). **영어 `VocabQuizRecord`와 컬렉션이 분리된다**(영어 집계에 일본어가 섞이면 안 된다).
 * `mode`는 그 세션의 **콘텐츠 모드**(집계를 모드별로 가르는 축, §6-2) — 타입은 단일 정의처 `JaQuizMode`(재정의 금지, 인계 #2).
 * 시험 활동은 이 컬렉션에 append로만 쌓인다(수정·삭제 API 없음 — 단어장 삭제 시 연쇄 삭제만).
 */
export interface JaQuizRecord {
  id: string;
  /** 어느 단어장인가 — JaVocabBookRecord.id */
  bookId: string;
  mode: JaQuizMode;
  startedAt: string; // ISO 8601
  /** 끝까지 풀면 ISO, "그만하기" 중단이면 null */
  finishedAt: string | null;
  items: JaQuizItem[];
}

/**
 * 한자 정보 레코드 (아빠의 일본어 JK, §12-3). 단어장에서 **파생**되지만 **별도 컬렉션**이다 — 단어장을 지워도
 * 한자 정보는 남는다(다른 단어장에서 또 쓰인다). `deleteJaKanji`는 두지 않는다(수집 파생물, §12-3). 한자가 든
 * 단어 목록은 저장하지 않는다(읽을 때 단어장에서 계산). `kanji`가 조회·중복 키.
 */
export interface JaKanjiRecord {
  id: string;
  /** 한자 한 글자 — 조회·upsert 키 */
  kanji: string;
  /** 한국 한자음 한 글자(다리). 한국에서 안 쓰는 한자(국자 등)면 null */
  koReading: string | null;
  /** 음독(히라가나) — 실제 쓰이는 것만 */
  onyomi: string[];
  /** 훈독(히라가나 사전형). 없으면 빈 배열 */
  kunyomi: string[];
  /** 한국어 뜻(짧게) */
  meaningKo: string;
  model: string;
  createdAt: string; // ISO 8601
}

/**
 * 한자 시험 세션 (JK, §12-4). **단어 시험(JaQuizRecord)과 별도 컬렉션**이라 집계가 섞이지 않는다(모드 무오염).
 * 단어장이 아니라 전역 한자 풀 대상이라 `bookId` 대신 `scope:"kanji"`. mode는 단일 정의처 `JaKanjiQuizMode`(재정의 금지).
 * items의 `word` 자리에 **한자 문자**가 들어간다(채점·집계 키, buildJaKanjiQuizQuestions 규약).
 */
export interface JaKanjiQuizRecord {
  id: string;
  scope: "kanji";
  mode: JaKanjiQuizMode;
  startedAt: string;
  finishedAt: string | null;
  items: JaQuizItem[];
}

/**
 * 듀오링고 대화 복습 레코드 (아빠의 일본어 §7-2). **전사가 본체, 해설은 부수 효과** — 호출 C가 실패해도
 * `coaching: null`로 저장하고 화면에서 "해설 다시 만들기"로 채운다. **사진 원본은 저장하지 않는다**(SPEC §1) —
 * 기록에 남는 것은 전사된 텍스트(turns)뿐. sortIndex는 목록 수동 정렬(단어장과 같은 규약).
 */
export interface JaDialogRecord {
  id: string;
  /** 화면 이름 — 판독에 제목이 없어 사용자가 정하거나 focusKo로 채운다 */
  titleKo: string;
  /** 이 대화의 학습 주제(첫 화면에 있을 수 있다). 없으면 null */
  focusKo: string | null;
  /** 전사된 발화들(호출 B 병합 결과). 본체 */
  turns: JaDialogTurn[];
  /** 학습 해설(호출 C). 실패·미생성이면 null(전사는 그대로 남는다) */
  coaching: JaDialogCoaching | null;
  /** 판독에 쓴 사진 수 */
  photoCount: number;
  /** 사진 밖으로 잘려 일부만 판독됐으면 true */
  partial: boolean;
  model: string;
  createdAt: string; // ISO 8601
  /** 목록 수동 정렬 인덱스 — 미정렬은 null(맨 위). 생성부는 null로 시작. */
  sortIndex: number | null;
}

/** 대화에서 모은 단어 담기 결과 (J5, §7-5). appendVocabEntry와 같은 규약. */
export interface AppendJaVocabResult {
  record: JaVocabBookRecord | null;
  appended: boolean;
}

/**
 * 단어 1개 추가 결과 (V8 더블탭 담기). "성공 = 그 단어가 이제 이 단어장에 있다"로 읽는다.
 * - `record: null`  → 없는 단어장(404). 담을 곳이 없다.
 * - `appended:true` → 새로 붙였다(record는 갱신본).
 * - `appended:false`(record는 non-null) → **이미 있어(대소문자 무시 word) 붙이지 않았다**(중복).
 *   record는 손대지 않은 현재 레코드 그대로다.
 */
export interface AppendVocabEntryResult {
  record: VocabBookRecord | null;
  appended: boolean;
}

/**
 * 유의어/반의어 연결·해제 입력 (단어장 정복 V8, 관계 문제). 사용자가 단어장 안의 다른 (단어+뜻)을
 * 골라 잇는다. 넷 다 `entries` 배열의 0-based 인덱스(단어)·뜻 인덱스다 — no가 아니라 인덱스로
 * 가리키는 이유는 `lib/vocab-link-contract.ts` 주석("왜 인덱스인가") 참고(손입력 단어는 no가 null).
 */
export interface VocabLinkInput {
  sourceIndex: number;
  sourceMeaningIndex: number;
  targetIndex: number;
  targetMeaningIndex: number;
  /** 유의어·반의어만(파생어 제외). syn/ant는 대칭이라 양쪽 뜻에 같은 kind로 상호 기록된다. */
  kind: "synonym" | "antonym";
}

/**
 * 연결·해제 결과 (단어장 정복 V8). `AppendVocabEntryResult`가 record:null로 404를 알리듯,
 * 여기선 세 상태를 status로 가른다 — 라우트가 그대로 200/400/404로 옮긴다.
 * - `"ok"`        → 연결/해제 반영됨(record는 갱신본). **멱등**: 이미 있는 링크를 또 걸거나 없는 링크를
 *                   풀어도 예외 없이 ok(record는 현재 레코드).
 * - `"not_found"` → 없거나 열 수 없는 단어장(404).
 * - `"invalid"`   → 인덱스 범위 밖·뜻 인덱스 밖·자기 자신 연결(source==target) 등 방어 실패(400).
 */
export type VocabLinkResult =
  | { status: "ok"; record: VocabBookRecord }
  | { status: "not_found" }
  | { status: "invalid" };

/**
 * 시험 한 문항의 결과 (단어장 정복 V4, 계획 §V4).
 *
 * **전부 필수 nullable — 선택(?) 키 금지**(lib/store.ts:73 규약, Firestore undefined 거부).
 * 시험은 **저장된 정의를 소비만** 하므로(정의 불변, 계획 §V3) 여기 담는 것은 "무엇을 물었고
 * 맞혔는가"뿐이다. 단어는 인덱스가 아니라 `word` 문자열로 잇는다(전사본 entries를 건드리지 않음).
 *
 * 세 상태를 `answered`·`correct`로 나눠 담는다(V5 오답노트가 이걸 읽어 wrong·total·streak을 낸다):
 * - 맞힘:   `answered:true,  correct:true`
 * - 틀림:   `answered:true,  correct:false`
 * - 미응답: `answered:null,  correct:false`  ← "그만하기"로 이 문항에 답하지 못함(세션에 포함은 됐다)
 *
 * `answered === true`인 항목만 "실제로 푼 문항"이다 — V5는 그것만 시도로 센다.
 */
export interface VocabQuizItem {
  /** 문제의 정답 영단어(표제어). 전사본 entries와 word 문자열로 잇는다 */
  word: string;
  /** 맞혔으면 true. 틀렸거나 미응답이면 false */
  correct: boolean;
  /** 답을 골랐으면 true, 이 세션에서 답하지 못했으면(그만하기) null */
  answered: boolean | null;
}

/**
 * 시험 세션 한 판 = 문서 1개 (단어장 정복 V4).
 *
 * **전사본(VocabBookRecord)을 건드리지 않는 별도 컬렉션이다** — 시험 활동은 여기 append로만
 * 쌓인다(수정·삭제 없음). 집계(정복률·오답 수)는 저장하지 않고 **읽을 때 계산**한다(V5).
 * 그래서 append만 있는 이 레코드에는 prod-guard를 걸지 않는다(삭제가 아니다).
 */
export interface VocabQuizRecord {
  id: string;
  /** 어느 단어장(DAY)의 시험인가 — VocabBookRecord.id */
  bookId: string;
  /** 어떤 판이었나 — "def-to-word"(일반 시험) 또는 "wrong-review"(오답복습 재시험, V5). 집계는 모드 무관 */
  mode: VocabQuizMode;
  /** 세션 시작 시각 ISO 8601 — 목록 정렬·streak 계산의 시간 축 */
  startedAt: string;
  /** 끝까지 풀면 완료 시각 ISO, "그만하기"로 중단(부분 결과)이면 null */
  finishedAt: string | null;
  /** 세션의 문항별 결과 (셔플된 문제 순서 그대로) */
  items: VocabQuizItem[];
}

// ---------------------------------------------------------------------------
// 아빠의 영어(토익스피킹) — 레코드 5종·컬렉션 5개 (docs/harness/toeic.md §7)
// 은우 영어(vocabBooks·vocabQuizzes)·일본어 컬렉션과 **섞지 않는다**(§0-1 — 섞으면 은우 스트릭·오답노트가 오염된다).
// 전부 필수 nullable — 선택(?) 키 금지(Firestore undefined 거부). 정규화는 lib/toeic-normalize.ts 한 곳.
// ---------------------------------------------------------------------------

/** 표현집 한 DAY = 문서 1개 (§7-1). 사진 원본은 저장하지 않는다(photoCount만). */
export interface ToeicSetRecord {
  id: string;
  /** 기본 "DAY {n} {topicKo}"(defaultToeicSetTitle) — 사용자가 고칠 수 있다 */
  titleKo: string;
  dayNo: number | null;
  topicKo: string | null;
  source: ToeicSetSource;
  /** 가져오기 멱등 키(§7-6). 사진이면 null */
  presetKey: string | null;
  entries: ToeicExprEntry[];
  quiz: ToeicBookQuiz[];
  /** 판독에 쓴 사진 수. 가져오기면 0 */
  photoCount: number;
  /** entries 전부 points !== null — 저장 계층이 entries에서 다시 계산한다(파생 상태) */
  enriched: boolean;
  /** 판독 모델. 가져오기면 null */
  model: string | null;
  createdAt: string; // ISO 8601
  /** 목록 수동 정렬 인덱스 — 서재와 같은 규약(미정렬 null이 맨 위, 생성부는 null로 시작) */
  sortIndex: number | null;
}

/** 표현 시험 문항 결과(§7-3) — 영어·일본어와 같은 3상태. `word` = 항목 키(§6-1: 표현 또는 QUIZ 키) */
export interface ToeicQuizItem {
  word: string;
  correct: boolean;
  answered: boolean | null;
}

/**
 * 표현 시험 세션(§7-3) — **한 레코드 = 한 모드**(혼합 세션은 화면이 모드별로 갈라 모드마다 POST, §6-2 무오염).
 * append 전용(수정·삭제 API 없음). 세트를 지우면 그 세트의 세션도 지운다.
 */
export interface ToeicQuizRecord {
  id: string;
  setId: string;
  mode: ToeicQuizMode;
  startedAt: string;
  /** 끝까지 풀면 ISO, 그만하기면 null */
  finishedAt: string | null;
  items: ToeicQuizItem[];
}

/** 모의고사 한 세트(§7-2) — 실패·미선택 파트는 null. 완전한 11문항 = 다섯 파트 모두 non-null(T3가 채운다). */
export interface ToeicMockRecord {
  id: string;
  titleKo: string;
  targetGrade: ToeicTargetGrade;
  /** 호출 C에 넘긴 활용할 표현(normalizeMockExpressions 결과 그대로 — 보낸 목록 = 저장 목록) */
  expressionsUsed: string[];
  /**
   * 호출 C에 넘긴 주제 힌트(공백 정리·중복 제거 후 그대로). "이 파트 다시 만들기"가 처음과 **같은 입력**(등급·주제·표현)으로
   * 부르게 레코드에 둔다(§7-2 — 스펙 공백을 채운 필드). 이 필드 이전 문서는 빈 배열로 읽는다(normalize).
   */
  topicHints: string[];
  parts: ToeicMockParts;
  model: string;
  createdAt: string;
  sortIndex: number | null;
}

/** Q3–4 생성 사진 한 장 = 문서 하나(§7-4). AI가 만든 사진이라 "원본 사진 미저장"(SPEC §13) 대상이 아니다. */
export interface ToeicImageRecord {
  id: string;
  mockId: string;
  slot: 0 | 1;
  /** image/jpeg base64, ≤ 900,000자(관문 P가 보장) */
  dataUrl: string;
  model: string;
  createdAt: string;
}

/** 모의고사 응시(§7-5). 녹음은 기기(IndexedDB)에만 — 서버에는 전사문·점수·피드백만. */
export interface ToeicAttemptRecord {
  id: string;
  mockId: string;
  scope: ToeicAttemptScope;
  parts: ToeicMockPart[];
  startedAt: string;
  /** null = 중간에 그만둠 */
  finishedAt: string | null;
  answers: ToeicAnswer[];
}

/** 표현집·모의고사 삭제 결과 — deleteVocabBook과 같은 규약 */
export interface DeleteToeicResult {
  ok: boolean;
}

/** 가져오기 결과(§7-6) — 같은 presetKey가 이미 있으면 건너뛴다(멱등). */
export interface ImportToeicSetsResult {
  created: ToeicSetRecord[];
  /** 이미 있어서(또는 같은 파일 안에서 중복이라) 건너뛴 presetKey */
  skippedKeys: string[];
}

/** 발화 포인트 병합 저장 결과(§3-4) — 병합은 저장 원자 단위 **안에서** 최신 entries에 한다. */
export interface MergeToeicSetPointsResult {
  record: ToeicSetRecord;
  /** 이번에 실제로 채우거나(빈 자리) 갈아 끼운(force) 항목 수 */
  filled: number;
  /** 이번에 대상이었지만 채우지 못한 항목 수 */
  remaining: number;
}

/** 응시 끝/그만둠(§7-5) — 문항별 녹음 여부·길이를 채운다(점수는 건드리지 않는다). */
export interface FinishToeicAttemptInput {
  finishedAt: string | null;
  answers: { q: number; recorded: boolean; durationMs: number | null }[];
}

/**
 * 끝/그만둠 결과 — **한 번만** 받는다(lib/toeic-attempt-rules decideAttemptFinish). `already_closed`면 아무것도 쓰지 않았다
 * (record는 저장돼 있던 그대로). 없는 id면 스토어가 null.
 */
export type FinishToeicAttemptResult = { outcome: "finished" | "already_closed"; record: ToeicAttemptRecord };

/** 문항 하나의 채점 결과(§5-0 5) — 그 문항만 갱신한다. */
export type ToeicAnswerScorePatch = Pick<ToeicAnswer, "transcript" | "readDiff" | "feedback" | "score" | "scoredAt">;

/**
 * 파트 채우기 결과(§4-0 "이 파트 다시 만들기") — **빈 자리만** 채운다(lib/toeic-mock-apply.ts decideFillPart).
 * `exists`면 아무것도 쓰지 않았다(그사이 다른 요청이 채웠다). 없는 id면 스토어가 null.
 */
export type FillToeicMockPartResult = { outcome: "filled" | "exists"; record: ToeicMockRecord };

/** 생성 사진 저장 입력(관문 P, §4-10) — 사진 문서 생성과 모의고사 칸 갱신을 **한 원자 단위**로 한다. */
export interface SaveToeicPictureImageInput {
  mockId: string;
  slot: 0 | 1;
  /** 사진을 만든 C2 imagePrompt — 지금 레코드의 장면과 다르면 쓰지 않는다(stale) */
  imagePrompt: string;
  /** image/jpeg base64, ≤ 900,000자(관문 P가 보장) */
  dataUrl: string;
  model: string;
}

/**
 * 생성 사진 저장 결과. `saved`만 사진 문서를 만들었다 — 나머지는 아무것도 쓰지 않았다(고아 사진 0).
 * - kept: 그 칸이 이미 ready(먼저 준비된 사진이 이긴다) — `record`의 사진을 쓰면 된다
 * - stale: 장면이 바뀌었다 · missing: 모의고사·picture 파트·칸이 없다
 */
export type SaveToeicPictureImageResult =
  | { outcome: "saved"; record: ToeicMockRecord; image: ToeicImageRecord }
  | { outcome: "kept" | "stale"; record: ToeicMockRecord }
  | { outcome: "missing"; record: ToeicMockRecord | null };

/**
 * 사진 실패 기록 결과 — ready인 칸은 failed로 내리지 않는다(kept). 없는 모의고사·칸이면 missing.
 */
export type MarkToeicPictureImageFailedResult =
  | { outcome: "marked" | "kept" | "stale"; record: ToeicMockRecord }
  | { outcome: "missing"; record: ToeicMockRecord | null };

// ---------------------------------------------------------------------------
// 은우 자유대화 — 컬렉션 `talkSessions` (docs/harness/english.md §12-4, SPEC §21-3)
// 은우 단어장 컬렉션(vocabBooks·vocabQuizzes)과 **섞지 않는다**(숙련도·오답노트 오염 방지). 음성·녹음은 저장하지 않는다 —
// 글자 스크립트·주제 스냅샷·설명만. 전부 필수 nullable(선택 키 금지 — Firestore undefined 거부). 정규화는 lib/talk-normalize.ts 한 곳.
// ---------------------------------------------------------------------------

/**
 * 자유대화 한 번 = 문서 1개(§12-4). 저장 조건은 은우 발화 ≥ 1(childTurnCount — 저장 계층이 turns에서 다시 센다).
 * 설명은 문장 탭마다 처음 한 번만 붙는다(같은 키가 없을 때만 append — 원자 단위 안에서 판정).
 */
export interface TalkSessionRecord {
  id: string;
  /** 화면 이름 — 기본 "{주제 라벨} 대화", 사용자가 고칠 수 있다 */
  titleKo: string;
  /** 서버가 해석해 선생님 지시문에 넣은 주제 스냅샷(나중에 단어장이 바뀌어도 기록은 그대로) */
  topic: TalkTopic;
  turns: TalkTurn[];
  explanations: TalkExplanation[];
  /** 연결이 열린 시각 ISO — 스트릭(§17-9)의 날짜 축 */
  startedAt: string;
  endedAt: string;
  durationSec: number;
  /** 은우 턴 수(파생 — normalize가 turns에서 다시 센다) */
  childTurnCount: number;
  /** 실제로 쓴 Realtime 모델·선생님 음성(연결 라우트가 돌려준 값) */
  model: string;
  voice: string;
  /**
   * 대화 중 화면에 보인 그림 카드(§12-6 — 선생님의 show_picture). 보인 순서, 같은 영어는 처음 1장, 최대 TALK_LIMITS.cards(30).
   * 저장 라우트가 sanitizeTalkCards(lib/talk-cards.ts)로 다시 검사한 값만 들어온다.
   */
  cards: TalkCard[];
  /** 주제 일러스트(§12-6) — `talkImages` 문서 id. 그림이 없었거나(실패·키 없음·늦음) 저장하지 않았으면 null */
  sceneImageId: string | null;
  /** 주제 일러스트의 장면 문장(영어, buildTalkSceneEn) — 그림이 없으면 null */
  sceneEn: string | null;
  createdAt: string;
  /** 목록 수동 정렬 — 미정렬 null(맨 위), 생성부는 null로 시작 */
  sortIndex: number | null;
}

/**
 * 주제 일러스트 한 장(§12-6) — 컬렉션 `talkImages`, 한 장 = 문서 하나(Firestore 문서 1MB라 대화 문서와 나눈다).
 * 대화 저장 때 함께 생성되고, 대화를 지우면 함께 지워진다(연쇄 — prod-guard는 `deleteTalkSession` 하나로).
 * 저장하지 않는 대화(은우 발화 0)의 그림은 서버에 남지 않는다(생성 라우트는 저장하지 않고 돌려주기만 한다).
 */
export interface TalkImageRecord {
  id: string;
  /** image/jpeg base64 data URL, ≤ TALK_SCENE_DATA_URL_MAX(900,000자 — 저장 라우트가 검사) */
  dataUrl: string;
  sceneEn: string;
  model: string;
  createdAt: string;
}

/**
 * 대화 저장 결과 — `created`면 이번에 만들었다, 아니면 같은 저장 키(clientSessionId)로 **이미 저장된** 대화를 돌려준 것이다
 * (응답 유실 뒤 다시 저장 — QA english_talk_1 P2-1). 어느 쪽이든 `record`는 저장소에 있는 그 대화다.
 */
export interface CreateTalkSessionResult {
  record: TalkSessionRecord;
  created: boolean;
}

/** 대화 삭제 결과 — deleteVocabBook과 같은 규약 */
export interface DeleteTalkSessionResult {
  ok: boolean;
}

/**
 * 설명 추가 결과(§12-4) — `added`만 썼다. `exists`는 같은 키가 이미 있어(다른 탭·연타가 먼저 저장) 그 설명을 돌려준다,
 * `full`은 설명 상한(TALK_LIMITS.explanations)이라 쓰지 않았다. 없는 id면 스토어가 null.
 */
export type AddTalkExplanationResult =
  | { outcome: "added" | "exists"; record: TalkSessionRecord; explanation: TalkExplanation }
  | { outcome: "full"; record: TalkSessionRecord };

// ---------------------------------------------------------------------------
// 아빠의 운동 — 스토어 계약의 입력·결과 (SPEC §19-4 "스토어 계약")
// 레코드 타입(WorkoutCycleRecord·WorkoutEvent)은 lib/workout.ts에 있고 위에서 재수출한다.
// ---------------------------------------------------------------------------

/**
 * 사이클 시작·재측정 입력. `todayKst`·`nowIso`는 **라우트가 한 번 계산해** 넘긴다 — 판정이 트랜잭션 안에서
 * 재시도돼도 같은 답을 내게(§19-4). `startDate`는 오늘 또는 내일(KST YYYY-MM-DD).
 */
export type StartWorkoutInput = DecideStartInput;

/** 기록 입력 — `day`·`targetDay`는 "화면이 낡지 않았다" 대조용일 뿐, 사건의 값은 서버가 계산한다(§19-4). */
export type LogWorkoutInput = DecideLogInput;

/** 마지막 기록 취소 입력 — 사건 개수가 아니라 rev로 대조한다(ABA 방지, §19-4). */
export type UndoWorkoutInput = DecideUndoInput;

/**
 * 시작 결과. `ok`면 `record`는 새로 만든(created) 또는 사건 0개라 제자리 교체한(replaced) 활성 사이클,
 * `closed`는 이번에 닫은 활성 사이클(없으면 null). `conflict`는 화면이 본 활성 id와 서버 활성 id가 다를 때(연타·두 탭).
 */
export type StartWorkoutResult =
  | { status: "ok"; record: WorkoutCycleRecord; mode: "created" | "replaced"; closed: { id: string; status: ClosedCycleStatus } | null }
  | { status: "conflict"; activeCycleId: string | null };

/**
 * 기록·취소 결과 — 라우트가 그대로 상태 코드로 옮긴다(ok 200 · not_found 404 · 나머지 409).
 * 거절이면 `record`는 손대지 않은 현재 레코드다.
 */
export type WorkoutMutationResult =
  | { status: "ok"; record: WorkoutCycleRecord }
  | { status: "not_found" }
  | { status: "conflict" | "stale_state" | "not_active" | "empty"; record: WorkoutCycleRecord };

// sortIndex도 제외한다 — id·createdAt처럼 **스토어가 매기는 값**이다. 신규 책은 항상
// sortIndex=null로 태어나(맨 위), 이후 reorderBooks로만 값이 박힌다. 생성부는 넘기지 않는다.
export type NewBook = Omit<BookRecord, "id" | "createdAt" | "sortIndex">;
export type NewCard = Omit<CardRecord, "id" | "createdAt">;
export type NewReading = Omit<ReadingRecord, "id">;
// sortIndex는 스토어가 매긴다(NewBook과 같은 규약) — 생성 시 null, 이후 reorder<X>로만 값이 박힌다.
export type NewExplanation = Omit<ExplanationRecord, "id" | "createdAt" | "sortIndex">;
export type NewVocabBook = Omit<VocabBookRecord, "id" | "createdAt" | "sortIndex">;
/** 일본어 단어장 생성 입력 — id·createdAt·sortIndex는 스토어가 매긴다(NewVocabBook과 같은 규약). */
export type NewJaVocabBook = Omit<JaVocabBookRecord, "id" | "createdAt" | "sortIndex">;
/** 일본어 시험 세션 저장 입력 — id는 스토어가 매긴다(NewVocabQuiz와 같은 규약). */
export type NewJaQuiz = Omit<JaQuizRecord, "id">;
/** 한자 정보 저장 입력 — id·createdAt은 스토어가 매긴다(kanji가 upsert 키). */
export type NewJaKanji = Omit<JaKanjiRecord, "id" | "createdAt">;
/** 한자 시험 세션 저장 입력 — id는 스토어가 매긴다. */
export type NewJaKanjiQuiz = Omit<JaKanjiQuizRecord, "id">;
/** 대화 복습 저장 입력 — id·createdAt·sortIndex는 스토어가 매긴다(NewJaVocabBook과 같은 규약). */
export type NewJaDialog = Omit<JaDialogRecord, "id" | "createdAt" | "sortIndex">;
/** 시험 세션 저장 입력 — id는 스토어가 매긴다. startedAt/finishedAt은 클라이언트가 정한 값 그대로 */
export type NewVocabQuiz = Omit<VocabQuizRecord, "id">;
/** 토익 표현집 세트 생성 입력 — id·createdAt·sortIndex는 스토어가 매긴다(enriched도 저장 계층이 entries에서 다시 계산). */
export type NewToeicSet = Omit<ToeicSetRecord, "id" | "createdAt" | "sortIndex">;
/** 토익 표현 시험 세션 저장 입력 */
export type NewToeicQuiz = Omit<ToeicQuizRecord, "id">;
/** 토익 모의고사 생성 입력 */
export type NewToeicMock = Omit<ToeicMockRecord, "id" | "createdAt" | "sortIndex">;
/** 토익 응시 시작 입력(녹음 IndexedDB 키로 id가 필요해 시작에 만든다, §7-5) */
export type NewToeicAttempt = Omit<ToeicAttemptRecord, "id">;
/**
 * 자유대화 저장 입력 — id·createdAt·sortIndex는 스토어가 매긴다. childTurnCount도 저장 계층이 turns에서 다시 센다(파생),
 * 설명은 저장 뒤 문장 탭으로만 붙으므로 생성 입력에 두지 않는다(빈 배열로 태어난다).
 */
export type NewTalkSession = Omit<
  TalkSessionRecord,
  "id" | "createdAt" | "sortIndex" | "childTurnCount" | "explanations" | "sceneImageId" | "sceneEn"
>;
/**
 * 대화와 함께 저장할 주제 일러스트(§12-6). 스토어가 `talkImages` 문서를 만들고 대화의 sceneImageId·sceneEn을 단다 —
 * 두 문서가 **한 원자 단위**(파일: mutate, Firestore: batch)로 생겨 한쪽만 남는 고아가 없다.
 */
export interface NewTalkSceneImage {
  dataUrl: string;
  sceneEn: string;
  model: string;
}

/** 책 삭제로 함께 지워진 개수 — 삭제 완료 안내에 그대로 쓴다 */
export interface DeleteBookResult {
  cards: number;
  readings: number;
}

export interface CardWithBook {
  card: CardRecord;
  book: BookRecord;
}

// ---------------------------------------------------------------------------
// 저장 계층 인터페이스 — 라우트·페이지가 의존하는 유일한 면
// ---------------------------------------------------------------------------

export interface StudyStore {
  createBook(input: NewBook): Promise<BookRecord>;
  getBook(id: string): Promise<BookRecord | null>;
  listBooks(): Promise<BookRecord[]>;
  /** 동일 책 재등록 감지용(SPEC §9) — 제목+저자 정규화(공백·대소문자 무시) 일치 */
  findBookByTitleAuthor(title: string, author: string): Promise<BookRecord | null>;
  /**
   * 책 삭제 — 그 책의 카드와 읽음 기록까지 **연쇄 삭제**하고 지운 개수를 돌려준다.
   * 되돌릴 수 없다(휴지통 없음 — 가족용 소규모 앱, 단순함 우선).
   * 없는 bookId면 아무것도 지우지 않고 {cards:0, readings:0}을 돌려준다
   * (존재 확인·404는 호출측 라우트의 몫 — 스토어는 "그 책과 딸린 것이 없는 상태"만 보장).
   */
  deleteBook(bookId: string): Promise<DeleteBookResult>;
  /**
   * 줄거리 근거 3필드만 갱신한다 (`/api/pages`가 본문·목차 판독 결과를 붙일 때).
   * 없는 bookId면 null — 404 판단은 호출측 라우트의 몫.
   */
  updateBookEvidence(bookId: string, patch: BookEvidencePatch): Promise<BookRecord | null>;

  /**
   * 서재 수동 정렬 — `orderedIds`가 곧 최종 순서다. 각 book의 sortIndex를 0..n으로 재색인해
   * 저장한다(두 백엔드 동일 동작). **목록에 없는 book은 건드리지 않는다**(sortIndex 보존).
   * 수정이지 삭제가 아니라 prod-guard를 걸지 않는다(updateBookEvidence와 같은 규약).
   * 단어장·수학 목록도 같은 시그니처의 재색인 메서드를 이 선례대로 붙인다.
   */
  reorderBooks(orderedIds: string[]): Promise<void>;

  createCard(input: NewCard): Promise<CardRecord>;
  getCard(id: string): Promise<CardRecord | null>;
  /**
   * 카드 1장만 지운다 — **연쇄 삭제가 없다.** 읽음 기록은 bookId에 매달려 있어
   * 카드와 무관하고(SPEC §5), 책은 그대로 남는다.
   *
   * 지웠으면 true, 없는 id였으면 false. 존재 확인·404는 호출측 라우트의 몫이다
   * (deleteBook과 같은 규약 — 스토어는 "그 카드가 없는 상태"만 보장한다).
   *
   * 주의: 그 책의 마지막 카드인지는 스토어가 따지지 않는다. 카드 없는 유령 책을
   * 막는 것은 라우트의 정책이다(app/api/cards/[id]/route.ts).
   */
  deleteCard(cardId: string): Promise<boolean>;
  /** 해당 책의 카드 목록 — 최신순 */
  listCardsForBook(bookId: string): Promise<CardRecord[]>;
  /** 홈 미리보기용 — 최신 카드 + 책 조인, 최신순 */
  listRecentCards(limit: number): Promise<CardWithBook[]>;

  // readings — M3(서재·읽음 기록).
  addReading(input: NewReading): Promise<ReadingRecord>;
  listReadings(bookId?: string): Promise<ReadingRecord[]>;

  // ---- explanations — 수학 설명 기록 (M4, math.md §9-2) ----
  // 백엔드가 하나이므로 인터페이스를 쪼개지 않고 여기에 네 개를 더한다.
  createExplanation(input: NewExplanation): Promise<ExplanationRecord>;
  getExplanation(id: string): Promise<ExplanationRecord | null>;
  /** 최신순. 가족용 규모라 전체 조회로 충분하다 */
  listExplanations(limit?: number): Promise<ExplanationRecord[]>;
  /** 지웠으면 true, 없는 id였으면 false — deleteCard와 같은 규약 */
  deleteExplanation(id: string): Promise<boolean>;
  /**
   * 수학 서재 수동 정렬 — `reorderBooks`의 explanations판(같은 규약). `orderedIds`가 곧 최종
   * 순서이고, 각 설명의 sortIndex를 0..n으로 재색인한다. 목록에 없는 기록은 건드리지 않는다.
   * 수정이라 prod-guard 무관.
   */
  reorderExplanations(orderedIds: string[]): Promise<void>;

  // ---- vocabBooks — 단어장 정복 (V1, english.md §7-6) ----
  // explanations와 같은 규약: 백엔드가 하나라 인터페이스를 쪼개지 않고 네 개를 더한다.
  createVocabBook(input: NewVocabBook): Promise<VocabBookRecord>;
  getVocabBook(id: string): Promise<VocabBookRecord | null>;
  /** 최신순. limit 생략이면 전체 (가족용 규모) */
  listVocabBooks(limit?: number): Promise<VocabBookRecord[]>;
  /**
   * "모은 단어" 수집 단어장을 얻거나(없으면) 만든다 (M2 챕터 리더 더블탭 담기).
   * `dayLabel === COLLECTED_VOCAB_DAY_LABEL`로 식별되는 **단일** 단어장이다(titleKo는 rename으로
   * 바뀔 수 있어 마커로 안 쓴다 — collected-vocab-contract 참고). 정본이 이미 있으면 그것을,
   * 없으면 빈 단어장을 만들어 돌려준다. 이후 호출측이 `appendVocabEntry`로 단어를 붙인다.
   * **생성**이라 prod-guard가 걸리지 않는다(삭제가 아니다). 중복 생성 경합은 "가장 먼저 만든 것"을
   * 정본으로 골라 최소화한다(가족용 규모라 실질 위험 무시 가능).
   */
  getOrCreateCollectedVocabBook(): Promise<VocabBookRecord>;
  /**
   * 보강(호출 D, V3) 결과를 저장한다 — 기존 레코드의 `entries`·`enriched`만 갈아끼운다.
   * **삭제가 아니라 수정**이라 prod-guard를 걸지 않는다(updateBookEvidence와 같은 규약).
   *
   * 정의 불변은 이 메서드가 지키는 게 아니라 **호출측이 `mergeEnrichment`로 만든 값**을 넘겨야
   * 지켜진다(그 순수 함수가 null 자리만 채운다). 스토어는 받은 entries를 그대로 굳힐 뿐이다 —
   * 저장 계층답게 `normalizeVocabEntry`로 undefined만 마지막으로 조인다(Firestore 거부 방어).
   *
   * 갱신된 레코드를 돌려준다. 없는 id면 null — 404 판단은 호출측 라우트의 몫.
   */
  updateVocabBookEnrichment(
    id: string,
    entries: VocabEntry[],
    enriched: boolean,
  ): Promise<VocabBookRecord | null>;
  /**
   * 단어 1개를 기존 DAY에 덧붙인다 (V8 더블탭 담기). **삭제가 아니라 수정**이라 prod-guard를 걸지
   * 않는다(updateVocabBookEnrichment와 같은 규약). **대소문자 무시 word 비교로 중복이면 붙이지
   * 않는다**(중복은 결과의 `appended:false`로 알린다 — 라우트가 "이미 있어요"로 안내). 새 단어를
   * 붙이면 `enriched`를 `isVocabBookEnriched`로 다시 계산한다(뜻 null 단어가 붙으면 false로 떨어져
   * "다시 만들기"가 열린다). 없는 id면 `{ record:null, appended:false }` — 404 판단은 라우트의 몫.
   */
  appendVocabEntry(id: string, entry: VocabEntry): Promise<AppendVocabEntryResult>;
  /**
   * 유의어/반의어 연결 — 단어장 안의 두 (단어+뜻)을 잇는다 (V8 관계 문제). **양쪽 상호 기록**:
   * source 뜻의 related에 대상(word·glossKo=대상 뜻 ko·source:"user"·linkedNo=대상 no·linkedMeaningIndex)을,
   * target 뜻의 related에 대칭으로(word·glossKo=source 뜻 ko·linkedNo=source no·linkedMeaningIndex) 붙인다.
   * **멱등** — 이미 있는 링크면 중복 추가하지 않는다. **삭제가 아니라 수정**이라 prod-guard를 걸지 않는다
   * (updateVocabBookEnrichment와 같은 규약). AI 호출 없음(glossKo는 대상 뜻 ko를 복사). 인덱스 방어는
   * `VocabLinkResult`의 status로 알린다(범위 밖·자기 자신 → "invalid").
   */
  linkVocabRelated(id: string, input: VocabLinkInput): Promise<VocabLinkResult>;
  /**
   * 유의어/반의어 연결 해제 — `linkVocabRelated`의 역연산(V8). 양쪽 뜻에서 그 사용자 링크를 제거한다.
   * 매칭은 `source:"user"` + kind + **상대 word** + 상대 meaningIndex로 한다(no가 null일 수 있어 안정적인
   * word를 키로 쓴다). **멱등** — 없는 링크를 풀어도 ok. 수정이라 prod-guard 무관.
   */
  unlinkVocabRelated(id: string, input: VocabLinkInput): Promise<VocabLinkResult>;
  /**
   * 단어장의 **화면 이름(titleKo)만** 바꾼다 (상세 헤더 인라인 편집). **삭제가 아니라 수정**이라
   * prod-guard를 걸지 않는다(updateVocabBookEnrichment와 같은 규약). entries·enriched·dayLabel·판독
   * 결과는 손대지 않는다 — 오직 titleKo 한 필드만 갈아끼운다. 읽기 경로(normalizeVocabEntry)는
   * 그대로 유지해 반환 레코드의 entries가 getVocabBook과 같은 모양이 되게 한다.
   * 갱신된 레코드를 돌려준다. 없는 id면 null — 404 판단은 호출측 라우트의 몫.
   */
  updateVocabBookTitle(id: string, titleKo: string): Promise<VocabBookRecord | null>;
  /**
   * 단어장 목록 수동 정렬 — `reorderBooks`의 vocab판(같은 규약). `orderedIds`가 곧 최종 순서이고,
   * 각 단어장의 sortIndex를 0..n으로 재색인한다. 목록에 없는 단어장은 건드리지 않는다.
   * 수정이라 prod-guard 무관.
   */
  reorderVocabBooks(orderedIds: string[]): Promise<void>;
  /**
   * 단어장 1개를 지운다 — 그 단어장의 **시험 세션(V4)까지 연쇄 삭제**한다(deleteBook과 같은 규약).
   * 지웠으면 `{ ok: true }`, 없는 id였으면 `{ ok: false }`. 존재 확인·404는 라우트의 몫.
   */
  deleteVocabBook(id: string): Promise<DeleteVocabBookResult>;

  // ---- vocabQuizzes — 시험 세션 (V4, 계획 §V4) ----
  // 전사본을 건드리지 않는 별도 컬렉션. append(add)와 조회(list)만 있다 — 수정·삭제 API가 없다.
  /** 시험 세션 한 판을 저장한다(완료·부분 결과 모두). append 전용이라 prod-guard 없음 */
  addVocabQuiz(input: NewVocabQuiz): Promise<VocabQuizRecord>;
  /**
   * 해당 단어장의 모든 시험 세션 — **오래된 순(startedAt 오름차순, 시간 순서)**.
   * V5가 이 순서로 걸어 단어별 wrong·total·streak(연속 정답)을 계산한다(순서가 streak의 뜻이다).
   */
  listVocabQuizzes(bookId: string): Promise<VocabQuizRecord[]>;
  /**
   * **모든 단어장의** 시험 세션 — 역시 **startedAt 오름차순**(bookId 무관 전역 시간순).
   * DAY를 넘는 통합 오답노트(V5 층2)가 bookId별로 다시 갈라 aggregateWordStats에 넣는다.
   * bookId별 상대 순서는 전역 정렬 안에서 보존된다(같은 규약: 순서가 streak의 뜻).
   */
  listAllVocabQuizzes(): Promise<VocabQuizRecord[]>;

  // ---- jaVocabBooks — 아빠의 일본어 JLPT 단어장 (J1, japanese.md §7-1) ----
  // explanations·vocabBooks와 같은 규약: 백엔드가 하나라 인터페이스를 쪼개지 않고 여기에 더한다. J1은 6개
  // (create/get/list/delete/reorder/rename)만 — 시험(J2)·대화(J3)는 다음 단계라 여기에 넣지 않는다.
  createJaVocabBook(input: NewJaVocabBook): Promise<JaVocabBookRecord>;
  getJaVocabBook(id: string): Promise<JaVocabBookRecord | null>;
  /** 최신순. limit 생략이면 전체(가족용 규모) */
  listJaVocabBooks(limit?: number): Promise<JaVocabBookRecord[]>;
  /**
   * 단어장 1개 삭제 — 시험(J2) 미도입이라 연쇄 대상이 없다. **삭제라 prod-guard를 건다**
   * (assertDestructiveAllowed("deleteJaVocabBook")). 지웠으면 {ok:true}, 없는 id면 {ok:false}. 404는 라우트 몫.
   */
  deleteJaVocabBook(id: string): Promise<DeleteJaVocabBookResult>;
  /** 목록 수동 정렬 — reorderBooks의 일본어판(같은 규약). 목록에 없는 것은 불간섭. 수정이라 prod-guard 무관. */
  reorderJaVocabBooks(orderedIds: string[]): Promise<void>;
  /** 화면 이름(titleKo)만 바꾼다(상세 인라인 편집). entries·levels·topic은 불변. 수정이라 prod-guard 무관. */
  updateJaVocabBookTitle(id: string, titleKo: string): Promise<JaVocabBookRecord | null>;

  // ---- jaQuizzes — 일본어 시험 세션 (J2, §7-3) ----
  // 영어 vocabQuizzes와 **컬렉션 분리**(집계가 섞이면 안 된다). append(저장)와 조회(list)만 — 수정·삭제 API 없음.
  /** 시험 세션 한 판 저장(완료·부분 결과 모두). append 전용이라 prod-guard 없음. */
  addJaQuiz(input: NewJaQuiz): Promise<JaQuizRecord>;
  /** 해당 단어장의 모든 시험 세션 — startedAt 오름차순(streak가 이 순서를 읽는다, 영어 규약). */
  listJaQuizzes(bookId: string): Promise<JaQuizRecord[]>;
  /** 전역 일본어 시험 세션 전체 — startedAt 오름차순. 스트릭(§17)이 사람별로 접는다. bookId 필터 없음. */
  listAllJaQuizzes(): Promise<JaQuizRecord[]>;

  // ---- jaKanji · jaKanjiQuizzes — 한자 단위 학습 (JK, §12-3·§12-4) ----
  // 한자 정보는 단어장 파생물이라 **별도 컬렉션**, 삭제 메서드 없음(§12-3). 시험도 별도 컬렉션(모드 무오염).
  /**
   * 한자 정보 여러 개 저장(호출 D 결과). **kanji 기준 insert-only** — 이미 있는 한자는 덮어쓰지 않고 건너뛴다(§12-2 불변).
   * 정상 경로는 enrich가 "정보 없는 한자만" 보내지만, 동시 요청(race)까지 저장 계층에서 막는다(영어 "정의 불변"과 같은 자리).
   * append 전용이라 prod-guard 없음. **새로 추가한(=실제로 채운) 한자 수만** 돌려준다(이미 있던 건 제외 — filled를 사실대로).
   */
  saveJaKanji(records: NewJaKanji[]): Promise<number>;
  /** 저장된 한자 정보 전체(전역, createdAt 오름차순). 목록·시험·카드가 읽는다. */
  listJaKanji(): Promise<JaKanjiRecord[]>;
  /** 한자 시험 세션 한 판 저장. append 전용이라 prod-guard 없음. */
  addJaKanjiQuiz(input: NewJaKanjiQuiz): Promise<JaKanjiQuizRecord>;
  /** 모든 한자 시험 세션 — startedAt 오름차순(집계가 이 순서를 읽는다). 전역 scope라 필터 없음. */
  listJaKanjiQuizzes(): Promise<JaKanjiQuizRecord[]>;

  // ---- jaDialogs — 듀오링고 대화 복습 (J3~J5, §7-2·§7-5) ----
  createJaDialog(input: NewJaDialog): Promise<JaDialogRecord>;
  getJaDialog(id: string): Promise<JaDialogRecord | null>;
  /** 최신순. limit 생략이면 전체(가족용 규모). */
  listJaDialogs(limit?: number): Promise<JaDialogRecord[]>;
  /** 삭제 — 딸린 것 없음. **삭제라 prod-guard**(assertDestructiveAllowed). 지웠으면 {ok:true}, 없으면 {ok:false}. */
  deleteJaDialog(id: string): Promise<DeleteJaVocabBookResult>;
  /** 목록 수동 정렬 — reorderBooks의 대화판. 수정이라 prod-guard 무관. */
  reorderJaDialogs(orderedIds: string[]): Promise<void>;
  /** 화면 이름(titleKo)만 바꾼다. turns·coaching은 불변. 수정이라 prod-guard 무관. */
  updateJaDialogTitle(id: string, titleKo: string): Promise<JaDialogRecord | null>;
  /** 해설(coaching)만 갈아끼운다(호출 C 재생성). 전사·제목은 불변. 없는 id면 null. 수정이라 prod-guard 무관. */
  updateJaDialogCoaching(id: string, coaching: JaDialogCoaching): Promise<JaDialogRecord | null>;

  // ---- 대화에서 모은 단어 (J5, §7-5) — kind:"collected" 일본어 단어장 ----
  /**
   * "대화에서 모은 단어" 단어장을 얻거나(없으면) 만든다. **kind:"collected"** 단일 단어장으로 식별한다
   * (JLPT 단어장과 섞지 않는다 — 영어 getOrCreateCollectedVocabBook 관용구). 생성이라 prod-guard 무관.
   */
  getOrCreateJaCollectedVocabBook(): Promise<JaVocabBookRecord>;
  /**
   * 단어 1개를 그 단어장에 덧붙인다(J5 담기). **같은 kana가 이미 있으면 붙이지 않는다**(중복은 appended:false).
   * **collected 단어장에만** 쓴다 — JLPT 단어장에 append 금지(§7-5, 라우트가 대상을 collected로 강제). 수정이라 prod-guard 무관.
   */
  appendJaVocabEntry(id: string, entry: JaVocabEntry): Promise<AppendJaVocabResult>;

  // ---- workoutCycles — 아빠의 운동 (§19-4) ----
  // 사이클 문서 하나가 사건 배열을 안는다(사이클당 수십 건). 저장하는 것은 사건뿐 — 현재 Day·실패·볼륨은 엔진이 재생한다.
  // **검증과 쓰기는 한 원자 단위다**: 판정은 순수 함수(lib/workout.ts의 decideStart·decideLog·decideUndo)가 하고,
  // 스토어는 그것을 파일은 `mutate` 콜백 안에서, Firestore는 `runTransaction` 안에서 부른다(applyVocabLink 관용구).
  /** 전체 사이클, createdAt 내림차순. 날짜 필터 쿼리 없음(복합 인덱스 회피) — 활성은 `pickActiveWorkoutCycle`로 고른다. */
  listWorkoutCycles(): Promise<WorkoutCycleRecord[]>;
  getWorkoutCycle(id: string): Promise<WorkoutCycleRecord | null>;
  /**
   * 처음 시작·재측정·도중 재측정. 활성과 `expectedActiveCycleId`를 대조하고, 활성 사건 0개면 제자리 교체, 아니면
   * `closingStatus`로 닫고 새 사이클(cycleNo = 전체 max+1). **prod-guard**: Firestore에서 사건 있는 활성을 닫을 때만
   * (`closeWorkoutCycle`) — 최초 생성·제자리 교체는 가드 대상이 아니다.
   */
  startWorkoutCycle(input: StartWorkoutInput): Promise<StartWorkoutResult>;
  /** 오늘 상태를 다시 계산·대조한 뒤 사건 append(date·at·reps는 서버 계산), rev+1. append라 prod-guard 없음. */
  logWorkoutEvent(cycleId: string, input: LogWorkoutInput): Promise<WorkoutMutationResult>;
  /** 활성 사이클의 마지막 사건 제거, rev+1. **prod-guard**(Firestore에서만, 첫 줄 — `undoWorkoutEvent`). */
  undoWorkoutEvent(cycleId: string, input: UndoWorkoutInput): Promise<WorkoutMutationResult>;

  // ---- 아빠의 영어(토익스피킹) — toeicSets·toeicQuizzes·toeicMocks·toeicImages·toeicAttempts (docs/harness/toeic.md §7) ----
  // 은우·일본어 컬렉션과 섞지 않는다. 삭제(세트·모의고사)는 Firestore에서 prod-guard, 딸린 문서 먼저·본 문서 마지막.

  /** 세트 생성(사진 판독 저장). sortIndex null로 시작(맨 위). */
  createToeicSet(input: NewToeicSet): Promise<ToeicSetRecord>;
  getToeicSet(id: string): Promise<ToeicSetRecord | null>;
  /** 최신순. limit 생략이면 전체(가족용 규모) */
  listToeicSets(limit?: number): Promise<ToeicSetRecord[]>;
  /** 가져오기 멱등 키로 찾는다(§7-6). 없으면 null */
  findToeicSetByPresetKey(presetKey: string): Promise<ToeicSetRecord | null>;
  /**
   * 파일 가져오기(§7-6) — **확인과 생성이 한 원자 단위**(파일 mutate / Firestore 트랜잭션)라 두 번 눌러도 같은 presetKey가
   * 두 번 생기지 않는다(멱등). 파일 순서가 목록 위→아래가 되도록 createdAt을 1ms씩 내려 매긴다(목록은 최신이 위).
   * 생성이라 prod-guard 무관.
   */
  importToeicSets(inputs: NewToeicSet[]): Promise<ImportToeicSetsResult>;
  /** 세트 삭제 — 그 세트의 시험 세션까지 연쇄 삭제(세션 먼저, 세트 마지막). **prod-guard**(`deleteToeicSet`). */
  deleteToeicSet(id: string): Promise<DeleteToeicResult>;
  /** 화면 이름(titleKo)만 바꾼다. 수정이라 prod-guard 무관. 없는 id면 null. */
  updateToeicSetTitle(id: string, titleKo: string): Promise<ToeicSetRecord | null>;
  /** 목록 수동 정렬(reorderBooks 규약). 수정이라 prod-guard 무관. */
  reorderToeicSets(orderedIds: string[]): Promise<void>;
  /**
   * 발화 포인트(호출 B) 병합 저장(§3-4) — **최신 entries를 원자 단위 안에서 읽어** applyPointsResults로 합친다.
   * 기본은 points가 null인 자리만 채우고(force=false), 다시 만들기(force=true)만 갈아 끼운다 — 저장 직후 자동 호출과
   * "만들기" 버튼이 겹쳐도 먼저 채운 포인트를 뒤 호출이 덮지 않는다. 수정이라 prod-guard 무관. 없는 id면 null.
   */
  mergeToeicSetPoints(id: string, items: ToeicPointsItem[], opts: { force: boolean }): Promise<MergeToeicSetPointsResult | null>;

  /** 시험 세션 저장(append 전용 — prod-guard 없음). */
  addToeicQuiz(input: NewToeicQuiz): Promise<ToeicQuizRecord>;
  /** 그 세트의 시험 세션 — startedAt 오름차순(숙련도 streak의 시간 축). 모르는 mode 레코드는 버린다. */
  listToeicQuizzes(setId: string): Promise<ToeicQuizRecord[]>;
  /** 전 세트의 시험 세션 — startedAt 오름차순(스트릭·모의고사 활용할 표현 고르기가 읽는다). */
  listAllToeicQuizzes(): Promise<ToeicQuizRecord[]>;

  /** 모의고사 생성(T3). */
  createToeicMock(input: NewToeicMock): Promise<ToeicMockRecord>;
  getToeicMock(id: string): Promise<ToeicMockRecord | null>;
  /** 최신순. limit 생략이면 전체 */
  listToeicMocks(limit?: number): Promise<ToeicMockRecord[]>;
  /** 모의고사 삭제 — 생성 사진·응시 기록까지 연쇄(딸린 것 먼저, 모의고사 마지막). **prod-guard**(`deleteToeicMock`). */
  deleteToeicMock(id: string): Promise<DeleteToeicResult>;
  updateToeicMockTitle(id: string, titleKo: string): Promise<ToeicMockRecord | null>;
  reorderToeicMocks(orderedIds: string[]): Promise<void>;
  /**
   * 빈 파트 하나를 채운다("이 파트 다시 만들기"·미선택 파트 만들기, §4-0). **빈 자리만** — 이미 있으면 쓰지 않고
   * `exists`(원자 단위 안에서 판정, lib/toeic-mock-apply.ts). 수정이라 prod-guard 무관. 없는 id면 null.
   */
  fillToeicMockPart<P extends ToeicMockPart>(id: string, part: P, value: ToeicMockPartRecordMap[P]): Promise<FillToeicMockPartResult | null>;
  /**
   * Q3–4 생성 사진 저장(관문 P, §4-10·§7-4) — **사진 문서 생성 + picture.items[slot].image = {ready, imageId}를 한 원자
   * 단위로**(파일: mutate, Firestore: runTransaction). 판정은 decidePictureImage — 이미 ready면 쓰지 않고(kept, 먼저 준비된
   * 사진이 이긴다), 장면이 바뀌었으면 쓰지 않는다(stale). 쓰지 않은 경우 사진 문서도 만들지 않는다(고아 사진 0).
   */
  saveToeicPictureImage(input: SaveToeicPictureImageInput): Promise<SaveToeicPictureImageResult>;
  /** 사진 생성 실패 기록 — 그 칸을 {failed, null}로. 이미 ready면 내리지 않는다(kept). 판정은 saveToeicPictureImage와 같은 함수. */
  markToeicPictureImageFailed(mockId: string, slot: 0 | 1, imagePrompt: string): Promise<MarkToeicPictureImageFailedResult>;
  /** 생성 사진 한 장(`GET /api/toeic/images/[id]`). */
  getToeicImage(id: string): Promise<ToeicImageRecord | null>;

  /** 응시 시작(§7-5) — 녹음 IndexedDB 키로 id가 필요해 시작에 만든다. */
  createToeicAttempt(input: NewToeicAttempt): Promise<ToeicAttemptRecord>;
  getToeicAttempt(id: string): Promise<ToeicAttemptRecord | null>;
  /** 그 모의고사의 응시 — startedAt 오름차순 */
  listToeicAttemptsByMock(mockId: string): Promise<ToeicAttemptRecord[]>;
  /** 전 응시 — startedAt 오름차순(스트릭) */
  listAllToeicAttempts(): Promise<ToeicAttemptRecord[]>;
  /**
   * 끝/그만둠 — finishedAt과 문항별 recorded·durationMs를 채운다(원자 단위 안에서, 채점 결과는 보존). **한 번만** — 이미 닫힌
   * 응시면 쓰지 않고 already_closed(판정은 decideAttemptFinish, 원자 단위 **안에서**). 없는 id면 null.
   */
  finishToeicAttempt(id: string, input: FinishToeicAttemptInput): Promise<FinishToeicAttemptResult | null>;
  /**
   * 문항 하나의 채점 결과 저장 — **그 문항만** 바꾼다(파일: mutate, Firestore: runTransaction). 같은 응시의 두 문항이
   * 동시에 채점돼도(동시 2개, §5-0) 서로 덮지 않는다. 그 q가 answers에 없으면 덧붙인다. 없는 id면 null.
   */
  updateToeicAttemptAnswer(id: string, q: number, patch: ToeicAnswerScorePatch): Promise<ToeicAttemptRecord | null>;

  // ---- talkSessions — 은우 자유대화 (docs/harness/english.md §12-4, SPEC §21) ----
  // 은우 단어장 컬렉션과 섞지 않는다. 삭제는 Firestore에서 prod-guard(`deleteTalkSession`).

  /**
   * 대화 저장(끝난 뒤 1회). sortIndex null·explanations []로 시작, childTurnCount는 turns에서 센다. 생성이라 prod-guard 무관.
   * `scene`이 있으면 주제 일러스트(`talkImages`)를 같은 원자 단위로 만들고 sceneImageId·sceneEn을 단다(§12-6).
   *
   * **멱등(QA english_talk_1 P2-1)**: `saveId`(화면이 만든 저장 키, TALK_SAVE_ID_RE)를 대화 문서 id로, 주제 일러스트 문서 id도
   * 같은 값으로 쓴다. 확인과 생성이 한 원자 단위(파일: mutate, Firestore: batch `create` — 이미 있으면 배치 전체가 거부된다)라
   * 응답이 유실돼 다시 저장해도 두 번 생기지 않고, 이미 있으면 `{created:false}`로 그 대화를 돌려준다. 같은 키에 **시작 시각이
   * 다른** 대화가 있으면(키 충돌 — 다른 대화) 덮어쓰지 않고 스토어가 새 id로 만든다.
   */
  createTalkSession(input: NewTalkSession, scene: NewTalkSceneImage | null, saveId: string): Promise<CreateTalkSessionResult>;
  getTalkSession(id: string): Promise<TalkSessionRecord | null>;
  /** 주제 일러스트 한 장(§12-6 — GET /api/english/talk/images/[id]). 없으면 null */
  getTalkImage(id: string): Promise<TalkImageRecord | null>;
  /** 최신순(createdAt 내림차순). limit 생략이면 전체(가족용 규모) */
  listTalkSessions(limit?: number): Promise<TalkSessionRecord[]>;
  /** 전 대화 — startedAt 오름차순(스트릭 §17-9가 읽는다). 날짜 필터 쿼리 없음(복합 인덱스 회피). */
  listAllTalkSessions(): Promise<TalkSessionRecord[]>;
  /**
   * 삭제 — 딸린 주제 일러스트(`talkImages`, sceneImageId)를 **먼저**, 대화를 마지막에 지운다(연쇄, §12-6).
   * **prod-guard**(`deleteTalkSession`, Firestore만 — 그림 연쇄도 이 op 하나로). 지웠으면 {ok:true}, 없으면 {ok:false}.
   */
  deleteTalkSession(id: string): Promise<DeleteTalkSessionResult>;
  /** 화면 이름(titleKo)만 바꾼다. 스크립트·설명 불변. 수정이라 prod-guard 무관. 없는 id면 null. */
  updateTalkSessionTitle(id: string, titleKo: string): Promise<TalkSessionRecord | null>;
  /** 목록 수동 정렬(reorderBooks 규약 — 없는 id는 건너뛴다). 수정이라 prod-guard 무관. */
  reorderTalkSessions(orderedIds: string[]): Promise<void>;
  /**
   * 문장 설명 한 건 추가(§12-4) — **같은 키(turnIndex, sentenceIndex)가 없을 때만 append**. 판정(decideTalkExplanation)과 쓰기를
   * 한 원자 단위로(파일: mutate, Firestore: runTransaction) — 두 탭·연타가 겹쳐도 한 번만 저장되고 먼저 저장된 설명이 이긴다.
   * append라 prod-guard 무관. 없는 id면 null.
   */
  addTalkExplanation(id: string, explanation: TalkExplanation): Promise<AddTalkExplanationResult | null>;
}

/**
 * 예전 이름. 과목이 영어뿐이던 시절의 이름이라 수학 기록까지 안는 지금은 좁게 읽히지만,
 * **별칭으로 남겨 기존 import를 하나도 깨지 않는다**(math.md §9-2).
 * 새 코드는 `StudyStore`를 쓸 것.
 */
export type BookCardStore = StudyStore;

// ---------------------------------------------------------------------------
// JSON 파일 구현 (M1 — data/db.json)
// ---------------------------------------------------------------------------

export interface DbShape {
  books: BookRecord[];
  cards: CardRecord[];
  readings: ReadingRecord[];
  explanations: ExplanationRecord[];
  vocabBooks: VocabBookRecord[];
  vocabQuizzes: VocabQuizRecord[];
  jaVocabBooks: JaVocabBookRecord[];
  jaQuizzes: JaQuizRecord[];
  jaKanji: JaKanjiRecord[];
  jaKanjiQuizzes: JaKanjiQuizRecord[];
  jaDialogs: JaDialogRecord[];
  /** 아빠의 운동 사이클(§19-4) — **필수 필드**. 빠뜨리면 emptyDb·readDb·mergeDbForSeed·seed.ts가 tsc에 걸린다 */
  workoutCycles: WorkoutCycleRecord[];
  /** 아빠의 영어(toeic.md §7) 5개 컬렉션 — **필수 필드**(빠뜨리면 emptyDb·readDb·mergeDbForSeed·seed.ts가 tsc에 걸린다) */
  toeicSets: ToeicSetRecord[];
  toeicQuizzes: ToeicQuizRecord[];
  toeicMocks: ToeicMockRecord[];
  toeicImages: ToeicImageRecord[];
  toeicAttempts: ToeicAttemptRecord[];
  /** 은우 자유대화(english.md §12-4) — **필수 필드**(빠뜨리면 emptyDb·readDb·mergeDbForSeed·seed.ts가 tsc에 걸린다) */
  talkSessions: TalkSessionRecord[];
  /** 자유대화 주제 일러스트(english.md §12-6) — 같은 이유로 필수 필드 */
  talkImages: TalkImageRecord[];
}

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "db.json");

function emptyDb(): DbShape {
  return {
    books: [], cards: [], readings: [], explanations: [], vocabBooks: [], vocabQuizzes: [], jaVocabBooks: [], jaQuizzes: [], jaKanji: [], jaKanjiQuizzes: [], jaDialogs: [], workoutCycles: [],
    toeicSets: [], toeicQuizzes: [], toeicMocks: [], toeicImages: [], toeicAttempts: [],
    talkSessions: [], talkImages: [],
  };
}

/** 모르는 mode 세션은 버린다(normalizeToeicQuizRecord가 null) — 모드별 숙련도 무오염(§6-2). 버린 수는 경고로 남긴다. */
function normalizeToeicQuizList(list: readonly unknown[]): ToeicQuizRecord[] {
  const out: ToeicQuizRecord[] = [];
  let dropped = 0;
  for (const raw of list) {
    const q = normalizeToeicQuizRecord(raw);
    if (q) out.push(q);
    else dropped += 1;
  }
  if (dropped > 0) console.warn(`[store] 모르는 mode의 토익 시험 세션 ${dropped}건을 건너뛰었어요.`);
  return out;
}

/**
 * 파일 스토어 방어 변환 — transcript grounding 이전에 저장된 book 레코드에는
 * `transcript`·`youtubeUrl` 키가 없다. 읽을 때 null로 메워 타입 계약(필수 nullable)을 지킨다.
 * (Firestore 쪽 대응은 store-firestore.ts의 `toBook`이 `toNullable`로 담당한다.)
 */
function normalizeBookRecord(b: BookRecord): BookRecord {
  return {
    ...b,
    transcript: b.transcript ?? null,
    youtubeUrl: b.youtubeUrl ?? null,
    // 챕터화 이전 db.json에는 이 키가 없다 — 읽을 때 null로 채운다(하위호환).
    chapters: b.chapters ?? null,
    // 수동 정렬 이전 db.json에는 이 키가 없다 — 읽을 때 null(=미정렬, 맨 위)로 채운다(하위호환).
    sortIndex: b.sortIndex ?? null,
  };
}

async function readDb(): Promise<DbShape> {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbShape>;
    return {
      // transcript grounding 이전 db.json에는 이 두 필드가 없다 — 읽을 때 null로 채운다
      // (없는 채로 흘리면 bookToMeta가 undefined를 넘겨 타입 계약과 어긋난다). 하위호환.
      books: (parsed.books ?? []).map(normalizeBookRecord),
      cards: parsed.cards ?? [],
      readings: parsed.readings ?? [],
      // M4 이전에 만들어진 db.json에는 이 키가 없다 — 마이그레이션 없이 그대로 열린다.
      // 수동 정렬 이전 문서엔 sortIndex 키가 없어 읽을 때 null(=미정렬)로 채운다(필수 nullable 방어).
      explanations: (parsed.explanations ?? []).map((e) => ({ ...e, sortIndex: e.sortIndex ?? null })),
      // V1 이전 db.json에는 이 키가 없다 — 같은 하위호환(없으면 빈 배열). sortIndex도 같은 방어.
      vocabBooks: (parsed.vocabBooks ?? []).map((v) => ({ ...v, sortIndex: v.sortIndex ?? null })),
      // V4 이전 db.json에는 이 키가 없다 — 같은 하위호환(없으면 빈 배열)
      vocabQuizzes: parsed.vocabQuizzes ?? [],
      // 아빠의 일본어 J1 이전 db.json엔 이 키가 없다 — 같은 하위호환(없으면 빈 배열). 각 레코드는
      // normalizeJaVocabBook으로 누락 키(sortIndex·topic 등)를 채운다(옛 문서 방어). get/list도 다시 태운다.
      jaVocabBooks: (parsed.jaVocabBooks ?? []).map((v) =>
        normalizeJaVocabBook(v as JaVocabBookRecord),
      ),
      // J2 이전 db.json엔 이 키가 없다 — 같은 하위호환(없으면 빈 배열). items는 normalizeJaQuizItem으로 방어.
      jaQuizzes: (parsed.jaQuizzes ?? []).map((q) => ({
        ...q,
        items: (q.items ?? []).map(normalizeJaQuizItem),
      })),
      // JK 이전 db.json엔 이 두 키가 없다 — 같은 하위호환(없으면 빈 배열). 각 레코드는 normalize로 방어.
      jaKanji: (parsed.jaKanji ?? []).map((k) => normalizeJaKanji(k as JaKanjiRecord)),
      jaKanjiQuizzes: (parsed.jaKanjiQuizzes ?? []).map((q) => ({
        ...q,
        items: (q.items ?? []).map(normalizeJaQuizItem),
      })),
      // J3 이전 db.json엔 이 키가 없다 — 같은 하위호환(없으면 빈 배열). 각 레코드는 normalizeJaDialogRecord로 방어.
      jaDialogs: (parsed.jaDialogs ?? []).map((d) => normalizeJaDialogRecord(d as JaDialogRecord)),
      // §19 이전 db.json엔 이 키가 없다 — 같은 하위호환(없으면 빈 배열). 각 레코드는 엔진의 normalizeWorkoutCycle로
      // 방어한다(두 백엔드 공유 단일 정의처 — 이후 get/list/decide*는 이 정규화된 값만 본다).
      workoutCycles: (parsed.workoutCycles ?? []).map((c) => normalizeWorkoutCycle(c)),
      // 아빠의 영어 이전 db.json엔 이 다섯 키가 없다 — 같은 하위호환(없으면 빈 배열). 각 레코드는 두 백엔드 공유
      // 정규화(lib/toeic-normalize.ts)로 방어한다 — 이후 get/list는 이 정규화된 값만 본다.
      toeicSets: (parsed.toeicSets ?? []).map(normalizeToeicSetRecord),
      toeicQuizzes: normalizeToeicQuizList(parsed.toeicQuizzes ?? []),
      toeicMocks: (parsed.toeicMocks ?? []).map(normalizeToeicMockRecord),
      toeicImages: (parsed.toeicImages ?? []).map(normalizeToeicImageRecord),
      toeicAttempts: (parsed.toeicAttempts ?? []).map(normalizeToeicAttemptRecord),
      // 자유대화 이전 db.json엔 이 키가 없다 — 같은 하위호환(없으면 빈 배열). 각 레코드는 두 백엔드 공유 정규화
      // (lib/talk-normalize.ts)로 방어한다 — 이후 get/list/addTalkExplanation은 이 정규화된 값만 본다.
      talkSessions: (parsed.talkSessions ?? []).map(normalizeTalkSessionRecord),
      // 주제 일러스트(§12-6)도 같은 하위호환 — 이 키가 없던 db.json이면 빈 배열
      talkImages: (parsed.talkImages ?? []).map(normalizeTalkImageRecord),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyDb();
    throw err;
  }
}

async function writeDb(db: DbShape): Promise<void> {
  await fs.mkdir(DB_DIR, { recursive: true });
  const tmpPath = `${DB_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(tmpPath, DB_PATH); // 임시 파일 → 원자적 교체 (쓰다 만 파일 방지)
}

/**
 * 제목+저자 정규화 키 — 공백 합치기 + 소문자 비교.
 * 두 구현(파일·Firestore)이 같은 중복 판정을 하도록 여기서만 정의한다.
 */
export function normalizeTitleAuthorKey(title: string, author: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(title)}|${norm(author)}`;
}

function byCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/** createdAt 오름차순(오래된 순 = 수집 순서). 한자 목록이 이 순서로 뜬다(JK). */
function byCreatedAtAsc(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** 시험 세션 정렬 — startedAt 오름차순(오래된 순 = 시간 순서). V5 streak 계산이 이 순서를 읽는다 */
function byStartedAtAsc(a: { startedAt: string }, b: { startedAt: string }): number {
  return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
}

/**
 * "모은 단어" 수집 단어장의 정본을 고른다 (M2). dayLabel 마커가 같은 것 중 **가장 먼저 만든 것**을
 * 정본으로 삼는다 — 첫 담기 경합으로 둘이 만들어져도 이후 담기가 같은 하나로 수렴한다. 없으면 null.
 * file·firestore 두 백엔드가 같은 규칙을 쓰도록 여기 한 곳에 둔다.
 */
function pickCollectedVocabBook(books: readonly VocabBookRecord[]): VocabBookRecord | null {
  let picked: VocabBookRecord | null = null;
  for (const b of books) {
    if (b.dayLabel !== COLLECTED_VOCAB_DAY_LABEL) continue;
    if (!picked || b.createdAt < picked.createdAt) picked = b;
  }
  return picked;
}

/**
 * 설명 기록의 문제 입력 정규화 — 저장 직전에 `givens[].unit`의 `undefined`를 `null`로 조인다.
 * (요청 zod가 `nullish`라 undefined로 들어올 수 있고, Firestore는 undefined를 아예 거부한다.)
 *
 * **두 백엔드가 같은 것을 저장하도록 여기서만 정의한다** — `normalizeTitleAuthorKey`와 같은 자리,
 * 같은 이유다. 예전에는 Firestore 구현에만 있어서, 파일 백엔드는 `unit` 키가 통째로 사라진
 * 레코드를 남겼다(타입은 `string | null`인데 읽으면 `undefined`).
 */
export function normalizeProblem(problem: MathProblemInput): MathProblemInput {
  return {
    ...problem,
    givens:
      problem.givens?.map((g) => ({ label: g.label, value: g.value, unit: g.unit ?? null })) ??
      null,
  };
}

/**
 * 단어 항목 저장 직전 방어 변환 — `undefined`를 전부 `null`(또는 빈 배열/문자열)로 조인다.
 *
 * **두 백엔드가 같은 것을 저장하도록 여기서만 정의한다** — `normalizeProblem`과 같은 자리,
 * 같은 이유다(예전에 Firestore 구현에만 정규화가 있어 파일 백엔드가 키를 잃었다). Firestore는
 * `undefined`를 아예 거부하고, `VocabEntry`의 (B) 창작 필드(V1에서 항상 null)와 중첩 배열
 * (`examples[].ko`·`related[].glossKo`)이 undefined로 새어 들면 저장이 통째로 실패한다.
 *
 * 값을 **손보지 않는다** — 뜻·예문은 책 전사본이라 여기서 다듬으면 원문이 바뀐다. 오직
 * "없는 것을 없음으로 적는" 정규화만 한다(정렬·병합은 이미 mergeVocabPages가 끝냈다).
 */
/**
 * `normalizeVocabEntry`가 받는 느슨한 입력. 저장(쓰기)은 새 구조 `VocabEntry`를 넘기지만,
 * **읽기 경로**(Firestore·파일 백엔드)에는 2026-08-22 이전에 저장된 옛 레코드가 섞여 있다 —
 * 그 레코드는 `meanings` 대신 평평한 `meaningsKo: string[]`를 갖는다. 두 모양을 한 함수가
 * 받아 새 구조로 흡수하려고 입력을 넓게 연다(옛 필드 `meaningsKo` 포함).
 */
export type LegacyOrNewVocabEntry = Partial<VocabEntry> & { meaningsKo?: unknown };

/**
 * 관련어 하나를 방어 정규화 — undefined를 null(또는 빈 문자열)로 조이고, 출처·연결 참조
 * (source·linkedNo·linkedMeaningIndex)를 채운다. 정규화 규칙은 스키마 단일 정의처(normalizeRelated)에
 * 위임한다 — 옛 레코드(세 필드 없음)는 source:"book"·linked* null로, 사용자 연결(source:"user")은 그대로 보존된다.
 */
function normalizeVocabRelated(r: unknown): VocabRelated {
  return normalizeRelated(r);
}

/**
 * 뜻 배열을 옛·새 두 구조 모두에서 새 구조 `VocabMeaning[]`로 흡수한다.
 * - 새 구조(`meanings`): 각 뜻의 no·ko·related를 정규화.
 * - 옛 구조(`meaningsKo: string[]`): 각 뜻을 `{ no:null, ko, related:[] }`로 승격.
 * 옛 레코드가 500을 내지 않게 하는 핵심 자리다(§5-1 인계).
 */
function toVocabMeanings(e: LegacyOrNewVocabEntry): VocabMeaning[] {
  if (Array.isArray(e.meanings)) {
    return e.meanings.map((m) => {
      const mm = (m ?? {}) as Partial<VocabMeaning>;
      return {
        no: typeof mm.no === "number" ? mm.no : null,
        ko: String(mm.ko ?? ""),
        related: Array.isArray(mm.related) ? mm.related.map(normalizeVocabRelated) : [],
      };
    });
  }
  if (Array.isArray(e.meaningsKo)) {
    return (e.meaningsKo as unknown[]).map((ko) => ({ no: null, ko: String(ko), related: [] }));
  }
  return [];
}

export function normalizeVocabEntry(entry: LegacyOrNewVocabEntry): VocabEntry {
  return {
    // (A) 책 전사
    no: entry.no ?? null,
    word: entry.word ?? "",
    ipa: entry.ipa ?? null,
    pos: entry.pos ?? [],
    // 옛 meaningsKo(평평) → 새 meanings(뜻 번호·유의어)로 승격. 선택 키 금지 규약 유지(meaningsKo는 반환 안 함)
    meanings: toVocabMeanings(entry),
    examples: (entry.examples ?? []).map((e) => ({ en: e.en, ko: e.ko ?? "" })),
    related: (entry.related ?? []).map(normalizeVocabRelated),
    // (B) AI 창작 — V1에서는 전부 null. undefined로 새면 Firestore가 거부한다
    definitionEn: entry.definitionEn ?? null,
    // 구 레코드(정의만 있고 KO 해석 없음, V7 이전) → null 폴백. 다음 보강에서 백필된다(§8-5)
    definitionKo: entry.definitionKo ?? null,
    imageEmoji: entry.imageEmoji ?? null,
    imageSvg: entry.imageSvg ?? null,
    // (C) 앱 부착
    photoIndex: entry.photoIndex ?? 0,
    confidence: entry.confidence ?? "medium",
    partial: entry.partial ?? false,
  };
}

/**
 * 시험 문항 하나를 저장 직전 방어 정규화 — `undefined`를 정한 값으로 조인다(Firestore 거부 방어).
 *
 * **두 백엔드가 같은 것을 저장하도록 여기서만 정의한다**(normalizeVocabEntry와 같은 자리·이유).
 * `answered`는 세 상태(true/false/null)를 유지하되, undefined만 null로 떨군다 — false와 null은
 * 뜻이 다르다(false=답 골랐는데 자리 미정 없음, null=미응답). `correct`는 boolean으로 굳힌다.
 */
export function normalizeVocabQuizItem(item: Partial<VocabQuizItem>): VocabQuizItem {
  return {
    word: String(item.word ?? ""),
    correct: item.correct === true,
    answered: item.answered === true ? true : item.answered === false ? false : null,
  };
}

/** `applyVocabLink`의 방향 — 링크를 걸(link) 것인지 뺄(unlink) 것인지. */
export type VocabLinkOp = "link" | "unlink";

/**
 * 유의어/반의어 연결·해제의 **순수 변환** — 링크를 걸거나 뺀 새 `entries`를 돌려준다 (V8 관계 문제).
 *
 * **두 백엔드가 같은 것을 저장하도록 여기서만 정의한다**(normalizeVocabEntry·normalizeVocabQuizItem과
 * 같은 자리·이유). 파일·Firestore 스토어가 각각 링크 로직을 구현하면 반드시 어긋난다 — 그래서 변환은
 * 이 순수 함수 한 곳만 살고, 두 스토어는 "읽고 → 이 함수로 새 entries 만들고 → 저장"만 한다.
 *
 * ── 상호 기록(양쪽 뜻) ──────────────────────────────────────────────────────
 * source 뜻의 related에 대상(word=target.word·glossKo=대상 뜻 ko·source:"user"·linkedNo=대상 no·
 * linkedMeaningIndex)을, target 뜻의 related에 대칭으로(word=source.word·glossKo=source 뜻 ko·
 * linkedNo=source no·linkedMeaningIndex) 붙인다. syn/ant는 대칭이라 양쪽 kind가 같다.
 *
 * ── 멱등 ────────────────────────────────────────────────────────────────────
 * link는 이미 있는 링크면 추가하지 않고, unlink는 없는 링크를 풀어도 조용히 통과한다(둘 다 status "ok").
 * 매칭은 (source:"user"·kind·상대 word·상대 meaningIndex)로 한다 — no가 null(손입력 단어)이어도 안정적.
 *
 * ── 방어 ────────────────────────────────────────────────────────────────────
 * 인덱스가 범위 밖이거나 뜻 인덱스가 밖이거나 자기 자신(source==target)이면 "invalid"(라우트가 400).
 * 입력 entries를 **바꾸지 않는다**(얕은 복제로 불변성 유지).
 */
export function applyVocabLink(
  entries: VocabEntry[],
  input: VocabLinkInput,
  op: VocabLinkOp,
): { status: "ok"; entries: VocabEntry[] } | { status: "invalid" } {
  const { sourceIndex, sourceMeaningIndex, targetIndex, targetMeaningIndex, kind } = input;
  // 자기 자신 금지 — 같은 단어(entry)끼리는 잇지 않는다(뜻이 달라도 self).
  if (sourceIndex === targetIndex) return { status: "invalid" };
  const source = entries[sourceIndex];
  const target = entries[targetIndex];
  if (!source || !target) return { status: "invalid" };
  const sm = source.meanings[sourceMeaningIndex];
  const tm = target.meanings[targetMeaningIndex];
  if (!sm || !tm) return { status: "invalid" };

  // 상호 링크 한 쌍 — source 뜻에 붙는 것(→target)과 target 뜻에 붙는 것(→source).
  const onSource: VocabRelated = {
    kind, word: target.word, glossKo: tm.ko, source: "user",
    linkedNo: target.no, linkedMeaningIndex: targetMeaningIndex,
  };
  const onTarget: VocabRelated = {
    kind, word: source.word, glossKo: sm.ko, source: "user",
    linkedNo: source.no, linkedMeaningIndex: sourceMeaningIndex,
  };
  // 사용자 링크 식별(멱등 검사·해제 매칭 공용). 상대 word가 유일 키 역할(no가 null이어도 안정적).
  const matchOnSource = (r: VocabRelated) =>
    r.source === "user" && r.kind === kind && r.word === target.word && r.linkedMeaningIndex === targetMeaningIndex;
  const matchOnTarget = (r: VocabRelated) =>
    r.source === "user" && r.kind === kind && r.word === source.word && r.linkedMeaningIndex === sourceMeaningIndex;

  const next = entries.map((e, i) => {
    if (i !== sourceIndex && i !== targetIndex) return e;
    const meanings = e.meanings.map((m, mi) => {
      const isSourceMeaning = i === sourceIndex && mi === sourceMeaningIndex;
      const isTargetMeaning = i === targetIndex && mi === targetMeaningIndex;
      if (!isSourceMeaning && !isTargetMeaning) return m;
      const add = isSourceMeaning ? onSource : onTarget;
      const matches = isSourceMeaning ? matchOnSource : matchOnTarget;
      let related: VocabRelated[];
      if (op === "link") {
        related = m.related.some(matches) ? m.related : [...m.related, add]; // 멱등
      } else {
        related = m.related.filter((r) => !matches(r));
      }
      return { ...m, related };
    });
    return { ...e, meanings };
  });
  return { status: "ok", entries: next };
}

// ---------------------------------------------------------------------------
// 일본어 단어장 저장 방어 정규화 (아빠의 일본어 J1) — undefined를 정한 값(null·빈 배열·"")으로 조인다.
// **두 백엔드가 같은 것을 저장하도록 여기서만 정의한다**(normalizeVocabEntry와 같은 자리·이유). 값을
// 손보지 않는다 — 표기·읽기·예문은 생성 결과라 다듬으면 원문이 바뀐다. 오직 "없는 것을 없음으로 적는" 정규화만.
// 옛/손입력 문서(누락 키)도 이 함수를 거치면 타입 계약(전부 필수 nullable)을 만족한다.
// ---------------------------------------------------------------------------

// 단어 항목 방어 정규화(normalizeJaVocabEntry)는 **lib/ai/japanese/vocab.ts 단일 정의처**를 쓴다(위 import, 인계 #1).
// imageEmoji 하위호환(구 레코드 → null)도 그 함수가 담당한다 — store가 따로 인라인 fill하지 않는다.

/**
 * 일본어 단어장 레코드 방어 정규화 (§7-1). 읽기(get/list·readDb)·쓰기(create) 경로가 모두 이걸 태운다.
 * kind는 "collected"만 명시 인정(그 밖은 "jlpt"), levels·entries는 배열 보장, topic·sortIndex는 nullable.
 */
export function normalizeJaVocabBook(book: JaVocabBookRecord): JaVocabBookRecord {
  const b = book as Partial<JaVocabBookRecord>;
  return {
    id: b.id ?? "",
    titleKo: String(b.titleKo ?? ""),
    kind: b.kind === "collected" ? "collected" : "jlpt",
    entries: Array.isArray(b.entries) ? b.entries.map(normalizeJaVocabEntry) : [],
    levels: Array.isArray(b.levels) ? (b.levels.filter((l) => typeof l === "string") as JlptLevel[]) : [],
    topic: b.topic ?? null,
    model: String(b.model ?? ""),
    createdAt: b.createdAt ?? new Date(0).toISOString(),
    sortIndex: b.sortIndex ?? null,
  };
}

/**
 * 일본어 시험 문항 하나 방어 정규화 — undefined를 정한 값으로 조인다(Firestore 거부 방어). 영어
 * `normalizeVocabQuizItem`과 같은 규약: `answered`는 세 상태(true/false/null) 유지, `correct`는 boolean으로 굳힌다.
 */
export function normalizeJaQuizItem(item: Partial<JaQuizItem>): JaQuizItem {
  return {
    word: String(item.word ?? ""),
    correct: item.correct === true,
    answered: item.answered === true ? true : item.answered === false ? false : null,
  };
}

/**
 * 한자 정보 레코드 방어 정규화(JK, §12-3) — undefined를 정한 값으로 조인다(Firestore 거부 방어). 값을 손보지
 * 않고 "없는 것을 없음"으로만 적는다. 두 백엔드 공유 단일 정의처(normalizeJaVocabBook과 같은 자리).
 */
export function normalizeJaKanji(k: Partial<JaKanjiRecord>): JaKanjiRecord {
  return {
    id: k.id ?? "",
    kanji: String(k.kanji ?? ""),
    koReading: typeof k.koReading === "string" ? k.koReading : null,
    onyomi: Array.isArray(k.onyomi) ? k.onyomi.map((s) => String(s)) : [],
    kunyomi: Array.isArray(k.kunyomi) ? k.kunyomi.map((s) => String(s)) : [],
    meaningKo: String(k.meaningKo ?? ""),
    model: String(k.model ?? ""),
    createdAt: k.createdAt ?? new Date(0).toISOString(),
  };
}

/** "대화에서 모은 단어" 단어장 이름·식별. kind:"collected"가 마커다(제목은 사용자가 안 바꾸지만 kind로 찾는다). */
export const JA_COLLECTED_VOCAB_TITLE_KO = "대화에서 모은 단어";

function normalizeJaToken2(t: unknown): JaToken {
  const o = (t ?? {}) as Partial<JaToken>;
  return { surface: String(o.surface ?? ""), reading: typeof o.reading === "string" ? o.reading : null };
}
function normalizeJaFeedback(fb: unknown): JaDialogFeedback | null {
  if (fb == null) return null;
  const o = fb as Partial<JaDialogFeedback>;
  return { kind: o.kind === "praise" ? "praise" : "tip", textKo: String(o.textKo ?? "") };
}
function normalizeJaDialogTurn(t: unknown): JaDialogTurn {
  const o = (t ?? {}) as Partial<JaDialogTurn>;
  const speaker = o.speaker === "partner" || o.speaker === "me" ? o.speaker : "unknown";
  return {
    speaker,
    ja: String(o.ja ?? ""),
    tokens: Array.isArray(o.tokens) ? o.tokens.map(normalizeJaToken2) : [],
    feedback: normalizeJaFeedback(o.feedback),
  };
}

/**
 * 대화 복습 레코드 방어 정규화 (§7-2) — undefined를 정한 값으로 조인다(Firestore 거부 방어). turns는 깊게 조이고,
 * coaching은 zod가 이미 검증한 호출 C 출력이라 **있으면 그대로, 없으면 null**로 둔다(두 백엔드 공유 단일 정의처).
 */
export function normalizeJaDialogRecord(d: Partial<JaDialogRecord>): JaDialogRecord {
  return {
    id: d.id ?? "",
    titleKo: String(d.titleKo ?? ""),
    focusKo: typeof d.focusKo === "string" ? d.focusKo : null,
    turns: Array.isArray(d.turns) ? d.turns.map(normalizeJaDialogTurn) : [],
    coaching: d.coaching ?? null,
    photoCount: typeof d.photoCount === "number" ? d.photoCount : 0,
    partial: d.partial === true,
    model: String(d.model ?? ""),
    createdAt: d.createdAt ?? new Date(0).toISOString(),
    sortIndex: d.sortIndex ?? null,
  };
}

/** 운동 사이클을 id로 upsert한다(파일 백엔드 전용) — decideStart의 writes·decideLog/Undo의 next를 반영할 때. */
function upsertWorkoutCycle(db: DbShape, record: WorkoutCycleRecord): void {
  const i = db.workoutCycles.findIndex((c) => c.id === record.id);
  if (i >= 0) db.workoutCycles[i] = record;
  else db.workoutCycles.push(record);
}

class JsonFileStore implements BookCardStore {
  /** 쓰기 직렬화 큐 — 동시 요청이 db.json을 서로 덮어쓰지 않게 한다 */
  private queue: Promise<unknown> = Promise.resolve();

  private mutate<T>(fn: (db: DbShape) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const db = await readDb();
      const result = fn(db);
      await writeDb(db);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async createBook(input: NewBook): Promise<BookRecord> {
    const record: BookRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      // 신규 책은 미정렬(맨 위)로 시작한다 — 정렬 규칙상 sortIndex=null이 최신 블록.
      sortIndex: null,
    };
    return this.mutate((db) => {
      db.books.push(record);
      return record;
    });
  }

  async reorderBooks(orderedIds: string[]): Promise<void> {
    // 넘어온 순서 = 최종 순서. 각 book의 sortIndex를 0..n으로 박는다.
    // **목록에 없는 book은 건드리지 않는다**(sortIndex 보존) — 부분 재배치·검색 필터 안전.
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    await this.mutate((db) => {
      for (const book of db.books) {
        const idx = rank.get(book.id);
        if (idx !== undefined) book.sortIndex = idx;
      }
    });
  }

  async getBook(id: string): Promise<BookRecord | null> {
    const db = await readDb();
    return db.books.find((b) => b.id === id) ?? null;
  }

  async listBooks(): Promise<BookRecord[]> {
    const db = await readDb();
    return [...db.books].sort(byCreatedAtDesc);
  }

  async findBookByTitleAuthor(title: string, author: string): Promise<BookRecord | null> {
    const key = normalizeTitleAuthorKey(title, author);
    const db = await readDb();
    return db.books.find((b) => normalizeTitleAuthorKey(b.title, b.author) === key) ?? null;
  }

  async deleteBook(bookId: string): Promise<DeleteBookResult> {
    // 한 번의 mutate(= 읽기→변경→원자적 쓰기) 안에서 셋을 함께 지운다 —
    // 카드만 지워지고 책이 남는 중간 상태가 파일에 남지 않는다.
    return this.mutate((db) => {
      const cardsBefore = db.cards.length;
      const readingsBefore = db.readings.length;
      db.books = db.books.filter((b) => b.id !== bookId);
      db.cards = db.cards.filter((c) => c.bookId !== bookId);
      db.readings = db.readings.filter((r) => r.bookId !== bookId);
      return {
        cards: cardsBefore - db.cards.length,
        readings: readingsBefore - db.readings.length,
      };
    });
  }

  async updateBookEvidence(
    bookId: string,
    patch: BookEvidencePatch,
  ): Promise<BookRecord | null> {
    return this.mutate((db) => {
      const book = db.books.find((b) => b.id === bookId);
      if (!book) return null;
      // 지정한 키만 덮어쓴다 — undefined는 "건드리지 않음"이지 "null로 지움"이 아니다
      if ("blurbText" in patch) book.blurbText = patch.blurbText ?? null;
      if ("sceneKind" in patch) book.sceneKind = patch.sceneKind ?? null;
      if ("sceneDigest" in patch) book.sceneDigest = patch.sceneDigest ?? null;
      if ("transcript" in patch) book.transcript = patch.transcript ?? null;
      if ("youtubeUrl" in patch) book.youtubeUrl = patch.youtubeUrl ?? null;
      if ("chapters" in patch) book.chapters = patch.chapters ?? null;
      return book;
    });
  }

  async createCard(input: NewCard): Promise<CardRecord> {
    const record: CardRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.mutate((db) => {
      db.cards.push(record);
      return record;
    });
  }

  async getCard(id: string): Promise<CardRecord | null> {
    const db = await readDb();
    return db.cards.find((c) => c.id === id) ?? null;
  }

  async deleteCard(cardId: string): Promise<boolean> {
    return this.mutate((db) => {
      const before = db.cards.length;
      db.cards = db.cards.filter((c) => c.id !== cardId);
      return db.cards.length < before;
    });
  }

  async listCardsForBook(bookId: string): Promise<CardRecord[]> {
    const db = await readDb();
    return db.cards.filter((c) => c.bookId === bookId).sort(byCreatedAtDesc);
  }

  async listRecentCards(limit: number): Promise<CardWithBook[]> {
    const db = await readDb();
    const books = new Map(db.books.map((b) => [b.id, b]));
    return [...db.cards]
      .sort(byCreatedAtDesc)
      .flatMap((card) => {
        const book = books.get(card.bookId);
        return book ? [{ card, book }] : [];
      })
      .slice(0, limit);
  }

  async addReading(input: NewReading): Promise<ReadingRecord> {
    const record: ReadingRecord = { ...input, id: randomUUID() };
    return this.mutate((db) => {
      db.readings.push(record);
      return record;
    });
  }

  async listReadings(bookId?: string): Promise<ReadingRecord[]> {
    const db = await readDb();
    const list = bookId ? db.readings.filter((r) => r.bookId === bookId) : db.readings;
    return [...list].sort((a, b) => (a.readAt < b.readAt ? 1 : -1));
  }

  // ---- explanations (M4) ----

  async createExplanation(input: NewExplanation): Promise<ExplanationRecord> {
    const record: ExplanationRecord = {
      ...input,
      // Firestore 구현과 같은 정규화를 태운다 — 두 백엔드가 같은 것을 저장해야 한다
      problem: normalizeProblem(input.problem),
      // 신규 설명은 미정렬(맨 위)로 시작 — reorderExplanations로만 값이 박힌다.
      sortIndex: null,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.mutate((db) => {
      db.explanations.push(record);
      return record;
    });
  }

  async reorderExplanations(orderedIds: string[]): Promise<void> {
    // reorderBooks의 explanations판(같은 규약). 넘긴 순서대로 0..n, 목록에 없는 기록은 불간섭.
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    await this.mutate((db) => {
      for (const e of db.explanations) {
        const idx = rank.get(e.id);
        if (idx !== undefined) e.sortIndex = idx;
      }
    });
  }

  async getExplanation(id: string): Promise<ExplanationRecord | null> {
    const db = await readDb();
    return db.explanations.find((e) => e.id === id) ?? null;
  }

  async listExplanations(limit?: number): Promise<ExplanationRecord[]> {
    const db = await readDb();
    const sorted = [...db.explanations].sort(byCreatedAtDesc);
    return limit == null ? sorted : sorted.slice(0, limit);
  }

  async deleteExplanation(id: string): Promise<boolean> {
    return this.mutate((db) => {
      const before = db.explanations.length;
      db.explanations = db.explanations.filter((e) => e.id !== id);
      return db.explanations.length < before;
    });
  }

  // ---- vocabBooks (V1) ----

  async createVocabBook(input: NewVocabBook): Promise<VocabBookRecord> {
    const record: VocabBookRecord = {
      ...input,
      // Firestore 구현과 같은 정규화를 태운다 — 두 백엔드가 같은 것을 저장해야 한다
      entries: input.entries.map(normalizeVocabEntry),
      // 신규 단어장은 미정렬(맨 위)로 시작 — reorderVocabBooks로만 값이 박힌다.
      sortIndex: null,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.mutate((db) => {
      db.vocabBooks.push(record);
      return record;
    });
  }

  async reorderVocabBooks(orderedIds: string[]): Promise<void> {
    // reorderBooks의 vocab판(같은 규약). 넘긴 순서대로 0..n, 목록에 없는 단어장은 불간섭.
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    await this.mutate((db) => {
      for (const v of db.vocabBooks) {
        const idx = rank.get(v.id);
        if (idx !== undefined) v.sortIndex = idx;
      }
    });
  }

  async getVocabBook(id: string): Promise<VocabBookRecord | null> {
    const db = await readDb();
    const found = db.vocabBooks.find((v) => v.id === id);
    if (!found) return null;
    // 읽기 정규화 — 옛 meaningsKo 레코드를 새 meanings로 승격(Firestore toVocabBook과 같은 방어)
    return { ...found, entries: (found.entries ?? []).map(normalizeVocabEntry) };
  }

  async getOrCreateCollectedVocabBook(): Promise<VocabBookRecord> {
    // 흔한 경로(이미 있음)는 파일을 다시 쓰지 않게 먼저 읽어 확인한다 — 없을 때만 mutate로 만든다.
    const db0 = await readDb();
    const existing = pickCollectedVocabBook(db0.vocabBooks);
    if (existing) {
      return { ...existing, entries: (existing.entries ?? []).map(normalizeVocabEntry) };
    }
    return this.mutate((db) => {
      // 경합 재확인 — read~mutate 사이에 다른 담기가 정본을 이미 만들었을 수 있다.
      const again = pickCollectedVocabBook(db.vocabBooks);
      if (again) return { ...again, entries: (again.entries ?? []).map(normalizeVocabEntry) };
      const record: VocabBookRecord = {
        titleKo: COLLECTED_VOCAB_TITLE_KO,
        dayLabel: COLLECTED_VOCAB_DAY_LABEL,
        entries: [],
        photoCount: 0,
        enriched: false,
        model: "",
        sortIndex: null,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      db.vocabBooks.push(record);
      return record;
    });
  }

  async listVocabBooks(limit?: number): Promise<VocabBookRecord[]> {
    const db = await readDb();
    const sorted = [...db.vocabBooks].sort(byCreatedAtDesc);
    const sliced = limit == null ? sorted : sorted.slice(0, limit);
    return sliced.map((v) => ({ ...v, entries: (v.entries ?? []).map(normalizeVocabEntry) }));
  }

  async updateVocabBookEnrichment(
    id: string,
    entries: VocabEntry[],
    enriched: boolean,
  ): Promise<VocabBookRecord | null> {
    // 쓰기 정규화 — createVocabBook과 같은 관문(undefined를 조인다). 정의 불변은 호출측 mergeEnrichment의 몫.
    const normalized = entries.map(normalizeVocabEntry);
    return this.mutate((db) => {
      const book = db.vocabBooks.find((v) => v.id === id);
      if (!book) return null;
      book.entries = normalized;
      book.enriched = enriched;
      return { ...book };
    });
  }

  async appendVocabEntry(id: string, entry: VocabEntry): Promise<AppendVocabEntryResult> {
    const incoming = normalizeVocabEntry(entry);
    const key = incoming.word.trim().toLowerCase();
    return this.mutate((db) => {
      const book = db.vocabBooks.find((v) => v.id === id);
      if (!book) return { record: null, appended: false };
      // 저장된 옛 레코드도 표(.map)가 안 터지게 읽기와 같은 정규화를 태운다(getVocabBook 규약).
      const existing = (book.entries ?? []).map(normalizeVocabEntry);
      // 중복(대소문자 무시 word) — 이미 있으면 붙이지 않고 현재 레코드를 그대로 돌려준다.
      if (existing.some((e) => e.word.trim().toLowerCase() === key)) {
        return { record: { ...book, entries: existing }, appended: false };
      }
      book.entries = [...existing, incoming];
      // 뜻 null 단어가 붙으면 enriched가 false로 떨어진다 — 단일 정의처로 다시 계산(우회 금지).
      book.enriched = isVocabBookEnriched(book.entries);
      return { record: { ...book }, appended: true };
    });
  }

  async linkVocabRelated(id: string, input: VocabLinkInput): Promise<VocabLinkResult> {
    return this.applyLink(id, input, "link");
  }

  async unlinkVocabRelated(id: string, input: VocabLinkInput): Promise<VocabLinkResult> {
    return this.applyLink(id, input, "unlink");
  }

  /**
   * link/unlink 공용 — 읽기 정규화(getVocabBook 규약)로 옛 레코드도 안전히 다룬 뒤, 순수 변환
   * `applyVocabLink`로 새 entries를 만들어 저장한다. 저장 직전 normalizeVocabEntry로 undefined를 조인다.
   * **수정이라 prod-guard 무관**(레코드 삭제가 아니라 필드 편집).
   */
  private applyLink(id: string, input: VocabLinkInput, op: VocabLinkOp): Promise<VocabLinkResult> {
    return this.mutate((db) => {
      const book = db.vocabBooks.find((v) => v.id === id);
      if (!book) return { status: "not_found" as const };
      const entries = (book.entries ?? []).map(normalizeVocabEntry);
      const result = applyVocabLink(entries, input, op);
      if (result.status === "invalid") return { status: "invalid" as const };
      book.entries = result.entries.map(normalizeVocabEntry);
      return { status: "ok" as const, record: { ...book, entries: book.entries } };
    });
  }

  async updateVocabBookTitle(id: string, titleKo: string): Promise<VocabBookRecord | null> {
    // **삭제가 아니라 수정**이라 prod-guard가 걸리지 않는다(updateVocabBookEnrichment와 같은 규약).
    // titleKo 한 필드만 갈아끼우고 entries는 손대지 않는다 — 반환만 읽기 정규화(getVocabBook 규약)를 태운다.
    return this.mutate((db) => {
      const book = db.vocabBooks.find((v) => v.id === id);
      if (!book) return null;
      book.titleKo = titleKo;
      return { ...book, entries: (book.entries ?? []).map(normalizeVocabEntry) };
    });
  }

  async deleteVocabBook(id: string): Promise<DeleteVocabBookResult> {
    // 단어장과 그 시험 세션(V4)을 한 mutate 안에서 함께 지운다 — deleteBook이 카드·읽음 기록을
    // 함께 지우는 것과 같은 규약. 단어장만 지워지고 유령 퀴즈가 남는 중간 상태를 파일에 남기지 않는다.
    return this.mutate((db) => {
      const before = db.vocabBooks.length;
      db.vocabBooks = db.vocabBooks.filter((v) => v.id !== id);
      const ok = db.vocabBooks.length < before;
      if (ok) db.vocabQuizzes = db.vocabQuizzes.filter((q) => q.bookId !== id);
      return { ok };
    });
  }

  // ---- vocabQuizzes (V4) ----

  async addVocabQuiz(input: NewVocabQuiz): Promise<VocabQuizRecord> {
    const record: VocabQuizRecord = {
      ...input,
      // Firestore 구현과 같은 정규화를 태운다 — 두 백엔드가 같은 것을 저장해야 한다
      items: input.items.map(normalizeVocabQuizItem),
      id: randomUUID(),
    };
    return this.mutate((db) => {
      db.vocabQuizzes.push(record);
      return record;
    });
  }

  async listVocabQuizzes(bookId: string): Promise<VocabQuizRecord[]> {
    const db = await readDb();
    return db.vocabQuizzes
      .filter((q) => q.bookId === bookId)
      .map((q) => ({ ...q, items: (q.items ?? []).map(normalizeVocabQuizItem) }))
      .sort(byStartedAtAsc);
  }

  async listAllVocabQuizzes(): Promise<VocabQuizRecord[]> {
    // bookId 필터만 뺀 listVocabQuizzes — 전역 startedAt 오름차순(층2가 bookId별로 다시 가른다).
    const db = await readDb();
    return db.vocabQuizzes
      .map((q) => ({ ...q, items: (q.items ?? []).map(normalizeVocabQuizItem) }))
      .sort(byStartedAtAsc);
  }

  // ---- jaVocabBooks — 아빠의 일본어 JLPT 단어장 (J1) ----

  async createJaVocabBook(input: NewJaVocabBook): Promise<JaVocabBookRecord> {
    const record: JaVocabBookRecord = normalizeJaVocabBook({
      ...input,
      sortIndex: null, // 신규는 미정렬(맨 위) — reorder로만 값이 박힌다
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    } as JaVocabBookRecord);
    return this.mutate((db) => {
      db.jaVocabBooks.push(record);
      return record;
    });
  }

  async getJaVocabBook(id: string): Promise<JaVocabBookRecord | null> {
    const db = await readDb();
    const found = db.jaVocabBooks.find((v) => v.id === id);
    return found ? normalizeJaVocabBook(found) : null;
  }

  async listJaVocabBooks(limit?: number): Promise<JaVocabBookRecord[]> {
    const db = await readDb();
    const sorted = [...db.jaVocabBooks].sort(byCreatedAtDesc);
    const sliced = limit == null ? sorted : sorted.slice(0, limit);
    return sliced.map(normalizeJaVocabBook);
  }

  async deleteJaVocabBook(id: string): Promise<DeleteJaVocabBookResult> {
    // prod-guard는 firestore(실데이터) 백엔드에만 건다 — 파일 백엔드는 로컬이라 안전(deleteVocabBook 선례).
    // 단어장과 그 시험 세션(J2)을 한 mutate 안에서 함께 지운다 — 유령 세션이 남지 않게(영어 deleteVocabBook 규약).
    return this.mutate((db) => {
      const before = db.jaVocabBooks.length;
      db.jaVocabBooks = db.jaVocabBooks.filter((v) => v.id !== id);
      const ok = db.jaVocabBooks.length < before;
      if (ok) db.jaQuizzes = db.jaQuizzes.filter((q) => q.bookId !== id);
      return { ok };
    });
  }

  async reorderJaVocabBooks(orderedIds: string[]): Promise<void> {
    // reorderBooks의 일본어판(같은 규약). 넘긴 순서대로 0..n, 목록에 없는 단어장은 불간섭. 수정이라 prod-guard 무관.
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    await this.mutate((db) => {
      for (const v of db.jaVocabBooks) {
        const idx = rank.get(v.id);
        if (idx !== undefined) v.sortIndex = idx;
      }
    });
  }

  async updateJaVocabBookTitle(id: string, titleKo: string): Promise<JaVocabBookRecord | null> {
    // titleKo 한 필드만 갈아끼운다 — entries·levels·topic은 손대지 않는다. 수정이라 prod-guard 무관.
    return this.mutate((db) => {
      const book = db.jaVocabBooks.find((v) => v.id === id);
      if (!book) return null;
      book.titleKo = titleKo;
      return normalizeJaVocabBook(book);
    });
  }

  // ---- jaQuizzes (J2) ----

  async addJaQuiz(input: NewJaQuiz): Promise<JaQuizRecord> {
    const record: JaQuizRecord = {
      ...input,
      items: input.items.map(normalizeJaQuizItem), // firestore와 같은 정규화(두 백엔드 동일)
      id: randomUUID(),
    };
    return this.mutate((db) => {
      db.jaQuizzes.push(record);
      return record;
    });
  }

  async listJaQuizzes(bookId: string): Promise<JaQuizRecord[]> {
    const db = await readDb();
    return db.jaQuizzes
      .filter((q) => q.bookId === bookId)
      .map((q) => ({ ...q, items: (q.items ?? []).map(normalizeJaQuizItem) }))
      .sort(byStartedAtAsc);
  }

  async listAllJaQuizzes(): Promise<JaQuizRecord[]> {
    // bookId 필터만 뺀 listJaQuizzes — 전역 startedAt 오름차순(스트릭이 사람별로 접는다, listAllVocabQuizzes 규약).
    const db = await readDb();
    return db.jaQuizzes
      .map((q) => ({ ...q, items: (q.items ?? []).map(normalizeJaQuizItem) }))
      .sort(byStartedAtAsc);
  }

  // ---- jaKanji · jaKanjiQuizzes (JK) ----

  async saveJaKanji(records: NewJaKanji[]): Promise<number> {
    const now = new Date().toISOString();
    return this.mutate((db) => {
      let added = 0;
      for (const rec of records) {
        const normalized = normalizeJaKanji({ ...rec, id: randomUUID(), createdAt: now });
        const idx = db.jaKanji.findIndex((k) => k.kanji === normalized.kanji);
        if (idx >= 0) {
          // **이미 있는 한자는 덮어쓰지 않는다**(§12-2 불변). 시험(kanji-to-on·kanji-to-meaning)이
          // 저장된 음독·뜻에 매달리므로, 재생성 때마다 값이 바뀌면 외운 것과 문제가 어긋난다.
          // 정상 경로는 selectKanjiToEnrich가 이미 걸러 주지만, 동시 요청(race)까지 저장 계층에서 막는다.
          // 영어 단어장의 "정의 불변"과 같은 자리. 덮어쓰기가 필요하면 사람이 고치는 길만 둔다.
          continue;
        }
        db.jaKanji.push(normalized);
        added += 1;
      }
      return added;
    });
  }

  async listJaKanji(): Promise<JaKanjiRecord[]> {
    const db = await readDb();
    return [...db.jaKanji].map(normalizeJaKanji).sort(byCreatedAtAsc);
  }

  async addJaKanjiQuiz(input: NewJaKanjiQuiz): Promise<JaKanjiQuizRecord> {
    const record: JaKanjiQuizRecord = {
      ...input,
      items: input.items.map(normalizeJaQuizItem),
      id: randomUUID(),
    };
    return this.mutate((db) => {
      db.jaKanjiQuizzes.push(record);
      return record;
    });
  }

  async listJaKanjiQuizzes(): Promise<JaKanjiQuizRecord[]> {
    const db = await readDb();
    return db.jaKanjiQuizzes
      .map((q) => ({ ...q, items: (q.items ?? []).map(normalizeJaQuizItem) }))
      .sort(byStartedAtAsc);
  }

  // ---- jaDialogs (J3~J5) ----

  async createJaDialog(input: NewJaDialog): Promise<JaDialogRecord> {
    const record = normalizeJaDialogRecord({
      ...(input as JaDialogRecord),
      sortIndex: null,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return this.mutate((db) => {
      db.jaDialogs.push(record);
      return record;
    });
  }

  async getJaDialog(id: string): Promise<JaDialogRecord | null> {
    const db = await readDb();
    const found = db.jaDialogs.find((d) => d.id === id);
    return found ? normalizeJaDialogRecord(found) : null;
  }

  async listJaDialogs(limit?: number): Promise<JaDialogRecord[]> {
    const db = await readDb();
    const sorted = [...db.jaDialogs].sort(byCreatedAtDesc);
    return (limit == null ? sorted : sorted.slice(0, limit)).map(normalizeJaDialogRecord);
  }

  async deleteJaDialog(id: string): Promise<DeleteJaVocabBookResult> {
    // prod-guard는 firestore(실데이터)에만 건다 — 파일 백엔드는 로컬이라 안전(deleteJaVocabBook 선례). 딸린 것 없음.
    return this.mutate((db) => {
      const before = db.jaDialogs.length;
      db.jaDialogs = db.jaDialogs.filter((d) => d.id !== id);
      return { ok: db.jaDialogs.length < before };
    });
  }

  async reorderJaDialogs(orderedIds: string[]): Promise<void> {
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    await this.mutate((db) => {
      for (const d of db.jaDialogs) {
        const idx = rank.get(d.id);
        if (idx !== undefined) d.sortIndex = idx;
      }
    });
  }

  async updateJaDialogTitle(id: string, titleKo: string): Promise<JaDialogRecord | null> {
    return this.mutate((db) => {
      const d = db.jaDialogs.find((x) => x.id === id);
      if (!d) return null;
      d.titleKo = titleKo;
      return normalizeJaDialogRecord(d);
    });
  }

  async updateJaDialogCoaching(id: string, coaching: JaDialogCoaching): Promise<JaDialogRecord | null> {
    return this.mutate((db) => {
      const d = db.jaDialogs.find((x) => x.id === id);
      if (!d) return null;
      d.coaching = coaching;
      return normalizeJaDialogRecord(d);
    });
  }

  // ---- 대화에서 모은 단어 (J5) ----

  async getOrCreateJaCollectedVocabBook(): Promise<JaVocabBookRecord> {
    const db0 = await readDb();
    const existing = db0.jaVocabBooks.find((v) => v.kind === "collected");
    if (existing) return normalizeJaVocabBook(existing);
    return this.mutate((db) => {
      const again = db.jaVocabBooks.find((v) => v.kind === "collected");
      if (again) return normalizeJaVocabBook(again);
      const record = normalizeJaVocabBook({
        id: randomUUID(),
        titleKo: JA_COLLECTED_VOCAB_TITLE_KO,
        kind: "collected",
        entries: [],
        levels: [],
        topic: null,
        model: "",
        createdAt: new Date().toISOString(),
        sortIndex: null,
      });
      db.jaVocabBooks.push(record);
      return record;
    });
  }

  async appendJaVocabEntry(id: string, entry: JaVocabEntry): Promise<AppendJaVocabResult> {
    const incoming = normalizeJaVocabEntry(entry);
    const key = incoming.kana.trim();
    return this.mutate((db) => {
      const book = db.jaVocabBooks.find((v) => v.id === id);
      if (!book) return { record: null, appended: false };
      const existing = (book.entries ?? []).map(normalizeJaVocabEntry);
      // 중복(같은 kana) — 이미 있으면 붙이지 않는다(§7-5)
      if (key !== "" && existing.some((e) => e.kana.trim() === key)) {
        return { record: normalizeJaVocabBook({ ...book, entries: existing }), appended: false };
      }
      book.entries = [...existing, incoming];
      return { record: normalizeJaVocabBook(book), appended: true };
    });
  }

  // ---- workoutCycles — 아빠의 운동 (§19-4) ----
  // 세 변경 모두 **판정과 쓰기를 한 mutate 콜백 안에서** 한다(applyLink 관용구). 판정을 mutate 밖에서 하면 큐에 먼저
  // 들어간 요청이 쓴 뒤의 상태를 못 보고 낡은 판정(같은 Day 이중 기록 등)을 굳힌다. 판정은 lib/workout.ts의 순수 함수다.
  // prod-guard는 Firestore(실데이터)에만 건다 — 파일 백엔드는 로컬이라 안전(deleteJaVocabBook 선례).

  async listWorkoutCycles(): Promise<WorkoutCycleRecord[]> {
    const db = await readDb(); // readDb가 normalizeWorkoutCycle을 이미 태웠다
    return [...db.workoutCycles].sort(byCreatedAtDesc);
  }

  async getWorkoutCycle(id: string): Promise<WorkoutCycleRecord | null> {
    const db = await readDb();
    return db.workoutCycles.find((c) => c.id === id) ?? null;
  }

  async startWorkoutCycle(input: StartWorkoutInput): Promise<StartWorkoutResult> {
    // 새 id는 판정 밖에서 한 번 만든다 — decideStart는 순수 함수라 id도 인자로 받는다(Firestore의 재시도 결정성과 같은 규약).
    const newId = randomUUID();
    return this.mutate((db): StartWorkoutResult => {
      const r = decideStart(db.workoutCycles, input, newId);
      if (r.status === "conflict") return { status: "conflict", activeCycleId: r.activeCycleId };
      // writes = 이번에 닫은 사이클 + 새로 만든/제자리 교체한 사이클. 한 mutate = 한 번의 파일 쓰기라 함께 반영된다.
      for (const w of r.writes) upsertWorkoutCycle(db, normalizeWorkoutCycle(w));
      return { status: "ok", record: normalizeWorkoutCycle(r.record), mode: r.mode, closed: r.closed };
    });
  }

  async logWorkoutEvent(cycleId: string, input: LogWorkoutInput): Promise<WorkoutMutationResult> {
    return this.mutate((db): WorkoutMutationResult => {
      const current = db.workoutCycles.find((c) => c.id === cycleId);
      if (!current) return { status: "not_found" };
      const r = decideLog(current, input);
      if (r.status !== "ok") return { status: r.status, record: current };
      const next = normalizeWorkoutCycle(r.next);
      upsertWorkoutCycle(db, next);
      return { status: "ok", record: next };
    });
  }

  async undoWorkoutEvent(cycleId: string, input: UndoWorkoutInput): Promise<WorkoutMutationResult> {
    return this.mutate((db): WorkoutMutationResult => {
      const current = db.workoutCycles.find((c) => c.id === cycleId);
      if (!current) return { status: "not_found" };
      const r = decideUndo(current, input);
      if (r.status !== "ok") return { status: r.status, record: current };
      const next = normalizeWorkoutCycle(r.next);
      upsertWorkoutCycle(db, next);
      return { status: "ok", record: next };
    });
  }

  // ---- 아빠의 영어(토익스피킹) — toeic.md §7 ----
  // 쓰기는 전부 normalize를 한 번 더 태운다(Firestore와 같은 것을 저장). 읽기는 readDb가 이미 정규화했다.
  // prod-guard는 Firestore(실데이터)에만 건다 — 파일 백엔드는 로컬이라 안전(deleteJaVocabBook 선례).

  async createToeicSet(input: NewToeicSet): Promise<ToeicSetRecord> {
    const record = normalizeToeicSetRecord({ ...input, id: randomUUID(), createdAt: new Date().toISOString(), sortIndex: null });
    return this.mutate((db) => {
      db.toeicSets.push(record);
      return record;
    });
  }

  async getToeicSet(id: string): Promise<ToeicSetRecord | null> {
    const db = await readDb();
    return db.toeicSets.find((s) => s.id === id) ?? null;
  }

  async listToeicSets(limit?: number): Promise<ToeicSetRecord[]> {
    const db = await readDb();
    const sorted = [...db.toeicSets].sort(byCreatedAtDesc);
    return limit == null ? sorted : sorted.slice(0, limit);
  }

  async findToeicSetByPresetKey(presetKey: string): Promise<ToeicSetRecord | null> {
    const db = await readDb();
    return db.toeicSets.find((s) => s.presetKey === presetKey) ?? null;
  }

  async importToeicSets(inputs: NewToeicSet[]): Promise<ImportToeicSetsResult> {
    const base = Date.now();
    // 확인과 생성을 한 mutate 안에서 — 두 번 눌러도(큐 직렬화) 같은 presetKey가 두 번 생기지 않는다(멱등, §7-6).
    return this.mutate((db) => {
      const have = new Set(db.toeicSets.map((s) => s.presetKey).filter((k): k is string => k !== null));
      const created: ToeicSetRecord[] = [];
      const skippedKeys: string[] = [];
      inputs.forEach((input, i) => {
        const key = input.presetKey;
        if (key !== null && have.has(key)) {
          skippedKeys.push(key);
          return;
        }
        if (key !== null) have.add(key);
        // 파일 첫 세트가 가장 최신(목록 맨 위) — createdAt을 1ms씩 내린다
        const record = normalizeToeicSetRecord({ ...input, id: randomUUID(), createdAt: new Date(base - i).toISOString(), sortIndex: null });
        db.toeicSets.push(record);
        created.push(record);
      });
      return { created, skippedKeys };
    });
  }

  async deleteToeicSet(id: string): Promise<DeleteToeicResult> {
    // 세트와 그 시험 세션을 한 mutate(= 한 번의 원자적 파일 쓰기)에서 — 유령 세션이 남는 중간 상태가 없다.
    return this.mutate((db) => {
      const before = db.toeicSets.length;
      db.toeicSets = db.toeicSets.filter((s) => s.id !== id);
      const ok = db.toeicSets.length < before;
      if (ok) db.toeicQuizzes = db.toeicQuizzes.filter((q) => q.setId !== id);
      return { ok };
    });
  }

  async updateToeicSetTitle(id: string, titleKo: string): Promise<ToeicSetRecord | null> {
    return this.mutate((db) => {
      const s = db.toeicSets.find((x) => x.id === id);
      if (!s) return null;
      s.titleKo = titleKo;
      return normalizeToeicSetRecord(s);
    });
  }

  async reorderToeicSets(orderedIds: string[]): Promise<void> {
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    await this.mutate((db) => {
      for (const s of db.toeicSets) {
        const idx = rank.get(s.id);
        if (idx !== undefined) s.sortIndex = idx;
      }
    });
  }

  async mergeToeicSetPoints(
    id: string,
    items: ToeicPointsItem[],
    opts: { force: boolean },
  ): Promise<MergeToeicSetPointsResult | null> {
    // 병합은 mutate **안에서** 최신 entries에 한다 — 밖에서 합치면 큐에 먼저 들어간 다른 포인트 호출이 쓴 것을 덮는다.
    return this.mutate((db) => {
      const i = db.toeicSets.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const current = normalizeToeicSetRecord(db.toeicSets[i]);
      const merged = applyPointsResults(current.entries, items, opts);
      const record = normalizeToeicSetRecord({ ...current, entries: merged.entries });
      db.toeicSets[i] = record;
      return { record, filled: merged.filled, remaining: merged.remaining };
    });
  }

  async addToeicQuiz(input: NewToeicQuiz): Promise<ToeicQuizRecord> {
    const record: ToeicQuizRecord = { ...input, items: input.items.map(normalizeToeicQuizItem), id: randomUUID() };
    return this.mutate((db) => {
      db.toeicQuizzes.push(record);
      return record;
    });
  }

  async listToeicQuizzes(setId: string): Promise<ToeicQuizRecord[]> {
    const db = await readDb();
    return db.toeicQuizzes.filter((q) => q.setId === setId).sort(byStartedAtAsc);
  }

  async listAllToeicQuizzes(): Promise<ToeicQuizRecord[]> {
    const db = await readDb();
    return [...db.toeicQuizzes].sort(byStartedAtAsc);
  }

  async createToeicMock(input: NewToeicMock): Promise<ToeicMockRecord> {
    const record = normalizeToeicMockRecord({ ...input, id: randomUUID(), createdAt: new Date().toISOString(), sortIndex: null });
    return this.mutate((db) => {
      db.toeicMocks.push(record);
      return record;
    });
  }

  async getToeicMock(id: string): Promise<ToeicMockRecord | null> {
    const db = await readDb();
    return db.toeicMocks.find((m) => m.id === id) ?? null;
  }

  async listToeicMocks(limit?: number): Promise<ToeicMockRecord[]> {
    const db = await readDb();
    const sorted = [...db.toeicMocks].sort(byCreatedAtDesc);
    return limit == null ? sorted : sorted.slice(0, limit);
  }

  async deleteToeicMock(id: string): Promise<DeleteToeicResult> {
    return this.mutate((db) => {
      const before = db.toeicMocks.length;
      db.toeicMocks = db.toeicMocks.filter((m) => m.id !== id);
      const ok = db.toeicMocks.length < before;
      if (ok) {
        db.toeicImages = db.toeicImages.filter((im) => im.mockId !== id);
        db.toeicAttempts = db.toeicAttempts.filter((a) => a.mockId !== id);
      }
      return { ok };
    });
  }

  async updateToeicMockTitle(id: string, titleKo: string): Promise<ToeicMockRecord | null> {
    return this.mutate((db) => {
      const m = db.toeicMocks.find((x) => x.id === id);
      if (!m) return null;
      m.titleKo = titleKo;
      return normalizeToeicMockRecord(m);
    });
  }

  async reorderToeicMocks(orderedIds: string[]): Promise<void> {
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    await this.mutate((db) => {
      for (const m of db.toeicMocks) {
        const idx = rank.get(m.id);
        if (idx !== undefined) m.sortIndex = idx;
      }
    });
  }

  async fillToeicMockPart<P extends ToeicMockPart>(
    id: string,
    part: P,
    value: ToeicMockPartRecordMap[P],
  ): Promise<FillToeicMockPartResult | null> {
    // 판정·쓰기가 한 mutate — 두 요청이 같은 빈 파트를 채우려 해도 먼저 온 쪽만 쓴다(빈 자리만, lib/toeic-mock-apply).
    return this.mutate((db): FillToeicMockPartResult | null => {
      const i = db.toeicMocks.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const current = normalizeToeicMockRecord(db.toeicMocks[i]);
      if (decideFillPart(current, part) === "exists") return { outcome: "exists", record: current };
      const record = normalizeToeicMockRecord(applyFillPart(current, part, value));
      db.toeicMocks[i] = record;
      return { outcome: "filled", record };
    });
  }

  async saveToeicPictureImage(input: SaveToeicPictureImageInput): Promise<SaveToeicPictureImageResult> {
    // 사진 id·시각은 원자 단위 밖에서 한 번만 정한다(Firestore 쪽과 같은 모양). 판정이 apply일 때만 사진 문서를 넣는다.
    const image = normalizeToeicImageRecord({
      id: randomUUID(),
      mockId: input.mockId,
      slot: input.slot,
      dataUrl: input.dataUrl,
      model: input.model,
      createdAt: new Date().toISOString(),
    });
    return this.mutate((db): SaveToeicPictureImageResult => {
      const i = db.toeicMocks.findIndex((x) => x.id === input.mockId);
      if (i < 0) return { outcome: "missing", record: null };
      const current = normalizeToeicMockRecord(db.toeicMocks[i]);
      const decision = decidePictureImage(current, input.slot, input.imagePrompt);
      if (decision === "missing") return { outcome: "missing", record: current };
      if (decision !== "apply") return { outcome: decision, record: current };
      const record = normalizeToeicMockRecord(applyPictureImage(current, input.slot, { status: "ready", imageId: image.id }));
      db.toeicImages.push(image);
      db.toeicMocks[i] = record;
      return { outcome: "saved", record, image };
    });
  }

  async markToeicPictureImageFailed(mockId: string, slot: 0 | 1, imagePrompt: string): Promise<MarkToeicPictureImageFailedResult> {
    return this.mutate((db): MarkToeicPictureImageFailedResult => {
      const i = db.toeicMocks.findIndex((x) => x.id === mockId);
      if (i < 0) return { outcome: "missing", record: null };
      const current = normalizeToeicMockRecord(db.toeicMocks[i]);
      const decision = decidePictureImage(current, slot, imagePrompt);
      if (decision === "missing") return { outcome: "missing", record: current };
      if (decision !== "apply") return { outcome: decision, record: current };
      const record = normalizeToeicMockRecord(applyPictureImage(current, slot, { status: "failed", imageId: null }));
      db.toeicMocks[i] = record;
      return { outcome: "marked", record };
    });
  }

  async getToeicImage(id: string): Promise<ToeicImageRecord | null> {
    const db = await readDb();
    return db.toeicImages.find((im) => im.id === id) ?? null;
  }

  async createToeicAttempt(input: NewToeicAttempt): Promise<ToeicAttemptRecord> {
    const record = normalizeToeicAttemptRecord({ ...input, id: randomUUID() });
    return this.mutate((db) => {
      db.toeicAttempts.push(record);
      return record;
    });
  }

  async getToeicAttempt(id: string): Promise<ToeicAttemptRecord | null> {
    const db = await readDb();
    return db.toeicAttempts.find((a) => a.id === id) ?? null;
  }

  async listToeicAttemptsByMock(mockId: string): Promise<ToeicAttemptRecord[]> {
    const db = await readDb();
    return db.toeicAttempts.filter((a) => a.mockId === mockId).sort(byStartedAtAsc);
  }

  async listAllToeicAttempts(): Promise<ToeicAttemptRecord[]> {
    const db = await readDb();
    return [...db.toeicAttempts].sort(byStartedAtAsc);
  }

  async finishToeicAttempt(id: string, input: FinishToeicAttemptInput): Promise<FinishToeicAttemptResult | null> {
    // 판정과 쓰기가 한 mutate — 두 요청(연타·재시도·다른 탭)이 겹쳐도 먼저 온 끝/그만두기 하나만 남는다.
    return this.mutate((db): FinishToeicAttemptResult | null => {
      const i = db.toeicAttempts.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const current = db.toeicAttempts[i];
      if (decideAttemptFinish(current) === "already_closed") return { outcome: "already_closed", record: current };
      const next = applyAttemptFinish(current, input);
      db.toeicAttempts[i] = next;
      return { outcome: "finished", record: next };
    });
  }

  async updateToeicAttemptAnswer(id: string, q: number, patch: ToeicAnswerScorePatch): Promise<ToeicAttemptRecord | null> {
    // 읽기·그 문항만 바꾸기·쓰기가 한 mutate — 같은 응시의 두 문항을 동시에 채점해도 서로 덮지 않는다(큐 직렬화).
    return this.mutate((db) => {
      const i = db.toeicAttempts.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const next = applyAttemptAnswer(db.toeicAttempts[i], q, patch);
      db.toeicAttempts[i] = next;
      return next;
    });
  }

  // ---- talkSessions — 은우 자유대화 (english.md §12-4) ----

  async createTalkSession(input: NewTalkSession, scene: NewTalkSceneImage | null, saveId: string): Promise<CreateTalkSessionResult> {
    const createdAt = new Date().toISOString();
    // 확인과 생성을 한 mutate 안에서(큐 직렬화) — 같은 저장 키로 두 번 와도(응답 유실 뒤 다시 저장·동시 두 요청) 한 번만 생긴다.
    // 주제 일러스트(§12-6)는 대화와 같은 mutate에서 함께 생긴다 — 한쪽만 남는 고아가 없다. 그림 문서 id = 대화 id.
    return this.mutate((db): CreateTalkSessionResult => {
      const existing = db.talkSessions.find((t) => t.id === saveId);
      if (existing) {
        const current = normalizeTalkSessionRecord(existing);
        if (current.startedAt === input.startedAt) return { record: current, created: false };
      }
      // 키 충돌(같은 키에 다른 대화)이나 같은 id의 그림이 남아 있으면 새 id — 남의 문서를 덮지 않는다
      const id = existing || db.talkImages.some((img) => img.id === saveId) ? randomUUID() : saveId;
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
      if (image) db.talkImages.push(image);
      db.talkSessions.push(record);
      return { record, created: true };
    });
  }

  async getTalkSession(id: string): Promise<TalkSessionRecord | null> {
    const db = await readDb();
    const found = db.talkSessions.find((t) => t.id === id);
    return found ? normalizeTalkSessionRecord(found) : null;
  }

  async getTalkImage(id: string): Promise<TalkImageRecord | null> {
    const db = await readDb();
    const found = db.talkImages.find((t) => t.id === id);
    return found ? normalizeTalkImageRecord(found) : null;
  }

  async listTalkSessions(limit?: number): Promise<TalkSessionRecord[]> {
    const db = await readDb();
    const sorted = [...db.talkSessions].sort(byCreatedAtDesc);
    return (limit == null ? sorted : sorted.slice(0, limit)).map(normalizeTalkSessionRecord);
  }

  async listAllTalkSessions(): Promise<TalkSessionRecord[]> {
    const db = await readDb();
    return db.talkSessions.map(normalizeTalkSessionRecord).sort(byStartedAtAsc);
  }

  async deleteTalkSession(id: string): Promise<DeleteTalkSessionResult> {
    // prod-guard는 firestore(실데이터)에만 건다 — 파일 백엔드는 로컬이라 안전(deleteJaDialog 선례).
    // 딸린 주제 일러스트(sceneImageId)를 먼저, 대화를 마지막에(§12-6 연쇄) — 한 mutate라 원자적이다.
    return this.mutate((db) => {
      const target = db.talkSessions.find((t) => t.id === id);
      if (!target) return { ok: false };
      const imageId = target.sceneImageId;
      if (imageId) db.talkImages = db.talkImages.filter((img) => img.id !== imageId);
      db.talkSessions = db.talkSessions.filter((t) => t.id !== id);
      return { ok: true };
    });
  }

  async updateTalkSessionTitle(id: string, titleKo: string): Promise<TalkSessionRecord | null> {
    return this.mutate((db) => {
      const t = db.talkSessions.find((x) => x.id === id);
      if (!t) return null;
      t.titleKo = titleKo;
      return normalizeTalkSessionRecord(t);
    });
  }

  async reorderTalkSessions(orderedIds: string[]): Promise<void> {
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    await this.mutate((db) => {
      for (const t of db.talkSessions) {
        const idx = rank.get(t.id);
        if (idx !== undefined) t.sortIndex = idx;
      }
    });
  }

  async addTalkExplanation(id: string, explanation: TalkExplanation): Promise<AddTalkExplanationResult | null> {
    // 판정과 쓰기가 한 mutate — 같은 문장을 두 번 탭해도(연타·두 탭) 큐 직렬화로 먼저 저장된 설명이 이긴다.
    return this.mutate((db) => {
      const i = db.talkSessions.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const decision = decideTalkExplanation(normalizeTalkSessionRecord(db.talkSessions[i]), explanation);
      if (decision.outcome === "added") db.talkSessions[i] = decision.record;
      return decision;
    });
  }
}

/**
 * 응시 끝/그만둠 반영(순수) — 두 백엔드가 같은 규칙을 쓴다. 넘어온 q의 recorded·durationMs만 바꾸고, 그 문항의
 * 채점 결과(transcript·feedback·score)는 보존한다. answers에 없는 q는 덧붙인다(q 오름차순 유지).
 */
export function applyAttemptFinish(current: ToeicAttemptRecord, input: FinishToeicAttemptInput): ToeicAttemptRecord {
  const byQ = new Map(current.answers.map((a) => [a.q, a] as const));
  for (const f of input.answers) {
    const prev = byQ.get(f.q) ?? normalizeToeicAnswer({ q: f.q });
    byQ.set(f.q, { ...prev, recorded: f.recorded, durationMs: f.durationMs });
  }
  return normalizeToeicAttemptRecord({
    ...current,
    finishedAt: input.finishedAt,
    answers: [...byQ.values()].sort((a, b) => a.q - b.q),
  });
}

/** 문항 하나의 채점 결과 반영(순수) — 그 q만 바꾼다(없으면 덧붙인다). recorded·durationMs는 보존한다. */
export function applyAttemptAnswer(current: ToeicAttemptRecord, q: number, patch: ToeicAnswerScorePatch): ToeicAttemptRecord {
  const has = current.answers.some((a) => a.q === q);
  const base = has ? current.answers : [...current.answers, normalizeToeicAnswer({ q })];
  const answers = base.map((a) => (a.q === q ? normalizeToeicAnswer({ ...a, ...patch, q }) : a)).sort((a, b) => a.q - b.q);
  return normalizeToeicAttemptRecord({ ...current, answers });
}

// ---------------------------------------------------------------------------
// 백엔드 선택 + 싱글턴 접근자 (M3)
// ---------------------------------------------------------------------------

export type StoreBackend = "firestore" | "file";

/** 파일 상단 주석의 선택 규칙 — env 명시 > 자격증명 자동 감지 > file */
function resolveStoreBackend(): StoreBackend {
  const env = process.env.STORE_BACKEND;
  if (env === "firestore" || env === "file") return env;
  if (env) {
    console.warn(
      `[store] STORE_BACKEND="${env}"는 알 수 없는 값이에요 (firestore|file) — 자동 감지로 진행합니다.`,
    );
  }
  const hasGcpCredentials = Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || // 로컬: 서비스 계정 키 파일 경로
      process.env.K_SERVICE || // Cloud Run이 주입 — 서비스 계정 ADC 사용 가능
      process.env.GOOGLE_CLOUD_PROJECT, // 그 외 GCP 환경 일반 신호
  );
  return hasGcpCredentials ? "firestore" : "file";
}

declare global {
  // dev(HMR)에서 모듈 재평가로 인스턴스가 늘어나는 것을 막기 위한 전역 캐시
  var __bookcardStore: StudyStore | undefined;
}

export function getStore(): StudyStore {
  if (!globalThis.__bookcardStore) {
    const backend = resolveStoreBackend();
    globalThis.__bookcardStore = backend === "firestore" ? new FirestoreStore() : new JsonFileStore();
    console.log(
      `[store] backend=${backend} (${process.env.STORE_BACKEND ? "STORE_BACKEND 명시" : "자동 감지"})`,
    );
    // 개발 환경인데 Firestore를 잡았다 = 로컬 실행이 **프로덕션 실데이터**를 향한다.
    // 2026-08-17에 이 상태로 삭제 기능을 테스트하다 가족 데이터가 전부 지워졌다.
    // 삭제는 lib/prod-guard.ts가 막지만, 읽기·쓰기는 그대로 통하므로 눈에 띄게 알린다.
    if (backend === "firestore" && process.env.NODE_ENV !== "production") {
      console.warn(
        "[store] ⚠️  개발 환경인데 **프로덕션 Firestore**에 연결했어요.\n" +
          "         여기서 만든 카드·읽음 기록은 실제 가족 데이터에 그대로 남습니다.\n" +
          "         삭제는 prod-guard가 막습니다(ALLOW_PROD_DESTRUCTIVE=1로만 해제).\n" +
          "         로컬 테스트라면 STORE_BACKEND=file 로 돌리세요.",
      );
    }
  }
  return globalThis.__bookcardStore;
}

/**
 * 시드 전용 — db.json 전체를 주어진 데이터로 교체한다 (scripts/seed.ts에서만 사용).
 * JSON 파일 구현에 종속적인 유틸이므로 BookCardStore 인터페이스에는 넣지 않는다.
 */
export async function mergeDbForSeed(seed: DbShape): Promise<void> {
  // 시드는 기존 데이터를 절대 지우지 않는다 — 같은 id만 덮어쓰는 머지(upsert).
  // (전체 덮어쓰기였을 때 검증 중 seed 실행이 실사용 카드를 지운 사고가 있었다)
  const cur = await readDb();
  const mergeById = <T extends { id: string }>(base: T[], add: T[]): T[] => {
    const map = new Map(base.map((r) => [r.id, r] as const));
    for (const r of add) map.set(r.id, r);
    return [...map.values()];
  };
  await writeDb({
    books: mergeById(cur.books, seed.books),
    cards: mergeById(cur.cards, seed.cards),
    readings: mergeById(cur.readings, seed.readings),
    explanations: mergeById(cur.explanations, seed.explanations),
    vocabBooks: mergeById(cur.vocabBooks, seed.vocabBooks),
    vocabQuizzes: mergeById(cur.vocabQuizzes, seed.vocabQuizzes),
    jaVocabBooks: mergeById(cur.jaVocabBooks, seed.jaVocabBooks),
    jaQuizzes: mergeById(cur.jaQuizzes, seed.jaQuizzes),
    jaKanji: mergeById(cur.jaKanji, seed.jaKanji),
    jaKanjiQuizzes: mergeById(cur.jaKanjiQuizzes, seed.jaKanjiQuizzes),
    jaDialogs: mergeById(cur.jaDialogs, seed.jaDialogs),
    // ⚠️ 반드시 mergeById — `seed.workoutCycles`를 그대로 넣으면 `npm run seed` 한 번에 운동 기록이 통째로 날아간다(§19-4).
    workoutCycles: mergeById(cur.workoutCycles, seed.workoutCycles),
    // 아빠의 영어 5개 — 같은 이유로 반드시 mergeById(시드가 가족 학습 기록을 지우지 않게).
    toeicSets: mergeById(cur.toeicSets, seed.toeicSets),
    toeicQuizzes: mergeById(cur.toeicQuizzes, seed.toeicQuizzes),
    toeicMocks: mergeById(cur.toeicMocks, seed.toeicMocks),
    toeicImages: mergeById(cur.toeicImages, seed.toeicImages),
    toeicAttempts: mergeById(cur.toeicAttempts, seed.toeicAttempts),
    // 은우 자유대화 — 같은 이유로 반드시 mergeById(시드가 아이의 대화 기록을 지우지 않게).
    talkSessions: mergeById(cur.talkSessions, seed.talkSessions),
    talkImages: mergeById(cur.talkImages, seed.talkImages),
  });
}
