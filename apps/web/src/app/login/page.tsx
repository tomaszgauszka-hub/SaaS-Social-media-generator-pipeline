import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-black text-white">
            CR
          </div>
          <h1 className="text-xl font-bold">Content Revenue Engine</h1>
          <p className="text-sm text-zinc-500">Approve, reject, regenerate — the pipeline does the rest.</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
