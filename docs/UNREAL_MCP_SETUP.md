# Unreal Engine 5.8 render station: setup, MCP / remote control, first render

> **Verification status — read first.** The Unreal adapter (`packages/render3d/src/engines/unreal/`) and the editor
> scripts (`tools/unreal/`) were written for UE 5.8 on Windows but were **not run against a real Unreal Engine** in
> the environment they were developed in (Linux container, no GPU, no UE install). What is verified there: the pure
> Python logic (job validation, the six set descriptions, camera / projection math, scale normalisation, material
> decisions — `python3 -m unittest` in `tools/unreal`), the TypeScript adapter end to end against a **fake**
> `UnrealEditor-Cmd` and a **mock** remote-execution node (vitest, results labelled `"mock": true`). Everything that
> touches the real editor — Python API names, Movie Render Queue behaviour, importer axis conversion, lighting
> values, the remote-execution wire protocol — must be confirmed on your 5.8 install with the diagnostics below
> before you trust a render.

## How the pieces fit

```
render worker (TS)
  └─ UnrealEngine.render()                      packages/render3d/src/engines/unreal/batch.ts
       ├─ writes ue-scene-job.json              closed sets + bounded numbers only (job.ts / tools/unreal/ue_job.py)
       ├─ UnrealEditor-Cmd <Render3D.uproject> -ExecutePythonScript=<repo>/tools/unreal/ue_scene.py
       │     -unattended -nopause -nosplash -NoSound -stdout -FullStdOutLogOutput      (no shell; job path in R3D_UE_JOB)
       │     └─ ue_scene.py (inside the editor): level /Game/Render3D/Levels/L_<template>, product import,
       │        set, CineCamera + Level Sequence, Movie Render Queue → frames/f_0001.png … + result.json
       └─ validates result.json (zod) → EngineRenderOutput → the engine-independent worker encodes MP4, runs QA,
          stores the clip in the library
interactive / MCP control (optional)
  └─ UeRemoteExecClient (remote-exec.ts) or tools/unreal/remote_exec.py
       → the open editor's Python remote execution, loopback only, whitelisted scripts only
```

Why `-ExecutePythonScript` and not the `-run=pythonscript` commandlet: Movie Render Queue renders over editor
ticks with a real RHI. `-ExecutePythonScript` starts the full editor loop; the script waits until the editor is idle,
sets the scene up, starts MRQ and quits the editor when `result.json` is written. The PythonScript commandlet runs a
script without that loop and without rendering — it is used only for `ue_diagnose.py`.

## 0. Check for an existing Unreal AI / MCP integration first

Before adding anything, check whether your UE 5.8 install (or a plugin you already own) provides an AI-assistant or
Model Context Protocol (MCP) integration. This document does not assume any specific product exists; check yourself:

1. Open any project in UE 5.8 → **Edit > Plugins** → search for `MCP`, `Model Context`, `AI`, `Assistant`. Note the
   plugin name, its vendor and whether it is Epic-made or third-party.
2. Look in **Edit > Project Settings > Plugins** for settings pages of such a plugin (ports, bind address,
   authentication).
3. Run the diagnostics (section 5): `plugins.aiIntegrationCandidates` lists enabled plugins whose names look like an
   AI / MCP integration — a hint, not a verdict.
4. Read the plugin's own documentation for how it is reached (stdio, HTTP, WebSocket) and what it can execute.

**If one exists, prefer it** for interactive editing from an MCP client: register it in `.mcp.json` the same way
`tools/mcp/launch.mjs` registers the Blender server (minimal environment, loopback only), and keep it limited to
`127.0.0.1`. Do not open it to the network. The render pipeline itself does **not** depend on it: renders always
go through the batch path above, which only needs the plugins in section 2.

If there is none, the repository's own path is Python remote execution (section 3) with the whitelisted client.

## 1. Create the dedicated render project (never a game project)

The adapter only ever modifies a project that carries the `Render3D` marker, and inside it only `/Game/Render3D/…`.

1. Epic Games Launcher → Unreal Engine 5.8 → **Launch** → **Games → Blank**, **Blueprint**, **no Starter Content**,
   target Desktop, quality Maximum. Ray tracing is optional (Lumen also works with software tracing).
2. Put it on a local SSD, ideally on a path **without spaces**, e.g. `D:\UE\Render3D\Render3D.uproject`
   (paths with spaces work through a fallback, see Troubleshooting). Close the editor.
