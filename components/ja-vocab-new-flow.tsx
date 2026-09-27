"use client";

/**
 * JLPT 단어장 만들기 흐름 (아빠의 일본어 J1, §8) — 클라이언트 컴포넌트.
 *
 * 세 손잡이(레벨 복수·주제·꼭 넣을 단어) → 생성(호출 A, 진행 표시) → **검토**(단어 + 못 넣은 포함 단어·걸러진 중복을
 * 사실대로) → 제목 정해 저장. 상수(레벨·주제 프리셋)는 **서버가 props로 내려준다**(클라 번들에 lib/ai가 새지 않게, §10).
 * 후리가나는 `ja-ruby`, 발음은 `speak(surface,"ja-JP")` 재사용(§5).
 *
 * 꼭 넣을 단어는 줄마다 **일본어 표기 또는 한국어 뜻**이다(2026-09-27, §0-2·§8). 줄 판별은 라우트 검증·배분 계획과 같은
 * `classifyJaIncludeLine`(lib/japanese-include.ts — import 0이라 클라에서 값으로 써도 안전)이 한다. 한국어 줄은 무엇으로
 * 바뀔지 아직 모르므로 "이미 있어요"를 달지 않고, 검토 화면이 `koConverted`("여권 → パスポート")·`koExcluded`("이미 있어서
 * 뺐어요")로 결과를 보여 준다. 거부된 줄의 칩 문구는 라우트 400 문구와 같은 `jaIncludeRejectReason`이 고른다
 * (여러 단어를 한 줄에 이어 쓴 줄은 "섞임"이 아니라 "한 줄에 하나씩" — QA 3회차 P3-D).
 *
 * 생성에 **성공해** 검토로 넘어가면 맨 위(실패 경고·매핑·"이미 있어서 뺐어요"·못 넣은 것)부터 보이게 스크롤을 올린다
 * — 폰에서는 만들기 버튼까지 내려온 스크롤이 그대로 남아 요약 상자가 고정 스트릭 헤더 뒤로 숨었다(P3-B). 저장 실패로
 * 검토에 되돌아올 때는 오류 문구가 아래에 뜨므로 스크롤하지 않는다.
 */

import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import JaRuby from "@/components/ja-ruby";
import { speak } from "@/lib/speech";
import { JA_TITLE_MAX } from "@/lib/japanese-vocab-contract";
import type {
  JaKoIncludeMapping,
  JaVocabEntry,
  JaVocabGenerateResponse,
  JaVocabPerLevelResult,
  JaVocabSaveResponse,
  JlptLevel,
} from "@/lib/japanese-vocab-contract";
import {
  classifyJaIncludeLine,
  jaIncludeRejectReason,
  normalizeKoInclude,
  type JaIncludeLang,
  type JaIncludeRejectReason,
} from "@/lib/japanese-include";
import s from "./ja-vocab-new-flow.module.css";

/** 입력 표기 정규화 — 서버(normalizeJaWord)와 같은 NFKC+공백제거. "이미 있어요" 판정용(진짜 dedup은 서버). */
function normJa(v: string): string {
  return v.normalize("NFKC").replace(/\s+/g, "");
}

/** 한자가 든 표기인가 — 매핑 줄에 읽기(かな)를 덧붙일지 정한다(가나 표기는 읽기가 곧 표기라 생략). */
const HAN = /\p{Script=Han}/u;

/** 꼭 넣을 단어 한 줄의 화면 상태. lang null = 섞임·나열·너무 김(만들기를 막는다 — 라우트도 400). */
interface IncludeLine {
  raw: string;
  lang: JaIncludeLang | null;
  /** lang이 null인 이유(표식 문구만 가른다 — 라우트 400 문구와 같은 함수). 받아들여진 줄이면 null */
  reason: JaIncludeRejectReason | null;
  /** 일본어 줄이 이미 다른 단어장에 있는가 — 알리기만 하고 막지 않는다(§2-0). 한국어 줄은 늘 false */
  exists: boolean;
  dup: boolean;
}

