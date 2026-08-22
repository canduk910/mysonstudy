"use client";

/**
 * 서재 화면 (M3, SPEC §4-3) — 클라이언트 컴포넌트.
 * - 상단 요약: 총 권수 / 최근 30일 권수(숫자를 크게, 라벨은 작게) +
 *   AR 레벨 추이 미니 차트(인라인 SVG, 차트 라이브러리 금지 — SPEC §4-3·§13).
 *   데이터 계산은 서버(app/library/page.tsx).
 * - 책 목록: 썸네일(또는 이모지) + 제목(17/500) + 메타 칩(12) + 제목 검색(클라이언트 필터).
 *   **한 줄 = 한 책**이다(story-4). 재생성으로 카드가 여러 장이면 "카드 N장"으로 알리고,
 *   줄을 누르면 최신 카드가 열린다 — 버전 목록·낱개 삭제는 그 카드 페이지 하단에 있다.
 * - 서재 관리(책 삭제): "관리" 토글을 켜야 항목마다 삭제 버튼이 나타난다(아이의
 *   오조작 방지). 삭제는 그 자리에서 인라인 확인 단계를 거친다 —
 *   window.confirm은 쓰지 않는다(모바일 UX·자동화 테스트).
 * 클라이언트인 이유: 검색 입력·관리 모드 상태 — 서버 왕복 없이 즉시 반응한다.
 *
 * 디자인: docs/DESIGN.md — 색·크기 값은 app/globals.css의 토큰만 참조한다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface LibraryItem {
  /**
   * 목록의 단위이자 **삭제의 단위**(story-4). 한 줄 = 한 책이라
   * "지운 것보다 많이 사라지는" 일이 구조적으로 없다.
   */
  bookId: string;
  /**
   * 대표(최신) 카드 — 줄을 누르면 이 카드가 열린다. 히스토리는 그 페이지 하단에 있다.
   *
   * **null이면 카드가 한 장도 없는 책**이다. 정상 흐름에서는 생기지 않지만(마지막 카드
   * 낱개 삭제를 라우트가 409로 막는다), 두 탭에서 2장짜리 책의 서로 다른 카드를 동시에
   * 지우면 둘 다 검사를 통과해 만들어질 수 있다(QA F15). 이런 책을 목록에서 숨기면
   * **지울 수단이 없어 영구히 낀다** — 그래서 숨기지 않고 "카드 없음"으로 보여준다.
   */
  cardId: string | null;
  /** 이 책에 딸린 카드 수(재생성분 포함) — 줄의 "카드 N장" 표시와 삭제 확인 문구용 */
  cardCount: number;
  /** 이 책의 읽음 기록 수 — 삭제 확인 문구용 */
  readingCount: number;
  title: string;
  author: string;
  series: string | null;
  coverUrl: string | null;
  coverEmoji: string | null;
  isFiction: boolean;
  arLevel: number | null;
  levelEstimated: boolean;
  createdAt: string; // ISO 8601
}

export interface ChartPoint {
  date: string; // YYYY-MM-DD (readAt)
  ar: number; // 그 책의 arLevel
  title: string; // 툴팁용 책 제목
}

/** 만든 날짜 표시 — 타임존 계산 없이 ISO 날짜부만 사용 (SSR/클라이언트 동일 출력) */
function formatDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, ".");
}

/**
 * 서재 한 줄의 겉껍질 — 대표 카드가 있으면 그 카드로 가는 링크, 없으면 링크가 아닌 상자.
 *
 * 카드 0장인 책은 열 곳이 없다. 그렇다고 목록에서 빼면 **지울 수단까지 사라져** 영구히
 * 낀다(QA F15 — 두 탭에서 2장짜리 책의 서로 다른 카드를 동시에 지우면 만들어진다).
 * 그래서 누를 수 없게만 하고 줄은 남긴다 — 관리 모드의 삭제 버튼은 bookId로 도니 그대로 는다.
 */
function Wrap({ cardId, children }: { cardId: string | null; children: React.ReactNode }) {
  if (cardId) {
    return (
      <Link href={`/card/${cardId}`} className="u-item min-w-0 flex-1">
        {children}
      </Link>
    );
  }
  return <div className="u-item min-w-0 flex-1 opacity-60">{children}</div>;
}