3. Mark and configure it (run from the repository root; plain Python 3, no editor needed):

   ```powershell
   python tools/unreal/ue_project.py init "D:\UE\Render3D\Render3D.uproject" --remote-exec --lumen
   python tools/unreal/ue_project.py check "D:\UE\Render3D\Render3D.uproject"
   ```

   `init` refuses a project that has C++ modules, a `Source` folder or existing content (so a real game project is
   never touched). It writes `Config/DefaultRender3D.ini` (the marker), enables the plugins below in the
   `.uproject` (backup: `.uproject.bak`), and with the flags writes the remote-execution and Lumen settings to
   `Config/DefaultEngine.ini`.

## 2. Plugins

Open the project once in the editor and confirm in **Edit > Plugins** (restart the editor when it asks):

| Plugin (display name)       | `.uproject` name           | used for                                  |
| --------------------------- | -------------------------- | ----------------------------------------- |
| Python Editor Script Plugin | `PythonScriptPlugin`       | running `tools/unreal/*.py` (required)    |
| Movie Render Queue          | `MovieRenderPipeline`      | PNG sequence rendering (required)         |
| Editor Scripting Utilities  | `EditorScriptingUtilities` | asset / actor scripting                   |
| Sequencer Scripting         | `SequencerScripting`       | keyframing the Level Sequence from Python |

Plugin names are the documented 5.x names; if 5.8 shows a different name, enable the matching plugin and tell the
diagnostics output (`missingRequired`) to confirm. The first editor start compiles shaders and can take a long time.

## 3. Python remote execution — loopback only (optional, for interactive control)

**Edit > Project Settings > Plugins > Python** (or the `--remote-exec` flag above):

- **Enable Remote Execution**: on
- **Multicast Group Endpoint**: `239.0.0.1:6766`
- **Multicast Bind Address**: `127.0.0.1` (never `0.0.0.0`)
- **Multicast Time-To-Live**: `0` (datagrams never leave the machine)

If Windows Firewall asks about `UnrealEditor.exe`, do not allow public networks; nothing needs an inbound rule.
The protocol (UDP multicast discovery `ping/pong/open_connection/close_connection`, then a TCP command channel the
_client_ listens on, `command` → `command_result`, exec modes `ExecuteFile` / `ExecuteStatement` /
`EvaluateStatement`) is documented in `tools/unreal/remote_exec.py`. It was implemented from UE's own
`Engine/Plugins/Experimental/PythonScriptPlugin/Content/Python/remote_execution.py` and **must be checked against
the copy in your 5.8 install** (same constants, same message fields).

## 4. Environment

In the repository's `.env` (paths are examples):

```dotenv
UE_EDITOR_CMD=C:/Program Files/Epic Games/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe
UE_PROJECT=D:/UE/Render3D/Render3D.uproject
# optional
UE_RENDER_TIMEOUT_MS=3600000        # hard limit of one render (default: the worker's request timeout)
UE_REMOTE_EXEC_PORT=6766            # multicast group port of Python remote execution
UE_STARTUP_TIMEOUT_MS=1200000       # editor start → ue_scene.py running (first start compiles shaders)
UE_REMOTE_EXEC_COMMAND_PORT=6776    # TCP port the remote-exec client listens on (127.0.0.1)
UE_MRQ_EXECUTOR=pie                 # pie (render in the editor process) | new_process (separate -game process)
UE_GI_MODE=auto                     # auto | lumen | screen_space
```

When `UE_EDITOR_CMD` is unset, `C:\Program Files\Epic Games\UE_5.*\Engine\Binaries\Win64\UnrealEditor-Cmd.exe` is
searched (newest 5.x first). The version is read from `Engine/Build/Build.version` next to the binary. The engine
probes as unavailable — with the exact reason — when the editor, the version file, the project, its marker or a
required plugin is missing, or when the project is associated with another engine version.

The editor process gets a minimal environment (no API keys or database URLs of the worker): `PATH`, the Windows
system variables an editor needs, `UE-LocalDataCachePath` / `UE-SharedDataCachePath` if you set them, and the job.

## 5. Diagnostics (do this first on a new install)

Any of these writes a JSON report (engine version, which Python APIs exist and **which renamed variant** was found —
e.g. `MoviePipelinePrimaryConfig` vs `MoviePipelineMasterConfig`, `add_track` vs `add_master_track` — plugin
state, Lumen capability, remote-execution settings, whether this is the dedicated project):

