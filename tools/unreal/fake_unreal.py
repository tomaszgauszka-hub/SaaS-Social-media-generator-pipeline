"""FAKE `unreal` module for unit tests — NOT Unreal Engine, renders nothing.

It implements just the editor API surface tools/unreal/ue_scene.py calls (asset registry, actors, levels, import,
materials, Level Sequence, Movie Render Queue, editor tick) with in-memory objects, so the editor-side glue code runs
end to end under plain CPython. Its Movie Render Queue writes flat-colour PNG files named from the job's MRQ output
settings — enough to prove the settings and the result.json writer fit together; it says nothing about how a real
UE 5.8 behaves (that needs the diagnostics on a real install).

    python3 -I fake_unreal.py <job.json>     run one job through ue_scene.py with this fake (prints the result path)
"""

from __future__ import annotations

import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))

#: imported product bounds (cm, local) and material slots of the FAKE importer
PRODUCT_BOUNDS = ((-10.0, -4.0, 0.0), (10.0, 4.0, 25.0))
PRODUCT_SLOTS = ("Body", "Glass")


class Name(str):
    pass


class Vector:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = float(x), float(y), float(z)


class Vector4(Vector):
    def __init__(self, x=0.0, y=0.0, z=0.0, w=0.0):
        super().__init__(x, y, z)
        self.w = float(w)


class Rotator:
    def __init__(self, roll=0.0, pitch=0.0, yaw=0.0):
        self.roll, self.pitch, self.yaw = float(roll), float(pitch), float(yaw)


class LinearColor:
    def __init__(self, r=0.0, g=0.0, b=0.0, a=1.0):
        self.r, self.g, self.b, self.a = r, g, b, a


class IntPoint:
    def __init__(self, x=0, y=0):
        self.x, self.y = x, y


class FrameRate:
    def __init__(self, numerator=30, denominator=1):
        self.numerator, self.denominator = numerator, denominator


class FrameNumber:
    def __init__(self, value=0):
        self.value = value


class DirectoryPath:
    def __init__(self, path=""):
        self.path = path


class SoftObjectPath:
    def __init__(self, path=""):
        self.path = path


