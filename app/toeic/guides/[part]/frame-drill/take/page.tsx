/**
 * 🗣️ 틀 말하기 진행 `/toeic/guides/[part]/frame-drill/take?topics=&ex=&qt=&n=&t=` (docs/harness/toeic.md §20-1, SPEC §20-17) — 서버 컴포넌트.
 *
 * part ∈ q5_7 | q11(그 밖 404). **출제를 서버가 한다** — 은행·통계를 읽어 범위(frameDrillScopeFrameKeys) → 가중 무작위 출제
 * (buildFrameDrillOrder — Math.random)를 1회 해서 넘긴다(문항 고정 — hydration 안전, 틀 테스트 페이지 관용구). `?t=`는 "다시 하기"
 * 논스 — 서버 재출제를 강제하고 화면을 remount한다. 화면에는 문항에 필요한 칸만(itemId·frameKey·한국어·모범 영어·`~` 틀) 넘긴다.
 * 이 경로는 표현 도우미가 막힌다(lib/phrase-helper-scope — 시험 경로, 진행 화면도 블록을 함께 건다). AI 없음 — 받아쓰기는 화면이 관문 T로.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ToeicFrameDrillRunner, { type ToeicFrameDrillRunItem } from "@/components/toeic-frame-drill-runner";
import s from "@/components/toeic-template-test.module.css";
import { getStore } from "@/lib/store";
import { TOEIC_FRAME_DRILL_PARTS, buildFrameDrillOrder, frameDrillFrameText, frameDrillScopeFrameKeys, frameDrillScopeItems, type ToeicFrameDrillPart } from "@/lib/toeic-frame-drill";
import { parseFrameDrillSelection, toeicFrameDrillTabHref, toeicFrameDrillTakeHref } from "@/lib/toeic-frame-drill-contract";
import { TOEIC_GUIDE_PART_TO_MOCK_PART } from "@/lib/toeic-guide";
import { toeicMockPartLabelKo } from "@/lib/toeic-mock-contract";

export const dynamic = "force-dynamic";

interface TakePageProps {
  params: Promise<{ part: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const isFramePart = (p: string): p is ToeicFrameDrillPart => (TOEIC_FRAME_DRILL_PARTS as readonly string[]).includes(p);

export async function generateMetadata({ params }: TakePageProps): Promise<Metadata> {
  const { part } = await params;
  if (!isFramePart(part)) return { title: "유형을 찾을 수 없어요 — 아빠의 영어" };
  return { title: `🗣️ 틀 말하기 — ${toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part])}` };
}

export default async function ToeicFrameDrillTakePage({ params, searchParams }: TakePageProps) {
  const { part } = await params;
  if (!isFramePart(part)) notFound();
  const sp = await searchParams;
  const sel = parseFrameDrillSelection(sp);
  const nonce = Array.isArray(sp.t) ? sp.t[0] : (sp.t ?? "0");

  const store = getStore();
  const [bank, stats] = await Promise.all([store.getToeicFrameDrillBank(), store.getToeicFrameDrillStats()]);
  const scopeKeys = bank ? frameDrillScopeFrameKeys(bank, part, sel.topicKeys, sel.excludedFrameKeys, sel.questionTypeKeys) : [];
  const scopeItems = bank ? frameDrillScopeItems(bank, scopeKeys) : [];
  const order = buildFrameDrillOrder(scopeItems, stats.items, sel.count);
  const frameByKey = new Map((bank?.frames ?? []).map((f) => [f.key, f] as const));
  const items: ToeicFrameDrillRunItem[] = order.items.flatMap((it) => {
    const f = frameByKey.get(it.frameKey);
    return f ? [{ itemId: it.id, frameKey: it.frameKey, ko: it.ko, en: it.en, frame: frameDrillFrameText(f) }] : [];
  });
  const topicNames = (bank?.topics ?? []).filter((t) => sel.topicKeys.includes(t.key)).map((t) => t.nameKo);

  const partLabelKo = toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part]);
  const backHref = toeicFrameDrillTabHref(part);
  let emptyKo: string | null = null;
  if (!bank) emptyKo = "아직 틀 말하기 문제가 없어요. 문제 파일을 먼저 가져와 주세요.";
  else if (items.length === 0) emptyKo = "고른 범위에 문항이 없어요. 소재·틀을 다시 골라 주세요.";

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className={s.head}>
        <div className="flex items-center justify-between gap-3">
          <Link href={backHref} className="u-navbtn">
            ← 틀 말하기
          </Link>
          <p className="t-caption flex-none">{partLabelKo}</p>
        </div>
        <h1 className="t-book-title mt-3">🗣️ 틀 말하기</h1>
      </header>

      {emptyKo !== null ? (
        <section className={s.empty}>
          <p className={s.emptyText}>{emptyKo}</p>
          <Link href={backHref} className="u-btn u-btn-primary">
            🗣️ 틀 말하기로
          </Link>
        </section>
      ) : (
        <ToeicFrameDrillRunner
          key={`${sel.topicKeys.join(",")}|${sel.excludedFrameKeys.join(",")}|${sel.questionTypeKeys.join(",")}|${sel.count}|${nonce}`}
          part={part}
          selection={sel}
          items={items}
          shortBy={order.shortBy}
          topicNamesKo={topicNames}
          backHref={backHref}
          retryHref={toeicFrameDrillTakeHref(part, sel)}
        />
      )}
    </main>
  );
}
