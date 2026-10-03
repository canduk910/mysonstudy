/**
 * 문항 단위 다시 풀기 `/toeic/attempts/[id]/retake?q=3,4[&replace=<rid>]` (아빠의 영어 — docs/harness/toeic.md §15-3, SPEC §20-13) — 서버 컴포넌트.
 *
 * 원래 응시 기록과 모의고사를 읽어 고른 문항(`q` — parseToeicRetakeQuestions)을 응시 범위와 대조하고, 응시 화면(ToeicTakeView)을 **그대로**
 * 띄운다(prop `retake`). 형식은 실전 그대로 — 단계 엔진이 고른 문항으로 지시문(파트 첫 문항이면)·표 읽기(Q8을 고르면)·질문 음성·준비·답변을 만든다.
 * 묶음 문항(Q5–7·Q8–10)은 문항 화면 자료(buildToeicQuestionViews)가 상황 소개·표를 그대로 싣는다. 녹음 보관 풀은 원래 응시와 같다.
 * 범위가 어긋나거나 닫히지 않은 응시는 이유와 "← 결과" 링크만. 없는 응시·모의고사는 404.
 * 시작(`POST …/retakes`)·끝(`POST …/retakes/[rid]/finish`)·녹음은 클라이언트가 한다. `replace`는 409 retake_in_progress 뒤 사용자가 고른 "그 다시 풀기를
 * 닫고 새로 시작"(시작 탭이 마이크 권한을 탭 안에서 얻어야 하므로 자동으로 다시 보내지 않는다).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicTakeView from "@/components/toeic-take-view";
import { getStore } from "@/lib/store";
import { buildToeicQuestionViews, toeicAttemptHref } from "@/lib/toeic-attempt-contract";
import { isToeicAttemptClosed, orderToeicParts } from "@/lib/toeic-attempt-rules";
import { toeicQuestionFormat } from "@/lib/toeic-mock";
import { isRenderableToeicMock } from "@/lib/toeic-record";
import { isToeicRetakeId, parseToeicRetakeQuestions } from "@/lib/toeic-retake";

export const dynamic = "force-dynamic";

interface RetakePageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({ params }: RetakePageProps): Promise<Metadata> {
  const { id } = await params;
  const attempt = await getStore().getToeicAttempt(id);
  if (!attempt) return { title: "응시 기록을 찾을 수 없어요 — 아빠의 영어" };
  return { title: "문항 다시 풀기 — 아빠의 영어" };
}

export default async function ToeicRetakePage({ params, searchParams }: RetakePageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const store = getStore();
  const attempt = await store.getToeicAttempt(id);
  if (!attempt) notFound();
  const mock = await store.getToeicMock(attempt.mockId);
  if (!mock || !isRenderableToeicMock(mock)) notFound();

  const back = { href: toeicAttemptHref(attempt.id), labelKo: "← 결과", buttonKo: "📊 결과로" };
  const qs = parseToeicRetakeQuestions(first(sp.q));
  const replaceRaw = first(sp.replace);
  const replaceOpen = replaceRaw && isToeicRetakeId(replaceRaw) ? replaceRaw : null;

  const reason =
    qs === null
      ? "다시 풀 문항이 올바르지 않아요."
      : qs.some((q) => !attempt.questions.includes(q))
        ? "이 응시에 없는 문항이 있어요."
        : !isToeicAttemptClosed(attempt)
          ? "아직 끝나지 않은 응시예요 — 응시를 마친 뒤 문항을 다시 풀 수 있어요."
          : null;
  if (reason !== null || qs === null) {
    return (
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        <header className="mb-4">
          <Link href={back.href} className="u-navbtn">
            {back.labelKo}
          </Link>
        </header>
        <div className="u-box" role="alert">
          <p className="t-body">{reason}</p>
        </div>
      </main>
    );
  }

  const parts = orderToeicParts(qs.map((q) => toeicQuestionFormat(q).part));
  return (
    <ToeicTakeView
      mockId={mock.id}
      titleKo={mock.titleKo}
      scope={attempt.scope}
      parts={parts}
      scopeLabelKo={`↻ 다시 풀기 · ${qs.map((q) => `Q${q}`).join(" · ")}`}
      questions={buildToeicQuestionViews(mock.parts, qs)}
      back={back}
      recPool={mock.drillPart !== null ? "drill" : "mock"}
      retake={{ attemptId: attempt.id, replaceOpen }}
    />
  );
}
