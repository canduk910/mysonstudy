/**
 * lib/store.ts — 저장 계층 (books / cards / readings / explanations)
 *
 * [M4] 수학 설명 기록(`explanations`)이 더해졌다 — 영어 3종과 같은 백엔드,
 * 같은 인터페이스 뒤에 산다(docs/harness/math.md §9-2).
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
// enriched 재계산의 단일 정의처(V8). 순수 함수라(타입만 import) 값으로 끌어와도 저장 계층이
// openai/client에 묶이지 않는다 — appendVocabEntry가 새 단어를 붙일 때 enriched를 다시 굳힌다.
import { isVocabBookEnriched } from "./ai/english/vocabbook-enrich";
// 시험(V4) 모드 유니온 — 순수 모듈이라 값 import여도 저장 계층이 AI에 묶이지 않는다(타입만 쓴다).
import type { VocabQuizMode } from "./vocab-quiz";
// "모은 단어" 수집 단어장의 안정 마커(dayLabel)·초기 이름. 타입 없는 상수 모듈이라 값으로 끌어와도
// 저장 계층이 AI에 묶이지 않는다(M2 챕터 리더 더블탭 담기).
import { COLLECTED_VOCAB_DAY_LABEL, COLLECTED_VOCAB_TITLE_KO } from "./collected-vocab-contract";
import type { SceneTier } from "./scene/types";
import { FirestoreStore } from "./store-firestore";

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
}

/** 단어장 삭제 결과 — `{ ok }` 하나면 충분하다(연쇄로 지운 퀴즈 수는 안내에 쓰지 않는다) */
export interface DeleteVocabBookResult {
  ok: boolean;
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

// sortIndex도 제외한다 — id·createdAt처럼 **스토어가 매기는 값**이다. 신규 책은 항상
// sortIndex=null로 태어나(맨 위), 이후 reorderBooks로만 값이 박힌다. 생성부는 넘기지 않는다.
export type NewBook = Omit<BookRecord, "id" | "createdAt" | "sortIndex">;
export type NewCard = Omit<CardRecord, "id" | "createdAt">;
export type NewReading = Omit<ReadingRecord, "id">;
export type NewExplanation = Omit<ExplanationRecord, "id" | "createdAt">;
export type NewVocabBook = Omit<VocabBookRecord, "id" | "createdAt">;
/** 시험 세션 저장 입력 — id는 스토어가 매긴다. startedAt/finishedAt은 클라이언트가 정한 값 그대로 */
export type NewVocabQuiz = Omit<VocabQuizRecord, "id">;

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
   * 단어장의 **화면 이름(titleKo)만** 바꾼다 (상세 헤더 인라인 편집). **삭제가 아니라 수정**이라
   * prod-guard를 걸지 않는다(updateVocabBookEnrichment와 같은 규약). entries·enriched·dayLabel·판독
   * 결과는 손대지 않는다 — 오직 titleKo 한 필드만 갈아끼운다. 읽기 경로(normalizeVocabEntry)는
   * 그대로 유지해 반환 레코드의 entries가 getVocabBook과 같은 모양이 되게 한다.
   * 갱신된 레코드를 돌려준다. 없는 id면 null — 404 판단은 호출측 라우트의 몫.
   */
  updateVocabBookTitle(id: string, titleKo: string): Promise<VocabBookRecord | null>;
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
}

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "db.json");

function emptyDb(): DbShape {
  return { books: [], cards: [], readings: [], explanations: [], vocabBooks: [], vocabQuizzes: [] };
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
      // M4 이전에 만들어진 db.json에는 이 키가 없다 — 마이그레이션 없이 그대로 열린다
      explanations: parsed.explanations ?? [],
      // V1 이전 db.json에는 이 키가 없다 — 같은 하위호환(없으면 빈 배열)
      vocabBooks: parsed.vocabBooks ?? [],
      // V4 이전 db.json에는 이 키가 없다 — 같은 하위호환(없으면 빈 배열)
      vocabQuizzes: parsed.vocabQuizzes ?? [],
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

/** 관련어 하나를 방어 정규화 — undefined를 null(또는 빈 문자열)로 조인다. */
function normalizeVocabRelated(r: unknown): VocabRelated {
  const o = (r ?? {}) as Partial<VocabRelated>;
  return {
    kind: o.kind as VocabRelated["kind"],
    word: String(o.word ?? ""),
    glossKo: o.glossKo ?? null,
  };
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
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.mutate((db) => {
      db.explanations.push(record);
      return record;
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
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.mutate((db) => {
      db.vocabBooks.push(record);
      return record;
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
  });
}
