/**
 * lib/push-send.ts — 웹 푸시 발송(가족 스트릭 강화 스펙 §6-1). 서버 전용 — VAPID 개인키를 쓴다.
 * 키가 없으면 pushConfigured()가 false이고 라우트가 501을 낸다(로컬 안전).
 */

import "server-only";
import webpush from "web-push";
import { DEFAULT_PUSH_PREFS, PUSH_PEOPLE, type PushPerson, type PushPrefs } from "./push-contract";
import type { PushSubscriptionRecord, StudyStore } from "./store";

export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim());
}

let ready = false;
function init() {
  if (ready) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:family@example.com", process.env.VAPID_PUBLIC_KEY!.trim(), process.env.VAPID_PRIVATE_KEY!.trim());
  ready = true;
}

/** 구독들에 보낸다. 410/404 = 사라진 기기(gone) — 호출측이 지운다. 그 밖 실패는 조용히 건너뛴다. */
export async function sendTo(subs: readonly PushSubscriptionRecord[], msg: { title: string; body: string; url: string }): Promise<{ ok: string[]; gone: string[] }> {
  init();
  const ok: string[] = [];
  const gone: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(msg), { TTL: 3600 });
        ok.push(s.id);
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.push(s.id);
        else console.error("[push] 발송 실패", code);
      }
    }),
  );
  return { ok, gone };
}

/**
 * 한 사람의 구독들에 보내고 뒷정리까지 — 사라진 기기(410/404)는 구독을 지우고, 성공한 기기는 lastOkAt을 적는다.
 * 뒷정리 실패(예: 개발 환경 Firestore의 prod-guard)는 발송 결과를 바꾸지 않는다. 돌려주는 값 = 성공한 기기 수.
 */
export async function deliver(store: StudyStore, subs: readonly PushSubscriptionRecord[], msg: { title: string; body: string; url: string }): Promise<number> {
  if (subs.length === 0) return 0;
  const { ok, gone } = await sendTo(subs, msg);
  const at = new Date().toISOString();
  await Promise.all([
    ...gone.map((id) => store.deletePushSubscription(id).catch((err: unknown) => console.error("[push] 사라진 구독 정리 실패", err instanceof Error ? err.name : "unknown"))),
    ...ok.map((id) => store.markPushOk(id, at).catch((err: unknown) => console.error("[push] lastOkAt 기록 실패", err instanceof Error ? err.name : "unknown"))),
  ]);
  return ok.length;
}

/**
 * 사람별 알림 설정 — 구독(기기)마다 prefs가 있으므로 사람 단위로 접는다: 시각은 가장 이른 것, 가족 알림은 하나라도 켰으면 켬.
 * (가족 알림을 실제로 보낼 때는 그 설정을 켠 기기에만 보낸다 — 틱 라우트.) 구독이 없는 사람은 기본값.
 */
export function prefsByPerson(subs: readonly PushSubscriptionRecord[]): Record<PushPerson, PushPrefs> {
  const out: Record<PushPerson, PushPrefs> = { ...DEFAULT_PUSH_PREFS };
  for (const p of PUSH_PEOPLE) {
    const mine = subs.filter((s) => s.person === p);
    if (mine.length === 0) continue;
    out[p] = {
      remindAt: mine.map((s) => s.prefs.remindAt).sort()[0],
      familyAlerts: mine.some((s) => s.prefs.familyAlerts),
    };
  }
  return out;
}
