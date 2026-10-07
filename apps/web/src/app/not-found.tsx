import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-bold">Not found</h1>
      <p className="text-sm text-zinc-500">
        This page or item does not exist (or belongs to another workspace).
      </p>
      <Link href="/dashboard" className="btn-secondary">
        Back to dashboard
      </Link>
    </main>
  );
}
