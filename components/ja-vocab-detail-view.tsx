"use client";

/**
 * 일본어 JLPT 단어장 상세 (아빠의 일본어 J1) — 클라이언트 컴포넌트.
 *
 * 서버(`app/japanese/vocab/[id]/page.tsx`)가 데이터·404를 맡고, 여기서 표기·예문을 **후리가나(ja-ruby)**로 그리고
 * 🔊는 **surface 원문을 `speak(text,"ja-JP")`**로 읽는다(루비는 읽히지 않는다 — §5). 제목은 인라인 수정(rename).
 * 학습자가 아빠(성인)라 은우 화면 톤을 그대로 베끼지 않는다 — 담백하게 정보를 촘촘히 보여준다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import JaRuby from "@/components/ja-ruby";
import TtsSpeedControl from "@/components/tts-speed-control";
import { speak } from "@/lib/speech";
import { JA_TITLE_MAX, type JaVocabEntry, type JlptLevel } from "@/lib/japanese-vocab-contract";
import type { JaVocabRenameResponse } from "@/lib/japanese-vocab-contract";
import s from "./ja-vocab-detail-view.module.css";

/** 일본어 발음 — surface 원문을 ja-JP로. 루비(reading)는 읽지 않는다(§5). */
function speakJa(text: string) {
  if (text.trim()) speak(text, "ja-JP");
}

export default function JaVocabDetailView({
  id,
  titleKo,
  levels,
  topic,
  entries,
}: {
  id: string;
  titleKo: string;
  levels: JlptLevel[];
  topic: string | null;
  entries: JaVocabEntry[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(titleKo);
  const [saving, setSaving] = useState(false);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  async function saveTitle() {
    const next = draft.trim();
    if (next === "" || next === titleKo) {
      setEditing(false);
      setDraft(titleKo);
      return;
    }
    setSaving(true);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/japanese/vocab/${id}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titleKo: next }),
      });
      const data = (await res.json()) as JaVocabRenameResponse;
      if (data.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setErrorKo(data.messageKo);
      }
    } catch {
      setErrorKo("이름을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={s.wrap}>
      {/* 제목 + 인라인 수정 */}
      <div className={s.titleRow}>
        {editing ? (
          <div className={s.titleEdit}>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={JA_TITLE_MAX}
              aria-label="단어장 이름"
              className={s.titleInput}
              autoFocus
            />
            <div className={s.titleBtns}>
              <button type="button" className="u-btn u-btn-primary" onClick={saveTitle} disabled={saving}>
                {saving ? "저장 중…" : "저장"}
              </button>
              <button
                type="button"
                className="u-btn u-btn-secondary"
                onClick={() => {
                  setEditing(false);
                  setDraft(titleKo);
                  setErrorKo(null);
                }}
                disabled={saving}
              >
                취소
              </button>
            </div>
          </div>
        ) : (
          <div className={s.titleView}>
            <h1 className="t-book-title">{titleKo}</h1>
            <button
              type="button"
              className="u-btn u-btn-secondary"
              onClick={() => setEditing(true)}
              aria-label="단어장 이름 수정"
            >
              <span aria-hidden>✏️</span> 이름
            </button>
          </div>
        )}
      </div>
      {errorKo && (
        <p role="alert" className={`${s.error}`}>
          {errorKo}
        </p>
      )}

      {/* 메타 — 레벨·주제·단어 수 + 읽기 속도 */}
      <div className={s.metaRow}>
        <span className="t-caption flex flex-wrap items-center gap-1.5">
          {levels.map((lv) => (
            <span key={lv} className="u-chip">
              {lv}
            </span>
          ))}
          {topic && <span className="u-chip">{topic}</span>}
          <span className="u-chip">단어 {entries.length}개</span>
        </span>
        <TtsSpeedControl />
      </div>

      {/* 단어 목록 */}
      <ul className={s.list}>
        {entries.map((e, i) => (
          <li key={i} className={s.card}>
            <div className={s.wordRow}>
              <JaRuby tokens={e.wordTokens.length > 0 ? e.wordTokens : [{ surface: e.word, reading: null }]} className={s.word} />
              <button
                type="button"
                className={s.speak}
                onClick={() => speakJa(e.word)}
                aria-label={`${e.word} 발음 듣기`}
                title="발음 듣기"
              >
                🔊
              </button>
              {e.level && <span className={`u-chip ${s.levelChip}`}>{e.level}</span>}
            </div>

            {/* 전체 읽기(가나) — 표기와 다를 때만 참고로 */}
            {e.kana && e.kana !== e.word && (
              <p className={s.kana} lang="ja">
                {e.kana}
              </p>
            )}

            {e.pos.length > 0 && (
              <p className={s.pos}>
                {e.pos.map((p) => (
                  <span key={p} className="u-chip">
                    {p}
                  </span>
                ))}
              </p>
            )}

            {e.meaningsKo.length > 0 && (
              <ol className={s.meanings}>
                {e.meaningsKo.map((m, k) => (
                  <li key={k} className={s.meaning}>
                    {e.meaningsKo.length > 1 && <span className={s.meaningNo}>{k + 1}.</span>}
                    {m}
                  </li>
                ))}
              </ol>
            )}

            {/* 예문 — 후리가나 + 🔊 + 한국어 번역 */}
            {e.example.ja && (
              <div className={s.example}>
                <div className={s.exampleHead}>
                  <button
                    type="button"
                    className={s.speak}
                    onClick={() => speakJa(e.example.ja)}
                    aria-label="예문 발음 듣기"
                    title="예문 듣기"
                  >
                    🔊
                  </button>
                  <JaRuby
                    tokens={e.example.tokens.length > 0 ? e.example.tokens : [{ surface: e.example.ja, reading: null }]}
                    className={s.exampleJa}
                  />
                </div>
                {e.example.ko && <p className={s.exampleKo}>{e.example.ko}</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
