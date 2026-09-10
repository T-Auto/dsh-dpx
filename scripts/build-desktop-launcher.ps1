[CmdletBinding()]
param(
  # Artifact version. Defaults to `desktop-shell/package.json`.
  [string]$Version,
  # Also write a publishable release folder (versioned EXE + desktop-latest.json).
  [string]$OutputDirectory,
  # Skip refreshing `assets\windows`, useful when building an older demo artifact.
  [switch]$SkipPackagedArtifact,
  # HTTP(S) proxy for cargo/npm downloads. Defaults to $env:DPX_BUILD_PROXY.
  [string]$Proxy = $env:DPX_BUILD_PROXY
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$shell = Join-Path $repo 'desktop-shell'
$output = Join-Path $repo 'assets\windows\DSH DeepSeek Harness Desktop.exe'

# Windows PowerShell 5.1 would prepend a UTF-8 BOM with `Set-Content -Encoding utf8`,
# which breaks JSON.parse on both consumers. Write UTF-8 without a BOM instead.
#
# Paths are resolved to absolute first: this script `Push-Location`s into
# `desktop-shell`, and .NET file APIs (`[System.IO.File]::WriteAllText`) resolve
# relative paths against the *process* working directory, which PowerShell's
# location does NOT follow. A relative `-OutputDirectory` would otherwise create
# the folder under desktop-shell and then fail to write into it.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Resolve-OutputPath([string]$Path) {
  $expanded = if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $repo $Path }
  return [System.IO.Path]::GetFullPath($expanded)
}
function Write-JsonFile([string]$Path, $Value) {
  [System.IO.File]::WriteAllText((Resolve-OutputPath $Path), ($Value | ConvertTo-Json -Depth 4), $utf8NoBom)
}

if ($env:OS -ne 'Windows_NT') {
  throw 'The dsh-dpx desktop launcher is built for Windows.'
}

if ($OutputDirectory) { $OutputDirectory = Resolve-OutputPath $OutputDirectory }

$shellPackage = Get-Content (Join-Path $shell 'package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $shellPackage.version }
$Version = $Version.Trim().TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+') { throw "Invalid desktop version: $Version" }

# Session-only toolchain activation; no user/system PATH is modified. On a machine
# with a local rustup install we select it explicitly instead of relying on a
# global default; on CI (or any machine with rustc on PATH) nothing is touched.
$localRust = 'D:\DevEnvs\Rust'
if (Test-Path (Join-Path $localRust '.rustup')) {
  $env:CARGO_HOME = Join-Path $localRust '.cargo'
  $env:RUSTUP_HOME = Join-Path $localRust '.rustup'
  $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
  $env:Path = "$(Join-Path $localRust '.cargo\bin');$env:Path"
}
if ($Proxy) {
  $env:HTTP_PROXY = $Proxy
  $env:HTTPS_PROXY = $Proxy
  $env:http_proxy = $Proxy
  $env:https_proxy = $Proxy
}
# Compiled into the binary so the running shell can report its own version.
$env:DPX_DESKTOP_VERSION = $Version

$assetName = "DSH-DeepSeek-Harness-Desktop-$Version-x64.exe"
$tag = "desktop-v$Version"

Push-Location $shell
try {
  if (-not (Test-Path 'node_modules')) { npm ci }
  npx tauri icon app-icon.png
  # Preserve the supplied Windows multi-resolution ICO as the executable icon.
  Copy-Item 'whale-app-icon.ico' 'src-tauri\icons\icon.ico' -Force
  npx tauri build --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }
  $built = 'src-tauri\target\release\dsh-dpx-desktop.exe'
  if (-not (Test-Path $built)) { throw "Missing build output: $built" }

  if (-not $SkipPackagedArtifact) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $output) | Out-Null
    Copy-Item $built $output -Force
    $digest = (Get-FileHash $output -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest = [ordered]@{
      schemaVersion = 1
      kind          = 'DPXDesktopRelease'
      channel       = 'desktop'
      version       = $Version
      tag           = $tag
      platform      = 'win32-x64'
      assetName     = "DSH DeepSeek Harness Desktop.exe"
      sha256        = $digest
      size          = (Get-Item $output).Length
      builtAt       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    Write-JsonFile (Join-Path $repo 'assets\windows\desktop-manifest.json') $manifest
    Write-Host "Packaged desktop launcher created: $output (v$Version, sha256 $digest)"  }

  if ($OutputDirectory) {
    New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
    $releaseAsset = Join-Path $OutputDirectory $assetName
    Copy-Item $built $releaseAsset -Force
    $digest = (Get-FileHash $releaseAsset -Algorithm SHA256).Hash.ToLowerInvariant()
    $releaseManifest = [ordered]@{
      schemaVersion = 1
      kind          = 'DPXDesktopRelease'
      channel       = 'desktop'
      version       = $Version
      tag           = $tag
      platform      = 'win32-x64'
      assetName     = $assetName
      # Relative on purpose: it resolves against the manifest URL, so the same
      # file works from `releases/latest/download/` and from a local folder.
      assetUrl      = $assetName
      sha256        = $digest
      size          = (Get-Item $releaseAsset).Length
      publishedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      notes         = "dsh-dpx desktop launcher $Version"
    }
    Write-JsonFile (Join-Path $OutputDirectory 'desktop-latest.json') $releaseManifest
    Write-Host "Release folder created: $OutputDirectory"
    Write-Host "  - $assetName"
    Write-Host "  - desktop-latest.json"
  }
} finally {
  Pop-Location
}
