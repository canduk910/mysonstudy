"use client";

/**
 * 모의고사 응시 결과 화면 (아빠의 영어 T5, docs/harness/toeic.md §5·§8) — 클라이언트 컴포넌트.
 *
 * - **내 녹음 ▶**(§13-8): 이 기기 사본(lib/toeic-rec-store — IndexedDB `eunwoo-toeic-rec`) → 서버 사본 순. 서버 사본은 화면이 열릴 때
 *   **미리 받는다**(fetch → Blob → objectURL, 동시 2개 — API 주소를 `<audio src>`에 넣지 않는다: iOS 탭 안 await 금지·Range). 둘 다 없으면
 *   "이 녹음은 아직 서버에 올라가지 않았어요 — 응시한 기기에서 결과 화면을 열면 올라가요". 형식 재생 실패(iPhone의 webm 등)는 그 문항에 안내.
 *   머리에 "🗄️ 녹음 서버 보관 n/m" + 이 기기에 못 올린 녹음이 있으면 "지금 올리기"(대기열 — lib/toeic-rec-upload). 진단 줄 "서버 ✓ 312KB · audio/mp4".
 * - **🎧 비교**(§13-9, 닫힌 접기 — AI 0): ① "▶ 내 답 → 개선 답변"(없으면 모범답변, Q1–2는 지문 — 칩으로 바꾸고 기기에 기억). 탭 안에서 동기로
 *   멈춤 → unlockSpeechPlayback → 공용 `<audio>` play(), ended에서 600ms 뒤 speakQueue(en-US). ② 글자 나란히(폰 위아래·iPad 두 열 — 틀 밑줄은
 *   templateRunSpans, 대상에만 있는 틀은 점선 "이 틀을 쓸 수 있었어요", 빠진 단계 한 줄). ③ 다시 풀기 기록(같은 모의고사·같은 문항 최근 5,
 *   "▶ 그때 → 이번"은 같은 공용 요소의 src를 ended에서 바꾼다) + 문항 머리 점수 변화 칩 + 결과 머리 응시 전체 변화.
 * - **AI 채점 받기**: 녹음이 이 기기 또는 서버에 있고 아직 점수가 없는 문항만, **동시 2개**. 서버 사본뿐이면 내려받은 Blob을 같은 경로로. 문항마다 16kHz mono WAV로 정규화
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
 * - **녹음 관리 · 고칠 문장 다시 녹음**(2026-10-03, docs/harness/toeic.md §14 — AI 0): 문항마다 "🗑 녹음 지우기"(확인 창 — 서버 먼저 → 이 기기
 *   사본·대기열, 점수·전사·피드백은 남고 그 문항은 다시 채점할 수 없다). 피드백 "고칠 문장"마다 🔊 고친 문장 · 🎤 다시 말하기(결과 화면 세션
 *   동안 마이크 하나 — components/use-toeic-fix-recorder) · ▶ 내 목소리 · ⇄ 내 목소리 → 고친 문장(공용 플레이어 이어 듣기) · 🗑. 다시 한 녹음은
 *   곧바로 서버에 올라가 고칠 문장마다 최신 하나로 바뀌고 다른 기기에서도 들린다. 지운 자리(recordingDeletions)가 덮는 이 기기 사본은 열 때 지운다.
 * - **문항 단위 다시 풀기**(2026-10-03, docs/harness/toeic.md §15-7): 닫힌 응시면 문항 카드마다 "↻ 이 문항 다시 풀기", 오류 문항(녹음 없음·실패·중단·
 *   소리 없음(무음)·채점 실패·녹음 지움)이 있으면 위에 "↻ 오류 문항 n개 다시 풀기"(lib/toeic-retake toeicErrorQuestions). 다시 푼 답은 원래 결과에
 *   합쳐지고 예전 답은 ③ "다시 풀기 전" 행으로 남는다(▶는 이 기기 사본(그 세대) → 서버 `…/history/[rid]`). 이 기기 사본은 세대(retakeId)가 지금 답과
 *   같을 때만 "지금 녹음"으로 쓴다(toeicLocalCopyRole — 다른 기기에서 다시 푼 뒤 예전 사본으로 새 답을 채점하지 않게). 문항 카드에 F2 진단 줄.
 *   머리에 "다시 풀기 전 추정 → 지금"(toeicRetakeEstimates).
 * - 모범답변 접기에 **모범답변 점검 줄**("🧩 모범답변의 틀 n개 · 단계 a/b" — 문서에 저장된 흐름으로 잰다, 옛 문서는 줄 없음)과 크게 덜 따랐으면
 *   미달 경고(→ ② 템플릿 훈련). 모범답변 속 강조는 틀 글자에서 온 구간을 🧩 색으로 따로 보인다(흐름 글자 집합에 드는가로 가른다).
 * - **🖨️ 인쇄 · PDF 저장**(2026-10-03, docs/harness/toeic.md §16 — 서버·AI 0): `window.print()` + 모듈 CSS의 @media print. 인쇄에는 머리(범위·제목·
 *   응시 날짜·추정 등급·채점 상태)와 문항마다 문제(사진·지문·표·질문)·전사문·점수·피드백 전부·모범답변 접기 속 전부가 들어가고, 버튼·재생·녹음·
 *   🎧 비교·🧩 틀 점검·다시 풀기·설정·진단·서버 줄은 빠진다. 표 보기·모범답변 접기(`data-print-expand`)는 인쇄 직전에 열고 끝나면 이 화면이 연
 *   것만 닫는다(components/use-print-expand — beforeprint·버튼 둘 다).
 * - **인쇄할 항목**(§16-10): 버튼 아래 체크박스 6개(전사·잘한 점·고칠 문장·빠진 내용·개선 답변·모범답변 — lib/toeic-print-sections).
 *   끈 항목은 루트의 `data-print-omit-{key}` + 묶음의 `data-print-sec`로 **인쇄에서만** 빠진다(화면 그대로). 기기에 기억(끈 목록).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ToeicInfoTableView from "@/components/toeic-info-table";
import ToeicMicKeepToggle from "@/components/toeic-mic-keep-toggle";
import { usePrintExpand } from "@/components/use-print-expand";
import {
  TOEIC_PRINT_SECTIONS,
  TOEIC_PRINT_SECTIONS_STORAGE_KEY,
  TOEIC_PRINT_SECTION_KO,
  parseToeicPrintOmit,
  serializeToeicPrintOmit,
  toeicPrintOmitAttrs,
  toeicPrintPickSummaryKo,
  toggleToeicPrintOmit,
  type ToeicPrintSection,
} from "@/lib/toeic-print-sections";
import TtsEngineControl from "@/components/tts-engine-control";
import TtsSpeedControl from "@/components/tts-speed-control";
import { toWav16kMono } from "@/lib/mic-session";
import { prefetchSpeech, speakQueue, unlockSpeechPlayback } from "@/lib/speech";
import { fixSlotKey, useToeicFixRecorder } from "@/components/use-toeic-fix-recorder";
import {
  TOEIC_SCORE_AUDIO_MAX_BYTES,
  TOEIC_SCORE_CONCURRENCY,
  TOEIC_SCORE_FIELD_AUDIO,
  TOEIC_SCORE_FIELD_Q,
  isAcceptedToeicAudioType,
  toeicAudioBaseType,
  toeicAudioFileName,
  toeicRecordingHistoryHref,
  toeicRecordingHref,
  type ToeicAnswer,
  type ToeicAttemptFinishResponse,
  type ToeicAttemptRecord,
  type ToeicQuestionView,
  type ToeicRecordingDeleteResponse,
  type ToeicRecordingDeletion,
  type ToeicRecordingGetErrorResponse,
  type ToeicScoreResponse,
  type ToeicStoredFixRecording,
  type ToeicStoredRecording,
} from "@/lib/toeic-attempt-contract";
import { isToeicRecordingTombstoned } from "@/lib/toeic-rec-rules";
import {
  TOEIC_ERROR_REASON_KO,
  toeicAnswerRecordingDeleted,
  toeicAnswerSourceOf,
  toeicDeletedHistoryLocalCopies,
  toeicOtherAttemptLocalCopies,
  toeicErrorQuestions,
  toeicLocalCopyRole,
  toeicOpenRetake,
  toeicRetakeEstimates,
  toeicRetakeHref,
} from "@/lib/toeic-retake";
import { toeicAnswerDiagLineKo } from "@/lib/toeic-mic-health";
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
import { answerFlowExpressions, frameSlotNames, templateRunSpans, templateSpanSegments } from "@/lib/toeic-template";
import { expressionKey } from "@/lib/toeic-text";
import { markReadAloud } from "@/lib/toeic-read-marks";
import { deleteToeicRecordingsLocal, listToeicRecordings, type ToeicRecording } from "@/lib/toeic-rec-store";
import { drainToeicRecUploads } from "@/lib/toeic-rec-upload";
import { useToeicRecUploadDrain, useToeicRecUploadStates } from "@/components/use-toeic-rec-uploads";
import {
  TOEIC_COMPARE_TARGET_KO,
  TOEIC_COMPARE_TARGET_STORAGE_KEY,
  parseToeicCompareTargetPref,
  pickToeicCompareTarget,
  toeicAttemptDelta,
  toeicAttemptDeltaLabelKo,
  toeicPreviousAttempt,
  toeicQuestionHistory,
  toeicScoreDelta,
  toeicScoreDeltaLabelKo,
  type ToeicCompareAttempt,
  type ToeicCompareTargetPref,
} from "@/lib/toeic-compare";
import { formatKst } from "@/lib/kst";
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

/** 재생·채점에 쓰는 소리 한 개(§13-8 — 이 기기 사본 → 서버 사본) */
type Clip =
  | { status: "loading" }
  | { status: "ready"; url: string; blob: Blob; source: "local" | "server"; mimeType: string; size: number }
  | { status: "error"; message: string };

