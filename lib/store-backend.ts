/**
 * lib/store-backend.ts — 저장 백엔드 판정 **단일 정의처** (lib/store.ts 머리 주석의 선택 규칙)
 *
 * 문서 스토어(`getStore()`)와 내 녹음 보관소(lib/toeic-rec-blob — docs/harness/toeic.md §13-1)가 **같은 판정**을 쓴다. 따로 판정하면
 * "문서는 파일, 녹음은 프로덕션 버킷" 같은 섞인 상태가 생긴다. lib/store.ts가 이 함수를 다시 내보낸다(`resolveStoreBackend`).
 * 별도 모듈인 이유: 녹음 보관소는 스토어의 삭제 연쇄(deleteToeicMock)가 부르는 쪽이라, store.ts를 import하면 순환이 된다.
 *
 * 서버 전용(process.env) — 클라이언트 컴포넌트에서 import하지 않는다.
 */

export type StoreBackend = "firestore" | "file";

/** env 명시(`STORE_BACKEND=firestore|file`) > GCP 자격증명 자동 감지 > file */
export function resolveStoreBackend(): StoreBackend {
  const env = process.env.STORE_BACKEND;
  if (env === "firestore" || env === "file") return env;
  if (env) {
    console.warn(
      `[store] STORE_BACKEND="${env}"는 알 수 없는 값이에요 (firestore|file) — 자동 감지로 진행합니다.`,
    );
  }
  const hasGcpCredentials = Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || // 로컬: 서비스 계정 키 파일 경로
      process.env.K_SERVICE || // Cloud Run이 주입 — 서비스 계정 ADC 사용 가능
      process.env.GOOGLE_CLOUD_PROJECT, // 그 외 GCP 환경 일반 신호
  );
  return hasGcpCredentials ? "firestore" : "file";
}
