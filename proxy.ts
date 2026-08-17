/**
 * proxy.ts — PIN 잠금 게이트 (모든 요청 검사)
 *
 * ⚠️ 파일 이름 주의: **Next.js 16에서 `middleware.ts`는 deprecated이고 `proxy.ts`로
 * 이름이 바뀌었다**(내보내는 함수도 `middleware` → `proxy`).
 * 근거: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
 * ("Middleware is deprecated and renamed to Proxy. Proxy defaults to the Node.js runtime", v16.0.0)
 * 기능은 동일하다. 새 이름을 쓰지 않으면 향후 버전에서 게이트가 통째로 사라질 수 있다.
 *
 * 하는 일 (lib/auth.ts의 규칙을 그대로 적용):
 * - 예외 경로(/unlock, /api/unlock, /_next/*, 정적 자산)는 통과.
 * - 유효 쿠키가 없으면 → 페이지 요청은 `/unlock?next=<원래경로>`로 리다이렉트,
 *   **API 요청은 401 JSON**. (API에 리다이렉트를 주면 fetch가 HTML을 받아 깨진다)
 * - `/api/card`·`/api/extract`처럼 OpenAI 비용이 나는 라우트도 반드시 게이트 안에
 *   둔다 — API가 열려 있으면 잠금의 의미가 없다.
 * - 프로덕션인데 APP_PIN이 없으면(gateMode "misconfigured") 전부 503으로 차단(fail-closed).
 *
 * 런타임: Next 16의 proxy는 Node.js 런타임이 기본이지만, 검증 코드는 Web Crypto만
 * 쓰므로(lib/auth.ts) Edge로 옮겨도 그대로 동작한다.
 */

import { NextResponse, type NextRequest } from "next/server";
import { UNLOCK_COOKIE, gateMode, getAppPin, verifyUnlockToken } from "@/lib/auth";

/** 게이트 예외 — 잠금 화면 자체와 그 API */
const PUBLIC_PATHS = new Set(["/unlock", "/api/unlock"]);

/** 정적 자산 확장자 — public/ 에 파일을 두게 되어도 잠금과 무관하게 서빙된다 */
const STATIC_FILE = /\.(?:ico|png|jpg|jpeg|gif|webp|avif|svg|css|js|mjs|map|txt|xml|json|webmanifest|woff2?)$/i;

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname === "/unlock/" || pathname === "/api/unlock/") return true;
  // 빌드 자산·이미지 최적화·dev HMR
  if (pathname.startsWith("/_next/")) return true;
  // dev 전용 엔드포인트(에러 오버레이 등)
  if (pathname.startsWith("/__next") || pathname.startsWith("/__nextjs")) return true;
  return STATIC_FILE.test(pathname);
}

/** no-store — 잠금 응답이 브라우저·CDN에 캐시되어 재사용되면 안 된다 */
function noStore(res: NextResponse): NextResponse {
  res.headers.set("cache-control", "no-store, must-revalidate");
  return res;
}

function lockedJson(messageKo: string, status: number): NextResponse {
  return noStore(
    NextResponse.json({ ok: false, error: status === 503 ? "not_configured" : "locked", messageKo }, { status }),
  );
}

function lockedPage(messageKo: string): NextResponse {
  // 프로덕션 설정 누락 전용 화면 — /unlock으로 보내면 영원히 못 여는 루프가 된다
  // 이 화면은 app/globals.css를 불러올 수 없는 독립 HTML이라, 예외적으로
  // docs/DESIGN.md §2 토큰 값을 그대로 옮겨 적는다(--bg/--ink/--ink-2, G마켓 산스).
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>은우 북카드</title>
<style>
@font-face{font-family:"GmarketSans";src:url("/fonts/GmarketSansLight.woff2") format("woff2");font-weight:300;font-style:normal;font-display:swap}
@font-face{font-family:"GmarketSans";src:url("/fonts/GmarketSansBold.woff2") format("woff2");font-weight:700;font-style:normal;font-display:swap}
</style></head>
<body style="margin:0;background:#ffffff;color:#0f172a;font-family:'GmarketSans',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;font-weight:300;line-height:1.75">
<main style="max-width:26rem;margin:0 auto;padding:4rem 1.5rem;text-align:center">
<p style="font-size:2.5rem;margin:0">🔒</p>
<h1 style="font-size:18px;font-weight:700;margin:.75rem 0 .25rem">잠깐 잠겨 있어요</h1>
<p style="font-size:16px;color:#475569;margin:0">${messageKo}</p>
</main></body></html>`;
  return noStore(
    new NextResponse(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } }),
  );
}

function redirectToUnlock(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  // 돌아갈 경로: 원래 경로 + 쿼리(단 RSC 내부 파라미터는 제거)
  const params = new URLSearchParams(req.nextUrl.search);
  params.delete("_rsc");
  const query = params.toString();
  const nextPath = req.nextUrl.pathname + (query ? `?${query}` : "");

  url.pathname = "/unlock";
  url.search = "";
  if (nextPath && nextPath !== "/") url.searchParams.set("next", nextPath);

  return noStore(NextResponse.redirect(url));
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  const mode = gateMode();

  // 프로덕션 + APP_PIN 미설정 → 전부 차단 (fail-closed)
  if (mode === "misconfigured") {
    const messageKo = "서버에 잠금 PIN(APP_PIN)이 설정되지 않아 접속을 막았어요. 관리자에게 알려 주세요.";
    return isApi ? lockedJson(messageKo, 503) : lockedPage(messageKo);
  }

  // 개발 환경 + APP_PIN 미설정 → 로컬 데모 그대로 통과
  if (mode === "open") return NextResponse.next();

  const pin = getAppPin();
  if (pin && (await verifyUnlockToken(req.cookies.get(UNLOCK_COOKIE)?.value, pin))) {
    return NextResponse.next();
  }

  return isApi
    ? lockedJson("잠금이 걸려 있어요. 화면을 새로고침한 뒤 PIN을 입력해 주세요.", 401)
    : redirectToUnlock(req);
}

export const config = {
  /**
   * 정적 자산은 게이트에서 제외한다(잠금 화면의 CSS/JS까지 막히면 화면이 깨진다).
   * **`api`는 제외하지 않는다** — API 보호가 이 잠금의 핵심이다.
   * 함수 안의 isPublicPath()가 같은 판정을 한 번 더 하므로(이중 방어),
   * matcher를 바꿔도 게이트가 뚫리지 않는다.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
