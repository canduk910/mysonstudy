/**
 * POST /api/toeic/attempts/[id]/score — 모의고사 한 문항 AI 채점 (docs/harness/toeic.md §5-0~§5-4, 로드맵 T5)
 *
 * multipart `q`(문항 번호) + `audio`(녹음 — 화면이 16kHz mono WAV로 정규화한 것, 실패하면 원본) →
 *   1. 관문 T 전사(lib/toeic-transcribe.ts — language "en", **기대 문장을 prompt로 넣지 않는다**, req.signal 전달)
 *   2. 전사문 단어 2개 미만 → 호출 D 없이 0점 "답변이 인식되지 않았어요"(§5-0 3, 비용 절약)
 *   3. Q1–2 → 지문 대조 순수 함수(alignReadAloud + readProxyScore, §5-4) / Q3–11 → 호출 D(generateFeedback, 모의고사 expressionsUsed)
 *   4. 그 문항만 저장(updateToeicAttemptAnswer — 파일 mutate / Firestore 트랜잭션, 동시 채점 2개가 서로 덮지 않는다)하고 돌려준다.
 * 사용자가 결과 화면에서 **버튼을 눌러야** 돈다(§0-2 — 비용이 드는 경로를 자동으로 태우지 않는다). 녹음 원본은 저장하지 않는다.
 *
 * ── 비용 가드 ────────────────────────────────────────────────────────────────
 * - 이미 점수가 있는 문항은 AI를 부르지 않고 저장된 답을 돌려준다(reused — 연타·다른 탭 방어).
 * - 호출 D가 실패해도 **전사문은 먼저 저장**한다. 다시 누르면 전사를 건너뛰고 저장된 전사문으로 호출 D만 한다(transcriptSource
 *   "stored") — 이미 낸 전사 비용을 두 번 내지 않는다. 응시가 끝난 뒤 녹음은 바뀌지 않으므로 저장된 전사문이 곧 그 녹음의 전사다.
 *
 * 검사 순서: 400(형식)·413(크기) → 404(응시·문항) → 409(아직 안 닫힘·녹음 안 됨) → 200 reused(키 불필요) → 501(키 없음, AI 앞) → AI.
 *
 * 응답 shape (단일 정의처 `lib/toeic-attempt-contract.ts` ToeicScoreResponse):
 * - 200 { ok:true, q, answer, reused, transcriptSource:"new"|"stored"|"reused", noResponse }
 * - 400 { ok:false, error:"invalid_input", messageKo }            ← multipart 아님·q·audio 없음·받지 않는 형식·빈 파일
 * - 413 { ok:false, error:"audio_too_large", messageKo }          ← TOEIC_SCORE_AUDIO_MAX_BYTES(4MB) 초과
 * - 404 { ok:false, error:"attempt_not_found" | "question_not_found", messageKo }
 * - 409 { ok:false, error:"not_finished" | "not_recorded", messageKo }
 * - 501 { ok:false, error:"no_api_key", messageKo }
 * - 499 { ok:false, error:"client_closed", messageKo }            ← 클라이언트가 먼저 끊었다(전사도 멈췄다)
 * - 500 { ok:false, error:"transcribe_failed", messageKo, retriable:true }          ← 아무것도 저장 안 함
 * - 500 { ok:false, error:"ai_failed", messageKo, retriable:true, answer }          ← 전사문은 저장됨
 * - 500 { ok:false, error:"save_failed", messageKo, retriable:true }
 */

import { NextResponse } from "next/server";
import { generateFeedback } from "@/lib/ai/toeic/calls";
import { buildFeedbackInput } from "@/lib/ai/toeic/mock";
import type { ToeicAnswer } from "@/lib/ai/toeic/schemas";
import { getStore, type ToeicAnswerScorePatch } from "@/lib/store";
import {
  TOEIC_SCORE_AUDIO_MAX_BYTES,
  TOEIC_SCORE_FIELD_AUDIO,
  TOEIC_SCORE_FIELD_Q,
  isAcceptedToeicAudioType,
  toeicAudioBaseType,
  toeicAudioFileName,
  toeicAudioTypeFromName,
  type ToeicScoreResponse,
} from "@/lib/toeic-attempt-contract";
import { isToeicAttemptClosed, toeicAttemptQuestions } from "@/lib/toeic-attempt-rules";
import { TOEIC_QUESTION_COUNT, toeicQuestionFormat } from "@/lib/toeic-mock";
import { isRenderableToeicMock } from "@/lib/toeic-record";
import { alignReadAloud, isNoResponseTranscript, noResponseFeedback, readProxyScore } from "@/lib/toeic-score";
import { transcribeAnswer } from "@/lib/toeic-transcribe";

