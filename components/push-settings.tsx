"use client";

/**
 * 🔔 알림 설정(가족 스트릭 강화 스펙 §6-1) — "나는 누구" + 이 기기 알림 켜기/끄기 + 시각·가족 알림.
 * - iPhone·iPad는 홈 화면에 추가한 앱(standalone)에서만 웹 푸시가 된다(iOS 16.4+) — 미설치면 설치 방법만 보이고 켜기 버튼을 숨긴다.
 * - 권한 요청은 반드시 버튼 탭 안에서(iOS는 사용자 동작 없이 부르면 거부한다).
 * - 서버에 VAPID 키가 없으면(공개키 null·501) "아직 알림 준비 중이에요" 한 줄.
 * - localStorage는 기기별 편의(사람·설정 기억)라 실패해도 화면은 돈다.
 */

import { useEffect, useState } from "react";
import { DEFAULT_PUSH_PREFS, PUSH_PEOPLE, PUSH_PERSON_KO, PUSH_PERSON_STORAGE_KEY, isPushPerson, parsePushPrefs, type PushPerson, type PushPrefs } from "@/lib/push-contract";

const PREFS_STORAGE_KEY = "push-prefs";

const TIMES: string[] = [];
for (let h = 8; h <= 22; h++) {
  TIMES.push(`${String(h).padStart(2, "0")}:00`);
  if (h < 22) TIMES.push(`${String(h).padStart(2, "0")}:30`);
}

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 기기 편의 — 조용히 */
  }
}

/** VAPID 공개키(base64url) → applicationServerKey */
function base64UrlToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = window.atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Env = { supported: boolean; installed: boolean; ios: boolean };

