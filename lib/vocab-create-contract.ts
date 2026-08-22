/**
 * lib/vocab-create-contract.ts — `POST /api/english/vocab`(단어장 저장)의 요청·응답 계약 (V1)
 *
 * 한 곳에 모아 둔 이유: 라우트가 받는 shape과 검토 화면이 보내는 shape이 서로 다른 파일에
 * 따로 적히면 반드시 어긋난다. qa-inspector가 경계면을 교차 검증할 때 볼 단일 정의처다.
 *
 * **길이·개수 상한(`VOCAB_LIMITS`)이 여기 사는 이유**(math-explain-contract와 같은 규약): 상한은
 * 타입만큼이나 계약의 일부다. 라우트 zod에만 적어 두면 검토 화면은 무엇이 거절될지 모른 채
 * 보내고, 사용자는 이유 없는 400만 본다. 화면은 이 값으로 편집창 `maxLength`·`CharCount`를 걸고,
 * 라우트는 같은 값으로 zod 상한을 짓는다.
 *
 * **단어별 필드 상한의 진짜 정의처는 `lib/ai/english/vocabbook-schemas.ts`다**(판독 zod가 쓴다).
 * 여기서 숫자를 다시 적지 않고 그 상수를 **끌어와 묶는다** — 두 곳에 흩어지면 어긋난다
 * (SIGHT_WORDS를 한 곳에만 둔 것과 같은 이유). 그 모듈은 zod만 의존하고 openai·API 키를
 * 건드리지 않으므로, 이 파일을 클라이언트에서 import해도 SDK가 번들에 새지 않는다.
 *
 * 참조: `docs/harness/english.md` §7-4(길이 상한) · 계획 "데이터 모델"
 */

import {
  VOCAB_DAY_LABEL_MAX,
  VOCAB_DEFINITION_EN_MAX,
  VOCAB_EXAMPLE_EN_MAX,
  VOCAB_EXAMPLE_KO_MAX,
  VOCAB_EXAMPLES_MAX,
  VOCAB_IPA_MAX,
  VOCAB_MEANING_KO_MAX,
  VOCAB_MEANINGS_MAX,
  VOCAB_NO_MAX,
  VOCAB_POS_MAX,
  VOCAB_RELATED_GLOSS_MAX,
  VOCAB_RELATED_MAX,
  VOCAB_RELATED_WORD_MAX,
  VOCAB_WORD_MAX,
  type VocabEntry,
} from "./ai/english/vocabbook-schemas";

/**
 * 단어장 저장·편집 상한의 단일 정의처. 단어별 필드 상한은 판독 zod(vocabbook-schemas)와
 * **같은 상수**를 끌어와 묶고, 책(DAY 레코드) 단위 상한만 여기서 새로 정한다.
 */
export const VOCAB_LIMITS = {
  // ── 단어별 필드 (vocabbook-schemas가 진짜 정의처 — 여기선 묶기만 한다) ──
  word: VOCAB_WORD_MAX,
  ipa: VOCAB_IPA_MAX,
  no: VOCAB_NO_MAX,
  meaningKo: VOCAB_MEANING_KO_MAX,
  exampleEn: VOCAB_EXAMPLE_EN_MAX,
  exampleKo: VOCAB_EXAMPLE_KO_MAX,
  relatedWord: VOCAB_RELATED_WORD_MAX,
  relatedGloss: VOCAB_RELATED_GLOSS_MAX,
  definitionEn: VOCAB_DEFINITION_EN_MAX,
  dayLabel: VOCAB_DAY_LABEL_MAX,
  // 한 항목의 배열 상한
  pos: VOCAB_POS_MAX,
  meanings: VOCAB_MEANINGS_MAX,
  examples: VOCAB_EXAMPLES_MAX,
  related: VOCAB_RELATED_MAX,

  // ── 책(DAY 레코드) 단위 — 여기서 새로 정한다 ──
  /** 목록·표에 뜨는 이름의 최대 길이 */
  titleKo: 120,
  /** 한 DAY(레코드)에 담을 단어 수 상한 — 여러 사진(최대 photos장)을 합쳐도 넘지 않는다 */
  entriesPerBook: 400,
  /** 한 번에 올려 판독할 사진 수 상한 — DAY 하나가 보통 2~4장, 겹쳐 찍기까지 넉넉히 */
  photos: 8,
} as const;

/**
 * 저장 요청 본문 — 검토 화면이 병합·편집을 끝낸 `VocabEntry[]`를 그대로 보낸다.
 *
 * **사진은 보내지 않는다**(§7-6 · SPEC §5). 병합된 텍스트만 남긴다. `titleKo`가 비면
 * 라우트가 `dayLabel`이나 기본 이름으로 채운다(§5 스펙 공백 — 페이지 사진에 책 제목이 없을 수 있다).
 */
export interface VocabCreateRequest {
  /** 목록에 뜰 이름. 비면 dayLabel/기본값으로 채워진다 */
  titleKo?: string | null;
  /** 판독된 단원 표기. 없으면 null */
  dayLabel?: string | null;
  /** 판독에 쓴 사진 수(사진 자체는 보내지 않는다) */
  photoCount?: number | null;
  /** 저장할 단어 목록 (병합·편집·"빼기" 반영 후) */
  entries: VocabEntry[];
}

/** 200 성공 — 저장된 레코드의 id로 `/english/vocab/[id]`를 연다 */
export interface VocabCreateSuccess {
  ok: true;
  id: string;
}

/** 오류 코드 */
export type VocabCreateErrorCode =
  | "invalid_input" // 400 — zod 검증 실패
  | "save_failed"; // 500 — 스토어 저장 실패

export interface VocabCreateFailure {
  ok: false;
  error: VocabCreateErrorCode;
  messageKo: string;
  /** invalid_input일 때만 */
  issues?: { path: string; message: string }[];
}

export type VocabCreateResponse = VocabCreateSuccess | VocabCreateFailure;
