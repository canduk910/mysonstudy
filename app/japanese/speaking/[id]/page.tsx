/**
 * 🎙️ 말하기 모의고사 학습 보기 `/japanese/speaking/[id]` (아빠의 일본어, docs/harness/japanese.md §15-10-2) — 서버 컴포넌트.
 *
 * 모의고사 레코드와 그 응시 기록(최신 위, 줄인 자료)을 읽어 클라이언트 학습 보기에 넘긴다. 사진 자동 요청·빈 파트 만들기·이름 바꾸기·
 * 모범답변 🔊는 클라이언트(JaSpeakingDetailView). 없거나 렌더할 수 없는 문서는 404.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import JaSpeakingDetailView from "@/components/ja-speaking-detail-view";
import { JA_SPEAKING_PARTS, type JaSpeakingPart } from "@/lib/ja-speaking";
import { JA_SPEAKING_HOME_HREF, summarizeJaSpeakingAttempt } from "@/lib/ja-speaking-contract";
import { isRenderableJaSpeakingMock } from "@/lib/japanese-record";
import { formatKstDate } from "@/lib/kst";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface DetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({ params }: DetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getJaSpeakingMock(id);
  if (!record || !isRenderableJaSpeakingMock(record)) return { title: "모의고사를 찾을 수 없어요 — 아빠의 일본어" };
  return { title: `${record.titleKo} — 아빠의 일본어` };
}

export default async function JaSpeakingDetailPage({ params, searchParams }: DetailPageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const store = getStore();
  const record = await store.getJaSpeakingMock(id);
  if (!record || !isRenderableJaSpeakingMock(record)) notFound();
  const attempts = (await store.listJaSpeakingAttemptsByMock(id)).map(summarizeJaSpeakingAttempt).reverse();
  const failedParts = (first(sp.failed) ?? "").split(",").filter((p): p is JaSpeakingPart => (JA_SPEAKING_PARTS as readonly string[]).includes(p));

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={JA_SPEAKING_HOME_HREF} className="u-navbtn">
            ← 말하기 모의고사
          </Link>
          <p className="t-caption flex-none">{formatKstDate(record.createdAt)}</p>
        </div>
      </header>
      <JaSpeakingDetailView mock={record} attempts={attempts} justCreated={first(sp.new) === "1"} failedParts={failedParts} />
    </main>
  );
}
