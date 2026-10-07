import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderError } from "@cre/shared";
import { mockIdeas, mockResearch, mockScript } from "./mock/generators.ts";
import {
  ALL_PROMPTS,
  hookVariantsPrompt,
  ideasPrompt,
  platformCaptionsPrompt,
  renderPrompt,
  renderTemplate,
  researchPrompt,
  shortVideoScriptPrompt,
  textReviewPrompt,
} from "./prompts/index.ts";
import {
  HookVariantsOutput,
  IdeasOutput,
  PlatformCaptionsOutput,
  QaReviewOutput,
  ResearchBriefOutput,
  ScriptOutput,
} from "./prompts/schemas.ts";
import { MockLLMProvider } from "./providers/mock.ts";
import { DeepSeekProvider, OpenAICompatibleProvider } from "./providers/openai-compatible.ts";
import { runPrompt, sumUsage } from "./registry.ts";
import { runStructured, StructuredOutputError } from "./structured.ts";
import { brandFixture, productFixture } from "./test-fixtures.ts";
import type { LlmCallResult } from "./types.ts";

const idea = {
  title: "Drill: before you buy",
  angle: "before_you_buy",
  hook: "Before you buy a drill, watch this",
};
const research = mockResearch({ brand: brandFixture, product: productFixture, idea });
const scriptCtx = {
  brand: brandFixture,
  product: productFixture,
  idea,
  research,
  targetDurationSec: 25,
  performanceSummary: "",
  economicOutcome: "AFFILIATE_CLICK",
  avoidHooks: [],
  feedback: null,
};

function callResult(text: string, finishReason = "stop"): LlmCallResult {
  return {
    text,
    usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
    provider: "test",
    model: "m",
    latencyMs: 1,
    finishReason,
    isMock: true,
  };
}

