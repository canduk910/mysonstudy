/**
 * 수학 3막 설명 화면 (M1) — `POST /api/math/explain` 결과를 그리는 표현 전용 컴포넌트.
 *
 * 구성 순서(개발 프롬프트 §4-3 + math.md §10-4):
 *   문제 헤더(유형 칩·채점 배지·보류 배지) → 한 줄 비유 → **1막 탐정 시간** →
 *   2막 되감기(단계 카드) → 3막 다시 재생(검사) → 🎬 되감기 플레이어(2단, 있을 때만) →
 *   💡 다른 방법도 있어요(insight · 접힘, 있을 때만) → 엄빠 티칭 포인트 → 규칙 카드
 *
 * ── 두 가지 설계 원칙 ───────────────────────────────────────────────────────
 * 1) **1막이 가장 또렷하다.** 이 아이는 계산이 아니라 "문장 → 식" 단계에서 무너진다
 *    (docs/harness/math.md §0 — 900원 문제에서 차 조건을 빼먹고 반씩 나눔).
 *    그래서 1막만 u-card + 컬러바를 쓰고, 움직임 화살표 문장을 화면에서 가장 큰
 *    본문 글자(20px)로 둔다. 2막 단계는 일부러 더 작게(16px) 간다 —
 *    풀이를 잘게 쪼개는 것보다 구조를 보여 주는 쪽이 이 아이에게 값어치가 크다.
 * 2) **`held`는 실패가 아니라 정직한 보류다.** 답은 접고 설명은 보여준다.
 *    틀린 답을 자신 있게 보여주면 아이가 그대로 배운다 — 이 앱의 핵심 안전장치다.
 *
 * ── 디자인 ─────────────────────────────────────────────────────────────────
 * 새 CSS 파일 없음. `app/globals.css`의 토큰(`u-*`·`t-*`)과 그 토큰에서 생성된
 * Tailwind 유틸(text-ink, bg-accent, border-line …)만 쓴다. 하드코딩 색·크기 0건.
 * 위계는 색이 아니라 **글자 크기**로 만든다(DESIGN §4).
 * 파랑(accent)은 강조 셋에만 — 보류 배너 / 1막의 "조심!" / 엄빠 티칭 포인트.
 *
 * 이 파일 자체는 클라이언트 전용 API를 쓰지 않아 "use client" 지시자가 없다. 저장된
 * 설명(`/math/problem/[id]`)에서는 서버에서 그려지고, `/math/new`에서는 호출부가
 * 클라이언트라 함께 번들된다 — 두 경로가 **같은 뷰 한 벌**을 쓰는 것이 요점이다.
 * 되감기 플레이어만 클라이언트가 필요해(`<MathScenePlayer>`: iframe·postMessage·타이머)
 * 그 조각에만 "use client"를 두었다. 이 파일을 클라이언트로 올리면 저장된 설명이
 * 서버 렌더를 잃는다 — 경계는 여기가 아니라 플레이어에 둔다.
 *
 * `lib/ai/*`는 **타입만** import한다 — 값 import는 openai·API 키를 클라이언트 번들로
 * 끌고 들어온다.
 */

import type { HeldReason } from "@/lib/ai/math/pipeline";
import type { MathExplainSuccess } from "@/lib/math-explain-contract";
// 채점 배지 문구는 목록 화면과 **한 정의처**를 공유한다 (lib/math-labels.ts)
import { GRADE_BADGE } from "@/lib/math-labels";
import type { SceneTier } from "@/lib/scene/types";
import MathScenePlayer from "./math-scene-player";

// ---------------------------------------------------------------------------
// 라벨 표 — 화면 문구는 전부 여기 모아 둔다
// ---------------------------------------------------------------------------

/**
 * 보류 사유별 안내. `HeldReason`을 키로 한 Record라 파이프라인이 사유를 늘리면
 * **여기서 컴파일이 깨진다** — 문구 없는 사유가 화면에서 조용히 사라지지 않게.
 */
