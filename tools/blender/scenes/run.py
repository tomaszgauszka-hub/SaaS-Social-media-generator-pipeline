"""Entry point of the parametric 3D scene generators (see scene_main.py).

    <python-with-bpy> tools/blender/scenes/run.py <scene-job.json>
    blender -b --factory-startup --python tools/blender/scenes/run.py -- <scene-job.json>

Exit codes: 0 ok · 2 usage · 3 invalid job · 1 render error (traceback on stderr).
"""

import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.join(os.path.dirname(HERE), "studio")
for p in (STUDIO, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

import scene_main  # noqa: E402

if __name__ == "__main__":
    try:
        code = scene_main.cli(sys.argv)
    except Exception:  # noqa: BLE001 — any render failure: traceback for the worker, exit 1
        traceback.print_exc()
        code = 1
    sys.stdout.flush()
    sys.stderr.flush()
    # bpy as a module can hang on interpreter teardown with render data loaded; the results are on disk
    os._exit(code)
