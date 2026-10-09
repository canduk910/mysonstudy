/**
 * 엄마의 생활영어 주간 테스트 `/mom/test/[week]` — 서버 컴포넌트(설계 §5).
 * ⚠️ `force-dynamic` 필수 — 빠지면 빌드 때 빈 DB로 정적 고정된다.
 *
 * - 주 번호: 실제 주 1~52, 자동 감속 가상 복습 주 101~152(isMomTestWeek). 그 밖은 404.
 * - 그 주에 끝낸 테스트가 있으면 → 결과 화면(가장 늦게 끝낸 것).
 * - 없고 오늘 할 일(momToday)이 바로 이 주의 테스트면 → 테스트(문항 = momPickTestItems — 결정적, 다시 열어도 같은 문항).
 * - 둘 다 아니면 → 아직 열리지 않은 테스트 안내 + 홈으로(가상 주도 404가 아니다).
 * 화면 글자: 복습 주(실제 8·16… 또는 가상 10x주)는 "복습 주 테스트", 그 밖은 "N주차 테스트" — "107주차"라고 쓰지 않는다.
 * 교재 문장은 화면 코드에 없다 — 모두 가져온 파일(스토어)에서 온다.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import MomTestRunner, { type MomTestRunnerItem } from "@/components/mom-test-runner";
import { getStore } from "@/lib/store";
import { isFullMomTest, isMomTestWeek, isMomVirtualWeek, momPickTestItems, momStageOfWeek, momTestSize, momToday, MOM_REVIEW_WEEKS, MOM_VIRTUAL_WEEK_OFFSET } from "@/lib/mom-plan";
import type { MomTestRecord } from "@/lib/mom-contract";

export const dynamic = "force-dynamic";

export default async function MomTestPage({ params }: { params: Promise<{ week: string }> }) {
  const { week: raw } = await params;
  if (!/^\d{1,3}$/.test(raw)) notFound();
  const week = Number(raw);
  if (!isMomTestWeek(week)) notFound();

  const store = getStore();
  const [blocks, lessons, tests] = await Promise.all([store.listMomBlocks(), store.listMomLessons(), store.listMomTests()]);

  const isReview = isMomVirtualWeek(week) || MOM_REVIEW_WEEKS.includes(week);
  const title = isReview ? "🔁 복습 주 테스트" : `${week}주차 테스트`;

  // 문장 id → 화면 문항(문장이 나온 블록의 틀로 판정)
  const byId = new Map<string, MomTestRunnerItem>();
  for (const b of blocks) for (const s of b.sentences) byId.set(s.id, { id: s.id, en: s.en, ko: s.ko, frameText: b.frame.text });

  // 끝낸 테스트가 있으면 결과 화면(가장 늦게 끝낸 것)
  let done: MomTestRecord | null = null;
  for (const t of tests) {
    if (t.week !== week || !isFullMomTest(t)) continue;
    if (!done || (t.finishedAt as string) > (done.finishedAt as string) || (t.finishedAt === done.finishedAt && t.id > done.id)) done = t;
  }

  const head = (
    <>
      <Link href="/mom" className="u-navbtn">← 엄마의 생활영어</Link>
      <h1 className="t-section-title mt-3">{title}</h1>
    </>
  );

  if (done) {
    const items = done.items.map((it) => byId.get(it.sentenceId) ?? { id: it.sentenceId, en: "", ko: "(지금은 없는 문장)", frameText: "" });
    const stage = momStageOfWeek(isMomVirtualWeek(week) ? week - MOM_VIRTUAL_WEEK_OFFSET : week);
    return (
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        {head}
        <MomTestRunner week={week} stage={stage} items={items} saved={done} />
      </main>
    );
  }

  const today = momToday({ blocks, lessons, tests });
  if (today.kind !== "test" || today.week !== week) {
    return (
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        {head}
        <section className="u-card mt-4 p-6 text-center">
          <p className="text-2xl">🗓️</p>
          <p className="t-section-title mt-2">아직 이 테스트를 볼 차례가 아니에요</p>
          <p className="t-body mt-2 text-ink-2">그 주 레슨 4개를 다 끝내면 테스트가 열려요. 오늘 할 일은 홈에서 볼 수 있어요.</p>
          <Link href="/mom" className="u-btn u-btn-primary mt-6 w-full text-lg" style={{ minHeight: 56 }}>
            홈으로
          </Link>
        </section>
      </main>
    );
  }

  const ids = momPickTestItems({ week, blocks, lessons, size: momTestSize(today.stage) });
  const items = ids.flatMap((sid) => {
    const it = byId.get(sid);
    return it ? [it] : [];
  });
  if (items.length === 0) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      {head}
      <MomTestRunner week={week} stage={today.stage} items={items} saved={null} />
    </main>
  );
}
