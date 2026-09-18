/**
 * POST /api/japanese/vocab — 검토한 JLPT 단어장 저장 (아빠의 일본어 J1, §8)
 *
 * 생성(`/generate`)은 저장하지 않는다. 사용자가 검토 화면에서 확정한 단어장을 여기서 저장한다.
 * **AI 호출 없음**(키가 없어도 저장은 되어야 한다 — /english/vocab 저장과 같은 정책). `kind:"jlpt"`는 서버가 붙인다
 * (대화에서 모은 collected와 구분, §7-5). 저장 계층(normalizeJaVocabBook)이 undefined를 마지막으로 조인다.
 *
 * 응답 shape (단일 정의처는 `lib/japanese-vocab-contract.ts`):
 * - 200 { ok:true, id }
 * - 400 { ok:false, error:"invalid_input", messageKo, issues }
 * - 500 { ok:false, error:"save_failed", messageKo }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  JLPT_LEVELS,
  JA_ENTRIES_MAX,
  JA_WORD_MAX,
  JA_KANA_MAX,
  type JaVocabEntry,
} from "@/lib/ai/japanese/schemas";
import { JA_TITLE_MAX, type JaVocabSaveResponse } from "@/lib/japanese-vocab-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

// 저장할 최대 단어 수 = 레벨당 상한 × 레벨 수(부분 성공이라 더 적을 수 있다). 넉넉한 방어선.
const ENTRIES_SAVE_MAX = JA_ENTRIES_MAX * JLPT_LEVELS.length;

// 후리가나 토큰(방어) — surface 필수, reading은 nullable. 값 손질은 store normalize가 마지막에 한다.
const jaTokenSchema = z.object({
  surface: z.string(),
  reading: z.string().nullable(),
});

// 단어 항목(방어 검증) — 화면이 생성 결과를 그대로 보내므로 관대하게 받되 핵심 형태는 지킨다. 깊은 조임은 store가.
const jaEntrySchema = z.object({
  word: z.string().trim().min(1, "표기가 비어 있어요").max(JA_WORD_MAX),
  kana: z.string().max(JA_KANA_MAX),
  wordTokens: z.array(jaTokenSchema),
  pos: z.array(z.string()),
  meaningsKo: z.array(z.string()),
  example: z.object({ ja: z.string(), ko: z.string(), tokens: z.array(jaTokenSchema) }),
  level: z.enum(JLPT_LEVELS).nullable(),
});

const bodySchema = z.object({
  titleKo: z.string().trim().min(1, "단어장 이름을 입력해 주세요").max(JA_TITLE_MAX, `이름은 최대 ${JA_TITLE_MAX}자예요`),
  topic: z.string().trim().max(60).nullable(),
  levels: z.array(z.enum(JLPT_LEVELS)),
  entries: z.array(jaEntrySchema).min(1, "저장할 단어가 없어요").max(ENTRIES_SAVE_MAX, "단어가 너무 많아요"),
  model: z.string().max(120),
});

function json(body: JaVocabSaveResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  const store = getStore();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "invalid_input",
        messageKo: "단어장을 저장할 수 없어요.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
      400,
    );
  }
  const { titleKo, topic, levels, model } = parsed.data;
  // zod가 형태를 검증했고, store의 normalizeJaVocabBook이 undefined를 마지막으로 조인다(영어 저장 규약).
  const entries = parsed.data.entries as JaVocabEntry[];

  try {
    const record = await store.createJaVocabBook({
      titleKo,
      kind: "jlpt", // 서버가 붙인다 — 대화에서 모은 collected와 섞지 않는다(§7-5)
      entries,
      levels,
      topic: topic && topic.length > 0 ? topic : null,
      model,
    });
    return json({ ok: true, id: record.id });
  } catch (err) {
    console.error("[/api/japanese/vocab] 저장 실패:", err);
    return json(
      { ok: false, error: "save_failed", messageKo: "단어장을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." },
      500,
    );
  }
}
