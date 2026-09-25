"use client";

/**
 * 표현 시험 진행 화면 (아빠의 영어 T2, docs/harness/toeic.md §6-1·§6-2) — 클라이언트 컴포넌트 두 개.
 *
 * - `ToeicChoiceRunner`: 5지선다 세 모드(뜻 → 표현 · 표현 → 뜻 · 빈칸) 혼합 세션.
 * - `ToeicSpeakRunner`: 말하기(한 → 영) — 우리말 문장 → 사용자가 말한다 → "정답 보기" → 모범 문장 표시·🔊 → ⭕/❌ **자기 채점**.
 *
 * 세션은 서버(`quiz/page.tsx`)가 lib/toeic-quiz의 순수 함수로 **조립해 넘긴다**(고정 — hydration 안전). 여기선 진행·피드백·
 * 발음·저장만 한다. 일본어 러너(ja-quiz-runner) 골격을 따르되 토익 전용으로 새로 둔다(§10 — 은우 vocab-quiz-view는 URL·문구·
 * TTS 언어가 박혀 있어 재사용하면 오염된다).
 *
 * ── 소리 규약(§6-1) ─────────────────────────────────────────────────────────────
 * **문제를 소리로 읽지 않는다**(표현을 읽으면 정답이 샌다 — 일본어 러너 관용구). 답을 고른 **뒤** 그 표현(말하기는 모범
 * 문장)을 `en-US`로 읽는다 — 탭 핸들러 안에서 부르므로 iOS 재생 잠금도 풀린다. 한국어를 영어 음성으로 읽지 않게 lang 명시.
 *
 * ── 저장(§6-2 무오염) ──────────────────────────────────────────────────────────
 * 혼합 세션은 `splitToeicItemsByMode`로 **모드별로 갈라** 모드마다 `POST /api/toeic/sets/[id]/quiz` 1건. 오답 재시험도 그 모드로
 * 저장해 재시도가 그 모드의 연속 정답을 밀어 올린다(졸업 성립). 저장에 성공하면 STREAK_REFRESH_EVENT(§17-4).
 * 일부 모드만 실패했을 때 "다시 저장"은 **실패한 모드만** 보낸다(useSessionSaver — 성공한 모드를 다시 보내면 거짓 졸업).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { prefetchSpeech, speak, stopSpeaking } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import { TOEIC_PART_BADGE_KO } from "@/lib/toeic-set-contract";
import type {
  ToeicChoiceQuestion,
  ToeicQuizMode,
  ToeicQuizSubmitRequest,
  ToeicQuizSubmitResponse,
  ToeicSpeakQuestion,
} from "@/lib/toeic-quiz-contract";
import { TOEIC_QUIZ_MODE_LABELS_KO, splitToeicItemsByMode, type ToeicAnsweredItem } from "@/lib/toeic-quiz";
import s from "./toeic-quiz.module.css";

/** 러너 피드백이 쓰는 표현 정보(서버가 entries에서 줄여 내린다) */
export interface ToeicQuizEntryInfo {
  expression: string;
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
  exampleSpan: string | null;
}

function speakEn(text: string | null | undefined) {
  const t = (text ?? "").trim();
  if (t) speak(t, "en-US");
}