const clipKey = (attemptId: string, q: number, fixIndex?: number, historyOf?: string) =>
  historyOf !== undefined ? `${attemptId}:${q}:h${historyOf}` : fixIndex === undefined ? `${attemptId}:${q}` : `${attemptId}:${q}:f${fixIndex}`;

/** Q1–2 안내를 둘로 — 앞 구절(채점 범위)은 인쇄에도, " — 녹음을 다시 들어 보세요"(화면 조작)는 화면에만 */
const READ_NOTICE_CUT = TOEIC_READ_NOTICE_KO.indexOf(" — ");
const READ_NOTICE_HEAD = READ_NOTICE_CUT < 0 ? TOEIC_READ_NOTICE_KO : TOEIC_READ_NOTICE_KO.slice(0, READ_NOTICE_CUT);
const READ_NOTICE_TAIL = READ_NOTICE_CUT < 0 ? "" : TOEIC_READ_NOTICE_KO.slice(READ_NOTICE_CUT);

/** 서버 사본 미리 받기 동시 수(§13-8) */
const SERVER_PREFETCH_CONCURRENCY = 2;
/** 이어 듣기 — 내 녹음이 끝난 뒤 쉬는 시간(§13-9 ①) */
const CHAIN_GAP_MS = 600;

/** 형식 재생 실패 안내(§13-8) — "이 기기에서 재생할 수 없는 형식(webm)이에요" */
function formatErrorKo(mimeType: string): string {
  const short = (mimeType.split(";")[0].split("/")[1] ?? "").trim() || "알 수 없음";
  return `이 기기에서 재생할 수 없는 형식(${short})이에요 — 녹음한 기기에서 들어 보세요.`;
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
  history = [],
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
  /** 🎧 비교 ③ — 같은 모의고사 응시(최신 20회, 줄인 자료 — 이번 응시 포함, 시간순) */
  history?: ToeicCompareAttempt[];
}) {
  const router = useRouter();
  const id = attempt.id;
  // 🖨️ 인쇄 · PDF 저장(§16) — 접기 펼치기·lazy 사진 받기는 훅이(beforeprint·버튼 둘 다)
  const printRootRef = useRef<HTMLDivElement | null>(null);
  const { printNow, preparing: printPreparing } = usePrintExpand(printRootRef);
  // 인쇄할 항목(§16-10) — 끈 항목 목록. 첫 렌더는 전부 켬(서버와 같게), 마운트 뒤 기기 기억을 읽는다(try/catch — 실패하면 전부 켬)
  const [printOmit, setPrintOmit] = useState<ToeicPrintSection[]>([]);
  useEffect(() => {
    try {
      setPrintOmit(parseToeicPrintOmit(window.localStorage.getItem(TOEIC_PRINT_SECTIONS_STORAGE_KEY)));
    } catch {
      // 전부 켬
    }
  }, []);
  function setPrintSection(key: ToeicPrintSection, on: boolean) {
    const next = toggleToeicPrintOmit(printOmit, key, on);
    setPrintOmit(next);
    try {
      window.localStorage.setItem(TOEIC_PRINT_SECTIONS_STORAGE_KEY, serializeToeicPrintOmit(next));
    } catch {
      // 기억 못 해도 지금 화면에는 반영된다
    }
  }
  /** 받지 못한 사진(404·네트워크) — 그 문항은 장면 설명 줄로 바꾼다(화면·인쇄 공통, QA print 1 F4) */
  const [brokenImgs, setBrokenImgs] = useState<ReadonlySet<number>>(() => new Set());
  const markBrokenImg = useCallback((q: number) => setBrokenImgs((prev) => (prev.has(q) ? prev : new Set(prev).add(q))), []);
  useEffect(() => {
    // 하이드레이션 전에 이미 실패한 사진(onError를 놓쳤을 수 있다) — complete인데 크기가 0
    for (const img of Array.from(printRootRef.current?.querySelectorAll<HTMLImageElement>("img[data-q]") ?? [])) {
      if (img.complete && img.naturalWidth === 0) markBrokenImg(Number(img.dataset.q));
    }
  }, [markBrokenImg]);
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

  // ── 서버 녹음 메타(§13-5·§14) — 페이지 값에서 시작해 이 화면의 지우기·고칠 문장 업로드 응답으로 바꾼다 ──
  type ServerRecState = { recordings: ToeicStoredRecording[]; fixRecordings: ToeicStoredFixRecording[]; recordingDeletions: ToeicRecordingDeletion[] };
  const fromAttempt = (a: ToeicAttemptRecord): ServerRecState => ({ recordings: a.recordings, fixRecordings: a.fixRecordings, recordingDeletions: a.recordingDeletions });
  const [srv, setSrv] = useState<ServerRecState>(() => fromAttempt(attempt));
  useEffect(() => {
    setSrv(fromAttempt(attempt));
  }, [attempt]);
  const deletionsRef = useRef(srv.recordingDeletions);
  useEffect(() => {
    deletionsRef.current = srv.recordingDeletions;
  }, [srv.recordingDeletions]);

  // ── 이 기기의 녹음 ──
  const [recs, setRecs] = useState<Map<number, LocalRec>>(new Map());
  /** 이 응시의 예전 답(다시 풀기 전 세대) 이 기기 사본 — 키 `${q}:${replacedBy}`(§15-7 ③) */
  const [histLocal, setHistLocal] = useState<Map<string, LocalRec>>(new Map());
  const historyRef0 = useRef<{ answerHistory: ToeicAttemptRecord["answerHistory"] }>({ answerHistory: attempt.answerHistory });
  useEffect(() => {
    historyRef0.current = { answerHistory: attempt.answerHistory };
  }, [attempt.answerHistory]);
  const [recsLoaded, setRecsLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    void listToeicRecordings(id).then((all) => {
      if (!alive) return;
      // 다른 기기·목록에서 지운 녹음(지운 자리가 이 사본의 녹음 시각을 덮는다)은 이 기기 사본도 지운다(§14-4)
      const gone = all.filter((r) => isToeicRecordingTombstoned(deletionsRef.current, r.q, null, r.createdAt));
      if (gone.length > 0) void deleteToeicRecordingsLocal(id, gone.map((r) => r.q));
      // 다른 기기·목록에서 지운 예전 답(이력 줄 recordingDeletedAt — 지운 자리를 남기지 않는다)의 이 기기 사본도 지운다.
      // 지금 답 세대 사본은 keepGeneration으로 남긴다(§15-8, QA rec-retake P2-4)
      const histGone = toeicDeletedHistoryLocalCopies(historyRef0.current, all.filter((r) => !gone.includes(r)));
      for (const p of histGone) void deleteToeicRecordingsLocal(id, [p.q], { keepGeneration: p.keepGeneration });
      const histGoneQ = new Set(histGone.map((p) => p.q));
      const list = all.filter((r) => !gone.includes(r) && !histGoneQ.has(r.q)); // 문항마다 사본은 하나(키 `{attemptId}:{q}`)
      // 세대(§15-6) — 지금 답 세대의 사본만 "지금 녹음", 예전 세대의 사본은 그 이력 줄(③)에, 어느 쪽도 아니면 쓰지 않는다
      const m = new Map<number, LocalRec>();
      const hm = new Map<string, LocalRec>();
      for (const r of list) {
        const role = toeicLocalCopyRole(historyRef0.current, r.q, r.retakeId);
        if (role.role === "stale") continue;
        const url = URL.createObjectURL(r.blob);
        urls.push(url);
        if (role.role === "current") m.set(r.q, { url, rec: r });
        else hm.set(`${r.q}:${role.replacedBy}`, { url, rec: r });
      }
      setRecs(m);
      setHistLocal(hm);
      setRecsLoaded(true);
    });
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [id]);

  // ── 서버 보관(§13-3·§13-8) — 대기열 계기 + 문항별 서버 메타(페이지 값 위에 이 화면에서 올라간 것을 얹는다) ──
  useToeicRecUploadDrain();
  const live = useToeicRecUploadStates(id);
  const serverRecs = useMemo(() => {
    const m = new Map<number, ToeicStoredRecording>(srv.recordings.map((r) => [r.q, r] as const));
    for (const [q, st] of Object.entries(live)) {
      if (st.state !== "done" || !st.recording) continue;
      // 이 화면에서 지운 뒤 늦게 끝난 업로드 이벤트가 지운 녹음을 되살리지 않게
      if (isToeicRecordingTombstoned(srv.recordingDeletions, Number(q), null, Date.parse(st.recording.recordedAt))) continue;
      m.set(Number(q), st.recording);
    }
    return m;
  }, [srv.recordings, srv.recordingDeletions, live]);
  /** 이 기기에 아직 못 올린(pending) 이 응시 녹음 수 — "지금 올리기" */
  const pendingHere = [...recs.values()].filter((r) => {
    const st = live[r.rec.q];
    if (st && st.createdAt === r.rec.createdAt) return st.state === "pending" || st.state === "uploading";
    return r.rec.upload === "pending";
  }).length;
  const [draining, setDraining] = useState(false);
  async function uploadNow() {
    setDraining(true);
    try {
      await drainToeicRecUploads();
    } finally {
      setDraining(false);
    }
  }

  // ── 다른 응시(다시 풀기 기록)의 이 기기 사본 — 비교 ③ 이어 듣기가 서버 사본보다 먼저 쓴다 ──
  const [otherLocal, setOtherLocal] = useState<Map<string, Map<number, LocalRec>>>(new Map());
  const historyIdsKey = history.map((h) => h.id).filter((x) => x !== id).join(",");
  // 그 응시들의 세대·지운 예전 답이 바뀌면(새로고침으로 다른 기기의 다시 풀기·지우기가 들어오면) 다시 가른다(P2-5)
  const historyGenKey = history
    .filter((h) => h.id !== id)
    .map((h) => `${h.id}=${(h.answerHistory ?? []).map((e) => `${e.q}:${e.replacedBy}:${e.recordingDeletedAt ?? ""}`).join(";")}|${(h.recordingDeletions ?? []).length}`)
    .join(",");
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    const ids = historyIdsKey ? historyIdsKey.split(",") : [];
    void Promise.all(ids.map(async (aid) => [aid, await listToeicRecordings(aid)] as const)).then((pairs) => {
      if (!alive) return;
      const out = new Map<string, Map<number, LocalRec>>();
      for (const [aid, all] of pairs) {
        // 그 응시에서 지운 녹음은 이 기기 사본도 지운다(§14-4 — 다시 풀기 기록이 지운 목소리를 틀지 않게)
        const other = historyRef.current.find((h) => h.id === aid);
        const dels = other?.recordingDeletions ?? [];
        const gone = all.filter((r) => isToeicRecordingTombstoned(dels, r.q, null, r.createdAt));
        if (gone.length > 0) void deleteToeicRecordingsLocal(aid, gone.map((r) => r.q));
        // 세대(§15-6, QA rec-retake 2 P2-5) — 그 응시의 지금 답 세대 사본만 "그 응시의 지금 답" 행에. 다른 기기에서 다시 풀어 합쳤으면
        // 이 기기의 예전 세대 사본은 쓰지 않고(서버 사본을 받는다), 그 응시에서 지운 예전 답 사본은 지운다(지금 세대 사본은 keepGeneration으로 남긴다)
        const split = toeicOtherAttemptLocalCopies({ answerHistory: other?.answerHistory ?? [] }, all.filter((r) => !gone.includes(r)));
        for (const p of split.purge) void deleteToeicRecordingsLocal(aid, [p.q], { keepGeneration: p.keepGeneration });
        const list = split.current;
        if (list.length === 0) continue;
        const m = new Map<number, LocalRec>();
        for (const r of list) {
          const url = URL.createObjectURL(r.blob);
          urls.push(url);
          m.set(r.q, { url, rec: r });
        }
        out.set(aid, m);
      }
      setOtherLocal(out);
    });
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [historyIdsKey, historyGenKey]);

  // ── 서버 사본 미리 받기(§13-8) — fetch → Blob → objectURL. `<audio src>`에 API 주소를 넣지 않는다(iOS 탭 규칙·Range) ──
  const [clips, setClips] = useState<Record<string, Clip>>({});
  const clipsRef = useRef(clips);
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);
  const clipUrlsRef = useRef<string[]>([]);
  const inflightRef = useRef(new Map<string, Promise<Clip>>());
  useEffect(
    () => () => {
      for (const u of clipUrlsRef.current) URL.revokeObjectURL(u);
      clipUrlsRef.current = [];
    },
    [],
  );
  const ensureServerClip = useCallback((attemptId: string, q: number, fixIndex?: number, historyOf?: string): Promise<Clip> => {
    const key = clipKey(attemptId, q, fixIndex, historyOf);
    const cur = clipsRef.current[key];
    if (cur && cur.status === "ready") return Promise.resolve(cur);
    const running = inflightRef.current.get(key);
    if (running) return running;
    setClips((prev) => ({ ...prev, [key]: { status: "loading" } }));
    const p = (async (): Promise<Clip> => {
      try {
        // fixIndex가 있으면 고칠 문장 녹음(§14-5), historyOf가 있으면 다시 풀기 전 예전 답 녹음(§15-8)
        const res =
          historyOf !== undefined
            ? await fetch(toeicRecordingHistoryHref(attemptId, q, historyOf), { cache: "no-store" })
            : await fetch(toeicRecordingHref(attemptId, q, fixIndex), { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as ToeicRecordingGetErrorResponse | null;
          return { status: "error", message: body?.messageKo ?? `서버 사본을 받지 못했어요(${res.status}).` };
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        clipUrlsRef.current.push(url);
        return { status: "ready", url, blob, source: "server", mimeType: blob.type || res.headers.get("content-type") || "", size: blob.size };
      } catch {
        return { status: "error", message: "네트워크 문제로 서버 사본을 받지 못했어요." };
      }
    })().then((c) => {
      inflightRef.current.delete(key);
      clipsRef.current = { ...clipsRef.current, [key]: c };
      setClips((prev) => ({ ...prev, [key]: c }));
      return c;
    });
    inflightRef.current.set(key, p);
    return p;
  }, []);

  /** 그 응시·문항의 소리 — 이 기기 사본이 먼저, 없으면 서버 사본(받는 중·실패·없음 포함). 어디에도 없으면 null. */
  const clipFor = useCallback(
    (attemptId: string, q: number): Clip | null => {
      const local = attemptId === id ? recs.get(q) : otherLocal.get(attemptId)?.get(q);
      if (local) return { status: "ready", url: local.url, blob: local.rec.blob, source: "local", mimeType: local.rec.mimeType, size: local.rec.size };
      return clips[clipKey(attemptId, q)] ?? null;
    },
    [id, recs, otherLocal, clips],
  );

  // 이 응시의 서버 사본 — 이 기기 사본이 없는 문항만, 동시 2개(실전 한 회 약 5MB)
  const serverOnlyKey = recsLoaded
    ? [...serverRecs.keys()].filter((q) => !recs.has(q)).sort((a, b) => a - b).join(",")
    : "";
  useEffect(() => {
    if (!serverOnlyKey) return;
    const queue = serverOnlyKey.split(",").map(Number);
    const worker = async () => {
      while (queue.length > 0) await ensureServerClip(id, queue.shift()!);
    };
    void Promise.all(Array.from({ length: Math.min(SERVER_PREFETCH_CONCURRENCY, queue.length) }, () => worker()));
  }, [serverOnlyKey, id, ensureServerClip]);
  const [formatErrors, setFormatErrors] = useState<Record<string, string>>({});
  const markFormatError = useCallback((attemptId: string, q: number, mimeType: string, fixIndex?: number) => {
    setFormatErrors((prev) => ({ ...prev, [clipKey(attemptId, q, fixIndex)]: formatErrorKo(mimeType) }));
  }, []);

  // ── 고칠 문장 다시 말하기(§14-5) — 결과 화면 세션 동안 마이크 하나, 끝나면 메모리 → 바로 서버. AI 0 ──
  const onFixStored = useCallback((rec: ToeicStoredFixRecording) => {
    setSrv((prev) => ({
      ...prev,
      fixRecordings: [...prev.fixRecordings.filter((r) => !(r.q === rec.q && r.fixIndex === rec.fixIndex)), rec].sort((a, b) => a.q - b.q || a.fixIndex - b.fixIndex),
    }));
  }, []);
  const answerSourceOf = useCallback((q: number) => toeicAnswerSourceOf(attempt, q), [attempt]);
  const fixRec = useToeicFixRecorder(id, onFixStored, answerSourceOf);
  const fixMeta = (q: number, i: number) => srv.fixRecordings.find((r) => r.q === q && r.fixIndex === i) ?? null;
  /** 고칠 문장 녹음 소리 — 이 화면에서 방금 한 녹음(메모리) → 서버 사본 */
  const fixClipFor = (q: number, i: number): Clip | null => {
    const take = fixRec.takes[fixSlotKey(q, i)];
    if (take) return { status: "ready", url: take.url, blob: take.blob, source: "local", mimeType: take.mimeType, size: take.size };
    return fixMeta(q, i) ? (clips[clipKey(id, q, i)] ?? null) : null;
  };
  // 서버 사본 미리 받기(§13-8 규칙 그대로 — iOS 탭 안 await 금지) — 이 화면에서 녹음하지 않은 고칠 문장 녹음만, 동시 2개
  const fixServerKey = srv.fixRecordings
    .filter((r) => !fixRec.takes[fixSlotKey(r.q, r.fixIndex)])
    .map((r) => `${r.q}:${r.fixIndex}:${r.sha256.slice(0, 8)}`)
    .join(",");
  useEffect(() => {
    if (!fixServerKey) return;
    const queue = fixServerKey.split(",").map((x) => x.split(":").map(Number) as [number, number]);
    const worker = async () => {
      while (queue.length > 0) {
        const [q, i] = queue.shift()!;
        await ensureServerClip(id, q, i);
      }
    };
    void Promise.all(Array.from({ length: Math.min(SERVER_PREFETCH_CONCURRENCY, queue.length) }, () => worker()));
  }, [fixServerKey, id, ensureServerClip]);

  // ── 녹음 지우기(§14-4) — 확인 창 → 서버 먼저(보관소 → 메타·지운 자리) → 이 기기 사본·대기열 → 화면 ──
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ key: string; message: string } | null>(null);
  /** 받아 둔 서버 사본을 버린다(다시 받지 않게 — 메타가 사라졌다) */
  const dropClip = (key: string) => {
    const c = clipsRef.current[key];
    if (c && c.status === "ready") URL.revokeObjectURL(c.url);
    setClips((prev) => {
      const next = { ...prev };
      delete next[key];
      clipsRef.current = next;
      return next;
    });
  };
  async function deleteRecording(target: { kind: "answer"; q: number } | { kind: "fix"; q: number; fixIndex: number }) {
    const key = target.kind === "answer" ? `a:${target.q}` : `f:${target.q}:${target.fixIndex}`;
    const what = target.kind === "answer" ? `Q${target.q} 내 답변 녹음` : `Q${target.q} 고칠 문장 ${target.fixIndex + 1}의 다시 말한 녹음`;
    const tail = target.kind === "answer" ? " 점수·전사·피드백은 남지만 이 문항은 다시 채점할 수 없어요." : "";
    if (!window.confirm(`${what}을 지울까요?\n서버와 이 기기에서 모두 지워지고 되돌릴 수 없어요.${tail}`)) return;
    stopAllPlayback();
    setDeleting(key);
    setDeleteError(null);
    try {
      const res = await fetch(target.kind === "answer" ? toeicRecordingHref(id, target.q) : toeicRecordingHref(id, target.q, target.fixIndex), { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as ToeicRecordingDeleteResponse | null;
      if (!data?.ok) {
        setDeleteError({ key, message: data && !data.ok ? data.messageKo : `지우지 못했어요(${res.status}). 다시 눌러 주세요.` });
        return;
      }
      // 서버가 지웠다 → 이 기기 사본(대기열 포함 — 업로드도 취소)·메모리·받아 둔 사본
      if (target.kind === "answer") {
        await deleteToeicRecordingsLocal(id, [target.q]);
        setRecs((prev) => {
          const r = prev.get(target.q);
          if (!r) return prev;
          URL.revokeObjectURL(r.url);
          const next = new Map(prev);
          next.delete(target.q);
          return next;
        });
        dropClip(clipKey(id, target.q));
      } else {
        fixRec.forget([fixSlotKey(target.q, target.fixIndex)]);
        dropClip(clipKey(id, target.q, target.fixIndex));
      }
      setSrv({ recordings: data.recordings, fixRecordings: data.fixRecordings, recordingDeletions: data.recordingDeletions });
    } catch {
      setDeleteError({ key, message: "네트워크 문제로 지우지 못했어요. 다시 눌러 주세요." });
    } finally {
      setDeleting(null);
    }
  }

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
  const serverRecsRef = useRef(serverRecs);
  useEffect(() => {
    serverRecsRef.current = serverRecs;
  }, [serverRecs]);

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
      // 소리 출처(§13-8): 이 기기 사본 → 서버 사본(내려받은 Blob — 다른 기기 채점). 채점 라우트 계약은 그대로(WAV 정규화 → multipart)
      const local = recsRef.current.get(q);
      let rec: { blob: Blob; mimeType: string; durationMs: number; size: number };
      if (local) {
        rec = local.rec;
      } else {
        const meta = serverRecsRef.current.get(q);
        if (!meta) {
          setJob(q, { phase: "failed", message: "녹음이 이 기기에도 서버에도 없어 채점할 수 없어요.", retriable: false });
          return;
        }
        setJob(q, { phase: "normalizing" });
        const clip = await ensureServerClip(id, q);
        if (clip.status !== "ready") {
          setJob(q, { phase: "failed", message: clip.status === "error" ? clip.message : "서버 사본을 받지 못했어요.", retriable: true });
          return;
        }
        rec = { blob: clip.blob, mimeType: meta.mimeType, durationMs: meta.durationMs, size: meta.size };
      }
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
        // 채점하는 사이 그 문항을 다시 풀어 답이 바뀌었다(§15-6) — 서버 값으로 다시 읽는다
        if (data.error === "answer_changed") router.refresh();
        setJob(q, { phase: "failed", message: data.messageKo, retriable: data.retriable === true || data.error === "client_closed" });
        patchDiag(q, { transcribe: "failed", error: `${status} ${data.error}` });
        return;
      }
      setJob(q, { phase: "failed", message: `채점 응답을 받지 못했어요(${status || "연결 끊김"}). 다시 시도해 주세요.`, retriable: true });
      patchDiag(q, { transcribe: "failed", error: `${status} 본문 없음` });
    },
    [id, patchDiag, setJob, ensureServerClip, router],
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
  /** 소리가 있는 문항(이 기기 사본 또는 서버 사본 — §13-8 "AI 채점 받기" 대상이 넓어진다) */
  const hasSound = (q: number) => recs.has(q) || serverRecs.has(q);
  /**
   * 이 문항 **지금 답**의 녹음을 지웠는가(§14-4 — 지운 자리) — 소리가 없으면 "녹음을 지웠어요 · 다시 채점할 수 없어요".
   * 지운 시각이 지금 답 세대의 시작보다 늦을 때만(지운 뒤 다시 풀어 합친 새 답은 "아직 서버에 올라가지 않았어요" — QA rec-retake P2-1)
   */
  const deletionView = { startedAt: attempt.startedAt, retakes: attempt.retakes, answerHistory: attempt.answerHistory, recordingDeletions: srv.recordingDeletions };
  const answerDeleted = (q: number) => !hasSound(q) && toeicAnswerRecordingDeleted(deletionView, q);
  const scorable = qs.filter((q) => {
    const a = answers[q];
    return a && isScorableToeicAnswer(a) && hasSound(q);
  });
  const recordedHere = qs.filter((q) => answers[q]?.recorded && hasSound(q)).length;
  const recordedAll = qs.filter((q) => answers[q]?.recorded).length;
  const deletedCount = qs.filter((q) => answers[q]?.recorded && answerDeleted(q)).length;
  const recordedElsewhere = recordedAll - recordedHere - deletedCount;
  /** 🗄️ 녹음 서버 보관 n/m — m = 녹음된 문항, n = 그중 서버 메타가 있는 문항 */
  const storedOnServer = qs.filter((q) => answers[q]?.recorded && serverRecs.has(q)).length;
  const estimate = estimateToeicTotal(Object.values(answers));
  // ── 문항 단위 다시 풀기(§15-7) — 오류 문항·다시 풀기 전 추정·진행 중 기록 ──
  const diagOf = (q: number) => attempt.answerDiags.find((d) => d.q === q) ?? null;
  const errorQs = closed
    ? toeicErrorQuestions(
        qs.map((q) => {
          const a = answers[q];
          const d = diagOf(q);
          return {
            q,
            recorded: a?.recorded === true,
            score: a?.score ?? null,
            transcript: a?.transcript ?? null,
            diagStatus: d?.status ?? null,
            silent: d?.silent === true,
            deleted: a?.recorded === true && answerDeleted(q),
            scoreFailed: jobs[q]?.phase === "failed",
          };
        }),
      )
    : [];
  const retakeEst = toeicRetakeEstimates(Object.values(answers), attempt.answerHistory);
  const openRetake = toeicOpenRetake(attempt.retakes);
  const retakenUnscored = qs.filter((q) => toeicAnswerSourceOf(attempt, q) !== null && answers[q]?.recorded && answers[q]?.score === null);

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
  /** 지금 재생을 모두 멈춘다 — 🔊 큐 · 이어 듣기 · 화면의 모든 <audio>(녹음·지우기 전에 — 재생과 캡처를 겹치지 않는다) */
  function stopAllPlayback() {
    runRef.current++;
    const stop = stopRef.current;
    stopRef.current = null;
    stop?.();
    setPlayingKey(null);
    stopChain();
    for (const el of Array.from(document.querySelectorAll("audio"))) el.pause();
  }
  function togglePlay(key: string, text: string) {
    if (fixRec.active) void fixRec.stop(); // 녹음 중이면 먼저 멈춘다(재생과 캡처를 겹치지 않는다)
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
    stopChain();
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

  // ── 🎧 비교 이어 듣기(§13-9 ①·③) — 화면에 하나뿐인 공용 <audio>. iOS 탭 규칙: 탭 안에서 동기로 멈춤 → unlockSpeechPlayback →
  //    src 넣고 play(). ended에서 다음 녹음(같은 요소의 src만 바꾼다) 또는 600ms 뒤 speakQueue. ■ 하나가 둘 다 멈춘다(chainRunRef 세대).
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const chainRunRef = useRef(0);
  const chainStopRef = useRef<(() => void) | null>(null);
  const chainTimerRef = useRef<number | null>(null);
  const [chainKey, setChainKey] = useState<string | null>(null);
  function stopChain() {
    chainRunRef.current++;
    if (chainTimerRef.current !== null) window.clearTimeout(chainTimerRef.current);
    chainTimerRef.current = null;
    const stop = chainStopRef.current;
    chainStopRef.current = null;
    stop?.();
    const p = playerRef.current;
    if (p) {
      p.onended = null;
      p.onerror = null;
      p.pause();
    }
    setChainKey(null);
  }
  useEffect(
    () => () => {
      chainRunRef.current++;
      if (chainTimerRef.current !== null) window.clearTimeout(chainTimerRef.current);
      chainStopRef.current?.();
      playerRef.current?.pause();
    },
    [],
  );
  /** 탭 핸들러 안에서 **동기로** 부른다 — clips는 이미 받아 둔 Blob URL이어야 한다(탭 안 await 금지) */
  function playChain(key: string, clipsToPlay: { url: string; attemptId: string; q: number; mimeType: string; fixIndex?: number }[], thenText: string | null) {
    if (chainKey === key) {
      stopChain();
      return;
    }
    if (fixRec.active) void fixRec.stop(); // 녹음 중이면 먼저 멈춘다
    // 지금 재생을 모두 멈춘다 — 🔊 큐, 이어 듣기, 문항 카드의 내 녹음 플레이어
    runRef.current++;
    stopRef.current?.();
    stopRef.current = null;
    setPlayingKey(null);
    stopChain();
    for (const el of Array.from(document.querySelectorAll("audio"))) if (el !== playerRef.current) el.pause();
    unlockSpeechPlayback(); // 뒤이은 탭 밖 speakQueue가 소리 나게(§18-2)
    const p = playerRef.current;
    if (!p) return;
    const run = ++chainRunRef.current;
    let i = 0;
    const finish = () => {
      if (chainRunRef.current !== run) return;
      chainStopRef.current = null;
      setChainKey(null);
    };
    const next = () => {
      if (chainRunRef.current !== run) return;
      if (i < clipsToPlay.length) {
        const c = clipsToPlay[i++];
        p.onended = next;
        p.onerror = () => {
          if (chainRunRef.current !== run) return;
          markFormatError(c.attemptId, c.q, c.mimeType, c.fixIndex);
          finish();
        };
        p.src = c.url;
        void p.play().catch(() => {
          if (chainRunRef.current === run) finish();
        });
        return;
      }
      p.onended = null;
      p.onerror = null;
      const pieces = thenText ? enPieces(thenText) : [];
      if (pieces.length === 0) return finish();
      chainTimerRef.current = window.setTimeout(() => {
        chainTimerRef.current = null;
        if (chainRunRef.current !== run) return;
        chainStopRef.current = speakQueue(pieces, { onEnd: finish });
      }, CHAIN_GAP_MS);
    };
    setChainKey(key);
    next();
  }

  // 비교 대상 칩(§13-9 ①) — 마지막 선택은 기기에 기억(try/catch — 실패하면 기본값)
  const [targetPref, setTargetPref] = useState<ToeicCompareTargetPref>("improved");
  useEffect(() => {
    try {
      setTargetPref(parseToeicCompareTargetPref(window.localStorage.getItem(TOEIC_COMPARE_TARGET_STORAGE_KEY)));
    } catch {
      // 기본값
    }
  }, []);
  function chooseTarget(p: ToeicCompareTargetPref) {
    setTargetPref(p);
    try {
      window.localStorage.setItem(TOEIC_COMPARE_TARGET_STORAGE_KEY, p);
    } catch {
      // 기억 못 해도 지금 화면에는 반영된다
    }
  }

  // 다시 풀기 기록(§13-9 ③) — 이번 응시는 이 화면의 최신 답·서버 메타로 바꿔 끼운다
  const compareAttempts = useMemo((): ToeicCompareAttempt[] => {
    const curH = history.find((h) => h.id === id);
    const cur: ToeicCompareAttempt = {
      id,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      scope: attempt.scope,
      answers: Object.values(answers).map((a) => ({ q: a.q, recorded: a.recorded === true, score: a.score, transcript: a.transcript })),
      recordings: [...serverRecs.values()],
      // 다시 풀기 전 예전 답(§15-7) — 페이지가 줄여 넘긴 이 응시의 이력 줄·지금 답 세대 시작 시각
      answerHistory: curH?.answerHistory ?? [],
      answerSince: curH?.answerSince ?? [],
    };
    const others = history.filter((h) => h.id !== id);
    return [...others, cur].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  }, [history, id, attempt.startedAt, attempt.finishedAt, attempt.scope, answers, serverRecs]);
  const attemptDelta = useMemo(() => {
    const cur = compareAttempts.find((a) => a.id === id);
    return cur ? toeicAttemptDelta(cur, toeicPreviousAttempt(compareAttempts, id)) : null;
  }, [compareAttempts, id]);
  const historyOf = useCallback(
    (q: number) => {
      const localCopies = new Set<string>();
      if (recs.has(q)) localCopies.add(id);
      for (const [aid, m] of otherLocal) if (m.has(q)) localCopies.add(aid);
      const historyLocalCopies = new Set<string>();
      for (const k of histLocal.keys()) if (k.startsWith(`${q}:`)) historyLocalCopies.add(`${id}:${k.slice(String(q).length + 1)}`);
      return toeicQuestionHistory(compareAttempts, id, q, { localCopies, historyLocalCopies });
    },
    [compareAttempts, id, recs, otherLocal, histLocal],
  );
  /** ③ 행의 소리 — 지금 답 행은 clipFor, 예전 답 행은 이 기기 사본(그 세대) → 받아 둔 서버 사본(§15-7) */
  const rowClip = (row: { attemptId: string; historyOf: string | null }, q: number): Clip | null => {
    if (row.historyOf === null) return clipFor(row.attemptId, q);
    const local = row.attemptId === id ? histLocal.get(`${q}:${row.historyOf}`) : undefined;
    if (local) return { status: "ready", url: local.url, blob: local.rec.blob, source: "local", mimeType: local.rec.mimeType, size: local.rec.size };
    return clips[clipKey(row.attemptId, q, undefined, row.historyOf)] ?? null;
  };
  const [openTranscripts, setOpenTranscripts] = useState<Record<string, boolean>>({});
  /** 접기를 여는 탭에서 기록 행들의 서버 사본을 미리 받는다(이 기기 사본이 있으면 그것) */
  function prefetchHistoryClips(q: number) {
    for (const row of historyOf(q)) {
      if (!row.hasRecording) continue;
      if (row.historyOf !== null) {
        // 예전 답(§15-7) — 이 기기 사본(그 세대)이 없고 서버 메타가 있으면 받아 둔다
        if (row.attemptId === id && histLocal.has(`${q}:${row.historyOf}`)) continue;
        const hasServerH = compareAttempts.find((a) => a.id === row.attemptId)?.answerHistory?.some((h) => h.q === q && h.replacedBy === row.historyOf && h.hasRecording);
        if (hasServerH) void ensureServerClip(row.attemptId, q, undefined, row.historyOf);
        continue;
      }
      const local = row.attemptId === id ? recs.get(q) : otherLocal.get(row.attemptId)?.get(q);
      if (local) continue;
      const hasServer = compareAttempts.find((a) => a.id === row.attemptId)?.recordings.some((r) => r.q === q);
      if (hasServer) void ensureServerClip(row.attemptId, q);
    }
  }

  // 프리페치(§16) — 모범답변·개선 답변 조각(키는 문자열 — 참조 변경으로 재시작하지 않게)
  const prefetchKey = useMemo(() => {
    const texts: string[] = [];
    for (const v of questions) {
      if (v.sampleAnswer) texts.push(v.sampleAnswer);
      if (v.passage) texts.push(v.passage); // 🎧 비교 ① Q1–2 — 내 읽기 → 지문 낭독(§13-9)
      const fb = answers[v.q]?.feedback;
      if (fb?.improvedAnswer) texts.push(fb.improvedAnswer);
      for (const f of fb?.fixes ?? []) if (f.better) texts.push(f.better); // 🔊 고친 문장 · ⇄ 이어 듣기(§14-5)
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
  /** 인쇄 머리 "채점 n/m문항"(점수가 있는 문항 — Q1–2 대조 포함) */
  const scoredCount = qs.filter((q) => answers[q]?.score !== null && answers[q]?.score !== undefined).length;
  function onPrint() {
    stopAllPlayback(); // 재생 중이면 멈추고 인쇄(인쇄 창이 떠 있는 동안 소리가 이어지지 않게)
    if (fixRec.active) void fixRec.stop();
    printNow();
  }

  return (
    <div className={s.wrap} ref={printRootRef} {...toeicPrintOmitAttrs(printOmit)}>
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
        {recordedAll > 0 && (
          <p className={s.serverLine} data-testid="rec-server-line">
            <span>
              🗄️ 녹음 서버 보관 {storedOnServer}/{recordedAll}
            </span>
            {pendingHere > 0 && (
              <button type="button" className="u-btn u-btn-secondary" onClick={() => void uploadNow()} disabled={draining}>
                {draining ? "올리는 중…" : `⬆️ 지금 올리기 (${pendingHere})`}
              </button>
            )}
            <Link href="/toeic/recordings" className={s.tplLink}>
              🎙️ 내 녹음 모아보기 →
            </Link>
          </p>
        )}
        {attemptDelta && (
          <p className={s.tplSummary} data-testid="attempt-delta">
            📈 {toeicAttemptDeltaLabelKo(attemptDelta)}
          </p>
        )}
        {retakeEst && retakeEst.before.complete && retakeEst.now.complete && (
          <p className={s.tplSummary} data-testid="retake-estimate">
            ↻ 다시 풀기 전 추정 {retakeEst.before.scaled} → 지금 {retakeEst.now.scaled} ({retakeEst.now.scaled - retakeEst.before.scaled >= 0 ? "+" : ""}
            {retakeEst.now.scaled - retakeEst.before.scaled}) · 추정(참고용)
          </p>
        )}
        {retakenUnscored.length > 0 && (
          <p className={`${s.tplSummary} ${s.printHide}`} data-testid="retake-unscored">
            ↻ 다시 푼 {retakenUnscored.map((q) => `Q${q}`).join("·")}를 채점하면 추정 등급을 다시 계산해요
            {retakeEst && retakeEst.before.complete ? ` (다시 풀기 전 추정 ${retakeEst.before.scaled} · ${retakeEst.before.band})` : ""}.
          </p>
        )}
        {openRetake && (
          <p className={`${s.caption} ${s.printHide}`} data-testid="retake-open">
            ↻ 다시 풀기 진행 중({openRetake.questions.map((q) => `Q${q}`).join("·")}) — 다른 탭·기기에서 열었다면 그쪽을 끝내 주세요.
          </p>
        )}
        {/* 인쇄에만 보이는 줄 — 응시 날짜(페이지 머리는 인쇄에서 빠진다)·채점 상태 */}
        <p className={s.printOnly} data-testid="print-meta">
          응시 {formatKst(attempt.startedAt)} · 채점 {scoredCount} / {qs.length}문항
          {estimate.complete ? ` · 추정 ${estimate.scaled} / 200 · ${estimate.band}` : ""}
        </p>
        {/* 🖨️ 인쇄 · PDF 저장(§16) — 인쇄 창에서 "PDF로 저장"을 고르면 PDF. 인쇄에서는 이 줄째로 빠진다 */}
        <div className={s.printBar}>
          <button type="button" className="u-btn u-btn-secondary" onClick={onPrint} disabled={printPreparing} data-testid="print-btn">
            {printPreparing ? "사진 불러오는 중…" : "🖨️ 인쇄 · PDF 저장"}
          </button>
          <span className={s.caption}>인쇄 창에서 &lsquo;PDF로 저장&rsquo;을 고르면 PDF가 돼요(iPhone은 인쇄 화면의 공유 버튼 → 파일에 저장).</span>
          {/* 인쇄할 항목(§16-10) — 화면 표시는 그대로, 끈 항목은 인쇄에서만 빠진다 */}
          <fieldset className={s.printPick} data-testid="print-pick">
            <legend className={s.printPickLegend}>인쇄할 항목</legend>
            <div className={s.printPickRow}>
              {TOEIC_PRINT_SECTIONS.map((k) => (
                <label key={k} className={s.printPickItem}>
                  <input type="checkbox" checked={!printOmit.includes(k)} onChange={(e) => setPrintSection(k, e.currentTarget.checked)} data-testid={`print-pick-${k}`} />
                  {TOEIC_PRINT_SECTION_KO[k]}
                </label>
              ))}
            </div>
            <p className={s.caption} aria-live="polite">
              {toeicPrintPickSummaryKo(printOmit)}
            </p>
          </fieldset>
        </div>
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

      {/* 오류 문항 다시 풀기(§15-7) — 녹음 없음·실패·중단·소리 없음(무음)·채점 실패·녹음 지움 */}
      {errorQs.length > 0 && (
        <section className={s.retakeBox} aria-label="오류 문항 다시 풀기" data-testid="retake-errors">
          <Link href={toeicRetakeHref(id, errorQs.map((e) => e.q))} className="u-btn u-btn-primary" data-testid="retake-errors-link">
            ↻ 오류 문항 {errorQs.length}개 다시 풀기
          </Link>
          <p className={s.caption}>
            {errorQs.map((e) => `Q${e.q} ${TOEIC_ERROR_REASON_KO[e.reason]}`).join(" · ")} — 실전과 같은 시간으로 그 문항만 다시 풀고, 녹음되면 이 결과에 합쳐요.
          </p>
        </section>
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
                    : recordedHere === 0 && recordedElsewhere > 0
                      ? "이 녹음은 아직 서버에 올라가지 않았어요 — 응시한 기기에서 결과 화면을 열면 올라가요."
                      : deletedCount > 0 && recordedHere === 0
                        ? "녹음을 지워 채점할 문항이 없어요(점수·전사·피드백은 남아 있어요)."
                        : "채점할 문항이 남지 않았어요."}
          </p>
          {recordedElsewhere > 0 && recsLoaded && recordedHere > 0 && (
            <p className={s.caption}>녹음 {recordedElsewhere}문항은 아직 서버에 올라가지 않았어요 — 응시한 기기에서 결과 화면을 열면 올라가요.</p>
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
              {/* 응시·다시 풀기 화면용 기기 설정(§15-13) — 이 화면의 고칠 문장 녹음은 설정과 상관없이 마이크를 화면 동안 하나로 유지한다(놓지 않는다) */}
              <ToeicMicKeepToggle
                onChange={() => {}}
                note="응시·다시 풀기 화면에만 적용돼요 — 이 화면의 고칠 문장 녹음은 마이크를 화면 동안 하나로 유지해요(첫 🎤에서만 권한을 물어요)."
              />
            </div>
          </details>
        </section>
      )}

      {/* 문항별 */}
      {questions.map((v, vi) => {
        const a = answers[v.q];
        // Q8–10은 같은 표 — 인쇄에서는 범위 안 첫 문항에만 싣고 나머지는 "표는 Qn과 같아요" 한 줄(§16)
        const tableFirstQ = v.table ? (questions.slice(0, vi).find((x) => x.part === v.part && x.table !== null)?.q ?? null) : null;
        const local = recs.get(v.q);
        const job = jobs[v.q];
        const diag = diags[v.q];
        const noResp = a?.transcript !== null && a?.transcript !== undefined && isNoResponseTranscript(a.transcript);
        const readMarks = v.passage && a?.transcript !== null && a?.transcript !== undefined && a.readDiff ? markReadAloud(v.passage, a.transcript) : null;
        const hist = historyOf(v.q);
        const delta = toeicScoreDelta(hist);
        const myClip = clipFor(id, v.q);
        const server = serverRecs.get(v.q) ?? null;
        const fmtErr = formatErrors[clipKey(id, v.q)];
        const qDiag = diagOf(v.q);
        const source = toeicAnswerSourceOf(attempt, v.q);
        return (
          <article key={v.q} className={s.item} aria-label={`Q${v.q} 결과`}>
            <div className={s.itemHead}>
              <span className={s.qBadge}>Q{v.q}</span>
              <span className={s.partName}>{v.partNameKo}</span>
              {delta && (
                <span className={s.deltaChip} data-testid={`score-delta-${v.q}`}>
                  {toeicScoreDeltaLabelKo(delta)}
                </span>
              )}
              {qDiag?.silent && (
                <span className={s.deltaChip} data-testid={`silent-chip-${v.q}`}>
                  소리 없음(무음)
                </span>
              )}
              <span className={`${s.scoreChip} ${a?.score !== null && a?.score !== undefined ? s.scoreOn : ""}`}>
                {a?.score !== null && a?.score !== undefined ? `${a.score} / ${v.maxScore}` : !a?.recorded ? "녹음 없음" : "채점 전"}
              </span>
            </div>
            {closed && (
              <p className={s.retakeRow}>
                <Link href={toeicRetakeHref(id, [v.q])} className={s.tplLink} data-testid={`retake-one-${v.q}`}>
                  ↻ 이 문항 다시 풀기
                </Link>
                {source !== null && <span className={s.caption}>다시 푼 답이에요(예전 답은 🎧 비교 ③)</span>}
              </p>
            )}
            {/* 인쇄에는 조작 줄(.retakeRow)이 빠지므로 "다시 푼 답" 표시만 따로 남긴다(QA print 1 F5) */}
            {source !== null && (
              <p className={`${s.printOnly} ${s.caption}`} data-testid={`print-retaken-${v.q}`}>
                ↻ 다시 푼 답이에요
              </p>
            )}

            {/* 자료 요약 */}
            {v.picture &&
              (v.picture.imageId && !brokenImgs.has(v.q) ? (
                // eslint-disable-next-line @next/next/no-img-element -- PIN 게이트 안 동적 라우트 바이트
                <img
                  src={toeicImageUrl(v.picture.imageId)}
                  alt={`Q${v.q} 사진`}
                  width={1536}
                  height={1024}
                  loading="lazy"
                  className={s.photo}
                  data-q={v.q}
                  onError={() => markBrokenImg(v.q)}
                />
              ) : (
                <p className={s.scene}>📷 {v.picture.sceneKo}</p>
              ))}
            {v.intro && (
              <p className={s.intro} lang="en">
                {v.intro}
              </p>
            )}
            {v.table && (
              <details className={tableFirstQ === null ? s.tableBox : `${s.tableBox} ${s.printHide}`} data-print-expand="">
                <summary className={s.tableSummary}>표 보기</summary>
                <ToeicInfoTableView table={v.table} />
              </details>
            )}
            {tableFirstQ !== null && <p className={`${s.printOnly} ${s.caption}`}>표는 Q{tableFirstQ}과 같아요.</p>}
            {v.question && (
              <p className={s.question} lang="en">
                {v.question}
              </p>
            )}

            {/* 내 녹음(인쇄에서는 통째로 빠진다 — 플레이어·서버 줄·지우기·진단) */}
            <div className={`${s.block} ${s.recBlock}`}>
              <p className={s.label}>내 녹음</p>
              {myClip?.status === "ready" ? (
                <>
                  {/* 이 기기 사본 또는 미리 받은 서버 사본의 Blob URL(API 주소를 src에 넣지 않는다 — §13-8) */}
                  <audio
                    className={s.audio}
                    controls
                    preload="metadata"
                    src={myClip.url}
                    onPlay={() => {
                      stopChain();
                      if (fixRec.active) void fixRec.stop();
                    }}
                    onError={() => markFormatError(id, v.q, myClip.mimeType)}
                  >
                    <track kind="captions" />
                  </audio>
                  {fmtErr && <p className={s.error}>{fmtErr}</p>}
                  <p className={s.diagLine}>
                    {myClip.source === "local" && local
                      ? `${secs(local.rec.durationMs)} · ${local.rec.mimeType || "형식 모름"} · ${kb(local.rec.size)} · 이 기기`
                      : `${secs(server?.durationMs ?? null)} · ${myClip.mimeType || "형식 모름"} · ${kb(myClip.size)} · 서버 사본`}
                  </p>
                </>
              ) : myClip?.status === "loading" ? (
                <p className={s.caption}>서버 사본을 불러오는 중…</p>
              ) : myClip?.status === "error" ? (
                <p className={s.error}>{myClip.message}</p>
              ) : answerDeleted(v.q) && recsLoaded ? (
                <p className={s.caption} data-testid={`rec-deleted-${v.q}`}>
                  🗑 녹음을 지웠어요 — 점수·전사·피드백은 남아 있어요. 이 문항은 다시 채점할 수 없어요.
                </p>
              ) : a?.recorded || local || server ? (
                <p className={s.caption}>
                  {!recsLoaded ? "녹음을 찾는 중…" : server ? "서버 사본을 불러오는 중…" : "이 녹음은 아직 서버에 올라가지 않았어요 — 응시한 기기에서 결과 화면을 열면 올라가요."}
                </p>
              ) : (
                <p className={s.caption}>녹음 없음(시간 안에 녹음되지 않았어요).</p>
              )}
              {(a?.recorded || server) && !answerDeleted(v.q) && (
                <p className={s.diagLine} data-testid={`rec-server-${v.q}`}>
                  {server ? `서버 ✓ ${kb(server.size)} · ${server.mimeType}` : live[v.q]?.state === "uploading" ? "서버 올리는 중…" : "서버 없음"}
                </p>
              )}
              {(local || server) && (
                <div className={s.recTools}>
                  <button
                    type="button"
                    className={s.delBtn}
                    data-testid={`rec-delete-${v.q}`}
                    disabled={deleting !== null}
                    onClick={() => void deleteRecording({ kind: "answer", q: v.q })}
                  >
                    {deleting === `a:${v.q}` ? "지우는 중…" : "🗑 녹음 지우기"}
                  </button>
                </div>
              )}
              {deleteError?.key === `a:${v.q}` && <p className={s.error}>{deleteError.message}</p>}
              {/* F2 문항별 진단(§15-11) — 응시 화면이 남긴 정책·열기 횟수·오류·최고 레벨·크기 */}
              {qDiag && (
                <p className={s.diagLine} data-testid={`answer-diag-${v.q}`}>
                  녹음 진단 · {toeicAnswerDiagLineKo(qDiag)}
                </p>
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
                    {job.retriable && hasSound(v.q) && a && isScorableToeicAnswer(a) && (
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
              <div className={s.block} data-print-sec="transcript">
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
                  <p className={s.label}>
                    {readMarks ? (
                      <>
                        {/* 전사를 끄고 인쇄하면 "지문 대조" 대신 "지문"(§16-10) */}
                        <span className={s.sec} data-print-sec="transcript">
                          지문 대조
                        </span>
                        <span className={s.printAlt} data-print-alt="transcript">
                          지문
                        </span>
                      </>
                    ) : (
                      "지문"
                    )}
                  </p>
                  {playBtn(`passage-${v.q}`, v.passage, `Q${v.q} 지문`)}
                </div>
                {readMarks && a?.readDiff ? (
                  <>
                    {/* 전사를 끄고 인쇄하면 대조 표시 대신 지문만(지문은 문제라 언제나 — §16-10) */}
                    <p className={`${s.passage} ${s.printAlt}`} data-print-alt="transcript" lang="en">
                      {v.passage}
                    </p>
                    <div className={s.sec} data-print-sec="transcript">
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
                      <p className={s.notice}>
                        🔈 {READ_NOTICE_HEAD}
                        {/* "— 녹음을 다시 들어 보세요"는 화면 조작 안내라 인쇄에서 뺀다(QA print 1 F5) */}
                        {READ_NOTICE_TAIL && <span className={s.printHide}>{READ_NOTICE_TAIL}</span>}
                      </p>
                    </div>
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
                {/* 인쇄할 항목 묶음(§16-10) — .sec는 display: contents라 화면 배치는 그대로 */}
                <div className={s.sec} data-print-sec="strengths">
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
                </div>
                {a.feedback.fixes.length > 0 && (
                  <div className={s.sec} data-print-sec="fixes">
                    <p className={s.label}>✏️ 고칠 문장</p>
                    <ul className={s.fixes}>
                      {a.feedback.fixes.map((f, k) => {
                        // 고칠 문장 다시 말하기(§14-5): 🔊 고친 문장 · 🎤 내가 다시 말하기 · ▶ 내 목소리 · ⇄ 내 목소리 → 고친 문장 · 🗑
                        const slot = fixSlotKey(v.q, k);
                        const take = fixRec.takes[slot];
                        const meta = fixMeta(v.q, k);
                        const clip = fixClipFor(v.q, k);
                        const act = fixRec.active?.key === slot ? fixRec.active : null;
                        const busyOther = fixRec.active !== null && !act;
                        const mineKey = `fix-mine-${v.q}-${k}`;
                        const chainFix = `fix-chain-${v.q}-${k}`;
                        const delKey = `f:${v.q}:${k}`;
                        const fmt = formatErrors[clipKey(id, v.q, k)];
                        return (
                          <li key={k} className={s.fix} data-testid={`fix-${v.q}-${k}`}>
                            <p className={s.said} lang="en">
                              <span className={s.fixTag}>말한 것</span> {f.said}
                            </p>
                            <p className={s.better} lang="en">
                              <span className={s.fixTag}>이렇게</span> {f.better}
                            </p>
                            <p className={s.why}>{f.whyKo}</p>
                            <div className={s.fixTools}>
                              {playBtn(`fix-better-${v.q}-${k}`, f.better, `Q${v.q} 고친 문장`)}
                              <button
                                type="button"
                                className={`${s.recBtn} ${act ? s.recOn : ""}`}
                                data-testid={`fix-rec-${v.q}-${k}`}
                                aria-pressed={act !== null}
                                disabled={busyOther || deleting !== null}
                                onClick={() => fixRec.toggle(v.q, k, stopAllPlayback)}
                              >
                                {act?.phase === "recording" ? "■ 그만" : act?.phase === "arming" ? "마이크 여는 중…" : clip ? "🎤 다시 말하기" : "🎤 내가 말하기"}
                              </button>
                              {clip?.status === "ready" ? (
                                <>
                                  <button
                                    type="button"
                                    className={`${s.play} ${chainKey === mineKey ? s.playOn : ""}`}
                                    data-testid={`fix-play-${v.q}-${k}`}
                                    disabled={act !== null}
                                    onClick={() => playChain(mineKey, [{ url: clip.url, attemptId: id, q: v.q, mimeType: clip.mimeType, fixIndex: k }], null)}
                                  >
                                    {chainKey === mineKey ? "■ 멈추기" : "▶ 내 목소리"}
                                  </button>
                                  <button
                                    type="button"
                                    className={`${s.play} ${chainKey === chainFix ? s.playOn : ""}`}
                                    data-testid={`fix-chain-${v.q}-${k}`}
                                    disabled={act !== null}
                                    onClick={() => playChain(chainFix, [{ url: clip.url, attemptId: id, q: v.q, mimeType: clip.mimeType, fixIndex: k }], f.better)}
                                  >
                                    {chainKey === chainFix ? "■ 멈추기" : "⇄ 내 목소리 → 고친 문장"}
                                  </button>
                                  <button
                                    type="button"
                                    className={s.delBtn}
                                    data-testid={`fix-delete-${v.q}-${k}`}
                                    disabled={act !== null || deleting !== null}
                                    onClick={() => void deleteRecording({ kind: "fix", q: v.q, fixIndex: k })}
                                  >
                                    {deleting === delKey ? "지우는 중…" : "🗑"}
                                  </button>
                                </>
                              ) : clip?.status === "loading" ? (
                                <span className={s.caption}>불러오는 중…</span>
                              ) : clip?.status === "error" ? (
                                <span className={s.caption}>{clip.message}</span>
                              ) : null}
                            </div>
                            {act?.phase === "recording" && (
                              <p className={s.recLive} role="status">
                                🔴 듣는 중 — 고친 문장을 소리 내어 말하고 ■ 그만을 눌러요(30초면 저절로 멈춰요).
                              </p>
                            )}
                            {(take || meta) && (
                              <p className={s.diagLine} data-testid={`fix-server-${v.q}-${k}`}>
                                {take && take.upload === "uploading"
                                  ? `서버에 올리는 중… · ${secs(take.durationMs)}`
                                  : take && take.upload === "failed"
                                    ? "서버에 올리지 못했어요"
                                    : meta
                                      ? `서버 ✓ ${secs(meta.durationMs)} · ${kb(meta.size)}`
                                      : ""}
                              </p>
                            )}
                            {take?.upload === "failed" && (
                              <p className={s.error}>
                                {take.message}{" "}
                                <button type="button" className={`${s.tplLink} ${s.linkBtn}`} onClick={() => fixRec.retryUpload(v.q, k)}>
                                  ⬆️ 다시 올리기
                                </button>
                              </p>
                            )}
                            {fixRec.error?.key === slot && <p className={s.error}>{fixRec.error.message}</p>}
                            {fmt && <p className={s.error}>{fmt}</p>}
                            {deleteError?.key === delKey && <p className={s.error}>{deleteError.message}</p>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {a.feedback.missingKo.length > 0 && (
                  <div className={s.sec} data-print-sec="missing">
                    <p className={s.label}>🧩 빠진 내용</p>
                    <ul className={s.list}>
                      {a.feedback.missingKo.map((t, k) => (
                        <li key={k}>{t}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className={s.sec} data-print-sec="improved">
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
              </div>
            )}

            {/* 모범답변 */}
            {v.sampleAnswer && (
              <details className={s.model} data-print-expand="" data-print-sec="model">
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

            {/* 🎧 비교(§13-9 — 닫힌 접기: ① 이어 듣기 ② 글자 나란히 ③ 다시 풀기 기록). AI 0 */}
            {(() => {
              const target = pickToeicCompareTarget(v, a ?? null, targetPref);
              if (!target && !myClip && hist.length <= 1) return null;
              const data = checks[v.part];
              const result = checkResults.get(v.q);
              const tpls = data?.templates ?? [];
              const mine = a?.transcript !== null && a?.transcript !== undefined && !noResp ? a.transcript : null;
              const mySpans = mine !== null && tpls.length > 0 ? templateRunSpans(mine, tpls) : [];
              const mineKeys = new Set(mySpans.map((x) => x.key));
              const tgtSpans = target && target.kind !== "passage" && tpls.length > 0 ? templateRunSpans(target.text, tpls) : [];
              const tplTitle = (key: string) => checkTplByKey.get(key)?.frameEn ?? key;
              const mineChain = `mine-${v.q}`;
              const pickable = v.q > 2 && !!a?.feedback?.improvedAnswer && !!v.sampleAnswer;
              const openTplCheck = () => {
                const el = document.getElementById(`tpl-check-${v.q}`);
                if (el instanceof HTMLDetailsElement) el.open = true;
                el?.scrollIntoView({ behavior: "smooth", block: "start" });
              };
              const current = myClip?.status === "ready" ? myClip : null;
              return (
                <details
                  className={s.cmpFold}
                  data-testid={`compare-${v.q}`}
                  onToggle={(e) => {
                    if ((e.currentTarget as HTMLDetailsElement).open) prefetchHistoryClips(v.q);
                  }}
                >
                  <summary className={s.tplCheckSummary}>🎧 비교{hist.length > 1 ? ` · 기록 ${hist.length}` : ""}</summary>
                  <div className={s.cmpBody}>
                    {/* ① 이어 듣기 */}
                    <section className={s.cmpSection} aria-label={`Q${v.q} 이어 듣기`}>
                      <p className={s.label}>① 이어 듣기</p>
                      {pickable && (
                        <div className={s.chipRow} role="group" aria-label="비교 대상">
                          <span className={s.caption}>비교 대상:</span>
                          {(["improved", "sample"] as const).map((k) => (
                            <button key={k} type="button" className={s.chipBtn} aria-pressed={targetPref === k} onClick={() => chooseTarget(k)}>
                              {TOEIC_COMPARE_TARGET_KO[k]}
                            </button>
                          ))}
                        </div>
                      )}
                      {target && myClip?.status === "ready" ? (
                        <button
                          type="button"
                          className={`${s.chainBtn} ${chainKey === mineChain ? s.chainOn : ""}`}
                          data-testid={`chain-${v.q}`}
                          onClick={() => playChain(mineChain, [{ url: myClip.url, attemptId: id, q: v.q, mimeType: myClip.mimeType }], target.text)}
                        >
                          {chainKey === mineChain ? "■ 멈추기" : `▶ 내 답 → ${TOEIC_COMPARE_TARGET_KO[target.kind]}`}
                        </button>
                      ) : target && myClip?.status === "loading" ? (
                        <button type="button" className={s.chainBtn} disabled>
                          불러오는 중…
                        </button>
                      ) : null}
                      {target && (
                        <div className={s.labelRow}>
                          <p className={s.caption}>{TOEIC_COMPARE_TARGET_KO[target.kind]}만 듣기</p>
                          {playBtn(`cmp-${v.q}`, target.text, `Q${v.q} ${TOEIC_COMPARE_TARGET_KO[target.kind]}`)}
                        </div>
                      )}
                      {myClip?.status === "error" && <p className={s.error}>{myClip.message}</p>}
                      {fmtErr && <p className={s.error}>{fmtErr}</p>}
                    </section>

                    {/* ② 글자 나란히 */}
                    {target && (
                      <section className={s.cmpSection} aria-label={`Q${v.q} 글자 나란히`}>
                        <p className={s.label}>② 글자 나란히</p>
                        <div className={s.cmpGrid}>
                          <div className={s.cmpCol}>
                            <p className={s.label}>내 답(들린 대로)</p>
                            {a?.transcript === null || a?.transcript === undefined ? (
                              <p className={s.caption}>AI 채점을 받으면 내 답이 글자로 나와요.</p>
                            ) : noResp ? (
                              <p className={s.noResp}>{TOEIC_NO_RESPONSE_KO}</p>
                            ) : (
                              <p className={s.cmpText} lang="en" data-testid={`cmp-mine-${v.q}`}>
                                {templateSpanSegments(a.transcript, mySpans).map((seg, k) =>
                                  seg.keys.length > 0 ? (
                                    <mark key={k} className={`${s.used} ${s.tplMine}`} title={seg.keys.map(tplTitle).join(" / ")}>
                                      {seg.text}
                                    </mark>
                                  ) : (
                                    <Fragment key={k}>{seg.text}</Fragment>
                                  ),
                                )}
                              </p>
                            )}
                          </div>
                          <div className={s.cmpCol}>
                            <p className={s.label}>{TOEIC_COMPARE_TARGET_KO[target.kind]}</p>
                            {target.kind === "passage" && readMarks ? (
                              <p className={s.cmpText} lang="en" data-testid={`cmp-target-${v.q}`}>
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
                            ) : (
                              <p className={s.cmpText} lang="en" data-testid={`cmp-target-${v.q}`}>
                                {templateSpanSegments(target.text, tgtSpans).map((seg, k) => {
                                  if (seg.keys.length === 0) return <Fragment key={k}>{seg.text}</Fragment>;
                                  const usedByMe = mine !== null && seg.keys.some((key) => mineKeys.has(key));
                                  return (
                                    <mark
                                      key={k}
                                      className={usedByMe || mine === null ? `${s.used} ${s.tplMine}` : s.tplCould}
                                      title={usedByMe || mine === null ? seg.keys.map(tplTitle).join(" / ") : `이 틀을 쓸 수 있었어요 — ${seg.keys.map(tplTitle).join(" / ")}`}
                                    >
                                      {seg.text}
                                    </mark>
                                  );
                                })}
                              </p>
                            )}
                          </div>
                        </div>
                        {(mySpans.length > 0 || tgtSpans.length > 0) && (
                          <p className={s.legendRow}>
                            <mark className={`${s.used} ${s.tplMine}`}>밑줄</mark> {mine !== null ? "내가 쓴 틀" : "틀"} ·{" "}
                            {mine !== null && (
                              <>
                                <span className={s.tplCould}>점선</span> 이 틀을 쓸 수 있었어요
                              </>
                            )}
                          </p>
                        )}
                        {target.kind === "passage" && readMarks && (
                          <p className={s.legendRow}>
                            <del className={s.missing}>취소선</del> 빠진 단어 · <mark className={s.substituted}>밑줄</mark> 다르게 들린 단어
                          </p>
                        )}
                        {result?.scored && result.flowChecked && result.missingSteps.length > 0 && (
                          <p className={s.caption} data-testid={`cmp-missing-${v.q}`}>
                            빠진 단계: {result.missingSteps.join(" · ")} —{" "}
                            <button type="button" className={`${s.tplLink} ${s.linkBtn}`} onClick={openTplCheck}>
                              쓸 수 있었던 틀은 🧩 틀 점검에 ↓
                            </button>
                          </p>
                        )}
                      </section>
                    )}

                    {/* ③ 다시 풀기 기록 */}
                    <section className={s.cmpSection} aria-label={`Q${v.q} 다시 풀기 기록`}>
                      <p className={s.label}>③ 다시 풀기 기록</p>
                      {hist.length <= 1 ? (
                        <p className={s.caption}>같은 문제를 다시 풀면 여기에서 지난 녹음·점수와 비교할 수 있어요.</p>
                      ) : (
                        <ul className={s.histList} data-testid={`history-${v.q}`}>
                          {hist.map((row) => {
                            const c = rowClip(row, v.q);
                            const rowKey = `row-${row.key}-${v.q}`;
                            const thenNow = `then-${row.key}-${v.q}`;
                            const tKey = `${row.key}:${v.q}`;
                            const label = row.isCurrent
                              ? source !== null
                                ? "이번(다시 푼 답)"
                                : "이번"
                              : row.historyOf !== null
                                ? `다시 풀기 전 · ${formatKst(row.startedAt)}`
                                : formatKst(row.startedAt);
                            return (
                              <li key={row.key} className={s.histRow} data-testid={row.historyOf !== null ? `history-row-before-${v.q}` : undefined}>
                                <div className={s.histHead}>
                                  <span className={row.isCurrent ? s.histNow : undefined}>{label}</span>
                                  <span>· {row.score !== null ? `${row.score} / ${row.maxScore}` : "채점 전"}</span>
                                  {c?.status === "ready" ? (
                                    <button
                                      type="button"
                                      className={`${s.play} ${chainKey === rowKey ? s.playOn : ""}`}
                                      onClick={() => playChain(rowKey, [{ url: c.url, attemptId: row.attemptId, q: v.q, mimeType: c.mimeType }], null)}
                                      aria-label={row.isCurrent ? "이번 녹음 듣기" : "그때 녹음 듣기"}
                                    >
                                      {chainKey === rowKey ? "■" : "▶"}
                                    </button>
                                  ) : c?.status === "loading" ? (
                                    <span className={s.caption}>불러오는 중…</span>
                                  ) : c?.status === "error" ? (
                                    <span className={s.caption}>소리 없음</span>
                                  ) : !row.hasRecording ? (
                                    <span className={s.caption}>녹음 없음</span>
                                  ) : null}
                                  {row.transcript !== null && (
                                    <button
                                      type="button"
                                      className={s.play}
                                      aria-pressed={openTranscripts[tKey] === true}
                                      onClick={() => setOpenTranscripts((prev) => ({ ...prev, [tKey]: !prev[tKey] }))}
                                    >
                                      글자
                                    </button>
                                  )}
                                  {!row.isCurrent &&
                                    (c?.status === "ready" && current ? (
                                      <button
                                        type="button"
                                        className={`${s.play} ${chainKey === thenNow ? s.playOn : ""}`}
                                        data-testid={`then-now-${v.q}`}
                                        onClick={() =>
                                          playChain(
                                            thenNow,
                                            [
                                              { url: c.url, attemptId: row.attemptId, q: v.q, mimeType: c.mimeType },
                                              { url: current.url, attemptId: id, q: v.q, mimeType: current.mimeType },
                                            ],
                                            null,
                                          )
                                        }
                                      >
                                        {chainKey === thenNow ? "■ 멈추기" : "▶ 그때 → 이번"}
                                      </button>
                                    ) : row.hasRecording && (c?.status === "loading" || myClip?.status === "loading") ? (
                                      <button type="button" className={s.play} disabled>
                                        불러오는 중…
                                      </button>
                                    ) : null)}
                                </div>
                                {openTranscripts[tKey] && row.transcript !== null && (
                                  <p className={s.cmpText} lang="en">
                                    {isNoResponseTranscript(row.transcript) ? TOEIC_NO_RESPONSE_KO : row.transcript}
                                  </p>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  </div>
                </details>
              );
            })()}

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
                  <section className={s.tplCheck} aria-label={`Q${v.q} 틀 점검`} data-testid={`tpl-check-${v.q}`} id={`tpl-check-${v.q}`}>
                    <p className={s.tplCheckTitle}>🧩 틀 점검</p>
                    {body}
                  </section>
                );
              }
              const summaryKo = result.scored
                ? `🧩 틀 점검 · 쓴 틀 ${result.used.length}${result.flowChecked ? ` · 빠진 단계 ${result.missingSteps.length}` : ""}`
                : `🧩 모범답변의 틀 ${result.suggestions.length} · 채점 뒤 내 틀`;
              return (
                <details className={s.tplCheckFold} aria-label={`Q${v.q} 틀 점검`} data-testid={`tpl-check-${v.q}`} id={`tpl-check-${v.q}`}>
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

      {/* 🎧 비교 이어 듣기 공용 플레이어(화면에 하나 — iOS는 탭으로 한 번 재생한 요소의 다음 play()를 허락한다) */}
      <audio ref={playerRef} className={s.hiddenPlayer} preload="auto" data-testid="compare-player">
        <track kind="captions" />
      </audio>

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
