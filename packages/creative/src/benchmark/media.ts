import type { MediaRef, ParamValue } from "../model.ts";

/**
 * Demo media catalogue (spec §74): parametric vector illustrations of the six DEMO_ONLY benchmark products and
 * their scenes. Drawn locally by the renderer (packages/motion/src/remotion/demo-media) — zero generation cost,
 * fully deterministic, sharp at any zoom. Geometry and anchors live here so the director (Node) and the renderer
 * (browser) share one source of truth. These are NOT real product photos and must never be published.
 */
export interface DemoMediaDef {
  width: number;
  height: number;
  role: MediaRef["role"];
  /** named points in px (converted to normalised anchors) */
  anchors: Record<string, [number, number]>;
  params: Record<string, ParamValue>;
  showsProduct?: boolean;
  description: string;
}

export const DEMO_MEDIA = {
  /* ---------------------------------------------------------------- tools: 20V drill/driver kit */
  drill: {
    width: 800,
    height: 720,
    role: "product",
    anchors: {
      bit: [70, 130],
      chuck: [212, 130],
      clutch: [316, 130],
      gear: [562, 40],
      housing: [470, 130],
      vents: [690, 130],
      trigger: [430, 288],
      led: [412, 566],
      handle: [548, 400],
      battery: [574, 640],
      gauge: [636, 652],
      base: [574, 704],
    },
    params: { bit: 1, spin: 0, trigger: 0, led: 0, charge: 1, torque: 12, gear: 2 },
    description: "Cordless drill/driver, side view, graphite body with amber accents (demo illustration)",
  },
  drill_work: {
    width: 1080,
    height: 1920,
    role: "scene",
    anchors: { contact: [330, 900], drill: [700, 1100], screw: [330, 900] },
    params: { drive: 0.4, spin: 1, trigger: 1, led: 1 },
    showsProduct: true,
    description: "Workshop close-up: the drill driving a screw into a timber post (demo illustration)",
  },
  /* ---------------------------------------------------------------- gadgets: 8-in-1 USB-C hub */
  hub: {
    width: 1000,
    height: 640,
    role: "product",
    anchors: {
      plug: [120, 64],
      pd: [192, 392],
      hdmi: [276, 392],
      usba: [406, 392],
      usbc: [530, 392],
      sd: [616, 392],
      microsd: [704, 392],
      ethernet: [806, 392],
      led: [822, 252],
      top: [516, 262],
      base: [516, 466],
    },
    params: { led: 1, glow: "", net: 1 },
    description: "8-in-1 USB-C hub, three-quarter front view with all ports (demo illustration)",
  },
  hub_screen: {
    width: 1200,
    height: 900,
    role: "ui",
    anchors: { window: [600, 360], toggle: [872, 562], list: [600, 330] },
    params: { items: 6, toggle: 0 },
    showsProduct: true,
    description: "Laptop screen listing the devices connected through the hub (demo UI)",
  },
  desk_before: {
    width: 1080,
    height: 1920,
    role: "scene",
    anchors: { laptop: [540, 1000] },
    params: {},
    description: "Top-down desk: laptop with a tangle of single-purpose dongles (demo illustration)",
  },
  desk_after: {
    width: 1080,
    height: 1920,
    role: "scene",
    anchors: { laptop: [540, 1000], hub: [660, 1320] },
    params: {},
    showsProduct: true,
    description: "Top-down desk: one hub, one cable, tidy (demo illustration)",
  },
  /* ---------------------------------------------------------------- home: motion-sensor cabinet light */
  cabinet_light: {
    width: 1000,
    height: 560,
    role: "product",
    anchors: {
      sensor: [170, 262],
      usbc: [898, 236],
      diffuser: [520, 262],
      light: [500, 420],
      magnet: [500, 166],
      base: [500, 300],
    },
    params: { light: 1, install: 3, shelf: 0, sense: 0 },
    description: "Slim rechargeable LED bar with PIR motion sensor and magnetic mount (demo illustration)",
  },
  cabinet_scene: {
    width: 1080,
    height: 1920,
    role: "scene",
    anchors: { light: [540, 420], centre: [540, 940], shelf: [540, 790] },
    params: { view: "kitchen", light: 0, mounted: 1, door: 1, sense: 0, ambient: 0.12 },
    showsProduct: true,
    description:
      "Open kitchen cabinet / wardrobe at night, lit or unlit by the cabinet light (demo illustration)",
  },
  /* ---------------------------------------------------------------- automotive: handheld car vacuum */
  car_vacuum: {
    width: 1000,
    height: 600,
    role: "product",
    anchors: {
      nozzle: [70, 300],
      tip: [40, 300],
      bin: [410, 320],
      filter: [415, 292],
      button: [760, 86],
      handle: [880, 180],
      usbc: [868, 352],
      vents: [660, 300],
      base: [470, 420],
    },
    params: { power: 0, fill: 0.15 },
    description: "Cordless handheld car vacuum with clear cyclone bin, side view (demo illustration)",
  },
  car_interior: {
    width: 1080,
    height: 1920,
    role: "scene",
    anchors: { nozzle: [430, 1100], seat: [560, 1110] },
    params: { crumbs: 1, power: 1, fill: 0.2 },
    showsProduct: true,
    description: "Car front seat with crumbs, the vacuum at work (demo illustration)",
  },
  car_mat: {
    width: 1080,
    height: 1920,
    role: "scene",
    anchors: { mat: [540, 1000] },
    params: { dirt: 1 },
    description: "Top-down car floor mat, dirty or clean (demo illustration)",
  },
  /* ---------------------------------------------------------------- beauty: LED makeup mirror */
  led_mirror: {
    width: 800,
    height: 1000,
    role: "product",
    anchors: {
      glass: [330, 330],
      ring: [400, 106],
      button: [400, 640],
      magnifier: [545, 545],
      stem: [400, 820],
      level: [400, 914],
      base: [400, 950],
    },
    params: { light: 1, tone: 1, level: 0.8 },
    description: "Round LED vanity mirror with touch control and 10× spot mirror (demo illustration)",
  },
  vanity_scene: {
    width: 1080,
    height: 1920,
    role: "scene",
    anchors: { mirror: [540, 820], button: [540, 1050], table: [540, 1500] },
    params: { light: 1, tone: 1 },
    showsProduct: true,
    description: "Vanity table at dusk with the mirror and make-up items (demo illustration)",
  },
  /* ---------------------------------------------------------------- pet: grooming vacuum kit */
  groom_kit: {
    width: 1000,
    height: 800,
    role: "product",
    anchors: {
      brush: [170, 214],
      teeth: [168, 282],
      hose: [420, 500],
      cup: [660, 545],
      dial: [820, 365],
      button: [656, 336],
      tools: [270, 690],
      handle: [712, 252],
      base: [712, 700],
    },
    params: { fill: 0.2, power: 0, level: 2, highlight: 0 },
    description: "Pet grooming vacuum: canister, hose, deshedding brush and attachments (demo illustration)",
  },
  dog_scene: {
    width: 1080,
    height: 1920,
    role: "scene",
    anchors: { brush: [600, 1040], dog: [560, 1200] },
    params: { fur: 1, brushing: 1 },
    showsProduct: true,
    description: "Friendly dog being groomed in a living room (demo illustration)",
  },
  sofa_scene: {
    width: 1080,
    height: 1920,
    role: "scene",
    anchors: { sofa: [540, 1200] },
    params: { fur: 1 },
    description: "Sofa covered in pet hair, or clean (demo illustration)",
  },
} as const satisfies Record<string, DemoMediaDef>;

export type DemoMediaKey = keyof typeof DEMO_MEDIA;

/** MediaRef for a demo illustration — always flagged demo-only + placeholder (never production media). */
export function demoMedia(
  key: DemoMediaKey,
  overrides: Partial<Pick<MediaRef, "id" | "params" | "showsProduct" | "description">> = {},
): MediaRef {
  const def: DemoMediaDef = DEMO_MEDIA[key];
  const anchors: MediaRef["anchors"] = {};
  for (const [name, [x, y]] of Object.entries(def.anchors))
    anchors[name] = { x: x / def.width, y: y / def.height };
  return {
    id: overrides.id ?? key,
    kind: "vector",
    src: key,
    width: def.width,
    height: def.height,
    hasAlpha: def.role !== "scene",
    role: def.role,
    provenance: "demo",
    placeholder: true,
    demoOnly: true,
    license: "Owned vector illustration — DEMO ONLY, not production media",
    anchors,
    params: { ...def.params, ...(overrides.params ?? {}) },
    showsProduct: overrides.showsProduct ?? def.showsProduct ?? false,
    description: overrides.description ?? def.description,
  };
}
