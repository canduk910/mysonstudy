"use client";

/**
 * ⑤ 🗣️ 틀 말하기 — 폴더 탭(고르기) (docs/harness/toeic.md §20-1, SPEC §20-17) — 클라이언트 컴포넌트.
 *
 * 소재 칩(여러 개) → 고른 소재의 이 폴더 틀이 **모두 체크**된 목록 → 뺄 틀만 체크 해제 → (질문 유형 칩으로 좁히기 — 기본 안 좁힘) →
 * 문항 수(1~20, 기본 10) → ▶ 시작 = 진행 화면(`frame-drill/take` — 서버가 출제한다). 범위 판정·문항 수는 순수 함수(frameDrillTabScope —
 * 순수 층 frameDrillScopeFrameKeys 그대로). 범위 문항 0이면 시작을 막는다. 범위가 요청보다 적으면 진행 화면이 알린다(shortBy).
 * 은행이 없으면 "가져오기 먼저". 지난 판 목록(최신 10) → 결과 화면.
 * 고르기는 이 기기에 기억한다(localStorage — 마운트 뒤에만 읽는다, 못 읽어도 동작).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import ToeicFrameDrillImportButton from "@/components/toeic-frame-drill-import-button";
import { formatKst } from "@/lib/kst";
import { TOEIC_FRAME_DRILL_COUNT_DEFAULT, TOEIC_FRAME_DRILL_COUNT_MAX, TOEIC_FRAME_DRILL_COUNT_MIN, clampFrameDrillCount } from "@/lib/toeic-frame-drill";
import { toeicFrameDrillResultHref, toeicFrameDrillTakeHref } from "@/lib/toeic-frame-drill-contract";
import { frameDrillTabScope, type ToeicFrameDrillTabData } from "@/lib/toeic-frame-drill-view";
import s from "./toeic-frame-drill.module.css";

const PREF_KEY = (part: string) => `toeic-frame-drill-sel:${part}`;

interface Sel {
  topicKeys: string[];
  excludedFrameKeys: string[];
  questionTypeKeys: string[];
  count: number;
}

export default function ToeicFrameDrillTab({ data }: { data: ToeicFrameDrillTabData }) {
  const router = useRouter();
  const [sel, setSel] = useState<Sel>({ topicKeys: [], excludedFrameKeys: [], questionTypeKeys: [], count: TOEIC_FRAME_DRILL_COUNT_DEFAULT });
  const [countText, setCountText] = useState(String(TOEIC_FRAME_DRILL_COUNT_DEFAULT));

  // 이 기기의 지난 고르기(모르는 key는 은행이 바뀐 것 — 조용히 버린다)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PREF_KEY(data.part));
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<Sel>;
      const topicKeys = new Set(data.topics.map((t) => t.key));
      const frameKeys = new Set(data.topics.flatMap((t) => t.frames.map((f) => f.key)));
      const qtKeys = new Set(data.questionTypes.map((q) => q.key));
      const count = clampFrameDrillCount(Number(p.count));
      setSel({
        topicKeys: (p.topicKeys ?? []).filter((k) => topicKeys.has(k)),
        excludedFrameKeys: (p.excludedFrameKeys ?? []).filter((k) => frameKeys.has(k)),
        questionTypeKeys: (p.questionTypeKeys ?? []).filter((k) => qtKeys.has(k)),
        count,
      });
      setCountText(String(count));
    } catch {
      /* 기억 못 해도 동작 */
    }
  }, [data.part, data.topics, data.questionTypes]);

  const update = (next: Sel) => {
    setSel(next);
    try {
      window.localStorage.setItem(PREF_KEY(data.part), JSON.stringify(next));
    } catch {
      /* noop */
    }
  };

  const scope = useMemo(() => frameDrillTabScope(data, sel), [data, sel]);
  const chosenTopics = data.topics.filter((t) => sel.topicKeys.includes(t.key));

  const toggleTopic = (key: string) => {
    const on = sel.topicKeys.includes(key);
    const topic = data.topics.find((t) => t.key === key);
    const frameKeys = new Set(topic?.frames.map((f) => f.key) ?? []);
    update({
      ...sel,
      topicKeys: on ? sel.topicKeys.filter((k) => k !== key) : [...sel.topicKeys, key],
      // 소재를 (다시) 고르면 그 소재 틀이 다 켜진다 — 그 소재의 뺀 틀 기억을 지운다
      excludedFrameKeys: sel.excludedFrameKeys.filter((k) => !frameKeys.has(k)),
    });
  };
  const toggleFrame = (key: string) => {
    const off = sel.excludedFrameKeys.includes(key);
    update({ ...sel, excludedFrameKeys: off ? sel.excludedFrameKeys.filter((k) => k !== key) : [...sel.excludedFrameKeys, key] });
  };
  const setTopicAll = (topicKey: string, on: boolean) => {
    const keys = new Set(data.topics.find((t) => t.key === topicKey)?.frames.map((f) => f.key) ?? []);
    const rest = sel.excludedFrameKeys.filter((k) => !keys.has(k));
    update({ ...sel, excludedFrameKeys: on ? rest : [...rest, ...keys] });
  };
  const toggleQt = (key: string) => {
    const on = sel.questionTypeKeys.includes(key);
    update({ ...sel, questionTypeKeys: on ? sel.questionTypeKeys.filter((k) => k !== key) : [...sel.questionTypeKeys, key] });
  };
  const commitCount = (text: string) => {
    const n = clampFrameDrillCount(Number(text));
    setCountText(String(n));
    update({ ...sel, count: n });
  };

  const qtFilter = new Set(sel.questionTypeKeys);
  const canStart = scope.itemCount > 0;
  const start = () => {
    if (!canStart) return;
    const n = clampFrameDrillCount(Number(countText));
    router.push(toeicFrameDrillTakeHref(data.part, { ...sel, count: n }, Date.now()));
  };

  const ready = data.bankState === "ready";
  // 가져오기 칸은 상태와 무관하게 **같은 자리**(마지막 자식)에 둔다 — 가져오기 뒤 router.refresh()로 빈 상태 → 고르기로 바뀌어도
  // 버튼이 다시 마운트되지 않아 "추가 n" 알림이 남는다
  return (
    <div className={s.wrap}>
      {!ready ? (
        <div className={s.empty}>
          <p className={s.emptyText}>
            {data.bankState === "broken"
              ? "⚠️ 틀 말하기 문제 은행을 열지 못했어요. 문제 파일을 다시 가져와 주세요."
              : data.bankState === "empty"
                ? "이 유형에는 아직 틀 말하기 틀이 없어요."
                : "아직 틀 말하기 문제가 없어요. 문제 파일(toeic-frame-drill)을 먼저 가져와 주세요."}
          </p>
        </div>
      ) : (
        <>
      <p className={s.lead}>
        한국어 문장을 보고 외운 영어 틀로 바로 말해요. 말이 끝나면 모범 영어가 크게, 내가 한 말이 작게 나오고 4초 뒤 다음 문장으로 넘어가요.
        끝나면 AI가 문항마다 판정하고 총평·개선점을 줘요.
      </p>

      <section className={s.box} aria-label="소재 고르기">
        <h2 className={s.boxTitle}>① 소재</h2>
        <div className={s.chipRow}>
          {data.topics.map((t) => {
            const on = sel.topicKeys.includes(t.key);
            const n = t.frames.reduce((a, f) => a + f.itemCount, 0);
            return (
              <button key={t.key} type="button" aria-pressed={on} className={`${s.chip} ${on ? s.chipOn : ""}`} onClick={() => toggleTopic(t.key)}>
                {on ? "✓ " : ""}
                {t.nameKo}
                <span className={s.chipCount}>틀 {t.frames.length} · {n}문항</span>
              </button>
            );
          })}
        </div>
        {data.questionTypes.length > 0 && (
          <>
            <p className={s.rowLabel}>질문 유형으로 좁히기(선택 — 안 고르면 전부)</p>
            <div className={s.chipRow}>
              {data.questionTypes.map((q) => {
                const on = sel.questionTypeKeys.includes(q.key);
                return (
                  <button key={q.key} type="button" aria-pressed={on} className={`${s.chip} ${on ? s.chipOn : ""}`} onClick={() => toggleQt(q.key)}>
                    {on ? "✓ " : ""}
                    {q.nameKo}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </section>

      {chosenTopics.length > 0 && (
        <section className={s.box} aria-label="틀 고르기">
          <h2 className={s.boxTitle}>② 틀 — 뺄 틀만 체크를 풀어요</h2>
          {chosenTopics.map((t) => {
            const frames = t.frames.filter((f) => qtFilter.size === 0 || f.questionTypes.some((q) => qtFilter.has(q)));
            if (frames.length === 0) {
              return (
                <p key={t.key} className={s.caption}>
                  {t.nameKo} — 고른 질문 유형의 틀이 없어요
                </p>
              );
            }
            const allOn = frames.every((f) => !sel.excludedFrameKeys.includes(f.key));
            return (
              <fieldset key={t.key} className={s.frameGroup}>
                <legend className="sr-only">{t.nameKo}</legend>
                <div className={s.frameGroupHead}>
                  <span>{t.nameKo}</span>
                  <button type="button" className={s.linkBtn} onClick={() => setTopicAll(t.key, !allOn)}>
                    {allOn ? "모두 빼기" : "모두 넣기"}
                  </button>
                </div>
                <ul className={s.frameList}>
                  {frames.map((f) => {
                    const on = !sel.excludedFrameKeys.includes(f.key);
                    return (
                      <li key={f.key}>
                        <label className={`${s.frameRow} ${on ? "" : s.frameRowOff}`}>
                          <input type="checkbox" className={s.frameCheck} checked={on} onChange={() => toggleFrame(f.key)} />
                          <span className={s.frameText}>
                            <span className={s.frameEn}>{f.frameEn}</span>
                            <span className={s.frameKo}>{f.frameKo}</span>
                          </span>
                          <span className={s.frameMeta}>
                            {f.itemCount}문항{f.wrongRate !== null ? ` · 오답 ${Math.round(f.wrongRate * 100)}%` : ""}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            );
          })}
        </section>
      )}

      <section className={s.box} aria-label="문항 수와 시작">
        <h2 className={s.boxTitle}>③ 문항 수</h2>
        <div className={s.countRow}>
          <input
            type="number"
            inputMode="numeric"
            min={TOEIC_FRAME_DRILL_COUNT_MIN}
            max={TOEIC_FRAME_DRILL_COUNT_MAX}
            className={s.countInput}
            aria-label="문항 수"
            value={countText}
            onChange={(e) => setCountText(e.target.value)}
            onBlur={(e) => commitCount(e.target.value)}
          />
          <span className={s.caption}>
            {TOEIC_FRAME_DRILL_COUNT_MIN}~{TOEIC_FRAME_DRILL_COUNT_MAX}문항 · 지금 범위 <b>틀 {scope.frameKeys.length}개 · {scope.itemCount}문항</b>
          </span>
        </div>
        <p className={s.caption}>오답률이 높은 문항과 덜 연습한 문항이 더 자주 나와요. 같은 틀은 연달아 나오지 않아요.</p>
        <p className={s.caption}>비용: 말한 문항마다 받아쓰기 1회, 끝나면 판정·총평 1회(오답률이 충분히 내려갔으면 새 문제 출제 1회).</p>
        <div>
          <button type="button" className="u-btn u-btn-primary" disabled={!canStart} onClick={start}>
            ▶ 시작
          </button>
        </div>
        {!canStart && <p className={s.caption}>{sel.topicKeys.length === 0 ? "소재를 하나 이상 골라 주세요." : "범위에 문항이 없어요 — 틀을 더 넣거나 질문 유형을 풀어 주세요."}</p>}
      </section>

        </>
      )}

      <RecentList data={data} />

      <section className={s.box} aria-label="문제 파일">
        {ready && <p className={s.caption}>문제 파일 다시 가져오기 — 오답 통계는 이어져요</p>}
        <ToeicFrameDrillImportButton label={ready ? "문제 파일 다시 가져오기" : "문제 파일 가져오기"} />
      </section>
    </div>
  );
}

function RecentList({ data }: { data: ToeicFrameDrillTabData }) {
  if (data.recent.length === 0) return null;
  return (
    <section className={s.box} aria-label="지난 판">
      <h2 className={s.boxTitle}>지난 판</h2>
      <ul className={s.recentList}>
        {data.recent.map((r) => (
          <li key={r.id}>
            <Link href={toeicFrameDrillResultHref(data.part, r.id)} className={s.recentRow}>
              <span className={s.recentMain}>
                <span className={s.recentTitle}>{r.topicNamesKo.length > 0 ? r.topicNamesKo.join(" · ") : "틀 말하기"}</span>
                <span className={s.caption}>
                  {formatKst(r.startedAt)} · {r.total}문항{r.ended === "quit" ? " · 그만둠" : ""}
                </span>
              </span>
              <span className={s.recentScore}>{r.judged ? `✓${r.correct} △${r.close} ✕${r.wrong}` : "판정 전"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
