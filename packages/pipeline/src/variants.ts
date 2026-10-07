import { CONTENT_DEFAULTS } from "@cre/config";
import { createTrackedLink, publicLinkUrl, type DisclosureRuleInput } from "@cre/core";
import type { DbClient, Platform, TrackedLink } from "@cre/db";
import { PLATFORM_LIMITS, type SocialPlatform } from "@cre/publishing";

/**
 * Platform variants: composing captions (with disclosures in the right place), CTA wording and the tracked
 * link each variant promotes. Pure helpers + one DB resolver.
 */

export interface LinkTarget {
  destinationUrl: string;
  /** false when the program forbids redirect links (publish the raw URL with a static sub-id) */
  redirect: boolean;
  subIdParam: string | null;
  affiliateLinkId: string | null;
  /** UTMs only on destinations we own — affiliate URLs must stay untouched */
  appendUtm: boolean;
  /** program-specific disclosure (e.g. Amazon's associate statement), added to the caption end */
  programDisclosure: string | null;
  /** a commission / referral relationship exists → advertising disclosure required */
  isAffiliate: boolean;
  /** the brand's own product (promoting its own business) */
  isOwnProduct: boolean;
}

/** Where the content sends people: affiliate link → offer landing page → product URL. */
export async function resolveLinkTarget(
  db: DbClient,
  project: { productId: string | null; offerId: string | null },
): Promise<LinkTarget | null> {
  if (!project.productId) return null;
  const product = await db.product.findUnique({
    where: { id: project.productId },
    include: {
      affiliateLinks: {
        where: { status: "ACTIVE" },
        include: { affiliateProgram: true },
        orderBy: { createdAt: "asc" },
      },
      offers: {
        where: { status: "ACTIVE" },
        include: { affiliateProgram: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!product) return null;
  const offer =
    (project.offerId ? product.offers.find((o) => o.id === project.offerId) : undefined) ??
    product.offers.find((o) => o.isPrimary) ??
    product.offers[0] ??
    null;
  const link =
    (offer ? product.affiliateLinks.find((l) => l.offerId === offer.id) : undefined) ??
    product.affiliateLinks[0] ??
    null;
  const program = link?.affiliateProgram ?? offer?.affiliateProgram ?? null;
  const destinationUrl = link?.url ?? product.affiliateUrl ?? offer?.landingUrl ?? product.productUrl ?? null;
  if (!destinationUrl) return null;
  const own = product.kind === "OWN_PRODUCT";
  // Conservative: any program, affiliate URL or commission means a material connection that must be disclosed.
  const isAffiliate =
    !own &&
    Boolean(program || link || product.affiliateUrl || product.commissionRate || product.commissionFixedUsd);
  return {
    destinationUrl,
    redirect: program?.redirectPolicy !== "DIRECT_LINK_ONLY",
    subIdParam: link?.subIdParam ?? program?.subIdParam ?? null,
    affiliateLinkId: link?.id ?? null,
    appendUtm: own,
    programDisclosure: isAffiliate ? (program?.disclosureText ?? null) : null,
    isAffiliate,
    isOwnProduct: own,
  };
}

/** The tracked link for one variant (created once, then reused by every re-render). */
export async function ensureVariantLink(
  db: DbClient,
  input: {
    variant: { id: string; trackedLinkId: string | null; platform: Platform };
    project: { id: string; workspaceId: string; brandId: string; productId: string | null };
    brandSlug: string;
    target: LinkTarget;
  },
): Promise<TrackedLink> {
  if (input.variant.trackedLinkId) {
    const existing = await db.trackedLink.findUnique({ where: { id: input.variant.trackedLinkId } });
    if (existing) return existing;
  }
  const link = await createTrackedLink(db, {
    workspaceId: input.project.workspaceId,
    brandId: input.project.brandId,
    destinationUrl: input.target.destinationUrl,
    redirect: input.target.redirect,
    productId: input.project.productId,
    projectId: input.project.id,
    affiliateLinkId: input.target.affiliateLinkId,
    platform: input.variant.platform,
    campaign: input.brandSlug,
    subIdParam: input.target.subIdParam,
    appendUtm: input.target.appendUtm,
    utm: {
      source: input.variant.platform.toLowerCase(),
      medium: "social",
      campaign: input.brandSlug,
      content: input.project.id,
    },
  });
  await db.contentVariant.update({ where: { id: input.variant.id }, data: { trackedLinkId: link.id } });
  return link;
}

/* ------------------------------------------------------------------ disclosures ----------------- */

export interface DisclosurePlan {
  captionStart: string[];
  captionEnd: string[];
  onScreen: string[];
}

/**
 * Which disclosures apply where. `platform = null` means "the master video" (rules for any target platform).
 * Commercial rules (AFFILIATE / AD / SPONSORED) apply to monetised content; AI_GENERATED only when realistic
 * AI imagery or video is used.
 */
export function planDisclosures(
  rules: readonly DisclosureRuleInput[],
  platform: string | null,
  flags: { isMonetized: boolean; aiGenerated: boolean },
): DisclosurePlan {
  const plan: DisclosurePlan = { captionStart: [], captionEnd: [], onScreen: [] };
  for (const rule of rules) {
    if (platform && rule.platform && rule.platform !== platform) continue;
    const applies = rule.kind === "AI_GENERATED" ? flags.aiGenerated : flags.isMonetized;
    if (!applies) continue;
    switch (rule.placement) {
      case "CAPTION_START":
        plan.captionStart.push(rule.text);
        break;
      case "CAPTION_END":
        plan.captionEnd.push(rule.text);
        break;
      case "ON_SCREEN":
        plan.onScreen.push(rule.text);
        break;
      case "CAPTION_AND_ON_SCREEN":
        plan.captionStart.push(rule.text);
        plan.onScreen.push(rule.text);
        break;
    }
  }
  return {
    captionStart: unique(plan.captionStart),
    captionEnd: unique(plan.captionEnd),
    onScreen: unique(plan.onScreen),
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = v.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------------------ captions -------------------- */

export function normalizeHashtags(tags: readonly string[], max: number): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const clean = `#${t.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "")}`;
    if (clean.length > 1 && !out.some((o) => o.toLowerCase() === clean.toLowerCase())) out.push(clean);
  }
  return out.slice(0, Math.max(0, max));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ComposeCaptionInput {
  platform: SocialPlatform;
  /** LLM-written caption body (no disclosure, no link) */
  body: string;
  hashtags: string[];
  disclosure: DisclosurePlan;
  programDisclosure: string | null;
  /** clickable link (Facebook); IG/TikTok captions use "link in bio" instead */
  linkUrl: string | null;
}

export interface ComposedCaption {
  caption: string;
  hashtags: string[];
  disclosureText: string | null;
}

/** Disclosure first (clear and conspicuous), then copy, link, hashtags and end-of-caption labels. */
export function composeCaption(input: ComposeCaptionInput): ComposedCaption {
  const limit = Math.min(
    PLATFORM_LIMITS[input.platform].captionMaxChars,
    CONTENT_DEFAULTS.captionMaxChars[input.platform] ?? 2200,
  );
  const disclosures = [
    ...input.disclosure.captionStart,
    ...input.disclosure.captionEnd,
    ...(input.programDisclosure ? [input.programDisclosure] : []),
  ];
  // the model was told not to write disclosures; strip any it wrote anyway so they appear exactly once
  let body = input.body;
  for (const d of disclosures) body = body.replace(new RegExp(escapeRegExp(d), "gi"), "");
  body = body
    .replace(/(^|\s)#ad\b/gi, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const disclosureHasAd = disclosures.some((d) => /#ad\b/i.test(d));
  const hashtags = normalizeHashtags(
    input.hashtags,
    CONTENT_DEFAULTS.maxHashtags[input.platform] ?? 5,
  ).filter(
    (h) =>
      !(disclosureHasAd && h.toLowerCase() === "#ad") &&
      !new RegExp(`${escapeRegExp(h)}(?![\\p{L}\\p{N}_])`, "iu").test(body),
  );
  const head = input.disclosure.captionStart.join(" · ");
  const tail = unique([
    ...(input.programDisclosure ? [input.programDisclosure] : []),
    ...input.disclosure.captionEnd,
  ]).filter((t) => !head.toLowerCase().includes(t.toLowerCase()));
  const fixed = [
    head,
    input.linkUrl ? `Link: ${input.linkUrl}` : "",
    hashtags.join(" "),
    tail.join("\n"),
  ].filter(Boolean);
  const fixedLen = fixed.join("\n\n").length + 2;
  if (body.length > limit - fixedLen) body = `${body.slice(0, Math.max(0, limit - fixedLen - 1)).trimEnd()}…`;
  const parts = [
    head,
    body,
    input.linkUrl ? `Link: ${input.linkUrl}` : "",
    hashtags.join(" "),
    tail.join("\n"),
  ].filter(Boolean);
  return {
    caption: parts.join("\n\n"),
    hashtags,
    disclosureText: disclosures.length ? unique(disclosures).join(" | ") : null,
  };
}

/** Text on the CTA button of the master video (works on every platform). */
export function ctaButtonText(ctaType: string | null, cta: string | null): string {
  switch (ctaType ?? "") {
    case "comment_keyword": {
      const keyword = /"([^"]{2,16})"|\b([A-Z]{3,12})\b/.exec(cta ?? "");
      return keyword ? `Comment "${keyword[1] ?? keyword[2]}"` : "Comment below";
    }
    case "save_post":
      return "Save this post";
    case "dm_keyword":
      return "Send us a DM";
    case "follow":
      return "Follow for more";
    default:
      return "Link in bio";
  }
}

/** Public link for a variant (tracking redirect, or the raw URL for direct-link-only programs). */
export function variantLinkUrl(appUrl: string, link: TrackedLink | null): string | null {
  return link ? publicLinkUrl(appUrl, link) : null;
}