const HELD_REASON_TEXT: Record<HeldReason, { emoji: string; ko: string; why: string }> = {
  "answer-mismatch": {
    emoji: "🤔",
    ko: "답이 두 번 다르게 나왔어요",
    why: "설명을 만든 AI와, 문제만 보고 따로 푼 AI의 답이 서로 달랐어요.",
  },
  "verifier-unsolvable": {
    emoji: "🧩",
    ko: "검산이 답을 정하지 못했어요",
    why: "문제 문장만으로는 답을 확정할 수 없다고 했어요. 문장이나 그림 설명을 조금 더 채우면 나아질 수 있어요.",
  },
  "verifier-failed": {
    emoji: "📵",
    ko: "검산을 하지 못했어요",
    why: "두 번째 계산이 실패해서 확인할 수가 없었어요. 잠시 후 다시 만들어 보세요.",
  },
  "low-confidence": {
    emoji: "😥",
    ko: "AI가 스스로 자신 없어 해요",
    why: "설명을 만든 AI가 답에 확신이 없다고 했어요.",
  },
};

/**
 * 그림 준비 상태 안내 — **그림을 실제로 못 그릴 때만** 쓴다.
 *
 * `html`(2단)은 이 표를 타지 않는다. 그림이 3막 아래에 실물로 뜨므로 "준비 중" 안내를
 * 함께 띄우면 같은 화면이 두 말을 하게 된다. `typed`(1단 전용 렌더러)는 아직 그리는
 * 화면이 없어 안내가 남아 있고, `none`은 그림 자체가 없다.
 */
const SCENE_TIER_TEXT: Record<Exclude<SceneTier, "html">, { ko: string; detail: string }> = {
  typed: {
    ko: "전용 그림(1단) 대본이 준비됐어요",
    detail:
      "숫자 검산까지 통과한 그림 대본이 있어요. 이걸 움직이는 그림으로 그리는 화면은 다음 단계(M2)에서 붙어요.",
  },
  none: {
    ko: "이번 문제는 그림 대본이 없어요",
    detail: "글 설명만으로도 충분한 문제이거나, 그림으로 옮기기 어려운 문제예요.",
  },
};

// ---------------------------------------------------------------------------
// 조각 컴포넌트
// ---------------------------------------------------------------------------

/** 막 배지. 1막만 꽉 찬 파랑 — 화면에서 무게 중심이 어디인지 한눈에 보이게 */
function ActBadge({ n, filled }: { n: string; filled?: boolean }) {
  return (
    <span className={`u-chip ${filled ? "border-accent bg-accent text-bg" : "u-chip-accent"}`}>
      {n}
    </span>
  );
}

function AnswerChips({ items }: { items: MathExplainSuccess["content"]["answer"] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {items.map((a, i) => (
        <li key={i} className="u-chip u-chip-accent text-question-ko">
          {a.label} = {a.value}
          {a.unit ?? ""}
        </li>
      ))}
    </ul>
  );
}

/**
 * 보류 배너 — 화면에서 가장 먼저 눈에 들어와야 한다.
 *
 * 노란색을 쓰지 않은 이유: 디자인 토큰에 경고용 노랑이 없다(DESIGN §2는 파랑 하나 +
 * 삭제 전용 빨강). 새 색을 만드는 대신 **컬러바를 두른 카드 + ⚠️ 이모지 + 18px 굵은 제목**
 * 으로 시선을 잡는다. 색이 아니라 형태·크기로 세우는 것이 이 디자인 시스템의 방식이다.
 */
