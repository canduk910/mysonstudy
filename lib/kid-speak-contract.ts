/**
 * lib/kid-speak-contract.ts — 은우 "그림 보고 말하기" 전사 라우트 계약 (2026-10-03, SPEC §15-5, docs/harness/english.md §14)
 *
 * `POST /api/english/vocab/speak-transcribe` — multipart `audio` 하나 → 영어 글자. 녹음·전사문 모두 저장하지 않는다.
 * 판정은 화면이 순수 함수(lib/kid-speak.ts `judgeKidSpeech`)로 한다 — 라우트는 정답을 받지도 보지도 않는다
 * (정답을 전사에 넘기면 전사가 그쪽으로 끌려간다 — 관문 T §5-0과 같은 무유도 원칙. 라우트가 정답을 모르면 넘길 수도 없다).
 *
 * 값 export는 숫자·문자열 상수뿐이다(런타임 import 0) — 화면이 그대로 import한다.
 */

export const KID_SPEAK_TRANSCRIBE_ENDPOINT = "/api/english/vocab/speak-transcribe";
/** multipart 필드 이름 */
export const KID_SPEAK_AUDIO_FIELD = "audio";
/** 녹음 길이 상한(ms) — 단어 하나라 짧다. 넘으면 화면이 스스로 끝낸다 */
export const KID_SPEAK_REC_MAX_MS = 6_000;
/** 이보다 짧은 녹음은 올리지 않는다(실수로 두 번 누른 것 — 전사 비용 0) */
export const KID_SPEAK_REC_MIN_MS = 300;
/**
 * 무음 판정 문턱(lib/mic-session level() 0..1 — -60dB → 0, 0dB → 1). 녹음 내내 최고 레벨이 이보다 낮으면 올리지 않고 "소리가 안 들렸어요"
 * (무음 전사는 엉뚱한 낱말을 지어낼 수 있다 — 비용도 0으로). 표현 도우미(0.2)보다 조금 낮다 — 아이 목소리는 작고 단어 하나는 짧다.
 */
export const KID_SPEAK_SILENCE_LEVEL = 0.15;
/** 업로드 크기 상한(바이트) — 6초 16kHz mono 16-bit WAV ≈ 192,044바이트. 정규화에 실패해 원본(mp4·webm)을 올려도 이보다 작다 */
export const KID_SPEAK_AUDIO_MAX_BYTES = 262_144; // 256 KiB
/** multipart 껍데기 여유 — content-length 선검사에만 쓴다 */
export const KID_SPEAK_AUDIO_MULTIPART_SLACK_BYTES = 16_384;
/** 서버 전사 한 번의 시간 상한(ms) — 아이가 기다리는 호출 */
export const KID_SPEAK_TRANSCRIBE_TIMEOUT_MS = 12_000;
/** 전사를 기다리는 화면 상한(ms) — 서버 상한 + 업로드 여유 */
export const KID_SPEAK_TRANSCRIBE_CLIENT_TIMEOUT_MS = 18_000;

/**
 * 응답(상태코드별):
 * - 200 `{ ok:true, text }` — 앞뒤 공백만 걷은 영어 글(빈 글이면 화면이 "잘 안 들렸어요" — 도움 단계는 오르지 않는다)
 * - 400 `{ ok:false, error:"invalid_input", messageKo }` — multipart 아님·audio 없음·받지 않는 형식·빈 파일
 * - 413 `{ ok:false, error:"audio_too_large", messageKo }`
 * - 499 `{ ok:false, error:"client_closed", messageKo }`
 * - 500 `{ ok:false, error:"transcribe_failed", messageKo, retriable:true }`
 * - 501 `{ ok:false, error:"no_api_key", messageKo }` — 본문을 읽기 전에(화면은 "스스로 확인"으로 바꾼다)
 */
export type KidSpeakTranscribeResponse =
  | { ok: true; text: string }
  | { ok: false; error: "invalid_input" | "audio_too_large" | "client_closed" | "no_api_key"; messageKo: string }
  | { ok: false; error: "transcribe_failed"; messageKo: string; retriable: true };
