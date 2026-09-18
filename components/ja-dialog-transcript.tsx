"use client";

/**
 * 대화 전사 말풍선 (아빠의 일본어 J3) — 화자별 말풍선(듀오링고 화면 구조를 학습용으로 확장). 검토 화면·상세 공용.
 * 내 발화(me)엔 듀오링고 피드백(praise/tip) 배지를 붙인다. 후리가나는 ja-ruby, 🔊는 `speak(ja,"ja-JP")`.
 */

import JaRuby from "@/components/ja-ruby";
import { speak } from "@/lib/speech";
import type { JaDialogTurn } from "@/lib/japanese-dialog-contract";
import s from "./ja-dialog-transcript.module.css";

const SPEAKER_LABEL: Record<JaDialogTurn["speaker"], string> = {
  partner: "상대",
  me: "나",
  unknown: "?",
};

export default function JaDialogTranscript({ turns }: { turns: JaDialogTurn[] }) {
  return (
    <div className={s.wrap}>
      {turns.map((t, i) => (
        <div key={i} className={`${s.row} ${t.speaker === "me" ? s.rowMe : ""}`}>
          <div className={`${s.bubble} ${t.speaker === "me" ? s.bubbleMe : t.speaker === "unknown" ? s.bubbleUnknown : s.bubblePartner}`}>
            <div className={s.bubbleHead}>
              <span className={s.speaker}>{SPEAKER_LABEL[t.speaker]}</span>
              <button
                type="button"
                className={s.speak}
                onClick={() => t.ja.trim() && speak(t.ja, "ja-JP")}
                aria-label="발음 듣기"
                title="듣기"
              >
                🔊
              </button>
            </div>
            <JaRuby
              tokens={t.tokens.length > 0 ? t.tokens : [{ surface: t.ja, reading: null }]}
              className={s.ja}
            />
            {t.feedback && (
              <p className={`${s.feedback} ${t.feedback.kind === "praise" ? s.praise : s.tip}`}>
                {t.feedback.kind === "praise" ? "👍" : "💡"} {t.feedback.textKo}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
