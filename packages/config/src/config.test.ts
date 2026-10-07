import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";
import {
  bgRemovalCostMicros,
  getPrice,
  imageCostMicros,
  llmCostMicros,
  ttsCostMicros,
  videoCostMicros,
} from "./pricing.ts";
import { resolveModelCatalog, resolveProviderSelection } from "./providers.ts";

describe("env", () => {
  it("defaults to safe mock mode with publishing disabled", () => {
    const env = parseEnv({});
    expect(env.MOCK_AI).toBe(true);
    expect(env.MOCK_MEDIA).toBe(true);
    expect(env.MOCK_SOCIAL).toBe(true);
    expect(env.PUBLISHING_ENABLED).toBe(false);
  });

  it("treats blank values as unset and parses booleans", () => {
    const env = parseEnv({ DEEPSEEK_API_KEY: "  ", MOCK_AI: "false", PUBLISHING_ENABLED: "1" });
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.MOCK_AI).toBe(false);
    expect(env.PUBLISHING_ENABLED).toBe(true);
  });

  it("reports invalid values", () => {
    expect(() => parseEnv({ APP_URL: "not a url" })).toThrow(/APP_URL/);
  });
});

describe("provider selection", () => {
  it("mock flags force mock providers", () => {
    const sel = resolveProviderSelection(
      parseEnv({ MOCK_AI: "true", MOCK_MEDIA: "true", MOCK_SOCIAL: "true" }),
    );
    expect(sel.llm).toBe("mock");
    expect(sel.image).toBe("mock");
    expect(sel.social.TIKTOK).toBe("mock");
  });

  it("real providers when mocks are off", () => {
    const env = parseEnv({
      MOCK_AI: "false",
      MOCK_MEDIA: "false",
      MOCK_SOCIAL: "false",
      TTS_PROVIDER: "elevenlabs",
    });
    const sel = resolveProviderSelection(env);
    expect(sel.llm).toBe("deepseek");
    expect(sel.image).toBe("fal");
    expect(sel.social.INSTAGRAM).toBe("meta");
    expect(resolveModelCatalog(env, sel).tts).toBe("eleven_flash_v2_5");
  });

  it("model overrides come from env", () => {
    const env = parseEnv({ IMAGE_MODEL_CHEAP: "fal-ai/custom" });
    expect(resolveModelCatalog(env).image.cheap).toBe("fal-ai/custom");
  });
});

describe("pricing", () => {
  it("prices DeepSeek tokens including cache hits", () => {
    // 10k uncached input, 2k cached, 1k output
    const micros = llmCostMicros("deepseek", "deepseek-chat", {
      inputTokens: 12_000,
      cachedInputTokens: 2_000,
      outputTokens: 1_000,
    });
    // 10_000*0.28 + 2_000*0.028 + 1_000*0.42 = 2800 + 56 + 420 = 3276 → / 1e6 USD
    expect(micros).toBe(3276);
  });

  it("prices images per megapixel (rounded up)", () => {
    // 1080x1920 = 2.07 MP → 3 MP billed
    expect(imageCostMicros("fal", "fal-ai/flux/schnell", { width: 1080, height: 1920 })).toBe(9_000);
    expect(imageCostMicros("fal", "fal-ai/flux/schnell", { width: 768, height: 1344, count: 2 })).toBe(
      12_000,
    );
  });

  it("applies minimum billable seconds for video", () => {
    expect(videoCostMicros("fal", "fal-ai/kling-video/v2.1/standard/image-to-video", { seconds: 3 })).toBe(
      250_000,
    );
    expect(videoCostMicros("fal", "fal-ai/kling-video/v2.1/standard/image-to-video", { seconds: 6.2 })).toBe(
      350_000,
    );
  });

  it("prices TTS per character and background removal per image", () => {
    expect(ttsCostMicros("openai", "tts-1", { characters: 1000 })).toBe(15_000);
    expect(ttsCostMicros("flite", "flite", { characters: 1000 })).toBe(0);
    expect(bgRemovalCostMicros("fal", "fal-ai/birefnet")).toBe(2_000);
  });

  it("uses a pessimistic fallback for unknown models", () => {
    const p = getPrice("unknown", "model", "video");
    expect(p.isFallback).toBe(true);
    expect(videoCostMicros("unknown", "model", { seconds: 5 })).toBe(2_500_000);
  });
});