/** "2026-08-16" → "8/16" — 문자열 분해라 타임존 영향 없음 */
function monthDay(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/** SVG 텍스트도 토큰을 쓴다 — fontSize 속성은 var()를 못 받으므로 style로 준다 */
const svgCaption = { fontSize: "var(--fs-caption)", fontWeight: "var(--fw-light)" } as const;
const svgValueLabel = { fontSize: "var(--fs-meta-chip)", fontWeight: "var(--fw-bold)" } as const;

/**
 * AR 레벨 추이 미니 차트 — 인라인 SVG 단일 시리즈 라인.
 * accent 선 하나 + line 격자, 면은 accent-soft로 아주 옅게.
 * 시리즈가 하나라 범례는 없다(제목이 곧 시리즈 이름). 점의 <title>이 네이티브 툴팁.
 */
function ArTrendChart({ points }: { points: ChartPoint[] }) {
  if (points.length < 2) {
    return (
      <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-4 py-5 text-center">
        읽음 기록이 2개 이상 쌓이면 AR 레벨이 어떻게 변하는지 여기에 그려드릴게요.
        <br />
        카드 화면의 &ldquo;오늘 읽었어요&rdquo;로 기록을 남겨 보세요!
      </p>
    );
  }

  const W = 560;
  const H = 170;
  const pad = { l: 34, r: 16, t: 16, b: 26 };

  const xs = points.map((p) => Date.parse(p.date));
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  if (minX === maxX) {
    // 모든 기록이 같은 날 — 인위 도메인 ±12시간으로 가운데 배치
    minX -= 12 * 3600 * 1000;
    maxX += 12 * 3600 * 1000;
  }

  const ys = points.map((p) => p.ar);
  const dataMinY = Math.min(...ys);
  const dataMaxY = Math.max(...ys);
  let minY = dataMinY;
  let maxY = dataMaxY;
  if (minY === maxY) {
    minY -= 0.5;
    maxY += 0.5;
  }
  const padY = (maxY - minY) * 0.2;
  minY = Math.max(0, minY - padY);
  maxY += padY;

  const x = (t: number) => pad.l + ((t - minX) / (maxX - minX)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - ((v - minY) / (maxY - minY)) * (H - pad.t - pad.b);

  // 그리드·눈금: 데이터 최소/중간/최대 AR — 미니 차트라 3개면 충분
  const tickValues = [
    ...new Set([
      Math.round(dataMinY * 10) / 10,
      Math.round(((dataMinY + dataMaxY) / 2) * 10) / 10,
      Math.round(dataMaxY * 10) / 10,
    ]),
  ];

  const coords = points.map((p) => ({ cx: x(Date.parse(p.date)), cy: y(p.ar) }));
  const linePoints = coords.map((c) => `${c.cx.toFixed(1)},${c.cy.toFixed(1)}`).join(" ");
  // 선 아래 옅은 면 — 추이를 눈으로 잡아주는 최소한의 보조 (색은 accent-soft 하나)
  const areaPoints = `${coords[0].cx.toFixed(1)},${(H - pad.b).toFixed(1)} ${linePoints} ${coords[
    coords.length - 1
  ].cx.toFixed(1)},${(H - pad.b).toFixed(1)}`;
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`AR 레벨 추이: ${first.date}부터 ${last.date}까지 읽음 기록 ${points.length}개, AR ${dataMinY}에서 ${dataMaxY} 사이`}
    >
      {/* 격자 + y 눈금(AR 값) — line 색으로 옅게, 데이터보다 뒤로 */}
      {tickValues.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
          <text
            x={pad.l - 8}
            y={y(v) + 4}
            textAnchor="end"
            fill="var(--ink-3)"
            style={svgCaption}
          >
            {v}
          </text>
        </g>
      ))}
      {/* 바닥선만 조금 진하게 — 기준선 */}
      <line
        x1={pad.l}
        x2={W - pad.r}
        y1={H - pad.b}
        y2={H - pad.b}
        stroke="var(--line-strong)"
        strokeWidth="1"
      />

      {/* 데이터 — accent 선 하나 + 옅은 면 + 점(점의 title = 네이티브 툴팁) */}
      <polygon points={areaPoints} fill="var(--accent-soft)" />
      <polyline
        points={linePoints}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map((p, i) => (
        <circle
          key={`${p.date}-${i}`}
          cx={coords[i].cx}
          cy={coords[i].cy}
          r="3.5"
          fill="var(--accent)"
          stroke="var(--bg)"
          strokeWidth="1.5"
        >
          <title>{`${p.title} · AR ${p.ar} · ${p.date}`}</title>
        </circle>
      ))}

      {/* x 눈금 — 처음·마지막 날짜 */}
      <text x={pad.l} y={H - 8} textAnchor="start" fill="var(--ink-3)" style={svgCaption}>
        {monthDay(first.date)}
      </text>
      <text x={W - pad.r} y={H - 8} textAnchor="end" fill="var(--ink-3)" style={svgCaption}>
        {monthDay(last.date)}
      </text>

      {/* 마지막 점 직접 라벨 — 지금 레벨이 헤드라인 */}
      <text
        x={Math.min(coords[coords.length - 1].cx + 4, W - pad.r)}
        y={Math.max(coords[coords.length - 1].cy - 10, pad.t)}
        textAnchor="end"
        fill="var(--accent-ink)"
        style={svgValueLabel}
      >
        AR {last.ar}
      </text>
    </svg>
  );
}

