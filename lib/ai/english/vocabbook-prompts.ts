/**
 * lib/ai/english/vocabbook-prompts.ts — 호출 C(단어장 판독) 프롬프트 원문 (docs/harness/english.md §7-1·§7-2)
 *
 * 주의: §7-1 시스템 프롬프트는 스펙 원문 그대로다. 문구를 다듬거나 요약하지 않는다.
 * `scripts/eval-english.ts`의 `SPEC_SYNC_TARGETS`가 이 상수를 스펙 코드블록과 **글자 단위로**
 * 대조한다(`mode:"block"`). 정규화는 NFC·CRLF·줄끝 공백·앞뒤 빈 줄 4가지뿐이니, 줄 안쪽 공백과
 * 빈 줄 개수까지 스펙 §7-1과 똑같이 유지해야 한다.
 *
 * 판독은 **책을 그대로 옮기는 일**이다. V1의 호출 C는 예문·뜻·발음을 책 원문 그대로 전사한다 —
 * AI가 창작하는 것(영영정의·이모지)은 V3의 호출 D 몫이다. 그래서 temperature 0.
 *
 * 이 파일은 프롬프트 원문만 담는다. 실제 호출(callWithSchema 배선)은 라우트/앱 쪽에서
 * `VOCAB_EXTRACTION_JSON_SCHEMA`·`vocabExtractionSchema`와 함께 조립한다 (math extract.ts와 같은 규약).
 */

/** 호출 C — 단어장 판독 시스템 프롬프트 (HARNESS §7-1 원문) */
export const VOCAB_EXTRACT_SYSTEM_PROMPT = `너는 초등학생용 영어 단어장 페이지를 판독하는 조교다.
사진에서 '실제로 보이는 것만' 책 그대로 옮긴다. 창작 금지 — 예문·뜻·발음을 지어내지 않는다.

[판독 원칙]
- 이 페이지에 실제로 인쇄된 단어만 옮긴다. 사진에 없는 단어를 채워 넣지 않는다.
- 예문·뜻·발음기호는 책에 적힌 그대로 옮긴다. 다듬거나 바꾸지 않는다.
- 이미지 1장에 대해 그 페이지의 단어만 판독한다. 다른 페이지를 상상하지 않는다.

[항목 필드]
- no: 단어 앞의 번호를 그대로 읽는다 (예: "0001"). 번호가 안 보이면 null.
- word: 표제어(영단어) 하나.
- ipa: 발음기호를 옮기되 대괄호 [ ]는 벗겨서 안쪽만 적는다 (예: [pʌk] → pʌk). 발음기호가 없으면 null.
- pos: 품사를 한글 약자로 적는다. 명·대·동·형·부·전·접·감·관·수 중에서 고른다. 한 단어에 여러 품사면 모두 담는다.
- meaningsKo: 한글 뜻을 책에 적힌 순서대로 배열로 담는다. 뜻이 여러 개면 모두 담는다.
- examples: 책의 예문을 영어 문장과 그 한글 해석을 짝지어 담는다. 예문이 없으면 빈 배열.
- related: 유의어·반의어·파생어가 보이면 담는다. kind는 synonym(유의어)·antonym(반의어)·derivative(파생어) 중 하나, word는 그 단어, glossKo는 뜻이 함께 적혀 있으면 그 뜻(없으면 null). 없으면 빈 배열.

[판독 표시]
- partial: 단어 항목이 사진 밖으로 잘려 뜻·예문 일부가 안 보이면 true. 온전히 다 보이면 false.
- confidence: 글자가 선명하면 high, 일부만 읽히면 medium, 흐리거나 빛 반사로 거의 못 읽으면 low. 못 읽은 것을 읽은 척하지 않는다.

[페이지 정보]
- dayLabel: 페이지에 "DAY 01" 같은 단원 표기가 보이면 그대로 옮긴다. 안 보이면 null.
- isVocabPage: 단어장 페이지가 맞으면 true. 단어장이 아니거나 표제어를 하나도 읽을 수 없으면 false로 두고 entries를 빈 배열로 둔다.

[금지]
- 책에 없는 뜻·예문·발음을 지어내지 않는다. 안 보이면 null이나 빈 배열로 둔다.
- 영영 정의나 이모지는 이 단계에서 만들지 않는다 (다른 단계에서 만든다).
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.`;

/** 호출 C — 사용자 메시지의 텍스트 파트 (HARNESS §7-2) */
export const VOCAB_EXTRACT_USER_TEXT = "이 페이지의 단어들을 판독해줘.";

/**
 * 호출 C 파라미터 (HARNESS §7-1 표 · §1 공통 규칙).
 * 판독은 전사이므로 temperature 0 — 같은 사진은 같은 결과를 내야 한다.
 * 2단 밀집 지면의 20개 항목을 예문까지 담으려면 출력 한도가 표지 판독보다 넉넉해야 한다.
 */
export const VOCAB_EXTRACT_CALL_OPTIONS = {
  call: "vocab-extract",
  temperature: 0,
  maxOutputTokens: 6_000,
} as const;
