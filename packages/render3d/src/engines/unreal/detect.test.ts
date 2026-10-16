import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveUnrealConfig } from "./config.ts";
import {
  capabilitiesFromDetection,
  detectUnreal,
  engineDirOf,
  inspectProject,
  parseBuildVersion,
  readBuildVersion,
  whichSync,
  windowsEditorCandidates,
} from "./detect.ts";
import { makeInstall, makeProject } from "./testing/fixtures.ts";

/* Configuration and file-system detection against MOCK install trees (no Unreal Engine is installed here). */

let tmp: string;
const scriptsDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../../../../tools/unreal",
);
const gpu = { available: true, name: "MOCK GPU", vramMb: 8192 };

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ue-detect-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("resolveUnrealConfig", () => {
  it("reads Env and the extra UE_* variables, with defaults", () => {
    const c = resolveUnrealConfig(
      {},
      {
        UE_EDITOR_CMD: "C:/UE/Engine/Binaries/Win64/UnrealEditor-Cmd.exe",
        UE_PROJECT: "/p/R.uproject",
        UE_RENDER_TIMEOUT_MS: 120_000,
      },
      { UE_MRQ_EXECUTOR: "new_process", UE_GI_MODE: "", UE_STARTUP_TIMEOUT_MS: "60000" },
    );
    expect(c.editorCmd).toMatch(/UnrealEditor-Cmd\.exe$/);
    expect(c.project).toBe(path.resolve("/p/R.uproject"));
    expect(c.renderTimeoutMs).toBe(120_000);
    expect(c.executor).toBe("new_process");
    expect(c.gi).toBe("auto");
    expect(c.startupTimeoutMs).toBe(60_000);
    expect(c.remoteExecPort).toBe(6766);
    expect(c.remoteExecCommandPort).toBe(6776);
    expect(c.scriptsDir).toBe(scriptsDir);
  });

  it("keeps a bare command name for PATH lookup and lets overrides win", () => {
    const c = resolveUnrealConfig(
      { executor: "pie", startupTimeoutMs: 1000 },
      { UE_EDITOR_CMD: "UnrealEditor-Cmd" },
      {},
    );
    expect(c.editorCmd).toBe("UnrealEditor-Cmd");
    expect(c.project).toBeNull();
    expect(c.startupTimeoutMs).toBe(1000);
  });

  it("rejects invalid values", () => {
    expect(() => resolveUnrealConfig({}, {}, { UE_MRQ_EXECUTOR: "remote" })).toThrow();
    expect(() => resolveUnrealConfig({}, {}, { UE_REMOTE_EXEC_PORT: "80" })).toThrow();
    expect(() => resolveUnrealConfig({}, {}, { UE_REMOTE_EXEC_GROUP: "10.0.0.1" })).toThrow();
    expect(() => resolveUnrealConfig({}, {}, { UE_PROJECT: "x\n.uproject" })).toThrow();
  });
});

describe("engine version", () => {
  it("parses Build.version and finds it next to the binary", () => {
    expect(
      parseBuildVersion(
        '{"MajorVersion":5,"MinorVersion":8,"PatchVersion":1,"Changelist":7,"BranchName":"++UE5+Release-5.8"}',
      ),
    ).toEqual({
      major: 5,
      minor: 8,
      patch: 1,
      changelist: 7,
      branch: "++UE5+Release-5.8",
    });
    expect(parseBuildVersion("{}")).toBeNull();
    expect(parseBuildVersion("not json")).toBeNull();
    const exe = makeInstall(path.join(tmp, "UE_5.8"));
    expect(engineDirOf(exe)).toBe(path.join(tmp, "UE_5.8", "Engine"));
    expect(readBuildVersion(exe)?.version.minor).toBe(8);
    expect(readBuildVersion(path.join(tmp, "nowhere", "UnrealEditor-Cmd"))).toBeNull();
  });

  it("lists default Windows installs newest first", () => {
    const pf = path.join(tmp, "ProgramFiles");
    for (const v of ["UE_5.6", "UE_5.8", "UE_4.27", "UE_5.10", "Launcher"])
      fs.mkdirSync(path.join(pf, "Epic Games", v), { recursive: true });
    const c = windowsEditorCandidates({ ProgramFiles: pf });
    expect(c.map((f) => f.split(/[\\/]/).find((p) => p.startsWith("UE_")))).toEqual([
      "UE_5.10",
      "UE_5.8",
      "UE_5.6",
    ]);
    expect(c[0]).toMatch(/Engine[\\/]Binaries[\\/]Win64[\\/]UnrealEditor-Cmd\.exe$/);
  });

  it("resolves bare commands through PATH", () => {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "UnrealEditor-Cmd"), "");
    expect(whichSync("UnrealEditor-Cmd", { PATH: bin }, "linux")).toBe(path.join(bin, "UnrealEditor-Cmd"));
    expect(whichSync("Nope", { PATH: bin }, "linux")).toBeNull();
  });
});

