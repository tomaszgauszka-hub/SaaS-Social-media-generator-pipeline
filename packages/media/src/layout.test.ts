import { describe, expect, it } from "vitest";
import { buildFinalArgs } from "./compositor.ts";
import { layoutStoryboard, type Storyboard } from "./layout.ts";
import { VideoProject } from "./schema.ts";
import { contrastRatio, mixHex, readableOn } from "./templates.ts";
import { clampTransitionMs, computeTimeline, textWindow } from "./timeline.ts";
import { findLayoutViolations } from "./validate.ts";

const brand = {
  name: "Demo",
  primary: "#F2A900",
  secondary: "#2B2B2B",
  accent: "#FF5A1F",
  text: "#FFFFFF",
  background: "#121212",
  headingFont: "Inter",
  bodyFont: "Inter",
};

function storyboard(overrides: Partial<Storyboard> = {}): Storyboard {
  return {
    templateKey: "vertical-bold",
    format: { aspect: "9:16", width: 1080, height: 1920, fps: 30 },
    safeArea: { top: 220, bottom: 440, left: 70, right: 150 },
    brand,
    scenes: [
      {
        id: "hook",
        kind: "HOOK",
        durationMs: 3000,
        headline: "Stop stripping *screws* with a cheap drill you bought on impulse",
        visual: { type: "image", src: "/bg.png" },
      },
      {
        id: "product",
        kind: "PRODUCT",
        durationMs: 5000,
        headline: "Meet the *20V* drill/driver kit",
        visual: { type: "product", productSrc: "/p.png" },
      },
      {
        id: "benefits",
        kind: "BENEFITS",
        durationMs: 5000,
        headline: "What you get",
        bullets: [
          "2-speed gearbox: 0-450 / 0-1,500 RPM",
          "2 batteries and a charger included",
          "1/2-inch keyless chuck",
        ],
        visual: { type: "image", src: "/bg2.png" },
      },
      { id: "cta", kind: "CTA", durationMs: 4000, visual: { type: "card" } },
    ],
    cta: { headline: "Check today's *price*", button: "Link in bio", subtext: "Comment DRILL for the link" },
    disclosure: { text: "#ad · affiliate link" },
    priceBadge: { text: "$89.00" },
    productLabel: "20V Cordless Drill/Driver Kit",
    subtitles: {
      words: [
        { text: "Stop", startMs: 100, endMs: 400 },
        { text: "stripping", startMs: 420, endMs: 900 },
      ],
    },
    audio: {
      musicSrc: "/music.wav",
      voiceover: { src: "/vo.wav", startMs: 300 },
      transitionSfxSrc: "/whoosh.wav",
    },
    progressBar: true,
    ...overrides,
  };
}

describe("timeline", () => {
  it("overlaps scenes by the transition length", () => {
    const t = computeTimeline([
      { id: "a", durationMs: 3000, transitionIn: { type: "cut", durationMs: 0 } },
      { id: "b", durationMs: 4000, transitionIn: { type: "fade", durationMs: 500 } },
      { id: "c", durationMs: 2000, transitionIn: { type: "cut", durationMs: 300 } },
    ]);
    expect(t.windows.map((w) => w.startMs)).toEqual([0, 2500, 6500]);
    expect(t.totalMs).toBe(8500);
    expect(t.windows[2]!.transitionMs).toBe(0);
  });

  it("clamps transitions to 40% of neighbouring scenes", () => {
    expect(clampTransitionMs(1000, 5000, 900)).toBe(400);
  });

  it("text windows start after the incoming transition midpoint", () => {
    const t = computeTimeline([
      { id: "a", durationMs: 3000, transitionIn: { type: "cut", durationMs: 0 } },
      { id: "b", durationMs: 3000, transitionIn: { type: "fade", durationMs: 400 } },
    ]);
    expect(textWindow(t, 1).startMs).toBe(2600 + 200);
    expect(textWindow(t, 0).endMs).toBe(2800);
  });
});

