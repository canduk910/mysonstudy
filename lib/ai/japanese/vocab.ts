/**
 * lib/ai/japanese/vocab.ts — 호출 A 단어 생성의 코드 후처리 순수 함수 (docs/harness/japanese.md §2-4·§2-0)
 *
 * **실호출 없이 eval이 검사하는 순수 함수다.** 부수효과·값 import를 최소로 둔다(타입·상수만 import).
 * 값을 만드는 것은 여기뿐이고 다른 곳은 결과를 소비만 한다 — 후처리 규칙이 두 곳에 살면 어긋난다.
 *
 * 후처리(§2-4)는 프롬프트를 못 믿는 진짜 방어선이다: 제외 재적용(일본어 include 예외)·포함 이행 보고·중복 접기
 * (일본어 include > 한국어에서 온 것 > 새 단어)·레벨 태깅(코드가 붙인다)·부분 성공·한국어 매핑 보고
 * (koConverted/koExcluded). 그리고 §2-0의 레벨별 include 배분 계획(일본어·한국어 줄 판별 포함).
 *
 * 한국어 꼭 넣을 단어(2026-09-27): 제외 판정은 **일본어로 바뀐 뒤에** 한다. 일본어로 직접 넣은 include는 제외보다
 * 우선하지만, 한국어에서 온 단어는 무엇이 될지 모르고 넣은 것이라 이미 가진 단어면 빼고 koExcluded로 알린다.
 *
 * "같은 단어" 판정(2026-09-27 정정 — isSameJaWord)은 제외·접기·매핑이 **한 함수**로 공유한다. 표기가 같으면 같은 단어,
 * 읽기만 같으면 한쪽 표기가 가나로만 돼 있거나(표기 흔들림) 한자 뼈대로 같은 단어의 표기 변형임이 보일 때만
 * (申し込む/申込む, 子ども/子供 — 같은 날 P3-1 보강) 같은 단어다. 동음이의어(暑い/熱い, 箸/橋, 風/風邪)는
 * 다른 단어라 접지도 제외하지도 않는다 — kana만으로 접으면 사용자가 요청한 단어가 사라지고 매핑이 틀린 단어를 가리켰다.
 */

import {
  JA_VOCAB_DEFAULT_COUNT,
  classifyJaIncludeLine,
  normalizeKoInclude,
  type JaKoIncludeMapping,
  type JaVocabEntry,
  type JaVocabGenEntry,
  type JlptLevel,
} from "./schemas";

// ---------------------------------------------------------------------------
// 정규화 — include/exclude 입력 정리 (§2-4: 공백·전각 정리)
// ---------------------------------------------------------------------------

/**
 * 일본어 표기 하나를 조인·비교용으로 정규화한다. NFKC로 전각/반각을 통일하고(예: 반각 가나 ｶﾞ→ガ,
 * 전각 공백 등) 공백을 전부 제거한다. 표제어에는 공백이 없어야 정상이므로 안전하다.
 */
export function normalizeJaWord(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "");
}

