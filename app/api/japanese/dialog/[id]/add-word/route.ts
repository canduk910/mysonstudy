/**
 * POST /api/japanese/dialog/[id]/add-word — 대화 어휘를 "대화에서 모은 단어" 단어장에 담기 (J5, §7-5) — AI 없음.
 *
 * 해설의 `items[itemIndex]`를 collected(kind:"collected") 일본어 단어장에 append한다. **JLPT 단어장에는 절대 담지 않는다**
 * — 대상 단어장은 `getOrCreateJaCollectedVocabBook()`이 정하는 collected 정본뿐이라, 라우트가 JLPT id를 받을 여지가 없다.
 * **get-or-create 멱등**(§7-5) + 같은 kana 중복 방지. 매핑: JaDialogItem → JaVocabEntry(pos:[]·imageEmoji:null·level:null·meaningsKo:[meaningKo]).
 *
 * - 200 { ok:true, added, bookId, word } / 400 invalid_input / 404 not_found / 500 save_failed
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { JaVocabEntry } from "@/lib/ai/japanese/schemas";
import { normalizeJaVocabEntry } from "@/lib/ai/japanese/vocab";
import type { JaDialogAddWordResponse } from "@/lib/japanese-dialog-contract";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const bodySchema = z.object({ itemIndex: z.number().int().min(0) });

function json(body: JaDialogAddWordResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_input", messageKo: "요청 본문이 올바른 JSON이 아니에요." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ ok: false, error: "invalid_input", messageKo: "담을 어휘를 확인해 주세요." }, 400);
  }

  const dialog = await store.getJaDialog(id);
  if (!dialog) return json({ ok: false, error: "not_found", messageKo: "없는 대화예요." }, 404);

  const item = dialog.coaching?.items[parsed.data.itemIndex];
  if (!item) {
    return json({ ok: false, error: "invalid_input", messageKo: "그 어휘를 찾지 못했어요. 화면을 새로고침해 주세요." }, 400);
  }

  // JaDialogItem → JaVocabEntry (§7-5 매핑).
  // pos·level·호출 A가 붙이는 값(이모지·일일정의)은 대화에서 담은 단어에 없다 — 검증할 수 없는 값을
  // 지어내지 않는다(§2-4 원칙). **빠진 필드는 normalizeJaVocabEntry가 채운다** — 여기서 필드를 일일이
  // 나열하면 스키마에 필드가 늘 때마다 이 라우트가 컴파일 에러로 깨진다(실제로 imageEmoji·definitionJa·
  // definitionTokens 세 번 겪었다). 정규화 한 곳만 따라가게 둔다.
  const entry: JaVocabEntry = normalizeJaVocabEntry({
    word: item.word,
    kana: item.kana,
    wordTokens: item.wordTokens,
    pos: [],
    meaningsKo: [item.meaningKo],
    example: item.example,
  });

  try {
    // 대상은 collected 정본뿐 — JLPT 단어장에 닿을 경로가 없다(§7-5).
    const book = await store.getOrCreateJaCollectedVocabBook();
    const res = await store.appendJaVocabEntry(book.id, entry);
    if (!res.record) return json({ ok: false, error: "save_failed", messageKo: "담지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
    return json({ ok: true, added: res.appended, bookId: book.id, word: item.word });
  } catch (err) {
    console.error(`[/api/japanese/dialog/${id}/add-word] 담기 실패:`, err);
    return json({ ok: false, error: "save_failed", messageKo: "담지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}
