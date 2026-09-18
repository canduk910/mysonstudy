/**
 * components/ja-ruby.tsx — 후리가나 렌더 헬퍼 (아빠의 일본어, 스펙 §5)의 **단일 정의처**.
 *
 * `JaToken[]`을 받아, 토큰마다 `reading !== null`이면 `<ruby>{surface}<rt>{reading}</rt></ruby>`, 아니면 그냥
 * 텍스트로 그린다. 화면(단어장 상세·시험·대화 복습)마다 이 로직을 복사하면 반드시 갈린다 — `resolveVocabImage`·
 * `lib/speech.ts` 선례대로 여기 한 곳만 둔다. J1/J3에서 이 컴포넌트를 **사용**한다(J0은 헬퍼만 만든다 — 데모 없음).
 *
 * 순수 표시 컴포넌트다(훅·브라우저 전역 없음) — "use client" 지시어를 두지 않아 서버·클라이언트 컴포넌트 양쪽에서
 * import할 수 있다. 타입은 타입 전용 모듈(`lib/japanese-ruby-contract`)에서 와 클라이언트 번들에 lib/ai가 새지 않는다.
 *
 * 발음(TTS)은 여기서 하지 않는다 — surface 원문을 `speak(text, "ja-JP")`로 읽는 것은 호출측(J1)의 몫이다(§5).
 */

import { Fragment } from "react";
import type { JaToken } from "@/lib/japanese-ruby-contract";
import s from "./ja-ruby.module.css";

interface JaRubyProps {
  tokens: JaToken[];
  /** 바깥 래퍼 태그 — 문장 안 인라인이면 "span"(기본), 블록으로 쓰려면 "div" 등. */
  as?: "span" | "div";
  /** 추가 클래스(호출측 레이아웃) — 내부 줄간격 클래스와 합쳐진다. */
  className?: string;
}

export default function JaRuby({ tokens, as: Tag = "span", className }: JaRubyProps) {
  return (
    <Tag lang="ja" className={`${s.line}${className ? ` ${className}` : ""}`}>
      {tokens.map((t, i) =>
        t.reading !== null ? (
          <ruby key={i} className={s.ruby}>
            {t.surface}
            <rt className={s.rt}>{t.reading}</rt>
          </ruby>
        ) : (
          // 가나·숫자·기호 — 루비 없이 원문 그대로. Fragment로 감싸 불필요한 span을 피한다.
          <Fragment key={i}>{t.surface}</Fragment>
        ),
      )}
    </Tag>
  );
}
