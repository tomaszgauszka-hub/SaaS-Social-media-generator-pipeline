import type { Metadata } from "next";
import Link from "next/link";
import { decimalFieldToMicros } from "@cre/db";
import {
  addConversionAction,
  addExpenseAction,
  createProgramAction,
  importConversionsAction,
  recordAdjustmentAction,
  rotatePostbackSecretAction,
} from "@/app/actions/revenue";
import { ActionButton } from "@/components/action-button";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, PageHeader, StatusBadge, Table } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { date, dateTime, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Revenue" };

export default async function RevenuePage() {
  const user = await requireUser();
  const prisma = db();
  const ws = user.workspaceId;
  const [conversions, programs, products, brands, expenses] = await Promise.all([
    prisma.conversion.findMany({
      where: { workspaceId: ws },
      orderBy: { occurredAt: "desc" },
      take: 40,
      include: {
        affiliateProgram: { select: { name: true } },
        project: { select: { id: true, title: true } },
        product: { select: { title: true } },
      },
    }),
    prisma.affiliateProgram.findMany({
      where: { workspaceId: ws },
      orderBy: { name: "asc" },
      include: { _count: { select: { conversions: true } } },
    }),
    prisma.product.findMany({
      where: { workspaceId: ws, status: { not: "ARCHIVED" } },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
    }),
    prisma.brand.findMany({
      where: { workspaceId: ws },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.expense.findMany({
      where: { workspaceId: ws },
      orderBy: { incurredOn: "desc" },
      take: 20,
      include: { brand: { select: { name: true } } },
    }),
  ]);
  const admin = user.role === "OWNER" || user.role === "ADMIN";

  return (
    <>
      <PageHeader
        title="Revenue attribution"
        subtitle="Conversions are matched to content through our click id (sub-id) → tracked link → variant → publication. Reversals book negative adjustments; history is never deleted."
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Recent conversions" className="xl:col-span-2">
          <Table
            head={
              <>
                <th className="th">When</th>
                <th className="th">Program / product</th>
                <th className="th hidden md:table-cell">Attributed to</th>
                <th className="th">Commission</th>
                <th className="th">Status</th>
              </>
            }
          >
            {conversions.map((c) => (
              <tr key={c.id}>
                <td className="td text-xs whitespace-nowrap">{dateTime(c.occurredAt, user.timezone)}</td>
                <td className="td text-xs">
                  {c.affiliateProgram?.name ?? "—"}
                  <div className="text-zinc-500">{c.product?.title ?? ""}</div>
                </td>
                <td className="td hidden text-xs md:table-cell">
                  {c.project ? (
                    <Link href={`/content/${c.project.id}`} className="hover:underline">
                      {c.project.title}
                    </Link>
                  ) : (
                    <span className="text-zinc-400">unattributed</span>
                  )}
                  <div className="text-zinc-500">
                    {c.platform?.toLowerCase() ?? ""} · {c.source}
                    {c.isSimulated ? " · simulated" : ""}
                  </div>
                </td>
                <td className="td tabular-nums">{usd(decimalFieldToMicros(c.commissionUsd))}</td>
                <td className="td">
                  <StatusBadge
                    status={
                      c.status === "APPROVED" ? "SUCCEEDED" : c.status === "REVERSED" ? "FAILED" : "PENDING"
                    }
                  />
                </td>
              </tr>
            ))}
          </Table>
          {conversions.length === 0 ? <p className="text-sm text-zinc-500">No conversions yet.</p> : null}
        </Card>

        <Card title="Add conversion">
          <ActionForm action={addConversionAction} submitLabel="Record" className="space-y-3">
            <select name="programId" className="input" aria-label="Program">
              <option value="">Program (optional)</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select name="productId" className="input" aria-label="Product">
              <option value="">Product (optional)</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <select name="type" className="input" aria-label="Type">
                <option value="SALE">Sale</option>
                <option value="LEAD">Lead</option>
                <option value="SIGNUP">Signup</option>
                <option value="INQUIRY">Inquiry</option>
                <option value="INSTALL">Install</option>
                <option value="OTHER">Other</option>
              </select>
              <select name="status" className="input" aria-label="Status">
                <option value="APPROVED">Approved</option>
                <option value="PENDING">Pending</option>
                <option value="REVERSED">Reversed</option>
              </select>
              <input
                name="commission"
                required
                inputMode="decimal"
                placeholder="Commission"
                className="input"
                aria-label="Commission"
              />
              <input
                name="currency"
                defaultValue="USD"
                maxLength={3}
                className="input"
                aria-label="Currency"
              />
              <input
                name="orderValue"
                inputMode="decimal"
                placeholder="Order value"
                className="input"
                aria-label="Order value"
              />
              <input
                name="fxRateToUsd"
                inputMode="decimal"
                placeholder="FX → USD (1)"
                className="input"
                aria-label="FX rate"
              />
            </div>
            <input name="occurredAt" type="datetime-local" className="input" aria-label="Date" />
            <input name="clickId" placeholder="Click id / sub-id (for attribution)" className="input" />
            <input name="externalId" placeholder="Network order id (deduplication)" className="input" />
          </ActionForm>
        </Card>

        <Card title="Import conversions CSV">
          <ActionForm action={importConversionsAction} submitLabel="Import" className="space-y-3">
            <select name="programId" className="input" aria-label="Default program">
              <option value="">Default program (optional)</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="file"
              name="file"
              accept=".csv,text/csv"
              className="block text-sm"
              aria-label="CSV file"
            />
            <textarea
              name="csv"
              rows={4}
              className="input font-mono text-xs"
              placeholder={
                "date,order_id,sub_id,commission,currency,status\n2026-10-01,A-1001,abc123XYZ,4.20,USD,approved"
              }
              aria-label="CSV text"
            />
            <input name="fx" placeholder="FX rates, e.g. EUR=1.08 GBP=1.27" className="input" />
          </ActionForm>
        </Card>

        <Card title="Affiliate programs & postbacks" className="xl:col-span-2">
          <ul className="space-y-2 text-sm">
            {programs.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 p-2"
              >
                <span>
                  <strong>{p.name}</strong> <span className="text-xs text-zinc-500">{p.network}</span>{" "}
                  {p.redirectPolicy === "DIRECT_LINK_ONLY" ? (
                    <Badge tone="amber">direct link only</Badge>
                  ) : (
                    <Badge tone="green">redirect ok</Badge>
                  )}{" "}
                  <span className="text-xs text-zinc-500">
                    sub-id param {p.subIdParam ?? "—"} · {p._count.conversions} conversions · postback{" "}
                    {p.postbackSecretHash ? "configured" : "not set"}
                  </span>
                </span>
                {admin ? (
                  <ActionButton
                    action={rotatePostbackSecretAction.bind(null, { programId: p.id })}
                    label={p.postbackSecretHash ? "Rotate postback token" : "Create postback URL"}
                    confirm={
                      p.postbackSecretHash
                        ? "The current postback URL will stop working. Continue?"
                        : undefined
                    }
                    className="btn-secondary min-h-8 px-3 text-xs"
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {admin ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-semibold">+ Add program</summary>
              <ActionForm
                action={createProgramAction}
                submitLabel="Add program"
                className="mt-3 grid gap-2 sm:grid-cols-2"
              >
                <input name="name" required placeholder="Name" className="input" />
                <input name="network" placeholder="Network (impact, awin, amazon…)" className="input" />
                <select name="redirectPolicy" className="input" aria-label="Redirect policy">
                  <option value="REDIRECT_ALLOWED">Redirect links allowed</option>
                  <option value="DIRECT_LINK_ONLY">Direct links only (no cloaking)</option>
                </select>
                <input name="subIdParam" placeholder="Sub-id parameter (e.g. subId1)" className="input" />
                <input
                  name="defaultCommissionRate"
                  inputMode="decimal"
                  placeholder="Default commission %"
                  className="input"
                />
                <input name="cookieDays" inputMode="numeric" placeholder="Cookie days" className="input" />
                <input name="website" type="url" placeholder="Website" className="input" />
                <input
                  name="disclosureText"
                  placeholder="Required disclosure text (if any)"
                  className="input"
                />
              </ActionForm>
            </details>
          ) : null}
        </Card>

        <Card title="Expenses (infrastructure, ads, tools)">
          <ul className="mb-3 space-y-1 text-sm">
            {expenses.map((e) => (
              <li key={e.id} className="flex justify-between gap-2">
                <span>
                  {e.category.toLowerCase()} {e.brand ? `· ${e.brand.name}` : "· shared"}
                  <span className="block text-xs text-zinc-500">
                    {date(e.incurredOn, user.timezone)} · {e.periodDays} days
                    {e.description ? ` · ${e.description}` : ""}
                  </span>
                </span>
                <span className="tabular-nums">{usd(decimalFieldToMicros(e.amountUsd))}</span>
              </li>
            ))}
            {expenses.length === 0 ? <li className="text-zinc-500">No expenses recorded.</li> : null}
          </ul>
          {admin ? (
            <>
              <ActionForm
                action={addExpenseAction}
                submitLabel="Add expense"
                className="grid grid-cols-2 gap-2"
                submitClassName="btn-secondary"
              >
                <select name="category" className="input" aria-label="Category">
                  <option value="INFRASTRUCTURE">Infrastructure</option>
                  <option value="ADS">Ads</option>
                  <option value="TOOLS">Tools</option>
                  <option value="OTHER">Other</option>
                </select>
                <input
                  name="amount"
                  required
                  inputMode="decimal"
                  placeholder="USD"
                  className="input"
                  aria-label="Amount"
                />
                <input name="incurredOn" type="date" className="input" aria-label="Date" />
                <input
                  name="periodDays"
                  inputMode="numeric"
                  defaultValue="30"
                  className="input"
                  aria-label="Period days"
                />
                <select name="brandId" className="input col-span-2" aria-label="Brand">
                  <option value="">Shared (all brands)</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <input name="description" placeholder="Description" className="input col-span-2" />
              </ActionForm>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-zinc-500">
                  Book a manual revenue adjustment
                </summary>
                <ActionForm
                  action={recordAdjustmentAction}
                  submitLabel="Book"
                  className="mt-2 grid grid-cols-2 gap-2"
                  submitClassName="btn-secondary"
                >
                  <input
                    name="amount"
                    required
                    inputMode="decimal"
                    placeholder="USD (negative = clawback)"
                    className="input"
                    aria-label="Amount"
                  />
                  <input name="note" placeholder="Note" className="input" aria-label="Note" />
                </ActionForm>
              </details>
            </>
          ) : null}
        </Card>
      </div>
    </>
  );
}
