"use client";

/**
 * 표현집 상세 (아빠의 영어 T1, docs/harness/toeic.md §3-0·§6-3·§8) — 클라이언트 컴포넌트.
 *
 * - **표현 카드**: 표현(🔊) · 뜻 · 예문(🔊, `exampleSpan` 하이라이트) · 해석 + **발화 포인트**(coreKo · 문항 배지 달린 useIn(🔊) ·
 *   답변 틀 · 바꿔 쓰기(🔊) · 발음 · 함정 · 문법 · 이어 말하기(🔊)). 포인트가 없으면 "발화 포인트 만들기".
 * - **발화 포인트 만들기/다시 만들기**: `POST /api/toeic/sets/[id]/points` — 기본은 빈 자리만, "다시 만들기"는 확인 후 force.
 * - **전체 듣기**(§6-3): 대본은 순수 함수 `buildToeicListenScript(set, mode)`(3모드), 재생은 `speakQueue` — **탭 핸들러 안에서
 *   동기로** 부르고(iOS 재생 잠금 해제), `onItem`으로 지금 읽는 카드를 강조·스크롤, 정지는 **큐가 돌려준 stop**만 쓴다
 *   (stopSpeaking은 다른 🔊까지 죽인다 — ja-dialog-coaching-view 관용구).
 * - **교재 QUIZ**: 우리말 → "정답 보기" → 모범답변 표시·🔊.
 * - 발음: 영어는 항상 `speak(text, "en-US")`, 대본의 한국어 조각은 `ko-KR` — lang을 늘 명시한다(한국어를 영어 음성으로 읽는
 *   실수 방지, §6-1). 속도·엔진(TtsSpeedControl·TtsEngineControl)은 은우와 전역 설정을 공유한다(§6-3).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import TtsEngineControl from "@/components/tts-engine-control";
import TtsSpeedControl from "@/components/tts-speed-control";
import { prefetchSpeech, speak, speakQueue } from "@/lib/speech";
import { TOEIC_LISTEN_MODES, TOEIC_LISTEN_MODE_LABELS_KO, buildToeicListenScript, type ToeicListenMode } from "@/lib/toeic-listen";
import {
  TOEIC_PART_BADGE_KO,
  type ToeicBookQuiz,
  type ToeicExprEntry,
  type ToeicPointsResponse,
  type ToeicSetRenameResponse,
} from "@/lib/toeic-set-contract";
import s from "./toeic-set-detail-view.module.css";

/** 영어 🔊 — 대본(trim)과 같은 글자로 읽어 두 겹 캐시가 한 번 합성한 소리를 다시 쓴다 */
function speakEn(text: string | null | undefined) {
  const t = (text ?? "").trim();
  if (t) speak(t, "en-US");
}

/** 재생 중인 실행을 무효화하고 큐를 멈춘다(큐가 돌려준 stop만 — 카드 🔊까지 죽이는 stopSpeaking을 쓰지 않는다). */
function haltQueue(runRef: RefObject<number>, stopRef: RefObject<(() => void) | null>) {
  runRef.current++;
  const stop = stopRef.current;
  stopRef.current = null;
  stop?.();
}

/** 예문 속 exampleSpan을 강조한다(대소문자 그대로 → 없으면 대소문자 무시로 한 번 더). 못 찾으면 원문 그대로. */
function highlightSpan(example: string, span: string | null): ReactNode {
  if (!span) return example;
  let at = example.indexOf(span);
  if (at < 0) at = example.toLowerCase().indexOf(span.toLowerCase());
  if (at < 0) return example;
  return (
    <>
      {example.slice(0, at)}
      <mark className={s.span}>{example.slice(at, at + span.length)}</mark>
      {example.slice(at + span.length)}
    </>
  );
}

/** 답변 틀의 "___"를 빈칸 모양으로 */
function renderFrame(frame: string): ReactNode {
  const parts = frame.split("___");
  return parts.map((p, i) => (
    <Fragment key={i}>
      {p}
      {i < parts.length - 1 && <span className={s.slot} aria-label="빈칸" />}
    </Fragment>
  ));
}

