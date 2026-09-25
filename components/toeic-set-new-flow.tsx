"use client";

/**
 * 표현집 사진 판독 → DAY별 검토·수정 → 저장 → 발화 포인트 (아빠의 영어 T1, docs/harness/toeic.md §2·§3-0·§8)
 * — `/toeic/sets/new` 화면의 본체.
 *
 * 흐름: 사진 여러 장을 쌓아 고르기(한 장씩 자르기 — ImageCropper) → 클라이언트 리사이즈(lib/image-resize) →
 * `POST /api/toeic/sets/extract`(호출 A, 사진별 병렬 + DAY별 묶기) → **검토 화면**(DAY 묶음마다 표현·뜻·예문·해석·QUIZ를
 * 고치고 빼기, 잘림·흐림 칩, 빠진 번호, 실패한 사진 수를 사실대로) → 묶음마다 `POST /api/toeic/sets`(저장) →
 * 저장된 세트마다 `POST /api/toeic/sets/[id]/points`(호출 B, **best-effort** — 실패해도 카드는 쓴다) → 상세(또는 목록)로.
 *
 * 은우 단어장 사진 흐름(`vocabbook-photo-flow.tsx`)의 관용구 — Phase 상태기계·재진입 가드(runningRef)·자르기 큐·미리보기 URL
 * 해제·경과 초 — 를 그대로 가져왔지만, 표현 엔트리 모양과 성인 톤이 달라 **토익 전용으로 새로** 둔다(§10, 은우 코드 무수정).
 *
 * 사진은 저장하지 않는다(판독에만 보내고 라우트가 버린다). `lib/ai/*`는 타입만(계약 모듈 경유) — 상한 숫자는 서버 페이지가
 * props(limits)로 내린다.
 *
 * ── 저장 전 점검(§7-1, QA toeic_m1 P2-3) ─────────────────────────────────────────
 * 판독 zod는 사진 그대로를 받으므로 초안에는 **같은 표현 두 항목**(대소문자·띄어쓰기만 다른 것 포함)과 **잘린 항목의 빈 뜻**이
 * 올 수 있다(§2-4). 저장 라우트가 둘 다 400으로 거부하므로, 검토 화면이 같은 판정(`findDuplicateExpressionIndexes` — lib/toeic-text
 * 단일 정의)으로 **저장 전에** 짚어 주고 그 묶음을 저장 대상에서 뺀다. 빈 뜻 항목은 처음부터 고치기 칸을 열어 둔다.
 *
 * ── 판독 실패 갈래(QA P2-2) ───────────────────────────────────────────────────────
 * "다시 읽기"는 **다시 눌러 나아질 때만** — 네트워크 예외, 라우트가 `retriable:true`로 답한 500(ai_failed), 우리 라우트가 답하지
 * 못한 게이트웨이 오류(본문이 JSON이 아닌 5xx). 키 없음(501)·입력 오류(400)는 같은 결과가 반복되므로 이유만 한국어로 알린다.
 *
 * ── 완료 안내(QA P2-6) ────────────────────────────────────────────────────────────
 * 저장 응답의 `droppedKeyExpressions`(검토에서 표현을 고치거나 빼서 QUIZ가 가리킬 표현을 잃은 수)가 있으면 바로 넘어가지 않고
 * 완료 화면에서 사실대로 알린 뒤 사용자가 넘어간다. 없으면 예전처럼 곧장 상세(또는 목록)로.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ImageCropper from "./image-cropper";
import { resizeToJpegDataUrl } from "@/lib/image-resize";
import {
  toeicIssueLineKo,
  type ToeicBookQuiz,
  type ToeicExtractResponse,
  type ToeicSetDraft,
  type ToeicSetEditLimits,
  type ToeicSetSaveEntry,
  type ToeicSetSaveRequest,
  type ToeicSetSaveResponse,
} from "@/lib/toeic-set-contract";
import { expressionKey, findDuplicateExpressionIndexes } from "@/lib/toeic-text";

type Phase = "pick" | "reading" | "review" | "saving" | "points" | "done";

interface EditEntry extends ToeicSetSaveEntry {
  excluded: boolean;
}
interface EditQuiz extends ToeicBookQuiz {
  excluded: boolean;
}
interface EditDraft {
  include: boolean;
  titleKo: string;
  dayNo: number | null;
  topicKo: string | null;
  entries: EditEntry[];
  quiz: EditQuiz[];
  photoIndexes: number[];
  missingNos: number[];
  mergedCount: number;
  droppedKeyExpressions: number;
  /** 저장에 성공했으면 id — 다시 저장을 눌러도 같은 묶음을 두 번 만들지 않는다 */
  savedId: string | null;
  /** 저장 응답의 droppedKeyExpressions — 표현을 고치거나 빼서 QUIZ가 가리킬 표현을 잃은 수(완료 안내, P2-6) */
  droppedOnSave: number;
  /** 이 묶음 저장 실패 메시지 */
  errorKo: string | null;
  issues: string[];
}

interface ReadMeta {
  photoCount: number;
  failedPhotoCount: number;
  notExpressionPhotoCount: number;
  model: string;
}

