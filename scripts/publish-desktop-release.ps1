# NOTE: this file is UTF-8 **with a BOM** on purpose. Windows PowerShell 5.1 decodes
# a BOM-less script as ANSI, which corrupts every Chinese operator message below and
# can even fail the parse. Do not save it back without the BOM.
#
# Publish a prepared desktop release folder to GitHub Releases in two auditable steps.
#
#   # Step 1 - create (or fill) a DRAFT release and write an upload receipt.
#   powershell -ExecutionPolicy Bypass -File scripts\publish-desktop-release.ps1 -Directory dist -Upload
#
#   # Step 2 - read the receipt back, re-verify every remote asset digest through
#   # the GitHub API, then publish the draft.
#   powershell -ExecutionPolicy Bypass -File scripts\publish-desktop-release.ps1 -Directory dist -Publish
#
# This is the local, inspectable alternative to the `release-desktop.yml` workflow:
# it never builds, it only verifies and uploads what is already in the folder. It
# requires an authenticated `gh` CLI and explicit approval, because it writes to the
# remote repository.
#
# A draft is NOT a publication. `gh release view` sees drafts too, so the
# immutability gate below tests `isDraft` instead of testing tag existence: a
# published release is left untouched, while a draft is the first half of this same
# two-step procedure. `gh release create --help` documents this order - create the
# release as a draft, upload the assets, then publish the release.
#
# The manifest is uploaded before the launcher so that a half-finished upload never
# looks like a complete feed, and the draft is invisible until step 2 anyway.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Directory,
  [string]$Repository = 'T-Auto/dsh-dpx',
  # Exactly one of these selects the step.
  [switch]$Upload,
  [switch]$Publish,
  # Release notes. Defaults to a one-liner naming the version.
  [string]$Notes,
  # Read the release notes from a file instead. Preferred for real notes:
  # multi-line text with quotes or asterisks does not survive being passed
  # through a command line.
  [string]$NotesFile,
  # Optional pre-publication signature check. Off by default: every manifest
  # published so far is unsigned, so requiring a signature by default would block
  # the existing flow. When this switch is present the manifest must carry a `sig`
  # that verifies against -PublicKey or DPX_DESKTOP_PUBLIC_KEY(S), or the step is
  # refused.
  [switch]$RequireSignature,
  # Public key for -RequireSignature: a PEM file path, a PEM block, or a base64
  # SPKI DER key (the single-line form `sign-desktop-manifest.mjs --generate-key`
  # writes to `desktop-release-pub.txt`). Defaults to DPX_DESKTOP_PUBLIC_KEY, then
  # to the public key shipped in assets\windows\. A public key is not a secret; the
  # private key never leaves the operator's offline machine and is never passed here.
  [string]$PublicKey,
  # Bounded retries for the network writes. Every attempt re-checks remote state,
  # so a retry after a partial upload re-uploads the missing assets.
  [int]$Attempts = 3
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ($Upload -eq $Publish) {
  throw '选择一步：-Upload（创建/补齐 draft 并写回执）或 -Publish（核对回执与远端摘要后发布）。两者互斥且必选其一。'
}

$directory = (Resolve-Path $Directory).Path
$manifestPath = Join-Path $directory 'desktop-latest.json'
if (-not (Test-Path $manifestPath)) { throw "缺少发布清单：$manifestPath" }

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$asset = Join-Path $directory $manifest.assetName
if (-not (Test-Path $asset)) { throw "缺少发布资产：$asset" }

$digest = (Get-FileHash $asset -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -ne $manifest.sha256) { throw "摘要不符：$digest != $($manifest.sha256)" }
if ((Get-Item $asset).Length -ne $manifest.size) { throw '资产与清单的大小不一致。' }

