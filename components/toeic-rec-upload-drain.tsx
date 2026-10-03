"use client";

/**
 * components/toeic-rec-upload-drain.tsx — 서버 컴포넌트 화면(아빠의 영어 허브)에 업로드 대기열 계기만 꽂는 빈 조각 (docs/harness/toeic.md §13-3·§13-6)
 *
 * 배포 뒤 아빠 iPhone에 남은 옛 녹음은 "아빠의 영어를 한 번 열면" 올라간다(SPEC §20-11 이행). 허브는 정적 서버 컴포넌트라 이 조각을 둔다.
 * 그리는 것은 없다.
 */

import { useToeicRecUploadDrain } from "@/components/use-toeic-rec-uploads";

export default function ToeicRecUploadDrain() {
  useToeicRecUploadDrain();
  return null;
}