describe("render project", () => {
  it("accepts the dedicated project and reports missing recommended plugins", () => {
    const p = inspectProject(
      makeProject(path.join(tmp, "proj-ok"), { plugins: ["PythonScriptPlugin", "MovieRenderPipeline"] }),
    );
    expect(p.ok).toBe(true);
    expect(p.dedicated).toBe(true);
    expect(p.warnings.join()).toMatch(/EditorScriptingUtilities/);
  });

  it("refuses projects without the marker, without required plugins or for another engine", () => {
    expect(inspectProject(makeProject(path.join(tmp, "game"), { marker: false })).reason).toMatch(
      /not the dedicated render project/,
    );
    expect(
      inspectProject(makeProject(path.join(tmp, "noplug"), { plugins: ["PythonScriptPlugin"] })).reason,
    ).toMatch(/MovieRenderPipeline/);
    const v = { major: 5, minor: 8, patch: 0, changelist: null, branch: null };
    expect(inspectProject(makeProject(path.join(tmp, "old"), { association: "5.6" }), v).reason).toMatch(
      /associated with UE 5.6/,
    );
    expect(inspectProject(makeProject(path.join(tmp, "src"), { association: "{0A1B2C3D-0000}" }), v).ok).toBe(
      true,
    );
    expect(inspectProject(path.join(tmp, "missing.uproject")).reason).toMatch(/does not exist/);
    expect(inspectProject(path.join(tmp, "x.txt")).reason).toMatch(/not a \.uproject/);
  });
});

describe("detectUnreal", () => {
  it("is available with an editor, a version and the dedicated project", () => {
    const exe = makeInstall(path.join(tmp, "UE_ok"));
    const project = makeProject(path.join(tmp, "Render3D"));
    const d = detectUnreal({ editorCmd: exe, project, scriptsDir }, {}, "win32");
    expect(d.available).toBe(true);
    expect(d.editorSource).toBe("config");
    const caps = capabilitiesFromDetection(d, gpu, "host1");
    expect(caps).toMatchObject({
      engine: "unreal",
      available: true,
      version: "Unreal Engine 5.8.1",
      reason: null,
      renderers: ["MRQ"],
      host: "host1",
    });
  });

  it("falls back to the default Windows install path", () => {
    const pf = path.join(tmp, "PF2");
    makeInstall(path.join(pf, "Epic Games", "UE_5.8"));
    const project = makeProject(path.join(tmp, "Render3D-b"));
    const d = detectUnreal({ editorCmd: null, project, scriptsDir }, { ProgramFiles: pf }, "win32");
    expect(d.available).toBe(true);
    expect(d.editorSource).toBe("default-install");
  });

  it("explains precisely why it is unavailable", () => {
    const project = makeProject(path.join(tmp, "Render3D-c"));
    const cases: [Parameters<typeof detectUnreal>[0], RegExp][] = [
      [{ editorCmd: null, project, scriptsDir }, /set UE_EDITOR_CMD/],
      [{ editorCmd: path.join(tmp, "none.exe"), project, scriptsDir }, /not found/],
      [
        { editorCmd: makeInstall(path.join(tmp, "UE_ok2")), project: null, scriptsDir },
        /UE_PROJECT is not set/,
      ],
      [
        {
          editorCmd: makeInstall(path.join(tmp, "UE_4"), {
            MajorVersion: 4,
            MinorVersion: 27,
            PatchVersion: 2,
          }),
          project,
          scriptsDir,
        },
        /UE 5\.x is required/,
      ],
      [
        {
          editorCmd: makeInstall(path.join(tmp, "UE_ok3")),
          project,
          scriptsDir: path.join(tmp, "noscripts"),
        },
        /UE scripts are missing/,
      ],
    ];
    for (const [cfg, re] of cases) {
      const d = detectUnreal(cfg, {}, "linux");
      expect(d.available).toBe(false);
      expect(d.reason).toMatch(re);
      expect(capabilitiesFromDetection(d, gpu).renderers).toEqual([]);
    }
    const noVersion = path.join(tmp, "bare", "UnrealEditor-Cmd");
    fs.mkdirSync(path.dirname(noVersion), { recursive: true });
    fs.writeFileSync(noVersion, "");
    expect(detectUnreal({ editorCmd: noVersion, project, scriptsDir }, {}, "linux").reason).toMatch(
      /Build\.version/,
    );
  });

  it("warns for another 5.x minor version", () => {
    const exe = makeInstall(path.join(tmp, "UE_5.6"), { MajorVersion: 5, MinorVersion: 6, PatchVersion: 0 });
    const project = makeProject(path.join(tmp, "Render3D-56"), { association: "5.6" });
    const d = detectUnreal({ editorCmd: exe, project, scriptsDir }, {}, "win32");
    expect(d.available).toBe(true);
    expect(d.warnings.join()).toMatch(/targets 5\.8/);
  });
});