export default function PushSettings() {
  const [env, setEnv] = useState<Env | null>(null);
  const [publicKey, setPublicKey] = useState<string | null | undefined>(undefined);
  const [person, setPerson] = useState<PushPerson | null>(null);
  const [prefs, setPrefs] = useState<PushPrefs | null>(null);
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    setEnv({
      supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
      installed: window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true,
      ios: /iPhone|iPad/.test(navigator.userAgent),
    });
    const p = readLocal(PUSH_PERSON_STORAGE_KEY);
    if (isPushPerson(p)) {
      setPerson(p);
      let saved: unknown = null;
      try {
        saved = JSON.parse(readLocal(PREFS_STORAGE_KEY) ?? "null");
      } catch {
        saved = null;
      }
      setPrefs(parsePushPrefs(saved, p));
    }
    let alive = true;
    fetch("/api/push/subscribe", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { publicKey: null }))
      .then((j: { publicKey?: string | null }) => alive && setPublicKey(j.publicKey ?? null))
      .catch(() => alive && setPublicKey(null));
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistration("/sw.js")
        .then((reg) => reg?.pushManager.getSubscription())
        .then((s) => alive && setSub(s ?? null))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, []);

  const save = async (s: PushSubscription, who: PushPerson, pr: PushPrefs): Promise<boolean> => {
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ person: who, subscription: s.toJSON(), prefs: pr }),
    });
    if (res.status === 501) setPublicKey(null);
    return res.ok;
  };

  const choosePerson = (p: PushPerson) => {
    const pr = DEFAULT_PUSH_PREFS[p];
    setPerson(p);
    setPrefs(pr);
    writeLocal(PUSH_PERSON_STORAGE_KEY, p);
    writeLocal(PREFS_STORAGE_KEY, JSON.stringify(pr));
    if (sub) void save(sub, p, pr).then((ok) => setMsg(ok ? `이 폰은 이제 ${PUSH_PERSON_KO[p]} 알림을 받아요.` : "저장하지 못했어요."));
  };

  const changePrefs = (next: PushPrefs) => {
    setPrefs(next);
    writeLocal(PREFS_STORAGE_KEY, JSON.stringify(next));
    if (sub && person) void save(sub, person, next).then((ok) => setMsg(ok ? "저장했어요." : "저장하지 못했어요."));
  };

  const turnOn = async () => {
    if (!person || !prefs || !publicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setMsg("알림이 허용되지 않았어요. 설정에서 이 앱의 알림을 켜 주세요.");
        return;
      }
      await navigator.serviceWorker.ready;
      const s = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(publicKey) }));
      if (await save(s, person, prefs)) {
        setSub(s);
        setMsg("알림을 켰어요.");
      } else {
        setMsg("저장하지 못했어요. 잠시 후 다시 해 주세요.");
      }
    } catch {
      setMsg("알림을 켜지 못했어요. 잠시 후 다시 해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (!sub) return;
    setBusy(true);
    setMsg(null);
    try {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => false);
      await fetch("/api/push/subscribe", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint }) });
      setSub(null);
      setMsg("알림을 껐어요.");
    } catch {
      setMsg("알림을 끄지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  if (!env || publicKey === undefined) return <p className="t-body text-ink-3">불러오는 중…</p>;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="t-book-title">🔔 알림 설정</h1>
        <p className="t-body mt-1 text-ink-2">오늘 🔥를 아직 안 켰을 때 이 폰으로 알려 줘요.</p>
      </header>

      {publicKey === null ? (
        <p className="t-body">아직 알림 준비 중이에요.</p>
      ) : (
        <>
          <section aria-label="나는 누구">
            <h2 className="t-section-title mb-2">나는 누구</h2>
            <div className="flex gap-2" role="radiogroup">
              {PUSH_PEOPLE.map((p) => (
                <label key={p} className={`u-chip cursor-pointer ${person === p ? "u-chip-accent" : ""}`}>
                  <input type="radio" name="push-person" className="sr-only" checked={person === p} onChange={() => choosePerson(p)} />
                  {PUSH_PERSON_KO[p]}
                </label>
              ))}
            </div>
          </section>

          {env.ios && !env.installed ? (
            <section aria-label="홈 화면에 추가" className="u-box">
              <p className="t-body font-medium">iPhone은 홈 화면에 추가한 앱에서만 알림을 받을 수 있어요.</p>
              <ol className="t-body mt-2 list-decimal pl-5">
                <li>Safari 아래쪽 공유 버튼을 눌러요.</li>
                <li>“홈 화면에 추가”를 눌러요.</li>
                <li>홈 화면에 생긴 아이콘으로 열어서 여기로 다시 와요.</li>
              </ol>
            </section>
          ) : !env.supported ? (
            <p className="t-body">이 브라우저는 알림을 받을 수 없어요.</p>
          ) : person && prefs ? (
            <>
              <section aria-label="알림 시각" className="flex flex-col gap-3">
                <label className="t-body flex items-center gap-3">
                  오늘 아직 알림
                  <select className="u-input w-auto" value={prefs.remindAt} onChange={(e) => changePrefs({ ...prefs, remindAt: e.target.value })}>
                    {TIMES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                {person !== "eunwoo" && (
                  <label className="t-body flex items-center gap-2">
                    <input type="checkbox" checked={prefs.familyAlerts} onChange={(e) => changePrefs({ ...prefs, familyAlerts: e.target.checked })} />
                    은우가 21시까지 아직이면 알려 주기
                  </label>
                )}
              </section>
              <div>
                {sub ? (
                  <button type="button" className="u-btn u-btn-secondary" disabled={busy} onClick={() => void turnOff()}>
                    알림 끄기
                  </button>
                ) : (
                  <button type="button" className="u-btn u-btn-primary" disabled={busy} onClick={() => void turnOn()}>
                    알림 켜기
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="t-body text-ink-2">먼저 누구의 폰인지 골라 주세요.</p>
          )}
          {msg && (
            <p className="t-body" role="status">
              {msg}
            </p>
          )}
        </>
      )}
    </div>
  );
}
