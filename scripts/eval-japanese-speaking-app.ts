/**
 * scripts/eval-japanese-speaking-app.ts — 🎙️ 말하기 모의고사 **앱 층**(JS1~JS3) 오프라인 점검 조각 (docs/harness/japanese.md §15-9·§15-10·§15-11)
 *
 * `scripts/eval-japanese-speaking.ts`의 runJaSpeakingChecks가 불러 `eval:japanese` 한 번에 돈다. 실호출 0 · 네트워크 0 · 저장소 쓰기 0
 * (순수 함수와 소스 정적 대조만 — data/db.json을 건드리지 않는다).
 *
 * 보는 것: 관문 T-ja 무유도(`language: "ja"`·prompt 없음)·관문 P 공용 코어·라우트 검사 순서(키 501 위치·reused 먼저·req.signal)·
 * 두 백엔드 컬렉션 이름·prod-guard·원자 단위 판정/적용 반례·문항 화면 자료·응시 화면 프로필(토익 기본 = 바이트 불변 배선)·녹음 풀 "ja"·
 * 시험 경로·계약 파일 번들 경계·렌더 판정.
 */

import { readFileSync } from "node:fs";
import type { JaLine } from "../lib/ai/japanese/speaking-schemas";
import type { JaSpeakingCheckResult } from "./eval-japanese-speaking";
import { jaSpeakingQuestionPieces } from "../lib/ja-speaking";
import {
  JA_SPEAKING_EXAM_LABELS,
  buildJaSpeakingQuestionView,
  buildJaSpeakingQuestionViews,
  isCompleteJaSpeakingMock,
  nextJaSpeakingTitle,
} from "../lib/ja-speaking-contract";
import { toeicExamBandTitle, toeicExamDirectionsTitle } from "../lib/toeic-exam-screen";
import {
  applyJaSpeakingAnswer,
  applyJaSpeakingFillPart,
  applyJaSpeakingFinish,
  applyJaSpeakingPictureImage,
  decideJaSpeakingFillPart,
  decideJaSpeakingPictureImage,
  isJaSpeakingAttemptClosed,
  normalizeJaSpeakingAttemptRecord,
  normalizeJaSpeakingMockRecord,
  type JaSpeakingMockRecord,
} from "../lib/ja-speaking-record";
import { isRenderableJaSpeakingMock } from "../lib/japanese-record";
import { isPhraseHelperExamPath } from "../lib/phrase-helper-scope";
import { completeFinishAnswers, decideAttemptScope } from "../lib/toeic-attempt-rules";
import { isDeviceOnlyPool, toeicRecPoolOf } from "../lib/toeic-rec-store";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf-8");
/** 주석을 걷은 소스(문자열 안 //는 이 파일들에 URL이 없어 안전) */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

// 지어낸 일본어 픽스처(교재 없음)
const line = (ja: string, reading: string | null = null): JaLine => ({ ja, tokens: [{ surface: ja, reading }], ko: "뜻" });
function fixtureMock(): JaSpeakingMockRecord {
  return normalizeJaSpeakingMockRecord({
    id: "m1",
    titleKo: "말하기 모의고사 1",
    level: "N4",
    topicHints: [],
    parts: {
      read: { items: [{ kind: "news", passage: line("きょうは あめです。"), tipsKo: ["천천히", "또박또박"] }, { kind: "tour", passage: line("ここは こうえんです。"), tipsKo: ["a", "b"] }] },
      picture: {
        items: [0, 1].map((i) => ({
          place: `カフェ${i}`,
          imagePrompt: `A cafe scene ${i}`,
          sceneKo: "카페 장면",
          sampleAnswer: line("ひとが コーヒーを のんで います。"),
          keyPointsKo: ["사람", "커피", "창가"],
          image: { status: "pending", imageId: null },
        })),
      },
      respond: {
        topicKo: "주말",
        intro: line("しゅうまつに ついて はなします。"),
        questions: [0, 1, 2].map((i) => ({ question: line(`しつもん${i}ですか。`), sampleAnswer: line(`こたえ${i}です。`), tipKo: "팁" })),
      },
      info: {
        table: { kind: "schedule", title: "よてい", titleKo: "일정", meta: ["3がつ"], rows: [{ left: "9:00", right: "かいぎ" }], notes: [] },
        callerIntro: line("もしもし、たなかです。"),
        questions: [0, 1, 2].map((i) => ({ question: line(`なんじ${i}ですか。`), sampleAnswer: line(`${i}じです。`), tipKo: "팁" })),
      },
      opinion: { kind: "agree", question: line("どう おもいますか。"), sampleAnswer: line("わたしは さんせいです。"), outlineKo: ["입장", "이유", "예"], tipKo: "팁" },
    },
    model: "stub",
    createdAt: "2026-10-25T00:00:00.000Z",
    sortIndex: null,
  });
}

