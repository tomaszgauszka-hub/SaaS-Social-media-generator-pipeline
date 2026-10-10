// dev helper: static-scene metric between two stills (same proxy + thresholds as Creative QA)
import { execFileSync } from "node:child_process";
import { dHash } from "../src/qa/frames.ts";
const gray = (f: string) =>
  execFileSync("ffmpeg", ["-v", "error", "-i", f, "-vf", "scale=108:192,format=gray", "-f", "rawvideo", "-"]);
const [a, b] = process.argv.slice(2).map(gray);
let d = 0;
for (let i = 0; i < a!.length; i++) d += Math.abs(a![i]! - b![i]!);
const ha = BigInt("0x" + dHash(a!));
const hb = BigInt("0x" + dHash(b!));
let x = ha ^ hb,
  bits = 0;
while (x) {
  bits += Number(x & 1n);
  x >>= 1n;
}
const mean = d / a!.length;
console.log(
  `mean|Δ| ${mean.toFixed(2)} (static < 4) · dHash distance ${bits} (static ≤ 5) → ${mean < 4 && bits <= 5 ? "STATIC" : "moving"}`,
);
