/** lib/push-contract.ts — 알림 구독·설정 계약(클라이언트·서버 공유, 순수) */

export const PUSH_PEOPLE = ["eunwoo", "appa", "mom"] as const;
export type PushPerson = (typeof PUSH_PEOPLE)[number];
export type PushKind = "today" | "last" | "repair" | "family" | "poke";
/** 이 기기의 "나는 누구" — localStorage 키(알림 설정·콕 찌르기 보낸 사람) */
export const PUSH_PERSON_STORAGE_KEY = "push-person";

export const PUSH_PERSON_KO: Record<PushPerson, string> = { eunwoo: "은우", appa: "아빠", mom: "엄마" };

export interface PushPrefs {
  /** 오늘 아직 알림 시각 "HH:MM"(30분 단위, 08:00~22:00) */
  remindAt: string;
  /** 은우가 아직일 때 21:00 가족 알림을 받을지 */
  familyAlerts: boolean;
}

export const DEFAULT_PUSH_PREFS: Record<PushPerson, PushPrefs> = {
  eunwoo: { remindAt: "18:00", familyAlerts: false },
  appa: { remindAt: "21:00", familyAlerts: false },
  mom: { remindAt: "20:00", familyAlerts: true },
};

export function isPushPerson(v: unknown): v is PushPerson {
  return typeof v === "string" && (PUSH_PEOPLE as readonly string[]).includes(v);
}

const HHMM = /^(0[89]|1\d|2[0-2]):(00|30)$/;

export function parsePushPrefs(v: unknown, person: PushPerson): PushPrefs {
  const d = DEFAULT_PUSH_PREFS[person];
  if (typeof v !== "object" || v === null) return d;
  const o = v as Record<string, unknown>;
  return {
    remindAt: typeof o.remindAt === "string" && HHMM.test(o.remindAt) ? o.remindAt : d.remindAt,
    familyAlerts: typeof o.familyAlerts === "boolean" ? o.familyAlerts : d.familyAlerts,
  };
}
