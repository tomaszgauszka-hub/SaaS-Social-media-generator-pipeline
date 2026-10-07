import type { ReactNode } from "react";
import { Nav, type NavItem } from "@/components/nav";
import { requireUser } from "@/lib/auth";
import { db, env } from "@/lib/db";
import { logout } from "../actions/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const [waiting, failedJobs] = await Promise.all([
    db().contentProject.count({ where: { workspaceId: user.workspaceId, status: "WAITING_APPROVAL" } }),
    db().generationJob.count({
      where: { workspaceId: user.workspaceId, status: { in: ["FAILED", "DEAD_LETTER"] } },
    }),
  ]);
  const e = env();
  const items: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: "◧", primary: true },
    { href: "/approval", label: "Approve", icon: "✓", badge: waiting, primary: true },
    { href: "/content", label: "Content", icon: "▶", primary: true },
    { href: "/calendar", label: "Calendar", icon: "▦", primary: true },
    { href: "/analytics", label: "Analytics", icon: "↗" },
    { href: "/costs", label: "Costs", icon: "$" },
    { href: "/revenue", label: "Revenue", icon: "€" },
    { href: "/brands", label: "Brands", icon: "★" },
    { href: "/products", label: "Products", icon: "▤" },
    { href: "/creative-benchmark", label: "Creative lab", icon: "◆" },
    { href: "/jobs", label: "Jobs", icon: "⚙", badge: failedJobs },
    { href: "/settings/providers", label: "Settings", icon: "⚑" },
  ];
  const mock = e.MOCK_AI || e.MOCK_MEDIA || e.MOCK_SOCIAL;
  const footer = (
    <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
      <div className="min-w-0">
        <div className="truncate font-semibold text-zinc-700">{user.email}</div>
        <div className="truncate">{user.workspaceName}</div>
      </div>
      <form action={logout}>
        <button type="submit" className="btn-ghost min-h-8 px-2 text-xs">
          Sign out
        </button>
      </form>
    </div>
  );
  return (
    <div className="min-h-dvh">
      <Nav items={items} footer={footer} />
      <div className="md:pl-60">
        {mock || !e.PUBLISHING_ENABLED ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
            {mock ? (
              <span>
                <strong>MOCK MODE</strong> —{" "}
                {[e.MOCK_AI && "AI", e.MOCK_MEDIA && "media", e.MOCK_SOCIAL && "social"]
                  .filter(Boolean)
                  .join(", ")}{" "}
                simulated, zero spend.
              </span>
            ) : null}
            {!e.PUBLISHING_ENABLED ? (
              <span>Publishing kill switch is ON (nothing is posted publicly).</span>
            ) : null}
          </div>
        ) : null}
        <main className="mx-auto max-w-7xl px-4 pt-4 pb-28 md:px-8 md:pt-8 md:pb-12">{children}</main>
      </div>
    </div>
  );
}
