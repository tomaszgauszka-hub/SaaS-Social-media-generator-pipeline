import { randomBytes } from "node:crypto";
import type { WorkspaceRole } from "@cre/db";
import { sha256Hex } from "@cre/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "./db";

/**
 * Session auth: an opaque random token in an httpOnly cookie; only its SHA-256 is stored, so a database leak
 * does not leak usable sessions. Authorization is always checked server-side (pages, actions, route handlers).
 */
export const SESSION_COOKIE = "cre_session";
const SESSION_DAYS = 30;
const TOUCH_INTERVAL_MS = 10 * 60_000;

export interface CurrentUser {
  userId: string;
  email: string;
  name: string | null;
  workspaceId: string;
  workspaceName: string;
  timezone: string;
  role: WorkspaceRole;
  sessionId: string;
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db().session.create({ data: { userId, tokenHash: sha256Hex(token), expiresAt } });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** The signed-in user (deduplicated per request), or null. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 100) return null;
  const session = await db().session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: {
      user: {
        include: { memberships: { include: { workspace: true }, orderBy: { createdAt: "asc" }, take: 1 } },
      },
    },
  });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  const membership = session.user.memberships[0];
  if (!membership) return null;
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db().session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    workspaceId: membership.workspaceId,
    workspaceName: membership.workspace.name,
    timezone: membership.workspace.timezone,
    role: membership.role,
    sessionId: session.id,
  };
});

/** Pages: redirect to /login when signed out. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

const WRITE_ROLES: WorkspaceRole[] = ["OWNER", "ADMIN", "EDITOR"];
const ADMIN_ROLES: WorkspaceRole[] = ["OWNER", "ADMIN"];

export class AuthorizationError extends Error {}

/** Server actions / route handlers: throw instead of redirecting. */
export async function requireActor(level: "write" | "admin" = "write"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthorizationError("Not signed in");
  const allowed = level === "admin" ? ADMIN_ROLES : WRITE_ROLES;
  if (!allowed.includes(user.role)) throw new AuthorizationError("Your role does not allow this action");
  return user;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db().session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
  jar.delete(SESSION_COOKIE);
}
