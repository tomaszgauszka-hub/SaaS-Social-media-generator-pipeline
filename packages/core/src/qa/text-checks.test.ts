import { describe, expect, it } from "vitest";
import { runTextChecks, scoreIssues, type TextQaInput } from "./text-checks.ts";

function input(
  overrides: {
    content?: Partial<TextQaInput["content"]>;
    variants?: TextQaInput["variants"];
    product?: TextQaInput["product"];
  } = {},
): TextQaInput {
  const caption =
    "#ad · affiliate link\n\nStop stripping screws.\n\n✓ 2-speed gearbox: 0-450 and 0-1,500 RPM\n\nCheck today's price — link in bio.";
  return {
    brand: {
      bannedWords: ["indestructible", "lifetime guarantee"],
      disclosureRules: [
        {
          platform: null,
          kind: "AFFILIATE",
          text: "#ad · affiliate link",
          placement: "CAPTION_START",
          isRequired: true,
        },
      ],
    },
    product: {
      title: "20V Cordless Drill/Driver Kit",
      priceMicros: 89_000_000,
      priceFresh: true,
      facts: [
        { id: "f1", claim: "20V max lithium-ion battery platform" },
        { id: "f2", claim: "2-speed gearbox: 0-450 and 0-1,500 RPM" },
      ],
    },
    content: {
      hook: "Stop stripping *screws*",
      cta: "Check today's price — link in bio",
      onScreenTexts: ["Stop stripping *screws*", "Meet the *20V* kit", "What you get"],
      voiceover: "This cordless drill has a two speed gearbox.",
      caption,
      hashtags: ["#drill", "#diy"],
      claimsUsed: ["f1", "f2"],
      isMonetized: true,
      aiGenerated: false,
      sceneKinds: ["HOOK", "PRODUCT", "CTA"],
      ...overrides.content,
    },
    variants: overrides.variants ?? [
      {
        platform: "TIKTOK",
        caption,
        hashtags: ["#drill", "#diy"],
        disclosureText: "#ad · affiliate link",
        destinationUrl: "https://example.com/aff/x?tag=1",
      },
    ],
    recentHooks: ["Three skincare mistakes that age you"],
    recentCaptions: [],
    ...(overrides.product !== undefined ? { product: overrides.product } : {}),
  };
}

const codes = (i: TextQaInput) => runTextChecks(i).map((x) => x.code);

