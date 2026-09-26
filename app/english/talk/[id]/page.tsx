/**
 * 은우 자유대화 보기 `/english/talk/[id]` (SPEC §21-2 6, docs/harness/english.md §12-3·§12-6) — 서버 컴포넌트.
 *
 * 저장된 대화를 읽어 말풍선(문장 탭 → 선생님 설명 시트)·주제 일러스트·오늘 본 그림 카드를 화면에 넘긴다. 렌더 판정은 목록·설명
 * 라우트와 같은 함수(isRenderableTalkSession) — 없거나 깨진 기록은 notFound(). AI 없음(설명은 문장을 탭할 때만 — 자동 비용 0).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import TalkReviewView from "@/components/talk-review-view";
import { formatKstDate } from "@/lib/kst";
import { isFirestoreDocId } from "@/lib/reorder-contract";
import { getStore } from "@/lib/store";
import { isRenderableTalkSession } from "@/lib/talk-record";

export const dynamic = "force-dynamic";

interface DetailProps {
  params: Promise<{ id: string }>;
}

async function load(id: string) {
  if (!isFirestoreDocId(id)) return null;
  const record = await getStore().getTalkSession(id);
  return isRenderableTalkSession(record) ? record : null;
}

export async function generateMetadata({ params }: DetailProps): Promise<Metadata> {
  const { id } = await params;
  const record = await load(id);
  if (!record) return { title: "대화를 찾을 수 없어요 — 은우 영어" };
  return { title: `${record.titleKo} — 자유대화` };
}

export default async function TalkDetailPage({ params }: DetailProps) {
  const { id } = await params;
  const record = await load(id);
  if (!record) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href="/english/talk" className="u-navbtn">
            ← 자유대화
          </Link>
          <p className="t-caption flex-none">{formatKstDate(record.createdAt)}</p>
        </div>
      </header>
      <TalkReviewView
        id={record.id}
        titleKo={record.titleKo}
        topicLabelKo={record.topic.labelKo}
        durationSec={record.durationSec}
        childTurnCount={record.childTurnCount}
        sceneImageId={record.sceneImageId}
        sceneEn={record.sceneEn}
        cards={record.cards}
        turns={record.turns}
        explanations={record.explanations}
      />
    </main>
  );
}
