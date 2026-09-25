"use client";

/**
 * 모의고사 학습 보기 (아빠의 영어 T3, docs/harness/toeic.md §4·§4-10·§6-4·§8) — 클라이언트 컴포넌트.
 *
 * - **파트별 자료·모범답변**(형식표 순서): Q1–2 지문(끊어 읽기 단위 `/` · 강세 단어 굵게 · 발음 팁), Q3–4 사진(없으면
 *   장면 설명 sceneKo + "사진 다시 만들기") · 묘사 포인트 · 모범답변, Q5–7 상황·질문·모범답변·요령, Q8–10 표(제목·머리 정보·
 *   행·각주) · 전화 도입 · 질문·모범답변·요령, Q11 질문 · 답변 뼈대 · 모범답변 · 요령.
 *   모범답변 속 **활용한 표현**(usedExpressions[].span)을 강조한다(표현집과 이어지는 자리).
 * - **🔊**: 모범답변·지문·질문은 길어서 `splitForTts`(300자)로 나눠 `speakQueue`로 이어 읽는다 — **탭 핸들러 안에서 동기로**
 *   부른다(iOS 재생 잠금). 정지는 큐가 돌려준 stop만(다른 🔊까지 죽이는 stopSpeaking을 쓰지 않는다). lang은 늘 "en-US" 명시.
 * - **사진(관문 P)**: pending 칸은 화면이 열리면 **두 장을 병렬로 자동 요청**한다(생성 직후 흐름 — 목록이 여기로 옮겨 온다).
 *   요청이 실패로 끝나면 `GET /api/toeic/mocks/[id]`로 **한 번 새로 읽어** 이미 저장됐는지 확인한 뒤에만 실패로 보인다(§4-10 —
 *   응답이 60초 상한에 끊겨도 서버는 끝까지 저장한다). failed 칸은 자동으로 다시 만들지 않는다(버튼 — 비용 가드).
 * - **빈 파트**: "이 파트 다시 만들기"(`POST [id]/regenerate?part=`) — 빈 자리만 채운다(이미 있으면 409 → 새로 읽기).
 * - **응시**: "실전 응시(11문항)"는 다섯 파트가 다 있을 때만, 파트마다 "유형 연습" — 응시 화면 `/take`(T4).
 * - **응시 기록**: 최신 위 — 날짜(KST 시각)·범위·끝까지/중단·녹음 수·채점 수·추정(11문항 채점 시). 누르면 결과 화면(T5).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import TtsEngineControl from "@/components/tts-engine-control";
import TtsSpeedControl from "@/components/tts-speed-control";
import { formatKst } from "@/lib/kst";
import { prefetchSpeech, speakQueue } from "@/lib/speech";
import {
  TOEIC_INFO_KIND_KO,
  TOEIC_OPINION_KIND_KO,
  TOEIC_READ_KIND_KO,
  missingToeicMockParts,
  segmentStressWords,
  segmentUsedExpressions,
  toeicImageUrl,
  toeicMockPartLabelKo,
  toeicTakeHref,
  type ToeicMockGetResponse,
  type ToeicMockImageResponse,
  type ToeicMockRecord,
  type ToeicMockRegenerateResponse,
  type ToeicMockRenameResponse,
  type ToeicPictureImage,
  type ToeicPictureItem,
  type ToeicUsedExpression,
} from "@/lib/toeic-mock-contract";
import { TOEIC_MOCK_FORMAT, TOEIC_MOCK_PARTS, TOEIC_QUESTION_COUNT, toeicPartQuestions, type ToeicMockPart } from "@/lib/toeic-mock";
import { TTS_TEXT_MAX_CHARS } from "@/lib/tts-shared";
import { splitForTts } from "@/lib/tts-split";
import s from "./toeic-mock-detail-view.module.css";

/** 응시 기록 한 줄(서버 페이지가 줄여 넘긴다) — 누르면 응시 결과 화면(`/toeic/attempts/[id]`) */
export interface ToeicMockAttemptSummary {
  id: string;
  scope: "full" | "part";
  parts: ToeicMockPart[];
  startedAt: string;
  /** 끝까지 마쳤다(finishedAt 있음) */
  finished: boolean;
  /** 끝/그만두기가 저장됐다(lib/toeic-attempt-rules isToeicAttemptClosed) — 아니면 "저장 안 됨" */
  closed: boolean;
  recordedCount: number;
  scoredCount: number;
  /** 11문항 모두 채점됐을 때 "추정 150 · IH"(§5-5), 아니면 null */
  estimateKo: string | null;
}

