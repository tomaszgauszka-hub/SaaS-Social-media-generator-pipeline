import type { DbClient, Platform, TrackedLink } from "@cre/db";
import { hmacSha256Hex, randomCode } from "@cre/shared";

/**
 * Tracking layer: https://<app>/go/<code> → affiliate / landing URL, recording a privacy-minimised click.
 * Stored per click: link, content, brand, platform, campaign, UTM, referrer HOST, device/OS/browser FAMILY,
 * CDN country, bot flag and a daily-rotating salted visitor hash. Never: raw IP, full user agent, cookies.
 */

export const LINK_CODE_LENGTH = 7;

export function trackingUrl(appUrl: string, code: string): string {
  return `${appUrl.replace(/\/$/, "")}/go/${code}`;
}

export interface RedirectTarget {
  destinationUrl: string;
  subIdParam: string | null;
  appendUtm: boolean;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
}

/** Final redirect URL: destination + our click id as sub-id (attribution) + optional UTMs (own sites only). */
export function buildRedirectUrl(link: RedirectTarget, clickId: string): string {
  const url = new URL(link.destinationUrl);
  if (link.subIdParam) url.searchParams.set(link.subIdParam, clickId);
  if (link.appendUtm) {
    const utm: [string, string | null][] = [
      ["utm_source", link.utmSource],
      ["utm_medium", link.utmMedium],
      ["utm_campaign", link.utmCampaign],
      ["utm_content", link.utmContent],
      ["utm_term", link.utmTerm],
    ];
    for (const [k, v] of utm) if (v && !url.searchParams.has(k)) url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Public URL to put in captions / bio pages. Programs that forbid redirects get the raw destination with a
 * static sub-id (the link code) so the network's own reports still attribute the content.
 */
export function publicLinkUrl(
  appUrl: string,
  link: Pick<TrackedLink, "code" | "redirect" | "destinationUrl" | "subIdParam">,
): string {
  if (link.redirect) return trackingUrl(appUrl, link.code);
  if (!link.subIdParam) return link.destinationUrl;
  const url = new URL(link.destinationUrl);
  url.searchParams.set(link.subIdParam, link.code);
  return url.toString();
}

export interface CreateLinkInput {
  workspaceId: string;
  brandId: string;
  destinationUrl: string;
  redirect: boolean;
  productId?: string | null;
  projectId?: string | null;
  affiliateLinkId?: string | null;
  platform?: Platform | null;
  campaign?: string | null;
  subIdParam?: string | null;
  appendUtm?: boolean;
  utm?: { source?: string; medium?: string; campaign?: string; content?: string; term?: string };
}

export async function createTrackedLink(db: DbClient, input: CreateLinkInput): Promise<TrackedLink> {
  new URL(input.destinationUrl); // validate (throws on garbage)
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode(LINK_CODE_LENGTH);
    const clash = await db.trackedLink.findUnique({ where: { code }, select: { id: true } });
    if (clash) continue;
    return db.trackedLink.create({
      data: {
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        code,
        destinationUrl: input.destinationUrl,
        redirect: input.redirect,
        productId: input.productId ?? null,
        projectId: input.projectId ?? null,
        affiliateLinkId: input.affiliateLinkId ?? null,
        platform: input.platform ?? null,
        campaign: input.campaign ?? null,
        subIdParam: input.subIdParam ?? null,
        appendUtm: input.appendUtm ?? false,
        utmSource: input.utm?.source ?? null,
        utmMedium: input.utm?.medium ?? null,
        utmCampaign: input.utm?.campaign ?? null,
        utmContent: input.utm?.content ?? null,
        utmTerm: input.utm?.term ?? null,
      },
    });
  }
  throw new Error("Could not allocate a unique tracking code");
}

/* ------------------------------------------------------------------ request parsing ------------- */

const BOT_RE =
  /bot|crawl|spider|slurp|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|embedly|preview|headless|python-requests|curl|wget|go-http-client|okhttp|axios|node-fetch|monitor|pingdom|uptime/i;

export interface ParsedAgent {
  deviceType: "mobile" | "tablet" | "desktop" | "bot" | "unknown";
  osFamily: string;
  browserFamily: string;
  isBot: boolean;
}

export function parseUserAgent(ua: string | null | undefined): ParsedAgent {
  if (!ua) return { deviceType: "unknown", osFamily: "Other", browserFamily: "Other", isBot: false };
  const isBot = BOT_RE.test(ua);
  const osFamily = /iphone|ipad|ipod|ios/i.test(ua)
    ? "iOS"
    : /android/i.test(ua)
      ? "Android"
      : /windows/i.test(ua)
        ? "Windows"
        : /mac os x|macintosh/i.test(ua)
          ? "macOS"
          : /cros/i.test(ua)
            ? "ChromeOS"
            : /linux/i.test(ua)
              ? "Linux"
              : "Other";
  const browserFamily = /instagram/i.test(ua)
    ? "Instagram in-app"
    : /fban|fbav|fb_iab/i.test(ua)
      ? "Facebook in-app"
      : /bytedancewebview|musical_ly|tiktok/i.test(ua)
        ? "TikTok in-app"
        : /edg\//i.test(ua)
          ? "Edge"
          : /samsungbrowser/i.test(ua)
            ? "Samsung Internet"
            : /firefox|fxios/i.test(ua)
              ? "Firefox"
              : /chrome|crios/i.test(ua)
                ? "Chrome"
                : /safari/i.test(ua)
                  ? "Safari"
                  : "Other";
  const deviceType = isBot
    ? "bot"
    : /ipad|tablet/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))
      ? "tablet"
      : /mobi|iphone|ipod|android/i.test(ua)
        ? "mobile"
        : osFamily === "Other"
          ? "unknown"
          : "desktop";
  return { deviceType, osFamily, browserFamily, isBot };
}

