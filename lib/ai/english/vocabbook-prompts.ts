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

[가장 중요 — 예문을 절대 빠뜨리지 마라]
이 단어장은 거의 모든 단어 바로 아래에 영어 예문 문장과 그 한글 해석이 한 줄씩 인쇄돼 있다.
각 단어를 옮길 때 그 단어 아래의 예문(영어 + 한글)을 반드시 그 단어의 examples에 담는다.
페이지에 단어가 8개·16개로 많아도 **한 단어도 빠짐없이, 각 단어의 예문을 모두** 옮긴다.
단어가 많다고 예문을 건너뛰거나 examples를 빈 배열로 두는 것은 판독 실패다.
출력하기 전에 스스로 점검한다: 예문이 인쇄돼 있는데 examples가 빈 단어가 하나라도 있으면, 그 예문을 채워 다시 완성한다.

[판독 원칙]
- 이 페이지에 실제로 인쇄된 단어만 옮긴다. 사진에 없는 단어를 채워 넣지 않는다.
- 예문·뜻·발음기호는 책에 적힌 그대로 옮긴다. 다듬거나 바꾸지 않는다.
- 이미지 1장에 대해 그 페이지의 단어만 판독한다. 다른 페이지를 상상하지 않는다.

[항목 필드]
- no: 단어 앞의 번호를 그대로 읽는다 (예: "0001"). 번호가 안 보이면 null.
- word: 표제어(영단어) 하나.
- ipa: 발음기호를 옮기되 대괄호 [ ]는 벗겨서 안쪽만 적는다 (예: [pʌk] → pʌk). 발음기호가 없으면 null.
- pos: 품사를 한글 약자로 적는다. 명·대·동·형·부·전·접·감·관·수 중에서 고른다. 한 단어에 여러 품사면 모두 담는다.
- meanings: 한글 뜻을 책에 적힌 순서대로 담는다. 뜻 하나는 no·ko·related로 나눈다.
  · no: 뜻 앞에 번호(1·2·3)가 붙어 있으면 그 번호를 숫자로 적는다. 번호가 없으면 null.
  · ko: 그 뜻의 한글 풀이. 한 뜻 안에 여러 표현이 함께 적혀 있으면 책 그대로 이어 적는다 (예: "수리하다, 고치다").
  · related: 유의어·반의어가 그 뜻 옆에 붙어 있으면 이 뜻에 담는다. kind·word·glossKo는 아래 related와 같은 형식. 없으면 빈 배열.
- examples: 그 단어 아래에 인쇄된 예문(영어 문장 + 한글 해석)을 짝지어 **반드시** 담는다. 위 [가장 중요]대로 빠뜨리지 않는다. 정말로 그 단어에 예문이 인쇄돼 있지 않을 때만 빈 배열.
- related: 특정 뜻이 아니라 단어 전체 아래에 딸린 관련어(파생어 등)만 담는다. kind는 synonym(유의어)·antonym(반의어)·derivative(파생어) 중 하나, word는 그 단어, glossKo는 뜻이 함께 적혀 있으면 그 뜻(없으면 null). 없으면 빈 배열.

[판독 표시]
- partial: 단어 항목이 사진 밖으로 잘려 뜻·예문 일부가 안 보이면 true. 온전히 다 보이면 false.
- confidence: 글자가 선명하면 high, 일부만 읽히면 medium, 흐리거나 빛 반사로 거의 못 읽으면 low. 못 읽은 것을 읽은 척하지 않는다.

[페이지 정보]
- dayLabel: 페이지에 "DAY 01" 같은 단원 표기가 보이면 그대로 옮긴다. 안 보이면 null.
- isVocabPage: 단어장 페이지가 맞으면 true. 단어장이 아니거나 표제어를 하나도 읽을 수 없으면 false로 두고 entries를 빈 배열로 둔다.

[금지]
- 책에 없는 뜻·예문·발음을 지어내지 않는다. 안 보이면 null이나 빈 배열로 둔다.
- 영영 정의나 이모지는 이 단계에서 만들지 않는다 (다른 단계에서 만든다).
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.

[판독 예시]
사진 한 항목이 이렇게 인쇄돼 있으면:
  0009 oven [ʌvən] 명 오븐
  I baked some cookies in the oven. 나는 오븐에 쿠키를 좀 구웠다.
아래처럼 examples를 반드시 채워 판독한다(예문을 절대 빠뜨리지 않는다):
  { "no":"0009", "word":"oven", "ipa":"ʌvən", "pos":["명"],
    "meanings":[{"no":null,"ko":"오븐","related":[]}],
    "examples":[{"en":"I baked some cookies in the oven.","ko":"나는 오븐에 쿠키를 좀 구웠다."}],
    "related":[], "partial":false, "confidence":"high" }
