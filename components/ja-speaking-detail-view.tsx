"use client";

/**
 * 🎙️ 말하기 모의고사 학습 보기 (아빠의 일본어, docs/harness/japanese.md §15-10-2) — 클라이언트 컴포넌트.
 *
 * - 파트별 자료(지문·사진·질문·표)를 **일본어 + 후리가나**(components/ja-ruby — 단일 정의처)로 보이고, 각 줄의 한국어 뜻(`ko`)은 "뜻 보기"로 펼친다.
 * - 모범답변 🔊는 ja-JP(`speak(text, "ja-JP")` — 일본어 기본 엔진은 기기 음성, SPEC §16-5). 후리가나(reading)를 읽히지 않는다(ja 원문을 읽는다).
 * - **Q3–4 사진 두 장을 열 때 자동 요청**(pending 칸만 — 이미 ready면 0, §15-11-3 비용표). 실패 칸은 장면 설명(sceneKo)으로 대신 보이고 "사진 다시 만들기".
 * - 빈 파트는 "이 파트 만들기"(`POST [id]/regenerate?part=` — 빈 자리만, 이미 있으면 409 → 새로 읽기). 버튼을 눌러야 비용이 든다.
 * - 응시: 실전(다섯 파트가 모두 있을 때) · 유형 연습(파트 하나). 응시 기록은 결과 화면으로.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import JaRuby from "@/components/ja-ruby";
import type { JaLine } from "@/lib/ai/japanese/speaking-schemas";
import { JA_SPEAKING_PART_NAME_KO, JA_SPEAKING_SPEECH_LANG, type JaSpeakingPart } from "@/lib/ja-speaking";
import {
  JA_SPEAKING_READ_KIND_KO,
  JA_SPEAKING_TITLE_MAX_CHARS,
  isCompleteJaSpeakingMock,
  jaSpeakingAttemptHref,
  jaSpeakingImageUrl,
  jaSpeakingPartLabelKo,
  jaSpeakingScopeLabelKo,
  jaSpeakingTakeHref,
  type JaSpeakingAttemptSummary,
  type JaSpeakingImageResponse,
  type JaSpeakingMockGetResponse,
  type JaSpeakingMockRecord,
  type JaSpeakingRegenerateResponse,
  type JaSpeakingRenameResponse,
} from "@/lib/ja-speaking-contract";
import { formatKst } from "@/lib/kst";
import { speak } from "@/lib/speech";

type ImageJob = { phase: "making" } | { phase: "ready"; imageId: string } | { phase: "failed"; message: string } | { phase: "nokey"; message: string };
type RegenState = { phase: "loading" } | { phase: "error"; message: string };

/** 일본어 한 줄 — 후리가나 + 🔊(선택) + 뜻 보기 */
function Line({ line, speakable = false, testId }: { line: JaLine; speakable?: boolean; testId?: string }) {
  return (
    <div className="mt-2" data-testid={testId}>
      <div className="flex items-start gap-2">
        <JaRuby tokens={line.tokens} as="div" className="t-body min-w-0 flex-1" />
        {speakable && (
          <button type="button" className="u-btn u-btn-secondary flex-none px-2 py-1" onClick={() => speak(line.ja, JA_SPEAKING_SPEECH_LANG)} aria-label="일본어로 듣기">
            🔊
          </button>
        )}
      </div>
      <details className="mt-1">
        <summary className="t-caption cursor-pointer select-none">뜻 보기</summary>
        <p className="t-caption mt-1 text-ink">{line.ko}</p>
      </details>
    </div>
  );
}

function Card({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="u-box mt-3">
      <p className="t-list-title">{title}</p>
      {children}
    </div>
  );
}