```powershell
# commandlet, no window (also what UnrealEngine.diagnose() runs)
& $env:UE_EDITOR_CMD "D:\UE\Render3D\Render3D.uproject" -run=pythonscript -script="C:/repo/tools/unreal/ue_diagnose.py" -unattended -stdout
#   → D:\UE\Render3D\Saved\Render3D\diagnose.json   (or $env:R3D_UE_DIAG_OUT)

# inside an open editor: Window > Output Log, "Cmd" → Python, then:
#   py "C:/repo/tools/unreal/ue_diagnose.py"

# remote execution into the open editor (section 3 enabled)
python tools/unreal/remote_exec.py discover
python tools/unreal/remote_exec.py diagnose C:/repo/.data/ue-diagnose.json
```

Check: `ok: true`, `missingRequired: []`, `project.dedicated: true`, `rendering.gi` (`lumen` when distance fields or
hardware ray tracing are on), and read every entry of `warnings`. Please keep the report: any API variant that
shows `null` means a code path that needs adjusting for 5.8.

## 6. First render

The worker uses the adapter once it is registered (`registerUnrealFactory(createUnrealEngine)` in
`packages/render3d/src/setup.ts`). For a first manual check, render a short preview of an exported product:

```ts
import { Recipe3D } from "@cre/render3d/contracts";
import { UnrealEngine } from "./packages/render3d/src/engines/unreal/index.ts";

const ue = new UnrealEngine(); // reads UE_EDITOR_CMD / UE_PROJECT from the environment
console.log(await ue.probe()); // available, "Unreal Engine 5.8.x", reason
console.log(await ue.diagnose({ outDir: ".data/ue-diag" }));
const out = await ue.render({
  jobId: "ue-first-render",
  recipe: Recipe3D.parse({
    template: "UE_LUXURY_STUDIO",
    engine: "UNREAL",
    productAssetId: "<asset id>",
    durationSec: 2,
    fps: 24,
    resolution: [540, 960],
    quality: "preview",
    camera: { preset: "orbit_closeup", movement: "slow" },
  }),
  product, // the Asset3D library record of the model
  productFile: "C:/repo/.data/export/product.fbx", // from tools/blender/scenes/export.py
  workDir: "C:/repo/.data/ue-first-render",
  device: "GPU",
  threads: 0,
  timeoutMs: 3_600_000,
  onProgress: (p) => console.log(`${p.frame}/${p.total}`),
});
```