# Two release paths must never disagree about the bytes: the launcher inside the
# npm package (`assets\windows\*`, what `dpx desktop install` copies) and the one
# attached to the release. Building with `-SkipPackagedArtifact` is exactly how they
# drift apart, so refuse to publish a folder that does not match the packaged one.
$packagedManifestPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\windows\desktop-manifest.json'
if (-not (Test-Path $packagedManifestPath)) { throw "缺少包内清单：$packagedManifestPath" }
$packaged = Get-Content $packagedManifestPath -Raw | ConvertFrom-Json
if ($packaged.version -ne $manifest.version) {
  throw "包内清单是 v$($packaged.version)，发布清单是 v$($manifest.version)。先跑 npm run desktop:build（不要加 -SkipPackagedArtifact）重建两份。"
}
if ($packaged.sha256 -ne $manifest.sha256) {
  throw "包内清单与发布清单指向不同字节：packaged=$($packaged.sha256) release=$($manifest.sha256)。先跑 npm run desktop:build（不要加 -SkipPackagedArtifact），让同一次构建同时写出 assets\windows\* 和发布目录。"
}

$tag = if ($manifest.tag) { $manifest.tag } else { "desktop-v$($manifest.version)" }
$script:tag = $tag

function Resolve-PublicKey {
  # The distributable half of the key pair travels inside the npm package, so a
  # packaged key is used when nothing more explicit is given.
  param([string]$Key)
  if ($Key) { return $Key }
  if ($env:DPX_DESKTOP_PUBLIC_KEY) { return $env:DPX_DESKTOP_PUBLIC_KEY }
  $packaged = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\windows\desktop-release-pub.txt'
  if (Test-Path $packaged) { return $packaged }
  throw '缺少公钥：用 -PublicKey 指定、设置 DPX_DESKTOP_PUBLIC_KEY，或把公钥放到 assets\windows\desktop-release-pub.txt。'
}

function Assert-ManifestSignature {
  # Only runs when -RequireSignature was passed; without the switch no signature is
  # read, checked, or required, which keeps today's unsigned releases publishable.
  # Verification is the offline signing tool's own `--verify`, so the signed message
  # and the accepted key formats cannot drift from what `dpx` and the shell check.
  param([string]$ManifestPath, [string]$Key)
  $tool = Join-Path $PSScriptRoot 'sign-desktop-manifest.mjs'
  if (-not (Test-Path $tool)) { throw "找不到验签工具：$tool（它随 scripts/ 一起分发）。" }
  $resolved = Resolve-PublicKey -Key $Key
  if (Test-Path -LiteralPath $resolved) { $resolved = (Get-Content -LiteralPath $resolved -Raw).Trim() }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $report = & node $tool --verify --manifest $ManifestPath --public-key $resolved 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0) {
    throw "验签未通过（node 退出码 $code）：$($report -join ' ')。先离线跑 `node scripts/sign-desktop-manifest.mjs --manifest <清单> --key <私钥>` 重新签名并重新上传，再发布。"
  }
  Write-Host "验签通过：$($report -join ' ')"
}

function Get-ReleaseState {
  # $null means "no release for this tag at all". A draft is returned with
  # isDraft = true; only a published release is immutable.
  param([string]$Tag, [string]$Repo)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $stdout = & gh release view $Tag --repo $Repo --json isDraft,assets 2>$null
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0 -or -not $stdout) { return $null }
  return ($stdout -join "`n" | ConvertFrom-Json)
}

function Invoke-Gh {
  # Native stderr must not terminate the script under
  # `$ErrorActionPreference = 'Stop'`, so it is merged and echoed instead.
  param([string[]]$Arguments, [string]$Action)
  if ($Arguments -contains 'release' -and $Arguments -contains 'upload') {
    # Drafts are mutable by design, and a published release is refused earlier, so
    # a re-run can safely replace a partially uploaded asset.
    if ($Arguments -notcontains '--clobber') { $Arguments += '--clobber' }
  }
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & gh @Arguments 2>&1 } finally { $ErrorActionPreference = $previous }
    $output | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -eq 0) { return }
    $code = $LASTEXITCODE
    # gh's own words go into the failure: a step that dies inside a script shows
    # only "exit code 1" in the checks UI, and the reason has to travel with it.
    $detail = (@($output | Select-Object -Last 6) -join ' | ')
    if ($attempt -eq $Attempts) {
      throw "$Action 失败（gh 退出码 $code，已尝试 $Attempts 次）：$detail。下一步：先只读核对远端状态 gh release view $script:tag --repo $Repository --json isDraft,assets；若已有 draft 就直接重跑 -Upload（会补齐缺失资产），若已发布则不要再动它，改为升版本号。"
    }
    Write-Warning "$Action 第 $attempt 次失败（gh 退出码 $code），$($attempt * 3) 秒后重试。"
    Start-Sleep -Seconds ($attempt * 3)
  }
}

