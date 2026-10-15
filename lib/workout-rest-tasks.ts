/**
 * lib/workout-rest-tasks.ts — 휴식 알림 예약 수단(SPEC §19-9): Google Cloud Tasks HTTP 태스크. 서버 전용.
 *
 * - 새 의존성 없이 이미 쓰는 firebase-admin의 ADC(`applicationDefault().getAccessToken()` — cloud-platform 범위)로 토큰을 받아
 *   Cloud Tasks REST v2 `projects.locations.queues.tasks.create`를 부른다. Cloud Run에서는 런타임 서비스 계정이다.
 * - 태스크는 `scheduleTime`에 `POST {PUBLIC_BASE_URL}/api/push/workout-rest/fire`를 헤더 `x-push-secret`(= PUSH_CRON_SECRET, 틱과 같은
 *   관례)으로 부른다. 요청 모양은 순수 모듈 `buildCloudTaskBody`가 정한다(eval이 본다).
 * - 설정(`restAlertConfig`)이 하나라도 비면 null → 라우트가 501(로컬 dev는 늘 꺼짐 — 실제 큐를 부르지 않는다).
 */

import "server-only";
import { applicationDefault } from "firebase-admin/app";
import { pushConfigured } from "./push-send";
import { buildCloudTaskBody, CLOUD_TASKS_QUEUE_PATTERN, normalizeBaseUrl, type RestAlertTaskPayload } from "./workout-rest-alert";

export const WORKOUT_REST_FIRE_PATH = "/api/push/workout-rest/fire";
const TASKS_TIMEOUT_MS = 8_000;

export interface RestAlertConfig {
  queue: string;
  fireUrl: string;
  secret: string;
}

/** 켜짐 조건 — VAPID(푸시)·큐·기본 URL·발송 비밀이 모두 있어야 한다. 하나라도 없으면 null */
export function restAlertConfig(): RestAlertConfig | null {
  if (!pushConfigured()) return null;
  const queue = process.env.WORKOUT_REST_TASKS_QUEUE?.trim() ?? "";
  const base = normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
  const secret = process.env.PUSH_CRON_SECRET?.trim() ?? "";
  if (!CLOUD_TASKS_QUEUE_PATTERN.test(queue) || !base || !secret) return null;
  return { queue, fireUrl: `${base}${WORKOUT_REST_FIRE_PATH}`, secret };
}

/** 태스크 하나 만들기. 실패는 throw(라우트가 500으로) — 응답 본문·토큰·비밀은 로그에 남기지 않는다 */
export async function createRestAlertTask(cfg: RestAlertConfig, payload: RestAlertTaskPayload): Promise<void> {
  const { access_token } = await applicationDefault().getAccessToken();
  const body = buildCloudTaskBody({ fireUrl: cfg.fireUrl, secret: cfg.secret, payload }, (s) => Buffer.from(s, "utf8").toString("base64"));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TASKS_TIMEOUT_MS);
  try {
    const res = await fetch(`https://cloudtasks.googleapis.com/v2/${cfg.queue}/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`cloud_tasks_${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