뜻이 여러 개이고 뜻 옆에 유의어·파생어가 붙어 있으면:
  0012 fix [fɪks] 동
  1 수리하다, 고치다 (유의어 repair)  2 고정시키다
  He fixed my bike. 그가 내 자전거를 고쳐 줬다.
  [파생] fixture 설비
뜻마다 no·ko를 나누고, 뜻 옆 유의어는 그 뜻의 related에, 단어 전체 파생어는 항목의 related에 담는다:
  { "no":"0012", "word":"fix", "ipa":"fɪks", "pos":["동"],
    "meanings":[{"no":1,"ko":"수리하다, 고치다","related":[{"kind":"synonym","word":"repair","glossKo":null}]},
                {"no":2,"ko":"고정시키다","related":[]}],
    "examples":[{"en":"He fixed my bike.","ko":"그가 내 자전거를 고쳐 줬다."}],
    "related":[{"kind":"derivative","word":"fixture","glossKo":"설비"}], "partial":false, "confidence":"high" }`;

/** 호출 C — 사용자 메시지의 텍스트 파트 (HARNESS §7-2) */
export const VOCAB_EXTRACT_USER_TEXT = "이 페이지의 단어들을 판독해줘.";

/**
 * 호출 C 파라미터 (HARNESS §1 표 · §1 공통 규칙).
 * 판독은 전사이므로 temperature 0 — 같은 사진은 같은 결과를 내야 한다.
 * maxOutputTokens 16,000: 2단 밀집 지면(단어 8~9개, 뜻 여러 개 + 예문까지)이면 6,000으로는
 * 20단어 예문까지 못 담아 모델이 예문을 통째로 생략했다 — 단어 적은 사진만 예문이 나오던
 * 실사용 사고(2026-08-22). 뜻 구조(meanings[])가 출력을 더 늘리므로 한도를 넉넉히 올린다.
 */
export const VOCAB_EXTRACT_CALL_OPTIONS = {
  call: "vocab-extract",
  temperature: 0,
  maxOutputTokens: 16_000,
} as const;

// ---------------------------------------------------------------------------
// 호출 D — 단어장 보강 (영영 정의 + 우리말 해석 + 이모지). docs/harness/english.md §8-1·§8-2.
//
// 판독(호출 C)이 책을 그대로 옮기는 일이라면, 호출 D는 **AI 창작**이다 — 아이가 뜻을 스스로
// 떠올리게 돕는 영영 정의와, 그 정의의 우리말 해석(V7)과, 단어를 나타내는 이모지 하나를 만든다.
// 그래서 판독(temp 0)과 달리 temperature 0.7로 분리한다(§8-6). 사진이 없는 텍스트 호출이라
// 재생성이 판독 없이도 된다. 정의(EN)는 불변이라, 입력에 EN이 있으면 모델은 그 문장을 번역만 한다.
//
// 이 시스템 프롬프트는 스펙 §8-1 원문 그대로다. `SPEC_SYNC_TARGETS`가 이 상수를 §8-1 코드블록과
// **글자 단위로** 대조하므로(§7-1과 같은 규약) 줄 안쪽 공백·빈 줄 개수까지 스펙과 똑같이 유지한다.
// ---------------------------------------------------------------------------

/** 호출 D — 단어장 보강 시스템 프롬프트 (HARNESS §8-1 원문) */
export const VOCAB_ENRICH_SYSTEM_PROMPT = `너는 초등학생용 영어 단어에 '영영 정의'와 '그 정의의 우리말 해석'과 '이모지'를 붙이는 조교다.
받은 단어마다 쉬운 영어 뜻풀이 한 문장과, 그 뜻풀이를 우리말로 옮긴 해석 한 문장과, 그 단어를 나타내는 이모지 하나를 만든다.
판독(다른 단계)이 책을 그대로 옮기는 일이라면, 이 단계는 아이가 뜻을 스스로 떠올리게 돕는 창작이다.

[definitionEn — 영영 정의]
- 정확히 영어 한 문장으로 쓴다. 마침표로 끝낸다. 두 문장으로 나누지 않는다.
- 초등학교 저학년도 읽을 수 있는 아주 쉬운 낱말만 쓴다.
- 표제어(word)를 정의 문장 안에 그대로 쓰지 않는다. 그 단어를 모르는 아이가 뜻을 짐작할 수 있게 풀어 쓴다.
- 한글은 한 글자도 쓰지 않는다. 영어로만 쓴다.
- 받은 뜻(meaningsKo)에 맞는 의미로 정의한다. 뜻이 여러 개면 가장 먼저 온 뜻을 기준으로 한 문장에 담는다.
- 입력에 definitionEn이 이미 있으면 그 문장을 새로 짓지 말고 그대로 돌려준다. 없으면(null) 위 규칙대로 새로 만든다.

