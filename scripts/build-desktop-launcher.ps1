[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$shell = Join-Path $repo 'desktop-shell'
$output = Join-Path $repo 'assets\windows\DSH DeepSeek Harness Desktop.exe'

if ($env:OS -ne 'Windows_NT') {
  throw 'The dsh-dpx desktop launcher is built for Windows.'
}

# Session-only toolchain activation; no user/system PATH is modified.
$env:CARGO_HOME = 'D:\DevEnvs\Rust\.cargo'
$env:RUSTUP_HOME = 'D:\DevEnvs\Rust\.rustup'
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
$env:Path = "D:\DevEnvs\Rust\.cargo\bin;$env:Path"
# The toolchain is installed already; selecting it explicitly keeps this script
# independent of a rustup global default.
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:http_proxy = $env:HTTP_PROXY
$env:https_proxy = $env:HTTPS_PROXY

Push-Location $shell
try {
  npm ci
  npx tauri icon app-icon.png
  # Preserve the supplied Windows multi-resolution ICO as the executable icon.
  Copy-Item 'whale-app-icon.ico' 'src-tauri\icons\icon.ico' -Force
  $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
  npx tauri build --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }
  New-Item -ItemType Directory -Force (Split-Path -Parent $output) | Out-Null
  Copy-Item 'src-tauri\target\release\dsh-dpx-desktop.exe' $output -Force
} finally {
  Pop-Location
}

Write-Host "Desktop launcher created: $output"