/** 영어를 큐 조각으로 — 300자 넘는 모범답변은 문장 단위로 나눈다(lib/tts-split 공용) */
function enPieces(text: string): { text: string; lang: string }[] {
  return splitForTts(text, TTS_TEXT_MAX_CHARS).map((t) => ({ text: t, lang: "en-US" }));
}

/** 재생 중인 실행을 무효화하고 큐를 멈춘다(큐가 돌려준 stop만). */
function haltQueue(runRef: RefObject<number>, stopRef: RefObject<(() => void) | null>) {
  runRef.current++;
  const stop = stopRef.current;
  stopRef.current = null;
  stop?.();
}

/** 파트 시간 안내 — 형식표에서 계산("준비 3초 · 답변 15/15/30초") */
function partTimeKo(part: ToeicMockPart): string {
  const fs = TOEIC_MOCK_FORMAT.filter((f) => f.part === part);
  const preps = [...new Set(fs.map((f) => f.prepSec))];
  const answers = fs.map((f) => f.answerSec);
  const same = answers.every((a) => a === answers[0]);
  return `준비 ${preps.join("/")}초 · 답변 ${same ? answers[0] : answers.join("/")}초`;
}

function highlightUsed(text: string, used: readonly ToeicUsedExpression[]): ReactNode {
  return segmentUsedExpressions(text, used).map((seg, i) =>
    seg.mark ? (
      <mark key={i} className={s.used} title={seg.expression ?? undefined}>
        {seg.text}
      </mark>
    ) : (
      <Fragment key={i}>{seg.text}</Fragment>
    ),
  );
}

/** 사진 칸의 화면 상태 — 서버 값(props) 위에 이 화면의 요청 결과를 얹는다 */
type ImageJob =
  | { phase: "making" }
  | { phase: "ready"; imageId: string }
  | { phase: "failed"; message: string }
  | { phase: "nokey"; message: string };

type RegenState = { phase: "loading" } | { phase: "error"; message: string; canRetry: boolean };

