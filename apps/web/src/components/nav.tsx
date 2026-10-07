"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: number;
  primary?: boolean;
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Sidebar on desktop, bottom tab bar + "more" sheet on phones (the approval queue is one tap away). */
export function Nav({ items, footer }: { items: NavItem[]; footer: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const primary = items.filter((i) => i.primary);
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-zinc-200 bg-white md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-xs font-black text-white">
            CR
          </div>
          <span className="text-sm font-bold">Content Revenue Engine</span>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Main">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${isActive(pathname, item.href) ? "bg-brand-50 text-brand-700" : "text-zinc-700 hover:bg-zinc-100"}`}
            >
              <span aria-hidden className="w-5 text-center">
                {item.icon}
              </span>
              <span className="flex-1">{item.label}</span>
              {item.badge ? (
                <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-bold text-white">
                  {item.badge}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>
        <div className="border-t border-zinc-200 p-3">{footer}</div>
      </aside>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Main"
      >
        {primary.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${isActive(pathname, item.href) ? "text-brand-700" : "text-zinc-500"}`}
          >
            <span aria-hidden className="text-lg leading-none">
              {item.icon}
            </span>
            {item.label}
            {item.badge ? (
              <span className="absolute top-1 right-[22%] min-w-5 rounded-full bg-rose-600 px-1 text-center text-[10px] font-bold text-white">
                {item.badge}
              </span>
            ) : null}
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-zinc-500"
        >
          <span aria-hidden className="text-lg leading-none">
            ☰
          </span>
          More
        </button>
      </nav>

      {open ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="grid grid-cols-3 gap-2">
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`flex flex-col items-center gap-1 rounded-xl p-3 text-xs font-medium ${isActive(pathname, item.href) ? "bg-brand-50 text-brand-700" : "bg-zinc-50 text-zinc-700"}`}
                >
                  <span aria-hidden className="text-xl">
                    {item.icon}
                  </span>
                  {item.label}
                </Link>
              ))}
            </div>
            <div className="mt-4 border-t border-zinc-200 pt-3">{footer}</div>
          </div>
        </div>
      ) : null}
    </>
  );
}