function toEditDraft(d: ToeicSetDraft): EditDraft {
  return {
    include: d.entries.length > 0,
    titleKo: d.titleKo,
    dayNo: d.dayNo,
    topicKo: d.topicKo,
    entries: d.entries.map((e) => ({
      no: e.no,
      expression: e.expression,
      meaningKo: e.meaningKo,
      example: e.example,
      exampleKo: e.exampleKo,
      confidence: e.confidence,
      partial: e.partial,
      excluded: false,
    })),
    quiz: d.quiz.map((q) => ({ ...q, excluded: false })),
    photoIndexes: d.photoIndexes,
    missingNos: d.missingNos,
    mergedCount: d.mergedCount,
    droppedKeyExpressions: d.droppedKeyExpressions,
    savedId: null,
    droppedOnSave: 0,
    errorKo: null,
    issues: [],
  };
}

/** 검토 화면의 항목 이름 — 교재 번호가 있으면 "#03", 없으면 "5번째"(화면 목록 순서, 뺀 항목 포함) */
function entryLabel(e: { no: number | null }, displayIndex: number): string {
  return e.no !== null ? `#${String(e.no).padStart(2, "0")}` : `${displayIndex + 1}번째`;
}
function quizLabel(q: { no: number | null }, displayIndex: number): string {
  return q.no !== null ? `Q${q.no}` : `${displayIndex + 1}번째`;
}
/** 완료 안내에 쓰는 묶음 이름 — 이름을 비웠으면 서버가 기본 제목을 붙이므로 여기선 DAY로만 */
function draftName(d: { titleKo: string; dayNo: number | null }): string {
  return d.titleKo.trim() || (d.dayNo !== null ? `DAY ${d.dayNo}` : "이름 없는 표현집");
}

/** 저장 전에 짚을 곳(§7-1) — 저장 라우트가 400으로 거부하는 것 중 판독이 흔히 남기는 셋. 뺀 항목은 보지 않는다. */
interface DraftProblems {
  /** 화면 위치 → 앞에 있는 같은 표현의 화면 위치 */
  dupOf: Map<number, number>;
  /** 뜻이 빈 항목(잘린 항목 — §2-4) */
  blankMeaning: Set<number>;
  /** 표현이 빈 항목(고치다 지운 경우) */
  blankExpression: Set<number>;
  count: number;
}

function draftProblems(d: EditDraft): DraftProblems {
  const keptIdx = d.entries.flatMap((e, i) => (e.excluded ? [] : [i]));
  const kept = keptIdx.map((i) => d.entries[i]);
  // 판정은 저장 라우트·가져오기 zod와 같은 함수(findDuplicateExpressionIndexes) — "앞 항목"을 짚으려고 첫 등장만 따로 기억한다
  const firstAt = new Map<string, number>();
  kept.forEach((e, k) => {
    const key = expressionKey(e.expression);
    if (key !== "" && !firstAt.has(key)) firstAt.set(key, keptIdx[k]);
  });
  const dupOf = new Map<number, number>();
  for (const k of findDuplicateExpressionIndexes(kept)) dupOf.set(keptIdx[k], firstAt.get(expressionKey(kept[k].expression)) ?? keptIdx[k]);
  const blankMeaning = new Set(keptIdx.filter((i) => d.entries[i].meaningKo.trim() === ""));
  const blankExpression = new Set(keptIdx.filter((i) => d.entries[i].expression.trim() === ""));
  return { dupOf, blankMeaning, blankExpression, count: dupOf.size + blankMeaning.size + blankExpression.size };
}

/** 키 없음(501)·입력 오류(400) — 다시 읽어도 같은 결과라 "다시 읽기" 대신 이유를 알린다(P2-2) */
const NO_KEY_HINT_KO =
  "키가 없으면 사진 판독(AI)을 할 수 없어서, 다시 읽어도 같은 결과예요. 교재 파일이 있으면 목록의 '파일로 가져오기'는 키 없이 돼요.";
const INVALID_HINT_KO = "보낸 사진을 받을 수 없었어요. 문제가 된 사진을 ✕로 빼거나 ✂️ 자르기로 줄인 뒤 다시 판독해 주세요.";

const nullIfBlank = (s: string | null): string | null => (s === null || s.trim() === "" ? null : s.trim());

/** 검토한 묶음 → 저장 요청. 뺀 것은 빼고, 빈 칸은 null로(예문을 지우면 해석도 서버가 비운다). */
function toSaveRequest(d: EditDraft, meta: ReadMeta): ToeicSetSaveRequest {
  return {
    titleKo: d.titleKo.trim(),
    dayNo: d.dayNo,
    topicKo: d.topicKo,
    entries: d.entries
      .filter((e) => !e.excluded)
      .map(({ excluded: _x, ...e }) => ({ ...e, expression: e.expression.trim(), meaningKo: e.meaningKo.trim(), example: nullIfBlank(e.example), exampleKo: nullIfBlank(e.exampleKo) })),
    quiz: d.quiz
      .filter((q) => !q.excluded)
      .map(({ excluded: _x, ...q }) => ({ ...q, promptKo: q.promptKo.trim(), modelAnswer: q.modelAnswer.trim(), hint: nullIfBlank(q.hint) })),
    photoCount: d.photoIndexes.length > 0 ? d.photoIndexes.length : meta.photoCount,
    model: meta.model,
  };
}

const inputCls = "mt-1 w-full rounded-[var(--radius-box)] border border-line bg-bg px-3 py-2 text-ink";

