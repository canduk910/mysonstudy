/**
 * 잠금 화면 `/unlock` — 서버 컴포넌트.
 *
 * 게이트(proxy.ts)가 쿠키 없는 페이지 요청을 여기로 보낸다.
 * `next` 파라미터(원래 가려던 경로)는 **서버에서 정리**해(오픈 리다이렉트 방지)
 * 안전한 경로만 클라이언트 폼에 내려준다 — lib/auth는 서버 전용 모듈이라
 * 클라이언트 컴포넌트에서 직접 import하지 않는다.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import UnlockForm from "@/components/unlock-form";
import { UNLOCK_COOKIE, gateMode, getAppPin, sanitizeNextPath, verifyUnlockToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "잠금 해제 — 은우 북카드",
  robots: { index: false, follow: false },
};

interface UnlockPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UnlockPage({ searchParams }: UnlockPageProps) {
  const sp = await searchParams;
  const rawNext = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  const next = sanitizeNextPath(rawNext);

  // 이미 풀려 있는데 잠금 화면에 왔다면(북마크·뒤로가기) 곧장 돌려보낸다
  const pin = getAppPin();
  if (gateMode() === "open") redirect(next);
  if (pin) {
    const token = (await cookies()).get(UNLOCK_COOKIE)?.value;
    if (await verifyUnlockToken(token, pin)) redirect(next);
  }

  // 흰 화면 가운데에 최소한의 요소만 — 앱 이름 · 안내 한 줄 · PIN 입력 · 큰 파란 버튼
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="t-book-title text-center">은우 북카드</h1>
      <p className="t-lead mt-2 text-center">우리 가족만 쓰는 앱이에요. PIN을 입력해 주세요.</p>

      <UnlockForm next={next} />

      <p className="t-caption mt-6 text-center">PIN이 기억나지 않으면 엄빠에게 물어보세요.</p>
    </main>
  );
}
