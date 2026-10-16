<#
.SYNOPSIS
  Local 3D production setup (Windows): pinned Blender MCP, Blender add-on, render-worker settings, optional
  Unreal Engine checks. Safe to re-run; it never touches existing game projects and opens no network ports.

.DESCRIPTION
  1. Checks uv and Python 3.11 (uv downloads Python itself), creates .tools\mcp-venv and installs the
     hash-locked tools\mcp\requirements-blender-mcp.txt (mcp-for-blender 2.1.9 + dependencies, --require-hashes).
  2. Verifies the bundled add-on against the reviewed SHA-256 (tools\mcp\blender_headless_host.py ADDON_SHA256).
  3. Finds Blender (-BlenderExe, else the newest "Blender Foundation\Blender *\blender.exe"), installs the add-on
     into that version's user add-ons folder and enables it headlessly (saved in the user preferences).
  4. Writes .tools\start-blender-mcp.cmd: starts Blender with the add-on's self-update check disabled.
  5. Optionally validates Unreal Engine paths (-UeEditorCmd, -UeProject) — read-only.
  6. Prints the .env lines for the render worker and, with -Check, runs the end-to-end MCP check (object,
     material, .blend, render) through the real MCP protocol.

  The Blender MCP server is registered for Claude Code by the repository's .mcp.json (project scope, approved
  once in Claude Code) — this script does not add a second, competing user-scope entry.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-3d.ps1 -Check
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-3d.ps1 -BlenderExe "C:\Program Files\Blender Foundation\Blender 4.3\blender.exe"
#>
[CmdletBinding()]
param(
  [string]$BlenderExe = "",
  [string]$UeEditorCmd = "",
  [string]$UeProject = "",
  [switch]$Check,
  [switch]$SkipAddon,
  [switch]$InstallUv
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Venv = Join-Path $Root ".tools\mcp-venv"
$Req = Join-Path $Root "tools\mcp\requirements-blender-mcp.txt"
$HostPy = Join-Path $Root "tools\mcp\blender_headless_host.py"
# Windows PowerShell 5.1 and pwsh on any OS: venv layout differs (Scripts\*.exe vs bin/*)
$OnWindows = $env:OS -eq "Windows_NT"
$VenvBin = if ($OnWindows) { Join-Path $Venv "Scripts" } else { Join-Path $Venv "bin" }
$Exe = if ($OnWindows) { ".exe" } else { "" }
$VenvPython = Join-Path $VenvBin "python$Exe"

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Ok($msg) { Write-Host "  ok $msg" -ForegroundColor Green }

# ------------------------------------------------------------------ 1. uv + pinned MCP server
Step "uv (Python package manager)"
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
  if ($InstallUv) {
    # signed package from the Windows Package Manager (no remote script piped into the shell)
    winget install --id=astral-sh.uv -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + $env:Path
    $uv = Get-Command uv -ErrorAction SilentlyContinue
  }
  if (-not $uv) { throw "uv not found. Install it (winget install --id=astral-sh.uv) or re-run with -InstallUv." }
}
Ok (& uv --version)

Step "MCP server venv (.tools\mcp-venv, hash-locked)"
if (-not (Test-Path $VenvPython)) {
  & uv venv --python 3.11 $Venv
}
& uv pip install --python $VenvPython --require-hashes -r $Req
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
Ok "mcp-for-blender installed"

# ------------------------------------------------------------------ 2. reviewed add-on hash
Step "Add-on integrity"
$expected = (Select-String -Path $HostPy -Pattern '^ADDON_SHA256 = "([0-9a-f]{64})"').Matches[0].Groups[1].Value
$bundled = if ($OnWindows) { Join-Path $Venv "Lib\site-packages\blender_mcp\bundled\addon.py" } else {
  (Get-ChildItem -Path (Join-Path $Venv "lib") -Filter addon.py -Recurse | Where-Object { $_.FullName -like "*blender_mcp*bundled*" } | Select-Object -First 1).FullName
}
$actual = (Get-FileHash -Algorithm SHA256 $bundled).Hash.ToLower()
if ($actual -ne $expected) { throw "bundled add-on sha256 $actual is not the reviewed $expected — do not install it" }
Ok "add-on matches the reviewed release ($expected)"

