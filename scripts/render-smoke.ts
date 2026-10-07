/**
 * Manual smoke test for the FFmpeg compositor: `pnpm exec tsx scripts/render-smoke.ts [outDir] [--small]`
 * Generates programmatic assets, lays out a storyboard and renders a vertical video + cover.
 */
import path from "node:path";
import {
  generateGradientImage,
  generateMotionClip,
  generateMusicBed,
  generateProductPackshot,
  generateSpeech,
  generateWhoosh,
  inspectVideo,
  layoutStoryboard,
  renderVideoProject,
  type Storyboard,
} from "@cre/media";

const outDir = path.resolve(process.argv[2] ?? ".data/smoke");
const small = process.argv.includes("--small");
const W = small ? 540 : 1080;
const H = small ? 960 : 1920;
const fps = small ? 24 : 30;

const brand = {
  name: "Demo Tools",
  primary: "#F2A900",
  secondary: "#2B2B2B",
  accent: "#FF5A1F",
  text: "#FFFFFF",
  background: "#121212",
  headingFont: "Inter",
  bodyFont: "Inter",
};

async function main() {
  const t0 = Date.now();
  const a = (n: string) => path.join(outDir, "assets", n);
  await generateGradientImage(a("bg-workshop.png"), {
    width: W,
    height: H,
    colors: ["#3A2A12", "#121212"],
    seed: "workshop",
    label: "MOCK IMAGE · cluttered garage workbench, warm light",
  });
  await generateGradientImage(a("bg-problem.png"), {
    width: W,
    height: H,
    colors: ["#2B2B2B", "#5A1F0A"],
    seed: "problem",
    label: "MOCK IMAGE · stripped screw head close-up",
  });
  await generateProductPackshot(a("product.png"), {
    title: "20V Cordless Drill/Driver Kit",
    subtitle: "Demo Power Tools",
    primary: brand.primary,
    accent: brand.accent,
  });
  await generateMotionClip(a("ai-shot.mp4"), {
    imagePath: a("bg-workshop.png"),
    durationSec: 4,
    width: W,
    height: H,
    fps,
  });
  await generateMusicBed(a("music.wav"), { durationSec: 30, seed: "demo", mood: "upbeat" });
  await generateWhoosh(a("whoosh.wav"));
  const vo = await generateSpeech(a("voice.wav"), {
    text: "Stop stripping screws with a cheap drill. This twenty volt kit has a two speed gearbox, two batteries and a charger. Check today's price, link in bio.",
  });
  console.log(`assets ready in ${Date.now() - t0} ms, voice ${vo.durationMs} ms`);

  const sb: Storyboard = {
    templateKey: "vertical-bold",
    format: { aspect: "9:16", width: W, height: H, fps },
    safeArea: { top: 220, bottom: 440, left: 70, right: 150 },
    brand,
    scenes: [
      {
        id: "s0",
        kind: "HOOK",
        durationMs: 3000,
        headline: "Stop stripping *screws*",
        visual: { type: "image", src: a("bg-problem.png"), motion: "zoom_in" },
      },
      {
        id: "s1",
        kind: "PROBLEM",
        durationMs: 4000,
        headline: "Cheap drills slip, stall and die mid-job",
        visual: { type: "image", src: a("bg-workshop.png") },
      },
      {
        id: "s2",
        kind: "PRODUCT",
        durationMs: 5000,
        headline: "Meet the *20V* kit",
        visual: { type: "product", productSrc: a("product.png") },
      },
      {
        id: "s3",
        kind: "AI_SHOT",
        durationMs: 4000,
        headline: "Two speeds. Zero drama.",
        visual: { type: "video", src: a("ai-shot.mp4") },
      },
      {
        id: "s4",
        kind: "BENEFITS",
        durationMs: 5000,
        headline: "What you get",
        bullets: ["2-speed gearbox: 0-450 / 0-1,500 RPM", "2 batteries + charger", "1/2-inch keyless chuck"],
        visual: { type: "image", src: a("bg-workshop.png"), motion: "pan_left" },
      },
      { id: "s5", kind: "CTA", durationMs: 4500, visual: { type: "card" } },
    ],
    cta: { headline: "Check today's *price*", button: "Link in bio", subtext: "#ad · affiliate link" },
    disclosure: { text: "#ad · affiliate link" },
    priceBadge: { text: "$89.00" },
    productLabel: "20V Cordless Drill/Driver Kit",
    subtitles: { words: vo.words.map((w) => ({ ...w, startMs: w.startMs + 300, endMs: w.endMs + 300 })) },
    audio: {
      musicSrc: a("music.wav"),
      voiceover: { src: a("voice.wav"), startMs: 300 },
      transitionSfxSrc: a("whoosh.wav"),
    },
    progressBar: true,
  };
  const project = layoutStoryboard(sb);
  const res = await renderVideoProject(project, {
    resolveSrc: (s) => s,
    workDir: path.join(outDir, "work"),
    cacheDir: path.join(outDir, "cache"),
    outputPath: path.join(outDir, "out.mp4"),
    coverPath: path.join(outDir, "cover.jpg"),
  });
  console.log(
    JSON.stringify(
      { durationMs: res.durationMs, info: res.info, scenes: res.scenes, totalMs: res.totalMs },
      null,
      2,
    ),
  );
  const insp = await inspectVideo(res.outputPath);
  console.log(
    "inspection",
    JSON.stringify({ black: insp.blackSegments, freeze: insp.freezeSegments, lufs: insp.integratedLufs }),
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
