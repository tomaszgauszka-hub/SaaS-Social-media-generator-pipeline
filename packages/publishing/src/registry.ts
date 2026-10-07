import { resolveProviderSelection, type Env } from "@cre/config";
import { MetaPublisher } from "./meta.ts";
import { MockSocialPublisher } from "./mock.ts";
import { TikTokPublisher } from "./tiktok.ts";
import type { SocialPlatform, SocialPublisher } from "./types.ts";

export type PublisherMap = Record<SocialPlatform, SocialPublisher>;

/**
 * Configuration-driven publisher selection. MOCK_SOCIAL=true → everything is mocked.
 * Real publishers additionally require PUBLISHING_ENABLED=true at publish time (enforced by the pipeline).
 */
export function createSocialPublishers(env: Env, overrides: Partial<PublisherMap> = {}): PublisherMap {
  const sel = resolveProviderSelection(env);
  const mock = new MockSocialPublisher();
  const meta = new MetaPublisher({
    graphVersion: env.META_GRAPH_API_VERSION,
    appConfigured: Boolean(env.META_APP_ID && env.META_APP_SECRET),
  });
  const tiktok = new TikTokPublisher({
    appConfigured: Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET),
  });
  const pick = (platform: SocialPlatform): SocialPublisher => {
    const name = sel.social[platform];
    return name === "mock" ? mock : name === "meta" ? meta : tiktok;
  };
  return {
    INSTAGRAM: overrides.INSTAGRAM ?? pick("INSTAGRAM"),
    FACEBOOK: overrides.FACEBOOK ?? pick("FACEBOOK"),
    TIKTOK: overrides.TIKTOK ?? pick("TIKTOK"),
  };
}

export function isSocialPlatform(p: string): p is SocialPlatform {
  return p === "INSTAGRAM" || p === "FACEBOOK" || p === "TIKTOK";
}