describe("structured generation", () => {
  const schema = z.object({ title: z.string().min(3), n: z.number().int() });

  it("repairs malformed JSON and schema violations by feeding errors back", async () => {
    const outputs = ['{"title": oops', '{"title": "ok", "n": 1.5}', '{"title": "fine", "n": 2}'];
    const seen: string[] = [];
    const result = await runStructured(
      (req) => {
        seen.push(req.messages.at(-1)!.content);
        return Promise.resolve(callResult(outputs.shift()!));
      },
      { messages: [{ role: "user", content: "go" }], schema, schemaName: "T", maxRepairAttempts: 2 },
    );
    expect(result.data).toEqual({ title: "fine", n: 2 });
    expect(result.attempts).toBe(3);
    expect(result.calls).toHaveLength(3);
    expect(seen[1]).toMatch(/not valid JSON/);
    expect(seen[2]).toMatch(/n: /);
  });

  it("gives up after the repair budget with all calls attached (so their cost is still recorded)", async () => {
    await expect(
      runStructured(() => Promise.resolve(callResult("{}")), {
        messages: [{ role: "user", content: "go" }],
        schema,
        schemaName: "T",
        maxRepairAttempts: 1,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof StructuredOutputError && err.calls.length === 2);
  });

  it("raises the token budget when output was truncated", async () => {
    const budgets: number[] = [];
    const outputs = ['{"title": "trunc', '{"title": "done", "n": 3}'];
    await runStructured(
      (req) => {
        budgets.push(req.maxOutputTokens ?? 0);
        return Promise.resolve(callResult(outputs.shift()!, budgets.length === 1 ? "length" : "stop"));
      },
      { messages: [{ role: "user", content: "x" }], schema, schemaName: "T", maxOutputTokens: 1000 },
    );
    expect(budgets).toEqual([1000, 1600]);
  });
});

describe("prompts", () => {
  it("render every prompt without missing variables and append the JSON schema contract", () => {
    const contexts: [unknown, unknown][] = [
      [
        ideasPrompt,
        {
          brand: brandFixture,
          products: [productFixture],
          count: 3,
          formats: ["SHORT_VIDEO"],
          performanceSummary: "",
          avoidTitles: [],
        },
      ],
      [researchPrompt, { brand: brandFixture, product: productFixture, idea }],
      [shortVideoScriptPrompt, scriptCtx],
      [
        hookVariantsPrompt,
        {
          brand: brandFixture,
          product: productFixture,
          angle: "comparison",
          currentHook: "x",
          count: 3,
          performanceSummary: "",
          avoidHooks: [],
          feedback: null,
        },
      ],
      [
        platformCaptionsPrompt,
        {
          brand: brandFixture,
          product: productFixture,
          hook: "h",
          cta: "c",
          masterCaption: "caption text",
          hashtags: ["#a"],
          platforms: [{ platform: "TIKTOK", maxChars: 2200, maxHashtags: 5, linkClickable: false }],
        },
      ],
      [
        textReviewPrompt,
        {
          brand: brandFixture,
          product: productFixture,
          hook: "h",
          onScreenTexts: ["a"],
          voiceover: "v",
          caption: "c",
        },
      ],
    ];
    for (const [prompt, ctx] of contexts) {
      const messages = renderPrompt(prompt as typeof ideasPrompt, ctx as never);
      expect(messages).toHaveLength(2);
      expect(messages[1]!.content).toContain("JSON Schema");
      expect(messages.map((m) => m.content).join("")).not.toMatch(/\{\{/);
    }
  });

  it("throws on missing template variables", () => {
    expect(() => renderTemplate("Hello {{name}}", {})).toThrow(/name/);
  });

  it("never asks the model to invent facts and always forbids banned words", () => {
    const sys = renderPrompt(shortVideoScriptPrompt, scriptCtx)[0]!.content;
    expect(sys).toContain("Use ONLY the product facts");
    expect(sys).toContain("indestructible");
  });

  it("prompt versions are unique and hashes are pinned (edit a prompt → bump its version)", () => {
    const ids = ALL_PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hashes = Object.fromEntries(ALL_PROMPTS.map((p) => [p.id, p.contentHash.slice(0, 16)]));
    expect(hashes).toMatchSnapshot();
  });
});

describe("mock LLM", () => {
  it("produces schema-valid output for every prompt from the same context the prompt uses", () => {
    expect(
      IdeasOutput.safeParse(
        mockIdeas({
          brand: brandFixture,
          products: [productFixture],
          count: 4,
          formats: ["SHORT_VIDEO"],
          performanceSummary: "",
          avoidTitles: [],
        }),
      ).success,
    ).toBe(true);
    expect(ResearchBriefOutput.safeParse(research).success).toBe(true);
    const script = mockScript(scriptCtx);
    expect(ScriptOutput.safeParse(script).success).toBe(true);
    const total = script.script.reduce((s, b) => s + b.durationSec, 0);
    expect(total).toBeGreaterThanOrEqual(20);
    expect(total).toBeLessThanOrEqual(30);
    expect(script.script[0]!.sceneKind).toBe("HOOK");
    expect(script.script.at(-1)!.sceneKind).toBe("CTA");
    // only sourced fact ids
    for (const id of script.claimsUsed) expect(productFixture.facts.map((f) => f.id)).toContain(id);
  });

  it("runs prompts end-to-end with usage and simulated cost", async () => {
    const llm = new MockLLMProvider({ costMode: "simulate" });
    const run = await runPrompt(llm, shortVideoScriptPrompt, scriptCtx);
    expect(run.data.hook.length).toBeGreaterThan(3);
    expect(run.promptId).toBe(shortVideoScriptPrompt.id);
    const usage = sumUsage(run.calls);
    expect(usage.inputTokens).toBeGreaterThan(500);
    expect(
      llm.estimateCost({ inputTokens: usage.inputTokens, maxOutputTokens: 3000 }).estimatedMicros,
    ).toBeGreaterThan(0);
    const hooks = await runPrompt(llm, hookVariantsPrompt, {
      brand: brandFixture,
      product: productFixture,
      angle: "comparison",
      currentHook: run.data.hook,
      count: 3,
      performanceSummary: "",
      avoidHooks: [],
      feedback: null,
    });
    expect(HookVariantsOutput.safeParse(hooks.data).success).toBe(true);
    const caps = await runPrompt(llm, platformCaptionsPrompt, {
      brand: brandFixture,
      product: productFixture,
      hook: run.data.hook,
      cta: run.data.cta,
      masterCaption: run.data.caption,
      hashtags: run.data.hashtags,
      platforms: [
        { platform: "INSTAGRAM", maxChars: 2200, maxHashtags: 5, linkClickable: false },
        { platform: "FACEBOOK", maxChars: 5000, maxHashtags: 3, linkClickable: true },
      ],
    });
    expect(PlatformCaptionsOutput.safeParse(caps.data).success).toBe(true);
    const qa = await runPrompt(llm, textReviewPrompt, {
      brand: brandFixture,
      product: productFixture,
      hook: "This drill is indestructible",
      onScreenTexts: [],
      voiceover: "",
      caption: "Guaranteed results",
    });
    expect(QaReviewOutput.safeParse(qa.data).success).toBe(true);
    expect(qa.data.issues.some((i) => i.severity === "blocker")).toBe(true);
  });

  it("injected malformed output is repaired; zero cost mode records nothing", async () => {
    const llm = new MockLLMProvider({ costMode: "zero", failures: { "script.short_video": ["malformed"] } });
    const run = await runPrompt(llm, shortVideoScriptPrompt, scriptCtx);
    expect(run.attempts).toBe(2);
    expect(llm.estimateCost({ inputTokens: 1000, maxOutputTokens: 1000 }).estimatedMicros).toBe(0);
  });
});

describe("DeepSeek adapter (fetch stubbed — no network)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends JSON mode and parses usage including cache hits", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.model).toBe("deepseek-chat");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "deepseek-chat",
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 80,
              prompt_cache_hit_tokens: 1000,
              prompt_cache_miss_tokens: 200,
            },
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const ds = new DeepSeekProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });
    const res = await ds.generateText({
      messages: [{ role: "user", content: "json please" }],
      jsonMode: true,
    });
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 80, cachedInputTokens: 1000 });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.deepseek.com/chat/completions");
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  it("maps HTTP errors to retryable / fatal provider errors", async () => {
    const ds = new DeepSeekProvider({
      apiKey: "sk",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("rate limited", { status: 429 }))),
    );
    await expect(ds.generateText({ messages: [] })).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.retryable,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("Insufficient Balance", { status: 402 }))),
    );
    await expect(ds.generateText({ messages: [] })).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && !e.retryable,
    );
  });

  it("refuses to run without an API key and health-checks via the free balance endpoint", async () => {
    const noKey = new DeepSeekProvider({
      apiKey: undefined,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });
    await expect(noKey.generateText({ messages: [] })).rejects.toThrow(/not configured/);
    expect((await noKey.healthCheck()).ok).toBe(false);
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20" }] }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ds = new DeepSeekProvider({
      apiKey: "sk",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });
    const health = await ds.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.message).toContain("4.20 USD");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.deepseek.com/user/balance");
  });

  it("treats network failures and unparseable bodies as retryable (the latter possibly charged)", async () => {
    const ds = new DeepSeekProvider({
      apiKey: "sk",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-chat",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(ds.generateText({ messages: [] })).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.retryable && !e.charged,
    );
    const garbage = vi.fn((_url: string) =>
      Promise.resolve(new Response("<html>gateway</html>", { status: 200 })),
    );
    vi.stubGlobal("fetch", garbage);
    await expect(ds.generateText({ messages: [] })).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.retryable && e.charged,
    );
    // trailing slash in DEEPSEEK_BASE_URL is tolerated
    expect(garbage.mock.calls[0]![0]).toBe("https://api.deepseek.com/chat/completions");
  });

  it("repairs invalid structured output through the real adapter, in JSON mode on every attempt", async () => {
    const replies = ['{"title": 42}', '{"title":"Fixed"}'];
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: replies[bodies.length - 1] }, finish_reason: "stop" }],
              usage: { prompt_tokens: 100, completion_tokens: 10 },
            }),
            { status: 200 },
          ),
        );
      }),
    );
    const ds = new DeepSeekProvider({
      apiKey: "sk",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });
    const res = await ds.generateStructured({
      messages: [{ role: "user", content: "Return JSON" }],
      schema: z.object({ title: z.string() }),
      schemaName: "Title",
    });
    expect(res).toMatchObject({ data: { title: "Fixed" }, attempts: 2 });
    expect(res.calls).toHaveLength(2);
    expect(bodies.every((b) => (b.response_format as { type: string }).type === "json_object")).toBe(true);
    const repair = bodies[1]!.messages as { role: string; content: string }[];
    expect(repair.at(-1)!.content).toMatch(/does not match the Title schema/);
  });

  it("prices cache hits at the discounted rate", () => {
    const ds = new DeepSeekProvider({
      apiKey: "sk",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });
    // 200 miss × 0.28 + 1000 hit × 0.028 + 300 out × 0.42 (USD / 1M tokens)
    expect(
      ds.costForUsage("deepseek-chat", { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1000 }),
    ).toBe(210);
    expect(
      ds.costForUsage("deepseek-chat", { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0 }),
    ).toBe(462);
  });

  it("reads OpenAI-style cached tokens and skips JSON mode where unsupported", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "{}" } }],
            usage: {
              prompt_tokens: 500,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 384 },
            },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const local = new OpenAICompatibleProvider({
      name: "vllm",
      baseUrl: "http://localhost:8000/v1",
      apiKey: "none",
      defaultModel: "qwen",
      pricingProvider: "vllm",
      supportsJsonMode: false,
    });
    const res = await local.generateText({ messages: [{ role: "user", content: "hi" }], jsonMode: true });
    expect(res.usage).toEqual({ inputTokens: 500, outputTokens: 20, cachedInputTokens: 384 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.response_format).toBeUndefined();
    expect(body).toMatchObject({ model: "qwen", stream: false });
  });

  it("estimates cost from the pricing catalog", () => {
    const ds = new DeepSeekProvider({
      apiKey: "sk",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });
    // 10k in + 2k out = 2800 + 840 = 3640 micros per call, 2 calls reserved
    expect(ds.estimateCost({ inputTokens: 10_000, maxOutputTokens: 2_000, calls: 2 }).estimatedMicros).toBe(
      7280,
    );
  });
});
