"use client";

/**
 * 가족 보드(가족 스트릭 강화) — `/api/streak`를 헤드라인과 같은 방식(seq 가드·STREAK_REFRESH_EVENT)으로 읽어
 * 오늘 · 이번 주 · 기록 세 블록을 그린다. 보조 화면이라 실패는 조용히.
 * - 아빠 오늘 줄: 어학·운동 중 하나라도 했으면 ✓(둘 다면 어학 라벨).
 * - 아빠 운동 배지 줄: 운동 기록이 없으면(중립값) 숨긴다.
 * - 🔔 알림 설정 링크(머리)·👉 콕(오늘 아직인 사람 옆, 서버에 알림 키가 있을 때만 — 스펙 §6-2). 보낸 사람 = 이 기기의 "나는 누구".
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { PUSH_PERSON_STORAGE_KEY, isPushPerson, type PushPerson } from "@/lib/push-contract";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import type { StreakResponse, PersonStreak } from "@/lib/streak-contract";
import { repairHintText, type WeekCell } from "@/lib/streak-v2";

const CELL: Record<WeekCell, { icon: string; label: string }> = {
  lit: { icon: "🔥", label: "했음" },
  freeze: { icon: "🧊", label: "쉬는 날 카드" },
  repaired: { icon: "🔁", label: "만회" },
  pending: { icon: "⏳", label: "만회 대기" },
  missed: { icon: "✗", label: "놓침" },
  future: { icon: "·", label: "아직" },
  none: { icon: "", label: "기록 전" },
};
const DOW = ["월", "화", "수", "목", "금", "토", "일"];
const BADGE_NAME = { eunwoo: "은우", appaLanguage: "아빠 어학", appaWorkout: "아빠 운동", mom: "엄마", family: "가족" } as const;

const POKE_FAIL: Record<number, string> = {
  404: "그 폰은 알림이 꺼져 있어요",
  409: "벌써 했어요!",
  429: "오늘은 더 못 찔러요",
  501: "아직 알림 준비 중이에요",
};

/** 409 reason "quiet" — 조용한 시간(스펙 §6-2) */
const POKE_QUIET = "지금은 조용한 시간이에요 (밤 10시 반~아침 8시)";

/**
 * 오늘 줄 하나. `person` = 사람 단위 info(아빠 = 어학 ∪ 운동 — 만회 대기·판 수·연속은 이 값). 없으면 p.info.
 * 만회 대기에 판이 모자라면(한 판 했어도) ✓로 보이지 않는다 — 자정에 어제가 끊기니까(needsMoreToday).
 */
function Today({ name, emoji, p, person, onPoke }: { name: string; emoji: string; p: PersonStreak | null | undefined; person?: PersonStreak["info"]; onPoke?: () => Promise<string> }) {
  const [pokeMsg, setPokeMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!p) return null;
  const who = person ?? p.info;
  const hint = repairHintText(who);
  const done = p.info.doneToday && hint === null;
  // 연속 숫자 — 오늘 한 트랙이면 그 트랙, 아무 트랙도 안 했으면 사람 단위(아빠가 운동만 이어 온 날 📚 0일로 보이지 않게)
  const current = p.info.doneToday ? p.info.current : who.current;
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-3">
      <span className="t-body shrink-0 font-medium">
        {emoji} {name}
      </span>
      <span className="t-caption flex min-w-0 items-center justify-end gap-2 text-right text-ink-2">
        <span>
          {hint ?? (done ? `✓ ${p.todayLabel ?? "오늘 완료"}` : "아직")}
          {" · "}🔥{current}일
          {pokeMsg && <span role="status"> · {pokeMsg}</span>}
        </span>
        {!done && onPoke && (
          <button
            type="button"
            className="u-chip shrink-0"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setPokeMsg(await onPoke());
              setBusy(false);
            }}
          >
            👉 콕
          </button>
        )}
      </span>
    </li>
  );
}