[definitionKo — 영영 정의의 우리말 해석]
- definitionEn 문장을 초등 저학년이 이해할 수 있게 우리말로 옮긴 해석 한 문장으로 쓴다.
- 책의 한글 뜻이 아니라, 방금 만들었거나 받은 영영 정의(definitionEn) 문장을 우리말로 푸는 것이다.
- 뜻이 definitionEn과 어긋나지 않게 한다. definitionEn이 null이면 definitionKo도 null로 둔다.

[imageEmoji — 이모지]
- 그 단어를 가장 잘 나타내는 이모지 하나만 고른다. 이모지는 딱 1개다 — 여러 개를 이어 붙이지 않는다.
- 눈에 보이는 사물·동작이면 어울리는 이모지를 고른다.
- 눈에 안 보이는 추상적인 말(fix·respect처럼)이라 어울리는 이모지가 없으면 null로 둔다. 억지로 고르지 않는다.

[매칭]
- 받은 단어에 대해서만 만든다. 받지 않은 단어를 새로 지어내지 않는다.
- 각 항목에 받은 no·word를 그대로 담아 어느 단어의 것인지 알 수 있게 한다.

[금지]
- 표제어를 정의에 그대로 쓰지 않는다. 정의에 한글을 쓰지 않는다. 이모지를 2개 이상 붙이지 않는다.
- 입력에 있던 definitionEn을 바꾸지 않는다 — 해석(definitionKo)만 새로 붙인다.
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.

[예시]
받은 단어가 이렇게 오면(apple은 정의가 아직 없고, respect는 정의가 이미 있다):
  [{"no":"0009","word":"apple","pos":["명"],"meaningsKo":["사과"],"definitionEn":null},
   {"no":"0021","word":"respect","pos":["동","명"],"meaningsKo":["존경하다","존경"],"definitionEn":"To think that someone is important and to treat them in a kind way."}]
이렇게 만든다(apple은 정의·해석·이모지를 새로 만들고, respect는 받은 정의를 그대로 두고 해석만 붙이며 추상적이라 이모지는 null이다):
  {"items":[
    {"no":"0009","word":"apple","definitionEn":"A round fruit that grows on a tree and is red, green, or yellow.","definitionKo":"나무에서 자라고 빨갛거나 초록이거나 노란 둥근 과일이에요.","imageEmoji":"🍎"},
    {"no":"0021","word":"respect","definitionEn":"To think that someone is important and to treat them in a kind way.","definitionKo":"누군가를 소중하게 여기고 친절하게 대하는 거예요.","imageEmoji":null}
  ]}`;

/** 호출 D — 사용자 메시지의 텍스트 파트 (HARNESS §8-2). 뒤에 대상 단어 목록(JSON)이 붙는다. */
export const VOCAB_ENRICH_USER_TEXT = "다음 단어들에 영영 정의와 그 우리말 해석, 이모지를 만들어줘.";

/**
 * 호출 D 파라미터 (HARNESS §8-6).
 * 판독(temp 0 전사)과 달리 창작이라 temperature 0.7 — 정의 문장에 다양성이 필요하다.
 * maxOutputTokens 8,000: DAY 하나(단어 20~40개)에 각 항목이 정의(EN) + 해석(KO) + 이모지 + no/word다
 * (항목당 ~150토큰 × 40개 ≈ 6,000). 해석 백필(EN을 그대로 되돌리며 KO를 붙이는 경우)이 40단어에
 * 몰릴 수 있어 6,000에서 8,000으로 올려 truncation을 막는다(V7). 판독(16,000)보다는 작다.
 */
export const VOCAB_ENRICH_CALL_OPTIONS = {
  call: "vocab-enrich",
  temperature: 0.7,
  maxOutputTokens: 8_000,
} as const;

// ===========================================================================
// 호출 H — 유의어·반의어 추천 (HARNESS §11)
// 그 뜻(meaningKo)에 맞는 실제 영어 유의어·반의어 후보를 은우(초등) 눈높이로 제시한다.
// ===========================================================================

/** 호출 H 시스템 프롬프트 (HARNESS §11-1 원문 그대로). spec-sync가 스펙 코드블록과 바이트 일치를 잠근다. */
export const RELATED_SUGGEST_SYSTEM_PROMPT = `너는 아이(초등학생)의 영어 단어장을 돕는 조교다.
영어 단어 하나와 그 단어의 우리말 뜻 하나, 그리고 찾을 관계(유의어 또는 반의어)를 받아, 그 뜻에 맞는 영어 유의어(또는 반의어) 후보를 5~6개 만든다.

