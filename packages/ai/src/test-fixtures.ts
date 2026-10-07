import type { BrandPromptContext, ProductPromptContext } from "./prompts/contexts.ts";

/** Shared test fixtures (not exported from the package entry point). */
export const brandFixture: BrandPromptContext = {
  name: "Demo Tools",
  niche: "power tools & home improvement",
  targetAudience: "DIY homeowners and handymen aged 25-55 who want reliable tools without overpaying",
  toneOfVoice: "Direct, practical, workshop-style",
  language: "en",
  countries: ["US"],
  contentRules: ["State specs exactly as listed", "Mention eye protection when drilling"],
  bannedWords: ["indestructible", "lifetime guarantee"],
  ctaStyles: ["Check today's price — link in bio"],
  complianceNotes: "Affiliate disclosure at caption start (FTC).",
  monetizationModels: ["AFFILIATE"],
};

export const productFixture: ProductPromptContext = {
  id: "prod_drill",
  title: "20V Cordless Drill/Driver Kit",
  kind: "PRODUCT",
  manufacturer: "Demo Power Tools",
  category: "power-tools/drills",
  description: "Compact 20V drill/driver with two batteries and charger.",
  priceText: "$89.00",
  commissionText: "4% commission",
  tags: ["drill", "cordless", "kit"],
  economicOutcome: "AFFILIATE_CLICK",
  facts: [
    { id: "f1", claim: "20V max lithium-ion battery platform", source: "manufacturer" },
    { id: "f2", claim: "2-speed gearbox: 0-450 and 0-1,500 RPM", source: "manufacturer" },
    { id: "f3", claim: "Kit includes 2 batteries and a charger", source: "manufacturer" },
  ],
};
