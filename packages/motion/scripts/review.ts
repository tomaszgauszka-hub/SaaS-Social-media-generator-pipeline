/**
 * Visual review helper (development): renders media sheets with anchors and review stills of benchmark reels.
 *   pnpm --filter @cre/motion exec tsx scripts/review.ts sheets drill drill_work
 *   pnpm --filter @cre/motion exec tsx scripts/review.ts stills bench-tools-drill [frames...]
 */
import path from "node:path";
import { BENCHMARK_BRIEFS, demoMedia, type DemoMediaKey } from "@cre/creative/benchmark";
import { STYLE_KITS, kitForCategory } from "@cre/creative";
import { fontAssets, prepareCreative } from "@cre/creative/node";
import { renderFinishedReel } from "../src/finish.ts";
import { renderMediaSheets, renderReelStills } from "../src/render.ts";

const [mode, ...rest] = process.argv.slice(2);
const out = process.env.REVIEW_OUT ?? path.resolve(".review");

if (mode === "sheets") {
  const kit = STYLE_KITS.general;
  const fonts = fontAssets(kit.tokens).assets;
  // key[:param=value,…][@kit] — e.g. cabinet_scene:view=wardrobe,light=1@home
  const items = rest.map((arg, i) => {
    const [spec, kitName] = arg.split("@");
    const [key, paramStr] = spec!.split(":");
    const params: Record<string, number | string> = {};
    for (const kv of paramStr ? paramStr.split(",") : []) {
      const [k, v] = kv.split("=");
      params[k!] = Number.isNaN(Number(v)) ? v! : Number(v);
    }
    return {
      media: demoMedia(key as DemoMediaKey, { id: `${key}-${i}`, params }),
      palette: kitForCategory(kitName ?? "general").tokens.palette,
      fonts,
    };
  });
  console.log(await renderMediaSheets(items, out));
} else if (mode === "stills") {
  const [id, ...frames] = rest;
  const brief = BENCHMARK_BRIEFS.find((b) => b.id === id);
  if (!brief) throw new Error(`unknown brief ${id}`);
  const prepared = prepareCreative(brief);
  for (const issue of prepared.issues)
    console.log(
      `[${issue.severity}] ${issue.code} ${issue.beatId ?? ""} ${issue.slot ?? ""} ${issue.message}`,
    );
  const list = frames.length
    ? frames.map(Number)
    : prepared.plan.beats.flatMap((b) => [
        Math.round(((b.startMs + Math.min(b.durationMs - 100, 1600)) * 30) / 1000),
      ]);
  console.log(
    prepared.plan.beats
      .map((b) => `${b.id} ${b.type} ${b.startMs}+${b.durationMs} ${b.transitionIn.type}`)
      .join("\n"),
  );
  console.log(await renderReelStills(prepared.plan, list, out));
} else if (mode === "video") {
  for (const id of rest) {
    const brief = BENCHMARK_BRIEFS.find((b) => b.id === id);
    if (!brief) throw new Error(`unknown brief ${id}`);
    const prepared = prepareCreative(brief);
    const r = await renderFinishedReel(prepared.plan, out, { onProgress: () => undefined });
    console.log(
      JSON.stringify({
        id,
        file: r.file,
        renderMs: r.renderMs,
        fps: r.renderFps.toFixed(1),
        audioMs: r.audioMs,
        finishMs: r.finishMs,
        info: r.info,
        loud: r.sourceLoudness,
      }),
    );
  }
} else {
  console.log("usage: review.ts sheets <keys…> | stills <briefId> [frames…]");
}
