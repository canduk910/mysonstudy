"use client";

/**
 * 학습 스트릭 헤드라인 (SPEC §17-4·§17-7) — 모든 화면 상단 고정. **가족 → 은우 → (엄마) → 아빠**를 나란히 대조해 습관을 자극한다.
 *
 * - 아빠 칸은 2026-10-09(사용자 결정, 옵션 1)부터 **사람 하나**(`appaPerson` — 은우·엄마와 같은 `Person`). 2026-10-10부터는
 *   📚 어학과 💪 운동을 **둘 다** 해야 켜지고(그 전 날짜는 둘 중 하나 — 이어 온 연속이 그대로 넘어간다), 라벨이 남은 것을 말한다
 *   ("운동 ✓ · 어학 남음" — 아직이어도 "오늘 아직" 대신, sm 이상). 예전 두 트랙 칸(📚·💪)과 그 전의 🗾·🎙️ 칸은 없다.
 * - `sticky top-0` + z는 10~19(카드 오버레이 z:20이 몰입 화면에서 덮는 게 의도). `print-hide`.
 * - `/unlock`에선 숨긴다. **시험 화면**(useExamScreen — lib/exam-screen.ts)에서도 숨기고 `--streak-h`를 0으로 내린다(2026-10-09). 데이터는 클라이언트가 `/api/streak`로 가져온다(초기 렌더는 중립 → 마운트 후 채움, hydration 안전).
 * - 시험 저장·운동 기록/취소/사이클 시작 성공 시 STREAK_REFRESH_EVENT로 즉시 갱신(성취감).
 * - 높이는 `--streak-h` 고정·한 줄 — 넘치면 가로 스크롤, 긴 라벨은 말줄임.
 * - **폰(<640px)은 `이모지 (사람 이름) 🔥N`만**(§17-7 폰 표시) — 360px 한 화면에 은우·일본어·영어·운동 🔥가 다 보이게.
 *   "오늘 아직"·트랙 이름·오늘 라벨은 sm 이상에서만 보이고 폰에선 `max-sm:sr-only`(스크린리더엔 남음). 오늘 아직은 흐림이 신호.
 *   아빠 트랙이 셋(🗾 일본어·🎙️ 영어·💪 운동, toeic.md §0-2)이 되면서 폰에선 "일" 글자를 빼고(🔥12 — role=img의 aria-label
 *   "영어 12일 연속"이 스크린리더에 그대로 간다) 간격을 한 단계 좁혔다. 실측(2026-09-26, 두 자리 연속일): 360px·390px에서
 *   가로 넘침 0 — 수치는 _workspace/build_app-builder_toeic-m1_report.md.
 * - **세 자리 연속일(100일+)이 하나라도 있으면 폰에서 한 단계 더 압축**(`compact`, QA toeic_m1 P2-4): 사람 이모지(🧒·🧑 — 장식,
 *   aria-hidden)를 숨기고 칸 사이 간격을 좁힌다. **사람 이름(은우·아빠)은 그대로 보인다** — 누구의 🔥인지는 이름이 말한다.
 *   두 자리까지는 예전 모습 그대로다(압축은 필요할 때만). 실측(2026-09-26, 360px): 세 자리 전부(123·234·345·456, 999×4)
 *   넘침 22·24px → 0, 네 자리(1234…) 53px → 0. 수치는 _workspace/build_app-builder_toeic-p2fix_report.md.
 *   영어 모바일 상단바(sticky top-0)가 이 높이만큼 내려가 겹치지 않는다(globals.css·english-nav.module.css).
 * - 2026-10-09 엄마의 생활영어(엄마 설계 §7): **👩 엄마 칸**(`mom` — 엄마 영역에 블록이 하나라도 있을 때만, null이면 칸 없음).
 *   만회 안내·오늘 아직 점은 은우 칸과 같은 `Person`(repairHintText·needsMoreToday 그대로).
 *   같은 날 사용자 요청: 순서는 **가족 → 은우 → 엄마 → 아빠**, 엄마도 은우와 **똑같이** 이름 글자를 보이고 👩는 compact 규칙으로
 *   숨긴다(🧒·🧑와 같다 — 예전에 폰에서 엄마 이름만 스크린리더로 돌리던 예외는 걷었다). 엄마 칸이 있으면 폰에서 늘 compact.
 *   (같은 날 넣었던 "엄마 칸이면 칸 사이·칸 안 2px·세로선 숨김"은 아빠가 칸 하나가 되며 걷었다 — 실측 넘침 0.)
 * - 2026-10 스트릭 v2(가족 스트릭 강화): 맨 앞에 **👪 가족 칸**(`family` — 오늘 모두 한 판 이상이면 켜진다)을 둔다.
 *   오늘 아직인 칸엔 이모지 앞에 **작은 점**(`data-pending-dot`, aria-hidden — 폰에서도 보이는 신호, 글자는 "오늘 아직"이 sr에 남는다).
 *   **만회 대기**(`info.pendingRepairDay` — 어제를 놓쳤고 오늘 두 판이면 돌아온다)이고 판이 모자라면(`repairHintText` — 한 판을
 *   해서 doneToday가 켜졌어도) "오늘 두 판이면 어제 🔥가 돌아와요"/"한 판 더 하면 어제 🔥가 돌아와요"(sm 이상, 폰은 sr-only).
 *   아빠도 사람 하나(`appaPerson`)라 다른 사람과 같은 자리(칸 안)에 보인다.
 *   배지 축하 토스트(`StreakCelebrate`)를 헤드라인 옆에 마운트한다 — 모든 화면에서 한 번 보인다.
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { STREAK_REFRESH_EVENT } from "@/lib/streak";
import type { PersonStreak, StreakResponse } from "@/lib/streak-contract";
import { appaRepairHintOf, repairHintText } from "@/lib/streak-v2";
import StreakCelebrate from "@/components/streak-celebrate";
import { useExamScreen } from "@/components/use-exam-screen";
import { EXAM_SCREEN_STREAK_H_CSS } from "@/lib/exam-screen";

/**
 * 폰 압축 한 단계 더 — 연속일이 이 값 이상인 칸이 하나라도 있을 때(🔥 숫자 폭이 늘어나는 만큼 장식을 덜어 낸다).
 * 2026-10(v2): 👪 칸과 오늘 아직 점이 늘어 100 → 10. 실측(360px, 두 자리 12·34·56·78 + 가족 23, 모두 오늘 아직):
 * 100일 때 넘침 21px → 10일 때 0. 390px은 둘 다 0. 세 자리도 0, 네 자리(1234…)는 360px에서 26px(가로 스크롤로 남는다).
 */