describe("text QA", () => {
  it("passes clean, compliant content", () => {
    const issues = runTextChecks(input());
    expect(issues).toEqual([]);
    expect(scoreIssues(issues, 70)).toMatchObject({ score: 100, passed: true });
  });

  it("blocks placeholders and banned words", () => {
    expect(codes(input({ content: { hook: "Get the [PRODUCT NAME] now" } }))).toContain("placeholder");
    expect(codes(input({ content: { voiceover: "Basically indestructible." } }))).toContain("banned_word");
    expect(codes(input({ content: { caption: "#ad · affiliate link\nPrice: undefined" } }))).toContain(
      "placeholder",
    );
  });

  it("blocks unsupported free offers but not '-free' product attributes", () => {
    const free = runTextChecks(input({ content: { cta: "Try it free — link in bio" } }));
    expect(free.find((i) => i.code === "unsupported_claim")?.severity).toBe("blocker");
    const attribute = runTextChecks(
      input({
        content: { onScreenTexts: ["Fragrance-free and hands-free"] },
        product: {
          title: "Serum",
          priceMicros: null,
          priceFresh: false,
          facts: [{ id: "f1", claim: "Fragrance-free formula" }],
        },
      }),
    );
    expect(attribute.some((i) => i.message.includes("free-offer"))).toBe(false);
    const sourced = runTextChecks(
      input({
        content: { cta: "Try it free — link in bio" },
        product: {
          title: "Notes app",
          priceMicros: null,
          priceFresh: false,
          facts: [{ id: "f1", claim: "14-day free trial, no credit card required" }],
        },
      }),
    );
    expect(sourced.some((i) => i.message.includes("free-offer"))).toBe(false);
  });

  it("requires the affiliate disclosure at the start of every platform caption", () => {
    const v = input().variants[0]!;
    expect(codes(input({ variants: [{ ...v, caption: "Great drill. Link in bio." }] }))).toContain(
      "missing_disclosure",
    );
    expect(
      codes(input({ variants: [{ ...v, caption: "Great drill. Link in bio.\n#ad · affiliate link" }] })),
    ).toContain("disclosure_not_prominent");
  });

  it("requires an AI label only when content contains AI imagery", () => {
    const rules = [
      {
        platform: null,
        kind: "AFFILIATE" as const,
        text: "#ad · affiliate link",
        placement: "CAPTION_START" as const,
        isRequired: true,
      },
      {
        platform: null,
        kind: "AI_GENERATED" as const,
        text: "Some visuals are AI-generated.",
        placement: "CAPTION_END" as const,
        isRequired: true,
      },
    ];
    const withRules = (ai: boolean) => ({
      ...input({ content: { aiGenerated: ai } }),
      brand: { bannedWords: [], disclosureRules: rules },
    });
    expect(runTextChecks(withRules(false)).map((i) => i.code)).not.toContain("missing_ai_label");
    expect(runTextChecks(withRules(true)).map((i) => i.code)).toContain("missing_ai_label");
  });

  it("flags unsupported claims and unsourced numbers", () => {
    expect(codes(input({ content: { voiceover: "The best drill money can buy." } }))).toContain(
      "unsupported_claim",
    );
    expect(codes(input({ content: { voiceover: "Lasts 10 hours on a charge." } }))).toContain(
      "unsourced_number",
    );
    const personal = runTextChecks(input({ content: { voiceover: "I tried it for a month." } }));
    expect(personal.find((i) => i.code === "unsupported_claim")?.severity).toBe("blocker");
    // numbers that ARE in the facts are fine
    expect(codes(input({ content: { voiceover: "Up to 1,500 RPM." } }))).not.toContain("unsourced_number");
  });

  it("checks price consistency and freshness", () => {
    expect(codes(input({ content: { voiceover: "Only $79 today." } }))).toContain("price_mismatch");
    expect(codes(input({ content: { voiceover: "Just $89.00." } }))).not.toContain("price_mismatch");
    expect(
      codes(
        input({
          content: { voiceover: "Just $89.00." },
          product: { title: "x", priceMicros: 89_000_000, priceFresh: false, facts: [] },
        }),
      ),
    ).toContain("stale_price");
    expect(
      codes(
        input({
          content: { voiceover: "Just $89." },
          product: { title: "x", priceMicros: null, priceFresh: false, facts: [] },
        }),
      ),
    ).toContain("price_without_source");
  });

  it("detects duplicate hooks and unknown fact references", () => {
    const i = input({ content: { claimsUsed: ["f1", "f9"] } });
    i.recentHooks = ["Stop stripping screws!"];
    const c = runTextChecks(i).map((x) => x.code);
    expect(c).toContain("duplicate_hook");
    expect(c).toContain("unknown_fact_reference");
  });

  it("requires a valid tracked link on monetized content", () => {
    const v = input().variants[0]!;
    expect(codes(input({ variants: [{ ...v, destinationUrl: null }] }))).toContain("missing_link");
    expect(codes(input({ variants: [{ ...v, destinationUrl: "not a url" }] }))).toContain("broken_url");
  });

  it("scores: any blocker fails; otherwise threshold applies", () => {
    expect(scoreIssues([{ code: "x", severity: "blocker", message: "" }], 0).passed).toBe(false);
    const majors = Array.from({ length: 3 }, () => ({ code: "m", severity: "major" as const, message: "" }));
    expect(scoreIssues(majors, 70)).toMatchObject({ score: 64, passed: false });
    expect(scoreIssues(majors, 60).passed).toBe(true);
  });
});
