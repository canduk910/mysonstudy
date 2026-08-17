/**
 * POST /api/unlock — PIN 확인 후 잠금 해제 쿠키 발급
 *
 * 이 라우트는 게이트 예외(proxy.ts의 PUBLIC_PATHS)다 — 자기 자신을 보호해야 하므로
 * 시도 제한을 여기에 둔다. 제한은 2겹이다:
 *   (1) 전역 백스톱 — 헤더를 전혀 보지 않는다. 10분 내 전체 오답 30회 → 창이 끝날 때까지 429.
 *   (2) 키별(≈IP) 카운터 — 10회 오답 → 10분 잠금. 키는 x-forwarded-for의 **마지막** 항목.
 * (1)이 있는 이유: (2)의 키는 프런트엔드가 붙이는 헤더에 의존하므로 구성에 따라 신뢰도가
 * 달라진다. 인덱스 판단이 틀려도 (1)이 남는다 — QA pin-1 F1.
 *
 * 응답 shape (qa-inspector 교차 검증용):
 * - 200: { ok: true, messageKo }                      + Set-Cookie(__session)
 * - 400: { ok: false, error: "invalid_input", messageKo }
 * - 401: { ok: false, error: "wrong_pin", messageKo, remainingAttempts: number }
 * - 429: { ok: false, error: "too_many_attempts", messageKo, retryAfterSec: number }
 * - 503: { ok: false, error: "not_configured", messageKo }
 *
 * 응답에는 PIN 값도, 길이·자릿수 같은 힌트도 절대 담지 않는다.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  UNLOCK_COOKIE,
  createUnlockToken,
  gateMode,
  getAppPin,
  timingSafeEqual,
  unlockCookieAttrs,
} from "@/lib/auth";

export const runtime = "nodejs";
// 쿠키를 다루므로 항상 요청 시점에 실행
export const dynamic = "force-dynamic";

const bodySchema = z.object({ pin: z.string().min(1).max(64) });

// ---------------------------------------------------------------------------
// 시도 제한 — 2겹(IP별 카운터 + 헤더 무관 전역 백스톱)
//
// 한계(의도적): 두 카운터 모두 **프로세스 메모리**에만 있다. Cloud Run 인스턴스가
// 재시작·스케일아웃되면 초기화되고, 인스턴스별로 따로 센다. 가족용 규모(동시
// 인스턴스 1개 수준)에서는 무차별 대입을 늦추는 데 충분하고, 이보다 강한 제한은
// 외부 저장소(Redis 등)를 요구해 과설계다 — SPEC §1 "과설계 금지".
// ---------------------------------------------------------------------------

const MAX_FAILS = 10;
const LOCK_MS = 10 * 60 * 1000; // 10분
const ENTRY_TTL_MS = 60 * 60 * 1000; // 1시간 미사용 항목은 정리
const MAX_ENTRIES = 1000; // attempts Map 상한 — 키 회전 공격의 메모리 고갈 차단
const GLOBAL_MAX_FAILS = 30; // 전역 백스톱: 10분 창 안 전체 오답 허용치
const GLOBAL_WINDOW_MS = 10 * 60 * 1000; // 전역 백스톱 창 = 10분

interface Attempt {
  fails: number;
  lockedUntil: number;
  seenAt: number;
}

const attempts = new Map<string, Attempt>();

function sweep(now: number) {
  // 항상 실행한다(예전엔 size<100이면 건너뛰었다 — 그 조건이 상한 없는 증가를 허용했다).
  for (const [key, a] of attempts) {
    if (now - a.seenAt > ENTRY_TTL_MS && a.lockedUntil <= now) attempts.delete(key);
  }
  if (attempts.size <= MAX_ENTRIES) return;
  // 상한 초과 = 키를 회전시키는 공격 신호. seenAt이 오래된 항목부터 잘라내 메모리를 묶는다.
  // (잠금 중인 항목이 잘릴 수 있지만, 아래 전역 백스톱이 헤더와 무관하게 남는다.)
  const oldestFirst = [...attempts.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
  const excess = attempts.size - MAX_ENTRIES;
  for (let i = 0; i < excess; i++) attempts.delete(oldestFirst[i][0]);
}

// --- 전역 백스톱 (헤더를 전혀 보지 않는다 → 우회 불가) --------------------------
// IP 키는 프런트엔드가 붙이는 헤더에 의존하므로 구성에 따라 신뢰도가 달라진다.
// 그래서 헤더와 무관한 2차 방어를 둔다: 10분 창 안에서 **전체** 오답이
// GLOBAL_MAX_FAILS를 넘으면 창이 끝날 때까지 모든 요청을 429로 막는다.
// 정상 사용은 기기당 180일에 1회 PIN 입력이라 오탐 비용이 사실상 0이고,
// 공격자가 x-forwarded-for를 아무리 회전시켜도 이 카운터는 늘어난다.
let globalFails = 0;
let globalWindowStart = 0;
let globalLockLogged = false;

/** 전역 잠금이 걸려 있으면 해제 시각(ms), 아니면 0 */
function globalLockUntil(now: number): number {
  if (globalWindowStart === 0 || now - globalWindowStart >= GLOBAL_WINDOW_MS) return 0; // 창 만료
  return globalFails >= GLOBAL_MAX_FAILS ? globalWindowStart + GLOBAL_WINDOW_MS : 0;
}

