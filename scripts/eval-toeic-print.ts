/**
 * 결과(첨삭) 화면 인쇄 — 인쇄할 항목 고르기 오프라인 점검(docs/harness/toeic.md §16-10). 실호출 0·네트워크 0·DB 0.
 * `eval-toeic.ts`가 불러 한 번에 돈다.
 *
 * ① 순수 모듈(lib/toeic-print-sections): 기억 값 파싱(없음·깨짐·모르는 키·중복 → 안전), 직렬화 순서, 켜기·끄기, 루트 속성, 묶음 건너뛰기 판정, 안내 문구
 * ② 소스 대조: 결과 화면이 여섯 묶음에 data-print-sec를 달고(모범답변은 접기 자체), 루트에 toeicPrintOmitAttrs를 펴며, 체크박스는 인쇄에서 숨는
 *    버튼 줄 안에 있다. 모듈 CSS가 여섯 묶음 모두를 `@media print` 안에서만 숨긴다(화면 영향 0). 펼치기 훅이 뺀 묶음의 접기를 건너뛴다.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOEIC_PRINT_SECTIONS,
  TOEIC_PRINT_SECTION_KO,
  parseToeicPrintOmit,
  serializeToeicPrintOmit,
  toeicPrintOmitAttrs,
  toeicPrintPickSummaryKo,
  toggleToeicPrintOmit,
} from "../lib/toeic-print-sections";
import type { GuideCheckResult } from "./eval-toeic-guides";

const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

export function runToeicPrintChecks(): GuideCheckResult[] {
  const results: GuideCheckResult[] = [];
  const add = (check: string, pass: boolean, detail = "") => results.push({ book: "인쇄 항목", check, pass, detail });

  // ① 순수 모듈
  add("항목 6개 = 전사·잘한 점·고칠 문장·빠진 내용·개선 답변·모범답변", eqJson(TOEIC_PRINT_SECTIONS.map((k) => TOEIC_PRINT_SECTION_KO[k]), ["전사", "잘한 점", "고칠 문장", "빠진 내용", "개선 답변", "모범답변"]));
  add("기억 없음(null·빈 문자열) → 전부 켬", eqJson(parseToeicPrintOmit(null), []) && eqJson(parseToeicPrintOmit(""), []) && eqJson(parseToeicPrintOmit(undefined), []));
  add("깨진 값(JSON 아님·객체·숫자) → 전부 켬", ["{", '{"fixes":true}', "3", "null", '"fixes"'].every((r) => eqJson(parseToeicPrintOmit(r), [])));
  add("모르는 키·중복·문자열 아닌 것 버림, 정의 순서", eqJson(parseToeicPrintOmit('["model","x",1,"fixes","model",null]'), ["fixes", "model"]));
  add("직렬화 → 다시 읽기 왕복(정의 순서)", eqJson(parseToeicPrintOmit(serializeToeicPrintOmit(["model", "transcript"])), ["transcript", "model"]) && serializeToeicPrintOmit(["model", "transcript"]) === '["transcript","model"]');
  add("끄기·켜기(새 목록, 중복 없음)", eqJson(toggleToeicPrintOmit([], "fixes", false), ["fixes"]) && eqJson(toggleToeicPrintOmit(["fixes"], "fixes", false), ["fixes"]) && eqJson(toggleToeicPrintOmit(["fixes", "model"], "fixes", true), ["model"]));
  add("루트 속성 = data-print-omit-{key}", eqJson(toeicPrintOmitAttrs(["fixes", "model"]), { "data-print-omit-fixes": "", "data-print-omit-model": "" }) && eqJson(toeicPrintOmitAttrs([]), {}));
  add(
    "안내 문구 — 전부·일부·없음(문제·점수만)",
    toeicPrintPickSummaryKo([]) === "모든 항목을 인쇄해요." &&
      toeicPrintPickSummaryKo(["fixes", "model"]) === "4개 항목만 인쇄해요(문제·점수는 언제나)." &&
      toeicPrintPickSummaryKo([...TOEIC_PRINT_SECTIONS]) === "고른 항목이 없어 문제·점수만 인쇄해요.",
  );

  // ② 소스 대조
  const view = codeOnly(read("components/toeic-attempt-view.tsx"));
  const secCount = (k: string) => (view.match(new RegExp(`data-print-sec="${k}"`, "g")) ?? []).length;
  add(
    "결과 화면: 묶음 표시 — 전사 3(전사 블록·지문 대조 라벨·대조 본문)·나머지 다섯은 1",
    secCount("transcript") === 3 && ["strengths", "fixes", "missing", "improved", "model"].every((k) => secCount(k) === 1),
    TOEIC_PRINT_SECTIONS.map((k) => `${k}=${secCount(k)}`).join(" "),
  );
  add("결과 화면: 모범답변 접기 자체가 model 묶음(펼치기 훅이 건너뛴다)", /<details className=\{s\.model\} data-print-expand="" data-print-sec="model">/.test(view));
  add("결과 화면: 루트에 toeicPrintOmitAttrs(printOmit)를 편다", /<div className=\{s\.wrap\} ref=\{printRootRef\} \{\.\.\.toeicPrintOmitAttrs\(printOmit\)\}>/.test(view));
  const bar = view.slice(view.indexOf("<div className={s.printBar}>"), view.indexOf("</fieldset>"));
  add("결과 화면: 체크박스는 인쇄에서 숨는 버튼 줄(.printBar) 안 · 항목마다 하나", bar.includes('data-testid="print-btn"') && /TOEIC_PRINT_SECTIONS\.map\(\(k\) =>[\s\S]*type="checkbox"/.test(bar));
  add("결과 화면: 기억 읽기·쓰기는 try/catch", /try \{\s*setPrintOmit\(parseToeicPrintOmit\(window\.localStorage\.getItem\(TOEIC_PRINT_SECTIONS_STORAGE_KEY\)\)\);\s*\} catch/.test(view) && /try \{\s*window\.localStorage\.setItem\(TOEIC_PRINT_SECTIONS_STORAGE_KEY/.test(view));
  const css = read("components/toeic-attempt-view.module.css");
  const printAt = css.indexOf("@media print");
  const omitRules = TOEIC_PRINT_SECTIONS.map((k) => `.wrap[data-print-omit-${k}] [data-print-sec="${k}"]`);
  add("CSS: 여섯 묶음 숨김 규칙이 모두 @media print 안에만", omitRules.every((r) => css.indexOf(r) > printAt && css.indexOf(r) === css.lastIndexOf(r)) && printAt > 0);
  add("CSS: .sec는 display: contents(화면 배치 불변)·.printAlt는 평소 숨김", /\.sec \{\s*display: contents;\s*\}/.test(css) && /\.printAlt \{\s*display: none;\s*\}/.test(css));
  const hook = codeOnly(read("components/use-print-expand.ts"));
  add("펼치기 훅: 뺀 묶음(data-print-sec + 루트 data-print-omit-*) 안의 접기는 열지 않는다", /if \(!d\.open && !inOmittedSection\(root, d\)\)/.test(hook) && /root\.hasAttribute\(`data-print-omit-\$\{sec\}`\)/.test(hook));
  return results;
}
