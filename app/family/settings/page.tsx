/**
 * 🔔 알림 설정 `/family/settings` — 서버 셸 + 클라이언트 설정(가족 스트릭 강화 스펙 §6-1). PIN 게이트 안.
 */

import type { Metadata } from "next";
import Link from "next/link";
import PushSettings from "@/components/push-settings";

export const metadata: Metadata = { title: "알림 설정 · 은우학습" };

export default function FamilySettingsPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4">
        <Link href="/family" className="u-navbtn">
          ← 가족 보드
        </Link>
      </div>
      <PushSettings />
    </main>
  );
}