/** 표기 목록을 정규화하고 빈 값·중복(정규화 기준)을 제거한다(등장 순서 유지). */
export function normalizeJaWordList(list: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const w = normalizeJaWord(raw);
    if (w === "" || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * 정규화한 표기가 가나(히라가나·가타카나 블록 — 장음부호 ー 포함)로만 돼 있는가.
 * 반각 가나는 normalizeJaWord의 NFKC가 전각으로 바꾼 뒤라 여기서 따로 다루지 않는다.
 */
function isKanaOnlyWord(normalized: string): boolean {
  return /^[぀-ゟ゠-ヿ]+$/.test(normalized);
}

/** 한자 한 글자인가 — Unicode Script=Han(々·〇 포함. ヶ·ー·・는 한자가 아니다). */
const HAN_CHAR = /\p{Script=Han}/u;
/** 가나 글자가 하나라도 들어 있는가 — 빠진 한자 자리를 가나로 적었는지 볼 때 쓴다(isKanaOnlyWord와 같은 블록). */
const HAS_KANA = /[぀-ゟ゠-ヿ]/;
/** 표기 머리의 가나(お·ご·み·おん)가 대신할 수 있는 유일한 한자 — 존경 접두 御 */
const HONORIFIC_PREFIX_KANJI = "御";

/**
 * 표기의 **한자 뼈대**와 그 사이 빈칸. kanji는 표기에서 한자만 순서대로 뽑은 열이고,
 * gaps[i]는 kanji[i] 앞(i=0이면 머리, i=kanji.length면 꼬리)에 있는 한자 아닌 글자다 — gaps.length = kanji.length + 1.
 * 예: 子ども → kanji [子], gaps ["", "ども"] · 見付ける → kanji [見, 付], gaps ["", "", "ける"].
 */
function kanjiShape(normalized: string): { kanji: string[]; gaps: string[] } {
  const kanji: string[] = [];
  const gaps: string[] = [""];
  for (const ch of normalized) {
    // for…of는 코드 포인트 단위라 확장 한자(𠮷 등)도 한 글자로 센다
    if (HAN_CHAR.test(ch)) {
      kanji.push(ch);
      gaps.push("");
    } else {
      gaps[gaps.length - 1] += ch;
    }
  }
  return { kanji, gaps };
}

/**
 * 짧은 표기의 빈칸 하나가, 긴 표기에서 그 자리에 있는 한자들(missing)을 **가나로 풀어 적은 것**일 수 있는가.
 * - 빠진 한자가 없으면 통과.
 * - 빈칸에 가나가 없으면 거부 — 한자가 읽기 없이 덧붙은 숙자훈과 가르려는 것이다(風/風邪: 邪 자리에 아무것도 없다).
 * - 머리 빈칸이면 빠진 한자가 御일 때만 통과 — 머리의 お·ご는 존경 접두 御의 가나 표기일 뿐이다(お茶/御茶).
 *   이 조건이 없으면 ご本/五本, ご用/誤用, ご入力/誤入力처럼 머리 한자가 ご로 읽히는 동음이의어가 접힌다.
 */
function isKanaStandIn(gap: string, missing: readonly string[], atHead: boolean): boolean {
  if (missing.length === 0) return true;
  if (!HAS_KANA.test(gap)) return false;
  if (atHead) return missing.every((k) => k === HONORIFIC_PREFIX_KANJI);
  return true;
}

/**
 * 한자가 든 두 표기가 같은 단어의 표기 변형인가(읽기가 같다는 전제에서만 부른다 — isSameJaWord 3번).
 * a. 한자 뼈대가 같으면 변형 — 오쿠리가나만 다르다(申し込む/申込む, 受け付け/受付, 終わる/終る).
 * b. 짧은 뼈대가 긴 뼈대의 순서 있는 부분열이고, 짧은 쪽에서 빠진 한자 자리마다 가나가 적혀 있으면 변형 — 한자 일부를
 *    가나로 푼 교과서·신문 표기(子ども/子供, 友だち/友達, 見つける/見付ける, お茶/御茶). 머리 자리는 御만(isKanaStandIn).
 * 둘 다 아니면 동음이의어로 본다. 뼈대가 비면(가나만의 표기) 여기서 다루지 않는다 — 그건 isSameJaWord 2번이다.
 * 부분열 맞춤은 여러 가지일 수 있어(같은 한자가 두 번) 되돌아가며 하나라도 성립하는지 본다. 표제어는 짧아 비용은 무시할 만하다.
 */
function isKanjiNotationVariant(aw: string, bw: string): boolean {
  const a = kanjiShape(aw);
  const b = kanjiShape(bw);
  if (a.kanji.length === 0 || b.kanji.length === 0) return false;
  const [short, long] = a.kanji.length <= b.kanji.length ? [a, b] : [b, a];
  if (short.kanji.length === long.kanji.length) return short.kanji.join("") === long.kanji.join("");
  // j: 짧은 쪽에서 다음에 맞출 한자, p: 긴 쪽에서 아직 쓰지 않은 첫 한자. 짧은 쪽 빈칸 j가 긴 쪽 kanji[p..q) 자리를 맡는다.
  const align = (j: number, p: number): boolean => {
    if (j === short.kanji.length) return isKanaStandIn(short.gaps[j], long.kanji.slice(p), false);
    for (let q = p; q < long.kanji.length; q++) {
      if (long.kanji[q] !== short.kanji[j]) continue;
      if (!isKanaStandIn(short.gaps[j], long.kanji.slice(p, q), j === 0)) continue;
      if (align(j + 1, q + 1)) return true;
    }
    return false;
  };
  return align(0, 0);
}

/**
 * 두 항목이 **같은 단어**인가 — §2-4의 제외 재적용(1)·중복 접기(3)·한국어 매핑(6)이 공유하는 단일 판정.
 * 1. 표기(word)가 같으면 같은 단어.
 * 2. 읽기(kana)가 같고 **두 표기 중 하나가 가나로만 돼 있으면** 같은 단어 — 같은 단어의 표기 흔들림을 흡수한다
 *    (見る/みる, 林檎/りんご, りんご/リンゴ, パスポート/ぱすぽーと).
 * 3. 읽기가 같고 두 표기 모두 한자를 포함하면 **한자 뼈대**(표기에서 한자만 순서대로 뽑은 열)로 가른다(2026-09-27 P3-1):
 *    뼈대가 같거나(申し込む/申込む), 한쪽이 다른 쪽 뼈대의 순서 있는 부분열이면서 빠진 한자 자리를 가나로 적었으면
 *    (子ども/子供, お茶/御茶) 같은 단어 — isKanjiNotationVariant.
 * 4. 그 밖(暑い/熱い, 箸/橋, 雨/飴, 風/風邪, ご本/五本)은 동음이의어 — **다른 단어**다.
 * 비교는 normalizeJaWord(NFKC·공백 제거) 값으로 한다. 가나 표기끼리 읽기가 같은 경우(はし/はし)는 코드가 뜻을 가를 수 없어
 * 같은 단어로 본다(모델은 한자가 있는 단어를 한자로 쓰므로 드물다).
 * 알려진 한계: 한자 자체가 다른 변형(綺麗/奇麗, 分かる/解る)과 양쪽이 서로 다른 한자를 푼 변형(子ども達/子供たち)은
 * 다른 단어로 본다 — 읽기 정렬 사전 없이는 異字同訓(見る/観る)과 가를 수 없다(§2-4 알려진 한계).
 */
export function isSameJaWord(a: { word: string; kana: string }, b: { word: string; kana: string }): boolean {
  const aw = normalizeJaWord(a.word);
  const bw = normalizeJaWord(b.word);
  if (aw !== "" && aw === bw) return true;
  const ak = normalizeJaWord(a.kana);
  if (ak === "" || ak !== normalizeJaWord(b.kana)) return false;
  if (isKanaOnlyWord(aw) || isKanaOnlyWord(bw)) return true;
  return isKanjiNotationVariant(aw, bw);
}

/** 한국어 꼭 넣을 단어 목록을 정규화(normalizeKoInclude)하고 빈 값·중복을 제거한다(등장 순서 유지). */
export function normalizeKoIncludeList(list: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const k = normalizeKoInclude(raw);
    if (k === "" || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 레벨별 include 배분 계획 (§2-0) — app-builder가 이걸로 병렬 호출을 만든다
// ---------------------------------------------------------------------------

/** 한 레벨 호출의 계획 — 이 레벨에서 만들 전체 개수(count)와 이 레벨에 배분된 꼭 넣을 단어(일본어·한국어). */
export interface JaVocabCallPlan {
  level: JlptLevel;
  /** 이 레벨 호출의 전체 개수(꼭 넣을 단어 포함). 새로 고르는 것은 count - include.length - includeKo.length */
  count: number;
  /** 이 레벨 호출에 배분된 꼭 넣을 단어 — 일본어 표기(normalizeJaWord). 첫 레벨에만 실린다 */
  include: string[];
  /** 이 레벨 호출에 배분된 꼭 넣을 단어 — 한국어 뜻(normalizeKoInclude). 첫 레벨에만 실린다(2026-09-27) */
  includeKo: string[];
}

/**
 * 레벨 여러 개일 때 꼭 넣을 단어를 **첫 번째 레벨 호출에만** 배분한다(§2-0·§2-1 3번).
 * 예: N2·N3 + 꼭 넣을 단어 3개(約束·여권·水), perLevelCount 10
 *   → [{N2, count 10, include [約束,水], includeKo [여권]}(새 7), {N3, count 10, include [], includeKo []}(새 10)].
 * 포함 단어를 레벨마다 쪼개 넣으면 같은 단어가 여러 번 나오므로 첫 레벨에 몰아준다.
 *
 * `include`는 화면이 보낸 **줄 그대로(일본어·한국어 섞임)** 받는다. 줄마다 classifyJaIncludeLine
 * (lib/japanese-include.ts 단일 정의)으로 가르고 — 라우트 검증(400)과 같은 함수라 판정이 어긋나지 않는다 —
 * 어느 쪽도 아닌 줄(섞임·라틴 등)은 버린다(라우트가 먼저 거부하므로 방어일 뿐이다).
 * 일본어·한국어를 **합쳐** 입력 순서대로 perLevelCount개까지만 싣는다(한국어도 전체 개수에 포함된다).
 *
 * @param levels     선택한 레벨들(순서 = 화면 선택 순서). 첫 레벨이 꼭 넣을 단어를 받는다
 * @param include    꼭 넣을 단어 줄(일본어 표기·한국어 뜻 섞임). 내부에서 판별·정규화·중복제거하고 perLevelCount로 상한을 건다
 * @param perLevelCount 레벨당 전체 개수(기본 10)
 */
export function planIncludeDistribution(
  levels: readonly JlptLevel[],
  include: readonly string[],
  perLevelCount: number = JA_VOCAB_DEFAULT_COUNT,
): JaVocabCallPlan[] {
  const ja: string[] = [];
  const ko: string[] = [];
  const seenJa = new Set<string>();
  const seenKo = new Set<string>();
  for (const raw of include) {
    // 첫 레벨이 담을 수 있는 꼭 넣을 단어는 (일본어+한국어) 최대 perLevelCount개(전체 개수를 넘을 수 없다)
    if (ja.length + ko.length >= perLevelCount) break;
    const lang = classifyJaIncludeLine(raw);
    if (lang === "ja") {
      const w = normalizeJaWord(raw);
      if (w === "" || seenJa.has(w)) continue;
      seenJa.add(w);
      ja.push(w);
    } else if (lang === "ko") {
      const k = normalizeKoInclude(raw);
      if (k === "" || seenKo.has(k)) continue;
      seenKo.add(k);
      ko.push(k);
    }
    // null(섞임·라틴·숫자·20자 초과)은 버린다 — 라우트가 400으로 먼저 막는다
  }
  return levels.map((level, i) => ({
    level,
    count: perLevelCount,
    include: i === 0 ? ja : [],
    includeKo: i === 0 ? ko : [],
  }));
}

// ---------------------------------------------------------------------------
// 생성 결과 후처리 (§2-4 1~6) — 한 레벨 호출의 zod 통과분에 적용
// ---------------------------------------------------------------------------

/** 후처리 입력 — 한 레벨 호출의 결과와 그 호출의 인자(레벨·include·includeKo·누적 exclude). */
export interface JaVocabPostprocessInput {
  /** 호출 A(이 레벨) zod 통과 결과 */
  entries: readonly JaVocabGenEntry[];
  /** 이 단어장이 공부하는 레벨 — 각 entry에 코드가 붙인다(§2-4 4번) */
  level: JlptLevel;
  /** 이 레벨 호출에 배분된 꼭 넣을 단어(일본어 표기). 정규화 전이어도 내부에서 정규화한다 */
  include: readonly string[];
  /**
   * 이 레벨 호출에 배분된 꼭 넣을 단어(한국어 뜻). 없으면 생략 가능(= 빈 배열). 정규화 전이어도 내부에서 정규화한다.
   * 이 값이 있어야 fromKo를 믿는다 — 받지 않은 한국어를 적은 fromKo는 없는 것(null)으로 본다.
   */
  includeKo?: readonly string[];
  /** 누적 제외 목록(표기+읽기). 같은 단어(isSameJaWord)면 버린다(일본어 include만 예외) */
  exclude: readonly { word: string; kana: string }[];
}

export interface JaVocabPostprocessResult {
  /** 레벨 태깅·제외 재필터·중복 접기를 마친 저장용 엔트리 */
  entries: JaVocabEntry[];
  /** 제외 재적용 + 중복 접기로 버려진 개수(입력 − 출력). koExcluded로 빠진 항목도 여기에 들어 있다 */
  filteredCount: number;
  /**
   * 꼭 넣을 단어 중 결과에 못 들어간 것(오류가 아니라 화면 보고 대상, §2-4 2번).
   * 일본어 표기(정규화값) 먼저, 이어서 한국어 뜻(정규화값 — 모델이 바꿔 내지 않은 줄) 순서다.
   * koExcluded에 든 한국어 줄은 여기에 넣지 않는다(못 넣은 게 아니라 이미 있어서 뺀 것).
   */
  missingIncludes: string[];
  /** 한국어 줄이 일본어 단어로 바뀌어 **결과에 들어간** 매핑("여권 → パスポート"). 한국어 입력 순서 */
  koConverted: JaKoIncludeMapping[];
  /** 한국어 줄이 바뀐 단어가 **누적 제외 목록에 있어 뺀** 매핑("이미 있어서 뺐어요: 여권 → パスポート"). 한국어 입력 순서 */
  koExcluded: JaKoIncludeMapping[];
}

/**
 * §2-4의 코드 후처리 1~6단계를 적용한다. "같은 단어"는 전부 isSameJaWord 하나로 판정한다
 * (표기가 같거나, 읽기가 같고 한쪽이 가나 표기이거나 한자 뼈대로 표기 변형임이 보임 — 동음이의어는 다른 단어).
 * 1. 제외 재적용 — 기존 표제어와 같은 단어면 버린다. **단 일본어 include에 있으면 버리지 않는다.**
 *    한국어에서 온 항목(fromKo)은 이 예외가 **아니다** — 무엇이 될지 모르고 넣은 것이라 이미 있는 단어를 또 넣지 않는다.
 * 2. 포함 이행 확인 — 일본어 include는 word 일치, 없으면 kana 일치. 한국어 include는 fromKo로 찾는다. 빠진 것은 보고만 한다.
 * 3. 중복 접기 — 같은 단어끼리만 접는다. 우선순위: 일본어 include > 한국어에서 온 것 > 새로 고른 것(같으면 첫 등장).
 *    남은 항목은 그 묶음에서 가장 먼저 나온 자리에 선다. 동음이의어는 꼭 넣을 단어끼리든 새 단어끼리든 접지 않는다.
 * 4. 레벨 태깅 — 호출 인자 레벨을 각 entry에 붙인다(모델이 스스로 적게 하지 않는다).
 * 5. 부분 성공 — 10개보다 적어도 성공. 걸러진 수·못 넣은 include는 화면이 알린다.
 * 6. 한국어 매핑 보고 — 결과에 남으면 koConverted(접혔으면 **실제로 남은 항목**의 표기로), 제외로 빠지면 koExcluded.
 *    제외로 빠졌어도 같은 단어가 일본어 include로 남아 있고 그 include도 제외 목록의 단어라면(= 일본어 include와 겹쳐
 *    include만 예외로 남음) 하나로 접힌 것으로 보고 koConverted다.
 */
export function applyVocabPostprocess(input: JaVocabPostprocessInput): JaVocabPostprocessResult {
  const includeList = normalizeJaWordList(input.include);
  const includeSet = new Set(includeList);
  const includeKoList = normalizeKoIncludeList(input.includeKo ?? []);
  const includeKoSet = new Set(includeKoList);
  const matchesExclude = (e: { word: string; kana: string }) => input.exclude.some((x) => isSameJaWord(e, x));

  const originalCount = input.entries.length;

  // 0) 항목 목록(입력 순서 index로 식별 — 같은 객체가 두 번 와도 섞이지 않게)과 fromKo 확정.
  //    받은 한국어 줄만 믿고, 한 줄은 첫 항목만 가져간다(zod가 막지만 순수 함수도 스스로 방어한다).
  interface Item {
    e: JaVocabGenEntry;
    i: number;
    /** 이 항목이 온 한국어 줄(정규화값). 한국어에서 오지 않았으면 null */
    ko: string | null;
    /** 접기 우선순위: 2 일본어 include · 1 한국어에서 온 것 · 0 새로 고른 것 */
    rank: 0 | 1 | 2;
  }
  const items: Item[] = [];
  const itemOfKo = new Map<string, Item>();
  input.entries.forEach((e, i) => {
    let ko: string | null = null;
    if (e.fromKo !== null) {
      const k = normalizeKoInclude(e.fromKo);
      if (includeKoSet.has(k) && !itemOfKo.has(k)) ko = k;
    }
    const isJaInclude = includeSet.has(normalizeJaWord(e.word));
    const item: Item = { e, i, ko, rank: isJaInclude ? 2 : ko !== null ? 1 : 0 };
    if (ko !== null) itemOfKo.set(ko, item);
    items.push(item);
  });

  // 1) 제외 재적용 (일본어 include만 예외 — 한국어에서 온 것은 예외 아님). 같은 단어 판정은 isSameJaWord.
  const excluded = new Set<Item>();
  const survivors = items.filter((it) => {
    if (it.rank === 2) return true; // 일본어 include는 제외보다 우선(§2-0)
    if (matchesExclude(it.e)) {
      excluded.add(it);
      return false;
    }
    return true;
  });

  // 3) 중복 접기 — 우선순위 순(rank 내림차순, 같으면 첫 등장)으로 훑어, 이미 남긴 항목과 같은 단어면 그 항목에 접는다.
  //    isSameJaWord는 추이적이지 않다(見る~みる~観る). 그래서 묶음을 합집합으로 키우지 않고, 각 항목을 **첫 번째로 같은
  //    대표 하나**에만 붙인다 — 남은 대표끼리는 서로 다른 단어임이 보장된다(見る·観る가 먼저 서면 둘 다 남고 みる만 접힌다).
  const byPriority = [...survivors].sort((a, b) => b.rank - a.rank || a.i - b.i);
  const kept: Item[] = []; // 우선순위 순
  const repOf = new Map<Item, Item>(); // 살아남은 항목 → 그 항목이 접힌 대표(남은 항목). 대표는 자기 자신
  for (const it of byPriority) {
    const rep = kept.find((k) => isSameJaWord(k.e, it.e));
    if (rep) {
      repOf.set(it, rep);
    } else {
      kept.push(it);
      repOf.set(it, it);
    }
  }
  // 출력 순서: 대표는 자기 묶음에서 가장 먼저 나온 자리에 선다(접기 전 순서를 최대한 유지).
  const slot = new Map<Item, number>();
  for (const it of survivors) {
    const rep = repOf.get(it)!;
    slot.set(rep, Math.min(slot.get(rep) ?? it.i, it.i));
  }
  const folded = [...kept].sort((a, b) => slot.get(a)! - slot.get(b)!).map((it) => it.e);

  // 4) 레벨 태깅 (imageEmoji는 호출 A가 낸 값을 그대로 실어 나른다 — §작업1). fromKo는 저장 레코드에 싣지 않는다.
  const entries: JaVocabEntry[] = folded.map((e) => ({
    word: e.word,
    kana: e.kana,
    wordTokens: e.wordTokens,
    pos: e.pos,
    meaningsKo: e.meaningsKo,
    example: e.example,
    imageEmoji: e.imageEmoji,
    definitionJa: e.definitionJa,
    definitionTokens: e.definitionTokens,
    level: input.level,
  }));

  // 2) 포함 이행 확인 — 최종 결과 기준. 일본어: word 일치, 없으면 kana 일치.
  const resultWords = new Set(entries.map((e) => normalizeJaWord(e.word)));
  const resultKana = new Set(entries.map((e) => normalizeJaWord(e.kana)));
  const missingJa = includeList.filter((w) => !resultWords.has(w) && !resultKana.has(w));

  // 6) 한국어 매핑 보고 — 한국어 입력 순서대로. 매핑은 **실제로 남은 항목**을 가리킨다.
  const koConverted: JaKoIncludeMapping[] = [];
  const koExcluded: JaKoIncludeMapping[] = [];
  const missingKo: string[] = [];
  for (const ko of includeKoList) {
    const it = itemOfKo.get(ko);
    if (!it) {
      missingKo.push(ko); // 모델이 바꿔 내지 않았다
      continue;
    }
    if (!excluded.has(it)) {
      // 결과에 남았다 — 그대로 남았거나(대표 = 자기), 같은 단어(일본어 include 등)에 접혔다(대표 = 남은 항목)
      const rep = repOf.get(it)!;
      koConverted.push({ ko, word: rep.e.word, kana: rep.e.kana });
      continue;
    }
    // 제외로 빠졌다. 같은 단어가 일본어 include로 남아 있고 그 include도 제외 목록의 단어라면 — 모델이 같은 단어를
    // 두 번 냈고 include만 예외로 남은 것이니 — 하나로 접힌 것(koConverted). 가나 표기 하나가 동음이의어 둘을
    // 잇는 경우(はし ~ 箸(제외) / はし ~ 橋(include))는 이 조건에서 빠져 koExcluded로 사실대로 알린다.
    const same = kept.find((k) => k.rank === 2 && isSameJaWord(k.e, it.e) && matchesExclude(k.e));
    if (same) koConverted.push({ ko, word: same.e.word, kana: same.e.kana });
    else koExcluded.push({ ko, word: it.e.word, kana: it.e.kana }); // 이미 가진 단어라 뺐다
  }

  return {
    entries,
    filteredCount: originalCount - entries.length,
    missingIncludes: [...missingJa, ...missingKo],
    koConverted,
    koExcluded,
  };
}

// ---------------------------------------------------------------------------
// 저장 방어 정규화 — normalizeJaVocabEntry (하위호환)
// 이미 저장된 단어장에는 imageEmoji가 없다(호출 A 이모지는 J2에서 추가). 읽기/쓰기 경로에서 이 헬퍼로
// undefined를 정한 값으로 조인다(Firestore가 undefined 거부). **store.ts는 app-builder가 이 헬퍼를 호출**한다
// — 값 정규화를 여기 한 곳에만 두어(영어 normalizeRelated 관용구) store와 어긋나지 않게 한다.
// ---------------------------------------------------------------------------

/** normalizeJaVocabEntry가 받는 느슨한 입력 — 구 레코드는 imageEmoji가 없을 수 있다. */
export type LegacyOrNewJaVocabEntry = Partial<JaVocabEntry>;

/**
 * 저장·읽기 직전 방어 정규화. undefined를 정한 값으로 조이고, 구 레코드에 없는 imageEmoji는 null로 채운다.
 * 값을 손보지 않는다 — 없는 것을 없음(null·빈 배열)으로 적을 뿐이다(정렬·병합은 이미 끝났다).
 */
export function normalizeJaVocabEntry(entry: LegacyOrNewJaVocabEntry): JaVocabEntry {
  return {
    word: entry.word ?? "",
    kana: entry.kana ?? "",
    wordTokens: entry.wordTokens ?? [],
    pos: entry.pos ?? [],
    meaningsKo: entry.meaningsKo ?? [],
    example: entry.example ?? { ja: "", ko: "", tokens: [] },
    imageEmoji: entry.imageEmoji ?? null, // 구 레코드(이모지 없음) → null 폴백
    definitionJa: entry.definitionJa ?? null, // 구 레코드(일일정의 없음) → null 폴백(하위호환)
    definitionTokens: entry.definitionTokens ?? null, // 구 레코드(정의 토큰 없음) → null 폴백(하위호환)
    level: entry.level ?? null,
  };
}
