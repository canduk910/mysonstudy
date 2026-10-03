/**
 * scripts/eval-toeic-exam-screen.ts — **응시 화면 실전 모양**(시험 창 표현) 오프라인 검증 (docs/harness/toeic.md §17, SPEC §20-15) —
 * scripts/eval-toeic.ts가 부른다.
 *
 * 5묶음: ① 머리 띠·안내 제목(형식표 범위) ② 단계 → 화면 종류(상황 화면은 Q5 상황 소개를 읽는 동안만) ③ 타이머 상자(진행 중인 쪽만 줄고,
 * 준비가 끝나면 0, 종료 시각 없으면 원래 시간 — 숫자는 형식표) ④ hh:mm:ss 표기 ⑤ 소스 대조(표현 층만 바뀌었다 — 시작 탭·안전망·앱 띠 조작·번들 경계).
 * ⑥ 진행 멘트(§18 — "Begin preparing now." 등): 파트별 문구·단계 → 멘트·Q10 둘째 재생 앞에만 listen again·표 읽기 앞 준비 멘트·
 * 멘트 끝 → 시계 순서·프리페치 목록·상한·소스 대조(멘트에 질문 안전망 없음·비프는 답변 멘트 뒤).
 * 네트워크·스토어를 부르지 않는다. 문장은 파트 공식 유형명과 시험 진행 멘트뿐(교재·영상 문장 0).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOEIC_EXAM_PART_TYPE_EN,
  TOEIC_REC_TOAST_MS,
  toeicRecToastFor,
  formatToeicExamClock,
  toeicExamBandTitle,
  toeicExamDirectionsTitle,
  toeicExamPartRange,
  toeicExamScreenOf,
  toeicExamTimers,
} from "../lib/toeic-exam-screen";
import {
  TOEIC_ANSWER_CUE,
  TOEIC_CUE_LISTEN_AGAIN,
  TOEIC_CUE_PREPARE,
  TOEIC_MOCK_FORMAT,
  TOEIC_MOCK_PARTS,
  firstPhase,
  nextPhase,
  toeicCueCapMs,
  toeicCueTexts,
  toeicHoldForCue,
  toeicPartQuestions,
  toeicPhaseCue,
  toeicQuestionFormat,
  toeicStartAfterCue,
  type ToeicPhaseState,
} from "../lib/toeic-mock";
import type { GuideCheckResult } from "./eval-toeic-guides";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function runToeicExamScreenChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = (check: string, pass: boolean, detail = "") => results.push({ book: "응시 화면 실전 모양", check, pass, detail });

  // ── ① 머리 띠·안내 제목 ──
  const bands = TOEIC_MOCK_FORMAT.map((f) => toeicExamBandTitle(f.q));
  add(
    "E1 머리 띠: Q1–7·Q11은 \"Question n of 11\", Q8–10은 파트 내내 \"Questions 8-10 of 11\"",
    TOEIC_MOCK_FORMAT.every((f, i) =>
      f.part === "info" ? bands[i] === "Questions 8-10 of 11" : bands[i] === `Question ${f.q} of 11`,
    ),
    bands.join(" | "),
  );
  const full = TOEIC_MOCK_FORMAT.map((f) => f.q);
  const titles = TOEIC_MOCK_PARTS.map((p) => toeicExamDirectionsTitle(p, full));
  add(
    "E2 안내 제목(실전): 파트 범위 + 공식 유형명",
    eqJson(titles, [
      "Questions 1-2: Read a text aloud",
      "Questions 3-4: Describe a picture",
      "Questions 5-7: Respond to questions",
      "Questions 8-10: Respond to questions using information provided",
      "Question 11: Express an opinion",
    ]),
    titles.join(" | "),
  );
  add(
    "E3 안내 제목은 이번 응시의 문항 수 — 사진 1장 연습(Q3)은 단수, 다시 풀기 Q6·Q7은 그 범위",
    toeicExamDirectionsTitle("picture", [3]) === "Question 3: Describe a picture" &&
      toeicExamDirectionsTitle("respond", [6, 7]) === "Questions 6-7: Respond to questions" &&
      toeicExamDirectionsTitle("info", [1, 2]) === `Questions 8-10: ${TOEIC_EXAM_PART_TYPE_EN.info}`,
    toeicExamDirectionsTitle("picture", [3]),
  );
  add(
    "E4 시작 안내 목록 범위 = 형식표(파트 문항 처음–끝)",
    eqJson(TOEIC_MOCK_PARTS.map(toeicExamPartRange), ["Questions 1-2", "Questions 3-4", "Questions 5-7", "Questions 8-10", "Question 11"]),
  );

  // ── ② 단계 → 화면 종류 ──
  const sc = (phase: ToeicPhaseState["phase"], q: number | null, play: number, introPieces: number, speakingIndex: number, paused = false) =>
    toeicExamScreenOf({ phase, q, play }, { introPieces, speakingIndex, paused });
  add("E5 지시문 단계 → 안내 화면", sc("directions", 1, 0, 0, -1) === "directions" && sc("directions", 8, 0, 0, 3) === "directions");
  add(
    "E6 Q5 첫 질문 재생에서 상황 소개 조각을 읽는 동안(시작 전 -1 포함) → 상황 화면, 질문 조각부터 문제 화면",
    sc("question", 5, 0, 1, -1) === "situation" &&
      sc("question", 5, 0, 2, 1) === "situation" &&
      sc("question", 5, 0, 1, 1) === "question" &&
      sc("question", 5, 0, 2, 2) === "question",
  );
  add(
    "E7 상황 화면이 아닌 경우: 멈춤(안전망)·도입 없음·Q6·Q8 도입(정보 활용)·준비 단계",
    sc("question", 5, 0, 1, 0, true) === "question" &&
      sc("question", 5, 0, 0, -1) === "question" &&
      sc("question", 6, 0, 1, -1) === "question" &&
      sc("question", 8, 0, 1, 0) === "question" &&
      sc("prep", 5, 0, 1, -1) === "question" &&
      sc("reading", 8, 0, 0, -1) === "question",
  );

  // ── ③ 타이머 상자 ──
  const NOW = 1_000_000;
  const st = (q: number, phase: ToeicPhaseState["phase"], endsIn: number | null): ToeicPhaseState => ({
    index: 0,
    q,
    phase,
    play: 0,
    endsAt: endsIn === null ? null : NOW + endsIn,
  });
  const t = (q: number, phase: ToeicPhaseState["phase"], endsIn: number | null) =>
    toeicExamTimers(st(q, phase, endsIn), NOW).map((b) => `${b.label === "PREPARATION TIME" ? "P" : "R"}${b.ms}${b.running ? "*" : ""}`).join(",");
  add("E8 표 읽기(Q8 앞) → PREPARATION TIME 하나(읽기 시간, 줄어든다)", t(8, "reading", 12_000) === "P12000*" && t(8, "reading", null) === "P45000");
  add("E9 준비 → 준비만 줄고 답변은 원래 시간 · 종료 시각 없으면(마이크 다시 켜기 대기) 원래 시간", t(1, "prep", 30_000) === "P30000*,R45000" && t(1, "prep", null) === "P45000,R45000");
  add("E10 질문 듣기 → 둘 다 원래 시간(Q5 3/15 · Q11 45/60)", t(5, "question", null) === "P3000,R15000" && t(11, "question", null) === "P45000,R60000");
  add("E11 비프·답변(녹음 시작 전) → 준비 0 · 답변 원래 시간", t(3, "beep", null) === "P0,R30000" && t(3, "answer", null) === "P0,R30000");
  add("E12 답변(녹음 시작 뒤) → 답변만 줄어든다 · 지나면 0", t(7, "answer", 5_000) === "P0,R5000*" && t(7, "answer", -300) === "P0,R0*");
  add(
    "E12b 진행 중 상자는 형식표 시간을 넘지 않는다(시계를 막 세운 순간 '지금'이 한 틱 늦어도 00:00:16 안 됨 — QA P3-2)",
    t(5, "answer", 15_000 + 240) === "P0,R15000*" && t(1, "prep", 45_000 + 200) === "P45000*,R45000" && t(8, "reading", 45_000 + 249) === "P45000*" && formatToeicExamClock(15_000) === "00:00:15",
  );
  add("E13 안내·끝 단계 → 상자 없음", t(1, "directions", null) === "" && toeicExamTimers({ index: 11, q: null, phase: "done", play: 0, endsAt: null }, NOW).length === 0);
  add(
    "E14 원래 시간은 형식표에서(모든 문항 — 숫자를 다시 적지 않는다)",
    TOEIC_MOCK_FORMAT.every((f) => {
      const b = toeicExamTimers(st(f.q, "question", null), NOW);
      return b[0].ms === f.prepSec * 1000 && b[1].ms === f.answerSec * 1000 && toeicQuestionFormat(f.q) === f;
    }),
  );

  // ── ④ 표기 ──
  const clocks = [45_000, 60_000, 200, 0, -5, 3_725_000, Number.NaN, 44_001].map(formatToeicExamClock);
  add(
    "E15 hh:mm:ss — 초는 올림·음수·NaN은 0",
    eqJson(clocks, ["00:00:45", "00:01:00", "00:00:01", "00:00:00", "00:00:00", "01:02:05", "00:00:00", "00:00:45"]),
    clocks.join(" "),
  );

  // ── ⑤ 소스 대조 ──
  const take = codeOnly(read("components/toeic-take-view.tsx"));
  const rules = codeOnly(read("lib/toeic-exam-screen.ts"));
  const runtimeImports = [...rules.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  add("E16 lib/toeic-exam-screen: 값 import는 ./toeic-mock 하나(클라이언트 번들 — lib/ai·store·zod 없음)", eqJson(runtimeImports, ["./toeic-mock"]), runtimeImports.join(","));
  add(
    "E17 시작 안내는 실전 전체 응시만(scope full · 다시 풀기 아님) · CONTINUE와 앱 띠 \"시작\"이 start()를 탭으로 부른다",
    /const showTestDirections = scope === "full" && !retake;/.test(take) &&
      /onClick=\{showTestDirections \? \(\) => setTestDirections\(true\) : start\}/.test(take) &&
      /\{examBand\(null, start\)\}/.test(take) &&
      /onClick=\{start\}>\s*시작\s*<\/button>/.test(take),
  );
  const onItemAt = take.indexOf("onItem: (i) =>");
  const onItemBody = onItemAt < 0 ? "" : take.slice(onItemAt, take.indexOf("onEnd:", onItemAt));
  add(
    "E18 질문 큐 onItem은 표현(speakIdx)만 — 단계 전이·정지를 하지 않는다",
    onItemAt > 0 && /setSpeakIdx\(i\)/.test(onItemBody) && !/advance|setPause|enterRef|setPhase/.test(onItemBody),
  );
  add(
    "E19 안전망·조작이 앱 띠에 남았다: 질문 보기·다시 듣기·계속·이 문항 다시·다음 문항·마이크 다시 켜기·시간만·그만두기·메모·무음 알림·서버 보관 진단",
    /onClick=\{showQuestionText\}/.test(take) &&
      /onClick=\{replaySpeech\}/.test(take) &&
      /onClick=\{continueAfterDirections\}/.test(take) &&
      /onClick=\{retryQuestion\}/.test(take) &&
      /onClick=\{skipQuestion\}/.test(take) &&
      /data-testid="mic-reopen"/.test(take) &&
      /data-testid="mic-skip"/.test(take) &&
      /onClick=\{confirmQuit\}/.test(take) &&
      /setMemo\(/.test(take) &&
      /data-testid="silence-alert"/.test(take) &&
      /data-testid="rec-upload-diag"/.test(take),
  );
  add(
    "E20 시험 창의 타이머는 toeicExamTimers·formatToeicExamClock만(화면이 남은 시간을 따로 계산하지 않는다) · role=timer(aria-live 없음)",
    /const timers = st \? toeicExamTimers\(st, now\) : \[\];/.test(take) &&
      /formatToeicExamClock\(t\.ms\)/.test(take) &&
      /role="timer"/.test(take) &&
      !/remainingMs\(/.test(take),
  );
  add(
    "E21 전체 화면은 지원할 때만(마운트 뒤 판정) · 요청 실패는 삼킨다",
    /setFsSupported\(Boolean\(d\.fullscreenEnabled \|\| d\.webkitFullscreenEnabled\)\)/.test(take) &&
      /const fsButton = fsSupported && \(/.test(take) &&
      /\.catch\(\(\) => \{\}\)/.test(take),
  );
  // ── ⑥ 진행 멘트 (§18) ──
  const cueOf = (phase: ToeicPhaseState["phase"], q: number, play = 0) => toeicPhaseCue({ phase, q, play });
  add(
    "C1 답변 멘트(파트별): Q1–2 reading aloud · Q3–4 speaking · Q5–7 responding · Q8–10 responding · Q11 speaking",
    TOEIC_ANSWER_CUE.read === "Begin reading aloud now." &&
      TOEIC_ANSWER_CUE.picture === "Begin speaking now." &&
      TOEIC_ANSWER_CUE.respond === "Begin responding now." &&
      TOEIC_ANSWER_CUE.info === "Begin responding now." &&
      TOEIC_ANSWER_CUE.opinion === "Begin speaking now." &&
      TOEIC_CUE_PREPARE === "Begin preparing now." &&
      TOEIC_CUE_LISTEN_AGAIN === "Now, listen again." &&
      TOEIC_MOCK_FORMAT.every((f) => cueOf("beep", f.q) === TOEIC_ANSWER_CUE[f.part]),
  );
  add(
    "C2 단계 → 멘트: 모든 문항 준비 앞 \"Begin preparing now.\" · Q8 표 읽기 앞도 같은 멘트 · 지시문·첫 질문 재생·답변에는 없음",
    TOEIC_MOCK_FORMAT.every((f) => cueOf("prep", f.q) === TOEIC_CUE_PREPARE && cueOf("question", f.q, 0) === null && cueOf("directions", f.q) === null && cueOf("answer", f.q) === null) &&
      cueOf("reading", 8) === TOEIC_CUE_PREPARE &&
      toeicPhaseCue({ phase: "done", q: null, play: 0 }) === null,
  );
  // 실전 단계열을 끝까지 돌며 멘트를 모은다(상태 기계 그대로 — 멘트는 단계 진입 때 화면이 읽는다)
  const all = TOEIC_MOCK_FORMAT.map((f) => f.q);
  const seq: string[] = [];
  {
    let st = firstPhase(all, 0);
    for (let guard = 0; st.phase !== "done" && guard < 200; guard++) {
      const c = toeicPhaseCue(st);
      seq.push(`Q${st.q}:${st.phase}${st.play ? st.play : ""}${c ? `[${c}]` : ""}`);
      st = nextPhase(all, st, 0);
    }
  }
  const listen = seq.filter((x) => x.includes(TOEIC_CUE_LISTEN_AGAIN));
  add(
    "C3 \"Now, listen again.\"은 Q10 둘째 재생 앞 한 번뿐(실전 단계열 전체)",
    listen.length === 1 && listen[0] === `Q10:question1[${TOEIC_CUE_LISTEN_AGAIN}]`,
    listen.join(" | "),
  );
  const q8 = seq.filter((x) => x.startsWith("Q8:"));
  add(
    "C4 Q8 순서: 지시문 → [준비 멘트] 표 읽기 → 질문 → [준비 멘트] 준비 → [답변 멘트] 비프 → 답변",
    JSON.stringify(q8) ===
      JSON.stringify([
        "Q8:directions",
        `Q8:reading[${TOEIC_CUE_PREPARE}]`,
        "Q8:question",
        `Q8:prep[${TOEIC_CUE_PREPARE}]`,
        "Q8:beep[Begin responding now.]",
        "Q8:answer",
      ]),
    q8.join(" "),
  );
  add(
    "C5 실전 멘트 개수: 준비 멘트 12(문항 11 + 표 읽기) · 답변 멘트 11 · listen again 1",
    seq.filter((x) => x.includes(`[${TOEIC_CUE_PREPARE}]`)).length === 12 &&
      seq.filter((x) => x.includes(":beep[")).length === 11 &&
      listen.length === 1,
  );
  const held = toeicHoldForCue(nextPhase(all, { index: 0, q: 1, phase: "directions", play: 0, endsAt: null }, NOW));
  const started = toeicStartAfterCue(held, NOW + 1_700);
  const heldR = toeicHoldForCue({ index: 7, q: 8, phase: "reading", play: 0, endsAt: NOW + 45_000 });
  add(
    "C6 멘트 끝 → 시계: 멘트를 읽는 동안 준비·읽기 종료 시각 null(타이머 상자는 원래 시간) · 멘트가 끝난 시각 + 형식표 시간(멘트가 준비 시간을 깎지 않는다)",
    held.phase === "prep" &&
      held.endsAt === null &&
      toeicExamTimers(held, NOW).map((b) => b.ms).join(",") === "45000,45000" &&
      started.endsAt === NOW + 1_700 + 45_000 &&
      heldR.endsAt === null &&
      toeicStartAfterCue(heldR, NOW + 900).endsAt === NOW + 900 + 45_000 &&
      toeicStartAfterCue({ index: 0, q: 3, phase: "beep", play: 0, endsAt: null }, NOW).endsAt === null &&
      toeicStartAfterCue({ index: 0, q: 3, phase: "answer", play: 0, endsAt: null }, NOW).endsAt === null,
  );
  add(
    "C7 프리페치 목록: 실전 5문장(≤ 7) · 파트 연습은 그 파트 것만 · 사진 1장 연습은 둘",
    JSON.stringify(toeicCueTexts(all)) ===
      JSON.stringify([TOEIC_CUE_PREPARE, "Begin reading aloud now.", "Begin speaking now.", "Begin responding now.", TOEIC_CUE_LISTEN_AGAIN]) &&
      JSON.stringify(toeicCueTexts(toeicPartQuestions("info"))) === JSON.stringify([TOEIC_CUE_PREPARE, "Begin responding now.", TOEIC_CUE_LISTEN_AGAIN]) &&
      JSON.stringify(toeicCueTexts([3])) === JSON.stringify([TOEIC_CUE_PREPARE, "Begin speaking now."]) &&
      JSON.stringify(toeicCueTexts([])) === "[]",
    JSON.stringify(toeicCueTexts(all)),
  );
  add(
    "C8 멘트 상한: 문장 길이에 비례 · 실전 멘트 모두 2.5~5초 · 시간 배율 적용(0<k≤1) · 잘못된 배율은 1",
    toeicCueTexts(all).every((x) => toeicCueCapMs(x) >= 2500 && toeicCueCapMs(x) <= 5000) &&
      toeicCueCapMs("Begin reading aloud now.") > toeicCueCapMs("Begin speaking now.") &&
      toeicCueCapMs(TOEIC_CUE_PREPARE, 0.1) === Math.round(toeicCueCapMs(TOEIC_CUE_PREPARE) * 0.1) &&
      toeicCueCapMs(TOEIC_CUE_PREPARE, 0) === toeicCueCapMs(TOEIC_CUE_PREPARE) &&
      toeicCueCapMs(TOEIC_CUE_PREPARE, Number.NaN) === toeicCueCapMs(TOEIC_CUE_PREPARE) &&
      toeicCueCapMs(TOEIC_CUE_PREPARE, 3) === toeicCueCapMs(TOEIC_CUE_PREPARE),
  );
  const cueAt = take.indexOf("const playCue = useCallback(");
  const cueBody = cueAt < 0 ? "" : take.slice(cueAt, take.indexOf("[stopCue, stopSpeech]", cueAt));
  add(
    "C9 화면: 멘트는 speakQueue(en-US) 한 조각 · 상한 = toeicCueCapMs(text, 배율) · 끝/멈춤/상한 어느 쪽이든 then 한 번 · 질문 안전망(setPause·toeicSpeechOutcome) 없음 · 세대가 바뀌면 진행 안 함",
    cueAt > 0 &&
      /speakQueue\(\[\{ text, lang: TOEIC_DIRECTIONS_LANG \}\]/.test(cueBody) &&
      /toeicCueCapMs\(text, scaleRef\.current\)/.test(cueBody) &&
      /if \(settled\) return;\s*settled = true;/.test(cueBody) &&
      /if \(runRef\.current !== token\) return;/.test(cueBody) &&
      !/setPause|toeicSpeechOutcome/.test(cueBody),
  );
  const enterAt = take.indexOf("const enterPhase = useCallback(");
  const enterBody = enterAt < 0 ? "" : take.slice(enterAt, take.indexOf("enterRef.current = enterPhase", enterAt));
  const caseOf = (name: string) => {
    const a = enterBody.indexOf(`case "${name}"`);
    if (a < 0) return "";
    const b = enterBody.indexOf("case \"", a + 6);
    return enterBody.slice(a, b < 0 ? undefined : b);
  };
  add(
    "C10 화면 배선: 준비·표 읽기는 멘트 동안 시계 보류 → 멘트 끝에 시계(holdThenStart) · 비프와 비프 뒤 넘어가기는 답변 멘트 콜백 안 · 준비 단계에서 비프를 미리 예약하지 않는다 · 둘째 재생은 멘트 → 질문",
    /setPhase\(toeicHoldForCue\(st\)\)|const held = toeicHoldForCue\(st\);/.test(enterBody) &&
      /playCue\(toeicPhaseCue\(st\), token, \(\) => \{[\s\S]*?setPhase\(scaled\(toeicStartAfterCue\(held, t\), t\)\)/.test(enterBody) &&
      /holdThenStart\(\)/.test(caseOf("prep")) &&
      /holdThenStart\(\)/.test(caseOf("reading")) &&
      !/scheduleToeicBeep/.test(caseOf("prep")) &&
      /playCue\(toeicPhaseCue\(st\), token, \(\) => \{[\s\S]*scheduleToeicBeep[\s\S]*setTimeout\(\(\) => advance\(token\), BEEP_GAP_MS\)/.test(caseOf("beep")) &&
      /playCue\(toeicPhaseCue\(st\), token, \(\) => playSpeech\(pieces, token, "question"\)\)/.test(caseOf("question")),
  );
  add(
    "C11 화면: 단계 진입·그만두기·시작 실패에서 멘트를 걷고(stopSpeech + stopCue), 언마운트가 상한 타이머를 지우며, 시작 탭 프리페치 **맨 앞**에 toeicCueTexts(qs)(첫 응시 멘트 잘림 방지 — QA cues P3-1)",
    /stopSpeech\(\);\s*stopCue\(\);/.test(enterBody) &&
      /runRef\.current \+= 1;\s*stopSpeech\(\);\s*stopCue\(\);\s*cancelBeep\(\);/.test(take) &&
      /function abortStart\(message: string\) \{\s*runRef\.current \+= 1;\s*stopSpeech\(\);\s*stopCue\(\);/.test(take) &&
      /if \(cueTimerRef\.current !== null\) window\.clearTimeout\(cueTimerRef\.current\);\s*recordingRef\.current\?\.rec\.abort\(\);/.test(take) &&
      /const texts: string\[\] = \[\.\.\.toeicCueTexts\(qs\)\];/.test(take),
  );
  // ── ⑦ 녹음 끝 알림 (§18-8) ──
  const toast = (status: Parameters<typeof toeicRecToastFor>[0]["status"], o: Partial<{ paused: boolean; stale: boolean; last: boolean }> = {}) =>
    toeicRecToastFor({ q: 3, status, paused: false, stale: false, last: false, ...o });
  add(
    "R1 녹음됨 → \"✓ Q3 녹음 끝\"(ok) · 빈 녹음 → \"⚠ Q3 녹음이 저장되지 않았어요\"(warn)",
    JSON.stringify(toast("recorded")) === JSON.stringify({ kind: "ok", text: "✓ Q3 녹음 끝" }) &&
      JSON.stringify(toast("empty")) === JSON.stringify({ kind: "warn", text: "⚠ Q3 녹음이 저장되지 않았어요" }),
  );
  add(
    "R2 다른 안내가 이미 말하는 경우는 알림 없음: 소리 없음(무음)·녹음 시작 실패·중단·녹음 없이",
    (["silent", "failed", "interrupted", "nomic"] as const).every((x) => toast(x) === null),
  );
  add(
    "R3 일시정지 중·그만둔 뒤(세대 바뀜)·마지막 문항(바로 끝 화면) → 알림 없음",
    toast("recorded", { paused: true }) === null && toast("recorded", { stale: true }) === null && toast("recorded", { last: true }) === null && toast("empty", { last: true }) === null,
  );
  const finAt = take.indexOf("const finishAnswer = useCallback(");
  const finBody = finAt < 0 ? "" : take.slice(finAt, take.indexOf("[advance, finalizeDiag", finAt));
  add(
    "R4 화면: 알림은 1.5초(실제 시간) 뒤 저절로 사라짐 · 녹음 끝 처리에서 알림을 띄운 뒤 advance를 그대로 부른다(기다리지 않음) · 그만두기에서 걷음 · 탭을 가로채지 않음",
    TOEIC_REC_TOAST_MS === 1500 &&
      /showRecToast\(\s*toeicRecToastFor\(\{[\s\S]*?\}\),\s*\);\s*advance\(token\);/.test(finBody) &&
      /window\.setTimeout\(\(\) => \{[\s\S]*?\}, TOEIC_REC_TOAST_MS\)/.test(take) &&
      /cancelBeep\(\);\s*showRecToast\(null\);/.test(take) &&
      /\.recToast \{[\s\S]*?pointer-events: none;/.test(readFileSync(path.join(ROOT, "components/toeic-take-view.module.css"), "utf-8")),
  );
  return results;
}
