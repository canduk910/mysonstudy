"use client";

/**
 * useToeicShadowSettings — 따라 말하기 설정(반복·틈 켬/끔·틈 단계·한국어/영어 틀 소개)을 **기기에 기억**하는 훅
 * (docs/harness/toeic.md §12-5-2 "반복·틈·소개는 기기에 기억한다(localStorage, try/catch — 없으면 기본값)").
 *
 * 공략 읽기 "영어만"의 따라 말할 틈 **단계**도 같은 기기 설정을 쓴다(§12-4 — "틈 길이 세 단계는 템플릿 따라 말하기와 같은 함수·같은
 * 기기 설정"). 읽기 탭의 틈 **켬/끔 토글**은 기억하지 않는다(기본 끔 — 매번 끈 채로 연다).
 *
 * hydration: 첫 렌더는 기본값(SSR과 같다), 저장값은 마운트 뒤 effect에서 읽는다(app-patterns §1). 해석·검증은 순수 함수
 * parseShadowSettings(lib/toeic-guide-view) 하나.
 */

import { useCallback, useEffect, useState } from "react";
import { TOEIC_SHADOW_SETTINGS_DEFAULT, parseShadowSettings, type ToeicShadowSettings } from "@/lib/toeic-guide-view";

export const TOEIC_SHADOW_SETTINGS_KEY = "toeic-shadow-settings:v1";

export function useToeicShadowSettings(): [ToeicShadowSettings, (patch: Partial<ToeicShadowSettings>) => void] {
  const [settings, setSettings] = useState<ToeicShadowSettings>(TOEIC_SHADOW_SETTINGS_DEFAULT);

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(TOEIC_SHADOW_SETTINGS_KEY);
    } catch {
      /* 프라이빗 모드 등 — 기본값 */
    }
    if (raw !== null) setSettings(parseShadowSettings(raw));
  }, []);

  const update = useCallback((patch: Partial<ToeicShadowSettings>) => {
    setSettings((prev) => {
      const next = parseShadowSettings(JSON.stringify({ ...prev, ...patch }));
      try {
        window.localStorage.setItem(TOEIC_SHADOW_SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* 저장 못 해도 이번 화면에서는 쓴다 */
      }
      return next;
    });
  }, []);

  return [settings, update];
}
