/**
 * 엄마의 생활영어 홈 본문(설계 §6-2) — 서버 컴포넌트. 가져오기 버튼만 클라이언트.
 *
 * - 자료 없음 → 안내 + 📥 가져오기
 * - 오늘 카드 → 레슨(시작하기) · 주간 테스트 · 1회차 끝
 * - 오늘의 복습 카드(SPEC §23 — 레슨에서 말해 본 문장, 끝낸 다음 날부터)
 * - 진도 지도 → 1~52주 칸(가상 복습 주는 칸이 없다 — "복습 주"로만 말한다), 단계 경계마다 이름표
 * 교재 문장은 여기 없다 — 화면은 주·일·개수만 보여 준다.
 */
import Link from "next/link";
import MomImportButton from "@/components/mom-import-button";
import ReviewTodayCard from "@/components/review-today-card";
import { isMomVirtualWeek, MOM_REVIEW_WEEKS, type MomProgress, type MomTodayItem } from "@/lib/mom-plan";

const MOM_TOTAL_WEEKS = 52;

/** 단계 경계(첫 주) → 이름 */
const STAGES: { stage: number; from: number; to: number; name: string }[] = [
  { stage: 0, from: 1, to: 4, name: "몸풀기" },
  { stage: 1, from: 5, to: 16, name: "부탁하고 원하기" },
  { stage: 2, from: 17, to: 32, name: "일상 말하기" },
  { stage: 3, from: 33, to: 46, name: "길게 잇기" },
  { stage: 4, from: 47, to: 52, name: "원어민 표현" },
];

function weekLabel(week: number): string {
  return isMomVirtualWeek(week) ? "복습 주" : `${week}주차`;
}

function TodayCard({ today }: { today: MomTodayItem }) {
  if (today.kind === "lesson") {
    const { lesson, minutesHint } = today;
    return (
      <section className="u-card mt-6 p-5">
        {lesson.kind === "review" ? <p className="u-chip u-chip-accent mb-2">🔁 복습 레슨</p> : null}
        <p className="t-section-title">
          오늘의 레슨 · {weekLabel(lesson.week)} {lesson.day}일 · 약 {minutesHint}
        </p>
        <Link href={`/mom/lesson/${lesson.id}`} className="u-btn u-btn-primary mt-4 w-full text-lg" style={{ minHeight: 56 }}>
          시작하기
        </Link>
      </section>
    );
  }
  if (today.kind === "test") {
    return (
      <section className="u-card mt-6 p-5">
        <p className="t-caption text-ink-3">{isMomVirtualWeek(today.week) ? "복습 주 테스트" : MOM_REVIEW_WEEKS.includes(today.week) ? `${today.week}주차 · 복습 주 테스트` : `${today.week}주차 테스트`}</p>
        <p className="t-section-title mt-1">이번 주 테스트 · {today.size}문제</p>
        <p className="t-body mt-1 text-ink-2">이번 주 레슨을 다 했어요. 배운 문장을 말해 봐요.</p>
        <Link href={`/mom/test/${today.week}`} className="u-btn u-btn-primary mt-4 w-full text-lg" style={{ minHeight: 56 }}>
          테스트 보기
        </Link>
      </section>
    );
  }
  if (today.kind === "done") {
    return (
      <section className="u-card mt-6 p-5">
        <p className="t-section-title">1회차를 다 했어요! 🎉</p>
        <p className="t-body mt-1 text-ink-2">정말 잘했어요. 지난 레슨은 언제든 다시 해 볼 수 있어요.</p>
      </section>
    );
  }
  return (
    <section className="u-card mt-6 p-5">
      <p className="t-section-title">말해 볼 문장이 아직 없어요</p>
      <p className="t-body mt-1 text-ink-2">가져온 자료에 말하기 문장이 없어요. 다른 파일을 가져와 보세요.</p>
    </section>
  );
}

function ProgressMap({ progress }: { progress: MomProgress }) {
  const byWeek = new Map(progress.weeks.map((w) => [w.week, w]));
  return (
    <section className="mt-8">
      <h2 className="t-section-title">진도 지도</h2>
      <p className="t-caption mt-1 text-ink-3">
        레슨 {progress.doneLessons} / {progress.totalLessons} · 지금 {progress.currentIsReview ? (MOM_REVIEW_WEEKS.includes(progress.currentWeek) ? `${progress.currentWeek}주차 · 복습 주` : "복습 주") : `${progress.currentWeek}주차`}
      </p>
      <p className="t-caption mt-1 text-ink-3">✓ 끝남 · 🔁 복습 주 · 테두리 굵은 칸 = 지금</p>
      {STAGES.map((s) => (
        <div key={s.stage} className="mt-4">
          <p className="t-caption font-medium text-ink-2">
            {s.stage}단계 · {s.name} <span className="text-ink-3">({s.from}~{s.to}주)</span>
          </p>
          <ol className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1.5">
            {Array.from({ length: s.to - s.from + 1 }, (_, i) => s.from + i).map((week) => {
              const w = byWeek.get(week);
              const isReview = MOM_REVIEW_WEEKS.includes(week);
              const status = w?.status ?? "none";
              const cls =
                status === "done"
                  ? "bg-accent-soft border-accent-soft text-accent-ink"
                  : status === "current"
                    ? "border-accent border-2 text-ink font-medium"
                    : status === "todo"
                      ? "border-line text-ink-2"
                      : "border-dashed border-line text-ink-3";
              const label = `${week}주차${isReview ? " 복습" : ""} — ${status === "done" ? "끝남" : status === "current" ? "지금" : status === "todo" ? "할 차례 아님" : "자료 없음"}`;
              return (
                <li
                  key={week}
                  aria-label={label}
                  title={label}
                  className={`flex h-11 flex-col items-center justify-center rounded-lg border text-xs leading-tight ${cls}`}
                >
                  <span>{status === "done" ? "✓" : isReview ? "🔁" : week}</span>
                  {status === "done" || isReview ? <span className="text-[10px] opacity-70">{week}</span> : null}
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </section>
  );
}

export default function MomHome({ today, progress, hasContent }: { today: MomTodayItem; progress: MomProgress; hasContent: boolean }) {
  if (!hasContent) {
    return (
      <section className="u-card mt-6 p-5">
        <p className="t-section-title">아직 학습 자료가 없어요.</p>
        <p className="t-body mt-1 text-ink-2">받은 파일을 가져오면 시작돼요.</p>
        <div className="mt-4">
          <MomImportButton />
        </div>
      </section>
    );
  }
  return (
    <>
      <TodayCard today={today} />
      <div className="mt-4">
        <ReviewTodayCard area="mom" tone="adult" />
      </div>
      <ProgressMap progress={progress} />
      <div className="mt-10 border-t border-line pt-4">
        <MomImportButton label="📥 자료 다시 가져오기" />
      </div>
    </>
  );
}
