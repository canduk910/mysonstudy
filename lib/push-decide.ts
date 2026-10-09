/**
 * lib/push-decide.ts — 알림 결정(가족 스트릭 강화 스펙 §6-2). 순수 — 시각("HH:MM", KST)·상태·설정·오늘 보낸 것 → 보낼 것.
 * 틱이 30분마다 부르므로 "그 시각 이후 아직 안 보낸 것"을 보낸다(틱이 늦어도 놓치지 않게).
 */

import { shiftDateString } from "./kst";
import { PUSH_PEOPLE, PUSH_PERSON_KO, type PushKind, type PushPerson, type PushPrefs } from "./push-contract";
import type { PersonStreak, StreakResponse } from "./streak-contract";
import { doneForPush } from "./streak-v2";

export const PUSH_DAILY_MAX = 3;
export const POKE_DAILY_MAX = 2;
export const QUIET_FROM = "22:30"; // 이 시각 초과부터 조용
export const QUIET_UNTIL = "08:00";
export const LAST_AT = "22:30";
export const REPAIR_AT = "08:30";
export const FAMILY_AT = "21:00";

/** 조용한 시간 — 22:30 초과부터 08:00 전까지(0 채움 "HH:MM" 사전순 비교). 틱·콕 찌르기 공용 단일 정의처 */
export function isQuietHHMM(hhmm: string): boolean {
  return hhmm > QUIET_FROM || hhmm < QUIET_UNTIL;
}

