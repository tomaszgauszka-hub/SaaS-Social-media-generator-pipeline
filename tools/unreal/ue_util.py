"""Small stdlib helpers shared by the UE scripts: logging, atomic JSON, hashing, frame scans, the dedicated-project
marker, a tiny PNG writer (no `unreal`, no third-party modules)."""

from __future__ import annotations

import hashlib
import json
import os
import re
import struct
import sys
import time
import zlib

#: marker of the dedicated render project: <Project>/Config/DefaultRender3D.ini (written by ue_project.py init)
MARKER_FILE = "DefaultRender3D.ini"
MARKER_SECTION = "[Render3D]"
MARKER_KEY = "DedicatedRenderProject=True"
#: every asset this tool creates lives below this content path; nothing else in a project is ever touched
OWN_ROOT = "/Game/Render3D"


class Log:
    """Line log to <out>/ue_scene.log and stdout (UE echoes Python's stdout to its log as LogPython lines)."""

    def __init__(self, path: str | None):
        self.path = path
        self._fh = None
        if path:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            self._fh = open(path, "a", encoding="utf-8", buffering=1)

    def __call__(self, msg: str) -> None:
        line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}"
        if self._fh:
            self._fh.write(line + "\n")
        print(msg, flush=True)

    def close(self) -> None:
        if self._fh:
            self._fh.close()
            self._fh = None


def atomic_write_json(path: str, data) -> None:
    """Write JSON to a temp file in the same directory, then rename over the target (readers never see half)."""
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, sort_keys=False, allow_nan=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


FRAME_RE = re.compile(r"^f_(\d{4})\.png$")


def scan_frames(frames_dir: str) -> dict:
    """Numbered frames on disk: {start, count, contiguous, numbers, mtimes}."""
    nums = []
    mtimes = {}
    try:
        names = os.listdir(frames_dir)
    except OSError:
        names = []
    for n in names:
        m = FRAME_RE.match(n)
        if m:
            k = int(m.group(1))
            nums.append(k)
            try:
                mtimes[k] = os.stat(os.path.join(frames_dir, n)).st_mtime
            except OSError:
                pass
    nums.sort()
    contiguous = bool(nums) and nums == list(range(nums[0], nums[0] + len(nums)))
    return {"start": nums[0] if nums else None, "count": len(nums), "contiguous": contiguous, "numbers": nums,
            "mtimes": mtimes}


def frame_ms_from_mtimes(numbers: list[int], mtimes: dict, render_start: float) -> list[int]:
    """Approximate per-frame render time from file write times (MRQ does not report per-frame timings)."""
    out = []
    prev = render_start
    for k in numbers:
        t = mtimes.get(k, prev)
        out.append(max(0, int(round((t - prev) * 1000))))
        prev = max(prev, t)
    return out


def is_dedicated_project(config_dir: str) -> bool:
    """The project carries the Render3D marker (only such a project is ever modified by these scripts)."""
    try:
        with open(os.path.join(config_dir, MARKER_FILE), encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return False
    lines = [ln.strip() for ln in text.splitlines()]
    return MARKER_SECTION in lines and MARKER_KEY in lines


def own_path(asset_path: str) -> str:
    """Guard: an asset path this tool writes must be below /Game/Render3D (raises otherwise)."""
    if not isinstance(asset_path, str) or not (asset_path == OWN_ROOT or asset_path.startswith(OWN_ROOT + "/")) \
            or ".." in asset_path or "\\" in asset_path:
        raise ValueError(f"refusing to touch {asset_path!r}: outside {OWN_ROOT}")
    return asset_path


def safe_asset_name(text: str, max_len: int = 60) -> str:
    """A UE asset name from an id (letters, digits, '_')."""
    s = re.sub(r"[^A-Za-z0-9_]", "_", text)[:max_len].strip("_")
    return s or "asset"


def png_bytes(width: int, height: int, rgb_rows) -> bytes:
    """Encode 8-bit RGB rows (an iterable of bytes, width*3 each) as PNG."""
    raw = b"".join(b"\x00" + bytes(row) for row in rgb_rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def solid_png(path: str, width: int, height: int, rgb: tuple[int, int, int]) -> str:
    row = bytes(rgb) * width
    with open(path, "wb") as fh:
        fh.write(png_bytes(width, height, (row for _ in range(height))))
    return path


def eprint(*args) -> None:
    print(*args, file=sys.stderr, flush=True)
