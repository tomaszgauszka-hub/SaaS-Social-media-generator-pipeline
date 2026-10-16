#!/usr/bin/env node
/*
 * FAKE UnrealEditor-Cmd — a MOCK test double, NOT Unreal Engine. vitest runs it (node <this file> <editor args>) in
 * place of the editor to exercise the adapter end to end: it checks the command line the adapter built, reads the
 * UE scene job from $R3D_UE_JOB, writes a short PNG sequence (pure PNG writer, no ffmpeg) and a result.json marked
 * "mock": true, printing ue_scene.py's marker lines behind UE-style log prefixes. Nothing here renders 3D.
 *
 * FAKE_UE_MODE: ok (default) · invalid (exit 3) · crash (exit 1, access-violation text) · hang (never exits) ·
 * silent (never reports R3D_STARTED, hangs) · linger (result written, editor never exits) · escape (result names
 * a frame dir outside the job) · fail_render (failure result.json, exit 1) · wrong_job (result for another job) ·
 * not_dedicated (failure result: not the render project)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const mode = process.env.FAKE_UE_MODE || "ok";
const args = process.argv.slice(2);
// synchronous writes: an async pipe write followed by process.exit() can lose the last lines
const log = (msg) => fs.writeSync(1, `[2026.10.16-12.00.00:000][  0]LogPython: ${msg}\n`);
const err = (msg) => fs.writeSync(2, `${msg}\n`);

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(tag, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(tag, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGB PNG: dark grey frame with a light box (the stand-in "product") at box = [u0, v0, u1, v1]. */
function png(w, h, box) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const inBox = u >= box[0] && u <= box[2] && v >= box[1] && v <= box[3];
      const g = inBox ? 210 : 30 + Math.round(20 * v);
      row[1 + x * 3] = g;
      row[2 + x * 3] = g;
      row[3 + x * 3] = inBox ? 190 : g + 4;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const hang = () => setInterval(() => undefined, 1 << 30);

// ---- the command line the adapter must build
const project = args[0];
const diag = args.includes("-run=pythonscript");
const scriptArg = diag
  ? args.find((a) => a.startsWith("-script="))
  : args.find((a) => a.startsWith("-ExecutePythonScript="));
if (!project || !project.endsWith(".uproject") || !fs.existsSync(project) || !scriptArg) {
  err(`FAKE editor: bad command line ${JSON.stringify(args)}`);
  process.exit(2);
}
for (const flag of ["-unattended", "-nopause", "-nosplash", "-stdout"])
  if (!args.includes(flag)) {
    err(`FAKE editor: missing ${flag}`);
    process.exit(2);
  }
log("LogInit: MOCK editor starting (this is the fake UnrealEditor-Cmd, not Unreal Engine)");

if (diag) {
  const out = process.env.R3D_UE_DIAG_OUT;
  log("R3D_STARTED script=ue_diagnose pid=" + process.pid);
  fs.writeFileSync(
    out,
    JSON.stringify({
      ok: true,
      mock: true,
      tool: "ue-diagnose/1",
      engineVersion: "MOCK-5.8.0",
      missingRequired: [],
      warnings: ["MOCK diagnostics: no editor was started"],
      apis: {},
    }),
  );
  log(`DIAGNOSE ${out}`);
  process.exit(0);
}

if (mode === "silent") {
  hang();
} else {
  log(`R3D_STARTED script=ue_scene pid=${process.pid}`);
  run();
}

function run() {
  if (mode === "hang") return hang();
  if (mode === "crash") {
    err("Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000000");
    process.exit(1);
  }
  const jobPath = process.env.R3D_UE_JOB;
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  } catch (e) {
    err(JSON.stringify({ ok: false, error: "invalid_job", message: String(e) }));
    process.exit(3);
  }
  if (
    mode === "invalid" ||
    job.version !== 1 ||
    job.kind !== "ue_scene" ||
    !path.isAbsolute(job.output?.dir ?? "")
  ) {
    err(JSON.stringify({ ok: false, error: "invalid_job", message: "job.template is not valid" }));
    process.exit(3);
  }
  const out = job.output.dir;
  fs.mkdirSync(out, { recursive: true });
  const fail = (error, message, code) => {
    fs.writeFileSync(
      path.join(out, "result.json"),
      JSON.stringify({ ok: false, error, message, exitCode: code, warnings: [], timings: {}, mock: true }),
    );
    process.exit(code);
  };
  if (mode === "fail_render") return fail("render_failed", "Movie Render Queue failed: MOCK failure", 1);
  if (mode === "not_dedicated")
    return fail("not_dedicated_project", "MOCK: not the dedicated render project", 1);

  const n = Math.max(2, Math.ceil(job.durationSec * job.fps - 1e-9));
  const s = job.quality === "preview" ? 0.5 : 1;
  const [rw, rh] = job.resolution;
  const w = Math.max(128, Math.round((rw * s) / 2) * 2);
  const h = Math.max(128, Math.round((rh * s) / 2) * 2);
  const frames = path.join(out, "frames");
  fs.mkdirSync(frames, { recursive: true });
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const box = [0.3 + 0.05 * t, 0.3, 0.7 + 0.05 * t, 0.7].map((v) => Math.round(v * 1e4) / 1e4);
    boxes.push(box);
    fs.writeFileSync(path.join(frames, `f_${String(i + 1).padStart(4, "0")}.png`), png(w, h, box));
    log(`PROGRESS job=${job.jobId} frame=${i + 1}/${n}`);
  }
  const center = boxes.map((b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
  const result = {
    ok: true,
    mock: true,
    sceneVersion: "ue-scene/1",
    jobId: mode === "wrong_job" ? "another-job" : job.jobId,
    template: job.template,
    unreal: {
      version: "MOCK-5.8.0",
      executor: job.render.executor,
      configClass: "MOCK",
      gi: "screen_space",
      apiVariants: {},
    },
    device: { device: "GPU", name: null },
    frames: {
      dir: mode === "escape" ? "../../escape" : "frames",
      pattern: "f_%04d.png",
      startNumber: 1,
      count: n,
      width: w,
      height: h,
      fps: job.fps,
      alpha: false,
    },
    product: {
      assetId: job.product.assetId,
      assetPath: "/Game/Render3D/Products/MOCK",
      sourceSha256: job.product.sha256,
      importSkipped: false,
      measuredCm: [20, 10, 30],
      dimsCm: [20, 10, 30],
      expectedCm: null,
      scaleApplied: 1,
      mismatchPct: null,
      materialHash: "0".repeat(64),
    },
    set: { name: "MOCK set", key: "0123456789abcdef", rebuilt: true },
    productBoxes: boxes,
    anchorTracks: { center, top: center.map(([u, v]) => [u, v - 0.2]) },
    camera: { preset: job.camera.preset, lensMm: 65, distanceCm: 120 },
    controlViews: [],
    materials: [],
    materialReport: job.product.materialReport ?? null,
    mrq: { executor: job.render.executor, mock: true },
    warnings: ["MOCK render from the fake UnrealEditor-Cmd"],
    timings: { totalMs: 10, renderMs: 5, frameMs: boxes.map(() => 1) },
    log: "ue_scene.log",
  };
  fs.writeFileSync(path.join(out, "result.json.tmp"), JSON.stringify(result));
  fs.renameSync(path.join(out, "result.json.tmp"), path.join(out, "result.json"));
  fs.writeFileSync(
    path.join(out, "fake-editor-args.json"),
    JSON.stringify({ args, env: Object.keys(process.env).sort() }),
  );
  log(`RESULT ${path.join(out, "result.json")}`);
  if (mode === "linger") return hang();
  process.exit(0);
}