# The manifest first, then the launcher, then any SBOM. A published release's
# assets cannot be added afterwards, so the SBOM has to be part of this list.
$sbomFiles = @(Get-ChildItem -Path $directory -Filter 'desktop-*.spdx.json' -File | Sort-Object Name | ForEach-Object { $_.FullName })
$uploadOrder = @($manifestPath, $asset) + $sbomFiles

# Everything below this line is local and network-free, so a bad signature or a
# missing receipt fails before anything talks to GitHub - and always before the
# draft is flipped live.
if ($RequireSignature) { Assert-ManifestSignature -ManifestPath $manifestPath -Key $PublicKey }

$receiptPath = Join-Path $directory 'desktop-upload-receipt.json'
$receipt = $null
if ($Publish) {
  if (-not (Test-Path $receiptPath)) { throw "缺少上传回执：$receiptPath。先跑 -Upload。" }
  $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
  if ($receipt.tag -ne $tag) { throw "回执属于 $($receipt.tag)，不是 $tag。不要用旧回执发布新版本。" }
  if ($receipt.repository -ne $Repository) { throw "回执属于 $($receipt.repository)，不是 $Repository。" }
  # The receipt is evidence only if the local bytes still match what it recorded.
  foreach ($entry in @($receipt.files)) {
    $path = Join-Path $directory $entry.name
    if (-not (Test-Path $path)) { throw "回执记录了 $($entry.name)，但它在 $directory 里不存在。" }
    $current = (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($current -ne $entry.sha256 -or (Get-Item $path).Length -ne $entry.size) {
      throw "本地资产 $($entry.name) 在上传后已变化，回执失效。重新跑 -Upload 生成新回执。"
    }
  }
}

# Read the auth state with stderr merged and under `Continue`. `gh` reports its
# credential source on stderr ("The value of the GH_TOKEN environment variable is
# being used for authentication"), and this script runs under
# `$ErrorActionPreference = 'Stop'`, where a native command's stderr is not
# something to ignore. The check stays a gate, but it no longer decides the run by
# side effect - the working release flow before it simply called gh and looked at
# the exit code.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { $auth = & gh auth status 2>&1 } finally { $ErrorActionPreference = $previous }
if ($LASTEXITCODE -ne 0) {
  throw "gh 未登录（$($auth -join ' ')）。在 CI 里把 github.token 作为 GH_TOKEN 传给这一步；在本地先跑 gh auth login（本脚本从不替你登录）。"
}
$auth | ForEach-Object { Write-Host $_ }

if ($Upload) {
  $state = Get-ReleaseState -Tag $tag -Repo $Repository
  if ($state -and -not $state.isDraft) {
    Write-Host "::notice title=Already published::$tag 已经是已发布 release，资产保持原样，不做任何修改。"
    $state.assets | ForEach-Object { Write-Host "  $($_.name)  $($_.digest)" }
    Write-Host "要发布新内容请升版本号（绝不复用已发布版本）。"
    exit 0
  }

  if ($state) {
    Write-Host "已存在 draft release $tag，补齐缺失资产。"
  } else {
    $arguments = @('release', 'create', $tag, '--repo', $Repository, '--draft', '--verify-tag', '--title', "Desktop launcher $($manifest.version)")
    if ($NotesFile) {
      # Hand the file to gh rather than its contents: a command line mangles
      # multi-line notes (quotes, asterisks, newlines).
      if (-not (Test-Path -LiteralPath $NotesFile)) { throw "缺少 notes 文件：$NotesFile" }
      $arguments += @('--notes-file', (Resolve-Path -LiteralPath $NotesFile).Path)
    } else {
      $notes = if ($Notes) { $Notes } else { "dsh-dpx desktop launcher $($manifest.version)." }
      $arguments += @('--notes', $notes)
    }
    # --verify-tag refuses to invent a tag from the default branch, so a release can
    # only ever describe a commit the operator actually pushed.
    Invoke-Gh -Arguments $arguments -Action "创建 draft release $tag（tag 必须已推送到远端，否则先 git push origin $tag）"
  }

  foreach ($file in $uploadOrder) {
    $name = Split-Path -Leaf $file
    Invoke-Gh -Arguments @('release', 'upload', $tag, $file, '--repo', $Repository) -Action "上传 $name"
    Write-Host "已上传 $name"
  }

  $receipt = [ordered]@{
    schemaVersion = 1
    kind          = 'DPXDesktopUploadReceipt'
    repository    = $Repository
    tag           = $tag
    version       = $manifest.version
    uploadedAt    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    files         = @($uploadOrder | ForEach-Object {
        [ordered]@{
          name   = Split-Path -Leaf $_
          sha256 = (Get-FileHash $_ -Algorithm SHA256).Hash.ToLowerInvariant()
          size   = (Get-Item $_).Length
        }
      })
  }
  [System.IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 4), $utf8NoBom)
  Write-Host "上传回执（本地证据，不作为发布资产）：$receiptPath"
  Write-Host "下一步：核对远端后跑 -Publish -Directory $Directory"
  exit 0
}

