/**
 * lib/toeic-firestore-codec.ts — 토익 세트 문서를 **Firestore에 쓸 때만** 필요한 모양 바꾸기 (docs/harness/toeic.md §12-3)
 *
 * Firestore는 배열 안에 배열을 바로 담지 못한다(배열 원소가 배열이면 쓰기가 INVALID_ARGUMENT로 거부된다). 틀 은행
 * (`guide.kind:"templates"`, 문서 id `guide-templates`)의 틀마다 있는 `testFills: string[][]`(자리 순서의 채움 묶음 목록, §12-2-7)가
 * 정확히 그 모양이라, 그대로 쓰면 프로덕션 가져오기가 500(save_failed)이 된다 — 파일 백엔드(JSON)는 받으므로 로컬에서는 드러나지 않는다.
 *
 * 그래서 **Firestore 본문에서만** `testFills: { fills: string[] }[]`로 감싸 쓰고, 읽을 때 다시 `string[][]`로 푼다. 앱 모양(레코드 타입·
 * 파일 백엔드·정규화 lib/toeic-normalize.ts·렌더 판정)은 그대로다. 내용 지문(`guide.contentHash`)은 zod 출력(string[][])에서 한 번
 * 계산해 **문자열로** 저장하므로 이 변환의 영향을 받지 않는다(다시 가져오기의 unchanged 판정이 그대로 맞는다).
 *
 * 순수 함수(런타임 import 0 — 서버·eval 공용). eval이 실제 가져오기 파일로 "인코딩한 본문에 배열 속 배열이 없다"와 왕복 불변을 잠근다.
 */

type Loose = Record<string, unknown>;

function isObj(v: unknown): v is Loose {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 값 어딘가에 "배열의 원소가 곧 배열"인 자리가 있는가(Firestore가 거부하는 모양). */
export function hasNestedArray(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => Array.isArray(x) || hasNestedArray(x));
  if (isObj(v)) return Object.values(v).some(hasNestedArray);
  return false;
}

/** 틀 은행 문서의 틀 목록만 바꾼다 — 유형 공략(kind "part")·표현집(null)·모르는 모양은 그대로 돌려준다. */
function mapTemplateItems(guide: unknown, fn: (item: Loose) => Loose): unknown {
  if (!isObj(guide) || guide.kind !== "templates" || !Array.isArray(guide.items)) return guide;
  return { ...guide, items: guide.items.map((it) => (isObj(it) ? fn(it) : it)) };
}

/**
 * 쓰기 본문용 — 틀마다 `testFills: string[][]` → `{ fills: string[] }[]`. 이미 감싼 원소·배열이 아닌 원소는 그대로 둔다(멱등).
 * 레코드 전체가 아니라 `guide` 칸 하나를 받는다(세트 쓰기 헬퍼가 정규화한 본문의 guide를 넘긴다).
 */
export function encodeToeicGuideForFirestore(guide: unknown): unknown {
  return mapTemplateItems(guide, (it) =>
    Array.isArray(it.testFills) ? { ...it, testFills: it.testFills.map((tf) => (Array.isArray(tf) ? { fills: tf } : tf)) } : it,
  );
}

/**
 * 읽기용 — `{ fills: string[] }` 원소를 `string[]`로 푼다. 배열 원소(파일에서 옮긴 문서 등)는 그대로, 모르는 모양도 그대로 둔다 —
 * 모양이 깨진 틀은 렌더 판정(isRenderableToeicTemplate)이 그 틀만 뺀다(던지지 않는다 — 정규화 관용구).
 */
export function decodeToeicGuideFromFirestore(guide: unknown): unknown {
  return mapTemplateItems(guide, (it) =>
    Array.isArray(it.testFills)
      ? { ...it, testFills: it.testFills.map((tf) => (isObj(tf) && Array.isArray(tf.fills) ? tf.fills : tf)) }
      : it,
  );
}
