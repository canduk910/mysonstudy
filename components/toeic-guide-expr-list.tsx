"use client";

/**
 * ③ 📝 표현 시험 탭의 **표현 목록** (docs/harness/toeic.md §12-6·§12-5-7) — 클라이언트 컴포넌트.
 *
 * 머리에 **시험 화면으로 가는 버튼**(T8 — 기존 표현 시험 화면 그대로, 주소는 `/toeic/sets/guide-{part}/…`): 👀 5지선다 시험(뜻 → 표현 ·
 * 표현 → 뜻, 한 판 최대 20문항 — 약한 것부터) · 📝 교재 문장 말하기(말하기 통계로 약한 문장부터 10개 — ② "🧩 틀 테스트"와 이름으로 가른다,
 * §12-6 검토 S11) · 📕 오답노트 · 📊 기록. 시험 화면의 "뒤로"는 이 탭으로 돌아온다(서버 페이지가 toeicSetBackLink로 내려준다).
 * 목록에는 **틀로 가는 🧩 칩** — 틀 은행의 어떤 틀이 `guideRefs`(kind "expression")로 가리키는 표현 옆에 "🧩 틀"
 * 칩과 그 틀의 테스트 상태(틀 바꿔 말하기 배지 — 틀 세션만 읽는다, 숙련도는 섞지 않는다). 누르면 ② 탭의 그 틀로 간다. `?expr=`로
 * 열리면 그 줄로 스크롤한다(틀 카드의 "📘 교재 틀" 칩이 여기로 온다). 판정은 templateLinksForGuide 하나(§12-4 — ① 탭과 같은 함수).
 *
 * 🔊·프리페치(§12-6): 표현 영어는 **trim만** 한 글자로 — 표현집 카드·시험 러너의 🔊와 캐시 키가 같아야 한다(공략 읽기의 정리 함수를
 * 쓰지 않는다, `~`도 그대로). 탭을 열 때만 미리 받는다(폴더를 여는 것만으로는 받지 않는다 — 이 컴포넌트는 탭이 열릴 때만 올라온다).
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { prefetchSpeech, speak } from "@/lib/speech";
import { toeicGuideSetId } from "@/lib/toeic-guide";
import type { ToeicGuidePart, ToeicTemplate } from "@/lib/toeic-guide-contract";
import { TOEIC_GUIDE_CHOICE_SESSION_MAX } from "@/lib/toeic-quiz";
import { TOEIC_TEMPLATE_BADGE_LABELS_KO, findGuideExpressionIndex } from "@/lib/toeic-guide-view";
import type { ToeicTemplateQuizMode } from "@/lib/toeic-quiz";
import { templateLinksForGuide, type ToeicTemplateBadge } from "@/lib/toeic-template";
import { expressionKey } from "@/lib/toeic-text";
import type { ToeicGuideExpressionItem } from "./toeic-guide-folder-view";
import s from "./toeic-guide-folder-view.module.css";

export default function ToeicGuideExprList({
  part,
  expressions,
  speakCount,
  templates,
  badges,
  focusExpr,
  onOpenTemplate,
}: {
  part: ToeicGuidePart;
  expressions: ToeicGuideExpressionItem[];
  speakCount: number;
  templates: ToeicTemplate[];
  badges: Record<ToeicTemplateQuizMode, Record<string, ToeicTemplateBadge>>;
  focusExpr: string | null;
  onOpenTemplate: (key: string) => void;
}) {
  const links = useMemo(() => templateLinksForGuide({ items: templates }, part), [templates, part]);
  const listRef = useRef<HTMLOListElement>(null);
  const [flash, setFlash] = useState<number | null>(null);

  // 프리페치 — 표현 영어(trim만, 최대 60 — PREFETCH_MAX_ITEMS 90 안). 키는 문자열(참조 변경으로 재시작하지 않게)
  const prefetchKey = useMemo(
    () =>
      expressions
        .map((e) => e.expression.trim())
        .filter((t) => t !== "")
        .join("\u0001"),
    [expressions],
  );
  useEffect(() => {
    if (!prefetchKey) return;
    return prefetchSpeech(prefetchKey.split("\u0001"), "en-US");
  }, [prefetchKey]);

  // ?expr= → 그 줄로 스크롤·잠깐 강조
  useEffect(() => {
    const i = findGuideExpressionIndex(expressions, focusExpr);
    if (i < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-expr="${i}"]`);
    el?.scrollIntoView({ block: "center" });
    setFlash(i);
    const t = window.setTimeout(() => setFlash(null), 2400);
    return () => window.clearTimeout(t);
  }, [focusExpr, expressions]);

  const base = `/toeic/sets/${toeicGuideSetId(part)}`;

  return (
    <div className={s.exprWrap}>
      <section className={s.exprActions} aria-label="표현 시험">
        <div className={s.exprActionRow}>
          <Link href={`${base}/quiz`} className="u-btn u-btn-primary">
            👀 5지선다 시험
          </Link>
          {speakCount > 0 ? (
            <Link href={`${base}/quiz?modes=speak`} className="u-btn u-btn-primary">
              📝 교재 문장 말하기
            </Link>
          ) : (
            <span className={s.exprActionOff} aria-disabled="true">
              📝 교재 문장 말하기 — 문항 없음
            </span>
          )}
        </div>
        <div className={s.exprActionRow}>
          <Link href={`${base}/wrong`} className="u-btn u-btn-secondary">
            📕 오답노트
          </Link>
          <Link href={`${base}/history`} className="u-btn u-btn-secondary">
            📊 기록
          </Link>
        </div>
        <p className="t-caption">
          5지선다는 뜻 → 표현 · 표현 → 뜻, 한 판 최대 {TOEIC_GUIDE_CHOICE_SESSION_MAX}문항(약한 것부터). 교재 문장 말하기는 우리말을 보고 소리 내어
          말한 뒤 스스로 채점해요(약한 문장부터 10개).
        </p>
      </section>
      <p className="t-caption">
        공략 표현 {expressions.length}개 · 교재 문장 말하기 {speakCount}개
      </p>
      <ol ref={listRef} className={s.exprList} aria-label="공략 표현">
        {expressions.map((e, i) => {
          const keys = links.expressions.get(expressionKey(e.expression)) ?? [];
          const tplKey = keys[0] ?? null;
          const swap = tplKey ? (badges["tpl-swap"][tplKey] ?? "new") : null;
          return (
            <li key={i} data-expr={i} className={`${s.expr} ${flash === i ? s.exprFocus : ""}`}>
              <div className={s.exprRow}>
                {e.no !== null && <span className={s.exprNo}>{String(e.no).padStart(2, "0")}</span>}
                <p className={s.exprEn} lang="en">
                  {e.expression}
                </p>
                <button type="button" className={s.speak} onClick={() => speak(e.expression.trim(), "en-US")} aria-label={`${e.expression} 듣기`}>
                  🔊
                </button>
              </div>
              <p className={s.exprKo}>{e.meaningKo}</p>
              {e.example && (
                <p className={s.exprExample} lang="en">
                  {e.example}
                </p>
              )}
              {tplKey && swap && (
                <div className={s.exprChips}>
                  <button type="button" className={s.linkChip} onClick={() => onOpenTemplate(tplKey)} aria-label="이 표현의 템플릿 훈련 틀로">
                    🧩 틀{keys.length > 1 ? ` ${keys.length}` : ""}
                  </button>
                  <span className="u-chip">틀 바꿔 말하기 · {TOEIC_TEMPLATE_BADGE_LABELS_KO[swap]}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
