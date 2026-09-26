/**
 * 아빠의 운동 `/workout` — 서버 컴포넌트 (SPEC §19-5·§19-6).
 *
 * 파벨 차졸린의 러시안 파이터 루틴(풀업·푸시업 사다리)을 매일 따라가게 한다. **AI 호출이 없다** — Day 계산·실패 롤백·
 * 브리핑은 전부 순수 엔진 lib/workout.ts가 한다(§19-0).
 *
 * 화면 데이터는 여기서 직접 읽는다: KST 오늘 → 전체 사이클 → 활성 하나(pickActiveWorkoutCycle — 페이지·스토어가 같은 정의)
 * → 엔진 snapshot(active, today) → 클라이언트 뷰에 **직렬화 가능한** props(문자열·숫자·배열만, Date 없음).
 * 지난 사이클은 workoutHistory가 닫힌 것만 cycleNo 내림차순으로 — RM 변화는 연속 사이클의 rm에서 파생(별도 필드 없음, §19-3).
 * 📒 운동 기록은 workoutLog가 모든 사이클의 사건을 최신 먼저로 — 소요시간(실측/근사)은 엔진이 읽을 때 계산한다(저장 없음, §19-8).
 *
 * ⚠️ `dynamic = "force-dynamic"`은 **필수**다 — 빠지면 빌드 때 빈 DB로 정적 고정돼 "처음 시작" 화면이 영구히 박힌다
 *    (store를 읽는 모든 페이지의 관용구). "오늘"은 서버(Cloud Run UTC)에서 lib/kst로만 계산한다 — 렌더 중 클라이언트 시계 금지.
 * 잠금: `proxy.ts`가 허용목록 밖을 전부 막으므로 `/workout`·`/api/workout`도 자동으로 PIN 게이트 안이다.
 * 디자인: 헤더는 app/japanese/page.tsx 관용구(`u-navbtn` "← 과목 선택" + 제목 + 한 줄 소개).
 */

import type { Metadata } from "next";
import Link from "next/link";
import WorkoutView from "@/components/workout-view";
import { kstTodayString, shiftDateString } from "@/lib/kst";
import { getStore } from "@/lib/store";
import { pickActiveWorkoutCycle, snapshot, workoutHistory, workoutLog } from "@/lib/workout";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "아빠의 운동 — 은우학습",
  description: "러시안 파이터 풀업·푸시업 사다리 — 오늘 할 세트를 계산해 주고, 기록하면 다음 날을 정해요.",
};

export default async function WorkoutPage() {
  const today = kstTodayString();
  const cycles = await getStore().listWorkoutCycles();
  const active = pickActiveWorkoutCycle(cycles);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="u-navbtn">
            ← 과목 선택
          </Link>
        </div>
        <h1 className="t-book-title mt-4">💪 아빠의 운동</h1>
        <p className="t-lead mt-1">
          러시안 파이터 풀업·푸시업 사다리 — 오늘 할 세트를 계산해 주고, 기록하면 다음 날을 정해요.
        </p>
      </header>

      <WorkoutView
        today={today}
        tomorrow={shiftDateString(today, 1)}
        snapshot={active ? snapshot(active, today) : null}
        history={workoutHistory(cycles)}
        log={workoutLog(cycles)}
      />
    </main>
  );
}
