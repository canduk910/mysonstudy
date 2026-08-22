/**
 * 단어장 표 보기 `/english/vocab/[id]` (단어장 정복 V1) — 서버 컴포넌트.
 *
 * 저장된 DAY 하나를 **표 모드**로 그린다. `getStore()`를 직접 읽고, 없는 id도 열 수 없는
 * 레코드도 같은 `notFound()`다(수학 `/math/problem/[id]`와 같은 규약) — 판정은 목록과
 * **같은 함수**(`lib/vocabbook-record.ts`). 두 벌이 되면 "목록엔 보이는데 눌렀더니 500"이 돌아온다.
 *
 * **표만 그린다.** 카드 모드·단어/예문 TTS는 V2다(계획). 디자인은 새 CSS 없이
 * `t-vocab-*` 전역 토큰 + `.u-table` + `overflow-x-auto`만 쓴다(DESIGN, 표는 좁은 화면에서
 * 표만 가로 스크롤하고 페이지는 밀리지 않는다 — 수학 서재 통계표와 같은 장치).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  PART_OF_SPEECH_LABELS_KO,
  RELATED_KIND_LABELS_KO,
} from "@/lib/ai/english/vocabbook-schemas";
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
       * 표는 좁은 화면에서 표만 가로 스크롤 — 페이지는 밀리지 않는다(수학 서재 통계표와 같은 장치).
       * min-width를 주지 않으면 4열이 360px에 눌려 한글 뜻이 글자 단위로 세로로 쪼개진다
       * ("이 / 루 / 다"). 열마다 최소 폭을 박아 표가 스크롤되게 하고, 한글 칸은 keep-all로
       * 어절 단위 줄바꿈한다.
       */}
      <div className="overflow-x-auto">
        <table className="u-table" style={{ minWidth: 600 }}>
          <colgroup>
            <col style={{ width: 52 }} />
            <col style={{ width: 168 }} />
            <col style={{ width: 168 }} />
            <col style={{ width: 212 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="text-right">번호</th>
              <th scope="col">단어</th>
              <th scope="col">뜻</th>
              <th scope="col">예문</th>
            </tr>
          </thead>
          <tbody>
            {record.entries.map((entry, i) => (
              <tr key={i}>
                <td className="t-meta-chip whitespace-nowrap text-right align-top">
                  {entry.no ?? ""}
                </td>
                <td className="align-top">
                  <span className="t-vocab-word block break-words">{entry.word}</span>
                  {entry.ipa && <span className="t-vocab-pron block break-words">[{entry.ipa}]</span>}
                  {entry.pos.length > 0 && (
                    <span className="t-caption block">
                      {entry.pos.map((p) => PART_OF_SPEECH_LABELS_KO[p]).join(" · ")}
                    </span>
                  )}
                  {entry.related.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {entry.related.map((r, k) => (
                        <span key={k} className="u-chip">
                          {RELATED_KIND_LABELS_KO[r.kind]} {r.word}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="t-vocab-meaning align-top" style={{ wordBreak: "keep-all" }}>
                  {entry.meaningsKo.length > 0 ? (
                    <ol className="list-inside list-decimal">
                      {entry.meaningsKo.map((m, k) => (
                        <li key={k}>{m}</li>
                      ))}
                    </ol>
                  ) : (
                    <span className="t-caption">—</span>
                  )}
                </td>
                <td className="align-top" style={{ wordBreak: "keep-all" }}>
                  {entry.examples.length > 0 ? (
                    <ul className="flex flex-col gap-1.5">
                      {entry.examples.map((ex, k) => (
                        <li key={k} className="t-vocab-example">
                          {ex.en}
                          {ex.ko ? <span className="mt-0.5 block text-ink-3">{ex.ko}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="t-caption">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 flex flex-wrap gap-2">
        <Link href="/english/vocab/new" className="u-btn u-btn-secondary">
          <span aria-hidden>📷</span> 새 단어장 만들기
        </Link>
        <Link href="/english/vocab" className="u-btn u-btn-secondary">
          <span aria-hidden>📓</span> 단어장 목록
        </Link>
      </div>
    </main>
  );
}
