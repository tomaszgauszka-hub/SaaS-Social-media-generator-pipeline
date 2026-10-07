/**
 * Contact sheet of a finished reel: frames at 0 %, 12.5 % … 87.5 % of the duration, tiled 4 × 2 (review aid).
 *   pnpm --filter @cre/motion exec tsx scripts/contact-sheet.ts <reel.mp4> <out.jpg>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeMedia, runFfmpeg } from "@cre/media";

const [file, out] = process.argv.slice(2);
if (!file || !out) throw new Error("usage: contact-sheet.ts <reel.mp4> <out.jpg>");
const info = await probeMedia(file);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cre-sheet-"));
const W = 405;
const H = 720;
const frames: string[] = [];
for (let i = 0; i < 8; i++) {
  const t = (info.durationMs / 1000) * (i / 8);
  const f = path.join(dir, `f${i}.jpg`);
  await runFfmpeg([
    "-ss",
    t.toFixed(3),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `scale=${W}:${H}`,
    "-q:v",
    "3",
    f,
  ]);
  frames.push(f);
}
const inputs = frames.flatMap((f) => ["-i", f]);
const layout = frames.map((_, i) => `${(i % 4) * W}_${Math.floor(i / 4) * H}`).join("|");
await runFfmpeg([
  ...inputs,
  "-filter_complex",
  `${frames.map((_, i) => `[${i}:v]`).join("")}xstack=inputs=8:layout=${layout}`,
  "-q:v",
  "3",
  out,
]);
fs.rmSync(dir, { recursive: true, force: true });
console.log(
  out,
  `${(info.durationMs / 1000).toFixed(1)} s`,
  frames.map((_, i) => `${((info.durationMs / 1000) * (i / 8)).toFixed(2)} s`).join(" · "),
);
