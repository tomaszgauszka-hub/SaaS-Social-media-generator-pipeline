"""Entry point of the Blender product studio.

    <python-with-bpy> tools/blender/studio/run.py <job.json>
    blender -b --factory-startup --python tools/blender/studio/run.py -- <job.json>

The job is a StudioJob JSON (packages/reel/src/contracts/media.ts) written by the TypeScript bridge. Exit codes:
0 ok · 2 usage · 3 invalid job · 1 render error (traceback on stderr).
"""

import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import studio_main  # noqa: E402

if __name__ == "__main__":
    try:
        code = studio_main.cli(sys.argv)
    except Exception:  # noqa: BLE001 — any render failure: traceback for the bridge, exit 1
        traceback.print_exc()
        code = 1
    sys.stdout.flush()
    sys.stderr.flush()
    # bpy as a module can hang on interpreter teardown with render data loaded; the results are on disk
    os._exit(code)
