import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFromRoot } from "@cre/config";
import { probeMedia, runFfmpeg } from "@cre/media";
import * as fontkit from "fontkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaptionTrack, ShotClip, TextElement, VoiceTrack } from "../contracts/media.ts";
import { PLATFORM_PROFILES } from "../contracts/profiles.ts";
import { testPlan } from "../testing/fixtures.ts";
import { composeLocalized, composeMaster, fontCellRatio, fontFaceName } from "./compose.ts";
import { buildReelAss } from "./subtitles.ts";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const FONT = resolveFromRoot("assets/fonts/inter/Inter-ExtraBold.otf");
const BODY = resolveFromRoot("assets/fonts/inter/Inter-SemiBold.otf");

async function rmsDb(file: string, filter: string, startS: number, endS: number): Promise<number> {
  const { stderr } = await runFfmpeg(
    [
      "-i",
      file,
      "-af",
      `${filter},atrim=start=${startS}:end=${endS},astats=measure_overall=RMS_level:measure_perchannel=none`,
      "-f",
      "null",
      "-",
    ],
    { logLevel: "info" },
  );
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(stderr);
  return m ? Number(m[1]) : NaN;
}

async function ebur128(file: string): Promise<{ I: number; TP: number }> {
  const { stderr } = await runFfmpeg(["-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], {
    logLevel: "info",
  });
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  return {
    I: Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]),
    TP: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]),
  };
}

