/**
 * /api/push/subscribe — 폰 알림 구독(가족 스트릭 강화 스펙 §6-1). PIN 게이트 안(proxy 자동).
 *
 * GET    → 200 `{ publicKey }` — VAPID 공개키(비밀 아님). 키가 없으면 null(화면이 "준비 중"·콕 버튼 숨김).
 * POST   `{ person, subscription: { endpoint, keys: { p256dh, auth } }, prefs }` → 200 `{ ok: true }` (같은 기기면 덮어쓴다 — 설정 변경도 이 경로)
 * DELETE `{ endpoint }` → 200 `{ ok: true }`
 * 키가 없으면 POST·DELETE 501(로컬 안전). 형식이 틀리면 400.
 */

import { NextResponse } from "next/server";
import { isPushPerson, parsePushPrefs } from "@/lib/push-contract";
import { pushConfigured } from "@/lib/push-send";
import { isProdGuardError } from "@/lib/prod-guard";
import { getStore, pushSubscriptionId } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY_MAX = 200;
const ENDPOINT_MAX = 2000;

function notConfigured() {
  return NextResponse.json({ ok: false, error: "not_configured", messageKo: "아직 알림 준비 중이에요." }, { status: 501 });
}
function bad(messageKo: string) {
  return NextResponse.json({ ok: false, error: "invalid_input", messageKo }, { status: 400 });
}
function isEndpoint(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("https://") && v.length <= ENDPOINT_MAX;
}
function isKey(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= KEY_MAX;
}

export async function GET() {
  const publicKey = pushConfigured() ? process.env.VAPID_PUBLIC_KEY!.trim() : null;
  return NextResponse.json({ publicKey }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  if (!pushConfigured()) return notConfigured();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return bad("요청 형식이 올바르지 않아요.");
  }
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const sub = (typeof o.subscription === "object" && o.subscription !== null ? o.subscription : {}) as Record<string, unknown>;
  const keys = (typeof sub.keys === "object" && sub.keys !== null ? sub.keys : {}) as Record<string, unknown>;
  if (!isPushPerson(o.person)) return bad("누구의 폰인지 골라 주세요.");
  if (!isEndpoint(sub.endpoint) || !isKey(keys.p256dh) || !isKey(keys.auth)) return bad("알림 구독 정보가 올바르지 않아요.");
  try {
    await getStore().upsertPushSubscription({
      id: pushSubscriptionId(sub.endpoint),
      person: o.person,
      endpoint: sub.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      prefs: parsePushPrefs(o.prefs, o.person),
    });
  } catch (err) {
    console.error("[/api/push/subscribe] 저장 실패:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ ok: false, error: "save_failed", messageKo: "저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  if (!pushConfigured()) return notConfigured();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return bad("요청 형식이 올바르지 않아요.");
  }
  const endpoint = (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).endpoint : undefined);
  if (!isEndpoint(endpoint)) return bad("알림 구독 정보가 올바르지 않아요.");
  try {
    await getStore().deletePushSubscription(pushSubscriptionId(endpoint));
  } catch (err) {
    if (isProdGuardError(err)) return NextResponse.json({ ok: false, error: "prod_guard", messageKo: "개발 환경에서는 실데이터를 지울 수 없어요." }, { status: 403 });
    console.error("[/api/push/subscribe] 삭제 실패:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ ok: false, error: "delete_failed", messageKo: "알림을 끄지 못했어요. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
