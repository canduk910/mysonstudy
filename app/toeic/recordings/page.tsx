/**
 * 🎙️ 내 녹음 `/toeic/recordings` (아빠의 영어 — 녹음 관리, docs/harness/toeic.md §14-6, SPEC §20-12) — 서버 컴포넌트.
 *
 * 모의고사·한 문제 연습 응시의 **녹음을 응시별로 모아** 보고(▶ 듣기) 지운다(하나씩·응시 통째). 지우면 서버(GCS 또는 파일 백엔드)와
 * 이 기기(IndexedDB·업로드 대기열) 모두에서 사라지고 **점수·전사·피드백은 남는다**(그 문항은 다시 채점할 수 없다).
 * 여기서는 응시 기록을 읽어 **줄인 요약**(ToeicRecAttemptSummary — 피드백 본문·전사문 없음)만 넘기고, 이 기기 사본과 합치기·재생·지우기는
 * 클라이언트(ToeicRecordingsView)가 한다. 이 화면도 업로드 대기열 계기다(§13-3 — 허브와 같은 토익 화면).
 *
 * 셸은 아빠 영역 방식(u-navbtn "← 아빠의 영어" 헤더 — 은우 셸을 쓰지 않는다). 잠금은 proxy.ts PIN 게이트.
 */

import type { Metadata } from "next";
import Link from "next/link";
import ToeicRecordingsView from "@/components/toeic-recordings-view";
import { getStore } from "@/lib/store";
import { toeicDrillScopeLabelKo, toeicScopeLabelKo } from "@/lib/toeic-attempt-contract";
import type { ToeicRecAttemptSummary } from "@/lib/toeic-rec-manage";
import { toeicGenerationStartedAt, toeicHistoryGenerationOf } from "@/lib/toeic-retake";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "내 녹음 — 아빠의 영어",
  description: "토익스피킹 모의고사·연습에서 녹음한 내 답과 고칠 문장 다시 말하기를 모아 듣고 지우는 곳.",
};

export default async function ToeicRecordingsPage() {
  const store = getStore();
  const attempts = await store.listAllToeicAttempts();
  const mockIds = [...new Set(attempts.map((a) => a.mockId))];
  const mocks = new Map((await Promise.all(mockIds.map((id) => store.getToeicMock(id)))).filter((m) => m !== null).map((m) => [m.id, m] as const));

  const summaries: ToeicRecAttemptSummary[] = [];
  for (const a of attempts) {
    const mock = mocks.get(a.mockId);
    if (!mock) continue; // 모의고사가 지워졌으면 응시도 지워졌다(연쇄) — 남은 기기 사본은 화면이 "기록 없는 녹음"으로 보인다
    summaries.push({
      id: a.id,
      mockId: a.mockId,
      titleKo: mock.titleKo,
      scopeLabelKo: mock.drillPart !== null ? toeicDrillScopeLabelKo(mock.drillPart, a.questions) : toeicScopeLabelKo(a.scope, a.parts),
      startedAt: a.startedAt,
      questions: a.questions,
      answers: a.answers.map((x) => ({ q: x.q, recorded: x.recorded === true, score: x.score })),
      recordings: a.recordings,
      fixRecordings: a.fixRecordings,
      recordingDeletions: a.recordingDeletions,
      // 예전 답 녹음(§15-8) — 줄인 자료(녹음 메타·세대 시작·점수·고칠 문장 녹음 수·녹음 지운 시각)만
      answerHistory: a.answerHistory.map((h) => {
        const rows = a.answerHistory.filter((x) => x.q === h.q);
        return {
          q: h.q,
          replacedBy: h.replacedBy,
          startedAt: toeicGenerationStartedAt(a, toeicHistoryGenerationOf(rows, rows.indexOf(h))),
          score: h.answer.score,
          recording: h.recording,
          fixCount: h.fixRecordings.length,
          recordingDeletedAt: h.recordingDeletedAt,
        };
      }),
    });
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/toeic" className="u-navbtn">
            ← 아빠의 영어
          </Link>
        </div>
        <h1 className="t-book-title mt-4">🎙️ 내 녹음</h1>
        <p className="t-lead mt-1">
          모의고사·한 문제 연습에서 녹음한 내 답과, 결과 화면에서 고칠 문장을 다시 말한 녹음을 응시별로 모았어요. 지우면 서버와 이 기기에서 모두
          사라지고 되돌릴 수 없어요 — 점수·전사·피드백은 남아요.
        </p>
      </header>
      <ToeicRecordingsView summaries={summaries} />
    </main>
  );
}
