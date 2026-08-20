/**
 * lib/build-id.ts — 지금 돌고 있는 빌드의 식별자 (서버 전용)
 *
 * 쓰임: `/api/version`이 이 값을 내려주고, 브라우저(`components/version-watch.tsx`)가
 * 처음 받은 값과 비교해 **새 배포가 올라왔는지**를 알아차린다.
 * (2026-08-20 "배포했는데 옛 화면이 보인다" 사고 대응)
 *
 * ── 왜 Next의 BUILD_ID인가 ─────────────────────────────────────────────────
 * Next는 `next build`마다 무작위 ID를 만들어 `.next/BUILD_ID`에 쓴다. 같은 소스를
 * 다시 빌드해도 값이 바뀌므로 "빌드가 갈렸다"를 정확히 가리킨다. 프리렌더 HTML도
 * `/_next/static/<BUILD_ID>/...`로 이 ID를 물고 있어, 화면과 서버가 같은 빌드인지
 * 판정하는 기준으로 의미가 맞는다.
 *
 * ── 왜 파일을 읽나 (런타임에만) ────────────────────────────────────────────
 * Next는 이 값을 앱 코드에 공개 API로 내주지 않는다. 그래서 서버 프로세스가 뜬 뒤
 * `.next/BUILD_ID`를 **한 번** 읽어 모듈 스코프에 캐시한다. `next start`가 같은
 * 파일을 같은 방식으로 읽으므로(next-server의 `readFileSync(distDir/BUILD_ID)`)
 * 위치는 안정적이다. Cloud Run 버스팩도 `npm run build` → `next start`를 같은
 * 디렉터리에서 돌리므로 `process.cwd()/.next/BUILD_ID`가 그대로 있다.
 *
 * **빌드(프리렌더) 중에는 절대 읽지 않는다.** `next build`가 이 파일을 언제 쓰는지는
 * 보장된 계약이 아니고, 직전 빌드의 값이 남아 있으면 옛 ID를 화면에 구워 넣게 된다.
 * 그래서 호출 지점은 요청 시점에만 도는 라우트 핸들러(`/api/version`) 하나뿐이다.
 *
 * ── 실패는 조용히 ──────────────────────────────────────────────────────────
 * 못 읽으면 `null`을 준다. 클라이언트는 `null`이면 **아무 배너도 띄우지 않는다** —
 * 아이가 문제를 푸는 중에 뜨는 거짓 알림이, 알림이 없는 것보다 나쁘다.
 */

import fs from "node:fs";
import path from "node:path";

/** `undefined` = 아직 안 읽음, `null` = 읽기 실패(알 수 없음) */
let cached: string | null | undefined;

export function getBuildId(): string | null {
  if (cached !== undefined) return cached;

  // `deploymentId`(next.config)를 설정한 빌드라면 그 값이 더 정확하다(빌드 재사용·롤백까지 반영).
  //
  // ⚠️ `typeof` 검사를 지우지 말 것. 번들러가 `process.env.NEXT_DEPLOYMENT_ID`를
  // **빌드 시점에 상수로 치환**하는데, 미설정이면 문자열이 아니라 **`false`**가 박힌다
  // (실측: `false.trim is not a function`으로 라우트가 500). 값이 아니라 타입을 먼저 본다.
  // 같은 이유로 이 참조는 런타임 env가 아니라 빌드 시점 상수다 — 배포 후에 바꿔도 안 바뀐다.
  const fromEnv: unknown = process.env.NEXT_DEPLOYMENT_ID;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    cached = fromEnv.trim();
    return cached;
  }

  try {
    const id = fs.readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
    cached = id.length > 0 ? id : null;
  } catch {
    cached = null;
  }
  return cached;
}