const COMPACT_FROM_DAYS = 10;

function Person({
  emoji,
  name,
  p,
  compact,
  labelWhenPending = false,
  repairHint,
}: {
  emoji: string;
  name: string;
  p: PersonStreak | undefined;
  compact: boolean;
  /** 아빠 — 오늘 아직이어도 라벨("운동 ✓ · 어학 남음")을 "오늘 아직" 대신 보인다(무엇이 남았는지가 라벨에 있다) */
  labelWhenPending?: boolean;
  /** 만회 안내를 밖에서 정한다(아빠 — 남은 쪽을 말하는 appaRepairHintOf). undefined면 공용 repairHintText */
  repairHint?: string | null;
}) {
  const loaded = p != null;
  // 만회 대기에 판이 모자라면(한 판만 했어도) 다 한 게 아니다 — 자정에 어제가 끊긴다(needsMoreToday)
  const hint = p ? (repairHint !== undefined ? repairHint : repairHintText(p.info)) : null;
  const done = (p?.info.doneToday ?? false) && hint === null;
  const days = p?.info.current ?? 0;
  return (
    <div className={`flex items-center gap-1 whitespace-nowrap sm:gap-1.5 ${loaded && !done ? "opacity-55" : ""}`}>
      {loaded && !done && <span data-pending-dot aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
      {/* 사람 이모지(🧒·👩)는 장식 — compact면 폰에서 숨기고 이름 글자가 사람을 가른다(아빠 🧑와 같은 규칙) */}
      <span aria-hidden className={compact ? "max-sm:hidden" : undefined}>
        {emoji}
      </span>
      <span className="t-caption font-medium text-ink">{name}</span>
      <span className="t-caption font-bold text-ink" role={loaded ? "img" : undefined} aria-label={loaded ? `${name} ${days}일 연속` : undefined}>
        🔥{loaded ? days : "··"}
        <span className="max-sm:hidden">일</span>
      </span>
      {loaded && !done && <span className="t-caption text-ink-3 max-sm:sr-only">{hint ?? (labelWhenPending && p?.todayLabel ? p.todayLabel : "오늘 아직")}</span>}
      {loaded && done && p?.todayLabel && <span className="t-caption text-ink-3 max-sm:sr-only">· {p.todayLabel}</span>}
    </div>
  );
}

/** 👪 가족 칸 — 사람 이름 없이 이모지 + 🔥(이름은 스크린리더에만). 2026-10-09까지는 아빠의 📚·💪 트랙 칸도 이것이었다 */
function Track({ emoji, name, p }: { emoji: string; name: string; p: PersonStreak | undefined }) {
  const loaded = p != null;
  const done = p?.info.doneToday ?? false;
  const days = p?.info.current ?? 0;
  return (
    <div className={`flex shrink-0 items-center gap-1 whitespace-nowrap ${loaded && !done ? "opacity-55" : ""}`}>
      {loaded && !done && <span data-pending-dot aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
      <span aria-hidden>{emoji}</span>
      {/* 폰에선 이모지(📚·💪)가 트랙을 가른다 — 이름은 스크린리더에만 */}
      <span className="t-caption text-ink-2 max-sm:sr-only">{name}</span>
      <span className="t-caption font-bold text-ink" role={loaded ? "img" : undefined} aria-label={loaded ? `${name} ${days}일 연속` : undefined}>
        🔥{loaded ? days : "··"}
        <span className="max-sm:hidden">일</span>
      </span>
      {loaded && !done && <span className="t-caption text-ink-3 max-sm:sr-only">오늘 아직</span>}
      {loaded && done && p?.todayLabel && (
        // 긴 단어장 제목은 말줄임 — 전체는 title로. 폰에선 스크린리더에만(🔥가 한 화면에 들어오게)
        <span className="t-caption inline-block max-w-[11rem] truncate text-ink-3 max-sm:sr-only" title={p.todayLabel}>
          · {p.todayLabel}
        </span>
      )}
    </div>
  );
}

export default function StreakHeadline() {
  const pathname = usePathname();
  const exam = useExamScreen();
  const [data, setData] = useState<StreakResponse | null>(null);

  useEffect(() => {
    let alive = true;
    let seq = 0; // 기록 직후 취소처럼 load()가 겹치면 늦게 온 옛 응답이 새 데이터를 덮지 않게 — 마지막 요청만 반영
    const load = async () => {
      const mine = ++seq;
      try {
        const res = await fetch("/api/streak", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as StreakResponse;
        if (alive && mine === seq) setData(json);
      } catch {
        /* 조용히 — 헤드라인은 보조 UI, 실패해도 앱은 정상 */
      }
    };
    void load();
    const onRefresh = () => void load(); // 시험 저장·운동 기록 직후 갱신
    window.addEventListener(STREAK_REFRESH_EVENT, onRefresh);
    return () => {
      alive = false;
      window.removeEventListener(STREAK_REFRESH_EVENT, onRefresh);
    };
  }, []);

  if (pathname === "/unlock") return null; // 잠금 화면엔 학습 현황을 보이지 않는다
  // 시험 화면(lib/exam-screen.ts)에선 헤드라인을 내리고 `--streak-h`를 0으로 — sticky 요소가 빈 칸 없이 맨 위에 붙는다.
  // 컴포넌트는 마운트된 채라 시험 저장 뒤 STREAK_REFRESH_EVENT 갱신을 그대로 받는다(돌아오면 새 숫자). <style>은 시험을
  // 벗어나면(경로 이동·블록 해제) 렌더에서 빠져 변수가 40px로 돌아온다 — 되돌리는 정리 코드가 따로 없다.
  if (exam) return <style data-exam-screen>{EXAM_SCREEN_STREAK_H_CSS}</style>;

  // 아빠는 사람 하나(appaPerson — APPA_BOTH_FROM부터 어학·운동 둘 다). 만회 안내·흐림·점은 Person이 이 값으로 판정한다.
  // appaPerson이 없는 응답(옛 서버·v2 폴백마저 실패)이면 어학 트랙으로 대신 보인다.
  const appaCell = data ? (data.appaPerson ?? data.appaLanguage) : undefined;
  // 만회 안내도 남은 쪽을 말한다(운동이 빠진 날 "두 판이면"은 틀린 지시 — QA appa-merge_1 P2-A)
  const appaHint = data ? appaRepairHintOf(data) : undefined;

  // 엄마 칸이 있으면 연속일과 무관하게 폰에서 늘 압축한다 — 한 자리 연속일·압축 없음이면 360px 44px·390px 14px 넘쳤다(2026-10-09 실측).
  const compact =
    data != null &&
    (data.mom != null || [data.family, data.eunwoo, appaCell, data.mom].some((p) => (p?.info.current ?? 0) >= COMPACT_FROM_DAYS));
  // 2026-10-09 아빠가 사람 하나(칸 하나 줄었다)가 되며 엄마 칸이 있을 때의 폰 추가 압축(칸 사이 2px·칸 안 2px·세로선 숨김)을 걷었다.
  //   실측(360·390px, 한·두·세 자리, 엄마 있음/없음, 모두 아직/모두 함, 아빠 만회 안내 있음/없음): 가로 넘침 0.
  //   네 자리(1234…)·엄마 있음·오늘 아직만 360px에서 11px(가로 스크롤로 남는다). _workspace/build_app-builder_common-appa-merge_report.md
  const gapCls = compact ? "gap-1.5" : "gap-2";
  const divCls = "h-5 w-px shrink-0 bg-line";

  return (
    <>
      <div
        className={`print-hide sticky top-0 z-[15] flex items-center ${gapCls} overflow-x-auto overflow-y-hidden border-b border-line bg-bg px-2 [scrollbar-width:none] sm:gap-3 sm:px-3 [&::-webkit-scrollbar]:hidden`}
        style={{ height: "var(--streak-h)" }}
        role="group"
        aria-label={data?.mom ? "학습 스트릭 — 가족, 은우, 엄마, 아빠" : "학습 스트릭 — 가족, 은우, 아빠"}
      >
        {/* 가족 — 오늘 모두 한 판 이상이면 켜진다(v2) */}
        <Track emoji="👪" name="가족" p={data?.family} />
        <span aria-hidden className={divCls} />
        <Person emoji="🧒" name="은우" p={data?.eunwoo} compact={compact} />
        {/* 엄마(엄마의 생활영어 — 엄마 설계 §7) — 은우 다음. 엄마 영역 데이터가 없으면(mom: null) 칸·세로선 모두 그리지 않는다 */}
        {data?.mom && (
          <>
            <span aria-hidden className={divCls} />
            <Person emoji="👩" name="엄마" p={data.mom} compact={compact} />
          </>
        )}
        {/* 두 사람 사이 — 기존 경계선 색(line)의 얇은 세로선 */}
        <span aria-hidden className={divCls} />
        {/* 아빠 사람 하나(2026-10-09 사용자 결정) — 2026-10-10부터 어학·운동 둘 다 해야 켜진다. 라벨이 남은 것을 말한다 */}
        <Person emoji="🧑" name="아빠" p={appaCell} compact={compact} labelWhenPending repairHint={appaHint} />
      </div>
      {/* 배지 축하 — 이 기기에서 아직 축하하지 않은 얻은 배지 하나(가족 스트릭 강화 §4-1) */}
      {data && <StreakCelebrate badges={data.badges} />}
    </>
  );
}
