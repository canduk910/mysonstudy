"use client";

/**
 * ③ 👀 틀 시험 탭 (docs/harness/toeic.md §12-13-2, SPEC §20-10) — 유형 폴더의 세 번째 탭(클라이언트 컴포넌트). 2026-10-02부터 교재 표현 시험
 * 대신 **그 유형의 틀**을 보고 고르고 빈칸을 채운다 — ② 🧩 틀 테스트(말하기)를 보완하는 "보는 눈·손" 연습. AI 0.
 *
 * - 머리: 모드 칩 셋(한→영 고르기 · 영→뜻 고르기 · 빈칸 채우기 — 기본 셋 다 켬, 칩마다 그 범위에서 낼 수 있는 문항 수), 범위 칩(유형 전체 기본 ·
 *   단계마다 · 묶음마다 — ② 따라 말하기와 같은 단위), "시작 (n문항)"(n = min(낼 수 있는 틀 수, 20)) → 러너 주소(번호 `i`만 — 교재 단계·
 *   묶음 이름을 주소에 싣지 않는다). 낼 수 있는 문항 수는 출제 함수(buildTemplateChoiceQuestions — 클라이언트 안전 순수 함수)를 세션 없이 돌려
 *   센다(출제 가능 여부는 세션과 무관 — 보기 2개 이상·빈칸 후보 유무만 본다).
 * - **틀린 틀**(오답노트 — 따로 페이지를 두지 않는다): 모드 탭 셋 — 줄마다 틀 줄·한국어 틀·오답 수·배지·"🧩 카드로"(② 그 카드), 탭 머리
 *   "틀린 틀만 다시 시험 · n". 자료는 서버 페이지가 틀 은행 세션으로 만들어 넘긴다(고르기 세 모드 통계 — 말하기와 섞지 않는다).
 * - **최근 틀 시험**: 같은 startedAt의 모드 문서를 한 줄로(recentTemplateChoiceTests — 서버 요약).
 * 문제를 소리로 읽지 않는 규칙·저장은 러너(components/toeic-template-quiz.tsx)가 한다. 이 탭은 소리를 내지 않고 미리 받지도 않는다.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { FrameLine } from "@/components/toeic-template-lines";
import type { ToeicGuidePart, ToeicTemplate, ToeicTemplateChoiceMode, ToeicTemplateFlow } from "@/lib/toeic-guide-contract";
import { TOEIC_TEMPLATE_BADGE_LABELS_KO, slotToneMap, toeicTemplateChoiceQuizHref, type ToeicTemplateChoiceScope } from "@/lib/toeic-guide-view";
import { TOEIC_TEMPLATE_CHOICE_MODES, TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO } from "@/lib/toeic-quiz";
import { frameSlotNames, templateFlowOrder, type ToeicTemplateBadge } from "@/lib/toeic-template";
import { TOEIC_TEMPLATE_CHOICE_MAX, buildTemplateChoiceQuestions, type ToeicRecentTemplateChoiceTest } from "@/lib/toeic-template-quiz";
import s from "./toeic-template-quiz.module.css";

/** 서버 페이지가 넘기는 ③ 탭 자료(직렬화 가능한 값만 — 그 유형 틀만) */
export interface ToeicTemplateQuizTabData {
  /** 모드마다 틀린 틀(틀렸고 미졸업) — 오답 많은 순 */
  wrong: Record<ToeicTemplateChoiceMode, { key: string; wrong: number; badge: ToeicTemplateBadge }[]>;
  /** 최근 틀 시험(같은 startedAt의 모드 문서를 한 줄로 — 최신 10) */
  recent: ToeicRecentTemplateChoiceTest[];
}