class Enum:
    """Any member name is a token (e.g. ComponentMobility.MOVABLE == 'MOVABLE')."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return name


class Obj:
    """Permissive editor object: editor properties in a dict, any other attribute a recording callable Obj."""

    def __init__(self, *args, **kwargs):
        self.__dict__["_props"] = dict(kwargs)
        self.__dict__["calls"] = []
        self.__dict__["_args"] = args

    def set_editor_property(self, name, value):
        self._props[name] = value

    def get_editor_property(self, name):
        if name not in self._props:
            self._props[name] = Obj()
        return self._props[name]

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        child = Obj()
        self.__dict__[name] = child
        return child

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return Obj()


class Delegate:
    def __init__(self):
        self.fns = []

    def add_callable_unique(self, fn):
        if fn not in self.fns:
            self.fns.append(fn)

    add_callable = add_callable_unique

    def broadcast(self, *args):
        for fn in list(self.fns):
            fn(*args)


class Actor(Obj):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.__dict__["label"] = ""
        self.__dict__["location"] = Vector()
        self.__dict__["rotation"] = Rotator()
        self.__dict__["scale"] = Vector(1, 1, 1)
        self.__dict__["parent"] = None
        self._props["tags"] = []

    def set_actor_label(self, label):
        self.__dict__["label"] = label

    def actor_has_tag(self, tag):
        return str(tag) in [str(t) for t in self._props.get("tags", [])]

    def set_actor_scale3d(self, v):
        self.__dict__["scale"] = v

    def set_actor_location(self, v, sweep=False, teleport=False):
        self.__dict__["location"] = v
        return True, None

    def attach_to_actor(self, parent, socket, a, b, c, weld):
        self.__dict__["parent"] = parent

    def get_actor_bounds(self, only_colliding=False):
        return Vector(), Vector(50, 50, 50)


class StaticMeshActor(Actor):
    pass


class CineCameraActor(Actor):
    def get_cine_camera_component(self):
        return self.get_editor_property("cine_camera_component")


class StaticMaterial(Obj):
    pass


class StaticMesh(Obj):
    def __init__(self, path="", *a, **k):
        super().__init__(*a, **k)
        self.__dict__["path"] = path
        self._props["static_materials"] = [StaticMaterial(material_slot_name=Name(s)) for s in PRODUCT_SLOTS]

    def get_path_name(self):
        return self.path

    def get_bounding_box(self):
        lo, hi = PRODUCT_BOUNDS
        return types.SimpleNamespace(min=Vector(*lo), max=Vector(*hi))

    def get_material(self, index):
        return Obj()


class Texture2D(Obj):
    pass


class Material(Obj):
    pass


class MaterialInstance(Obj):
    pass


class MaterialInstanceConstant(MaterialInstance):
    pass


class Channel:
    def __init__(self, name):
        self.name = name
        self.keys: list[tuple[int, float]] = []

    def get_name(self):
        return self.name

    def add_key(self, time, value, sub_frame=0.0, time_unit=None, interpolation=None):
        self.keys.append((time.value, value))


CHANNELS = ("Location.X", "Location.Y", "Location.Z", "Rotation.X", "Rotation.Y", "Rotation.Z", "Scale.X", "Scale.Y",
            "Scale.Z")


class MovieSceneSection(Obj):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.__dict__["channels"] = [Channel(n) for n in CHANNELS]
        self.__dict__["range"] = None

    def get_all_channels(self):
        return list(self.channels)

    def set_range(self, start, end):
        self.__dict__["range"] = (start, end)

    def set_camera_binding_id(self, binding_id):
        self.__dict__["camera"] = binding_id


class Track(Obj):
    def __init__(self, cls=None):
        super().__init__()
        self.__dict__["cls"] = cls
        self.__dict__["sections"] = []

    def add_section(self):
        s = MovieSceneSection()
        self.sections.append(s)
        return s


class Binding(Obj):
    def __init__(self, actor):
        super().__init__()
        self.__dict__["actor"] = actor
        self.__dict__["tracks"] = []

    def add_track(self, cls):
        t = Track(cls)
        self.tracks.append(t)
        return t


class MovieSceneSequence(Obj):
    def add_track(self, cls):
        t = Track(cls)
        self.__dict__.setdefault("tracks", []).append(t)
        return t

    def get_portable_binding_id(self, root, binding):
        return ("binding", id(binding))

    def get_binding_id(self, binding):
        return ("binding", id(binding))


class LevelSequence(MovieSceneSequence):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.__dict__["bindings"] = []
        self.__dict__["playback"] = [0, 0]

    def set_display_rate(self, rate):
        self.__dict__["rate"] = rate

    def set_playback_start(self, f):
        self.playback[0] = f

    def set_playback_end(self, f):
        self.playback[1] = f

    def add_possessable(self, actor):
        b = Binding(actor)
        self.bindings.append(b)
        return b


class Executor(Obj):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.__dict__["on_executor_finished_delegate"] = Delegate()
        self.__dict__["on_executor_errored_delegate"] = Delegate()


class MoviePipelinePIEExecutor(Executor):
    pass


class MoviePipelineNewProcessExecutor(Executor):
    pass


class Config(Obj):
    def __init__(self):
        super().__init__()
        self.__dict__["settings"] = {}

    def find_or_add_setting_by_class(self, cls):
        if cls not in self.settings:
            self.settings[cls] = cls()
        return self.settings[cls]


class MoviePipelinePrimaryConfig(Config):
    pass


class MoviePipelineExecutorJob(Obj):
    def __init__(self):
        super().__init__()
        self.__dict__["config"] = MoviePipelinePrimaryConfig()

    def get_configuration(self):
        return self.config


class Queue(Obj):
    def __init__(self):
        super().__init__()
        self.__dict__["jobs"] = []

    def delete_all_jobs(self):
        self.jobs.clear()

    def allocate_new_job(self, cls):
        j = cls()
        self.jobs.append(j)
        return j


class MoviePipelineQueueSubsystem(Obj):
    def __init__(self):
        super().__init__()
        self.__dict__["queue"] = Queue()
        self.__dict__["executor"] = None

    def get_queue(self):
        return self.queue

    def render_queue_with_executor_instance(self, executor):
        self.__dict__["executor"] = executor

    def render_queue_with_executor(self, cls):
        self.__dict__["executor"] = cls()
        return self.executor


class EditorActorSubsystem(Obj):
    def __init__(self, fake):
        super().__init__()
        self.__dict__["fake"] = fake

    def spawn_actor_from_class(self, cls, location, rotation=None, transient=False):
        a = cls()
        a.__dict__["location"] = location
        a.__dict__["rotation"] = rotation
        self.fake.level_actors().append(a)
        return a

    def get_all_level_actors(self):
        return list(self.fake.level_actors())

    def destroy_actor(self, actor):
        self.fake.level_actors().remove(actor)
        return True


class LevelEditorSubsystem(Obj):
    def __init__(self, fake):
        super().__init__()
        self.__dict__["fake"] = fake

    def new_level(self, path, partitioned=False):
        self.fake.assets[path] = Obj()
        self.fake.levels[path] = []
        self.fake.current_level = path
        return True

    def load_level(self, path):
        self.fake.current_level = path
        return True

    def save_current_level(self):
        return True


class UnrealEditorSubsystem(Obj):
    def get_editor_world(self):
        return Obj()


class FakeUnreal(types.ModuleType):
    """The module object: explicit classes above + auto-made classes for any other CamelCase name."""

    IS_FAKE_UNREAL = True  # ue_scene.py marks results of this module "mock": true

    def __init__(self, project_dir: str):
        super().__init__("unreal")
        self.project_dir = project_dir
        self.assets: dict[str, object] = {}
        self.folders: set[str] = set()
        self.tags: dict[int, dict[str, str]] = {}
        self.levels: dict[str, list] = {}
        self.current_level: str | None = None
        self.ticks: list = []
        self.quit_called = 0
        self.cvars = {"r.GenerateMeshDistanceFields": 1, "r.RayTracing": 0, "Interchange.FeatureFlags.Import.FBX": 0}
        self._subsystems: dict = {}
        for k, v in list(globals().items()):
            if isinstance(v, type) and k not in ("FakeUnreal",):
                setattr(self, k, v)
        enums = ("ComponentMobility", "AttachmentRule", "MaterialProperty", "BlendMode", "MaterialShadingModel",
                 "TranslucencyLightingMode", "MaterialSamplerType", "TextureCompressionSettings", "FBXImportType",
                 "FBXNormalImportMethod", "SkyLightSourceType", "LightUnits", "AutoExposureMethod",
                 "DynamicGlobalIlluminationMethod", "ReflectionMethod", "CameraFocusMethod", "MovieSceneTimeUnit",
                 "MovieSceneKeyInterpolation", "AntiAliasingMethod", "MoviePipelineTextureStreamingMethod",
                 "MovieSceneObjectBindingSpace")
        for e in enums:
            setattr(self, e, Enum())
        fake = self
        self.EditorAssetLibrary = types.SimpleNamespace(
            does_asset_exist=lambda p: p in fake.assets,
            does_directory_exist=lambda p: p in fake.folders,
            make_directory=lambda p: fake.folders.add(p) or True,
            delete_directory=fake._delete_directory,
            delete_asset=lambda p: fake.assets.pop(p, None) is not None,
            list_assets=lambda folder, recursive=True, include_folder=False: [
                f"{k}.{k.rsplit('/', 1)[-1]}" for k in fake.assets if k.startswith(folder + "/")],
            load_asset=lambda p: fake.assets.get(p.split(".")[0]) if not p.startswith("/Engine/") else Obj(),
            save_loaded_asset=lambda a: True,
            save_directory=lambda p, only_dirty=True, recursive=True: True,
            set_metadata_tag=lambda a, k, v: fake.tags.setdefault(id(a), {}).__setitem__(k, v),
            get_metadata_tag=lambda a, k: fake.tags.get(id(a), {}).get(k, ""),
        )
        self.AssetToolsHelpers = types.SimpleNamespace(get_asset_tools=lambda: fake._tools)
        self._tools = types.SimpleNamespace(create_asset=self._create_asset, import_asset_tasks=self._import)
        self.AssetRegistryHelpers = types.SimpleNamespace(
            get_asset_registry=lambda: types.SimpleNamespace(is_loading_assets=lambda: False))
        self.EditorLoadingAndSavingUtils = types.SimpleNamespace(get_dirty_map_packages=lambda: [])
        self.SystemLibrary = types.SimpleNamespace(
            get_console_variable_int_value=lambda n: fake.cvars.get(n, 0),
            get_engine_version=lambda: "5.8.0-FAKE+++UE5+Release-5.8",
            quit_editor=fake._quit,
        )
        self.Paths = types.SimpleNamespace(
            project_dir=lambda: fake.project_dir + os.sep,
            project_config_dir=lambda: os.path.join(fake.project_dir, "Config") + os.sep,
            project_saved_dir=lambda: os.path.join(fake.project_dir, "Saved") + os.sep,
            convert_relative_path_to_full=lambda p: p,
            get_project_file_path=lambda: os.path.join(fake.project_dir, "Render3D.uproject"),
        )
        self.MaterialEditingLibrary = Obj()
        self.MaterialEditingLibrary.__dict__["get_material_instance_vector_parameter_value"] = \
            lambda mi, name: LinearColor(0, 0, 0)

    def __getattr__(self, name):
        if name[:1].isupper():
            base = Actor if name.endswith(("Light", "Actor", "Volume", "Fog", "Atmosphere")) else Obj
            cls = type(name, (base,), {})
            setattr(self, name, cls)
            return cls
        raise AttributeError(name)

    # -- module functions
    def get_editor_subsystem(self, cls):
        if cls not in self._subsystems:
            self._subsystems[cls] = cls(self) if cls in (EditorActorSubsystem, LevelEditorSubsystem) else cls()
        return self._subsystems[cls]

    def new_object(self, cls, outer=None, name=None):
        return cls()

    def register_slate_post_tick_callback(self, fn):
        self.ticks.append(fn)
        return len(self.ticks)

    def unregister_slate_post_tick_callback(self, handle):
        self.ticks[handle - 1] = None

    def tick(self, n: int = 1) -> None:
        for _ in range(n):
            for fn in list(self.ticks):
                if fn:
                    fn(0.016)
            self._mrq_step()

    def _quit(self):
        self.quit_called += 1

    def level_actors(self) -> list:
        return self.levels.setdefault(self.current_level or "", [])

    # -- assets
    def _delete_directory(self, folder):
        for k in [k for k in self.assets if k.startswith(folder + "/")]:
            del self.assets[k]
        self.folders.discard(folder)
        return True

    def _create_asset(self, name, folder, cls, factory):
        a = cls()
        self.assets[f"{folder}/{name}"] = a
        return a

    def _import(self, tasks):
        for t in tasks:
            fn = t.get_editor_property("filename")
            dest = t.get_editor_property("destination_path")
            ext = os.path.splitext(fn)[1].lower()
            if ext in (".fbx", ".glb"):
                path = f"{dest}/SM_{os.path.splitext(os.path.basename(fn))[0]}"
                self.assets[path] = StaticMesh(path)
            else:
                name = t._props.get("destination_name") or os.path.splitext(os.path.basename(fn))[0]
                path = f"{dest}/{name}"
                self.assets[path] = Texture2D()
            t.set_editor_property("imported_object_paths", [f"{path}.{path.rsplit('/', 1)[-1]}"])

    # -- Movie Render Queue: frames named from the output settings, then the finished delegate
    def _mrq_step(self):
        qs = self._subsystems.get(MoviePipelineQueueSubsystem)
        ex = qs.executor if qs else None
        if ex is None or ex.__dict__.get("done"):
            return
        from ue_util import solid_png  # noqa: PLC0415

        job = qs.queue.jobs[0]
        out = job.config.find_or_add_setting_by_class(self.MoviePipelineOutputSetting)
        seq_path = job.get_editor_property("sequence").path.split(".")[0]
        seq = self.assets[seq_path]
        res = out.get_editor_property("output_resolution")
        frames_dir = out.get_editor_property("output_directory").path
        fmt = out.get_editor_property("file_name_format")
        pad = out._props.get("zero_pad_frame_numbers", 0)
        offset = out._props.get("frame_number_offset", 0)
        os.makedirs(frames_dir, exist_ok=True)
        for f in range(seq.playback[0], seq.playback[1]):
            name = fmt.replace("{frame_number}", str(f + offset).zfill(pad)) + ".png"
            solid_png(os.path.join(frames_dir, name), res.x, res.y, (40, 40, 44))
        ex.__dict__["done"] = True
        ex.on_executor_finished_delegate.broadcast(ex, True)


def install(project_dir: str) -> FakeUnreal:
    """Make `import unreal` return a FAKE module for project_dir (also patches the already-imported tools)."""
    fake = FakeUnreal(project_dir)
    sys.modules["unreal"] = fake
    for mod in ("ue_compat", "ue_scene"):
        if mod in sys.modules:
            sys.modules[mod].unreal = fake
    return fake


def run_job(job_path: str, project_dir: str, max_ticks: int = 50) -> FakeUnreal:
    """Drive one job through ue_scene.main + the tick driver with the FAKE editor (exits are recorded, not taken)."""
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    fake = install(project_dir)
    import ue_scene  # noqa: PLC0415

    exits: list[int] = []
    ue_scene.exit_editor = lambda ue, code: exits.append(code)
    fake.__dict__["exits"] = exits
    code = ue_scene.main(["ue_scene.py", job_path], {})
    fake.__dict__["main_code"] = code
    for _ in range(max_ticks):
        if exits:
            break
        fake.tick()
    return fake


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: fake_unreal.py <job.json> <project dir>", file=sys.stderr)
        sys.exit(2)
    f = run_job(sys.argv[1], sys.argv[2])
    print(f"FAKE run: main={f.main_code} exits={f.exits}")
    sys.exit(0 if f.exits == [0] else 1)
