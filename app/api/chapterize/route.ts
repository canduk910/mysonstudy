/**
 * POST /api/chapterize — 챕터 리더 만들기 (호출 F, docs/harness/english.md §9)
 *
 * 목차(sceneKind='toc')로 읽은 챕터 제목 + 유튜브 낭독 자막(transcript)이 둘 다 있는 책을
 * 챕터별 영어 원문(en)/우리말 해석(ko) 문장으로 나눠 book.chapters에 저장한다.
 * 이 결과는 챕터 리더 UI(components/chapter-reader.tsx)의 근거가 된다.
 *
 * 카드 생성(/api/card)과 **별개 경로**다 — 카드·책은 그대로 두고 챕터만 얹는다(재나누기 가능).
 * 그래서 챕터화 실패는 **비치명**이다: book/card는 손대지 않고 실패만 알린다. 챕터 제목·자막은
 * 이미 book에 저장돼 있으므로, 재나누기에 사진·영상을 다시 넣을 필요가 없다.
 *
 * 챕터 제목의 출처: 호출 A′(toc 모드)가 목차 사진을 읽어 만든 sceneDigest의 각 항목 labelKo다
 * (§2A-2 "챕터 제목은 labelKo에 그대로"). book.sceneDigest.map(s => s.labelKo)를 chapterTitles로 넘긴다.
 *
 * 응답 shape (qa-inspector 교차 검증용 — 빌드 리포트에도 명시):
 * - 200 { ok: true, bookId, chapterCount, matchedCount, truncated, droppedSentenceCount }
 * - 400 { ok: false, error: "invalid_input", messageKo, issues: {path, message}[] }   ← 본문 JSON 오류
 * - 400 { ok: false, error: "not_chapterizable", messageKo }                          ← 목차/자막이 아직 없음(먼저 준비해야 함)
 * - 404 { ok: false, error: "book_not_found", messageKo }
 * - 501 { ok: false, error: "no_api_key", messageKo }
 * - 500 { ok: false, error: "ai_failed", messageKo, retriable: true }                 ← 챕터화 재시도 소진(throw)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { chapterizeTranscript, isChapterizeError } from "@/lib/ai/client";
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
 * 챕터화 가능 조건 판정 — 목차 챕터 제목과 낭독 자막이 둘 다 있어야 한다.
 * 챕터 제목은 sceneKind='toc'인 sceneDigest의 labelKo에 들어 있다(§2A-2).
 * 조건이 안 맞으면 어떤 안내를 할지까지 정해 돌려준다(버튼은 가려져 있어야 정상이지만, 방어적으로).
 */
function collectChapterTitles(book: BookRecord):
  | { ok: true; titles: string[]; transcript: string }
  | { ok: false; messageKo: string } {
  // 버튼 노출(서버 페이지)과 **같은 정의**로 가른다 — 여기서만 세부 안내 문구를 고른다.
  if (!canChapterizeBook(book)) {
    const hasToc = book.sceneKind === "toc" && (book.sceneDigest?.length ?? 0) > 0;
    const hasTranscript = (book.transcript?.trim() ?? "") !== "";
    if (!hasToc && !hasTranscript) {
      return {
        ok: false,
        messageKo:
          "챕터로 나누려면 목차 사진과 유튜브 낭독 영상이 둘 다 필요해요. 목차를 찍어 읽고, 낭독 영상 주소를 넣어 카드를 만든 뒤 다시 눌러 주세요.",
      };
    }
    if (!hasToc) {
      return {
        ok: false,
        messageKo: "목차 사진을 먼저 읽어야 챕터로 나눌 수 있어요. 목차를 찍어 '목차로 읽기'로 등록해 주세요.",
      };
    }
    return {
      ok: false,
      messageKo: "유튜브 낭독 영상 자막이 있어야 챕터로 나눌 수 있어요. 낭독 영상 주소를 넣어 카드를 다시 만들어 주세요.",
    };
  }
  // canChapterizeBook 통과 → transcript·sceneDigest는 있다. 각 장면 labelKo가 영어 챕터 제목(§2A-2).
  const transcript = book.transcript!.trim();
  const titles = (book.sceneDigest ?? [])
    .map((scene) => scene.labelKo.trim())
    .filter((t) => t !== "");
  if (titles.length === 0) {
    return { ok: false, messageKo: "목차에서 챕터 제목을 읽지 못했어요. 목차 사진을 다시 찍어 읽어 주세요." };
  }
  return { ok: true, titles, transcript };
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
    // 목차·자막이 아직 없다 — 재시도한다고 달라지지 않는 준비 부족이므로 not_chapterizable(400)로 갈라 보낸다.
    return NextResponse.json(
      { ok: false, error: "not_chapterizable", messageKo: collected.messageKo },
      { status: 400 },
    );
  }

  // 호출 F — 자막을 챕터별 EN/KO 문장으로 나눈다. 저장되는 en은 groundChapters를 지나
  // 전부 자막 부분문자열임이 보장된다(§9-5). 실패 구분은 상태코드로 관통한다.
  let result;
  try {
    result = await chapterizeTranscript(collected.titles, collected.transcript);
  } catch (err) {
    // 목차·자막이 비었으면 chapterizeTranscript가 ChapterizeError("invalid_input")를 던진다.
    // 위 collectChapterTitles가 먼저 걸러 주지만, 뚫린 경우 여기가 마지막 관문이다(§9-6 계약).
    if (isChapterizeError(err) && err.code === "invalid_input") {
      console.error("[/api/chapterize] 입력 오류:", err.message);
      return NextResponse.json(
        {
          ok: false,
          error: "not_chapterizable",
          messageKo: "챕터로 나눌 목차·자막을 찾지 못했어요. 목차와 낭독 영상을 확인해 주세요.",
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
