"use client";

/**
 * 👀 틀 시험 한 판 (docs/harness/toeic.md §12-13-2, SPEC §20-10) — 클라이언트 컴포넌트. 문항은 서버 페이지가 한 번 조립해 넘긴다(고정 — hydration 안전).
 *
 * - 모드 셋 — 한→영 고르기(한국어 틀 ~ → 영어 틀 ~ 5지선다), 영→뜻 고르기(영어 틀 ~ → 한국어 틀 ~), 빈칸 채우기(영어 틀의 고정 낱말 하나를
 *   가린 문제 → 낱말 5지선다, 자리 이름은 칩으로 보인다 — 빈칸 낱말의 단서). 문항 머리에 모드 칩. 판 안에서 모드별로 묶여 나온다(서버 조립).
 * - **문제를 소리로 읽지 않는다**(영어를 읽으면 정답이 샌다 — §6-1 소리 규칙). 답을 고르면 정답·오답 색을 보이고 **영어 틀을 en-US로 읽는다**
 *   (cleanGuideEnForTts(frameEn) — 자리는 "…", 탭 핸들러 안에서 동기로 speakQueue — iOS 재생 잠금). 그 아래 틀 줄과 예문 한 줄(🔊 — 탭만).
 *   멈출 때는 큐가 돌려준 stop만(stopSpeaking 금지 — 다른 🔊를 죽이지 않게). 문항을 열 때 소리를 내지 않으므로 "시작" 탭이 따로 없다.
 * - 프리페치: 열리면 이 판 문항의 영어 틀 정리 글(최대 20)과 예문 영어(최대 20) — 합 40(상한 90 안).
 * - **저장 — 모드마다 한 건**(buildTemplateChoiceSessionBodies — 답한 문항만, 답한 문항이 0인 모드는 보내지 않는다): 기존 라우트
 *   `POST /api/toeic/guides/templates/sessions`. clientSessionId는 마운트 때 모드마다 UUID 하나씩, startedAt은 모두 같다. 일부가 실패하면
 *   "다시 저장"이 같은 키로 **전부** 다시 보낸다(이미 저장된 모드는 서버가 reused:true로 접는다 — 거짓 졸업 없음). 저장되면 STREAK_REFRESH_EVENT.
 *   화면을 떠나면(언마운트·pagehide 비캐시) 판정한 문항을 keepalive로 저장한다(best-effort — 멱등 키라 두 번 가도 한 벌, templateTestLeaveSave 규칙).
 * - 끝 화면(그만두기도 같은 화면 — 답한 문항만): 모드마다 ○ n / 전체, 틀린 틀(틀 줄 + 한국어 틀 + "🧩 카드로" → ② 그 카드), 모드마다
 *   "틀린 틀만 다시 · {모드} n", "다시 풀기", "폴더로".
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FrameLine } from "@/components/toeic-template-lines";
import { prefetchSpeech, speakQueue } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import { cleanGuideEnForTts } from "@/lib/toeic-guide";
import type { ToeicGuidePart, ToeicTemplateChoiceMode, ToeicTemplateSessionResponse } from "@/lib/toeic-guide-contract";
import { slotToneMap, toeicGuideFolderHref, toeicTemplateChoiceQuizHref } from "@/lib/toeic-guide-view";
import { TOEIC_TEMPLATE_CHOICE_MODES, TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO } from "@/lib/toeic-quiz";
import { frameSlotNames, splitFrameForDisplay } from "@/lib/toeic-template";
import { buildTemplateChoiceSessionBodies, type ToeicTemplateChoiceQuestion } from "@/lib/toeic-template-quiz";
import { newTemplateSessionId, templateTestLeaveSave } from "@/lib/toeic-template-test-view";
import { TTS_TEXT_MAX_CHARS } from "@/lib/tts-shared";
import { splitForTts } from "@/lib/tts-split";
import { TOEIC_TEMPLATE_CHOICE_MODE_SHORT_KO } from "./toeic-template-quiz-tab";
import q from "./toeic-quiz.module.css";
import s from "./toeic-template-quiz.module.css";

type SaveState = "idle" | "saving" | "saved" | "error";

const SESSIONS_URL = "/api/toeic/guides/templates/sessions";

/** 영어 한 덩어리 → 큐 조각(300자 넘으면 문장 단위로) */
function enItems(text: string): { text: string; lang: string }[] {
  return splitForTts(text, TTS_TEXT_MAX_CHARS)
    .filter((t) => t.trim() !== "")
    .map((t) => ({ text: t, lang: "en-US" }));
}

