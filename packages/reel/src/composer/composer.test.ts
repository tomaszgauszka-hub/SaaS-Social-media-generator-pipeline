import { describe, expect, it } from "vitest";
import { PLATFORM_PROFILES } from "../contracts/profiles.ts";
import { testPlan } from "../testing/fixtures.ts";
import { buildMixArgs, duckingExpression, duckingGainDb, loudnormTarget, speechRegions } from "./audio.ts";
import { buildLocalizedVideoArgs } from "./compose.ts";
import { buildMasterArgs, logoRect } from "./master.ts";
import {
  assLines,
  captionEvents,
  captionLineBreak,
  normalisePhrases,
  textElementEvents,
} from "./subtitles.ts";
import { assertContiguous, clampTransition, shotWindows, XFADE_MODE } from "./timeline.ts";

const tiktok = PLATFORM_PROFILES.tiktok;

describe("timeline", () => {
  it("maps every transition id to a fixed xfade mode or a cut", () => {
    expect(XFADE_MODE.cut).toBeNull();
    expect(XFADE_MODE.fade).toBe("fade");
    expect(Object.values(XFADE_MODE).filter(Boolean)).toHaveLength(10);
  });

  it("keeps cuts on the plan and gives the outgoing shot a hold of the next transition", () => {
    const w = shotWindows(testPlan().shots);
    expect(w.map((x) => [x.startMs, x.mode, x.transitionMs, x.holdMs])).toEqual([
      [0, null, 0, 400],
      [1500, "fade", 400, 300],
      [3500, "slideup", 300, 0],
    ]);
    expect(() => assertContiguous(w, 5000)).not.toThrow();
    expect(() => assertContiguous(w, 6000)).toThrow(/5000 ms/);
  });

  it("clamps transitions to 40 % of the incoming shot and 800 ms", () => {
    expect(clampTransition(1000, 700)).toBe(400);
    expect(clampTransition(5000, 2000)).toBe(800);
  });
});

