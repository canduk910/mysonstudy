/**
 * 🏝️ 나만의 답변 섬 `/toeic/island?part=q5_7|q11` (docs/harness/toeic.md §21-4, SPEC §20-18) — 서버 컴포넌트.
 *
 * 섬 문장 전부(toeicIsland)와, 소재 칩(틀 말하기 은행 소재 — 유형별)·강조할 틀(틀 말하기 틀 + 공략 틀 은행 틀, key·frameEn만)을
 * 읽어 클라이언트 화면에 넘긴다. 은행이 없어도 섬은 온전히 동작한다(소재는 "소재 없음"·이름 사본, 강조 없음). AI 호출 0.
 * 셸은 토익 방식("← 아빠의 영어" 헤더 — 은우 EnglishNav를 쓰지 않는다).
 */

import type { Metadata } from "next";
import Link from "next/link";
import ToeicIslandView from "@/components/toeic-island-view";
import { getStore } from "@/lib/store";
import { frameDrillFramesForPart, frameDrillTopicsForPart } from "@/lib/toeic-frame-drill";
import { TOEIC_TEMPLATE_BANK_ID } from "@/lib/toeic-guide";
import { guideTemplatesForPart } from "@/lib/toeic-guide-view";
import { TOEIC_ISLAND_PARTS, type ToeicIslandPart } from "@/lib/toeic-island";
import type { ToeicIslandTopicChip } from "@/lib/toeic-island-contract";
import { isRenderableToeicTemplateBank } from "@/lib/toeic-record";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "🏝️ 나만의 답변 섬 — 아빠의 영어",
};

interface IslandPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ToeicIslandPage({ searchParams }: IslandPageProps) {
  const sp = await searchParams;
  const rawPart = typeof sp.part === "string" ? sp.part : "";
  const initialPart: ToeicIslandPart = (TOEIC_ISLAND_PARTS as readonly string[]).includes(rawPart) ? (rawPart as ToeicIslandPart) : "q5_7";
  const store = getStore();
  const [entries, frameBank, tplBank] = await Promise.all([
    store.listToeicIslandEntries(),
    store.getToeicFrameDrillBank().catch(() => null),
    store.getToeicSet(TOEIC_TEMPLATE_BANK_ID).catch(() => null),
  ]);
  const tplItems = tplBank !== null && isRenderableToeicTemplateBank(tplBank) ? (tplBank.guide as { items: unknown[] }).items : [];
  const topicsByPart = {} as Record<ToeicIslandPart, ToeicIslandTopicChip[]>;
  const templatesByPart = {} as Record<ToeicIslandPart, { key: string; frameEn: string }[]>;
  for (const p of TOEIC_ISLAND_PARTS) {
    topicsByPart[p] = frameBank ? frameDrillTopicsForPart(frameBank, p).map((t) => ({ key: t.topic.key, nameKo: t.topic.nameKo })) : [];
    const frames = frameBank ? frameDrillFramesForPart(frameBank, p).map((f) => ({ key: `fd:${f.key}`, frameEn: f.frameEn })) : [];
    const tpls = tplItems.length > 0 ? guideTemplatesForPart(tplItems, p).templates.map((t) => ({ key: `tpl:${t.key}`, frameEn: t.frameEn })) : [];
    templatesByPart[p] = [...frames, ...tpls];
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/toeic" className="u-navbtn">
            ← 아빠의 영어
          </Link>
          <Link href={`/toeic/guides/${initialPart}?tab=frame`} className="t-caption">
            🗣️ 틀 말하기
          </Link>
        </div>
        <h1 className="t-book-title mt-4">🏝️ 나만의 답변 섬</h1>
        <p className="t-lead mt-1">
          Q5–7·Q11 단골 소재마다 내 경험으로 만든 답변 조각을 모아요. 남의 예문보다 내 이야기가 시험장에서 먼저 떠올라요.
        </p>
        <p className="t-caption mt-1">📅 담은 문장은 다음 날부터 오늘의 복습에 나와요(가린 채 떠올리기).</p>
      </header>
      <ToeicIslandView initialEntries={entries} initialPart={initialPart} topicsByPart={topicsByPart} templatesByPart={templatesByPart} />
    </main>
  );
}