function Tips({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="t-caption mt-2 list-disc pl-5">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

export default function JaSpeakingDetailView({
  mock,
  attempts,
  justCreated,
  failedParts,
}: {
  mock: JaSpeakingMockRecord;
  attempts: JaSpeakingAttemptSummary[];
  justCreated: boolean;
  failedParts: JaSpeakingPart[];
}) {
  const router = useRouter();
  const id = mock.id;
  const p = mock.parts;
  const complete = isCompleteJaSpeakingMock(p);

  // ── 이름 바꾸기 ──
  const [title, setTitle] = useState(mock.titleKo);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mock.titleKo);
  const [renameError, setRenameError] = useState<string | null>(null);
  async function saveTitle() {
    setRenameError(null);
    try {
      const res = await fetch(`/api/japanese/speaking/mocks/${encodeURIComponent(id)}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titleKo: draft }),
      });
      const data = (await res.json().catch(() => null)) as JaSpeakingRenameResponse | null;
      if (data?.ok) {
        setTitle(data.titleKo);
        setEditing(false);
        router.refresh();
        return;
      }
      setRenameError(data && !data.ok ? data.messageKo : "이름을 저장하지 못했어요.");
    } catch {
      setRenameError("네트워크 문제로 이름을 저장하지 못했어요.");
    }
  }

  // ── Q3–4 사진(관문 P) — pending 칸만 자동 요청 ──
  const [imageJobs, setImageJobs] = useState<Partial<Record<0 | 1, ImageJob>>>({});
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
  async function reread(slot: 0 | 1, imagePrompt: string) {
    try {
      const res = await fetch(`/api/japanese/speaking/mocks/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as JaSpeakingMockGetResponse | null;
      if (!data?.ok) return null;
      const item = data.mock.parts.picture?.items[slot];
      return item && item.imagePrompt === imagePrompt ? item.image : null;
    } catch {
      return null;
    }
  }
  async function requestImage(slot: 0 | 1, imagePrompt: string) {
    if (inFlight.current.has(slot)) return;
    inFlight.current.add(slot);
    setJob(slot, { phase: "making" });
    let status = 0;
    let data: JaSpeakingImageResponse | null = null;
    try {
      const res = await fetch(`/api/japanese/speaking/mocks/${encodeURIComponent(id)}/image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      status = res.status;
      data = (await res.json().catch(() => null)) as JaSpeakingImageResponse | null;
    } catch {
      data = null;
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
      const current = await reread(slot, imagePrompt);
      if (current?.status === "ready" && current.imageId) {
        setJob(slot, { phase: "ready", imageId: current.imageId });
        router.refresh();
        return;
      }
      setJob(slot, { phase: "failed", message: data && !data.ok ? data.messageKo : "사진 응답을 받지 못했어요. 잠시 뒤 새로 읽거나 다시 만들어 보세요." });
    } finally {
      inFlight.current.delete(slot);
    }
  }
  const picture = p.picture;
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
    // requestImage 안의 값(id·router)은 바뀌지 않는다 — picture가 바뀔 때만 돈다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picture]);

  // ── 빈 파트 만들기 ──
  const [regen, setRegen] = useState<Partial<Record<JaSpeakingPart, RegenState>>>({});
  const regenBusy = useRef<Set<JaSpeakingPart>>(new Set());
  async function regeneratePart(part: JaSpeakingPart) {
    if (regenBusy.current.has(part)) return;
    regenBusy.current.add(part);
    setRegen((prev) => ({ ...prev, [part]: { phase: "loading" } }));
    try {
      const res = await fetch(`/api/japanese/speaking/mocks/${encodeURIComponent(id)}/regenerate?part=${part}`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as JaSpeakingRegenerateResponse | null;
      if (data?.ok || res.status === 409) {
        setRegen((prev) => {
          const next = { ...prev };
          delete next[part];
          return next;
        });
        router.refresh();
        return;
      }
      if (!data) router.refresh();
      setRegen((prev) => ({ ...prev, [part]: { phase: "error", message: data && !data.ok ? data.messageKo : "응답이 끊겼어요 — 새로 읽었어요. 파트가 보이지 않으면 다시 눌러 주세요." } }));
    } catch {
      router.refresh();
      setRegen((prev) => ({ ...prev, [part]: { phase: "error", message: "네트워크 문제로 만들지 못했어요." } }));
    } finally {
      regenBusy.current.delete(part);
    }
  }

  const sectionHead = (part: JaSpeakingPart) => (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="t-section-title">{jaSpeakingPartLabelKo(part)}</h2>
      {p[part] && (
        <Link href={jaSpeakingTakeHref(id, "part", part)} className="u-btn u-btn-secondary px-3 py-1.5 text-meta-chip" data-testid={`ja-take-part-${part}`}>
          🎙️ 이 유형 연습
        </Link>
      )}
    </div>
  );

  const missing = (part: JaSpeakingPart) => {
    const st = regen[part];
    return (
      <div className="u-box mt-3 border border-dashed border-line">
        <p className="t-caption">{failedParts.includes(part) ? "만들기에 실패한 파트예요." : "아직 없는 파트예요."}</p>
        <button type="button" className="u-btn u-btn-primary mt-2" onClick={() => void regeneratePart(part)} disabled={st?.phase === "loading"} data-testid={`ja-regen-${part}`}>
          {st?.phase === "loading" ? "만드는 중…" : `✨ ${JA_SPEAKING_PART_NAME_KO[part]} 만들기`}
        </button>
        {st?.phase === "error" && (
          <p role="alert" className="t-caption mt-2 text-danger">
            {st.message}
          </p>
        )}
      </div>
    );
  };

  return (
    <>
      <section className="mb-6">
        {editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={JA_SPEAKING_TITLE_MAX_CHARS} className="u-input min-w-0 flex-1" aria-label="모의고사 이름" />
            <button type="button" className="u-btn u-btn-primary" onClick={() => void saveTitle()}>
              저장
            </button>
            <button type="button" className="u-btn u-btn-secondary" onClick={() => setEditing(false)}>
              취소
            </button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <h1 className="t-book-title">🎙️ {title}</h1>
            <button type="button" className="u-btn u-btn-secondary flex-none px-3 py-1.5 text-meta-chip" onClick={() => setEditing(true)}>
              이름 바꾸기
            </button>
          </div>
        )}
        {renameError && <p className="t-caption mt-1 text-danger">{renameError}</p>}
        <p className="t-caption mt-2 flex flex-wrap items-center gap-1.5">
          <span className="u-chip u-chip-accent">{mock.level}</span>
          {mock.topicHints.map((h) => (
            <span key={h} className="u-chip">
              {h}
            </span>
          ))}
        </p>
        {justCreated && failedParts.length > 0 && (
          <p role="status" className="u-box t-caption mt-3 border border-line-strong">
            ⚠️ {failedParts.map(jaSpeakingPartLabelKo).join(" · ")} 파트를 만들지 못했어요. 아래에서 그 파트만 다시 만들 수 있어요.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {complete ? (
            <Link href={jaSpeakingTakeHref(id, "full")} className="u-btn u-btn-primary" data-testid="ja-take-full">
              🎙️ 실전 응시(11문항)
            </Link>
          ) : (
            <span className="t-caption">빠진 파트를 채우면 실전 응시를 할 수 있어요. 있는 파트는 유형 연습으로 풀 수 있어요.</span>
          )}
        </div>
        <p className="t-caption mt-2">녹음은 이 기기에만 남아요 — AI 채점은 응시한 기기에서 받아요.</p>
      </section>

      {/* Q1–2 지문 읽기 */}
      <section className="mt-6" aria-label="지문 읽기">
        {sectionHead("read")}
        {p.read
          ? p.read.items.map((it, i) => (
              <Card key={i} title={`Q${i + 1} · ${JA_SPEAKING_READ_KIND_KO[it.kind] ?? it.kind}`}>
                <Line line={it.passage} speakable testId={`ja-read-${i + 1}`} />
                <Tips items={it.tipsKo} />
              </Card>
            ))
          : missing("read")}
      </section>

      {/* Q3–4 사진 묘사 */}
      <section className="mt-8" aria-label="사진 묘사">
        {sectionHead("picture")}
        {p.picture
          ? p.picture.items.map((it, i) => {
              const slot = i as 0 | 1;
              const job = imageJobs[slot];
              const imageId = it.image.status === "ready" && it.image.imageId ? it.image.imageId : job?.phase === "ready" ? job.imageId : null;
              return (
                <Card key={i} title={`Q${i + 3} · ${it.place}`}>
                  {imageId ? (
                    // eslint-disable-next-line @next/next/no-img-element -- PIN 게이트 안 동적 라우트 바이트
                    <img src={jaSpeakingImageUrl(imageId)} alt={`Q${i + 3} 사진`} width={1536} height={1024} className="mt-2 h-auto w-full rounded-[var(--radius-box)]" />
                  ) : (
                    <div className="mt-2 rounded-[var(--radius-box)] border border-dashed border-line p-3" data-testid={`ja-scene-${slot}`}>
                      <p className="t-caption">{job?.phase === "making" ? "📷 일본 배경 사진을 그리는 중… (1분 안팎)" : "📷 사진 대신 장면 설명"}</p>
                      <p className="t-body mt-1">{it.sceneKo}</p>
                      {(job?.phase === "failed" || (it.image.status === "failed" && job?.phase !== "making")) && (
                        <>
                          {job?.phase === "failed" && <p className="t-caption mt-1 text-danger">{job.message}</p>}
                          <button type="button" className="u-btn u-btn-secondary mt-2" onClick={() => void requestImage(slot, it.imagePrompt)}>
                            🔄 사진 다시 만들기
                          </button>
                        </>
                      )}
                      {job?.phase === "nokey" && <p className="t-caption mt-1">{job.message}</p>}
                    </div>
                  )}
                  <p className="t-caption mt-3">모범답변</p>
                  <Line line={it.sampleAnswer} speakable />
                  <Tips items={it.keyPointsKo} />
                </Card>
              );
            })
          : missing("picture")}
      </section>

      {/* Q5–7 듣고 답하기 */}
      <section className="mt-8" aria-label="듣고 답하기">
        {sectionHead("respond")}
        {p.respond ? (
          <>
            <Card title={`상황 · ${p.respond.topicKo}`}>
              <Line line={p.respond.intro} speakable />
            </Card>
            {p.respond.questions.map((qq, i) => (
              <Card key={i} title={`Q${i + 5}`}>
                <Line line={qq.question} speakable />
                <p className="t-caption mt-3">모범답변</p>
                <Line line={qq.sampleAnswer} speakable />
                <Tips items={[qq.tipKo]} />
              </Card>
            ))}
          </>
        ) : (
          missing("respond")
        )}
      </section>

      {/* Q8–10 정보 활용 */}
      <section className="mt-8" aria-label="정보 활용">
        {sectionHead("info")}
        {p.info ? (
          <>
            <Card title={`표 · ${p.info.table.titleKo}`}>
              <div className="mt-2" lang="ja">
                <p className="t-list-title">{p.info.table.title}</p>
                {p.info.table.meta.map((m, k) => (
                  <p key={k} className="t-caption">
                    {m}
                  </p>
                ))}
                <table className="mt-2 w-full border-collapse text-left">
                  <tbody>
                    {p.info.table.rows.map((r, k) => (
                      <tr key={k} className="border-t border-line">
                        <th scope="row" className="t-caption py-1 pr-2 align-top font-medium">
                          {r.left}
                        </th>
                        <td className="t-body py-1">{r.right}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {p.info.table.notes.map((n, k) => (
                  <p key={k} className="t-caption mt-1">
                    {n}
                  </p>
                ))}
              </div>
              <p className="t-caption mt-3">전화 건 사람</p>
              <Line line={p.info.callerIntro} speakable />
            </Card>
            {p.info.questions.map((qq, i) => (
              <Card key={i} title={`Q${i + 8}`}>
                <Line line={qq.question} speakable />
                <p className="t-caption mt-3">모범답변</p>
                <Line line={qq.sampleAnswer} speakable />
                <Tips items={[qq.tipKo]} />
              </Card>
            ))}
          </>
        ) : (
          missing("info")
        )}
      </section>

      {/* Q11 의견 말하기 */}
      <section className="mt-8" aria-label="의견 말하기">
        {sectionHead("opinion")}
        {p.opinion ? (
          <Card title="Q11">
            <Line line={p.opinion.question} speakable />
            <p className="t-caption mt-3">답변 뼈대</p>
            <Tips items={p.opinion.outlineKo} />
            <p className="t-caption mt-3">모범답변</p>
            <Line line={p.opinion.sampleAnswer} speakable />
            <Tips items={[p.opinion.tipKo]} />
          </Card>
        ) : (
          missing("opinion")
        )}
      </section>

      {/* 응시 기록 */}
      <section className="mt-10" aria-label="응시 기록">
        <h2 className="t-section-title">응시 기록</h2>
        {attempts.length === 0 ? (
          <p className="t-caption mt-2">아직 응시 기록이 없어요.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {attempts.map((a) => (
              <li key={a.id}>
                <Link href={jaSpeakingAttemptHref(a.id)} className="u-item" data-testid="ja-attempt-row">
                  <span className="u-item-thumb" aria-hidden>
                    📊
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="t-list-title block truncate">{jaSpeakingScopeLabelKo(a.scope, a.parts)}</span>
                    <span className="t-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span className="u-chip">{a.finishedAt ? "끝까지" : "중간에 그만둠"}</span>
                      <span className="u-chip">
                        녹음 {a.recordedCount}/{a.questions.length}
                      </span>
                      {a.scoredCount > 0 && <span className="u-chip u-chip-accent">채점 {a.scoredCount}</span>}
                      <span>{formatKst(a.startedAt)}</span>
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

    </>
  );
}
