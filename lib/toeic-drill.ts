/**
 * lib/toeic-drill.ts — 토익스피킹 **한 문제 연습** 단위표·레코드 파트 줄이기·제목·주제 풀 순수 함수 (docs/harness/toeic.md §12-7-1·§12-7-2)
 *
 * - 연습 단위표 `TOEIC_DRILL_UNITS`는 **여기 한 곳**이 단일 정의다(eval이 리터럴로 잠근다). 응시 범위(`questions`)는 서버가 이
 *   표에서 정한다 — 클라이언트가 문항 부분집합을 고를 길은 없다(§12-7-1).
 * - 호출 C 프롬프트는 바꾸지 않는다(§4-3 "정확히 2개"는 spec-sync 대상). C2가 낸 두 장면 중 **하나만** rng로 골라 저장한다.
 * - 활용할 표현 고르기(`pickExpressionsForDrill`)는 여기 두지 않는다 — 재사용할 pickExpressionsForMock이 zod를 끌어오는 서버 모듈
 *   (lib/ai/toeic/mock.ts)에 있어서다(번들 경계, §12-7-1).
 *
 * ⚠️ 클라이언트 번들 안전: 런타임 import는 lib/toeic-mock뿐, lib/ai·lib/toeic-guide는 `import type`만. 정규식 lookbehind 금지.
 */

import { TOEIC_MOCK_PART_NAME_KO, type ToeicMockPart } from "./toeic-mock";
import type { ToeicMockPartRecordMap, ToeicPicturePart } from "./ai/toeic/schemas";
import type { ToeicGuidePart } from "./toeic-guide";
import type { Rng } from "./vocab-quiz";

// ---------------------------------------------------------------------------
// 연습 단위표 (§12-7-1 — 단일 정의)
// ---------------------------------------------------------------------------

/** 연습이 쓰는 모의고사 파트(Q1–2는 연습 폴더가 없다) */
export type ToeicDrillMockPart = Exclude<ToeicMockPart, "read">;

export interface ToeicDrillUnit {
  /** 공략 유형(폴더) */
  part: ToeicGuidePart;
  /** 모의고사 파트(호출 C 생성기 — 연습 문서의 drillPart) */
  mockPart: ToeicDrillMockPart;
  /** 응시 문항(오름차순) — Q3–4는 사진 1장이라 Q3 하나 */
  questions: readonly number[];
}

/**
 * Q3–4 사진 1장(Q3) · Q5–7 세 문항 한 묶음 · Q8–10 표 + 세 문항 · Q11 한 문항. 앞 문항의 상황·표를 뒤 문항이 이어받는 유형은
 * 실전 묶음을 쪼개지 않는다(§12-7-1 근거).
 */
export const TOEIC_DRILL_UNITS: readonly ToeicDrillUnit[] = [
  { part: "q3_4", mockPart: "picture", questions: [3] },
  { part: "q5_7", mockPart: "respond", questions: [5, 6, 7] },
  { part: "q8_10", mockPart: "info", questions: [8, 9, 10] },
  { part: "q11", mockPart: "opinion", questions: [11] },
];

/** 공략 유형 → 연습 단위(없으면 null) */
export function toeicDrillUnit(part: ToeicGuidePart): ToeicDrillUnit | null {
  return TOEIC_DRILL_UNITS.find((u) => u.part === part) ?? null;
}

/** 모의고사 파트(연습 문서의 drillPart) → 연습 단위(없으면 null — read) */
export function toeicDrillUnitForMockPart(mockPart: ToeicMockPart): ToeicDrillUnit | null {
  return TOEIC_DRILL_UNITS.find((u) => u.mockPart === mockPart) ?? null;
}

// ---------------------------------------------------------------------------
// 레코드 파트 → 연습 파트 (§12-7-1)
// ---------------------------------------------------------------------------

/**
 * toMockRecordPart(서버, lib/ai/toeic/mock.ts)가 사진 칸을 pending으로 붙인 **레코드 파트**를 받아, 사진이면 두 장면 중 rng가 고른
 * **한 장면만** 남긴다(저장 문서에서는 그 장면이 items[0] = Q3 = slot 0, 사진은 pending). 다른 파트는 그대로 돌려준다.
 * 늘 첫 장면만 쓰면 C2의 버릇(장소 목록 앞쪽)이 연습마다 되풀이될 수 있어 무작위로 고른다(비용 0). rng 0 → 첫 장면, 0.99 → 둘째.
 * attachPendingImages를 다시 쓰지 않는다(zod 값 import를 피한다) — 사진 상태는 여기서 pending으로 다시 적는다.
 */
