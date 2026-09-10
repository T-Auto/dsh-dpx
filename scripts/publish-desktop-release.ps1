# Publish a prepared desktop release folder to GitHub Releases.
#
#   powershell -ExecutionPolicy Bypass -File scripts\publish-desktop-release.ps1 -Directory dist
#
# This is the local, inspectable alternative to the `release-desktop.yml`
# workflow: it never builds, it only verifies and uploads what is already in the
# folder. It requires an authenticated `gh` CLI and explicit approval, because it
# writes to the remote repository.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Directory,
  [string]$Repository = 'T-Auto/dsh-dpx',
  [switch]$Draft
)

$ErrorActionPreference = 'Stop'
$directory = (Resolve-Path $Directory).Path
$manifestPath = Join-Path $directory 'desktop-latest.json'
if (-not (Test-Path $manifestPath)) { throw "Missing release manifest: $manifestPath" }

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$asset = Join-Path $directory $manifest.assetName
if (-not (Test-Path $asset)) { throw "Missing release asset: $asset" }

$digest = (Get-FileHash $asset -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -ne $manifest.sha256) { throw "Digest mismatch: $digest != $($manifest.sha256)" }
if ((Get-Item $asset).Length -ne $manifest.size) { throw 'Size mismatch between the asset and the manifest.' }

$tag = if ($manifest.tag) { $manifest.tag } else { "desktop-v$($manifest.version)" }
gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'gh is not authenticated; run `gh auth login` first (this script never authenticates for you).' }

$arguments = @('release', 'create', $tag, '--repo', $Repository, '--title', "Desktop launcher $($manifest.version)", '--notes', "dsh-dpx desktop launcher $($manifest.version).")
if ($Draft) { $arguments += '--draft' }
Write-Host "Creating release $tag in $Repository with:"
Write-Host "  - $($manifest.assetName)"
Write-Host "  - desktop-latest.json"
& gh @arguments $asset $manifestPath
if ($LASTEXITCODE -ne 0) { throw "gh release create failed with exit code $LASTEXITCODE" }
Write-Host "Published $tag"
