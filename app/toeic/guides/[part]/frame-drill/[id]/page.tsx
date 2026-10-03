/**
 * 🗣️ 틀 말하기 결과 `/toeic/guides/[part]/frame-drill/[id]` (docs/harness/toeic.md §20-1 5, SPEC §20-17) — 서버 컴포넌트.
 *
 * 저장된 한 판을 읽어 넘긴다(없거나 유형이 다르면 404). 판정이 없으면 화면이 열리자마자 판정을 요청하고(`/judge` — 호출 E 또는 AI 0),
 * 판정이 있으면 보충을 한 번 요청한다(`/supply` — 한 판에 한 번, 재방문은 표시만 돌려받아 호출 F 0회). 틀 글자는 판 기록의 사본(items[].frame)
 * 으로 보인다(은행이 바뀌어도 결과가 같다). 이 화면은 표현 도우미를 막지 않는다(결과 화면 — SPEC §22-3).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicFrameDrillResult from "@/components/toeic-frame-drill-result";
import s from "@/components/toeic-template-test.module.css";
import { getStore } from "@/lib/store";
import { TOEIC_FRAME_DRILL_PARTS, type ToeicFrameDrillPart } from "@/lib/toeic-frame-drill";
import { isToeicFrameDrillDocId, toeicFrameDrillTabHref, toeicFrameDrillTakeHref } from "@/lib/toeic-frame-drill-contract";
import { TOEIC_GUIDE_PART_TO_MOCK_PART } from "@/lib/toeic-guide";
import { toeicMockPartLabelKo } from "@/lib/toeic-mock-contract";

export const dynamic = "force-dynamic";

interface ResultPageProps {
  params: Promise<{ part: string; id: string }>;
}

const isFramePart = (p: string): p is ToeicFrameDrillPart => (TOEIC_FRAME_DRILL_PARTS as readonly string[]).includes(p);

export async function generateMetadata({ params }: ResultPageProps): Promise<Metadata> {
  const { part } = await params;
  if (!isFramePart(part)) return { title: "유형을 찾을 수 없어요 — 아빠의 영어" };
  return { title: `🗣️ 틀 말하기 결과 — ${toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part])}` };
}

export default async function ToeicFrameDrillResultPage({ params }: ResultPageProps) {
  const { part, id } = await params;
  if (!isFramePart(part) || !isToeicFrameDrillDocId(id)) notFound();
  const store = getStore();
  const [session, bank] = await Promise.all([store.getToeicFrameDrillSession(id), store.getToeicFrameDrillBank().catch(() => null)]);
  if (!session || session.part !== part) notFound();
  const topicNames = (bank?.topics ?? []).filter((t) => session.topicKeys.includes(t.key)).map((t) => t.nameKo);
  const backHref = toeicFrameDrillTabHref(part);
  const retryHref = toeicFrameDrillTakeHref(part, {
    topicKeys: session.topicKeys,
    excludedFrameKeys: session.excludedFrameKeys,
    questionTypeKeys: session.questionTypeKeys,
    count: session.requested,
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className={s.head}>
        <div className="flex items-center justify-between gap-3">
          <Link href={backHref} className="u-navbtn">
            ← 틀 말하기
          </Link>
          <p className="t-caption flex-none">{toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part])}</p>
        </div>
        <h1 className="t-book-title mt-3">🗣️ 틀 말하기 결과</h1>
      </header>
      <ToeicFrameDrillResult initial={session} topicNamesKo={topicNames} backHref={backHref} retryHref={retryHref} />
    </main>
  );
}
