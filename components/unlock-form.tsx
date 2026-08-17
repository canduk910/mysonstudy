"use client";

/**
 * 잠금 해제 폼 (클라이언트) — `/unlock` 화면의 입력부.
 *
 * POST /api/unlock → 성공 시 쿠키(httpOnly)가 붙고 `next` 경로로 이동한다.
 * `next`는 **서버(app/unlock/page.tsx)에서 이미 안전하게 정리된 내부 경로**만 받는다.
 * 실패·잠금 메시지는 서버가 준 messageKo를 그대로 보여준다(클라이언트가 PIN을
 * 알 필요도, 힌트를 만들 필요도 없다).
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

interface UnlockFormProps {
  /** 잠금 해제 후 이동할 내부 경로 (서버에서 sanitize 완료) */
  next: string;
}

interface UnlockResponse {
  ok?: boolean;
  messageKo?: string;
}

export default function UnlockForm({ next }: UnlockFormProps) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const value = pin.trim();
    if (!value) {
      setErrorKo("PIN을 입력해 주세요.");
      return;
    }

    setBusy(true);
    setErrorKo(null);
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: value }),
      });
      const data: UnlockResponse = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        setPin("");
        // 쿠키가 붙은 뒤라야 게이트를 통과한다 — 서버 렌더를 새로 받도록 replace + refresh
        router.replace(next);
        router.refresh();
        return;
      }

      setErrorKo(data.messageKo ?? "잠금을 풀지 못했어요. 잠시 뒤 다시 시도해 주세요.");
    } catch {
      setErrorKo("연결이 끊겼어요. 인터넷 상태를 확인하고 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-8">
      <label htmlFor="pin" className="u-label text-center">
        PIN 번호
      </label>
      {/* 아이도 쓸 수 있게 크게(--fs-pin 26px) + 숫자 키패드 */}
      <input
        id="pin"
        name="pin"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        autoFocus
        maxLength={8}
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        disabled={busy}
        aria-invalid={errorKo ? true : undefined}
        className="u-input h-16 text-center text-pin tracking-[0.35em]"
      />

      {errorKo && (
        <p role="alert" className="u-box-accent t-question-ko mt-4 text-ink">
          {errorKo}
        </p>
      )}

      <button type="submit" disabled={busy} className="u-btn u-btn-primary mt-4 w-full">
        {busy ? "확인 중…" : "잠금 풀기"}
      </button>
    </form>
  );
}
