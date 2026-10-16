import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FatalError, RetryableError } from "@cre/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineUnavailableError, type EngineProgress } from "../../contracts/engine.ts";
import { runEngineProcess } from "../proc.ts";
import {
  parseUeLine,
  scriptArgument,
  ueDiagnoseArgs,
  ueEnv,
  ueSceneArgs,
  UnrealEngine,
  type UnrealEngineOptions,
} from "./batch.ts";
import { resolveUnrealConfig } from "./config.ts";
import { createUnrealEngine } from "./index.ts";
import { UeSceneJob } from "./job.ts";
import { FAKE_EDITOR, makeInstall, makeProduct, makeProject, makeRequest } from "./testing/fixtures.ts";

/*
 * The adapter end to end against a FAKE UnrealEditor-Cmd (testing/fake-unreal-editor.mjs, a node script): every
 * result in this file is a MOCK — no Unreal Engine runs here. What is real: the job file, the command line, the
 * process handling (timeouts, abort, kill), result validation and the mapping to the engine contract.
 */

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let tmp: string;
let exe: string;
let project: string;
let model: string;
let n = 0;
const scriptsDir = resolveUnrealConfig({}, {}, {}).scriptsDir;
const gpu = () => ({ available: true, name: "MOCK GPU", vramMb: 8192 });

