"use client";

/**
 * 영어 공통 셸 내비게이션 (IA 재편) — 클라이언트 컴포넌트.
 *
 * `app/english/layout.tsx`(서버)가 이걸 `{children}` 위에 얹어, `/english/*` 모든 화면에 같은
 * 학습 메뉴를 붙인다. lg↑에서는 좌측 고정 사이드바, lg미만에서는 상단 버거 → 드로어.
 *
 * ── 현재 섹션 하이라이트 ────────────────────────────────────────────────────
 * `usePathname()`를 startsWith로 매칭한다. usePathname은 SSR/CSR이 같은 요청에 같은 값을 주므로
 * 첫 페인트부터 하이라이트가 맞아 hydration mismatch가 없다. 서재(`/library`)는 셸 밖 경로라
 * 매칭 대상이 아니다(링크만).
 *
 * ── 드로어 ─────────────────────────────────────────────────────────────────
 * 열림 상태는 클라이언트 로컬(초기 false → SSR/CSR 동일). ESC·바깥클릭·링크클릭으로 닫고, 열린
 * 동안 body 스크롤을 잠근다. `aria-expanded`/`aria-controls`/`role="dialog"`까지 — 포커스 트랩은
 * 과설계라 두지 않는다(설계 문서).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import s from "./english-nav.module.css";

interface NavItem {
  href: string;
  icon: string;
  label: string;
  /** startsWith 매칭 접두사. null이면 하이라이트 안 함(셸 밖 경로) */
  match: string | null;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/english/books", icon: "🏠", label: "북카드", match: "/english/books" },
  { href: "/english/vocab", icon: "📓", label: "단어장", match: "/english/vocab" },
  { href: "/library", icon: "📚", label: "서재", match: null },
];

function NavMenu({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className={s.menu} aria-label="영어 학습 메뉴">
      {NAV_ITEMS.map((item) => {
        const active = item.match != null && pathname.startsWith(item.match);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`${s.link} ${active ? s.linkActive : ""}`}
          >
            <span className={s.linkIcon} aria-hidden>
              {item.icon}
            </span>
            {item.label}
          </Link>
        );
      })}
      <Link href="/" onClick={onNavigate} className={`${s.link} ${s.subjectLink}`}>
        <span className={s.linkIcon} aria-hidden>
          ←
        </span>
        과목 선택
      </Link>
    </nav>
  );
}

export default function EnglishNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // 드로어 열린 동안: ESC로 닫기 + body 스크롤 잠금 (카드 오버레이와 같은 규약)
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      {/* 데스크톱 좌측 사이드바 (lg↑) */}
      <aside className={s.sidebar} aria-label="영어 사이드바">
        <Link href="/english" className={`${s.brand} ${s.brandRow}`}>
          <span className={s.brandIcon} aria-hidden>
            📚
          </span>
          은우 영어
        </Link>
        <NavMenu pathname={pathname} />
      </aside>

      {/* 모바일 상단바 (<lg) */}
      <div className={s.topbar}>
        <button
          type="button"
          className={s.burger}
          aria-label="메뉴 열기"
          aria-expanded={open}
          aria-controls="english-drawer"
          onClick={() => setOpen(true)}
        >
          ☰
        </button>
        <Link href="/english" className={s.brand}>
          <span className={s.brandIcon} aria-hidden>
            📚
          </span>
          은우 영어
        </Link>
      </div>

      {/* 모바일 드로어 (열렸을 때만 DOM) */}
      {open && (
        <>
          <div className={s.backdrop} onClick={() => setOpen(false)} aria-hidden />
          <div
            id="english-drawer"
            className={s.panel}
            role="dialog"
            aria-modal="true"
            aria-label="영어 학습 메뉴"
          >
            <div className={s.panelHeader}>
              <Link href="/english" onClick={() => setOpen(false)} className={s.brand}>
                <span className={s.brandIcon} aria-hidden>
                  📚
                </span>
                은우 영어
              </Link>
              <button
                type="button"
                className={s.closeBtn}
                aria-label="메뉴 닫기"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>
            <NavMenu pathname={pathname} onNavigate={() => setOpen(false)} />
          </div>
        </>
      )}
    </>
  );
}
