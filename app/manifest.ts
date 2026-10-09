/** app/manifest.ts — PWA 매니페스트(가족 스트릭 강화 스펙 §6-1). 홈 화면 추가(iOS 16.4+ 웹 푸시의 전제)용 */
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "은우학습",
    short_name: "은우학습",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [{ src: "/apple-icon.png", sizes: "180x180", type: "image/png" }, { src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
