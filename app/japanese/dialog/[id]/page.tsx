/**
 * 대화 복습 상세 `/japanese/dialog/[id]` (아빠의 일본어 J3·J4·J5, §8) — 서버 컴포넌트.
 * 저장된 대화를 읽어 전사+해설 화면에 넘긴다. 전사(turns)가 없으면 notFound(빈 레코드 방지). AI 없음.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import JaDialogDetailView from "@/components/ja-dialog-detail-view";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface DetailProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: DetailProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getJaDialog(id);
  if (!record || record.turns.length === 0) return { title: "대화를 찾을 수 없어요 — 아빠의 일본어" };
  return { title: `${record.titleKo} — 아빠의 일본어 대화` };
}

export default async function JaDialogDetailPage({ params }: DetailProps) {
  const { id } = await params;
  const record = await getStore().getJaDialog(id);
  if (!record || record.turns.length === 0) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href="/japanese/dialog" className="u-navbtn">
            ← 대화 복습
          </Link>
          <p className="t-caption flex-none">{record.createdAt.slice(0, 10).replace(/-/g, ".")}</p>
        </div>
      </header>
      <JaDialogDetailView
        id={record.id}
        titleKo={record.titleKo}
        focusKo={record.focusKo}
        turns={record.turns}
        coaching={record.coaching}
        partial={record.partial}
      />
    </main>
  );
}
