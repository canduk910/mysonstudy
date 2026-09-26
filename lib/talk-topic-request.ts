/**
 * lib/talk-topic-request.ts — 화면의 주제 선택(`TalkTopicRequest`) → 주제 스냅샷(`TalkTopic`) 해석 (서버 전용)
 * (docs/harness/english.md §12-1 입력 정리·§12-6 "연결과 같은 함수로 해석")
 *
 * 연결 라우트(`/api/english/talk/connect`)와 주제 일러스트 라우트(`/api/english/talk/scene`)가 **이 함수 하나**로 주제를 만든다 —
 * 두 곳이 따로 해석하면 선생님이 말하는 주제와 화면 그림의 주제가 어긋난다.
 *
 * - 프리셋: lib/talk-topics.ts에 있는 키만(없으면 400).
 * - 직접 입력: 줄바꿈·제어문자·따옴표·#·백틱 제거 후 1~30자(아니면 400 — 자르지 않는다).
 * - 단어장: 클라이언트는 id만 보낸다. 서버가 `getVocabBook(id)` + `isRenderableVocabBook`으로 404를 가르고, 책 순서로 최대 20개
 *   단어·첫 우리말 뜻을 스냅샷으로 뽑는다("모은 단어"도 같은 방식). 넘길 단어가 0개면 400.
 */

import { z } from "zod";
import { getStore } from "./store";
import { isRenderableVocabBook } from "./vocabbook-record";
import { isFirestoreDocId } from "./reorder-contract";
import { resolveCustomTalkTopic, resolvePresetTalkTopic, resolveVocabTalkTopic } from "./talk-session-config";
import type { TalkTopic } from "./ai/english/talk-schemas";
import type { TalkTopicRequest } from "./talk-contract";

/** 요청 본문의 주제 선택 zod — 모양만 본다(내용 정리는 resolve*가 한다). 길이는 넉넉한 방어선 */
export const talkTopicRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), key: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("custom"), text: z.string().max(400) }),
  z.object({ kind: z.literal("vocab"), vocabBookId: z.string().min(1).max(200) }),
]);

// 요청 계약 ↔ zod 양방향 묶기(한쪽 필드 이름만 바꾸면 컴파일 때 잡힌다 — app-patterns §2)
type TopicInput = z.infer<typeof talkTopicRequestSchema>;
const topicMatchesSchema: [TalkTopicRequest, TopicInput] extends [TopicInput, TalkTopicRequest] ? true : never = true;
void topicMatchesSchema;

export type ResolveTalkTopicResult =
  | { ok: true; topic: TalkTopic }
  | { ok: false; status: 400; error: "invalid_input"; messageKo: string }
  | { ok: false; status: 404; error: "vocab_not_found"; messageKo: string };

/** 주제 선택 → 스냅샷. 단어장은 스토어를 읽는다(서버 전용). */
export async function resolveTalkTopicRequest(req: TalkTopicRequest): Promise<ResolveTalkTopicResult> {
  if (req.kind === "preset") {
    const topic = resolvePresetTalkTopic(req.key);
    return topic ? { ok: true, topic } : { ok: false, status: 400, error: "invalid_input", messageKo: "모르는 주제예요. 주제를 다시 골라 주세요." };
  }
  if (req.kind === "custom") {
    const topic = resolveCustomTalkTopic(req.text);
    return topic
      ? { ok: true, topic }
      : { ok: false, status: 400, error: "invalid_input", messageKo: "주제는 1~30자로 적어 주세요(따옴표·# 같은 기호는 빼요)." };
  }
  // 단어장 — id 형식이 아니면 존재할 수 없는 문서다(스토어에 넘기지 않는다)
  if (!isFirestoreDocId(req.vocabBookId)) {
    return { ok: false, status: 404, error: "vocab_not_found", messageKo: "단어장을 찾지 못했어요." };
  }
  const book = await getStore().getVocabBook(req.vocabBookId);
  if (!book || !isRenderableVocabBook(book)) {
    return { ok: false, status: 404, error: "vocab_not_found", messageKo: "단어장을 찾지 못했어요. 지워졌을 수 있어요." };
  }
  const topic = resolveVocabTalkTopic(book);
  return topic
    ? { ok: true, topic }
    : { ok: false, status: 400, error: "invalid_input", messageKo: "이 단어장에는 대화에 쓸 단어가 없어요." };
}
