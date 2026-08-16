import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-4xl" aria-hidden>🔍</p>
      <h1 className="text-xl font-bold text-ink">찾는 카드가 없어요</h1>
      <p className="text-sm text-sub">주소가 바뀌었거나 아직 만들지 않은 카드예요.</p>
      <Link
        href="/"
        className="mt-2 rounded-xl border border-line bg-card px-4 py-2.5 text-sm font-semibold text-ink"
      >
        ← 홈으로 돌아가기
      </Link>
    </main>
  );
}
