/**
 * GET /api/version — 지금 서버가 돌리고 있는 빌드 식별자
 *
 * 브라우저가 "내가 보고 있는 화면이 최신 배포인가"를 확인하는 유일한 창구다.
 * (2026-08-20 "배포했는데 옛 화면이 보인다" 사고 대응 — components/version-watch.tsx)
 *
 * 응답 shape (qa-inspector 교차 검증용):
 * - 200: { ok: true, buildId: string | null }
 *   · `buildId: null` = 서버가 자기 빌드를 알아내지 못했다 → 클라이언트는 **아무것도
 *     하지 않는다**(거짓 알림 금지). 에러가 아니므로 200을 준다.
 * - 401: { ok: false, error: "locked", ... }  ← proxy.ts가 준다(아래 "잠금 관계")
 *
 * ── 캐시 ────────────────────────────────────────────────────────────────────
 * **반드시 `no-store`**다. 이 응답이 한 번이라도 캐시되면 갱신 감지 장치 자체가
 * 옛 값을 물고 고장 난다 — 고치려던 문제를 그대로 재현하게 된다.
 * `next.config.ts`의 페이지 캐시 규칙은 `/api/**`를 제외하므로 이 값이 그대로 나간다.
 *
 * ── 잠금(proxy.ts) 관계: **게이트 안에 둔다** ───────────────────────────────
 * `PUBLIC_PATHS`에 넣지 않았다. 근거:
 * · 배너가 뜰 화면은 전부 PIN 뒤라 쿠키가 이미 붙어 있다 — 공개해서 얻는 기능이 없다.
 * · proxy.ts 주석의 원칙("API가 열려 있으면 잠금의 의미가 없다")을 깨면서까지 열 이유가
 *   없다. 인증 없이 두드릴 수 있는 원본 엔드포인트를 하나 늘리는 값이 더 비싸다.
 * · 빌드 ID 자체는 비밀이 아니다(프리렌더 HTML의 `/_next/static/<BUILD_ID>/...`에
 *   이미 드러난다). 그래서 **공개 여부는 보안이 아니라 표면적 문제**이고, 표면을
 *   늘리지 않는 쪽을 골랐다.
 * · 잠금 화면(`/unlock`)은 `force-dynamic`이라 애초에 캐시되지 않는다 — 잠긴 상태에서
 *   갱신 감지가 필요한 화면이 없다. 잠긴 동안 이 요청은 401이 되고, 클라이언트는
 *   401을 "모름"으로 취급해 조용히 넘어간다.
 */

import { NextResponse } from "next/server";
import { getBuildId } from "@/lib/build-id";

export const runtime = "nodejs";
// 파일시스템을 읽고 매 요청 최신 값을 줘야 하므로 프리렌더 금지
export const dynamic = "force-dynamic";

export interface VersionResponse {
  ok: true;
  buildId: string | null;
}

export async function GET() {
  const body: VersionResponse = { ok: true, buildId: getBuildId() };
  return NextResponse.json(body, {
    headers: { "cache-control": "no-store, must-revalidate" },
  });
}
