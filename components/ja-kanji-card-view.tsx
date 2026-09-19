"use client";

/**
 * 한자 카드 (아빠의 일본어 JK, §12-5·§12-0) — 클라이언트. `約 — 약 — やく`를 **나란히**(한국 한자음이 다리).
 * 음독·훈독·뜻 + "내 단어장에서 이 한자가 든 단어들"(단어장으로 링크). 🔊는 표기(한자·단어)를 ja-JP로.
 * **훈독은 추측이 안 된다**는 안내를 넣는다(과신 방지, §12-0).
 */

import Link from "next/link";
import { useEffect } from "react";
import { prefetchSpeech, speak } from "@/lib/speech";
import type { JaKanjiCardData } from "@/lib/japanese-kanji-contract";
import s from "./ja-kanji-card-view.module.css";

function speakJa(text: string) {
  if (text.trim()) speak(text, "ja-JP");
}

export default function JaKanjiCardView({ data }: { data: JaKanjiCardData }) {
  const bridgeOn = data.onyomi[0] ?? null;
  // 프리페치(§16): 한자 + 이 한자가 든 단어들의 발음을 미리 캐시 → 🔊 첫 재생 지연 제거.
  useEffect(() => prefetchSpeech([data.kanji, ...data.words.map((w) => w.word)], "ja-JP"), [data]);

  return (
    <div className={s.wrap}>
      {/* 다리: 한자 — 한국 한자음 — 음독 */}
      <section className={s.bridgeCard}>
        <div className={s.bridge}>
          <span className={s.kanji} lang="ja">
            {data.kanji}
          </span>
          {data.hasInfo && (
            <>
              <span className={s.dash} aria-hidden>
                —
              </span>
              <span className={s.ko}>{data.koReading ?? "?"}</span>
              {bridgeOn && (
                <>
                  <span className={s.dash} aria-hidden>
                    —
                  </span>
                  <span className={s.on} lang="ja">
                    {bridgeOn}
                  </span>
                </>
              )}
            </>
          )}
          <button
            type="button"
            className={s.speak}
            onClick={() => speakJa(data.kanji)}
            aria-label={`${data.kanji} 발음 듣기`}
            title="발음 듣기"
          >
            🔊
          </button>
        </div>
        {data.hasInfo && (
          <p className={s.koHint}>한국 한자음 <b>{data.koReading ?? "—"}</b>이(가) 음독을 외우는 다리예요.</p>
        )}
      </section>

      {!data.hasInfo ? (
        <section className={s.noInfo}>
          <p className="t-lead">아직 이 한자의 정보가 없어요.</p>
          <Link href="/japanese/kanji" className="u-btn u-btn-primary">
            <span aria-hidden>✨</span> 한자 목록에서 정보 만들기
          </Link>
        </section>
      ) : (
        <section className={s.detail}>
          <dl className={s.rows}>
            <div className={s.row}>
              <dt className={s.label}>음독</dt>
              <dd className={s.value} lang="ja">
                {data.onyomi.length > 0 ? data.onyomi.join(" · ") : <span className={s.dim}>—</span>}
              </dd>
            </div>
            <div className={s.row}>
              <dt className={s.label}>훈독</dt>
              <dd className={s.value} lang="ja">
                {data.kunyomi.length > 0 ? data.kunyomi.join(" · ") : <span className={s.dim}>없음</span>}
              </dd>
            </div>
            <div className={s.row}>
              <dt className={s.label}>뜻</dt>
              <dd className={s.value}>{data.meaningKo || <span className={s.dim}>—</span>}</dd>
            </div>
          </dl>
          <p className={`t-caption ${s.kunNote}`}>
            ⚠️ <b>훈독은 추측이 안 돼요</b> — 음독은 한국 한자음으로 짐작해도, 훈독은 단어마다 외워야 해요.
          </p>
        </section>
      )}

      {/* 내 단어장에서 이 한자가 든 단어들 */}
      <section className={s.words}>
        <h2 className="t-section-title">이 한자가 든 내 단어</h2>
        {data.words.length === 0 ? (
          <p className={s.dim}>아직 없어요.</p>
        ) : (
          <ul className={s.wordList}>
            {data.words.map((w) => (
              <li key={`${w.bookId}-${w.word}`} className={s.wordRow}>
                <Link href={`/japanese/vocab/${w.bookId}`} className={s.wordLink} lang="ja">
                  {w.word}
                </Link>
                <button
                  type="button"
                  className={s.speak}
                  onClick={() => speakJa(w.word)}
                  aria-label={`${w.word} 발음 듣기`}
                >
                  🔊
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
