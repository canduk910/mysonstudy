/**
 * lib/prod-guard.ts — 개발 환경에서 프로덕션 데이터를 지우는 것을 막는 가드
 *
 * **왜 있나 (2026-08-17 사고)**
 * `.env`에 `STORE_BACKEND=firestore`가 들어 있어, 로컬에서 앱을 띄우면 프로덕션
 * Firestore를 직접 읽고 썼다. 그 상태로 삭제 기능(`deleteBook`·`deleteCard`)을
 * 테스트하다 가족 데이터가 전부 지워졌다 — 책 4권·카드 8장·읽음 기록 6건.
 * 그때 PITR이 꺼져 있어, Firestore가 기본으로 유지하는 1시간 버전 보존 창이
 * 닫히기 직전에 겨우 되살렸다.
 *
 * `.env`를 정리했지만 그것만으로는 부족하다 — 누군가(사람이든 에이전트든) 다시
 * 켜면 같은 사고가 그대로 재현된다. 그래서 코드 층에 한 겹 더 둔다.
 *
 * **규칙**: 프로덕션이 아닌데 Firestore(=실데이터)를 지우려 하면 **던진다.**
 * 조용히 넘어가지 않는다 — 조용한 실패는 "지워진 줄 모르는" 오늘의 사고와 같다.
 *
 * 정말 로컬에서 프로덕션 데이터를 지워야 한다면 `ALLOW_PROD_DESTRUCTIVE=1`을
 * 명시적으로 주면 된다. 실수로 켜지지 않도록 `.env`에 두지 말고 그 명령에만 붙일 것:
 *   ALLOW_PROD_DESTRUCTIVE=1 npx tsx scripts/whatever.ts
 */

/** 파괴적 작업 이름 — 에러 메시지에 그대로 실린다 */
export type DestructiveOp = "deleteBook" | "deleteCard";

export class ProdGuardError extends Error {
  readonly code = "prod_guard";
  constructor(op: DestructiveOp) {
    super(
      `[prod-guard] 개발 환경에서 프로덕션 Firestore의 ${op}를 막았어요.\n` +
        `  지금 스토어 백엔드가 firestore인데 NODE_ENV가 production이 아닙니다 — ` +
        `로컬 실행이 실제 가족 데이터를 지우려는 상황입니다.\n` +
        `  로컬 테스트라면 STORE_BACKEND=file 로 돌리세요(.env에서 이미 기본값입니다).\n` +
        `  의도한 작업이라면 그 명령에만 ALLOW_PROD_DESTRUCTIVE=1 을 붙이세요.`,
    );
    this.name = "ProdGuardError";
  }
}

/**
 * 파괴적 작업 직전에 호출한다. 막아야 하면 던지고, 아니면 조용히 통과한다.
 *
 * 통과 조건:
 * - `NODE_ENV === "production"` — Cloud Run의 실서버. 여기서 막으면 기능이 죽는다.
 * - `ALLOW_PROD_DESTRUCTIVE === "1"` — 사람이 의도를 명시한 경우.
 */
export function assertDestructiveAllowed(op: DestructiveOp): void {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.ALLOW_PROD_DESTRUCTIVE === "1") return;
  throw new ProdGuardError(op);
}

/** 라우트가 502가 아니라 의미 있는 상태코드를 주도록 판별에 쓴다 */
export function isProdGuardError(e: unknown): e is ProdGuardError {
  return e instanceof Error && (e as ProdGuardError).code === "prod_guard";
}
