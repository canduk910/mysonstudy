"use client";

/**
 * 문제 직접 입력 → 3막 설명 (M1) — `/math/new` 화면의 본체.
 *
 * 흐름: 입력 폼 → `POST /api/math/explain` → 결과를 **같은 화면에서** 교체 렌더.
 * 결과 화면으로 라우팅하지 않고 상태로만 전환한다 — 기다린 30초 끝에 화면이 통째로
 * 바뀌면 "다시 만드나?" 싶어진다. 대신 결과 아래에 보관된 기록으로 가는 링크를 둔다.
 *
 * [M4] 라우트가 만든 설명을 `explanations`에 자동 저장하므로 결과가 더 이상 새로고침과
 * 함께 사라지지 않는다. 응답의 `id`가 그 기록의 주소(`/math/problem/[id]`)이고,
 * 목록은 `/math/library`에 있다. **저장은 best-effort라 `id`가 null일 수 있다** —
 * 그때도 화면의 설명은 온전하다(§9-3).
 *
 * 입력 3칸은 HARNESS §3-2 사용자 메시지 템플릿의 슬롯이다:
 *   문장(필수) · 그림 설명(선택) · 아이가 쓴 답(선택)
 * `번호`·`주어진 숫자`·`아이가 쓴 풀이`는 사진 판독(M3)이 채울 자리라 폼에 두지 않았다
 * (템플릿은 빈 값을 "없음"으로 채운다).
 *
 * 디자인: 새 CSS 없음 — `u-input`·`u-label`·`u-btn`·`u-box*`·`t-*`만 쓴다.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type {
  MathExplainRequest,
  MathExplainResponse,
  MathExplainSuccess,
} from "@/lib/math-explain-contract";
import MathExplanationView from "./math-explanation-view";

type Phase = "form" | "loading" | "done";

/** 예시 문제 — 은우가 실제로 틀린 문제(docs/harness/math.md §0). 빈 화면 앞에서 막히지 않게 */
const SAMPLE = {
  text: "자와 지우개를 합한 값이 900원입니다. 자는 지우개보다 300원 더 비쌉니다. 자와 지우개는 각각 얼마일까요?",
  childAnswer: "자 450원, 지우개 150원",
};

