"use client";

/**
 * components/math-scene-player.tsx — 2단 되감기 플레이어를 화면에 띄운다 (docs/harness/math.md §3-4)
 *
 * 호출 E가 만든 HTML 조각(`sceneHtml`)을 `buildSceneSrcdoc()`으로 감싸 **sandbox iframe**에
 * 넣고, 키트가 보내는 `ready`/`step`/`error`를 듣는다.
 *
 * ┌─ 이 파일에서 절대 하면 안 되는 것 ─────────────────────────────────────────┐
 * │ 1. `sandbox`에 **`allow-same-origin`을 추가하지 마라.** `allow-scripts`와    │
 * │    함께 주면 iframe이 부모와 같은 출처가 되어 스스로 sandbox 속성을 지울 수   │
 * │    있다 — 격리가 사실상 없어진다(§3-4). 값은 `SCENE_IFRAME_SANDBOX` 하나뿐.  │
 * │ 2. `sceneHtml`을 `dangerouslySetInnerHTML`로 본문에 붙이지 마라. AI가 쓴     │
 * │    코드이고, 격리가 유일한 방어선이다(정적 검사는 2차 방어다).               │
 * │ 3. `srcDoc`은 **프로퍼티로** 넘긴다. 문자열을 손으로 조립해 속성에 끼우면      │
 * │    따옴표 이스케이프가 어긋나 문서가 깨진다.                                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ── 폴백이 이 컴포넌트의 절반이다 (§3-4 앱 측 처리 4번) ─────────────────────
 * `SCENE_READY_TIMEOUT_MS`(3초) 안에 `ready`가 없거나 `error`가 **한 번이라도** 오면
 * 플레이어를 걷어내고 텍스트 3막만 남긴다. 폴백이 없으면 화면에 **빈 사각형**이 남고,
 * 아이는 "그림이 있어야 하는데 안 뜬다"로 읽는다.
 *
 * 폴백 시 화면에는 **아무것도 그리지 않는다**(사과 문구도 없다). §3-4가 "플레이어 숨기고
 * 텍스트 3막만"이라고 못 박은 대로다 — 텍스트 3막은 그 자체로 완결이라 없는 그림을
 * 굳이 알릴 이유가 없고, 실패 안내는 아이에게 불안만 준다. 사유는 **콘솔 로그**로 남긴다:
 * 이 로그가 §8 "그 유형을 1단 렌더러로 승격할" 근거다.
 *
 * ── 메시지 처리에서 틀리기 쉬운 세 가지 (player-builder 인수인계 §7-3, 전부 실측) ─
 * 1. 발신자는 **`event.source`로 가린다.** `origin` 대조로는 못 가린다 — 샌드박스
 *    iframe의 origin은 문자열 `"null"`이라 어떤 창과도 구별되지 않는다.
 * 2. 같은 `index`의 `step`이 **연달아 두 번 올 수 있다**(이동 1건 + ResizeObserver의
 *    높이 변화 1건). 멱등하게 처리한다 — 높이만 반영하고 아무 상태도 누적하지 않는다.
 * 3. `error` 뒤에 `ready`가 올 수 있다(거부된 Promise 사례). **`error`가 이긴다.**
 *    그래서 판정은 "마지막 메시지"가 아니라 **한 번 fallback이면 끝**이다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildSceneSrcdoc,
  loadPlayerKit,
  SCENE_IFRAME_SANDBOX,
  SCENE_READY_TIMEOUT_MS,
} from "@/lib/scene/html";

/** 폴백 사유 — 로그에 그대로 실린다. 유형별 집계가 §8의 목적이다 */
type FallbackReason =
  | "kit-load-failed" // /player-kit/*를 못 읽었다 (배포 누락·네트워크)
  | "ready-timeout" // 3초 안에 ready가 없었다 (Kit.mount 미호출·무한 루프 등)
  | "scene-error"; // 키트가 error를 보냈다 (render 예외·전역 예외·거부된 Promise)

/** 키트가 부모에게 보내는 메시지 (public/player-kit/kit.js) */
interface KitMessage {
  source: "player-kit";
  type: "ready" | "step" | "error";
  steps?: number;
  index?: number;
  total?: number;
  done?: boolean;
  height?: number;
  message?: string;
  detail?: string | null;
}

function isKitMessage(data: unknown): data is KitMessage {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  return (
    m.source === "player-kit" &&
    (m.type === "ready" || m.type === "step" || m.type === "error")
  );
}

/**
 * iframe 높이 하한·상한. 키트가 보내는 `height`를 그대로 믿되 터무니없는 값은 자른다
 * (AI가 짠 CSS가 `100vh` 같은 것을 쓰면 측정값이 계속 자라는 되먹임이 생긴다).
 */
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 2000;