/** 지금 KST "HH:MM"(분 그대로, 0 채움) — 콕 찌르기의 조용한 시간 판정용 */
export function kstHHMM(now: Date): string {
  const k = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${String(k.getUTCHours()).padStart(2, "0")}:${String(k.getUTCMinutes()).padStart(2, "0")}`;
}

export interface PersonState {
  person: PushPerson;
  doneToday: boolean;
  current: number;
  freezeLeft: number;
  pendingRepairYesterday: boolean;
  /** 아빠 — 아직인 트랙 이름("어학"·"운동") */
  missingTracks: string[];
}

export interface PushToSend {
  person: PushPerson;
  kind: PushKind;
  title: string;
  body: string;
  url: string;
}

const URL_OF: Record<PushPerson, string> = { eunwoo: "/english", appa: "/appa", mom: "/mom" };

export function pushText(person: PushPerson, kind: PushKind, s: PersonState, extra: { from?: PushPerson; about?: PushPerson } = {}): { title: string; body: string; url: string } {
  const kid = person === "eunwoo";
  switch (kind) {
    case "today":
      return {
        title: kid ? "은우야, 오늘 공부할 시간!" : "오늘 🔥 아직이에요",
        // 0일(아직 켠 적 없음·끊김)엔 "🔥 0일이 걸려 있어요"가 어색하다 — 켜 보자는 문구로
        body:
          s.current === 0
            ? kid
              ? "오늘 한 판 하자! 🔥를 켜 보자"
              : `오늘 한 판 해 볼까요? 🔥를 켜 봐요${s.missingTracks.length ? ` (${s.missingTracks.join("·")})` : ""}`
            : kid
              ? `🔥 ${s.current}일째야. 한 판만 하자!`
              : `🔥 ${s.current}일이 걸려 있어요. 한 판만 하면 돼요!${s.missingTracks.length ? ` (${s.missingTracks.join("·")})` : ""}`,
        url: URL_OF[person],
      };
    case "last":
      return {
        title: kid ? "오늘이 곧 끝나요!" : "1시간 반 남았어요",
        // 0일이면 지킬 🔥가 없다 — 카드·만회 대신 켜는 안내
        body: s.current === 0 ? "오늘 한 판이면 🔥가 켜져요." : s.freezeLeft > 0 ? "오늘 못 하면 🧊 쉬는 날 카드가 쓰여요." : "오늘 못 하면 🔥가 내일 두 판으로만 살아나요.",
        url: URL_OF[person],
      };
    case "repair":
      return { title: "🔁 어제를 되살릴 수 있어요", body: "오늘 두 판 하면 어제 🔥가 돌아와요.", url: URL_OF[person] };
    case "family":
      return { title: "👪 가족 알림", body: `${PUSH_PERSON_KO[extra.about ?? "eunwoo"]}가 오늘 아직이에요.`, url: "/family" };
    case "poke":
      return { title: `👉 ${PUSH_PERSON_KO[extra.from ?? "mom"]}가 콕 찔렀어요`, body: kid ? "오늘 한 판 하자!" : "오늘 한 판 해요!", url: URL_OF[person] };
  }
}

export function decidePushes(input: {
  nowHHMM: string;
  states: readonly PersonState[];
  prefs: Readonly<Record<PushPerson, PushPrefs>>;
  sentToday: readonly { person: PushPerson; kind: PushKind }[];
}): PushToSend[] {
  const now = input.nowHHMM;
  if (isQuietHHMM(now)) return [];
  const sentCount = (p: PushPerson) => input.sentToday.filter((s) => s.person === p).length;
  const was = (p: PushPerson, k: PushKind) => input.sentToday.some((s) => s.person === p && s.kind === k);
  const out: PushToSend[] = [];
  const push = (s: PersonState, kind: PushKind, extra?: { about?: PushPerson }) => {
    if (was(s.person, kind) || sentCount(s.person) + out.filter((o) => o.person === s.person).length >= PUSH_DAILY_MAX) return;
    out.push({ person: s.person, kind, ...pushText(s.person, kind, s, extra) });
  };
  for (const s of input.states) {
    if (s.pendingRepairYesterday && !s.doneToday && now >= REPAIR_AT) push(s, "repair");
    if (s.doneToday) continue;
    if (now >= LAST_AT) push(s, "last");
    else if (now >= input.prefs[s.person].remindAt) push(s, "today");
  }
  // 👪 가족 알림 — 받는 사람은 states가 아니라 설정(familyAlerts)으로 고른다. 자기 상태가 없는 사람(엄마 영역 데이터가 아직 없음)도
  // 21:00 "은우가 아직이에요"는 받는다 — 그때 하루 상한은 이미 보낸 수(sentCount)로만 센다(push가 같은 계산을 한다).
  const kid = input.states.find((s) => s.person === "eunwoo");
  if (kid && !kid.doneToday && now >= FAMILY_AT) {
    for (const p of PUSH_PEOPLE) {
      if (p === "eunwoo" || !input.prefs[p].familyAlerts) continue;
      const s = input.states.find((x) => x.person === p) ?? { person: p, doneToday: true, current: 0, freezeLeft: 0, pendingRepairYesterday: false, missingTracks: [] };
      push(s, "family", { about: "eunwoo" });
    }
  }
  return out;
}

/**
 * 틱의 "지금" — KST 시:분을 **30분 내림**한 0 채움 "HH:MM"(08:44 → "08:30"). decidePushes는 문자열 사전순으로 비교하므로
 * 반드시 두 자리 0 채움이어야 한다. Cloud Run(UTC)·로컬 어디서든 같은 값(+9h → getUTC*).
 * `skewMs` — 내리기 전에 더할 여유. 스케줄러가 22:29:59에 불러도 "22:30" 칸으로 잡히게 틱은 TICK_SKEW_MS를 넘긴다.
 */
export function kstHalfHourHHMM(now: Date, skewMs = 0): string {
  const k = new Date(now.getTime() + skewMs + 9 * 60 * 60 * 1000);
  const h = k.getUTCHours();
  const m = k.getUTCMinutes() < 30 ? 0 : 30;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 틱 시각 여유(2분) — Cloud Scheduler가 정각 몇 초 전에 불러도 그 30분 칸으로(22:29:59 → "22:30", 08:01 → "08:00") */
export const TICK_SKEW_MS = 2 * 60 * 1000;

/**
 * 알림 결정용 사람 상태(가족 스트릭 강화 스펙 §6-2) — 스트릭 응답을 decidePushes 입력으로 접는다. 순수(틱·콕 찌르기 공용).
 * "오늘 다 했다" = 켜졌고 **만회 판이 모자라지 않음**(doneForPush) — 만회 대기에 한 판만 했으면 만회·오늘·마지막 알림이 그대로 나간다.
 * 아빠 = 사람 하나(`appaPerson` — appaPersonV2): 켜짐·만회 대기·판 수·연속 숫자·카드 모두 사람 값. APPA_BOTH_FROM(2026-10-10)부터
 * 켜짐은 📚·💪 **둘 다**(그 전 날짜는 둘 중 하나 — 서버가 이미 판정해 doneToday에 담는다). 아직인 트랙 이름을 문구에 싣는다.
 */
export function pushStates(r: StreakResponse): PersonState[] {
  const yesterday = shiftDateString(r.today, -1);
  const s = (person: PushPerson, info: PersonStreak["info"], missing: string[] = [], lit: boolean = info.doneToday): PersonState => ({
    person,
    doneToday: doneForPush({ ...info, doneToday: lit }),
    current: info.current,
    freezeLeft: info.freezeLeftThisMonth ?? 0,
    pendingRepairYesterday: info.pendingRepairDay === yesterday,
    missingTracks: missing,
  });
  // appaPerson이 없는 응답(옛 서버·폴백마저 실패)은 옛 규칙(만회 없음·둘 중 하나)으로 — 어학 info + 어학 ∨ 운동
  const appaInfo = r.appaPerson?.info ?? r.appaLanguage.info;
  const appaLit = r.appaPerson ? r.appaPerson.info.doneToday : r.appaLanguage.info.doneToday || r.appaWorkout.info.doneToday;
  const appaMissing = [!r.appaLanguage.info.doneToday ? "어학" : null, !r.appaWorkout.info.doneToday ? "운동" : null].filter((x): x is string => x !== null);
  const out: PersonState[] = [s("eunwoo", r.eunwoo.info), s("appa", appaInfo, appaMissing, appaLit)];
  // 엄마 영역 데이터가 없으면(mom: null) 엄마 상태는 없다 — 엄마 자신의 알림(오늘 아직·마지막·만회)은 나가지 않는다.
  // 👪 가족 알림(은우 아직 → 엄마 폰)은 decidePushes가 설정(familyAlerts)으로 따로 고르므로 자리표시가 필요 없다(엄마 설계 §7).
  if (r.mom) out.push(s("mom", r.mom.info));
  return out;
}
