"use client";

/**
 * 수학 서재 화면 (M4, docs/harness/math.md §9-4) — 클라이언트 컴포넌트.
 *
 * - 상단 요약: 전체 / 틀린 문제 / 보류 건수(숫자를 크게, 라벨은 작게)
 * - 유형별 통계: `problemPattern`별 건수 · 정답률 · 보류율 · 그림 단계(1단/2단/없음).
 *   **정답률 분모에서 `childGrade === 'none'`을 뺀다** — 아이가 답을 쓰지 않아 채점할 것이
 *   없었던 문제다. 분모가 0이면 비율 대신 "—"를 보인다(§9-4).
 *   보류율은 §8의 "held 비율을 유형별로 남긴다"가 겨냥한 신호다 — 특정 유형에서 잦으면
 *   그 유형 프롬프트를 손볼 신호이지 검산을 느슨하게 할 신호가 아니다.
 *   그림 단계는 §8[개정 4]의 "sceneTier를 유형별로 집계해 서재에 보여준다"이고, 겨냥한 신호는
 *   **다음에 만들 전용 렌더러**다 — 2단(AI HTML)으로 자주 그려지는 유형이 곧 승격 후보다.
 * - 목록 필터 3종: 전체 / 틀린 문제(childGrade가 wrong·partial) / 보류(verify.status === 'held')
 * - 관리 모드: 켜야 삭제 버튼이 나타나고, 그 자리에서 인라인 확인을 거친다
 *   (window.confirm 금지 — 영어 서재와 같은 규약)
 *
 * 계산은 전부 서버(app/math/library/page.tsx)가 하고, 여기서는 고르고 지우는 일만 한다.
 * 클라이언트인 이유: 필터·관리 모드 상태 — 서버 왕복 없이 즉시 반응한다.
 *
 * **보류 중인 기록은 답도 채점 배지도 보이지 않는다.** 접어 둔 답을 목록에서 슬쩍
 * 내보이면 답을 접은 뜻이 없어진다 — `components/math-explanation-view.tsx`와 같은 규칙이다.
 *
 * 디자인: 새 CSS 없음. `app/globals.css`의 토큰(`u-*`·`t-*`)과 거기서 생성된 Tailwind
 * 유틸만 쓴다. 위계는 색이 아니라 글자 크기로 만든다(DESIGN §4).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useReorder } from "@/components/use-reorder";
import type { ChildGrade, ProblemPattern } from "@/lib/ai/math/schemas";
// 채점 배지 문구는 설명 화면과 **한 정의처**를 공유한다 — 예전엔 두 벌이라 `wrong`이 어긋나 있었다
import { GRADE_BADGE } from "@/lib/math-labels";
import type { SceneTier } from "@/lib/scene/types";

// ---------------------------------------------------------------------------
// 데이터 (서버가 만들어 넘긴다)
// ---------------------------------------------------------------------------

export interface MathLibraryItem {
  /** 목록의 단위이자 삭제의 단위 — `/math/problem/[id]`로 열린다 */
  id: string;
  /** 문제 번호(사진 판독 M3이 채운다). 직접 입력이면 null */
  number: string | null;
  problemText: string;
  /** 유형 코드 — 필터·통계의 키 */
  pattern: ProblemPattern;
  /** AI가 붙인 아이 말 이름(예: "되감기형 · 양 옮기기") — 줄에 보이는 이름 */
  patternNameKo: string;
  childGrade: ChildGrade;
  /** verify.status === 'held' */
  held: boolean;
  /** 답 한 줄. **보류면 화면에 내지 않는다** */
  answerText: string;
  createdAt: string; // ISO 8601
  /** 수동 정렬 값(서재와 동일 규약). null이면 미정렬(맨 위 블록). 정렬은 서버(page.tsx)가 끝낸다. */
  sortIndex: number | null;
}

