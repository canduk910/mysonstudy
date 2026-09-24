/**
 * lib/kst.ts — 한국 시간(KST) 날짜 유틸의 **단일 정의처** (SPEC §17-2).
 *
 * 왜 한 곳인가: 같은 로직이 세 곳에 복붙돼 있었다(card-view의 localDateString, 시험 기록 화면 둘의 formatKst).
 * 날짜 규칙이 갈리면 스트릭·기록이 조용히 틀어진다 — 그래서 여기 모은다.
 *
 * ⚠️ 계산은 **`+9시간 → getUTC*`** 방식만 쓴다. `toLocaleString`·`Intl`·시간대 DB를 쓰지 않는다 —
 * 그래야 **서버(Cloud Run UTC)·SSR·클라이언트가 항상 같은 값**을 낸다(hydration 안전). 런타임 의존성 없음.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** ISO(UTC) 시각 → **KST 일자** `YYYY-MM-DD`. 스트릭·기록의 "하루" 기준. 파싱 실패 시 원문 반환. */
export function kstDateString(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** ISO(UTC) 시각 → **KST 날짜·시각** `YYYY.MM.DD HH:MM`. 시험 기록 화면의 표시용. */
export function formatKst(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}.${pad2(d.getUTCMonth() + 1)}.${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 지금(기본 new Date())의 **KST 오늘 일자** `YYYY-MM-DD`. "오늘"이 필요한 순간에만 부른다(서버가 스트릭 계산 시). */
export function kstTodayString(now: Date = new Date()): string {
  return kstDateString(now.toISOString());
}

/**
 * `YYYY-MM-DD`에 일수를 더하거나 뺀다(달력 산술, 결정적). 스트릭의 "어제·연속" 판정에 쓴다.
 * UTC 자정을 기준으로 계산하므로 DST·시간대 영향이 없다.
 */
export function shiftDateString(date: string, deltaDays: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const base = Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  const shifted = new Date(base + deltaDays * 24 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/**
 * 두 `YYYY-MM-DD` 사이의 **일수 차**(`to − from`, 달력 산술, 결정적). 운동 상태 기계의 gap 판정에 쓴다(SPEC §19-2).
 * shiftDateString과 같은 방식(UTC 자정 기준)이라 월·연 경계·DST에 흔들리지 않는다.
 *
 * **형식이 틀리면 NaN** — 정확히 숫자 `YYYY-MM-DD`이고 달력에 실제로 있는 날(월 1~12, 그 달의 일수 안 — 평년 2월 29 ✗)이어야 한다.
 * 문자열이 아닌 값, `""`·`"2026-09"`·`"2026-13-01"`·`"2026-02-30"`·시각이 붙은 값은 전부 NaN이다
 * (예전엔 `""`를 1900-01-01로, 2월 30일을 3월 2일로 조용히 굴렸다). 그래서 `diffDateStrings(d, d) === 0`이 곧 "유효한 날짜" 검사다.
 * 연도 0000~0099는 Date.UTC가 1900년대로 해석하므로 왕복 검사에서 NaN이 된다(실사용 범위 밖).
 */
export function diffDateStrings(from: string, to: string): number {
  const utcMidnight = (date: unknown): number => {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN;
    const [y, m, d] = date.split("-").map(Number);
    const t = Date.UTC(y, m - 1, d);
    // 달력 왕복 — Date.UTC는 13월·2월 30일을 다음 달로 굴린다. 되돌린 연·월·일이 입력과 같아야 실제로 있는 날이다.
    const back = new Date(t);
    return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? t : Number.NaN;
  };
  return Math.round((utcMidnight(to) - utcMidnight(from)) / (24 * 60 * 60 * 1000));
}

/**
 * **기기 로컬** 날짜 `YYYY-MM-DD`. ⚠️ KST가 아니다 — 이건 **"오늘 읽었어요"(읽음 기록) 전용**이다.
 * 읽은 날의 기준은 사용자 쪽 달력이어야 자연스럽다는 규약(`app/api/readings/route.ts` 주석 참고).
 * 그래서 KST 함수와 **일부러 합치지 않는다** — 스트릭(KST)과 읽음(기기 로컬)은 다른 기준이다.
 */
export function deviceDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
