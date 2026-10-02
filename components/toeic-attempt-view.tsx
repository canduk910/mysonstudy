"use client";

/**
 * 모의고사 응시 결과 화면 (아빠의 영어 T5, docs/harness/toeic.md §5·§8) — 클라이언트 컴포넌트.
 *
 * - **내 녹음 ▶**: 기기 보관소(lib/toeic-rec-store — IndexedDB `eunwoo-toeic-rec`)에서 꺼낸다. 없으면 "녹음은 응시한 기기에만 있어요".
 * - **AI 채점 받기**: 녹음이 이 기기에 있고 아직 점수가 없는 문항만, **동시 2개**. 문항마다 16kHz mono WAV로 정규화
 *   (lib/mic-session toWav16kMono — 실패하면 원본 업로드) → `POST /api/toeic/attempts/[id]/score`(multipart). 진행 표시·문항별 재시도.
 *   버튼을 눌러야 돈다(§0-2 — 비용이 드는 경로를 자동으로 태우지 않는다). 키가 없으면(501) 남은 문항을 멈추고 이유를 알린다.
 * - 문항별: 전사문 · 점수 · 피드백(잘한 점 · 고칠 문장 said→better · 이유 · 빠진 내용 · 개선 답변 🔊 · 넣었으면 좋았을 표현) ·
 *   Q1–2 대조(빠진·바뀐 단어를 지문 위에 표시 + "발음·억양은 채점하지 않았어요") · 모범답변 🔊.
 * - **추정 총점·등급**: 11문항 모두 채점됐을 때만(lib/toeic-score estimateToeicTotal) — "추정(참고용)".
 * - **진단 캡션**: 마지막 녹음의 mimeType·길이·크기·정규화 여부·전사 상태(SPEC §16-5 관용구 — 서버 로그를 못 보는 폰에서 판정).
 * - 🔊는 탭 안에서 동기로 speakQueue(en-US 명시), 정지는 큐가 돌려준 stop만.
 * - 닫히지 않은 응시(끝/그만두기 저장이 실패한 채 떠남)는 이 기기 녹음으로 "녹음 기록 저장하기"를 제안한다.
 * - 모범답변 접기 안에 Q3–4 **묘사 포인트**(keyPointsKo)·Q11 **답변 뼈대**(outlineKo)도 보인다 — 규칙은 "비어 있지 않으면 보인다" 하나라
 *   실전 모의고사 결과에도 같다(docs/harness/toeic.md §12-7-5 — 연습은 학습 보기를 쓰지 않으므로 결과 화면이 복습 자리다).
 * - 유형별 공략 **한 문제 연습**(`drill` — 서버 페이지가 문서의 drillPart로 넘긴다, §12-7-5·§12-7-9): 끝 버튼 줄은 "같은 문제 다시"·
 *   "새 문제"(유형 폴더의 만들기로)이고 **"학습 보기로"는 숨긴다**(학습 보기는 연습을 폴더로 보낸다).
 * - **"🧩 틀 점검"**(AI 없음 — 채점 때 만든 전사문과 저장된 C·D 출력만: 쓴 틀·빠진 단계(Q3–4·Q11)·쓸 수 있었던 틀 — lib/toeic-drill-view
 *   drillTemplateCheck). 2026-10-02(§12-13-3)부터 **실전 모의고사에도** 붙는다 — 서버가 파트마다 점검 자료(`checks`)를 넘긴다. 연습은 문항마다
 *   펼쳐서, 실전 모의고사는 문항마다 **닫힌 접기** "🧩 틀 점검 · 쓴 틀 n(· 빠진 단계 m)"(채점 전은 "🧩 모범답변의 틀 n · 채점 뒤 내 틀") — 11문항
 *   결과 화면이 길어지지 않게. 실전 모의고사는 결과 머리에 한 줄 "🧩 틀을 쓴 문항 n/m · 빠진 단계 k"(toeicTemplateCheckSummary).
 * - 모범답변 접기에 **모범답변 점검 줄**("🧩 모범답변의 틀 n개 · 단계 a/b" — 문서에 저장된 흐름으로 잰다, 옛 문서는 줄 없음)과 크게 덜 따랐으면
 *   미달 경고(→ ② 템플릿 훈련). 모범답변 속 강조는 틀 글자에서 온 구간을 🧩 색으로 따로 보인다(흐름 글자 집합에 드는가로 가른다).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ToeicInfoTableView from "@/components/toeic-info-table";
import TtsEngineControl from "@/components/tts-engine-control";
import TtsSpeedControl from "@/components/tts-speed-control";
import { toWav16kMono } from "@/lib/mic-session";
import { prefetchSpeech, speakQueue } from "@/lib/speech";
import {
  TOEIC_SCORE_AUDIO_MAX_BYTES,
  TOEIC_SCORE_CONCURRENCY,
  TOEIC_SCORE_FIELD_AUDIO,
  TOEIC_SCORE_FIELD_Q,
  isAcceptedToeicAudioType,
  toeicAudioBaseType,
  toeicAudioFileName,
  type ToeicAnswer,
  type ToeicAttemptFinishResponse,
  type ToeicAttemptRecord,
  type ToeicQuestionView,
  type ToeicScoreResponse,
} from "@/lib/toeic-attempt-contract";
import { isScorableToeicAnswer } from "@/lib/toeic-attempt-rules";
import { FrameLine } from "@/components/toeic-template-lines";
import {
  TOEIC_ANSWER_FLOW_WEAK_KO,
  TOEIC_DRILL_SUGGESTION_SOURCE_KO,
  answerFlowCheckLine,
  drillTemplateCheck,
  toeicTemplateCheckSummary,
  type ToeicDrillCheckResult,
  type ToeicDrillCheckTemplate,
  type ToeicTemplateCheckData,
} from "@/lib/toeic-drill-view";
import { toeicGuidePartOfMockPart } from "@/lib/toeic-guide";
import type { ToeicAnswerFlow } from "@/lib/toeic-guide-contract";
import { slotToneMap, toeicGuideFolderHref } from "@/lib/toeic-guide-view";
import { segmentUsedExpressions, toeicImageUrl, toeicTakeHref, type ToeicUsedExpression } from "@/lib/toeic-mock-contract";
import type { ToeicMockPart } from "@/lib/toeic-mock";
import { answerFlowExpressions, frameSlotNames } from "@/lib/toeic-template";
import { expressionKey } from "@/lib/toeic-text";
import { markReadAloud } from "@/lib/toeic-read-marks";
import { listToeicRecordings, type ToeicRecording } from "@/lib/toeic-rec-store";
import { TOEIC_NO_RESPONSE_KO, TOEIC_READ_NOTICE_KO, estimateToeicTotal, isNoResponseTranscript } from "@/lib/toeic-score";
import { TTS_TEXT_MAX_CHARS } from "@/lib/tts-shared";
import { splitForTts } from "@/lib/tts-split";
import s from "./toeic-attempt-view.module.css";

type ScoreJob =
  | { phase: "queued" }
  | { phase: "normalizing" }
  | { phase: "uploading" }
  | { phase: "done" }
  | { phase: "failed"; message: string; retriable: boolean };

interface ScoreDiag {
  mimeType: string;
  durationMs: number;
  size: number;
  /** wav: 16kHz WAV로 올림 · original: 정규화 실패로 원본 · null: 아직 */
  normalized: "wav" | "original" | null;
  uploadSize: number | null;
  normError: string | null;
  /** ok: 전사·채점 끝 · stored: 저장된 전사문으로 피드백만 · no_response: 무응답 · failed: 실패 */
  transcribe: "ok" | "stored" | "no_response" | "failed" | null;
  error: string | null;
}

