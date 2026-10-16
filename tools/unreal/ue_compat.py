"""Runtime resolution of Unreal Python API names that moved or were renamed between UE 5.x releases.

Nothing here assumes one engine version: every feature lists its candidate names (newest first) and the variant
actually found is recorded — ue_diagnose.py reports them, ue_scene.py writes them to result.json (unreal.apiVariants)
so a run on an untested engine shows exactly which code path it took. Known renames handled:

  EditorLevelLibrary (deprecated in 5.0)  → EditorActorSubsystem / LevelEditorSubsystem / UnrealEditorSubsystem
  MoviePipelineMasterConfig (≤ 5.0)       → MoviePipelinePrimaryConfig (5.1+)
  MovieSceneSequence.add_master_track     → add_track (5.2+)
  MovieSceneSequence.make_binding_id      → get_binding_id / get_portable_binding_id
  MovieSceneSection.get_channels          → get_all_channels
  Movie Render Queue legacy config        ↔ Movie Render Graph (MovieGraphConfig, 5.4+; reported, not used)

`resolve()` is pure (getattr probes on any object) and unit-tested with a fake module; the helpers below it need the
real `unreal` module and run inside the editor only.
"""

from __future__ import annotations

try:  # inside the editor
    import unreal  # type: ignore
except ImportError:  # plain CPython (unit tests, the setup CLI)
    unreal = None

#: feature → candidate attribute paths on the `unreal` module, preferred first ("Class.method" checks a method)
API_CHECKS: dict[str, tuple[str, ...]] = {
    "editorSubsystems": ("get_editor_subsystem",),
    "actors": ("EditorActorSubsystem", "EditorLevelLibrary"),
    "levels": ("LevelEditorSubsystem", "EditorLevelLibrary"),
    "editorWorld": ("UnrealEditorSubsystem", "EditorLevelLibrary"),
    "assets": ("EditorAssetLibrary", "EditorAssetSubsystem"),
    "assetTools": ("AssetToolsHelpers",),
    "assetRegistry": ("AssetRegistryHelpers",),
    "dirtyPackages": ("EditorLoadingAndSavingUtils",),
    "importTask": ("AssetImportTask",),
    "fbxImportUi": ("FbxImportUI",),
    "interchange": ("InterchangeManager",),
    "materialEditing": ("MaterialEditingLibrary",),
    "materialInstance": ("MaterialInstanceConstant",),
    "materialFactory": ("MaterialFactoryNew",),
    "materialInstanceFactory": ("MaterialInstanceConstantFactoryNew",),
    "textureFactory": ("TextureFactory",),
    "levelSequence": ("LevelSequence",),
    "levelSequenceFactory": ("LevelSequenceFactoryNew",),
    "levelSequenceEditor": ("LevelSequenceEditorSubsystem",),
    "sequenceAddTrack": ("MovieSceneSequence.add_track", "MovieSceneSequence.add_master_track"),
    "sequenceBindingId": ("MovieSceneSequence.get_portable_binding_id", "MovieSceneSequence.get_binding_id",
                          "MovieSceneSequence.make_binding_id"),
    "sectionChannels": ("MovieSceneSection.get_all_channels", "MovieSceneSection.get_channels"),
    "transformTrack": ("MovieScene3DTransformTrack",),
    "cameraCutTrack": ("MovieSceneCameraCutTrack",),
    "cineCamera": ("CineCameraActor",),
    "mrqQueueSubsystem": ("MoviePipelineQueueSubsystem",),
    "mrqExecutorJob": ("MoviePipelineExecutorJob",),
    "mrqConfig": ("MoviePipelinePrimaryConfig", "MoviePipelineMasterConfig"),
    "mrqPieExecutor": ("MoviePipelinePIEExecutor",),
    "mrqNewProcessExecutor": ("MoviePipelineNewProcessExecutor",),
    "mrqRenderWithInstance": ("MoviePipelineQueueSubsystem.render_queue_with_executor_instance",
                              "MoviePipelineQueueSubsystem.render_queue_with_executor"),
    "mrqOutputSetting": ("MoviePipelineOutputSetting",),
    "mrqDeferredPass": ("MoviePipelineDeferredPassBase",),
    "mrqPngOutput": ("MoviePipelineImageSequenceOutput_PNG",),
    "mrqAntiAliasing": ("MoviePipelineAntiAliasingSetting",),
    "mrqConsoleVariables": ("MoviePipelineConsoleVariableSetting",),
    "mrqGameOverrides": ("MoviePipelineGameOverrideSetting",),
    "movieRenderGraph": ("MovieGraphConfig",),
    "postProcessVolume": ("PostProcessVolume",),
    "rectLight": ("RectLight",),
    "spotLight": ("SpotLight",),
    "pointLight": ("PointLight",),
    "directionalLight": ("DirectionalLight",),
    "skyLight": ("SkyLight",),
    "skyAtmosphere": ("SkyAtmosphere",),
    "heightFog": ("ExponentialHeightFog",),
    "staticMeshActor": ("StaticMeshActor",),
    "slateTick": ("register_slate_post_tick_callback",),
    "pluginLibrary": ("PluginBlueprintLibrary",),
    "systemLibrary": ("SystemLibrary",),
    "paths": ("Paths",),
}
#: without these a render cannot be set up at all
REQUIRED = ("editorSubsystems", "actors", "levels", "assets", "assetTools", "importTask", "materialEditing",
            "materialInstance", "materialFactory", "materialInstanceFactory", "levelSequence",
            "levelSequenceFactory", "sequenceAddTrack", "sequenceBindingId", "sectionChannels", "transformTrack",
            "cameraCutTrack", "cineCamera", "mrqQueueSubsystem", "mrqExecutorJob", "mrqOutputSetting",
            "mrqDeferredPass", "mrqPngOutput", "staticMeshActor", "systemLibrary", "paths")


