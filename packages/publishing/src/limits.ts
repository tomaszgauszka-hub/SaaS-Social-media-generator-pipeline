import type { PublishRequest, SocialPlatform } from "./types.ts";

/**
 * Platform constraints for short vertical video (verify against current platform docs — see docs/SOCIAL_APIS.md).
 */
export interface PlatformLimits {
  captionMaxChars: number;
  maxHashtags: number;
  videoMinMs: number;
  videoMaxMs: number;
  maxFileBytes: number;
  /** links in captions are clickable */
  linkClickable: boolean;
  requiresPublicVideoUrl: boolean;
}

export const PLATFORM_LIMITS: Record<SocialPlatform, PlatformLimits> = {
  INSTAGRAM: {
    captionMaxChars: 2200,
    maxHashtags: 30,
    videoMinMs: 3_000,
    videoMaxMs: 15 * 60_000,
    maxFileBytes: 300 * 1024 * 1024,
    linkClickable: false,
    requiresPublicVideoUrl: true,
  },
  FACEBOOK: {
    captionMaxChars: 63_206,
    maxHashtags: 30,
    videoMinMs: 3_000,
    videoMaxMs: 90_000,
    maxFileBytes: 1024 * 1024 * 1024,
    linkClickable: true,
    requiresPublicVideoUrl: true,
  },
  TIKTOK: {
    captionMaxChars: 2200,
    maxHashtags: 30,
    videoMinMs: 3_000,
    videoMaxMs: 10 * 60_000,
    maxFileBytes: 4 * 1024 * 1024 * 1024,
    linkClickable: false,
    requiresPublicVideoUrl: false,
  },
};

export function validateForPlatform(req: PublishRequest, opts: { needsPublicUrl: boolean }): string[] {
  const limits = PLATFORM_LIMITS[req.platform];
  const problems: string[] = [];
  if (req.caption.length > limits.captionMaxChars)
    problems.push(`caption ${req.caption.length}/${limits.captionMaxChars} chars`);
  const hashtags = req.caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (hashtags > limits.maxHashtags) problems.push(`${hashtags} hashtags (max ${limits.maxHashtags})`);
  if (req.media.kind === "video") {
    const d = req.media.durationMs ?? 0;
    if (d < limits.videoMinMs || d > limits.videoMaxMs)
      problems.push(`video duration ${Math.round(d / 1000)}s outside platform limits`);
    if ((req.media.sizeBytes ?? 0) > limits.maxFileBytes) problems.push("video file too large");
    if (opts.needsPublicUrl && limits.requiresPublicVideoUrl && !req.media.videoUrl) {
      problems.push("platform needs a public video URL (configure S3/R2 storage)");
    }
  }
  return problems;
}
