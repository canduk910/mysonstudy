/**
 * scripts/provider-schemas.ts — 저장소의 strict JSON Schema 상수 수집기(공급자 층 점검 공용).
 *
 * `lib/ai/` 아래 `JSON_SCHEMA`를 담은 모듈을 import해 `{ name, strict: true, schema }` 모양의 export(한 단계 중첩 레코드 포함)를 모은다.
 * eval-provider(오프라인 Claude 호환 점검)와 smoke-anthropic-schemas(실호출 게이트 — 에이전트는 실행하지 않는다)가 같은 목록을 본다.
 * 진입 함수 모듈(calls.ts·client.ts)은 스키마를 import만 하므로 건너뛴다. 네트워크·클라이언트 생성 없음.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface CollectedSchema {
  /** 정의 위치 `파일:export이름` */
  where: string;
  /** json_schema 이름 */
  name: string;
  schema: Record<string, unknown>;
}

const ROOT = new URL("..", import.meta.url).pathname;

export async function collectStrictSchemas(): Promise<CollectedSchema[]> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(entry) && /JSON_SCHEMA/.test(readFileSync(p, "utf-8"))) files.push(p);
    }
  };
  walk(join(ROOT, "lib/ai"));
  const found: CollectedSchema[] = [];
  const isStrict = (v: unknown): v is { name: string; strict: true; schema: Record<string, unknown> } =>
    typeof v === "object" &&
    v !== null &&
    (v as { strict?: unknown }).strict === true &&
    typeof (v as { name?: unknown }).name === "string" &&
    typeof (v as { schema?: unknown }).schema === "object";
  for (const f of files.sort()) {
    if (/calls\.ts$|client\.ts$/.test(f)) continue;
    const mod = (await import(f)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(mod)) {
      if (isStrict(v)) found.push({ where: `${relative(ROOT, f)}:${k}`, name: v.name, schema: v.schema });
      else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          if (isStrict(v2)) found.push({ where: `${relative(ROOT, f)}:${k}.${k2}`, name: v2.name, schema: v2.schema });
        }
      }
    }
  }
  // 같은 스키마 객체를 여러 export가 다시 내보내면 하나로
  return [...new Map(found.map((x) => [x.schema, x])).values()];
}