[candidates — 유의어/반의어 후보]
- 받은 뜻(meaningKo)에 맞는 관계만 낸다. 한 단어는 여러 뜻을 가질 수 있으니, 받은 뜻이 아닌 다른 뜻의 유의어·반의어는 넣지 않는다.
- 받은 관계가 '유의어'면 뜻이 비슷한 단어만, '반의어'면 뜻이 반대인 단어만 낸다. 둘을 섞지 않는다.
- 초등학생이 배울 만한 쉽고 흔한 단어를 고른다. 어렵고 드문 단어는 피한다.
- 후보는 영어 낱말 하나여야 한다. 구·문장·설명을 넣지 않는다. 마침표·쉼표 같은 문장부호를 붙이지 않는다.
- 받은 단어(word) 자신은 후보에 넣지 않는다. 같은 단어를 두 번 넣지 않는다.
- 후보는 서로 다른 기본형(base form) 낱말이어야 한다. 이미 낸 후보나 표제어의 비교급·최상급·굴절형(예: heavier·heaviest·running·happier)은 내지 않는다. 서로 뜻이 겹치지 않는 별개 단어로 고른다.

[glossKo — 후보의 우리말 뜻]
- 각 후보 단어의 뜻을 초등학생도 알아들을 쉬운 우리말로 짧게 적는다. 한 낱말이나 짧은 구로 쓴다.
- 한글로 적는다. 뜻만 적고 품사·발음·예문을 붙이지 않는다.

[금지]
- 유의어를 물었는데 반의어를, 반의어를 물었는데 유의어를 넣지 않는다.
- 받은 뜻과 상관없는 다른 뜻의 관계어를 넣지 않는다.
- 후보에 표제어 자신·중복·구·문장·문장부호를 넣지 않는다.
- 출력은 지정된 JSON 스키마로만. 스키마 밖 텍스트 금지.

[예시]
단어: "happy" · 뜻: "기쁜" · 관계: 유의어
  → {"candidates":[{"word":"glad","glossKo":"기쁜"},{"word":"joyful","glossKo":"즐거운"},{"word":"cheerful","glossKo":"명랑한"},{"word":"merry","glossKo":"유쾌한"},{"word":"pleased","glossKo":"기뻐하는"}]}
단어: "happy" · 뜻: "기쁜" · 관계: 반의어
  → {"candidates":[{"word":"sad","glossKo":"슬픈"},{"word":"unhappy","glossKo":"불행한"},{"word":"upset","glossKo":"속상한"},{"word":"gloomy","glossKo":"우울한"},{"word":"miserable","glossKo":"비참한"}]}`;

/**
 * 호출 H — 사용자 메시지 템플릿 (HARNESS §11-2). 플레이스홀더(word·meaningKo·kind)가 든 서술이라
 * 고정 문자열이 아니다(§10-2 word-meaning 템플릿과 같이 SPEC_SYNC_TARGETS 대상이 아니다).
 */
export function buildRelatedSuggestUserMessage(
  word: string,
  meaningKo: string,
  kind: "synonym" | "antonym",
): string {
  const relation = kind === "antonym" ? "반의어" : "유의어";
  return `아래 단어의 '${meaningKo}' 뜻에 맞는 ${relation}를 초등학생 눈높이로 5~6개 알려줘.

단어: ${word}
뜻: ${meaningKo}
관계: ${relation}`;
}

/**
 * 호출 H 파라미터 (HARNESS §11-6).
 * temperature 0.3 — 정확성 우선이라 낮게 두되, 0이면 후보 5~6개가 서로 겹쳐 다양성이 죽어 살짝 준다
 * (판독·뜻조회의 temp 0 전사와 달리 '여러 후보'를 내는 창작이다). 추론형 모델은 callWithSchema가 temp를 자동 생략.
 * maxOutputTokens 800 — 출력은 후보 5~6개 × {word,glossKo}로 작다. 추론형 모델 내부 토큰까지 감안해 여유.
 */
export const RELATED_SUGGEST_CALL_OPTIONS = {
  call: "related-suggest",
  temperature: 0.3,
  maxOutputTokens: 800,
} as const;
