/**
 * POST /api/chapterize — 챕터 리더 만들기 (호출 F, docs/harness/english.md §9)
 *
 * **유튜브 낭독 자막(transcript)이 있는 책**을 챕터별 영어 원문(en)/우리말 해석(ko) 문장으로
 * 나눠 book.chapters에 저장한다. 목차(sceneKind='toc')가 있으면 챕터별로, 없으면 자막 전체를
 * "전체" 단일 챕터로 만든다(자막 필수, 목차 선택 — §9). 이 결과는 챕터 리더 UI의 근거가 된다.
 *
 * 카드 생성(/api/card)과 **별개 경로**다 — 카드·책은 그대로 두고 챕터만 얹는다(재나누기 가능).
 * 그래서 챕터화 실패는 **비치명**이다: book/card는 손대지 않고 실패만 알린다. 자막·목차는
 * 이미 book에 저장돼 있으므로, 재나누기에 사진·영상을 다시 넣을 필요가 없다.
 *
 * 챕터 제목의 출처(목차 있을 때): 호출 A′(toc 모드)가 목차 사진을 읽어 만든 sceneDigest의 각
 * 항목 labelKo다. labelKo는 영어 챕터 제목 그 자체가 아니라 **부모가 알아볼 이름**이다 — A′ 프롬프트가
 * 목차 모드 labelKo를 "3장: Pooh와 꿀단지"처럼 서수를 붙여 쓰라고 한다(§2A-1). 그래서 F에 넘기기 전에
 * `prepareChapterTitles`(schemas.ts, §9-2 "목차 제목 준비")로 서수 접두어를 떼고(번호는 챕터 리더 탭이
 * 따로 붙인다), 완전 중복을 거르고, 떼고 나서 겹치면 " (n)"을 붙이고("아침"·"아침 (2)" — 접두어를
 * 되살리지 않는다), 40개(CHAPTERIZE_MAX_CHAPTERS)를 넘으면 인접 제목을 순서대로 묶는다
 * — A′ 장면은 120개(MAX_SCENE_DIGEST_ITEMS)까지 오는데 F zod는 40개까지만 받아, 그대로 넘기면 목차가
 * 긴 책의 챕터화가 통째로 실패한다. 이렇게 준비한 제목은 챕터 리더가 표시할 때 하는 정리
 * (cleanChapterTitles)로 바뀌지 않는다. 목차가 없으면 빈 배열([])을 넘긴다.
 *
 * 응답 shape (qa-inspector 교차 검증용 — 빌드 리포트에도 명시):
 * - 200 { ok: true, bookId, chapterCount, matchedCount, truncated, droppedSentenceCount }
 * - 400 { ok: false, error: "invalid_input", messageKo, issues: {path, message}[] }   ← 본문 JSON 오류
 * - 400 { ok: false, error: "not_chapterizable", messageKo }                          ← 낭독 자막이 아직 없음(먼저 준비해야 함)
 * - 404 { ok: false, error: "book_not_found", messageKo }
 * - 501 { ok: false, error: "no_api_key", messageKo }
 * - 500 { ok: false, error: "ai_failed", messageKo, retriable: true }                 ← 챕터화 재시도 소진(throw)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { chapterizeTranscript, isChapterizeError } from "@/lib/ai/client";
import { prepareChapterTitles, type PreparedChapterTitles } from "@/lib/ai/english/schemas";
import { canChapterizeBook, getStore, type BookRecord } from "@/lib/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  bookId: z.string().trim().min(1).max(200),
});

function invalidInput(error?: z.ZodError) {
  return NextResponse.json(
    {
      ok: false,
      error: "invalid_input",
      messageKo: "요청 내용을 확인해 주세요.",
      issues:
        error?.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })) ?? [],
    },
    { status: 400 },
  );
}

function aiFailed() {
  return NextResponse.json(
    {
      ok: false,
      error: "ai_failed",
      messageKo: "챕터로 나누다가 문제가 생겼어요. 잠시 후 '다시 시도'를 눌러 주세요.",
      retriable: true, // SPEC §9 — 클라이언트는 재시도 버튼을 노출한다
    },
    { status: 500 },
  );
}

/**
 * 챕터 리더 입력 조립 — **낭독 자막(필수)** + 목차 챕터 제목(선택)을 모은다.
 * 목차(sceneKind='toc')가 있으면 각 장면 labelKo("3장: Pooh와 꿀단지" 모양, §2A-1)를
 * `prepareChapterTitles`로 F가 받을 수 있는 제목(서수 접두어 제거·중복 제거·겹침 " (n)"·40개 이하로 묶기)으로
 * 바꾼다. 없으면 빈 배열을 돌려주고, chapterizeTranscript가 자막 전체를 "전체" 단일 챕터로 만든다(§9).
 *
 * 버튼 노출(서버 페이지)과 **같은 정의**(canChapterizeBook = 자막 존재)로 가른다.
 */
