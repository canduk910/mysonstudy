"use client";

/**
 * 서재 화면 (M3, SPEC §4-3) — 클라이언트 컴포넌트.
 * - 상단 요약: 총 권수 / 최근 30일 권수 / AR 레벨 추이 미니 차트(인라인 SVG,
 *   라이브러리 금지 — SPEC §4-3·§13). 데이터 계산은 서버(app/library/page.tsx).
 * - 카드 목록: 썸네일(또는 이모지)·제목·AR 칩·만든 날짜 + 제목 검색(클라이언트 필터).
 * 클라이언트인 이유: 검색 입력 상태 하나 — 서버 왕복 없이 즉시 거른다.
 */

import Link from "next/link";
import { useState } from "react";

export interface LibraryItem {
  cardId: string;
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

/** "2026-08-16" → "8/16" — 문자열 분해라 타임존 영향 없음 */
function monthDay(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/**
 * AR 레벨 추이 미니 차트 — 인라인 SVG 단일 시리즈 라인.
 * 얇은 마크(선 2px·점 r4), 옅은 그리드, 텍스트는 보조색 — 시리즈가 하나라
 * 범례는 없다(제목이 곧 시리즈 이름). 점의 <title>이 네이티브 툴팁이 된다.
 */
function ArTrendChart({ points }: { points: ChartPoint[] }) {
  if (points.length < 2) {
    return (
      <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-5 text-center text-[13px] text-sub">
        읽음 기록이 2개 이상 쌓이면 AR 레벨이 어떻게 변하는지 여기에 그려드릴게요.
        <br />
        카드 화면의 &ldquo;오늘 읽었어요&rdquo;로 기록을 남겨 보세요!
      </p>
    );
  }

  const W = 560;
  const H = 180;
  const pad = { l: 38, r: 18, t: 18, b: 28 };

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

  // 그리드·눈금: 데이터 최소/최대(+중간) AR 값 — 미니 차트라 3개면 충분
  const tickValues = [...new Set([
    Math.round(dataMinY * 10) / 10,
    Math.round(((dataMinY + dataMaxY) / 2) * 10) / 10,
    Math.round(dataMaxY * 10) / 10,
  ])];

  const linePoints = points.map((p) => `${x(Date.parse(p.date)).toFixed(1)},${y(p.ar).toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`AR 레벨 추이: ${first.date}부터 ${last.date}까지 읽음 기록 ${points.length}개, AR ${dataMinY}에서 ${dataMaxY} 사이`}
    >
      {/* 그리드 + y 눈금(AR 값) — 옅게, 데이터보다 뒤로 */}
      {tickValues.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#e6e2d8" strokeWidth="1" />
          <text x={pad.l - 6} y={y(v) + 3.5} textAnchor="end" fontSize="11" fill="#5b6472">
            {v}
          </text>
        </g>
      ))}

      {/* x 눈금 — 처음·마지막 날짜 */}
      <text x={x(Date.parse(first.date))} y={H - 8} textAnchor="start" fontSize="11" fill="#5b6472">
        {monthDay(first.date)}
      </text>
      <text x={x(Date.parse(last.date))} y={H - 8} textAnchor="end" fontSize="11" fill="#5b6472">
        {monthDay(last.date)}
      </text>

      {/* 데이터 — 단일 시리즈 라인 + 점 (점의 title = 네이티브 툴팁) */}
      <polyline points={linePoints} fill="none" stroke="#3b6ea5" strokeWidth="2" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={x(Date.parse(p.date))} cy={y(p.ar)} r="4" fill="#3b6ea5" stroke="#fff" strokeWidth="1.5">
          <title>{`${p.title} · AR ${p.ar} · ${p.date}`}</title>
        </circle>
      ))}

      {/* 마지막 점 직접 라벨 — 지금 레벨이 헤드라인 */}
      <text
        x={Math.min(x(Date.parse(last.date)) + 8, W - pad.r)}
        y={y(last.ar) - 8}
        textAnchor="end"
        fontSize="11.5"
        fontWeight="700"
        fill="#2a4f77"
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
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q ? items.filter((item) => item.title.toLowerCase().includes(q)) : items;

  return (
    <>
      {/* 상단 요약 (SPEC §4-3) */}
      <section aria-label="읽기 요약" className="mb-6">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-line bg-card px-4 py-3">
            <p className="text-[12px] text-sub">총 권수</p>
            <p className="text-[24px] font-bold text-ink">
              {totalBooks}
              <span className="ml-1 text-[13px] font-semibold text-sub">권</span>
            </p>
          </div>
          <div className="rounded-2xl border border-line bg-card px-4 py-3">
            <p className="text-[12px] text-sub">최근 30일</p>
            <p className="text-[24px] font-bold text-ink">
              {recent30Books}
              <span className="ml-1 text-[13px] font-semibold text-sub">권</span>
            </p>
          </div>
        </div>
        <div className="mt-3 rounded-2xl border border-line bg-card px-4 py-3">
          <p className="mb-2 text-[12px] text-sub">AR 레벨 추이 — 읽은 날짜별, 그 책의 AR 지수</p>
          <ArTrendChart points={chartPoints} />
        </div>
      </section>

      {/* 제목 검색 (클라이언트 필터) */}
      <section aria-label="카드 목록">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="flex-none text-[15px] font-bold text-ink">만든 카드</h2>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="책 제목으로 검색"
            aria-label="책 제목으로 검색"
            className="w-full min-w-0 rounded-xl border border-line bg-card px-3 py-2 text-[13.5px] text-ink placeholder:text-sub focus:border-nonfiction focus:outline-none"
          />
        </div>

        {items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line bg-card px-5 py-6 text-center text-[13.5px] text-sub">
            아직 만든 카드가 없어요.{" "}
            <Link href="/" className="font-semibold text-nonfiction underline">
              홈에서 첫 카드를 만들어 볼까요?
            </Link>
          </p>
        ) : filtered.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line bg-card px-5 py-6 text-center text-[13.5px] text-sub">
            &ldquo;{query.trim()}&rdquo; 제목의 카드를 찾지 못했어요.
          </p>
        ) : (
          <ul className="grid gap-3">
            {filtered.map((item) => (
              <li key={item.cardId}>
                <Link
                  href={`/card/${item.cardId}`}
                  className="flex items-center gap-3 rounded-2xl border border-line bg-card p-4 transition hover:shadow-sm"
                >
                  {item.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 외부 썸네일, next/image 원격 설정은 과설계
                    <img
                      src={item.coverUrl}
                      alt=""
                      className="h-14 w-11 flex-none rounded-lg border border-line object-cover"
                    />
                  ) : (
                    <span
                      className={`flex h-12 w-12 flex-none items-center justify-center rounded-xl text-2xl ${
                        item.isFiction ? "bg-fiction/10" : "bg-nonfiction/10"
                      }`}
                      aria-hidden
                    >
                      {item.coverEmoji || "📖"}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-bold text-ink">{item.title}</span>
                    <span className="block truncate text-[12.5px] text-sub">
                      {item.author}
                      {item.series ? ` · ${item.series}` : ""}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-sub">
                      만든 날짜 {formatDate(item.createdAt)}
                    </span>
                  </span>
                  <span
                    className={`flex-none rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${
                      item.isFiction ? "bg-fiction/10 text-fiction" : "bg-nonfiction/10 text-nonfiction"
                    }`}
                  >
                    {item.arLevel != null ? `AR ${item.arLevel}` : "레벨 추정"}
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
