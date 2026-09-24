"use client";

/**
 * 대화 학습 해설 (아빠의 일본어 J4·J5) — 총평·잘한 점·고칠 점·어휘·다음 연습. 검토 화면(dialogId 없음)·상세(있음) 공용.
 * dialogId가 있으면 어휘마다 **"단어장에 담기"**(J5, "대화에서 모은 단어"로) 버튼을 붙인다. 후리가나 ja-ruby, 🔊 ja-JP.
 *
 * 해설 낭독(SPEC §18-4):
 * - 맨 위 sticky **해설 듣기 바** — "🎧 해설 전체 듣기" / 재생 중 "■ 멈추기" + 진행(조각 기준 `i / n`). 소리 설정은 <details> 안.
 * - 섹션 제목 옆 ▶ = 그 섹션부터 이어 듣기. 재생 중인 카드(섹션·item)를 강조하고 화면을 따라간다.
 * - 일본어 문장마다 🔊(단발). 누르면 speak()의 토큰 규약으로 이어 읽기가 멈춘다.
 * 대본은 lib/ja-coaching-script.ts(순수 함수)가 만들고, 재생은 lib/speech.ts의 speakQueue가 한다 — 화면은 판단하지 않는다.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import JaRuby from "@/components/ja-ruby";
import TtsEngineControl from "@/components/tts-engine-control";
import TtsSpeedControl from "@/components/tts-speed-control";
import { buildCoachingScript, coachingJaTexts, type ScriptSection } from "@/lib/ja-coaching-script";
import { prefetchSpeech, speak, speakQueue } from "@/lib/speech";
import type { JaDialogAddWordResponse, JaDialogCoaching } from "@/lib/japanese-dialog-contract";
import s from "./ja-dialog-coaching-view.module.css";

function speakJa(text: string) {
  if (text.trim()) speak(text, "ja-JP");
}

type AddState = { phase: "idle" | "loading" | "added" | "dup" | "error"; msg?: string };

/** 섹션 제목(화면 표기). 낭독 제목은 대본(lib/ja-coaching-script.ts)이 따로 갖는다. */
const SECTION_LABEL: Record<ScriptSection, string> = {
  summary: "총평",
  goods: "👍 잘한 점",
  fixes: "💡 고칠 점",
  items: "📖 어휘",
  practice: "✏️ 다음 연습",
};
const SECTION_NAME: Record<ScriptSection, string> = {
  summary: "총평",
  goods: "잘한 점",
  fixes: "고칠 점",
  items: "어휘",
  practice: "다음 연습",
};

/** 재생 중인 실행을 무효화하고 큐를 멈춘다(큐가 돌려준 stop — 말풍선 🔊까지 죽이는 stopSpeaking()을 쓰지 않는다). */
function haltQueue(runRef: RefObject<number>, stopRef: RefObject<(() => void) | null>) {
  runRef.current++;
  const stop = stopRef.current;
  stopRef.current = null;
  stop?.();
}

