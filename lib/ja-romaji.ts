/**
 * lib/ja-romaji.ts — 로마자 → ひらがな 변환(순수 함수, import 0). AI 없음.
 *
 * 왜: 관문 T-ja는 `language:"ja"`인데도 짧은 단어만 말하면 전사 모델이 로마자로 적는 일이 있다
 * (2026-11-18 실기기 — 「がっこう さっか」를 말했더니 "gadko sakka" → 글자 일치율 0%). 판정 쪽 안전망으로,
 * 받아쓰기에 라틴 글자가 섞여 있으면 그 부분만 가나로 바꿔 대조한다. 가나·한자는 그대로 둔다.
 *
 * 헵번식·훈령식 둘 다 받는다(shi/si, chi/ti, tsu/tu, fu/hu, ji/zi, sha/sya …). 겹자음(kk·tt·cch) → っ,
 * 자음·끝 앞의 n(과 n') → ん, 장음 기호(ā·ō …)는 모음 둘로 편다. 표에 없는 글자는 그대로 남긴다(정규화가 버린다).
 */

const TABLE: Record<string, string> = {
  a: "あ", i: "い", u: "う", e: "え", o: "お",
  ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ",
  ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
  sa: "さ", si: "し", shi: "し", su: "す", se: "せ", so: "そ",
  za: "ざ", zi: "じ", ji: "じ", zu: "ず", ze: "ぜ", zo: "ぞ",
  ta: "た", ti: "ち", chi: "ち", tu: "つ", tsu: "つ", te: "て", to: "と",
  da: "だ", di: "ぢ", du: "づ", de: "で", do: "ど",
  na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の",
  ha: "は", hi: "ひ", hu: "ふ", fu: "ふ", he: "へ", ho: "ほ",
  ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ",
  pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
  ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
  ya: "や", yu: "ゆ", yo: "よ",
  ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ",
  la: "ら", li: "り", lu: "る", le: "れ", lo: "ろ",
  wa: "わ", wo: "を", we: "うぇ", wi: "うぃ",
  kya: "きゃ", kyu: "きゅ", kyo: "きょ",
  gya: "ぎゃ", gyu: "ぎゅ", gyo: "ぎょ",
  sha: "しゃ", shu: "しゅ", sho: "しょ", she: "しぇ", sya: "しゃ", syu: "しゅ", syo: "しょ",
  ja: "じゃ", ju: "じゅ", jo: "じょ", je: "じぇ", jya: "じゃ", jyu: "じゅ", jyo: "じょ", zya: "じゃ", zyu: "じゅ", zyo: "じょ",
  cha: "ちゃ", chu: "ちゅ", cho: "ちょ", che: "ちぇ", tya: "ちゃ", tyu: "ちゅ", tyo: "ちょ",
  nya: "にゃ", nyu: "にゅ", nyo: "にょ",
  hya: "ひゃ", hyu: "ひゅ", hyo: "ひょ",
  bya: "びゃ", byu: "びゅ", byo: "びょ",
  pya: "ぴゃ", pyu: "ぴゅ", pyo: "ぴょ",
  mya: "みゃ", myu: "みゅ", myo: "みょ",
  rya: "りゃ", ryu: "りゅ", ryo: "りょ",
  fa: "ふぁ", fi: "ふぃ", fe: "ふぇ", fo: "ふぉ",
  va: "ゔぁ", vi: "ゔぃ", vu: "ゔ", ve: "ゔぇ", vo: "ゔぉ",
};

const LONG_VOWEL: Record<string, string> = { "ā": "aa", "ī": "ii", "ū": "uu", "ē": "ee", "ō": "ou", "â": "aa", "î": "ii", "û": "uu", "ê": "ee", "ô": "ou" };

const isVowel = (c: string) => c === "a" || c === "i" || c === "u" || c === "e" || c === "o";
const isLatin = (c: string) => c >= "a" && c <= "z";

/** 라틴 글자가 하나라도 있는가 */
export function hasLatinLetters(s: string): boolean {
  return /[A-Za-zĀ-ſ]/.test(s);
}

/** 로마자 부분만 ひらがな로 — 가나·한자·기호는 그대로 */
export function jaRomajiToHiragana(input: string): string {
  let s = "";
  for (const ch of input.toLowerCase()) s += LONG_VOWEL[ch] ?? ch;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (!isLatin(c)) {
      out += c === "'" ? "" : c;
      i++;
      continue;
    }
    const next = s[i + 1] ?? "";
    // 겹자음 → っ (n은 제외, cch → っち)
    if (c !== "n" && !isVowel(c) && (next === c || (c === "t" && next === "c" && s[i + 2] === "h"))) {
      out += "っ";
      i++;
      continue;
    }
    let matched = false;
    for (const len of [3, 2, 1]) {
      const chunk = s.slice(i, i + len);
      const kana = TABLE[chunk];
      if (kana) {
        out += kana;
        i += len;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // n: 모음·y 앞이 아니면 ん (nn·n' 포함)
    if (c === "n") {
      out += "ん";
      i += next === "n" && !isVowel(s[i + 2] ?? "") && s[i + 2] !== "y" ? 2 : 1;
      continue;
    }
    out += c; // 표에 없는 글자 — 정규화가 버린다
    i++;
  }
  return out;
}