/** 저장 응답의 droppedKeyExpressions를 사실대로(P2-6) — QUIZ 문장은 남고, 연결만 풀린다 */
function DropNotes({ notes }: { notes: { titleKo: string; dropped: number }[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="mt-3 rounded-[var(--radius-box)] border border-line-strong px-4 py-3 text-left">
      <ul className="t-caption flex flex-col gap-1">
        {notes.map((n, i) => (
          <li key={i}>
            🔗 <span className="font-medium text-ink">{n.titleKo}</span> — QUIZ가 가리키던 표현 {n.dropped}개는 검토에서 고치거나 뺀
            표현이라 연결을 풀었어요.
          </li>
        ))}
      </ul>
      <p className="t-caption mt-2">
        QUIZ 문장·모범답변은 그대로 남아요. 표현 연결이 모두 풀린 QUIZ는 말하기 시험에서 QUIZ 번호로 기록해요.
      </p>
    </div>
  );
}

export default function ToeicSetNewFlow({ limits }: { limits: ToeicSetEditLimits }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("pick");

  // 사진(판독 전)
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [cropIndex, setCropIndex] = useState<number | null>(null);
  const [cropQueue, setCropQueue] = useState<File[]>([]);

  // 검토
  const [drafts, setDrafts] = useState<EditDraft[]>([]);
  const [meta, setMeta] = useState<ReadMeta | null>(null);
  const [editing, setEditing] = useState<Set<string>>(new Set());

  // 상태
  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [canRetry, setCanRetry] = useState(false);
  const [errorHintKo, setErrorHintKo] = useState<string | null>(null);
  /** 저장 완료 안내 — 묶음마다 QUIZ 연결을 푼 수(P2-6) */
  const [dropNotes, setDropNotes] = useState<{ titleKo: string; dropped: number }[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const [retakeKo, setRetakeKo] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [doneHref, setDoneHref] = useState("/toeic/sets");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const runningRef = useRef(false);
  const busy = phase === "reading" || phase === "saving" || phase === "points";

  useEffect(() => {
    if (!busy) return;
    setElapsedSec(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsedSec(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // 미리보기 object URL 해제 — 언마운트 시(바뀔 때마다는 remove/replace/reset이 직접 해제)
  useEffect(() => {
    return () => previews.forEach((url) => URL.revokeObjectURL(url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearStatus() {
    setErrorKo(null);
    setIssues([]);
    setCanRetry(false);
    setErrorHintKo(null);
    setRetakeKo(null);
  }

  // ── 1) 사진 ──
  function enqueueForCrop(list: FileList | null) {
    const added = Array.from(list ?? []);
    if (added.length === 0) return;
    clearStatus();
    const remaining = Math.max(0, limits.photos - files.length - cropQueue.length);
    if (remaining === 0) return;
    setCropQueue((q) => [...q, ...added.slice(0, remaining)]);
  }
  function appendCroppedFile(next: File) {
    clearStatus();
    const url = URL.createObjectURL(next);
    setFiles((prev) => [...prev, next]);
    setPreviews((prev) => [...prev, url]);
  }
  function removeFile(index: number) {
    clearStatus();
    setPreviews((prev) => {
      const url = prev[index];
      if (url) URL.revokeObjectURL(url);
      return prev.filter((_, i) => i !== index);
    });
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }
  function replaceFile(index: number, next: File) {
    clearStatus();
    setPreviews((prev) => {
      const url = prev[index];
      if (url) URL.revokeObjectURL(url);
      return prev.map((u, i) => (i === index ? URL.createObjectURL(next) : u));
    });
    setFiles((prev) => prev.map((f, i) => (i === index ? next : f)));
  }
  function resetToPick() {
    previews.forEach((url) => URL.revokeObjectURL(url));
    setPreviews([]);
    setFiles([]);
    setCropQueue([]);
    setDrafts([]);
    setMeta(null);
    setEditing(new Set());
    clearStatus();
    setPhase("pick");
  }

  // ── 2) 판독 ──
  async function readAll() {
    if (runningRef.current || files.length === 0) return;
    runningRef.current = true;
    clearStatus();
    setPhase("reading");
    try {
      const images = await Promise.all(files.map((f) => resizeToJpegDataUrl(f)));
      const res = await fetch("/api/toeic/sets/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const data = (await res.json().catch(() => null)) as ToeicExtractResponse | null;
      if (data?.ok) {
        const nextDrafts = data.drafts.map(toEditDraft);
        setDrafts(nextDrafts);
        setMeta({
          photoCount: data.photoCount,
          failedPhotoCount: data.failedPhotoCount,
          notExpressionPhotoCount: data.notExpressionPhotoCount,
          model: data.model,
        });
        // 뜻이 빈 항목(잘린 항목, §2-4)은 고치기 칸을 처음부터 열어 둔다 — 채워야 저장된다(§7-1)
        setEditing(new Set(nextDrafts.flatMap((d, di) => d.entries.flatMap((e, ei) => (e.meaningKo.trim() === "" ? [`${di}:e:${ei}`] : [])))));
        setPhase("review");
        return;
      }
      if (data && "reason" in data) {
        setRetakeKo(data.messageKo); // 다시 찍기 — 오류가 아니라 정상 갈래. 고른 사진은 그대로 둔다
        setPhase("pick");
        return;
      }
      const err = data && !data.ok && "error" in data ? data : null;
      setErrorKo(err ? err.messageKo : "사진을 읽지 못했어요. 잠시 후 다시 시도해 주세요.");
      // 다시 눌러 나아질 때만 "다시 읽기"(P2-2): 우리 라우트가 답했으면 그 retriable(ai_failed 500)만 믿는다 — 501(키 없음)·
      // 400(입력)은 몇 번을 눌러도 같다. 본문이 우리 JSON이 아닌 5xx(게이트웨이 시간 초과 등)는 네트워크와 같은 일시 장애로 본다.
      setCanRetry(err ? err.retriable === true : res.status >= 500 && res.status !== 501);
      setErrorHintKo(err?.error === "no_api_key" ? NO_KEY_HINT_KO : err?.error === "invalid_input" ? INVALID_HINT_KO : null);
      setIssues(err?.issues ? err.issues.map((i) => toeicIssueLineKo(i)) : []);
      setPhase("pick");
    } catch {
      setErrorKo("인터넷 연결을 확인한 뒤 다시 시도해 주세요.");
      setCanRetry(true);
      setPhase("pick");
    } finally {
      runningRef.current = false;
    }
  }

  // ── 3) 검토 편집 ──
  function patchDraft(d: number, patch: Partial<EditDraft>) {
    setDrafts((prev) => prev.map((x, i) => (i === d ? { ...x, ...patch } : x)));
  }
  function patchEntry(d: number, e: number, patch: Partial<EditEntry>) {
    setDrafts((prev) => prev.map((x, i) => (i === d ? { ...x, entries: x.entries.map((y, j) => (j === e ? { ...y, ...patch } : y)) } : x)));
  }
  function patchQuiz(d: number, q: number, patch: Partial<EditQuiz>) {
    setDrafts((prev) => prev.map((x, i) => (i === d ? { ...x, quiz: x.quiz.map((y, j) => (j === q ? { ...y, ...patch } : y)) } : x)));
  }
  function toggleEdit(key: string) {
    setEditing((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** 저장 가능한 묶음 — 포함·미저장·표현 1개 이상, 그리고 세트 상한(§7-1: 표현 60·QUIZ 12, 서버 zod와 같은 수 — props) 안 */
  const withinLimits = (d: EditDraft) => {
    const kept = d.entries.filter((e) => !e.excluded).length;
    return kept >= 1 && kept <= limits.entriesMax && d.quiz.filter((q) => !q.excluded).length <= limits.quizMax;
  };
  const problemsByDraft = drafts.map(draftProblems);
  /** 저장 가능 — 위 상한 + 저장 전 점검(같은 표현·빈 뜻·빈 표현)이 0이어야 한다(저장 라우트가 400으로 거부하는 것, §7-1) */
  const isSavable = (d: EditDraft) => d.include && d.savedId === null && withinLimits(d) && draftProblems(d).count === 0;
  const savable = drafts.filter(isSavable);
  const alreadySaved = drafts.filter((d) => d.savedId !== null);
  /** 저장하려고 고른 묶음 중 고칠 곳이 남아 저장에서 빠지는 수 */
  const blockedCount = drafts.filter((d, i) => d.include && d.savedId === null && withinLimits(d) && problemsByDraft[i].count > 0).length;

  // ── 4) 저장 → 발화 포인트(best-effort) ──
  async function saveAll() {
    if (runningRef.current || !meta) return;
    if (savable.length === 0 && alreadySaved.length === 0) return;
    runningRef.current = true;
    clearStatus();
    setPhase("saving");
    const targets = drafts.map((d, i) => ({ d, i })).filter(({ d }) => isSavable(d));
    setProgress({ done: 0, total: targets.length });
    let failed = false;
    const savedIds: string[] = drafts.filter((d) => d.savedId !== null).map((d) => d.savedId!);
    // 완료 안내(P2-6) — 앞선 시도에서 저장된 묶음의 안내도 잃지 않는다(drafts 상태는 이 함수 안에서 갱신이 안 보이므로 따로 모은다)
    const notes = drafts.filter((d) => d.savedId !== null && d.droppedOnSave > 0).map((d) => ({ titleKo: draftName(d), dropped: d.droppedOnSave }));
    for (const [k, { d, i }] of targets.entries()) {
      try {
        const res = await fetch("/api/toeic/sets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(toSaveRequest(d, meta)),
        });
        const data = (await res.json().catch(() => null)) as ToeicSetSaveResponse | null;
        if (data?.ok) {
          savedIds.push(data.id);
          if (data.droppedKeyExpressions > 0) notes.push({ titleKo: draftName(d), dropped: data.droppedKeyExpressions });
          patchDraft(i, { savedId: data.id, droppedOnSave: data.droppedKeyExpressions, errorKo: null, issues: [] });
        } else {
          failed = true;
          // 저장 요청은 뺀 항목을 건너뛴 목록이라 issue의 번호를 화면 이름(#03·Q1)으로 되돌린다
          const keptEntries = d.entries.flatMap((e, ei) => (e.excluded ? [] : [ei]));
          const keptQuiz = d.quiz.flatMap((q, qi) => (q.excluded ? [] : [qi]));
          const indexLabel = (col: string, n: number): string | null => {
            if (col === "entries" && keptEntries[n] !== undefined) return `표현 ${entryLabel(d.entries[keptEntries[n]], keptEntries[n])}`;
            if (col === "quiz" && keptQuiz[n] !== undefined) return `QUIZ ${quizLabel(d.quiz[keptQuiz[n]], keptQuiz[n])}`;
            return null;
          };
          patchDraft(i, {
            errorKo: data && !data.ok ? data.messageKo : "저장하지 못했어요.",
            issues: data && !data.ok ? (data.issues ?? []).slice(0, 6).map((x) => toeicIssueLineKo(x, indexLabel)) : [],
          });
        }
      } catch {
        failed = true;
        patchDraft(i, { errorKo: "네트워크 문제로 저장하지 못했어요.", issues: [] });
      }
      setProgress({ done: k + 1, total: targets.length });
    }

    if (failed) {
      setErrorKo("저장하지 못한 묶음이 있어요. 표시된 곳을 고친 뒤 다시 저장해 주세요(저장된 묶음은 다시 만들지 않아요).");
      setPhase("review");
      runningRef.current = false;
      return;
    }

    // 발화 포인트 — 저장된 세트마다 한 번(빈 자리만). 실패·키 없음(501)은 조용히 넘어간다: 상세의 "발화 포인트 만들기"로 채운다.
    const href = savedIds.length === 1 ? `/toeic/sets/${savedIds[0]}` : "/toeic/sets";
    setDoneHref(href);
    setDropNotes(notes);
    setSavedCount(savedIds.length);
    setPhase("points");
    setProgress({ done: 0, total: savedIds.length });
    for (const [k, id] of savedIds.entries()) {
      try {
        const res = await fetch(`/api/toeic/sets/${encodeURIComponent(id)}/points`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: false }),
        });
        // 결과는 보지 않는다 — 못 채운 표현은 상세 화면이 "발화 포인트 만들기"를 띄운다(포인트 개수를 세트에서 읽는다)
        await res.json().catch(() => null);
      } catch {
        /* best-effort — 네트워크 실패도 상세에서 다시 만들 수 있다 */
      }
      setProgress({ done: k + 1, total: savedIds.length });
    }
    runningRef.current = false;
    if (notes.length > 0) {
      setPhase("done"); // 알릴 것이 있으면 곧장 넘기지 않는다 — 완료 화면에서 사실대로 보여 주고 사용자가 넘어간다(P2-6)
      return;
    }
    router.push(href);
  }

  // ── 렌더 ──
  if (phase === "done") {
    return (
      <div className="u-box text-center" role="status" aria-live="polite">
        <p className="t-section-title">✅ 표현집 {savedCount}개를 저장했어요</p>
        <DropNotes notes={dropNotes} />
        <div className="mt-4 flex justify-center">
          <Link href={doneHref} className="u-btn u-btn-primary">
            <span aria-hidden>📒</span> {doneHref === "/toeic/sets" ? "표현집 목록 보기" : "표현집 보기"}
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "reading" || phase === "saving" || phase === "points") {
    return (
      <div className="u-box text-center" role="status" aria-live="polite">
        <p className="t-section-title">
          {phase === "reading" ? "📖 표현을 읽고 있어요…" : phase === "saving" ? "💾 저장하고 있어요…" : "✨ 발화 포인트를 만들고 있어요…"}
        </p>
        <p className="t-caption mt-2">
          {phase === "reading"
            ? `사진 ${files.length}장을 한 번에 읽는 중이에요.`
            : phase === "saving"
              ? `표현집 ${progress.done}/${progress.total}`
              : `표현마다 문항별 활용 문장·답변 틀·발음 팁을 만드는 중이에요 (${progress.done}/${progress.total}).`}
          {elapsedSec >= 3 ? ` (${elapsedSec}초)` : ""}
        </p>
        {phase === "points" && (
          <>
            <DropNotes notes={dropNotes} />
            <p className="t-caption mt-3">
              <Link href={doneHref} className="text-accent underline">
                기다리지 않고 보기
              </Link>{" "}
              — 못 만든 포인트는 상세 화면에서 다시 만들 수 있어요.
            </p>
          </>
        )}
      </div>
    );
  }

  if (phase === "review" && meta) {
    return (
      <div>
        <div className="u-box">
          <p className="t-section-title">읽은 표현집 {drafts.length}개</p>
          {meta.failedPhotoCount > 0 && (
            <p className="t-caption mt-2">
              ⚠️ 사진 {meta.photoCount}장 중 {meta.failedPhotoCount}장을 읽지 못했어요. 빠진 표현이 있으면 그 페이지를 다시 찍어 주세요.
            </p>
          )}
          {meta.notExpressionPhotoCount > 0 && (
            <p className="t-caption mt-1">📷 표현 암기장이 아닌 것 같은 사진 {meta.notExpressionPhotoCount}장은 뺐어요.</p>
          )}
          <p className="t-caption mt-2">
            잘못 읽은 곳은 <span className="font-medium text-ink">✏️ 고치기</span>로, 저장하지 않을 항목은{" "}
            <span className="font-medium text-ink">🗑 빼기</span>로 손봐 주세요. 저장하면 발화 포인트를 바로 만들어요.
          </p>
        </div>

        {drafts.map((d, di) => {
          const kept = d.entries.filter((e) => !e.excluded).length;
          const keptQuiz = d.quiz.filter((q) => !q.excluded).length;
          const pr = problemsByDraft[di];
          return (
            <section
              key={di}
              aria-label={`${d.titleKo} 검토`}
              className={`mt-6 rounded-[var(--radius-card)] border p-4 ${d.include ? "border-line" : "border-dashed border-line opacity-60"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="t-section-title">
                  {d.dayNo !== null ? `DAY ${d.dayNo}` : "DAY 없음"}
                  {d.topicKo ? ` · ${d.topicKo}` : ""}
                </p>
                {d.savedId ? (
                  <span className="u-chip u-chip-accent">✓ 저장됨</span>
                ) : (
                  <label className="t-meta-chip flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={d.include}
                      disabled={d.entries.length === 0}
                      onChange={(e) => patchDraft(di, { include: e.target.checked })}
                    />
                    이 묶음 저장
                  </label>
                )}
              </div>
              <div className="t-caption mt-1 flex flex-wrap gap-1.5">
                <span className="u-chip">사진 {d.photoIndexes.map((p) => p + 1).join("·")}</span>
                <span className="u-chip">표현 {kept}/{d.entries.length}</span>
                <span className="u-chip">QUIZ {keptQuiz}/{d.quiz.length}</span>
                {d.mergedCount > 0 && <span className="u-chip">겹친 {d.mergedCount}개 합침</span>}
              </div>
              {d.missingNos.length > 0 && (
                <p className="t-caption mt-2">
                  🔎 {d.missingNos.slice(0, 10).join(", ")}
                  {d.missingNos.length > 10 ? " 등" : ""}번이 빠진 것 같아요 — 그 번호가 있는 사진이 빠졌을 수 있어요.
                </p>
              )}
              {d.droppedKeyExpressions > 0 && (
                <p className="t-caption mt-1">QUIZ의 굵은 표현 중 {d.droppedKeyExpressions}개는 이 페이지 표현과 맞지 않아 뺐어요.</p>
              )}
              {d.include && !d.savedId && (kept > limits.entriesMax || keptQuiz > limits.quizMax) && (
                <p role="alert" className="t-caption mt-2 text-danger">
                  한 표현집에는 표현 {limits.entriesMax}개·QUIZ {limits.quizMax}개까지 담을 수 있어요 — 빼기로 줄이거나 사진을 나눠 찍어 주세요.
                </p>
              )}
              {d.entries.length === 0 && (
                <p className="t-caption mt-2">이 묶음에는 표현이 없어 저장할 수 없어요(QUIZ만 읽혔어요).</p>
              )}
              {!d.savedId && pr.count > 0 && (
                <div role="alert" className="t-caption mt-2 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-3 py-2 text-danger">
                  <p className="font-medium">저장 전에 고칠 곳이 {pr.count}곳 있어요 — 고치거나 🗑 빼면 저장할 수 있어요.</p>
                  <ul className="mt-1 list-disc pl-5">
                    {pr.dupOf.size > 0 && <li>같은 표현이 두 번 있어요 {pr.dupOf.size}곳(대소문자·띄어쓰기만 달라도 같은 표현이에요)</li>}
                    {pr.blankMeaning.size > 0 && <li>뜻이 빈 표현 {pr.blankMeaning.size}개(사진 밖으로 잘린 항목) — 뜻을 채워 주세요</li>}
                    {pr.blankExpression.size > 0 && <li>영어 표현이 빈 항목 {pr.blankExpression.size}개</li>}
                  </ul>
                </div>
              )}

              {!d.savedId && d.entries.length > 0 && (
                <label className="mt-3 block">
                  <span className="t-meta-chip">이름</span>
                  <input
                    type="text"
                    value={d.titleKo}
                    onChange={(e) => patchDraft(di, { titleKo: e.target.value })}
                    maxLength={limits.title}
                    placeholder="예: DAY 3 쇼핑"
                    className={inputCls}
                  />
                </label>
              )}

              {/* 표현 항목 */}
              <ul className="mt-3 flex flex-col gap-2">
                {d.entries.map((e, ei) => {
                  const key = `${di}:e:${ei}`;
                  const isEditing = editing.has(key) && !e.excluded && !d.savedId;
                  const dupFirst = d.savedId ? undefined : pr.dupOf.get(ei);
                  const blankMeaning = !d.savedId && pr.blankMeaning.has(ei);
                  const blankExpression = !d.savedId && pr.blankExpression.has(ei);
                  const hasProblem = dupFirst !== undefined || blankMeaning || blankExpression;
                  return (
                    <li
                      key={ei}
                      className={`rounded-[var(--radius-box)] border p-3 ${e.excluded ? "border-dashed border-line opacity-55" : hasProblem ? "border-danger" : "border-line"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-baseline gap-x-2">
                            {e.no !== null && <span className="t-meta-chip tabular-nums">{String(e.no).padStart(2, "0")}</span>}
                            <span className="t-list-title break-words" lang="en">
                              {e.expression.trim() !== "" ? e.expression : <span className="text-danger">(영어 표현이 비었어요)</span>}
                            </span>
                          </p>
                          {e.meaningKo.trim() !== "" ? (
                            <p className="t-question-ko mt-0.5">{e.meaningKo}</p>
                          ) : (
                            <p className="t-question-ko mt-0.5 text-danger">(뜻이 비었어요 — 채워 주세요)</p>
                          )}
                        </div>
                        {!d.savedId && (
                          <div className="flex flex-none flex-col gap-1">
                            {!e.excluded && (
                              <button
                                type="button"
                                onClick={() => toggleEdit(key)}
                                aria-pressed={isEditing}
                                className={`u-btn ${isEditing ? "u-btn-primary" : "u-btn-secondary"} px-3 py-1.5 text-meta-chip`}
                              >
                                {isEditing ? "접기" : "✏️ 고치기"}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => patchEntry(di, ei, { excluded: !e.excluded })}
                              aria-pressed={e.excluded}
                              className={`u-btn px-3 py-1.5 text-meta-chip ${e.excluded ? "u-btn-primary" : "u-btn-secondary"}`}
                            >
                              {e.excluded ? "↩️ 되살리기" : "🗑 빼기"}
                            </button>
                          </div>
                        )}
                      </div>
                      {(e.partial || e.confidence === "low" || hasProblem) && !e.excluded && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {dupFirst !== undefined && (
                            <span className="u-chip max-w-full whitespace-normal border-danger text-danger">
                              🔁 위와 같은 표현({entryLabel(d.entries[dupFirst], dupFirst)}) — 하나만 남겨요
                            </span>
                          )}
                          {blankMeaning && <span className="u-chip max-w-full whitespace-normal border-danger text-danger">✏️ 뜻을 채워 주세요</span>}
                          {e.partial && <span className="u-chip border-danger text-danger">✂️ 사진 밖으로 잘렸어요</span>}
                          {e.confidence === "low" && <span className="u-chip border-danger text-danger">🌫 흐릿하게 읽혔어요</span>}
                        </div>
                      )}
                      {!isEditing && !e.excluded && e.example && (
                        <p className="t-vocab-example mt-2" lang="en">
                          {e.example}
                          {e.exampleKo && (
                            <span className="block text-ink-3" lang="ko">
                              {e.exampleKo}
                            </span>
                          )}
                        </p>
                      )}
                      {isEditing && (
                        <div className="mt-3 flex flex-col gap-2">
                          <label className="block">
                            <span className="t-meta-chip">표현 (영어)</span>
                            <input
                              type="text"
                              lang="en"
                              value={e.expression}
                              maxLength={limits.expression}
                              onChange={(ev) => patchEntry(di, ei, { expression: ev.target.value })}
                              className={inputCls}
                            />
                          </label>
                          <label className="block">
                            <span className="t-meta-chip">뜻 (한국어)</span>
                            <input
                              type="text"
                              value={e.meaningKo}
                              maxLength={limits.meaningKo}
                              onChange={(ev) => patchEntry(di, ei, { meaningKo: ev.target.value })}
                              className={inputCls}
                            />
                          </label>
                          <label className="block">
                            <span className="t-meta-chip">예문 (영어, 없으면 비워 두기)</span>
                            <textarea
                              lang="en"
                              value={e.example ?? ""}
                              maxLength={limits.example}
                              rows={2}
                              onChange={(ev) => patchEntry(di, ei, { example: ev.target.value })}
                              className={inputCls}
                            />
                          </label>
                          <label className="block">
                            <span className="t-meta-chip">예문 해석</span>
                            <textarea
                              value={e.exampleKo ?? ""}
                              maxLength={limits.example}
                              rows={2}
                              disabled={!e.example || e.example.trim() === ""}
                              onChange={(ev) => patchEntry(di, ei, { exampleKo: ev.target.value })}
                              className={inputCls}
                            />
                          </label>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* 교재 QUIZ */}
              {d.quiz.length > 0 && (
                <>
                  <p className="t-meta-chip mt-4">교재 QUIZ</p>
                  <ul className="mt-2 flex flex-col gap-2">
                    {d.quiz.map((q, qi) => {
                      const key = `${di}:q:${qi}`;
                      const isEditing = editing.has(key) && !q.excluded && !d.savedId;
                      return (
                        <li
                          key={qi}
                          className={`rounded-[var(--radius-box)] border p-3 ${q.excluded ? "border-dashed border-line opacity-55" : "border-line"}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="t-question-ko text-ink">
                                {q.no !== null && <span className="t-meta-chip mr-1 tabular-nums">Q{q.no}</span>}
                                {q.promptKo}
                                {q.hint && <span className="u-chip ml-1">{q.hint}</span>}
                              </p>
                              {!isEditing && (
                                <p className="t-vocab-example mt-1" lang="en">
                                  {q.modelAnswer}
                                </p>
                              )}
                            </div>
                            {!d.savedId && (
                              <div className="flex flex-none flex-col gap-1">
                                {!q.excluded && (
                                  <button
                                    type="button"
                                    onClick={() => toggleEdit(key)}
                                    aria-pressed={isEditing}
                                    className={`u-btn ${isEditing ? "u-btn-primary" : "u-btn-secondary"} px-3 py-1.5 text-meta-chip`}
                                  >
                                    {isEditing ? "접기" : "✏️ 고치기"}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => patchQuiz(di, qi, { excluded: !q.excluded })}
                                  aria-pressed={q.excluded}
                                  className={`u-btn px-3 py-1.5 text-meta-chip ${q.excluded ? "u-btn-primary" : "u-btn-secondary"}`}
                                >
                                  {q.excluded ? "↩️ 되살리기" : "🗑 빼기"}
                                </button>
                              </div>
                            )}
                          </div>
                          {isEditing && (
                            <div className="mt-3 flex flex-col gap-2">
                              <label className="block">
                                <span className="t-meta-chip">우리말 문장</span>
                                <textarea value={q.promptKo} rows={2} onChange={(ev) => patchQuiz(di, qi, { promptKo: ev.target.value })} className={inputCls} />
                              </label>
                              <label className="block">
                                <span className="t-meta-chip">힌트 (없으면 비워 두기)</span>
                                <input
                                  type="text"
                                  value={q.hint ?? ""}
                                  maxLength={limits.hint}
                                  onChange={(ev) => patchQuiz(di, qi, { hint: ev.target.value })}
                                  className={inputCls}
                                />
                              </label>
                              <label className="block">
                                <span className="t-meta-chip">모범답변 (영어)</span>
                                <textarea
                                  lang="en"
                                  value={q.modelAnswer}
                                  maxLength={limits.example}
                                  rows={2}
                                  onChange={(ev) => patchQuiz(di, qi, { modelAnswer: ev.target.value })}
                                  className={inputCls}
                                />
                              </label>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              {d.errorKo && (
                <div role="alert" className="mt-3 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3">
                  <p className="t-question-ko text-danger">{d.errorKo}</p>
                  {d.issues.length > 0 && (
                    <ul className="t-caption mt-2 list-disc pl-5">
                      {d.issues.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          );
        })}

        {errorKo && (
          <p role="alert" className="t-question-ko mt-4 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3 text-danger">
            {errorKo}
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          <button type="button" onClick={saveAll} disabled={savable.length === 0} className="u-btn u-btn-primary flex-1">
            <span aria-hidden>💾</span> 표현집 {savable.length}개 저장하기
          </button>
          <button type="button" onClick={resetToPick} className="u-btn u-btn-secondary flex-none">
            <span aria-hidden>↩️</span> 처음부터
          </button>
        </div>
        {blockedCount > 0 && (
          <p className="t-caption mt-2 text-center text-danger">고칠 곳이 남은 묶음 {blockedCount}개는 저장에서 빠져요 — 위의 빨간 표시를 확인해 주세요.</p>
        )}
        {savable.length === 0 && alreadySaved.length === 0 && blockedCount === 0 && (
          <p className="t-caption mt-2 text-center">저장할 묶음이 없어요. 표현을 하나 이상 남긴 묶음을 골라 주세요.</p>
        )}
        {alreadySaved.length > 0 && savable.length === 0 && (
          <p className="t-caption mt-2 text-center">
            <Link href={alreadySaved.length === 1 ? `/toeic/sets/${alreadySaved[0].savedId}` : "/toeic/sets"} className="text-accent underline">
              저장한 표현집 보기
            </Link>
          </p>
        )}
      </div>
    );
  }

  // phase === "pick"
  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          enqueueForCrop(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="u-box">
        <p className="t-section-title">📷 표현 암기장 페이지를 찍어요</p>
        <p className="t-caption mt-2">
          한 페이지를 여러 장으로 나눠 찍어도 돼요. DAY 번호가 같은 사진은 한 표현집으로, 겹쳐 찍은 표현은 번호로 합쳐 드려요. 여러 DAY를
          한 번에 찍으면 DAY마다 따로 만들어요. 최대 {limits.photos}장.
        </p>

        {previews.length > 0 && (
          <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {previews.map((url, i) => (
              <li key={url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 object URL 미리보기 */}
                <img src={url} alt={`고른 사진 ${i + 1}`} className="aspect-square w-full rounded-[var(--radius-box)] border border-line object-cover" />
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  aria-label={`사진 ${i + 1} 빼기`}
                  className="t-meta-chip absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-bg text-ink shadow-sm"
                >
                  ✕
                </button>
                <button
                  type="button"
                  onClick={() => setCropIndex(i)}
                  aria-label={`사진 ${i + 1} 자르기`}
                  className="t-meta-chip absolute bottom-1 left-1 flex items-center gap-1 rounded-full border border-line bg-bg px-2 py-1 text-ink shadow-sm"
                >
                  ✂️ 자르기
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => fileInputRef.current?.click()} className="u-btn u-btn-secondary flex-1">
            <span aria-hidden>➕</span> {previews.length === 0 ? "사진 고르기" : `사진 더 넣기 (${previews.length}/${limits.photos})`}
          </button>
          {previews.length > 0 && (
            <button type="button" onClick={readAll} className="u-btn u-btn-primary flex-1">
              <span aria-hidden>📖</span> {previews.length}장 판독하기
            </button>
          )}
        </div>
      </div>

      {retakeKo && (
        <p role="status" className="u-box-accent t-question-ko mt-4 text-ink">
          📷 {retakeKo}
        </p>
      )}
      {errorKo && (
        <div role="alert" className="mt-4 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3">
          <p className="t-question-ko text-danger">{errorKo}</p>
          {errorHintKo && <p className="t-caption mt-2">{errorHintKo}</p>}
          {issues.length > 0 && (
            <ul className="t-caption mt-2 list-disc pl-5">
              {issues.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          )}
          {canRetry && (
            <button type="button" onClick={readAll} className="u-btn u-btn-secondary mt-3">
              <span aria-hidden>🔄</span> 다시 읽기
            </button>
          )}
        </div>
      )}

      <p className="t-caption mt-6 text-center">
        가져오기 파일이 있으면{" "}
        <Link href="/toeic/sets" className="text-accent underline">
          목록의 &lsquo;파일로 가져오기&rsquo;
        </Link>
        로 넣을 수 있어요.
      </p>

      {cropQueue[0] ? (
        <ImageCropper
          file={cropQueue[0]}
          onDone={(result) => {
            appendCroppedFile(result);
            setCropQueue((q) => q.slice(1));
          }}
          onCancel={() => setCropQueue((q) => q.slice(1))}
        />
      ) : cropIndex != null && files[cropIndex] ? (
        <ImageCropper
          file={files[cropIndex]}
          onDone={(result) => {
            replaceFile(cropIndex, result);
            setCropIndex(null);
          }}
          onCancel={() => setCropIndex(null)}
        />
      ) : null}
    </div>
  );
}
