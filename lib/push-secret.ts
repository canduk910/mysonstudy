/**
 * lib/push-secret.ts — PIN 게이트 밖 알림 라우트(30분 틱 `/api/push/tick`·휴식 알림 발송 `/api/push/workout-rest/fire`)의
 * 헤더 `x-push-secret` 검사 — env `PUSH_CRON_SECRET`과 상수 시간 비교(비밀 없음·불일치 → false). 서버 전용.
 */

import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** 길이가 달라도 상수 시간 — 둘 다 sha256으로 같은 길이로 만든 뒤 비교 */
export function pushSecretOk(given: string | null): boolean {
  const want = process.env.PUSH_CRON_SECRET?.trim();
  if (!want || !given) return false;
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(given), h(want));
}
