import { describe, expect, it } from "vitest";
import { PROXY, dHash, frameStats, hamming, staticSegments } from "./frames.ts";

const frame = (fn: (x: number, y: number) => number) => {
  const b = Buffer.alloc(PROXY.w * PROXY.h);
  for (let y = 0; y < PROXY.h; y++) for (let x = 0; x < PROXY.w; x++) b[y * PROXY.w + x] = fn(x, y);
  return b;
};

describe("frame analysis", () => {
  const gradient = frame((x) => Math.round((x / PROXY.w) * 255));
  const reversed = frame((x) => 255 - Math.round((x / PROXY.w) * 255));
  const flat = frame(() => 128);

  it("hashes identical frames identically and opposite frames far apart", () => {
    expect(hamming(dHash(gradient), dHash(gradient))).toBe(0);
    expect(hamming(dHash(gradient), dHash(reversed))).toBeGreaterThan(40);
  });

  it("measures spread and frame-to-frame change", () => {
    const [a, b, c] = frameStats([gradient, gradient, flat]);
    expect(a!.std).toBeGreaterThan(60);
    expect(b!.diff).toBe(0);
    expect(c!.std).toBe(0);
    expect(c!.diff).toBeGreaterThan(30);
  });
});

describe("static segments", () => {
  const still = Buffer.alloc(PROXY.w * PROXY.h, 120);
  const moving = (i: number) => {
    const b = Buffer.alloc(PROXY.w * PROXY.h);
    for (let k = 0; k < b.length; k++) b[k] = (k + i * 37) % 255;
    return b;
  };
  it("finds a held frame longer than 2.5 s and ignores a changing picture", () => {
    const frames = [
      ...Array.from({ length: 10 }, (_, i) => moving(i)),
      ...Array.from({ length: 40 }, () => still),
      ...Array.from({ length: 10 }, (_, i) => moving(i + 20)),
    ];
    const segs = staticSegments(frames);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.endMs - segs[0]!.startMs).toBeGreaterThanOrEqual(2500);
    expect(staticSegments(Array.from({ length: 60 }, (_, i) => moving(i)))).toEqual([]);
  });
});
