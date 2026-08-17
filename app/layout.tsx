import type { Metadata, Viewport } from "next";
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
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
