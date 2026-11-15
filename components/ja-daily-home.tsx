"use client";

/**
 * components/ja-daily-home.tsx — 🗓️ 오늘의 일본어 홈 `/japanese/daily`(설계 §5).
 *
 * `GET /api/japanese/daily` 하나로 그린다: 오늘 회차 시작 · 진행률 · 과정표(끝낸 칸 = 다시 하기) · 원음 상태(이 기기) · 가져오기 둘
 * (내용 파일 → `POST /api/japanese/daily/import` / 원음 묶음 jpack → lib/ja-audio-store 기기 저장 — 서버로 보내지 않는다) · 모의 2회 실전 점수.
 * 내용이 하나도 없으면 가져오기 안내만. "오늘 완료"는 서버의 `doneTodayN`(lib/ja-daily-streak `jaDailyDoneTodayN` — 스트릭과 같은 판정).
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JaDailyImportResponse, JaDailyIndexOk, JaDailyIndexResponse, JaDailyMockScore, JaDailySessionResponse } from "@/lib/ja-daily-contract";
import { importJaAudioPack, listJaAudioKeys, requestJaAudioPersist } from "@/lib/ja-audio-store";
import { jaDailySessionSummary } from "@/lib/ja-daily-quiz";

/** 내용 파일 상한(라우트와 같은 6MB — 클라이언트 사전 차단) */
const IMPORT_MAX_BYTES = 6 * 1024 * 1024;

const KIND_KO = { lesson: "회화 과", vocab: "단어 DAY", tip: "청해 요령", litem: "청해 문항", mock: "모의 회차" } as const;

function neededAudioKeys(ix: JaDailyIndexOk): string[] {
  const keys = new Set<string>();
  for (const l of ix.content.lessons) if (l.step === 1 || l.step === 2) for (const t of l.tracks) keys.add(t.audioKey);
  for (const t of ix.content.tips) keys.add(t.audioKey);
  for (const it of ix.content.litems) keys.add(it.audioKey);
  return [...keys];
}

