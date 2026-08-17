/**
 * 수학(수학코치) 홈 `/math` — **자리만 잡아 둔 화면**이다.
 *
 * 경로 확정이 이 파일의 목적이다. 수학 기능(문제집 판독 → 문제 선택 → 3막 설명 →
 * 되감기 플레이어)은 다른 에이전트가 `docs/harness/math.md`대로 붙인다.
 * 확정한 경로 규약:
 *
 *   화면  `/math`                 이 파일 — 사진 촬영·문제 직접 입력 진입점이 될 자리
 *         `/math/problem/[id]`    문제 1개의 3막 설명 + 되감기 플레이어(iframe)
 *         `/math/library`         수학 서재 (별도 작업 — 영어 `/library`는 건드리지 않는다)
 *   API   `/api/math/extract`     호출 A (문제 판독, vision)
 *         `/api/math/explain`     호출 B→C→장면 검산 파이프라인
 *         `/api/math/practice`    호출 D (연습문제)
 *
 * 잠금: `proxy.ts`는 허용목록(=`/unlock`·정적 자산) 밖을 전부 막으므로 이 경로도
 * 자동으로 PIN 게이트 안이다. 별도 등록이 필요 없다.
 *
 * 디자인: 새 스타일 없음 — `.u-navbtn` / `.u-box-accent` / `.u-btn` / `.t-*`만 쓴다.
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "수학코치 — 은우학습",
  description: "문제집 사진으로 왜 그렇게 푸는지 설명해 주는 수학 코치 (준비 중).",
};

export default function MathHomePage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="u-navbtn">
            ← 과목 선택
          </Link>
        </div>
        <h1 className="t-book-title mt-4">🔢 은우 수학코치</h1>
        <p className="t-lead mt-1">
          문제집 사진을 찍으면 &lsquo;왜 그렇게 푸는지&rsquo;를 아이 눈높이로 설명해요.
        </p>
      </header>

      <div className="u-box-accent">
        <p className="t-question-ko text-ink">🛠️ 아직 준비 중이에요</p>
        <p className="t-caption mt-1">
          지금은 자리만 잡아 두었어요. 곧 이 화면에서 문제집 사진을 찍을 수 있어요.
        </p>
      </div>

      <section className="mt-6">
        <h2 className="t-section-title">준비하고 있는 것</h2>
        <ul className="mt-3 flex flex-col gap-2">
          <li className="u-box t-question-ko">
            📷 문제집 페이지를 찍으면 문제를 하나씩 읽어 드려요
          </li>
          <li className="u-box t-question-ko">
            🎬 고른 문제를 &lsquo;탐정 시간 · 풀이 · 정리&rsquo; 3막으로 설명해요
          </li>
          <li className="u-box t-question-ko">
            ⏪ 풀이 과정을 앞뒤로 되감아 보는 그림 플레이어가 붙어요
          </li>
          <li className="u-box t-question-ko">
            ✅ 답은 두 번 검산해요. 확실하지 않으면 &lsquo;아빠가 확인해 주세요&rsquo;라고
            정직하게 알려요
          </li>
        </ul>
      </section>

      <div className="mt-8">
        <Link href="/english" className="u-btn u-btn-secondary">
          <span aria-hidden>📚</span> 그동안 영어 북카드 하러 가기
        </Link>
      </div>
    </main>
  );
}