function hasUndefinedDeep(v: unknown): boolean {
  if (v === undefined) return true;
  if (Array.isArray(v)) return v.some(hasUndefinedDeep);
  if (v && typeof v === "object") return Object.values(v).some(hasUndefinedDeep);
  return false;
}

export function runJaSpeakingAppChecks(): JaSpeakingCheckResult[] {
  const results: JaSpeakingCheckResult[] = [];
  const push = (book: string, check: string, pass: boolean, detail = pass ? "OK" : "불일치") => results.push({ book, check, pass, detail });

  // ── 관문 T-ja(§15-8) — 무유도 전사 ──
  {
    const book = "앱 관문 T-ja";
    const t = code("lib/ja-speaking-transcribe.ts");
    push(book, "language = JA_SPEAKING_TRANSCRIBE_LANGUAGE(\"ja\") 고정", /JA_SPEAKING_TRANSCRIBE_LANGUAGE = "ja"/.test(t) && /language: JA_SPEAKING_TRANSCRIBE_LANGUAGE/.test(t));
    push(book, "prompt 필드·인자 없음(기대 문장을 넣지 않는다)", !/\bprompt\b/.test(t));
    push(book, "함수 인자는 (input, signal)뿐 · signal을 SDK에 넘긴다", /export async function transcribeJaSpeakingAnswer\(input: TranscribeAudioInput, signal\?: AbortSignal\)/.test(t) && /\{ signal \}/.test(t));
    push(book, "모델 = resolveToeicTranscribeModel(토익과 같은 env) · maxRetries 1 · 30초 · json", /resolveToeicTranscribeModel\(\)/.test(t) && /maxRetries: 1/.test(t) && /JA_SPEAKING_TRANSCRIBE_TIMEOUT_MS = 30_000/.test(t) && /response_format: "json"/.test(t));
    push(book, "키 없으면 네트워크 없이 no_api_key(클라이언트 만들기 전)", t.indexOf('error: "no_api_key"') > 0 && t.indexOf('error: "no_api_key"') < t.indexOf("getClient(apiKey)"));
    push(book, "로그에 전사문을 싣지 않는다(chars 수만)", /chars=\$\{countJaSpeechChars\(text\)\}/.test(t) && !/console\.\w+\([^)]*\$\{text\}/.test(t));
    push(book, "토익 관문 T는 그대로 en", /TOEIC_TRANSCRIBE_LANGUAGE = "en"/.test(code("lib/toeic-transcribe.ts")));
  }

  // ── 관문 P(§15-7) — 공용 코어 그대로 ──
  {
    const book = "앱 관문 P";
    const p = code("lib/ja-speaking-image.ts");
    push(
      book,
      "공용 코어 generateJpegImage + buildJaSpeakingImagePrompt + 태그 ja_speaking_scene + 토익 설정 상수(크기·압축 70→50·상한)",
      /generateJpegImage\(\{/.test(p) && /buildJaSpeakingImagePrompt\(imagePrompt\)/.test(p) && /"ja_speaking_scene"/.test(p) && /TOEIC_IMAGE_SIZE/.test(p) && /\[TOEIC_IMAGE_COMPRESSION, TOEIC_IMAGE_COMPRESSION_RETRY\]/.test(p) && /TOEIC_IMAGE_DATA_URL_MAX/.test(p),
    );
    const r = code("app/api/japanese/speaking/mocks/[id]/image/route.ts");
    push(book, "사진 라우트: 요청 신호를 넘기지 않고 서버 시간 상한만(AbortSignal.timeout) · ready면 키 없이 reused", /AbortSignal\.timeout\(IMAGE_JOB_TIMEOUT_MS\)/.test(r) && !/req\.signal/.test(r) && r.indexOf("reused: true") < r.indexOf("OPENAI_API_KEY"));
  }

  // ── 라우트 검사 순서 ──
  {
    const book = "앱 라우트";
    const create = code("app/api/japanese/speaking/mocks/route.ts");
    push(book, "만들기: 키 검사(501)가 맨 먼저(본문 읽기 앞) · 파트 병렬 allSettled · 전부 실패만 500(저장 안 함)", create.indexOf("OPENAI_API_KEY") < create.indexOf("req.json()") && /Promise\.allSettled\(chosen\.map\(\(part\) => generateJaSpeakingPart\(part/.test(create) && create.indexOf("createdParts.length === 0") < create.indexOf("createJaSpeakingMock("));
    push(book, "만들기: 주제는 normalizeJaSpeakingTopicHints 결과를 저장(보낸 것 = 저장)", /const topicHints = normalizeJaSpeakingTopicHints\(/.test(create) && /generateJaSpeakingPart\(part, \{ level, topicHints \}\)/.test(create) && /topicHints,\n\s*parts,/.test(create));
    push(book, "만들기: 모델은 메인 resolveModel(토익 출제 모델 아님)", /model: resolveModel\(\)/.test(create) && !/resolveToeicModel|OPENAI_TOEIC_MODEL/.test(create));
    const regen = code("app/api/japanese/speaking/mocks/[id]/regenerate/route.ts");
    push(book, "다시 만들기: part_exists(409) → 키(501) → 호출 E → 원자 단위 채우기(exists면 409)", regen.indexOf("part_exists") < regen.indexOf("OPENAI_API_KEY") && regen.indexOf("OPENAI_API_KEY") < regen.indexOf("generateJaSpeakingPart(") && /fillJaSpeakingMockPart\(id, part, value\)/.test(regen) && /level: mock\.level, topicHints: mock\.topicHints/.test(regen));
    const score = code("app/api/japanese/speaking/attempts/[id]/score/route.ts");
    const order = ['"question_not_found"', '"not_finished"', '"not_recorded"', 'reused: true', "OPENAI_API_KEY", "transcribeJaSpeakingAnswer("].map((x) => score.indexOf(x));
    push(book, "채점 검사 순서: 404 → 409 not_finished·not_recorded → 200 reused(키 불필요) → 501 → 전사", order.every((x, i) => x > 0 && (i === 0 || order[i - 1] < x)), order.join(","));
    push(book, "채점: 전사에 req.signal · 저장된 전사문이 있으면 전사 건너뜀(stored) · Q3–11 전사문 선저장 → 호출 F", /transcribeJaSpeakingAnswer\([^;]*req\.signal\)/.test(score) && /transcriptSource = "stored"/.test(score) && score.indexOf("feedback: null, noResponse: false, score: null, scoredAt: null") < score.indexOf("generateJaSpeakingFeedback("));
    push(book, "채점: Q1–2는 AI 없이 alignJaReadAloud + jaReadProxyScore(무응답은 표시만) · Q3–11 무응답은 F 없이 0점·feedback null", /alignJaReadAloud\(passageTokens!, transcript\)/.test(score) && /noResponse, score: jaReadProxyScore\(readDiff\.accuracy\)/.test(score) && /feedback: null, noResponse: true, score: 0/.test(score));
    push(book, "채점: 피드백 입력은 레코드에서(buildJaSpeakingFeedbackInput) — 화면이 보낸 글을 믿지 않는다", /generateJaSpeakingFeedback\(buildJaSpeakingFeedbackInput\(mock, q, transcript\)!\)/.test(score));
    const finish = code("app/api/japanese/speaking/attempts/[id]/finish/route.ts");
    push(book, "끝내기: 이미 닫힘 409 already_finished(recordedCount) · 범위 채우기 completeFinishAnswers · 원자 단위", /already_finished/.test(finish) && /completeFinishAnswers\(qs, parsed\.data\.answers\)/.test(finish) && /finishJaSpeakingAttempt\(id, \{/.test(finish));
    const all = [
      "app/api/japanese/speaking/mocks/route.ts",
      "app/api/japanese/speaking/mocks/[id]/route.ts",
      "app/api/japanese/speaking/mocks/[id]/rename/route.ts",
      "app/api/japanese/speaking/mocks/[id]/regenerate/route.ts",
      "app/api/japanese/speaking/mocks/[id]/image/route.ts",
      "app/api/japanese/speaking/mocks/[id]/attempts/route.ts",
      "app/api/japanese/speaking/mocks/reorder/route.ts",
      "app/api/japanese/speaking/images/[id]/route.ts",
      "app/api/japanese/speaking/attempts/[id]/finish/route.ts",
      "app/api/japanese/speaking/attempts/[id]/score/route.ts",
    ];
    const leak = all.filter((f) => /getToeic|createToeic|finishToeic|updateToeicAttempt|toeic-transcribe"|toeic-image"|generateFeedback|generateMockPart/.test(code(f)));
    push(book, "라우트 10개가 토익 컬렉션·토익 AI 진입 함수를 부르지 않는다", leak.length === 0, leak.join(", ") || "OK");
    const noKey = ["app/api/japanese/speaking/mocks/[id]/attempts/route.ts", "app/api/japanese/speaking/attempts/[id]/finish/route.ts", "app/api/japanese/speaking/mocks/[id]/rename/route.ts", "app/api/japanese/speaking/mocks/reorder/route.ts"].filter((f) => /OPENAI_API_KEY/.test(code(f)));
    push(book, "AI가 필요 없는 라우트(시작·끝·이름·순서)에는 키 검사가 없다", noKey.length === 0, noKey.join(", ") || "OK");
    push(book, "전부 runtime = nodejs", all.every((f) => /export const runtime = "nodejs";/.test(code(f))));
  }

  // ── 저장소 ──
  {
    const book = "앱 저장소";
    const file = code("lib/store.ts");
    const fs = code("lib/store-firestore.ts");
    push(book, "Firestore 컬렉션 셋 jaSpeakingMocks·jaSpeakingImages·jaSpeakingAttempts", ["jaSpeakingMocks", "jaSpeakingImages", "jaSpeakingAttempts"].every((c) => fs.includes(`collection("${c}")`)));
    push(book, "파일 DbShape·빈 db·readDb·시드 머지에 세 키", ["jaSpeakingMocks", "jaSpeakingImages", "jaSpeakingAttempts"].every((c) => (file.match(new RegExp(`\\b${c}\\b`, "g")) ?? []).length >= 4));
    push(book, "Firestore 삭제는 prod-guard deleteJaSpeakingMock · 가드 목록에 등록", /assertDestructiveAllowed\("deleteJaSpeakingMock"\)/.test(fs) && /\| "deleteJaSpeakingMock"/.test(code("lib/prod-guard.ts")));
    push(
      book,
      "두 백엔드가 같은 판정 함수(채우기·사진·닫힘·적용)를 원자 단위 안에서 부른다",
      ["decideJaSpeakingFillPart(", "decideJaSpeakingPictureImage(", "isJaSpeakingAttemptClosed(", "applyJaSpeakingFinish(", "applyJaSpeakingAnswer("].every((f) => file.includes(f) && fs.includes(f)) &&
        (fs.match(/runTransaction/g) ?? []).length >= 5,
    );
  }

  // ── 원자 단위 판정·적용(반례) ──
  {
    const book = "앱 판정";
    const m = fixtureMock();
    const empty = { ...m, parts: { ...m.parts, read: null } };
    push(book, "빈 파트만 채운다(있으면 exists)", decideJaSpeakingFillPart(m, "read") === "exists" && decideJaSpeakingFillPart(empty, "read") === "fill" && applyJaSpeakingFillPart(empty, "read", m.parts.read!).parts.read === m.parts.read);
    const prompt0 = m.parts.picture!.items[0].imagePrompt;
    const ready = applyJaSpeakingPictureImage(m, 0, { status: "ready", imageId: "img1" });
    push(
      book,
      "사진: pending=apply · ready=kept(먼저 준비된 사진이 이긴다) · 다른 장면=stale · 칸 없음=missing",
      decideJaSpeakingPictureImage(m, 0, prompt0) === "apply" &&
        decideJaSpeakingPictureImage(ready, 0, prompt0) === "kept" &&
        decideJaSpeakingPictureImage(m, 0, "other") === "stale" &&
        decideJaSpeakingPictureImage({ ...m, parts: { ...m.parts, picture: null } }, 0, prompt0) === "missing" &&
        ready.parts.picture!.items[1].image.status === "pending",
    );
    const att = normalizeJaSpeakingAttemptRecord({ id: "a1", mockId: "m1", scope: "part", parts: ["read"], questions: [1, 2], startedAt: "2026-10-25T00:00:00.000Z", finishedAt: null, answers: [] });
    const answers = completeFinishAnswers(att.questions, [{ q: 1, recorded: true, durationMs: 30_000 }]);
    const fin = applyJaSpeakingFinish(att, { finishedAt: "2026-10-25T00:10:00.000Z", answers });
    push(book, "끝내기 전 열림 · 끝내기가 범위 전부 채움(안 보낸 Q2 = recorded false) · 뒤엔 닫힘", !isJaSpeakingAttemptClosed(att) && fin.answers.length === 2 && fin.answers[1].recorded === false && fin.answers[1].durationMs === null && isJaSpeakingAttemptClosed(fin));
    const quit = applyJaSpeakingFinish(att, { finishedAt: null, answers: completeFinishAnswers(att.questions, []) });
    push(book, "그만둠(finishedAt null)도 닫힘(answers 채워짐) — 두 번째 끝내기는 already_closed", isJaSpeakingAttemptClosed(quit));
    const scored = applyJaSpeakingAnswer(fin, 1, { transcript: "きょうはあめです", readDiff: null, feedback: null, noResponse: false, score: 3, scoredAt: "x" });
    push(book, "채점 적용은 그 문항만(다른 문항 그대로)", scored.answers[0].score === 3 && scored.answers[1] === fin.answers[1]);
    const norm = normalizeJaSpeakingAttemptRecord({ id: "a", answers: [{ q: 3 }] });
    const normM = normalizeJaSpeakingMockRecord({ id: "m" });
    push(book, "정규화: 옛·손으로 넣은 문서도 undefined 없음(Firestore 거부 방어) · 빠진 파트는 null", !hasUndefinedDeep(norm) && !hasUndefinedDeep(normM) && normM.parts.opinion === null && norm.answers[0].transcript === null);
    push(book, "응시 범위 판정은 토익 순수 함수 그대로: 실전은 완전한 세트만 · 빠진 파트 → incomplete_mock", decideAttemptScope("full", ["read", "picture", "respond", "info", "opinion"], m.parts).ok && (decideAttemptScope("full", ["read", "picture", "respond", "info", "opinion"], empty.parts) as { reason?: string }).reason === "incomplete_mock");
  }

  // ── 문항 화면 자료·계약 ──
  {
    const book = "앱 화면 자료";
    const m = fixtureMock();
    const v5 = buildJaSpeakingQuestionView(m.parts, 5);
    const v6 = buildJaSpeakingQuestionView(m.parts, 6);
    const v8 = buildJaSpeakingQuestionView(m.parts, 8);
    push(book, "Q5 첫 재생 = 상황 소개 + 질문(jaSpeakingQuestionPieces와 같은 글)", v5.spokenIntro === m.parts.respond!.intro.ja && JSON.stringify(jaSpeakingQuestionPieces(m.parts, 5, 0)) === JSON.stringify([v5.spokenIntro, v5.question]));
    push(book, "Q6은 도입 없음 · Q8은 전화 건 사람 도입", v6.spokenIntro === null && v8.spokenIntro === m.parts.info!.callerIntro.ja && v8.intro === null && v8.table?.title === "よてい");
    const views = buildJaSpeakingQuestionViews(m.parts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    push(book, "11문항 전부 available · 지문 토큰·모범답변 토큰 실림 · 형식표 숫자", views.every((v) => v.available) && views[0].ja.passage !== null && views[2].ja.sampleAnswer !== null && views[10].maxScore === 5 && views[9].questionPlays === 2);
    push(book, "빠진 파트 → available false", !buildJaSpeakingQuestionView({ ...m.parts, opinion: null }, 11).available && !isCompleteJaSpeakingMock({ ...m.parts, opinion: null }) && isCompleteJaSpeakingMock(m.parts));
    push(book, "기본 제목 번호 = 가장 큰 n + 1", nextJaSpeakingTitle(["말하기 모의고사 2", "말하기 모의고사 7", "내 연습"]) === "말하기 모의고사 8" && nextJaSpeakingTitle([]) === "말하기 모의고사 1");
    push(book, "렌더 판정: 정상 true · 깨진 파트 false · null 파트는 정상", isRenderableJaSpeakingMock(m) && !isRenderableJaSpeakingMock({ ...m, parts: { ...m.parts, read: { items: [{}] } } as unknown as JaSpeakingMockRecord["parts"] }) && isRenderableJaSpeakingMock({ ...m, parts: { ...m.parts, info: null } }));
    const contract = read("lib/ja-speaking-contract.ts");
    const valueImports = [...contract.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((x) => x[1]);
    push(book, "계약 파일 번들 경계: 값 import는 ./ja-speaking뿐(lib/ai·store·zod는 type만)", valueImports.every((p) => p === "./ja-speaking"), valueImports.join(", "));
  }

  // ── 응시 화면 재사용(§15-10-3) ──
  {
    const book = "앱 응시 화면";
    const take = code("components/toeic-take-view.tsx");
    const locals = [
      "const TOEIC_DIRECTIONS_LANG = profile?.speechLang ?? TOEIC_DIRECTIONS_LANG_EN;",
      "const toeicPhaseCue = profile?.phaseCue ?? toeicPhaseCueEn;",
      "const toeicCueTexts = profile?.cueTexts ?? toeicCueTextsEn;",
      "const toeicPartDirections = profile?.directions ?? toeicPartDirectionsEn;",
      "const toeicImageUrl = profile?.imageUrl ?? toeicImageUrlEn;",
      "const toeicAttemptHref = profile?.resultHref ?? toeicAttemptHrefEn;",
      "const drainToeicRecUploads = serverUpload ? drainToeicRecUploadsEn : noDrain;",
    ];
    push(book, "프로필이 없으면 토익 lib의 그 함수·값 그대로(지역 이름 7개 — 읽는 글·미리 받는 글 바이트 불변)", locals.every((l) => take.includes(l)), locals.filter((l) => !take.includes(l)).join(" / ") || "OK");
    push(
      book,
      "토익 경로의 질문 조각·미리 받기 식은 그대로(프로필 없을 때)",
      take.includes(": [...(st.play === 0 ? enPieces(v.spokenIntro) : []), ...enPieces(v.question)]") &&
        take.includes("else texts.push(...enPieces(v.spokenIntro).map((p) => p.text), ...enPieces(v.question).map((p) => p.text));") &&
        /function enPieces\(text: string \| null, lang: string = TOEIC_DIRECTIONS_LANG_EN\)/.test(take),
    );
    push(book, "공통 코어는 프로필 밖: usePhraseHelperBlock·toeicSpeechOutcome·createMicKeeper·toeicMicGate가 조건 없이 그대로", /usePhraseHelperBlock\(\);/.test(take) && /toeicSpeechOutcome\(kind, reason, sounded, pieces\.length\)/.test(take) && /createMicKeeper\(\)/.test(take) && (take.match(/toeicMicGate\(/g) ?? []).length === 2);
    const toeicPage = code("app/toeic/mocks/[id]/take/page.tsx");
    push(book, "토익 응시 페이지는 프로필을 넘기지 않는다(기본 = 토익)", !/profile=/.test(toeicPage) && /<ToeicTakeView/.test(toeicPage));
    const ja = code("components/ja-speaking-take-view.tsx");
    push(
      book,
      "일본어 프로필: ja-JP · 일본어 지시문/멘트/질문 조각 · 일본어 라우트 · 서버 업로드 끔 · 시작 안내 끔 · 풀 \"ja\"",
      /speechLang: JA_SPEAKING_SPEECH_LANG/.test(ja) &&
        /jaSpeakingPartDirections\(part, count\)/.test(ja) &&
        /phaseCue: jaSpeakingPhaseCue/.test(ja) &&
        /cueTexts: jaSpeakingCueTexts/.test(ja) &&
        /jaSpeakingQuestionPieces\(speechParts, view\.q, play\)/.test(ja) &&
        /attemptsHref: jaSpeakingAttemptsApi/.test(ja) &&
        /finishHref: jaSpeakingFinishApi/.test(ja) &&
        /serverUpload: false/.test(ja) &&
        /testDirections: false/.test(ja) &&
        /recPool="ja"/.test(ja) &&
        /<ToeicTakeView/.test(ja) &&
        !/\/api\/toeic/.test(ja),
    );
    push(book, "녹음 풀 \"ja\" = 기기 전용(업로드 대기열·내 녹음 목록 제외)", toeicRecPoolOf({ pool: "ja" }) === "ja" && isDeviceOnlyPool({ pool: "ja" }));
    push(book, "응시 경로는 시험 화면(표현 도우미·상단 스트릭 숨김) · 결과·학습 보기는 아니다", isPhraseHelperExamPath("/japanese/speaking/m1/take") && !isPhraseHelperExamPath("/japanese/speaking/m1") && !isPhraseHelperExamPath("/japanese/speaking/attempts/a1"));
    const result = code("components/ja-speaking-attempt-view.tsx");
    push(book, "결과 화면: 녹음은 이 기기(listToeicRecordings) · 채점은 버튼 뒤 · 동시 2개(TOEIC_SCORE_CONCURRENCY) · 기기에 없으면 막고 이유", /listToeicRecordings\(attemptId\)/.test(result) && /onClick=\{\(\) => void runScoring\(\)\}/.test(result) && /TOEIC_SCORE_CONCURRENCY/.test(result) && /응시한 기기에만 있어요/.test(result) && !/useEffect\([^)]*runScoring/.test(result));
    // 시험 창 화면 글자(examLabels) — 토익 기본값은 영어 그대로, 일본어 프로필은 일본어
    push(
      book,
      "시험 창 글자: 프로필이 없으면 토익 영어 그대로(문항 제목·지시문 제목 lib 함수 · Directions:·CONTINUE·VOLUME·타이머 원문)",
      take.includes("const toeicExamBandTitle = profile?.examLabels.bandTitle ?? toeicExamBandTitleEn;") &&
        take.includes("const toeicExamDirectionsTitle = profile?.examLabels.directionsTitle ?? toeicExamDirectionsTitleEn;") &&
        take.includes('{profile?.examLabels.directionsLabel ?? "Directions:"}') &&
        take.includes('{profile?.examLabels.continueLabel ?? "CONTINUE"}') &&
        (take.match(/profile\?\.examLabels\.volumeLabel \?\? "VOLUME"/g) ?? []).length === 2 &&
        take.includes("(profile ? profile.examLabels.timerLabel(label) : label)") &&
        toeicExamBandTitle(3) === "Question 3 of 11" &&
        /^Questions 1-2: /.test(toeicExamDirectionsTitle("read", [1, 2])),
    );
    const L = JA_SPEAKING_EXAM_LABELS;
    push(
      book,
      "시험 창 글자(일본어): 問題 3 / 11 · 問題 8–10 / 11 · 問題 1–2：音読 · 사진 1장 問題 3：写真描写 · 指示：· 次へ · 音量 · 準備時間/回答時間 · 프로필에 연결",
      L.bandTitle(3) === "問題 3 / 11" &&
        L.bandTitle(9) === "問題 8–10 / 11" &&
        L.directionsTitle("read", [1, 2]) === "問題 1–2：音読" &&
        L.directionsTitle("picture", [3]) === "問題 3：写真描写" &&
        L.directionsLabel === "指示：" &&
        L.continueLabel === "次へ" &&
        L.volumeLabel === "音量" &&
        L.timerLabel("PREPARATION TIME") === "準備時間" &&
        L.timerLabel("RESPONSE TIME") === "回答時間" &&
        /examLabels: JA_SPEAKING_EXAM_LABELS/.test(ja),
    );
    const detail = code("components/ja-speaking-detail-view.tsx");
    push(book, "학습 보기: 사진은 pending 칸만 자동 요청(같은 장면 한 번) · 빈 파트 만들기는 버튼", /it\.image\.status !== "pending" \|\| autoRequested\.current\.has\(key\)/.test(detail) && /onClick=\{\(\) => void regeneratePart\(part\)\}/.test(detail));
  }

  return results;
}
