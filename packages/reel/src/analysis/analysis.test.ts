import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProductFact, ProductSource } from "../contracts/product.ts";
import { ingestAboProduct } from "../ingest/abo.ts";
import { classifyCategory, emitsLightOf } from "./deterministic.ts";

const src = (
  over: Partial<Pick<ProductSource, "category" | "categoryPath" | "names">>,
  facts: Pick<ProductFact, "id" | "kind" | "text">[] = [],
): Pick<ProductSource, "category" | "categoryPath" | "names" | "facts"> => ({
  category: "other",
  names: {},
  ...over,
  facts: facts.map((f) => ({ ...f, source: "catalog" })) as ProductFact[],
});

describe("category", () => {
  it("never reads a colour or weight word as a light source", () => {
    const sofa = src({
      category: "Sofas",
      categoryPath: "Home & Kitchen/Furniture/Living Room Furniture/Sofas",
      names: { "en-US": 'Rivet Revolve Modern Upholstered Sofa, 80"W, Light Grey' },
    });
    expect(classifyCategory(sofa)).toEqual({ category: "home", from: "category" });
    expect(emitsLightOf(sofa)).toBe(false);
    const chair = src({ category: "other", names: { "en-US": "AmazonBasics Lightweight Folding Chair" } });
    expect(classifyCategory(chair).category).toBe("home");
    const rug = src({ category: "RUG", names: { "en-US": "Stone & Beam Flatweave Rug, Light Blue" } });
    expect(classifyCategory(rug).category).toBe("home");
    expect(emitsLightOf(rug)).toBe(false);
  });

  it("reads the leaf before the path (Home & Kitchen/…/Sofas is home, not kitchen) and needs evidence from names", () => {
    expect(
      classifyCategory(src({ category: "x", categoryPath: "Home & Kitchen/Furniture/Sofas" })).category,
    ).toBe("home");
    // named a lamp but filed nowhere: lighting, but a light source only with facts that say so
    const named = src({ names: { "en-US": "Ceramic Table Lamp" } });
    expect(classifyCategory(named)).toEqual({ category: "lighting", from: "name" });
    expect(emitsLightOf(named)).toBe(false);
    expect(
      emitsLightOf({
        ...named,
        facts: [{ id: "bp", kind: "feature", text: "LED bulb included", source: "catalog" }] as ProductFact[],
      }),
    ).toBe(true);
    // a drill's work light is an accessory, not a light source
    const drill = src({ category: "Power Drills" }, [
      { id: "bp", kind: "feature", text: "Built-in LED work light" },
    ]);
    expect(classifyCategory(drill).category).toBe("tools");
    expect(emitsLightOf(drill)).toBe(false);
  });

  const abo = path.resolve(import.meta.dirname, "../../../../.data/products/abo");
  const lamps = fs.existsSync(abo)
    ? fs.readdirSync(abo).filter((d) => fs.existsSync(path.join(abo, d, "listing.json")))
    : [];
  it.skipIf(!lamps.length)(
    "keeps every real ABO table lamp a light source",
    async () => {
      for (const id of lamps) {
        const s = await ingestAboProduct(path.join(abo, id));
        expect(classifyCategory(s).category, id).toBe("lighting");
        expect(emitsLightOf(s), id).toBe(true);
      }
    },
    60_000,
  );
});
