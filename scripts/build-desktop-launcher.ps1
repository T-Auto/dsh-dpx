[CmdletBinding()]
param(
  # Artifact version. Defaults to `desktop-shell/package.json`.
  [string]$Version,
  # Also write a publishable release folder (versioned EXE + desktop-latest.json).
  [string]$OutputDirectory,
  # Skip refreshing `assets\windows`, useful when building an older demo artifact.
  # Never use this for a release: the packaged manifest is what `dpx desktop
  # install` copies out of the npm package, and `publish-desktop-release.ps1`
  # refuses to publish a folder that does not match it.
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

# Three source manifests also declare this version: `package.json` (the npm side),
# `Cargo.toml` (the crate, and what a plain `cargo build` reports) and
# `tauri.conf.json` (the Windows file properties). `-Version` is passed in, so
# bumping only one of them would silently produce an EXE whose own version
# disagrees with the manifest that installs it. Refuse that artifact.
#
# `-SkipPackagedArtifact` builds a local demo of an older version and writes no
# packaged manifest, so it warns instead of throwing: there is nothing to publish
# and therefore nothing for the mismatch to mislead.
$manifestVersions = [ordered]@{
  'desktop-shell/package.json'              = [string]$shellPackage.version
  'desktop-shell/src-tauri/Cargo.toml'      = [string]((Select-String -Path (Join-Path $shell 'src-tauri\Cargo.toml') -Pattern '^\s*version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches[0].Groups[1].Value)
  'desktop-shell/src-tauri/tauri.conf.json' = [string]((Get-Content (Join-Path $shell 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version)
}
$mismatched = @($manifestVersions.GetEnumerator() | Where-Object { $_.Value -ne $Version })
if ($mismatched.Count -gt 0) {
  $detail = ($mismatched | ForEach-Object { "$($_.Key) declares '$($_.Value)'" }) -join '; '
  if ($SkipPackagedArtifact) {
    Write-Warning "Building v$Version while $detail. This is only safe because -SkipPackagedArtifact writes no packaged manifest."
  } else {
    throw "Desktop version '$Version' does not match the source manifests: $detail. Bump every manifest before building, or pass -SkipPackagedArtifact for a local demo build."
  }
}

# Session-only toolchain activation; no user/system PATH is modified. On a machine
# with a local rustup install we select it explicitly instead of relying on a
# global default; on CI (or any machine with rustc on PATH) nothing is touched.
$localRust = 'D:\DevEnvs\Rust'
if (Test-Path (Join-Path $localRust '.rustup')) {
  $env:CARGO_HOME = Join-Path $localRust '.cargo'
  $env:RUSTUP_HOME = Join-Path $localRust '.rustup'
  $env:Path = "$(Join-Path $localRust '.cargo\bin');$env:Path"
}

# `RUSTUP_TOOLCHAIN` wins over `rust-toolchain.toml`, so setting a channel here by
# hand would silently make that file decorative. Read the pin instead, and leave
# the environment untouched when there is no file to read.
$toolchainFile = Join-Path $shell 'src-tauri\rust-toolchain.toml'
if (Test-Path $toolchainFile) {
  $channel = Select-String -Path $toolchainFile -Pattern '^\s*channel\s*=\s*"([^"]+)"' | Select-Object -First 1
  if ($channel) {
    $env:RUSTUP_TOOLCHAIN = $channel.Matches[0].Groups[1].Value
    Write-Host "Rust toolchain pinned by rust-toolchain.toml: $env:RUSTUP_TOOLCHAIN"
  } else {
    Write-Warning "$toolchainFile has no [toolchain] channel; leaving RUSTUP_TOOLCHAIN unset."
  }
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
