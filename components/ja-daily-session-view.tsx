"use client";

/**
 * components/ja-daily-session-view.tsx — 🗓️ 오늘의 일본어 **회차 화면** `/japanese/daily/[n]`(설계 §4).
 *
 * `GET /api/japanese/daily/session/[n]`로 칸별 내용을 받아 네 칸(🗣️ 회화 · 📚 단어 · 📝 시험 대비 · 🔁 복습)을 순서대로 연다.
 * 칸마다 "건너뛰기"(그 칸은 skipped). 마지막 칸을 넘기면 `POST /api/japanese/daily/sessions`(클라이언트 id 멱등 — 재시도는 같은 본문)로
 * 저장하고 결과(🔥·내일 미리보기)를 보인다. **중간에 나가면 기록 없음**(엄마 레슨 선례 — 끝까지 한 회차만 저장).
 * 끝낸 회차를 다시 열면 replay:true(기록은 남고 진도는 그대로).
 *
 * 복습 칸: 일본어 오늘의 복습 남은 수(`GET /api/review/japanese`). 0이면 자동 ✓. "복습하러 가기"는 이 회차를 먼저 저장(복습 done)하고 이동한다
 * — 이 화면을 떠나면 진행이 사라지기 때문이다.
 * 원음 URL은 이 화면 한 곳에서 모아 만든다(useJaAudioUrls — 언마운트 때 revoke).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JaDailyExam, { type JaDailyExamAnswer } from "@/components/ja-daily-exam";
import JaDailyKaiwa from "@/components/ja-daily-kaiwa";
import { pauseAllMedia, useJaAudioUrls } from "@/components/ja-daily-media";
import JaDailyVocab from "@/components/ja-daily-vocab";
import type { JaDailyIndexResponse, JaDailyKaiwaCheck, JaDailyMockItemView, JaDailySaveResponse, JaDailySessionOk, JaDailySessionRecord, JaDailySessionResponse } from "@/lib/ja-daily-contract";
import { jaDailyExamLabel, jaDailyKaiwaLabel, jaDailySessionSummary, jaDailyVocabLabel } from "@/lib/ja-daily-quiz";
import type { ReviewQueueResponse } from "@/lib/review-contract";
import { stopSpeaking } from "@/lib/speech";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";

type StepKey = "kaiwa" | "vocab" | "exam" | "review";
const STEPS: StepKey[] = ["kaiwa", "vocab", "exam", "review"];
const STEP_TITLE: Record<StepKey, string> = { kaiwa: "🗣️ 회화", vocab: "📚 N5 단어", exam: "📝 시험 대비", review: "🔁 복습" };

function newClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 보안 컨텍스트 밖(http LAN) — 아래로 */
  }
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** 회차 안 원음 키 전부(트랙·요령·청해·모의 청해) */
function audioKeysOf(d: JaDailySessionOk): string[] {
  const keys: string[] = [];
  if (d.kaiwa.type === "unit") keys.push(...d.kaiwa.tracks.map((t) => t.audioKey));
  const e = d.exam;
  if (e.type === "tip") keys.push(e.tip.audioKey, ...e.examples.map((x) => x.audioKey));
  else if (e.type === "litems") keys.push(...e.items.map((x) => x.audioKey));
  else if (e.type === "weakItems" || e.type === "final") keys.push(...e.litems.map((x) => x.audioKey), ...e.mockItems.flatMap((v) => (v.item.audioKey ? [v.item.audioKey] : [])));
  else if (e.type !== "empty" && "items" in e) keys.push(...(e.items as JaDailyMockItemView[]).flatMap((v) => (v.item.audioKey ? [v.item.audioKey] : [])));
  return keys;
}

type Load = { kind: "loading" } | { kind: "ok"; data: JaDailySessionOk } | { kind: "error"; messageKo: string; nextN: number | null };
type Save = "idle" | "saving" | "saved" | "error";

