import type { Logger } from "@cre/shared";

export type SocialPlatform = "INSTAGRAM" | "FACEBOOK" | "TIKTOK";

export interface SocialAccountRef {
  id: string;
  platform: SocialPlatform;
  handle: string;
  /** IG user id / FB page id / TikTok open_id */
  externalAccountId: string | null;
  isMock: boolean;
  metadata?: Record<string, unknown> | null;
}

/** Decrypted credentials — server-side only, never logged or sent to the browser. */
export interface SocialCredentials {
  accessToken: string;
  /** e.g. Facebook page access token */
  pageAccessToken?: string;
  expiresAt?: Date | null;
}

export interface PublishMedia {
  kind: "video" | "image" | "carousel";
  /** local file (mock / upload flows) */
  videoPath?: string;
  /** short-lived public URL the platform can pull (IG/FB/TikTok PULL_FROM_URL) */
  videoUrl?: string;
  coverUrl?: string;
  imageUrls?: string[];
  durationMs?: number;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

export interface PublishRequest {
  publicationId: string;
  platform: SocialPlatform;
  account: SocialAccountRef;
  credentials: SocialCredentials | null;
  media: PublishMedia;
  caption: string;
  firstComment?: string | null;
  /** platform AI-content label where supported */
  aiGenerated: boolean;
  /**
   * Commercial content: THIRD_PARTY = promotes someone else's product for an incentive (affiliate commission,
   * paid lead), OWN_BUSINESS = promotes the brand's own product. Sets platform disclosure toggles where supported.
   */
  promotion?: "THIRD_PARTY" | "OWN_BUSINESS" | null;
  /** clickable link (Facebook) */
  link?: string | null;
  idempotencyKey: string;
}

export interface PublishResult {
  status: "PUBLISHED" | "PROCESSING";
  externalPostId: string;
  externalUrl?: string;
  /** IG media container / TikTok publish id used for status polling */
  containerId?: string;
  raw?: Record<string, unknown>;
}

export interface PublicationStatus {
  status: "PROCESSING" | "PUBLISHED" | "FAILED";
  externalPostId?: string;
  externalUrl?: string;
  error?: string;
}

/** Cumulative metrics at capture time (null = not provided by the platform). */
export interface PlatformMetrics {
  capturedAt: Date;
  impressions: number | null;
  reach: number | null;
  plays: number | null;
  views3s: number | null;
  completionRate: number | null;
  avgWatchTimeMs: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  profileVisits: number | null;
  outboundClicks: number | null;
  follows: number | null;
  raw?: Record<string, unknown>;
}

export interface AnalyticsContext {
  account: SocialAccountRef;
  credentials: SocialCredentials | null;
  publishedAt: Date;
  now: Date;
  signal?: AbortSignal;
  /** simulation hints for the mock publisher (ignored by real publishers) */
  hints?: { qaScore?: number | null; hookStyle?: string | null; durationMs?: number | null; seed?: string };
}

export interface PublisherHealth {
  ok: boolean;
  publisher: string;
  isMock: boolean;
  message?: string;
}

export interface SocialPublisher {
  readonly name: string;
  readonly isMock: boolean;
  readonly platforms: readonly SocialPlatform[];
  healthCheck(): Promise<PublisherHealth>;
  /** Problems that would make the platform reject the post (empty = OK). */
  validate(req: PublishRequest): string[];
  publish(req: PublishRequest, ctx: { signal?: AbortSignal; logger?: Logger }): Promise<PublishResult>;
  /** Native platform scheduling (Facebook pages); others publish at slot time via our scheduler. */
  schedule?(
    req: PublishRequest,
    at: Date,
    ctx: { signal?: AbortSignal; logger?: Logger },
  ): Promise<PublishResult>;
  getStatus(
    ref: { externalPostId?: string | null; containerId?: string | null },
    ctx: { account: SocialAccountRef; credentials: SocialCredentials | null; signal?: AbortSignal },
  ): Promise<PublicationStatus>;
  getAnalytics(externalPostId: string, ctx: AnalyticsContext): Promise<PlatformMetrics>;
}
