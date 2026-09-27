"use client";

/**
 * ④ 🎤 한 문제 연습 탭 (docs/harness/toeic.md §12-7·§12-8, SPEC §20-10) — 유형 폴더의 네 번째 탭(클라이언트 컴포넌트).
 *
 * - **🧩 이 유형 답변 흐름**(접힘, §12-7-9): 흐름의 단계마다 단계 이름과 틀 하나(두 테스트 모드 합친 가장 약한 틀 — 서버가
 *   lib/toeic-drill-view drillStepPicks로 골라 넘긴다). 응시 화면(준비 45초) 안에는 두지 않는다 — 시작 전에 보는 자리다.
 * - **응시 전 연습 안내**(§12-7-2): 응시 기록이 없는 연습이 있으면 "응시 전 연습 n개 — 먼저 풀어 보세요" + 가장 최근 것 열기
 *   (새로 만들기를 막지는 않는다).
 * - **새 문제 만들기**: 목표 등급(IM3·IH 기본·AL — 마지막 선택을 기기 localStorage에, try/catch) → `POST /api/toeic/guides/[part]/drills`
 *   (호출 C 1회). 버튼 옆 비용 캡션. 응답이 끊기면(게이트웨이 60초·네트워크) 서버는 끝까지 저장할 수 있다 — 목록을 새로 읽어 누른 뒤
 *   생긴 연습(누르기 전 목록에 없던 id)이 있으면 그것을 열고, 없으면 "서버에서 만들어졌을 수 있어요" + "그래도 새로 만들기"(SPEC §20-3).
 * - **사진 준비(Q3–4, §12-7-3)**: 만들기가 성공하면 **같은 버튼 흐름 안에서** `POST /api/toeic/mocks/[id]/image {slot:0}` 한 번을 부르고
 *   기다린다(실패를 받으면 `GET /api/toeic/mocks/[id]`로 한 번 다시 읽어 이미 저장됐는지 확인). 준비 중에도 **사진을 보여 주지 않는다**
 *   (준비 45초가 실전이 아니게 되므로) — 상태만. 실패하면 "사진 다시 만들기" / "사진 없이 시작". 다시 열었는데 pending이면 **자동으로
 *   부르지 않고** "사진 만들기" 버튼(비용이 드는 요청은 명시적 흐름으로만).
 * - **시작** → 기존 응시 화면(`/toeic/mocks/[id]/take?scope=part&part=`). 채점은 결과 화면의 버튼(자동 채점 없음).
 * - **최근 연습**(최신 10): 제목·날짜·목표 등급·상태(사진 준비 중 / 응시 전 / 녹음 n · 채점 m / 점수 합·만점). 응시 전이면 준비 카드를
 *   열고, 응시했으면 가장 늦은 응시의 결과 화면으로 간다. 삭제·자동 정리는 두지 않는다(SPEC §20-6).
 * 판단은 lib/toeic-drill-view 순수 함수가 하고 여기서는 소비만 한다. 공략이 없어도 연습은 된다(§12-8).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { FrameLine } from "@/components/toeic-template-lines";
import { formatKstDate } from "@/lib/kst";
import type { ToeicDrillMockPart } from "@/lib/toeic-drill";
import {
  TOEIC_DRILL_GRADE_STORAGE_KEY,
  parseDrillGrade,
  toeicDrillCostCaptionKo,
  toeicDrillStatusKo,
  type ToeicDrillSummary,
} from "@/lib/toeic-drill-view";
import type { ToeicDrillCreateRequest, ToeicDrillCreateResponse, ToeicGuidePart } from "@/lib/toeic-guide-contract";
import { slotToneMap } from "@/lib/toeic-guide-view";
import {
  TOEIC_TARGET_GRADE_DESC_KO,
  toeicTakeHref,
  type ToeicMockGetResponse,
  type ToeicMockImageResponse,
} from "@/lib/toeic-mock-contract";
import { TOEIC_TARGET_GRADES, type ToeicTargetGrade } from "@/lib/toeic-mock";
import { frameSlotNames } from "@/lib/toeic-template";
import s from "./toeic-drill-view.module.css";

/** 서버 페이지가 넘기는 ④ 탭 자료(직렬화 가능한 값만) */
export interface ToeicDrillTabData {
  mockPart: ToeicDrillMockPart;
  /** 그 유형 연습 최신 10개 */
  recent: ToeicDrillSummary[];
  /** 응시 기록이 없는 연습 수(전체 — 10개 밖 포함) */
  pendingCount: number;
  /** 응시 전 연습 중 가장 최근 것(없으면 null) */
  latestPending: ToeicDrillSummary | null;
  /** 🧩 이 유형 답변 흐름 — 단계마다 가장 약한 틀 하나(없는 단계는 null) */
  flow: { stepKo: string; template: { key: string; frameEn: string; frameKo: string } | null }[];
}

