/**
 * Demo seed data. All URLs use example.com (reserved domain); all companies are fictional.
 * Product facts carry a source so generation can only repeat sourced claims.
 */
import type {
  DisclosureKind,
  DisclosurePlacement,
  EconomicOutcome,
  GenerationTier,
  MonetizationModel,
  Platform,
  ProductKind,
  RedirectPolicy,
} from "../generated/prisma/enums.ts";

// A type alias (not an interface) so it is assignable to Prisma's JSON input type.
export type SeedFact = {
  id: string;
  claim: string;
  source: string;
  verifiedAt: string;
};

export interface SeedProduct {
  sku: string;
  kind: ProductKind;
  title: string;
  description: string;
  manufacturer: string;
  category: string;
  price: string | null;
  commissionRate: string | null;
  commissionFixedUsd?: string;
  productUrl: string;
  affiliateUrl: string;
  program: string;
  tags: string[];
  facts: SeedFact[];
  economicOutcome: EconomicOutcome;
}

export interface SeedBrand {
  slug: string;
  name: string;
  description: string;
  niche: string;
  targetAudience: string;
  language: string;
  countries: string[];
  toneOfVoice: string;
  timezone: string;
  colors: { primary: string; secondary: string; accent: string; text: string; background: string };
  typography: { headingFont: string; bodyFont: string };
  ctaStyles: string[];
  contentRules: string[];
  bannedWords: string[];
  complianceNotes: string;
  monetizationModels: MonetizationModel[];
  targetPlatforms: Platform[];
  maxTier: GenerationTier;
  ttsEnabled: boolean;
  allowAiVideo: boolean;
  defaultTemplateKey: string;
  handle: string;
  disclosures: {
    kind: DisclosureKind;
    platform: Platform | null;
    text: string;
    placement: DisclosurePlacement;
    jurisdiction: string;
    notes?: string;
  }[];
  products: SeedProduct[];
}

export interface SeedProgram {
  name: string;
  network: string;
  website: string;
  defaultCommissionRate: string;
  cookieDays: number;
  redirectPolicy: RedirectPolicy;
  subIdParam: string;
  disclosureText: string;
  termsNotes: string;
}

const VERIFIED = "2026-10-01";
const SRC = "Manufacturer listing (demo data)";

export const PROGRAMS: SeedProgram[] = [
  {
    name: "Demo Beauty Network",
    network: "impact",
    website: "https://example.com/beauty-network",
    defaultCommissionRate: "0.0600",
    cookieDays: 30,
    redirectPolicy: "REDIRECT_ALLOWED",
    subIdParam: "subId1",
    disclosureText: "#ad · affiliate link",
    termsNotes: "Demo program. Redirect tracking allowed. Disclosure required.",
  },
  {
    name: "Demo Marketplace Associates",
    network: "marketplace",
    website: "https://example.com/associates",
    defaultCommissionRate: "0.0400",
    cookieDays: 1,
    redirectPolicy: "REDIRECT_ALLOWED",
    subIdParam: "ascsubtag",
    disclosureText: "As an associate I earn from qualifying purchases.",
    termsNotes: "Demo program modelled on large marketplaces: 24h cookie, sub-tag attribution.",
  },
  {
    name: "Strict Direct-Link Program",
    network: "custom",
    website: "https://example.com/strict",
    defaultCommissionRate: "0.0600",
    cookieDays: 7,
    redirectPolicy: "DIRECT_LINK_ONLY",
    subIdParam: "sid",
    disclosureText: "#ad",
    termsNotes:
      "Demo of a program whose terms forbid redirect/cloaked links: content uses the raw affiliate URL; clicks are attributed via the network's sub-id reports.",
  },
  {
    name: "Demo Home Services Leads",
    network: "custom",
    website: "https://example.com/home-leads",
    defaultCommissionRate: "0.0000",
    cookieDays: 30,
    redirectPolicy: "REDIRECT_ALLOWED",
    subIdParam: "ref",
    disclosureText: "#ad · we may earn a referral fee",
    termsNotes: "Pays a fixed fee per qualified lead.",
  },
  {
    name: "Demo SaaS Partners",
    network: "partnerstack",
    website: "https://example.com/saas-partners",
    defaultCommissionRate: "0.3000",
    cookieDays: 90,
    redirectPolicy: "REDIRECT_ALLOWED",
    subIdParam: "sub_id",
    disclosureText: "#ad | affiliate link — I may earn a commission",
    termsNotes: "30% recurring for 12 months (demo terms).",
  },
];

