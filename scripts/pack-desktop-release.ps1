# Package the desktop launcher that is already in `assets\windows` into a
# publishable release folder, WITHOUT rebuilding.
#
#   powershell -ExecutionPolicy Bypass -File scripts\pack-desktop-release.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\pack-desktop-release.ps1 -OutputDirectory out
#
# This is the "release exactly the artifact that was verified" path: it only
# copies and hashes, so the published EXE is byte-identical to the one tested.
# Use `build-desktop-launcher.ps1 -OutputDirectory` when you do want a fresh build.

[CmdletBinding()]
param(
  [string]$OutputDirectory = 'dist',
  # Release owner/repo, used to build the GitHub asset URL. Left relative by
  # default so the manifest also works from a local folder.
  [string]$Repository = 'T-Auto/dsh-dpx',
  [switch]$AbsoluteAssetUrl
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'assets\windows\DSH DeepSeek Harness Desktop.exe'
$manifestSource = Join-Path $repo 'assets\windows\desktop-manifest.json'

if (-not (Test-Path $source)) { throw "Missing packaged launcher: $source" }
if (-not (Test-Path $manifestSource)) { throw "Missing packaged manifest: $manifestSource" }

$packaged = Get-Content $manifestSource -Raw | ConvertFrom-Json
$version = $packaged.version
if (-not $version) { throw 'The packaged manifest has no version; rebuild with build-desktop-launcher.ps1.' }

$digest = (Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($packaged.sha256 -and $packaged.sha256 -ne $digest) {
  throw "Packaged manifest is stale: manifest=$($packaged.sha256) file=$digest. Re-run build-desktop-launcher.ps1."
}

$tag = "desktop-v$version"
$assetName = "DSH-DeepSeek-Harness-Desktop-$version-x64.exe"
$target = Join-Path $repo $OutputDirectory
New-Item -ItemType Directory -Force $target | Out-Null
$assetPath = Join-Path $target $assetName
Copy-Item $source $assetPath -Force

$assetUrl = $assetName
if ($AbsoluteAssetUrl) {
  $assetUrl = "https://github.com/$Repository/releases/download/$tag/$assetName"
}

$manifest = [ordered]@{
  schemaVersion = 1
  kind          = 'DPXDesktopRelease'
  channel       = 'desktop'
  version       = $version
  tag           = $tag
  platform      = 'win32-x64'
  assetName     = $assetName
  assetUrl      = $assetUrl
  sha256        = $digest
  size          = (Get-Item $assetPath).Length
  publishedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  notes         = "dsh-dpx desktop launcher $version"
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $target 'desktop-latest.json'), ($manifest | ConvertTo-Json -Depth 4), $utf8NoBom)

Write-Host "Release folder: $target"
Write-Host "  - $assetName  ($($manifest.size) bytes, sha256 $digest)"
Write-Host "  - desktop-latest.json  (tag $tag)"
