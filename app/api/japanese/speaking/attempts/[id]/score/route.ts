/**
 * POST /api/japanese/speaking/attempts/[id]/score — 말하기 모의고사 한 문항 AI 채점 (docs/harness/japanese.md §15-4·§15-5·§15-10-1)
 *
 * multipart `q` + `audio`(화면이 16kHz mono WAV로 정규화한 것, 실패하면 원본 — 필드 이름·형식·4MB 상한은 토익 계약 그대로) →
 *   1. 관문 T-ja 전사(lib/ja-speaking-transcribe.ts — `language: "ja"`, **기대 문장을 넣지 않는다**, req.signal 전달)
 *   2. Q1–2 → 지문 대조 순수 함수(alignJaReadAloud + jaReadProxyScore — AI 없음). 무응답(발화 글자 < 4)도 **기록만** 하고 점수 경로는 같다(§15-4-0 4)
 *   3. Q3–11 무응답 → 호출 F 없이 `score 0 · feedback null · noResponse true`(피드백을 지어내지 않는다 — 추정 수준 집계에 섞이지 않게)
 *   4. Q3–11 → 전사문을 **먼저 저장**(F 실패 대비) → 호출 F(generateJaSpeakingFeedback — 입력은 레코드에서, buildJaSpeakingFeedbackInput)
 *   5. 그 문항만 저장(store.updateJaSpeakingAttemptAnswer — 원자 단위, 동시 채점 2개가 서로 덮지 않는다)하고 돌려준다.
 * 사용자가 결과 화면에서 **버튼을 눌러야** 돈다. 올라온 오디오는 전사에만 쓰고 저장하지 않는다(녹음은 기기 전용 — §15-9-4).
 *
 * 비용 가드: 이미 점수가 있으면 AI 없이 저장된 답(reused) · F만 실패했으면 다시 누를 때 저장된 전사문으로 F만(transcriptSource "stored").
 * 검사 순서: 400(형식)·413(크기) → 404(응시·문항) → 409(아직 안 닫힘·녹음 안 됨) → 200 reused(키 불필요) → 501(키 없음, AI 앞) → AI.
 *
 * 응답 shape (lib/ja-speaking-contract.ts JaSpeakingScoreResponse):
 * - 200 { ok:true, q, answer, reused, transcriptSource:"new"|"stored"|"reused", noResponse }
 * - 400 invalid_input · 413 audio_too_large · 404 attempt_not_found|question_not_found · 409 not_finished|not_recorded · 501 no_api_key
 * - 499 client_closed · 500 transcribe_failed(retriable, 저장 없음) · ai_failed(retriable, answer = 전사문 저장된 문항) · save_failed(retriable)
 */

import { NextResponse } from "next/server";
import { generateJaSpeakingFeedback } from "@/lib/ai/client";
import { buildJaSpeakingFeedbackInput } from "@/lib/ai/japanese/speaking";
import { jaSpeakingQuestionFormat, JA_SPEAKING_QUESTION_COUNT } from "@/lib/ja-speaking";
import type { JaSpeakingScoreResponse } from "@/lib/ja-speaking-contract";
import type { JaSpeakingAnswer, JaSpeakingAnswerScorePatch } from "@/lib/ja-speaking-record";
import { isJaSpeakingAttemptClosed } from "@/lib/ja-speaking-record";
import { alignJaReadAloud, isJaNoResponseTranscript, jaReadProxyScore } from "@/lib/ja-speaking-score";
import { transcribeJaSpeakingAnswer } from "@/lib/ja-speaking-transcribe";
import { isRenderableJaSpeakingMock } from "@/lib/japanese-record";
import { getStore } from "@/lib/store";
import {
  TOEIC_SCORE_AUDIO_MAX_BYTES,
  TOEIC_SCORE_FIELD_AUDIO,
  TOEIC_SCORE_FIELD_Q,
  isAcceptedToeicAudioType,
  toeicAudioBaseType,
  toeicAudioFileName,
  toeicAudioTypeFromName,
} from "@/lib/toeic-attempt-contract";

export const runtime = "nodejs";