# ------------------------------------------------------------------ 3. Blender + add-on
Step "Blender"
if (-not $BlenderExe) {
  $searchRoot = if ($OnWindows) { Join-Path $env:ProgramFiles "Blender Foundation" } else { "/nonexistent" }
  $cands = Get-ChildItem -Path $searchRoot -Filter "blender.exe" -Recurse -ErrorAction SilentlyContinue |
    Sort-Object { [version](($_.Directory.Name -replace '[^0-9.]', '') + '.0') } -Descending
  if ($cands) { $BlenderExe = $cands[0].FullName }
}
if (-not $BlenderExe -or -not (Test-Path $BlenderExe)) {
  Warn "Blender not found — pass -BlenderExe. The render worker can still use a bpy venv (BLENDER_PYTHON)."
} else {
  $ver = (& $BlenderExe -b --factory-startup --version | Select-String -Pattern '^Blender (\d+\.\d+)').Matches[0].Groups[1].Value
  Ok "Blender $ver at $BlenderExe"
  if ([version]"$ver.0" -lt [version]"4.2.0") { throw "Blender $ver is older than the supported 4.2" }
  if (-not $SkipAddon) {
    $addons = if ($OnWindows) { Join-Path $env:APPDATA "Blender Foundation\Blender\$ver\scripts\addons" } else {
      Join-Path $HOME ".config/blender/$ver/scripts/addons"
    }
    New-Item -ItemType Directory -Force -Path $addons | Out-Null
    $env:BLENDERMCP_ADDONS_DIR = $addons
    $env:BLENDERMCP_NO_UPDATE_CHECK = "1"
    & (Join-Path $VenvBin "mcp-for-blender$Exe") install-addon
    $installed = Join-Path $addons "blender_mcp.py"
    if ((Get-FileHash -Algorithm SHA256 $installed).Hash.ToLower() -ne $expected) { throw "installed add-on differs from the reviewed release" }
    & $BlenderExe -b -noaudio --python-expr "import addon_utils, bpy; addon_utils.enable('blender_mcp', default_set=True, persistent=True); bpy.ops.wm.save_userpref(); print('BLENDER_MCP_ENABLED')"
    Ok "add-on installed in $addons and enabled"
  }
  $starter = Join-Path $Root ".tools\start-blender-mcp.cmd"
  @"
@echo off
rem Blender with the MCP add-on: no add-on self-update from the internet; the add-on listens on 127.0.0.1 only.
set BLENDERMCP_NO_UPDATE_CHECK=1
start "" "$BlenderExe"
"@ | Set-Content -Encoding ASCII $starter
  Ok "launcher: $starter (in Blender: N panel > MCP > Start Server)"
}

# ------------------------------------------------------------------ 5. Unreal Engine (read-only checks)
if ($UeEditorCmd) {
  Step "Unreal Engine"
  if (-not (Test-Path $UeEditorCmd)) { throw "UnrealEditor-Cmd not found: $UeEditorCmd" }
  $build = Join-Path (Split-Path (Split-Path (Split-Path $UeEditorCmd))) "Build\Build.version"
  if (Test-Path $build) {
    $b = Get-Content $build | ConvertFrom-Json
    Ok "Unreal Engine $($b.MajorVersion).$($b.MinorVersion).$($b.PatchVersion)"
  } else { Warn "Build.version not found next to the editor" }
  if ($UeProject) {
    if (-not (Test-Path $UeProject)) { throw "project not found: $UeProject" }
    Ok "render project: $UeProject (use a dedicated project — never an existing game project; see docs\UNREAL_MCP_SETUP.md)"
  }
}

# ------------------------------------------------------------------ 6. worker settings + check
Step "Render worker settings (.env)"
if ($BlenderExe) { Write-Host "  BLENDER_BIN=$BlenderExe" }
Write-Host "  RENDER3D_DEVICE=AUTO"
Write-Host "  RENDER3D_MAX_CONCURRENT=1"
if ($UeEditorCmd) { Write-Host "  UE_EDITOR_CMD=$UeEditorCmd" }
if ($UeProject) { Write-Host "  UE_PROJECT=$UeProject" }

if ($Check) {
  Step "End-to-end Blender MCP check (MCP protocol -> add-on -> Blender)"
  $py = $VenvPython
  if ($BlenderExe) {
    & $py (Join-Path $Root "tools\mcp\check_blender_mcp.py") --blender-bin $BlenderExe
  } else {
    & $py (Join-Path $Root "tools\mcp\check_blender_mcp.py")
  }
  if ($LASTEXITCODE -ne 0) { throw "MCP check failed (report in .data\mcp-check\report.json)" }
  Ok "MCP check passed"
}
Write-Host "Done. In Claude Code run: claude mcp list   (approve the project servers 'blender' and 'render3d' once)."
