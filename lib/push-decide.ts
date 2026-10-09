/**
 * lib/push-decide.ts — 알림 결정(가족 스트릭 강화 스펙 §6-2). 순수 — 시각("HH:MM", KST)·상태·설정·오늘 보낸 것 → 보낼 것.
 * 틱이 30분마다 부르므로 "그 시각 이후 아직 안 보낸 것"을 보낸다(틱이 늦어도 놓치지 않게).
 */

import { PUSH_PERSON_KO, type PushKind, type PushPerson, type PushPrefs } from "./push-contract";

export const PUSH_DAILY_MAX = 3;
export const POKE_DAILY_MAX = 2;
export const QUIET_FROM = "22:30"; // 이 시각 초과부터 조용
export const QUIET_UNTIL = "08:00";
export const LAST_AT = "22:30";
export const REPAIR_AT = "08:30";
export const FAMILY_AT = "21:00";

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

const URL_OF: Record<PushPerson, string> = { eunwoo: "/english", appa: "/", mom: "/" };

export function pushText(person: PushPerson, kind: PushKind, s: PersonState, extra: { from?: PushPerson; about?: PushPerson } = {}): { title: string; body: string; url: string } {
  const kid = person === "eunwoo";
  switch (kind) {
    case "today":
      return {
        title: kid ? "은우야, 오늘 공부할 시간!" : "오늘 🔥 아직이에요",
        body: kid ? `🔥 ${s.current}일째야. 한 판만 하자!` : `🔥 ${s.current}일이 걸려 있어요. 한 판만 하면 돼요!${s.missingTracks.length ? ` (${s.missingTracks.join("·")})` : ""}`,
        url: URL_OF[person],
      };
    case "last":
      return {
        title: kid ? "오늘이 곧 끝나요!" : "1시간 반 남았어요",
        body: s.freezeLeft > 0 ? "오늘 못 하면 🧊 쉬는 날 카드가 쓰여요." : "오늘 못 하면 🔥가 내일 두 판으로만 살아나요.",
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
  if (now > QUIET_FROM || now < QUIET_UNTIL) return [];
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
  const kid = input.states.find((s) => s.person === "eunwoo");
  if (kid && !kid.doneToday && now >= FAMILY_AT) {
    for (const s of input.states) {
      if (s.person !== "eunwoo" && input.prefs[s.person].familyAlerts) push(s, "family", { about: "eunwoo" });
    }
  }
  return out;
}
