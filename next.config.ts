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
    ];
  },
};

export default nextConfig;