describe("master args", () => {
  const plan = testPlan();
  const clips = plan.shots.map((s) => ({ shotId: s.id, path: `/c/${s.id}.mp4` }));
  const logo = { path: "/l.png", width: 620, height: 150, widthPx: 230, position: "top_left" as const };

  it("chains concat for cuts and xfade at the exact cut offsets, frame-exact length", () => {
    const { args, frameCount, logoBox } = buildMasterArgs({
      plan,
      clips,
      platform: tiktok,
      logo,
      outPath: "/o.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(frameCount).toBe(150);
    // shot 1 holds 12 frames (400 ms) for the fade, shot 2 holds 9 (300 ms) for the slide
    expect(graph).toContain("trim=end_frame=57,");
    expect(graph).toContain("trim=end_frame=69,");
    expect(graph).toContain("trim=end_frame=45,");
    expect(graph).toContain("xfade=transition=fade:duration=0.4000:offset=1.5000");
    expect(graph).toContain("xfade=transition=slideup:duration=0.3000:offset=3.5000");
    expect(graph).toContain("overlay=x=48:y=164:enable='between(t,0.000,5.000)'");
    expect(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2)).toEqual([
      "-frames:v",
      "150",
    ]);
    expect(logoBox).toEqual({ x: 48, y: 164, w: 230, h: 56 });
  });

  it("uses concat when a transition is shorter than two frames", () => {
    const p = testPlan();
    p.shots[1]!.transitionIn = { type: "fade", ms: 30 };
    const graph = buildMasterArgs({ plan: p, clips, platform: tiktok, outPath: "/o.mp4" }).args.join(" ");
    expect(graph).toContain("[s0][s1]concat=n=2:v=1:a=0[x1]");
  });

  it("refuses a missing clip", () => {
    expect(() => buildMasterArgs({ plan, clips: clips.slice(1), platform: tiktok, outPath: "/o" })).toThrow(
      /sh01/,
    );
  });

  it("places logos outside the platform UI", () => {
    for (const pos of ["top_left", "top_right", "bottom_right", "end_card"] as const) {
      const r = logoRect(pos, tiktok, 230, 56);
      for (const u of tiktok.unsafe) {
        const overlap =
          r.x < u.rect.x + u.rect.w &&
          r.x + r.w > u.rect.x &&
          r.y < u.rect.y + u.rect.h &&
          r.y + r.h > u.rect.y;
        expect(overlap, `${pos} vs ${u.name}`).toBe(false);
      }
    }
  });
});

describe("audio args", () => {
  const voice = {
    path: "/v.wav",
    words: [
      { text: "a", startMs: 1000, endMs: 1400 },
      { text: "b", startMs: 1600, endMs: 2200 },
      { text: "c", startMs: 3000, endMs: 4000 },
    ],
    segments: [],
  };
  const ducking = { enabled: true, depthDb: 10, attackMs: 80, releaseMs: 350 };

  it("merges words into speech regions", () => {
    expect(speechRegions(voice)).toEqual([
      { startMs: 1000, endMs: 2200 },
      { startMs: 3000, endMs: 4000 },
    ]);
  });

  it("ducks by depthDb inside speech, pre-ducks before onsets and releases after", () => {
    const g = speechRegions(voice);
    expect(duckingGainDb(g, ducking, 500)).toBe(-0);
    expect(duckingGainDb(g, ducking, 1000)).toBeCloseTo(-10);
    expect(duckingGainDb(g, ducking, 960)).toBeCloseTo(-5);
    expect(duckingGainDb(g, ducking, 2200 + 175)).toBeCloseTo(-5);
    expect(duckingGainDb(g, ducking, 2700)).toBeCloseTo(0);
    const expr = duckingExpression(g, ducking)!;
    expect(expr).toMatch(/^pow\(10,-0\.5000\*max\(clip\(\(t-0\.920\)\/0\.080,0,1\)/);
    expect(duckingExpression(g, { ...ducking, enabled: false })).toBeNull();
  });

  it("builds a mix of music (ducked) + voice + delayed SFX with exact duration", () => {
    const { args, duckExpr } = buildMixArgs({
      durationMs: 5000,
      music: { path: "/m.wav" },
      musicGainDb: -10,
      ducking,
      voice,
      sfx: [
        { path: "/s1.wav", atMs: 1500, gainDb: -6 },
        { path: "/s2.wav", atMs: 9000, gainDb: 0 },
      ],
      outWav: "/mix.wav",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(duckExpr).not.toBeNull();
    expect(args.filter((a) => a === "-i")).toHaveLength(3); // the cue after the end is dropped
    expect(graph).toContain("volume=-10.00dB,asetnsamples=n=240:p=0,volume='pow(10");
    expect(graph).toContain("adelay=delays=1500:all=1");
    expect(graph).toContain("amix=inputs=3:duration=first:dropout_transition=0:normalize=0");
    expect(graph).toContain("atrim=duration=5.000[mix]");
  });

  it("masters below the delivery true peak", () => {
    expect(loudnormTarget({ lufs: -14, truePeakDb: -1.5 })).toEqual({ I: -14, TP: -3, LRA: 11 });
  });
});

describe("ASS", () => {
  const face = () => "Inter ExtraBold";

  it("sanitises model text and keeps explicit line breaks", () => {
    expect(assLines("Hello {\\b1}world\nsecond\\Nline")).toBe("Hello (/b1)world\\Nsecond/Nline");
  });

  it("draws a centred panel behind a text element and clamps it inside the frame", () => {
    const ev = textElementEvents(
      {
        id: "cta",
        kind: "cta",
        text: "Link w bio",
        startMs: 3500,
        endMs: 5000,
        box: { x: 1000, y: 300, w: 400, h: 90 },
        align: "center",
        fontSizePx: 70,
        font: { family: "Inter", file: "x.otf" },
        color: "#FFFFFF",
        panel: { color: "#1C1714", opacity: 0.62, radius: 26, padding: 22 },
      },
      face,
      1080,
      1920,
    );
    expect(ev).toHaveLength(2);
    expect(ev[0]!.layer).toBe(0);
    expect(ev[0]!.text).toContain("\\p1}m 26 0");
    // box clamped to x = 1080 − 22 − 400 = 658 → centre 858
    expect(ev[1]!.text).toContain("\\pos(858,345)");
    expect(ev[1]!.text).toContain("\\fnInter ExtraBold\\fs70\\b0");
  });

  it("word_highlight: one event per word, the active word in the highlight colour", () => {
    const track = {
      style: "word_highlight" as const,
      phrases: [
        {
          startMs: 1000,
          endMs: 2300,
          words: [
            { text: "ciepłe", startMs: 1000, endMs: 1400 },
            { text: "światło", startMs: 1500, endMs: 2200 },
          ],
        },
      ],
      font: { family: "Inter", file: "x.otf" },
      fontSizePx: 64,
      color: "#FFFFFF",
      highlightColor: "#E8A33D",
      outlineColor: "#000000",
      box: { x: 72, y: 1050, w: 936, h: 260 },
      uppercase: true,
    };
    const ev = captionEvents(track, face, 1080, 1920);
    expect(ev.map((e) => [e.startMs, e.endMs])).toEqual([
      [1000, 1500],
      [1500, 2300],
    ]);
    expect(ev[0]!.text).toContain("{\\c&H3DA3E8&}CIEPŁE{\\c&HFFFFFF&} ŚWIATŁO");
    expect(ev[1]!.text).toContain("CIEPŁE {\\c&H3DA3E8&}ŚWIATŁO");
  });

  it("karaoke_fill times \\kf per word with \\k gaps", () => {
    const ev = captionEvents(
      {
        style: "karaoke_fill",
        phrases: [
          {
            startMs: 1000,
            endMs: 2300,
            words: [
              { text: "one", startMs: 1000, endMs: 1400 },
              { text: "two", startMs: 1600, endMs: 2200 },
            ],
          },
        ],
        font: { family: "Inter", file: "x.otf" },
        fontSizePx: 64,
        color: "#FFFFFF",
        highlightColor: "#E8A33D",
        outlineColor: "#000000",
        box: { x: 72, y: 1050, w: 936, h: 260 },
        uppercase: false,
      },
      face,
      1080,
      1920,
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.text).toContain("\\1c&H3DA3E8&\\2c&HFFFFFF&}{\\kf40}one{\\k20}{\\kf60} two");
  });

  it("breaks long phrases into two balanced lines and de-overlaps phrases", () => {
    expect(captionLineBreak(["short"], 64, 900)).toBeNull();
    expect(captionLineBreak(["Mosiężna", "nóżka", "i", "orzechowa", "podstawa"], 64, 700)).toBe(3);
    const p = normalisePhrases([
      { startMs: 0, endMs: 1200, words: [{ text: "a", startMs: 0, endMs: 500 }] },
      { startMs: 1000, endMs: 2000, words: [{ text: "b", startMs: 1000, endMs: 1500 }] },
    ]);
    expect(p[0]!.endMs).toBe(1000);
  });
});

describe("localized video args", () => {
  it("burns the ASS file from the compose dir and refuses unsafe filter paths", () => {
    const base = {
      masterPath: "/m.mp4",
      audioPath: "/a.wav",
      fontsDir: "fonts",
      frameCount: 150,
      fps: 30,
      crf: 20,
      preset: "veryfast",
      outPath: "/o.mp4",
    };
    const args = buildLocalizedVideoArgs({ ...base, assFile: "captions.ass" });
    expect(args).toContain("[0:v]ass=filename=captions.ass:fontsdir=fonts,format=yuv420p[v]");
    expect(() => buildLocalizedVideoArgs({ ...base, assFile: "x.ass:fontsdir=/etc" })).toThrow(/unsafe/);
  });
});
