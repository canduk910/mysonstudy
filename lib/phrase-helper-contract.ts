/**
 * lib/phrase-helper-contract.ts — 표현 도우미 라우트 ↔ 화면 경계 (SPEC §22-2, docs/harness/phrase-helper.md §8·§13)
 *
 * 라우트 두 개의 요청·응답 모양과, 라우트 검사·화면 검사가 **같이 import하는** 상한의 단일 정의처다.
 * - `POST /api/phrase-helper` — `{ mode, input }` → 표현 도우미 결과(호출 하나 — `explainPhrase`)
 * - `POST /api/phrase-helper/transcribe` — multipart `audio` 하나 → 한국어 글자(마이크 모드). 녹음·전사문 모두 저장하지 않는다.
 *
 * ⚠️ 클라이언트가 값으로 import한다 — 런타임 import는 0이고 `./phrase-helper`(클라이언트 안전 순수 모듈)에서 **타입만** 가져온다.
 * `lib/ai/*`·openai·store를 끌어오지 않는다.
 */

import type { PhraseHelperMode, PhraseHelperResult } from "./phrase-helper";

// ---------------------------------------------------------------------------
// 물어보기 — POST /api/phrase-helper
// ---------------------------------------------------------------------------

export const PHRASE_HELPER_ENDPOINT = "/api/phrase-helper";

/**
 * 요청 본문 바이트 상한(UTF-8). 입력 상한 200자(코드 포인트, 한 글자 최대 4바이트 = 800바이트) + JSON 껍데기에 넉넉한 값.
 * 넘으면 본문을 해석하지 않고 413 — 도우미에 큰 글을 붙여 넣어 서버 메모리·로그를 쓰게 하지 않는다.
 */
export const PHRASE_HELPER_BODY_MAX_BYTES = 4096;

export interface PhraseHelperRequest {
  mode: PhraseHelperMode;
  /** 사용자가 넣은 글 그대로(라우트·진입 함수가 normalizePhraseHelperInput으로 정리한다) */
  input: string;
}

/**
 * 응답(상태코드별):
 * - 200 `{ ok:true, result }` — status가 not_korean·out_of_scope여도 200(정상 흐름, 화면은 noteKo 안내)
 * - 400 `{ ok:false, error:"invalid_input", messageKo }` — JSON 아님·모드 아님·입력 거부(빈 글·200자 초과)
 * - 413 `{ ok:false, error:"body_too_large", messageKo }`
 * - 499 `{ ok:false, error:"client_closed", messageKo }` — 화면이 먼저 끊었다(패널 닫힘·다시 묻기·시험 시작)
 * - 500 `{ ok:false, error:"ai_failed", messageKo, retriable:true }` — 재요청 실패·30초 초과·상류 오류
 * - 501 `{ ok:false, error:"no_api_key", messageKo }` — 키 없음(맨 먼저 검사)
 * - (PIN 게이트 proxy) 401 locked · 503 not_configured
 */
export type PhraseHelperResponse =
  | { ok: true; result: PhraseHelperResult }
  | { ok: false; error: "invalid_input" | "body_too_large" | "client_closed" | "no_api_key"; messageKo: string }
  | { ok: false; error: "ai_failed"; messageKo: string; retriable: true };

/**
 * 화면이 기다리는 상한(ms) — 서버 상한 30초(PHRASE_HELPER_TIMEOUT_MS) + zod 재요청이 그 안에 든다. 여유 5초를 둔다.
 * 넘으면 화면이 요청을 끊고(서버는 499) "다시 물어보기"를 보인다.
 */
export const PHRASE_HELPER_CLIENT_TIMEOUT_MS = 35_000;

// ---------------------------------------------------------------------------
// 마이크 모드 — POST /api/phrase-helper/transcribe
// ---------------------------------------------------------------------------

export const PHRASE_HELPER_TRANSCRIBE_ENDPOINT = "/api/phrase-helper/transcribe";
/** multipart 필드 이름 */
export const PHRASE_HELPER_AUDIO_FIELD = "audio";
/** 녹음 길이 상한(ms) — 넘으면 화면이 스스로 끝낸다 */
export const PHRASE_HELPER_REC_MAX_MS = 30_000;
/** 이보다 짧은 녹음은 올리지 않는다(실수로 두 번 누른 것 — 전사 비용 0) */
export const PHRASE_HELPER_REC_MIN_MS = 400;
/**
 * 무음 판정 문턱(lib/mic-session level() 0..1 — -60dB → 0, 0dB → 1). 녹음 내내 최고 레벨이 이 값보다 낮으면 올리지 않고
 * "소리가 안 들렸어요"(무음 전사는 엉뚱한 한국어 문장을 지어낼 수 있다 — 비용도 0으로). 0.2 ≈ -48dB(방 소음 수준).
 */
export const PHRASE_HELPER_SILENCE_LEVEL = 0.2;
/**
 * 업로드 크기 상한(바이트) — 30초 16kHz mono 16-bit WAV ≈ 960,044바이트. 정규화에 실패해 원본(mp4·webm)을 올려도 이보다 작다.
 */
export const PHRASE_HELPER_AUDIO_MAX_BYTES = 1_310_720; // 1.25 MiB
/** multipart 껍데기 여유 — content-length 선검사에만 쓴다 */
export const PHRASE_HELPER_AUDIO_MULTIPART_SLACK_BYTES = 16_384;
/** 전사를 기다리는 화면 상한(ms) — 서버 전사 상한 20초 + 업로드 여유 */
export const PHRASE_HELPER_TRANSCRIBE_CLIENT_TIMEOUT_MS = 30_000;

/**
 * 응답(상태코드별):
 * - 200 `{ ok:true, text }` — 앞뒤 공백만 걷은 한국어 글. 빈 글이면 화면이 "잘 안 들렸어요"(입력 칸은 그대로)
 * - 400 `{ ok:false, error:"invalid_input", messageKo }` — multipart 아님·audio 없음·받지 않는 형식·빈 파일
 * - 413 `{ ok:false, error:"audio_too_large", messageKo }`
 * - 499 `{ ok:false, error:"client_closed", messageKo }`
 * - 500 `{ ok:false, error:"transcribe_failed", messageKo, retriable:true }`
 * - 501 `{ ok:false, error:"no_api_key", messageKo }` — 본문을 읽기 전에
 */
export type PhraseHelperTranscribeResponse =
  | { ok: true; text: string }
  | { ok: false; error: "invalid_input" | "audio_too_large" | "client_closed" | "no_api_key"; messageKo: string }
  | { ok: false; error: "transcribe_failed"; messageKo: string; retriable: true };
