/**
 * 엄마의 생활영어 `/mom` — 서버 컴포넌트(설계 §6-2). 오늘의 레슨·진도 지도.
 * ⚠️ `force-dynamic` 필수 — 빠지면 빌드 때 빈 DB로 정적 고정된다(store를 읽는 페이지의 관용구).
 * 교재 문장은 화면 코드에 없다 — 모두 가져온 파일(스토어)에서 온다.
 */
import Link from "next/link";
import MomHome from "@/components/mom-home";
import { getStore } from "@/lib/store";
import { momProgress, momToday } from "@/lib/mom-plan";

export const dynamic = "force-dynamic";

export default async function MomPage() {
  const store = getStore();
  const [blocks, lessons, tests] = await Promise.all([store.listMomBlocks(), store.listMomLessons(), store.listMomTests()]);
  const today = momToday({ blocks, lessons, tests });
  const progress = momProgress({ blocks, lessons, tests });
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <Link href="/" className="u-navbtn">← 과목 선택</Link>
      <h1 className="t-book-title mt-3">👩 엄마의 생활영어</h1>
      <p className="t-lead">소리 블록으로 하루 한 레슨 — 듣고, 따라 하고, 말해 봐요.</p>
      <MomHome today={today} progress={progress} hasContent={blocks.length > 0} />
    </main>
  );
}
