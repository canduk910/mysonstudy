/**
 * lib/person-area.ts — 지금 화면이 **누구의 습관**인지(은우·엄마·아빠)를 경로만으로 가르는 단일 정의처.
 *
 * 홈(`/`)은 사람 고르기(은우 → `/eunwoo`, 엄마 → `/mama`, 아빠 → `/appa`)이고, 각 사람 허브가 그 사람의 과목을 나열한다.
 * 상단 "누구 습관" 표시줄(components/person-bar.tsx)과 과목 화면의 "← 과목 선택" 링크가 이 표를 같이 본다.
 *
 * - 은우: `/eunwoo`·`/english`·`/math`·`/card`·`/library`(북카드 한 장과 서재는 은우 영어 북카드)
 * - 엄마: `/mama`·`/mom`
 * - 아빠: `/appa`·`/japanese`·`/toeic`·`/workout`
 * - 그 밖(`/`·`/family`·`/unlock`·`/api` 등) → null(표시줄을 숨긴다)
 *
 * 첫 경로 조각이 **정확히** 같아야 한다 — `/mother`·`/english2`처럼 앞 글자만 같은 경로는 null.
 * ⚠️ 런타임 import 0·`window` 미사용 — 화면이 값으로 import하고 eval이 그대로 부른다.
 */

export type Person = "eunwoo" | "mama" | "appa";

export const PERSON_HUB_HREF: Readonly<Record<Person, string>> = {
  eunwoo: "/eunwoo",
  mama: "/mama",
  appa: "/appa",
};

export const PERSON_LABEL_KO: Readonly<Record<Person, { emoji: string; name: string }>> = {
  eunwoo: { emoji: "🧒", name: "은우" },
  mama: { emoji: "👩", name: "엄마" },
  appa: { emoji: "🧑", name: "아빠" },
};

const FIRST_SEGMENT_PERSON: Readonly<Record<string, Person>> = {
  eunwoo: "eunwoo",
  english: "eunwoo",
  math: "eunwoo",
  card: "eunwoo",
  library: "eunwoo",
  mama: "mama",
  mom: "mama",
  appa: "appa",
  japanese: "appa",
  toeic: "appa",
  workout: "appa",
};

/** 경로 → 사람(null = 사람 영역 밖 — 홈·가족 보드·잠금 화면 등) */
export function personOfPath(pathname: string | null | undefined): Person | null {
  const raw = typeof pathname === "string" ? pathname : "";
  const path = raw.split(/[?#]/)[0] ?? "";
  const first = path.split("/").filter((s) => s !== "")[0] ?? "";
  return Object.prototype.hasOwnProperty.call(FIRST_SEGMENT_PERSON, first) ? FIRST_SEGMENT_PERSON[first] : null;
}
