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
      {/* 폰트: 시스템 폰트 스택 — 외부 폰트·CDN 로딩 금지 (SPEC §8) */}
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
