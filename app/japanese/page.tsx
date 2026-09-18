/**
 * 아빠의 일본어 허브 `/japanese` — 서버 컴포넌트(정적). (스펙 §0-4·§8)
 *
 * 이 과목의 학습자는 은우가 아니라 **아빠**다(§0-1). 그래서 홈(`/`)에서 따로 들어오고, 은우 화면과 섞이지 않는다.
 * 허브는 **두 독립 기능을 나란히 세운 갈림길**일 뿐이다(영어 허브 `/english`가 북카드·단어장을 두 장으로 세우는 것과 같은 모양):
 *   - **JLPT 단어장**(`/japanese/vocab`) — 레벨·주제로 단어를 만들고 후리가나·TTS로 외운다(J1).
 *   - **대화 복습**(`/japanese/dialog`) — 듀오링고 스크린샷을 찍어 전사·해설로 복습한다(J3).
 * 한쪽이 비어 있어도 다른 쪽은 온전히 동작한다(§0-4). 기능은 하나도 갖지 않는다 — 고르기만 한다.
 *
 * 잠금: `proxy.ts`가 허용목록 밖을 전부 막으므로 이 경로도 자동으로 PIN 게이트 안이다(별도 등록 불필요).
 * 디자인: 새 스타일 없음 — `.u-entry*`/`.u-navbtn`/`.t-*`만 쓴다(수학 홈 `app/math/page.tsx`와 같은 헤더 방식).
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "아빠의 일본어 — 은우학습",
  description: "JLPT 단어장과 듀오링고 대화 복습으로 아빠가 일본어를 공부하는 곳.",
};

export default function JapaneseHubPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="u-navbtn">
            ← 과목 선택
          </Link>
        </div>
        <h1 className="t-book-title mt-4">🗾 아빠의 일본어</h1>
        <p className="t-lead mt-1">
          JLPT 단어장으로 어휘를 쌓고, 듀오링고 대화를 찍어 복습하고, 모은 한자를 한국 한자음으로 익혀요. 따로따로 써도 돼요.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/japanese/vocab" className="u-entry u-entry-primary">
          <span className="u-entry-icon" aria-hidden>
            🗂️
          </span>
          <span className="u-entry-title">JLPT 단어장</span>
          <span className="u-entry-desc">
            레벨(N1~N5)과 주제를 골라 단어를 만들고, 한자 위 후리가나·발음으로 외워요. 시험과 오답노트도 있어요.
          </span>
        </Link>

        <Link href="/japanese/dialog" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            💬
          </span>
          <span className="u-entry-title">대화 복습</span>
          <span className="u-entry-desc">
            듀오링고 대화 스크린샷을 찍으면 전사하고, 잘한 점·고칠 점·어휘를 짚어 복습하게 해줘요.
          </span>
        </Link>

        {/* 한자 — 단어장에서 파생되지만 화면은 독립(§12-1). 아랫줄 full-width로 두 기능과 시각 구분. */}
        <Link href="/japanese/kanji" className="u-entry u-entry-secondary sm:col-span-2">
          <span className="u-entry-icon" aria-hidden>
            🈳
          </span>
          <span className="u-entry-title">한자</span>
          <span className="u-entry-desc">
            단어장에서 모은 한자를 한국 한자음을 다리 삼아 익혀요. 음독·훈독·뜻과 한자 시험이 있어요.
          </span>
        </Link>
      </div>
    </main>
  );
}