function recordGlobalFail(now: number) {
  if (globalWindowStart === 0 || now - globalWindowStart >= GLOBAL_WINDOW_MS) {
    globalWindowStart = now; // 새 창 시작
    globalFails = 0;
    globalLockLogged = false;
  }
  globalFails += 1;
  if (globalFails === GLOBAL_MAX_FAILS && !globalLockLogged) {
    globalLockLogged = true;
    // 운영자가 Cloud Run 로그에서 공격을 알아챌 수 있게 1회만 남긴다(PIN·본문은 찍지 않는다).
    console.warn(
      `[unlock] 전역 시도 제한 발동 — 10분 내 오답 ${GLOBAL_MAX_FAILS}회, 창 종료까지 모든 요청 429`,
    );
  }
}

// 배포 후 1회만: 실제 프런트엔드가 붙이는 x-forwarded-for 형태를 확인하기 위한 로그.
// (어느 인덱스가 신뢰 가능한지 실측으로 확정하려는 목적 — 확인 후 지워도 된다.)
let xffLogged = false;

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const parts = (xff ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // **마지막** 항목을 쓴다 = 우리 앞단(Cloud Run GFE / Firebase Hosting)이 덧붙인 값.
  // 앞쪽 값은 클라이언트가 통째로 위조할 수 있어(GCP 프런트엔드는 받은 XFF를 버리지 않고
  // 뒤에 덧붙인다) 키로 쓰면 시도 제한이 무효가 된다 — QA pin-1 F1 실측.
  // 앞단 구성상 마지막 값이 상수(LB 주소)로 나오면 이 카운터는 사실상 전체 공용이 되는데,
  // 그래도 "느슨해지는" 쪽이 아니라 "빡빡해지는" 쪽이라 안전하다. 실제 형태는 아래 1회 로그로 확인.
  const trusted = parts.length > 0 ? parts[parts.length - 1] : null;
  const key = trusted || req.headers.get("x-real-ip")?.trim() || "unknown";
  if (!xffLogged) {
    xffLogged = true;
    console.info(
      `[unlock] x-forwarded-for="${xff ?? ""}" (항목 ${parts.length}개) → 시도 제한 키="${key}"`,
    );
  }
  return key;
}

function noStore(res: NextResponse): NextResponse {
  res.headers.set("cache-control", "no-store, must-revalidate");
  return res;
}