/** 예문 속 구간 강조(대소문자 그대로 → 없으면 무시로 한 번 더) */
function highlight(example: string, span: string | null): ReactNode {
  if (!span) return example;
  let at = example.indexOf(span);
  if (at < 0) at = example.toLowerCase().indexOf(span.toLowerCase());
  if (at < 0) return example;
  return (
    <>
      {example.slice(0, at)}
      <mark className={s.span}>{example.slice(at, at + span.length)}</mark>
      {example.slice(at + span.length)}
    </>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";

/** 한 모드 POST 결과 — 네트워크 예외도 여기로 접는다(한 모드의 예외가 다른 모드의 성공 기록을 지우지 않게) */
type ModeSaveResult = { mode: ToeicQuizMode; ok: true } | { mode: ToeicQuizMode; ok: false; messageKo: string };

/**
 * 세션 저장 훅 — 모드별로 갈라 모드마다 POST(§6-2). 실패하면 "다시 저장"으로 재시도.
 *
 * **모드별 저장 성공을 기억한다**(`savedModesRef`, QA toeic_m1 P2-1). 혼합 세션의 POST 중 하나만 끊긴 뒤 "다시 저장"이 전 모드를
 * 다시 보내면 성공했던 모드 세션이 한 벌 더 쌓이고, 숙련도 집계(`aggregateWordStats`)가 한 번 맞힌 것을 **연속 2회 정답**으로
 * 세어 거짓 졸업이 난다(오답 재시험에서 빠짐·기록에 같은 세션 두 줄). 그래서 재시도는 **아직 저장되지 않은 모드만** 보낸다.
 * - 동시에 두 번 누르지 못하게 `savingRef`로 막는다(저장 중 재진입 금지).
 * - `finishedAt`은 첫 시도에서 정해 재시도에도 같은 값을 쓴다 — 한 세션의 모드별 레코드가 같은 끝 시각을 갖는다.
 * - 새로 저장된 모드가 하나라도 있으면 STREAK_REFRESH_EVENT(§17-4) — 서버의 스트릭은 그 순간 이미 바뀌었다.
 * startedAt은 마운트 후 1회(렌더 중 new Date()면 SSR↔CSR 불일치).
 */
function useSessionSaver(id: string) {
  const [startedAt, setStartedAt] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const savingRef = useRef(false);
  const savedModesRef = useRef<Set<ToeicQuizMode>>(new Set());
  const finishedAtRef = useRef<string | null | undefined>(undefined);
  useEffect(() => setStartedAt(new Date().toISOString()), []);

  async function postMode(mode: ToeicQuizMode, list: ToeicQuizSubmitRequest["items"], finishedAt: string | null): Promise<ModeSaveResult> {
    try {
      const body: ToeicQuizSubmitRequest = { mode, startedAt: startedAt || new Date().toISOString(), finishedAt, items: list };
      const res = await fetch(`/api/toeic/sets/${encodeURIComponent(id)}/quiz`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as ToeicQuizSubmitResponse | null;
      if (data?.ok) return { mode, ok: true };
      return { mode, ok: false, messageKo: data && !data.ok ? data.messageKo : "결과를 저장하지 못했어요." };
    } catch {
      return { mode, ok: false, messageKo: "연결이 끊겨 결과를 저장하지 못했어요." };
    }
  }

  async function submit(items: ToeicAnsweredItem[], complete: boolean) {
    if (savingRef.current) return;
    if (!items.some((it) => it.answered === true)) {
      setSaveState("idle");
      setSaveMsg("아직 푼 문항이 없어 저장하지 않았어요.");
      return;
    }
    const byMode = splitToeicItemsByMode(items);
    const pending = (Object.keys(byMode) as ToeicQuizMode[]).filter((m) => !savedModesRef.current.has(m));
    if (pending.length === 0) return; // 전부 저장됐다 — 다시 보내지 않는다
    savingRef.current = true;
    setSaveState("saving");
    setSaveMsg(null);
    if (finishedAtRef.current === undefined) finishedAtRef.current = complete ? new Date().toISOString() : null;
    const finishedAt = finishedAtRef.current;

    const results = await Promise.all(pending.map((m) => postMode(m, byMode[m] ?? [], finishedAt)));
    let newlySaved = 0;
    for (const r of results) {
      if (r.ok) {
        savedModesRef.current.add(r.mode);
        newlySaved += 1;
      }
    }
    savingRef.current = false;
    if (newlySaved > 0) window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT)); // 스트릭 헤드라인 즉시 갱신(§17-4)

    const failed = results.filter((r): r is Extract<ModeSaveResult, { ok: false }> => !r.ok);
    if (failed.length === 0) {
      setSaveState("saved");
      setSaveMsg(complete ? "시험 결과를 저장했어요!" : "여기까지 푼 결과를 저장했어요.");
      return;
    }
    setSaveState("error");
    const failedLabels = failed.map((r) => TOEIC_QUIZ_MODE_LABELS_KO[r.mode]).join(" · ");
    const savedSome = savedModesRef.current.size > 0;
    setSaveMsg(
      savedSome
        ? `${failedLabels} 결과만 저장하지 못했어요 — 나머지는 저장됐어요. '다시 저장'은 못 한 것만 보내요.`
        : failed[0].messageKo,
    );
  }

  return { submit, saveState, saveMsg };
}

function ResultsView({
  id,
  completed,
  isReview,
  correct,
  answered,
  saveState,
  saveMsg,
  onResave,
  retryHref,
}: {
  id: string;
  completed: boolean;
  isReview: boolean;
  correct: number;
  answered: number;
  saveState: SaveState;
  saveMsg: string | null;
  onResave: () => void;
  retryHref: string;
}) {
  const router = useRouter();
  return (
    <div className={s.wrap}>
      <div className={s.results}>
        <p className="t-caption">{completed ? (isReview ? "복습 끝!" : "시험 끝!") : "여기까지 풀었어요"}</p>
        <p className={s.scoreBig}>
          {correct} <span className={s.scoreSlash}>/</span> {answered}
        </p>
        <p className="t-lead">{answered > 0 ? `${answered}문제 중 ${correct}개를 맞혔어요.` : "푼 문제가 없어요."}</p>
        {saveState === "saving" ? (
          <p role="status" className={s.saveMsg}>
            결과를 저장하는 중이에요…
          </p>
        ) : saveMsg ? (
          <p role="status" className={`${s.saveMsg} ${saveState === "error" ? s.saveMsgError : ""}`}>
            {saveMsg}
            {saveState === "error" ? (
              <button type="button" className={s.retryBtn} onClick={onResave}>
                다시 저장
              </button>
            ) : null}
          </p>
        ) : null}
        <div className={s.resultActions}>
          <button
            type="button"
            className="u-btn u-btn-primary"
            onClick={() => router.push(`${retryHref}${retryHref.includes("?") ? "&" : "?"}t=${Date.now()}`)}
          >
            <span aria-hidden>🔁</span> 다시 풀기
          </button>
          <Link href={`/toeic/sets/${id}/wrong`} className="u-btn u-btn-secondary">
            <span aria-hidden>📕</span> 오답노트
          </Link>
          <Link href={`/toeic/sets/${id}/history`} className="u-btn u-btn-secondary">
            <span aria-hidden>📊</span> 시험 기록
          </Link>
          <Link href={`/toeic/sets/${id}`} className="u-btn u-btn-secondary">
            <span aria-hidden>📒</span> 표현집으로
          </Link>
        </div>
      </div>
    </div>
  );
}

function Progress({ titleKo, current, total, answered }: { titleKo: string; current: number; total: number; answered: boolean }) {
  const progress = total > 0 ? ((current + (answered ? 1 : 0)) / total) * 100 : 0;
  return (
    <>
      <div className={s.topRow}>
        <p className="t-caption">{titleKo}</p>
        <p className={s.counter} aria-live="polite">
          {current + 1} / {total}
        </p>
      </div>
      <div className={s.progressTrack} aria-hidden>
        <div className={s.progressFill} style={{ width: `${progress}%` }} />
      </div>
    </>
  );
}

// ===========================================================================
// 5지선다
// ===========================================================================

export function ToeicChoiceRunner({
  id,
  titleKo,
  questions,
  skipped,
  entries,
  retryHref,
  isReview,
}: {
  id: string;
  titleKo: string;
  questions: ToeicChoiceQuestion[];
  /** 출제 조건이 안 맞아 뺀 (표현, 모드) 수 — 사실대로 안내 */
  skipped: number;
  entries: ToeicQuizEntryInfo[];
  retryHref: string;
  isReview: boolean;
}) {
  const [answers, setAnswers] = useState<(boolean | null)[]>(() => new Array(questions.length).fill(null));
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<"quiz" | "results">("quiz");
  const [completed, setCompleted] = useState(false);
  const { submit, saveState, saveMsg } = useSessionSaver(id);

  useEffect(() => () => stopSpeaking(), []);
  // 문항이 바뀌면 이전 재생만 끊는다 — 문제는 자동 낭독하지 않는다(§6-1)
  useEffect(() => stopSpeaking(), [current, phase]);
  // 답한 뒤 읽을 표현을 미리 받아 둔다(재생은 안 한다)
  const prefetchKey = [...new Set(questions.map((q) => entries[q.entryIndex]?.expression.trim() ?? ""))].filter(Boolean).join("\u0001");
  useEffect(() => (prefetchKey ? prefetchSpeech(prefetchKey.split("\u0001"), "en-US") : undefined), [prefetchKey]);

  const total = questions.length;
  const answeredCount = answers.filter((a) => a !== null).length;
  const correctCount = answers.filter((a) => a === true).length;

  function collect(): ToeicAnsweredItem[] {
    return questions.map((q, i) => ({ mode: q.mode, key: q.key, correct: answers[i] === true, answered: answers[i] === null ? null : true }));
  }

  function choose(choice: string) {
    if (selected !== null) return;
    const q = questions[current];
    const isCorrect = choice === q.answer;
    setSelected(choice);
    setAnswers((prev) => {
      const next = [...prev];
      next[current] = isCorrect;
      return next;
    });
    speakEn(entries[q.entryIndex]?.expression ?? q.key); // 답한 뒤에만, 표현을 en-US로(§6-1)
  }

  function next() {
    stopSpeaking();
    if (current + 1 >= total) {
      setCompleted(true);
      setPhase("results");
      void submit(collect(), true);
      return;
    }
    setCurrent((c) => c + 1);
    setSelected(null);
  }

  function stop() {
    stopSpeaking();
    setCompleted(false);
    setPhase("results");
    void submit(collect(), false);
  }

  if (phase === "results") {
    return (
      <ResultsView
        id={id}
        completed={completed}
        isReview={isReview}
        correct={correctCount}
        answered={answeredCount}
        saveState={saveState}
        saveMsg={saveMsg}
        onResave={() => void submit(collect(), completed)}
        retryHref={retryHref}
      />
    );
  }

  const q = questions[current];
  const answered = selected !== null;
  const entry = entries[q.entryIndex];
  const promptLang = q.mode === "ko-to-expr" ? "ko" : "en";
  const choiceLang = q.mode === "expr-to-ko" ? "ko" : "en";

  return (
    <div className={s.wrap}>
      <Progress titleKo={titleKo} current={current} total={total} answered={answered} />
      {skipped > 0 && <p className={`t-caption ${s.skipped}`}>이 조건에서 낼 수 없는 문항 {skipped}개는 뺐어요.</p>}

      <div className={s.prompt}>
        <p className={s.promptLabel}>
          <span className={s.modeBadge}>{TOEIC_QUIZ_MODE_LABELS_KO[q.mode]}</span>
          {q.mode === "ko-to-expr" ? "이 뜻의 표현은?" : q.mode === "expr-to-ko" ? "이 표현의 뜻은?" : "빈칸에 들어갈 말은?"}
        </p>
        {/* 문제에는 듣기 버튼을 두지 않는다 — 표현을 읽어 주면 그게 곧 정답이다(§6-1) */}
        <p className={`${s.promptText} ${q.mode === "cloze" ? s.promptCloze : ""}`} lang={promptLang}>
          {q.prompt}
        </p>
        {q.promptSubKo && (
          <p className={s.promptSub} lang="ko">
            {q.promptSubKo}
          </p>
        )}
      </div>

      <div className={s.choices} role="group" aria-label="보기">
        {q.choices.map((choice) => {
          const isCorrectChoice = choice === q.answer;
          const isPicked = choice === selected;
          let stateClass = "";
          if (answered) {
            if (isCorrectChoice) stateClass = s.choiceCorrect;
            else if (isPicked) stateClass = s.choiceWrong;
            else stateClass = s.choiceDim;
          }
          return (
            <button
              key={choice}
              type="button"
              className={`${s.choice} ${stateClass}`}
              onClick={() => choose(choice)}
              disabled={answered}
              aria-pressed={isPicked}
              lang={choiceLang}
            >
              <span className={s.choiceText}>{choice}</span>
              {answered && isCorrectChoice ? <span aria-hidden className={s.mark}>○</span> : null}
              {answered && isPicked && !isCorrectChoice ? <span aria-hidden className={s.mark}>✕</span> : null}
            </button>
          );
        })}
      </div>

      {answered && entry ? (
        <div className={`${s.feedback} ${answers[current] ? s.feedbackCorrect : s.feedbackWrong}`} role="status">
          <div className={s.feedbackHead}>
            <span className={s.feedbackText}>{answers[current] ? "정답이에요! 🎉" : "아쉬워요"}</span>
            <button type="button" className={s.speaker} onClick={() => speakEn(entry.expression)} aria-label={`${entry.expression} 발음 듣기`}>
              🔊
            </button>
          </div>
          <p className={s.feedbackWord} lang="en">
            {entry.expression}
          </p>
          <p className={s.feedbackMeaning}>{entry.meaningKo}</p>
          {q.mode === "cloze" && entry.example && (
            <div className={s.feedbackExample}>
              <div className={s.enRow}>
                <p lang="en">{highlight(entry.example, entry.exampleSpan)}</p>
                <button type="button" className={s.speaker} onClick={() => speakEn(entry.example)} aria-label="예문 듣기">
                  🔊
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className={`t-caption ${s.hint}`}>보기를 골라 보세요.</p>
      )}

      <div className={s.actions}>
        <button type="button" className="u-btn u-btn-primary" onClick={next} disabled={!answered}>
          {current + 1 >= total ? "끝내기" : "다음 →"}
        </button>
        <button type="button" className="u-btn u-btn-secondary" onClick={stop}>
          그만하기
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// 말하기(자기 채점)
// ===========================================================================

export function ToeicSpeakRunner({
  id,
  titleKo,
  questions,
  retryHref,
  isReview,
}: {
  id: string;
  titleKo: string;
  questions: ToeicSpeakQuestion[];
  retryHref: string;
  isReview: boolean;
}) {
  const [answers, setAnswers] = useState<(boolean | null)[]>(() => new Array(questions.length).fill(null));
  const [current, setCurrent] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [phase, setPhase] = useState<"quiz" | "results">("quiz");
  const [completed, setCompleted] = useState(false);
  const { submit, saveState, saveMsg } = useSessionSaver(id);

  useEffect(() => () => stopSpeaking(), []);
  useEffect(() => stopSpeaking(), [current, phase]);
  const prefetchKey = questions.map((q) => q.answer.trim()).filter(Boolean).join("\u0001");
  useEffect(() => (prefetchKey ? prefetchSpeech(prefetchKey.split("\u0001"), "en-US") : undefined), [prefetchKey]);

  const total = questions.length;
  const answeredCount = answers.filter((a) => a !== null).length;
  const correctCount = answers.filter((a) => a === true).length;

  function collect(list: (boolean | null)[] = answers): ToeicAnsweredItem[] {
    return questions.map((q, i) => ({ mode: "speak", key: q.key, correct: list[i] === true, answered: list[i] === null ? null : true }));
  }

  function reveal() {
    setRevealed(true);
    speakEn(questions[current].answer); // 탭 안에서 — 모범 문장을 en-US로(§6-1)
  }

  function grade(ok: boolean) {
    const nextAnswers = [...answers];
    nextAnswers[current] = ok;
    setAnswers(nextAnswers);
    stopSpeaking();
    if (current + 1 >= total) {
      setCompleted(true);
      setPhase("results");
      void submit(collect(nextAnswers), true);
      return;
    }
    setCurrent((c) => c + 1);
    setRevealed(false);
  }

  function stop() {
    stopSpeaking();
    setCompleted(false);
    setPhase("results");
    void submit(collect(), false);
  }

  if (phase === "results") {
    return (
      <ResultsView
        id={id}
        completed={completed}
        isReview={isReview}
        correct={correctCount}
        answered={answeredCount}
        saveState={saveState}
        saveMsg={saveMsg}
        onResave={() => void submit(collect(), completed)}
        retryHref={retryHref}
      />
    );
  }

  const q = questions[current];
  return (
    <div className={s.wrap}>
      <Progress titleKo={titleKo} current={current} total={total} answered={false} />

      <div className={s.prompt}>
        <p className={s.promptLabel}>
          <span className={s.modeBadge}>{TOEIC_QUIZ_MODE_LABELS_KO.speak}</span>
          {q.source === "quiz" ? "교재 QUIZ" : q.part ? TOEIC_PART_BADGE_KO[q.part] : "활용 문장"}
        </p>
        <p className={s.promptText} lang="ko">
          {q.promptKo}
        </p>
        {q.hint && <span className="u-chip self-start">힌트 · {q.hint}</span>}
        {!revealed && <p className="t-caption">🎙️ 소리 내어 영어로 말해 본 뒤 정답을 확인하세요.</p>}
      </div>

      {revealed ? (
        <div className={`${s.feedback} ${s.feedbackReveal}`} role="status">
          <div className={s.enRow}>
            <p className={s.answerEn} lang="en">
              {q.answer}
            </p>
            <button type="button" className={s.speaker} onClick={() => speakEn(q.answer)} aria-label="모범 문장 듣기">
              🔊
            </button>
          </div>
          <p className={s.gradeAsk}>이렇게 말했나요?</p>
          <div className={s.gradeRow}>
            <button type="button" className={`u-btn ${s.gradeBtn} ${s.gradeOk}`} onClick={() => grade(true)}>
              ⭕ 말했어요
            </button>
            <button type="button" className={`u-btn ${s.gradeBtn} ${s.gradeNo}`} onClick={() => grade(false)}>
              ❌ 못 했어요
            </button>
          </div>
        </div>
      ) : (
        <div className={s.actions}>
          <button type="button" className="u-btn u-btn-primary" onClick={reveal}>
            정답 보기 🔊
          </button>
        </div>
      )}

      <div className={s.actions}>
        <button type="button" className="u-btn u-btn-secondary" onClick={stop}>
          그만하기
        </button>
      </div>
    </div>
  );
}
