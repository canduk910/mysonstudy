/**
 * lib/toeic-mock-apply.ts — 모의고사 레코드를 **원자 단위 안에서** 바꾸는 판정·적용 순수 함수 (docs/harness/toeic.md §4-0·§4-10·§7-2)
 *
 * 두 백엔드(lib/store.ts 파일 mutate · lib/store-firestore.ts runTransaction)가 **같은 함수**로 판정한다 — 판정이 두 벌이면
 * 한쪽만 "먼저 만든 사진을 덮는" 구멍이 난다(applyAttemptFinish·applyAttemptAnswer와 같은 방침). eval이 반례로 잠근다.
 *
 * 불변식
 * 1. **파트 채우기는 빈 자리만**(`decideFillPart`): 이미 있는 파트는 덮지 않는다. "이 파트 다시 만들기"가 두 번 눌리거나
 *    두 탭에서 겹쳐도 먼저 채운 파트가 남는다 — 보던 모범답변·응시 기록이 가리키는 문항이 말없이 바뀌지 않는다.
 * 2. **사진은 먼저 준비된 것이 이긴다**(`decidePictureImage`): `ready`는 다른 `ready`로도 `failed`로도 바뀌지 않는다.
 *    두 요청이 같은 칸을 동시에 만들어도 한 장만 저장되고, 늦게 실패한 요청이 먼저 성공한 사진을 지우지 않는다.
 * 3. **장면이 바뀌었으면 쓰지 않는다**: 사진을 만든 `imagePrompt`가 지금 레코드의 장면과 다르면 `stale` — 다른 장면의
 *    사진이 붙지 않게(지금은 파트가 빈 자리만 채워져 장면이 바뀔 일이 없지만, 판정은 방어로 남긴다).
 *
 * ⚠️ 런타임 import 0(타입만) — eval·두 백엔드가 가볍게 부른다.
 */

import type { ToeicMockPartRecordMap, ToeicPictureImage } from "./ai/toeic/schemas";
import type { ToeicMockRecord } from "./store";
import type { ToeicMockPart } from "./toeic-mock";

/** 파트 채우기 판정 — `exists`면 쓰지 않는다 */
export type ToeicFillPartDecision = "fill" | "exists";

export function decideFillPart(current: ToeicMockRecord, part: ToeicMockPart): ToeicFillPartDecision {
  return current.parts[part] === null || current.parts[part] === undefined ? "fill" : "exists";
}

/** 파트 하나를 넣은 새 레코드(판정이 fill일 때만 부른다). 정규화는 호출측(저장 계층)이 한다. */
export function applyFillPart<P extends ToeicMockPart>(
  current: ToeicMockRecord,
  part: P,
  value: ToeicMockPartRecordMap[P],
): ToeicMockRecord {
  return { ...current, parts: { ...current.parts, [part]: value } };
}

/**
 * 사진 상태 쓰기 판정.
 * - `missing`: picture 파트가 없거나 그 칸이 없다
 * - `stale`: 그 칸의 imagePrompt가 사진을 만든 프롬프트와 다르다(장면이 바뀜)
 * - `kept`: 이미 ready — 먼저 준비된 사진을 그대로 둔다(새 ready·failed 모두 쓰지 않는다)
 * - `apply`: 쓴다
 */
export type ToeicPictureImageDecision = "apply" | "kept" | "stale" | "missing";

export function decidePictureImage(current: ToeicMockRecord, slot: 0 | 1, imagePrompt: string): ToeicPictureImageDecision {
  const item = current.parts.picture?.items[slot];
  if (!item) return "missing";
  if (item.imagePrompt !== imagePrompt) return "stale";
  if (item.image.status === "ready" && item.image.imageId) return "kept";
  return "apply";
}

/** 그 칸의 image만 바꾼 새 레코드(판정이 apply일 때만 부른다). */
export function applyPictureImage(current: ToeicMockRecord, slot: 0 | 1, image: ToeicPictureImage): ToeicMockRecord {
  const picture = current.parts.picture;
  if (!picture) return current;
  const items = picture.items.map((it, k) => (k === slot ? { ...it, image } : it));
  return { ...current, parts: { ...current.parts, picture: { ...picture, items } } };
}
