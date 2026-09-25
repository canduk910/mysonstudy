/**
 * lib/toeic-zod-ko.ts — 아빠의 영어(토익) 라우트의 zod **기본 오류 문구를 한국어로** 바꾸는 오류 맵 (docs/harness/toeic.md §7-1·§7-6)
 *
 * 왜: 라우트 400의 `issues[].message`와 `messageKo`는 화면에 그대로 보인다(사진 흐름 검토 화면·파일 가져오기·시험 저장).
 * 스키마에 한국어 문구를 직접 적지 않은 규칙(`.max(999)`, `z.literal(...)`, 타입 불일치 등)은 zod 기본 영어 문구
 * ("Too big: expected number to be <=999", `Invalid input: expected "toeic-sets/v1"`)가 나간다(QA toeic_m1_2 관찰 3).
 *
 * 쓰는 법: `schema.safeParse(raw, { error: toeicZodErrorKo })` — **요청 단위(per-parse) 오류 맵**이라
 *  - 스키마에 직접 적은 문구(`.min(1, "뜻이 비었어요")`)와 superRefine의 custom 문구가 **여전히 우선**한다(zod v4 우선순위:
 *    스키마 문구 → per-parse 맵 → 전역 설정 → 로캘). 이 맵은 문구가 없는 기본 오류만 채운다.
 *  - **전역 `z.config`를 건드리지 않는다.** 전역을 바꾸면 AI 재요청 문구(`callWithSchema`의 zod 오류 요약)까지 바뀌어 세 과목
 *    프롬프트 동작이 흔들린다. 토익 라우트가 파싱할 때만 적용된다.
 *
 * 규약: **입력값은 문구에 넣지 않는다**(가져오기 파일은 교재 원문이다 — 응답·로그에 새지 않게, schemas.ts와 같은 규약).
 * 넣는 것은 스키마가 정한 상한·허용값(우리 상수)뿐이다. 모르는 키 이름도 싣지 않는다(파일에서 온 값이다).
 *
 * import는 zod **타입만** — 런타임 의존 0(어디서 불러도 번들에 zod가 딸려 오지 않는다).
 */

import type { z } from "zod";

type RawIssue = z.core.$ZodRawIssue;

const TYPE_EXPECTED_KO: Record<string, string> = {
  string: "글자여야 해요",
  number: "숫자여야 해요",
  int: "정수여야 해요",
  boolean: "참/거짓 값이어야 해요",
  array: "목록이어야 해요",
  object: "항목 묶음이어야 해요",
  null: "비어 있어야(null) 해요",
  date: "날짜여야 해요",
};

const FALLBACK_KO = "형식이 맞지 않아요";

function num(v: number | bigint): string {
  return typeof v === "bigint" ? v.toString() : String(v);
}

/** zod v4 per-parse 오류 맵 — 기본 오류(문구 없는 규칙)만 한국어로. custom은 스키마 문구가 늘 있으므로 폴백만. */
export function toeicZodErrorKo(iss: RawIssue): string {
  switch (iss.code) {
    case "invalid_type": {
      if (iss.input === undefined) return "빠진 값이 있어요";
      return TYPE_EXPECTED_KO[iss.expected] ?? FALLBACK_KO;
    }
    case "too_big": {
      const max = num(iss.maximum);
      if (iss.origin === "string") return `최대 ${max}자까지예요`;
      if (iss.origin === "array" || iss.origin === "set") return `최대 ${max}개까지예요`;
      if (iss.origin === "number" || iss.origin === "int") return iss.inclusive === false ? `${max}보다 작아야 해요` : `${max} 이하여야 해요`;
      return "너무 커요";
    }
    case "too_small": {
      const min = num(iss.minimum);
      if (iss.origin === "string") return min === "1" ? "비어 있어요" : `최소 ${min}자 이상이어야 해요`;
      if (iss.origin === "array" || iss.origin === "set") return min === "1" ? "하나 이상 있어야 해요" : `최소 ${min}개 이상이어야 해요`;
      if (iss.origin === "number" || iss.origin === "int") return iss.inclusive === false ? `${min}보다 커야 해요` : `${min} 이상이어야 해요`;
      return "너무 작아요";
    }
    case "invalid_value": {
      // 허용값은 스키마가 정한 상수(파일 형식 표시·모드 이름 등)라 실어도 된다 — 입력값은 싣지 않는다
      const allowed = iss.values.map((v) => (typeof v === "string" ? `"${v}"` : String(v)));
      if (allowed.length === 1) return `${allowed[0]} 이어야 해요`;
      if (allowed.length > 0 && allowed.length <= 6) return `${allowed.join(" · ")} 중 하나여야 해요`;
      return "허용되지 않는 값이에요";
    }
    case "invalid_format":
      if (iss.format === "datetime") return "시각 형식(ISO)이 아니에요";
      return FALLBACK_KO;
    case "unrecognized_keys":
      return "모르는 항목이 들어 있어요";
    case "not_multiple_of":
      return "정수여야 해요";
    case "invalid_union":
    case "invalid_key":
    case "invalid_element":
    case "custom":
    default:
      return FALLBACK_KO;
  }
}

/** 라우트 400 `issues` — 경로(점 표기)와 규칙 문구만(값 없음). 개수 상한은 라우트가 정한다. */
export function toToeicIssues(issues: readonly z.core.$ZodIssue[], max = Infinity): { path: string; message: string }[] {
  return issues.slice(0, max).map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}
