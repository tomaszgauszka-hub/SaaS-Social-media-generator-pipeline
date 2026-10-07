/**
 * Product defaults that are not secrets and rarely change. Brand-level settings in the database override
 * the per-brand values (QA threshold, tier ceiling, …).
 */
export const CONTENT_DEFAULTS = {
  /** Target duration range for short-form video (ms). */
  shortVideoMinMs: 15_000,
  shortVideoMaxMs: 45_000,
  shortVideoTargetMs: 27_000,
  /** Hook must land within the first 3 seconds. */
  hookMaxMs: 3_500,
  qaThreshold: 70,
  /** Similarity above which a hook is considered a duplicate of a recent one. */
  duplicateHookSimilarity: 0.82,
  duplicateLookbackDays: 45,
  /** Days after which a stored product price is considered stale for on-screen mentions. */
  priceStaleDays: 7,
  maxHashtags: { INSTAGRAM: 5, TIKTOK: 5, FACEBOOK: 3 } as Record<string, number>,
  captionMaxChars: { INSTAGRAM: 2200, TIKTOK: 2200, FACEBOOK: 5000 } as Record<string, number>,
};

export const VIDEO_DEFAULTS = {
  width: 1080,
  height: 1920,
  fps: 30,
  /** Safe area (px at 1080×1920) that stays clear of TikTok/Instagram UI chrome. */
  safeArea: { top: 220, bottom: 440, left: 70, right: 150 },
  /** Static post / carousel slide size (4:5). */
  staticWidth: 1080,
  staticHeight: 1350,
};

export const ANALYTICS_DEFAULTS = {
  /** Snapshot offsets after publishing (hours). Cumulative metrics → aggregate the latest snapshot. */
  snapshotOffsetsHours: [1, 6, 24, 72, 168],
  /** After this many days the publication leaves ANALYTICS_PENDING and is archived. */
  windowDays: 14,
};

export const SCHEDULER_DEFAULTS = {
  /** Never schedule a post sooner than this after approval. */
  minLeadMinutes: 10,
  /** How far ahead the scheduler searches for a free slot. */
  horizonDays: 21,
};

export const JOB_DEFAULTS: Record<string, { timeoutMs: number; maxAttempts: number; queue: string }> = {
  "strategy.ideate": { queue: "strategy", timeoutMs: 120_000, maxAttempts: 3 },
  "pipeline.research": { queue: "research", timeoutMs: 120_000, maxAttempts: 3 },
  "pipeline.script": { queue: "scripts", timeoutMs: 180_000, maxAttempts: 3 },
  "pipeline.plan_assets": { queue: "scripts", timeoutMs: 60_000, maxAttempts: 3 },
  "asset.image": { queue: "images", timeoutMs: 180_000, maxAttempts: 3 },
  "asset.product_image": { queue: "images", timeoutMs: 120_000, maxAttempts: 3 },
  "asset.video": { queue: "video_generation", timeoutMs: 900_000, maxAttempts: 2 },
  "asset.tts": { queue: "tts", timeoutMs: 180_000, maxAttempts: 3 },
  "asset.music": { queue: "tts", timeoutMs: 120_000, maxAttempts: 2 },
  "pipeline.render": { queue: "render", timeoutMs: 900_000, maxAttempts: 2 },
  "pipeline.qa": { queue: "qa", timeoutMs: 180_000, maxAttempts: 3 },
  "publish.publication": { queue: "publish", timeoutMs: 600_000, maxAttempts: 4 },
  "analytics.collect": { queue: "analytics", timeoutMs: 120_000, maxAttempts: 3 },
  "analytics.profile": { queue: "analytics", timeoutMs: 120_000, maxAttempts: 2 },
  "maintenance.tick": { queue: "maintenance", timeoutMs: 120_000, maxAttempts: 1 },
};

export const QUEUE_NAMES = [
  "strategy",
  "research",
  "scripts",
  "images",
  "video_generation",
  "tts",
  "render",
  "qa",
  "publish",
  "analytics",
  "maintenance",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
export const DEAD_LETTER_QUEUE = "dead_letter";
