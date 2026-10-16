#!/usr/bin/env bash
# Local 3D production setup (Linux / macOS): pinned Blender MCP (hash-locked venv), reviewed add-on, optional
# add-on install into a desktop Blender, worker settings, optional end-to-end MCP check. Safe to re-run.
#   scripts/setup-3d.sh [--blender /path/to/blender] [--check]
# Windows: scripts/setup-3d.ps1. Docs: docs/BLENDER_MCP_SETUP.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.tools/mcp-venv"
BLENDER="${BLENDER_BIN:-}"
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --blender) BLENDER="$2"; shift 2 ;;
    --check) CHECK=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

command -v uv >/dev/null || { echo "uv not found — https://docs.astral.sh/uv/ (package manager install recommended)" >&2; exit 1; }
[ -x "$VENV/bin/python" ] || uv venv --python 3.11 "$VENV"
uv pip install --python "$VENV/bin/python" --require-hashes -r "$ROOT/tools/mcp/requirements-blender-mcp.txt"

EXPECTED="$(sed -n 's/^ADDON_SHA256 = "\([0-9a-f]\{64\}\)"/\1/p' "$ROOT/tools/mcp/blender_headless_host.py")"
BUNDLED="$(ls "$VENV"/lib/python3*/site-packages/blender_mcp/bundled/addon.py)"
ACTUAL="$(sha256sum "$BUNDLED" | cut -d' ' -f1)"
[ "$ACTUAL" = "$EXPECTED" ] || { echo "add-on sha256 $ACTUAL is not the reviewed $EXPECTED — refusing" >&2; exit 1; }
echo "ok add-on matches the reviewed release"

if [ -n "$BLENDER" ] && [ -x "$BLENDER" ]; then
  VER="$("$BLENDER" -b --factory-startup --version | sed -n 's/^Blender \([0-9]*\.[0-9]*\).*/\1/p' | head -1)"
  echo "ok Blender $VER"
  CFG="${XDG_CONFIG_HOME:-$HOME/.config}/blender/$VER/scripts/addons"
  [ "$(uname)" = "Darwin" ] && CFG="$HOME/Library/Application Support/Blender/$VER/scripts/addons"
  mkdir -p "$CFG"
  BLENDERMCP_ADDONS_DIR="$CFG" BLENDERMCP_NO_UPDATE_CHECK=1 "$VENV/bin/mcp-for-blender" install-addon
  [ "$(sha256sum "$CFG/blender_mcp.py" | cut -d' ' -f1)" = "$EXPECTED" ] || { echo "installed add-on differs" >&2; exit 1; }
  "$BLENDER" -b -noaudio --python-expr "import addon_utils, bpy; addon_utils.enable('blender_mcp', default_set=True, persistent=True); bpy.ops.wm.save_userpref()"
  echo "ok add-on enabled for Blender $VER (start Blender with BLENDERMCP_NO_UPDATE_CHECK=1)"
  echo "BLENDER_BIN=$BLENDER"
else
  echo "no desktop Blender given: the worker uses BLENDER_PYTHON (bpy) — headless MCP: tools/mcp/blender_headless_host.py"
fi

if [ "$CHECK" = 1 ]; then
  if [ -n "$BLENDER" ]; then "$VENV/bin/python" "$ROOT/tools/mcp/check_blender_mcp.py" --blender-bin "$BLENDER"
  else "$VENV/bin/python" "$ROOT/tools/mcp/check_blender_mcp.py"; fi
fi
echo "done — in Claude Code: claude mcp list (approve the project servers once)"
