"use client";

/**
 * 대화 학습 해설 (아빠의 일본어 J4·J5) — 총평·잘한 점·고칠 점·어휘·다음 연습. 검토 화면(dialogId 없음)·상세(있음) 공용.
 * dialogId가 있으면 어휘마다 **"단어장에 담기"**(J5, "대화에서 모은 단어"로) 버튼을 붙인다. 후리가나 ja-ruby, 🔊 ja-JP.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import JaRuby from "@/components/ja-ruby";
import { speak } from "@/lib/speech";
import type { JaDialogAddWordResponse, JaDialogCoaching } from "@/lib/japanese-dialog-contract";
import s from "./ja-dialog-coaching-view.module.css";

function speakJa(text: string) {
  if (text.trim()) speak(text, "ja-JP");
}

type AddState = { phase: "idle" | "loading" | "added" | "dup" | "error"; msg?: string };

export default function JaDialogCoachingView({
  coaching,
  dialogId,
}: {
  coaching: JaDialogCoaching;
  /** 저장된 대화면 담기 버튼을 켠다(J5). 검토 단계(미저장)면 undefined */
  dialogId?: string;
}) {
  const router = useRouter();
  const [addStates, setAddStates] = useState<Record<number, AddState>>({});

  async function addWord(itemIndex: number) {
    if (!dialogId) return;
    if (addStates[itemIndex]?.phase === "loading") return;
    setAddStates((p) => ({ ...p, [itemIndex]: { phase: "loading" } }));
    try {
      const res = await fetch(`/api/japanese/dialog/${dialogId}/add-word`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemIndex }),
      });
      const data = (await res.json()) as JaDialogAddWordResponse;
      if (data.ok) {
        setAddStates((p) => ({ ...p, [itemIndex]: { phase: data.added ? "added" : "dup" } }));
        router.refresh();
      } else {
        setAddStates((p) => ({ ...p, [itemIndex]: { phase: "error", msg: data.messageKo } }));
      }
    } catch {
      setAddStates((p) => ({ ...p, [itemIndex]: { phase: "error", msg: "담지 못했어요." } }));
    }
  }

  return (
    <div className={s.wrap}>
      {coaching.summaryKo && (
        <section className={s.summary}>
          <h3 className={s.h}>총평</h3>
          <p className={s.summaryText}>{coaching.summaryKo}</p>
        </section>
      )}

      {coaching.goods.length > 0 && (
        <section>
          <h3 className={s.h}>👍 잘한 점</h3>
          <ul className={s.list}>
            {coaching.goods.map((g, i) => (
              <li key={i} className={s.good}>
                <span className={s.quote} lang="ja">
                  {g.quoteJa}
                </span>
                <span className={s.why}>{g.whyKo}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {coaching.fixes.length > 0 && (
        <section>
          <h3 className={s.h}>💡 고칠 점</h3>
          <ul className={s.list}>
            {coaching.fixes.map((f, i) => (
              <li key={i} className={s.fix}>
                <span className={s.fixOrig} lang="ja">
                  {f.originalJa}
                </span>
                <span className={s.arrow} aria-hidden>
                  ↓
                </span>
                <span className={s.fixBetter} lang="ja">
                  {f.betterJa}
                </span>
                <span className={s.why}>{f.whyKo}</span>
                {f.grammarKo && <span className={s.grammar}>문법: {f.grammarKo}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {coaching.items.length > 0 && (
        <section>
          <h3 className={s.h}>📖 어휘</h3>
          <ul className={s.list}>
            {coaching.items.map((it, i) => {
              const st = addStates[i];
              return (
                <li key={i} className={s.item}>
                  <div className={s.itemMain}>
                    <JaRuby
                      tokens={it.wordTokens.length > 0 ? it.wordTokens : [{ surface: it.word, reading: null }]}
                      className={s.itemWord}
                    />
                    <button type="button" className={s.speak} onClick={() => speakJa(it.word)} aria-label={`${it.word} 발음 듣기`}>
                      🔊
                    </button>
                    <span className={s.itemMeaning}>{it.meaningKo}</span>
                  </div>
                  {it.usageKo && <p className={s.itemUsage}>{it.usageKo}</p>}
                  {dialogId && (
                    <div className={s.itemAdd}>
                      {st?.phase === "added" ? (
                        <span className={s.added}>✓ 단어장에 담았어요</span>
                      ) : st?.phase === "dup" ? (
                        <span className={s.added}>이미 담겨 있어요</span>
                      ) : (
                        <button
                          type="button"
                          className="u-btn u-btn-secondary"
                          onClick={() => addWord(i)}
                          disabled={st?.phase === "loading"}
                        >
                          {st?.phase === "loading" ? "담는 중…" : "➕ 단어장에 담기"}
                        </button>
                      )}
                      {st?.phase === "error" && <span className={s.err}>{st.msg}</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {coaching.practice.length > 0 && (
        <section>
          <h3 className={s.h}>✏️ 다음 연습</h3>
          <ul className={s.list}>
            {coaching.practice.map((p, i) => (
              <li key={i} className={s.practice}>
                <JaRuby tokens={p.tokens.length > 0 ? p.tokens : [{ surface: p.ja, reading: null }]} className={s.practiceJa} />
                {p.ko && <span className={s.practiceKo}>{p.ko}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
