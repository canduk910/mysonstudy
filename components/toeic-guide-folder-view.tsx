"use client";

/**
 * 유형 폴더 화면 (docs/harness/toeic.md §12-8) — 클라이언트 컴포넌트. 서버 페이지(`app/toeic/guides/[part]/page.tsx`)가 읽어 넘긴
 * 자료로 탭을 가른다.
 *
 * - 탭: 학습 흐름 순서(① 📖 공략 읽기 ② 🧩 템플릿 훈련 ③ 📝 표현 시험 ④ 🎤 한 문제 연습). **주소가 탭을 기억한다**(`?tab=` — useSearchParams로 읽고, 탭을 누르면 `history.pushState` — Next 라우터와 동기화되어
 *   서버를 다시 부르지 않는다). `?tab`이 없으면 그 유형 틀이 있으면 ②, 없으면 ①(resolveGuideTab — §12-8).
 * - 탭을 바꾸면 이전 탭 컴포넌트가 내려가며 그 탭의 재생이 멈춘다(정지 조건 "탭 전환" — 각 뷰의 언마운트 정리).
 * - 교재 ↔ 틀 오가기(§12-4 🧩 칩 · §12-5-7 📘 교재 틀 칩): 같은 폴더면 pushState(`?tab=templates&tpl=` / `?tab=read&goto=` /
 *   `?tab=quiz&expr=`), 다른 유형 폴더면 router.push. 받는 탭이 그 줄·블록·카드로 스크롤한다.
 * - 빈 상태: 공략이 없으면 📖·📝 탭은 "아직 공략 자료가 없어요", 틀이 없으면 🧩 탭은 "아직 틀이 없어요" — 둘 다 "📂 파일로 가져오기".
 *   ④ 🎤 한 문제 연습은 공략·틀 없이도 된다(AI가 새로 만든다 — §12-8).
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";
import ToeicGuideImportButton from "@/components/toeic-guide-import-button";
import ToeicGuideExprList from "@/components/toeic-guide-expr-list";
import ToeicDrillView, { type ToeicDrillTabData } from "@/components/toeic-drill-view";
import ToeicGuideReadView from "@/components/toeic-guide-read-view";
import ToeicTemplateView from "@/components/toeic-template-view";
import type { ToeicGuidePart, ToeicGuideSection, ToeicTemplate, ToeicTemplateFlow } from "@/lib/toeic-guide-contract";
import { TOEIC_GUIDE_TAB_LABELS_KO, resolveGuideTab, type ToeicGuideTab } from "@/lib/toeic-guide-view";
import type { ToeicQuizMode, ToeicTemplateQuizMode } from "@/lib/toeic-quiz";
import type { ToeicTemplateBadge } from "@/lib/toeic-template";
import type { ToeicRecentTemplateTest } from "@/lib/toeic-template-test-view";
import s from "./toeic-guide-folder-view.module.css";

/** 폴더 탭(학습 흐름 순서 — ① 읽기 ② 템플릿 훈련 ③ 표현 시험 ④ 한 문제 연습) */
const AVAILABLE_TABS: readonly ToeicGuideTab[] = ["read", "templates", "quiz", "drill"];

export interface ToeicGuideExpressionItem {
  no: number | null;
  expression: string;
  meaningKo: string;
  example: string | null;
  exampleKo: string | null;
}

/** 서버 페이지가 넘기는 자료(직렬화 가능한 값만) */
export interface ToeicGuideFolderData {
  part: ToeicGuidePart;
  partLabelKo: string;
  guide: { sections: ToeicGuideSection[]; expressions: ToeicGuideExpressionItem[]; speakCount: number } | null;
  /** 공략 문서가 있는데 모양이 깨져 열 수 없다 */
  guideBroken: boolean;
  /**
   * 그 유형의 렌더 가능한 틀(파일 순서). **testFills는 비워서 넘긴다**(서버 페이지) — 틀 바꿔 말하기의 정답 채움이라 ② 카드·페이지 소스에
   * 먼저 나오지 않게(§12-5-1 "테스트 전용 채움은 카드에 보이지 않는다", S1 QA P3-6). 테스트 화면은 틀 은행을 따로 읽는다.
   */
  templates: ToeicTemplate[];
  /** 그 유형 흐름(0~1개) */
  flows: ToeicTemplateFlow[];
  /** 열지 못한 틀 수 */
  brokenTemplates: number;
  /** 틀 모음 문서가 있는데 모양이 깨졌다 */
  bankBroken: boolean;
  /** 모드마다 틀 key → 배지(시도한 틀만 — 없으면 안 해 봄) */
  badges: Record<ToeicTemplateQuizMode, Record<string, ToeicTemplateBadge>>;
  /** 두 테스트 모드 중 하나라도 틀렸고 미졸업(그 유형 틀만) */
  wrongKeys: string[];
  /** 틀 바꿔 말하기 졸업(그 유형 틀만) */
  masteredKeys: string[];
  /** 틀이 연결한 교재 표현(expressionKey) → 시도가 있는 표현 시험 모드의 상태 */
  exprBadges: Record<string, { mode: ToeicQuizMode; badge: "mastered" | "progress" | "wrong" }[]>;
  /** 그 유형 틀이 든 틀 세션 최신 10개(서버 요약 — §12-5-6 최근 테스트) */
  recentTests: ToeicRecentTemplateTest[];
  /** 모드마다 그 유형의 틀린 틀 수(틀렸고 미졸업) */
  wrongCounts: Record<ToeicTemplateQuizMode, number>;
  /** ④ 한 문제 연습 탭 자료(최근 연습·응시 전 연습·답변 흐름 — 파트 본문 없음) */
  drill: ToeicDrillTabData;
}