function HeldBanner({ verify, uncertaintyNote }: {
  verify: MathExplainSuccess["verify"];
  uncertaintyNote: string | null;
}) {
  /*
   * 첫 문장은 실제 사유에 맞춘다. "두 번 계산해 봤는데 달랐어요"를 검산이 아예 실패한
   * 경우에도 쓰면, 앱이 하지 않은 일을 했다고 말하는 셈이 된다 — 이 화면은 정직함이
   * 전부라 여기서 대충 쓰면 배지의 신뢰가 깎인다.
   */
  const leadKo = verify.heldReasons.includes("answer-mismatch")
    ? "답을 두 번 계산해 봤는데 서로 달랐어요."
    : verify.heldReasons.includes("verifier-failed") ||
        verify.heldReasons.includes("verifier-unsolvable")
      ? "답이 맞는지 한 번 더 확인해 보려 했는데, 확인이 되지 않았어요."
      : "설명을 만든 AI가 답에 확신이 없다고 했어요.";

  return (
    <section className="u-card mt-4 border-line-strong" role="status">
      <div className="u-cardbar" />
      <div className="p-4 sm:p-5">
        <h2 className="t-section-title">⚠️ 엄빠가 한 번 확인해 주세요</h2>
        <p className="t-question-ko mt-2 text-ink">
          {leadKo} 틀린 답을 알려주면 안 되니까 <b>답은 아래에 접어 두었어요.</b> 설명은
          그대로 읽어도 좋아요.
        </p>

        <ul className="mt-3 flex flex-col gap-2">
          {verify.heldReasons.map((reason) => {
            const t = HELD_REASON_TEXT[reason];
            return (
              <li key={reason} className="u-box">
                <p className="t-list-title">
                  {t.emoji} {t.ko}
                </p>
                <p className="t-caption mt-1">{t.why}</p>
              </li>
            );
          })}
        </ul>

        {uncertaintyNote && (
          <p className="t-caption mt-3">
            🗒️ AI 메모: {uncertaintyNote}
          </p>
        )}
        <p className="t-caption mt-2">
          {verify.attempts === 2 && !verify.answerMatch
            ? "한 번 더 풀어 보게 했는데도 답이 모이지 않았어요."
            : "설명을 만든 뒤 답을 한 번 더 검산했어요."}
        </p>
      </div>
    </section>
  );
}

/**
 * 답 — `ok`면 펼쳐서, `held`면 접어서 보여준다(§5-3 "답은 접어 둔다").
 *
 * 접는 자리를 한 곳으로 모은 이유: 답이 화면 여러 곳에 흩어지면 보류일 때 한 군데를
 * 빠뜨리기 쉽다.
 *
 * **보류 건은 채점을 아예 내지 않는다**(QA P3-5 — 목록 화면과 같은 규칙). `held`는 AI가
 * 자기 답을 확신하지 못한 상태다. 그 답을 기준으로 매긴 채점을 "틀렸어요"로 아이에게
 * 내미는 것은 이 앱의 핵심 안전장치(§5-3)와 어긋난다 — 접어 둔 안쪽이라도 마찬가지다.
 * 그 자리는 위쪽 "⚠️ 엄빠가 한 번 확인해 주세요" 배너가 맡는다.
 */
function AnswerBlock({ content, verify }: {
  content: MathExplainSuccess["content"];
  verify: MathExplainSuccess["verify"];
}) {
  if (verify.status === "ok") {
    return (
      <div className="u-box mt-4">
        <p className="u-label">✅ 답</p>
        <p className="text-question-en font-medium text-ink">{content.answerText}</p>
        <AnswerChips items={content.answer} />
      </div>
    );
  }

  return (
    <details className="u-box mt-4">
      <summary className="t-list-title cursor-pointer">
        🔒 답은 접어 두었어요 — 엄빠가 확인한 뒤 펼쳐 주세요
      </summary>
      <p className="t-caption mt-2">
        아래 두 답이 서로 다르거나 확인되지 않았어요. 어느 쪽이 맞는지 엄빠가 봐 주세요.
      </p>

      <p className="u-label mt-3">설명을 만든 AI의 답</p>
      <p className="t-question-ko text-ink">{content.answerText}</p>
      <AnswerChips items={content.answer} />

      <p className="u-label mt-4">따로 푼 AI(검산)의 답</p>
      {verify.checkAnswer && verify.checkAnswer.length > 0 ? (
        <AnswerChips items={verify.checkAnswer} />
      ) : (
        <p className="t-question-ko">답을 내지 못했어요.</p>
      )}
    </details>
  );
}

/**
 * [M5 §10-4] 두 번째 풀이 — **접힌 카드**. 3막 뒤, 엄빠 티칭 포인트 앞에 놓인다.
 *
 * `<details>`/`<summary>`를 쓰는 이유는 두 가지다(§10-4): JS 없이 접힘이 동작하고,
 * 인쇄하면 브라우저가 펼쳐 준다. 기본은 **닫힘** — §10-1의 "지름길을 먼저 가르치지 마라"가
 * 화면 순서와 기본 상태 양쪽에 걸려 있다. 정석(1~3막)을 지나야 여기에 닿는다.
 *
 * 컬러바(`u-cardbar`)를 두르지 않았다: 파랑은 보류 배너·1막의 "조심!"·엄빠 티칭 포인트
 * 셋에만 쓴다. 통찰은 **보너스**라 정석보다 시선을 끌면 안 된다(§10-1).
 * `parentNoteKo`만 `t-parent-hint`(부모용 작은 글자)로 내려 위계를 만든다 —
 * 색이 아니라 크기로 가른다(DESIGN §4).
 */
