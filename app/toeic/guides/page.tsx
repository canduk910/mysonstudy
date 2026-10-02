/**
 * 유형별 공략 폴더 목록 `/toeic/guides` (docs/harness/toeic.md §12-8, SPEC §20-10) — 서버 컴포넌트.
 *
 * 유형 폴더 넷(Q3–4 사진 묘사 · Q5–7 듣고 답하기 · Q8–10 정보 활용 · Q11 의견 말하기)을 **파일이 없어도** 보인다. 폴더 카드에는
 * 가져왔는지(공략 섹션 n)와 **외울 틀 n · 익힘 m**(m = 틀 바꿔 말하기 졸업 수 — §12-5-6), **연습 n · 마지막 점수**(한 문제 연습 — 연습
 * 문서 수와 최신순으로 처음 만나는 "녹음된 문항을 다 채점한" 연습의 점수 합/만점, §12-8)를 보인다. 2026-10-02(§12-13): 교재 표현 시험을
 * 닫아 카드의 "표현 n · 말하기 n"을 뺐다 — 폴더의 네 기능(읽기·따라 말하기·틀 시험·한 문제 연습)이 틀 은행 하나를 중심으로 돈다.
 * 2026-10-03(SPEC §15-4): "외울 틀 n · 익힘 m" 옆에 **시험 응시 배지**("시험 전 / 오늘 ✓ · 8/10 / ✓ 10월 2일 · 8/10") — ② 틀 테스트·③ 틀 시험
 * 중 그 유형 틀을 답한 마지막 판(templateSessionsForPart → lib/test-status). 이미 읽는 틀 은행 세션을 그대로 쓴다(추가 쿼리 없음).
 *
 * 읽기: 공략 문서는 결정적 id(`guide-{part}`)·틀 은행은 `guide-templates`라 목록 전체를 훑지 않고 id로 읽는다. 틀 테스트 세션은
 * `setId`가 하나(`guide-templates`)라 한 번 읽어 네 폴더에 나눠 쓴다(§12-5-6). 연습은 유형마다 `listToeicDrills`(등호 하나), 응시는
 * 한 번 읽어 메모리에서 모은다(가족 규모). 렌더 판정은 lib/toeic-record 단일 정의처
 * (유형 공략 isRenderableToeicSet + isRenderableToeicGuide, 틀 은행 isRenderableToeicTemplateBank, 틀 하나 isRenderableToeicTemplate).
 *
 * 셸은 토익 관용구(u-navbtn "← 아빠의 영어", EnglishNav 없음, 새 전역 CSS 없음 — 화면 CSS 모듈에 기존 변수만).
 */

import type { Metadata } from "next";
import Link from "next/link";
import ToeicGuideImportButton from "@/components/toeic-guide-import-button";
import s from "@/components/toeic-guide-folder-view.module.css";
import { getStore, type ToeicSetRecord } from "@/lib/store";
import { TOEIC_GUIDE_PARTS, TOEIC_GUIDE_PART_TO_MOCK_PART, TOEIC_TEMPLATE_BANK_ID, toeicGuideSetId, type ToeicGuidePart } from "@/lib/toeic-guide";
import { toeicDrillUnit } from "@/lib/toeic-drill";
import { summarizeToeicDrill, toeicDrillFolderCard } from "@/lib/toeic-drill-view";
import { countMastered, guideTemplatesForPart, templateSessionsForPart, templateSwapMasteredKeys } from "@/lib/toeic-guide-view";
import { kstTodayString } from "@/lib/kst";
import { summarizeTestStatus, toTestStatusBadge, type TestStatusBadge } from "@/lib/test-status";
import TestStatusChip from "@/components/test-status-chip";
import { toeicMockPartLabelKo } from "@/lib/toeic-mock-contract";
import { isRenderableToeicGuide, isRenderableToeicMock, isRenderableToeicSet, isRenderableToeicTemplateBank, isToeicGuidePartSet } from "@/lib/toeic-record";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "토익스피킹 유형별 공략 — 아빠의 영어",
  description: "질문 유형별 교재 공략을 읽고 듣고, 답변 틀을 따라 말하며 입에 붙여요.",
};

/** 폴더 아이콘 — 유형마다 하나(장식) */
const FOLDER_ICON: Record<ToeicGuidePart, string> = { q3_4: "📷", q5_7: "👂", q8_10: "📋", q11: "💬" };

interface FolderCard {
  part: ToeicGuidePart;
  labelKo: string;
  imported: { sections: number } | null;
  /** 공략 문서가 있는데 모양이 깨져 열 수 없다 */
  broken: boolean;
  templates: number;
  mastered: number;
  /** 한 문제 연습 수와 마지막 점수("5/6" — 없으면 null) */
  drills: { count: number; lastScoreKo: string | null };
  /** 시험 응시 배지(SPEC §15-4) — ② 틀 테스트·③ 틀 시험 중 이 유형 틀을 답한 마지막 판. 틀이 없는 폴더는 null(볼 시험이 없다) */
  test: TestStatusBadge | null;
}

