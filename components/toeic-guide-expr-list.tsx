"use client";

/**
 * ① 공략 읽기 끝의 **📘 교재 표현 목록**(읽기 전용 — docs/harness/toeic.md §12-13-1·§12-13-2, §12-12 34) — 클라이언트 컴포넌트.
 *
 * 2026-10-02: 유형 폴더의 교재 표현 **시험**을 닫고(③은 👀 틀 시험), 시험이 아닌 **표현 목록 자체**(교재 표현·뜻·교재 예문)는 지우지 않고 여기로
 * 옮겼다 — ① 본문 줄에 없는 교재 표현의 뜻·예문이 화면에서 사라지지 않게("교재 내용은 그대로"). 그래서 **시험 버튼·오답노트·기록·`?expr=`
 * 처리·말하기 상태·미리 받기가 없다**.
 * - 틀이 연결한 표현(templateLinksForGuide — ① 본문과 같은 표)에는 "🧩 외울 틀" 칩(→ ② 그 카드).
 * - 같은 자리 다른 표현(templateAlternateLinks — 틀 은행 alternates)에 든 표현은 목록 끝의 안쪽 접기 "↳ 같은 자리 다른 표현 n"에 모으고
 *   줄마다 "→ 🧩 {대표 틀}".
 * - 🔊는 **탭할 때만**(표현 영어 trim만 — 옛 목록·표현집 카드·시험 러너와 같은 캐시 키). 섹션 ▶·처음부터 대본에 들지 않고 미리 받지 않는다.
 * 이 파일은 지우지 않는다(기존 eval이 최상위에서 읽는다 — 검토 S1).
 */

import { useMemo } from "react";
import { speak } from "@/lib/speech";
import type { ToeicGuidePart, ToeicTemplate, ToeicTemplateAlternate } from "@/lib/toeic-guide-contract";
import { frameToExpression, templateAlternateLinks, templateLinksForGuide } from "@/lib/toeic-template";
import { expressionKey } from "@/lib/toeic-text";
import type { ToeicGuideExpressionItem } from "./toeic-guide-folder-view";
import s from "./toeic-guide-folder-view.module.css";

export default function ToeicGuideExprList({
  part,
  expressions,
  templates,
  alternates,
  onOpenTemplate,
}: {
  part: ToeicGuidePart;
  expressions: ToeicGuideExpressionItem[];
  /** 그 유형의 렌더 가능한 틀 */
  templates: ToeicTemplate[];
  /** 그 유형의 같은 자리 다른 표현(틀 은행 alternates) */
  alternates: ToeicTemplateAlternate[];
  onOpenTemplate: (key: string) => void;
}) {
  const links = useMemo(() => templateLinksForGuide({ items: templates }, part), [templates, part]);
  const altLinks = useMemo(() => templateAlternateLinks({ alternates }, part), [alternates, part]);
  const byKey = useMemo(() => new Map(templates.map((t) => [t.key, t] as const)), [templates]);
  const main = expressions.filter((e) => !altLinks.expressions.has(expressionKey(e.expression)));
  const alts = expressions.filter((e) => altLinks.expressions.has(expressionKey(e.expression)));

  function row(e: ToeicGuideExpressionItem, i: number, alt: boolean) {
    const k = expressionKey(e.expression);
    const frameKeys = alt ? [] : (links.expressions.get(k) ?? []);
    const rep = alt ? byKey.get(altLinks.expressions.get(k)?.[0] ?? "") : undefined;
    return (
      <li key={`${alt ? "a" : "m"}${i}`} className={s.expr}>
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
        {frameKeys.length > 0 && (
          <div className={s.exprChips}>
            <button type="button" className={s.linkChip} onClick={() => onOpenTemplate(frameKeys[0])} aria-label="이 표현의 템플릿 훈련 카드로">
              🧩 외울 틀{frameKeys.length > 1 ? ` ${frameKeys.length}` : ""}
            </button>
          </div>
        )}
        {rep && (
          <div className={s.exprChips}>
            <button type="button" className={s.linkChip} onClick={() => onOpenTemplate(rep.key)} aria-label="외울 틀의 템플릿 훈련 카드로">
              → 🧩 <span lang="en">{frameToExpression(rep.frameEn)}</span>
            </button>
          </div>
        )}
      </li>
    );
  }

  return (
    <div className={s.exprWrap}>
      <p className="t-caption">
        교재 표현 {expressions.length}개(읽기 전용 — 시험은 👀 틀 시험이 틀로 내요). 🔊는 누를 때만 소리 나요.
      </p>
      <ol className={s.exprList} aria-label="교재 표현">
        {main.map((e, i) => row(e, i, false))}
      </ol>
      {alts.length > 0 && (
        <details className={s.exprAltFold}>
          <summary className={s.exprAltSummary}>↳ 같은 자리 다른 표현 {alts.length}</summary>
          <ol className={s.exprList} aria-label="같은 자리 다른 표현">
            {alts.map((e, i) => row(e, i, true))}
          </ol>
        </details>
      )}
    </div>
  );
}