/** 거부된 줄의 칩 표식(짧게)과 title(이유). empty는 화면이 빈 줄을 건너뛰어 칩으로 오지 않지만 타입을 채운다. */
const REJECT_MARK: Record<JaIncludeRejectReason, string> = {
  empty: "빈 줄",
  listed: "한 줄에 하나씩",
  too_long: "너무 김",
  mixed: "섞임",
};
function rejectTitle(reason: JaIncludeRejectReason, wordMax: number): string {
  switch (reason) {
    case "listed":
      return "여러 단어를 한 줄에 이어 썼어요 — 줄을 바꿔 한 줄에 하나씩 적어 주세요";
    case "too_long":
      return `한 줄은 최대 ${wordMax}자예요`;
    case "empty":
      return "빈 줄이에요";
    case "mixed":
      return "일본어와 한국어(또는 숫자·영문·기호)가 한 줄에 섞였어요";
  }
}

/** 매핑 한 줄 "여권 → パスポート" (한자 표기면 읽기를 작게 덧붙인다). */
function MappingText({ m }: { m: JaKoIncludeMapping }) {
  return (
    <>
      <span lang="ko">{m.ko}</span>
      <span aria-hidden className={s.mapArrow}>
        →
      </span>
      <span className="sr-only">, 일본어로 </span>
      <b lang="ja">{m.word}</b>
      {HAN.test(m.word) && (
        <span className={s.mapKana} lang="ja">
          ({m.kana})
        </span>
      )}
    </>
  );
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

  // 생성 **성공**으로 검토에 들어온 횟수 — 이 값이 바뀔 때만 맨 위로 올린다(저장 실패로 되돌아올 때는 그대로 둔다).
  const [reviewEntry, setReviewEntry] = useState(0);
  const reviewHeadRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (reviewEntry === 0) return;
    // 그리기 전에 올려 스크롤된 검토 화면이 한 번 비치지 않게 한다. scrollY 0이면 sticky 스트릭 헤더가 문서 흐름 맨 위에
    // 제자리를 차지해 헤딩·요약 상자를 가리지 않는다. 헤딩 포커스는 화면 읽기용 — 스크롤은 이미 했으니 막는다.
    window.scrollTo(0, 0);
    reviewHeadRef.current?.focus({ preventScroll: true });
  }, [reviewEntry]);

  const existingSet = useMemo(() => new Set(existingWords), [existingWords]);

  // 꼭 넣을 단어 — 줄 단위 파싱(빈 줄 제거). 줄마다 일본어/한국어/거부를 판별하고 표식을 단다.
  const includeLines = useMemo(() => {
    const seen = new Set<string>();
    const out: IncludeLine[] = [];
    for (const rawLine of includeText.split("\n")) {
      const raw = rawLine.trim();
      if (raw === "") continue;
      const lang = classifyJaIncludeLine(raw);
      // 중복 키는 배분 계획(planIncludeDistribution)과 같은 기준이다 — 한국어 줄은 normalizeKoInclude(안쪽 공백 한 칸을
      // 남긴다: "여권 사진" ≠ "여권사진"), 일본어 줄은 normJa. 일본어·한국어는 서로 다른 칸이라 섞여 중복되지 않는다.
      const key = lang === "ko" ? `ko:${normalizeKoInclude(raw)}` : `ja:${normJa(raw)}`;
      const dup = seen.has(key);
      seen.add(key);
      out.push({
        raw,
        lang,
        reason: lang === null ? jaIncludeRejectReason(raw) : null,
        exists: lang === "ja" && existingSet.has(normJa(raw)),
        dup,
      });
    }
    return out;
  }, [includeText, existingSet]);

  const includeWords = includeLines.filter((l) => !l.dup).map((l) => l.raw);
  const includeTooMany = includeWords.length > includeMax;
  const includeHasRejected = includeLines.some((l) => l.lang === null);
  const includeHasTooLong = includeLines.some((l) => l.reason === "too_long");
  const includeHasListed = includeLines.some((l) => l.reason === "listed");
  const includeHasMixed = includeLines.some((l) => l.reason === "mixed" || l.reason === "empty");
  const includeHasKo = includeLines.some((l) => l.lang === "ko");
  const totalCount = selected.length * perLevelCount;
  const canGenerate = selected.length > 0 && !includeTooMany && !includeHasRejected && phase !== "generating";

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
        setReviewEntry((n) => n + 1); // 성공 경로에서만 — 검토 맨 위로(P3-B)
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
    // 실패 레벨의 missingIncludes는 "그 레벨에 배분됐던 꼭 넣을 단어 전부"다(계약) — 모델이 못 넣은 것과 이유가 달라
    // 실패 경고 안에서 따로 알리고, 아래 "이번엔 못 넣은 것"에는 성공 레벨 것만 모은다(두 번 적지 않는다).
    const failedIncludes = perLevel.filter((p) => p.failed && p.missingIncludes.length > 0);
    const missing = perLevel.filter((p) => !p.failed).flatMap((p) => p.missingIncludes);
    const koConverted = perLevel.flatMap((p) => p.koConverted);
    const koExcluded = perLevel.flatMap((p) => p.koExcluded);
    // filteredCount에는 koExcluded로 뺀 항목이 이미 들어 있다(계약 주석) — 따로 알리는 만큼 빼서 두 번 세지 않는다.
    const otherFiltered = Math.max(0, perLevel.reduce((n, p) => n + p.filteredCount, 0) - koExcluded.length);
    // 카드마다 "여권 →" 표식 — 매핑의 word는 그 레벨 entries에 실제로 남은 항목의 표기다(계약). 두 줄이 한 단어로 접혔으면 둘 다.
    const koFrom = new Map<string, string[]>();
    for (const p of perLevel) {
      for (const m of p.koConverted) {
        const key = `${p.level}|${m.word}`;
        koFrom.set(key, [...(koFrom.get(key) ?? []), m.ko]);
      }
    }
    return (
      <div className={s.wrap}>
        <h2 ref={reviewHeadRef} tabIndex={-1} className={`t-section-title ${s.reviewHead}`}>
          만든 단어를 확인해요
        </h2>

        {/* 사실 보고 — 지어낸 성공을 보여주지 않는다(§2-4) */}
        {failedLevels.length > 0 && (
          <div role="alert" className={s.warn}>
            <p className={s.warnLine}>
              ⚠️ {failedLevels.join("·")} 레벨은 만들지 못했어요. 저장 후 다시 만들거나, 지금 다시 시도할 수 있어요.
            </p>
            {failedIncludes.map((p) => (
              <p key={p.level} className={s.warnLine}>
                꼭 넣을 단어 {p.missingIncludes.length}개는 {p.level} 레벨이 실패해 넣지 못했어요:{" "}
                {p.missingIncludes.map((w, i) => (
                  <Fragment key={i}>
                    {i > 0 && ", "}
                    <b lang={classifyJaIncludeLine(w) === "ko" ? "ko" : "ja"}>{w}</b>
                  </Fragment>
                ))}{" "}
                — ‘손잡이 다시 고르기’에 적어 둔 그대로 남아 있어요.
              </p>
            ))}
          </div>
        )}
        {koConverted.length > 0 && (
          <div role="status" className={s.note}>
            <p className={s.noteHead}>한국어로 넣은 단어는 이렇게 바꿨어요</p>
            <ul className={s.mapList}>
              {koConverted.map((m, i) => (
                <li key={i} className={s.mapItem}>
                  <MappingText m={m} />
                </li>
              ))}
            </ul>
            <p className={s.noteSub}>원하던 단어가 아니면 ‘손잡이 다시 고르기’에서 일본어 표기로 적어 주세요.</p>
          </div>
        )}
        {koExcluded.length > 0 && (
          <div role="status" className={s.note}>
            <p className={s.noteHead}>이미 있어서 뺐어요:</p>
            <ul className={s.mapList}>
              {koExcluded.map((m, i) => (
                <li key={i} className={s.mapItem}>
                  <MappingText m={m} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {missing.length > 0 && (
          <p role="status" className={s.note}>
            꼭 넣으려던 단어 중 이번엔 못 넣은 것:{" "}
            {missing.map((w, i) => (
              <Fragment key={i}>
                {i > 0 && ", "}
                <b lang={classifyJaIncludeLine(w) === "ko" ? "ko" : "ja"}>{w}</b>
              </Fragment>
            ))}
          </p>
        )}
        {otherFiltered > 0 && (
          <p role="status" className={s.note}>
            {koExcluded.length > 0 ? "그 밖에 " : ""}이미 있거나 겹친 단어 {otherFiltered}개를 걸렀어요.
          </p>
        )}

        {genEntries.length === 0 ? (
          <p className={s.empty}>만들어진 단어가 없어요. 다시 시도해 주세요.</p>
        ) : (
          <>
            <p className="t-caption">{genEntries.length}개를 만들었어요. 마음에 들면 이름을 정하고 저장하세요.</p>
            <ul className={s.list}>
              {genEntries.map((e, i) => {
                const fromKo = e.level ? koFrom.get(`${e.level}|${e.word}`) : undefined;
                return (
                  <li key={i} className={s.card}>
                    <div className={s.wordRow}>
                      {fromKo && (
                        <span
                          className={`u-chip u-chip-accent ${s.fromKo}`}
                          lang="ko"
                          title={`한국어 ‘${fromKo.join("’·‘")}’에서 바꾼 단어예요`}
                        >
                          {fromKo.join(" · ")} →
                        </span>
                      )}
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
                );
              })}
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
        <p className="t-caption">
          일본어를 모르면 <b>한국어로 적어도 돼요</b>(예: 여권) — 그 레벨의 일본어 단어로 바꿔 넣어요. 한 줄에는 일본어나
          한국어 중 하나만 적어 주세요.
        </p>
        <textarea
          value={includeText}
          onChange={(e) => setIncludeText(e.target.value)}
          placeholder={"促す\n約束\n여권"}
          aria-label="꼭 넣을 단어(줄 단위 — 일본어 표기 또는 한국어 뜻)"
          rows={3}
          lang="ja"
          className={s.textarea}
        />
        {includeLines.length > 0 && (
          <div className={s.chipRow}>
            {includeLines.map((l, i) => {
              const bad = l.lang === null;
              return (
                <span
                  key={i}
                  className={`u-chip ${bad || l.dup ? s.includeBad : l.lang === "ko" ? s.includeKo : ""}`}
                  lang={l.lang === "ko" ? "ko" : "ja"}
                  title={
                    bad
                      ? rejectTitle(l.reason ?? "mixed", includeWordMax)
                      : l.dup
                        ? "중복"
                        : l.lang === "ko"
                          ? "이 뜻의 일본어 단어로 바꿔 넣어요"
                          : l.exists
                            ? "이미 다른 단어장에 있어요"
                            : ""
                  }
                >
                  {l.raw}
                  {l.lang === "ko" && !l.dup && <span className={s.includeMark}>한국어 → 일본어로</span>}
                  {l.exists && !l.dup && <span className={s.includeMark}>이미 있어요</span>}
                  {l.dup && <span className={s.includeMark}>중복</span>}
                  {bad && <span className={s.includeMark}>{REJECT_MARK[l.reason ?? "mixed"]}</span>}
                </span>
              );
            })}
          </div>
        )}
        {includeHasListed && (
          <p className={`t-caption ${s.error}`}>
            여러 단어를 한 줄에 이어 쓴 줄이 있어요 — 줄을 바꿔 한 줄에 하나씩 적어 주세요.
          </p>
        )}
        {includeHasMixed && (
          <p className={`t-caption ${s.error}`}>
            섞인 줄이 있어요 — 한 줄에는 일본어 표기나 한국어 뜻 중 하나만 적어 주세요(숫자·영문·기호는 빼 주세요).
          </p>
        )}
        {includeHasTooLong && (
          <p className={`t-caption ${s.error}`}>한 줄은 최대 {includeWordMax}자예요.</p>
        )}
        {includeHasKo && !includeHasMixed && !includeHasListed && (
          <p className="t-caption">한국어 줄은 무엇으로 바뀌었는지 만든 뒤 확인 화면에서 보여 드려요.</p>
        )}
        {includeTooMany && (
          <p className={`t-caption ${s.error}`}>꼭 넣을 단어는 일본어·한국어 합쳐 최대 {includeMax}개예요.</p>
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