export const runtime = "nodejs";

function json(body: ToeicScoreResponse, status = 200) {
  return NextResponse.json(body, { status });
}

function bad(messageKo: string) {
  return json({ ok: false, error: "invalid_input", messageKo }, 400);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // ── 1. 형식 ──
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("녹음 업로드 형식(multipart)이 올바르지 않아요.");
  }
  const qRaw = form.get(TOEIC_SCORE_FIELD_Q);
  const q = typeof qRaw === "string" && /^\d{1,2}$/.test(qRaw.trim()) ? Number(qRaw.trim()) : NaN;
  if (!Number.isInteger(q) || q < 1 || q > TOEIC_QUESTION_COUNT) return bad(`문항 번호(q)는 1~${TOEIC_QUESTION_COUNT}이어야 해요.`);
  const audio = form.get(TOEIC_SCORE_FIELD_AUDIO);
  if (!(audio instanceof Blob)) return bad("녹음 파일(audio)이 없어요.");
  const fileName = typeof (audio as File).name === "string" ? (audio as File).name : "";
  const type = toeicAudioBaseType(audio.type) || toeicAudioTypeFromName(fileName);
  if (!isAcceptedToeicAudioType(type)) return bad("받지 않는 녹음 형식이에요(wav·mp4·m4a·webm만).");
  if (audio.size === 0) return bad("녹음 파일이 비어 있어요.");
  if (audio.size > TOEIC_SCORE_AUDIO_MAX_BYTES) {
    return json(
      { ok: false, error: "audio_too_large", messageKo: `녹음 파일이 너무 커요(최대 ${Math.round(TOEIC_SCORE_AUDIO_MAX_BYTES / 1024 / 1024)}MB).` },
      413,
    );
  }

  // ── 2. 응시·문항 ──
  const store = getStore();
  const attempt = await store.getToeicAttempt(id);
  if (!attempt) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
  if (!toeicAttemptQuestions(attempt.parts).includes(q)) {
    return json({ ok: false, error: "question_not_found", messageKo: `이 응시에는 Q${q}가 없어요.` }, 404);
  }
  if (!isToeicAttemptClosed(attempt)) {
    return json({ ok: false, error: "not_finished", messageKo: "아직 끝나지 않은 응시예요 — 응시를 마친 뒤 채점할 수 있어요." }, 409);
  }
  const answer = attempt.answers.find((a) => a.q === q);
  if (!answer || !answer.recorded) {
    return json({ ok: false, error: "not_recorded", messageKo: `Q${q}는 녹음되지 않아 채점할 수 없어요.` }, 409);
  }
  if (answer.score !== null) {
    return json({ ok: true, q, answer, reused: true, transcriptSource: "reused", noResponse: isNoResponseTranscript(answer.transcript) });
  }

  const mock = await store.getToeicMock(attempt.mockId);
  if (!mock || !isRenderableToeicMock(mock)) {
    return json({ ok: false, error: "question_not_found", messageKo: "이 응시의 모의고사 자료를 찾을 수 없어요." }, 404);
  }
  const f = toeicQuestionFormat(q);
  const passage = f.part === "read" ? (mock.parts.read?.items[f.slot]?.text ?? null) : null;
  if (f.part === "read" ? passage === null : buildFeedbackInput(mock, q, "") === null) {
    return json({ ok: false, error: "question_not_found", messageKo: `모의고사에 Q${q} 자료가 없어요.` }, 404);
  }

  // ── 3. 키(AI 앞) ──
  if (!process.env.OPENAI_API_KEY) {
    return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 AI 채점을 할 수 없어요. 녹음은 이 기기에 그대로 있어요." }, 501);
  }

  const nowIso = new Date().toISOString();

  // ── 4. 전사(관문 T) — 앞선 시도에서 저장된 전사문이 있으면 건너뛴다(비용 가드) ──
  let transcript: string;
  let transcriptSource: "new" | "stored";
  if (answer.transcript !== null) {
    transcript = answer.transcript;
    transcriptSource = "stored";
  } else {
    const baseName = toeicAudioFileName(type)!;
    const r = await transcribeAnswer({ bytes: await audio.arrayBuffer(), fileName: baseName, type }, req.signal);
    if (!r.ok) {
      if (r.error === "aborted") return json({ ok: false, error: "client_closed", messageKo: "요청이 취소됐어요." }, 499);
      if (r.error === "no_api_key") {
        return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 AI 채점을 할 수 없어요." }, 501);
      }
      return json(
        { ok: false, error: "transcribe_failed", messageKo: "녹음을 글로 옮기지 못했어요. 잠시 뒤 다시 시도해 주세요.", retriable: true },
        500,
      );
    }
    transcript = r.text;
    transcriptSource = "new";
  }

  const noResponse = isNoResponseTranscript(transcript);
  const save = async (patch: ToeicAnswerScorePatch): Promise<ToeicAnswer | null> => {
    const rec = await store.updateToeicAttemptAnswer(id, q, patch);
    return rec?.answers.find((a) => a.q === q) ?? null;
  };
  const saveFailed = () =>
    json({ ok: false, error: "save_failed", messageKo: "채점 결과를 저장하지 못했어요. 다시 시도해 주세요.", retriable: true }, 500);

  // ── 5a. Q1–2 — 지문 대조(AI 없음) ──
  if (f.part === "read") {
    const readDiff = alignReadAloud(passage!, transcript);
    const score = noResponse ? 0 : readProxyScore(readDiff.accuracy);
    try {
      const saved = await save({ transcript, readDiff, feedback: null, score, scoredAt: nowIso });
      if (!saved) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
      return json({ ok: true, q, answer: saved, reused: false, transcriptSource, noResponse });
    } catch (err) {
      console.error(`[/api/toeic/attempts/${id}/score] Q${q} 저장 실패:`, err);
      return saveFailed();
    }
  }

  // ── 5b. Q3–11 무응답 — 호출 D 없이 0점 ──
  if (noResponse) {
    try {
      const saved = await save({ transcript, readDiff: null, feedback: noResponseFeedback(), score: 0, scoredAt: nowIso });
      if (!saved) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
      return json({ ok: true, q, answer: saved, reused: false, transcriptSource, noResponse: true });
    } catch (err) {
      console.error(`[/api/toeic/attempts/${id}/score] Q${q} 저장 실패:`, err);
      return saveFailed();
    }
  }

  // ── 5c. Q3–11 — 전사문을 먼저 저장(호출 D 실패 대비) → 호출 D ──
  let transcriptOnly: ToeicAnswer | null = null;
  if (transcriptSource === "new") {
    try {
      transcriptOnly = await save({ transcript, readDiff: null, feedback: null, score: null, scoredAt: null });
      if (!transcriptOnly) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
    } catch (err) {
      console.error(`[/api/toeic/attempts/${id}/score] Q${q} 전사문 저장 실패:`, err);
      return saveFailed();
    }
  } else {
    transcriptOnly = answer;
  }

  const input = buildFeedbackInput(mock, q, transcript)!;
  let feedback;
  try {
    feedback = await generateFeedback(input);
  } catch (err) {
    if (req.signal.aborted) return json({ ok: false, error: "client_closed", messageKo: "요청이 취소됐어요." }, 499);
    console.error(`[/api/toeic/attempts/${id}/score] Q${q} 호출 D 실패:`, err instanceof Error ? err.message : err);
    return json(
      {
        ok: false,
        error: "ai_failed",
        messageKo: "피드백을 만들지 못했어요. 전사문은 저장했어요 — 다시 누르면 피드백만 다시 만들어요.",
        retriable: true,
        answer: transcriptOnly,
      },
      500,
    );
  }

  try {
    const saved = await save({ transcript, readDiff: null, feedback, score: feedback.score, scoredAt: nowIso });
    if (!saved) return json({ ok: false, error: "attempt_not_found", messageKo: "응시 기록을 찾을 수 없어요." }, 404);
    return json({ ok: true, q, answer: saved, reused: false, transcriptSource, noResponse: false });
  } catch (err) {
    console.error(`[/api/toeic/attempts/${id}/score] Q${q} 저장 실패:`, err);
    return saveFailed();
  }
}