/** 틀 글(자리 `{…}`)을 자리 이름 칩과 함께 — 빈칸 문제의 앞·뒤 글(고정 부분은 굵게 하지 않는다 — 문장으로 읽게) */
function SlotText({ text }: { text: string }) {
  return (
    <>
      {splitFrameForDisplay(text).map((g, i) =>
        g.name === null ? (
          <span key={i}>{g.text}</span>
        ) : (
          <span key={i} className={s.slotName}>
            {g.name}
          </span>
        ),
      )}
    </>
  );
}

const MODE_ASK_KO: Record<ToeicTemplateChoiceMode, string> = {
  "tpl-ko-frame": "이 뜻의 영어 틀은?",
  "tpl-frame-ko": "이 틀의 뜻은?",
  "tpl-cloze": "빈칸에 들어갈 낱말은?",
};

export default function ToeicTemplateQuiz({
  part,
  scopeLabelKo,
  questions,
  skipped,
  backHref,
  retryHref,
}: {
  part: ToeicGuidePart;
  scopeLabelKo: string;
  questions: ToeicTemplateChoiceQuestion[];
  /** 출제 조건이 안 맞아 뺀 (틀, 모드) 수 */
  skipped: number;
  backHref: string;
  retryHref: string;
}) {
  const total = questions.length;
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<(string | null)[]>(() => new Array(questions.length).fill(null));
  const [stage, setStage] = useState<"run" | "done">("run");
  const [completed, setCompleted] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // ── 세션 키·시작 시각(마운트 뒤 한 번 — 렌더 중 난수·시각은 SSR과 갈린다) ──
  const sessionIdsRef = useRef<Record<ToeicTemplateChoiceMode, string> | null>(null);
  const startedAtRef = useRef("");
  const finishedAtRef = useRef<string | null | undefined>(undefined);
  const savingRef = useRef(false);
  const savedRef = useRef(false);
  const pickedRef = useRef(picked);
  const stageRef = useRef(stage);
  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);
  useEffect(() => {
    sessionIdsRef.current = {
      "tpl-ko-frame": newTemplateSessionId(),
      "tpl-frame-ko": newTemplateSessionId(),
      "tpl-cloze": newTemplateSessionId(),
    };
    startedAtRef.current = new Date().toISOString();
  }, []);

  // ── 소리(큐가 돌려준 stop만) ──
  const runRef = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);
  const stopSound = useCallback(() => {
    runRef.current++;
    const st = stopRef.current;
    stopRef.current = null;
    st?.();
  }, []);
  /** ⚠️ 탭 핸들러 안에서 **동기로** 부른다(await·setTimeout 금지 — iOS 재생 잠금) */
  function play(text: string) {
    const items = enItems(text);
    if (items.length === 0) return;
    const run = ++runRef.current;
    stopRef.current = null;
    const stop = speakQueue(items, {
      onEnd: () => {
        if (runRef.current === run) stopRef.current = null;
      },
    });
    if (runRef.current === run) stopRef.current = stop;
  }

  // 프리페치 — 영어 틀 정리 글(≤20)·예문 영어(≤20). 키는 문자열(참조 변경으로 재시작하지 않게)
  const prefetchKey = useMemo(() => {
    const texts = [
      ...questions.map((x) => cleanGuideEnForTts(x.frameEn)),
      ...questions.map((x) => x.example?.en.trim() ?? ""),
    ].flatMap((t) => splitForTts(t, TTS_TEXT_MAX_CHARS));
    return [...new Set(texts.filter((t) => t.trim() !== ""))].join("\u0001");
  }, [questions]);
  useEffect(() => {
    if (!prefetchKey) return;
    return prefetchSpeech(prefetchKey.split("\u0001"), "en-US");
  }, [prefetchKey]);

  // ── 저장(모드마다 한 건) ──
  const buildBodies = useCallback(
    (finishedAt: string | null) =>
      buildTemplateChoiceSessionBodies({
        answers: questions.flatMap((x, i) => (pickedRef.current[i] === null ? [] : [{ mode: x.mode, key: x.key, correct: pickedRef.current[i] === x.answer }])),
        sessionIds: sessionIdsRef.current ?? { "tpl-ko-frame": "", "tpl-frame-ko": "", "tpl-cloze": "" },
        startedAt: startedAtRef.current || new Date().toISOString(),
        finishedAt,
      }),
    [questions],
  );

  async function save(complete: boolean) {
    if (savingRef.current || savedRef.current) return;
    if (finishedAtRef.current === undefined) finishedAtRef.current = complete ? new Date().toISOString() : null;
    const bodies = buildBodies(finishedAtRef.current);
    if (bodies.length === 0) {
      setSaveState("idle");
      setSaveMsg("답한 문항이 없어 저장하지 않았어요.");
      return;
    }
    savingRef.current = true;
    setSaveState("saving");
    setSaveMsg(null);
    const results = await Promise.all(
      bodies.map(async (body) => {
        try {
          const res = await fetch(SESSIONS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const data = (await res.json().catch(() => null)) as ToeicTemplateSessionResponse | null;
          return data?.ok ? ({ ok: true, reused: data.reused } as const) : ({ ok: false, messageKo: data && !data.ok ? data.messageKo : "결과를 저장하지 못했어요." } as const);
        } catch {
          return { ok: false, messageKo: "연결이 끊겨 결과를 저장하지 못했어요." } as const;
        }
      }),
    );
    savingRef.current = false;
    const failed = results.filter((r) => !r.ok);
    if (results.some((r) => r.ok)) {
      try {
        window.dispatchEvent(new Event(STREAK_REFRESH_EVENT));
      } catch {
        /* noop */
      }
    }
    if (failed.length === 0) {
      savedRef.current = true;
      setSaveState("saved");
      setSaveMsg(results.every((r) => r.ok && r.reused) ? "이미 저장된 결과예요." : complete ? "결과를 저장했어요." : "여기까지 푼 결과를 저장했어요.");
      return;
    }
    setSaveState("error");
    const first = failed[0];
    setSaveMsg(`${!first.ok ? first.messageKo : "결과를 저장하지 못했어요."} '다시 저장'은 같은 판을 한 번 더 보내요(이미 저장된 방식은 한 번만 남아요).`);
  }

  function finish(complete: boolean) {
    stopSound();
    setCompleted(complete);
    setStage("done");
    void save(complete);
  }

  // ── 고르기(탭) — 정답·오답 색 + 영어 틀 소리(탭 안에서 동기로) ──
  function choose(choice: string) {
    if (picked[index] !== null) return;
    const cur = questions[index];
    const next = picked.map((p, i) => (i === index ? choice : p));
    pickedRef.current = next;
    setPicked(next);
    play(cleanGuideEnForTts(cur.frameEn));
  }

  function goNext() {
    stopSound();
    if (index + 1 >= total) finish(true);
    else setIndex(index + 1);
  }

  // ── 화면을 떠날 때: 판정한 문항을 keepalive로(best-effort — 멱등 키라 두 번 가도 한 벌), 소리 정리 ──
  const leaveSaveRef = useRef<() => void>(() => {});
  useEffect(() => {
    leaveSaveRef.current = () => {
      const plan = templateTestLeaveSave({
        stage: stageRef.current,
        saved: savedRef.current,
        saving: savingRef.current,
        answered: pickedRef.current.filter((p) => p !== null).length,
        hasSessionId: sessionIdsRef.current !== null,
        finishedAt: finishedAtRef.current,
      });
      if (plan === null) return;
      savedRef.current = true;
      for (const body of buildBodies(plan.finishedAt)) {
        try {
          void fetch(SESSIONS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
        } catch {
          /* best-effort */
        }
      }
    };
  }, [buildBodies]);
  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) leaveSaveRef.current(); // bfcache로 되살아날 수 있는 이탈이면 저장하지 않는다(이어서 풀 수 있다)
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);
  useEffect(
    () => () => {
      leaveSaveRef.current();
      runRef.current++;
      const st = stopRef.current;
      stopRef.current = null;
      st?.();
    },
    [],
  );

  // ── 끝 화면 ──
  if (stage === "done") {
    const answered = questions.map((x, i) => ({ x, p: picked[i] })).filter((r) => r.p !== null);
    const correct = answered.filter((r) => r.p === r.x.answer).length;
    const wrongs = answered.filter((r) => r.p !== r.x.answer).map((r) => r.x);
    const modesHere = TOEIC_TEMPLATE_CHOICE_MODES.filter((m) => answered.some((r) => r.x.mode === m));
    return (
      <div className={q.wrap} data-testid="tpl-quiz-done">
        <div className={q.results}>
          <p className="t-caption">{completed ? "틀 시험 끝!" : "여기까지 풀었어요"}</p>
          <p className={q.scoreBig}>
            {correct} <span className={q.scoreSlash}>/</span> {answered.length}
          </p>
          <div className={s.modeScore}>
            {modesHere.map((m) => {
              const rows = answered.filter((r) => r.x.mode === m);
              return (
                <span key={m} className="u-chip">
                  {TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO[m]} ○ {rows.filter((r) => r.p === r.x.answer).length} / {rows.length}
                </span>
              );
            })}
          </div>
          {saveState === "saving" ? (
            <p role="status" className={q.saveMsg}>
              결과를 저장하는 중이에요…
            </p>
          ) : saveMsg ? (
            <p role="status" className={`${q.saveMsg} ${saveState === "error" ? q.saveMsgError : ""}`}>
              {saveMsg}
              {saveState === "error" ? (
                <button type="button" className={q.retryBtn} onClick={() => void save(completed)}>
                  다시 저장
                </button>
              ) : null}
            </p>
          ) : null}
        </div>

        {wrongs.length > 0 && (
          <section className={s.box} aria-label="틀린 틀">
            <p className={s.boxTitle}>📕 틀린 틀 {wrongs.length}</p>
            <ul className={s.list}>
              {wrongs.map((x) => {
                const tones = slotToneMap(frameSlotNames(x.frameEn));
                const ko = x.mode === "tpl-frame-ko" ? x.answer : x.prompt;
                return (
                  <li key={`${x.mode}-${x.key}`} className={s.item}>
                    <p className={s.itemEn} lang="en">
                      <FrameLine frame={x.frameEn} tones={tones} lang="en" />
                    </p>
                    <p className={s.itemKo}>{ko}</p>
                    <div className={s.itemFoot}>
                      <span className="u-chip">{TOEIC_TEMPLATE_CHOICE_MODE_SHORT_KO[x.mode]}</span>
                      <Link href={toeicGuideFolderHref(part, { tab: "templates", tpl: x.key })} className={s.cardLink}>
                        🧩 카드로
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className={s.startRow}>
              {TOEIC_TEMPLATE_CHOICE_MODES.filter((m) => wrongs.some((x) => x.mode === m)).map((m) => (
                <Link
                  key={m}
                  href={`${toeicTemplateChoiceQuizHref(part, { modes: [m], scope: "wrong", wrong: m })}&t=${Date.now()}`}
                  className="u-btn u-btn-secondary"
                >
                  틀린 틀만 다시 · {TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO[m]} {wrongs.filter((x) => x.mode === m).length}
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className={q.resultActions}>
          <Link href={`${retryHref}${retryHref.includes("?") ? "&" : "?"}t=${Date.now()}`} className="u-btn u-btn-primary">
            <span aria-hidden>🔁</span> 다시 풀기
          </Link>
          <Link href={backHref} className="u-btn u-btn-secondary">
            폴더로
          </Link>
        </div>
      </div>
    );
  }

  // ── 문항 ──
  const cur = questions[index];
  const choice = picked[index];
  const answered = choice !== null;
  const isRight = answered && choice === cur.answer;
  const tones = slotToneMap(frameSlotNames(cur.frameEn));
  const promptLang = cur.mode === "tpl-ko-frame" ? "ko" : "en";
  const choiceLang = cur.mode === "tpl-frame-ko" ? "ko" : "en";
  const koTilde = cur.mode === "tpl-frame-ko" ? cur.answer : cur.prompt;
  const progress = total > 0 ? ((index + (answered ? 1 : 0)) / total) * 100 : 0;

  return (
    <div className={q.wrap} data-testid="tpl-quiz-run">
      <div className={q.topRow}>
        <p className="t-caption">{scopeLabelKo}</p>
        <p className={q.counter} aria-live="polite">
          {index + 1} / {total}
        </p>
      </div>
      <div className={q.progressTrack} aria-hidden>
        <div className={q.progressFill} style={{ width: `${progress}%` }} />
      </div>
      {skipped > 0 && index === 0 && <p className={`t-caption ${q.skipped}`}>이 조건에서 낼 수 없는 (틀, 방식) {skipped}개는 뺐어요.</p>}

      <div className={q.prompt}>
        <p className={q.promptLabel}>
          <span className={q.modeBadge}>{TOEIC_TEMPLATE_CHOICE_MODE_SHORT_KO[cur.mode]}</span>
          {MODE_ASK_KO[cur.mode]}
        </p>
        {/* 문제에는 듣기 버튼을 두지 않는다 — 영어를 읽어 주면 그게 곧 정답이다(§6-1) */}
        {cur.mode === "tpl-cloze" && cur.cloze ? (
          <>
            <p className={s.clozeLine} lang="en" data-testid="tpl-quiz-cloze">
              <SlotText text={cur.cloze.before} />
              <span className={s.blank} aria-label="빈칸">
                {answered ? cur.answer : "_____"}
              </span>
              <SlotText text={cur.cloze.after} />
            </p>
            <p className={q.promptSub}>{cur.prompt}</p>
          </>
        ) : (
          <p className={q.promptText} lang={promptLang}>
            {cur.prompt}
          </p>
        )}
        <p className={s.groupLine}>{cur.groupKo}</p>
      </div>

      <div className={q.choices} role="group" aria-label="보기">
        {cur.choices.map((c) => {
          const isAnswer = c === cur.answer;
          const isPicked = c === choice;
          let state = "";
          if (answered) state = isAnswer ? q.choiceCorrect : isPicked ? q.choiceWrong : q.choiceDim;
          return (
            <button key={c} type="button" className={`${q.choice} ${state}`} onClick={() => choose(c)} disabled={answered} aria-pressed={isPicked} lang={choiceLang}>
              <span className={q.choiceText}>{c}</span>
              {answered && isAnswer ? <span aria-hidden className={q.mark}>○</span> : null}
              {answered && isPicked && !isAnswer ? <span aria-hidden className={q.mark}>✕</span> : null}
            </button>
          );
        })}
      </div>

      {answered && (
        <div className={`${q.feedback} ${isRight ? q.feedbackCorrect : q.feedbackWrong}`} role="status" data-testid="tpl-quiz-feedback">
          <div className={q.feedbackHead}>
            <span className={q.feedbackText}>{isRight ? "정답이에요! 🎉" : "아쉬워요"}</span>
            <button type="button" className={q.speaker} onClick={() => play(cleanGuideEnForTts(cur.frameEn))} aria-label="영어 틀 다시 듣기">
              🔊
            </button>
          </div>
          <div className={s.frameBox}>
            <p className={s.itemEn} lang="en">
              <FrameLine frame={cur.frameEn} tones={tones} lang="en" />
            </p>
            <p className={s.itemKo}>{koTilde}</p>
          </div>
          {cur.example && (
            <div className={s.frameRow}>
              <p>
                <span className={s.exampleEn} lang="en">
                  {cur.example.en}
                </span>
                <br />
                <span className={s.exampleKo}>{cur.example.ko}</span>
              </p>
              <button type="button" className={q.speaker} onClick={() => play(cur.example!.en.trim())} aria-label="예문 듣기">
                🔊
              </button>
            </div>
          )}
        </div>
      )}

      <div className={q.actions}>
        {answered && (
          <button type="button" className="u-btn u-btn-primary" onClick={goNext} data-testid="tpl-quiz-next">
            {index + 1 >= total ? "결과 보기" : "다음 →"}
          </button>
        )}
      </div>
      <button type="button" className={s.stopBtn} onClick={() => finish(false)}>
        그만두기
      </button>
    </div>
  );
}