function json(body: JaSpeakingScoreResponse, status = 200) {
  return NextResponse.json(body, { status });
}
function bad(messageKo: string) {
  return json({ ok: false, error: "invalid_input", messageKo }, 400);
}
const NOT_FOUND_KO = "응시 기록을 찾을 수 없어요.";

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
  if (!Number.isInteger(q) || q < 1 || q > JA_SPEAKING_QUESTION_COUNT) return bad(`문항 번호(q)는 1~${JA_SPEAKING_QUESTION_COUNT}이어야 해요.`);
  const audio = form.get(TOEIC_SCORE_FIELD_AUDIO);
  if (!(audio instanceof Blob)) return bad("녹음 파일(audio)이 없어요.");
  const fileName = typeof (audio as File).name === "string" ? (audio as File).name : "";
  const type = toeicAudioBaseType(audio.type) || toeicAudioTypeFromName(fileName);
  if (!isAcceptedToeicAudioType(type)) return bad("받지 않는 녹음 형식이에요(wav·mp4·m4a·webm만).");
  if (audio.size === 0) return bad("녹음 파일이 비어 있어요.");
  if (audio.size > TOEIC_SCORE_AUDIO_MAX_BYTES) {
    return json({ ok: false, error: "audio_too_large", messageKo: `녹음 파일이 너무 커요(최대 ${Math.round(TOEIC_SCORE_AUDIO_MAX_BYTES / 1024 / 1024)}MB).` }, 413);
  }

  // ── 2. 응시·문항 ──
  const store = getStore();
  const attempt = await store.getJaSpeakingAttempt(id);
  if (!attempt) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_KO }, 404);
  if (!attempt.questions.includes(q)) return json({ ok: false, error: "question_not_found", messageKo: `이 응시에는 Q${q}가 없어요.` }, 404);
  if (!isJaSpeakingAttemptClosed(attempt)) {
    return json({ ok: false, error: "not_finished", messageKo: "아직 끝나지 않은 응시예요 — 응시를 마친 뒤 채점할 수 있어요." }, 409);
  }
  const answer = attempt.answers.find((a) => a.q === q);
  if (!answer || !answer.recorded) return json({ ok: false, error: "not_recorded", messageKo: `Q${q}는 녹음되지 않아 채점할 수 없어요.` }, 409);
  if (answer.score !== null) {
    return json({ ok: true, q, answer, reused: true, transcriptSource: "reused", noResponse: answer.noResponse });
  }

  const mock = await store.getJaSpeakingMock(attempt.mockId);
  if (!mock || !isRenderableJaSpeakingMock(mock)) return json({ ok: false, error: "question_not_found", messageKo: "이 응시의 모의고사 자료를 찾을 수 없어요." }, 404);
  const f = jaSpeakingQuestionFormat(q);
  const passageTokens = f.part === "read" ? (mock.parts.read?.items[f.slot]?.passage.tokens ?? null) : null;
  if (f.part === "read" ? passageTokens === null : buildJaSpeakingFeedbackInput(mock, q, "") === null) {
    return json({ ok: false, error: "question_not_found", messageKo: `모의고사에 Q${q} 자료가 없어요.` }, 404);
  }

  // ── 3. 키(AI 앞) ──
  if (!process.env.OPENAI_API_KEY) {
    return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 AI 채점을 할 수 없어요. 녹음은 이 기기에 그대로 있어요." }, 501);
  }
  const nowIso = new Date().toISOString();

  // ── 4. 전사(관문 T-ja) — 앞선 시도에서 저장된 전사문이 있으면 건너뛴다(비용 가드) ──
  let transcript: string;
  let transcriptSource: "new" | "stored";
  if (answer.transcript !== null) {
    transcript = answer.transcript;
    transcriptSource = "stored";
  } else {
    const r = await transcribeJaSpeakingAnswer({ bytes: await audio.arrayBuffer(), fileName: toeicAudioFileName(type)!, type }, req.signal);
    if (!r.ok) {
      if (r.error === "aborted") return json({ ok: false, error: "client_closed", messageKo: "요청이 취소됐어요." }, 499);
      if (r.error === "no_api_key") return json({ ok: false, error: "no_api_key", messageKo: "OpenAI API 키가 아직 설정되지 않아 AI 채점을 할 수 없어요." }, 501);
      return json({ ok: false, error: "transcribe_failed", messageKo: "녹음을 글로 옮기지 못했어요. 잠시 뒤 다시 시도해 주세요.", retriable: true }, 500);
    }
    transcript = r.text;
    transcriptSource = "new";
  }

  const noResponse = isJaNoResponseTranscript(transcript);
  const save = async (patch: JaSpeakingAnswerScorePatch): Promise<JaSpeakingAnswer | null> => {
    const rec = await store.updateJaSpeakingAttemptAnswer(id, q, patch);
    return rec?.answers.find((a) => a.q === q) ?? null;
  };
  const saveFailed = () => json({ ok: false, error: "save_failed", messageKo: "채점 결과를 저장하지 못했어요. 다시 시도해 주세요.", retriable: true }, 500);

  // ── 5a. Q1–2 — 지문 대조(AI 없음). 무응답은 표시만(점수 경로 같음 — 빈 전사면 정확도 0 → 0점) ──
  if (f.part === "read") {
    const readDiff = alignJaReadAloud(passageTokens!, transcript);
    try {
      const saved = await save({ transcript, readDiff, feedback: null, noResponse, score: jaReadProxyScore(readDiff.accuracy), scoredAt: nowIso });
      if (!saved) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_KO }, 404);
      return json({ ok: true, q, answer: saved, reused: false, transcriptSource, noResponse });
    } catch (err) {
      console.error(`[/api/japanese/speaking/attempts/${id}/score] Q${q} 저장 실패:`, err);
      return saveFailed();
    }
  }

  // ── 5b. Q3–11 무응답 — 호출 F 없이 0점 ──
  if (noResponse) {
    try {
      const saved = await save({ transcript, readDiff: null, feedback: null, noResponse: true, score: 0, scoredAt: nowIso });
      if (!saved) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_KO }, 404);
      return json({ ok: true, q, answer: saved, reused: false, transcriptSource, noResponse: true });
    } catch (err) {
      console.error(`[/api/japanese/speaking/attempts/${id}/score] Q${q} 저장 실패:`, err);
      return saveFailed();
    }
  }

  // ── 5c. Q3–11 — 전사문을 먼저 저장(호출 F 실패 대비) → 호출 F ──
  let transcriptOnly: JaSpeakingAnswer | null = answer;
  if (transcriptSource === "new") {
    try {
      transcriptOnly = await save({ transcript, readDiff: null, feedback: null, noResponse: false, score: null, scoredAt: null });
      if (!transcriptOnly) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_KO }, 404);
    } catch (err) {
      console.error(`[/api/japanese/speaking/attempts/${id}/score] Q${q} 전사문 저장 실패:`, err);
      return saveFailed();
    }
  }

  let feedback;
  try {
    feedback = await generateJaSpeakingFeedback(buildJaSpeakingFeedbackInput(mock, q, transcript)!);
  } catch (err) {
    if (req.signal.aborted) return json({ ok: false, error: "client_closed", messageKo: "요청이 취소됐어요." }, 499);
    console.error(`[/api/japanese/speaking/attempts/${id}/score] Q${q} 호출 F 실패:`, err instanceof Error ? err.message.slice(0, 300) : err);
    return json(
      { ok: false, error: "ai_failed", messageKo: "피드백을 만들지 못했어요. 전사문은 저장했어요 — 다시 누르면 피드백만 다시 만들어요.", retriable: true, answer: transcriptOnly },
      500,
    );
  }

  try {
    const saved = await save({ transcript, readDiff: null, feedback, noResponse: false, score: feedback.score, scoredAt: nowIso });
    if (!saved) return json({ ok: false, error: "attempt_not_found", messageKo: NOT_FOUND_KO }, 404);
    return json({ ok: true, q, answer: saved, reused: false, transcriptSource, noResponse: false });
  } catch (err) {
    console.error(`[/api/japanese/speaking/attempts/${id}/score] Q${q} 저장 실패:`, err);
    return saveFailed();
  }
}
