import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 가족용 소규모 앱 — 기본 설정으로 충분 (SPEC §1)
  // dev 전용: 같은 Wi-Fi의 폰에서 접속하면 Next dev가 크로스 오리진 리소스를 차단하므로 허용.
  // 공유기 DHCP로 IP가 바뀌면 여기에 새 IP를 추가할 것 (프로덕션 빌드에는 영향 없음).
  allowedDevOrigins: ["192.168.10.126"],
};

export default nextConfig;
