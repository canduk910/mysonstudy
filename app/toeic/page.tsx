/**
 * 아빠의 영어 허브 `/toeic` — 서버 컴포넌트(정적). (docs/harness/toeic.md §0-3·§0-4·§8)
 *
 * 학습자는 은우가 아니라 **아빠**(토익스피킹 수험자)다(§0-1). 은우의 영어(`/english` — 북카드·단어장)와 경로·컬렉션·스트릭이
 * 전부 갈린다. 코드·경로 이름이 `toeic`인 이유는 `english`를 은우 북카드가 쓰고 있어서다(§0-3).
 * 허브는 **두 독립 기능을 나란히 세운 갈림길**일 뿐이다(일본어 허브와 같은 모양, §0-4):
 *   - **표현집**(`/toeic/sets`) — 표현 암기장 사진·파일 → 발화 포인트 카드 · 전체 듣기 · 표현 시험(T1·T2).
 *   - **모의고사**(`/toeic/mocks`) — AI가 새로 만든 11문항(T3 만들기·학습 보기, 응시·채점은 T4·T5).
 * 한쪽이 비어 있어도 다른 쪽은 온전히 동작한다. 기능은 하나도 갖지 않는다 — 고르기만 한다.
 *
 * 잠금: proxy.ts가 허용목록 밖을 전부 막으므로 자동으로 PIN 게이트 안이다. 셸은 일본어 방식(공통 레이아웃 없이 u-navbtn
 * "← 과목 선택" 헤더) — 은우 영어 셸(EnglishNav)을 쓰지 않는다(§8). 디자인: 새 스타일 없음(.u-entry*·.u-navbtn·.t-*).
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "아빠의 영어 — 은우학습",
  description: "토익스피킹 표현집(발화 포인트·전체 듣기·말하기 시험)과 모의고사로 아빠가 영어 말하기를 준비하는 곳.",
};

export default function ToeicHubPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="u-navbtn">
            ← 과목 선택
          </Link>
        </div>
        <h1 className="t-book-title mt-4">🎙️ 아빠의 영어</h1>
        <p className="t-lead mt-1">
          토익스피킹 준비 — 표현집으로 답변에 꺼내 쓸 표현을 쌓고, 모의고사로 실전처럼 말해 봐요. 따로따로 써도 돼요.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/toeic/sets" className="u-entry u-entry-primary">
          <span className="u-entry-icon" aria-hidden>
            📒
          </span>
          <span className="u-entry-title">표현집</span>
          <span className="u-entry-desc">
            표현 암기장을 찍거나 파일로 넣으면 표현마다 문항별 활용 문장·답변 틀·발음 팁을 붙여 줘요. 전체 듣기와 말하기 시험도 있어요.
          </span>
        </Link>

        <Link href="/toeic/mocks" className="u-entry u-entry-secondary">
          <span className="u-entry-icon" aria-hidden>
            🧑‍💼
          </span>
          <span className="u-entry-title">모의고사</span>
          <span className="u-entry-desc">
            AI가 새로 만든 11문항 — 모범답변·사진으로 공부하고, 지문 읽기부터 의견 말하기까지 실제 시간대로 연습해요.
          </span>
        </Link>
      </div>
    </main>
  );
}
