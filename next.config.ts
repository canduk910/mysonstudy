import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 가족용 소규모 앱 — 기본 설정으로 충분 (SPEC §1)
  // dev 전용: 같은 Wi-Fi의 폰에서 접속하면 Next dev가 크로스 오리진 리소스를 차단하므로 허용.
  // 공유기 DHCP로 IP가 바뀌면 여기에 새 IP를 추가할 것 (프로덕션 빌드에는 영향 없음).
  allowedDevOrigins: ["192.168.10.126"],

  /**
   * 부모 문서 CSP — 되감기 플레이어 iframe이 **스스로 외부 주소로 이동하는 것**을 막는다.
   * (docs/harness/math.md §3-4 격리 · QA 리포트 `_workspace/qa_report_math-m25_1.md` P1)
   *
   * ── 왜 iframe 쪽 방어로는 부족한가 ──────────────────────────────────────────
   * `sandbox="allow-scripts"`는 **top 이동·팝업·폼**만 막는다. **프레임 자신의 이동은 막지
   * 않는다.** 그리고 srcdoc에 심은 CSP는 **문서 단위**라 이동이 일어나는 순간 사라진다.
   * 그래서 아래 세 경로가 전부 열려 있었다(전부 로컬에서 실측·재현했다):
   *   - `<a href="//호스트/x">` (스크립트로 자동 클릭 가능)
   *   - `location.href = "//호스트/x"`
   *   - `<meta http-equiv="refresh" content="0;url=//호스트/x">`  ← 스크립트조차 필요 없다
   * 이동에 성공하면 도착 문서에는 CSP가 없고, 그 문서가 부모에 `{source:'player-kit',
   * type:'ready'}`를 보내면 **`event.source`가 같은 프레임이라 통과한다** — 폴백이 취소되고
   * 외부 페이지가 아이 화면을 차지한다.
   *
   * **자식 프레임의 이동까지 관장하는 것은 부모 문서의 `frame-src`뿐이다.** 프레임이 어디로
   * 가든 그 검사는 프레임을 소유한 문서(=이 앱)의 정책으로 이뤄지므로, 안에서 지울 수 없다.
   *
   * ── 왜 `frame-src` 한 줄뿐인가 ─────────────────────────────────────────────
   * 지금 필요한 것은 프레임 이동 차단이다. CSP에 `default-src`를 두지 않았으므로 이 헤더는
   * **프레임 로드·이동 외에 아무것도 제한하지 않는다** — 스크립트·스타일·이미지·연결은
   * 지금과 똑같이 동작한다. 지시어를 더 조이고 싶으면 무엇이 깨지는지 먼저 확인하고,
   * 지시어마다 왜 안전한지 근거를 남겨라.
   *
   * `'none'`이 아니라 `'self'`인 이유: 플레이어는 `srcdoc` iframe이고(브라우저가 부모 정책을
   * 물려주는 자리라 이 값에서 정상 동작한다 — 실측), 앞으로 같은 출처 프레임을 쓸 여지도 남긴다.
   *
   * ── 적용 범위 ──────────────────────────────────────────────────────────────
   * `source: "/:path*"` — **모든 경로**다. 플레이어는 `/math/problem/[id]`와 `/math/new`
   * 두 곳에서 뜨고, 경로마다 헤더가 다르면 한쪽만 막힌다. `proxy.ts`(PIN 게이트)에 넣지
   * 않은 이유: 그쪽은 `isPublicPath()`에서 **먼저 return** 하는 분기가 있어 예외 경로가
   * 헤더를 못 받고, 인증 게이트에 무관한 보안 헤더를 섞으면 책임이 흐려진다.
   * 여기 두면 dev(`next dev`)·프로덕션(`next start`) 양쪽에 똑같이 실린다.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-src 'self'" }],
      },
      {
        /**
         * 페이지 문서·RSC 페이로드는 **공유 캐시에 저장 금지 + 매 요청 재검증**.
         * (2026-08-20 "배포했는데 옛 화면이 보인다" 사고 대응 — 실측표는
         *  `_workspace/build_app-builder_fresh-deploy_report.md`)
         *
         * ── 무엇이 문제였나 ──────────────────────────────────────────────────
         * Next는 프리렌더된 정적 페이지(`○`: `/`, `/math`, `/math/new`, `/math/photo`)의
         * HTML과 RSC 페이로드에 **`Cache-Control: s-maxage=31536000`**(1년)을 붙인다.
         * 이 값은 "배포할 때 CDN을 퍼지한다"는 전제 위에 서 있다. 그런데 우리 배포
         * 경로에는 **퍼지 단계가 없다**: 커스텀 도메인은 Firebase Hosting → Cloud Run
         * 리라이트(firebase.json)이고, GitHub Actions는 `gcloud run deploy`만 한다
         * (`.github/workflows/*`). Hosting CDN은 `firebase deploy --only hosting`
         * 때만 퍼지되므로, Cloud Run만 새로 올리면 **엣지에 남은 옛 HTML이 최대 1년
         * 그대로 나갈 수 있다.**
         *
         * 옛 HTML이 위험한 이유는 그 자체보다 그것이 물고 있는 자산이다. 프리렌더
         * HTML에는 `/_next/static/<BUILD_ID>/...`가 박혀 있고 그 청크는
         * `immutable`(1년)이라 브라우저에 그대로 남는다 → **옛 앱이 통째로 계속
         * 돈다.** 2026-08-20 로그에서 같은 세션의 `/math` 요청에 옛/새 `_rsc` 해시가
         * 섞여 있던 것이 이 상태다(옛 번들이 옛 해시를 계산한다).
         *
         * ── 왜 `private, no-cache, must-revalidate`인가 ──────────────────────
         * · `private` — 공유 캐시(Hosting CDN 등)가 **저장 자체를 못 한다**. 퍼지 단계가
         *   없는 배포 경로에서는 이게 유일하게 확실한 방법이다. 게다가 이 앱의 모든
         *   페이지는 PIN 뒤의 가족 전용 화면이라 엣지에 둘 이유가 애초에 없다.
         * · `no-cache` — 브라우저는 저장은 하되 **매번 원본에 물어본다**. 정적 페이지
         *   HTML에는 ETag가 붙으므로 바뀐 게 없으면 304(본문 0바이트)로 끝난다.
         *   `no-store`가 아닌 이유가 이것이다 — 신선도는 동일하고 왕복 비용만 아낀다.
         * · `must-revalidate` — `no-cache`를 무시하는 구형 캐시에 대한 이중 방어.
         *
         * 동적 페이지(`ƒ`)는 Next가 이미 `private, no-cache, no-store, max-age=0,
         * must-revalidate`를 주므로 이 규칙과 방향이 같다. 즉 **바뀌는 것은 정적
         * 페이지 4개(+RSC 페이로드)뿐**이고, 사이트 전체가 같은 정책으로 통일된다.
         *
         * ── 무엇을 건드리지 않는가 (source의 두 부정 선견) ────────────────────
         * · `(?!_next/|api/)` —
         *   `/_next/static/**`는 파일명에 콘텐츠 해시가 있어 `public, max-age=31536000,
         *   immutable`이 **정답**이다. 여기서 덮으면 배포마다 전 자산을 다시 받는다.
         *   (Next 문서는 이 값을 못 덮는다고 하지만 **실측 결과 덮인다** — 그래서
         *   제외가 필수다.)
         *   `/api/**`는 라우트 핸들러가 각자 정하게 둔다 — 예: `/api/version`은 스스로
         *   `no-store`를 건다. 여기서 덮으면 그 의도가 지워진다.
         * · `(?!.*\.[a-zA-Z0-9]+$)` — 확장자로 끝나는 경로 제외.
         *   `/player-kit/kit.js`·`/fonts/*.woff2`·`/icon.svg`·`/favicon.ico`는 지금
         *   `public, max-age=0`(= 매번 재검증)이라 이미 신선하다. 손댈 이유가 없다.
         *
         * PIN 잠금 응답(`proxy.ts`의 307·401)은 proxy가 직접 `no-store`를 박고,
         * **그 값이 이 규칙보다 우선한다**(실측). 잠금 응답은 그대로 `no-store`다.
         */
        source: "/:path((?!_next/|api/)(?!.*\\.[a-zA-Z0-9]+$).*)",
        headers: [{ key: "Cache-Control", value: "private, no-cache, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