# -Publish: the receipt and the local bytes were already validated above.
$state = Get-ReleaseState -Tag $tag -Repo $Repository
if (-not $state) { throw "远端没有 $tag 的 release，先跑 -Upload。" }
if (-not $state.isDraft) {
  Write-Host "::notice title=Already published::$tag 已经是已发布 release，不再改动。"
  exit 0
}

# Publication authorization: the draft is only flipped when every remote asset is
# byte-identical to what the receipt recorded. A missing receipt or a digest
# mismatch refuses publication instead of publishing unverified bytes.
foreach ($entry in @($receipt.files)) {
  $remote = $state.assets | Where-Object { $_.name -eq $entry.name } | Select-Object -First 1
  if (-not $remote) { throw "远端缺少资产 $($entry.name)。重跑 -Upload 补齐后再发布。" }
  if ($remote.state -and $remote.state -ne 'uploaded') { throw "远端资产 $($entry.name) 状态是 $($remote.state)，还未上传完成。" }
  if ([int64]$remote.size -ne [int64]$entry.size) { throw "远端 $($entry.name) 大小不符：remote=$($remote.size) receipt=$($entry.size)" }
  if (-not $remote.digest) { throw "GitHub 没有返回 $($entry.name) 的 digest，无法复核（需要 gh 2.50+）。请手动核对远端摘要后再决定是否发布。" }
  if ($remote.digest -ne "sha256:$($entry.sha256)") {
    throw "远端 $($entry.name) 摘要不符：remote=$($remote.digest) 本地=sha256:$($entry.sha256)。不要发布，先查清远端那份是什么。"
  }
  Write-Host "远端已核对：$($entry.name)  sha256:$($entry.sha256)"
}

# --latest keeps the constant feed address truthful: `releases/latest` ignores
# drafts and pre-releases and picks by creation date, and publishing a draft keeps
# the draft's older creation date.
Invoke-Gh -Arguments @('release', 'edit', $tag, '--repo', $Repository, '--draft=false', '--latest') -Action "发布 $tag"
Write-Host "已发布 $tag（草稿转正式，资产不可再改）"
