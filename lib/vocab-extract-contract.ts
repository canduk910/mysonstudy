/**
 * lib/vocab-extract-contract.ts — `POST /api/english/vocab/extract`의 요청·응답 타입 (V1, 호출 C)
 *
 * **타입만 있는 모듈이다.** 값 export가 하나도 없으므로 라우트(서버)와 판독 흐름 화면
 * (클라이언트)이 같은 정의를 보면서도 클라이언트 번들에는 아무것도 들어가지 않는다.
 * `lib/math-extract-contract.ts`가 수학 호출 A에 대해 서는 자리와 같은 자리다 — 라우트가
 * 내려주는 shape과 화면이 기대하는 shape이 서로 다른 파일에 따로 적히면 반드시 어긋난다.
 *
 * 참조: `docs/harness/english.md` §7(호출 C) · §7-5(병합) · §7-6(후처리·retake)
 */

import type {
  VocabEntry,
  VocabExtractEntry,
  VocabExtraction,
} from "./ai/english/vocabbook-schemas";

/**
 * 판독·병합 결과 타입은 `lib/ai/english/vocabbook-schemas.ts`가 단일 정의처다.
 * 여기서 **다시 선언하지 않고 통로만 낸다** — 화면이 `lib/ai/*`를 직접 가리키지 않게 하되
 * 정의가 두 벌이 되는 것은 막는다. (`import type`이라 번들에는 남지 않는다.)
 */
export type { VocabEntry, VocabExtractEntry, VocabExtraction };

/**
 * 요청 본문 — 사진 **여러 장**(base64 data URL 배열)을 받는다 (§7-2 · §7-5).
 *
 * 수학 호출 A(1장)와 다른 이유: 단어장은 사진 간 겹침을 번호로 접어야 해서 "사진 1장 =
 * 판독 1회"가 병합의 전제다. 라우트가 각 장을 **병렬로** 따로 호출하고(호출 A′ 관용구),
 * 결과를 `mergeVocabPages`로 번호 병합해 DAY 하나로 만든다.
 *
 * 사진은 이 요청의 메모리에서만 쓰고 **어디에도 저장하지 않는다**(영어 `/api/extract`와 같은 규약).
 * 상한(장수·한 장 길이)은 `lib/vocab-create-contract.ts`의 `VOCAB_LIMITS`와 `lib/upload-limits.ts`가
 * 단일 정의처다 — 여기에 숫자를 적지 않는다.
 */
export interface VocabExtractRequest {
  /** `data:image/jpeg;base64,…` 형식. 클라이언트가 긴 변 `MAX_IMAGE_EDGE`로 리사이즈해 보낸다 */
  images: string[];
}

/**
 * 사진 1장의 판독 성패 — 부분 실패(한 장만 흐려 실패)를 화면이 알릴 수 있게 함께 내려준다.
 * `digestPages`의 `PageDigestBatchOutcome`과 같은 성격이다(배치별 성패).
 */
export interface VocabPageOutcome {
  /** 요청 배열에서의 사진 인덱스 (0부터) */
  photoIndex: number;
  /** 판독이 성공했는지 (실패 = callWithSchema throw) */
  ok: boolean;
  /** 성공했을 때, 그 사진이 단어장 페이지로 판정됐는지 */
  isVocabPage: boolean;
  /** 성공했을 때, 그 사진에서 읽은 항목 수 */
  entryCount: number;
  /** 실패했을 때의 짧은 사유(로깅용). 성공이면 null */
  errorMessage: string | null;
}

/** 200 성공 — 병합 결과에 단어가 하나 이상 있다 */
export interface VocabExtractSuccess {
  ok: true;
  /** 번호 오름차순으로 병합·정렬된 단어 목록 (mergeVocabPages 결과) */
  entries: VocabEntry[];
  /** DAY 대표 단원 표기 — 판독된 dayLabel 중 처음 발견된 non-null(사진마다 다를 수 있어 대표를 고른다) */
  dayLabel: string | null;
  /** 겹쳐 찍기로 접힌 항목 수 (입력 − 출력) */
  mergedCount: number;
  /** 번호 수열의 구멍 — 사진 한 장 통째 누락 신호 (§7-6) */
  missingNos: string[];
  /** 요청한 사진 수 */
  photoCount: number;
  /** 판독에 실패한 사진 수 (0보다 크면 부분 실패를 알린다) */
  failedPhotoCount: number;
  /** 사진별 판독 성패 */
  pages: VocabPageOutcome[];
}

/**
 * 200 폴백 — **오류가 아니다.** 모든 사진이 단어장이 아니거나 한 단어도 못 읽었을 때 (§7-6).
 *
 * 표지 판독 `isBookCover=false`·수학 `isWorksheet=false`와 같은 갈래다. 화면은 이 신호를 받아
 * "단어장 페이지를 다시 찍어주세요"를 띄우고 사진을 다시 고르게 한다.
 */
export interface VocabExtractRetake {
  ok: false;
  reason: "retake";
  messageKo: string;
}

/** 오류 코드. `locked`·`not_configured`는 상위 PIN 게이트가 내려보낸다 */
export type VocabExtractErrorCode =
  | "invalid_input" // 400 — zod 검증 실패(형식·길이·장수)
  | "no_api_key" // 501 — OPENAI_API_KEY 미설정
  | "ai_failed"; // 500 — 모든 사진이 재요청까지 쓰고 실패(throw). 화면은 '다시 읽기' 버튼을 띄운다

export interface VocabExtractFailure {
  ok: false;
  error: VocabExtractErrorCode;
  messageKo: string;
  /** invalid_input일 때만 */
  issues?: { path: string; message: string }[];
  /** true면 같은 사진으로 다시 눌러 볼 만하다 */
  retriable?: boolean;
}

/**
 * 화면이 세 갈래를 구분하는 법:
 *   `data.ok === true`            → 단어 목록 검토 화면
 *   `"reason" in data`            → 다시 찍기 안내 (정상 흐름)
 *   그 밖(`"error" in data`)      → 오류 배너
 */
export type VocabExtractResponse =
  | VocabExtractSuccess
  | VocabExtractRetake
  | VocabExtractFailure;