function tooManyAttempts(retryAfterSec: number): NextResponse {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return noStore(
    NextResponse.json(
      {
        ok: false,
        error: "too_many_attempts",
        messageKo: `너무 여러 번 틀렸어요. 약 ${minutes}분 뒤에 다시 시도해 주세요.`,
        retryAfterSec,
      },
      { status: 429, headers: { "retry-after": String(retryAfterSec) } },
    ),
  );
}

export async function POST(req: Request) {
  const now = Date.now();
  const mode = gateMode();

  if (mode === "misconfigured") {
    return noStore(
      NextResponse.json(
        {
          ok: false,
          error: "not_configured",
          messageKo: "서버에 잠금 PIN(APP_PIN)이 설정되지 않았어요. 관리자에게 알려 주세요.",
        },
        { status: 503 },
      ),
    );
  }

  if (mode === "open") {
    // 개발 환경 + APP_PIN 미설정 — 게이트가 없으므로 쿠키도 필요 없다
    return noStore(
      NextResponse.json({ ok: true, messageKo: "개발 환경이라 잠금이 없어요." }),
    );
  }

  // (1) 전역 백스톱 — 헤더를 보지 않으므로 어떤 우회도 통하지 않는다. 가장 먼저 확인한다.
  const globalUntil = globalLockUntil(now);
  if (globalUntil > now) {
    return tooManyAttempts(Math.ceil((globalUntil - now) / 1000));
  }

  // (2) 키별(≈IP) 카운터
  const ip = clientIp(req);
  sweep(now);
  const attempt = attempts.get(ip);

  if (attempt && attempt.lockedUntil > now) {
    return tooManyAttempts(Math.ceil((attempt.lockedUntil - now) / 1000));
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return noStore(
      NextResponse.json(
        { ok: false, error: "invalid_input", messageKo: "PIN을 입력해 주세요." },
        { status: 400 },
      ),
    );
  }

  const appPin = getAppPin();
  // mode === "enforce"이면 appPin은 반드시 존재하지만, 타입 좁히기 겸 방어
  if (!appPin) {
    return noStore(
      NextResponse.json(
        { ok: false, error: "not_configured", messageKo: "서버 잠금 설정을 확인해 주세요." },
        { status: 503 },
      ),
    );
  }

  if (!timingSafeEqual(parsed.data.pin.trim(), appPin)) {
    recordGlobalFail(now); // 헤더와 무관한 전역 카운터 — 키를 회전시켜도 반드시 늘어난다
    const fails = (attempt?.fails ?? 0) + 1;
    const locked = fails >= MAX_FAILS;
    attempts.set(ip, {
      fails: locked ? 0 : fails, // 잠금에 들어가면 카운터를 리셋하고 시간으로 막는다
      lockedUntil: locked ? now + LOCK_MS : 0,
      seenAt: now,
    });

    if (locked) {
      return tooManyAttempts(Math.ceil(LOCK_MS / 1000));
    }

    // 이 오답으로 전역 백스톱이 걸렸다면(마지막 한 번) 그 사실을 바로 알린다
    const nowGlobalUntil = globalLockUntil(now);
    if (nowGlobalUntil > now) {
      return tooManyAttempts(Math.ceil((nowGlobalUntil - now) / 1000));
    }

    return noStore(
      NextResponse.json(
        {
          ok: false,
          error: "wrong_pin",
          messageKo: "PIN이 맞지 않아요. 다시 입력해 주세요.",
          remainingAttempts: MAX_FAILS - fails,
        },
        { status: 401 },
      ),
    );
  }

  // 성공 — 카운터 해제 후 서명 쿠키 발급.
  // 정답을 아는 사람은 가족뿐이므로 전역 카운터도 함께 비운다(공격 중이라도 가족은 들어올 수 있게).
  attempts.delete(ip);
  globalFails = 0;
  globalWindowStart = 0;
  globalLockLogged = false;
  const res = NextResponse.json({ ok: true, messageKo: "잠금을 풀었어요." });
  res.cookies.set({
    name: UNLOCK_COOKIE,
    value: await createUnlockToken(appPin, now),
    ...unlockCookieAttrs(),
  });
  return noStore(res);
}
