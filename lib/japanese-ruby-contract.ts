/**
 * lib/japanese-ruby-contract.ts — 후리가나 토큰 타입 재수출 (아빠의 일본어, 스펙 §5)
 *
 * **타입만 있는 모듈이다**(값 export 0). 후리가나 렌더 헬퍼(`components/ja-ruby.tsx`, 클라이언트에서도 쓰인다)가
 * `lib/ai/japanese/schemas.ts`의 `JaToken` 정의를 **타입 전용 경로**로 보게 하는 통로다.
 *
 * ── J1에서 옮겼다 ─────────────────────────────────────────────────────────────
 * J0 시점엔 여기에 `JaToken`을 임시로 정의해 뒀다. J1에서 호출 A 스키마를 만들며 정의를
 * `lib/ai/japanese/schemas.ts`로 옮기고, 여기서는 **타입 전용 재수출**만 한다. `export type { … } from …`은
 * 컴파일 시 완전히 지워지므로(`isolatedModules`), `ja-ruby.tsx`(클라이언트)가 이 파일을 import해도
 * `lib/ai/*`의 값(zod 등)이 클라이언트 번들에 새지 않는다 — 경계 규약 유지.
 *
 * ── 규약 (§5) ────────────────────────────────────────────────────────────────
 * - 문자열 안에 루비를 끼워 넣지 않는다(`漢字(かんじ)` 금지). 토큰 배열로 받는다.
 * - `surface`를 순서대로 이어 붙이면 원문과 정확히 같다(AI 쪽 zod가 강제, §2-4).
 * - `reading`은 그 토큰이 한자를 포함할 때만 히라가나로 채운다. 가나·숫자·기호는 `null`.
 * - TTS는 `surface` 원문을 읽는다(`ja-JP`). 루비(reading)를 읽히지 않는다.
 */

export type { JaToken } from "@/lib/ai/japanese/schemas";