export default function FamilyBoard() {
  const [data, setData] = useState<StreakResponse | null>(null);
  /** 서버에 알림 키가 있을 때만 콕 버튼 */
  const [pushReady, setPushReady] = useState(false);
  const [me, setMe] = useState<PushPerson | null>(null);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(PUSH_PERSON_STORAGE_KEY);
      if (isPushPerson(v)) setMe(v);
    } catch {
      /* 기기 편의 — 조용히 */
    }
    let alive = true;
    fetch("/api/push/subscribe", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { publicKey?: string | null } | null) => alive && setPushReady(!!j?.publicKey))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      try {
        const res = await fetch("/api/streak", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as StreakResponse;
        if (alive && mine === seq) setData(json);
      } catch {
        /* 보조 화면 — 조용히 */
      }
    };
    void load();
    const on = () => void load();
    window.addEventListener(STREAK_REFRESH_EVENT, on);
    return () => {
      alive = false;
      window.removeEventListener(STREAK_REFRESH_EVENT, on);
    };
  }, []);
  if (!data) return <p className="t-body text-ink-3">불러오는 중…</p>;

  /** 콕 찌르기 — 결과 문구를 돌려준다(그 줄에 짧게 보인다). 자기 자신 줄에는 버튼이 없다 */
  const pokeFor = (to: PushPerson): (() => Promise<string>) | undefined => {
    if (!pushReady || me === to) return undefined;
    return async () => {
      if (!me) return "🔔 알림 설정에서 '나는 누구'를 먼저 골라요";
      try {
        const res = await fetch("/api/push/poke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: me, to }) });
        if (res.ok) return "콕 찔렀어요!";
        const j = (await res.json().catch(() => null)) as { reason?: string } | null;
        if (res.status === 409 && j?.reason === "quiet") return POKE_QUIET;
        return POKE_FAIL[res.status] ?? "보내지 못했어요";
      } catch {
        return "보내지 못했어요";
      }
    };
  };

  // 아빠 오늘 — 어학·운동 중 하나라도 했으면 ✓(둘 다면 어학 라벨). 만회 안내·판 수·(둘 다 아직일 때) 숫자는 사람 단위(appaPerson).
  const appa: PersonStreak = data.appaLanguage.info.doneToday || !data.appaWorkout.info.doneToday ? data.appaLanguage : data.appaWorkout;
  const workoutNeutral = data.appaWorkout.info.current === 0 && data.appaWorkout.info.best === 0 && data.appaWorkout.todayLabel === null;
  const badges = data.badges.filter((b) => !(b.key === "appaWorkout" && workoutNeutral));
  const rows: { key: "eunwoo" | "appa" | "mom"; name: string }[] = [
    { key: "eunwoo", name: "은우" },
    { key: "appa", name: "아빠" },
    ...(data.week.rows.mom ? [{ key: "mom" as const, name: "엄마" }] : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="flex items-center justify-between gap-3">
          <h1 className="t-book-title">👪 가족 보드</h1>
          <Link href="/family/settings" className="u-navbtn shrink-0">
            🔔 알림 설정
          </Link>
        </div>
        <p className="t-body mt-1 text-ink-2">
          가족 🔥 {data.family.info.current}일 · 최고 {data.family.info.best}일
        </p>
      </header>
      <section aria-label="오늘">
        <h2 className="t-section-title mb-2">오늘</h2>
        <ul className="flex flex-col gap-2">
          <Today name="은우" emoji="🧒" p={data.eunwoo} onPoke={pokeFor("eunwoo")} />
          <Today name="아빠" emoji="🧑" p={appa} person={data.appaPerson?.info} onPoke={pokeFor("appa")} />
          <Today name="엄마" emoji="👩" p={data.mom} onPoke={pokeFor("mom")} />
        </ul>
      </section>
      <section aria-label="이번 주">
        <h2 className="t-section-title mb-2">이번 주</h2>
        <table className="w-full table-fixed text-center">
          <thead>
            <tr>
              <th className="w-12" />
              {DOW.map((d, i) => (
                <th key={d} className={`t-caption ${data.week.days[i] === data.today ? "font-bold text-ink" : "text-ink-3"}`}>
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th className="t-caption text-left font-medium text-ink">{r.name}</th>
                {(data.week.rows[r.key] ?? []).map((c, i) => (
                  <td key={i} className="py-1" title={CELL[c].label} aria-label={`${DOW[i]} ${CELL[c].label}`}>
                    {CELL[c].icon}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="t-caption mt-2">🔥 했음 · 🧊 쉬는 날 카드 · 🔁 만회 · ⏳ 만회 대기 · ✗ 놓침</p>
      </section>
      <section aria-label="기록">
        <h2 className="t-section-title mb-2">기록</h2>
        <ul className="t-body flex flex-col gap-1">
          <li>
            🧊 이번 달 남은 쉬는 날 카드 — 은우 {data.eunwoo.info.freezeLeftThisMonth ?? 0}장 · 아빠 {data.appaLanguage.info.freezeLeftThisMonth ?? 0}장
            {data.mom ? ` · 엄마 ${data.mom.info.freezeLeftThisMonth ?? 0}장` : ""}
          </li>
          {badges.map((b) => (
            <li key={b.key}>
              🏅 {BADGE_NAME[b.key]} — {b.earned.length > 0 ? b.earned.map((n) => `${n}일`).join(" · ") : "아직 없음"}
            </li>
          ))}
        </ul>
        <p className="t-caption mt-2">
          {data.v2From}부터 한 판을 끝까지 해야 🔥가 켜져요. 하루를 놓치면 쉬는 날 카드(한 달 2장)가 자동으로 쓰이고, 카드가 없으면 다음 날 두 판으로 메울 수 있어요.
        </p>
      </section>
    </div>
  );
}
