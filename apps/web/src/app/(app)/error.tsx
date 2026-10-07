"use client";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="card mx-auto mt-10 max-w-lg p-6 text-center">
      <h1 className="text-lg font-bold">Something went wrong</h1>
      <p className="mt-2 text-sm text-zinc-500">
        The error was logged on the server{error.digest ? ` (reference ${error.digest})` : ""}.
      </p>
      <button type="button" className="btn-primary mt-4" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