function collectChapterTitles(book: BookRecord):
  | { ok: true; prepared: PreparedChapterTitles; transcript: string }
  | { ok: false; messageKo: string } {
  if (!canChapterizeBook(book)) {
    return {
      ok: false,
      messageKo:
        "낭독 자막이 있어야 챕터로 읽을 수 있어요. 유튜브 낭독 영상 주소를 넣어 카드를 만든 뒤 다시 눌러 주세요.",
    };
  }
  const transcript = book.transcript!.trim();
  // 목차가 있으면 챕터 제목 배열, 없으면 빈 배열([]) → 자막 전체가 "전체" 단일 챕터로 나뉜다.
  const prepared = prepareChapterTitles(
    book.sceneKind === "toc" ? (book.sceneDigest ?? []).map((scene) => scene.labelKo) : [],
  );
  return { ok: true, prepared, transcript };
}

export async function POST(req: Request) {
  // 키가 없으면 어떤 작업도 하지 않고 명시적으로 알린다 (/api/card·/api/pages와 동일 정책)
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_api_key",
        messageKo:
          "OpenAI API 키가 아직 설정되지 않았어요. .env.local에 OPENAI_API_KEY를 넣고 서버를 다시 켜 주세요.",
      },
      { status: 501 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return invalidInput();
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return invalidInput(parsed.error);

  const store = getStore();
  const book = await store.getBook(parsed.data.bookId);
  if (!book) {
    return NextResponse.json(
      { ok: false, error: "book_not_found", messageKo: "책 정보를 찾을 수 없어요. 서재에서 다시 열어 주세요." },
      { status: 404 },
    );
  }

  const collected = collectChapterTitles(book);
  if (!collected.ok) {
    // 낭독 자막이 아직 없다 — 재시도한다고 달라지지 않는 준비 부족이므로 not_chapterizable(400)로 갈라 보낸다.
    return NextResponse.json(
      { ok: false, error: "not_chapterizable", messageKo: collected.messageKo },
      { status: 400 },
    );
  }

  // 목차가 40개를 넘어 인접 제목을 묶었으면 로그로 남긴다 — 묶음 크기가 챕터 리더 탭 하나에 든 목차 수다.
  const { prepared } = collected;
  if (prepared.groupSize > 1) {
    console.warn(
      JSON.stringify({
        call: "chapterize",
        bookId: book.id,
        tocTitleCount: prepared.sourceCount,
        groupSize: prepared.groupSize,
        chapterTitleCount: prepared.titles.length,
      }),
    );
  }

  // 호출 F — 자막을 챕터별 EN/KO 문장으로 나눈다. 저장되는 en은 groundChapters를 지나
  // 전부 자막 부분문자열임이 보장된다(§9-5). 실패 구분은 상태코드로 관통한다.
  let result;
  try {
    result = await chapterizeTranscript(prepared.titles, collected.transcript);
  } catch (err) {
    // 자막이 비었으면 chapterizeTranscript가 ChapterizeError("invalid_input")를 던진다(목차 없음은 정상 — "전체" 단일 챕터).
    // 위 collectChapterTitles가 먼저 걸러 주지만, 뚫린 경우 여기가 마지막 관문이다(§9-6 계약).
    if (isChapterizeError(err) && err.code === "invalid_input") {
      console.error("[/api/chapterize] 입력 오류:", err.message);
      return NextResponse.json(
        {
          ok: false,
          error: "not_chapterizable",
          messageKo: "챕터로 읽을 낭독 자막을 찾지 못했어요. 낭독 영상을 확인해 주세요.",
        },
        { status: 400 },
      );
    }
    // 재요청 2회 실패(throw) — 재시도 가치가 있다(§9-6)
    console.error("[/api/chapterize] 챕터화 실패:", err);
    return aiFailed();
  }

  // 자막 밖 문장이 잘려 나갔으면(0이 정상) 로그로 남긴다 — 크면 프롬프트 이탈 신호(§9-5).
  if (result.droppedSentenceCount > 0) {
    console.warn(
      JSON.stringify({
        call: "chapterize",
        bookId: book.id,
        droppedSentenceCount: result.droppedSentenceCount,
        truncated: result.truncated,
      }),
    );
  }

  // 카드·책은 손대지 않고 챕터만 얹는다(비치명 경로). 재나누기면 이전 chapters를 덮어쓴다.
  await store.updateBookEvidence(book.id, { chapters: result.chapters });

  const matchedCount = result.chapters.filter((ch) => ch.matched).length;
  return NextResponse.json({
    ok: true,
    bookId: book.id,
    chapterCount: result.chapters.length,
    matchedCount,
    truncated: result.truncated,
    droppedSentenceCount: result.droppedSentenceCount,
  });
}
