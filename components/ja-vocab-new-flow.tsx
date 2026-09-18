"use client";

/**
 * JLPT 단어장 만들기 흐름 (아빠의 일본어 J1, §8) — 클라이언트 컴포넌트.
 *
 * 세 손잡이(레벨 복수·주제·꼭 넣을 단어) → 생성(호출 A, 진행 표시) → **검토**(단어 + 못 넣은 포함 단어·걸러진 중복을
 * 사실대로) → 제목 정해 저장. 상수(레벨·주제 프리셋)는 **서버가 props로 내려준다**(클라 번들에 lib/ai가 새지 않게, §10).
 * 후리가나는 `ja-ruby`, 발음은 `speak(surface,"ja-JP")` 재사용(§5).
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import JaRuby from "@/components/ja-ruby";
import { speak } from "@/lib/speech";
import { JA_TITLE_MAX } from "@/lib/japanese-vocab-contract";
import type {
  JaVocabEntry,
  JaVocabGenerateResponse,
  JaVocabPerLevelResult,
  JaVocabSaveResponse,
  JlptLevel,
} from "@/lib/japanese-vocab-contract";
import s from "./ja-vocab-new-flow.module.css";

/** 입력 표기 정규화 — 서버(normalizeJaWord)와 같은 NFKC+공백제거. "이미 있어요" 판정용(진짜 dedup은 서버). */
function normJa(v: string): string {
  return v.normalize("NFKC").replace(/\s+/g, "");
}

function speakJa(text: string) {
  if (text.trim()) speak(text, "ja-JP");
}

interface JaVocabNewFlowProps {
  /** 서버가 내려주는 상수(값) — 클라가 lib/ai를 직접 import하지 않게 props로 받는다 */
  levels: JlptLevel[];
  topicPresets: string[];
  perLevelCount: number;
  includeMax: number;
  includeWordMax: number;
  /** 저장된 모든 일본어 표제어(정규화됨) — "이미 있어요" 표식용 */
  existingWords: string[];
}

type Phase = "form" | "generating" | "review" | "saving";