describe("layoutStoryboard", () => {
  it("produces a schema-valid VideoProject", () => {
    const project = layoutStoryboard(storyboard());
    expect(() => VideoProject.parse(project)).not.toThrow();
    expect(project.scenes).toHaveLength(4);
    expect(project.scenes[0]!.transitionIn.type).toBe("cut");
    expect(project.subtitles?.words).toHaveLength(2);
    expect(project.audio.sfx.length).toBe(3); // one whoosh per transition
  });

  it("keeps every text and shape inside the platform safe area (1080×1920 and 540×960)", () => {
    for (const size of [
      { width: 1080, height: 1920 },
      { width: 540, height: 960 },
    ]) {
      const project = layoutStoryboard(storyboard({ format: { aspect: "9:16", ...size, fps: 30 } }));
      expect(findLayoutViolations(project)).toEqual([]);
    }
  });

  it("works with the clean template too", () => {
    const project = layoutStoryboard(storyboard({ templateKey: "vertical-clean" }));
    expect(findLayoutViolations(project)).toEqual([]);
    expect(project.templateKey).toBe("vertical-clean");
  });

  it("detects violations", () => {
    const project = layoutStoryboard(storyboard());
    project.texts.push({ ...project.texts[0]!, id: "bad", x: 1050, y: 100 });
    const v = findLayoutViolations(project);
    expect(v.some((x) => x.id === "bad" && x.kind === "outside_safe_area")).toBe(true);
  });

  it("shows the on-screen disclosure for the whole video", () => {
    const project = layoutStoryboard(storyboard());
    const disclosure = project.texts.find((t) => t.id === "disclosure");
    const total = computeTimeline(project.scenes).totalMs;
    expect(disclosure?.startMs).toBe(0);
    expect(disclosure?.endMs).toBe(total);
  });

  it("only shows a price badge when one is provided", () => {
    const without = layoutStoryboard(storyboard({ priceBadge: undefined }));
    expect(without.texts.some((t) => t.id.endsWith("-price"))).toBe(false);
  });

  it("CTA buttons contrast with their backdrop", () => {
    const project = layoutStoryboard(storyboard());
    const button = project.shapes.find((s) => s.id === "cta-button")!;
    const bg = project.scenes[3]!.background;
    expect(bg.type).toBe("gradient");
    if (bg.type === "gradient") {
      expect(contrastRatio(button.color, mixHex(bg.colors[0], bg.colors[1], 0.5))).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("text palette", () => {
  it("uses dark, readable text on light brand backdrops", () => {
    const light = { ...brand, primary: "#E8547A", accent: "#F59BB4", background: "#FFF7FA", text: "#2A1A20" };
    const project = layoutStoryboard(storyboard({ brand: light }));
    const productScene = project.scenes[1]!;
    const headline = project.texts.find((t) => t.id === "product-headline")!;
    expect(productScene.background.type).toBe("gradient");
    if (productScene.background.type === "gradient") {
      const mid = mixHex(productScene.background.colors[0], productScene.background.colors[1], 0.5);
      expect(contrastRatio(headline.color, mid)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(headline.accentColor, mid)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("colour helpers", () => {
  it("picks readable text colours", () => {
    expect(readableOn("#FFFFFF")).toBe("#111111");
    expect(readableOn("#121212")).toBe("#FFFFFF");
  });
});

describe("buildFinalArgs", () => {
  const project = VideoProject.parse(layoutStoryboard(storyboard()));
  const timeline = computeTimeline(project.scenes);
  const scenePaths = project.scenes.map((s) => `/cache/${s.id}.mp4`);

  it("chains xfade with offsets from the timeline and burns in the ASS overlay", () => {
    const args = buildFinalArgs(
      project,
      timeline,
      scenePaths,
      "/work/o.ass",
      { music: "/m.wav", voiceover: "/v.wav", sfx: ["/w.wav", "/w.wav", "/w.wav"] },
      "/out.mp4",
    );
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    const offsets = [...graph.matchAll(/offset=([0-9.]+)/g)].map((m) => Number(m[1]));
    expect(offsets).toEqual(timeline.windows.slice(1).map((w) => w.startMs / 1000));
    expect(graph).toContain("ass=filename='/work/o.ass'");
    expect(graph).toContain("sidechaincompress");
    expect(graph).toContain("loudnorm=I=-14");
    expect(args).toContain("+faststart");
    expect(args.at(-1)).toBe("/out.mp4");
  });

  it("adds a silent track when there is no audio", () => {
    const silent = VideoProject.parse({ ...project, audio: { sfx: [], targetLufs: -14 } });
    const args = buildFinalArgs(silent, timeline, scenePaths, "/o.ass", { sfx: [] }, "/out.mp4");
    expect(args.join(" ")).toContain("anullsrc=r=48000:cl=stereo");
  });

  it("uses concat for cuts", () => {
    const cuts = VideoProject.parse({
      ...project,
      scenes: project.scenes.map((s) => ({ ...s, transitionIn: { type: "cut", durationMs: 0 } })),
    });
    const t = computeTimeline(cuts.scenes);
    const args = buildFinalArgs(cuts, t, scenePaths, "/o.ass", { sfx: [] }, "/out.mp4");
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("xfade");
    expect(graph.match(/concat=n=2/g)).toHaveLength(3);
  });
});
