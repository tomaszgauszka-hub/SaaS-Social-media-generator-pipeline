import type { Metadata } from "next";
import { decimalFieldToMicros, decimalToNumber } from "@cre/db";
import { addDays } from "@cre/shared";
import { createProductAction, importProductsAction, setProductStatusAction } from "@/app/actions/products";
import { ActionButton } from "@/components/action-button";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, EmptyState, FilterLink, PageHeader, StatusBadge, Table } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { date, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ brand?: string }> }) {
  const user = await requireUser();
  const { brand } = await searchParams;
  const prisma = db();
  const [brands, programs] = await Promise.all([
    prisma.brand.findMany({
      where: { workspaceId: user.workspaceId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.affiliateProgram.findMany({
      where: { workspaceId: user.workspaceId, isActive: true },
      select: { id: true, name: true, redirectPolicy: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const brandId = brands.some((b) => b.id === brand) ? brand : undefined;
  const products = await prisma.product.findMany({
    where: { workspaceId: user.workspaceId, ...(brandId ? { brandId } : {}), status: { not: "ARCHIVED" } },
    orderBy: [{ status: "asc" }, { title: "asc" }],
    include: {
      brand: { select: { name: true } },
      offers: {
        where: { isPrimary: true },
        include: { affiliateProgram: { select: { name: true, redirectPolicy: true } } },
      },
      _count: { select: { projects: true } },
    },
  });
  const revenue = products.length
    ? await prisma.revenueEntry.groupBy({
        by: ["productId"],
        where: { productId: { in: products.map((p) => p.id) } },
        _sum: { amountUsd: true },
      })
    : [];
  const staleBefore = addDays(new Date(), -7);

  return (
    <>
      <PageHeader
        title="Products & offers"
        subtitle="Generation may only use the sourced facts listed here. Prices older than 7 days are never shown in content."
      />
      {brands.length > 1 ? (
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          <FilterLink href="/products" active={!brandId}>
            All brands
          </FilterLink>
          {brands.map((b) => (
            <FilterLink key={b.id} href={`/products?brand=${b.id}`} active={brandId === b.id}>
              {b.name}
            </FilterLink>
          ))}
        </div>
      ) : null}
      {products.length === 0 ? (
        <EmptyState title="No products yet">Add one below or import a CSV.</EmptyState>
      ) : (
        <div className="card mb-6">
          <Table
            head={
              <>
                <th className="th">Product</th>
                <th className="th hidden md:table-cell">Program</th>
                <th className="th">Price</th>
                <th className="th hidden sm:table-cell">Commission</th>
                <th className="th hidden lg:table-cell">Revenue</th>
                <th className="th">Status</th>
              </>
            }
          >
            {products.map((p) => {
              const facts = Array.isArray(p.facts) ? p.facts.length : 0;
              const rate = decimalToNumber(p.commissionRate);
              const stale = p.price !== null && (!p.priceCheckedAt || p.priceCheckedAt < staleBefore);
              const offer = p.offers[0];
              const rev = revenue.find((r) => r.productId === p.id)?._sum.amountUsd ?? null;
              return (
                <tr key={p.id}>
                  <td className="td">
                    <div className="font-semibold">{p.title}</div>
                    <div className="text-xs text-zinc-500">
                      {p.brand.name} · {p.kind.toLowerCase().replace("_", " ")} · {facts} sourced fact(s) ·{" "}
                      {p._count.projects} content
                      {p.sku ? ` · ${p.sku}` : ""}
                    </div>
                  </td>
                  <td className="td hidden text-xs md:table-cell">
                    {offer?.affiliateProgram?.name ?? "—"}
                    {offer?.affiliateProgram?.redirectPolicy === "DIRECT_LINK_ONLY" ? (
                      <Badge tone="amber">direct link only</Badge>
                    ) : null}
                  </td>
                  <td className="td tabular-nums">
                    {p.price ? usd(decimalFieldToMicros(p.price)) : "—"}
                    {stale ? (
                      <div className="text-xs text-amber-700">
                        stale · {date(p.priceCheckedAt, user.timezone)}
                      </div>
                    ) : null}
                  </td>
                  <td className="td hidden tabular-nums sm:table-cell">
                    {p.commissionFixedUsd
                      ? usd(decimalFieldToMicros(p.commissionFixedUsd))
                      : rate !== null
                        ? `${(rate * 100).toFixed(1)}%`
                        : "—"}
                  </td>
                  <td className="td hidden tabular-nums lg:table-cell">{usd(decimalFieldToMicros(rev))}</td>
                  <td className="td">
                    <div className="flex flex-col items-start gap-1">
                      <StatusBadge status={p.status} />
                      {p.status === "ACTIVE" ? (
                        <ActionButton
                          action={setProductStatusAction.bind(null, { productId: p.id, status: "PAUSED" })}
                          label="Pause"
                          className="btn-ghost min-h-7 px-2 text-xs"
                        />
                      ) : (
                        <ActionButton
                          action={setProductStatusAction.bind(null, { productId: p.id, status: "ACTIVE" })}
                          label="Activate"
                          className="btn-ghost min-h-7 px-2 text-xs"
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Add product">
          <ActionForm action={createProductAction} submitLabel="Save product">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="label">Brand</span>
                <select name="brandId" defaultValue={brandId ?? brands[0]?.id} className="input">
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Kind</span>
                <select name="kind" className="input">
                  <option value="PRODUCT">Affiliate product</option>
                  <option value="SERVICE">Service (lead gen)</option>
                  <option value="DIGITAL_PRODUCT">Digital product</option>
                  <option value="OWN_PRODUCT">Own product</option>
                  <option value="LEAD_MAGNET">Lead magnet</option>
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="label">Title</span>
                <input name="title" required maxLength={200} className="input" />
              </label>
              <label className="block">
                <span className="label">SKU / ASIN</span>
                <input name="sku" maxLength={80} className="input" />
              </label>
              <label className="block">
                <span className="label">Affiliate program</span>
                <select name="affiliateProgramId" className="input">
                  <option value="">None</option>
                  {programs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.redirectPolicy === "DIRECT_LINK_ONLY" ? " (direct link only)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="label">Product page URL</span>
                <input name="productUrl" type="url" className="input" />
              </label>
              <label className="block sm:col-span-2">
                <span className="label">Affiliate URL</span>
                <input name="affiliateUrl" type="url" className="input" />
              </label>
              <label className="block">
                <span className="label">Price (verified today)</span>
                <input name="price" inputMode="decimal" placeholder="49.99" className="input" />
              </label>
              <label className="block">
                <span className="label">Currency</span>
                <input name="currency" defaultValue="USD" maxLength={3} className="input" />
              </label>
              <label className="block">
                <span className="label">Commission %</span>
                <input name="commissionRate" inputMode="decimal" placeholder="4" className="input" />
              </label>
              <label className="block">
                <span className="label">Fixed payout (USD)</span>
                <input name="commissionFixedUsd" inputMode="decimal" placeholder="25" className="input" />
              </label>
              <label className="block sm:col-span-2">
                <span className="label">Image URLs (comma separated)</span>
                <input name="imageUrls" className="input" />
              </label>
              <label className="block sm:col-span-2">
                <span className="label">Facts — one per line: claim | source</span>
                <textarea
                  name="facts"
                  rows={4}
                  required
                  placeholder={
                    "2-speed gearbox: 0-450 / 0-1,500 RPM | manufacturer spec sheet\nIncludes 2 batteries and a charger | product page"
                  }
                  className="input font-mono text-xs"
                />
              </label>
              <label className="block">
                <span className="label">Category</span>
                <input name="category" className="input" />
              </label>
              <label className="block">
                <span className="label">Tags</span>
                <input name="tags" placeholder="drill, diy" className="input" />
              </label>
            </div>
          </ActionForm>
        </Card>
        <Card title="Import CSV">
          <ActionForm action={importProductsAction} submitLabel="Import">
            <label className="block">
              <span className="label">Brand</span>
              <select name="brandId" defaultValue={brandId ?? brands[0]?.id} className="input">
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">File</span>
              <input type="file" name="file" accept=".csv,text/csv" className="block text-sm" />
            </label>
            <label className="block">
              <span className="label">…or paste CSV</span>
              <textarea
                name="csv"
                rows={6}
                className="input font-mono text-xs"
                placeholder={
                  "sku,title,price,affiliate_url,commission_rate,facts,facts_source,program\nX1,Example Kit,49.99,https://…,4%,Fact one|Fact two,https://maker.example/spec,Demo Marketplace"
                }
              />
            </label>
            <p className="text-xs text-zinc-500">
              Columns: title (required), sku, kind, price, currency, product_url, affiliate_url, image_url,
              commission_rate, commission_fixed, tags, facts (| separated), facts_source, program. Rows with
              the same SKU update the product.
            </p>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