export const BRANDS: SeedBrand[] = [
  {
    slug: "demo-beauty",
    name: "Demo Beauty",
    description: "Simple, honest skincare picks and beauty tools under $30.",
    niche: "skincare & beauty tools",
    targetAudience:
      "Women and men aged 22-40 who want simple, science-literate skincare routines on a budget",
    language: "en",
    countries: ["US", "GB"],
    toneOfVoice:
      "Friendly and honest, explains *why* something works, zero hype, never makes medical or before/after claims",
    timezone: "America/New_York",
    colors: {
      primary: "#E8547A",
      secondary: "#FFE4EC",
      accent: "#7A2E8E",
      text: "#1F1A24",
      background: "#FFF7FA",
    },
    typography: { headingFont: "Inter", bodyFont: "Inter" },
    ctaStyles: ["Link in bio for today's price", "Save this for your next restock"],
    contentRules: [
      "Never claim to cure, treat or prevent any skin condition",
      "No before/after claims",
      "Mention a price only if it was verified in the last 7 days",
      "No fake testimonials or invented personal experiences",
    ],
    bannedWords: ["cure", "miracle", "guaranteed", "clinically proven", "dermatologist recommended"],
    complianceNotes:
      "Cosmetics: avoid drug claims. Affiliate disclosure at the start of the caption (FTC). Label realistic AI imagery.",
    monetizationModels: ["AFFILIATE"],
    targetPlatforms: ["TIKTOK", "INSTAGRAM", "FACEBOOK"],
    maxTier: "TIER_1",
    ttsEnabled: false,
    allowAiVideo: true,
    defaultTemplateKey: "vertical-clean",
    handle: "demobeauty",
    disclosures: [
      {
        kind: "AFFILIATE",
        platform: null,
        text: "#ad · affiliate link",
        placement: "CAPTION_AND_ON_SCREEN",
        jurisdiction: "US-FTC",
      },
      {
        kind: "AI_GENERATED",
        platform: null,
        text: "Some visuals are AI-generated.",
        placement: "CAPTION_END",
        jurisdiction: "platform-policy",
        notes: "Applies only when content contains realistic AI-generated imagery or video.",
      },
    ],
    products: [
      {
        sku: "DB-HA-SERUM-30",
        kind: "PRODUCT",
        title: "Hydrating Hyaluronic Acid Serum 30 ml",
        description: "Lightweight daily serum with hyaluronic acid and vitamin B5.",
        manufacturer: "Demo Skin Co.",
        category: "skincare/serum",
        price: "18.99",
        commissionRate: "0.0600",
        productUrl: "https://example.com/demo-skin/ha-serum",
        affiliateUrl: "https://example.com/aff/demo-skin/ha-serum?partner=demo-beauty",
        program: "Demo Beauty Network",
        tags: ["serum", "hydration", "fragrance-free"],
        economicOutcome: "AFFILIATE_CLICK",
        facts: [
          {
            id: "f1",
            claim: "Contains 2% hyaluronic acid and vitamin B5",
            source: SRC,
            verifiedAt: VERIFIED,
          },
          { id: "f2", claim: "30 ml glass bottle with dropper", source: SRC, verifiedAt: VERIFIED },
          { id: "f3", claim: "Fragrance-free formula", source: SRC, verifiedAt: VERIFIED },
          {
            id: "f4",
            claim: "Directions: apply morning and evening to clean skin before moisturiser",
            source: SRC,
            verifiedAt: VERIFIED,
          },
        ],
      },
      {
        sku: "DB-LASH-HEAT",
        kind: "PRODUCT",
        title: "Heated Eyelash Curler",
        description: "USB-C rechargeable heated lash curler with three heat settings.",
        manufacturer: "Demo Beauty Tools",
        category: "beauty-tools",
        price: "24.50",
        commissionRate: "0.0500",
        productUrl: "https://example.com/demo-tools-beauty/lash-curler",
        affiliateUrl: "https://example.com/aff/lash-curler?partner=demo-beauty",
        program: "Demo Beauty Network",
        tags: ["lashes", "tools"],
        economicOutcome: "AFFILIATE_CLICK",
        facts: [
          { id: "f1", claim: "USB-C rechargeable", source: SRC, verifiedAt: VERIFIED },
          { id: "f2", claim: "Three heat settings", source: SRC, verifiedAt: VERIFIED },
          {
            id: "f3",
            claim: "Heats up in about 15 seconds (manufacturer specification)",
            source: SRC,
            verifiedAt: VERIFIED,
          },
        ],
      },
      {
        sku: "DB-SPF50-MIN",
        kind: "PRODUCT",
        title: "Mineral Sunscreen SPF 50 (50 ml)",
        description: "Zinc-oxide mineral sunscreen, broad spectrum SPF 50.",
        manufacturer: "Demo Skin Co.",
        category: "skincare/sunscreen",
        price: "15.00",
        commissionRate: "0.0600",
        productUrl: "https://example.com/demo-skin/spf50",
        affiliateUrl: "https://example.com/aff/strict/spf50?sid=demo-beauty",
        program: "Strict Direct-Link Program",
        tags: ["spf", "sunscreen", "mineral"],
        economicOutcome: "AFFILIATE_CLICK",
        facts: [
          { id: "f1", claim: "Broad-spectrum SPF 50 (per label)", source: SRC, verifiedAt: VERIFIED },
          { id: "f2", claim: "Zinc oxide mineral UV filter", source: SRC, verifiedAt: VERIFIED },
          { id: "f3", claim: "50 ml tube", source: SRC, verifiedAt: VERIFIED },
        ],
      },
    ],
  },
  {
    slug: "demo-tools",
    name: "Demo Tools",
    description: "No-nonsense tool picks and home improvement tips for DIYers.",
    niche: "power tools & home improvement",
    targetAudience: "DIY homeowners and handymen aged 25-55 who want reliable tools without overpaying",
    language: "en",
    countries: ["US"],
    toneOfVoice: "Direct, practical, workshop-style. Specs and numbers over adjectives. Light humour.",
    timezone: "America/Chicago",
    colors: {
      primary: "#F2A900",
      secondary: "#2B2B2B",
      accent: "#FF5A1F",
      text: "#FFFFFF",
      background: "#121212",
    },
    typography: { headingFont: "Inter", bodyFont: "Inter" },
    ctaStyles: ["Check today's price — link in bio", "Comment DRILL and we'll send you the link"],
    contentRules: [
      "State specs exactly as listed — never round up",
      "Mention eye protection whenever cutting or drilling is shown",
      "No durability claims without a source",
    ],
    bannedWords: ["indestructible", "lifetime guarantee", "best in the world"],
    complianceNotes:
      "Affiliate disclosure at caption start (FTC). Lead-gen posts must say we may earn a referral fee.",
    monetizationModels: ["AFFILIATE", "LEAD_GENERATION"],
    targetPlatforms: ["TIKTOK", "INSTAGRAM", "FACEBOOK"],
    maxTier: "TIER_2",
    ttsEnabled: true,
    allowAiVideo: true,
    defaultTemplateKey: "vertical-bold",
    handle: "demotools",
    disclosures: [
      {
        kind: "AFFILIATE",
        platform: null,
        text: "#ad · affiliate link",
        placement: "CAPTION_AND_ON_SCREEN",
        jurisdiction: "US-FTC",
      },
      {
        kind: "AI_GENERATED",
        platform: null,
        text: "Some visuals are AI-generated.",
        placement: "CAPTION_END",
        jurisdiction: "platform-policy",
      },
    ],
    products: [
      {
        sku: "DT-DRILL-20V",
        kind: "PRODUCT",
        title: "20V Cordless Drill/Driver Kit",
        description: "Compact 20V drill/driver with two batteries and charger.",
        manufacturer: "Demo Power Tools",
        category: "power-tools/drills",
        price: "89.00",
        commissionRate: "0.0400",
        productUrl: "https://example.com/demo-power/drill-20v",
        affiliateUrl: "https://example.com/aff/marketplace/drill-20v?tag=demotools-20",
        program: "Demo Marketplace Associates",
        tags: ["drill", "cordless", "kit"],
        economicOutcome: "AFFILIATE_CLICK",
        facts: [
          { id: "f1", claim: "20V max lithium-ion battery platform", source: SRC, verifiedAt: VERIFIED },
          { id: "f2", claim: "2-speed gearbox: 0-450 and 0-1,500 RPM", source: SRC, verifiedAt: VERIFIED },
          { id: "f3", claim: "Kit includes 2 batteries and a charger", source: SRC, verifiedAt: VERIFIED },
          { id: "f4", claim: "1/2-inch keyless chuck", source: SRC, verifiedAt: VERIFIED },
        ],
      },
      {
        sku: "DT-LASER-165",
        kind: "PRODUCT",
        title: "Laser Distance Measure 165 ft",
        description: "Pocket laser measure with area and volume functions.",
        manufacturer: "Demo Power Tools",
        category: "measuring",
        price: "39.99",
        commissionRate: "0.0400",
        productUrl: "https://example.com/demo-power/laser-165",
        affiliateUrl: "https://example.com/aff/marketplace/laser-165?tag=demotools-20",
        program: "Demo Marketplace Associates",
        tags: ["laser", "measuring"],
        economicOutcome: "AFFILIATE_CLICK",
        facts: [
          { id: "f1", claim: "Measures distances up to 165 ft", source: SRC, verifiedAt: VERIFIED },
          {
            id: "f2",
            claim: "Accuracy ±1/16 inch (manufacturer specification)",
            source: SRC,
            verifiedAt: VERIFIED,
          },
          { id: "f3", claim: "Calculates area and volume", source: SRC, verifiedAt: VERIFIED },
        ],
      },
      {
        sku: "DT-LEAD-BATH",
        kind: "SERVICE",
        title: "Bathroom Remodel Quote (Austin, TX)",
        description: "Free remodel quote from a partner network of local contractors.",
        manufacturer: "Demo Home Services",
        category: "services/remodeling",
        price: null,
        commissionRate: null,
        commissionFixedUsd: "25.00",
        productUrl: "https://example.com/home-leads/bathroom-austin",
        affiliateUrl: "https://example.com/home-leads/bathroom-austin?ref=demotools",
        program: "Demo Home Services Leads",
        tags: ["lead", "remodel", "local"],
        economicOutcome: "LEAD",
        facts: [
          {
            id: "f1",
            claim: "Free, no-obligation quote",
            source: "Partner terms (demo data)",
            verifiedAt: VERIFIED,
          },
          {
            id: "f2",
            claim: "Contractors in the partner network are licensed and insured",
            source: "Partner terms (demo data)",
            verifiedAt: VERIFIED,
          },
          {
            id: "f3",
            claim: "Serves the Austin, TX metro area",
            source: "Partner terms (demo data)",
            verifiedAt: VERIFIED,
          },
        ],
      },
    ],
  },
  {
    slug: "demo-saas",
    name: "Demo SaaS",
    description: "AI and automation tools that save small teams hours every week.",
    niche: "AI & productivity software",
    targetAudience: "Solo founders, freelancers and small teams who want to automate admin work",
    language: "en",
    countries: ["US", "GB", "PL", "DE"],
    toneOfVoice: "Smart, concise, benefit-first. Show the workflow. No buzzword soup, no income claims.",
    timezone: "Europe/Warsaw",
    colors: {
      primary: "#4F46E5",
      secondary: "#E0E7FF",
      accent: "#10B981",
      text: "#0F172A",
      background: "#F8FAFC",
    },
    typography: { headingFont: "Inter", bodyFont: "Inter" },
    ctaStyles: ["Try it free — link in bio", "Grab the template from the link in bio"],
    contentRules: [
      "Describe product workflows only from listed facts",
      "State free-trial terms exactly",
      "No income or revenue claims",
    ],
    bannedWords: ["get rich", "passive income guaranteed", "10x your revenue"],
    complianceNotes: "Affiliate disclosure at caption start. Own products need no affiliate disclosure.",
    monetizationModels: ["AFFILIATE", "DIGITAL_PRODUCT"],
    targetPlatforms: ["TIKTOK", "INSTAGRAM", "FACEBOOK"],
    maxTier: "TIER_1",
    ttsEnabled: true,
    allowAiVideo: false,
    defaultTemplateKey: "vertical-clean",
    handle: "demosaas",
    disclosures: [
      {
        kind: "AFFILIATE",
        platform: null,
        text: "#ad | affiliate link",
        placement: "CAPTION_AND_ON_SCREEN",
        jurisdiction: "US-FTC / EU-UCPD",
      },
    ],
    products: [
      {
        sku: "DS-NOTES-PRO",
        kind: "PRODUCT",
        title: "Demo AI Meeting Notes — Pro plan",
        description: "AI note-taker for video calls with automatic action items.",
        manufacturer: "Demo Notes Inc.",
        category: "software/productivity",
        price: "12.00",
        commissionRate: "0.3000",
        productUrl: "https://example.com/demo-notes/pricing",
        affiliateUrl: "https://example.com/aff/saas/demo-notes?via=demosaas",
        program: "Demo SaaS Partners",
        tags: ["ai", "meetings", "saas"],
        economicOutcome: "EMAIL_SIGNUP",
        facts: [
          {
            id: "f1",
            claim: "Records and transcribes Zoom, Google Meet and Microsoft Teams calls",
            source: SRC,
            verifiedAt: VERIFIED,
          },
          {
            id: "f2",
            claim: "14-day free trial, no credit card required",
            source: SRC,
            verifiedAt: VERIFIED,
          },
          { id: "f3", claim: "Exports action items to Notion and Slack", source: SRC, verifiedAt: VERIFIED },
          {
            id: "f4",
            claim: "Pro plan costs $12 per user per month (billed monthly)",
            source: SRC,
            verifiedAt: VERIFIED,
          },
        ],
      },
      {
        sku: "DS-INVOICE-PACK",
        kind: "OWN_PRODUCT",
        title: "Invoice Automation Template Pack",
        description: "12 Notion templates for invoicing and payment tracking.",
        manufacturer: "Demo SaaS (own product)",
        category: "digital/templates",
        price: "19.00",
        commissionRate: "1.0000",
        productUrl: "https://example.com/demo-saas/invoice-pack",
        affiliateUrl: "https://example.com/demo-saas/invoice-pack?utm_source=social",
        program: "Demo SaaS Partners",
        tags: ["notion", "templates", "invoicing"],
        economicOutcome: "SALE",
        facts: [
          {
            id: "f1",
            claim: "12 Notion templates for invoices and payment tracking",
            source: "Own product page",
            verifiedAt: VERIFIED,
          },
          {
            id: "f2",
            claim: "Instant download after purchase",
            source: "Own product page",
            verifiedAt: VERIFIED,
          },
          { id: "f3", claim: "One-time payment of $19", source: "Own product page", verifiedAt: VERIFIED },
        ],
      },
    ],
  },
];

/** Default daily posting slots (brand local time). */
export const DEFAULT_SLOTS: { platform: Platform; timeOfDay: string }[] = [
  { platform: "TIKTOK", timeOfDay: "12:00" },
  { platform: "INSTAGRAM", timeOfDay: "15:00" },
  { platform: "FACEBOOK", timeOfDay: "18:00" },
];

export const SYSTEM_TEMPLATES = [
  {
    key: "vertical-bold",
    name: "Vertical Bold",
    kind: "VIDEO" as const,
    spec: { preset: "vertical-bold", description: "Heavy headline type, boxed captions, punchy zooms" },
  },
  {
    key: "vertical-clean",
    name: "Vertical Clean",
    kind: "VIDEO" as const,
    spec: { preset: "vertical-clean", description: "Light layout, soft fades, centred product cards" },
  },
  {
    key: "static-card",
    name: "Static Product Card",
    kind: "STATIC" as const,
    spec: { preset: "static-card", description: "4:5 product card with headline, price badge and CTA" },
  },
];
