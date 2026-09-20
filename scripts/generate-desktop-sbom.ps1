# NOTE: this file is UTF-8 **with a BOM** on purpose. Windows PowerShell 5.1 decodes
# a BOM-less script as ANSI, which corrupts the Chinese operator messages below.
# Do not save it back without the BOM.
#
# Generate an SPDX 2.3 JSON SBOM for a prepared desktop release folder.
#
#   powershell -ExecutionPolicy Bypass -File scripts\generate-desktop-sbom.ps1 -ReleaseDirectory dist
#
# The payload is one Windows executable plus its manifest, with no bundled
# third-party tree, so this SBOM is:
#   - a file inventory with the SHA-256 of every published file, and
#   - the exact locked dependency set the launcher was built from and built with:
#     `desktop-shell/src-tauri/Cargo.lock` (the Tauri/Rust crate graph) and
#     `desktop-shell/package-lock.json` (the CLI that drove the build).
#
# The file is written into the release folder so `release-desktop.yml` can attach it
# as an asset. That has to happen before the release is published: a release's
# assets are immutable afterwards, so an asset missing from the upload list can
# never be added later.

[CmdletBinding()]
param(
  [string]$ReleaseDirectory = 'dist',
  # Defaults to the manifest's version. Only used to name the file.
  [string]$Version,
  # Defaults to `<ReleaseDirectory>\desktop-<version>.spdx.json`.
  [string]$OutputPath,
  [string]$Repository = 'T-Auto/dsh-dpx'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$directory = (Resolve-Path $ReleaseDirectory).Path
$manifestPath = Join-Path $directory 'desktop-latest.json'
if (-not (Test-Path $manifestPath)) { throw "缺少发布清单：$manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $manifest.version }
if (-not $Version) { throw '发布清单没有 version，无法给 SBOM 命名。' }
if (-not $OutputPath) { $OutputPath = Join-Path $directory "desktop-$Version.spdx.json" }

function ConvertTo-SpdxId {
  # SPDX identifiers allow letters, digits, `.` and `-` only.
  param([string]$Value, [string]$Prefix)
  $safe = ($Value -replace '[^A-Za-z0-9.\-]', '-')
  return "$Prefix-$safe"
}

function Get-CargoPackages([string]$LockPath) {
  if (-not (Test-Path $LockPath)) { return @() }
  $packages = @()
  $current = $null
  foreach ($line in Get-Content $LockPath) {
    if ($line -match '^\[\[package\]\]') {
      if ($current -and $current.name) { $packages += $current }
      $current = [ordered]@{ name = ''; version = '' }
      continue
    }
    if ($null -eq $current) { continue }
    if ($line -match '^\s*name\s*=\s*"([^"]+)"') { $current.name = $Matches[1] }
    elseif ($line -match '^\s*version\s*=\s*"([^"]+)"') { $current.version = $Matches[1] }
    elseif ($line -match '^\[') {
      if ($current.name) { $packages += $current }
      $current = $null
    }
  }
  if ($current -and $current.name) { $packages += $current }
  return $packages
}

function Get-NpmPackages([string]$LockPath) {
  if (-not (Test-Path $LockPath)) { return @() }
  # Read this one through Node: a v3 npm lockfile has an empty-string root key
  # ("packages": { "": {...} }), and Windows PowerShell 5.1's ConvertFrom-Json
  # rejects an empty property name outright. Node is already required by
  # `scripts/sign-desktop-manifest.mjs`, so this adds no new dependency.
  $query = @'
const lock = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const entries = new Map();
for (const [key, value] of Object.entries(lock.packages ?? {})) {
  if (!key) continue;
  const name = value.name ?? key.replace(/^.*node_modules\//, '');
  const version = value.version;
  if (!name || !version) continue;
  entries.set(`${name}@${version}`, { name, version });
}
process.stdout.write(JSON.stringify([...entries.values()]));
'@
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $json = & node -e $query $LockPath 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0) { throw "读取 npm 锁定依赖失败（node 退出码 $code，需要 PATH 上有 node）：$json" }
  return @($json | ConvertFrom-Json)
}

$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$launcherDigest = (Get-FileHash (Join-Path $directory $manifest.assetName) -Algorithm SHA256).Hash.ToLowerInvariant()

# --- Files: every published file except this SBOM and the local upload receipt,
# which is operator evidence and never an asset.
$fileEntries = @()
$relationships = @()
foreach ($file in (Get-ChildItem -Path $directory -File | Sort-Object Name)) {
  if ($file.Name -like '*.spdx.json' -or $file.Name -eq 'desktop-upload-receipt.json') { continue }
  $sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $id = ConvertTo-SpdxId -Value $file.Name -Prefix 'SPDXRef-File'
  $fileEntries += [ordered]@{
    SPDXID           = $id
    fileName         = "./$($file.Name)"
    checksums        = @([ordered]@{ algorithm = 'SHA256'; checksumValue = $sha256 })
    licenseConcluded = 'NOASSERTION'
    copyrightText    = 'NOASSERTION'
    comment          = "$($file.Length) bytes"
  }
  $relationships += [ordered]@{ spdxElementId = 'SPDXRef-Package-dsh-dpx-desktop'; relationshipType = 'CONTAINS'; relatedSpdxElement = $id }
}

# --- Packages: the launcher itself plus the locked dependency sets.
$packageEntries = @()
$packageEntries += [ordered]@{
  SPDXID             = 'SPDXRef-Package-dsh-dpx-desktop'
  name               = 'dsh-dpx-desktop'
  versionInfo        = [string]$Version
  downloadLocation   = "https://github.com/$Repository/releases/download/desktop-v$Version/$($manifest.assetName)"
  filesAnalyzed      = $false
  licenseConcluded   = 'NOASSERTION'
  licenseDeclared    = 'NOASSERTION'
  copyrightText      = 'NOASSERTION'
  comment            = "Windows x64 desktop launcher for dsh-dpx. sha256 $launcherDigest."
  externalRefs       = @([ordered]@{
      referenceCategory = 'PACKAGE-MANAGER'
      referenceType     = 'purl'
      referenceLocator  = "pkg:generic/dsh-dpx-desktop@$Version"
    })
}
$relationships += [ordered]@{ spdxElementId = 'SPDXRef-DOCUMENT'; relationshipType = 'DESCRIBES'; relatedSpdxElement = 'SPDXRef-Package-dsh-dpx-desktop' }

$dependencyIds = @()
$cargoPackages = Get-CargoPackages (Join-Path $repo 'desktop-shell\src-tauri\Cargo.lock')
foreach ($crate in ($cargoPackages | Sort-Object { "$($_.name)@$($_.version)" })) {
  $id = ConvertTo-SpdxId -Value "cargo-$($crate.name)-$($crate.version)" -Prefix 'SPDXRef-Package'
  $dependencyIds += $id
  $packageEntries += [ordered]@{
    SPDXID           = $id
    name             = $crate.name
    versionInfo      = $crate.version
    downloadLocation = "https://crates.io/api/v1/crates/$($crate.name)/$($crate.version)/download"
    filesAnalyzed    = $false
    licenseConcluded = 'NOASSERTION'
    licenseDeclared  = 'NOASSERTION'
    copyrightText    = 'NOASSERTION'
    externalRefs     = @([ordered]@{
        referenceCategory = 'PACKAGE-MANAGER'
        referenceType     = 'purl'
        referenceLocator  = "pkg:cargo/$($crate.name)@$($crate.version)"
      })
  }
}

$npmPackages = Get-NpmPackages (Join-Path $repo 'desktop-shell\package-lock.json')
$seen = @{}
foreach ($module in ($npmPackages | Sort-Object { "$($_.name)@$($_.version)" })) {
  $key = "$($module.name)@$($module.version)"
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  $id = ConvertTo-SpdxId -Value "npm-$($module.name)-$($module.version)" -Prefix 'SPDXRef-Package'
  $dependencyIds += $id
  $tarballBase = ($module.name -replace '^@[^/]+/', '')
  $packageEntries += [ordered]@{
    SPDXID           = $id
    name             = $module.name
    versionInfo      = $module.version
    downloadLocation = "https://registry.npmjs.org/$($module.name)/-/$tarballBase-$($module.version).tgz"
    filesAnalyzed    = $false
    licenseConcluded = 'NOASSERTION'
    licenseDeclared  = 'NOASSERTION'
    copyrightText    = 'NOASSERTION'
    externalRefs     = @([ordered]@{
        referenceCategory = 'PACKAGE-MANAGER'
        referenceType     = 'purl'
        referenceLocator  = "pkg:npm/$($module.name)@$($module.version)"
      })
  }
}

foreach ($id in $dependencyIds) {
  $relationships += [ordered]@{ spdxElementId = 'SPDXRef-Package-dsh-dpx-desktop'; relationshipType = 'DEPENDS_ON'; relatedSpdxElement = $id }
}

$spdx = [ordered]@{
  spdxVersion       = 'SPDX-2.3'
  dataLicense       = 'CC0-1.0'
  SPDXID            = 'SPDXRef-DOCUMENT'
  name              = "dsh-dpx-desktop-$Version"
  documentNamespace = "https://github.com/$Repository/spdx/desktop-v$Version-$($launcherDigest.Substring(0, 16))"
  creationInfo      = [ordered]@{
    created  = $now
    creators = @('Tool: dsh-dpx/scripts/generate-desktop-sbom.ps1')
    comment  = 'Inventory of the published files with SHA-256 digests, plus the locked Cargo and npm dependency sets the launcher was built from and with. Dependency licenses were not resolved by this generator.'
  }
  packages          = $packageEntries
  files             = $fileEntries
  relationships     = $relationships
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputPath, ($spdx | ConvertTo-Json -Depth 8), $utf8NoBom)

Write-Host "SBOM 已写入：$OutputPath"
Write-Host "  文件 $($fileEntries.Count) 个；包 $($packageEntries.Count) 个（cargo $($cargoPackages.Count)、npm $($seen.Count)）"
Write-Host "  把它作为发布资产一起上传：发布后再补资产是不可能的。"