function engine(
  mode = "ok",
  o: Partial<UnrealEngineOptions> = {},
  cfg: Parameters<typeof resolveUnrealConfig>[0] = {},
): UnrealEngine {
  return new UnrealEngine({
    launcher: { command: process.execPath, prefixArgs: [FAKE_EDITOR] },
    allowMock: true,
    env: { FAKE_UE_MODE: mode },
    gpu,
    ...o,
    config: { editorCmd: exe, project, scriptsDir, lockDir: path.join(tmp, "locks"), ...cfg },
  });
}
const work = () => {
  const d = path.join(tmp, `work-${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ue-batch-"));
  exe = makeInstall(path.join(tmp, "UE_5.8"));
  project = makeProject(path.join(tmp, "Render3D"));
  model = path.join(tmp, "models", "product.fbx");
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.writeFileSync(model, "MOCK FBX");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("UnrealEngine (MOCK editor)", () => {
  it("MOCK: renders a PNG sequence end to end through the fake UnrealEditor-Cmd", async () => {
    process.env.R3D_TEST_SECRET_API_KEY = "must-not-leak";
    const dir = work();
    const progress: EngineProgress[] = [];
    let pid = 0;
    const out = await engine().render(
      makeRequest(dir, model, { onProgress: (p) => progress.push(p), onSpawn: (p) => (pid = p) }),
    );
    delete process.env.R3D_TEST_SECRET_API_KEY;
    expect(out).toMatchObject({
      frameCount: 12,
      startNumber: 1,
      width: 128,
      height: 128,
      fps: 24,
      alpha: false,
      framePattern: "f_%04d.png",
    });
    expect(out.framesDir).toBe(path.join(dir, "ue", "frames"));
    expect(fs.readdirSync(out.framesDir).filter((f) => f.endsWith(".png"))).toHaveLength(12);
    expect(out.productBoxes).toHaveLength(12);
    expect(out.anchorTracks.center).toHaveLength(12);
    expect(out.warnings[0]).toMatch(/^MOCK render/);
    expect(out.engineVersion).toBe("Unreal Engine MOCK-5.8.0");
    expect(out.device).toBe("GPU MOCK GPU");
    expect(out.raw.mock).toBe(true);
    expect(progress.at(-1)).toEqual({ frame: 12, total: 12 });
    expect(pid).toBeGreaterThan(0);
    const job = UeSceneJob.parse(JSON.parse(fs.readFileSync(path.join(dir, "ue-scene-job.json"), "utf8")));
    expect(job.product.path).toBe(model);
    expect(job.output.dir).toBe(path.join(dir, "ue"));
    const seen = JSON.parse(fs.readFileSync(path.join(dir, "ue", "fake-editor-args.json"), "utf8")) as {
      args: string[];
      env: string[];
    };
    expect(seen.args[0]).toBe(project);
    expect(seen.args[1]).toBe(`-ExecutePythonScript=${path.join(scriptsDir, "ue_scene.py")}`);
    expect(seen.args).toEqual(
      expect.arrayContaining([
        "-unattended",
        "-nopause",
        "-nosplash",
        "-NoSound",
        "-stdout",
        "-FullStdOutLogOutput",
      ]),
    );
    expect(seen.env).toEqual(expect.arrayContaining(["R3D_UE_JOB", "UE_PYTHONPATH", "R3D_UE_TOOLS"]));
    expect(seen.env).not.toContain("R3D_TEST_SECRET_API_KEY");
    expect(fs.readFileSync(path.join(dir, "unreal.log"), "utf8")).toMatch(/LogPython: RESULT /);
  });

  it("MOCK: encodes the fake frames with FFmpeg like any engine output", async () => {
    if (!hasFfmpeg) return; // FFmpeg missing on this host: nothing to encode
    const out = await engine().render(makeRequest(work(), model));
    const mp4 = path.join(out.framesDir, "..", "clip.mp4");
    await runEngineProcess("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-framerate",
      String(out.fps),
      "-start_number",
      String(out.startNumber),
      "-i",
      path.join(out.framesDir, out.framePattern),
      "-c:v",
      "mpeg4",
      "-pix_fmt",
      "yuv420p",
      mp4,
    ]);
    expect(fs.statSync(mp4).size).toBeGreaterThan(500);
  });

  it("MOCK: refuses a mock result unless the caller allows it", async () => {
    await expect(engine("ok", { allowMock: false }).render(makeRequest(work(), model))).rejects.toThrow(
      /marked mock/,
    );
  });

  it("MOCK: maps editor failures to the error taxonomy", async () => {
    const cases: [string, new (...a: never[]) => Error, RegExp][] = [
      ["invalid", FatalError, /rejected the scene job/],
      ["crash", RetryableError, /crashed/],
      ["fail_render", FatalError, /render_failed/],
      ["not_dedicated", EngineUnavailableError, /not the dedicated/],
      ["wrong_job", FatalError, /for job another-job/],
      ["escape", FatalError, /failed validation/],
    ];
    for (const [mode, cls, re] of cases) {
      const err = await engine(mode)
        .render(makeRequest(work(), model))
        .catch((e: unknown) => e);
      expect(err, mode).toBeInstanceOf(cls);
      expect((err as Error).message, mode).toMatch(re);
    }
  });

  it("MOCK: kills a hung editor on timeout and on abort", async () => {
    const t0 = Date.now();
    await expect(engine("hang").render(makeRequest(work(), model, { timeoutMs: 1500 }))).rejects.toThrow(
      RetryableError,
    );
    expect(Date.now() - t0).toBeLessThan(10_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    await expect(engine("hang").render(makeRequest(work(), model, { signal: ac.signal }))).rejects.toThrow(
      /aborted/,
    );
  });

  it("MOCK: an editor that never runs the script is reported as unavailable (startup watchdog)", async () => {
    const err = await engine("silent", {}, { startupTimeoutMs: 700 })
      .render(makeRequest(work(), model))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toMatch(/did not run ue_scene\.py/);
  });

  it("MOCK: keeps the result when the editor does not exit after writing it", async () => {
    const out = await engine("linger", {}, { exitGraceMs: 400 }).render(makeRequest(work(), model));
    expect(out.frameCount).toBe(12);
    expect(out.warnings.join()).toMatch(/did not exit/);
  });

  it("checks the model before starting the editor", async () => {
    await expect(engine().render(makeRequest(work(), null))).rejects.toThrow(/no model file/);
    await expect(engine().render(makeRequest(work(), path.join(tmp, "missing.fbx")))).rejects.toThrow(
      /not found/,
    );
    const product = makeProduct({
      outputFiles: [
        {
          role: "fbx",
          key: "models/product.fbx",
          sizeBytes: 8,
          sha256: "0".repeat(64),
          contentType: "model/fbx",
        },
      ],
    });
    await expect(engine().render(makeRequest(work(), model, { product }))).rejects.toThrow(
      /does not match the library record/,
    );
  });

  it("is unavailable without a dedicated project, and the factory never throws for a missing install", async () => {
    const e = engine("ok", {}, { project: path.join(tmp, "nope.uproject") });
    expect((await e.probe()).available).toBe(false);
    await expect(e.render(makeRequest(work(), model))).rejects.toBeInstanceOf(EngineUnavailableError);
    const f = createUnrealEngine({}, { gpu }, {});
    const caps = await f.probe();
    expect(caps).toMatchObject({ engine: "unreal", available: false, renderers: [] });
    expect(caps.reason).toMatch(/UE_EDITOR_CMD|Unreal Engine not found/);
    const ok = await engine().probe();
    expect(ok).toMatchObject({ available: true, version: "Unreal Engine 5.8.1", renderers: ["MRQ"] });
  });

  it("MOCK: runs the diagnostics commandlet", async () => {
    const rep = await engine().diagnose({ outDir: work() });
    expect(rep).toMatchObject({ ok: true, mock: true, engineVersion: "MOCK-5.8.0" });
  });
});

describe("command line + output parsing", () => {
  it("builds the editor arguments", () => {
    expect(ueSceneArgs("/p/R.uproject", "/repo/tools/unreal/ue_scene.py", "linux").slice(0, 2)).toEqual([
      "/p/R.uproject",
      "-ExecutePythonScript=/repo/tools/unreal/ue_scene.py",
    ]);
    expect(
      ueDiagnoseArgs("C:\\P\\R.uproject", "C:\\repo\\tools\\unreal\\ue_diagnose.py", "win32").slice(1, 3),
    ).toEqual(["-run=pythonscript", "-script=C:\\repo\\tools\\unreal\\ue_diagnose.py"]);
    // a Windows path with spaces cannot survive UE's raw command-line parser: the name goes through UE_PYTHONPATH
    expect(scriptArgument("C:\\Users\\Jane Doe\\repo\\tools\\unreal\\ue_scene.py", "win32")).toBe(
      "-ExecutePythonScript=ue_scene.py",
    );
    expect(scriptArgument("/home/jane doe/tools/unreal/ue_scene.py", "linux")).toBe(
      "-ExecutePythonScript=/home/jane doe/tools/unreal/ue_scene.py",
    );
  });

  it("parses ue_scene.py lines behind UE log prefixes", () => {
    expect(parseUeLine("[2026.10.16-12.00.00:000][  0]LogPython: PROGRESS job=j1 frame=3/40")).toEqual({
      kind: "progress",
      progress: { frame: 3, total: 40 },
    });
    expect(parseUeLine("PROGRESS job=j1 frame=3/40 ms=120")).toEqual({
      kind: "progress",
      progress: { frame: 3, total: 40, ms: 120 },
    });
    expect(parseUeLine("LogPython: R3D_STARTED script=ue_scene pid=4")).toEqual({ kind: "started" });
    expect(parseUeLine("LogPython: RESULT C:\\w\\ue\\result.json")).toEqual({ kind: "result" });
    expect(parseUeLine("LogPython: PHASE import job=j1")).toEqual({ kind: "phase", phase: "import" });
    expect(parseUeLine("LogTemp: SOMEPROGRESS job=x frame=1/2")).toBeNull();
  });

  it("gives the editor a minimal environment", () => {
    const env = ueEnv(
      "/repo/tools/unreal",
      { R3D_UE_JOB: "/w/job.json" },
      {
        PATH: "/bin",
        ProgramData: "C:\\ProgramData",
        GEMINI_API_KEY: "secret",
        DATABASE_URL: "postgres://x",
        "UE-LocalDataCachePath": "D:\\DDC",
      },
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      ProgramData: "C:\\ProgramData",
      R3D_UE_JOB: "/w/job.json",
      UE_PYTHONPATH: "/repo/tools/unreal",
      "UE-LocalDataCachePath": "D:\\DDC",
    });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });
});
