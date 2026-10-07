import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { decimalFieldToMicros, type Prisma } from "@cre/db";
import {
  addDisclosureAction,
  addSlotAction,
  removeDisclosureAction,
  removeSlotAction,
  requestIdeasAction,
  updateBrandAction,
  updateBudgetAction,
} from "@/app/actions/brands";
import { ActionButton } from "@/components/action-button";
import { ActionForm } from "@/components/action-form";
import { BrandFields } from "@/components/brand-form";
import { Badge, Card, PageHeader, StatusBadge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { date } from "@/lib/format";

export const metadata: Metadata = { title: "Brand" };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function BrandPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const prisma = db();
  const brand = await prisma.brand.findFirst({
    where: { id, workspaceId: user.workspaceId },
    include: {
      budget: true,
      publishingSlots: { orderBy: [{ platform: "asc" }, { timeOfDay: "asc" }] },
      disclosureRules: { orderBy: { createdAt: "asc" } },
      socialAccounts: { orderBy: { platform: "asc" } },
      performanceProfiles: { orderBy: { version: "desc" }, take: 1 },
      projects: {
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: { id: true, title: true, status: true, updatedAt: true },
      },
      _count: { select: { products: true } },
    },
  });
  if (!brand) notFound();
  const canAdmin = user.role === "OWNER" || user.role === "ADMIN";
  const b = brand.budget;
  const m = (v: Prisma.Decimal | null | undefined) =>
    v ? (decimalFieldToMicros(v) / 1_000_000).toString() : "";
  const profile = brand.performanceProfiles[0];

  return (
    <>
      <PageHeader
        title={brand.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={brand.status} /> {brand.niche} ·{" "}
            <Link href={`/products?brand=${brand.id}`} className="underline">
              {brand._count.products} products
            </Link>{" "}
            · public bio page{" "}
            <Link href={`/b/${brand.slug}`} className="underline">
              /b/{brand.slug}
            </Link>
          </span>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Generate content">
            <ActionForm
              action={requestIdeasAction}
              submitLabel="Generate ideas"
              className="flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="brandId" value={brand.id} />
              <label>
                <span className="label">Ideas to produce</span>
                <select name="count" defaultValue={String(brand.ideasPerCycle)} className="input w-24">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="label">Quality</span>
                <select name="quality" defaultValue="STANDARD" className="input w-36">
                  <option value="DRAFT">Draft (cheapest)</option>
                  <option value="STANDARD">Standard</option>
                  <option value="PREMIUM">Premium (if evidence)</option>
                </select>
              </label>
            </ActionForm>
            <p className="mt-2 text-xs text-zinc-500">
              The router still decides the production tier from product evidence and budgets — premium never
              runs for unproven products.
            </p>
          </Card>

          <Card title="Brand settings">
            {canAdmin ? (
              <ActionForm action={updateBrandAction} submitLabel="Save brand">
                <input type="hidden" name="brandId" value={brand.id} />
                <BrandFields brand={brand} />
              </ActionForm>
            ) : (
              <p className="text-sm text-zinc-500">Only owners and admins can edit brand settings.</p>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Budget (enforced before every paid call)">
            <ActionForm action={updateBudgetAction} submitLabel="Save budget" className="space-y-3">
              <input type="hidden" name="scope" value="brand" />
              <input type="hidden" name="brandId" value={brand.id} />
              {(
                [
                  ["dailyLimitUsd", "Daily limit (USD)", b?.dailyLimitUsd],
                  ["weeklyLimitUsd", "Weekly limit (USD)", b?.weeklyLimitUsd],
                  ["monthlyLimitUsd", "Monthly limit (USD)", b?.monthlyLimitUsd],
                  ["maxContentCostUsd", "Max cost per content (USD)", b?.maxContentCostUsd],
                  ["maxAiVideoCostUsd", "Max AI video per content (USD)", b?.maxAiVideoCostUsd],
                ] as const
              ).map(([name, label, value]) => (
                <label key={name} className="block">
                  <span className="label">{label}</span>
                  <input
                    name={name}
                    inputMode="decimal"
                    defaultValue={m(value)}
                    placeholder="no limit"
                    className="input"
                  />
                </label>
              ))}
              <label className="block">
                <span className="label">Max regenerations per content</span>
                <input
                  name="maxRegenerations"
                  inputMode="numeric"
                  defaultValue={b?.maxRegenerations ?? ""}
                  placeholder="no limit"
                  className="input"
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="isEnforced"
                  defaultChecked={b?.isEnforced ?? true}
                  className="size-4"
                />{" "}
                Enforce
              </label>
            </ActionForm>
          </Card>

          <Card title="Posting slots">
            <ul className="mb-3 space-y-1 text-sm">
              {brand.publishingSlots.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span>
                    <Badge tone="indigo">{s.platform.toLowerCase()}</Badge> {s.timeOfDay}{" "}
                    {s.dayOfWeek === null ? "daily" : DAYS[s.dayOfWeek]}{" "}
                    <span className="text-xs text-zinc-500">({brand.timezone})</span>
                  </span>
                  {canAdmin ? (
                    <ActionButton
                      action={removeSlotAction.bind(null, { slotId: s.id })}
                      label="Remove"
                      className="btn-ghost min-h-8 px-2 text-xs"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
            {canAdmin ? (
              <ActionForm
                action={addSlotAction}
                submitLabel="Add slot"
                className="flex flex-wrap items-end gap-2"
                submitClassName="btn-secondary"
              >
                <input type="hidden" name="brandId" value={brand.id} />
                <select name="platform" className="input w-32" aria-label="Platform">
                  <option value="TIKTOK">TikTok</option>
                  <option value="INSTAGRAM">Instagram</option>
                  <option value="FACEBOOK">Facebook</option>
                </select>
                <input
                  name="timeOfDay"
                  type="time"
                  required
                  defaultValue="12:00"
                  className="input w-28"
                  aria-label="Time"
                />
                <select name="dayOfWeek" className="input w-28" aria-label="Day">
                  <option value="">Every day</option>
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </ActionForm>
            ) : null}
          </Card>

          <Card title="Disclosure rules">
            <ul className="mb-3 space-y-2 text-sm">
              {brand.disclosureRules.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-2">
                  <span>
                    <Badge tone={r.kind === "AI_GENERATED" ? "violet" : "amber"}>
                      {r.kind.toLowerCase().replace("_", " ")}
                    </Badge>{" "}
                    “{r.text}”
                    <span className="block text-xs text-zinc-500">
                      {r.placement.toLowerCase().replace(/_/g, " ")} ·{" "}
                      {r.platform?.toLowerCase() ?? "all platforms"}
                      {r.jurisdiction ? ` · ${r.jurisdiction}` : ""}
                    </span>
                  </span>
                  {canAdmin ? (
                    <ActionButton
                      action={removeDisclosureAction.bind(null, { ruleId: r.id })}
                      label="Remove"
                      confirm="Remove this disclosure rule?"
                      className="btn-ghost min-h-8 px-2 text-xs"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
            {canAdmin ? (
              <ActionForm
                action={addDisclosureAction}
                submitLabel="Add rule"
                className="space-y-2"
                submitClassName="btn-secondary"
              >
                <input type="hidden" name="brandId" value={brand.id} />
                <div className="flex flex-wrap gap-2">
                  <select name="kind" className="input w-36" aria-label="Kind">
                    <option value="AFFILIATE">Affiliate</option>
                    <option value="AD">Ad</option>
                    <option value="SPONSORED">Sponsored</option>
                    <option value="AI_GENERATED">AI generated</option>
                  </select>
                  <select name="placement" className="input w-48" aria-label="Placement">
                    <option value="CAPTION_AND_ON_SCREEN">Caption + on screen</option>
                    <option value="CAPTION_START">Caption start</option>
                    <option value="CAPTION_END">Caption end</option>
                    <option value="ON_SCREEN">On screen</option>
                  </select>
                  <select name="platform" className="input w-36" aria-label="Platform">
                    <option value="">All platforms</option>
                    <option value="TIKTOK">TikTok</option>
                    <option value="INSTAGRAM">Instagram</option>
                    <option value="FACEBOOK">Facebook</option>
                  </select>
                </div>
                <input
                  name="text"
                  required
                  placeholder="#ad · affiliate link"
                  className="input"
                  aria-label="Disclosure text"
                />
                <input
                  name="jurisdiction"
                  placeholder="Jurisdiction (optional, e.g. US-FTC)"
                  className="input"
                />
              </ActionForm>
            ) : null}
          </Card>

          <Card
            title="Social accounts"
            actions={
              <Link href="/settings/providers" className="text-xs font-semibold text-brand-700">
                Connect
              </Link>
            }
          >
            <ul className="space-y-1 text-sm">
              {brand.socialAccounts.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span>
                    {a.platform.toLowerCase()} · {a.handle}
                  </span>
                  <StatusBadge status={a.status} />
                </li>
              ))}
              {brand.socialAccounts.length === 0 ? <li className="text-zinc-500">No accounts yet.</li> : null}
            </ul>
          </Card>

          <Card title="Learning loop">
            {profile ? (
              <>
                <p className="mb-2 text-xs text-zinc-500">
                  Profile v{profile.version} · {profile.sampleSize} posts ·{" "}
                  {date(profile.createdAt, user.timezone)} — injected into ideation and script prompts.
                </p>
                <pre className="text-xs whitespace-pre-wrap text-zinc-700">
                  {profile.promptText || "Not enough data yet."}
                </pre>
              </>
            ) : (
              <p className="text-sm text-zinc-500">Builds automatically once posts have analytics.</p>
            )}
          </Card>

          <Card title="Recent content">
            <ul className="space-y-1 text-sm">
              {brand.projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <Link href={`/content/${p.id}`} className="min-w-0 truncate hover:underline">
                    {p.title}
                  </Link>
                  <StatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
