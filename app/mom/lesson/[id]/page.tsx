/**
 * 엄마의 생활영어 하루 레슨 `/mom/lesson/[id]` — 서버 컴포넌트(설계 §4).
 * ⚠️ `force-dynamic` 필수 — 빠지면 빌드 때 빈 DB로 정적 고정된다.
 *
 * 레슨 찾기: `buildMomWeeks`(실제 주·실제 복습 주) → 없으면 `momToday`가 오늘 내준 레슨(자동 감속 가상 복습 주 `rw{N+100}`은
 * 진도 걷기 안에서만 생긴다 — 오늘 레슨일 때만 열린다). 둘 다 아니면 404.
 * 교재 문장은 화면 코드에 없다 — 모두 가져온 파일(스토어)에서 온다.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import MomLessonRunner from "@/components/mom-lesson-runner";
import { getStore } from "@/lib/store";
import { buildMomWeeks, isMomVirtualWeek, momToday, type MomLesson } from "@/lib/mom-plan";
import type { MomBlock, MomSentence } from "@/lib/mom-content";

export const dynamic = "force-dynamic";

type Stage = 0 | 1 | 2 | 3 | 4;

export default async function MomLessonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();
  const [blocks, lessons, tests] = await Promise.all([store.listMomBlocks(), store.listMomLessons(), store.listMomTests()]);

  let found: { lesson: MomLesson; stage: Stage } | null = null;
  for (const wp of buildMomWeeks(blocks)) {
    const l = wp.lessons.find((x) => x.id === id);
    if (l) {
      found = { lesson: l, stage: wp.stage };
      break;
    }
  }
  if (!found) {
    const today = momToday({ blocks, lessons, tests });
    if (today.kind === "lesson" && today.lesson.id === id) found = { lesson: today.lesson, stage: today.stage };
  }
  if (!found) notFound();
  const { lesson, stage } = found;

  // 문장 id → (문장, 블록)
  const byId = new Map<string, { s: MomSentence; b: MomBlock }>();
  for (const b of blocks) for (const s of b.sentences) byId.set(s.id, { s, b });

  const block = lesson.blockId ? (blocks.find((b) => b.id === lesson.blockId) ?? null) : null;
  // 복습 레슨은 틀 카드를 건너뛴다
  const frame = lesson.kind === "new" && block ? { text: block.frame.text, slots: block.frame.slots } : null;
  const explainKo = lesson.kind === "new" && block ? block.explainKo : null;
  const speak = lesson.speakIds.flatMap((sid) => {
    const hit = byId.get(sid);
    // 판정 틀은 문장이 나온 블록의 틀(레슨이 블록 둘에 걸치거나 복습 레슨이어도 문장마다 맞는 틀로)
    return hit ? [{ id: sid, en: hit.s.en, ko: hit.s.ko, chunks: hit.s.chunks, frameText: hit.b.frame.text }] : [];
  });
  const listen = lesson.listenIds.flatMap((sid) => {
    const hit = byId.get(sid);
    return hit ? [{ id: sid, en: hit.s.en, ko: hit.s.ko }] : [];
  });
  if (speak.length === 0) notFound();

  const weekLabel = isMomVirtualWeek(lesson.week) ? "복습 주" : `${lesson.week}주차`;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <Link href="/mom" className="u-navbtn">← 엄마의 생활영어</Link>
      <p className="t-caption mt-3 text-ink-3">
        {lesson.kind === "review" ? "🔁 복습 레슨 · " : ""}
        {weekLabel} {lesson.day}일
      </p>
      <MomLessonRunner lesson={lesson} stage={stage} frame={frame} explainKo={explainKo} speak={speak} listen={listen} />
    </main>
  );
}
