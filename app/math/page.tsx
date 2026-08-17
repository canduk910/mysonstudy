/**
 * 수학(수학코치) 홈 `/math` — 진입 버튼 두 개.
 *
 * 경로 규약(subject-routing에서 확정, 이 파일이 그 목록의 유지처):
 *   화면  `/math`                 이 파일 — 진입점
 *         `/math/new`             문제 직접 입력 → 3막 설명 (M1, **동작함**)
 *         `/math/problem/[id]`    저장된 설명 보기 (M4 — `explanations` 컬렉션이 생긴 뒤)
 *         `/math/library`         수학 서재 (별도 작업 — 영어 `/library`는 건드리지 않는다)
 *   API   `/api/math/explain`     호출 B→C→장면 검산 파이프라인 (M1, **동작함**)
 *         `/api/math/extract`     호출 A (문제집 사진 판독, vision) — M3
 *         `/api/math/practice`    호출 D (연습문제) — 이후
 *
 * 사진 입력(M3)이 아직 준비 중인 이유: 문제집 사진은 비공개 저장소(버킷)와 서명 URL,
 * 새 환경 변수가 함께 있어야 안전하게 다룰 수 있다. 그 인프라가 서기 전까지는
 * 버튼을 눌리지 않게 두는 편이 낫다 — 눌리는데 안 되는 버튼이 가장 나쁘다.
 *
 * 잠금: `proxy.ts`는 허용목록(=`/unlock`·정적 자산) 밖을 전부 막으므로 이 경로도,
 * `/math/new`도, `/api/math/explain`도 자동으로 PIN 게이트 안이다. 별도 등록이 필요 없다.
 *
 * 디자인: 새 스타일 없음 — `.u-entry*` / `.u-navbtn` / `.u-box` / `.t-*`만 쓴다.
 * 진입 버튼 규격은 영어 홈(`app/english/page.tsx`)과 같은 것을 그대로 재사용한다.
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "수학코치 — 은우학습",
  description: "문제를 3막(탐정 시간·되감기·다시 재생)으로 설명해 주는 수학 코치.",
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
          문제를 &lsquo;왜 그렇게 푸는지&rsquo; 아이 눈높이로 설명하고, 답은 두 번
          검산해요.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {/*
         * 동작하는 쪽을 주요(파랑)로 둔다. 영어 홈은 사진이 주요지만, 수학은 지금
         * 직접 입력만 동작하므로 그쪽이 화면의 주인공이다.
         */}
        <Link href="/math/new" className="u-entry u-entry-primary">
          <span className="u-entry-icon" aria-hidden>
            ✏️
          </span>
          <span className="u-entry-title">문제 직접 입력</span>
          <span className="u-entry-desc">
            문제 문장을 적으면 3막 설명을 만들어요. 은우가 쓴 답도 함께 봐 드려요.
          </span>
        </Link>

        {/*
         * 준비 중 — <button disabled>로 둔다. Link로 두면 눌리는데 아무 일도 일어나지
         * 않거나 404가 나서, 고장으로 보인다. disabled 버튼은 `.u-entry:disabled`가
         * 흐리게 처리하고 커서로도 알려준다.
         */}
        <button
          type="button"
          disabled
          aria-describedby="photo-soon"
          className="u-entry u-entry-secondary"
        >
          <span className="u-entry-icon" aria-hidden>
            📷
          </span>
          <span className="u-entry-title">문제집 사진으로</span>
          <span className="u-entry-desc">
            페이지를 찍으면 문제를 하나씩 읽어 드려요. 아직 준비 중이에요.
          </span>
        </button>
      </div>

      <p id="photo-soon" className="t-caption mt-3">
        📷 사진으로 읽기는 준비 중이에요. 지금은 문제를 직접 적어 주세요.
      </p>

      <section className="mt-10">
        <h2 className="t-section-title">설명은 이렇게 나와요</h2>
        <ul className="mt-3 flex flex-col gap-2">
          <li className="u-box t-question-ko">
            🔍 <b>1막 탐정 시간</b> — 누가, 무엇을, 어디로 옮겼는지부터 또렷하게
          </li>
          <li className="u-box t-question-ko">
            ⏪ <b>2막 되감기</b> — 끝 장면에서 거꾸로 되감으며 한 단계씩
          </li>
          <li className="u-box t-question-ko">
            ▶️ <b>3막 다시 재생</b> — 나온 답으로 문제를 다시 해 보며 검사
          </li>
          <li className="u-box t-question-ko">
            ⚠️ 답이 두 번 다르게 나오면 <b>답을 접고</b> &lsquo;아빠가 확인해
            주세요&rsquo;라고 정직하게 알려요
          </li>
        </ul>
      </section>

      <div className="mt-8">
        <Link href="/english" className="u-btn u-btn-secondary">
          <span aria-hidden>📚</span> 영어 북카드 하러 가기
        </Link>
      </div>
    </main>
  );
}