In the work directory you get `ue-scene-job.json`, `unreal.log` (the editor's stdout), `ue/ue_scene.log`,
`ue/frames/f_0001.png …` and `ue/result.json`. In the project, everything lives under `/Game/Render3D`
(`Levels/L_<template>`, `Sequences/LS_<template>`, `Products/<asset id>`, `Materials/…`); open the level and the
sequence in the editor to look at what was built. Run a preview of each template once and look at the frames before
any production render.

### Product files and materials

- Export products with `tools/blender/scenes/export.py`: FBX with `FBX_SCALE_UNITS` (metres in Blender → centimetres
  in UE), Z up, front −Y in Blender → **+X in UE** (the legacy FBX importer's _Force Front X Axis_; with Interchange
  the script rotates by −90° instead). glTF axis conversion through Interchange is **unverified**: check the front.
- The imported model is re-imported only when its sha256 changes (asset metadata tag `R3D_SourceSha256` + manifest
  `Saved/Render3D/import_manifest.json`), scaled to the declared `dimensionsM` (warning above 10 % mismatch, unit
  errors such as metres-as-centimetres are named), centred on XY with its base on Z = 0.
- Materials follow the export report (`<model>.materials.json`, `material_report.json`, or the Blender export's
  `result.json` one directory up): `PBR_DIRECT` as imported; `APPROXIMATED` → instance of a clear-coat / translucent
  / opaque parent with parameter values (kept as imported, with a warning, when it has image textures);
  `NEEDS_BAKE` → textured instance when `baked/<Material>.<baseColor|roughness|metallic|normal>.png` maps exist next
  to the model, else as imported + warning; `UNSUPPORTED` → neutral grey + warning.

### Templates

| Template                  | Set (built from `/Engine/BasicShapes`, `tools/unreal/ue_sets.py`)                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `UE_LUXURY_STUDIO`        | dark glossy stage, stone plinth with brass ring, soft key, strip rims, backdrop light pool         |
| `UE_AUTOMOTIVE_CINEMATIC` | polished concrete hall, low metal turntable, overhead strip array, side rims, volumetric haze      |
| `UE_MODERN_INTERIOR`      | daylit room; product on side table / counter / vanity / desk (or the floor), sofa, plant, pendant  |
| `UE_INDUSTRIAL_WORKSHOP`  | workbench, pegboard with tool silhouettes, shelving, hanging lamp, tube light, dusty haze (garage) |
| `UE_TECHNOLOGY_SHOWCASE`  | black gloss floor with emissive grid, pedestal with glowing ring, light panels, cool haze          |
| `UE_ARCHITECTURAL_DEMO`   | bright hall, white podium, mullioned window wall with sun, columns, sky atmosphere                 |

Sets scale with the product (studios) or keep real furniture sizes (interiors) and are rebuilt automatically when
their description changes (another product size bucket, lighting or background preset); swapping the product never
needs manual set work. The light / exposure values are **untuned starting points**: adjust them in the editor and
carry the numbers back into `ue_sets.py`.

## Troubleshooting

| Symptom                                                          | Cause / fix                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| probe: `UE_EDITOR_CMD … not found` / `cannot read Build.version` | point `UE_EDITOR_CMD` at `…/Engine/Binaries/Win64/UnrealEditor-Cmd.exe` of a launcher or source build                                                 |
| probe: `not the dedicated render project`                        | run `ue_project.py init` on a fresh blank project (never on a game project)                                                                           |
| probe: `associated with UE 5.x but the editor is …`              | open the project once with the configured editor (or fix `UE_EDITOR_CMD`)                                                                             |
| `the editor did not run ue_scene.py within … s`                  | Python Editor Script Plugin disabled, or the first start is still compiling shaders: raise `UE_STARTUP_TIMEOUT_MS`                                    |
| repository path contains spaces                                  | the adapter passes `-ExecutePythonScript=ue_scene.py` and `UE_PYTHONPATH=<repo>/tools/unreal` (unverified UE behaviour): prefer a path without spaces |
| `api_missing` in result.json                                     | a required API is not in this engine: run the diagnostics and report the `null` variants                                                              |
| `Lumen unavailable … screen-space GI` warning                    | enable _Generate Mesh Distance Fields_ (or hardware ray tracing) in Project Settings > Rendering                                                      |
| product faces away / lies on its side                            | export with `export.py`; for glTF set a front yaw (`UnrealEngineOptions.frontYawDeg`)                                                                 |
| `model size differs … by N %`                                    | the model's units or the asset's `dimensionsM` are wrong — check both                                                                                 |
| MRQ fails / PIE window issues                                    | try `UE_MRQ_EXECUTOR=new_process`; read `ue/ue_scene.log` and `unreal.log`                                                                            |
| `the editor crashed` (retried)                                   | GPU driver / out of video memory: lower the resolution or `quality: preview`                                                                          |
| `remote_exec.py discover` finds nothing                          | remote execution off, bind address not 127.0.0.1, another client holds port 6766, or a firewall blocks loopback multicast                             |

## Security

- Loopback only: the remote-exec clients bind and connect `127.0.0.1`, send with TTL 0, drop non-loopback peers,
  and refuse non-loopback settings unless explicitly overridden in code. No public ports are needed for anything.
- Whitelisted scripts only: the clients cannot send caller-supplied code; they send one fixed template that runs this
  repository's `ue_diagnose.py` or `ue_scene.py` with a validated absolute `.json` path (a scene job must be
  `interactive: true` so the user's editor is never closed). With `expectProjectDir` the TS client also refuses
  editors that have another project open.
- Nothing from a job is executed or evaluated: the job names closed-set values and bounded numbers, unknown keys are
  rejected on both sides, and the only paths it carries are the output directory, the model file and baked maps copied
  into the output directory. `result.json` is validated before any file name in it is used.
- The editor runs without a shell and with a minimal environment; only the dedicated project is modified, only below
  `/Game/Render3D`; one editor per project at a time (lock file in `<project>/Saved/Render3D/locks`).

## Not verifiable without a real UE 5.8 install

- the exact Python API names in 5.8 (all resolved at runtime with fallbacks; the diagnostics report what exists);
- `-ExecutePythonScript` timing inside `UnrealEditor-Cmd` and `quit_editor()` exit codes; the relative script-name
  fallback through `UE_PYTHONPATH`;
- Movie Render Queue in this mode (PIE / new-process executor, `frame_number_offset`, AA / warm-up settings, PNG
  output naming) and whether the legacy MRQ configuration is still the default next to Movie Render Graph;
- FBX import through the legacy importer vs Interchange (axis / unit handling), glTF axis conversion, importer
  material parameter names;
- the look of the six sets (light intensities, exposure, fog) and per-frame product boxes vs the rendered pixels
  (the math matches UE's camera model on paper; boxes use the product's oriented bounds, so they are conservative);
- the remote-execution protocol details (`remote_execution.py` of 5.8) and multicast on the Windows loopback.
