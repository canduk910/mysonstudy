"use client";

/**
 * 대화 복습 만들기 흐름 (아빠의 일본어 J3·J4, §8) — 클라이언트.
 *
 * 스크린샷 **여러 장** → (한 장씩 자르기) → 전사(호출 B, 병렬·병합) → **검토**(합쳐진 대화·partial·allUnknown 사실 보고)
 * → 해설(호출 C, best-effort) → 제목 정해 저장. **해설이 실패해도 전사는 저장**(§7-2). 이미지 리사이즈는 공유 파이프(resizeToJpegDataUrl).
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ImageCropper from "@/components/image-cropper";
import JaDialogTranscript from "@/components/ja-dialog-transcript";
import JaDialogCoachingView from "@/components/ja-dialog-coaching-view";
import { resizeToJpegDataUrl } from "@/lib/image-resize";
import { JA_DIALOG_TITLE_MAX } from "@/lib/japanese-dialog-contract";
import type {
  JaDialogCoaching,
  JaDialogCoachResponse,
  JaDialogExtractResponse,
  JaDialogSaveResponse,
  JaDialogTurn,
} from "@/lib/japanese-dialog-contract";
import s from "./ja-dialog-new-flow.module.css";

type Phase = "pick" | "reading" | "review" | "saving";

export default function JaDialogNewFlow() {
  const router = useRouter();
  const runningRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("pick");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [cropQueue, setCropQueue] = useState<File[]>([]);
  const [cropIndex, setCropIndex] = useState<number | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  // 전사 결과
  const [turns, setTurns] = useState<JaDialogTurn[]>([]);
  const [focusKo, setFocusKo] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [allUnknown, setAllUnknown] = useState(false);
  const [mergedCount, setMergedCount] = useState(0);
  const [model, setModel] = useState("");
  const [photoCount, setPhotoCount] = useState(0);

  // 해설
  const [coaching, setCoaching] = useState<JaDialogCoaching | null>(null);
  const [coachPhase, setCoachPhase] = useState<"idle" | "loading" | "error">("idle");
  const [coachMsg, setCoachMsg] = useState<string | null>(null);
  const [title, setTitle] = useState("");

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // 같은 파일 재선택 허용
    if (picked.length > 0) {
      setErrorKo(null);
      setCropQueue((q) => [...q, ...picked]); // 한 장씩 자르기 큐로
    }
  }
  function appendCropped(next: File) {
    const url = URL.createObjectURL(next);
    setFiles((prev) => [...prev, next]);
    setPreviews((prev) => [...prev, url]);
  }
  function removeFile(i: number) {
    setPreviews((prev) => {
      const url = prev[i];
      if (url) URL.revokeObjectURL(url);
      return prev.filter((_, k) => k !== i);
    });
    setFiles((prev) => prev.filter((_, k) => k !== i));
  }
  function replaceFile(i: number, next: File) {
    setPreviews((prev) => {
      const url = prev[i];
      if (url) URL.revokeObjectURL(url);
      return prev.map((u, k) => (k === i ? URL.createObjectURL(next) : u));
    });
    setFiles((prev) => prev.map((f, k) => (k === i ? next : f)));
  }

  async function readAll() {
    if (runningRef.current || files.length === 0) return;
    runningRef.current = true;
    setErrorKo(null);
    setPhase("reading");
    try {
      const images = await Promise.all(files.map((f) => resizeToJpegDataUrl(f)));
      const res = await fetch("/api/japanese/dialog/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const data = (await res.json().catch(() => null)) as JaDialogExtractResponse | null;
      if (data?.ok) {
        setTurns(data.turns);
        setFocusKo(data.focusKo);
        setPartial(data.partial);
        setAllUnknown(data.allUnknown);
        setMergedCount(data.mergedCount);
        setModel(data.model);
        setPhotoCount(files.length);
        setTitle(data.focusKo ?? "");
        setCoaching(null);
        setCoachPhase("idle");
        setCoachMsg(null);
        setPhase("review");
      } else {
        setErrorKo(data && !data.ok ? data.messageKo : "대화를 읽지 못했어요. 잠시 후 다시 시도해 주세요.");
        setPhase("pick");
      }
    } catch {
      setErrorKo("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
      setPhase("pick");
    } finally {
      runningRef.current = false;
    }
  }

  async function makeCoaching() {
    if (coachPhase === "loading") return;
    setCoachPhase("loading");
    setCoachMsg(null);
    try {
      const res = await fetch("/api/japanese/dialog/coach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ focusKo, turns }),
      });
      const data = (await res.json()) as JaDialogCoachResponse;
      if (data.ok) {
        setCoaching(data.coaching);
        setCoachPhase("idle");
      } else {
        setCoachPhase("error");
        setCoachMsg(
          data.error === "no_api_key"
            ? "API 키가 준비되면 해설을 만들 수 있어요. 전사는 저장할 수 있어요."
            : `${data.messageKo} 전사는 저장 후 "해설 다시 만들기"로 채울 수 있어요.`,
        );
      }
    } catch {
      setCoachPhase("error");
      setCoachMsg("해설을 만들지 못했어요. 전사는 저장할 수 있어요.");
    }
  }

  async function save() {
    if (phase === "saving") return;
    const t = title.trim();
    if (t === "") {
      setErrorKo("대화 이름을 입력해 주세요.");
      return;
    }
    setPhase("saving");
    setErrorKo(null);
    try {
      const res = await fetch("/api/japanese/dialog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titleKo: t, focusKo, turns, coaching, photoCount, partial, model }),
      });
      const data = (await res.json()) as JaDialogSaveResponse;
      if (data.ok) router.push(`/japanese/dialog/${data.id}`);
      else {
        setErrorKo(data.messageKo);
        setPhase("review");
      }
    } catch {
      setErrorKo("저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
      setPhase("review");
    }
  }

  // ── 검토/해설/저장 ──────────────────────────────────────────────────────────
  if (phase === "review" || phase === "saving") {
    return (
      <div className={s.wrap}>
        <h2 className="t-section-title">읽은 대화를 확인해요</h2>
        {partial && <p role="alert" className={s.warn}>⚠️ 일부만 읽혔어요(사진이 잘렸거나 일부 실패). 빠진 부분이 있을 수 있어요.</p>}
        {allUnknown && <p role="alert" className={s.warn}>⚠️ 화자(나/상대)를 구분하지 못했어요. 말풍선 방향이 맞는지 확인해 주세요.</p>}
        {mergedCount > 0 && <p role="status" className={s.note}>사진 경계에서 겹친 발화 {mergedCount}개를 합쳤어요.</p>}

        {turns.length === 0 ? (
          <p className={s.empty}>읽어낸 대화가 없어요. 다시 시도해 주세요.</p>
        ) : (
          <>
            <JaDialogTranscript turns={turns} />

            {/* 해설(호출 C, best-effort) */}
            <section className={s.coachBox}>
              {coaching ? (
                <>
                  <p className="t-caption">해설을 만들었어요.</p>
                  <JaDialogCoachingView coaching={coaching} />
                  <button type="button" className="u-btn u-btn-secondary" onClick={makeCoaching} disabled={coachPhase === "loading"}>
                    {coachPhase === "loading" ? "다시 만드는 중…" : "🔁 해설 다시 만들기"}
                  </button>
                </>
              ) : (
                <div className={s.coachIdle}>
                  <p className="t-lead">잘한 점·고칠 점·어휘·연습 해설을 만들어 볼까요? (없이 저장해도 나중에 만들 수 있어요)</p>
                  <button type="button" className="u-btn u-btn-primary" onClick={makeCoaching} disabled={coachPhase === "loading"}>
                    {coachPhase === "loading" ? "만드는 중…" : "✨ 해설 만들기"}
                  </button>
                  {coachMsg && <p className={`t-caption ${coachPhase === "error" ? s.err : ""}`}>{coachMsg}</p>}
                </div>
              )}
            </section>

            <label className={s.titleLabel} htmlFor="ja-dialog-title">대화 이름</label>
            <input
              id="ja-dialog-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={JA_DIALOG_TITLE_MAX}
              placeholder="예: 호텔 체크인 대화"
              className={s.titleInput}
            />
          </>
        )}

        {errorKo && <p role="alert" className={s.err}>{errorKo}</p>}

        <div className={s.actions}>
          {turns.length > 0 && (
            <button type="button" className="u-btn u-btn-primary" onClick={save} disabled={phase === "saving"}>
              {phase === "saving" ? "저장 중…" : "이 대화 저장"}
            </button>
          )}
          <button
            type="button"
            className="u-btn u-btn-secondary"
            onClick={() => {
              setPhase("pick");
              setErrorKo(null);
            }}
            disabled={phase === "saving"}
          >
            <span aria-hidden>↩</span> 사진 다시 고르기
          </button>
        </div>
      </div>
    );
  }

  // ── 사진 고르기 ──────────────────────────────────────────────────────────────
  return (
    <div className={s.wrap}>
      <p className="t-lead">듀오링고 대화 스크린샷을 순서대로 올려 주세요. 여러 장이면 한 대화로 합쳐요.</p>

      <label className={`u-btn u-btn-primary ${s.pickBtn}`}>
        <span aria-hidden>📷</span> 스크린샷 고르기
        <input type="file" accept="image/*" multiple onChange={onPick} className="sr-only" />
      </label>

      {files.length > 0 && (
        <>
          <ul className={s.thumbs}>
            {files.map((_, i) => (
              <li key={i} className={s.thumb}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previews[i]} alt={`사진 ${i + 1}`} className={s.thumbImg} />
                <div className={s.thumbBtns}>
                  <button type="button" className={s.thumbBtn} onClick={() => setCropIndex(i)}>
                    ✂️ 자르기
                  </button>
                  <button type="button" className={s.thumbBtn} onClick={() => removeFile(i)}>
                    🗑 빼기
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className={s.actions}>
            <button type="button" className="u-btn u-btn-primary" onClick={readAll} disabled={phase === "reading"}>
              {phase === "reading" ? (
                <>
                  <span aria-hidden>⏳</span> 읽는 중… (여러 장이면 조금 걸려요)
                </>
              ) : (
                <>
                  <span aria-hidden>📝</span> 전사하기 ({files.length}장)
                </>
              )}
            </button>
          </div>
        </>
      )}

      {errorKo && <p role="alert" className={s.err}>{errorKo}</p>}

      {/* 자르기 모달 — 큐 우선(새 사진), 그다음 다시 자르기 */}
      {cropQueue[0] ? (
        <ImageCropper
          file={cropQueue[0]}
          onDone={(result) => {
            appendCropped(result);
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