/** 낼 수 있는 문항 수 세기용 고정 rng — 셈은 rng와 무관하지만 Math.random을 렌더에서 부르지 않게(hydration 안전) */
function fixedRng(): () => number {
  let x = 7;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/** 모드 칩 짧은 이름(문항 머리 칩과 같다) */
export const TOEIC_TEMPLATE_CHOICE_MODE_SHORT_KO: Record<ToeicTemplateChoiceMode, string> = {
  "tpl-ko-frame": "한→영",
  "tpl-frame-ko": "영→뜻",
  "tpl-cloze": "빈칸",
};

export default function ToeicTemplateQuizTab({
  part,
  templates,
  flows,
  data,
  onOpenTemplate,
  onOpenTemplatesTab,
}: {
  part: ToeicGuidePart;
  /** 그 유형의 렌더 가능한 틀(testFills 비움) */
  templates: ToeicTemplate[];
  flows: ToeicTemplateFlow[];
  data: ToeicTemplateQuizTabData;
  onOpenTemplate: (key: string) => void;
  onOpenTemplatesTab: () => void;
}) {
  const groups = useMemo(() => templateFlowOrder({ flows, items: templates }, part), [flows, templates, part]);
  const flow = useMemo(() => flows.find((f) => f.part === part) ?? null, [flows, part]);
  const byKey = useMemo(() => new Map(templates.map((t) => [t.key, t] as const)), [templates]);
  /** 단계 이름(흐름 순서, 처음 나온 순서) — 러너 주소의 번호 i와 같은 번호 매김(templateChoiceScopeTemplates) */
  const steps = useMemo(() => {
    const out: string[] = [];
    for (const g of groups) if (g.kind === "step" && g.stepKo !== null && !out.includes(g.stepKo)) out.push(g.stepKo);
    return out;
  }, [groups]);

  const [modes, setModes] = useState<ToeicTemplateChoiceMode[]>([...TOEIC_TEMPLATE_CHOICE_MODES]);
  const [scope, setScope] = useState<{ kind: Extract<ToeicTemplateChoiceScope, "all" | "step" | "group">; i: number | null }>({ kind: "all", i: null });
  const [wrongMode, setWrongMode] = useState<ToeicTemplateChoiceMode>(() => TOEIC_TEMPLATE_CHOICE_MODES.find((m) => data.wrong[m].length > 0) ?? "tpl-ko-frame");

  const scopeTemplates = useMemo(() => {
    if (scope.kind === "group" && scope.i !== null) return groups[scope.i]?.templates ?? [];
    if (scope.kind === "step" && scope.i !== null) {
      const stepKo = steps[scope.i];
      return groups.filter((g) => g.kind === "step" && g.stepKo === stepKo).flatMap((g) => g.templates);
    }
    return groups.flatMap((g) => g.templates);
  }, [scope, groups, steps]);

  /** 모드마다 이 범위에서 낼 수 있는 문항 수(한 틀 한 문항 — 모드 하나만 켜면 틀 수 이하) */
  const countByMode = useMemo(() => {
    const out = {} as Record<ToeicTemplateChoiceMode, number>;
    for (const m of TOEIC_TEMPLATE_CHOICE_MODES) {
      out[m] = buildTemplateChoiceQuestions(scopeTemplates, templates, [], { modes: [m], max: 10_000, rng: fixedRng(), flow }).questions.length;
    }
    return out;
  }, [scopeTemplates, templates, flow]);
  const startCount = useMemo(() => {
    if (modes.length === 0) return 0;
    const n = buildTemplateChoiceQuestions(scopeTemplates, templates, [], { modes, max: 10_000, rng: fixedRng(), flow }).questions.length;
    return Math.min(n, TOEIC_TEMPLATE_CHOICE_MAX);
  }, [modes, scopeTemplates, templates, flow]);

  const toggleMode = (m: ToeicTemplateChoiceMode) =>
    setModes((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : TOEIC_TEMPLATE_CHOICE_MODES.filter((x) => x === m || prev.includes(x))));

  const startHref = toeicTemplateChoiceQuizHref(part, { modes, scope: scope.kind, i: scope.i });
  const wrongList = data.wrong[wrongMode];

  return (
    <div className={s.wrap} data-testid="tpl-quiz-tab">
      <p className={s.lead}>
        외운 틀을 보고 고르고 빈칸을 채워요 — 소리 내어 말하는 시험은{" "}
        <button type="button" className={s.leadLink} onClick={onOpenTemplatesTab}>
          🧩 틀 테스트
        </button>
        .
      </p>

      <section className={s.box} aria-label="틀 시험 시작">
        <p className={s.rowLabel}>방식</p>
        <div className={s.chipRow} role="group" aria-label="시험 방식">
          {TOEIC_TEMPLATE_CHOICE_MODES.map((m) => (
            <button key={m} type="button" aria-pressed={modes.includes(m)} className={`${s.chip} ${modes.includes(m) ? s.chipOn : ""}`} onClick={() => toggleMode(m)}>
              {TOEIC_TEMPLATE_CHOICE_MODE_LABELS_KO[m]} · {countByMode[m]}
            </button>
          ))}
        </div>

        <p className={s.rowLabel}>범위</p>
        <div className={s.chipRow} role="group" aria-label="범위">
          <button type="button" aria-pressed={scope.kind === "all"} className={`${s.chip} ${scope.kind === "all" ? s.chipOn : ""}`} onClick={() => setScope({ kind: "all", i: null })}>
            유형 전체 · 틀 {templates.length}
          </button>
          {steps.map((st, i) => {
            const on = scope.kind === "step" && scope.i === i;
            return (
              <button key={`st-${i}`} type="button" aria-pressed={on} className={`${s.chip} ${on ? s.chipOn : ""}`} onClick={() => setScope({ kind: "step", i })}>
                단계 {i + 1} · {st}
              </button>
            );
          })}
        </div>
        {groups.length > 1 && (
          <details className={s.groupFold} open={scope.kind === "group" ? true : undefined}>
            <summary>묶음마다 고르기 · {groups.length}묶음</summary>
            <div className={s.chipRow} role="group" aria-label="묶음">
              {groups.map((g, i) => {
                const on = scope.kind === "group" && scope.i === i;
                return (
                  <button key={`g-${i}`} type="button" aria-pressed={on} className={`${s.chip} ${on ? s.chipOn : ""}`} onClick={() => setScope({ kind: "group", i })}>
                    {g.groupKo} · {g.templates.length}
                  </button>
                );
              })}
            </div>
          </details>
        )}

        <div className={s.startRow}>
          {startCount > 0 ? (
            <Link href={startHref} className="u-btn u-btn-primary" data-testid="tpl-quiz-start">
              👀 시작 ({startCount}문항)
            </Link>
          ) : (
            <button type="button" className="u-btn u-btn-primary" disabled>
              👀 시작
            </button>
          )}
        </div>
        <p className={s.caption}>
          한 판 최대 {TOEIC_TEMPLATE_CHOICE_MAX}문항 · 약한 틀부터 · 한 틀은 한 판에 한 번 · 방식별로 묶어 나와요. 고르기는 자리를 ~로 가려요. 답을 고르면
          영어 틀을 읽어 주고 예문 한 줄을 보여요. 방식마다 숙련도를 따로 세요(서로 다른 날 두 번 잇달아 맞히면 졸업).
        </p>
      </section>

      <section className={s.box} aria-label="틀린 틀">
        <p className={s.boxTitle}>📕 틀린 틀</p>
        <div className={s.chipRow} role="group" aria-label="방식별 틀린 틀">
          {TOEIC_TEMPLATE_CHOICE_MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={wrongMode === m}
              className={`${s.chip} ${wrongMode === m ? s.chipOn : ""}`}
              onClick={() => setWrongMode(m)}
            >
              {TOEIC_TEMPLATE_CHOICE_MODE_SHORT_KO[m]} · {data.wrong[m].length}
            </button>
          ))}
        </div>
        {wrongList.length > 0 ? (
          <>
            <div className={s.startRow}>
              <Link href={toeicTemplateChoiceQuizHref(part, { modes: [wrongMode], scope: "wrong", wrong: wrongMode })} className="u-btn u-btn-secondary">
                틀린 틀만 다시 시험 · {wrongList.length}
              </Link>
            </div>
            <ul className={s.list}>
              {wrongList.map((w) => {
                const t = byKey.get(w.key);
                if (!t) return null;
                const tones = slotToneMap(frameSlotNames(t.frameEn));
                return (
                  <li key={w.key} className={s.item}>
                    <p className={s.itemEn} lang="en">
                      <FrameLine frame={t.frameEn} tones={tones} lang="en" />
                    </p>
                    <p className={s.itemKo}>
                      <FrameLine frame={t.frameKo} tones={tones} lang="ko" />
                    </p>
                    <div className={s.itemFoot}>
                      <span className="u-chip">✕ {w.wrong}</span>
                      <span className="u-chip">{TOEIC_TEMPLATE_BADGE_LABELS_KO[w.badge]}</span>
                      <button type="button" className={s.cardLink} onClick={() => onOpenTemplate(w.key)}>
                        🧩 카드로
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className={s.caption}>이 방식에서 틀린 틀이 없어요.</p>
        )}
      </section>

      <section className={s.box} aria-label="최근 틀 시험">
        <p className={s.boxTitle}>📊 최근 틀 시험</p>
        {data.recent.length > 0 ? (
          <ul className={s.list}>
            {data.recent.map((r) => (
              <li key={r.startedAt} className={s.recentRow}>
                <span>{r.whenKo}</span>
                <span>{r.modes.map((m) => TOEIC_TEMPLATE_CHOICE_MODE_SHORT_KO[m]).join(" · ")}</span>
                <span className={s.recentScore}>
                  ○ {r.correct} / {r.answered}
                </span>
                {!r.finished && <span className="u-chip">그만둠</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.caption}>아직 틀 시험 기록이 없어요.</p>
        )}
      </section>
    </div>
  );
}
