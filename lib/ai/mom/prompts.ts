/**
 * lib/ai/mom/prompts.ts — 엄마의 생활영어 호출 M1(주간 테스트 총평) 원문 상수 (설계 §5·§8).
 * 입력은 문항별 (한국어 뜻, 목표 문장, 받아쓰기, 판정)뿐 — 녹음은 보내지 않는다. 순수(클라이언트 안전).
 */
import { MOM_VERDICT_KO, type MomVerdict } from "../../mom-contract";

export const MOM_SUMMARY_SYSTEM_PROMPT = `너는 영어 말하기를 처음 배우는 성인(엄마)의 다정한 코치다. 이번 주 말하기 테스트 결과를 보고 한국어로 짧게 말해 준다.
- goodKo: 잘한 점 하나(구체적으로 — 어떤 문장·틀을 잘 말했는지). 1문장, 60자 안팎.
- fixKo: 다음 주에 고칠 점 하나(가장 자주 틀린 틀이나 소리 하나만, 쉬운 말로). 1문장, 60자 안팎.
- 영어 용어(관사·시제 등)는 쓰지 말고 쉬운 한국어로. 점수·등급·비교는 말하지 않는다.
- 받아쓰기는 기계가 받아 적은 것이라 틀릴 수 있다 — 발음을 단정하지 말고 "이렇게 들렸어요" 수준으로만.
- 영어 문장을 인용할 때는 입력에 있는 목표 문장만 그대로 쓴다.`;

export const MOM_SUMMARY_CALL_OPTIONS = { call: "mom_summary", temperature: 0.4, maxOutputTokens: 400 } as const;

/** 줄바꿈을 한 칸으로 — 입력 한 줄이 문항 한 줄을 깨지 않게 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 문항마다 `- 뜻: … / 목표: … / 받아쓰기: …(없으면 "없음") / 판정: 맞음|아깝다|다시|넘어감` */
export function buildMomSummaryUserMessage(items: readonly { ko: string; en: string; transcript: string | null; verdict: MomVerdict }[]): string {
  return items
    .map((it) => {
      const heard = it.transcript && oneLine(it.transcript) !== "" ? oneLine(it.transcript) : "없음";
      return `- 뜻: ${oneLine(it.ko)} / 목표: ${oneLine(it.en)} / 받아쓰기: ${heard} / 판정: ${MOM_VERDICT_KO[it.verdict]}`;
    })
    .join("\n");
}
