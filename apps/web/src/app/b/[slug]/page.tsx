import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicLinkUrl } from "@cre/core";
import { db, env } from "@/lib/db";

export const dynamic = "force-dynamic";

const PLATFORM_PARAM: Record<string, "INSTAGRAM" | "TIKTOK" | "FACEBOOK"> = {
  ig: "INSTAGRAM",
  instagram: "INSTAGRAM",
  tt: "TIKTOK",
  tiktok: "TIKTOK",
  fb: "FACEBOOK",
  facebook: "FACEBOOK",
};

async function load(slug: string) {
  return db().brand.findFirst({
    where: { slug, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, description: true, colors: true },
  });
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const brand = await load((await params).slug);
  return { title: brand ? `${brand.name} — links` : "Links", robots: { index: false } };
}

/**
 * Public "link in bio" page. Instagram/TikTok captions are not clickable, so each brand's bio points here
 * (e.g. /b/demo-tools?p=ig); every button is the content's own tracked link for that platform.
 */
export default async function BioPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ p?: string }>;
}) {
  const { slug } = await params;
  const platform = PLATFORM_PARAM[((await searchParams).p ?? "").toLowerCase()];
  const brand = await load(slug);
  if (!brand) notFound();
  const projects = await db().contentProject.findMany({
    where: { brandId: brand.id, status: { in: ["PUBLISHED", "ANALYTICS_PENDING"] } },
    orderBy: { publishedAt: "desc" },
    take: 20,
    select: {
      id: true,
      title: true,
      product: { select: { title: true } },
      variants: {
        where: { status: "PUBLISHED", trackedLinkId: { not: null } },
        select: { platform: true, trackedLink: true },
      },
    },
  });
  const appUrl = env().APP_URL;
  const items = projects
    .map((p) => {
      const variant = p.variants.find((v) => v.platform === platform) ?? p.variants[0];
      return variant?.trackedLink
        ? { id: p.id, title: p.product?.title ?? p.title, url: publicLinkUrl(appUrl, variant.trackedLink) }
        : null;
    })
    .filter((x): x is { id: string; title: string; url: string } => x !== null);
  const primary = ((brand.colors ?? {}) as { primary?: string }).primary ?? "#4f46e5";

  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 py-10">
      <h1 className="text-center text-2xl font-bold">{brand.name}</h1>
      {brand.description ? (
        <p className="mt-2 text-center text-sm text-zinc-600">{brand.description}</p>
      ) : null}
      <p className="mt-4 rounded-lg bg-zinc-100 px-3 py-2 text-center text-xs text-zinc-600">
        Some links below are affiliate or referral links: we may earn a commission if you buy, at no extra
        cost to you.
      </p>
      <ul className="mt-6 space-y-3">
        {items.map((i) => (
          <li key={i.id}>
            <a
              href={i.url}
              rel="sponsored noopener"
              className="block rounded-xl px-4 py-4 text-center font-semibold text-white shadow-sm"
              style={{ background: primary }}
            >
              {i.title}
            </a>
          </li>
        ))}
      </ul>
      {items.length === 0 ? <p className="mt-6 text-center text-sm text-zinc-500">No links yet.</p> : null}
    </main>
  );
}
