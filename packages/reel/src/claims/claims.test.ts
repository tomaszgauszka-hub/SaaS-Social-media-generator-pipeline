import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GoogleAI } from "@cre/providers";
import { describe, expect, it } from "vitest";
import type { CallContext } from "../capabilities/types.ts";
import { SafeId } from "../contracts/ids.ts";
import type { LocaleCopy } from "../contracts/plan.ts";
import { ProductSource, type ProductFact } from "../contracts/product.ts";
import { CostTracker } from "../cost/tracker.ts";
import { ratingFact } from "../director/hooks.ts";
import { loadProductSourceJson } from "../ingest/abo.ts";
import { GeminiTranscreation } from "../localize/gemini.ts";
import { validateCopy } from "./validate.ts";

const fact = (id: string, kind: ProductFact["kind"], text: string, value?: number): ProductFact =>
  ({ id, kind, text, source: "catalog", ...(value !== undefined ? { value } : {}) }) as ProductFact;

const source = (facts: ProductFact[]) =>
  ProductSource.parse({
    id: "lamp-1",
    names: { "en-US": "Table Lamp" },
    category: "Table Lamps",
    facts,
    images: [],
    brand: "Test",
    source: { kind: "json", ref: "test", license: "test" },
  });

const copy = (
  text: string,
  factIds: string[] = [],
  locale = "en-US",
  kind: "voice" | "disclosure" = "voice",
) =>
  ({
    locale,
    market: locale.slice(3),
    slots: { [kind === "disclosure" ? "disclosure" : "voice.1.x"]: { kind, text, factIds } },
    transcreation: { provider: "t", model: "t", sourceLocale: "en-US", isMaster: true },
  }) as LocaleCopy;

const codes = (
  text: string,
  facts: ProductFact[] = [],
  opts: { modelWritten?: boolean } = {},
  ids: string[] = [],
) =>
  validateCopy(copy(text, ids), source(facts), { forbiddenPhrases: [] }, undefined, opts)
    .filter((i) => i.severity === "blocker")
    .map((i) => i.code);

describe("claim validation", () => {
  const base = [fact("h", "dimension", "Height 55 cm", 55), fact("c", "color", "Black metal base")];

  it("blocks fabricated social proof, free shipping and urgency in every language", () => {
    for (const t of [
      "Over 10000 happy customers",
      "Loved by thousands of customers",
      "I've used it every night for 2 years",
      "Klienci kochają tę lampę",
      "Kunden lieben sie",
      "Me encanta esta lámpara",
    ])
      expect(codes(t, base), t).toContain("social_proof");
    for (const t of [
      "Free shipping today only",
      "Kostenloser Versand – nur heute!",
      "Darmowa dostawa, ostatnie sztuki!",
    ])
      expect(
        codes(t, base).some((c) => c === "unsupported_shipping" || c === "unsupported_urgency"),
        t,
      ).toBe(true);
  });

  it("model-written copy: an invented number or colour is a blocker (a template line keeps the warning)", () => {
    expect(codes("3 brightness levels", base, { modelWritten: true })).toContain("invented_number");
    expect(codes("3 brightness levels", base)).not.toContain("invented_number");
    expect(codes("Now in gold and silver", base, { modelWritten: true })).toContain("color_mismatch");
    const warranty = [...base, fact("w", "warranty", "2 year manufacturer warranty", 2)];
    expect(codes("5-year warranty", warranty, { modelWritten: true }, ["w"])).toContain("invented_number");
    expect(codes("2-year warranty", warranty, { modelWritten: true }, ["w"])).toEqual([]);
  });

  it("a rating claim needs a real rating fact, not the word 'review' in the instructions", () => {
    const instructions = [...base, fact("u", "usage", "Please review the assembly instructions before use")];
    expect(codes("Rated 4.9/5 by our buyers", instructions)).toContain("unsupported_reviews");
    expect(ratingFact(instructions)).toBeUndefined();
    expect(ratingFact([fact("e", "performance", "Energy rating A+ (8 kWh/1000 h)", 8)])).toBeUndefined();
    const rated = [fact("r", "rating", "4.6 out of 5 stars", 4.6)];
    expect(ratingFact(rated)?.id).toBe("r");
    expect(codes("Rated 4.6/5", rated, {}, ["r"])).toEqual([]);
  });

  it("the disclosure must read exactly what the brand configured for the locale", () => {
    const brand = { forbiddenPhrases: [], disclosure: { "de-DE": "Werbung · Affiliate-Link" } };
    const v = (text: string) =>
      validateCopy(copy(text, [], "de-DE", "disclosure"), source(base), brand).map((i) => i.code);
    expect(v("Werbung · Affiliate-Link")).toEqual([]);
    expect(v("Link in der Bio")).toContain("disclosure_altered");
  });
});

