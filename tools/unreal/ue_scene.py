"""UE scene generator: one validated UE scene job → a Movie Render Queue PNG sequence + result.json.

Runs INSIDE the Unreal Editor of the dedicated render project (never a game project):

    UnrealEditor-Cmd <Render3D.uproject> -ExecutePythonScript=<abs>/tools/unreal/ue_scene.py -unattended ...
        job file from $R3D_UE_JOB (the adapter's way: no path is ever quoted on the editor command line)
    UnrealEditor-Cmd <Render3D.uproject> -ExecutePythonScript="<abs>/ue_scene.py <job.json>"   (manual use)
    Python remote execution into an open editor: ue_scene.py <job.json> with "interactive": true in the job

-ExecutePythonScript starts the full editor (with its engine loop), which Movie Render Queue needs: rendering
happens over editor ticks. The PythonScript commandlet (-run=pythonscript) runs a script without that loop and
without rendering; it is only usable with render.setupOnly (build the level, import, sequence — no frames).

Steps (each logged to <output.dir>/ue_scene.log): validate the job (closed sets, bounded numbers, paths) → check the
project carries the Render3D marker → open / create /Game/Render3D/Levels/L_<template> → import the product into
/Game/Render3D/Products/<assetId> unless its sha256 is unchanged (asset metadata tag + Saved/Render3D manifest) →
normalise its scale to the declared dimensions, centre it, base on Z = 0 → material instances per the export
report → build or reuse the template set (ue_sets) → CineCameraActor tracking the product, Level Sequence with
camera + product keys per frame (ue_math.camera_plan) → MRQ job (PNG f_%04d.png into <output.dir>/frames) →
render (PIE or new-process executor) while printing PROGRESS lines → result.json (atomic) → quit the editor.

Nothing from the job is executed or evaluated. Exit codes: 0 ok · 3 invalid job · 1 error.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(globals().get("__file__") or os.environ.get("R3D_UE_TOOLS", "") + "/x"))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import ue_compat  # noqa: E402
import ue_job  # noqa: E402
import ue_materials  # noqa: E402
import ue_math  # noqa: E402
import ue_mrq  # noqa: E402
import ue_sets  # noqa: E402
import ue_util  # noqa: E402
from ue_job import UeJobError  # noqa: E402

unreal = ue_compat.unreal

SCENE_VERSION = "ue-scene/1"
EXIT_OK, EXIT_ERROR, EXIT_INVALID = 0, 1, 3
ROOT = ue_util.OWN_ROOT
LEVELS = ROOT + "/Levels"
SEQUENCES = ROOT + "/Sequences"
PRODUCTS = ROOT + "/Products"
MATERIALS = ROOT + "/Materials"
SET_MATERIALS = MATERIALS + "/Set"
INSTANCES = MATERIALS + "/Instances"
BAKED = MATERIALS + "/Baked"
TAG_SET, TAG_PRODUCT, TAG_CAMERA = "R3D_SET", "R3D_PRODUCT", "R3D_CAMERA"
SHA_TAG = "R3D_SourceSha256"
MANIFEST = "import_manifest.json"
BASIC_SHAPES = "/Engine/BasicShapes/"
RESULT, LOG = "result.json", "ue_scene.log"


class ProjectError(RuntimeError):
    """The editor's project is not the dedicated render project (or has unsaved work in interactive mode)."""


class RenderError(RuntimeError):
    """Movie Render Queue failed or produced an incomplete sequence."""


# ------------------------------------------------------------------------------------- pure helpers ----


def level_path(template: str) -> str:
    return ue_util.own_path(f"{LEVELS}/L_{template}")


def sequence_path(template: str) -> str:
    return ue_util.own_path(f"{SEQUENCES}/LS_{template}")


def product_folder(asset_id: str) -> str:
    return ue_util.own_path(f"{PRODUCTS}/{ue_util.safe_asset_name(asset_id)}")


def object_path(asset_path: str) -> str:
    """/Game/A/B → /Game/A/B.B (the soft object path MRQ and load_asset accept)."""
    return f"{asset_path}.{asset_path.rsplit('/', 1)[-1]}"


def import_decision(entry: dict | None, sha: str, mesh_tags: list[str | None], fmt: str) -> tuple[bool, str]:
    """(import?, why) — re-import only when the product file's content hash changed or the assets are gone."""
    if not mesh_tags:
        return True, "no imported meshes yet"
    if entry is None:
        return True, "not in the import manifest"
    if entry.get("sha256") != sha:
        return True, "product file changed (sha256)"
    if entry.get("format") != fmt:
        return True, f"format changed ({entry.get('format')} → {fmt})"
    if any(t != sha for t in mesh_tags):
        return True, "asset metadata hash differs from the manifest"
    return False, "unchanged (sha256 matches)"


def load_manifest(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) and isinstance(data.get("products"), dict) else {"products": {}}
    except (OSError, ValueError):
        return {"products": {}}


def failure_doc(job_id: str | None, code: int, error: str, message: str, warnings: list[str],
                timings: dict) -> dict:
    return {"ok": False, "sceneVersion": SCENE_VERSION, "jobId": job_id, "exitCode": code, "error": error,
            "message": message[:4000], "warnings": warnings[:200], "timings": timings}


def classify(exc: BaseException) -> tuple[int, str]:
    if isinstance(exc, UeJobError):
        return EXIT_INVALID, "invalid_job"
    if isinstance(exc, ProjectError):
        return EXIT_ERROR, "not_dedicated_project"
    if isinstance(exc, ue_compat.ApiMissing):
        return EXIT_ERROR, "api_missing"
    if isinstance(exc, RenderError):
        return EXIT_ERROR, "render_failed"
    return EXIT_ERROR, "error"


def expected_set_actors(desc: dict) -> int:
    """Actors a built set consists of: shapes, lights, the post-process volume, fog and sky atmosphere."""
    return len(desc["shapes"]) + len(desc["lights"]) + 1 + (1 if desc["fog"] else 0) + \
        (1 if desc["skyAtmosphere"] else 0)


def hex_linear(hex_color: str) -> tuple[float, float, float]:
    return ue_materials._hex_to_linear(hex_color)  # noqa: SLF001 — one conversion for the whole tool


def poses_track(poses: list, every: int) -> list[dict]:
    return [{"f": p.frame, "x": round(p.camera[0], 2), "y": round(p.camera[1], 2), "z": round(p.camera[2], 2),
             "pitch": round(p.pitch, 3), "yaw": round(p.yaw, 3), "productYaw": round(p.product_yaw, 3)}
            for p in poses[::max(1, every)]]


# --------------------------------------------------------------------------------------- the run ----


