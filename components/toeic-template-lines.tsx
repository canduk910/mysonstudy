/**
 * 틀 줄·예문 줄 표시 조각 (docs/harness/toeic.md §12-5-1) — ② 템플릿 훈련 탭과 🧩 틀 테스트가 **같은 모양**으로 틀을 보이게 한 곳에 둔다.
 *
 * - `FrameLine`: 영어·한국어 틀 — 고정 부분 굵게, 자리는 자리 칩(같은 이름 = 같은 색 — slotToneMap).
 * - `ExampleLine`: 예문·정답 문장 — 채움 i 구간에 자리 색 밑줄(문장 = 틀 + 채움이라 위치가 결정적이다 — splitExampleByFills).
 * 판단은 lib/toeic-template의 순수 함수가 하고 여기서는 칠하기만 한다. 모든 글은 텍스트로만 넣는다(HTML 해석 없음).
 * 훅이 없어 서버·클라이언트 컴포넌트 어디서든 쓸 수 있다(스타일은 ② 탭 CSS 모듈의 자리 색 — 새 색조 없음).
 */

import { Fragment } from "react";
import { splitExampleByFills, splitFrameForDisplay } from "@/lib/toeic-template";
import s from "./toeic-template-view.module.css";

/** 자리 순서 → 색 클래스(네 가지 — 색 + 선 모양) */
export const TEMPLATE_TONE_CLASS = [s.tone0, s.tone1, s.tone2, s.tone3];

export function templateToneClass(slot: number): string {
  return TEMPLATE_TONE_CLASS[((slot % TEMPLATE_TONE_CLASS.length) + TEMPLATE_TONE_CLASS.length) % TEMPLATE_TONE_CLASS.length];
}

/** 자리 칩 클래스(자리 순서 색 + 선 모양) — 틀 줄의 자리와 같은 모양(테스트의 채움 칩·비교 칩이 쓴다) */
export function slotChipClass(slot: number): string {
  return `${s.slot} ${templateToneClass(slot)}`;
}

/** 영어·한국어 틀 줄 — 고정 부분 굵게, 자리는 자리 칩(같은 이름 = 같은 색) */
export function FrameLine({ frame, tones, lang }: { frame: string; tones: Map<string, number>; lang: "en" | "ko" }) {
  return (
    <>
      {splitFrameForDisplay(frame).map((g, i) =>
        g.name === null ? (
          <b key={i} className={lang === "en" ? s.fixedEn : s.fixedKo}>
            {g.text}
          </b>
        ) : (
          <span key={i} className={`${s.slot} ${TEMPLATE_TONE_CLASS[tones.get(g.name) ?? 0]}`}>
            {g.name}
          </span>
        ),
      )}
    </>
  );
}

/** 예문 — 채움 i 구간에 자리 색 밑줄(`boldFixed`면 틀 고정 부분을 굵게 — 테스트 정답 표시, §12-5-3) */
export function ExampleLine({ frameEn, fills, boldFixed = false }: { frameEn: string; fills: readonly string[]; boldFixed?: boolean }) {
  return (
    <>
      {splitExampleByFills(frameEn, fills).map((g, i) =>
        g.slot === null ? (
          boldFixed ? (
            <b key={i} className={s.fixedEn}>
              {g.text}
            </b>
          ) : (
            <Fragment key={i}>{g.text}</Fragment>
          )
        ) : (
          <span key={i} className={`${s.fill} ${templateToneClass(g.slot)}`}>
            {g.text}
          </span>
        ),
      )}
    </>
  );
}
