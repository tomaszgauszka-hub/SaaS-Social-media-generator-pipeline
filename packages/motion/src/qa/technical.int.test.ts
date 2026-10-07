import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BENCH_TOOLS } from "@cre/creative/benchmark";
import { prepareCreative } from "@cre/creative/node";
import { runFfmpeg } from "@cre/media";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { technicalQa } from "./technical.ts";

/** Fixture media made with FFmpeg's test sources — every defect the technical gate must catch. */
let dir: string;
const base = prepareCreative(BENCH_TOOLS).plan;
const plan = {
  ...base,
  durationMs: 3000,
  durationInFrames: 90,
  beats: [{ ...base.beats[0]!, startMs: 0, durationMs: 3000 }],
};

async function make(name: string, video: string, extra: string[] = []) {
  const file = path.join(dir, `${name}.mp4`);
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    video,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=3",
    ...extra,
    "-ac",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  return file;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cre-techqa-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("technical QA on fixture media", () => {
  it("passes geometry, codecs and frames on a clean moving clip", async () => {
    const file = await make("clean", "testsrc2=size=1080x1920:rate=30:duration=3");
    const { report } = await technicalQa(file, plan);
    const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      codec: "pass",
      geometry: "pass",
      fps: "pass",
      duration: "pass",
      decode: "pass",
      black: "pass",
      blank: "pass",
      frozen: "pass",
    });
  });

  it("catches a black segment", async () => {
    const file = await make(
      "black",
      "color=c=black:size=1080x1920:rate=30:duration=1,format=yuv420p[b];testsrc2=size=1080x1920:rate=30:duration=2[t];[b][t]concat=n=2:v=1:a=0",
    );
    const { report } = await technicalQa(file, plan);
    expect(report.checks.find((c) => c.id === "black")!.status).toBe("fail");
    expect(report.status).toBe("FAIL");
  });

  it("catches the wrong aspect ratio", async () => {
    const file = await make("landscape", "testsrc2=size=1920x1080:rate=30:duration=3");
    const { report } = await technicalQa(file, plan);
    expect(report.checks.find((c) => c.id === "geometry")!.status).toBe("fail");
  });

  it("catches a frozen picture", async () => {
    const file = await make("frozen", "smptebars=size=1080x1920:rate=30:duration=3");
    const { report } = await technicalQa(file, plan);
    expect(report.checks.find((c) => c.id === "frozen")!.status).toBe("fail");
  });
});
