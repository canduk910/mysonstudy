"use client";

/**
 * 🎙️ 일본어 말하기 모의고사 결과 (docs/harness/japanese.md §15-4·§15-6·§15-10-2) — 클라이언트 컴포넌트.
 *
 * - 내 녹음 ▶ — **이 기기**(IndexedDB 풀 "ja", lib/toeic-rec-store)에만 있다. 서버 업로드가 없으므로 다른 기기에서는 채점할 수 없다 —
 *   녹음이 이 기기에 없으면 AI 채점 버튼을 막고 "이 녹음은 응시한 기기에만 있어요"라고 말한다(§15-9-4).
 * - **"AI 채점 받기"**를 눌러야 돈다(비용 — §15-11-3): 문항마다 동시 2개(TOEIC_SCORE_CONCURRENCY — 토익과 같은 값) — 녹음을 16kHz mono WAV로
 *   정규화(lib/mic-session toWav16kMono, 실패하면 원본) → `POST /api/japanese/speaking/attempts/[id]/score`. 이미 채점된 문항은 보내지 않는다.
 *   키가 없으면(501) 남은 문항을 멈추고 이유를 보인다.
 * - Q1–2: 글자 일치율(참고 — 발음·억양은 채점하지 않는다), 빠진·다르게 들린 토큰. Q3–11: 한국어 피드백·고칠 표현·고친 답변(후리가나 🔊)·추정 수준.
 * - 응시 전체: **추정 수준(참고용 — JLPT에는 말하기 시험이 없다)**(estimateJaSpeakingLevel — 아래쪽 중앙값, 유효 3개 이상) · "이 레벨 달성도"
 *   (jaSpeakingAchievement — 범위 전부 채점됐을 때만). 토익 ACTFL 환산은 쓰지 않는다(§15-6).
 */

import { useEffect, useRef, useState } from "react";
import JaRuby from "@/components/ja-ruby";
import type { JaLine } from "@/lib/ai/japanese/speaking-schemas";
import {
  JA_SPEAKING_ACHIEVEMENT_LABEL_KO,
  JA_SPEAKING_ESTIMATE_LABEL_KO,
  JA_SPEAKING_LEVEL_LABEL_KO,
  JA_SPEAKING_SPEECH_LANG,
  estimateJaSpeakingLevel,
  jaSpeakingAchievement,
} from "@/lib/ja-speaking";
import { jaSpeakingScoreApi, type JaSpeakingAnswer, type JaSpeakingQuestionView, type JaSpeakingScoreResponse } from "@/lib/ja-speaking-contract";
import { JA_SPEAKING_NO_RESPONSE_KO, JA_SPEAKING_READ_NOTICE_KO } from "@/lib/ja-speaking-score";
import { toWav16kMono } from "@/lib/mic-session";
import { speak } from "@/lib/speech";
import {
  TOEIC_SCORE_AUDIO_MAX_BYTES,
  TOEIC_SCORE_CONCURRENCY,
  TOEIC_SCORE_FIELD_AUDIO,
  TOEIC_SCORE_FIELD_Q,
  isAcceptedToeicAudioType,
  toeicAudioBaseType,
  toeicAudioFileName,
} from "@/lib/toeic-attempt-contract";
import { listToeicRecordings } from "@/lib/toeic-rec-store";

type Job = { phase: "queued" } | { phase: "working" } | { phase: "done" } | { phase: "failed"; message: string };
type LocalRec = { blob: Blob; mimeType: string; durationMs: number; url: string };

function SpokenLine({ line, label }: { line: JaLine; label: string }) {
  return (
    <div className="mt-2">
      <p className="t-caption">{label}</p>
      <div className="flex items-start gap-2">
        <JaRuby tokens={line.tokens} as="div" className="t-body min-w-0 flex-1" />
        <button type="button" className="u-btn u-btn-secondary flex-none px-2 py-1" onClick={() => speak(line.ja, JA_SPEAKING_SPEECH_LANG)} aria-label={`${label} 듣기`}>
          🔊
        </button>
      </div>
      {line.ko && (
        <details className="mt-1">
          <summary className="t-caption cursor-pointer select-none">뜻 보기</summary>
          <p className="t-caption mt-1 text-ink">{line.ko}</p>
        </details>
      )}
    </div>
  );
}