export default function ToeicGuideFolderView({ data }: { data: ToeicGuideFolderData }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tabsRef = useRef<HTMLDivElement>(null);

  const tab = resolveGuideTab(params.get("tab"), data.templates.length, AVAILABLE_TABS);
  const focusTpl = tab === "templates" ? params.get("tpl") : null;
  const goto = tab === "read" ? params.get("goto") : null;
  const focusExpr = tab === "quiz" ? params.get("expr") : null;
  const initialRange = tab === "templates" && params.get("range") === "wrong" ? "wrong" : null;

  // 폰에서 탭 줄은 가로로 넘친다(탭 넷) — 고른 탭이 줄 밖에 있으면 줄만 가로로 밀어 보이게 한다(페이지는 스크롤하지 않는다)
  useEffect(() => {
    const strip = tabsRef.current;
    const on = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !on) return;
    const r = on.getBoundingClientRect();
    const sr = strip.getBoundingClientRect();
    if (r.right > sr.right) strip.scrollLeft += r.right - sr.right + 8;
    else if (r.left < sr.left) strip.scrollLeft -= sr.left - r.left + 8;
  }, [tab]);

  /** 폴더 안 이동(탭·칩) — 같은 폴더면 pushState(서버 왕복 없음), 다른 폴더면 라우터 이동 */
  const navigate = useCallback(
    (href: string) => {
      const url = new URL(href, window.location.href);
      if (url.pathname === pathname) {
        window.history.pushState(null, "", `${url.pathname}${url.search}`);
        // 탭 줄이 화면 위로 지나갔으면 탭 머리로 올려 새 탭의 처음이 보이게(칩 이동은 받는 탭이 그 줄로 다시 스크롤한다)
        const el = tabsRef.current;
        if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
      } else {
        router.push(`${url.pathname}${url.search}`);
      }
    },
    [pathname, router],
  );

  const openTemplate = useCallback((key: string) => navigate(`${pathname}?tab=templates&tpl=${encodeURIComponent(key)}`), [navigate, pathname]);

  const emptyGuide = useMemo(
    () => (
      <div className={s.empty}>
        <p className={s.emptyText}>
          {data.guideBroken ? "⚠️ 이 유형 공략의 형식이 맞지 않아 열지 못했어요. 가져오기 파일을 다시 넣어 주세요." : "아직 공략 자료가 없어요."}
        </p>
        <ToeicGuideImportButton />
      </div>
    ),
    [data.guideBroken],
  );

  return (
    <div>
      <div ref={tabsRef} role="tablist" aria-label="폴더 탭" className={s.tabs}>
        {AVAILABLE_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`${s.tab} ${tab === t ? s.tabOn : ""}`}
            onClick={() => {
              if (t !== tab) navigate(`${pathname}?tab=${t}`);
            }}
          >
            {TOEIC_GUIDE_TAB_LABELS_KO[t]}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={TOEIC_GUIDE_TAB_LABELS_KO[tab]}>
        {tab === "read" &&
          (data.guide ? (
            <ToeicGuideReadView part={data.part} sections={data.guide.sections} templates={data.templates} goto={goto} onOpenTemplate={openTemplate} />
          ) : (
            emptyGuide
          ))}

        {tab === "templates" &&
          (data.templates.length > 0 ? (
            <ToeicTemplateView
              part={data.part}
              partLabelKo={data.partLabelKo}
              templates={data.templates}
              flows={data.flows}
              badges={data.badges}
              wrongKeys={data.wrongKeys}
              masteredKeys={data.masteredKeys}
              exprBadges={data.exprBadges}
              brokenTemplates={data.brokenTemplates}
              recentTests={data.recentTests}
              wrongCounts={data.wrongCounts}
              initialRange={initialRange}
              focusKey={focusTpl}
              onNavigate={navigate}
            />
          ) : (
            <div className={s.empty}>
              <p className={s.emptyText}>
                {data.bankBroken
                  ? "⚠️ 틀 모음 문서의 형식이 맞지 않아 열지 못했어요. 가져오기 파일을 다시 넣어 주세요."
                  : data.brokenTemplates > 0
                    ? `아직 틀이 없어요(열지 못한 틀 ${data.brokenTemplates}개).`
                    : "아직 틀이 없어요."}
              </p>
              <ToeicGuideImportButton />
            </div>
          ))}

        {tab === "quiz" &&
          (data.guide ? (
            <ToeicGuideExprList
              part={data.part}
              expressions={data.guide.expressions}
              speakCount={data.guide.speakCount}
              templates={data.templates}
              badges={data.badges}
              focusExpr={focusExpr}
              onOpenTemplate={openTemplate}
            />
          ) : (
            emptyGuide
          ))}

        {tab === "drill" && <ToeicDrillView part={data.part} partLabelKo={data.partLabelKo} data={data.drill} onOpenTemplate={openTemplate} />}
      </div>
    </div>
  );
}