function ContentImport({ onDone }: { onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(file: File) {
    setMsg(null);
    if (file.size > IMPORT_MAX_BYTES) {
      setMsg({ ok: false, text: "파일이 너무 커요(6MB까지)." });
      return;
    }
    let text: string;
    try {
      text = await file.text();
      JSON.parse(text);
    } catch {
      setMsg({ ok: false, text: "JSON 파일이 아니에요." });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/japanese/daily/import", { method: "POST", headers: { "content-type": "application/json" }, body: text });
      const body = (await res.json().catch(() => null)) as JaDailyImportResponse | null;
      if (body?.ok) {
        const parts = (Object.keys(KIND_KO) as (keyof typeof KIND_KO)[])
          .map((k) => {
            const c = body.result[k];
            return c.added + c.updated + c.unchanged > 0 ? `${KIND_KO[k]} 추가 ${c.added}·고침 ${c.updated}·그대로 ${c.unchanged}` : null;
          })
          .filter(Boolean);
        setMsg({ ok: true, text: parts.join(" / ") || "가져왔어요." });
        onDone();
      } else if (body && !body.ok) {
        const first = "issues" in body ? body.issues?.[0] : undefined;
        setMsg({ ok: false, text: first ? `${body.messageKo} (${first.path || "파일"}: ${first.message})` : body.messageKo });
      } else setMsg({ ok: false, text: "가져오지 못했어요. 잠시 뒤 다시 해 주세요." });
    } catch {
      setMsg({ ok: false, text: "네트워크 문제로 가져오지 못했어요." });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        data-testid="ja-daily-import-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(f);
        }}
      />
      <button type="button" className="u-btn u-btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? "가져오는 중…" : "📥 내용 파일 가져오기"}
      </button>
      {msg ? (
        <p role={msg.ok ? "status" : "alert"} className={`t-caption break-all ${msg.ok ? "text-ink-2" : "text-danger"}`} data-testid="ja-daily-import-msg">
          {msg.ok ? "✅ " : ""}
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}

function AudioImport({ onDone }: { onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const acRef = useRef<AbortController | null>(null);
  const [prog, setProg] = useState<{ saved: number; total: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [persist, setPersist] = useState<boolean | null | undefined>(undefined);
  useEffect(() => () => acRef.current?.abort(), []);
  async function run(file: File) {
    setMsg(null);
    const ac = new AbortController();
    acRef.current = ac;
    setProg({ saved: 0, total: 0 });
    // 어떤 실패에도 진행 막대를 거두고 버튼을 되살린다(QA daily-full P2-B) — 들어간 트랙은 보관소에 남는다
    try {
      const r = await importJaAudioPack(file, { signal: ac.signal, onProgress: (saved, total) => setProg({ saved, total }) });
      if (r.ok) setMsg({ ok: true, text: r.aborted ? `멈췄어요 — ${r.saved}/${r.total}트랙은 들어갔어요. 다시 가져오면 이어서 덮어써요.` : `원음 ${r.saved}트랙을 이 기기에 넣었어요.` });
      else setMsg({ ok: false, text: `${r.messageKo}${r.saved > 0 ? ` (${r.saved}/${r.total}트랙은 들어갔어요)` : ""} 아래 버튼으로 다시 가져오세요.` });
    } catch {
      setMsg({ ok: false, text: "가져오는 중 문제가 생겼어요 — 들어간 트랙은 남아 있어요. 아래 버튼으로 다시 가져오세요." });
    } finally {
      if (acRef.current === ac) acRef.current = null;
      setProg(null);
      onDone();
    }
  }
  const pct = prog && prog.total > 0 ? Math.round((prog.saved / prog.total) * 100) : 0;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <input
        ref={fileRef}
        type="file"
        accept=".jpack,application/octet-stream"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        data-testid="ja-daily-audio-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(f);
        }}
      />
      {prog ? (
        <div data-testid="ja-daily-audio-progress">
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between">
            <p className="t-caption text-ink-2" role="status">
              {prog.total > 0 ? `원음 넣는 중 ${prog.saved}/${prog.total} (${pct}%)` : "묶음 읽는 중…"}
            </p>
            <button type="button" className="t-caption text-ink-3 underline" onClick={() => acRef.current?.abort()}>
              멈추기
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="u-btn u-btn-secondary"
          onClick={() => {
            // 저장소 유지 요청은 탭 안에서 한 번(iOS가 지우지 않게 — 결과는 안내만)
            void requestJaAudioPersist().then(setPersist);
            fileRef.current?.click();
          }}
        >
          🎧 원음 묶음 가져오기(.jpack)
        </button>
      )}
      {msg ? (
        <p role={msg.ok ? "status" : "alert"} className={`t-caption ${msg.ok ? "text-ink-2" : "text-danger"}`} data-testid="ja-daily-audio-msg">
          {msg.text}
        </p>
      ) : null}
      {persist === false ? <p className="t-caption text-ink-3">이 기기가 보관 유지를 약속하지 않았어요 — 저장 공간이 부족하면 원음이 지워질 수 있어요(그때는 다시 가져오면 돼요).</p> : null}
      <p className="t-caption text-ink-3">원음은 이 기기에만 보관돼요(서버로 보내지 않아요). 다른 기기에선 합성 음성으로 들려요.</p>
    </div>
  );
}

function ScoreLine({ score }: { score: JaDailyMockScore }) {
  return (
    <p className="t-body">
      모의 {score.round}회 종합 <b>{score.total}</b>/180 · 언어지식·독해 {score.langReading.scaled}/120 · 청해 {score.listening.scaled}/60 ·{" "}
      <span className={score.pass ? "text-accent-ink" : "text-danger"}>{score.pass ? "합격권" : "아직 불합격권"}</span>
    </p>
  );
}

export default function JaDailyHome() {
  const [ix, setIx] = useState<JaDailyIndexOk | null | "error">(null);
  const [audioKeys, setAudioKeys] = useState<string[] | null>(null);
  const [score, setScore] = useState<JaDailyMockScore | null>(null);

  const reload = useCallback(() => {
    fetch("/api/japanese/daily", { cache: "no-store" })
      .then((r) => r.json() as Promise<JaDailyIndexResponse>)
      .then((b) => setIx(b.ok ? b : "error"))
      .catch(() => setIx("error"));
  }, []);
  const reloadAudio = useCallback(() => {
    void listJaAudioKeys().then(setAudioKeys);
  }, []);
  useEffect(() => {
    reload();
    reloadAudio();
  }, [reload, reloadAudio]);

  // 모의 실전 채점표 회차를 끝냈으면 그 점수를 읽는다(회차 내용 라우트가 계산한다)
  const scoreN = ix && ix !== "error" ? (ix.course.find((s) => s.exam.type === "mockScore")?.n ?? null) : null;
  const scoreDone = ix && ix !== "error" && scoreN !== null && ix.records.some((r) => !r.replay && r.n === scoreN);
  useEffect(() => {
    if (!scoreDone || scoreN === null) return;
    let alive = true;
    fetch(`/api/japanese/daily/session/${scoreN}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<JaDailySessionResponse>)
      .then((b) => {
        if (alive && b.ok && b.exam.type === "mockScore") setScore(b.exam.score);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [scoreDone, scoreN]);

  if (ix === null) return <p className="t-body text-ink-3">불러오는 중…</p>;
  if (ix === "error") return <p className="t-body text-danger">불러오지 못했어요. 잠시 뒤 다시 열어 주세요.</p>;

  const imports = (
    <section key="imports" className="u-card flex flex-col gap-4 p-4" data-testid="ja-daily-imports">
      <p className="t-section-title">📦 가져오기</p>
      <ContentImport onDone={reload} />
      <AudioImport onDone={reloadAudio} />
    </section>
  );

  // 가져오기 칸은 두 갈래 모두 같은 뿌리 div 아래 key="imports"로 둔다 — 내용이 생겨 갈래가 바뀌어도 다시 마운트되지 않아 결과 문구가 남는다
  if (!ix.hasContent) {
    return (
      <div className="flex flex-col gap-4">
        <div className="u-box" data-testid="ja-daily-empty">
          <p className="t-body">아직 내용이 없어요. 먼저 내용 파일(ja-daily/v1 JSON)을 가져오세요. 원음 묶음은 있으면 좋고, 없어도 합성 음성으로 끝까지 할 수 있어요.</p>
        </div>
        {imports}
      </div>
    );
  }

  const total = ix.course.length;
  const doneSet = new Set(ix.records.filter((r) => !r.replay).map((r) => r.n));
  const doneCount = Math.min(doneSet.size, total);
  const next = ix.next;
  const needed = neededAudioKeys(ix);
  const have = audioKeys ? new Set(audioKeys) : null;
  const haveNeeded = have ? needed.filter((k) => have.has(k)).length : null;
  const nextSession = next.session;

  // 진행 — 다음 회차 기준 회화 과·단어 DAY
  const kaiwaPos = nextSession && nextSession.kaiwa.type === "unit" ? ix.content.lessons.find((l) => l.id === (nextSession.kaiwa as { lessonId: string }).lessonId) : null;
  const vocabDay = nextSession && nextSession.vocab.type !== "weak" ? (nextSession.vocab as { day: number }).day : null;

  return (
    <div className="flex flex-col gap-4">
      <section className="u-card p-5" data-testid="ja-daily-today">
        {ix.doneTodayN !== null ? (
          <>
            <p className="t-list-title">오늘 완료 ✓</p>
            <p className="t-caption mt-1 text-ink-2">Day {ix.doneTodayN} 끝 — 내일 Day {next.n}</p>
            {nextSession ? (
              <Link href={`/japanese/daily/${next.n}`} className="u-btn u-btn-secondary mt-4 w-full" data-testid="ja-daily-start">
                Day {next.n} 미리 하기
              </Link>
            ) : null}
          </>
        ) : nextSession ? (
          <>
            <p className="t-caption text-ink-3">{next.courseDone ? "과정 완료 · 반복 모드" : "오늘 회차"}</p>
            <p className="t-body mt-1">{jaDailySessionSummary(nextSession, ix.content.lessons)}</p>
            <Link href={`/japanese/daily/${next.n}`} className="u-btn u-btn-primary mt-4 w-full" data-testid="ja-daily-start">
              ▶ Day {next.n} 시작
            </Link>
          </>
        ) : (
          <p className="t-body">과정 완료 🎉</p>
        )}
      </section>

      <section className="u-card p-4" data-testid="ja-daily-progress">
        <div className="flex items-baseline justify-between">
          <p className="t-section-title">진행</p>
          <p className="t-caption tabular-nums text-ink-2">
            {doneCount} / {total}회
          </p>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full bg-accent" style={{ width: `${total > 0 ? Math.round((doneCount / total) * 100) : 0}%` }} />
        </div>
        <p className="t-caption mt-2 text-ink-3">
          {kaiwaPos ? `회화 ${kaiwaPos.step}-${kaiwaPos.lesson}과` : "회화 다시 하기"} · {vocabDay !== null ? `단어 DAY ${vocabDay}/${ix.content.vocabDays.length}` : "약한 단어"} · 모의 {ix.content.mocks.length}회분
        </p>
        <div className="mt-3 grid grid-cols-10 gap-1" data-testid="ja-daily-grid">
          {ix.course.map((s) => {
            const done = doneSet.has(s.n);
            const isNext = s.n === next.n;
            const cls = done ? "bg-accent text-white" : isNext ? "border-2 border-accent text-accent-ink" : "border border-line text-ink-3";
            const cell = <span className={`flex aspect-square items-center justify-center rounded text-[11px] tabular-nums ${cls}`}>{s.n}</span>;
            return done || isNext ? (
              <Link key={s.n} href={`/japanese/daily/${s.n}`} title={done ? `Day ${s.n} 다시 하기` : `Day ${s.n}`} aria-label={done ? `Day ${s.n} 다시 하기` : `Day ${s.n} 시작`}>
                {cell}
              </Link>
            ) : (
              <span key={s.n} aria-hidden>
                {cell}
              </span>
            );
          })}
        </div>
        <p className="t-caption mt-2 text-ink-3">채운 칸을 누르면 그 회차를 다시 해요(진도는 그대로).</p>
      </section>

      {score ? (
        <section className="u-card p-4" data-testid="ja-daily-mock-score">
          <p className="t-section-title mb-1">📝 실전 모의 점수</p>
          <ScoreLine score={score} />
        </section>
      ) : null}

      <section className="u-card p-4" data-testid="ja-daily-audio-status">
        <p className="t-section-title">🎧 원음</p>
        <p className="t-body mt-1">
          {audioKeys === null
            ? "확인 중…"
            : audioKeys.length === 0
              ? "이 기기에 원음이 없어요 — 합성 음성으로 들려요."
              : `원음 ${audioKeys.length}트랙 · 이 기기${haveNeeded !== null && needed.length > 0 ? ` (회화·청해 ${haveNeeded}/${needed.length})` : ""}`}
        </p>
      </section>

      {imports}
    </div>
  );
}
