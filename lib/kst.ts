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

/** isZonedIsoTimestamp의 형식 — 날짜만, 또는 날짜T시각(시 00~23·분초 00~59·소수 1~3자리) + `Z`·`±HH:MM` 필수 */
const ZONED_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

/**
 * 시간대가 **명시된** ISO 시각 문자열인가 — "어느 런타임에서 `Date.parse`해도 같은 순간이 나오는 값"의 **단일 정의처**.
 * 표시(formatKstDate)와 운동 엔진(`lib/workout.ts`의 createdAt·endedAt 판정)이 같이 쓴다 — 예전엔 두 벌이라 경계가 갈렸다
 * (`…T15:00:00.123456Z`를 운동은 유효로, 표시는 폴백으로 봤다).
 *
 * 받는 것: 날짜만(`YYYY-MM-DD`, 명세상 UTC로 해석) 또는 `YYYY-MM-DDTHH:MM[:SS[.s{1,3}]]` + `Z`·`±HH:MM`,
 * 그리고 날짜가 달력에 실제로 있고(diffDateStrings가 같은 날끼리 0) `Date.parse`가 성공하는 값. 우리가 저장하는 값
 * (`new Date().toISOString()` — Z·소수 3자리, 날짜만)은 전부 통과한다.
 * 거절하는 것과 이유 — 전부 "엔진·실행 시간대마다 해석이 갈려 서버(Cloud Run UTC)와 폰(KST)이 다른 날을 낼 수 있는 값"이다:
 * - 시간대 없는 날짜·시각(`2026-09-25T10:00:00`): `Date.parse`가 **실행 환경의 로컬 시각**으로 읽는다.
 * - 소수 4자리 이상: ES 날짜 형식은 밀리초 3자리다. 그 밖은 엔진 재량(자르기·반올림)이라 자정 직전 값의 날짜가 갈릴 수 있다
 *   (1~2자리는 밀리초로 정확히 떨어져 갈리지 않는다).
 * - `24:00`: V8은 다음 날 0시로 굴린다 — 날짜부와 실제 순간의 날짜가 다른 값이다. 시 00~23·분초 00~59로 좁힌다.
 * - 달력에 없는 날(2월 30일): V8은 3월 2일로 굴리고 다른 엔진은 NaN을 낼 수 있다.
 * 문자열이 아닌 값(`String` 객체 포함)은 false다.
 */
export function isZonedIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ZONED_ISO_PATTERN.test(value)) return false;
  const datePart = value.slice(0, 10);
  return diffDateStrings(datePart, datePart) === 0 && !Number.isNaN(Date.parse(value));
}

/**
 * ISO(UTC) 시각 → **KST 날짜 표시** `YYYY.MM.DD`. 목록·상세 화면의 "만든 날짜"(`createdAt`) 표시의 단일 정의처.
 *
 * 왜: 화면마다 `iso.slice(0, 10)`으로 UTC 일자를 잘라 보여, **KST 00:00~08:59에 만든 기록이 전날로** 보였다.
 * 계산은 kstDateString(+9h → getUTC*)이라 서버(Cloud Run UTC)·SSR·클라이언트가 같은 값을 낸다 — hydration 안전.
 * isZonedIsoTimestamp가 아닌 값(시간대 없음·파싱 불가·비문자열)은 **예전 동작 그대로** 원문 앞 10자(`-`→`.`)를 보인다
 * (결정적이라 역시 hydration 안전). 비문자열은 `""`.
 *
 * ⚠️ 읽음 기록의 `readAt`(읽은 날)에는 쓰지 않는다 — 그건 기기 로컬 날짜 문자열이다(아래 deviceDateString).
 */
export function formatKstDate(iso: string): string {
  const raw = typeof iso === "string" ? iso : "";
  const datePart = raw.slice(0, 10); // 폴백 — 예전 동작(원문 앞 10자)
  return (isZonedIsoTimestamp(raw) ? kstDateString(raw) : datePart).replace(/-/g, ".");
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