function SpeakBtn({ text, label }: { text: string | null | undefined; label: string }) {
  if (!text || !text.trim()) return null;
  return (
    <button type="button" className={s.speak} onClick={() => speakEn(text)} aria-label={`${label} 듣기`} title="듣기">
      🔊
    </button>
  );
}

type PointsState =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "loading"; force: boolean }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string };

export default function ToeicSetDetailView({
  id,
  titleKo,
  dayNo,
  topicKo,
  source,
  entries,
  quiz,
  titleMax,
}: {
  id: string;
  titleKo: string;
  dayNo: number | null;
  topicKo: string | null;
  source: "photo" | "import";
  entries: ToeicExprEntry[];
  quiz: ToeicBookQuiz[];
  titleMax: number;
}) {
  const router = useRouter();
  const pointsCount = entries.filter((e) => e.points !== null).length;
  const missingPoints = entries.length - pointsCount;

  // ── 제목 인라인 수정 ──
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(titleKo);
  const [saving, setSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  async function saveTitle() {
    const next = draft.trim();
    if (next === "" || next === titleKo) {
      setEditing(false);
      setDraft(titleKo);
      return;
    }
    setSaving(true);
    setTitleError(null);
    try {
      const res = await fetch(`/api/toeic/sets/${encodeURIComponent(id)}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titleKo: next }),
      });
      const data = (await res.json().catch(() => null)) as ToeicSetRenameResponse | null;
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

  // ── 발화 포인트 만들기 / 다시 만들기 ──
  const [points, setPoints] = useState<PointsState>({ phase: "idle" });
  const pointsBusy = points.phase === "loading";

  async function makePoints(force: boolean) {
    if (pointsBusy) return;
    setPoints({ phase: "loading", force });
    try {
      const res = await fetch(`/api/toeic/sets/${encodeURIComponent(id)}/points`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = (await res.json().catch(() => null)) as ToeicPointsResponse | null;
      if (data?.ok) {
        const message = data.nothingToFill
          ? "이미 모든 표현에 발화 포인트가 있어요."
          : data.remaining > 0
            ? `${data.filled}개를 만들었어요. ${data.remaining}개는 만들지 못했어요 — 다시 눌러 채울 수 있어요.`
            : `${data.filled}개 표현의 발화 포인트를 만들었어요.`;
        setPoints({ phase: "done", message });
        router.refresh();
        return;
      }
      setPoints({ phase: "error", message: data && !data.ok ? data.messageKo : "발화 포인트를 만들지 못했어요." });
    } catch {
      setPoints({ phase: "error", message: "네트워크 문제로 발화 포인트를 만들지 못했어요." });
    }
  }

  // ── 전체 듣기 ──
  const [listenMode, setListenMode] = useState<ToeicListenMode>("basic");
  const script = useMemo(() => buildToeicListenScript({ entries }, listenMode), [entries, listenMode]);
  const scriptKey = useMemo(() => script.map((p) => `${p.lang}|${p.text}`).join("\n"), [script]);
  const runRef = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);
  const [playing, setPlaying] = useState<{ key: string; index: number } | null>(null);
  const cur = playing && playing.key === scriptKey && playing.index < script.length ? playing.index : null;
  const activeEntry = cur != null ? script[cur].entryIndex : null;
  const listRef = useRef<HTMLOListElement>(null);
  const settingsRef = useRef<HTMLDetailsElement>(null);

  // 정지 조건 ① 화면을 떠나면 ② 대본이 바뀌면(모드 변경·포인트 새로 고침) — 옛 대본을 읽으며 새 카드를 강조하지 않게
  useEffect(() => () => haltQueue(runRef, stopRef), []);
  useEffect(
    () => () => {
      haltQueue(runRef, stopRef);
      setPlaying(null);
    },
    [scriptKey],
  );

  // 지금 읽는 카드로 화면을 따라간다 — 카드가 바뀔 때만
  useEffect(() => {
    if (activeEntry == null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-entry="${activeEntry}"]`);
    if (!el) return;
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* noop */
    }
    el.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [activeEntry]);

  /** ⚠️ onClick 안에서 **동기로** 부른다(await·setTimeout 금지) — speakQueue가 첫 await 전에 iOS 재생 잠금을 푼다. */
  function startListening() {
    if (script.length === 0) return;
    const run = ++runRef.current;
    const key = scriptKey;
    stopRef.current = null;
    const stop = speakQueue(
      script.map((p) => ({ text: p.text, lang: p.lang })),
      {
        onItem: (i) => {
          if (runRef.current === run) setPlaying({ key, index: i });
        },
        onEnd: () => {
          if (runRef.current !== run) return;
          stopRef.current = null;
          setPlaying(null);
        },
      },
    );
    if (runRef.current === run) stopRef.current = stop;
    if (settingsRef.current) settingsRef.current.open = false; // 커진 sticky 바가 따라가는 카드를 덮지 않게
  }

  function stopListening() {
    haltQueue(runRef, stopRef);
    setPlaying(null);
  }

  // 프리페치(§16) — 카드의 🔊 영어 문장(표현·예문·활용 문장·이어 말하기)을 미리. 키는 문자열(참조 변경으로 재시작하지 않게).
  const prefetchKey = useMemo(
    () =>
      [
        ...entries.map((e) => e.expression),
        ...entries.map((e) => e.example ?? ""),
        ...entries.flatMap((e) => e.points?.useIn.map((u) => u.sentence) ?? []),
      ]
        .map((t) => t.trim())
        .filter((t) => t !== "")
        .join("\u0001"),
    [entries],
  );
  useEffect(() => {
    if (!prefetchKey) return;
    return prefetchSpeech(prefetchKey.split("\u0001"), "en-US");
  }, [prefetchKey]);

  // ── 교재 QUIZ 정답 보기 ──
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  return (
    <div className={s.wrap}>
      {/* 제목 */}
      <div>
        {editing ? (
          <div className={s.titleEdit}>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={titleMax}
              aria-label="표현집 이름"
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
                  setDraft(titleKo);
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
            <h1 className="t-book-title">{titleKo}</h1>
            <button type="button" className="u-btn u-btn-secondary" onClick={() => setEditing(true)} aria-label="표현집 이름 수정">
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
          {dayNo !== null && <span className="u-chip">DAY {dayNo}</span>}
          {topicKo && <span className="u-chip">{topicKo}</span>}
          <span className="u-chip">표현 {entries.length}개</span>
          {quiz.length > 0 && <span className="u-chip">QUIZ {quiz.length}</span>}
          <span className={`u-chip ${missingPoints === 0 ? "u-chip-accent" : ""}`}>
            발화 포인트 {pointsCount}/{entries.length}
          </span>
          {source === "import" && <span className="u-chip">📂 가져옴</span>}
        </p>
      </div>

      {/* 시험 */}
      <div className={s.toolbar}>
        <Link href={`/toeic/sets/${id}/quiz`} className="u-btn u-btn-primary">
          <span aria-hidden>📝</span> 시험 보기
        </Link>
        <Link href={`/toeic/sets/${id}/wrong`} className="u-btn u-btn-secondary">
          <span aria-hidden>📕</span> 오답노트
        </Link>
        <Link href={`/toeic/sets/${id}/history`} className="u-btn u-btn-secondary">
          <span aria-hidden>📊</span> 시험 기록
        </Link>
      </div>

      {/* 발화 포인트 상태 */}
      <div className={s.pointsBox}>
        {missingPoints > 0 ? (
          <>
            <p className={s.pointsText}>
              ✨ 발화 포인트가 없는 표현이 {missingPoints}개 있어요. 문항별로 바로 말할 수 있는 문장·답변 틀·발음 팁을 붙여 드려요.
            </p>
            <button type="button" className="u-btn u-btn-primary" onClick={() => makePoints(false)} disabled={pointsBusy}>
              {pointsBusy ? "만드는 중…" : "✨ 발화 포인트 만들기"}
            </button>
          </>
        ) : points.phase === "confirm" ? (
          <div role="group" aria-label="다시 만들기 확인" className={s.confirm}>
            <p className={s.pointsText}>
              다시 만들면 지금 보는 발화 포인트({entries.length}개 표현)가 새 문장으로 바뀌어요. 다시 만들까요?
            </p>
            <div className={s.row}>
              <button type="button" className="u-btn u-btn-primary" onClick={() => makePoints(true)}>
                다시 만들기
              </button>
              <button type="button" className="u-btn u-btn-secondary" onClick={() => setPoints({ phase: "idle" })}>
                취소
              </button>
            </div>
          </div>
        ) : (
          <div className={s.row}>
            <p className={s.pointsText}>✓ 모든 표현에 발화 포인트가 있어요.</p>
            <button
              type="button"
              className="u-btn u-btn-secondary"
              onClick={() => setPoints({ phase: "confirm" })}
              disabled={pointsBusy}
            >
              {pointsBusy ? "다시 만드는 중…" : "↻ 다시 만들기"}
            </button>
          </div>
        )}
        {points.phase === "loading" && (
          <p role="status" className="t-caption">
            표현 7개씩 나눠 만드는 중이에요. 표현이 많으면 30초쯤 걸려요.
          </p>
        )}
        {points.phase === "done" && (
          <p role="status" className="t-caption">
            {points.message}
          </p>
        )}
        {points.phase === "error" && (
          <p role="alert" className={s.error}>
            {points.message}
          </p>
        )}
      </div>

      {/* 전체 듣기 바 — sticky(스트릭 헤드라인 아래) */}
      <div className={s.bar}>
        <div role="group" aria-label="듣기 방식" className={s.modes}>
          {TOEIC_LISTEN_MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={listenMode === m}
              onClick={() => setListenMode(m)}
              className={`${s.modeChip} ${listenMode === m ? s.modeOn : ""}`}
            >
              {TOEIC_LISTEN_MODE_LABELS_KO[m]}
            </button>
          ))}
        </div>
        <div className={s.barRow}>
          {cur != null ? (
            <button type="button" className="u-btn u-btn-primary" onClick={stopListening}>
              ■ 멈추기
            </button>
          ) : (
            <button type="button" className="u-btn u-btn-primary" onClick={startListening} disabled={script.length === 0}>
              🎧 전체 듣기
            </button>
          )}
          <span className={s.progress} aria-live="polite">
            {cur != null ? `${cur + 1} / ${script.length}` : ""}
          </span>
          <details className={s.settings} ref={settingsRef}>
            <summary className={s.settingsSummary}>⚙️ 소리 설정</summary>
            <div className={s.settingsBody}>
              <TtsSpeedControl />
              <TtsEngineControl lang="en-US" />
              <TtsEngineControl lang="ko-KR" />
            </div>
          </details>
        </div>
      </div>

      {/* 표현 카드 */}
      <ol className={s.list} ref={listRef} aria-label="표현 카드">
        {entries.map((e, i) => {
          const p = e.points;
          return (
            <li key={i} data-entry={i} className={`${s.card} ${activeEntry === i ? s.cardActive : ""}`}>
              <div className={s.exprRow}>
                {e.no !== null && <span className={s.no}>{String(e.no).padStart(2, "0")}</span>}
                <span className={s.expr} lang="en">
                  {e.expression}
                </span>
                <SpeakBtn text={e.expression} label={`${e.expression} 발음`} />
              </div>
              <p className={s.meaning}>{e.meaningKo}</p>

              {e.example && (
                <div className={s.example}>
                  <div className={s.enRow}>
                    <p className={s.exampleEn} lang="en">
                      {highlightSpan(e.example, p?.exampleSpan ?? null)}
                    </p>
                    <SpeakBtn text={e.example} label="예문" />
                  </div>
                  {e.exampleKo && <p className={s.ko}>{e.exampleKo}</p>}
                </div>
              )}

              {p ? (
                <div className={s.points}>
                  <p className={s.core}>
                    <span aria-hidden>💡</span> {p.coreKo}
                  </p>

                  <p className={s.label}>문항별로 이렇게 말해요</p>
                  <ul className={s.useList}>
                    {p.useIn.map((u, k) => (
                      <li key={k} className={s.useItem}>
                        <span className={s.partBadge}>{TOEIC_PART_BADGE_KO[u.part]}</span>
                        <div className={s.enRow}>
                          <p className={s.en} lang="en">
                            {u.sentence}
                          </p>
                          <SpeakBtn text={u.sentence} label="활용 문장" />
                        </div>
                        <p className={s.ko}>{u.sentenceKo}</p>
                      </li>
                    ))}
                  </ul>

                  {p.frames.length > 0 && (
                    <>
                      <p className={s.label}>답변 틀</p>
                      <ul className={s.frames}>
                        {p.frames.map((f, k) => (
                          <li key={k} className={s.frame} lang="en">
                            {renderFrame(f)}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {p.variations.length > 0 && (
                    <>
                      <p className={s.label}>바꿔 쓰기</p>
                      <ul className={s.variations}>
                        {p.variations.map((v, k) => (
                          <li key={k} className={s.variation}>
                            <span className={s.varEn} lang="en">
                              {v.en}
                            </span>
                            <SpeakBtn text={v.en} label={v.en} />
                            <span className={s.varKo}>{v.ko}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  <dl className={s.notes}>
                    <div className={s.note}>
                      <dt>🗣 발음</dt>
                      <dd>{p.pronunciationKo}</dd>
                    </div>
                    {p.pitfallKo && (
                      <div className={s.note}>
                        <dt>⚠️ 함정</dt>
                        <dd>{p.pitfallKo}</dd>
                      </div>
                    )}
                    {p.grammarKo && (
                      <div className={s.note}>
                        <dt>📐 문법</dt>
                        <dd>{p.grammarKo}</dd>
                      </div>
                    )}
                  </dl>

                  <p className={s.label}>이어 말하기</p>
                  <div className={s.enRow}>
                    <p className={s.en} lang="en">
                      {p.followUp.en}
                    </p>
                    <SpeakBtn text={p.followUp.en} label="이어 말하기" />
                  </div>
                  <p className={s.ko}>{p.followUp.ko}</p>
                </div>
              ) : (
                <div className={s.noPoints}>
                  <p className="t-caption">발화 포인트가 아직 없어요.</p>
                  <button type="button" className="u-btn u-btn-secondary" onClick={() => makePoints(false)} disabled={pointsBusy}>
                    {pointsBusy ? "만드는 중…" : "✨ 발화 포인트 만들기"}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* 교재 QUIZ */}
      {quiz.length > 0 && (
        <section aria-label="교재 QUIZ" className={s.quizSection}>
          <h2 className="t-section-title">📝 교재 QUIZ — 우리말을 영어로 말해 보세요</h2>
          <ol className={s.quizList}>
            {quiz.map((q, qi) => {
              const open = revealed.has(qi);
              return (
                <li key={qi} className={s.quizItem}>
                  <p className={s.quizPrompt}>
                    {q.no !== null && <span className={s.no}>Q{q.no}</span>} {q.promptKo}
                  </p>
                  {q.hint && <span className="u-chip">힌트 · {q.hint}</span>}
                  {open ? (
                    <div className={s.answer}>
                      <div className={s.enRow}>
                        <p className={s.en} lang="en">
                          {q.modelAnswer}
                        </p>
                        <SpeakBtn text={q.modelAnswer} label="모범답변" />
                      </div>
                      {q.keyExpressions.length > 0 && (
                        <p className="t-caption flex flex-wrap gap-1">
                          {q.keyExpressions.map((k) => (
                            <span key={k} className="u-chip u-chip-accent" lang="en">
                              {k}
                            </span>
                          ))}
                        </p>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="u-btn u-btn-secondary"
                      onClick={() => {
                        setRevealed((prev) => new Set(prev).add(qi));
                        speakEn(q.modelAnswer); // 탭 안에서 — iOS 재생 잠금 규칙
                      }}
                    >
                      정답 보기 🔊
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
