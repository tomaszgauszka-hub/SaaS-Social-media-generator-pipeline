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
  // mid-hero the drill comes alive: trigger pulled, LED work light on, chuck spinning
  heroAnimate: {
    trigger: [
      { atMs: 1500, value: 0 },
      { atMs: 1700, value: 1 },
    ],
    led: [
      { atMs: 1550, value: 0 },
      { atMs: 1750, value: 1 },
    ],
    spin: [
      { atMs: 1600, value: 0 },
      { atMs: 2400, value: 1 },
    ],
  },
  media: [demoMedia("drill"), demoMedia("drill_work")],
  hook: {
    text: "Every spec of this *20V drill*, broken down",
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

export const BENCH_GADGETS: CreativeBriefInput = {
  id: "bench-gadgets-hub",
  title: "8-in-1 USB-C Hub — product demo",
  category: "gadgets",
  structure: "PRODUCT_DEMO",
  demoOnly: true,
  product: {
    name: "8-in-1 USB-C Hub",
    shortName: "8-in-1 USB-C Hub",
    eyebrow: "One cable, eight ports",
    tagline: "HDMI · Ethernet · SD · 100 W pass-through",
  },
  heroMedia: "hub",
  media: [demoMedia("hub"), demoMedia("hub_screen"), demoMedia("desk_before"), demoMedia("desk_after")],
  hook: {
    text: "Two ports on your laptop? *Make it eight.*",
    strategy: "relatable limit → product answer, product from frame 0",
  },
  calloutsTitle: "What's on the side",
  features: [
    { id: "hdmi", title: "4K HDMI to any screen", callout: "4K HDMI out", anchor: "hdmi" },
    { id: "ethernet", title: "Gigabit Ethernet", callout: "Gigabit Ethernet", anchor: "ethernet" },
    {
      id: "pd",
      title: "Charge through the hub",
      callout: "100 W pass-through",
      anchor: "pd",
      stat: {
        value: 100,
        unit: "W",
        label: "Pass-through charging",
        style: "bar",
        max: 100,
        params: { glow: "pd" },
      },
    },
    {
      id: "sd",
      title: "*SD + microSD* readers, side by side",
      anchor: "sd",
      zoom: 3.4,
      params: { glow: "sd" },
    },
  ],
  screen: {
    headline: "Plug in once — *everything* connects",
    caption: "Display, network, storage and charging",
    media: "hub_screen",
    animate: {
      items: [
        { atMs: 250, value: 0 },
        { atMs: 1500, value: 6 },
      ],
      toggle: [
        { atMs: 1750, value: 0 },
        { atMs: 1950, value: 1 },
      ],
    },
    cursor: [
      { x: 0.42, y: 0.9 },
      { x: 0.62, y: 0.74 },
      { x: 0.727, y: 0.626 },
    ],
    clickAtMs: [1450],
  },
  sideBySide: {
    headline: "Five dongles *or one hub*",
    left: "desk_before",
    right: "desk_after",
    leftLabel: "Dongles",
    rightLabel: "One hub",
  },
  cta: { headline: "All 8 ports and specs at the link", button: "See the hub", sub: DEMO_SUB },
  disclosure: DISCLOSURE,
  targetDurationMs: 24_000,
};

export const BENCH_HOME: CreativeBriefInput = {
  id: "bench-home-cabinet-light",
  title: "Motion Sensor LED Cabinet Light — problem / solution",
  category: "home",
  structure: "PROBLEM_SOLUTION",
  demoOnly: true,
  product: {
    name: "Motion Sensor LED Cabinet Light",
    shortName: "Motion-Sensor Cabinet Light",
    eyebrow: "Rechargeable · stick-on",
    tagline: "On when you're near, off when you leave",
  },
  heroMedia: "cabinet_light",
  heroParams: { light: 1 },
  media: [demoMedia("cabinet_light"), demoMedia("cabinet_scene")],
  hook: {
    text: "Searching your cabinets *in the dark*?",
    strategy: "relatable night-time problem; product inset at 0.7 s",
  },
  problem: {
    media: "cabinet_scene",
    text: "Searching your cabinets in the dark?",
    params: { light: 0, mounted: 0 },
    productInset: true,
  },
  solution: {
    media: "cabinet_scene",
    text: "It lights up *the moment* you open the door",
    params: { mounted: 1 },
    animate: {
      light: [
        { atMs: 600, value: 0 },
        { atMs: 1000, value: 1 },
      ],
      sense: [
        { atMs: 0, value: 1 },
        { atMs: 1000, value: 1 },
        { atMs: 1500, value: 0 },
      ],
    },
  },
  features: [
    {
      id: "battery",
      title: "USB-C rechargeable",
      stat: {
        value: 30,
        unit: "days",
        label: "Up to, per USB-C charge",
        style: "plain",
        params: { light: 1 },
      },
    },
  ],
  steps: {
    title: "Installs in a minute",
    items: ["Charge it via USB-C", "Stick the magnetic strip", "Snap the light on", "Walk by — it turns on"],
    media: "cabinet_light",
    param: "install",
    params: { shelf: 1, light: 0 },
  },
  inUse: {
    media: "cabinet_scene",
    text: "Wardrobes, pantries, *under the sink*",
    params: { view: "wardrobe" },
    animate: {
      light: [
        { atMs: 200, value: 0 },
        { atMs: 600, value: 1 },
      ],
    },
    timer: { seconds: 20, label: "Auto-off after 20 s" },
  },
  beforeAfter: {
    headline: "Same cabinet, *night and day*",
    before: "cabinet_scene",
    after: "cabinet_scene",
    beforeLabel: "Before",
    afterLabel: "After",
    beforeParams: { light: 0, mounted: 0 },
    afterParams: { light: 1 },
  },
  cta: { headline: "Sizes and multi-packs at the link", button: "See the light", sub: DEMO_SUB },
  disclosure: DISCLOSURE,
  targetDurationMs: 25_000,
};

export const BENCH_AUTOMOTIVE: CreativeBriefInput = {
  id: "bench-automotive-car-vacuum",
  title: "Cordless Handheld Car Vacuum — demonstration",
  category: "automotive",
  structure: "TEST_RESULT",
  demoOnly: true,
  product: {
    name: "Cordless Handheld Car Vacuum",
    shortName: "Cordless Car Vacuum",
    eyebrow: "Handheld · USB-C",
    tagline: "Crevice nozzle · clear cyclone bin · washable filter",
  },
  heroMedia: "car_vacuum",
  heroParams: { power: 0, fill: 0.1 },
  media: [demoMedia("car_vacuum"), demoMedia("car_interior"), demoMedia("car_mat")],
  hook: {
    text: "Crumbs in the seat gap? *Watch this.*",
    strategy: "demonstration promise over the mess; product inset at 0.7 s",
    scene: { media: "car_interior", text: "", params: { vacuum: 0, crumbs: 1 }, productInset: true },
  },
  inUse: {
    media: "car_interior",
    text: "The crevice nozzle *reaches the gap*",
    params: { vacuum: 1, power: 1 },
    animate: {
      crumbs: [
        { atMs: 300, value: 1 },
        { atMs: 2500, value: 0.08 },
      ],
      fill: [
        { atMs: 300, value: 0.15 },
        { atMs: 2500, value: 0.4 },
      ],
    },
    particles: {
      variant: "crumbs",
      direction: "in",
      box: { x: 250, y: 1020, w: 600, h: 110 },
      sink: { x: 430, y: 1092 },
      density: 0.85,
      delayMs: 300,
    },
  },
  features: [
    {
      id: "suction",
      title: "Strong cyclone suction",
      stat: {
        value: 8000,
        unit: "Pa",
        label: "Suction",
        style: "gauge",
        max: 10000,
        params: { power: 1, fill: 0.3 },
      },
    },
    { id: "nozzle", title: "Crevice nozzle", callout: "Crevice nozzle", anchor: "nozzle" },
    { id: "bin", title: "Clear cyclone bin", callout: "Clear, washable bin", anchor: "bin" },
    { id: "button", title: "One-touch power", callout: "One-touch power", anchor: "button" },
  ],
  calloutsTitle: "Built for car interiors",
  beforeAfter: {
    headline: "Floor mat, *before and after*",
    before: "car_mat",
    after: "car_mat",
    beforeLabel: "Before",
    afterLabel: "After",
    beforeParams: { dirt: 1 },
    afterParams: { dirt: 0 },
  },
  cta: { headline: "Nozzles, battery and price at the link", button: "See the vacuum", sub: DEMO_SUB },
  disclosure: DISCLOSURE,
  targetDurationMs: 23_000,
};

export const BENCH_BEAUTY: CreativeBriefInput = {
  id: "bench-beauty-sunscreen",
  title: "Mineral Sun Fluid SPF 50 — product hero",
  category: "beauty",
  // beauty shot grammar: lit hero → packaging macro → ritual → how it works → texture → benefit montage → hero
  structure: "PRODUCT_HERO",
  demoOnly: true,
  product: {
    name: "Mineral Sun Fluid SPF 50",
    shortName: "Mineral Sun Fluid",
    eyebrow: "Mineral SPF 50",
    tagline: "Zinc oxide · sheer finish · 50 ml",
  },
  heroMedia: "sun_tube",
  media: [
    demoMedia("sun_tube"),
    demoMedia("sun_podium"),
    demoMedia("sun_vanity"),
    demoMedia("sun_mineral"),
    demoMedia("sun_texture"),
    demoMedia("sun_outdoor"),
    demoMedia("sun_flatlay"),
  ],
  hook: {
    text: "Mineral SPF 50, *no white cast*",
    strategy: "premium hero shot from frame 0, light sweeping across the tube; five-word promise",
    scene: {
      media: "sun_podium",
      text: "",
      params: { variant: "podium" },
      animate: {
        sheen: [
          { atMs: 0, value: 0.05 },
          { atMs: 2600, value: 0.95 },
        ],
      },
      textPosition: "top",
      textTone: "dark",
    },
  },
  features: [
    {
      id: "spf",
      title: "",
      anchor: "spf",
      zoom: 1.1,
      animate: {
        sheen: [
          { atMs: 0, value: 0 },
          { atMs: 2400, value: 1 },
        ],
      },
      chips: [
        { icon: "shield", label: "SPF 50" },
        { icon: "crystal", label: "Mineral zinc oxide filter" },
      ],
    },
  ],
  lifestyle: {
    media: "sun_vanity",
    text: "Your morning *SPF* step",
    textPosition: "top",
    textTone: "dark",
    animate: {
      light: [
        { atMs: 0, value: 0.55 },
        { atMs: 1800, value: 1 },
      ],
    },
  },
  ingredient: {
    media: "sun_mineral",
    title: "How a *mineral* filter works",
    chips: [
      { icon: "crystal", label: "Zinc oxide", at: { x: 0.26, y: 0.585 } },
      { icon: "layers", label: "Sits on top of skin", at: { x: 0.45, y: 0.45 } },
      { icon: "sun", label: "Reflects UV light", at: { x: 0.6, y: 0.31 } },
    ],
  },
  inUse: {
    media: "sun_texture",
    text: "Blends in — *no white cast*",
    textPosition: "bottom",
    textTone: "dark",
    animate: {
      spread: [
        { atMs: 400, value: 0 },
        { atMs: 2500, value: 1 },
      ],
    },
  },
  montage: {
    shots: [
      {
        media: "sun_texture",
        label: "Sheer, weightless finish",
        icon: "feather",
        params: { view: "swatch" },
        zoom: 1.1,
      },
      { media: "sun_flatlay", label: "Fragrance-free", icon: "leaf", focus: "product", zoom: 1.08 },
      { media: "sun_outdoor", label: "50 ml — fits any bag", icon: "bag", focus: "product", zoom: 1.15 },
    ],
  },
  heroReturn: {
    media: "sun_podium",
    title: "Mineral Sun Fluid",
    tagline: "SPF 50 · zinc oxide",
    params: { variant: "shadow" },
    animate: {
      sheen: [
        { atMs: 0, value: 0.1 },
        { atMs: 2600, value: 0.9 },
      ],
    },
  },
  cta: {
    headline: "Find it at the link",
    button: "Shop the fluid",
    sub: DEMO_SUB,
    scene: { media: "sun_vanity", focus: "product", zoom: 1.45 },
  },
  disclosure: DISCLOSURE,
  targetDurationMs: 22_000,
};

export const BENCH_PET: CreativeBriefInput = {
  id: "bench-pet-grooming-kit",
  title: "Pet Grooming Vacuum Kit — before / after",
  category: "pet",
  structure: "BEFORE_AFTER",
  demoOnly: true,
  product: {
    name: "Pet Grooming Vacuum & Deshedding Kit",
    shortName: "Pet Grooming Vacuum Kit",
    eyebrow: "Deshedding kit",
    tagline: "Brushes loose fur straight into the cup",
  },
  heroMedia: "groom_kit",
  heroParams: { fill: 0.25 },
  media: [demoMedia("groom_kit"), demoMedia("dog_scene"), demoMedia("sofa_scene")],
  hook: {
    text: "Dog hair on *everything*?",
    strategy: "relatable mess first; product inset at 0.7 s",
    scene: { media: "sofa_scene", text: "", params: { fur: 1 }, productInset: true },
  },
  inUse: {
    media: "dog_scene",
    text: "Loose fur goes *straight into the cup*",
    params: { brushing: 1 },
    animate: {
      fur: [
        { atMs: 300, value: 1 },
        { atMs: 2600, value: 0.15 },
      ],
    },
    particles: {
      variant: "fur",
      direction: "in",
      box: { x: 420, y: 1000, w: 520, h: 240 },
      sink: { x: 620, y: 1020 },
      density: 0.7,
      delayMs: 300,
    },
  },
  features: [
    {
      id: "cup",
      title: "Clear fur cup",
      callout: "Clear 1.5 L fur cup",
      anchor: "cup",
      stat: {
        value: 1.5,
        decimals: 1,
        unit: "L",
        label: "Fur cup capacity",
        style: "plain",
        params: { fill: 0.6 },
      },
    },
    { id: "brush", title: "Deshedding comb", callout: "Deshedding comb", anchor: "brush" },
    { id: "dial", title: "3 suction levels", callout: "3 suction levels", anchor: "dial" },
  ],
  calloutsTitle: "Everything in one kit",
  steps: {
    title: "How it works",
    items: ["Pick a comb head", "Brush with the coat", "Empty the cup"],
    media: "groom_kit",
    param: "highlight",
    params: { power: 1, fill: 0.4 },
  },
  beforeAfter: {
    headline: "Same sofa, *fur-free*",
    before: "sofa_scene",
    after: "sofa_scene",
    beforeLabel: "Before",
    afterLabel: "After",
    beforeParams: { fur: 1 },
    afterParams: { fur: 0 },
  },
  cta: { headline: "Attachments and price at the link", button: "See the kit", sub: DEMO_SUB },
  disclosure: DISCLOSURE,
  targetDurationMs: 25_000,
};

export const BENCHMARK_BRIEFS: CreativeBriefInput[] = [
  BENCH_TOOLS,
  BENCH_GADGETS,
  BENCH_HOME,
  BENCH_AUTOMOTIVE,
  BENCH_BEAUTY,
  BENCH_PET,
];
