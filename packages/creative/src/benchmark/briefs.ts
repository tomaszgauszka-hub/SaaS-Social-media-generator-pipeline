import type { CreativeBriefInput } from "../brief.ts";
import { demoMedia } from "./media.ts";

/**
 * The six DEMO_ONLY benchmark products (spec §73–§75). Fictional, generic products with illustrative specs:
 * no affiliate URLs, no merchant, never published. Each uses a different creative structure and style kit so the
 * benchmark proves the engine produces visibly different reels per category. Copy avoids test claims, reviews,
 * testimonials and (for beauty) any skin / medical claims.
 */
const DISCLOSURE = "Ad · affiliate link (demo)";
const DEMO_SUB = "Demo creative — no live offer";

export const BENCH_TOOLS: CreativeBriefInput = {
  id: "bench-tools-drill",
  title: "20V Cordless Drill/Driver Kit — spec breakdown",
  category: "tools",
  structure: "SPEC_BREAKDOWN",
  demoOnly: true,
  product: {
    name: "20V Cordless Drill/Driver Kit",
    shortName: "20V Drill/Driver Kit",
    eyebrow: "Spec breakdown",
    tagline: "2 speeds · 21 clutch settings · LED light",
  },
  heroMedia: "drill",
  media: [demoMedia("drill"), demoMedia("drill_work")],
  hook: {
    text: "Every spec of this *20V drill* in 25 seconds",
    strategy: "spec promise — product on screen from frame 0",
  },
  features: [
    {
      id: "chuck",
      title: "*13 mm* keyless chuck — no key, fast bit swaps",
      anchor: "chuck",
      zoom: 2.5,
      animate: {
        spin: [
          { atMs: 200, value: 0 },
          { atMs: 900, value: 0.6 },
        ],
      },
    },
    {
      id: "clutch",
      title: "*21* clutch settings + drill mode",
      anchor: "clutch",
      zoom: 2.7,
      animate: {
        torque: [
          { atMs: 200, value: 3 },
          { atMs: 1700, value: 18 },
        ],
      },
      stat: {
        value: 45,
        unit: "Nm",
        label: "Max torque",
        style: "gauge",
        max: 60,
        params: { spin: 1, trigger: 1 },
      },
    },
    { id: "led", title: "LED work light for dark corners", anchor: "led", zoom: 2.1, params: { led: 1 } },
  ],
  inUse: {
    media: "drill_work",
    text: "Drives screws *flush* into timber",
    textPosition: "top",
    animate: {
      drive: [
        { atMs: 200, value: 0 },
        { atMs: 2400, value: 1 },
      ],
    },
    particles: {
      variant: "dust",
      direction: "out",
      box: { x: 330, y: 860, w: 90, h: 90 },
      density: 0.7,
      delayMs: 250,
    },
  },
  specs: {
    title: "The numbers",
    items: [
      { label: "Voltage", value: "20 V" },
      { label: "Chuck", value: "13 mm keyless" },
      { label: "Speeds", value: "0–450 / 0–1,700 rpm" },
      { label: "Clutch", value: "21 + drill" },
      { label: "Weight", value: "1.4 kg" },
    ],
  },
  cta: { headline: "Kit contents and price at the link", button: "See the kit", sub: DEMO_SUB },
  disclosure: DISCLOSURE,
  targetDurationMs: 24_000,
};

export const BENCHMARK_BRIEFS: CreativeBriefInput[] = [BENCH_TOOLS];