/** 유형별 집계 — 비율 계산은 화면에서 한다(분모 0 처리와 문구가 붙어 있어서) */
export interface PatternStat {
  pattern: ProblemPattern;
  /** 그 유형의 전체 건수 */
  count: number;
  /** 채점된 건수 = childGrade !== 'none' — **정답률의 분모** */
  gradedCount: number;
  correctCount: number;
  heldCount: number;
  /**
   * 그림 단계별 건수 (§8[개정 4]). `typed`(1단 전용 렌더러) · `html`(2단 AI HTML) · `none`(글만).
   * 세 값이 **항상 들어 있다**(0 포함) — 서버가 `SCENE_TIERS`로 깔고 시작한다.
   */
  tierCounts: Record<SceneTier, number>;
}

/**
 * 유형 코드의 한국어 이름 — 호출 B 프롬프트(§3-1 [problemPattern])의 설명을 그대로 옮겼다.
 * `Record<ProblemPattern, string>`이라 스키마에 유형이 늘면 **여기서 컴파일이 깨진다**
 * (이름 없는 유형이 통계표에서 코드로 새어 나오지 않게).
 *
 * 줄에 붙는 이름은 AI가 문제마다 짓는 `patternNameKo`를 쓰고, 통계표는 이 고정 이름을 쓴다 —
 * 집계는 같은 유형이 같은 이름으로 묶여야 읽힌다.
 */
const PATTERN_LABEL_KO: Record<ProblemPattern, string> = {
  "rewind-transfer": "주고받기 되감기",
  "part-whole": "합·차·부분·전체",
  multiple: "몇 배",
  "sequence-ops": "더하고 빼기 순서",
  rate: "속력·시간·거리",
  pattern: "규칙 찾기",
  geometry: "길이·넓이·모양",
  counting: "빠짐없이 세기",
  other: "그 밖에",
};

/**
 * 그림 단계 열 이름 (§8[개정 4]). 열 머리는 **짧게** 두고 뜻은 표 아래 캡션이 한 번 설명한다 —
 * 모바일에서 표를 넓히는 것은 거의 항상 열 머리 글자수다.
 * `Record<SceneTier, string>`이라 단수가 늘면 **여기서 컴파일이 깨진다**(PATTERN_LABEL_KO와 같은 장치).
 */
const SCENE_TIER_LABEL_KO: Record<SceneTier, string> = {
  typed: "1단",
  html: "2단",
  none: "없음",
};

/** 표의 열 순서 — 그린 정도가 센 쪽부터(전용 그림 → AI HTML → 없음) */
const SCENE_TIER_ORDER: SceneTier[] = ["typed", "html", "none"];

type FilterKey = "all" | "wrong" | "held";

const FILTERS: { key: FilterKey; labelKo: string }[] = [
  { key: "all", labelKo: "전체" },
  { key: "wrong", labelKo: "틀린 문제" },
  { key: "held", labelKo: "보류" },
];

/** 만든 날짜 표시 — 타임존 계산 없이 ISO 날짜부만 사용 (SSR/클라이언트 동일 출력) */
function formatDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, ".");
}

