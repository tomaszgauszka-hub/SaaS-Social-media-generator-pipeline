"""Blender version compatibility (4.2 LTS … 5.x) for the studio and the 3D scene generators.

Everything that differs between the supported Blender versions goes through here, so a recipe renders the same
picture on a workstation with Blender 4.3 and on a render host with Blender 5.2:

  * EEVEE's engine id: BLENDER_EEVEE_NEXT (4.2–4.5) → BLENDER_EEVEE (5.0+);
  * light colour temperature (Light.use_temperature, 4.4+) — older versions get the equivalent RGB colour;
  * the compositor tree: Scene.node_tree (≤ 4.5) → Scene.compositing_node_group (5.0+);
  * Cycles GPU backends (OPTIX / CUDA / HIP / METAL / ONEAPI), probed instead of assumed.

Pure helpers (kelvin_rgb, version_tuple) do not need bpy and are unit-tested without it.
"""

from __future__ import annotations

import math

MIN_VERSION = (4, 2, 0)
GPU_BACKENDS = ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI")


def version_tuple(bpy_module=None) -> tuple[int, int, int]:
    if bpy_module is None:
        import bpy as bpy_module  # noqa: PLC0415
    v = tuple(int(x) for x in bpy_module.app.version[:3])
    return v[0], v[1], v[2]


def require_supported(bpy_module=None) -> tuple[int, int, int]:
    v = version_tuple(bpy_module)
    if v < MIN_VERSION:
        raise RuntimeError(f"Blender {'.'.join(map(str, v))} is older than the supported "
                           f"{'.'.join(map(str, MIN_VERSION))}")
    return v


def kelvin_rgb(kelvin: float) -> tuple[float, float, float]:
    """Linear RGB of a black body at `kelvin`, normalised to max 1 (Tanner Helland fit, then sRGB → linear).

    Used where Light.use_temperature does not exist (Blender < 4.4): the light gets this colour instead."""
    t = max(1000.0, min(40000.0, kelvin)) / 100.0
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * ((t - 60) ** -0.1332047592)
        g = 288.1221695283 * ((t - 60) ** -0.0755148492)
        b = 255.0
    srgb = [max(0.0, min(255.0, c)) / 255.0 for c in (r, g, b)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    m = max(lin) or 1.0
    return lin[0] / m, lin[1] / m, lin[2] / m


def set_light_temperature(light_data, kelvin: float) -> None:
    """Colour temperature on a light datablock: native on 4.4+, an equivalent RGB colour before."""
    if hasattr(light_data, "use_temperature"):
        light_data.use_temperature = True
        light_data.temperature = kelvin
    else:
        light_data.color = kelvin_rgb(kelvin)


def eevee_engine_id(bpy_module=None) -> str:
    if bpy_module is None:
        import bpy as bpy_module  # noqa: PLC0415
    items = {e.identifier for e in bpy_module.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    for cand in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        if cand in items:
            return cand
    raise RuntimeError("this Blender has no EEVEE engine")


def compositor_tree(scene, create: bool = True):
    """The scene's compositor node tree on any supported version (None when absent and not created)."""
    import bpy  # noqa: PLC0415

    if hasattr(scene, "compositing_node_group"):  # 5.0+
        tree = scene.compositing_node_group
        if tree is None and create:
            tree = bpy.data.node_groups.new(f"{scene.name}.Compositor", "CompositorNodeTree")
            scene.compositing_node_group = tree
        return tree
    if create:
        scene.use_nodes = True
    return scene.node_tree


def configure_cycles_device(scene, prefer: str = "CPU") -> dict:
    """CPU or the best available GPU backend. Returns {device, backend, devices} for telemetry.

    `prefer="GPU"` falls back to CPU when no GPU backend has a usable device (e.g. a cloud host without a GPU)."""
    import bpy  # noqa: PLC0415

    scene.cycles.device = "CPU"
    info = {"device": "CPU", "backend": "NONE", "devices": []}
    if prefer.upper() != "GPU":
        return info
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except (KeyError, AttributeError):
        return info
    for backend in GPU_BACKENDS:
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue  # backend not compiled into this build
        try:
            prefs.refresh_devices()
        except Exception:  # noqa: BLE001 — a broken driver must not fail the render: CPU fallback
            continue
        gpus = [d for d in prefs.devices if d.type == backend]
        if not gpus:
            continue
        for d in prefs.devices:
            d.use = d.type == backend
        scene.cycles.device = "GPU"
        return {"device": "GPU", "backend": backend, "devices": [d.name for d in gpus]}
    prefs.compute_device_type = "NONE"
    return info