export default function ToeicMockDetailView({
  mock,
  attempts,
  justCreated,
  failedParts,
  titleMax,
}: {
  mock: ToeicMockRecord;
  attempts: ToeicMockAttemptSummary[];
  justCreated: boolean;
  failedParts: ToeicMockPart[];
  titleMax: number;
}) {
  const router = useRouter();
  const id = mock.id;
  const missing = missingToeicMockParts(mock.parts);
  const complete = missing.length === 0;

  // ── 제목 인라인 수정 ──
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mock.titleKo);
  const [saving, setSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  async function saveTitle() {
    const next = draft.trim();
    if (next === "" || next === mock.titleKo) {
      setEditing(false);
      setDraft(mock.titleKo);
      return;
    }
    setSaving(true);
    setTitleError(null);
    try {
      const res = await fetch(`/api/toeic/mocks/${encodeURIComponent(id)}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titleKo: next }),
      });
      const data = (await res.json().catch(() => null)) as ToeicMockRenameResponse | null;
      if (data?.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setTitleError(data && !data.ok ? data.messageKo : "이름을 저장하지 못했어요.");
      }
    } catch {
      setTitleError("이름을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  }

  // ── 🔊 한 번에 하나 — 모범답변·지문·질문 ──
  const runRef = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  useEffect(() => () => haltQueue(runRef, stopRef), []);

  /** ⚠️ onClick 안에서 **동기로** 부른다(await·setTimeout 금지) — speakQueue가 첫 await 전에 iOS 재생 잠금을 푼다. */
  function togglePlay(key: string, text: string) {
    if (playingKey === key) {
      haltQueue(runRef, stopRef);
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

  function playBtn(k: string, text: string, label: string) {
    const on = playingKey === k;
    return (
      <button
        type="button"
        className={`${s.play} ${on ? s.playOn : ""}`}
        onClick={() => togglePlay(k, text)}
        aria-label={on ? `${label} 멈추기` : `${label} 듣기`}
        aria-pressed={on}
      >
        {on ? "■ 멈추기" : "🔊 듣기"}
      </button>
    );
  }

  // 프리페치(§16) — 🔊 대상 영어 조각을 미리(≤90개는 lib가 자른다). 키는 문자열(참조 변경으로 재시작하지 않게).
  const prefetchKey = useMemo(() => {
    const texts: string[] = [];
    const p = mock.parts;
    p.read?.items.forEach((it) => texts.push(it.text));
    p.picture?.items.forEach((it) => texts.push(it.sampleAnswer));
    if (p.respond) {
      texts.push(p.respond.intro);
      p.respond.questions.forEach((q) => texts.push(q.question, q.sampleAnswer));
    }
    if (p.info) {
      texts.push(p.info.callerIntro);
      p.info.questions.forEach((q) => texts.push(q.question, q.sampleAnswer));
    }
    if (p.opinion) texts.push(p.opinion.question, p.opinion.sampleAnswer);
    return texts
      .flatMap((t) => splitForTts(t, TTS_TEXT_MAX_CHARS))
      .filter((t) => t !== "")
      .join("\u0001");
  }, [mock.parts]);
  useEffect(() => {
    if (!prefetchKey) return;
    return prefetchSpeech(prefetchKey.split("\u0001"), "en-US");
  }, [prefetchKey]);

  // ── Q3–4 사진(관문 P) ──
  const [imageJobs, setImageJobs] = useState<Partial<Record<0 | 1, ImageJob>>>({});
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());
  const autoRequested = useRef<Set<string>>(new Set());
  const inFlight = useRef<Set<number>>(new Set());

  function setJob(slot: 0 | 1, job: ImageJob | null) {
    setImageJobs((prev) => {
      const next = { ...prev };
      if (job) next[slot] = job;
      else delete next[slot];
      return next;
    });
  }

  /** 실패를 받았을 때 — 한 번 새로 읽어 이미 저장됐는지 본다(§4-10). 장면이 바뀌었으면 null. */
  async function rereadImage(slot: 0 | 1, imagePrompt: string): Promise<ToeicPictureImage | null> {
    try {
      const res = await fetch(`/api/toeic/mocks/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as ToeicMockGetResponse | null;
      if (!data?.ok) return null;
      const item = data.mock.parts.picture?.items[slot];
      if (!item || item.imagePrompt !== imagePrompt) return null;
      return item.image;
    } catch {
      return null;
    }
  }

  async function requestImage(slot: 0 | 1, imagePrompt: string) {
    if (inFlight.current.has(slot)) return;
    inFlight.current.add(slot);
    setJob(slot, { phase: "making" });
    let status = 0;
    let data: ToeicMockImageResponse | null = null;
    try {
      const res = await fetch(`/api/toeic/mocks/${encodeURIComponent(id)}/image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      status = res.status;
      data = (await res.json().catch(() => null)) as ToeicMockImageResponse | null;
    } catch {
      data = null; // 네트워크가 끊겼다 — 아래에서 다시 읽어 확인
    }
    try {
      if (data?.ok && data.image.imageId) {
        setJob(slot, { phase: "ready", imageId: data.image.imageId });
        router.refresh();
        return;
      }
      if (status === 501 && data && !data.ok) {
        setJob(slot, { phase: "nokey", message: data.messageKo });
        return;
      }
      if (status === 409) {
        setJob(slot, null);
        router.refresh();
        return;
      }
      // 실패로 받았다 — 이미 저장됐는지 한 번 새로 읽은 뒤에만 실패로 보인다
      const current = await rereadImage(slot, imagePrompt);
      if (current?.status === "ready" && current.imageId) {
        setJob(slot, { phase: "ready", imageId: current.imageId });
        router.refresh();
        return;
      }
      setJob(slot, {
        phase: "failed",
        message:
          data && !data.ok
            ? data.messageKo
            : "사진 응답을 받지 못했어요. 서버가 아직 그리는 중일 수 있어요 — 잠시 뒤 새로 읽거나 다시 만들어 보세요.",
      });
    } finally {
      inFlight.current.delete(slot);
    }
  }

  // pending 칸은 열리자마자 두 장을 **병렬로** 자동 요청(생성 직후 흐름). 같은 장면은 이 화면에서 한 번만.
  const picture = mock.parts.picture;
  useEffect(() => {
    if (!picture) return;
    picture.items.forEach((it, i) => {
      if (i > 1) return;
      const slot = i as 0 | 1;
      const key = `${slot}|${it.imagePrompt}`;
      if (it.image.status !== "pending" || autoRequested.current.has(key)) return;
      autoRequested.current.add(key);
      void requestImage(slot, it.imagePrompt);
    });
    // requestImage는 매 렌더 새로 만들어지지만 안에서 쓰는 값(id·router)은 바뀌지 않는다 — picture가 바뀔 때만 돈다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picture]);

  const makingCount = Object.values(imageJobs).filter((j) => j?.phase === "making").length;

  // ── 빈 파트 다시 만들기 ──
  const [regen, setRegen] = useState<Partial<Record<ToeicMockPart, RegenState>>>({});
  const regenBusy = useRef<Set<ToeicMockPart>>(new Set());

  async function regeneratePart(part: ToeicMockPart) {
    if (regenBusy.current.has(part)) return;
    regenBusy.current.add(part);
    setRegen((prev) => ({ ...prev, [part]: { phase: "loading" } }));
    const clear = () =>
      setRegen((prev) => {
        const next = { ...prev };
        delete next[part];
        return next;
      });
    try {
      const res = await fetch(`/api/toeic/mocks/${encodeURIComponent(id)}/regenerate?part=${part}`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as ToeicMockRegenerateResponse | null;
      if (data?.ok || res.status === 409) {
        clear();
        router.refresh();
        return;
      }
      if (data && !data.ok) {
        setRegen((prev) => ({
          ...prev,
          [part]: { phase: "error", message: data.messageKo, canRetry: data.error !== "no_api_key" && data.error !== "mock_not_found" },
        }));
        return;
      }
      router.refresh(); // 우리 JSON이 아니다(게이트웨이 끊김) — 서버가 저장했을 수 있어 새로 읽는다
      setRegen((prev) => ({
        ...prev,
        [part]: { phase: "error", message: "응답이 중간에 끊겼어요. 화면을 새로 읽었어요 — 파트가 보이지 않으면 다시 만들어 주세요.", canRetry: true },
      }));
    } catch {
      router.refresh();
      setRegen((prev) => ({
        ...prev,
        [part]: { phase: "error", message: "네트워크 문제로 파트를 만들지 못했어요. 연결을 확인하고 다시 시도해 주세요.", canRetry: true },
      }));
    } finally {
      regenBusy.current.delete(part);
    }
  }

  const [bannerOpen, setBannerOpen] = useState(justCreated);
  const shownFailed = failedParts.filter((p) => missing.includes(p));

  // ── 렌더 ──

  function partHead(part: ToeicMockPart, present: boolean) {
    return (
      <div className={s.partHead}>
        <div className={s.partTitleRow}>
          <h2 className="t-section-title">{toeicMockPartLabelKo(part)}</h2>
          <span className={s.partTime}>{partTimeKo(part)}</span>
        </div>
        {present && (
          <Link href={toeicTakeHref(id, "part", part)} className={`u-btn u-btn-secondary ${s.practiceBtn}`}>
            🎯 유형 연습
          </Link>
        )}
      </div>
    );
  }

  function missingPart(part: ToeicMockPart) {
    const st = regen[part];
    const wasFailed = failedParts.includes(part);
    return (
      <div className={s.missing}>
        <p className={s.missingText}>
          {wasFailed ? "이 파트는 만들다 실패했어요." : "이 파트는 아직 없어요."} 같은 목표 등급·주제·활용할 표현으로 만들어요
          (보통 10~30초).
        </p>
        <button type="button" className="u-btn u-btn-primary" onClick={() => void regeneratePart(part)} disabled={st?.phase === "loading"}>
          {st?.phase === "loading" ? "만드는 중…" : wasFailed ? "🔄 이 파트 다시 만들기" : "✨ 이 파트 만들기"}
        </button>
        {st?.phase === "error" && (
          <p role="alert" className={s.error}>
            {st.message}
          </p>
        )}
      </div>
    );
  }

  function modelAnswer(k: string, text: string, used: readonly ToeicUsedExpression[], label = "모범답변") {
    const exprs = [...new Set(used.map((u) => u.expression))];
    return (
      <div className={s.answer}>
        <div className={s.answerHead}>
          <span className={s.label}>{label}</span>
          {playBtn(k, text, label)}
        </div>
        <p className={s.answerText} lang="en">
          {highlightUsed(text, used)}
        </p>
        {exprs.length > 0 && (
          <p className={s.usedList}>
            <span className={s.usedLabel}>활용한 표현</span>
            {exprs.map((e) => (
              <span key={e} className="u-chip u-chip-accent" lang="en">
                {e}
              </span>
            ))}
          </p>
        )}
      </div>
    );
  }

  function pictureFrame(item: ToeicPictureItem, slot: 0 | 1, q: number) {
    const job = imageJobs[slot];
    const readyId =
      job?.phase === "ready" ? job.imageId : item.image.status === "ready" && item.image.imageId ? item.image.imageId : null;
    if (readyId && !brokenImages.has(readyId)) {
      return (
        <figure className={s.photo}>
          {/* eslint-disable-next-line @next/next/no-img-element -- PIN 게이트 안 동적 라우트 바이트(next/image 최적화 경로를 거치지 않는다) */}
          <img
            src={toeicImageUrl(readyId)}
            alt={`Q${q} 사진 — ${item.sceneKo}`}
            width={1536}
            height={1024}
            loading="lazy"
            className={s.photoImg}
            onError={() => setBrokenImages((prev) => new Set(prev).add(readyId))}
          />
        </figure>
      );
    }
    const making = job?.phase === "making";
    const message =
      job?.phase === "failed" || job?.phase === "nokey"
        ? job.message
        : readyId
          ? "사진을 불러오지 못했어요."
          : item.image.status === "failed"
            ? "사진을 만들지 못했어요 — 장면 설명으로 연습하거나 다시 만들어 보세요."
            : null;
    return (
      <div className={`${s.photoFallback} ${making ? s.photoMaking : ""}`} role="group" aria-label={`Q${q} 장면 설명`}>
        <p className={s.photoStatus} aria-live="polite">
          {making ? "📷 사진을 그리는 중이에요… (보통 20~60초)" : "📷 사진 대신 장면 설명"}
        </p>
        <p className={s.scene}>{item.sceneKo}</p>
        {message && !making && <p className={s.photoMsg}>{message}</p>}
        {!making && job?.phase !== "nokey" && (
          <div className={s.row}>
            <button type="button" className="u-btn u-btn-secondary" onClick={() => void requestImage(slot, item.imagePrompt)}>
              {item.image.status === "pending" && !job ? "📷 사진 만들기" : "📷 사진 다시 만들기"}
            </button>
            {job?.phase === "failed" && (
              <button type="button" className="u-btn u-btn-secondary" onClick={() => router.refresh()}>
                ↻ 새로 읽기
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const p = mock.parts;
  const qOf = (part: ToeicMockPart) => toeicPartQuestions(part);

  return (
    <div className={s.wrap}>
      {bannerOpen && (
        <div role="status" className={s.banner}>
          <p className={s.bannerText}>
            ✨ 새 모의고사를 만들었어요.
            {shownFailed.length > 0 && (
              <> {shownFailed.map(toeicMockPartLabelKo).join(" · ")} 파트는 만들지 못했어요 — 아래에서 다시 만들 수 있어요.</>
            )}
            {makingCount > 0 && <> Q3–4 사진 {makingCount}장을 그리는 중이에요.</>}
          </p>
          <button type="button" className={s.bannerClose} onClick={() => setBannerOpen(false)} aria-label="안내 닫기">
            ✕
          </button>
        </div>
      )}

      {/* 제목 */}
      <div>
        {editing ? (
          <div className={s.titleEdit}>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={titleMax}
              aria-label="모의고사 이름"
              className={s.titleInput}
              autoFocus
            />
            <div className={s.row}>
              <button type="button" className="u-btn u-btn-primary" onClick={saveTitle} disabled={saving}>
                {saving ? "저장 중…" : "저장"}
              </button>
              <button
                type="button"
                className="u-btn u-btn-secondary"
                onClick={() => {
                  setEditing(false);
                  setDraft(mock.titleKo);
                  setTitleError(null);
                }}
                disabled={saving}
              >
                취소
              </button>
            </div>
          </div>
        ) : (
          <div className={s.titleView}>
            <h1 className="t-book-title">{mock.titleKo}</h1>
            <button type="button" className="u-btn u-btn-secondary" onClick={() => setEditing(true)} aria-label="모의고사 이름 수정">
              <span aria-hidden>✏️</span> 이름
            </button>
          </div>
        )}
        {titleError && (
          <p role="alert" className={s.error}>
            {titleError}
          </p>
        )}
        <p className="t-caption mt-2 flex flex-wrap items-center gap-1.5">
          <span className="u-chip">목표 {mock.targetGrade}</span>
          <span className={`u-chip ${complete ? "u-chip-accent" : ""}`}>
            {complete ? `✓ ${TOEIC_QUESTION_COUNT}문항` : `파트 ${TOEIC_MOCK_PARTS.length - missing.length}/${TOEIC_MOCK_PARTS.length}`}
          </span>
          {mock.expressionsUsed.length > 0 && <span className="u-chip">활용할 표현 {mock.expressionsUsed.length}개</span>}
          {mock.topicHints.map((t) => (
            <span key={t} className="u-chip">
              # {t}
            </span>
          ))}
        </p>
      </div>

      {/* 응시 */}
      <div className={s.takeBox}>
        {complete ? (
          <Link href={toeicTakeHref(id, "full")} className="u-btn u-btn-primary">
            ▶ 실전 응시 ({TOEIC_QUESTION_COUNT}문항)
          </Link>
        ) : (
          <button type="button" className="u-btn u-btn-primary" disabled aria-describedby="toeic-full-take-note">
            ▶ 실전 응시 ({TOEIC_QUESTION_COUNT}문항)
          </button>
        )}
        <p id="toeic-full-take-note" className={s.takeNote}>
          {complete
            ? "실제 시험 시간대로 11문항을 이어서 — 준비·답변 시간을 재고 녹음해요. 파트 하나만 하려면 아래 \"유형 연습\"."
            : `다섯 파트가 다 있어야 실전 응시를 할 수 있어요 — 빠진 파트(${missing.map(toeicMockPartLabelKo).join(" · ")})를 아래에서 만들어 주세요. 있는 파트는 "유형 연습"으로 응시할 수 있어요.`}
        </p>
        <nav aria-label="파트로 이동" className={s.partNav}>
          {TOEIC_MOCK_PARTS.map((part) => (
            <a key={part} href={`#part-${part}`} className={`u-chip ${p[part] ? "" : s.navMissing}`}>
              {toeicMockPartLabelKo(part)}
              {p[part] ? "" : " ✕"}
            </a>
          ))}
        </nav>
        <details className={s.settings}>
          <summary className={s.settingsSummary}>⚙️ 소리 설정</summary>
          <div className={s.settingsBody}>
            <TtsSpeedControl />
            <TtsEngineControl lang="en-US" />
          </div>
        </details>
      </div>

      {/* Q1–2 지문 읽기 */}
      <section id="part-read" className={s.part} aria-label={toeicMockPartLabelKo("read")}>
        {partHead("read", p.read !== null)}
        {p.read ? (
          p.read.items.map((it, i) => {
            const chunksMatch = it.chunks.join(" ").replace(/\s+/g, " ").trim() === it.text.replace(/\s+/g, " ").trim();
            return (
              <article key={i} className={s.item}>
                <div className={s.itemHead}>
                  <span className={s.qBadge}>Q{qOf("read")[i]}</span>
                  <span className="u-chip">{TOEIC_READ_KIND_KO[it.kind] ?? it.kind}</span>
                  {playBtn(`read-${i}`, it.text, `Q${qOf("read")[i]} 지문`)}
                </div>
                <p className={s.passage} lang="en">
                  {(chunksMatch ? it.chunks : [it.text]).map((c, k) => (
                    <Fragment key={k}>
                      {k > 0 && (
                        <span className={s.chunkSep} aria-hidden>
                          {" / "}
                        </span>
                      )}
                      {k > 0 && <span className={s.srOnly}> </span>}
                      {segmentStressWords(c, it.stressWords).map((seg, j) =>
                        seg.mark ? (
                          <strong key={j} className={s.stress}>
                            {seg.text}
                          </strong>
                        ) : (
                          <Fragment key={j}>{seg.text}</Fragment>
                        ),
                      )}
                    </Fragment>
                  ))}
                </p>
                <p className={s.legendNote}>
                  <span className={s.chunkSep}>/</span> 끊어 읽기 · <strong className={s.stress}>굵게</strong> 강하게 읽기
                </p>
                {it.tipsKo.length > 0 && (
                  <>
                    <p className={s.label}>발음·억양 팁</p>
                    <ul className={s.tips}>
                      {it.tipsKo.map((t, k) => (
                        <li key={k}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
              </article>
            );
          })
        ) : (
          missingPart("read")
        )}
      </section>

      {/* Q3–4 사진 묘사 */}
      <section id="part-picture" className={s.part} aria-label={toeicMockPartLabelKo("picture")}>
        {partHead("picture", p.picture !== null)}
        {p.picture ? (
          p.picture.items.map((it, i) => {
            const q = qOf("picture")[i] ?? 3 + i;
            return (
              <article key={i} className={s.item}>
                <div className={s.itemHead}>
                  <span className={s.qBadge}>Q{q}</span>
                  <span className="u-chip">{it.place}</span>
                </div>
                {i <= 1 && pictureFrame(it, i as 0 | 1, q)}
                {it.keyPointsKo.length > 0 && (
                  <>
                    <p className={s.label}>놓치지 말 묘사 포인트</p>
                    <ul className={s.tips}>
                      {it.keyPointsKo.map((t, k) => (
                        <li key={k}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                {modelAnswer(`pic-${i}`, it.sampleAnswer, it.usedExpressions)}
              </article>
            );
          })
        ) : (
          missingPart("picture")
        )}
      </section>

      {/* Q5–7 듣고 답하기 */}
      <section id="part-respond" className={s.part} aria-label={toeicMockPartLabelKo("respond")}>
        {partHead("respond", p.respond !== null)}
        {p.respond ? (
          <>
            <article className={s.item}>
              <div className={s.itemHead}>
                <span className={s.label}>상황</span>
                <span className="u-chip">{p.respond.topicKo}</span>
                {playBtn("respond-intro", p.respond.intro, "상황 소개")}
              </div>
              <p className={s.en} lang="en">
                {p.respond.intro}
              </p>
            </article>
            {p.respond.questions.map((qq, i) => {
              const q = qOf("respond")[i];
              const f = TOEIC_MOCK_FORMAT.find((x) => x.q === q);
              return (
                <article key={i} className={s.item}>
                  <div className={s.itemHead}>
                    <span className={s.qBadge}>Q{q}</span>
                    {f && <span className={s.partTime}>답변 {f.answerSec}초</span>}
                    {playBtn(`respond-q-${i}`, qq.question, `Q${q} 질문`)}
                  </div>
                  <p className={s.question} lang="en">
                    {qq.question}
                  </p>
                  {modelAnswer(`respond-a-${i}`, qq.sampleAnswer, qq.usedExpressions)}
                  <p className={s.tip}>💡 {qq.tipKo}</p>
                </article>
              );
            })}
          </>
        ) : (
          missingPart("respond")
        )}
      </section>

      {/* Q8–10 정보 활용 */}
      <section id="part-info" className={s.part} aria-label={toeicMockPartLabelKo("info")}>
        {partHead("info", p.info !== null)}
        {p.info ? (
          <>
            <article className={s.item}>
              <div className={s.table} lang="en">
                <div className={s.tableHead}>
                  <p className={s.tableTitle}>{p.info.table.title}</p>
                  <span className="u-chip" lang="ko">
                    {TOEIC_INFO_KIND_KO[p.info.table.kind] ?? p.info.table.kind}
                  </span>
                </div>
                {p.info.table.meta.length > 0 && (
                  <ul className={s.meta}>
                    {p.info.table.meta.map((m, k) => (
                      <li key={k}>{m}</li>
                    ))}
                  </ul>
                )}
                <table className={s.rows}>
                  <tbody>
                    {p.info.table.rows.map((r, k) => (
                      <tr key={k}>
                        <th scope="row">{r.left}</th>
                        <td>{r.right}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {p.info.table.notes.length > 0 && (
                  <ul className={s.notes}>
                    {p.info.table.notes.map((n, k) => (
                      <li key={k}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className={s.itemHead}>
                <span className={s.label}>전화 건 사람</span>
                {playBtn("info-caller", p.info.callerIntro, "전화 도입")}
              </div>
              <p className={s.en} lang="en">
                {p.info.callerIntro}
              </p>
            </article>
            {p.info.questions.map((qq, i) => {
              const q = qOf("info")[i];
              const f = TOEIC_MOCK_FORMAT.find((x) => x.q === q);
              return (
                <article key={i} className={s.item}>
                  <div className={s.itemHead}>
                    <span className={s.qBadge}>Q{q}</span>
                    {f && <span className={s.partTime}>답변 {f.answerSec}초{f.questionPlays > 1 ? ` · 질문 ${f.questionPlays}번 들려줌` : ""}</span>}
                    {playBtn(`info-q-${i}`, qq.question, `Q${q} 질문`)}
                  </div>
                  <p className={s.question} lang="en">
                    {qq.question}
                  </p>
                  {modelAnswer(`info-a-${i}`, qq.sampleAnswer, qq.usedExpressions)}
                  <p className={s.tip}>💡 {qq.tipKo}</p>
                </article>
              );
            })}
            <p className={s.caption}>실전에서는 표만 보이고 질문은 소리로만 나와요(질문 글은 학습 보기에서만).</p>
          </>
        ) : (
          missingPart("info")
        )}
      </section>

      {/* Q11 의견 말하기 */}
      <section id="part-opinion" className={s.part} aria-label={toeicMockPartLabelKo("opinion")}>
        {partHead("opinion", p.opinion !== null)}
        {p.opinion ? (
          <article className={s.item}>
            <div className={s.itemHead}>
              <span className={s.qBadge}>Q{qOf("opinion")[0]}</span>
              <span className="u-chip">{TOEIC_OPINION_KIND_KO[p.opinion.kind] ?? p.opinion.kind}</span>
              {playBtn("opinion-q", p.opinion.question, "Q11 질문")}
            </div>
            <p className={s.question} lang="en">
              {p.opinion.question}
            </p>
            {p.opinion.outlineKo.length > 0 && (
              <>
                <p className={s.label}>답변 뼈대</p>
                <ol className={s.outline}>
                  {p.opinion.outlineKo.map((o, k) => (
                    <li key={k}>{o}</li>
                  ))}
                </ol>
              </>
            )}
            {modelAnswer("opinion-a", p.opinion.sampleAnswer, p.opinion.usedExpressions)}
            <p className={s.tip}>💡 {p.opinion.tipKo}</p>
          </article>
        ) : (
          missingPart("opinion")
        )}
      </section>

      {/* 활용할 표현 */}
      {mock.expressionsUsed.length > 0 && (
        <details className={s.exprBox}>
          <summary className={s.exprSummary}>📒 이 모의고사에 넘긴 활용할 표현 {mock.expressionsUsed.length}개</summary>
          <p className={s.caption}>표현집에서 골라 모범답변에 녹이도록 넘긴 표현이에요. 실제로 쓴 곳은 모범답변에 밑줄로 보여요.</p>
          <p className="mt-2 flex flex-wrap gap-1.5">
            {mock.expressionsUsed.map((e) => (
              <span key={e} className="u-chip" lang="en">
                {e}
              </span>
            ))}
          </p>
        </details>
      )}

      {/* 응시 기록 */}
      <section aria-label="응시 기록" className={s.part}>
        <h2 className="t-section-title">📊 응시 기록</h2>
        {attempts.length === 0 ? (
          <p className={s.emptyNote}>아직 응시 기록이 없어요. 실전 응시나 유형 연습을 마치면 여기에 쌓여요.</p>
        ) : (
          <ul className={s.attemptList}>
            {attempts.map((a) => (
              <li key={a.id}>
                <Link href={`/toeic/attempts/${encodeURIComponent(a.id)}`} className="u-item">
                  <span className="u-item-thumb" aria-hidden>
                    {a.scope === "full" ? "🧑‍💼" : "🎯"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="t-list-title block truncate">
                      {a.scope === "full" ? "실전 응시" : `유형 연습 · ${a.parts.map(toeicMockPartLabelKo).join(" · ")}`}
                    </span>
                    <span className="t-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span className="u-chip">{a.finished ? "끝까지" : a.closed ? "중단" : "저장 안 됨"}</span>
                      <span className="u-chip">녹음 {a.recordedCount}문항</span>
                      {a.scoredCount > 0 && <span className="u-chip u-chip-accent">채점 {a.scoredCount}문항</span>}
                      {a.estimateKo && <span className="u-chip u-chip-accent">{a.estimateKo}</span>}
                      <span className="t-caption">{formatKst(a.startedAt)}</span>
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
