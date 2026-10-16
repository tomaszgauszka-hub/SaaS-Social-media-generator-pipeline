"""Movie Render Queue settings and the global-illumination decision (pure CPython — unit-tested).

ue_scene.py applies these values to a MoviePipelineExecutorJob configuration; result.json reports them as `mrq`.
"""

from __future__ import annotations

FILE_NAME_FORMAT = "f_{frame_number}"
FRAME_PATTERN = "f_%04d.png"
ZERO_PAD = 4
#: MRQ numbers frames from the sequence's playback start (0); +1 gives f_0001.png like the Blender generators
FRAME_NUMBER_OFFSET = 1

#: quality → anti-aliasing / warm-up (temporal samples also average Lumen's temporal noise in production)
QUALITY = {
    "preview": {"spatialSamples": 1, "temporalSamples": 1, "warmUpFrames": 8, "antiAliasing": "engine_default"},
    "production": {"spatialSamples": 1, "temporalSamples": 8, "warmUpFrames": 32, "antiAliasing": "none"},
}


def mrq_settings(quality: str, render: dict, width: int, height: int, fps: int, frames_dir: str,
                 gi: str) -> dict:
    """Everything the queue job is configured with (deterministic, recorded in result.json)."""
    q = dict(QUALITY[quality])
    for key in ("spatialSamples", "temporalSamples", "warmUpFrames"):
        if render.get(key) is not None:
            q[key] = render[key]
    if q["spatialSamples"] * q["temporalSamples"] > 1:
        q["antiAliasing"] = "none"  # MRQ's own sub-pixel jitter replaces TSR / TAA
    cvars = {
        "r.MotionBlurQuality": 0,  # product clips: no motion blur (clean frames for QA and 2D overlays)
        "r.DepthOfFieldQuality": 4 if quality == "production" else 2,
        "r.ScreenPercentage": 100,
    }
    if gi == "screen_space":
        cvars["r.SSGI.Enable"] = 1
        cvars["r.SSGI.Quality"] = 4 if quality == "production" else 2
    return {
        "executor": render["executor"],
        "outputDirectory": frames_dir,
        "fileNameFormat": FILE_NAME_FORMAT,
        "framePattern": FRAME_PATTERN,
        "zeroPad": ZERO_PAD,
        "frameNumberOffset": FRAME_NUMBER_OFFSET,
        "resolution": [width, height],
        "fps": fps,
        "spatialSamples": q["spatialSamples"],
        "temporalSamples": q["temporalSamples"],
        "warmUpFrames": q["warmUpFrames"],
        "antiAliasing": q["antiAliasing"],
        "png": {"writeAlpha": False},
        "cvars": cvars,
        "gameOverrides": {"cinematicQuality": True, "textureStreaming": "disabled", "lodZero": True,
                          "disableHlods": True},
    }


def choose_gi(requested: str, cvars: dict) -> tuple[str, str | None]:
    """('lumen' | 'screen_space', warning) from the job's request and the project's rendering cvars.

    Lumen needs Shader Model 5+ and either mesh distance fields (software tracing, r.GenerateMeshDistanceFields=1)
    or hardware ray tracing (r.RayTracing=1 project setting + an RT-capable GPU). cvars maps names to the values the
    editor reports (None when the cvar does not exist in this engine version).
    """
    if requested == "screen_space":
        return "screen_space", None
    sdf = cvars.get("r.GenerateMeshDistanceFields")
    rt = cvars.get("r.RayTracing")
    lumen_ok = bool(sdf) or bool(rt)
    if lumen_ok:
        return "lumen", None
    why = ("the project has neither mesh distance fields (r.GenerateMeshDistanceFields) nor hardware ray tracing "
           "(r.RayTracing) enabled")
    if requested == "lumen":
        return "screen_space", f"Lumen requested but unavailable: {why} — screen-space GI / reflections used"
    return "screen_space", f"Lumen unavailable ({why}): screen-space GI / reflections used"
