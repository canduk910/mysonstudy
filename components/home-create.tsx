"use client";

/**
 * 홈의 카드 만들기 영역 (SPEC §4-1) — 클라이언트 컴포넌트.
 * - "표지 사진으로 만들기": M2(사진 판독) 예정 — 비활성 + 안내만.
 * - "책 이름으로 만들기": 수동 메타데이터 전체 입력 폼 (M1에서는 판독·식별이 없어
 *   이 폼이 §9의 수동 입력 폴백을 겸한다).
 * 제출 → "카드 만드는 중" 로딩 → 성공 시 /card/[id] 이동.
 */

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

interface DuplicateInfo {
  bookId: string;
  cardId: string | null;
}

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink outline-none focus:border-fiction";
const labelCls = "block text-[13px] font-semibold text-sub mb-1";

export default function HomeCreate() {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);
  const lastPayload = useRef<Record<string, unknown> | null>(null);
  const formSectionRef = useRef<HTMLDivElement>(null);

  async function post(payload: Record<string, unknown>) {
    setSubmitting(true);
    setErrorKo(null);
    setDuplicate(null);
    lastPayload.current = payload;
    let navigating = false;
    try {
      const res = await fetch("/api/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; cardId?: string | null; bookId?: string; reason?: string; messageKo?: string }
        | null;

      if (res.ok && data?.ok && data.cardId) {
        navigating = true;
        router.push(`/card/${data.cardId}`);
        return;
      }
      if (data?.reason === "duplicate" && data.bookId) {
        setDuplicate({ bookId: data.bookId, cardId: data.cardId ?? null });
        return;
      }
      setErrorKo(data?.messageKo ?? "알 수 없는 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      if (!navigating) setSubmitting(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const str = (name: string) => String(fd.get(name) ?? "").trim();
    const num = (name: string): number | null => {
      const v = str(name);
      if (!v) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const title = str("title");
    const topic = str("topic");
    const fiction = fd.get("isFiction");
    if (!title || !topic || !fiction) {
      setErrorKo("제목, 주제, 픽션/논픽션은 꼭 입력해 주세요.");
      return;
    }

    const lexile = num("lexile");
    const wordCount = num("wordCount");
    void post({
      title,
      author: str("author"),
      series: str("series"),
      isFiction: fiction === "fiction",
      arLevel: num("arLevel"),
      lexile: lexile == null ? null : Math.round(lexile),
      wordCount: wordCount == null ? null : Math.round(wordCount),
      arQuizNo: str("arQuizNo"),
      topic,
      description: str("description"),
      coverEmoji: str("coverEmoji"),
    });
  }

  function openForm() {
    setShowForm(true);
    // 다음 페인트 후 폼으로 부드럽게 스크롤
    setTimeout(() => formSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  }

  return (
    <section>
      {/* 큰 버튼 2개 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="cursor-not-allowed rounded-2xl border border-line bg-card p-5 text-left opacity-60"
        >
          <span className="text-3xl" aria-hidden>📷</span>
          <span className="mt-2 block text-lg font-bold text-ink">표지 사진으로 만들기</span>
          <span className="mt-1 block text-[13px] leading-snug text-sub">
            준비 중이에요 — 사진 판독은 다음 업데이트에서 열려요. 지금은 아래 &lsquo;책 이름으로
            만들기&rsquo;를 이용해 주세요.
          </span>
        </button>

        <button
          type="button"
          onClick={openForm}
          className="rounded-2xl border-2 border-fiction/50 bg-card p-5 text-left shadow-sm transition hover:border-fiction hover:shadow"
        >
          <span className="text-3xl" aria-hidden>✏️</span>
          <span className="mt-2 block text-lg font-bold text-ink">책 이름으로 만들기</span>
          <span className="mt-1 block text-[13px] leading-snug text-sub">
            책 표지나 정보 스티커에 있는 내용을 입력하면 학습 카드를 만들어 드려요.
          </span>
        </button>
      </div>

      {/* 수동 메타데이터 입력 폼 */}
      {showForm && (
        <div ref={formSectionRef} className="mt-6 rounded-2xl border border-line bg-card p-5 sm:p-6">
          <h2 className="text-lg font-bold text-ink">책 정보 입력</h2>
          <p className="mt-1 text-[13px] text-sub">
            제목·주제·픽션 여부만 필수예요. AR 같은 정보는 책 뒤 정보 스티커에 있으면 함께
            적어 주세요 — 카드가 더 정확해져요.
          </p>

          {submitting && (
            <div className="mt-6 flex flex-col items-center gap-2 rounded-xl bg-paper p-8 text-center">
              <span className="text-3xl" aria-hidden>⏳</span>
              <p className="text-base font-bold text-ink">카드 만드는 중…</p>
              <p className="text-[13px] text-sub">보통 20~30초 정도 걸려요. 조금만 기다려 주세요!</p>
            </div>
          )}

          {!submitting && duplicate && (
            <div className="mt-6 rounded-xl bg-paper p-6 text-center">
              <p className="text-base font-bold text-ink">이미 이 책으로 만든 카드가 있어요 📚</p>
              <p className="mt-1 text-[13px] text-sub">기존 카드를 볼까요, 새로 하나 더 만들까요?</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {duplicate.cardId && (
                  <button
                    type="button"
                    onClick={() => router.push(`/card/${duplicate.cardId}`)}
                    className="rounded-xl bg-fiction px-4 py-2.5 text-[14px] font-bold text-white"
                  >
                    기존 카드 보기
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => lastPayload.current && void post({ ...lastPayload.current, force: true })}
                  className="rounded-xl border border-line bg-white px-4 py-2.5 text-[14px] font-semibold text-ink"
                >
                  그래도 새로 만들기
                </button>
              </div>
            </div>
          )}

          {/* 폼은 로딩·중복 패널이 떠 있는 동안에도 언마운트하지 않고 숨기기만 한다 —
              비제어 입력값을 보존해 AI 오류 후 재시도·값 수정이 가능하게 (SPEC §9, QA m1full-1). */}
          <form
            onSubmit={onSubmit}
            className={`mt-4 gap-4 ${submitting || duplicate ? "hidden" : "grid"}`}
          >
              <div>
                <label htmlFor="f-title" className={labelCls}>제목 *</label>
                <input id="f-title" name="title" required className={inputCls} placeholder="예: Wolves" />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="f-author" className={labelCls}>저자</label>
                  <input id="f-author" name="author" className={inputCls} placeholder="예: Laura Marsh" />
                </div>
                <div>
                  <label htmlFor="f-series" className={labelCls}>시리즈</label>
                  <input id="f-series" name="series" className={inputCls} placeholder="예: National Geographic Kids Readers" />
                </div>
              </div>

              <fieldset>
                <legend className={labelCls}>어떤 책인가요? *</legend>
                <div className="flex gap-2">
                  <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] font-semibold text-ink has-checked:border-fiction has-checked:bg-fiction/10">
                    <input type="radio" name="isFiction" value="fiction" className="accent-fiction" />
                    📖 픽션 (이야기 책)
                  </label>
                  <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] font-semibold text-ink has-checked:border-nonfiction has-checked:bg-nonfiction/10">
                    <input type="radio" name="isFiction" value="nonfiction" className="accent-nonfiction" />
                    🔬 논픽션 (정보 책)
                  </label>
                </div>
              </fieldset>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <label htmlFor="f-ar" className={labelCls}>AR 지수</label>
                  <input id="f-ar" name="arLevel" type="number" step="0.1" min="0" max="13" inputMode="decimal" className={inputCls} placeholder="3.3" />
                </div>
                <div>
                  <label htmlFor="f-lexile" className={labelCls}>Lexile</label>
                  <input id="f-lexile" name="lexile" type="number" step="1" min="0" inputMode="numeric" className={inputCls} placeholder="570" />
                </div>
                <div>
                  <label htmlFor="f-wc" className={labelCls}>단어 수</label>
                  <input id="f-wc" name="wordCount" type="number" step="1" min="1" inputMode="numeric" className={inputCls} placeholder="864" />
                </div>
                <div>
                  <label htmlFor="f-quiz" className={labelCls}>AR 퀴즈번호</label>
                  <input id="f-quiz" name="arQuizNo" className={inputCls} placeholder="148832" />
                </div>
              </div>
              <p className="-mt-2 text-[12px] text-sub">
                AR을 비워 두면 주제·소개글로 레벨을 추정하고 카드에 &lsquo;레벨 추정&rsquo; 배지가 붙어요.
              </p>

              <div>
                <label htmlFor="f-topic" className={labelCls}>주제 *</label>
                <input id="f-topic" name="topic" required className={inputCls} placeholder="예: 늑대 — 무리 생활, 하울링, 사냥, 새끼 키우기" />
              </div>

              <div>
                <label htmlFor="f-desc" className={labelCls}>소개글 (출판사 공개 소개 등)</label>
                <textarea id="f-desc" name="description" rows={3} className={inputCls} placeholder="책 뒤표지나 온라인 서점의 공개 소개글이 있으면 붙여 넣어 주세요 (선택)" />
              </div>

              <div>
                <label htmlFor="f-emoji" className={labelCls}>커버 이모지</label>
                <input id="f-emoji" name="coverEmoji" className={inputCls} placeholder="🐺 (비워 두면 📖)" />
              </div>

              {errorKo && (
                <div className="rounded-xl border border-fiction/40 bg-fiction/10 px-4 py-3 text-[13.5px] text-ink">
                  <p>{errorKo}</p>
                  {/* 재시도 = 마지막으로 보낸 페이로드 그대로 재전송 (SPEC §9).
                      값을 고쳐 다시 보내려면 아래 "학습 카드 만들기"를 누르면 된다.
                      아직 서버로 보낸 적이 없으면(클라이언트 검증 오류) 재시도할 대상이 없어 숨긴다. */}
                  {lastPayload.current != null && (
                    <button
                      type="button"
                      onClick={() => lastPayload.current && void post(lastPayload.current)}
                      className="mt-2 rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-semibold"
                    >
                      재시도
                    </button>
                  )}
                </div>
              )}

              <button
                type="submit"
                className="rounded-xl bg-fiction px-4 py-3 text-base font-bold text-white shadow-sm transition hover:brightness-105"
              >
                🪄 학습 카드 만들기
              </button>
          </form>
        </div>
      )}
    </section>
  );
}