export default function JaSpeakingAttemptView({
  attemptId,
  mockTitleKo,
  level,
  scopeLabelKo,
  questions,
  initialAnswers,
  closed,
  finished,
}: {
  attemptId: string;
  mockTitleKo: string;
  level: string;
  scopeLabelKo: string;
  questions: JaSpeakingQuestionView[];
  initialAnswers: JaSpeakingAnswer[];
  closed: boolean;
  finished: boolean;
}) {
  const [answers, setAnswers] = useState<Record<number, JaSpeakingAnswer>>(() => Object.fromEntries(initialAnswers.map((a) => [a.q, a])));
  const [recs, setRecs] = useState<Map<number, LocalRec> | null>(null);
  const [jobs, setJobs] = useState<Record<number, Job>>({});
  const [running, setRunning] = useState(false);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const stopAllRef = useRef(false);
  const urlsRef = useRef<string[]>([]);

  // 이 기기의 녹음(풀 "ja") — 마운트 뒤 읽는다
  useEffect(() => {
    let alive = true;
    void listToeicRecordings(attemptId).then((list) => {
      if (!alive) return;
      const m = new Map<number, LocalRec>();
      for (const r of list) {
        const url = URL.createObjectURL(r.blob);
        urlsRef.current.push(url);
        m.set(r.q, { blob: r.blob, mimeType: r.mimeType, durationMs: r.durationMs, url });
      }
      setRecs(m);
    });
    return () => {
      alive = false;
    };
  }, [attemptId]);
  useEffect(
    () => () => {
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    },
    [],
  );

  const qs = questions.map((v) => v.q);
  const answerList = qs.map((q) => answers[q]).filter((a): a is JaSpeakingAnswer => !!a);
  const scorable = qs.filter((q) => answers[q]?.recorded && answers[q]?.score === null);
  const scorableHere = scorable.filter((q) => recs?.has(q));
  const missingHere = recs ? scorable.filter((q) => !recs.has(q)) : [];

  const setJob = (q: number, job: Job) => setJobs((prev) => ({ ...prev, [q]: job }));

  async function scoreOne(q: number): Promise<void> {
    const rec = recs?.get(q);
    if (!rec) {
      setJob(q, { phase: "failed", message: "이 녹음은 응시한 기기에만 있어요." });
      return;
    }
    setJob(q, { phase: "working" });
    let upload: Blob = rec.blob;
    try {
      const wav = await toWav16kMono(rec.blob);
      if (wav.blob.size <= TOEIC_SCORE_AUDIO_MAX_BYTES) upload = wav.blob;
    } catch {
      /* 원본 그대로 */
    }
    const type = toeicAudioBaseType(upload.type) || toeicAudioBaseType(rec.mimeType);
    if (upload.size > TOEIC_SCORE_AUDIO_MAX_BYTES || !isAcceptedToeicAudioType(type)) {
      setJob(q, { phase: "failed", message: "이 녹음은 채점에 올릴 수 없어요(크기·형식)." });
      return;
    }
    const fd = new FormData();
    fd.append(TOEIC_SCORE_FIELD_Q, String(q));
    fd.append(TOEIC_SCORE_FIELD_AUDIO, upload.type ? upload : new Blob([upload], { type }), toeicAudioFileName(type) ?? "answer.webm");
    let status = 0;
    let data: JaSpeakingScoreResponse | null = null;
    try {
      const res = await fetch(jaSpeakingScoreApi(attemptId), { method: "POST", body: fd });
      status = res.status;
      data = (await res.json().catch(() => null)) as JaSpeakingScoreResponse | null;
    } catch {
      setJob(q, { phase: "failed", message: "네트워크 문제로 채점하지 못했어요. 다시 시도해 주세요." });
      return;
    }
    if (data?.ok) {
      setAnswers((prev) => ({ ...prev, [q]: data.answer }));
      setJob(q, { phase: "done" });
      return;
    }
    if (data && !data.ok) {
      if (data.answer) setAnswers((prev) => ({ ...prev, [q]: data.answer! }));
      if (data.error === "no_api_key") {
        stopAllRef.current = true;
        setKeyMessage(data.messageKo);
      }
      setJob(q, { phase: "failed", message: data.messageKo });
      return;
    }
    setJob(q, { phase: "failed", message: `채점 응답을 받지 못했어요(${status || "응답 없음"}). 다시 시도해 주세요.` });
  }

  async function runScoring() {
    if (running) return;
    setRunning(true);
    stopAllRef.current = false;
    setKeyMessage(null);
    const queue = [...scorableHere];
    for (const q of queue) setJob(q, { phase: "queued" });
    const worker = async () => {
      while (queue.length > 0 && !stopAllRef.current) {
        const q = queue.shift()!;
        await scoreOne(q);
      }
    };
    await Promise.all(Array.from({ length: Math.min(TOEIC_SCORE_CONCURRENCY, queue.length) }, worker));
    setJobs((prev) => {
      const next = { ...prev };
      for (const [k, j] of Object.entries(next)) if (j.phase === "queued") delete next[Number(k)];
      return next;
    });
    setRunning(false);
  }

  const estimate = estimateJaSpeakingLevel(
    answerList.filter((a) => qs.includes(a.q)).map((a) => ({ levelEstimate: a.feedback?.levelEstimate ?? null })),
  );
  const achievement = jaSpeakingAchievement(qs, answerList);

  return (
    <>
      <section className="mb-6">
        <p className="t-caption">{scopeLabelKo}</p>
        <h1 className="t-book-title mt-1">📊 {mockTitleKo}</h1>
        <p className="t-caption mt-2 flex flex-wrap items-center gap-1.5">
          <span className="u-chip u-chip-accent">{level}</span>
          <span className="u-chip">{finished ? "끝까지" : closed ? "중간에 그만둠" : "응시 중"}</span>
          <span className="u-chip">
            녹음 {answerList.filter((a) => a.recorded).length}/{qs.length}
          </span>
        </p>

        <div className="u-box mt-4" data-testid="ja-summary">
          <p className="t-list-title">
            추정 수준: {estimate ? JA_SPEAKING_LEVEL_LABEL_KO[estimate.level] : "—"}
            {estimate && <span className="t-caption"> (문항 {estimate.count}개 기준)</span>}
          </p>
          <p className="t-caption mt-1">{JA_SPEAKING_ESTIMATE_LABEL_KO}</p>
          {!estimate && <p className="t-caption mt-1">채점된 Q3–11 문항이 3개 이상이면 보여요.</p>}
          <p className="t-list-title mt-3" data-testid="ja-achievement">
            {achievement.ok
              ? `${level} 달성도 ${achievement.raw}/${achievement.max} · ${JA_SPEAKING_ACHIEVEMENT_LABEL_KO[achievement.band]}`
              : `${level} 달성도 — ${achievement.scoredCount}/${achievement.total}문항 채점됨`}
          </p>
        </div>

        <div className="mt-4">
          {!closed ? (
            <p className="t-caption">아직 끝나지 않은 응시예요 — 응시를 마친 뒤 채점할 수 있어요.</p>
          ) : scorable.length === 0 ? (
            <p className="t-caption">{answerList.some((a) => a.score !== null) ? "✓ 녹음된 문항은 모두 채점했어요." : "채점할 녹음이 없어요."}</p>
          ) : (
            <>
              <button
                type="button"
                className="u-btn u-btn-primary"
                onClick={() => void runScoring()}
                disabled={running || recs === null || scorableHere.length === 0}
                data-testid="ja-score-all"
              >
                {running ? "채점하는 중…" : `🤖 AI 채점 받기 (${scorableHere.length}문항)`}
              </button>
              <p className="t-caption mt-1">문항마다 전사 1회 + 피드백 1회(Q1–2는 AI 없이 글자 대조)가 들어요. 이미 채점된 문항은 다시 보내지 않아요.</p>
            </>
          )}
          {recs !== null && missingHere.length > 0 && (
            <p role="status" className="t-caption mt-2 text-danger" data-testid="ja-rec-missing">
              {missingHere.map((q) => `Q${q}`).join("·")}: 이 녹음은 응시한 기기에만 있어요 — 그 기기에서 채점해 주세요.
            </p>
          )}
          {keyMessage && (
            <p role="alert" className="t-caption mt-2 text-danger">
              {keyMessage}
            </p>
          )}
        </div>
      </section>

      <ul className="flex flex-col gap-3">
        {questions.map((v) => {
          const a = answers[v.q];
          const rec = recs?.get(v.q);
          const job = jobs[v.q];
          const fb = a?.feedback ?? null;
          return (
            <li key={v.q} className="u-box" data-testid={`ja-answer-${v.q}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="t-list-title">
                  Q{v.q} · {v.partNameKo}
                </p>
                <p className="t-caption">
                  {a?.score !== null && a?.score !== undefined ? (
                    <span className="u-chip u-chip-accent" data-testid={`ja-score-${v.q}`}>
                      {a.score}/{v.maxScore}
                    </span>
                  ) : a?.recorded ? (
                    "채점 전"
                  ) : (
                    "녹음 안 됨"
                  )}
                </p>
              </div>
              {rec && (
                <audio className="mt-2 w-full" controls src={rec.url} preload="metadata">
                  <track kind="captions" />
                </audio>
              )}
              {job?.phase === "working" && <p className="t-caption mt-1">채점하는 중…</p>}
              {job?.phase === "queued" && <p className="t-caption mt-1">차례를 기다리는 중…</p>}
              {job?.phase === "failed" && <p className="t-caption mt-1 text-danger">{job.message}</p>}
              {a?.transcript !== null && a?.transcript !== undefined && (
                <div className="mt-2">
                  <p className="t-caption">내 답변(전사)</p>
                  <p className="t-body" lang="ja" data-testid={`ja-transcript-${v.q}`}>
                    {a.transcript || "—"}
                  </p>
                </div>
              )}
              {a?.noResponse && <p className="t-caption mt-1 text-danger">{JA_SPEAKING_NO_RESPONSE_KO}</p>}

              {a?.readDiff && (
                <div className="mt-2">
                  <p className="t-list-title">글자 일치율(참고) {Math.round(a.readDiff.accuracy * 100)}%</p>
                  <p className="t-caption">{JA_SPEAKING_READ_NOTICE_KO}</p>
                  {a.readDiff.missing.length > 0 && (
                    <p className="t-caption mt-1" lang="ja">
                      빠짐: {a.readDiff.missing.join(" · ")}
                    </p>
                  )}
                  {a.readDiff.substituted.length > 0 && (
                    <p className="t-caption mt-1" lang="ja">
                      다르게 들림: {a.readDiff.substituted.map((x) => `${x.expected} → ${x.heard}`).join(" · ")}
                    </p>
                  )}
                </div>
              )}

              {fb && (
                <div className="mt-3">
                  <p className="t-body">{fb.summaryKo}</p>
                  <p className="t-caption mt-1">
                    답변 추정 수준 {JA_SPEAKING_LEVEL_LABEL_KO[fb.levelEstimate]} — {fb.levelReasonKo}
                  </p>
                  {fb.strengths.length > 0 && (
                    <>
                      <p className="t-caption mt-2">잘한 점</p>
                      <ul className="t-caption list-disc pl-5">
                        {fb.strengths.map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {fb.fixes.length > 0 && (
                    <>
                      <p className="t-caption mt-2">고칠 표현</p>
                      <ul className="flex flex-col gap-1">
                        {fb.fixes.map((f, i) => (
                          <li key={i} className="t-caption">
                            <span lang="ja" className="line-through">
                              {f.said}
                            </span>{" "}
                            → <span lang="ja" className="font-medium text-ink">{f.better}</span>
                            <span className="block">{f.whyKo}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {fb.missingKo.length > 0 && (
                    <>
                      <p className="t-caption mt-2">빠진 내용</p>
                      <ul className="t-caption list-disc pl-5">
                        {fb.missingKo.map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  <SpokenLine line={fb.improvedAnswer} label="고친 답변" />
                </div>
              )}
              {v.ja.sampleAnswer && (
                <details className="mt-3">
                  <summary className="t-caption cursor-pointer select-none">모범답변 보기</summary>
                  <SpokenLine line={v.ja.sampleAnswer} label="모범답변" />
                </details>
              )}
              {v.ja.passage && (
                <details className="mt-3">
                  <summary className="t-caption cursor-pointer select-none">지문 보기</summary>
                  <SpokenLine line={v.ja.passage} label="지문" />
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
