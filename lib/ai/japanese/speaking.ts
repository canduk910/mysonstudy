/**
 * lib/ai/japanese/speaking.ts — 말하기 모의고사 후처리·피드백 입력 순수 함수 (docs/harness/japanese.md §15-3-8·§15-4-2)
 *
 * - `toJaSpeakingRecordPart`: 호출 E 결과 → 레코드 파트. E2(사진)만 `items[i].image = {status:"pending", imageId:null}`을 붙인다
 *   (관문 P가 채운다 — 토익 C2와 같은 상태 기계).
 * - `buildJaSpeakingFeedbackMaterial`·`buildJaSpeakingFeedbackInput`: 호출 F 사용자 메시지 자료를 **레코드에서** 만든다(화면이 보낸 글을
 *   믿지 않는다 — 응시 레코드·모의고사 레코드가 단일 근거).
 * - 무응답(전사 글자 < JA_SPEAKING_MIN_TRANSCRIPT_CHARS)은 호출 F 없이 `score: 0, feedback: null, noResponse: true`로 저장한다(§15-4-0) —
 *   피드백 객체를 지어내지 않아 추정 수준 집계에 섞이지 않는다.
 *
 * 순수(네트워크·store 없음). 라우트·eval이 쓴다.
 */

import type { JlptLevel } from "./schemas";
import type { JaSpeakingFeedbackInput } from "./speaking-prompts";
import type { JaSpeakingPartGenMap, JaSpeakingPartRecordMap } from "./speaking-schemas";
import { jaSpeakingQuestionFormat, type JaSpeakingPart } from "../../ja-speaking";

/** 호출 E 결과 → 레코드 파트(사진만 image pending) */
export function toJaSpeakingRecordPart<P extends JaSpeakingPart>(part: P, gen: JaSpeakingPartGenMap[P]): JaSpeakingPartRecordMap[P] {
  if (part === "picture") {
    const g = gen as JaSpeakingPartGenMap["picture"];
    const rec: JaSpeakingPartRecordMap["picture"] = {
      items: g.items.map((it) => ({ ...it, image: { status: "pending", imageId: null } })),
    };
    return rec as JaSpeakingPartRecordMap[P];
  }
  return gen as unknown as JaSpeakingPartRecordMap[P];
}

/** 레코드의 파트 묶음(모의고사 레코드 `parts`) */
export type JaSpeakingParts = { [P in JaSpeakingPart]: JaSpeakingPartRecordMap[P] | null };

/**
 * 호출 F의 `수험자가 본 자료`(§15-4-2) — 줄마다 한 가지, 라벨은 한국어. Q1–2이거나 파트·슬롯이 없으면 null(호출 F를 부르지 않는다).
 * - Q3–4: `사진 설명: {sceneKo}` → `묘사 포인트:` → `- {keyPointsKo}`
 * - Q5–7: `상황: {intro.ja}` → `질문: {question.ja}`
 * - Q8–10: `표: {title}` → meta 한 줄씩 → rows `{left} — {right}` → notes → `전화 건 사람: {callerIntro.ja}` → `질문: {question.ja}`
 * - Q11: `질문: {question.ja}`
 */
export function buildJaSpeakingFeedbackMaterial(parts: JaSpeakingParts, q: number): string | null {
  const f = jaSpeakingQuestionFormat(q);
  switch (f.part) {
    case "read":
      return null;
    case "picture": {
      const it = parts.picture?.items[f.slot];
      if (!it) return null;
      return [`사진 설명: ${it.sceneKo}`, "묘사 포인트:", ...it.keyPointsKo.map((k) => `- ${k}`)].join("\n");
    }
    case "respond": {
      const p = parts.respond;
      const it = p?.questions[f.slot];
      if (!p || !it) return null;
      return [`상황: ${p.intro.ja}`, `질문: ${it.question.ja}`].join("\n");
    }
    case "info": {
      const p = parts.info;
      const it = p?.questions[f.slot];
      if (!p || !it) return null;
      return [
        `표: ${p.table.title}`,
        ...p.table.meta,
        ...p.table.rows.map((r) => `${r.left} — ${r.right}`),
        ...p.table.notes,
        `전화 건 사람: ${p.callerIntro.ja}`,
        `질문: ${it.question.ja}`,
      ].join("\n");
    }
    case "opinion": {
      const p = parts.opinion;
      if (!p) return null;
      return `질문: ${p.question.ja}`;
    }
  }
}

/** 그 문항의 모범답변 ja(Q1–2·없으면 null) */
export function jaSpeakingSampleAnswer(parts: JaSpeakingParts, q: number): string | null {
  const f = jaSpeakingQuestionFormat(q);
  switch (f.part) {
    case "picture":
      return parts.picture?.items[f.slot]?.sampleAnswer.ja ?? null;
    case "respond":
      return parts.respond?.questions[f.slot]?.sampleAnswer.ja ?? null;
    case "info":
      return parts.info?.questions[f.slot]?.sampleAnswer.ja ?? null;
    case "opinion":
      return parts.opinion?.sampleAnswer.ja ?? null;
    default:
      return null;
  }
}

/** 호출 F 입력 — 레코드(레벨·파트)와 전사문으로 만든다. Q1–2이거나 자료가 없으면 null(호출하지 않는다) */
export function buildJaSpeakingFeedbackInput(
  mock: { level: JlptLevel; parts: JaSpeakingParts },
  q: number,
  transcript: string,
): JaSpeakingFeedbackInput | null {
  const material = buildJaSpeakingFeedbackMaterial(mock.parts, q);
  const sampleAnswer = jaSpeakingSampleAnswer(mock.parts, q);
  if (material === null || sampleAnswer === null) return null;
  return { q, level: mock.level, material, sampleAnswer, transcript };
}