/** 비율 표시 — 분모가 0이면 숫자 대신 "—"(§9-4). 0%와 "잴 것이 없음"은 다른 말이다 */
function ratio(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function isWrong(item: MathLibraryItem): boolean {
  return item.childGrade === "wrong" || item.childGrade === "partial";
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export default function MathLibraryView({
  items,
  stats,
  skippedCount = 0,
}: {
  items: MathLibraryItem[];
  stats: PatternStat[];
  /**
   * 서버가 읽지 못해 건너뛴 기록 수 (QA 5-4). 목록·집계가 읽는 필드가 빠진 문서다.
   * **조용히 사라지게 두지 않는다** — 건수가 맞지 않으면 부모는 "내 설명이 없어졌다"고 읽는다.
   */
  skippedCount?: number;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterKey>("all");
  /** 관리 모드 — 꺼져 있으면 삭제 버튼 자체가 없다(아이가 눌러 지우는 사고 방지) */
  const [manageMode, setManageMode] = useState(false);
  /** 인라인 확인 중인 기록 (window.confirm 대신 그 항목 자리에서 확인한다) */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** 지운 기록 — 서버 데이터가 새로고침되기 전에도 목록에서 즉시 사라지게 한다 */
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [noticeKo, setNoticeKo] = useState<string | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  const visibleItems = items.filter((item) => !deletedIds.includes(item.id));
  const wrongCount = visibleItems.filter(isWrong).length;
  const heldCount = visibleItems.filter((item) => item.held).length;

  /*
   * 수동 정렬(서재와 동일) — 공유 프리미티브 useReorder에 배선한다.
   * **필터가 '전체'가 아닐 때 재배치를 끈다**(서재의 "검색 중 비활성"에 대응): reorderExplanations는
   * 넘긴 목록만 0..n으로 재색인하므로, 필터된 일부만 넘기면 나머지 인덱스와 충돌한다. 전체 목록일
   * 때만 순서가 일관된다. (삭제는 어느 필터에서도 되게 둔다 — 항목 단위라 인덱스와 무관.)
   */
  const reorderEnabled = manageMode && filter === "all";
  const reorder = useReorder({
    ids: visibleItems.map((item) => item.id),
    enabled: reorderEnabled,
    onPersist: async (orderedIds) => {
      const res = await fetch("/api/math/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      });
      if (!res.ok) throw new Error("reorder failed");
      setErrorKo(null);
      router.refresh(); // 서버가 sortIndex로 다시 정렬해 순서를 확정한다
    },
    onError: () => setErrorKo("순서를 저장하지 못했어요. 잠시 후 다시 시도해 주세요."),
  });

  // 훅이 정한 순서(관리 모드 재배치 반영)로 세운 뒤 필터를 적용한다.
  const itemById = new Map(visibleItems.map((item) => [item.id, item]));
  const orderedItems = reorder.order
    .map((id) => itemById.get(id))
    .filter((item): item is MathLibraryItem => item != null);
  const filtered =
    filter === "wrong"
      ? orderedItems.filter(isWrong)
      : filter === "held"
        ? orderedItems.filter((item) => item.held)
        : orderedItems;

  function toggleManage() {
    setManageMode((on) => !on);
    setConfirmId(null);
    setErrorKo(null);
    setNoticeKo(null);
  }

  async function runDelete(item: MathLibraryItem) {
    setDeletingId(item.id);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/math/explanations/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; messageKo?: string }
        | null;

      if (res.ok && data?.ok) {
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        setNoticeKo("설명 하나를 지웠어요.");
        router.refresh(); // 요약 타일·유형별 통계도 최신 데이터로
        return;
      }

      if (res.status === 404) {
        // 이미 지워진 기록(다른 기기·중복 클릭) — 목록에서 빼는 것이 맞다
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        setNoticeKo("이미 지워져 있었어요.");
        router.refresh();
        return;
      }

      setErrorKo(data?.messageKo ?? "지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 지우지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      {/* 읽지 못한 기록이 있으면 먼저 알린다 — 숫자가 조용히 줄어드는 것이 가장 나쁘다 */}
      {skippedCount > 0 && (
        <p role="status" className="u-box t-caption mb-4 border border-line-strong">
          ⚠️ 예전 형식이라 열지 못한 기록이 {skippedCount}건 있어요. 아래 목록과 통계에는
          빠져 있어요.
        </p>
      )}

      {/* 상단 요약 — 숫자를 크게, 라벨은 작게 (영어 서재와 같은 타일) */}
      <section aria-label="설명 요약" className="mb-8">
        <div className="grid grid-cols-3 gap-3">
          <div className="u-box">
            <p className="t-meta-chip">전체</p>
            <p className="t-stat-number mt-1">
              {visibleItems.length}
              <span className="t-meta-chip ml-1">건</span>
            </p>
          </div>
          <div className="u-box">
            <p className="t-meta-chip">틀린 문제</p>
            <p className="t-stat-number mt-1">
              {wrongCount}
              <span className="t-meta-chip ml-1">건</span>
            </p>
          </div>
          <div className="u-box">
            <p className="t-meta-chip">보류</p>
            <p className="t-stat-number mt-1">
              {heldCount}
              <span className="t-meta-chip ml-1">건</span>
            </p>
          </div>
        </div>
      </section>

      {/* 유형별 통계 (§9-4) — 어떤 유형에서 자주 막히는지 부모가 한눈에 본다 */}
      <section aria-label="유형별 통계" className="mb-8">
        <h2 className="t-section-title mb-3">유형별로 보면</h2>
        {stats.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            설명이 쌓이면 어떤 유형에서 자주 막히는지 여기에 모아 드릴게요.
          </p>
        ) : (
          /*
           * 표가 좁은 화면에서 넘치면 표만 가로로 스크롤한다 — 페이지는 밀리지 않는다.
           *
           * 모든 칸에 `whitespace-nowrap`을 준다(360px 실측 근거). 그림 단계 3열이 붙으면서
           * 표가 313px 컨테이너에 눌리는데, 그대로 두면 브라우저가 **한국어 낱말을 가운데서
           * 쪼갠다** — "건/수", "정답/률", "길이·넓/이·모양"처럼. 줄바꿈을 막으면 표는 376px가
           * 되어 이 컨테이너 안에서만 가로 스크롤이 생기고(360px에서 63px, 390px에서 33px,
           * 414px에서 9px, 430px 이상은 0), 머리글 37px·행 45px로 **열이 늘기 전과 같은 한 줄
           * 높이**를 지킨다(쪼갤 때는 58px·72.5px였다).
           * 페이지 자체는 어느 폭에서도 넘치지 않는다(문서 스크롤 폭 = 화면 폭, 실측).
           */
          <div className="overflow-x-auto">
            <table className="u-table whitespace-nowrap">
              <thead>
                <tr>
                  <th scope="col">유형</th>
                  <th scope="col" className="text-right">건수</th>
                  <th scope="col" className="text-right">정답률</th>
                  <th scope="col" className="text-right">보류율</th>
                  {/*
                   * 그림 단계 3열 (§8[개정 4]). 머리에는 이름만 둔다 — 앞 4열(성적)과 다른
                   * 이야기라는 표시(🎬)와 뜻풀이는 표 아래 캡션이 맡는다. 머리에 🎬을 붙여
                   * 봤더니 표가 15px 넓어져 430px 화면에서 스크롤이 생겼다(실측). 좁은 화면에서
                   * 표를 넓히는 것은 거의 항상 머리글자다.
                   */}
                  {SCENE_TIER_ORDER.map((tier) => (
                    <th key={tier} scope="col" className="text-right">
                      {SCENE_TIER_LABEL_KO[tier]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.map((stat) => (
                  <tr key={stat.pattern}>
                    <td className="t-question-ko text-ink">{PATTERN_LABEL_KO[stat.pattern]}</td>
                    <td className="t-meta-chip text-right">{stat.count}</td>
                    {/* 분모는 채점된 건수 — 아이가 답을 안 쓴 문제는 뺀다 */}
                    <td className="t-meta-chip text-right">
                      {ratio(stat.correctCount, stat.gradedCount)}
                    </td>
                    <td className="t-meta-chip text-right">{ratio(stat.heldCount, stat.count)}</td>
                    {/* 0도 그대로 적는다 — "이 유형은 2단을 한 번도 안 탔다"가 곧 신호다 */}
                    {SCENE_TIER_ORDER.map((tier) => (
                      <td key={tier} className="t-meta-chip text-right">
                        {stat.tierCounts[tier]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/*
         * 캡션은 표가 있을 때만 (P3-7) — 0건이면 위 안내가 이미 그 자리를 맡고 있어
         * "정답률은…"만 남으면 무엇을 설명하는 말인지 알 수 없다.
         *
         * 두 비율의 분모가 서로 다르다는 것을 적어 둔다 (P3-4): 정답률은 채점된 건수,
         * 보류율은 전체 건수. 같은 줄에 나란히 있으면 같은 분모로 읽히기 쉽다.
         */}
        {stats.length > 0 && (
          <>
            <p className="t-caption mt-2">
              정답률은 <b className="font-medium text-ink">은우가 답을 쓴 문제</b>만 세요 (답을 안 쓴
              문제는 채점할 것이 없어 뺐어요). 잴 것이 없으면 &ldquo;—&rdquo;로 둡니다.{" "}
              <b className="font-medium text-ink">보류율은 전체 건수 기준</b>이에요.
            </p>
            {/*
             * 그림 단계 열의 뜻 (§8[개정 4]). 열 머리를 짧게 두는 대신 여기서 한 번 풀어 준다.
             * 마지막 문장이 이 집계를 만든 이유다 — 숫자만 있고 "그래서 뭘 보라는 건지"가
             * 없으면 아무도 읽지 않는다.
             */}
            <p className="t-caption mt-1">
              🎬 오른쪽 세 칸(<b className="font-medium text-ink">그림 단계</b>)은 그 유형을 어떻게
              그렸는지예요. <b className="font-medium text-ink">1단</b>은 앱이 가진 전용 그림,{" "}
              <b className="font-medium text-ink">2단</b>은 AI가 그때그때 그린 그림,{" "}
              <b className="font-medium text-ink">없음</b>은 글 설명만이에요. 2단이 많이 쌓인
              유형일수록 전용 그림으로 만들 값어치가 큰 유형이에요.
            </p>
          </>
        )}
      </section>

      {/* 목록 — 필터 3종 + 관리 토글 */}
      <section aria-label="설명 목록">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="t-section-title">지난 문제</h2>
          <p className="t-caption flex-none">{filtered.length}건</p>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          <div role="group" aria-label="목록 거르기" className="flex min-w-0 flex-1 gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`u-btn min-w-0 flex-1 ${
                  filter === f.key ? "u-btn-primary" : "u-btn-secondary"
                }`}
              >
                {f.labelKo}
              </button>
            ))}
          </div>
          {visibleItems.length > 0 && (
            <button
              type="button"
              onClick={toggleManage}
              aria-pressed={manageMode}
              className={`u-btn flex-none ${manageMode ? "u-btn-primary" : "u-btn-secondary"}`}
            >
              {manageMode ? "완료" : "관리"}
            </button>
          )}
        </div>

        {manageMode && (
          <p className="t-caption mb-3 rounded-[var(--radius-box)] border border-dashed border-line px-4 py-3">
            {reorderEnabled ? (
              <>
                <span className="font-medium text-ink">≡ 손잡이를 끌어</span> 순서를 바꾸거나{" "}
                <span className="font-medium text-ink">↑ ↓ 버튼</span>으로 옮겨요. 지울 설명은{" "}
                <span className="font-medium text-ink">🗑 지우기</span> —{" "}
                <span className="font-medium text-ink">되돌릴 수 없어요.</span>
              </>
            ) : (
              <>
                순서 바꾸기는 <span className="font-medium text-ink">‘전체’ 목록</span>에서만 돼요
                (필터를 걸면 잠시 꺼져요). 지울 설명의{" "}
                <span className="font-medium text-ink">🗑 지우기</span> 버튼을 누르세요.{" "}
                <span className="font-medium text-ink">되돌릴 수 없어요.</span>
              </>
            )}
          </p>
        )}

        {noticeKo && (
          <p role="status" className="u-box-accent t-question-ko mb-3 text-ink">
            ✅ {noticeKo}
          </p>
        )}

        {errorKo && (
          <p
            role="alert"
            className="t-question-ko mb-3 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3 text-danger"
          >
            {errorKo}
          </p>
        )}

        {visibleItems.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            아직 만든 설명이 없어요.{" "}
            <Link href="/math/new" className="font-medium text-accent underline">
              문제를 적어 첫 설명을 만들어 볼까요?
            </Link>
          </p>
        ) : filtered.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            {filter === "wrong"
              ? "이 조건에 맞는 문제가 없어요. 은우가 다 맞혔네요!"
              : "보류된 설명이 없어요. 답이 두 번 다 같게 나왔어요."}
          </p>
        ) : (
          /* grid가 아니라 세로 flex — grid 트랙은 긴 문장에 맞춰 늘어나 375px에서 넘친다 */
          <ul className="flex flex-col gap-2">
            {filtered.map((item) =>
              confirmId === item.id ? (
                /* 인라인 확인 단계 — 그 항목 자리에서 묻는다 (window.confirm 금지) */
                <li key={item.id}>
                  <div
                    role="group"
                    aria-label="삭제 확인"
                    className="rounded-[var(--radius-box)] border border-danger bg-danger-soft p-4"
                  >
                    <p className="t-list-title line-clamp-2">{item.problemText}</p>
                    <p className="t-caption mt-1">
                      이 설명을 지울까요?{" "}
                      <span className="font-medium text-danger">되돌릴 수 없어요.</span>
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void runDelete(item)}
                        disabled={deletingId === item.id}
                        className="u-btn flex-1 bg-danger text-bg"
                      >
                        {deletingId === item.id ? "지우는 중…" : "지우기"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        disabled={deletingId === item.id}
                        className="u-btn u-btn-secondary flex-1"
                      >
                        취소
                      </button>
                    </div>
                  </div>
                </li>
              ) : (
                <li
                  key={item.id}
                  {...reorder.getRowProps(item.id)}
                  className={`flex min-w-0 items-stretch gap-2 rounded-[var(--radius-box)] ${
                    reorder.draggingId === item.id ? "opacity-90 ring-2 ring-accent" : ""
                  }`}
                >
                  {/* 드래그 손잡이 — 관리 모드·'전체' 필터에서만. touch-action:none으로 스크롤 안 샘.
                      키보드는 ↑/↓로 이동(핸들 aria-label 안내). */}
                  {reorderEnabled && (
                    <div
                      {...reorder.getHandleProps(item.id)}
                      className="t-list-title flex w-8 flex-none select-none items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink-3 hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent print:hidden"
                    >
                      <span aria-hidden>≡</span>
                    </div>
                  )}
                  <Link href={`/math/problem/${item.id}`} className="u-item min-w-0 flex-1">
                    <span className="u-item-thumb" aria-hidden>
                      {item.held ? "⚠️" : "🧮"}
                    </span>
                    <span className="min-w-0 flex-1">
                      {/* 문제 문장이 곧 제목이다 — 두 줄까지만 보이고 나머지는 상세에서 */}
                      <span className="t-list-title line-clamp-2">
                        {item.number ? `${item.number}. ` : ""}
                        {item.problemText}
                      </span>
                      {/*
                       * 보류면 답을 내지 않는다 — 접어 둔 답을 목록에서 슬쩍 보이면
                       * 답을 접은 뜻이 없어진다(설명 화면과 같은 규칙).
                       */}
                      <span className="t-caption mt-0.5 block truncate">
                        {item.held ? "답은 접어 뒀어요 — 엄빠와 함께 확인해요" : item.answerText}
                      </span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="u-chip">🏷️ {item.patternNameKo}</span>
                        {item.held ? (
                          <span className="u-chip border-accent bg-accent text-bg">
                            ⚠️ 엄빠 확인 필요
                          </span>
                        ) : (
                          item.childGrade !== "none" && (
                            <span className="u-chip">{GRADE_BADGE[item.childGrade]}</span>
                          )
                        )}
                        <span className="t-caption">{formatDate(item.createdAt)}</span>
                      </span>
                    </span>
                  </Link>

                  {/* ↑/↓ 이동 버튼 — 드래그가 어려운 상황·a11y 폴백('전체' 필터에서만) */}
                  {reorderEnabled && (
                    <div className="flex w-9 flex-none flex-col gap-1 print:hidden">
                      <button
                        type="button"
                        onClick={() => reorder.moveUp(item.id)}
                        disabled={!reorder.canMoveUp(item.id) || reorder.saving}
                        aria-label="이 설명 위로"
                        className="t-list-title flex flex-1 items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink disabled:opacity-30 hover:enabled:border-line-strong"
                      >
                        <span aria-hidden>↑</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => reorder.moveDown(item.id)}
                        disabled={!reorder.canMoveDown(item.id) || reorder.saving}
                        aria-label="이 설명 아래로"
                        className="t-list-title flex flex-1 items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink disabled:opacity-30 hover:enabled:border-line-strong"
                      >
                        <span aria-hidden>↓</span>
                      </button>
                    </div>
                  )}

                  {/* 관리 모드에서만 나타나는 삭제 버튼 — 평소엔 렌더 자체를 하지 않는다 */}
                  {manageMode && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmId(item.id);
                        setErrorKo(null);
                        setNoticeKo(null);
                      }}
                      aria-label="이 설명 지우기"
                      className="t-meta-chip flex w-14 flex-none flex-col items-center justify-center gap-0.5 rounded-[var(--radius-box)] border border-danger bg-bg text-danger transition hover:bg-danger-soft print:hidden"
                    >
                      <span aria-hidden>🗑</span>
                      지우기
                    </button>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </>
  );
}