interface LocalRec {
  url: string;
  rec: ToeicRecording;
}

function enPieces(text: string): { text: string; lang: string }[] {
  return splitForTts(text, TTS_TEXT_MAX_CHARS)
    .filter((t) => t.trim() !== "")
    .map((t) => ({ text: t, lang: "en-US" }));
}

function kb(n: number | null): string {
  if (n === null) return "–";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

function secs(ms: number | null): string {
  return ms === null ? "–" : `${(ms / 1000).toFixed(1)}초`;
}

/** 한 문제 연습의 결과 화면 자료(서버 페이지가 문서의 drillPart로 만든다 — 모의고사면 null) */
export interface ToeicAttemptDrillInfo {
  /** "같은 문제 다시" — 같은 연습 응시 */
  retakeHref: string;
  /** "새 문제" — 유형 폴더 ④ 탭(만들기) */
  newHref: string;
}

/** 틀 한 줄(영어 틀 — 자리 칩) + 한국어 틀(작은 글씨) */
function TemplateMini({ t }: { t: ToeicDrillCheckTemplate }) {
  const tones = slotToneMap(frameSlotNames(t.frameEn));
  return (
    <>
      <span className={s.tplEn} lang="en">
        <FrameLine frame={t.frameEn} tones={tones} lang="en" />
      </span>
      <span className={s.tplKo}>
        <FrameLine frame={t.frameKo} tones={tones} lang="ko" />
      </span>
    </>
  );
}

/** 모범답변 속 활용한 표현 강조 — 틀 글자(흐름 글자 집합)에서 온 구간은 `frameClass`(🧩 색)로 따로(§12-13-3) */
function highlightUsed(text: string, used: readonly ToeicUsedExpression[], markClass: string, frameKeys?: ReadonlySet<string>, frameClass?: string): ReactNode {
  return segmentUsedExpressions(text, used).map((seg, i) =>
    seg.mark ? (
      <mark
        key={i}
        className={frameKeys && frameClass && seg.expression && frameKeys.has(expressionKey(seg.expression)) ? `${markClass} ${frameClass}` : markClass}
        title={seg.expression ?? undefined}
      >
        {seg.text}
      </mark>
    ) : (
      <Fragment key={i}>{seg.text}</Fragment>
    ),
  );
}

export default function ToeicAttemptView({
  attempt,
  mockId,
  mockTitleKo,
  scopeLabelKo,
  closed,
  questions,
  drill = null,
  checks = {},
  answerFlows = [],
}: {
  attempt: ToeicAttemptRecord;
  mockId: string;
  mockTitleKo: string;
  scopeLabelKo: string;
  closed: boolean;
  questions: ToeicQuestionView[];
  /** 한 문제 연습이면 끝 버튼 줄(모의고사면 null) */
  drill?: ToeicAttemptDrillInfo | null;
  /** 🧩 틀 점검 자료 — 파트마다(read 제외, 틀 은행에 그 유형 틀이 없으면 그 파트는 키 없음 — 점검 없이 결과만) */
  checks?: Partial<Record<ToeicMockPart, ToeicTemplateCheckData>>;
  /** 문서에 저장된 답변 흐름(만들 때의 입력 — 모범답변 점검 줄이 잰다. 옛 문서는 []) */
  answerFlows?: ToeicAnswerFlow[];
}) {
  const router = useRouter();
  const id = attempt.id;
  const checkTplByKey = useMemo(() => {
    const m = new Map<string, ToeicDrillCheckTemplate>();
    for (const c of Object.values(checks)) for (const t of c?.templates ?? []) if (!m.has(t.key)) m.set(t.key, t);
    return m;
  }, [checks]);
  const flowOf = useCallback((part: ToeicMockPart) => answerFlows.find((f) => f.part === part) ?? null, [answerFlows]);
  /** 파트마다 흐름 틀 글자 키 — 모범답변 강조에서 틀 글자에서 온 구간을 가른다 */
  const flowKeySets = useMemo(() => new Map(answerFlows.map((f) => [f.part, new Set(answerFlowExpressions(f).map(expressionKey))] as const)), [answerFlows]);
  const flowKeys = (part: ToeicMockPart): ReadonlySet<string> | undefined => flowKeySets.get(part);

  // ── 문항별 답(서버 값 위에 이 화면의 채점 결과를 얹는다 — 새로 읽으면 서버 값으로 맞춘다) ──
  const toMap = (list: readonly ToeicAnswer[]) => Object.fromEntries(list.map((a) => [a.q, a] as const)) as Record<number, ToeicAnswer>;
  const [answers, setAnswers] = useState<Record<number, ToeicAnswer>>(() => toMap(attempt.answers));
  useEffect(() => {
    setAnswers(toMap(attempt.answers));
  }, [attempt]);

  // ── 이 기기의 녹음 ──
  const [recs, setRecs] = useState<Map<number, LocalRec>>(new Map());
  const [recsLoaded, setRecsLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    void listToeicRecordings(id).then((list) => {
      if (!alive) return;
      const m = new Map<number, LocalRec>();
      for (const r of list) {
        const url = URL.createObjectURL(r.blob);
        urls.push(url);
        m.set(r.q, { url, rec: r });
      }
      setRecs(m);
      setRecsLoaded(true);
    });
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [id]);

  // ── AI 채점 ──
  const [jobs, setJobs] = useState<Record<number, ScoreJob>>({});
  const [diags, setDiags] = useState<Record<number, ScoreDiag>>({});
  const [lastDiagQ, setLastDiagQ] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const runningRef = useRef(false);
  const stopAllRef = useRef(false);
  const recsRef = useRef(recs);
  useEffect(() => {
    recsRef.current = recs;
  }, [recs]);

  const setJob = useCallback((q: number, job: ScoreJob) => setJobs((prev) => ({ ...prev, [q]: job })), []);
  const patchDiag = useCallback((q: number, patch: Partial<ScoreDiag>) => {
    setDiags((prev) => {
      const base: ScoreDiag = prev[q] ?? {
        mimeType: "",
        durationMs: 0,
        size: 0,
        normalized: null,
        uploadSize: null,
        normError: null,
        transcribe: null,
        error: null,
      };
      return { ...prev, [q]: { ...base, ...patch } };
    });
    setLastDiagQ(q);
  }, []);

  const scoreOne = useCallback(
    async (q: number) => {
      const local = recsRef.current.get(q);
      if (!local) {
        setJob(q, { phase: "failed", message: "녹음이 이 기기에 없어 채점할 수 없어요.", retriable: false });
        return;
      }
      const rec = local.rec;
      patchDiag(q, { mimeType: rec.mimeType, durationMs: rec.durationMs, size: rec.size, normalized: null, uploadSize: null, normError: null, transcribe: null, error: null });
      setJob(q, { phase: "normalizing" });
      let upload: Blob = rec.blob;
      let normalized: "wav" | "original" = "original";
      let normError: string | null = null;
      try {
        const wav = await toWav16kMono(rec.blob);
        if (wav.blob.size <= TOEIC_SCORE_AUDIO_MAX_BYTES) {
          upload = wav.blob;
          normalized = "wav";
        } else normError = "WAV가 너무 커요";
      } catch (e) {
        normError = e instanceof Error ? e.message.slice(0, 80) : "디코드 실패";
      }
      const type = toeicAudioBaseType(upload.type) || toeicAudioBaseType(rec.mimeType);
      patchDiag(q, { normalized, uploadSize: upload.size, normError });
      if (upload.size > TOEIC_SCORE_AUDIO_MAX_BYTES) {
        setJob(q, { phase: "failed", message: "녹음 파일이 너무 커서 올릴 수 없어요.", retriable: false });
        patchDiag(q, { transcribe: "failed", error: "too_large" });
        return;
      }
      if (!isAcceptedToeicAudioType(type)) {
        setJob(q, { phase: "failed", message: `이 녹음 형식(${type || "알 수 없음"})은 채점에 올릴 수 없어요.`, retriable: false });
        patchDiag(q, { transcribe: "failed", error: "unsupported_type" });
        return;
      }
      setJob(q, { phase: "uploading" });
      const fd = new FormData();
      fd.append(TOEIC_SCORE_FIELD_Q, String(q));
      fd.append(TOEIC_SCORE_FIELD_AUDIO, upload.type ? upload : new Blob([upload], { type }), toeicAudioFileName(type) ?? "answer.webm");
      let status = 0;
      let data: ToeicScoreResponse | null = null;
      try {
        const res = await fetch(`/api/toeic/attempts/${encodeURIComponent(id)}/score`, { method: "POST", body: fd });
        status = res.status;
        data = (await res.json().catch(() => null)) as ToeicScoreResponse | null;
      } catch {
        setJob(q, { phase: "failed", message: "네트워크 문제로 채점하지 못했어요. 다시 시도해 주세요.", retriable: true });
        patchDiag(q, { transcribe: "failed", error: "network" });
        return;
      }
      if (data?.ok) {
        setAnswers((prev) => ({ ...prev, [q]: data.answer }));
        setJob(q, { phase: "done" });
        patchDiag(q, { transcribe: data.noResponse ? "no_response" : data.transcriptSource === "stored" ? "stored" : "ok", error: null });
        return;
      }
      if (data && !data.ok) {
        if (data.answer) setAnswers((prev) => ({ ...prev, [q]: data.answer! }));
        if (data.error === "no_api_key") {
          stopAllRef.current = true;
          setKeyMessage(data.messageKo);
        }
        setJob(q, { phase: "failed", message: data.messageKo, retriable: data.retriable === true || data.error === "client_closed" });
        patchDiag(q, { transcribe: "failed", error: `${status} ${data.error}` });
        return;
      }
      setJob(q, { phase: "failed", message: `채점 응답을 받지 못했어요(${status || "연결 끊김"}). 다시 시도해 주세요.`, retriable: true });
      patchDiag(q, { transcribe: "failed", error: `${status} 본문 없음` });
    },
    [id, patchDiag, setJob],
  );

  const runScoring = useCallback(
    async (targets: number[]) => {
      if (runningRef.current || targets.length === 0) return;
      runningRef.current = true;
      stopAllRef.current = false;
      setKeyMessage(null);
      setRunning(true);
      setJobs((prev) => {
        const next = { ...prev };
        for (const q of targets) next[q] = { phase: "queued" };
        return next;
      });
      const queue = [...targets];
      const worker = async () => {
        while (queue.length > 0 && !stopAllRef.current) {
          const q = queue.shift()!;
          await scoreOne(q);
        }
      };
      await Promise.all(Array.from({ length: Math.min(TOEIC_SCORE_CONCURRENCY, targets.length) }, () => worker()));
      if (stopAllRef.current) {
        setJobs((prev) => {
          const next = { ...prev };
          for (const q of queue) delete next[q]; // 키가 없어 멈춘 나머지는 대기 표시를 걷는다
          return next;
        });
      }
      runningRef.current = false;
      setRunning(false);
    },
    [scoreOne],
  );

  const qs = questions.map((v) => v.q);
  const scorable = qs.filter((q) => {
    const a = answers[q];
    return a && isScorableToeicAnswer(a) && recs.has(q);
  });
  const recordedHere = qs.filter((q) => answers[q]?.recorded && recs.has(q)).length;
  const recordedAll = qs.filter((q) => answers[q]?.recorded).length;
  const recordedElsewhere = recordedAll - recordedHere;
  const estimate = estimateToeicTotal(Object.values(answers));

  // ── 🧩 틀 점검(AI 0) — 문항마다 한 번 계산해 머리 요약·문항 접기가 같이 쓴다 ──
  const checkResults = useMemo(() => {
    const out = new Map<number, ToeicDrillCheckResult>();
    for (const v of questions) {
      const data = checks[v.part];
      if (!data || toeicGuidePartOfMockPart(v.part) === null) continue;
      const a = answers[v.q];
      out.set(
        v.q,
        drillTemplateCheck(data, {
          transcript: a?.transcript ?? null,
          sampleAnswer: v.sampleAnswer,
          sampleUsedExpressions: v.usedExpressions.map((u) => u.expression),
          tryExpressions: a?.feedback?.tryExpressions ?? [],
        }),
      );
    }
    return out;
  }, [questions, checks, answers]);
  /** 실전 모의고사 결과 머리 한 줄(연습에는 두지 않는다 — 문항이 1~3개이고 펼쳐서 보인다) */
  const checkSummary = drill ? null : toeicTemplateCheckSummary([...checkResults.values()]);
  const doneCount = qs.filter((q) => jobs[q]?.phase === "done" || jobs[q]?.phase === "failed").length;
  const activeTargets = qs.filter((q) => jobs[q] !== undefined && jobs[q].phase !== "done" && jobs[q].phase !== "failed");

  // ── 🔊(한 번에 하나, 큐가 돌려준 stop만) ──
  const runRef = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  useEffect(
    () => () => {
      runRef.current++;
      stopRef.current?.();
      stopRef.current = null;
    },
    [],
  );
  function togglePlay(key: string, text: string) {
    if (playingKey === key) {
      runRef.current++;
      const stop = stopRef.current;
      stopRef.current = null;
      stop?.();
      setPlayingKey(null);
      return;
    }
    const pieces = enPieces(text);
    if (pieces.length === 0) return;
    const run = ++runRef.current;
    stopRef.current = null;
    const stop = speakQueue(pieces, {
      onEnd: () => {
        if (runRef.current !== run) return;
        stopRef.current = null;
        setPlayingKey(null);
      },
    });
    if (runRef.current === run) {
      stopRef.current = stop;
      setPlayingKey(key);
    }
  }
  function playBtn(key: string, text: string, label: string) {
    const on = playingKey === key;
    return (
      <button
        type="button"
        className={`${s.play} ${on ? s.playOn : ""}`}
        onClick={() => togglePlay(key, text)}
        aria-label={on ? `${label} 멈추기` : `${label} 듣기`}
        aria-pressed={on}
      >
        {on ? "■ 멈추기" : "🔊 듣기"}
      </button>
    );
  }

  // 프리페치(§16) — 모범답변·개선 답변 조각(키는 문자열 — 참조 변경으로 재시작하지 않게)
  const prefetchKey = useMemo(() => {
    const texts: string[] = [];
    for (const v of questions) {
      if (v.sampleAnswer) texts.push(v.sampleAnswer);
      const fb = answers[v.q]?.feedback;
      if (fb?.improvedAnswer) texts.push(fb.improvedAnswer);
    }
    return texts
      .flatMap((t) => splitForTts(t, TTS_TEXT_MAX_CHARS))
      .filter((t) => t !== "")
      .join("\u0001");
  }, [questions, answers]);
  useEffect(() => {
    if (!prefetchKey) return;
    return prefetchSpeech(prefetchKey.split("\u0001"), "en-US");
  }, [prefetchKey]);

  // ── 닫히지 않은 응시 복구 — 이 기기 녹음으로 끝/그만두기 저장 ──
  const [recover, setRecover] = useState<{ phase: "idle" | "saving" } | { phase: "error"; message: string }>({ phase: "idle" });
  async function recoverFinish() {
    setRecover({ phase: "saving" });
    const body = {
      finishedAt: null,
      answers: qs.map((q) => {
        const r = recs.get(q);
        return r && r.rec.durationMs > 0 ? { q, recorded: true, durationMs: Math.round(r.rec.durationMs) } : { q, recorded: false, durationMs: null };
      }),
    };
    try {
      const res = await fetch(`/api/toeic/attempts/${encodeURIComponent(id)}/finish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as ToeicAttemptFinishResponse | null;
      if (data?.ok || (data && !data.ok && data.error === "already_finished")) {
        setRecover({ phase: "idle" });
        router.refresh();
        return;
      }
      setRecover({ phase: "error", message: data && !data.ok ? data.messageKo : "저장하지 못했어요." });
    } catch {
      setRecover({ phase: "error", message: "네트워크 문제로 저장하지 못했어요." });
    }
  }

  // ── 렌더 ──
  const partOnly = attempt.scope === "part";
  const firstPart = attempt.parts[0];
  const lastDiag = lastDiagQ !== null ? diags[lastDiagQ] : undefined;
  const lastLocal = [...recs.values()].sort((a, b) => b.rec.q - a.rec.q)[0];

  return (
    <div className={s.wrap}>
      <div>
        <p className={s.kicker}>{scopeLabelKo}</p>
        <h1 className={s.title}>{mockTitleKo}</h1>
        <p className={s.meta}>
          <span className="u-chip">{attempt.finishedAt ? "끝까지" : closed ? "중단" : "저장 안 됨"}</span>
          <span className="u-chip">
            녹음 {recordedAll} / {qs.length}문항
          </span>
          {!estimate.complete && estimate.scoredCount > 0 && <span className="u-chip">{estimate.messageKo}</span>}
        </p>
        {checkSummary && (
          <p className={s.tplSummary} data-testid="tpl-check-summary">
            {checkSummary.textKo}
          </p>
        )}
      </div>

      {/* 추정 총점 */}
      <section className={s.estimate} aria-label="추정 총점">
        {estimate.complete ? (
          <>
            <p className={s.estimateLabel}>{estimate.labelKo}</p>
            <p className={s.estimateScore}>
              {estimate.scaled}
              <span className={s.estimateUnit}> / 200</span>
              <span className={s.band}>{estimate.band}</span>
            </p>
            <p className={s.caption}>
              원점수 {estimate.raw} / 35. ETS 환산표는 공개되지 않아 비율로 어림한 값이에요 — 실제 시험 점수와 다를 수 있어요.
            </p>
          </>
        ) : (
          <p className={s.caption}>
            {partOnly
              ? "추정 총점은 실전 11문항을 모두 채점했을 때만 계산해요. 유형 연습은 문항 점수만 보여 줘요."
              : `추정 총점·등급은 11문항을 모두 채점하면 보여요(지금 ${estimate.scoredCount}문항).`}
          </p>
        )}
      </section>

      {!closed && (
        <div className={s.alert} role="alert">
          <p>이 응시는 결과가 아직 저장되지 않았어요(응시 중에 화면을 떠났거나 저장이 실패했어요).</p>
          {recs.size > 0 ? (
            <>
              <button type="button" className="u-btn u-btn-primary" onClick={() => void recoverFinish()} disabled={recover.phase === "saving"}>
                {recover.phase === "saving" ? "저장하는 중…" : `💾 이 기기 녹음 ${recs.size}문항으로 저장하기`}
              </button>
              {recover.phase === "error" && <p className={s.error}>{recover.message}</p>}
            </>
          ) : (
            <p className={s.caption}>{recsLoaded ? "이 기기에 이 응시의 녹음이 없어요." : "녹음을 찾는 중…"}</p>
          )}
        </div>
      )}

      {/* AI 채점 받기 */}
      {closed && (
        <section className={s.scoreBox} aria-label="AI 채점">
          <button type="button" className="u-btn u-btn-primary" onClick={() => void runScoring(scorable)} disabled={running || scorable.length === 0}>
            {running ? `채점 중… ${doneCount} / ${doneCount + activeTargets.length}` : `🤖 AI 채점 받기${scorable.length > 0 ? ` (${scorable.length}문항)` : ""}`}
          </button>
          <p className={s.caption} aria-live="polite">
            {running
              ? "녹음을 글로 옮기고(전사) 문항마다 피드백을 만들어요. 한 문항에 10~30초쯤 걸려요."
              : scorable.length > 0
                ? `녹음된 문항마다 전사 1회 + 피드백 1회 비용이 들어요. Q1–2는 AI 없이 지문과 대조해요.`
                : recordedAll === 0
                  ? "녹음된 문항이 없어 채점할 것이 없어요."
                  : !recsLoaded
                    ? "이 기기의 녹음을 찾는 중…"
                    : recordedHere === 0
                      ? "녹음은 응시한 기기에만 있어요 — 이 기기에는 이 응시의 녹음이 없어 채점할 수 없어요."
                      : "채점할 문항이 남지 않았어요."}
          </p>
          {recordedElsewhere > 0 && recsLoaded && recordedHere > 0 && (
            <p className={s.caption}>녹음 {recordedElsewhere}문항은 이 기기에 없어요(응시한 기기에만 있어요).</p>
          )}
          {keyMessage && (
            <p className={s.error} role="alert">
              {keyMessage}
            </p>
          )}
          <details className={s.settings}>
            <summary className={s.settingsSummary}>⚙️ 소리 설정</summary>
            <div className={s.settingsBody}>
              <TtsSpeedControl />
              <TtsEngineControl lang="en-US" />
            </div>
          </details>
        </section>
      )}

      {/* 문항별 */}
      {questions.map((v) => {
        const a = answers[v.q];
        const local = recs.get(v.q);
        const job = jobs[v.q];
        const diag = diags[v.q];
        const noResp = a?.transcript !== null && a?.transcript !== undefined && isNoResponseTranscript(a.transcript);
        const readMarks = v.passage && a?.transcript !== null && a?.transcript !== undefined && a.readDiff ? markReadAloud(v.passage, a.transcript) : null;
        return (
          <article key={v.q} className={s.item} aria-label={`Q${v.q} 결과`}>
            <div className={s.itemHead}>
              <span className={s.qBadge}>Q{v.q}</span>
              <span className={s.partName}>{v.partNameKo}</span>
              <span className={`${s.scoreChip} ${a?.score !== null && a?.score !== undefined ? s.scoreOn : ""}`}>
                {a?.score !== null && a?.score !== undefined ? `${a.score} / ${v.maxScore}` : !a?.recorded ? "녹음 없음" : "채점 전"}
              </span>
            </div>

            {/* 자료 요약 */}
            {v.picture &&
              (v.picture.imageId ? (
                // eslint-disable-next-line @next/next/no-img-element -- PIN 게이트 안 동적 라우트 바이트
                <img src={toeicImageUrl(v.picture.imageId)} alt={`Q${v.q} 사진`} width={1536} height={1024} loading="lazy" className={s.photo} />
              ) : (
                <p className={s.scene}>📷 {v.picture.sceneKo}</p>
              ))}
            {v.intro && (
              <p className={s.intro} lang="en">
                {v.intro}
              </p>
            )}
            {v.table && (
              <details className={s.tableBox}>
                <summary className={s.tableSummary}>표 보기</summary>
                <ToeicInfoTableView table={v.table} />
              </details>
            )}
            {v.question && (
              <p className={s.question} lang="en">
                {v.question}
              </p>
            )}

            {/* 내 녹음 */}
            <div className={s.block}>
              <p className={s.label}>내 녹음</p>
              {local ? (
                <>
                  <audio className={s.audio} controls preload="metadata" src={local.url}>
                    <track kind="captions" />
                  </audio>
                  <p className={s.diagLine}>
                    {secs(local.rec.durationMs)} · {local.rec.mimeType || "형식 모름"} · {kb(local.rec.size)}
                  </p>
                </>
              ) : a?.recorded ? (
                <p className={s.caption}>{recsLoaded ? "녹음은 응시한 기기에만 있어요." : "녹음을 찾는 중…"}</p>
              ) : (
                <p className={s.caption}>녹음 없음(시간 안에 녹음되지 않았어요).</p>
              )}
            </div>

            {/* 채점 진행 */}
            {job && job.phase !== "done" && (
              <div className={s.jobLine} aria-live="polite">
                {job.phase === "queued" && <span>채점 대기 중</span>}
                {job.phase === "normalizing" && <span>녹음 변환 중(16kHz WAV)…</span>}
                {job.phase === "uploading" && <span>전사·채점 중…</span>}
                {job.phase === "failed" && (
                  <>
                    <span className={s.error}>{job.message}</span>
                    {job.retriable && local && a && isScorableToeicAnswer(a) && (
                      <button type="button" className="u-btn u-btn-secondary" onClick={() => void runScoring([v.q])} disabled={running}>
                        ↻ 다시 채점
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* 전사문 */}
            {a?.transcript !== null && a?.transcript !== undefined && (
              <div className={s.block}>
                <p className={s.label}>내가 말한 것(전사)</p>
                {noResp ? (
                  <p className={s.noResp}>{TOEIC_NO_RESPONSE_KO}</p>
                ) : (
                  <p className={s.transcript} lang="en">
                    {a.transcript}
                  </p>
                )}
              </div>
            )}

            {/* Q1–2 대조 */}
            {v.passage && (
              <div className={s.block}>
                <div className={s.labelRow}>
                  <p className={s.label}>{readMarks ? "지문 대조" : "지문"}</p>
                  {playBtn(`passage-${v.q}`, v.passage, `Q${v.q} 지문`)}
                </div>
                {readMarks && a?.readDiff ? (
                  <>
                    <p className={s.readStats}>
                      정확도 {Math.round(a.readDiff.accuracy * 100)}% · 빠짐 {readMarks.missingCount} · 바뀜 {readMarks.substitutedCount} · 더 말함{" "}
                      {readMarks.extra.length}
                    </p>
                    <p className={s.passage} lang="en">
                      {readMarks.segments.map((seg, k) =>
                        seg.space || seg.status === "ok" ? (
                          <Fragment key={k}>{seg.text}</Fragment>
                        ) : seg.status === "missing" ? (
                          <del key={k} className={s.missing} title="빠진 단어">
                            {seg.text}
                          </del>
                        ) : (
                          <mark key={k} className={s.substituted} title={`들린 말: ${seg.heard ?? ""}`}>
                            {seg.text}
                            <span className={s.heard}>({seg.heard})</span>
                          </mark>
                        ),
                      )}
                    </p>
                    <p className={s.legend}>
                      <del className={s.missing}>취소선</del> 빠진 단어 · <mark className={s.substituted}>밑줄</mark> 다르게 들린 단어(괄호 안이 들린 말)
                      {readMarks.extra.length > 0 && <> · 더 말한 단어: {readMarks.extra.join(", ")}</>}
                    </p>
                    <p className={s.notice}>🔈 {TOEIC_READ_NOTICE_KO}</p>
                  </>
                ) : (
                  <p className={s.passage} lang="en">
                    {v.passage}
                  </p>
                )}
              </div>
            )}

            {/* Q3–11 피드백 */}
            {a?.feedback && !noResp && (
              <div className={s.feedback}>
                <p className={s.summary}>{a.feedback.summaryKo}</p>
                {a.feedback.strengths.length > 0 && (
                  <>
                    <p className={s.label}>👍 잘한 점</p>
                    <ul className={s.list}>
                      {a.feedback.strengths.map((t, k) => (
                        <li key={k}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                {a.feedback.fixes.length > 0 && (
                  <>
                    <p className={s.label}>✏️ 고칠 문장</p>
                    <ul className={s.fixes}>
                      {a.feedback.fixes.map((f, k) => (
                        <li key={k} className={s.fix}>
                          <p className={s.said} lang="en">
                            <span className={s.fixTag}>말한 것</span> {f.said}
                          </p>
                          <p className={s.better} lang="en">
                            <span className={s.fixTag}>이렇게</span> {f.better}
                          </p>
                          <p className={s.why}>{f.whyKo}</p>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {a.feedback.missingKo.length > 0 && (
                  <>
                    <p className={s.label}>🧩 빠진 내용</p>
                    <ul className={s.list}>
                      {a.feedback.missingKo.map((t, k) => (
                        <li key={k}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                {a.feedback.improvedAnswer && (
                  <div className={s.answerBox}>
                    <div className={s.labelRow}>
                      <p className={s.label}>🌱 내 답을 살린 개선 답변</p>
                      {playBtn(`improved-${v.q}`, a.feedback.improvedAnswer, `Q${v.q} 개선 답변`)}
                    </div>
                    <p className={s.answerText} lang="en">
                      {a.feedback.improvedAnswer}
                    </p>
                  </div>
                )}
                {a.feedback.tryExpressions.length > 0 && (
                  <p className={s.tryList}>
                    <span className={s.label}>📒 넣었으면 좋았을 표현</span>
                    {/* tryChip: 공략 틀의 `~` 형태(50자 넘음)가 오면 전역 .u-chip의 nowrap이 폰 폭을 넘긴다 — 칩 안에서 줄바꿈(QA final P2-2) */}
                    {a.feedback.tryExpressions.map((e) => (
                      <span key={e} className={`u-chip u-chip-accent ${s.tryChip}`} lang="en">
                        {e}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            )}

            {/* 모범답변 */}
            {v.sampleAnswer && (
              <details className={s.model}>
                <summary className={s.modelSummary}>모범답변(참고용) 보기</summary>
                <div className={s.labelRow}>
                  <p className={s.label}>모범답변</p>
                  {playBtn(`model-${v.q}`, v.sampleAnswer, `Q${v.q} 모범답변`)}
                </div>
                <p className={s.answerText} lang="en">
                  {highlightUsed(v.sampleAnswer, v.usedExpressions, s.used, flowKeys(v.part), s.usedFrame)}
                </p>
                {(() => {
                  // 모범답변 점검(§12-13-3 — 저장된 흐름으로 잰다, 측정만). 흐름이 없는 문서(옛 문서)는 줄이 없다
                  const line = answerFlowCheckLine(v.sampleAnswer, flowOf(v.part), v.part);
                  if (!line) return null;
                  const gp = toeicGuidePartOfMockPart(v.part);
                  return (
                    <>
                      <p className={s.flowCheck} data-testid={`flow-check-${v.q}`}>
                        {line.textKo}
                      </p>
                      {line.weak && (
                        <p className={s.flowWeak}>
                          {TOEIC_ANSWER_FLOW_WEAK_KO}
                          {gp && (
                            <>
                              {" "}
                              <Link href={toeicGuideFolderHref(gp, { tab: "templates" })} className={s.tplLink}>
                                🧩 템플릿 훈련 →
                              </Link>
                            </>
                          )}
                        </p>
                      )}
                    </>
                  );
                })()}
                {v.tipKo && <p className={s.caption}>💡 {v.tipKo}</p>}
                {/* 응시 뒤 복습 자료(§12-7-5) — 비어 있지 않으면 보인다(실전 결과에도 같다) */}
                {v.keyPointsKo.length > 0 && (
                  <>
                    <p className={s.label}>📌 묘사 포인트</p>
                    <ul className={s.list}>
                      {v.keyPointsKo.map((t, k) => (
                        <li key={k}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                {v.outlineKo.length > 0 && (
                  <>
                    <p className={s.label}>🗂 답변 뼈대</p>
                    <ol className={s.olist}>
                      {v.outlineKo.map((t, k) => (
                        <li key={k}>{t}</li>
                      ))}
                    </ol>
                  </>
                )}
              </details>
            )}

            {/* 🧩 틀 점검(AI 없음 — 연습은 펼쳐서, 실전 모의고사는 닫힌 접기로, §12-7-9·§12-13-3) */}
            {(() => {
              const data = checks[v.part];
              const result = checkResults.get(v.q);
              if (!data || !result) return null;
              const tplHref = (key: string) => toeicGuideFolderHref(data.part, { tab: "templates", tpl: key });
              const body = (
                <>
                  {result.scored && (
                    <div className={s.block}>
                      <p className={s.label}>내 답에서 쓴 틀</p>
                      {result.used.length > 0 ? (
                        <ul className={s.tplList}>
                          {result.used.map((u) => {
                            const t = checkTplByKey.get(u.key);
                            if (!t) return null;
                            return (
                              <li key={u.key} className={s.tplItem}>
                                <span className={s.tplMeta}>{u.stepKo ? `${u.stepKo} · ${u.groupKo}` : u.groupKo}</span>
                                <TemplateMini t={t} />
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className={s.caption}>받아쓰기에서 찾은 틀이 없어요.</p>
                      )}
                    </div>
                  )}
                  {result.scored && result.flowChecked && (
                    <div className={s.block}>
                      <p className={s.label}>빠진 단계</p>
                      {result.missingSteps.length > 0 ? (
                        <p className={s.tplSteps}>
                          {result.missingSteps.map((st) => (
                            <span key={st} className="u-chip">
                              {st}
                            </span>
                          ))}
                        </p>
                      ) : (
                        <p className={s.caption}>답변 흐름의 단계를 모두 지났어요 ✓</p>
                      )}
                    </div>
                  )}
                  <div className={s.block}>
                    <p className={s.label}>{result.scored ? "쓸 수 있었던 틀" : "모범답변이 쓴 틀"}</p>
                    {result.suggestions.length > 0 ? (
                      <ul className={s.tplList}>
                        {result.suggestions.map((sg) => {
                          const t = checkTplByKey.get(sg.key);
                          if (!t) return null;
                          return (
                            <li key={sg.key} className={s.tplItem}>
                              <span className={s.tplMeta}>{TOEIC_DRILL_SUGGESTION_SOURCE_KO[sg.source]}</span>
                              <TemplateMini t={t} />
                              <Link href={tplHref(sg.key)} className={s.tplLink}>
                                이 틀 연습하기 →
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className={s.caption}>{result.scored ? "더 권할 틀이 없어요." : "모범답변에서 되짚히는 틀이 없어요."}</p>
                    )}
                  </div>
                  <p className={s.caption}>
                    {result.scored
                      ? "받아쓰기에서 틀의 고정 부분을 찾은 참고예요(점수가 아니에요) — 발음 때문에 다르게 적히면 쓴 틀도 못 찾을 수 있어요."
                      : "AI 채점을 받으면 내 답에서 쓴 틀과 쓸 수 있었던 틀이 더 보여요."}
                  </p>
                </>
              );
              if (drill) {
                return (
                  <section className={s.tplCheck} aria-label={`Q${v.q} 틀 점검`} data-testid={`tpl-check-${v.q}`}>
                    <p className={s.tplCheckTitle}>🧩 틀 점검</p>
                    {body}
                  </section>
                );
              }
              const summaryKo = result.scored
                ? `🧩 틀 점검 · 쓴 틀 ${result.used.length}${result.flowChecked ? ` · 빠진 단계 ${result.missingSteps.length}` : ""}`
                : `🧩 모범답변의 틀 ${result.suggestions.length} · 채점 뒤 내 틀`;
              return (
                <details className={s.tplCheckFold} aria-label={`Q${v.q} 틀 점검`} data-testid={`tpl-check-${v.q}`}>
                  <summary className={s.tplCheckSummary}>{summaryKo}</summary>
                  <div className={s.tplCheckBody}>{body}</div>
                </details>
              );
            })()}

            {diag && (
              <p className={s.diagLine}>
                진단 · {diag.mimeType || "형식 모름"} {secs(diag.durationMs)} {kb(diag.size)} →{" "}
                {diag.normalized === "wav" ? `WAV ${kb(diag.uploadSize)}` : diag.normalized === "original" ? `원본 그대로(${diag.normError ?? "변환 실패"})` : "변환 전"} · 전사{" "}
                {diag.transcribe === "ok"
                  ? "✓"
                  : diag.transcribe === "stored"
                    ? "저장된 전사문 사용"
                    : diag.transcribe === "no_response"
                      ? "무응답"
                      : diag.transcribe === "failed"
                        ? `실패(${diag.error ?? ""})`
                        : "대기"}
              </p>
            )}
          </article>
        );
      })}

      {/* 진단 캡션 — 마지막 녹음 */}
      <p className={s.diagLine}>
        진단 · 마지막 녹음{" "}
        {lastDiag
          ? `${lastDiag.mimeType || "형식 모름"} · ${secs(lastDiag.durationMs)} · ${kb(lastDiag.size)} · 정규화 ${
              lastDiag.normalized === "wav" ? `WAV ${kb(lastDiag.uploadSize)}` : lastDiag.normalized === "original" ? "실패 — 원본" : "전"
            } · 전사 ${lastDiag.transcribe ?? "대기"}${lastDiag.error ? ` (${lastDiag.error})` : ""}`
          : lastLocal
            ? `${lastLocal.rec.mimeType || "형식 모름"} · ${secs(lastLocal.rec.durationMs)} · ${kb(lastLocal.rec.size)} · 정규화 전 · 전사 전`
            : "이 기기에 없음"}
      </p>

      {drill ? (
        // 한 문제 연습(§12-7-5) — "같은 문제 다시"·"새 문제". "학습 보기로"는 숨긴다(학습 보기는 연습을 유형 폴더로 보낸다)
        <div className={s.row}>
          <Link href={drill.retakeHref} className="u-btn u-btn-secondary">
            ↻ 같은 문제 다시
          </Link>
          <Link href={drill.newHref} className="u-btn u-btn-secondary">
            ✨ 새 문제
          </Link>
        </div>
      ) : (
        <div className={s.row}>
          <Link href={toeicTakeHref(mockId, attempt.scope, partOnly ? firstPart : undefined)} className="u-btn u-btn-secondary">
            ↻ 다시 응시
          </Link>
          <Link href={`/toeic/mocks/${encodeURIComponent(mockId)}`} className="u-btn u-btn-secondary">
            학습 보기로
          </Link>
        </div>
      )}
    </div>
  );
}
