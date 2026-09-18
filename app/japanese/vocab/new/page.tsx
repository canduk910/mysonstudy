/**
 * JLPT 단어장 만들기 `/japanese/vocab/new` (아빠의 일본어 J1, §8) — 서버 컴포넌트.
 *
 * 세 손잡이·생성·검토·저장은 클라이언트(`ja-vocab-new-flow`)가 한다. 이 서버 컴포넌트의 몫은 **상수(값) 공급**:
 * 레벨·주제 프리셋·개수 상한은 `lib/ai/japanese/schemas`에 있고(단일 정의처), 그 **값**을 화면에 직접 import하면
 * 클라 번들에 lib/ai(zod 등)가 샌다(§10). 그래서 서버가 읽어 props로 내려보낸다. 저장된 표제어(중복 표식용)도 여기서 수집.
 */

import type { Metadata } from "next";
import Link from "next/link";
import JaVocabNewFlow from "@/components/ja-vocab-new-flow";
import {
  JLPT_LEVELS,
  JA_VOCAB_TOPIC_PRESETS,
  JA_VOCAB_DEFAULT_COUNT,
  JA_INCLUDE_MAX,
  JA_INCLUDE_WORD_MAX,
} from "@/lib/ai/japanese/schemas";
import { normalizeJaWord } from "@/lib/ai/japanese/vocab";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "단어장 만들기 — 아빠의 일본어",
  description: "레벨과 주제를 골라 JLPT 단어장을 만들어요.",
};

export default async function JaVocabNewPage() {
  // "이미 있어요" 표식용 — 저장된 모든 단어장의 표기·읽기를 정규화해 모은다(진짜 dedup은 생성 라우트가 한다).
  const books = await getStore().listJaVocabBooks();
  const existing = new Set<string>();
  for (const b of books) {
    for (const e of b.entries) {
      if (e.word) existing.add(normalizeJaWord(e.word));
      if (e.kana) existing.add(normalizeJaWord(e.kana));
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/japanese/vocab" className="u-navbtn">
            ← 단어장 목록
          </Link>
        </div>
        <h1 className="t-book-title mt-4">✨ 단어장 만들기</h1>
        <p className="t-lead mt-1">레벨과 주제를 고르면 AI가 단어·읽기·뜻·예문을 만들어요.</p>
      </header>

      <JaVocabNewFlow
        levels={[...JLPT_LEVELS]}
        topicPresets={[...JA_VOCAB_TOPIC_PRESETS]}
        perLevelCount={JA_VOCAB_DEFAULT_COUNT}
        includeMax={JA_INCLUDE_MAX}
        includeWordMax={JA_INCLUDE_WORD_MAX}
        existingWords={[...existing]}
      />
    </main>
  );
}
