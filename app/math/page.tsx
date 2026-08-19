/**
 * 수학(수학코치) 홈 `/math` — 진입 버튼 두 개 + 지난 문제(M4) 진입.
 *
 * 경로 규약(subject-routing에서 확정, 이 파일이 그 목록의 유지처):
 *   화면  `/math`                 이 파일 — 진입점
 *         `/math/new`             문제 직접 입력 → 3막 설명 (M1, **동작함**)
 *         `/math/photo`           문제집 사진 판독 → 문제 고르기 → 3막 설명 (M3, **동작함**)
 *         `/math/problem/[id]`    저장된 설명 보기 (M4, **동작함**)
 *         `/math/library`         수학 서재 — 목록 + 유형별 통계 (M4, **동작함**)
 *   API   `/api/math/explain`     호출 B→C→장면 검산 파이프라인 + 설명 자동 저장 (M1·M4, **동작함**)
 *         `/api/math/explanations/[id]`  저장된 설명 삭제 (M4, **동작함**)
 *         `/api/math/extract`     호출 A (문제집 사진 판독, vision) — M3, **동작함**
 *         `/api/math/practice`    호출 D (연습문제) — 이후
 *
 * 사진 입력(M3)에 버킷은 필요 없었다. 이 주석은 오래 "비공개 저장소(버킷)와 서명 URL,
 * 새 환경 변수가 함께 있어야 한다"고 적어 두었는데 **과한 전제였고, 그 전제가 M3을 계속
 * 미루게 했다.** 영어 표지 판독(`/api/extract`)이 이미 같은 일을 버킷 없이 한다 —
 * 클라이언트에서 리사이즈해 base64 data URL로 보내고, 판독에만 쓰고 저장하지 않는다.
 * 근거와 경위는 `docs/harness/math.md` §11-2에 있다.
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
        {/* 과목 선택 ↔ 수학 홈 ↔ 지난 문제 — 영어 홈과 같은 알약 버튼(.u-navbtn) */}
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="u-navbtn">
            ← 과목 선택
          </Link>
          <Link href="/math/library" className="u-navbtn">
            <span aria-hidden>🧮</span> 지난 문제
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
         * [M3] 사진이 주요(파랑)가 됐다. 영어 홈과 같은 배치다 — 소마 사고력수학은 도형·규칙
         * 찾기가 많아 **그림은 타이핑으로 옮길 수단이 아예 없다.** 평소 쓰는 길이 이쪽이다.
         * 직접 입력은 사진이 잘 안 읽힐 때의 확실한 뒷길로 남는다.
         */}
        <Link href="/math/photo" className="u-entry u-entry-primary">
          <span className="u-entry-icon" aria-hidden>
            📷
          </span>
          <span className="u-entry-title">문제집 사진으로</span>
          <span className="u-entry-desc">
            페이지를 찍으면 문제를 하나씩 읽어 드려요. 그중 설명이 필요한 문제만 고르면 돼요.
          </span>
        </Link>

        <Link href="/math/new" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            ✏️
          </span>
          <span className="u-entry-title">문제 직접 입력</span>
          <span className="u-entry-desc">
            문제 문장을 적으면 3막 설명을 만들어요. 은우가 쓴 답도 함께 봐 드려요.
          </span>
        </Link>
      </div>

      <p className="t-caption mt-3">
        📷 사진은 한 번에 한 페이지씩 읽어요. 은우가 쓴 답과 채점 표시도 함께 찾아 드려요.
      </p>

      {/*
       * 지난 문제 보기(M4) — 만든 설명은 이제 자동으로 남는다. 헤더의 알약 버튼과 같은
       * 곳으로 가지만, 진입 타일 바로 아래에도 한 번 더 둔다: 설명을 만든 직후 돌아온
       * 사람이 가장 먼저 찾는 것이 "방금 그거 어디 갔지?"다.
       */}
      <div className="mt-6">
        <Link href="/math/library" className="u-btn u-btn-secondary">
          <span aria-hidden>🧮</span> 지난 문제 보기
        </Link>
      </div>

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
            ⚠️ 답이 두 번 다르게 나오면 <b>답을 접고</b> &lsquo;엄빠가 확인해
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