export default function MathExplainForm() {
  const [phase, setPhase] = useState<Phase>("form");
  const [text, setText] = useState("");
  const [figureDesc, setFigureDesc] = useState("");
  const [childAnswer, setChildAnswer] = useState("");

  const [result, setResult] = useState<MathExplainSuccess | null>(null);
  /** 결과 화면에 문제 문장을 나란히 보여주기 위해 보낸 값을 그대로 붙들어 둔다 */
  const [askedText, setAskedText] = useState("");

  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [elapsedSec, setElapsedSec] = useState(0);

  const topRef = useRef<HTMLDivElement>(null);

  // 경과 시간 — B와 C를 함께 돌리고 어긋나면 한 번 더 푸는 구조라 30초 안팎이 걸린다.
  // 숫자가 올라가는 것만 보여도 "멈춘 건가?" 하는 불안이 크게 줄어든다.
  useEffect(() => {
    if (phase !== "loading") return;
    setElapsedSec(0);
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // 결과가 나오면 화면 맨 위로 — 긴 폼 아래에 설명이 붙으면 스크롤을 놓친다
  useEffect(() => {
    if (phase === "done") topRef.current?.scrollIntoView({ block: "start" });
  }, [phase]);

  async function run() {
    const problem = text.trim();
    if (!problem) {
      setErrorKo("문제 문장을 적어 주세요.");
      setCanRetry(false);
      setIssues([]);
      return;
    }

    setPhase("loading");
    setErrorKo(null);
    setCanRetry(false);
    setIssues([]);
    setAskedText(problem);

    const body: MathExplainRequest = {
      text: problem,
      figureDesc: figureDesc.trim() || null,
      childAnswer: childAnswer.trim() || null,
    };

    try {
      const res = await fetch("/api/math/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as MathExplainResponse | null;

      if (data?.ok) {
        setResult(data);
        setPhase("done");
        return;
      }

      // 실패는 전부 여기로 모인다 (400 검증 / 500 재시도 소진 / 501 키 없음 / 401 잠금)
      setErrorKo(
        data?.messageKo ?? "설명을 만들지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
      setCanRetry(data?.retriable === true || res.status >= 500);
      setIssues(data && !data.ok ? (data.issues ?? []).map((i) => i.message) : []);
      setPhase("form");
    } catch {
      // 네트워크 끊김 — 서버까지 못 갔으므로 다시 눌러 볼 값어치가 있다
      setErrorKo("인터넷 연결을 확인한 뒤 다시 시도해 주세요.");
      setCanRetry(true);
      setPhase("form");
    }
  }

  function reset() {
    setPhase("form");
    setResult(null);
    setErrorKo(null);
    setCanRetry(false);
    setIssues([]);
  }

  // ---------------------------------------------------------------------
  // 결과 화면
  // ---------------------------------------------------------------------
  if (phase === "done" && result) {
    return (
      <div ref={topRef}>
        <MathExplanationView problemText={askedText} result={result} />

        <div className="mt-10 flex flex-wrap gap-2">
          <button type="button" onClick={reset} className="u-btn u-btn-primary">
            ✏️ 다른 문제 풀어보기
          </button>
          <Link href="/math" className="u-btn u-btn-secondary">
            🔢 수학 홈으로
          </Link>
        </div>
        {/*
         * [QA P3-8] 저장 결과를 알린다. 라우트는 설명을 만들자마자 `explanations`에
         * 자동 저장하고 그 기록의 주소를 `id`로 돌려준다(§9-3).
         *
         * **`id`가 null이면 저장이 실패한 것이다** — 저장은 best-effort라 화면을 죽이지
         * 않는다. 그래도 담담하게 알려야 한다. 알리지 않으면 부모가 나중에 서재에서
         * 찾다가 없는 것을 앱의 배신으로 읽는다.
         */}
        {result.id ? (
          <p className="t-caption mt-3">
            ✅ 이 설명은 보관됐어요 →{" "}
            <Link
              href={`/math/problem/${result.id}`}
              className="font-medium text-accent underline"
            >
              보기
            </Link>{" "}
            · <Link href="/math/library" className="font-medium text-accent underline">
              지난 문제 모아 보기
            </Link>
          </p>
        ) : (
          <p className="t-caption mt-3">
            🗒️ 이번 건은 보관하지 못했어요. 화면의 설명은 그대로예요 — 새로고침하면
            사라지니, 필요하면 지금 보여 주세요.
          </p>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // 입력 폼 / 만드는 중
  // ---------------------------------------------------------------------
  const busy = phase === "loading";

  return (
    <div ref={topRef}>
      {busy && (
        <div className="u-box-accent mb-6" role="status" aria-live="polite">
          <p className="t-list-title">🧠 열심히 생각하고 있어요…</p>
          <p className="t-question-ko mt-1 text-ink">
            설명을 만들고, 답이 맞는지 따로 한 번 더 풀어 보는 중이에요. 30초쯤 걸려요.
          </p>
          <p className="t-caption mt-2">{elapsedSec}초 지났어요</p>
        </div>
      )}

      {errorKo && (
        <div className="u-box mb-6 border border-line-strong" role="alert">
          <p className="t-question-ko text-ink">😥 {errorKo}</p>
          {issues.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {issues.map((issue, i) => (
                <li key={i} className="t-caption">
                  · {issue}
                </li>
              ))}
            </ul>
          )}
          {canRetry && (
            <button type="button" onClick={run} className="u-btn u-btn-secondary mt-3">
              🔄 다시 만들기
            </button>
          )}
        </div>
      )}

      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div>
          <label htmlFor="m-text" className="u-label">
            문제 문장 *
          </label>
          <textarea
            id="m-text"
            rows={5}
            required
            disabled={busy}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="u-input"
            placeholder="문제집에 있는 문장을 그대로 옮겨 적어 주세요."
          />
          <p className="t-caption mt-2">
            문장을 빠뜨리지 않고 그대로 적을수록 설명이 정확해져요. 숫자도 문장 안에
            그대로 두면 돼요.
          </p>
        </div>

        <div>
          <label htmlFor="m-figure" className="u-label">
            그림 · 표 설명 (선택)
          </label>
          <textarea
            id="m-figure"
            rows={2}
            disabled={busy}
            value={figureDesc}
            onChange={(e) => setFigureDesc(e.target.value)}
            className="u-input"
            placeholder="예: 통 가·나·다 그림, 아래는 각각 5L"
          />
          <p className="t-caption mt-2">
            문제에 그림이나 표가 있으면 보이는 대로 적어 주세요. 그림 속 숫자도요.
          </p>
        </div>

        <div>
          <label htmlFor="m-child" className="u-label">
            은우가 쓴 답 (선택)
          </label>
          <input
            id="m-child"
            disabled={busy}
            value={childAnswer}
            onChange={(e) => setChildAnswer(e.target.value)}
            className="u-input"
            placeholder="예: 자 450원, 지우개 150원"
          />
          <p className="t-caption mt-2">
            적어 주시면 어디가 맞았고 어디를 다시 보면 좋은지 함께 알려드려요. 비워 두면
            채점 없이 설명만 만들어요.
          </p>
        </div>

        <button type="submit" disabled={busy} className="u-btn u-btn-primary w-full">
          {busy ? "만드는 중이에요…" : "🪄 설명 만들기"}
        </button>
      </form>

      {!busy && (
        <div className="mt-8">
          <p className="t-caption">무엇을 적어야 할지 모르겠다면</p>
          <button
            type="button"
            className="u-btn u-btn-secondary mt-2"
            onClick={() => {
              setText(SAMPLE.text);
              setChildAnswer(SAMPLE.childAnswer);
              setFigureDesc("");
              setErrorKo(null);
            }}
          >
            📝 예시 문제 넣어보기
          </button>
        </div>
      )}
    </div>
  );
}