type CreateState =
  | { phase: "idle" }
  | { phase: "creating"; startedAt: number }
  | { phase: "error"; message: string; retriable: boolean; cut: boolean };

/** 사진 칸의 화면 상태 — 서버 값(props) 위에 이 화면의 요청 결과를 얹는다 */
type ImageJob =
  | { phase: "making"; startedAt: number }
  | { phase: "ready" }
  | { phase: "failed"; message: string }
  | { phase: "nokey"; message: string };

export default function ToeicDrillView({
  part,
  partLabelKo,
  data,
  onOpenTemplate,
}: {
  part: ToeicGuidePart;
  partLabelKo: string;
  data: ToeicDrillTabData;
  onOpenTemplate: (key: string) => void;
}) {
  const router = useRouter();
  const isPicture = data.mockPart === "picture";

  // ── 목표 등급(기기 기억 — 마운트 뒤 읽기: hydration 안전) ──
  const [grade, setGrade] = useState<ToeicTargetGrade>(parseDrillGrade(null));
  useEffect(() => {
    try {
      setGrade(parseDrillGrade(window.localStorage.getItem(TOEIC_DRILL_GRADE_STORAGE_KEY)));
    } catch {
      /* 기기 저장소를 못 쓰면 기본값 */
    }
  }, []);
  function chooseGrade(g: ToeicTargetGrade) {
    setGrade(g);
    try {
      window.localStorage.setItem(TOEIC_DRILL_GRADE_STORAGE_KEY, g);
    } catch {
      /* 기억하지 못해도 이번 선택은 그대로 */
    }
  }

  // ── 준비 카드(지금 고른 연습) ──
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 막 만든 연습 — 목록을 새로 읽기 전에도 준비 카드를 그리려고(제목만) */
  const [created, setCreated] = useState<{ id: string; titleKo: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const prepRef = useRef<HTMLElement>(null);

  const known = [...data.recent, ...(data.latestPending ? [data.latestPending] : [])];
  const activeSummary = activeId ? (known.find((d) => d.id === activeId) ?? null) : null;
  const active: Pick<ToeicDrillSummary, "id" | "titleKo" | "picture" | "attemptCount" | "latest"> | null =
    activeSummary ??
    (activeId && created?.id === activeId
      ? { id: created.id, titleKo: created.titleKo, picture: isPicture ? "pending" : null, attemptCount: 0, latest: null }
      : null);

  const openPrep = useCallback((id: string) => {
    setActiveId(id);
    // 카드가 그려진 뒤 화면 안으로
    window.setTimeout(() => prepRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
  }, []);

  // ── 사진(관문 P) — Q3–4만, 칸 하나(slot 0) ──
  const [imageJobs, setImageJobs] = useState<Record<string, ImageJob>>({});
  const inFlight = useRef<Set<string>>(new Set());
  const setJob = useCallback((id: string, job: ImageJob | null) => {
    setImageJobs((prev) => {
      const next = { ...prev };
      if (job) next[id] = job;
      else delete next[id];
      return next;
    });
  }, []);

  /** 실패를 받았을 때 — 한 번 새로 읽어 이미 저장됐는지 본다(§4-10). */
  async function rereadReady(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/toeic/mocks/${encodeURIComponent(id)}`, { cache: "no-store" });
      const got = (await res.json().catch(() => null)) as ToeicMockGetResponse | null;
      if (!got?.ok) return false;
      const img = got.mock.parts.picture?.items[0]?.image;
      return img?.status === "ready" && !!img.imageId;
    } catch {
      return false;
    }
  }

  async function requestImage(id: string) {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setJob(id, { phase: "making", startedAt: Date.now() });
    let status = 0;
    let res: ToeicMockImageResponse | null = null;
    try {
      const r = await fetch(`/api/toeic/mocks/${encodeURIComponent(id)}/image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: 0 }),
      });
      status = r.status;
      res = (await r.json().catch(() => null)) as ToeicMockImageResponse | null;
    } catch {
      res = null; // 네트워크가 끊겼다 — 아래에서 다시 읽어 확인
    }
    try {
      if (res?.ok && res.image.imageId) {
        setJob(id, { phase: "ready" });
        router.refresh();
        return;
      }
      if (status === 501 && res && !res.ok) {
        setJob(id, { phase: "nokey", message: res.messageKo });
        return;
      }
      if (status === 409) {
        setJob(id, null);
        router.refresh();
        return;
      }
      if (await rereadReady(id)) {
        setJob(id, { phase: "ready" });
        router.refresh();
        return;
      }
      setJob(id, {
        phase: "failed",
        message:
          res && !res.ok
            ? res.messageKo
            : "사진 응답을 받지 못했어요. 서버가 아직 그리는 중일 수 있어요 — 잠시 뒤 다시 만들어 보거나 사진 없이 시작해요.",
      });
    } finally {
      inFlight.current.delete(id);
    }
  }

  // ── 새 문제 만들기 ──
  const [create, setCreate] = useState<CreateState>({ phase: "idle" });
  const creatingRef = useRef(false);
  /** 응답이 끊겼을 때 — 누르기 전 목록에 있던 연습 id(새로 읽은 목록에 이것 밖의 id가 있으면 서버가 만든 것) */
  const cutWatchRef = useRef<Set<string> | null>(null);

  async function runCreate() {
    if (creatingRef.current) return;
    creatingRef.current = true;
    const knownIds = new Set(known.map((d) => d.id));
    setNotice(null);
    setCreate({ phase: "creating", startedAt: Date.now() });
    const body: ToeicDrillCreateRequest = { targetGrade: grade };
    let got: ToeicDrillCreateResponse | null = null;
    let reached = true;
    try {
      const r = await fetch(`/api/toeic/guides/${part}/drills`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      got = (await r.json().catch(() => null)) as ToeicDrillCreateResponse | null;
    } catch {
      reached = false;
    }
    creatingRef.current = false;
    if (got?.ok) {
      setCreate({ phase: "idle" });
      setCreated({ id: got.id, titleKo: got.titleKo });
      openPrep(got.id);
      router.refresh();
      // Q3–4 — 같은 버튼 흐름 안에서 사진 한 장을 요청하고 기다린다(§12-7-3)
      if (isPicture) await requestImage(got.id);
      return;
    }
    if (got && !got.ok) {
      setCreate({ phase: "error", message: got.messageKo, retriable: got.error === "ai_failed" || got.error === "save_failed", cut: false });
      return;
    }
    // 우리 JSON이 아니다(게이트웨이 시간 초과·네트워크) — 서버는 끝까지 만들어 저장했을 수 있다: 목록을 새로 읽는다
    cutWatchRef.current = knownIds;
    router.refresh();
    setCreate({
      phase: "error",
      message: `${reached ? "응답이 중간에 끊겼어요" : "네트워크가 끊겼어요"}. 서버에서 만들어졌을 수 있어 목록을 새로 읽었어요 — 새 연습이 보이면 그것을 쓰세요.`,
      retriable: true,
      cut: true,
    });
  }

  // 끊긴 뒤 새로 읽은 목록에 누른 뒤 생긴 연습이 있으면 그것을 연다(두 벌을 만들지 않게)
  useEffect(() => {
    const watch = cutWatchRef.current;
    if (!watch) return;
    const fresh = data.recent.find((d) => !watch.has(d.id));
    if (!fresh) return;
    cutWatchRef.current = null;
    setCreate({ phase: "idle" });
    setNotice(`응답은 끊겼지만 서버에서 만들어진 연습(${fresh.titleKo})이 있어 그것을 열었어요.`);
    openPrep(fresh.id);
  }, [data.recent, openPrep]);

  // ── 흐르는 시간(만드는 중·사진 준비 중) ──
  const makingJob = active ? imageJobs[active.id] : undefined;
  const ticking = create.phase === "creating" || makingJob?.phase === "making";
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [ticking]);
  const secsSince = (at: number) => Math.max(0, Math.floor((now - at) / 1000));

  const busy = create.phase === "creating" || makingJob?.phase === "making";
  const takeHref = (id: string) => toeicTakeHref(id, "part", data.mockPart);
  const flowShown = data.flow.some((f) => f.template !== null);

  // ── 준비 카드 ──
  function prepCard() {
    if (!active) return null;
    const job = imageJobs[active.id];
    const pic = active.picture;
    const attempted = active.attemptCount > 0;
    return (
      <section ref={prepRef} className={s.prep} aria-label="연습 준비" data-testid="drill-prep">
        <div className={s.prepHead}>
          <p className={s.prepTitle}>{active.titleKo}</p>
          {attempted && <span className="u-chip">응시 {active.attemptCount}회</span>}
        </div>
        {isPicture && (
          <div className={s.picState} aria-live="polite" data-testid="drill-picture-state">
            {job?.phase === "making" ? (
              <p className={s.picLine}>📷 사진 준비 중… {secsSince(job.startedAt)}초 — 준비되면 시작할 수 있어요(사진은 준비 45초에 처음 보여요).</p>
            ) : job?.phase === "ready" || (!job && pic === "ready") ? (
              <p className={s.picLine}>📷 사진 준비됨 — 준비 45초에 처음 보여요.</p>
            ) : job?.phase === "nokey" ? (
              <p className={s.picWarn}>{job.message}</p>
            ) : job?.phase === "failed" ? (
              <p className={s.picWarn}>{job.message}</p>
            ) : pic === "failed" ? (
              <p className={s.picWarn}>사진을 만들지 못했어요. 다시 만들거나 사진 없이(장면 설명으로) 시작할 수 있어요.</p>
            ) : (
              <p className={s.picLine}>📷 사진이 아직 없어요 — 만들면 사진 한 장 비용이 들어요.</p>
            )}
          </div>
        )}
        <div className={s.prepActions}>
          {(() => {
            if (!isPicture) {
              return (
                <Link href={takeHref(active.id)} className="u-btn u-btn-primary" data-testid="drill-start">
                  ▶ 시작
                </Link>
              );
            }
            if (job?.phase === "making") {
              return (
                <button type="button" className="u-btn u-btn-primary" disabled>
                  ▶ 시작
                </button>
              );
            }
            const ready = job?.phase === "ready" || (!job && pic === "ready");
            if (ready) {
              return (
                <Link href={takeHref(active.id)} className="u-btn u-btn-primary" data-testid="drill-start">
                  ▶ 시작
                </Link>
              );
            }
            return (
              <>
                {job?.phase !== "nokey" && (
                  <button type="button" className="u-btn u-btn-primary" onClick={() => void requestImage(active.id)} data-testid="drill-make-picture">
                    📷 {job?.phase === "failed" || pic === "failed" ? "사진 다시 만들기" : "사진 만들기"}
                  </button>
                )}
                <Link href={takeHref(active.id)} className="u-btn u-btn-secondary" data-testid="drill-start-nopic">
                  사진 없이 시작
                </Link>
              </>
            );
          })()}
          {active.latest && (
            <Link href={`/toeic/attempts/${encodeURIComponent(active.latest.id)}`} className="u-btn u-btn-secondary">
              📊 지난 결과
            </Link>
          )}
        </div>
        <p className={s.caption}>시작하면 실전처럼 지시문·질문을 듣고 준비·답변 시간대로 녹음해요. 끝나면 결과 화면에서 AI 채점을 받을 수 있어요.</p>
      </section>
    );
  }

  return (
    <div className={s.wrap}>
      <p className={s.lead}>
        AI가 {partLabelKo} 문제를 매번 새로 만들어요(교재 예시 문제가 아니에요). 실전처럼 준비·답변을 녹음한 뒤, 결과 화면에서 AI 채점을 받아요.
      </p>

      {/* 🧩 이 유형 답변 흐름(접힘 — 시작 전에 보는 자리, §12-7-9) */}
      {flowShown && (
        <details className={s.flow} data-testid="drill-flow">
          <summary className={s.flowSummary}>🧩 이 유형 답변 흐름 — 단계마다 틀 하나</summary>
          <ol className={s.flowList}>
            {data.flow.map((f, i) => {
              const t = f.template;
              const tones = t ? slotToneMap(frameSlotNames(t.frameEn)) : new Map<string, number>();
              return (
                <li key={`${i}-${f.stepKo}`} className={s.flowItem}>
                  <span className={s.flowStep}>
                    {i + 1}. {f.stepKo}
                  </span>
                  {t ? (
                    <>
                      <span className={s.flowEn} lang="en">
                        <FrameLine frame={t.frameEn} tones={tones} lang="en" />
                      </span>
                      <span className={s.flowKo}>
                        <FrameLine frame={t.frameKo} tones={tones} lang="ko" />
                      </span>
                      <button type="button" className={s.flowLink} onClick={() => onOpenTemplate(t.key)}>
                        이 틀 연습하기 →
                      </button>
                    </>
                  ) : (
                    <span className={s.caption}>이 단계의 틀이 아직 없어요.</span>
                  )}
                </li>
              );
            })}
          </ol>
          <p className={s.caption}>틀이 가장 약한 것부터 골랐어요. 문제를 만들 때도 이 틀들을 모범답변에 먼저 녹여요.</p>
        </details>
      )}

      {/* 응시 전 연습 — 먼저 권한다(새로 만들기를 막지는 않는다) */}
      {data.pendingCount > 0 && data.latestPending && (
        <div className={s.pending} role="status" data-testid="drill-pending">
          <p className={s.pendingText}>응시 전 연습 {data.pendingCount}개 — 먼저 풀어 보세요.</p>
          {activeId !== data.latestPending.id && (
            <button type="button" className="u-btn u-btn-secondary" onClick={() => openPrep(data.latestPending!.id)}>
              {data.latestPending.titleKo} 열기
            </button>
          )}
        </div>
      )}

      {notice && (
        <p role="status" className="u-box-accent t-question-ko text-ink">
          ✅ {notice}
        </p>
      )}

      {prepCard()}

      {/* 새 문제 만들기 */}
      <section className={s.create} aria-label="새 문제 만들기">
        <fieldset className={s.fieldset} disabled={busy}>
          <legend className={s.legend}>목표 등급 — 모범답변의 길이·수준이 달라져요</legend>
          <div className={s.choices}>
            {TOEIC_TARGET_GRADES.map((g) => (
              <label key={g} className={`${s.choice} ${grade === g ? s.choiceOn : ""}`}>
                <input type="radio" name={`drill-grade-${part}`} value={g} checked={grade === g} onChange={() => chooseGrade(g)} className={s.srOnly} />
                <span className={s.choiceTitle}>{g}</span>
                <span className={s.choiceDesc}>{TOEIC_TARGET_GRADE_DESC_KO[g]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className={s.createRow}>
          <button type="button" className="u-btn u-btn-primary" onClick={() => void runCreate()} disabled={busy} data-testid="drill-create">
            {create.phase === "creating" ? `만드는 중… ${secsSince(create.startedAt)}초` : "✨ 새 문제 만들기"}
          </button>
          <p className={s.cost} data-testid="drill-cost">
            {toeicDrillCostCaptionKo(part)}
          </p>
        </div>
        {create.phase === "creating" && (
          <p role="status" className={s.caption}>
            문제를 만들고 있어요(보통 10~30초) — 화면을 켜 둔 채 기다려 주세요.{isPicture ? " 이어서 사진 한 장을 그려요." : ""}
          </p>
        )}
        {create.phase === "error" && (
          <div role="alert" className={s.error}>
            <p className={s.errorText}>{create.message}</p>
            {create.retriable && (
              <button type="button" className="u-btn u-btn-secondary" onClick={() => void runCreate()}>
                {create.cut ? "그래도 새로 만들기" : "🔄 다시 만들기"}
              </button>
            )}
          </div>
        )}
      </section>

      {/* 최근 연습(최신 10) */}
      <section aria-label="최근 연습" className={s.recent}>
        <h2 className={s.recentTitle}>최근 연습</h2>
        {data.recent.length === 0 ? (
          <p className={s.empty}>아직 연습이 없어요. 위에서 첫 문제를 만들어 볼까요?</p>
        ) : (
          <ul className={s.list} data-testid="drill-recent">
            {data.recent.map((d) => {
              const body = (
                <>
                  <span className="u-item-thumb" aria-hidden>
                    🎤
                  </span>
                  <span className={s.rowBody}>
                    <span className="t-list-title block truncate">{d.titleKo}</span>
                    <span className={s.rowChips}>
                      <span className="u-chip">목표 {d.targetGrade}</span>
                      <span className={`u-chip ${d.latest && d.latest.recorded > 0 && d.latest.scored >= d.latest.recorded ? "u-chip-accent" : ""}`}>
                        {toeicDrillStatusKo(d)}
                      </span>
                      <span className="t-caption">{formatKstDate(d.createdAt)}</span>
                    </span>
                  </span>
                </>
              );
              return (
                <li key={d.id}>
                  {d.latest ? (
                    <Link href={`/toeic/attempts/${encodeURIComponent(d.latest.id)}`} className="u-item" data-testid="drill-row">
                      {body}
                    </Link>
                  ) : (
                    <button type="button" className={`u-item ${s.rowButton}`} onClick={() => openPrep(d.id)} data-testid="drill-row">
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