class SceneRun:
    """One job inside the editor. setup() is synchronous; rendering progresses over editor ticks (poll())."""

    def __init__(self, job: dict, log: ue_util.Log, api: ue_compat.Api):
        self.job = job
        self.log = log
        self.api = api
        self.ue = api.ue
        self.out_dir = job["output"]["dir"]
        self.frames_dir = os.path.join(self.out_dir, "frames")
        self.warnings: list[str] = []
        self.timings: dict = {}
        self.t_all = time.monotonic()
        self.n = ue_job.frame_count(job["durationSec"], job["fps"])
        self.width, self.height = ue_job.render_size(job["quality"], job["resolution"])
        self.executor = None
        self.finished: bool | None = None
        self.errors: list[str] = []
        self.render_started = 0.0
        self.render_wall_start = 0.0
        self.last_count = -1
        self.last_poll = 0.0
        self.info: dict = {}
        self.state: dict = {}
        self.queue_subsystem = None

    # -- small helpers
    def warn(self, msg: str) -> None:
        if msg not in self.warnings:
            self.warnings.append(msg)
            self.log(f"WARNING {msg}")

    def phase(self, name: str) -> None:
        self.log(f"PHASE {name} job={self.job['jobId']}")

    def try_set(self, obj, prop: str, value) -> bool:
        """Set a cosmetic editor property; a missing / renamed property becomes a warning, not a failure."""
        try:
            obj.set_editor_property(prop, value)
            return True
        except Exception as e:  # noqa: BLE001
            self.warn(f"could not set {type(obj).__name__}.{prop}: {str(e)[:160]}")
            return False

    def try_call(self, what: str, fn, *args) -> bool:
        try:
            fn(*args)
            return True
        except Exception as e:  # noqa: BLE001
            self.warn(f"{what} failed: {str(e)[:160]}")
            return False

    def vec(self, v) -> object:
        return self.ue.Vector(float(v[0]), float(v[1]), float(v[2]))

    def rot(self, pitch: float, yaw: float, roll: float = 0.0) -> object:
        return self.ue.Rotator(roll=float(roll), pitch=float(pitch), yaw=float(yaw))

    def color(self, rgb) -> object:
        return self.ue.LinearColor(float(rgb[0]), float(rgb[1]), float(rgb[2]), 1.0)

    def tag(self, actor, tags: list[str], label: str, folder: str) -> None:
        self.try_call("set_actor_label", actor.set_actor_label, label)
        self.try_set(actor, "tags", [self.ue.Name(t) for t in tags])
        if hasattr(actor, "set_folder_path"):
            self.try_call("set_folder_path", actor.set_folder_path, self.ue.Name(folder))

    def tagged(self, tag: str) -> list:
        return [a for a in self.api.actors().get_all_level_actors() if a.actor_has_tag(self.ue.Name(tag))]

    def spawn(self, cls, location=(0, 0, 0), pitch=0.0, yaw=0.0, roll=0.0):
        actor = self.api.actors().spawn_actor_from_class(cls, self.vec(location), self.rot(pitch, yaw, roll))
        if actor is None:
            raise RuntimeError(f"could not spawn {cls}")
        return actor

    def movable(self, actor) -> None:
        try:
            root = actor.get_editor_property("root_component")
        except Exception:  # noqa: BLE001 — not exposed as an editor property in this version
            root = getattr(actor, "root_component", None)
        if root is not None:
            self.try_call("set_mobility", root.set_mobility, self.ue.ComponentMobility.MOVABLE)

    # -- checks
    def check_project(self) -> None:
        cfg = self.api.project_config_dir()
        if not ue_util.is_dedicated_project(cfg):
            raise ProjectError(f"{self.api.project_dir()} is not the dedicated render project (no {ue_util.MARKER_FILE} "
                               f"with {ue_util.MARKER_KEY} in {cfg}) — create one with tools/unreal/ue_project.py init")
        missing = ue_compat.missing_required(self.api.variants)
        if missing:
            raise ue_compat.ApiMissing("required editor APIs missing (enable Python Editor Script Plugin, Editor "
                                       "Scripting Utilities, Sequencer Scripting, Movie Render Queue): "
                                       + ", ".join(missing))
        if self.job["interactive"] and hasattr(self.ue, "EditorLoadingAndSavingUtils"):
            dirty = [p.get_name() for p in self.ue.EditorLoadingAndSavingUtils.get_dirty_map_packages()]
            foreign = [p for p in dirty if not str(p).startswith(ROOT + "/")]
            if foreign:
                raise ProjectError(f"unsaved level(s) {', '.join(foreign[:5])}: save or close them first — the render "
                                   "switches to its own level")

    def ensure_dirs(self) -> None:
        assets = self.api.assets()
        for d in (ROOT, LEVELS, SEQUENCES, PRODUCTS, MATERIALS, SET_MATERIALS, INSTANCES, BAKED):
            if not assets.does_directory_exist(d):
                assets.make_directory(ue_util.own_path(d))

    # -- materials
    def default_linear_texture(self):
        path = f"{MATERIALS}/T_R3D_WhiteLinear"
        assets = self.api.assets()
        if assets.does_asset_exist(path):
            return assets.load_asset(path)
        tex_dir = os.path.join(self.api.project_saved_dir(), "Render3D", "tex")
        os.makedirs(tex_dir, exist_ok=True)
        png = ue_util.solid_png(os.path.join(tex_dir, "T_R3D_WhiteLinear.png"), 4, 4, (255, 255, 255))
        tex = self.import_texture(png, MATERIALS, "T_R3D_WhiteLinear", srgb=False, normal=False)
        return tex

    def import_texture(self, file: str, folder: str, name: str, srgb: bool, normal: bool):
        ue = self.ue
        task = ue.AssetImportTask()
        for k, v in (("filename", file), ("destination_path", ue_util.own_path(folder)), ("destination_name", name),
                     ("replace_existing", True), ("automated", True), ("save", True)):
            task.set_editor_property(k, v)
        self.api.asset_tools().import_asset_tasks([task])
        paths = list(task.get_editor_property("imported_object_paths") or [])
        if not paths:
            raise RuntimeError(f"texture import produced nothing: {file}")
        tex = self.api.assets().load_asset(str(paths[0]))
        self.try_set(tex, "srgb", srgb)
        if normal:
            self.try_set(tex, "compression_settings", ue.TextureCompressionSettings.TC_NORMALMAP)
        self.api.assets().save_loaded_asset(tex)
        return tex

    def parent_material(self, key: str):
        ue = self.ue
        spec = ue_materials.PARENTS[key]
        path = f"{MATERIALS}/{spec['asset']}"
        assets = self.api.assets()
        if assets.does_asset_exist(path):
            return assets.load_asset(path)
        self.log(f"creating parent material {path}")
        mat = self.api.asset_tools().create_asset(spec["asset"], MATERIALS, ue.Material, ue.MaterialFactoryNew())
        mel = ue.MaterialEditingLibrary
        MP = ue.MaterialProperty
        if spec["blend"] == "translucent":
            mat.set_editor_property("blend_mode", ue.BlendMode.BLEND_TRANSLUCENT)
            if hasattr(ue, "TranslucencyLightingMode"):
                self.try_set(mat, "translucency_lighting_mode", ue.TranslucencyLightingMode.TLM_SURFACE)
        if spec["shading"] == "clear_coat":
            mat.set_editor_property("shading_model", ue.MaterialShadingModel.MSM_CLEAR_COAT)
        y = [0]

        def node(cls, x=-600):
            e = mel.create_material_expression(mat, cls, x, y[0])
            y[0] += 160
            return e

        def scalar(name, default):
            e = node(ue.MaterialExpressionScalarParameter)
            e.set_editor_property("parameter_name", name)
            e.set_editor_property("default_value", float(default))
            return e

        def vector(name, rgb):
            e = node(ue.MaterialExpressionVectorParameter)
            e.set_editor_property("parameter_name", name)
            e.set_editor_property("default_value", self.color(rgb))
            return e

        def multiply(a, a_out, b, b_out=""):
            m = node(ue.MaterialExpressionMultiply, -250)
            mel.connect_material_expressions(a, a_out, m, "A")
            mel.connect_material_expressions(b, b_out, m, "B")
            return m

        props = {"Roughness": MP.MP_ROUGHNESS, "Metallic": MP.MP_METALLIC, "Specular": MP.MP_SPECULAR,
                 "Opacity": MP.MP_OPACITY, "ClearCoat": MP.MP_CUSTOM_DATA0, "ClearCoatRoughness": MP.MP_CUSTOM_DATA1}
        if key == "textured":
            samplers = {"color": ue.MaterialSamplerType.SAMPLERTYPE_COLOR,
                        "linear": ue.MaterialSamplerType.SAMPLERTYPE_LINEAR_COLOR,
                        "normal": ue.MaterialSamplerType.SAMPLERTYPE_NORMAL}
            defaults = {"color": assets.load_asset("/Engine/EngineResources/WhiteSquareTexture"),
                        "linear": self.default_linear_texture(),
                        "normal": assets.load_asset("/Engine/EngineMaterials/DefaultNormal")}
            tex = {}
            for name, kind in spec["textures"].items():
                t = node(ue.MaterialExpressionTextureSampleParameter2D, -900)
                t.set_editor_property("parameter_name", name)
                if defaults[kind] is not None:
                    t.set_editor_property("texture", defaults[kind])
                t.set_editor_property("sampler_type", samplers[kind])
                tex[name] = t
            tint = vector("BaseColorTint", spec["vectors"]["BaseColorTint"])
            mel.connect_material_property(multiply(tex["BaseColorMap"], "", tint), "", MP.MP_BASE_COLOR)
            rs = scalar("RoughnessScale", spec["scalars"]["RoughnessScale"])
            mel.connect_material_property(multiply(tex["RoughnessMap"], "R", rs), "", MP.MP_ROUGHNESS)
            ms = scalar("MetallicScale", spec["scalars"]["MetallicScale"])
            mel.connect_material_property(multiply(tex["MetallicMap"], "R", ms), "", MP.MP_METALLIC)
            mel.connect_material_property(tex["NormalMap"], "", MP.MP_NORMAL)
        else:
            base = vector("BaseColor", spec["vectors"]["BaseColor"])
            mel.connect_material_property(base, "", MP.MP_BASE_COLOR)
            for name, default in spec["scalars"].items():
                if name == "EmissiveStrength":
                    continue
                mel.connect_material_property(scalar(name, default), "", props[name])
            if "EmissiveColor" in spec["vectors"]:
                emc = vector("EmissiveColor", spec["vectors"]["EmissiveColor"])
                ems = scalar("EmissiveStrength", spec["scalars"]["EmissiveStrength"])
                mel.connect_material_property(multiply(emc, "", ems), "", MP.MP_EMISSIVE_COLOR)
        mel.recompile_material(mat)
        assets.save_loaded_asset(mat)
        return mat

    def material_instance(self, folder: str, name: str, parent_key: str, scalars: dict, vectors: dict,
                          textures: dict | None = None):
        ue = self.ue
        path = ue_util.own_path(f"{folder}/{name}")
        assets = self.api.assets()
        if assets.does_asset_exist(path):
            return assets.load_asset(path)
        mi = self.api.asset_tools().create_asset(name, folder, ue.MaterialInstanceConstant,
                                                 ue.MaterialInstanceConstantFactoryNew())
        mel = ue.MaterialEditingLibrary
        mel.set_material_instance_parent(mi, self.parent_material(parent_key))
        for k, v in scalars.items():
            mel.set_material_instance_scalar_parameter_value(mi, k, float(v))
        for k, v in vectors.items():
            mel.set_material_instance_vector_parameter_value(mi, k, self.color(v))
        for k, tex in (textures or {}).items():
            mel.set_material_instance_texture_parameter_value(mi, k, tex)
        mel.update_material_instance(mi)
        assets.save_loaded_asset(mi)
        return mi

    def set_material(self, m: dict):
        """Material instance of a set shape (shared by every shape with the same values)."""
        name = "MI_Set_" + hashlib.sha256(json.dumps(m, sort_keys=True).encode()).hexdigest()[:10]
        rgb = hex_linear(m["color"])
        scalars = {"Roughness": m["roughness"], "Metallic": m["metallic"], "Specular": m["specular"],
                   "EmissiveStrength": m["emissive"]}
        vectors = {"BaseColor": rgb, "EmissiveColor": rgb if m["emissive"] > 0 else (0.0, 0.0, 0.0)}
        return self.material_instance(SET_MATERIALS, name, "opaque", scalars, vectors)

    # -- level
    def open_level(self) -> str:
        path = level_path(self.job["template"])
        if self.api.assets().does_asset_exist(path):
            self.log(f"loading level {path}")
            self.api.load_level(path)
        else:
            self.log(f"creating level {path}")
            self.api.new_level(path)
        return path

    # -- product
    def import_product(self) -> list:
        p = self.job["product"]
        if not os.path.isfile(p["path"]):
            raise UeJobError(f"product file not found: {p['path']}")
        sha = ue_util.file_sha256(p["path"])
        if sha != p["sha256"]:
            raise UeJobError("product file changed since the job was written (sha256 mismatch)")
        assets = self.api.assets()
        folder = product_folder(p["assetId"])
        manifest_path = os.path.join(self.api.project_saved_dir(), "Render3D", MANIFEST)
        manifest = load_manifest(manifest_path)
        meshes = self.product_meshes(folder) if assets.does_directory_exist(folder) else []
        tags = []
        for mesh in meshes:
            try:
                tags.append(assets.get_metadata_tag(mesh, SHA_TAG) or None)
            except Exception:  # noqa: BLE001
                tags.append(None)
        need, why = import_decision(manifest["products"].get(p["assetId"]), sha, tags, p["format"])
        self.log(f"product import: {'importing' if need else 'reusing'} — {why}")
        self.info["importSkipped"] = not need
        self.info["assetFolder"] = folder
        self.info["interchangeFbx"] = p["format"] == "fbx" and bool(self.api.cvar_int("Interchange.FeatureFlags.Import.FBX"))
        if not need:
            return meshes
        if assets.does_directory_exist(folder):
            assets.delete_directory(folder)
        assets.make_directory(folder)
        ue = self.ue
        task = ue.AssetImportTask()
        for k, v in (("filename", p["path"]), ("destination_path", folder), ("replace_existing", True),
                     ("automated", True), ("save", True)):
            task.set_editor_property(k, v)
        if p["format"] == "fbx" and hasattr(ue, "FbxImportUI") and not self.info["interchangeFbx"]:
            ui = ue.FbxImportUI()
            for k, v in (("import_mesh", True), ("import_as_skeletal", False), ("import_materials", True),
                         ("import_textures", True), ("import_animations", False), ("create_physics_asset", False)):
                self.try_set(ui, k, v)
            self.try_set(ui, "mesh_type_to_import", ue.FBXImportType.FBXIT_STATIC_MESH)
            smd = ui.get_editor_property("static_mesh_import_data")
            for k, v in (("combine_meshes", True), ("auto_generate_collision", False), ("convert_scene", True),
                         ("force_front_x_axis", True), ("convert_scene_unit", False), ("import_uniform_scale", 1.0),
                         ("generate_lightmap_u_vs", False)):
                self.try_set(smd, k, v)
            if hasattr(ue, "FBXNormalImportMethod"):
                self.try_set(smd, "normal_import_method", ue.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS_AND_TANGENTS)
            task.set_editor_property("options", ui)
        elif p["format"] == "fbx":
            self.warn("FBX is imported through Interchange in this editor: the legacy FBX options (Force Front X "
                      "Axis) do not apply — the front is corrected by yaw instead")
        t0 = time.monotonic()
        self.api.asset_tools().import_asset_tasks([task])
        self.timings["importMs"] = int((time.monotonic() - t0) * 1000)
        meshes = self.product_meshes(folder)
        if not meshes:
            raise RuntimeError(f"the import of {os.path.basename(p['path'])} produced no static mesh "
                               "(skeletal / empty model?)")
        for mesh in meshes:
            assets.set_metadata_tag(mesh, SHA_TAG, sha)
            assets.save_loaded_asset(mesh)
        manifest["products"][p["assetId"]] = {"sha256": sha, "format": p["format"], "folder": folder,
                                              "meshes": len(meshes), "importedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}
        os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
        ue_util.atomic_write_json(manifest_path, manifest)
        return meshes

    def product_meshes(self, folder: str) -> list:
        assets = self.api.assets()
        out = []
        for path in assets.list_assets(folder, True, False):
            obj = assets.load_asset(str(path).split(".")[0])
            if obj is not None and isinstance(obj, self.ue.StaticMesh):
                out.append(obj)
        return sorted(out, key=lambda m: m.get_path_name())

    def place_product(self, meshes: list) -> dict:
        """Pivot (animated) + mesh actors (rotated front → +X, scaled, centred, base on Z 0)."""
        ue = self.ue
        p = self.job["product"]
        for a in self.tagged(TAG_PRODUCT):
            self.api.actors().destroy_actor(a)
        front = ue_math.import_front_yaw(p["format"], self.info.get("interchangeFbx", False)) + p["frontYawDeg"]
        if p["format"] == "glb" and p["frontYawDeg"] == 0.0:
            self.warn("glTF axis conversion of the Interchange importer is not verified for UE 5.8 here: check the "
                      "product faces the camera (set the product's front yaw if not)")
        pivot = self.spawn(ue.StaticMeshActor)
        self.tag(pivot, [TAG_PRODUCT], "R3D_ProductPivot", "Render3D/Product")
        self.movable(pivot)
        actors, bounds = [], []
        for k, mesh in enumerate(meshes):
            a = self.spawn(ue.StaticMeshActor, yaw=front)
            a.static_mesh_component.set_static_mesh(mesh)
            self.tag(a, [TAG_PRODUCT], f"R3D_Product_{k}", "Render3D/Product")
            self.movable(a)
            bounds.append(self.mesh_bounds(mesh, a, front))
            actors.append(a)
        lo, hi = ue_math.union_bounds(bounds)
        measured = (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
        sc = ue_math.normalise_scale(measured, p["dimensionsM"])
        for w in sc["warnings"]:
            self.warn(w)
        s = sc["scale"]
        off = ue_math.placement(lo, hi, s)
        for a in actors:
            a.set_actor_scale3d(ue.Vector(s, s, s))
            a.set_actor_location(self.vec(off), False, True)
            a.attach_to_actor(pivot, ue.Name(), ue.AttachmentRule.KEEP_WORLD, ue.AttachmentRule.KEEP_WORLD,
                              ue.AttachmentRule.KEEP_WORLD, False)
        dims = tuple(round(v * s, 3) for v in measured)
        self.log(f"product placed: measured {measured} cm, scale {s:.4f}, dims {dims} cm, front yaw {front}")
        return {"pivot": pivot, "actors": actors, "meshes": meshes, "dims": dims, "measured": measured, "scale": sc,
                "frontYaw": front}

    def mesh_bounds(self, mesh, actor, yaw: float):
        """World AABB of a mesh at the origin rotated by `yaw`, from the asset's local bounding box."""
        try:
            box = mesh.get_bounding_box()
            lo = (box.min.x, box.min.y, box.min.z)
            hi = (box.max.x, box.max.y, box.max.z)
            return ue_math.rotated_aabb(lo, hi, yaw)
        except Exception:  # noqa: BLE001 — fall back to the component bounds
            origin, extent = actor.get_actor_bounds(False)
            return ((origin.x - extent.x, origin.y - extent.y, origin.z - extent.z),
                    (origin.x + extent.x, origin.y + extent.y, origin.z + extent.z))

    def apply_materials(self, placed: dict) -> dict:
        ue = self.ue
        p = self.job["product"]
        slots: list[str] = []
        per_actor = []
        for a, mesh in zip(placed["actors"], placed["meshes"]):
            names = [str(sm.get_editor_property("material_slot_name")) for sm in mesh.get_editor_property("static_materials")]
            per_actor.append((a, mesh, names))
            slots += [n for n in names if n not in slots]
        plan = ue_materials.plan_materials(slots, p["materialReport"], p["bakedTextures"])
        for w in plan["warnings"]:
            self.warn(w)
        by_slot = {pl["slot"]: pl for pl in plan["plans"]}
        made: dict[str, object] = {}
        rows = []
        for a, mesh, names in per_actor:
            smc = a.static_mesh_component
            for idx, slot in enumerate(names):
                pl = by_slot[slot]
                rows.append({"slot": slot, "material": pl["material"], "status": pl["status"], "action": pl["action"],
                             "parent": pl["parent"]})
                if pl["action"] == "keep":
                    continue
                if slot not in made:
                    vectors = dict(pl["vectors"])
                    if pl["action"] == "instance" and pl["parent"] != "textured" and "BaseColor" not in vectors:
                        imported = mesh.get_material(idx)
                        got = self.imported_base_color(imported)
                        vectors["BaseColor"] = got or ue_materials.NEUTRAL["BaseColor"]
                    textures = {}
                    for param, file in pl["textures"].items():
                        kind = ue_materials.PARENTS["textured"]["textures"][param]
                        textures[param] = self.import_texture(
                            file, f"{BAKED}/{ue_util.safe_asset_name(p['assetId'])}",
                            ue_util.safe_asset_name(f"T_{slot}_{param}"), srgb=kind == "color",
                            normal=kind == "normal")
                    made[slot] = self.material_instance(INSTANCES, ue_materials.instance_name(pl, p["assetId"]),
                                                        pl["parent"], pl["scalars"], vectors, textures)
                smc.set_material(idx, made[slot])
        return {"rows": rows, "hash": plan["hash"]}

    def imported_base_color(self, material):
        """Base colour of an importer-made material instance (Interchange / glTF parents expose one)."""
        ue = self.ue
        if material is None or not isinstance(material, ue.MaterialInstance):
            return None
        for name in ("BaseColor", "Base Color", "BaseColorFactor", "Albedo", "DiffuseColor", "Color"):
            try:
                c = ue.MaterialEditingLibrary.get_material_instance_vector_parameter_value(material, name)
            except Exception:  # noqa: BLE001
                continue
            if c is not None and (c.r, c.g, c.b) != (0.0, 0.0, 0.0):
                return (c.r, c.g, c.b)
        return None

    # -- set
    def build_set(self, dims) -> dict:
        j = self.job
        desc = ue_sets.describe_set(j["template"], j["lighting"]["preset"], j["background"], j["environment"], dims)
        for w in desc["warnings"]:
            self.warn(w)
        key_tag = f"R3D_SETKEY_{desc['key']}"
        existing = self.tagged(TAG_SET)
        want = expected_set_actors(desc)
        if existing and len(existing) == want and all(a.actor_has_tag(self.ue.Name(key_tag)) for a in existing):
            self.log(f"set {desc['name']} reused (key {desc['key']})")
            return {"desc": desc, "rebuilt": False}
        for a in existing:
            self.api.actors().destroy_actor(a)
        self.log(f"building set {desc['name']} (key {desc['key']}, {len(desc['shapes'])} shapes, "
                 f"{len(desc['lights'])} lights)")
        tags = [TAG_SET, key_tag]
        for s in desc["shapes"]:
            self.spawn_shape(s, tags)
        for lt in desc["lights"]:
            self.spawn_light(lt, tags, desc["skyAtmosphere"])
        if desc["fog"]:
            self.spawn_fog(desc["fog"], tags)
        if desc["skyAtmosphere"] and hasattr(self.ue, "SkyAtmosphere"):
            a = self.spawn(self.ue.SkyAtmosphere)
            self.tag(a, tags, "R3D_SkyAtmosphere", "Render3D/Set")
        self.spawn_post(desc["post"], tags)
        return {"desc": desc, "rebuilt": True}

    def spawn_shape(self, s: dict, tags: list[str]) -> None:
        ue = self.ue
        mesh = self.api.assets().load_asset(BASIC_SHAPES + s["mesh"])
        if mesh is None:
            raise ue_compat.ApiMissing(f"engine basic shape {BASIC_SHAPES}{s['mesh']} not found")
        r = s["rotation"]
        a = self.spawn(ue.StaticMeshActor, s["location"], pitch=r[0], yaw=r[1], roll=r[2])
        a.static_mesh_component.set_static_mesh(mesh)
        a.set_actor_scale3d(self.vec(s["scale"]))
        a.static_mesh_component.set_material(0, self.set_material(s["material"]))
        self.tag(a, tags, f"R3D_{s['id']}", "Render3D/Set")

    def spawn_light(self, lt: dict, tags: list[str], atmosphere: bool) -> None:
        ue = self.ue
        cls = {"rect": "RectLight", "spot": "SpotLight", "point": "PointLight", "directional": "DirectionalLight",
               "sky": "SkyLight"}[lt["kind"]]
        a = self.spawn(getattr(ue, cls), lt["location"], pitch=lt["rotation"][0], yaw=lt["rotation"][1])
        comp = a.get_editor_property("light_component")
        self.try_call("set_mobility", comp.set_mobility, ue.ComponentMobility.MOVABLE)
        if lt["kind"] == "sky":
            self.try_set(comp, "source_type", ue.SkyLightSourceType.SLS_CAPTURED_SCENE)
            self.try_set(comp, "real_time_capture", True)
            self.try_call("sky intensity", comp.set_intensity, float(lt["intensity"]))
        else:
            if lt["unit"] == "candelas" and hasattr(ue, "LightUnits"):
                self.try_set(comp, "intensity_units", ue.LightUnits.CANDELAS)
            self.try_call("light intensity", comp.set_intensity, float(lt["intensity"]))
            if lt["color"]:
                self.try_call("light colour", comp.set_light_color, self.color(hex_linear(lt["color"])))
            elif lt["kelvin"]:
                self.try_set(comp, "use_temperature", True)
                self.try_call("light temperature", comp.set_temperature, float(lt["kelvin"]))
            self.try_set(comp, "cast_shadows", bool(lt["castShadows"]))
            if lt["kind"] in ("rect", "spot", "point"):
                self.try_set(comp, "attenuation_radius", float(lt["attenuationCm"]))
            if lt["kind"] == "rect" and "width" in lt:
                self.try_set(comp, "source_width", float(lt["width"]))
                self.try_set(comp, "source_height", float(lt["height"]))
            if lt["kind"] == "spot" and "coneDeg" in lt:
                self.try_set(comp, "outer_cone_angle", float(lt["coneDeg"]) / 2.0)
                self.try_set(comp, "inner_cone_angle", float(lt["coneDeg"]) / 4.0)
            if lt["kind"] == "directional" and atmosphere:
                self.try_set(comp, "atmosphere_sun_light", True)
        self.tag(a, tags, f"R3D_{lt['id']}", "Render3D/Set")

    def spawn_fog(self, fog: dict, tags: list[str]) -> None:
        ue = self.ue
        a = self.spawn(ue.ExponentialHeightFog, (0, 0, -50))
        comp = a.get_editor_property("component")
        self.try_call("fog density", comp.set_fog_density, float(fog["density"]))
        self.try_call("fog falloff", comp.set_fog_height_falloff, float(fog["heightFalloff"]))
        self.try_call("fog colour", comp.set_fog_inscattering_color, self.color(hex_linear(fog["color"])))
        self.try_call("fog start", comp.set_start_distance, float(fog["startCm"]))
        self.try_call("volumetric fog", comp.set_volumetric_fog, bool(fog["volumetric"]))
        self.tag(a, tags, "R3D_Fog", "Render3D/Set")

    def spawn_post(self, post: dict, tags: list[str]) -> None:
        ue = self.ue
        self.info["gi"], gi_warning = ue_mrq.choose_gi(self.job["render"]["gi"], {
            "r.GenerateMeshDistanceFields": self.api.cvar_int("r.GenerateMeshDistanceFields"),
            "r.RayTracing": self.api.cvar_int("r.RayTracing"),
        })
        if gi_warning:
            self.warn(gi_warning)
        a = self.spawn(ue.PostProcessVolume)
        self.try_set(a, "unbound", True)
        st = a.get_editor_property("settings")
        values = [
            ("auto_exposure_method", getattr(ue.AutoExposureMethod, "AEM_MANUAL", None)),
            ("auto_exposure_apply_physical_camera_exposure", False),
            ("auto_exposure_bias", float(post["exposureEv100"])),
            ("bloom_intensity", float(post["bloom"])),
            ("vignette_intensity", float(post["vignette"])),
            ("motion_blur_amount", 0.0),
            ("color_contrast", ue.Vector4(post["contrast"], post["contrast"], post["contrast"], 1.0)),
            ("color_saturation", ue.Vector4(post["saturation"], post["saturation"], post["saturation"], 1.0)),
        ]
        lumen = self.info["gi"] == "lumen"
        if hasattr(ue, "DynamicGlobalIlluminationMethod"):
            values.append(("dynamic_global_illumination_method",
                           ue.DynamicGlobalIlluminationMethod.LUMEN if lumen
                           else ue.DynamicGlobalIlluminationMethod.SCREEN_SPACE))
        if hasattr(ue, "ReflectionMethod"):
            values.append(("reflection_method", ue.ReflectionMethod.LUMEN if lumen else ue.ReflectionMethod.SCREEN_SPACE))
        for prop, value in values:
            if value is None:
                continue
            self.try_set(st, f"override_{prop}", True)
            self.try_set(st, prop, value)
        self.try_set(a, "settings", st)
        self.tag(a, tags, "R3D_PostProcess", "Render3D/Set")

    # -- camera + sequence
    def camera_and_sequence(self, placed: dict, set_info: dict) -> dict:
        ue = self.ue
        j = self.job
        plan = ue_math.camera_plan(j["camera"]["preset"], ue_job.MOVEMENTS[j["camera"]["movement"]], j["turns"],
                                   j["framing"], placed["dims"], self.width, self.height, self.n)
        vol = set_info["desc"].get("cameraVolume")
        if vol:
            lo, hi = vol
            out = [p.frame for p in plan["poses"] if any(not (lo[i] <= p.camera[i] <= hi[i]) for i in range(3))]
            if out:
                self.warn(f"camera leaves the set's open volume on {len(out)} frame(s): walls may block the view")
        for a in self.tagged(TAG_CAMERA):
            self.api.actors().destroy_actor(a)
        p0 = plan["poses"][0]
        cam = self.spawn(ue.CineCameraActor, p0.camera, pitch=p0.pitch, yaw=p0.yaw)
        self.tag(cam, [TAG_CAMERA], "R3D_Camera", "Render3D/Camera")
        comp = cam.get_cine_camera_component()
        lens = plan["lens"]
        fb = comp.get_editor_property("filmback")
        self.try_set(fb, "sensor_width", float(lens.sensor_w_mm))
        self.try_set(fb, "sensor_height", float(lens.sensor_h_mm))
        self.try_set(comp, "filmback", fb)
        ls = comp.get_editor_property("lens_settings")
        self.try_set(ls, "min_focal_length", min(4.0, lens.focal_mm))
        self.try_set(ls, "max_focal_length", max(1000.0, lens.focal_mm))
        self.try_set(comp, "lens_settings", ls)
        self.try_set(comp, "current_focal_length", float(lens.focal_mm))
        self.try_set(comp, "constrain_aspect_ratio", True)
        fstop = set_info["desc"]["camera"].get("fstop")
        if j["camera"]["preset"] == "macro_slide":
            fstop = 4.0
        fs = comp.get_editor_property("focus_settings")
        if fstop:
            self.try_set(comp, "current_aperture", float(fstop))
            self.try_set(fs, "focus_method", ue.CameraFocusMethod.TRACKING)
            tfs = fs.get_editor_property("tracking_focus_settings")
            self.try_set(tfs, "actor_to_track", placed["pivot"])
            self.try_set(tfs, "relative_offset", ue.Vector(0.0, 0.0, placed["dims"][2] * 0.5))
            self.try_set(fs, "tracking_focus_settings", tfs)
        else:
            self.try_set(fs, "focus_method", ue.CameraFocusMethod.DISABLE)
        self.try_set(comp, "focus_settings", fs)

        # level sequence (recreated per job; only this tool's asset)
        assets = self.api.assets()
        spath = sequence_path(j["template"])
        if assets.does_asset_exist(spath):
            assets.delete_asset(spath)
        name = spath.rsplit("/", 1)[-1]
        seq = self.api.asset_tools().create_asset(name, SEQUENCES, ue.LevelSequence, ue.LevelSequenceFactoryNew())
        seq.set_display_rate(ue.FrameRate(j["fps"], 1))
        seq.set_playback_start(0)
        seq.set_playback_end(self.n)
        cam_b = seq.add_possessable(cam)
        piv_b = seq.add_possessable(placed["pivot"])
        cam_ch = self.transform_channels(cam_b)
        piv_ch = self.transform_channels(piv_b)
        add = self.api.add_key
        for ch, v in (("Scale.X", 1.0), ("Scale.Y", 1.0), ("Scale.Z", 1.0), ("Rotation.X", 0.0)):
            add(cam_ch[ch], 0, v)
            add(piv_ch[ch], 0, v)
        for ch in ("Location.X", "Location.Y", "Location.Z", "Rotation.Y"):
            add(piv_ch[ch], 0, 0.0)
        for pose in plan["poses"]:
            f = pose.frame
            add(cam_ch["Location.X"], f, pose.camera[0])
            add(cam_ch["Location.Y"], f, pose.camera[1])
            add(cam_ch["Location.Z"], f, pose.camera[2])
            add(cam_ch["Rotation.Y"], f, pose.pitch)
            add(cam_ch["Rotation.Z"], f, pose.yaw)
            add(piv_ch["Rotation.Z"], f, pose.product_yaw)
        cut_track = self.api.add_track(seq, ue.MovieSceneCameraCutTrack)
        cut = cut_track.add_section()
        self.api.set_section_range(cut, 0, self.n)
        cut.set_camera_binding_id(self.api.binding_id(seq, cam_b))
        assets.save_loaded_asset(seq)
        return {"plan": plan, "sequence": spath, "camera": cam, "fstop": fstop}

    def transform_channels(self, binding) -> dict:
        track = binding.add_track(self.ue.MovieScene3DTransformTrack)
        section = track.add_section()
        self.api.set_section_range(section, 0, self.n)
        chans = self.api.channels(section)
        names = ["Location.X", "Location.Y", "Location.Z", "Rotation.X", "Rotation.Y", "Rotation.Z", "Scale.X",
                 "Scale.Y", "Scale.Z"]
        by_name = {}
        for k, ch in enumerate(chans):
            try:
                n = str(ch.get_name())
            except Exception:  # noqa: BLE001
                n = names[k] if k < len(names) else f"ch{k}"
            by_name[n] = ch
        if not all(n in by_name for n in names):
            by_name = {names[k]: ch for k, ch in enumerate(chans[:9])}
        if len(by_name) < 9:
            raise ue_compat.ApiMissing("transform section has fewer than 9 channels")
        return by_name

    # -- Movie Render Queue
    def soft_path(self, path: str):
        ue = self.ue
        try:
            return ue.SoftObjectPath(path)
        except Exception:  # noqa: BLE001 — struct without a string constructor in this version
            sp = ue.SoftObjectPath()
            sp.set_editor_property("asset_path_name", path)
            self.api.used["softObjectPath"] = "asset_path_name"
            return sp

    def configure_queue(self, level: str, seq: str) -> dict:
        ue = self.ue
        j = self.job
        settings = ue_mrq.mrq_settings(j["quality"], j["render"], self.width, self.height, j["fps"], self.frames_dir,
                                       self.info.get("gi", "screen_space"))
        qs = ue.get_editor_subsystem(ue.MoviePipelineQueueSubsystem)
        queue = qs.get_queue()
        if hasattr(queue, "delete_all_jobs"):
            queue.delete_all_jobs()
        else:
            for old in list(queue.get_jobs()):
                queue.delete_job(old)
        mjob = queue.allocate_new_job(ue.MoviePipelineExecutorJob)
        mjob.set_editor_property("job_name", j["jobId"])
        mjob.set_editor_property("map", self.soft_path(object_path(level)))
        mjob.set_editor_property("sequence", self.soft_path(object_path(seq)))
        cfg = mjob.get_configuration()
        self.info["configClass"] = type(cfg).__name__
        out = cfg.find_or_add_setting_by_class(ue.MoviePipelineOutputSetting)
        out.set_editor_property("output_directory", ue.DirectoryPath(path=self.frames_dir))
        out.set_editor_property("file_name_format", settings["fileNameFormat"])
        out.set_editor_property("output_resolution", ue.IntPoint(self.width, self.height))
        self.try_set(out, "use_custom_frame_rate", True)
        self.try_set(out, "output_frame_rate", ue.FrameRate(j["fps"], 1))
        self.try_set(out, "override_existing_output", True)
        self.try_set(out, "zero_pad_frame_numbers", settings["zeroPad"])
        self.try_set(out, "frame_number_offset", settings["frameNumberOffset"])
        cfg.find_or_add_setting_by_class(ue.MoviePipelineDeferredPassBase)
        png = cfg.find_or_add_setting_by_class(ue.MoviePipelineImageSequenceOutput_PNG)
        self.try_set(png, "write_alpha", settings["png"]["writeAlpha"])
        if hasattr(ue, "MoviePipelineAntiAliasingSetting"):
            aa = cfg.find_or_add_setting_by_class(ue.MoviePipelineAntiAliasingSetting)
            self.try_set(aa, "spatial_sample_count", settings["spatialSamples"])
            self.try_set(aa, "temporal_sample_count", settings["temporalSamples"])
            self.try_set(aa, "render_warm_up_count", settings["warmUpFrames"])
            self.try_set(aa, "engine_warm_up_count", settings["warmUpFrames"])
            self.try_set(aa, "render_warm_up_frames", True)
            if settings["antiAliasing"] == "none":
                self.try_set(aa, "override_anti_aliasing", True)
                self.try_set(aa, "anti_aliasing_method", ue.AntiAliasingMethod.AAM_NONE)
        if hasattr(ue, "MoviePipelineConsoleVariableSetting"):
            cv = cfg.find_or_add_setting_by_class(ue.MoviePipelineConsoleVariableSetting)
            for name, value in settings["cvars"].items():
                if hasattr(cv, "add_or_update_console_variable"):
                    self.try_call(f"cvar {name}", cv.add_or_update_console_variable, name, float(value))
                else:
                    self.warn("console variables not applied (no add_or_update_console_variable)")
                    break
        if hasattr(ue, "MoviePipelineGameOverrideSetting"):
            go = cfg.find_or_add_setting_by_class(ue.MoviePipelineGameOverrideSetting)
            self.try_set(go, "cinematic_quality_settings", True)
            self.try_set(go, "use_lod_zero", True)
            self.try_set(go, "disable_hlods", True)
            if hasattr(ue, "MoviePipelineTextureStreamingMethod"):
                self.try_set(go, "texture_streaming", ue.MoviePipelineTextureStreamingMethod.DISABLED)
        self.queue_subsystem = qs
        return settings

    def setup(self) -> None:
        t0 = time.monotonic()
        j = self.job
        if j["actions"]:
            self.warn("product actions are not animated by the UE adapter (no rig): rendered without them")
        if j["focus"]:
            self.warn(f"focus part {j['focus']!r} ignored: the UE adapter frames the whole product")
        self.phase("check")
        self.check_project()
        os.makedirs(self.frames_dir, exist_ok=True)
        for name in os.listdir(self.frames_dir):  # a previous attempt's frames never mix with this render
            if ue_util.FRAME_RE.match(name):
                os.remove(os.path.join(self.frames_dir, name))
        self.ensure_dirs()
        self.phase("level")
        level = self.open_level()
        self.phase("import")
        meshes = self.import_product()
        self.phase("place")
        placed = self.place_product(meshes)
        mats = self.apply_materials(placed)
        self.phase("set")
        set_info = self.build_set(placed["dims"])
        self.phase("sequence")
        cs = self.camera_and_sequence(placed, set_info)
        self.api.save_current_level()
        self.api.assets().save_directory(ROOT, True, True)
        self.phase("queue")
        mrq = self.configure_queue(level, cs["sequence"])
        self.state = {"level": level, "placed": placed, "materials": mats, "set": set_info, "cs": cs, "mrq": mrq}
        self.timings["setupMs"] = int((time.monotonic() - t0) * 1000)

    def start_render(self) -> None:
        self.phase("render")
        self.render_started = time.monotonic()
        self.render_wall_start = time.time()
        self.executor = self.api.render_queue(self.queue_subsystem, self.job["render"]["executor"])
        ex = self.executor
        if hasattr(ex, "on_executor_finished_delegate"):
            ex.on_executor_finished_delegate.add_callable_unique(self._on_finished)
        if hasattr(ex, "on_executor_errored_delegate"):
            ex.on_executor_errored_delegate.add_callable_unique(self._on_errored)
        self.log(f"render started: {self.n} frames {self.width}x{self.height} via {self.job['render']['executor']}")

    def _on_finished(self, executor, success) -> None:
        self.finished = bool(success)

    def _on_errored(self, executor, pipeline, is_fatal, error_text) -> None:
        self.errors.append(str(error_text)[:1000])
        if is_fatal:
            self.finished = False

    def poll(self) -> bool:
        """Progress line when the frame count changes; True when the render is over (either way)."""
        now = time.monotonic()
        if now - self.last_poll >= 0.5 or self.finished is not None:
            self.last_poll = now
            scan = ue_util.scan_frames(self.frames_dir)
            if scan["count"] != self.last_count:
                self.last_count = scan["count"]
                print(f"PROGRESS job={self.job['jobId']} frame={min(scan['count'], self.n)}/{self.n}", flush=True)
        if now - self.render_started > self.job["render"]["maxRenderSec"]:
            self.errors.append(f"render exceeded {self.job['render']['maxRenderSec']:.0f} s")
            self.finished = False
        return self.finished is not None

    def result(self) -> dict:
        self.timings["renderMs"] = int((time.monotonic() - self.render_started) * 1000)
        if not self.finished:
            raise RenderError("Movie Render Queue failed: " + ("; ".join(self.errors) or "executor reported failure"))
        scan = ue_util.scan_frames(self.frames_dir)
        if scan["count"] != self.n or not scan["contiguous"] or scan["start"] not in (0, 1):
            raise RenderError(f"expected {self.n} contiguous frames f_0001.png…, found {scan['count']} "
                              f"(start {scan['start']}, contiguous {scan['contiguous']})")
        st = self.state
        plan = st["cs"]["plan"]
        placed = st["placed"]
        sc = placed["scale"]
        frame_ms = ue_util.frame_ms_from_mtimes(scan["numbers"], scan["mtimes"], self.render_wall_start)
        self.timings["frameMs"] = frame_ms
        self.timings["totalMs"] = int((time.monotonic() - self.t_all) * 1000)
        p = self.job["product"]
        return {
            "ok": True,
            # a run through tools/unreal/fake_unreal.py (unit tests) is labelled mock — never a real render
            "mock": bool(getattr(self.ue, "IS_FAKE_UNREAL", False)),
            "sceneVersion": SCENE_VERSION,
            "jobId": self.job["jobId"],
            "template": self.job["template"],
            "unreal": {"version": self.api.engine_version(), "executor": self.job["render"]["executor"],
                       "configClass": self.info.get("configClass", "unknown"), "gi": self.info.get("gi", "screen_space"),
                       "apiVariants": {**{k: v for k, v in self.api.variants.items() if v}, **self.api.used}},
            "device": {"device": "GPU", "name": None},
            "frames": {"dir": "frames", "pattern": ue_mrq.FRAME_PATTERN, "startNumber": scan["start"],
                       "count": scan["count"], "width": self.width, "height": self.height, "fps": self.job["fps"],
                       "alpha": False},
            "product": {"assetId": p["assetId"], "assetPath": self.info["assetFolder"],
                        "sourceSha256": p["sha256"], "importSkipped": self.info["importSkipped"],
                        "format": p["format"], "frontYawDeg": placed["frontYaw"],
                        "measuredCm": [round(v, 3) for v in placed["measured"]], "dimsCm": list(placed["dims"]),
                        "expectedCm": sc["expectedCm"], "scaleApplied": round(sc["scale"], 6),
                        "mismatchPct": sc["mismatchPct"], "unitCorrection": sc["unitCorrection"],
                        "heightM": round(placed["dims"][2] / 100.0, 5), "materialHash": st["materials"]["hash"]},
            "set": {"name": st["set"]["desc"]["name"], "key": st["set"]["desc"]["key"],
                    "rebuilt": st["set"]["rebuilt"], "lighting": self.job["lighting"]["preset"],
                    "fstop": st["cs"]["fstop"], "level": st["level"]},
            "sequence": st["cs"]["sequence"],
            "productBoxes": plan["productBoxes"],
            "anchorTracks": plan["anchorTracks"],
            "camera": {"preset": plan["preset"], "lensMm": plan["lensMm"], "distanceCm": plan["distanceCm"],
                       "sensorMm": [round(plan["lens"].sensor_w_mm, 4), round(plan["lens"].sensor_h_mm, 4)],
                       "fill": plan["fill"], "centerY": plan["centerY"], "aimOffsetDeg": plan["aimOffsetDeg"],
                       "track": poses_track(plan["poses"], self.n // 30)},
            "controlViews": [],
            "materials": st["materials"]["rows"],
            "materialReport": p["materialReport"],
            "mrq": st["mrq"],
            "warnings": self.warnings,
            "timings": self.timings,
            "log": LOG,
        }


# ----------------------------------------------------------------------------------------- driver ----


class Driver:
    """Steps a SceneRun over editor ticks: wait until the editor is idle → setup → render → finish → quit."""

    WAIT_TICKS = 10

    def __init__(self, run: SceneRun, interactive: bool, finish):
        self.run = run
        self.interactive = interactive
        self.finish = finish
        self.ticks = 0
        self.state = "wait"
        self.handle = run.ue.register_slate_post_tick_callback(self.tick)

    def ready(self) -> bool:
        ue = self.run.ue
        try:
            if hasattr(ue, "AssetRegistryHelpers") and ue.AssetRegistryHelpers.get_asset_registry().is_loading_assets():
                return False
        except Exception:  # noqa: BLE001
            pass
        return self.run.api.editor_world() is not None

    def tick(self, _dt: float) -> None:
        try:
            self.ticks += 1
            if self.state == "wait":
                if self.ticks >= self.WAIT_TICKS and self.ready():
                    self.state = "setup"
            elif self.state == "setup":
                self.run.setup()
                if self.run.job["render"]["setupOnly"]:
                    self.done(None, setup_only=True)
                    return
                self.run.start_render()
                self.state = "render"
            elif self.state == "render":
                if self.run.poll():
                    self.done(self.run.result())
        except Exception as e:  # noqa: BLE001 — every failure ends the run with a result file
            self.done(None, error=e)

    def done(self, result, error: BaseException | None = None, setup_only: bool = False) -> None:
        self.state = "done"
        try:
            self.run.ue.unregister_slate_post_tick_callback(self.handle)
        except Exception:  # noqa: BLE001
            pass
        self.finish(self.run, result, error, setup_only)


_ACTIVE: list = []  # keeps the driver (and its delegates) alive while the editor ticks


def write_failure(out_dir: str | None, job_id: str | None, exc: BaseException, log, warnings, timings) -> int:
    code, kind = classify(exc)
    msg = str(exc) or type(exc).__name__
    if log:
        log(f"FAILED {kind}: {msg}")
        if kind == "error":
            log(traceback.format_exc())
    if out_dir and os.path.isdir(out_dir):
        try:
            ue_util.atomic_write_json(os.path.join(out_dir, RESULT),
                                      failure_doc(job_id, code, kind, msg, warnings, timings))
        except OSError:
            pass
    ue_util.eprint(json.dumps({"ok": False, "error": kind, "message": msg[:2000]}))
    return code


def finish(run: SceneRun, result, error, setup_only: bool) -> None:
    code = EXIT_OK
    if error is not None:
        code = write_failure(run.out_dir, run.job["jobId"], error, run.log, run.warnings, run.timings)
    elif setup_only:
        ue_util.atomic_write_json(os.path.join(run.out_dir, "setup.json"),
                                  {"ok": True, "jobId": run.job["jobId"], "level": run.state["level"],
                                   "sequence": run.state["cs"]["sequence"], "warnings": run.warnings})
        run.log("SETUP_DONE")
    else:
        path = os.path.join(run.out_dir, RESULT)
        ue_util.atomic_write_json(path, result)
        run.log(f"RESULT {path}")
    run.log.close()
    if run.job["interactive"]:
        return  # never close the user's editor
    exit_editor(run.ue, code)


def exit_editor(ue, code: int) -> None:
    sys.stdout.flush()
    sys.stderr.flush()
    if code == EXIT_OK and ue is not None:
        try:
            ue.SystemLibrary.quit_editor()
            return
        except Exception:  # noqa: BLE001
            pass
    os._exit(code)  # a non-zero status for the adapter; everything is on disk already


def main(argv: list[str], environ=os.environ) -> int:
    """Entry: validate, then hand the run to the tick driver (returns at once inside the editor).

    An invalid job writes nothing (its output dir is not trusted): the reason goes to stderr, exit code 3."""
    print(f"R3D_STARTED script=ue_scene pid={os.getpid()}", flush=True)
    try:
        path = ue_job.job_path_from(argv, environ)
        with open(path, encoding="utf-8") as fh:
            job = ue_job.validate_job(json.load(fh))
    except (OSError, ValueError) as e:
        return write_failure(None, None, e if isinstance(e, UeJobError) else UeJobError(str(e)), None, [], {})
    if "--no-exit" in argv:  # remote execution into a running editor: never close it
        job["interactive"] = True
    os.makedirs(job["output"]["dir"], exist_ok=True)
    log = ue_util.Log(os.path.join(job["output"]["dir"], LOG))
    log(f"R3D_JOB job={job['jobId']} template={job['template']} quality={job['quality']}")
    try:
        api = ue_compat.Api()
    except ue_compat.ApiMissing as e:
        return write_failure(job["output"]["dir"], job["jobId"], e, log, [], {})
    run = SceneRun(job, log, api)
    if job["render"]["setupOnly"]:  # synchronous: also works in the PythonScript commandlet (no editor tick)
        try:
            run.setup()
        except Exception as e:  # noqa: BLE001
            return write_failure(run.out_dir, job["jobId"], e, log, run.warnings, run.timings)
        finish(run, None, None, True)
        return EXIT_OK
    if not hasattr(api.ue, "register_slate_post_tick_callback"):
        e = ue_compat.ApiMissing("no editor tick (register_slate_post_tick_callback): run through "
                                 "-ExecutePythonScript in the editor, not the PythonScript commandlet")
        return write_failure(job["output"]["dir"], job["jobId"], e, log, [], {})
    _ACTIVE.append(Driver(run, job["interactive"], finish))
    log("waiting for the editor to become idle")
    return EXIT_OK


# run as a script: `python ue_scene.py`, runpy (remote execution) or the editor's -ExecutePythonScript (whatever
# module name its file runner uses) — but not when imported by the unit tests / fake_unreal.py
if __name__ == "__main__" or __name__ not in ("ue_scene",):
    _code = main(sys.argv)
    if _code != EXIT_OK and "--no-exit" not in sys.argv:
        exit_editor(unreal, _code)