export default function JaDialogCoachingView({
  coaching,
  dialogId,
  prefetch = true,
}: {
  coaching: JaDialogCoaching;
  /** 저장된 대화면 담기 버튼을 켠다(J5). 검토 단계(미저장)면 undefined */
  dialogId?: string;
  /**
   * 해설 일본어 문장 프리페치(기본 true). 부모가 전사와 **한 번에** 프리페치하면 false로 끈다(§18-5) —
   * prefetchSpeech는 새 배치가 오면 직전 배치를 끊는데, 효과는 자식→부모 순이라 여기 것이 항상 끊긴다.
   */
  prefetch?: boolean;
}) {
  const router = useRouter();
  const [addStates, setAddStates] = useState<Record<number, AddState>>({});

  // ── 해설 낭독 대본 ──
  const script = useMemo(() => buildCoachingScript(coaching), [coaching]);
  /** 대본 **내용** 키 — router.refresh()("단어장에 담기")로 참조만 바뀌면 같다. 해설 "다시 만들기"면 달라진다. */
  const scriptKey = useMemo(() => script.map((p) => p.lang + "|" + p.text).join("\n"), [script]);
  const sectionStart = useMemo(() => {
    const m = new Map<ScriptSection, number>();
    script.forEach((p, i) => {
      if (!m.has(p.section)) m.set(p.section, i);
    });
    return m;
  }, [script]);

  /** 실행 번호 — 옛 실행의 onItem/onEnd를 무시한다(큐의 토큰 규약 위 이중 안전장치). */
  const runRef = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);
  /** 재생 위치(대본 절대 인덱스). 대본 키가 다르면(해설이 바뀜) 무효로 본다. */
  const [playing, setPlaying] = useState<{ key: string; index: number } | null>(null);
  const cur = playing && playing.key === scriptKey && playing.index < script.length ? playing.index : null;
  const curPiece = cur != null ? script[cur] : null;
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const hasBar = script.length > 0;

  // 프리페치(§16·§18-5): 해설의 일본어 문장(인용·원문·고친 문장·어휘·연습)을 미리 받아 🔊 첫 재생을 즉시로.
  // 의존성은 배열 참조가 아니라 문자열 키 — refresh로 참조만 바뀌면 다시 시작하지 않는다(중단된 합성 요금 낭비 방지).
  const jaKey = useMemo(() => coachingJaTexts(coaching).join("\u0001"), [coaching]);
  useEffect(() => {
    if (!prefetch || !jaKey) return;
    return prefetchSpeech(jaKey.split("\u0001"), "ja-JP");
  }, [prefetch, jaKey]);

  // 정지 조건 ① 화면을 떠나면 멈춘다.
  useEffect(() => () => haltQueue(runRef, stopRef), []);
  // 정지 조건 ② 대본 내용이 바뀌면(해설 "다시 만들기") 멈춘다 — 옛 대본을 계속 읽으며 새 카드를 강조하지 않게.
  // 재생 위치도 비운다: 안 비우면 키가 옛 값으로 되돌아올 때(A→B→A) 아무것도 안 나오는데 "■ 멈추기"가 뜬다.
  useEffect(
    () => () => {
      haltQueue(runRef, stopRef);
      setPlaying(null);
    },
    [scriptKey],
  );

  // 듣기 바의 **실제 높이**를 CSS 변수(--coach-bar-h)로 — 자동 스크롤된 카드가 바 밑에 숨지 않게 scroll-margin이 쓴다.
  // 고정값(64px)이면 "⚙️ 소리 설정"을 연 채 재생할 때(바가 크게 자람)나 좁은 화면에서 줄이 바뀔 때 카드가 가려진다.
  useEffect(() => {
    const bar = barRef.current;
    const wrap = wrapRef.current;
    if (!hasBar || !bar || !wrap || typeof ResizeObserver === "undefined") return;
    const apply = () => wrap.style.setProperty("--coach-bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [hasBar]);

  // 재생 중인 카드로 화면을 따라간다 — (섹션, item)이 바뀔 때만(쪼갠 조각끼리는 안 움직인다).
  const activeKey = curPiece ? `${curPiece.section}:${curPiece.item ?? "title"}` : "";
  useEffect(() => {
    if (!activeKey) return;
    const [sec, item] = activeKey.split(":");
    const el = wrapRef.current?.querySelector<HTMLElement>(`[data-sec="${sec}"][data-item="${item}"]`);
    if (!el) return;
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* noop */
    }
    el.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [activeKey]);

  /**
   * start번째 조각부터 이어 듣기. ⚠️ **onClick 안에서 동기로** 부른다(await·setTimeout 금지) —
   * speakQueue가 첫 await 전에 iOS 재생 잠금을 풀어야 한다.
   */
  function startFrom(start: number) {
    if (start < 0 || start >= script.length) return;
    const run = ++runRef.current;
    const key = scriptKey;
    stopRef.current = null; // 옛 큐는 speakQueue 안에서 끊긴다(옛 onEnd는 실행 번호로 무시)
    const stop = speakQueue(
      script.slice(start).map((p) => ({ text: p.text, lang: p.lang })),
      {
        onItem: (i) => {
          if (runRef.current === run) setPlaying({ key, index: start + i });
        },
        onEnd: () => {
          if (runRef.current !== run) return;
          stopRef.current = null;
          setPlaying(null);
        },
      },
    );
    if (runRef.current === run) stopRef.current = stop;
    // 소리 설정을 연 채 재생을 시작하면 접는다 — 커진 sticky 바가 따라가는 카드를 덮지 않게(재생 중 다시 열 수 있다).
    if (settingsRef.current) settingsRef.current.open = false;
  }

  function stopPlayback() {
    haltQueue(runRef, stopRef);
    setPlaying(null);
  }

  const isActive = (sec: ScriptSection, item: number) => curPiece?.section === sec && curPiece.item === item;
  const titleActive = (sec: ScriptSection) => curPiece?.section === sec && curPiece.item === null;

  /** 섹션 제목 + ▶(그 섹션부터 듣기). 컴포넌트가 아니라 렌더 헬퍼 — 재생 중 매 조각마다 다시 그려도 버튼이 재마운트되지 않게. */
  function sectionHead(sec: ScriptSection) {
    const start = sectionStart.get(sec);
    return (
      <div className={s.secHead} data-sec={sec} data-item="title">
        <h3 className={`${s.h} ${titleActive(sec) ? s.hActive : ""}`}>{SECTION_LABEL[sec]}</h3>
        {start !== undefined && (
          <button type="button" className={s.secPlay} onClick={() => startFrom(start)} aria-label={`${SECTION_NAME[sec]}부터 듣기`}>
            ▶
          </button>
        )}
      </div>
    );
  }

  /** 일본어 문장 옆 🔊(단발 재생). 렌더 헬퍼(위와 같은 이유). */
  function jaSpeak(text: string) {
    if (!text.trim()) return null;
    return (
      <button type="button" className={s.speak} onClick={() => speakJa(text)} aria-label={`${text} 발음 듣기`}>
        🔊
      </button>
    );
  }

  async function addWord(itemIndex: number) {
    if (!dialogId) return;
    if (addStates[itemIndex]?.phase === "loading") return;
    setAddStates((p) => ({ ...p, [itemIndex]: { phase: "loading" } }));
    try {
      const res = await fetch(`/api/japanese/dialog/${dialogId}/add-word`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemIndex }),
      });
      const data = (await res.json()) as JaDialogAddWordResponse;
      if (data.ok) {
        setAddStates((p) => ({ ...p, [itemIndex]: { phase: data.added ? "added" : "dup" } }));
        router.refresh();
      } else {
        setAddStates((p) => ({ ...p, [itemIndex]: { phase: "error", msg: data.messageKo } }));
      }
    } catch {
      setAddStates((p) => ({ ...p, [itemIndex]: { phase: "error", msg: "담지 못했어요." } }));
    }
  }

  return (
    <div className={s.wrap} ref={wrapRef}>
      {/* 해설 듣기 바 — sticky(스트릭 헤드라인 아래). 자동 스크롤이 카드를 따라가도 ■ 멈추기가 화면에 남는다. */}
      {hasBar && (
        <div className={s.bar} ref={barRef}>
          {cur != null ? (
            <button type="button" className="u-btn u-btn-primary" onClick={stopPlayback}>
              ■ 멈추기
            </button>
          ) : (
            <button type="button" className="u-btn u-btn-primary" onClick={() => startFrom(0)}>
              🎧 해설 전체 듣기
            </button>
          )}
          <span className={s.progress} aria-live="polite">
            {cur != null ? `${cur + 1} / ${script.length}` : ""}
          </span>
          <details className={s.settings} ref={settingsRef}>
            <summary className={s.settingsSummary}>⚙️ 소리 설정</summary>
            <div className={s.settingsBody}>
              <TtsSpeedControl />
              <TtsEngineControl lang="ko-KR" />
              <TtsEngineControl lang="ja-JP" />
              <p className={s.settingsNote}>화면을 끄고 들으려면 일본어도 클라우드로 — 기기 음성은 화면이 꺼지면 멈춰요.</p>
            </div>
          </details>
        </div>
      )}

      {coaching.summaryKo && (
        <section className={`${s.summary} ${isActive("summary", 0) ? s.active : ""}`} data-sec="summary" data-item="0">
          {sectionHead("summary")}
          <p className={s.summaryText}>{coaching.summaryKo}</p>
        </section>
      )}

      {coaching.goods.length > 0 && (
        <section>
          {sectionHead("goods")}
          <ul className={s.list}>
            {coaching.goods.map((g, i) => (
              <li key={i} className={`${s.good} ${isActive("goods", i) ? s.active : ""}`} data-sec="goods" data-item={i}>
                <div className={s.jaRow}>
                  <span className={s.quote} lang="ja">
                    {g.quoteJa}
                  </span>
                  {jaSpeak(g.quoteJa)}
                </div>
                <span className={s.why}>{g.whyKo}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {coaching.fixes.length > 0 && (
        <section>
          {sectionHead("fixes")}
          <ul className={s.list}>
            {coaching.fixes.map((f, i) => (
              <li key={i} className={`${s.fix} ${isActive("fixes", i) ? s.active : ""}`} data-sec="fixes" data-item={i}>
                {/* 원문(취소선 그대로)과 고친 문장을 귀로 대조할 수 있게 둘 다 🔊 */}
                <div className={s.jaRow}>
                  <span className={s.fixOrig} lang="ja">
                    {f.originalJa}
                  </span>
                  {jaSpeak(f.originalJa)}
                </div>
                <span className={s.arrow} aria-hidden>
                  ↓
                </span>
                <div className={s.jaRow}>
                  <span className={s.fixBetter} lang="ja">
                    {f.betterJa}
                  </span>
                  {jaSpeak(f.betterJa)}
                </div>
                <span className={s.why}>{f.whyKo}</span>
                {f.grammarKo && <span className={s.grammar}>문법: {f.grammarKo}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {coaching.items.length > 0 && (
        <section>
          {sectionHead("items")}
          <ul className={s.list}>
            {coaching.items.map((it, i) => {
              const st = addStates[i];
              return (
                <li key={i} className={`${s.item} ${isActive("items", i) ? s.active : ""}`} data-sec="items" data-item={i}>
                  <div className={s.itemMain}>
                    <JaRuby
                      tokens={it.wordTokens.length > 0 ? it.wordTokens : [{ surface: it.word, reading: null }]}
                      className={s.itemWord}
                    />
                    <button type="button" className={s.speak} onClick={() => speakJa(it.word)} aria-label={`${it.word} 발음 듣기`}>
                      🔊
                    </button>
                    <span className={s.itemMeaning}>{it.meaningKo}</span>
                  </div>
                  {it.usageKo && <p className={s.itemUsage}>{it.usageKo}</p>}
                  {dialogId && (
                    <div className={s.itemAdd}>
                      {st?.phase === "added" ? (
                        <span className={s.added}>✓ 단어장에 담았어요</span>
                      ) : st?.phase === "dup" ? (
                        <span className={s.added}>이미 담겨 있어요</span>
                      ) : (
                        <button
                          type="button"
                          className="u-btn u-btn-secondary"
                          onClick={() => addWord(i)}
                          disabled={st?.phase === "loading"}
                        >
                          {st?.phase === "loading" ? "담는 중…" : "➕ 단어장에 담기"}
                        </button>
                      )}
                      {st?.phase === "error" && <span className={s.err}>{st.msg}</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {coaching.practice.length > 0 && (
        <section>
          {sectionHead("practice")}
          <ul className={s.list}>
            {coaching.practice.map((p, i) => (
              <li key={i} className={`${s.practice} ${isActive("practice", i) ? s.active : ""}`} data-sec="practice" data-item={i}>
                <div className={s.jaRow}>
                  <JaRuby tokens={p.tokens.length > 0 ? p.tokens : [{ surface: p.ja, reading: null }]} className={s.practiceJa} />
                  {jaSpeak(p.ja)}
                </div>
                {p.ko && <span className={s.practiceKo}>{p.ko}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