describe("Gemini transcreation never touches the disclosure", () => {
  it("does not send it to the model and writes the brand's text itself", async () => {
    let payload = "";
    const ai = {
      hasApiKey: true,
      estimateGenerateMicros: () => 1,
      generate: (req: { parts: { text: string }[] }) => {
        payload = req.parts[0]!.text;
        return Promise.resolve({
          text: "",
          json: {
            locales: [
              { locale: "de-DE", slots: [{ id: "voice.1.x", text: "Sockel aus Walnuss.", factIds: [] }] },
            ],
          },
          usage: { inputTokens: 10, outputTokens: 10, thoughtsTokens: 0, cachedTokens: 0 },
          model: "m",
          latencyMs: 1,
          costMicros: 1,
        });
      },
    } as unknown as GoogleAI;
    const master = {
      ...copy("A walnut base.", [], "en-US"),
      slots: {
        "voice.1.x": { kind: "voice" as const, text: "A walnut base.", factIds: [] },
        disclosure: { kind: "disclosure" as const, text: "Ad · affiliate link", factIds: [] },
      },
    } as LocaleCopy;
    const ctx: CallContext = {
      workDir: os.tmpdir(),
      cacheDir: os.tmpdir(),
      scope: "t",
      tracker: new CostTracker(),
    };
    const [de] = await new GeminiTranscreation(ai, "m").transcreate(
      {
        master,
        targets: [{ locale: "de-DE", market: "DE" }],
        product: {} as never,
        productNames: {},
        facts: [],
        brand: {
          brandName: "b",
          forbiddenPhrases: [],
          preferredCTA: {},
          disclosure: { "de-DE": "Werbung · Affiliate-Link" },
        },
        limits: { "voice.1.x": 80 },
      },
      ctx,
    );
    expect(payload).not.toContain("affiliate");
    expect(de!.slots.disclosure?.text).toBe("Werbung · Affiliate-Link");
  });
});

describe("ids and paths from payloads", () => {
  it("ids that become file names cannot leave their root", () => {
    for (const ok of ["e2e-lamp-3", "batch-B075X2FZSM-1a2b3c", "B075X2FZSM", "reel-x-20261010"])
      expect(SafeId.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["../../etc", "a/b", "..", "a..b", "", ".hidden", "x y"])
      expect(SafeId.safeParse(bad).success, bad).toBe(false);
  });

  it("product JSON media paths must stay inside the product's directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-product-"));
    const write = (img: string) => {
      const f = path.join(dir, "product.json");
      fs.writeFileSync(
        f,
        JSON.stringify({
          id: "p1",
          names: { "en-US": "Lamp" },
          category: "Lamps",
          facts: [],
          brand: "Test",
          images: [{ path: img, role: "main", license: "test" }],
          source: { kind: "json", ref: "test", license: "test" },
        }),
      );
      return f;
    };
    expect(loadProductSourceJson(write("images/main.jpg")).images[0]!.path).toBe(
      path.join(dir, "images/main.jpg"),
    );
    expect(() => loadProductSourceJson(write("../../etc/passwd"))).toThrow(/leaves/);
    expect(() => loadProductSourceJson(write("/etc/passwd"))).toThrow(/leaves/);
  });
});
