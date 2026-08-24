"use client";

/**
 * 챕터 리더 (호출 F · 챕터화, docs/harness/english.md §9) — 카드 화면에 붙는 섹션.
 *
 * 목차 챕터 제목 + 유튜브 낭독 자막이 둘 다 있는 책을 챕터별로 나눠, 챕터마다
 * **영어 원문 문장 + 그 아래 우리말 해석 + 영어 읽어주기(TTS)** 를 보여준다.
 *
 * 세 가지 상태를 한 컴포넌트가 그린다(카드 화면은 이 한 줄만 얹으면 된다):
 * - chapters 있음 → 리더(챕터 목록 → 문장들) + "다시 나누기"
 * - chapters 없지만 목차·자막 준비됨(canChapterize) → "📖 챕터로 나누기" 버튼
 * - 둘 다 아님 → 아무것도 그리지 않는다(회귀 0 — 목차/자막 없는 카드 화면은 그대로)
 *
 * ⚠️ 영어 원문 표시는 이 리더에 한해 허용된 것이다(§9 서두, 가족 전용 확정). 카드의 다른
 * 부분(줄거리·예문)은 여전히 원문을 옮기지 않는다.
 *
 * M1 스코프: 리더 + TTS까지. 단어 더블탭 뜻·단어장 추가는 M2다(여기서 만들지 않는다).
 * lib/store는 타입을 쓰지 않는다 — chapters는 부모(card-view)가 book에서 꺼내 넘긴다.
 * 발음은 lib/speech.ts가 단일 정의처다(카드 단어 스피커와 같은 목소리·속도).
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { Chapter } from "@/lib/ai/english/schemas";
import { speak, speakSequence } from "@/lib/speech";
import s from "./chapter-reader.module.css";

/** matched(내용 있음) 챕터 중 첫 번째를 기본 선택 — 없으면 0번 */
function firstMatchedIndex(chapters: readonly Chapter[]): number {
  const idx = chapters.findIndex((ch) => ch.matched && ch.sentences.length > 0);
  return idx >= 0 ? idx : 0;
}

/** 선택된 챕터 한 개의 본문(문장 목록 또는 "못 찾음" 안내) */
function ChapterBody({ chapter }: { chapter: Chapter }) {
  if (!chapter.matched || chapter.sentences.length === 0) {
    return (
      <p className={s.notFound}>
        이 챕터는 낭독 자막에서 찾지 못했어요. 영상이 이 챕터까지 닿지 않았거나 이 부분을 읽지 않았을 수 있어요.
      </p>
    );
  }
  return (
    <>
      <div className={s.chapterTools}>
        <button
          type="button"
          className={s.readAllBtn}
          onClick={() => speakSequence(chapter.sentences.map((sent) => sent.en))}
        >
          🔊 이 챕터 이어 읽기
        </button>
      </div>
      <ol className={s.sentences}>
        {chapter.sentences.map((sent, i) => (
          <li key={i} className={s.sentence}>
            <div className={s.enRow}>
              <p className={s.en} lang="en">
                {sent.en}
              </p>
              <button
                type="button"
                className={s.speak}
                aria-label="이 문장 영어로 듣기"
                title="영어로 듣기"
                onClick={() => speak(sent.en)}
              >
                🔊
              </button>
            </div>
            <p className={s.ko}>{sent.ko}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

/** 챕터가 있을 때의 리더(목록 + 본문) */
function Reader({
  chapters,
  onRechapterize,
  busy,
}: {
  chapters: Chapter[];
  onRechapterize: () => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState(() => firstMatchedIndex(chapters));
  // selected가 범위를 벗어나지 않게(챕터 수가 바뀌는 경우 대비) 안전하게 좁힌다
  const active = chapters[Math.min(selected, chapters.length - 1)] ?? chapters[0];
  const matchedCount = useMemo(() => chapters.filter((ch) => ch.matched).length, [chapters]);

  return (
    <div className={s.reader}>
      <p className={s.readerNote}>
        낭독 자막을 목차의 챕터별로 나눴어요. 챕터를 고르면 영어 원문과 우리말 해석을 함께 볼 수 있고,
        🔊로 영어를 들을 수 있어요. (챕터 {chapters.length}개 중 {matchedCount}개에 내용이 있어요.)
      </p>

      {/* 챕터 목록 — 가로 스크롤 탭. matched 아닌 챕터는 흐리게 */}
      <div className={s.tabs} role="tablist" aria-label="챕터 목록">
        {chapters.map((ch, i) => {
          const isActive = ch === active;
          const dim = !ch.matched || ch.sentences.length === 0;
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`${s.tab} ${isActive ? s.tabActive : ""} ${dim ? s.tabDim : ""}`}
              onClick={() => setSelected(i)}
            >
              <span className={s.tabNo}>{i + 1}</span>
              <span className={s.tabTitle} lang="en">
                {ch.titleEn}
              </span>
              {dim && <span className={s.tabDimMark}>내용 없음</span>}
            </button>
          );
        })}
      </div>

      {/* 선택된 챕터 본문 */}
      <div className={s.chapterPane}>
        <h4 className={s.chapterTitle} lang="en">
          {active.titleEn}
        </h4>
        <ChapterBody chapter={active} />
      </div>

      {/* 다시 나누기 — 자막·목차를 다시 넣을 필요 없이 book에 저장된 근거로 재호출 */}
      <div className={s.rechapterize}>
        <button type="button" className={s.rechapterizeBtn} onClick={onRechapterize} disabled={busy}>
          {busy ? "⏳ 다시 나누는 중…" : "🔀 다시 나누기"}
        </button>
      </div>
    </div>
  );
}

export default function ChapterReaderSection({
  bookId,
  chapters,
  canChapterize,
}: {
  bookId: string;
  /** 저장된 챕터화 결과(호출 F). null이면 아직 안 나눴거나 목차/자막이 없다 */
  chapters: Chapter[] | null;
  /** 목차(toc)와 낭독 자막이 둘 다 준비돼 챕터로 나눌 수 있는지 — 서버가 판정해 넘긴다 */
  canChapterize: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasChapters = !!chapters && chapters.length > 0;

  // 목차/자막도 없고 챕터도 없으면 섹션 자체를 그리지 않는다(회귀 0)
  if (!hasChapters && !canChapterize) return null;

  async function runChapterize() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/chapterize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; messageKo?: string }
        | null;
      if (res.ok && data?.ok) {
        // 서버 컴포넌트를 다시 읽어 book.chapters(새 결과)를 화면에 반영한다
        router.refresh();
        return;
      }
      setError(data?.messageKo ?? "챕터로 나누지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setError("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.section} aria-label="챕터별로 읽기">
      <h3 className={s.h3}>
        📖 챕터별로 읽기 <span className={s.h3en}>Chapter Reader</span>
      </h3>

      {hasChapters ? (
        <Reader chapters={chapters!} onRechapterize={runChapterize} busy={busy} />
      ) : (
        <div className={s.cta}>
          <p className={s.ctaText}>
            이 책은 목차와 유튜브 낭독 영상이 준비돼 있어요. 낭독 자막을 목차의 챕터별로 나눠,
            챕터마다 영어 원문과 우리말 해석을 함께 읽을 수 있어요.
          </p>
          <button type="button" className={s.ctaBtn} onClick={runChapterize} disabled={busy}>
            {busy ? "⏳ 챕터로 나누는 중…" : "📖 챕터로 나누기"}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
    </section>
  );
}