export default function LibraryView({
  items,
  totalBooks,
  recent30Books,
  chartPoints,
}: {
  items: LibraryItem[];
  totalBooks: number;
  recent30Books: number;
  chartPoints: ChartPoint[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  /** 관리 모드 — 꺼져 있으면 삭제 버튼 자체가 없다(아이가 눌러 지우는 사고 방지) */
  const [manageMode, setManageMode] = useState(false);
  /** 인라인 확인 중인 책 (window.confirm 대신 그 항목 자리에서 확인한다) */
  const [confirmBookId, setConfirmBookId] = useState<string | null>(null);
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null);
  /** 지운 책 — 서버 데이터가 새로고침되기 전에도 목록에서 즉시 사라지게 한다 */
  const [deletedBookIds, setDeletedBookIds] = useState<string[]>([]);
  const [noticeKo, setNoticeKo] = useState<string | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  const visibleItems = items.filter((item) => !deletedBookIds.includes(item.bookId));
  const q = query.trim().toLowerCase();
  const filtered = q ? visibleItems.filter((item) => item.title.toLowerCase().includes(q)) : visibleItems;

  function toggleManage() {
    setManageMode((on) => !on);
    setConfirmBookId(null);
    setErrorKo(null);
    setNoticeKo(null);
  }

  function askDelete(item: LibraryItem) {
    setConfirmBookId(item.bookId);
    setErrorKo(null);
    setNoticeKo(null);
  }

  /** 삭제 실행 — 성공하면 그 책의 항목(카드가 여러 장이면 전부)을 목록에서 뺀다 */
  async function runDelete(item: LibraryItem) {
    setDeletingBookId(item.bookId);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/books/${encodeURIComponent(item.bookId)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; deleted?: { cards: number; readings: number }; messageKo?: string }
        | null;

      if (res.ok && data?.ok) {
        setDeletedBookIds((prev) => [...prev, item.bookId]);
        setConfirmBookId(null);
        setNoticeKo(
          `『${item.title}』을 지웠어요. (카드 ${data.deleted?.cards ?? 0}장 · 읽음 기록 ${
            data.deleted?.readings ?? 0
          }건)`,
        );
        router.refresh(); // 요약 타일·AR 차트도 최신 데이터로
        return;
      }

      if (res.status === 404) {
        // 이미 지워진 책(다른 기기·중복 클릭) — 목록에서 빼는 것이 맞다
        setDeletedBookIds((prev) => [...prev, item.bookId]);
        setConfirmBookId(null);
        setNoticeKo(`『${item.title}』은 이미 지워져 있었어요.`);
        router.refresh();
        return;
      }

      setErrorKo(data?.messageKo ?? "지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 지우지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setDeletingBookId(null);
    }
  }

  return (
    <>
      {/* 상단 요약 (SPEC §4-3) — 숫자를 크게, 라벨은 작게 */}
      <section aria-label="읽기 요약" className="mb-8">
        <div className="grid grid-cols-2 gap-3">
          <div className="u-box">
            <p className="t-meta-chip">총 권수</p>
            <p className="t-stat-number mt-1">
              {totalBooks}
              <span className="t-meta-chip ml-1">권</span>
            </p>
          </div>
          <div className="u-box">
            <p className="t-meta-chip">최근 30일</p>
            <p className="t-stat-number mt-1">
              {recent30Books}
              <span className="t-meta-chip ml-1">권</span>
            </p>
          </div>
        </div>
        <div className="u-box mt-3">
          <p className="t-meta-chip mb-2">AR 레벨 추이 — 읽은 날짜별, 그 책의 AR 지수</p>
          <ArTrendChart points={chartPoints} />
        </div>
      </section>

      {/* 제목 검색 (클라이언트 필터) + 관리 토글 */}
      <section aria-label="책 목록">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          {/* 단위가 '장'에서 '권'으로 바뀌었다 — 위 "총 권수" 타일과 이제 같은 수를 센다 */}
          <h2 className="t-section-title">읽은 책</h2>
          <p className="t-caption flex-none">{filtered.length}권</p>
        </div>

        <div className="mb-4 flex gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="책 제목으로 검색"
            aria-label="책 제목으로 검색"
            className="u-input min-w-0 flex-1"
          />
          {visibleItems.length > 0 && (
            <button
              type="button"
              onClick={toggleManage}
              aria-pressed={manageMode}
              className={`u-btn flex-none print:hidden ${
                manageMode ? "u-btn-primary" : "u-btn-secondary"
              }`}
            >
              {manageMode ? "완료" : "관리"}
            </button>
          )}
        </div>

        {manageMode && (
          <p className="t-caption mb-3 rounded-[var(--radius-box)] border border-dashed border-line px-4 py-3 print:hidden">
            지울 책의 <span className="font-medium text-ink">🗑 지우기</span> 버튼을 누르세요. 카드와
            읽음 기록이 함께 사라지고, <span className="font-medium text-ink">되돌릴 수 없어요.</span>
          </p>
        )}

        {noticeKo && (
          <p role="status" className="u-box-accent t-question-ko mb-3 text-ink print:hidden">
            ✅ {noticeKo}
          </p>
        )}

        {errorKo && (
          <p
            role="alert"
            className="t-question-ko mb-3 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3 text-danger print:hidden"
          >
            {errorKo}
          </p>
        )}

        {visibleItems.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            아직 만든 카드가 없어요.{" "}
            {/* 카드 만들기는 북카드 홈(`/english/books`)에 있다 — `/english`는 허브 */}
            <Link href="/english/books" className="font-medium text-accent underline">
              홈에서 첫 카드를 만들어 볼까요?
            </Link>
          </p>
        ) : filtered.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            &ldquo;{query.trim()}&rdquo; 제목의 책을 찾지 못했어요.
          </p>
        ) : (
          /* grid가 아니라 세로 flex — grid 트랙은 긴 제목에 맞춰 늘어나 375px에서 넘친다 */
          <ul className="flex flex-col gap-2">
            {filtered.map((item) =>
              confirmBookId === item.bookId ? (
                /* 인라인 확인 단계 — 그 항목 자리에서 묻는다 (window.confirm 금지) */
                <li key={item.bookId}>
                  <div
                    role="group"
                    aria-label="삭제 확인"
                    className="rounded-[var(--radius-box)] border border-danger bg-danger-soft p-4"
                  >
                    <p className="t-list-title">『{item.title}』을 지울까요?</p>
                    <p className="t-caption mt-1">
                      카드 {item.cardCount}장 · 읽음 기록 {item.readingCount}건이 함께 사라져요.{" "}
                      <span className="font-medium text-danger">되돌릴 수 없어요.</span>
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void runDelete(item)}
                        disabled={deletingBookId === item.bookId}
                        className="u-btn flex-1 bg-danger text-bg"
                      >
                        {deletingBookId === item.bookId ? "지우는 중…" : "지우기"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmBookId(null)}
                        disabled={deletingBookId === item.bookId}
                        className="u-btn u-btn-secondary flex-1"
                      >
                        취소
                      </button>
                    </div>
                  </div>
                </li>
              ) : (
                <li key={item.bookId} className="flex min-w-0 items-stretch gap-2">
                  {/* 줄을 누르면 그 책의 **최신 카드**로 바로 간다 — 아이와 카드를 펼치는
                      것이 이 앱에서 가장 잦은 동작이라, 책 상세를 한 번 더 거치지 않는다.
                      버전 목록·낱개 삭제는 그 카드 페이지 하단의 히스토리 섹션에 있다. */}
                  {/* 카드가 없는 책(F15)은 열 곳이 없어 링크로 감싸지 않는다 — 대신
                      줄은 그대로 보여서 관리 모드에서 지울 수 있게 한다 */}
                  <Wrap cardId={item.cardId}>
                    {item.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- 외부 썸네일, next/image 원격 설정은 과설계
                      <img src={item.coverUrl} alt="" className="u-item-cover" />
                    ) : (
                      <span className="u-item-thumb" aria-hidden>
                        {item.coverEmoji || "📖"}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="t-list-title block truncate">{item.title}</span>
                      <span className="t-caption block truncate">
                        {item.author}
                        {item.series ? ` · ${item.series}` : ""}
                      </span>
                      {/* 메타 칩 — 12px, 색 노이즈를 줄여 중립 칩 하나로 */}
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="u-chip">
                          {item.arLevel != null ? `AR ${item.arLevel}` : "레벨 추정"}
                        </span>
                        <span className="u-chip">{item.isFiction ? "픽션" : "논픽션"}</span>
                        {/* 재생성으로 여러 장이면 알린다 — 한 줄인데 그 뒤에 히스토리가
                            있다는 사실이 보여야 사용자가 찾아갈 수 있다 */}
                        {item.cardCount > 1 && (
                          <span className="u-chip">카드 {item.cardCount}장</span>
                        )}
                        {item.cardCount === 0 && <span className="u-chip">카드 없음</span>}
                        <span className="t-caption">{formatDate(item.createdAt)}</span>
                      </span>
                    </span>
                  </Wrap>

                  {/* 관리 모드에서만 나타나는 삭제 버튼 — 평소엔 렌더 자체를 하지 않는다 */}
                  {manageMode && (
                    <button
                      type="button"
                      onClick={() => askDelete(item)}
                      aria-label={`${item.title} 지우기`}
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
