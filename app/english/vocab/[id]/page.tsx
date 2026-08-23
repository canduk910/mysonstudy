/**
 * 단어장 상세 `/english/vocab/[id]` (단어장 정복 V1·V2) — 서버 컴포넌트.
 *
 * 저장된 DAY 하나를 읽어 온다. `getStore()`를 직접 읽고, 없는 id도 열 수 없는 레코드도 같은
 * `notFound()`다(수학 `/math/problem/[id]`와 같은 규약) — 판정은 목록과 **같은 함수**
 * (`lib/vocabbook-record.ts`). 두 벌이 되면 "목록엔 보이는데 눌렀더니 500"이 돌아온다.
 *
 * **그리는 일은 클라이언트로 내려간다(V2).** 이 서버 컴포넌트는 데이터 로딩·404 판정과 정적
 * 헤더·푸터(서버에서 그려도 되는 Link)만 맡고, 표/카드 토글·이어읽기·TTS가 붙는 본문은
 * `components/vocabbook-view.tsx`(클라이언트)가 그린다 — 그쪽 상태가 전부 브라우저 것이라서다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import VocabbookView from "@/components/vocabbook-view";
import { MIN_QUIZ_WORDS } from "@/lib/vocab-quiz";
import { isRenderableVocabBook } from "@/lib/vocabbook-record";
import { getStore } from "@/lib/store";

// 저장 데이터는 요청 시점에 읽는다
export const dynamic = "force-dynamic";

interface VocabDetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: VocabDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getVocabBook(id);
  if (!record || !isRenderableVocabBook(record)) {
    return { title: "단어장을 찾을 수 없어요 — 은우 북카드" };
  }
  return { title: `${record.titleKo} — 은우 북카드` };
}

export default async function VocabDetailPage({ params }: VocabDetailPageProps) {
  const { id } = await params;
  const record = await getStore().getVocabBook(id);
  // 없는 id도, 열 수 없는 레코드도 같은 404 — 목록이 "예전 형식이라 열지 못한 단어장" 안내를 띄운다
  if (!record || !isRenderableVocabBook(record)) notFound();

  // 시험은 저장된 영영 정의에 의존한다(V4) — 보강 완료(enriched)일 때만 진입 버튼을 노출한다.
  // 시험 페이지(`/quiz`)와 **같은 게이트** — 정의 있는 단어가 5지선다를 만들 수 있는 5개(MIN_QUIZ_WORDS)
  // 이상이면 시험 가능. 버튼과 시험 페이지 기준을 하나로 둬 "버튼은 막혔는데 URL로는 되는" 어긋남을 막는다.
  const canQuiz = record.entries.filter((e) => e.definitionEn !== null).length >= MIN_QUIZ_WORDS;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/english/vocab" className="u-navbtn">
            ← 단어장 목록
          </Link>
          <p className="t-caption flex-none">{record.createdAt.slice(0, 10).replace(/-/g, ".")}</p>
        </div>
        <h1 className="t-book-title mt-4">{record.titleKo}</h1>
        <p className="t-lead mt-1">
          단어 {record.entries.length}개
          {record.dayLabel && record.dayLabel !== record.titleKo ? ` · ${record.dayLabel}` : ""}
        </p>
      </header>

      {/*
       * 표/카드 토글·스피커·이어읽기가 붙는 본문 (클라이언트, V2).
       * titleKo·dayLabel은 카드 모드 전면 오버레이의 컴팩트 chrome에서만 쓴다 —
       * 표 모드는 위 서버 헤더가 그대로 보인다(회귀 0).
       */}
      {/*
       * 시험 보기는 이제 본문 툴바(표/카드 토글과 한 줄)에서 canQuiz로 게이트한다.
       * per-DAY 오답노트·새 단어장·단어장 목록은 "단어장 정복" 랜딩(`/english/vocab`)으로 올렸다 —
       * 하단 액션행/푸터를 두지 않는다. 목록으로 돌아가는 길은 헤더의 "← 단어장 목록" 백링크.
       */}
      <VocabbookView
        id={record.id}
        entries={record.entries}
        titleKo={record.titleKo}
        dayLabel={record.dayLabel}
        canQuiz={canQuiz}
      />
    </main>
  );
}