export default function JaDailySessionView({ n }: { n: number }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [stepIdx, setStepIdx] = useState(0);
  const [steps, setSteps] = useState<Partial<Record<StepKey, "done" | "skipped">>>({});
  const checksRef = useRef<JaDailyKaiwaCheck[]>([]);
  const vocabRef = useRef<JaDailySessionRecord["vocabAnswers"]>([]);
  const examRef = useRef<JaDailyExamAnswer[]>([]);
  const idRef = useRef("");
  const startedAtRef = useRef("");
  const recordRef = useRef<JaDailySessionRecord | null>(null);
  const [save, setSave] = useState<Save>("idle");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [review, setReview] = useState<{ count: number } | null | "error">(null);
  const [nextPreview, setNextPreview] = useState<string | null>(null);

  useEffect(() => {
    idRef.current = newClientId();
    startedAtRef.current = new Date().toISOString();
    let alive = true;
    fetch(`/api/japanese/daily/session/${n}`, { cache: "no-store" })
      .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as JaDailySessionResponse | null }))
      .then(({ body }) => {
        if (!alive) return;
        if (body?.ok) setLoad({ kind: "ok", data: body });
        else setLoad({ kind: "error", messageKo: body?.messageKo ?? "불러오지 못했어요.", nextN: body && !body.ok && typeof body.nextN === "number" ? body.nextN : null });
      })
      .catch(() => alive && setLoad({ kind: "error", messageKo: "네트워크 문제로 불러오지 못했어요.", nextN: null }));
    return () => {
      alive = false;
    };
  }, [n]);

  // 화면을 떠나면 소리를 멈춘다
  useEffect(
    () => () => {
      stopSpeaking();
      pauseAllMedia();
    },
    [],
  );

  const data = load.kind === "ok" ? load.data : null;
  const keySig = data ? audioKeysOf(data) : [];
  const urls = useJaAudioUrls(keySig);
  const step: StepKey | "done" = stepIdx < STEPS.length ? STEPS[stepIdx] : "done";

  // 복습 칸에 들어서면 남은 수를 읽는다 — 0이면 자동 ✓
  useEffect(() => {
    if (step !== "review") return;
    let alive = true;
    fetch("/api/review/japanese", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ReviewQueueResponse>) : null))
      .then((b) => {
        if (!alive) return;
        setReview(b && b.ok ? { count: b.cards.length } : "error");
      })
      .catch(() => alive && setReview("error"));
    return () => {
      alive = false;
    };
  }, [step]);

  const buildRecord = useCallback(
    (st: Record<StepKey, "done" | "skipped">): JaDailySessionRecord => {
      if (recordRef.current) return recordRef.current; // 재시도는 같은 본문(같은 id·같은 내용 → reused)
      const rec: JaDailySessionRecord = {
        id: idRef.current || newClientId(),
        n,
        replay: data?.replay ?? false,
        startedAt: startedAtRef.current || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        steps: st,
        kaiwaChecks: checksRef.current.slice(0, 40),
        vocabAnswers: vocabRef.current.slice(0, 80),
        examAnswers: examRef.current.slice(0, 120),
      };
      recordRef.current = rec;
      return rec;
    },
    [n, data],
  );

  const doSave = useCallback(
    async (rec: JaDailySessionRecord): Promise<boolean> => {
      setSave("saving");
      setSaveMsg(null);
      try {
        const res = await fetch("/api/japanese/daily/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rec) });
        const body = (await res.json().catch(() => null)) as JaDailySaveResponse | null;
        if (body?.ok) {
          setSave("saved");
          window.dispatchEvent(new Event(STREAK_REFRESH_EVENT));
          // 내일 미리보기
          fetch("/api/japanese/daily", { cache: "no-store" })
            .then((r) => r.json() as Promise<JaDailyIndexResponse>)
            .then((ix) => {
              if (!ix.ok) return;
              if (ix.next.courseDone && ix.next.session === null) setNextPreview("과정 완료 🎉");
              else if (ix.next.session) setNextPreview(jaDailySessionSummary(ix.next.session, ix.content.lessons));
            })
            .catch(() => undefined);
          return true;
        }
        setSave("error");
        if (res.status === 409 && body && !body.ok && body.error === "id_conflict") {
          // 같은 id로 다른 본문이 이미 있다 — 같은 본문을 다시 보내면 409만 되풀이하므로 새 id로 바꿔 둔다(QA daily-full P3-4)
          recordRef.current = { ...rec, id: newClientId() };
          setSaveMsg("같은 기록 번호가 이미 있어요 — 다시 저장을 누르면 새 기록으로 저장해요.");
          return false;
        }
        setSaveMsg(body && !body.ok ? body.messageKo : "저장하지 못했어요.");
        return false;
      } catch {
        setSave("error");
        setSaveMsg("네트워크 문제로 저장하지 못했어요.");
        return false;
      }
    },
    [],
  );

  const finishStep = useCallback(
    (key: StepKey, state: "done" | "skipped", opts: { thenGo?: string } = {}) => {
      stopSpeaking();
      pauseAllMedia();
      const next = { ...steps, [key]: state };
      setSteps(next);
      const idx = STEPS.indexOf(key) + 1;
      setStepIdx(idx);
      window.scrollTo({ top: 0 });
      if (idx >= STEPS.length) {
        const full = { kaiwa: next.kaiwa ?? "skipped", vocab: next.vocab ?? "skipped", exam: next.exam ?? "skipped", review: next.review ?? "skipped" } as Record<StepKey, "done" | "skipped">;
        void doSave(buildRecord(full)).then((ok) => {
          if (ok && opts.thenGo) router.push(opts.thenGo);
        });
      }
    },
    [steps, doSave, buildRecord, router],
  );

  const summary = useMemo(() => {
    const acc = checksRef.current.map((c) => c.accuracy).filter((a): a is number => a !== null);
    const graded = examRef.current.filter((a) => a.correct !== null);
    return {
      checks: checksRef.current.length,
      avg: acc.length > 0 ? Math.round((acc.reduce((s, a) => s + a, 0) / acc.length) * 100) : null,
      vocab: { r: vocabRef.current.filter((a) => a.correct).length, t: vocabRef.current.length },
      exam: { r: graded.filter((a) => a.correct).length, t: graded.length },
    };
    // 결과 화면에 들어설 때 한 번 계산
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step === "done"]);

  if (load.kind === "loading") return <p className="t-body text-ink-3">불러오는 중…</p>;
  if (load.kind === "error") {
    return (
      <div className="u-card p-5" data-testid="ja-daily-session-error">
        <p className="t-body">{load.messageKo}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {load.nextN !== null ? (
            <Link href={`/japanese/daily/${load.nextN}`} className="u-btn u-btn-primary">
              Day {load.nextN} 하러 가기
            </Link>
          ) : null}
          <Link href="/japanese/daily" className="u-btn u-btn-secondary">
            오늘의 일본어 홈
          </Link>
        </div>
      </div>
    );
  }
  const d = load.data;
  const s = d.session;
  const dayTitle = s.phase === "repeat" ? `Day ${d.n} · 반복` : `Day ${d.n} / ${d.total}`;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <div className="flex items-center justify-between gap-2">
          <h1 className="t-book-title">🗓️ {dayTitle}</h1>
          <div className="flex gap-1" aria-label="진행">
            {STEPS.map((k, i) => (
              <span
                key={k}
                title={STEP_TITLE[k]}
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs ${steps[k] === "done" ? "bg-accent text-white" : steps[k] === "skipped" ? "bg-line text-ink-3" : i === stepIdx ? "border-2 border-accent" : "border border-line"}`}
              >
                {steps[k] === "done" ? "✓" : steps[k] === "skipped" ? "–" : i + 1}
              </span>
            ))}
          </div>
        </div>
        <p className="t-caption mt-1 text-ink-3">
          {d.kaiwa.type === "unit" ? (d.kaiwa.review ? `약한 과 다시 · ${d.kaiwa.lesson.titleKo}` : `회화 ${d.kaiwa.lesson.step}-${d.kaiwa.lesson.lesson}과 ${d.kaiwa.lesson.titleKo}`) : jaDailyKaiwaLabel(s.kaiwa, [])} · {jaDailyVocabLabel(s.vocab)} · {jaDailyExamLabel(s.exam)} · 약 {s.minutesHint}분
        </p>
        {d.replay ? <p className="u-box mt-2 t-caption">🔁 다시 하기 — 기록은 남고 진도는 그대로예요.</p> : null}
      </header>

      {step !== "done" ? (
        <div className="flex items-center justify-between">
          <p className="t-section-title">
            {stepIdx + 1}/4 · {STEP_TITLE[step]}
          </p>
          <button type="button" className="t-caption text-ink-3 underline" onClick={() => finishStep(step, "skipped")} data-testid="ja-daily-skip-step">
            이 칸 건너뛰기
          </button>
        </div>
      ) : null}

      {step === "kaiwa" ? (
        d.kaiwa.type === "unit" ? (
          <JaDailyKaiwa
            key={`k${d.n}`}
            view={d.kaiwa}
            urls={urls}
            onDone={(checks) => {
              checksRef.current = checks;
              finishStep("kaiwa", "done");
            }}
          />
        ) : (
          <div className="u-card p-5">
            <p className="t-body">오늘은 회화 칸 내용이 없어요.</p>
            <button type="button" className="u-btn u-btn-primary mt-4" onClick={() => finishStep("kaiwa", "skipped")}>
              다음 →
            </button>
          </div>
        )
      ) : null}

      {step === "vocab" ? (
        <JaDailyVocab
          view={d.vocab}
          onDone={(answers) => {
            vocabRef.current = answers;
            finishStep("vocab", answers.length > 0 ? "done" : "skipped");
          }}
        />
      ) : null}

      {step === "exam" ? (
        <JaDailyExam
          view={d.exam}
          urls={urls}
          onDone={(answers) => {
            examRef.current = answers;
            finishStep("exam", d.exam.type === "empty" ? "skipped" : "done");
          }}
        />
      ) : null}

      {step === "review" ? (
        <section className="u-card p-5" data-testid="ja-daily-review">
          {review === null ? (
            <p className="t-body text-ink-3">오늘의 복습을 확인하는 중…</p>
          ) : review === "error" ? (
            <>
              <p className="t-body">오늘의 복습 수를 읽지 못했어요.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" className="u-btn u-btn-primary" onClick={() => finishStep("review", "done", { thenGo: "/japanese/review" })}>
                  끝내고 복습하러 가기
                </button>
                <button type="button" className="u-btn u-btn-secondary" onClick={() => finishStep("review", "skipped")}>
                  복습 없이 끝내기
                </button>
              </div>
            </>
          ) : review.count === 0 ? (
            <>
              <p className="t-body">✓ 오늘 일본어 복습은 남은 게 없어요.</p>
              <button type="button" className="u-btn u-btn-primary mt-4" onClick={() => finishStep("review", "done")} data-testid="ja-daily-finish">
                오늘 회차 끝내기 🔥
              </button>
            </>
          ) : (
            <>
              <p className="t-body">📅 오늘의 복습이 {review.count}개 남았어요. N5 단어는 처음 배운 다음 날부터 여기에 돌아와요.</p>
              <p className="t-caption mt-1 text-ink-3">복습하러 가면 이 회차를 먼저 저장해요.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" className="u-btn u-btn-primary" onClick={() => finishStep("review", "done", { thenGo: "/japanese/review" })} data-testid="ja-daily-go-review">
                  끝내고 복습하러 가기 →
                </button>
                <button type="button" className="u-btn u-btn-secondary" onClick={() => finishStep("review", "skipped")} data-testid="ja-daily-finish">
                  복습은 나중에 · 끝내기
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {step === "done" ? (
        <section className="u-card p-6 text-center" data-testid="ja-daily-result">
          <p className="text-5xl" aria-hidden>
            🔥
          </p>
          <p className="t-book-title mt-2">Day {d.n} 끝!</p>
          <ul className="mt-3 flex flex-col gap-1 t-body">
            <li>🗣️ 회화 {steps.kaiwa === "done" ? (summary.checks > 0 ? `🎤 ${summary.checks}문장${summary.avg !== null ? ` · 평균 ${summary.avg}%` : ""}` : "✓") : "건너뜀"}</li>
            <li>📚 단어 {steps.vocab === "done" ? `${summary.vocab.r}/${summary.vocab.t}` : "건너뜀"}</li>
            <li>📝 시험 대비 {steps.exam === "done" ? (summary.exam.t > 0 ? `${summary.exam.r}/${summary.exam.t}` : "✓") : "건너뜀"}</li>
            <li>🔁 복습 {steps.review === "done" ? "✓" : "건너뜀"}</li>
          </ul>
          <p className="t-caption mt-3" role="status" data-testid="ja-daily-save-state">
            {save === "saving" ? "저장하는 중…" : save === "saved" ? "✓ 저장했어요" : save === "error" ? saveMsg : ""}
          </p>
          {save === "error" && recordRef.current ? (
            <button type="button" className="u-btn u-btn-primary mt-2" onClick={() => recordRef.current && void doSave(recordRef.current)}>
              다시 저장
            </button>
          ) : null}
          {nextPreview ? (
            <div className="u-box mt-4 text-left" data-testid="ja-daily-tomorrow">
              <p className="t-caption text-ink-3">내일 할 것</p>
              <p className="t-body">{nextPreview}</p>
            </div>
          ) : null}
          <div className="mt-5 flex flex-col gap-2">
            {typeof review === "object" && review !== null && review.count > 0 ? (
              <Link href="/japanese/review" className="u-btn u-btn-primary">
                📅 오늘의 복습 {review.count}개
              </Link>
            ) : null}
            <Link href="/japanese/daily" className="u-btn u-btn-secondary">
              오늘의 일본어 홈
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}
