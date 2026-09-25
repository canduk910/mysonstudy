/**
 * 모의고사 학습 보기 `/toeic/mocks/[id]` (아빠의 영어 T3, docs/harness/toeic.md §4·§6-4·§8) — 서버 컴포넌트.
 *
 * 저장된 모의고사 하나와 그 응시 기록을 읽어 클라이언트 화면에 넘긴다. 데이터 로딩·404·렌더 판정만 맡고(목록·라우트와
 * **같은 함수** lib/toeic-record), 파트별 자료·모범답변·🔊·사진 자동 요청·"이 파트 다시 만들기"·이름 수정은 클라이언트가 한다.
 *
 * `?new=1&failed=<part,…>` — 막 만든 모의고사(목록의 만들기 흐름이 붙인다). 화면이 "만들었어요 · N개 파트는 못 만들었어요"를
 * 알리는 데만 쓴다(사진 자동 요청은 쿼리와 무관하게 pending 칸이면 한다).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicMockDetailView, { type ToeicMockAttemptSummary } from "@/components/toeic-mock-detail-view";
import { formatKstDate } from "@/lib/kst";
import { getStore } from "@/lib/store";
import { TOEIC_MOCK_TITLE_MAX } from "@/lib/toeic-mock-contract";
import { TOEIC_MOCK_PARTS, type ToeicMockPart } from "@/lib/toeic-mock";
import { isToeicAttemptClosed, recordedToeicCount, scoredToeicCount } from "@/lib/toeic-attempt-rules";
import { isRenderableToeicMock } from "@/lib/toeic-record";
import { estimateToeicTotal } from "@/lib/toeic-score";

export const dynamic = "force-dynamic";

interface DetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: DetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getToeicMock(id);
  if (!record || !isRenderableToeicMock(record)) return { title: "모의고사를 찾을 수 없어요 — 아빠의 영어" };
  return { title: `${record.titleKo} — 아빠의 영어` };
}

/** 응시 기록 줄의 추정 — 11문항 모두 채점됐을 때만 "추정 150 · IH"(§5-5), 아니면 null */
function estimateLabelKo(answers: readonly { q: number; score: number | null }[]): string | null {
  const e = estimateToeicTotal(answers);
  return e.complete ? `추정 ${e.scaled} · ${e.band}` : null;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ToeicMockDetailPage({ params, searchParams }: DetailPageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const store = getStore();
  const record = await store.getToeicMock(id);
  if (!record || !isRenderableToeicMock(record)) notFound();

  const attempts = await store.listToeicAttemptsByMock(id);
  const attemptSummaries: ToeicMockAttemptSummary[] = attempts
    .map((a) => ({
      id: a.id,
      scope: a.scope,
      parts: a.parts,
      startedAt: a.startedAt,
      finished: a.finishedAt !== null,
      closed: isToeicAttemptClosed(a),
      recordedCount: recordedToeicCount(a.answers),
      scoredCount: scoredToeicCount(a.answers),
      estimateKo: estimateLabelKo(a.answers),
    }))
    .reverse(); // 최신 위

  const justCreated = first(sp.new) === "1";
  const failedParts = (first(sp.failed) ?? "")
    .split(",")
    .filter((p): p is ToeicMockPart => (TOEIC_MOCK_PARTS as readonly string[]).includes(p));

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href="/toeic/mocks" className="u-navbtn">
            ← 모의고사 목록
          </Link>
          <p className="t-caption flex-none">{formatKstDate(record.createdAt)}</p>
        </div>
      </header>

      <ToeicMockDetailView
        mock={record}
        attempts={attemptSummaries}
        justCreated={justCreated}
        failedParts={failedParts}
        titleMax={TOEIC_MOCK_TITLE_MAX}
      />
    </main>
  );
}