describe.skipIf(!hasFfmpeg)("libass text size", () => {
  it("draws the em size the layout measured (\\fs is the font's ascent + descent)", async () => {
    expect(fontCellRatio(FONT)).toBeCloseTo((1984 + 494) / 2048, 6);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-libass-"));
    try {
      fs.mkdirSync(path.join(dir, "fonts"));
      fs.copyFileSync(FONT, path.join(dir, "fonts", "00.otf"));
      const text = "Poczekaj, aż";
      const hook: TextElement = {
        id: "hook",
        kind: "disclosure", // no scale animation: the frame shows the final size
        text,
        startMs: 0,
        endMs: 1000,
        box: { x: 200, y: 560, w: 680, h: 100 },
        align: "center",
        fontSizePx: 88,
        font: { family: "Inter", file: FONT },
        color: "#FFFFFF",
      };
      fs.writeFileSync(
        path.join(dir, "t.ass"),
        buildReelAss({
          width: 1080,
          height: 1920,
          texts: [hook],
          faceOf: fontFaceName,
          cellRatioOf: fontCellRatio,
          defaultFace: fontFaceName(FONT),
        }),
      );
      const raw = path.join(dir, "f.gray");
      await runFfmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          "color=black:s=1080x1920:d=0.5",
          "-vf",
          "ass=filename=t.ass:fontsdir=fonts,format=gray",
        ].concat(["-frames:v", "1", "-f", "rawvideo", raw]),
        { cwd: dir },
      );
      const px = fs.readFileSync(raw);
      let x0 = 1080;
      let x1 = -1;
      for (let y = 0; y < 1920; y++)
        for (let x = 0; x < 1080; x++)
          if (px[y * 1080 + x]! > 128) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
          }
      // the same text's ink width from the font itself at an 88 px em
      const font = fontkit.create(fs.readFileSync(FONT)) as fontkit.Font;
      const run = font.layout(text);
      let pen = 0;
      let lo = Infinity;
      let hi = -Infinity;
      run.glyphs.forEach((g, i) => {
        if (g.bbox.maxX > g.bbox.minX) {
          lo = Math.min(lo, pen + g.bbox.minX);
          hi = Math.max(hi, pen + g.bbox.maxX);
        }
        pen += run.positions[i]!.xAdvance;
      });
      const expected = ((hi - lo) * 88) / font.unitsPerEm;
      // before: libass drew \fs88 as an 88 px cell = 72.7 px em (ratio 0.83)
      expect((x1 - x0 + 1) / expected).toBeGreaterThan(0.97);
      expect((x1 - x0 + 1) / expected).toBeLessThan(1.03);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!hasFfmpeg)("ReelComposer end to end (synthetic inputs)", () => {
  let dir: string;
  const plan = testPlan();
  const clips: ShotClip[] = [];
  let voice: VoiceTrack;
  let music: string;
  let sfx: string[];
  let logo: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-composer-"));
    for (const [i, s] of plan.shots.entries()) {
      const p = path.join(dir, `${s.id}.mp4`);
      await runFfmpeg([
        "-f",
        "lavfi",
        "-i",
        `testsrc2=s=540x960:r=30:d=${s.durationMs / 1000},hue=h=${i * 120}`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        p,
      ]);
      clips.push({
        shotId: s.id,
        path: p,
        durationMs: s.durationMs,
        width: 540,
        height: 960,
        fps: 30,
        productTrack: [],
        cacheHit: false,
        renderMs: 0,
        encodeMs: 0,
      });
    }
    music = path.join(dir, "music.wav");
    await runFfmpeg(["-f", "lavfi", "-i", "sine=f=150:r=48000:d=6", "-af", "volume=-6dB", music]);
    const vpath = path.join(dir, "voice.wav");
    // 2 kHz "speech" during 1.0–2.2 s and 3.0–4.0 s
    await runFfmpeg([
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='0.4*sin(2*PI*2000*t)*(between(t,1,2.2)+between(t,3,4))':s=48000:d=5",
      vpath,
    ]);
    voice = {
      path: vpath,
      durationMs: 5000,
      words: [
        { text: "Ciepłe", startMs: 1000, endMs: 1500 },
        { text: "światło", startMs: 1550, endMs: 2200 },
        { text: "na", startMs: 3000, endMs: 3200 },
        { text: "wieczór.", startMs: 3250, endMs: 4000 },
      ],
      timingsSource: "provider",
      segments: [],
      provider: "test",
      model: "tone",
      voice: "tone",
    };
    sfx = [path.join(dir, "s1.wav"), path.join(dir, "s2.wav")];
    await runFfmpeg([
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=d=0.25:c=pink:r=48000:a=0.5",
      "-af",
      "afade=t=out:d=0.25",
      sfx[0]!,
    ]);
    await runFfmpeg(["-f", "lavfi", "-i", "sine=f=80:r=48000:d=0.4", "-af", "afade=t=out:d=0.4", sfx[1]!]);
    logo = path.join(dir, "logo.png");
    await runFfmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=0xE8A33D@0.9:s=620x150,format=rgba",
      "-frames:v",
      "1",
      logo,
    ]);
  }, 120_000);

  afterAll(() => {
    if (dir && !process.env.KEEP_COMPOSER_OUTPUT) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("master once, two locales reuse it; exact duration, size, fps, loudness and ducking", async () => {
    const cacheDir = path.join(dir, "cache");
    const brandLogo = { path: logo, position: "top_left" as const, widthPx: 230 };
    const master = await composeMaster({
      plan,
      clips,
      outPath: path.join(dir, "A.master.mp4"),
      workDir: dir,
      cacheDir,
    });
    expect(master.reused).toBe(false);
    const again = await composeMaster({
      plan,
      clips,
      outPath: path.join(dir, "A.master2.mp4"),
      workDir: dir,
      cacheDir,
    });
    expect(again.reused).toBe(true);
    expect(again.visualHash).toBe(master.visualHash);
    const mi = await probeMedia(master.path);
    expect([mi.width, mi.height, mi.fps, mi.hasAudio]).toEqual([1080, 1920, 30, false]);
    expect(Math.abs(mi.durationMs - 5000)).toBeLessThanOrEqual(34);

    const platform = PLATFORM_PROFILES.tiktok;
    for (const [locale, words] of [
      ["pl-PL", ["Ciepłe", "światło", "na", "wieczór."]],
      ["de-DE", ["Warmes", "Licht", "für", "Abende."]],
    ] as const) {
      const p = { ...plan, language: locale };
      const captions: CaptionTrack = {
        style: locale === "pl-PL" ? "word_highlight" : "karaoke_fill",
        phrases: [
          {
            startMs: 1000,
            endMs: 2300,
            words: voice.words.slice(0, 2).map((w, i) => ({ ...w, text: words[i]! })),
          },
          {
            startMs: 3000,
            endMs: 4100,
            words: voice.words.slice(2).map((w, i) => ({ ...w, text: words[i + 2]! })),
          },
        ],
        font: { family: "Inter", file: FONT },
        fontSizePx: 66,
        color: "#FFFFFF",
        highlightColor: "#E8A33D",
        outlineColor: "#000000",
        box: { x: 72, y: 1050, w: 936, h: 260 },
        uppercase: false,
      };
      const texts: TextElement[] = [
        {
          id: "hook",
          kind: "hook",
          text: "Światło, które\nzmienia wieczór",
          startMs: 150,
          endMs: 1380,
          box: { x: 190, y: 246, w: 700, h: 180 },
          align: "center",
          fontSizePx: 76,
          font: { family: "Inter", file: FONT },
          color: "#FFFFFF",
          panel: { color: "#1C1714", opacity: 0.62, radius: 26, padding: 22 },
        },
        {
          id: "cta",
          kind: "cta",
          text: "Link w bio",
          startMs: 3500,
          endMs: 5000,
          box: { x: 330, y: 246, w: 420, h: 90 },
          align: "center",
          fontSizePx: 72,
          font: { family: "Inter", file: FONT },
          color: "#FFFFFF",
          panel: { color: "#1C1714", opacity: 0.62, radius: 26, padding: 22 },
        },
        {
          id: "button",
          kind: "button",
          text: "Sprawdź {cenę}",
          startMs: 3850,
          endMs: 5000,
          box: { x: 390, y: 450, w: 300, h: 56 },
          align: "center",
          fontSizePx: 44,
          font: { family: "Inter", file: FONT },
          color: "#2B2420",
          panel: { color: "#E8A33D", opacity: 1, radius: 40, padding: 26 },
        },
        {
          id: "disclosure",
          kind: "disclosure",
          text: "Reklama · link afiliacyjny",
          startMs: 0,
          endMs: 5000,
          box: { x: 48, y: 1486, w: 360, h: 34 },
          align: "left",
          fontSizePx: 28,
          font: { family: "Inter", file: BODY },
          color: "#FFFFFF",
          panel: { color: "#000000", opacity: 0.45, radius: 14, padding: 12 },
        },
      ];
      const out = await composeLocalized({
        plan: p,
        masterPath: master.path,
        music: {
          path: music,
          durationMs: 6000,
          bpm: 110,
          provider: "test",
          model: "sine",
          license: "test",
          cached: false,
        },
        voice,
        sfx: [
          { atMs: 1500, kind: "whoosh", gainDb: -8, path: sfx[0]!, provider: "test", cached: false },
          { atMs: 3500, kind: "bass_hit", gainDb: -6, path: sfx[1]!, provider: "test", cached: false },
        ],
        captions,
        texts,
        platform,
        logo: brandLogo,
        outPath: path.join(dir, `${locale}.mp4`),
        posterPath: path.join(dir, `${locale}.jpg`),
        workDir: dir,
      });
      const info = await probeMedia(out.path);
      expect([info.width, info.height, info.fps, info.hasAudio, info.audioSampleRate]).toEqual([
        1080,
        1920,
        30,
        true,
        48000,
      ]);
      expect(Math.abs(info.durationMs - 5000)).toBeLessThanOrEqual(34);
      expect(fs.statSync(out.posterPath).size).toBeGreaterThan(10_000);
      expect(fs.readFileSync(out.assPath, "utf8")).toContain("Sprawdź (cenę)");
      const loud = await ebur128(out.path);
      expect(Math.abs(loud.I - platform.loudness.lufs)).toBeLessThanOrEqual(1);
      expect(loud.TP).toBeLessThanOrEqual(platform.loudness.truePeakDb);

      // ducking: the 150 Hz music bed (voice is a 2 kHz tone, removed by the low-pass) is ~10 dB lower inside speech than before it
      const musicOnly = "lowpass=f=300,lowpass=f=300,lowpass=f=300,lowpass=f=300";
      const outside = await rmsDb(out.audioPath, musicOnly, 0.35, 0.8);
      const inside = await rmsDb(out.audioPath, musicOnly, 1.15, 1.45); // before the 1.5 s whoosh
      expect(outside - inside).toBeGreaterThan(8);
      expect(outside - inside).toBeLessThan(12);

      // the same locale for another platform: same master, same audio, logo placed for that platform's UI
      if (locale === "pl-PL") {
        const yt = await composeLocalized({
          plan: { ...p, platform: "youtube_shorts" },
          masterPath: master.path,
          sfx: [],
          captions,
          texts,
          platform: PLATFORM_PROFILES.youtube_shorts,
          logo: brandLogo,
          reuseAudio: { path: out.audioPath, lufs: out.audio.lufs, truePeakDb: out.audio.truePeakDb },
          outPath: path.join(dir, `${locale}.youtube_shorts.mp4`),
          posterPath: path.join(dir, `${locale}.youtube_shorts.jpg`),
          workDir: dir,
        });
        expect(yt.audioReused).toBe(true);
        expect(yt.audioMs).toBeLessThan(out.audioMs);
        expect(yt.logoBox).toBeDefined();
        const yi = await probeMedia(yt.path);
        expect([yi.width, yi.height, yi.hasAudio]).toEqual([1080, 1920, true]);
      }
    }
  }, 180_000);
});
