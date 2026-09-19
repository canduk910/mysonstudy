"use client";

/**
 * 한자 목록 화면 (아빠의 일본어 JK, §12-5) — 클라이언트. 서버가 단어장에서 수집한 한자 목록을 받아
 * "정보 만들기"(호출 D)만 부른다. 정보 없는 한자는 흐리게. 각 한자는 카드로 링크. 훈독 추측 불가 안내(§12-0).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { prefetchSpeech, speak } from "@/lib/speech";
import type { JaKanjiEnrichResponse, JaKanjiListItem } from "@/lib/japanese-kanji-contract";
import s from "./ja-kanji-list-view.module.css";

export default function JaKanjiListView({ items }: { items: JaKanjiListItem[] }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const missingInfo = items.filter((it) => !it.hasInfo).length;
  // 프리페치(§16): 목록에 보이는 한자 발음을 미리 캐시 → 🔊 첫 재생 지연 제거.
  useEffect(() => prefetchSpeech(items.map((it) => it.kanji), "ja-JP"), [items]);

  async function enrich() {
    if (phase === "loading") return;
    setPhase("loading");
    setMessage(null);
    try {
      const res = await fetch("/api/japanese/kanji/enrich", { method: "POST" });
      const data = (await res.json()) as JaKanjiEnrichResponse;
      if (data.ok) {
        if (data.nothingToFill) {
          setMessage("모든 한자에 이미 정보가 있어요.");
        } else {
          const parts = [`${data.filled}자를 채웠어요`];
          if (data.missingKanji.length > 0) parts.push(`못 채운 한자: ${data.missingKanji.join(" ")}`);
          setMessage(parts.join(" · "));
        }
        setPhase("done");
        router.refresh();
      } else if (data.error === "no_api_key") {
        setMessage("API 키가 준비되면 한자 정보를 만들 수 있어요.");
        setPhase("error");
      } else {
        setMessage(data.messageKo);
        setPhase("error");
      }
    } catch {
      setMessage("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
      setPhase("error");
    }
  }

  return (
    <div className={s.wrap}>
      <p className={`t-caption ${s.hanNote}`}>
        💡 음독(音読み)은 한국 한자음으로 추측할 수 있어요. 하지만 <b>훈독(訓読み)은 추측이 안 돼요</b> — 외워야 해요.
      </p>

      {items.length === 0 ? (
        <p className={s.empty}>
          아직 수집된 한자가 없어요. <Link href="/japanese/vocab" className="u-link">단어장</Link>을 만들면 그 표기에서 한자가 모여요.
        </p>
      ) : (
        <>
          {missingInfo > 0 && (
            <div className={s.enrichRow}>
              <button type="button" className="u-btn u-btn-primary" onClick={enrich} disabled={phase === "loading"}>
                {phase === "loading" ? (
                  <>
                    <span aria-hidden>⏳</span> 만드는 중… (10자씩 조금 걸려요)
                  </>
                ) : (
                  <>
                    <span aria-hidden>✨</span> 정보 없는 한자 {missingInfo}자 만들기
                  </>
                )}
              </button>
            </div>
          )}
          {message && (
            <p role="status" className={`${s.msg} ${phase === "error" ? s.msgError : ""}`}>
              {message}
            </p>
          )}

          <ul className={s.list}>
            {items.map((it) => (
              <li key={it.kanji}>
                <Link
                  href={`/japanese/kanji/${encodeURIComponent(it.kanji)}`}
                  className={`${s.card} ${it.hasInfo ? "" : s.cardDim}`}
                >
                  <span className={s.kanji} lang="ja">
                    {it.kanji}
                  </span>
                  <span className={s.info}>
                    {it.hasInfo ? (
                      <>
                        <span className={s.bridge}>
                          {it.koReading && <b>{it.koReading}</b>}
                          {it.meaningKo && <span className={s.meaning}> · {it.meaningKo}</span>}
                        </span>
                        <span className={s.count}>단어 {it.wordCount}개</span>
                      </>
                    ) : (
                      <>
                        <span className={s.noInfo}>정보 없음</span>
                        <span className={s.count}>단어 {it.wordCount}개</span>
                      </>
                    )}
                  </span>
                  <button
                    type="button"
                    className={s.speak}
                    onClick={(e) => {
                      e.preventDefault();
                      speak(it.kanji, "ja-JP");
                    }}
                    aria-label={`${it.kanji} 발음 듣기`}
                  >
                    🔊
                  </button>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