export function toDrillRecordPart<P extends ToeicDrillMockPart>(mockPart: P, recordPart: ToeicMockPartRecordMap[P], rng: Rng = Math.random): ToeicMockPartRecordMap[P] {
  if (mockPart !== "picture") return recordPart;
  const pic = recordPart as ToeicPicturePart;
  const items = Array.isArray(pic.items) ? pic.items : [];
  if (items.length === 0) return recordPart;
  const idx = Math.min(items.length - 1, Math.max(0, Math.floor(rng() * items.length)));
  const scene = items[idx];
  const out: ToeicPicturePart = { ...pic, items: [{ ...scene, image: { status: "pending", imageId: null } }] };
  return out as ToeicMockPartRecordMap[P];
}

// ---------------------------------------------------------------------------
// 제목 (§12-7-2) — "{유형 짧은 이름} 연습 {n}", 연습끼리·유형별로 센다
// ---------------------------------------------------------------------------

/** 연습 제목의 머리 — "사진 묘사 연습 " */
export function toeicDrillTitlePrefix(mockPart: ToeicMockPart): string {
  return `${TOEIC_MOCK_PART_NAME_KO[mockPart]} 연습 `;
}

/**
 * 새 연습 제목 — 지운 뒤 만들어도 겹치지 않게 **넘겨받은 제목 수와 기존 "{이름} 연습 N"의 최대 N 중 큰 값 + 1**
 * (nextToeicMockTitle과 같은 관용구). `existingTitles`는 같은 유형 연습들의 제목이다.
 */
export function nextToeicDrillTitle(mockPart: ToeicMockPart, existingTitles: readonly string[]): string {
  const prefix = toeicDrillTitlePrefix(mockPart);
  let max = existingTitles.length;
  for (const t of existingTitles) {
    if (!t.startsWith(prefix)) continue;
    const rest = t.slice(prefix.length);
    if (/^\d{1,6}$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${max + 1}`;
}

// ---------------------------------------------------------------------------
// 주제 풀 (§12-7-2) — 이 앱이 정한 일반 낱말(교재 글이 아니다). 호출 C의 기존 입력 "주제 힌트"로 넘긴다(프롬프트 변경 0)
// ---------------------------------------------------------------------------

/** 파트마다 8개 이상의 일상 주제(한국어 — 표현집 topicKo와 같은 모양) */
export const TOEIC_DRILL_TOPIC_POOL: Readonly<Record<ToeicDrillMockPart, readonly string[]>> = {
  picture: ["시장", "기차역", "공원", "카페", "사무실", "공항", "도서관", "식당 주방", "공사 현장", "캠핑장"],
  respond: ["주말 취미", "대중교통", "온라인 쇼핑", "운동 습관", "휴가 계획", "음악 감상", "외식", "스마트폰 사용", "동네 가게", "독서"],
  info: ["행사 일정", "출장 일정", "교육 프로그램", "회의 안내", "면접 일정", "강좌 시간표", "여행 일정", "워크숍", "박람회"],
  opinion: ["재택근무", "온라인 수업", "대중교통 요금", "직장 복장 규정", "팀 프로젝트", "환경 보호", "청소년 스마트폰 사용", "도시와 시골 생활", "리더의 자질"],
};

/** 최근 연습 몇 개의 주제를 빼는가(§12-7-2 "최근 연습 3개") */
export const TOEIC_DRILL_RECENT_TOPICS_EXCLUDE = 3;

/**
 * 주제 힌트 하나 — 그 유형 **최근 연습 3개**(`recentTopicHints` — 최신순, 연습마다 topicHints 배열)가 쓴 주제를 빼고 풀에서 무작위로.
 * 다 빠지면 풀 전체에서 고른다.
 */
export function pickDrillTopic(
  mockPart: ToeicDrillMockPart,
  recentTopicHints: readonly (readonly string[])[],
  rng: Rng = Math.random,
): string {
  const pool = TOEIC_DRILL_TOPIC_POOL[mockPart];
  const recent = new Set(recentTopicHints.slice(0, TOEIC_DRILL_RECENT_TOPICS_EXCLUDE).flat());
  const fresh = pool.filter((t) => !recent.has(t));
  const from = fresh.length > 0 ? fresh : pool;
  const idx = Math.min(from.length - 1, Math.max(0, Math.floor(rng() * from.length)));
  return from[idx];
}
