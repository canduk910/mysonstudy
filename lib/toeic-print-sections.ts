/**
 * 결과(첨삭) 화면 인쇄 — 인쇄할 항목 고르기(docs/harness/toeic.md §16-10, SPEC §20-14). 순수 모듈(DOM·React 없음).
 *
 * 화면 표시는 바꾸지 않는다 — 끈 항목은 **인쇄에서만** 빠진다. 결과 화면 루트에 `data-print-omit-{key}`를 달고, 그 항목 묶음에는
 * `data-print-sec="{key}"`를 단다. 모듈 CSS의 `@media print`가 `.wrap[data-print-omit-k] [data-print-sec="k"]`를 숨긴다.
 * 문제(사진·지문·표·질문)·머리·점수 칩은 항목이 아니다(언제나 인쇄).
 *
 * 묶음(어느 항목에 딸려 빠지는가):
 * - 전사(transcript): 내가 말한 것(전사)·무응답 문구, Q1–2 지문 대조(정확도·표시한 지문·범례·안내 — 끄면 지문만 남는다)
 * - 잘한 점(strengths): 피드백 총평 한 줄 + 👍 잘한 점
 * - 고칠 문장(fixes) · 빠진 내용(missing)
 * - 개선 답변(improved): 🌱 개선 답변 + 📒 넣었으면 좋았을 표현
 * - 모범답변(model): 모범답변 접기 통째(점검 줄·미달 경고·💡 팁·📌 묘사 포인트·🗂 답변 뼈대) — 끄면 인쇄 때 접기도 펼치지 않는다
 *
 * 기기에 기억하는 것은 **끈 항목** 목록이다(나중에 항목이 늘어도 새 항목은 켜진 채로 시작한다).
 */

export const TOEIC_PRINT_SECTIONS = ["transcript", "strengths", "fixes", "missing", "improved", "model"] as const;
export type ToeicPrintSection = (typeof TOEIC_PRINT_SECTIONS)[number];

export const TOEIC_PRINT_SECTION_KO: Record<ToeicPrintSection, string> = {
  transcript: "전사",
  strengths: "잘한 점",
  fixes: "고칠 문장",
  missing: "빠진 내용",
  improved: "개선 답변",
  model: "모범답변",
};

/** localStorage 키 — 값은 끈 항목 JSON 배열(예: `["fixes","model"]`) */
export const TOEIC_PRINT_SECTIONS_STORAGE_KEY = "toeic-print-omit";

const KNOWN: ReadonlySet<string> = new Set(TOEIC_PRINT_SECTIONS);

export function isToeicPrintSection(v: unknown): v is ToeicPrintSection {
  return typeof v === "string" && KNOWN.has(v);
}

/** 기억한 값 → 끈 항목(정의 순서, 중복·모르는 키 버림). 없거나 깨졌으면 빈 목록(= 전부 켬) */
export function parseToeicPrintOmit(raw: string | null | undefined): ToeicPrintSection[] {
  if (typeof raw !== "string" || raw === "") return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const set = new Set(v.filter(isToeicPrintSection));
  return TOEIC_PRINT_SECTIONS.filter((k) => set.has(k));
}

/** 끈 항목 → 기억할 값(정의 순서) */
export function serializeToeicPrintOmit(omit: readonly ToeicPrintSection[]): string {
  const set = new Set(omit);
  return JSON.stringify(TOEIC_PRINT_SECTIONS.filter((k) => set.has(k)));
}

/** 한 항목 켜기·끄기 — 새 목록(정의 순서) */
export function toggleToeicPrintOmit(omit: readonly ToeicPrintSection[], key: ToeicPrintSection, on: boolean): ToeicPrintSection[] {
  const set = new Set(omit);
  if (on) set.delete(key);
  else set.add(key);
  return TOEIC_PRINT_SECTIONS.filter((k) => set.has(k));
}

/** 결과 화면 루트에 다는 속성 — `{ "data-print-omit-fixes": "" , … }` */
export function toeicPrintOmitAttrs(omit: readonly ToeicPrintSection[]): Record<string, string> {
  return Object.fromEntries(omit.map((k) => [`data-print-omit-${k}`, ""]));
}

/** 버튼 옆 안내 — 몇 개를 인쇄하는가 */
export function toeicPrintPickSummaryKo(omit: readonly ToeicPrintSection[]): string {
  const n = TOEIC_PRINT_SECTIONS.length - new Set(omit).size;
  if (n === TOEIC_PRINT_SECTIONS.length) return "모든 항목을 인쇄해요.";
  if (n === 0) return "고른 항목이 없어 문제·점수만 인쇄해요.";
  return `${n}개 항목만 인쇄해요(문제·점수는 언제나).`;
}
