"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { verifyPassword } from "@cre/shared";
import { z } from "zod";
import { createSession, destroySession } from "@/lib/auth";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";

const LoginInput = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
});

export interface LoginState {
  error: string | null;
}

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = LoginInput.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: "Enter your email and password." };
  const email = parsed.data.email.toLowerCase();
  const ip = clientIp(await headers()) ?? "unknown";
  const limited = rateLimit(`login:${ip}:${email}`, 8, 15 * 60_000);
  if (!limited.ok)
    return { error: `Too many attempts. Try again in ${Math.ceil(limited.retryAfterSec / 60)} min.` };
  const user = await db().user.findUnique({ where: { email } });
  // constant-ish work whether or not the user exists
  const ok = await verifyPassword(
    parsed.data.password,
    user?.passwordHash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA",
  );
  if (!user || !ok) return { error: "Invalid email or password." };
  await createSession(user.id);
  await db().user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  redirect("/dashboard");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}