export default function MathScenePlayer({ sceneHtml }: { sceneHtml: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  /** null이면 아직 화면 밖이거나 키트를 읽는 중이다 — 그때는 iframe을 아예 만들지 않는다 */
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [height, setHeight] = useState(MIN_HEIGHT);

  /**
   * 화면에 들어왔는가. **3초 타이머를 여기에 묶는 것이 핵심이다.**
   *
   * 샌드박스 iframe은 opaque origin이라 부모에게 cross-origin이고, 브라우저는 화면 밖의
   * cross-origin 프레임의 렌더링(rAF 포함)을 늦춘다. 키트의 `ready`는 rAF 2회 뒤에
   * 나가므로(`afterLayout` — 높이 0 버그 수정), 화면 밖에서 타이머를 돌리면 멀쩡한
   * 플레이어가 3초를 넘겨 **거짓 폴백**이 된다. 이 플레이어는 3막 아래에 있어 대개
   * 처음에는 화면 밖이다 — 스크롤해서 보이기 시작할 때 비로소 세기 시작한다.
   */
  const [visible, setVisible] = useState(false);

  /** 폴백은 되돌리지 않는다. 사유를 남기고 상태를 잠근다 (error 뒤 ready가 와도 error가 이긴다) */
  const fellBack = useRef(false);
  const goFallback = useCallback((reason: FallbackReason, detail?: string) => {
    if (fellBack.current) return;
    fellBack.current = true;
    setFallback(true);
    // §8 운영 로그 — 이 유형이 반복되면 1단 전용 렌더러로 승격할 신호다
    console.warn(
      JSON.stringify({
        scope: "math-scene-player",
        fallback: reason,
        detail: detail ?? null,
      }),
    );
  }, []);

  // ── 1. 화면에 들어왔는지 감시 ────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // IntersectionObserver가 없으면(아주 옛 브라우저) 그냥 바로 시작한다 — 없는 것보다 낫다
    if (typeof IntersectionObserver !== "function") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      // 조금 미리 띄워 두면 스크롤이 닿을 때쯤 이미 준비돼 있다
      { rootMargin: "200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // ── 2. 키트를 읽어 srcdoc 조립 ───────────────────────────────────────────
  useEffect(() => {
    if (!visible || fellBack.current) return;
    let alive = true;
    loadPlayerKit()
      .then((kit) => {
        if (!alive) return;
        setSrcDoc(buildSceneSrcdoc({ html: sceneHtml, kitCss: kit.css, kitJs: kit.js }));
      })
      .catch((err: unknown) => {
        if (!alive) return;
        goFallback("kit-load-failed", err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [visible, sceneHtml, goFallback]);

  // ── 3. 메시지 수신 ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!srcDoc) return;

    function onMessage(e: MessageEvent) {
      // **발신자 판별은 event.source로만.** origin은 샌드박스 iframe에서 "null" 문자열이라
      // 다른 어떤 창과도 구별되지 않는다(실측). contentWindow 동일성만이 유일한 근거다.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (!isKitMessage(e.data)) return;
      const msg = e.data;

      if (msg.type === "error") {
        // error가 이긴다 — 뒤에 ready가 와도 폴백을 되돌리지 않는다
        goFallback("scene-error", msg.message);
        return;
      }
      if (fellBack.current) return;

      // ready와 step 둘 다 높이만 반영한다. 같은 index의 step이 연달아 두 번 와도
      // (이동 1건 + 높이 변화 1건) 결과가 같으므로 멱등하다.
      if (typeof msg.height === "number" && Number.isFinite(msg.height)) {
        const h = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(msg.height)));
        setHeight((prev) => (Math.abs(prev - h) < 4 ? prev : h));
      }
      if (msg.type === "ready") setReady(true);
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [srcDoc, goFallback]);

  // ── 4. ready 타임아웃 (§3-4 4번) ─────────────────────────────────────────
  useEffect(() => {
    if (!srcDoc || ready || fellBack.current) return;
    const timer = setTimeout(() => goFallback("ready-timeout"), SCENE_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [srcDoc, ready, goFallback]);

  // 폴백이면 흔적을 남기지 않는다 — 텍스트 3막이 이미 온전하다
  if (fallback) return null;

  return (
    /*
     * 인쇄에서는 숨긴다(`print-hide`).
     * 이유: (1) 종이에는 **한 단계만** 찍힌다 — 되감기 플레이어의 값어치는 앞뒤로 오가는
     * 데 있고, 멈춘 한 장은 3막 텍스트가 이미 더 자세히 말한다. (2) 인쇄 시점에 아직
     * `ready` 전이면 빈 칸이 통째로 찍힌다. (3) 브라우저마다 iframe 인쇄 동작이 갈린다.
     * 새 CSS를 만들지 않았다 — `.print-hide`는 globals.css에 이미 있는 훅이다.
     */
    <section ref={wrapRef} className="print-hide mt-8">
      <h2 className="t-section-title">🎬 움직이는 그림으로 다시 보기</h2>
      <p className="t-caption mt-1">
        {ready
          ? "‘다음 ▶’을 눌러 한 단계씩 보고, ‘◀ 이전’으로 되감아 보세요."
          : "그림을 준비하고 있어요…"}
      </p>

      <div className="u-card mt-3 overflow-hidden">
        {srcDoc && (
          <iframe
            ref={iframeRef}
            /*
             * srcDoc / sandbox — 이 두 줄이 격리의 전부다. 위 경고 상자를 읽지 않고
             * 고치지 마라. sandbox 값은 상수(`allow-scripts`) 하나이고 여기서 덧붙이지 않는다.
             */
            srcDoc={srcDoc}
            sandbox={SCENE_IFRAME_SANDBOX}
            title="움직이는 설명 플레이어"
            /*
             * ready 전에는 1px로 접어 둔다. `display:none`이 아닌 이유: 그러면 iframe 안의
             * 레이아웃이 잡히지 않아 키트가 `ready`를 보내지 못하고, 3초 뒤 거짓 폴백이 된다.
             * 높이는 키트가 보내 주는 실측값(`ready.height`·`step.height`)을 따른다 —
             * iframe은 내용에 맞춰 자라지 않으므로 부모가 대신 키운다.
             */
            style={{ height: ready ? `${height}px` : "1px" }}
            className="block w-full border-0"
          />
        )}
      </div>
    </section>
  );
}
