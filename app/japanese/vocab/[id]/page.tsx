/**
 * JLPT 단어장 상세 `/japanese/vocab/[id]` (아빠의 일본어 J1) — 서버 컴포넌트.
 *
 * 저장된 단어장 하나를 읽어 클라이언트 상세 화면에 넘긴다. 데이터 로딩·404·렌더 판정만 맡고(기존 규약),
 * 표기·예문 후리가나·TTS·제목 수정은 클라이언트가 한다. 렌더 판정은 목록/rename과 **같은 함수**(lib/japanese-record).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import JaVocabDetailView from "@/components/ja-vocab-detail-view";
import { resolveJaGlyph } from "@/lib/ai/japanese/schemas";
import { isRenderableJaVocabBook } from "@/lib/japanese-record";
import { formatKstDate } from "@/lib/kst";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: DetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getStore().getJaVocabBook(id);
  if (!record || !isRenderableJaVocabBook(record)) {
    return { title: "단어장을 찾을 수 없어요 — 아빠의 일본어" };
  }
  return { title: `${record.titleKo} — 아빠의 일본어` };
}

export default async function JaVocabDetailPage({ params }: DetailPageProps) {
  const { id } = await params;
  const record = await getStore().getJaVocabBook(id);
  if (!record || !isRenderableJaVocabBook(record)) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <Link href="/japanese/vocab" className="u-navbtn">
            ← 단어장 목록
          </Link>
          <p className="t-caption flex-none">{formatKstDate(record.createdAt)}</p>
        </div>
      </header>

      <JaVocabDetailView
        id={record.id}
        titleKo={record.titleKo}
        levels={record.levels}
        topic={record.topic}
        entries={record.entries}
        // 글리프는 서버에서 계산해 내려준다(값 resolveJaGlyph는 lib/ai에 남고, 화면엔 JaGlyph 타입만 간다 — 번들 경계 §10)
        glyphs={record.entries.map((e) => resolveJaGlyph(e))}
      />
    </main>
  );
}
