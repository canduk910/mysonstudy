/**
 * lib/auth.ts — PIN 잠금 (가족용 최소 접근 제어)
 *
 * 로그인은 두지 않는다(SPEC §1 "로그인 없음"). 커스텀 도메인 공개 후 URL을 아는
 * 외부인이 들어와 AI 호출 비용을 쓰는 것만 막는 최소 장치다.
 *
 * 동작:
 * - 서버 전용 env `APP_PIN`(4~8자리 숫자)과 일치하면 서명 쿠키(`eb_unlock`)를 발급한다.
 * - 쿠키 값은 `<exp>.<sig>`, sig = HMAC-SHA256(key=APP_PIN, msg=`unlock:<exp>`)의 hex.
 *   PIN이 곧 서명 키이므로 **PIN을 바꾸면 기존 쿠키는 서명 불일치로 자동 무효화**된다
 *   (별도의 폐기 절차·저장소가 필요 없다 — 가족용 규모에 맞는 단순함).
 * - 검증은 만료 확인 + 서명 재계산 후 상수시간 비교.
 *
 * 런타임 제약: 이 모듈은 proxy(구 middleware)에서도 import된다. Next 16의 proxy는
 * Node.js 런타임이 기본이지만, Edge로 옮겨도 그대로 동작하도록 **node:crypto를 쓰지
 * 않고 Web Crypto(crypto.subtle)만** 사용한다.
 *
 * 서버 전용 모듈이다(process.env.APP_PIN을 읽는다) — 클라이언트 컴포넌트에서
 * 값 import 금지. `sanitizeNextPath`처럼 순수 함수도 서버(페이지 컴포넌트)에서
 * 호출해 결과만 클라이언트로 내려보낼 것.
 */

/** 쿠키 이름 — 값에는 PIN이 들어가지 않는다(서명만) */
export const UNLOCK_COOKIE = "eb_unlock";

/** 쿠키 수명 180일 — 가족 기기에서 매번 PIN을 묻지 않도록 넉넉하게 */
export const UNLOCK_MAX_AGE_SEC = 180 * 24 * 60 * 60;

/** 게이트 상태 */
export type GateMode =
  /** APP_PIN 미설정 + 개발 환경 — 게이트 통과(로컬 데모 유지) */
  | "open"
  /** APP_PIN 설정됨 — 쿠키 검사 */
  | "enforce"
  /** APP_PIN 미설정 + 프로덕션 — 전부 차단(fail-closed) */
  | "misconfigured";

/** APP_PIN (미설정·빈 문자열이면 null) */
export function getAppPin(): string | null {
  const raw = process.env.APP_PIN;
  if (typeof raw !== "string") return null;
  const pin = raw.trim();
  return pin.length > 0 ? pin : null;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * 게이트 상태 판정.
 *
 * 프로덕션에서 APP_PIN이 없으면 통과시키지 않고 **전부 차단**한다(fail-closed):
 * 설정 실수로 잠금이 열린 채 방치되는 사고가, 잠긴 채 막혀 곧바로 알아채는 것보다
 * 훨씬 나쁘다(AI 비용·개인 이용 노출). 개발 환경에서는 키 없는 로컬 데모를
 * 그대로 쓸 수 있게 통과시킨다.
 */
export function gateMode(): GateMode {
  if (getAppPin()) return "enforce";
  return isProduction() ? "misconfigured" : "open";
}

const encoder = new TextEncoder();

/** HMAC-SHA256(key, msg) → hex. Web Crypto만 사용(Edge 호환) */
async function hmacHex(key: string, msg: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(msg));
  let hex = "";
  for (const byte of new Uint8Array(sig)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * 상수시간 문자열 비교 — 길이를 먼저 확인하고, 같으면 문자 코드 XOR을 끝까지 누적한다.
 * (조기 return이 없어야 일치하는 접두사 길이가 응답 시간으로 새지 않는다)
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 쿠키 값 생성: `<exp>.<sig>` */
export async function createUnlockToken(pin: string, now: number = Date.now()): Promise<string> {
  const exp = now + UNLOCK_MAX_AGE_SEC * 1000;
  return `${exp}.${await hmacHex(pin, `unlock:${exp}`)}`;
}

/** 쿠키 값 검증: 만료 확인 + 서명 재계산 + 상수시간 비교 */
export async function verifyUnlockToken(
  token: string | null | undefined,
  pin: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;

  const expPart = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // 서명 길이는 고정(hex 64) — 형식이 어긋나면 HMAC 계산 없이 거절
  if (!/^\d{1,15}$/.test(expPart) || sig.length !== 64) return false;

  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp <= now) return false;

  // 서명 대상은 쿠키에 실린 문자열 그대로 — 파싱 결과가 아니라 원문에 서명한다
  return timingSafeEqual(sig, await hmacHex(pin, `unlock:${expPart}`));
}

/** 쿠키 속성 (NextResponse.cookies.set / ResponseCookies 공용) */
export function unlockCookieAttrs() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    // 로컬 http 개발에서도 쿠키가 붙도록 프로덕션에서만 secure
    secure: isProduction(),
    maxAge: UNLOCK_MAX_AGE_SEC,
  };
}

/**
 * 잠금 해제 후 돌아갈 경로 정리 — **오픈 리다이렉트 방지**.
 * `/`로 시작하는 내부 경로만 허용하고, `//`(프로토콜 상대 URL = 외부 도메인)·
 * `/\`(브라우저가 `//`로 정규화하는 변종)·개행(헤더 인젝션)은 전부 `/`로 되돌린다.
 * `/unlock` 자신으로 돌아가는 루프도 막는다.
 */
export function sanitizeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\r\n\t]/.test(raw)) return "/";
  if (raw === "/unlock" || raw.startsWith("/unlock?") || raw.startsWith("/unlock/")) return "/";
  return raw;
}
