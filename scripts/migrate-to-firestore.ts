/**
 * scripts/migrate-to-firestore.ts — 파일 스토어(data/db.json) → Firestore 1회성 이관
 *
 * 실행: npx tsx scripts/migrate-to-firestore.ts --i-know-this-overwrites-prod
 * 전제: GOOGLE_CLOUD_PROJECT + ADC(gcloud auth application-default login).
 * 문서 ID를 그대로 보존하므로 여러 번 실행해도 같은 문서를 덮어쓸 뿐 중복이 생기지 않는다.
 *
 * ⚠️ "덮어쓸 뿐"이 곧 위험이다 — 가족이 실제로 쓰는 프로덕션 Firestore 문서를 로컬 db.json의
 * (대개 오래된·시험용) 내용으로 `set` 해 버린다. 2026-08-17 사고(CLAUDE.md 서문) 이후
 * 이 스크립트는 명시 플래그 `--i-know-this-overwrites-prod` 없이는 아무것도 하지 않고 종료한다.
 */
import { existsSync, readFileSync } from "node:fs";
import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const CONFIRM_FLAG = "--i-know-this-overwrites-prod";
if (!process.argv.includes(CONFIRM_FLAG)) {
  console.error(
    `[migrate-to-firestore] 중단: 이 스크립트는 프로덕션 Firestore 문서를 data/db.json 내용으로 덮어씁니다.\n` +
      `  정말 의도한 1회성 이관이면 ${CONFIRM_FLAG} 를 붙여 다시 실행하세요.`,
  );
  process.exit(1);
}

for (const envFile of [".env.local", ".env"]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

async function main() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT가 설정되어 있지 않습니다.");
  if (!existsSync("data/db.json")) throw new Error("data/db.json이 없습니다 — 이관할 데이터 없음.");

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId });
  }
  const db = getFirestore();
  const data = JSON.parse(readFileSync("data/db.json", "utf8")) as Record<
    string,
    Array<{ id: string }>
  >;

  for (const col of ["books", "cards", "readings", "explanations", "vocabBooks"] as const) {
    const rows = data[col] ?? [];
    for (const row of rows) {
      await db.collection(col).doc(row.id).set(row);
    }
    console.log(`${col}: ${rows.length}건 이관 (프로젝트 ${projectId})`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("이관 실패:", err);
    process.exit(1);
  },
);
