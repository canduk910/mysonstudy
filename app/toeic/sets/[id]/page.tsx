/**
 * 표현집 상세 `/toeic/sets/[id]` (아빠의 영어 T1, docs/harness/toeic.md §3·§6-3·§8) — 서버 컴포넌트.
 *
 * 저장된 세트 하나를 읽어 클라이언트 상세 화면에 넘긴다. 유형별 공략 세트는 그 유형 폴더로, 틀 은행은 폴더 목록으로 보낸다(§12-3 표). 데이터 로딩·404·렌더 판정만 맡고(목록·라우트와 **같은 함수**
 * lib/toeic-record), 표현 카드·발화 포인트·전체 듣기·교재 QUIZ·이름 수정·"발화 포인트 만들기"는 클라이언트가 한다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import ToeicSetDetailView from "@/components/toeic-set-detail-view";
import { TOEIC_SET_TITLE_MAX } from "@/lib/ai/toeic/schemas";
import { formatKstDate } from "@/lib/kst";
import { getStore } from "@/lib/store";
import { toeicGuideFolderHref, toeicGuidePartOfSet } from "@/lib/toeic-guide-view";
import { isRenderableToeicSet, isToeicGuideSet } from "@/lib/toeic-record";

export const dynamic = "force-dynamic";

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: DetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getToeicSet(id);
  if (!record || !isRenderableToeicSet(record)) return { title: "표현집을 찾을 수 없어요 — 아빠의 영어" };
  return { title: `${record.titleKo} — 아빠의 영어` };
}

export default async function ToeicSetDetailPage({ params }: DetailPageProps) {
  const { id } = await params;
  const record = await getStore().getToeicSet(id);
  // 공략 계열은 표현집 상세가 아니다(§12-3 표): 유형 공략 → 그 유형 폴더 ③ 탭, 틀 은행·깨진 공략 → 폴더 목록.
  // 표현집 상세(이름 바꾸기·발화 포인트 만들기)가 공략에 열리지 않게 — 라우트도 409 is_guide로 막는다.
  if (record && isToeicGuideSet(record)) {
    const part = toeicGuidePartOfSet(record);
    redirect(part ? toeicGuideFolderHref(part, { tab: "quiz" }) : "/toeic/guides");
  }
  if (!record || !isRenderableToeicSet(record)) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href="/toeic/sets" className="u-navbtn">
            ← 표현집 목록
          </Link>
          <p className="t-caption flex-none">{formatKstDate(record.createdAt)}</p>
        </div>
      </header>

      <ToeicSetDetailView
        id={record.id}
        titleKo={record.titleKo}
        dayNo={record.dayNo}
        topicKo={record.topicKo}
        source={record.source}
        entries={record.entries}
        quiz={record.quiz}
        titleMax={TOEIC_SET_TITLE_MAX}
      />
    </main>
  );
}