/** 유형 공략 문서 → 폴더 카드 "가져옴" 표시(렌더 가능할 때만). 문서가 있는데 판정에서 떨어지면 broken. */
function importedOf(record: ToeicSetRecord | null): { imported: FolderCard["imported"]; broken: boolean } {
  if (record === null) return { imported: null, broken: false };
  if (!isToeicGuidePartSet(record) || !isRenderableToeicSet(record) || !isRenderableToeicGuide(record)) return { imported: null, broken: record.guide !== null };
  const g = record.guide as { sections: unknown[] };
  return { imported: { sections: g.sections.length }, broken: false };
}

export default async function ToeicGuidesPage() {
  const store = getStore();
  const [partDocs, bank, bankSessions, partDrills, attempts] = await Promise.all([
    Promise.all(TOEIC_GUIDE_PARTS.map((p) => store.getToeicSet(toeicGuideSetId(p)))),
    store.getToeicSet(TOEIC_TEMPLATE_BANK_ID),
    store.listToeicQuizzes(TOEIC_TEMPLATE_BANK_ID),
    Promise.all(TOEIC_GUIDE_PARTS.map((p) => store.listToeicDrills(toeicDrillUnit(p)!.mockPart))),
    store.listAllToeicAttempts(),
  ]);

  const bankOk = bank !== null && isRenderableToeicTemplateBank(bank);
  const bankItems: unknown[] = bankOk ? ((bank.guide as { items: unknown[] }).items ?? []) : [];
  const mastered = templateSwapMasteredKeys(bankSessions);
  const todayKst = kstTodayString();

  const cards: FolderCard[] = TOEIC_GUIDE_PARTS.map((part, i) => {
    const { imported, broken } = importedOf(partDocs[i]);
    const { templates } = guideTemplatesForPart(bankItems, part);
    const partKeys = new Set(templates.map((t) => t.key));
    const drills = partDrills[i].filter(isRenderableToeicMock);
    const ids = new Set(drills.map((d) => d.id));
    const mine = attempts.filter((a) => ids.has(a.mockId));
    return {
      part,
      labelKo: toeicMockPartLabelKo(TOEIC_GUIDE_PART_TO_MOCK_PART[part]),
      imported,
      broken,
      templates: templates.length,
      mastered: countMastered(templates, mastered),
      drills: toeicDrillFolderCard(drills.map((d) => summarizeToeicDrill(d, mine))),
      test: templates.length > 0 ? toTestStatusBadge(summarizeTestStatus(templateSessionsForPart(bankSessions, partKeys), todayKst), todayKst) : null,
    };
  });
  const nothingYet = cards.every((c) => c.imported === null && c.templates === 0);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/toeic" className="u-navbtn">
            ← 아빠의 영어
          </Link>
        </div>
        <h1 className="t-book-title mt-4">🧭 토익스피킹 유형별 공략</h1>
        <p className="t-lead mt-1">
          질문 유형마다 폴더가 하나예요. 자리마다 외울 틀 하나 — 공략 읽기에서 그 틀을 찾고, 따라 말하고, 틀 시험으로 확인하고, 한 문제 연습에서 그 틀로 답해요.
        </p>
      </header>

      {bank !== null && !bankOk && (
        <p role="status" className="u-box t-caption mb-4 border border-line-strong">
          ⚠️ 틀 모음 문서의 형식이 맞지 않아 열지 못했어요. 가져오기 파일을 다시 넣어 주세요.
        </p>
      )}

      <ul className={s.folders} aria-label="유형 폴더">
        {cards.map((c) => (
          <li key={c.part}>
            <Link href={`/toeic/guides/${c.part}`} className={s.folder} data-testid={`guide-folder-${c.part}`}>
              <span className={s.folderIcon} aria-hidden>
                {FOLDER_ICON[c.part]}
              </span>
              <span className={s.folderBody}>
                <span className={s.folderTitle}>{c.labelKo}</span>
                <span className={s.folderChips}>
                  {c.imported ? (
                    <span className="u-chip">공략 섹션 {c.imported.sections}</span>
                  ) : c.broken ? (
                    <span className="u-chip">⚠️ 공략을 열지 못했어요</span>
                  ) : (
                    <span className="u-chip">공략 아직 없음</span>
                  )}
                  {c.templates > 0 && (
                    <span className={`u-chip ${c.mastered > 0 ? "u-chip-accent" : ""}`}>
                      외울 틀 {c.templates} · 익힘 {c.mastered}
                    </span>
                  )}
                  {c.test && <TestStatusChip badge={c.test} />}
                  {c.drills.count > 0 && (
                    <span className="u-chip">
                      연습 {c.drills.count}
                      {c.drills.lastScoreKo ? ` · 마지막 ${c.drills.lastScoreKo}` : ""}
                    </span>
                  )}
                </span>
              </span>
              <span className={s.folderArrow} aria-hidden>
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <section aria-label="파일로 가져오기" className="mt-8">
        {nothingYet && (
          <p className="t-caption mb-3 rounded-[var(--radius-box)] border border-dashed border-line px-5 py-4">
            아직 공략 자료가 없어요. 공략 가져오기 파일(toeic-guides/v2)을 넣으면 네 폴더에 공략과 틀이 한 번에 들어가요.
          </p>
        )}
        <ToeicGuideImportButton />
        <p className="t-caption mt-2">
          같은 파일을 다시 넣으면 그대로, 고친 파일을 넣으면 그 자리에서 고쳐져요(시험·테스트 기록은 그대로 남아요).
        </p>
      </section>
    </main>
  );
}