function InsightCard({ insight }: { insight: NonNullable<MathExplainSuccess["content"]["insight"]> }) {
  return (
    <section className="mt-8">
      <details className="u-card">
        <summary className="t-section-title cursor-pointer p-4 sm:p-5">
          💡 다른 방법도 있어요
        </summary>
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <p className="t-list-title">{insight.titleKo}</p>
          <p className="t-question-ko mt-1 text-ink">{insight.hookKo}</p>

          {/* 2~3단계. 2막 단계 카드와 같은 모양이되 여기서 끝난다(답은 3막 것을 쓴다) */}
          <ol className="mt-3 flex flex-col gap-2">
            {insight.stepsKo.map((step, i) => (
              <li key={i} className="u-box flex items-start gap-3">
                <span className="u-chip u-chip-accent shrink-0">{i + 1}</span>
                <p className="t-question-ko min-w-0 text-ink">{step}</p>
              </li>
            ))}
          </ol>

          <p className="t-parent-hint mt-4">👨‍👩‍👦 {insight.parentNoteKo}</p>
        </div>
      </details>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export default function MathExplanationView({
  problemText,
  result,
}: {
  /** 사용자가 입력한 문제 문장 — 설명과 나란히 두어야 부모가 대조할 수 있다 */
  problemText: string;
  result: MathExplainSuccess;
}) {
  const { content, verify, sceneTier } = result;
  const held = verify.status === "held";
  const act1 = content.act1;

  /*
   * 2막에 남길 "그림 준비 중" 안내. **판정 기준은 `sceneTier`가 아니라 `sceneHtml`의 유무다.**
   * 그림이 실제로 뜨는지를 결정하는 것은 HTML 조각이지 티어 문자열이 아니라서다 —
   * `sceneTier: 'html'`인데 `sceneHtml`이 없는 손상·옛 기록이 오면(둘은 다른 필드다)
   * 티어로 판정한 코드는 안내도 그림도 없는 **빈 자리**를 남긴다. 그런 기록은 그림이
   * 없는 것과 같이 다룬다. 티어 자체는 아래 칩에 원본 그대로 보여 준다.
   */
  const sceneNote = result.sceneHtml
    ? null
    : SCENE_TIER_TEXT[sceneTier === "html" ? "none" : sceneTier];

  return (
    <article>
      {/* ── 1. 문제 헤더 ─────────────────────────────────────────────── */}
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <span className="u-chip u-chip-accent">🏷️ {content.patternNameKo}</span>
          {/*
           * 채점 배지는 `ok`일 때만 세운다. 보류 중인 답을 근거로 "틀렸어요"를
           * 아이에게 내미는 것이 이 화면에서 가장 나쁜 일이다 (채점은 답 접기 안으로 들어간다).
           */}
          {!held && content.childGrade !== "none" && (
            <span className="u-chip">{GRADE_BADGE[content.childGrade]}</span>
          )}
          {held && <span className="u-chip border-accent bg-accent text-bg">⚠️ 엄빠 확인 필요</span>}
        </div>

        <div className="u-box mt-3">
          <p className="u-label">문제</p>
          <p className="t-body whitespace-pre-wrap">{problemText}</p>
        </div>

        {!held && content.childGrade !== "none" && content.gradeNote && (
          <p className="t-question-ko mt-3 text-ink">{content.gradeNote}</p>
        )}
      </header>

      {/* ── 2. 보류 배너 ─────────────────────────────────────────────── */}
      {held && <HeldBanner verify={verify} uncertaintyNote={content.uncertaintyNote} />}

      {/* ── 3. 한 줄 비유 ────────────────────────────────────────────── */}
      <section className="mt-6">
        <div className="u-box">
          <p className="t-list-title">💡 {content.analogy.titleKo}</p>
          <p className="t-body mt-1">{content.analogy.bodyKo}</p>
        </div>
      </section>

      {/* ── 4. 1막 탐정 시간 — 이 화면의 주인공 ──────────────────────── */}
      <section className="mt-8">
        <h2 className="t-section-title flex flex-wrap items-center gap-2">
          <ActBadge n="1막" filled />
          🔍 탐정 시간
        </h2>
        <p className="t-caption mt-1">
          식을 세우기 전에, 무엇이 주어졌고 무엇을 구하는지부터 또렷하게 봐요.
        </p>

        {/* 함정이 있으면 1막 맨 위 — 이 아이가 가장 자주 빠지는 자리다 */}
        {act1.trap && (
          <div className="u-box-accent mt-3 border border-accent">
            <p className="t-section-title text-accent-ink">🚨 조심!</p>
            <p className="text-question-en mt-1 font-medium text-ink">{act1.trap}</p>
          </div>
        )}

        <div className="u-card mt-3">
          <div className="u-cardbar" />
          <div className="p-4 sm:p-5">
            <p className="u-label">🙋 등장인물 · 물건</p>
            <ul className="flex flex-wrap gap-2">
              {act1.castKo.map((c, i) => (
                <li key={i} className="u-chip text-question-ko">
                  {c}
                </li>
              ))}
            </ul>

            {/*
             * 움직임 화살표 — **화면에서 가장 큰 본문 글자(20px/500)**.
             * 받은 쪽이 누구인지를 뒤집는 것이 이 아이의 대표 오답이라(§0),
             * "민희 → 철희 : 연필 3자루"가 한눈에 읽혀야 한다.
             * `text-question-en`은 크기 역할 토큰(20px "아이에게 읽어줄 문장")을 재사용한 것이다
             * — 이름은 영어 카드에서 왔지만 값은 역할(읽어줄 문장) 그대로다. 새 토큰을 만들지 않았다.
             */}
            <p className="u-label mt-5">➡️ 무엇이 어떻게 움직였나</p>
            <ol className="flex flex-col gap-2">
              {act1.movesKo.map((m, i) => (
                <li key={i} className="u-box text-question-en font-medium text-ink">
                  {m}
                </li>
              ))}
            </ol>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="u-box">
                <p className="u-label">🏁 끝 장면</p>
                <p className="t-body">{act1.endSceneKo}</p>
              </div>
              <div className="u-box">
                <p className="u-label">❓ 구할 것</p>
                <p className="t-body">{act1.goalKo}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 5. 2막 되감기 ────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="t-section-title flex flex-wrap items-center gap-2">
          <ActBadge n="2막" />
          ⏪ 되감기
        </h2>

        {/*
         * ┌ 그림이 없을 때만 남는 안내 ─────────────────────────────────────────────┐
         * │ 2단 HTML이 있으면 여기에 아무것도 그리지 않는다 — 실물 그림이              │
         * │ 3막 아래 `<MathScenePlayer>`로 뜬다. "준비 중" 안내를 함께 띄우면 같은      │
         * │ 화면이 두 말을 하게 된다. 플레이어가 3초 폴백으로 사라져도 이 블록과는       │
         * │ 무관하다 — 폴백은 자기 자신만 걷어내고, 텍스트 3막이 이미 온전하다.         │
         * │ `typed`(1단 전용 렌더러)는 아직 그리는 화면이 없어 안내가 남아 있다(M2).    │
         * │ iframe의 srcdoc 조립·sandbox·CSP는 player-builder 소관이다 — 배치만 여기.  │
         * └──────────────────────────────────────────────────────────────────────┘
         */}
        {sceneNote && (
          <div className="u-box mt-3">
            <p className="t-list-title">🎬 움직이는 그림은 준비 중이에요</p>
            <p className="t-caption mt-1">{sceneNote.detail}</p>
            <p className="mt-2 flex flex-wrap gap-2">
              <span className="u-chip">그림 준비 상태: {sceneTier}</span>
              <span className="u-chip">{sceneNote.ko}</span>
            </p>
            {verify.sceneErrors.length > 0 && (
              <p className="t-caption mt-2">
                🔧 그림 대본의 숫자가 맞지 않아 그림은 뺐어요 (설명은 그대로예요):{" "}
                {verify.sceneErrors.join(" / ")}
              </p>
            )}
          </div>
        )}

        {held && (
          <p className="t-caption mt-3">
            아래 풀이에 나오는 숫자도 아직 확인 전이에요. 엄빠와 함께 짚어 보세요.
          </p>
        )}

        {/* 단계 카드 — 1막보다 작게(16px). 풀이를 잘게 쪼개는 쪽에 무게를 싣지 않는다 */}
        <ol className="mt-3 flex flex-col gap-2">
          {content.act2.steps.map((step, i) => (
            <li key={i} className="u-box flex items-start gap-3">
              <span className="u-chip u-chip-accent shrink-0">{i + 1}</span>
              <div className="min-w-0">
                <p className="t-question-ko text-ink">{step.say}</p>
                {step.calc && (
                  <p className="mt-2">
                    <span className="u-chip text-question-ko text-ink">{step.calc}</span>
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>

        <AnswerBlock content={content} verify={verify} />
      </section>

      {/* ── 6. 3막 다시 재생 ─────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="t-section-title flex flex-wrap items-center gap-2">
          <ActBadge n="3막" />
          ▶️ 다시 재생 — 맞는지 검사해요
        </h2>
        <ol className="mt-3 flex flex-col gap-2">
          {content.act3.checks.map((check, i) => (
            <li key={i} className="u-box">
              <p className="t-list-title">✔️ {check.titleKo}</p>
              <p className="t-question-ko mt-1">{check.bodyKo}</p>
            </li>
          ))}
        </ol>
      </section>

      {/*
        ── 7. 되감기 플레이어 (2단, M2.5 §3-4) ────────────────────────────
        자리가 **3막 뒤**인 이유: 이 플레이어는 2막만이 아니라 1막(문제 상황) → 2막(되감기)
        → 3막(검사 장면)을 통째로 다시 보여준다(§3-4 "첫 단계는 문제 상황, 마지막 단계는
        답이 보이는 검사 장면"). 2막 안에 끼우면 이야기 중간에 이야기 전체가 들어가는 꼴이
        되고, 3막 텍스트를 읽기도 전에 그림이 답을 먼저 보여 준다. 글로 한 번 따라간 뒤
        같은 이야기를 손으로 되감아 보는 순서가 §10-1("지름길을 먼저 가르치지 마라")과 결이 같다.

        insight(💡 다른 방법도 있어요) **앞**인 이유: 그림은 정석 풀이의 일부이고,
        insight는 정석을 다 지난 뒤에 오는 보너스다.

        `sceneHtml`이 있을 때만 그린다. iframe 조립·sandbox·3초 폴백은 전부 자식이 맡는다 —
        여기서는 **자리만** 정한다.
      */}
      {result.sceneHtml && <MathScenePlayer sceneHtml={result.sceneHtml} />}

      {/*
        ── 8. 두 번째 풀이(insight) — 접힌 카드 (M5 §10-4) ──────────────
        `insight`가 없으면 **카드 자체를 그리지 않는다.** 빈 카드가 "안 나왔네?"로
        읽히면 안 된다(§10-4).

        `=== null`이 아니라 **truthy 판정**인 것이 중요하다: M4에서 저장된 옛 기록의
        `content`에는 `insight` 키가 아예 없어 읽으면 `undefined`다(null이 아니다).
      */}
      {content.insight && <InsightCard insight={content.insight} />}

      {/* ── 9. 엄빠 티칭 포인트 ──────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="t-section-title">👨‍👩‍👦 엄빠 티칭 포인트</h2>
        <div className="u-box-accent mt-3">
          <p className="t-question-ko text-ink">{content.parentTip}</p>
        </div>
      </section>

      {/* ── 10. 규칙 카드 ─────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="t-section-title">📌 기억할 규칙</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {content.rules.map((rule, i) => (
            <li key={i} className="u-card p-4">
              <p className="text-vocab-word leading-none" aria-hidden>
                {rule.emoji}
              </p>
              <p className="t-list-title mt-2">{rule.ko}</p>
              <p className="t-caption mt-1">{rule.why}</p>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