/** Daily-rotating pseudonymous visitor id: cannot be linked across days or reversed to an IP. */
export function visitorHash(secret: string, ip: string | null, ua: string | null, day: Date): string | null {
  if (!ip) return null;
  const dayKey = day.toISOString().slice(0, 10);
  return hmacSha256Hex(secret, `${dayKey}|${ip}|${ua ?? ""}`).slice(0, 32);
}

export function referrerHost(referer: string | null | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).hostname.slice(0, 120) || null;
  } catch {
    return null;
  }
}

export interface ClickContext {
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
  /** country from a trusted CDN header (cf-ipcountry, x-vercel-ip-country) */
  country: string | null;
  query: URLSearchParams;
  hashSecret: string;
  now?: Date;
  isSimulated?: boolean;
}

export interface RecordedClick {
  clickId: string;
  redirectUrl: string;
  isBot: boolean;
}

/** Look up the link's attribution context and record one click. */
export async function recordClick(
  db: DbClient,
  link: TrackedLink,
  ctx: ClickContext,
): Promise<RecordedClick> {
  const now = ctx.now ?? new Date();
  const agent = parseUserAgent(ctx.userAgent);
  const clickId = randomCode(16);
  const variant = await db.contentVariant.findUnique({
    where: { trackedLinkId: link.id },
    select: {
      id: true,
      projectId: true,
      platform: true,
      publications: {
        where: { status: "PUBLISHED" },
        select: { id: true },
        orderBy: { publishedAt: "desc" },
        take: 1,
      },
    },
  });
  const q = (k: string) => ctx.query.get(k)?.slice(0, 120) ?? null;
  await db.click.create({
    data: {
      clickId,
      trackedLinkId: link.id,
      workspaceId: link.workspaceId,
      brandId: link.brandId,
      projectId: link.projectId ?? variant?.projectId ?? null,
      variantId: variant?.id ?? null,
      publicationId: variant?.publications[0]?.id ?? null,
      productId: link.productId,
      platform: link.platform ?? variant?.platform ?? null,
      campaign: link.campaign,
      occurredAt: now,
      referrerHost: referrerHost(ctx.referer),
      utmSource: q("utm_source") ?? link.utmSource,
      utmMedium: q("utm_medium") ?? link.utmMedium,
      utmCampaign: q("utm_campaign") ?? link.utmCampaign,
      utmContent: q("utm_content") ?? link.utmContent,
      utmTerm: q("utm_term") ?? link.utmTerm,
      deviceType: agent.deviceType,
      osFamily: agent.osFamily,
      browserFamily: agent.browserFamily,
      country: ctx.country?.slice(0, 2).toUpperCase() ?? null,
      isBot: agent.isBot,
      visitorHash: visitorHash(ctx.hashSecret, ctx.ip, ctx.userAgent, now),
      isSimulated: ctx.isSimulated ?? false,
    },
  });
  return { clickId, redirectUrl: buildRedirectUrl(link, clickId), isBot: agent.isBot };
}
