import type { Metadata, Viewport } from "next";
import VersionWatch from "@/components/version-watch";
import "./globals.css";

export const metadata: Metadata = {
  title: "은우 북카드",
  description: "영어책 표지 사진이나 제목으로 우리 아이 학습 카드를 만들어요.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      {/* 폰트: G마켓 산스 self-host(public/fonts/*.woff2) — 외부 CDN 없음.
          @font-face·색·타이포 토큰은 app/globals.css (docs/DESIGN.md §2~§6) */}
      {/* VersionWatch는 body의 **마지막 자식**이어야 한다 — `sticky bottom-0`가
          문서 흐름 끝에서 자기 자리를 만들어야 페이지 마지막 줄을 가리지 않는다.
          (새 배포 감지: components/version-watch.tsx) */}
      <body className="min-h-screen antialiased">
        {children}
        <VersionWatch />
      </body>
    </html>
  );
}
