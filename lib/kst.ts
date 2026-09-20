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
 * **기기 로컬** 날짜 `YYYY-MM-DD`. ⚠️ KST가 아니다 — 이건 **"오늘 읽었어요"(읽음 기록) 전용**이다.
 * 읽은 날의 기준은 사용자 쪽 달력이어야 자연스럽다는 규약(`app/api/readings/route.ts` 주석 참고).
 * 그래서 KST 함수와 **일부러 합치지 않는다** — 스트릭(KST)과 읽음(기기 로컬)은 다른 기준이다.
 */
export function deviceDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