class ApiMissing(RuntimeError):
    """A required editor API is not available in this engine / plugin set."""


def has_path(module, dotted: str) -> bool:
    obj = module
    for part in dotted.split("."):
        obj = getattr(obj, part, None)
        if obj is None:
            return False
    return True


def resolve(module, checks: dict[str, tuple[str, ...]] = API_CHECKS) -> dict[str, str | None]:
    """feature → the first candidate present on `module` (None: none of them)."""
    return {feature: next((n for n in names if has_path(module, n)), None) for feature, names in checks.items()}


def missing_required(variants: dict[str, str | None]) -> list[str]:
    return [f"{f} ({' / '.join(API_CHECKS[f])})" for f in REQUIRED if variants.get(f) is None]


# -------------------------------------------------------------------------------- editor-only facade ----


class Api:
    """The variants present in this editor, behind one small interface (records what it used)."""

    def __init__(self, ue=None):
        self.ue = ue if ue is not None else unreal
        if self.ue is None:
            raise ApiMissing("the `unreal` module is only available inside the Unreal Editor")
        self.variants = resolve(self.ue)
        self.used: dict[str, str] = {}

    # -- subsystems / libraries
    def _sub(self, name: str):
        cls = getattr(self.ue, name, None)
        if cls is None:
            return None
        try:
            return self.ue.get_editor_subsystem(cls)
        except Exception:  # noqa: BLE001 — subsystem not initialised (commandlet)
            return None

    def _pick(self, feature: str, subsystem: str, library: str):
        sub = self._sub(subsystem)
        if sub is not None:
            self.used[feature] = subsystem
            return sub
        lib = getattr(self.ue, library, None)
        if lib is not None:
            self.used[feature] = library
            return lib
        raise ApiMissing(f"no {feature} API ({subsystem} / {library})")

    def actors(self):
        return self._pick("actors", "EditorActorSubsystem", "EditorLevelLibrary")

    def levels(self):
        return self._pick("levels", "LevelEditorSubsystem", "EditorLevelLibrary")

    def assets(self):
        lib = getattr(self.ue, "EditorAssetLibrary", None)
        if lib is not None:
            self.used["assets"] = "EditorAssetLibrary"
            return lib
        sub = self._sub("EditorAssetSubsystem")
        if sub is None:
            raise ApiMissing("no asset API (EditorAssetLibrary / EditorAssetSubsystem)")
        self.used["assets"] = "EditorAssetSubsystem"
        return sub

    def asset_tools(self):
        return self.ue.AssetToolsHelpers.get_asset_tools()

    def editor_world(self):
        sub = self._sub("UnrealEditorSubsystem")
        if sub is not None:
            return sub.get_editor_world()
        lib = getattr(self.ue, "EditorLevelLibrary", None)
        return lib.get_editor_world() if lib is not None else None

    # -- levels
    def new_level(self, path: str) -> None:
        lv = self.levels()
        try:
            ok = lv.new_level(path, False)  # 5.1+: (asset_path, is_partitioned_world)
        except TypeError:
            ok = lv.new_level(path)
        if ok is False:
            raise RuntimeError(f"could not create level {path}")

    def load_level(self, path: str) -> None:
        if self.levels().load_level(path) is False:
            raise RuntimeError(f"could not load level {path}")

    def save_current_level(self) -> None:
        if self.levels().save_current_level() is False:
            raise RuntimeError("could not save the current level")

    # -- sequencer
    def add_track(self, sequence, track_cls):
        if hasattr(sequence, "add_track"):
            self.used["sequenceAddTrack"] = "add_track"
            return sequence.add_track(track_cls)
        self.used["sequenceAddTrack"] = "add_master_track"
        return sequence.add_master_track(track_cls)

    def binding_id(self, sequence, binding):
        if hasattr(sequence, "get_portable_binding_id"):
            self.used["sequenceBindingId"] = "get_portable_binding_id"
            return sequence.get_portable_binding_id(sequence, binding)
        if hasattr(sequence, "get_binding_id"):
            self.used["sequenceBindingId"] = "get_binding_id"
            return sequence.get_binding_id(binding)
        self.used["sequenceBindingId"] = "make_binding_id"
        return sequence.make_binding_id(binding, self.ue.MovieSceneObjectBindingSpace.LOCAL)

    def channels(self, section) -> list:
        if hasattr(section, "get_all_channels"):
            self.used["sectionChannels"] = "get_all_channels"
            return list(section.get_all_channels())
        self.used["sectionChannels"] = "get_channels"
        return list(section.get_channels())

    def set_section_range(self, section, start: int, end: int) -> None:
        if hasattr(section, "set_range"):
            section.set_range(start, end)
        else:
            section.set_start_frame(start)
            section.set_end_frame(end)

    def add_key(self, channel, frame: int, value: float) -> None:
        ue = self.ue
        t = ue.FrameNumber(frame)
        try:
            channel.add_key(t, value, 0.0, ue.MovieSceneTimeUnit.DISPLAY_RATE,
                            ue.MovieSceneKeyInterpolation.LINEAR)
            self.used["addKey"] = "linear"
        except (TypeError, AttributeError):
            channel.add_key(t, value)
            self.used["addKey"] = "default-interpolation"

    # -- Movie Render Queue
    def render_queue(self, subsystem, executor_kind: str):
        ue = self.ue
        cls = ue.MoviePipelinePIEExecutor if executor_kind == "pie" else ue.MoviePipelineNewProcessExecutor
        if hasattr(subsystem, "render_queue_with_executor_instance"):
            executor = ue.new_object(cls, outer=subsystem)
            if executor_kind == "pie" and hasattr(executor, "set_is_rendering_offscreen"):
                try:
                    executor.set_is_rendering_offscreen(True)
                    self.used["pieOffscreen"] = "set_is_rendering_offscreen"
                except Exception:  # noqa: BLE001
                    pass
            subsystem.render_queue_with_executor_instance(executor)
            self.used["mrqRender"] = "render_queue_with_executor_instance"
            return executor
        self.used["mrqRender"] = "render_queue_with_executor"
        return subsystem.render_queue_with_executor(cls)

    # -- misc
    def cvar_int(self, name: str):
        try:
            return int(self.ue.SystemLibrary.get_console_variable_int_value(name))
        except Exception:  # noqa: BLE001
            return None

    def engine_version(self) -> str:
        try:
            return str(self.ue.SystemLibrary.get_engine_version())
        except Exception:  # noqa: BLE001
            return "unknown"

    def full_path(self, rel: str) -> str:
        return str(self.ue.Paths.convert_relative_path_to_full(rel))

    def project_config_dir(self) -> str:
        return self.full_path(self.ue.Paths.project_config_dir())

    def project_saved_dir(self) -> str:
        return self.full_path(self.ue.Paths.project_saved_dir())

    def project_dir(self) -> str:
        return self.full_path(self.ue.Paths.project_dir())

    def enabled_plugins(self) -> list[str] | None:
        lib = getattr(self.ue, "PluginBlueprintLibrary", None)
        if lib is None or not hasattr(lib, "get_enabled_plugin_names"):
            return None
        try:
            return sorted(str(n) for n in lib.get_enabled_plugin_names())
        except Exception:  # noqa: BLE001
            return None
