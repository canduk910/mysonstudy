/**
 * scripts/eval-toeic-exam-screen.ts — **응시 화면 실전 모양**(시험 창 표현) 오프라인 검증 (docs/harness/toeic.md §17, SPEC §20-15) —
 * scripts/eval-toeic.ts가 부른다.
 *
 * 5묶음: ① 머리 띠·안내 제목(형식표 범위) ② 단계 → 화면 종류(상황 화면은 Q5 상황 소개를 읽는 동안만) ③ 타이머 상자(진행 중인 쪽만 줄고,
 * 준비가 끝나면 0, 종료 시각 없으면 원래 시간 — 숫자는 형식표) ④ hh:mm:ss 표기 ⑤ 소스 대조(표현 층만 바뀌었다 — 시작 탭·안전망·앱 띠 조작·번들 경계).
 * 네트워크·스토어를 부르지 않는다. 문장은 파트 공식 유형명뿐(교재 문장 0).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOEIC_EXAM_PART_TYPE_EN,
  formatToeicExamClock,
  toeicExamBandTitle,
  toeicExamDirectionsTitle,
  toeicExamPartRange,
  toeicExamScreenOf,
  toeicExamTimers,
} from "../lib/toeic-exam-screen";
import { TOEIC_MOCK_FORMAT, TOEIC_MOCK_PARTS, toeicQuestionFormat, type ToeicPhaseState } from "../lib/toeic-mock";
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
  return results;
}