export default function JaVocabNewFlow({
  levels,
  topicPresets,
  perLevelCount,
  includeMax,
  includeWordMax,
  existingWords,
}: JaVocabNewFlowProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<JlptLevel[]>([]);
  const [topic, setTopic] = useState("");
  const [includeText, setIncludeText] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [errorKo, setErrorKo] = useState<string | null>(null);

  // 생성 결과(검토용)
  const [genEntries, setGenEntries] = useState<JaVocabEntry[]>([]);
  const [perLevel, setPerLevel] = useState<JaVocabPerLevelResult[]>([]);
  const [model, setModel] = useState("");
  const [title, setTitle] = useState("");

  const existingSet = useMemo(() => new Set(existingWords), [existingWords]);

  // 꼭 넣을 단어 — 줄 단위 파싱(빈 줄 제거). 각 단어에 길이 초과·이미 있음 표식을 단다.
  const includeLines = useMemo(() => {
    const seen = new Set<string>();
    const out: { raw: string; norm: string; tooLong: boolean; exists: boolean; dup: boolean }[] = [];
    for (const rawLine of includeText.split("\n")) {
      const raw = rawLine.trim();
      if (raw === "") continue;
      const norm = normJa(raw);
      const dup = seen.has(norm);
      seen.add(norm);
      out.push({
        raw,
        norm,
        tooLong: raw.length > includeWordMax,
        exists: existingSet.has(norm),
        dup,
      });
    }
    return out;
  }, [includeText, includeWordMax, existingSet]);

  const includeWords = includeLines.filter((l) => !l.dup).map((l) => l.raw);
  const includeTooMany = includeWords.length > includeMax;
  const includeHasTooLong = includeLines.some((l) => l.tooLong);
  const totalCount = selected.length * perLevelCount;
  const canGenerate = selected.length > 0 && !includeTooMany && !includeHasTooLong && phase !== "generating";

  function toggleLevel(lv: JlptLevel) {
    setSelected((cur) => (cur.includes(lv) ? cur.filter((x) => x !== lv) : [...cur, lv]));
  }

  async function generate() {
    if (!canGenerate) return;
    setPhase("generating");
    setErrorKo(null);
    try {
      const body = { levels: selected, topic: topic.trim() || null, include: includeWords };
      const res = await fetch("/api/japanese/vocab/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as JaVocabGenerateResponse;
      if (data.ok) {
        setGenEntries(data.entries);
        setPerLevel(data.perLevel);
        setModel(data.model);
        setTitle(topic.trim() ? `${selected.join("·")} · ${topic.trim()}` : `${selected.join("·")} 단어`);
        setPhase("review");
      } else {
        setErrorKo(data.messageKo);
        setPhase("form");
      }
    } catch {
      setErrorKo("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
      setPhase("form");
    }
  }

  async function save() {
    if (phase === "saving" || genEntries.length === 0) return;
    const t = title.trim();
    if (t === "") {
      setErrorKo("단어장 이름을 입력해 주세요.");
      return;
    }
    setPhase("saving");
    setErrorKo(null);
    try {
      const body = {
        titleKo: t,
        topic: topic.trim() || null,
        levels: selected,
        entries: genEntries,
        model,
      };
      const res = await fetch("/api/japanese/vocab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as JaVocabSaveResponse;
      if (data.ok) {
        router.push(`/japanese/vocab/${data.id}`);
      } else {
        setErrorKo(data.messageKo);
        setPhase("review");
      }
    } catch {
      setErrorKo("저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
      setPhase("review");
    }
  }

  // ── 검토 화면 ────────────────────────────────────────────────────────────────
  if (phase === "review" || phase === "saving") {
    const failedLevels = perLevel.filter((p) => p.failed).map((p) => p.level);
    const missing = perLevel.flatMap((p) => p.missingIncludes);
    const filtered = perLevel.reduce((n, p) => n + p.filteredCount, 0);
    return (
      <div className={s.wrap}>
        <h2 className="t-section-title">만든 단어를 확인해요</h2>

        {/* 사실 보고 — 지어낸 성공을 보여주지 않는다(§2-4) */}
        {failedLevels.length > 0 && (
          <p role="alert" className={s.warn}>
            ⚠️ {failedLevels.join("·")} 레벨은 만들지 못했어요. 저장 후 다시 만들거나, 지금 다시 시도할 수 있어요.
          </p>
        )}
        {missing.length > 0 && (
          <p role="status" className={s.note}>
            꼭 넣으려던 단어 중 이번엔 못 넣은 것: <b lang="ja">{missing.join(", ")}</b>
          </p>
        )}
        {filtered > 0 && (
          <p role="status" className={s.note}>
            이미 있거나 겹친 단어 {filtered}개를 걸렀어요.
          </p>
        )}

        {genEntries.length === 0 ? (
          <p className={s.empty}>만들어진 단어가 없어요. 다시 시도해 주세요.</p>
        ) : (
          <>
            <p className="t-caption">{genEntries.length}개를 만들었어요. 마음에 들면 이름을 정하고 저장하세요.</p>
            <ul className={s.list}>
              {genEntries.map((e, i) => (
                <li key={i} className={s.card}>
                  <div className={s.wordRow}>
                    <JaRuby
                      tokens={e.wordTokens.length > 0 ? e.wordTokens : [{ surface: e.word, reading: null }]}
                      className={s.word}
                    />
                    <button
                      type="button"
                      className={s.speak}
                      onClick={() => speakJa(e.word)}
                      aria-label={`${e.word} 발음 듣기`}
                    >
                      🔊
                    </button>
                    {e.level && <span className={`u-chip ${s.levelChip}`}>{e.level}</span>}
                  </div>
                  {e.pos.length > 0 && (
                    <p className={s.pos}>
                      {e.pos.map((p) => (
                        <span key={p} className="u-chip">
                          {p}
                        </span>
                      ))}
                    </p>
                  )}
                  {e.meaningsKo.length > 0 && <p className={s.meaning}>{e.meaningsKo.join(", ")}</p>}
                  {e.example.ja && (
                    <p className={s.example}>
                      <JaRuby
                        tokens={e.example.tokens.length > 0 ? e.example.tokens : [{ surface: e.example.ja, reading: null }]}
                      />
                      {e.example.ko && <span className={s.exampleKo}>{e.example.ko}</span>}
                    </p>
                  )}
                </li>
              ))}
            </ul>

            <label className={s.titleLabel} htmlFor="ja-title">
              단어장 이름
            </label>
            <input
              id="ja-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={JA_TITLE_MAX}
              className={s.titleInput}
            />
          </>
        )}

        {errorKo && (
          <p role="alert" className={s.error}>
            {errorKo}
          </p>
        )}

        <div className={s.actions}>
          {genEntries.length > 0 && (
            <button type="button" className="u-btn u-btn-primary" onClick={save} disabled={phase === "saving"}>
              {phase === "saving" ? "저장 중…" : "이 단어장 저장"}
            </button>
          )}
          <button
            type="button"
            className="u-btn u-btn-secondary"
            onClick={() => {
              setPhase("form");
              setErrorKo(null);
            }}
            disabled={phase === "saving"}
          >
            <span aria-hidden>↩</span> 손잡이 다시 고르기
          </button>
        </div>
      </div>
    );
  }

  // ── 만들기 폼 ────────────────────────────────────────────────────────────────
  return (
    <div className={s.wrap}>
      {/* 손잡이 1 — 레벨(복수 선택) */}
      <section className={s.handle}>
        <h2 className="t-section-title">1. 레벨 고르기</h2>
        <p className="t-caption">여러 개 고를 수 있어요. 고른 레벨마다 {perLevelCount}개씩 만들어요.</p>
        <div role="group" aria-label="JLPT 레벨" className={s.levelGroup}>
          {levels.map((lv) => (
            <button
              key={lv}
              type="button"
              onClick={() => toggleLevel(lv)}
              aria-pressed={selected.includes(lv)}
              className={`u-btn ${s.levelBtn} ${selected.includes(lv) ? "u-btn-primary" : "u-btn-secondary"}`}
            >
              {lv}
            </button>
          ))}
        </div>
        <p className={`t-caption ${s.countHint}`}>
          {selected.length === 0
            ? "레벨을 하나 이상 골라 주세요."
            : `${selected.join("·")} — 모두 ${totalCount}개를 만들어요.`}
        </p>
      </section>

      {/* 손잡이 2 — 주제 */}
      <section className={s.handle}>
        <h2 className="t-section-title">2. 주제 (선택)</h2>
        <p className="t-caption">상황을 고르면 그 상황의 단어로 묶어요. 안 고르면 레벨 전반에서 골라요.</p>
        <div className={s.chipRow}>
          {topicPresets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setTopic((cur) => (cur === p ? "" : p))}
              aria-pressed={topic === p}
              className={`u-chip ${s.topicChip} ${topic === p ? s.topicChipOn : ""}`}
            >
              {p}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="직접 입력 (예: 공항, 병원)"
          aria-label="주제 직접 입력"
          className={s.textInput}
        />
      </section>

      {/* 손잡이 3 — 꼭 넣을 단어 */}
      <section className={s.handle}>
        <h2 className="t-section-title">3. 꼭 넣을 단어 (선택)</h2>
        <p className="t-caption">
          한 줄에 하나씩, 표기만 적으면 돼요 — <b>읽기·뜻은 AI가 채워요.</b> 나머지는 AI가 골라 {perLevelCount}개를 채워요.
        </p>
        <textarea
          value={includeText}
          onChange={(e) => setIncludeText(e.target.value)}
          placeholder={"促す\n約束\n…"}
          aria-label="꼭 넣을 단어(줄 단위)"
          rows={3}
          lang="ja"
          className={s.textarea}
        />
        {includeLines.length > 0 && (
          <div className={s.chipRow}>
            {includeLines.map((l, i) => (
              <span
                key={i}
                className={`u-chip ${l.tooLong || l.dup ? s.includeBad : ""}`}
                lang="ja"
                title={l.tooLong ? "너무 길어요" : l.dup ? "중복" : l.exists ? "이미 다른 단어장에 있어요" : ""}
              >
                {l.raw}
                {l.exists && !l.dup && <span className={s.includeMark}>이미 있어요</span>}
                {l.dup && <span className={s.includeMark}>중복</span>}
                {l.tooLong && <span className={s.includeMark}>너무 김</span>}
              </span>
            ))}
          </div>
        )}
        {includeTooMany && (
          <p className={`t-caption ${s.error}`}>꼭 넣을 단어는 최대 {includeMax}개예요.</p>
        )}
      </section>

      {errorKo && (
        <p role="alert" className={s.error}>
          {errorKo}
        </p>
      )}

      <div className={s.actions}>
        <button type="button" className="u-btn u-btn-primary" onClick={generate} disabled={!canGenerate}>
          {phase === "generating" ? (
            <>
              <span aria-hidden>⏳</span> 만드는 중… (레벨마다 조금 걸려요)
            </>
          ) : (
            <>
              <span aria-hidden>✨</span> 단어 만들기
            </>
          )}
        </button>
      </div>
    </div>
  );
}
