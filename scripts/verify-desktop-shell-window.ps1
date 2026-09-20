# Verify the desktop launcher's window lifecycle against a real executable.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-desktop-shell-window.ps1 `
#     -Launcher "assets\windows\DSH DeepSeek Harness Desktop.exe"
#
# Why this script exists
# ----------------------
# `tao` caches a window's visibility in its own `WindowFlags` and *skips* the
# `ShowWindow` call when the cached value already matches the request. This shell
# changes the real Win32 visibility behind that cache on purpose: a second launch
# of the same environment restores the already-running window with a raw
# `ShowWindow`/`SetForegroundWindow` pair from another process
# (`instance::focus_existing`). The cache then says "hidden" while Windows says
# "visible", and every later `WebviewWindow::hide()` becomes a silent no-op —
# the title-bar X logs "minimized to the notification area" and does nothing,
# on every click, until some unrelated code path calls a tao `show()` again.
#
# No Rust unit test can see that: it needs a real window, a real second process
# and the real Win32 state. So this script drives the packaged EXE.
#
# The launcher is pointed at a **scratch environment root** through
# DSH_DESKTOP_ENV, so nothing here touches a running environment, its DSH_HOME or
# its DSH session. `npm-prefix` is a directory junction to the launcher's own
# environment, which keeps the DSH child discoverable without copying it.
#
# Checks
#   1. the main window appears and the UI thread answers;
#   2. the title-bar X (WM_CLOSE) hides the window to the notification area;
#   3. a second launch of the same environment restores that window (the real
#      focus_existing path, i.e. the trigger of the desync);
#   4. the X hides it again                       <- 0.2.6 fails here
#   5. the UI thread answers throughout (no "not responding");
#   6. "close = exit" stops the DSH child tree and the launcher in time.
#
# Exit code 0 means every check passed.

[CmdletBinding()]
param(
  # The launcher executable to verify. Defaults to the packaged artifact.
  [string]$Launcher = (Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\windows\DSH DeepSeek Harness Desktop.exe'),
  # Directory to create the scratch environment in. Defaults to a temp folder.
  [string]$ScratchRoot,
  # Environment whose `npm-prefix` the scratch root links to, so the launcher
  # finds a real DSH and starts a real child. Defaults to the environment the
  # launcher itself lives in.
  [string]$EnvironmentSource,
  # Seconds to wait for the launcher's window to appear.
  [int]$StartupTimeoutSeconds = 90,
  # Seconds to wait for a window transition after a close request.
  [int]$TransitionTimeoutSeconds = 10,
  # Keep the scratch environment (and its shell.log) for inspection.
  [switch]$KeepScratch
)

$ErrorActionPreference = 'Stop'

$launcherPath = (Resolve-Path -LiteralPath $Launcher).Path
$launcherDirectory = Split-Path -Parent $launcherPath
# The launcher lives in <env-root>\desktop\, so its environment is one level up.
$environmentRoot = Split-Path -Parent $launcherDirectory
if (-not $EnvironmentSource) { $EnvironmentSource = $environmentRoot }
if (Test-Path -LiteralPath $EnvironmentSource) {
  $EnvironmentSource = (Resolve-Path -LiteralPath $EnvironmentSource).Path
}

if (-not $ScratchRoot) {
  $ScratchRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dpx-shell-window-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
}
$ScratchRoot = [System.IO.Path]::GetFullPath($ScratchRoot)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DpxWindowCheck {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  public const uint WM_CLOSE = 0x0010;
  public const uint WM_NULL = 0x0000;
  public const uint SMTO_ABORTIFHUNG = 0x0002;
  public static bool Responds(IntPtr h, uint milliseconds) {
    IntPtr result;
    return SendMessageTimeoutW(h, WM_NULL, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, milliseconds, out result) != IntPtr.Zero;
  }
  public static void Close(IntPtr h) { PostMessageW(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }
  public static string Title(IntPtr h) {
    var text = new StringBuilder(512);
    GetWindowTextW(h, text, 512);
    return text.ToString();
  }
  public static string ClassName(IntPtr h) {
    var text = new StringBuilder(512);
    GetClassNameW(h, text, 512);
    return text.ToString();
  }
  // A Tauri process owns several top-level windows: the real one (class
  // "Tauri Window"), tao's "Tao Thread Event Target" pump, the tray icon window
  // and IME helpers. Process.MainWindowHandle is documented to return the first
  // *visible* one, and "Tao Thread Event Target" is visible too — sending
  // WM_CLOSE there is silently ignored, so a check run built on it measures
  // nothing at all. Select by class instead.
  public static IntPtr FindMainWindow(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != target) { return true; }
      if (ClassName(h) != "Tauri Window") { return true; }
      if (!IsWindowVisible(h)) { return true; }
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
  /// Every top-level window of the process, for failure diagnostics.
  public static string[] DescribeProcess(uint target) {
    var lines = new List<string>();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == target) {
        lines.Add(string.Format("hwnd={0} class='{1}' visible={2} title='{3}'", h, ClassName(h), IsWindowVisible(h), Title(h)));
      }
      return true;
    }, IntPtr.Zero);
    return lines.ToArray();
  }
}
'@

$script:results = New-Object System.Collections.Generic.List[object]
function Test-Check {
  param([string]$Name, [bool]$Passed, [string]$Detail = '')
  $script:results.Add([pscustomobject]@{ Check = $Name; Result = $(if ($Passed) { 'PASS' } else { 'FAIL' }); Detail = $Detail })
  $colour = if ($Passed) { 'Green' } else { 'Red' }
  Write-Host ("  [{0}] {1}{2}" -f $(if ($Passed) { 'PASS' } else { 'FAIL' }), $Name, $(if ($Detail) { " — $Detail" } else { '' })) -ForegroundColor $colour
}

function Get-LauncherProcess {
  param([int]$ProcessId)
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($process) { $process.Refresh() }
  return $process
}

function Get-MainWindowHandle {
  # Strict: only the real window counts. The framework's own MainWindowHandle is
  # NOT a fallback here — tao's visible "Tao Thread Event Target" pump window
  # exists before the real window is shown, so falling back early latches the
  # whole run onto a window that ignores WM_CLOSE.
  param([int]$ProcessId)
  return [DpxWindowCheck]::FindMainWindow([uint32]$ProcessId)
}

function Get-WindowInventory {
  param([int]$ProcessId)
  return @([DpxWindowCheck]::DescribeProcess([uint32]$ProcessId))
}

function Wait-For {
  param([scriptblock]$Condition, [int]$TimeoutSeconds, [int]$IntervalMilliseconds = 200)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds $IntervalMilliseconds
  }
  return [bool](& $Condition)
}

function Wait-ForWindowState {
  param([IntPtr]$Handle, [bool]$Visible, [int]$TimeoutSeconds)
  return Wait-For -TimeoutSeconds $TimeoutSeconds -Condition {
    if (-not [DpxWindowCheck]::IsWindow($Handle)) { return $false }
    return ([DpxWindowCheck]::IsWindowVisible($Handle) -eq $Visible)
  }
}

function Read-ShellLog {
  param([string]$Root)
  $path = Join-Path $Root 'desktop-state\shell.log'
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  return @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)
}

function Get-LogCount {
  param([string[]]$Lines, [string]$Pattern)
  return @($Lines | Where-Object { $_ -match $Pattern }).Count
}

function Get-DshChildId {
  param([string[]]$Lines)
  $match = $Lines | Where-Object { $_ -match 'spawned DSH \(pid (\d+)\)' } | Select-Object -Last 1
  if ($match -and $match -match 'spawned DSH \(pid (\d+)\)') { return [int]$Matches[1] }
  return 0
}

function Remove-Junction {
  # `Remove-Item -Recurse` can follow a junction into its target; rmdir never does.
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) {
    & cmd.exe /c rmdir "$Path" 2>&1 | Out-Null
  }
}

function Stop-ScratchEnvironment {
  param([string]$Root, [int]$ProcessId)
  if ($ProcessId) {
    $process = Get-LauncherProcess -ProcessId $ProcessId
    if ($process) { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Milliseconds 500
  # The launcher's job object kills the DSH child tree with it.
  $childId = Get-DshChildId -Lines (Read-ShellLog -Root $Root)
  if ($childId) {
    $child = Get-Process -Id $childId -ErrorAction SilentlyContinue
    if ($child) { Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue }
  }
}

function New-ScratchEnvironment {
  param([string]$Root, [string]$SourceEnvironmentRoot)
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  # The full dpx layout, not just the two directories the launcher writes: the
  # DSH child is handed TEMP/TMP/APPDATA/… below this root and fails to boot if
  # they are missing (dsh-spill-local needs `<root>\tmp` before it can start).
  foreach ($relative in @(
      'desktop-state', 'dsh-home', 'agents-home', 'home', 'home\Desktop', 'tmp',
      'appdata', 'localappdata', 'xdg-config', 'xdg-cache', 'xdg-data', 'workspace')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $relative) | Out-Null
  }

  $sourcePrefix = Join-Path $SourceEnvironmentRoot 'npm-prefix'
  $targetPrefix = Join-Path $Root 'npm-prefix'
  if (Test-Path -LiteralPath $sourcePrefix) {
    New-Item -ItemType Junction -Path $targetPrefix -Target $sourcePrefix | Out-Null
  } else {
    New-Item -ItemType Directory -Force -Path $targetPrefix | Out-Null
  }
  Write-CloseAction -Root $Root -Action 'tray'
}

function Write-CloseAction {
  param([string]$Root, [string]$Action)
  $settings = [ordered]@{
    schemaVersion   = 1
    closeAction     = $Action
    trayEnabled     = $true
    autoCheckUpdates = $false
  }
  $json = $settings | ConvertTo-Json -Depth 4
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText((Join-Path $Root 'desktop-state\settings.json'), $json, $utf8NoBom)
}

function Start-Launcher {
  param([string]$Launcher, [string]$Root)
  $env:DSH_DESKTOP_ENV = $Root
  try {
    return Start-Process -FilePath $Launcher -PassThru
  } finally {
    Remove-Item Env:\DSH_DESKTOP_ENV -ErrorAction SilentlyContinue
  }
}

Write-Host "launcher          : $launcherPath"
Write-Host "environment root  : $environmentRoot"
Write-Host "package source    : $EnvironmentSource"
Write-Host "scratch root      : $ScratchRoot"
Write-Host ""

$primary = $null
try {
  New-ScratchEnvironment -Root $ScratchRoot -SourceEnvironmentRoot $EnvironmentSource

  Write-Host '1. start the launcher'
  $primary = Start-Launcher -Launcher $launcherPath -Root $ScratchRoot
  $appeared = Wait-For -TimeoutSeconds $StartupTimeoutSeconds -Condition {
    return ((Get-MainWindowHandle -ProcessId $primary.Id) -ne [IntPtr]::Zero)
  }
  $windowHandle = Get-MainWindowHandle -ProcessId $primary.Id
  $windowDetail = "pid $($primary.Id), hwnd $windowHandle"
  if ($windowHandle -ne [IntPtr]::Zero) {
    $windowDetail += ", class '$([DpxWindowCheck]::ClassName($windowHandle))', title '$([DpxWindowCheck]::Title($windowHandle))'"
  } else {
    $windowDetail += '; top-level windows: ' + ((Get-WindowInventory -ProcessId $primary.Id) -join ' | ')
  }
  Test-Check -Name 'the main window appears' -Passed $appeared -Detail $windowDetail
  if (-not $appeared) { throw 'the launcher never showed a window' }
  Test-Check -Name 'the UI thread answers' -Passed ([DpxWindowCheck]::Responds($windowHandle, 2000))

  Write-Host ''
  Write-Host '2. title-bar X with the "minimize to tray" close action'
  $logPath = Join-Path $ScratchRoot 'desktop-state\shell.log'
  [DpxWindowCheck]::Close($windowHandle)
  $hidden = Wait-ForWindowState -Handle $windowHandle -Visible $false -TimeoutSeconds $TransitionTimeoutSeconds
  Test-Check -Name 'the X hides the window' -Passed $hidden
  $lines = Read-ShellLog -Root $ScratchRoot
  $reported = (Get-LogCount -Lines $lines -Pattern 'close request: minimized to the notification area') -gt 0
  Test-Check -Name 'the close request is logged' -Passed $reported
  $honest = (Get-LogCount -Lines $lines -Pattern 'window visible afterwards: False') -gt 0
  Test-Check -Name 'the close line records the real visibility (0.2.7+)' -Passed $honest -Detail 'negative on 0.2.6, which never logged it'

  Write-Host ''
  Write-Host '3. a second launch restores that window (the real focus_existing path)'
  $second = Start-Launcher -Launcher $launcherPath -Root $ScratchRoot
  $secondExited = Wait-For -TimeoutSeconds 30 -Condition {
    $process = Get-LauncherProcess -ProcessId $second.Id
    return ($null -eq $process)
  }
  Test-Check -Name 'the second launch exits instead of starting a second shell' -Passed $secondExited -Detail "pid $($second.Id)"
  $restored = Wait-ForWindowState -Handle $windowHandle -Visible $true -TimeoutSeconds $TransitionTimeoutSeconds
  Test-Check -Name 'the second launch restores the window' -Passed $restored
  $lines = Read-ShellLog -Root $ScratchRoot
  $handover = (Get-LogCount -Lines $lines -Pattern 'another desktop shell already owns this environment') -gt 0
  Test-Check -Name 'the handover is logged' -Passed $handover

  Write-Host ''
  Write-Host '4. title-bar X again — the desync regression'
  $before = Get-LogCount -Lines (Read-ShellLog -Root $ScratchRoot) -Pattern 'close request: minimized'
  [DpxWindowCheck]::Close($windowHandle)
  $hiddenAgain = Wait-ForWindowState -Handle $windowHandle -Visible $false -TimeoutSeconds $TransitionTimeoutSeconds
  $after = Get-LogCount -Lines (Read-ShellLog -Root $ScratchRoot) -Pattern 'close request: minimized'
  Test-Check -Name 'the X still hides the window after a restore' -Passed $hiddenAgain -Detail "close lines: $before -> $after"
  $lines = Read-ShellLog -Root $ScratchRoot
  $repaired = (Get-LogCount -Lines $lines -Pattern 'visibility was out of sync') -gt 0
  Test-Check -Name 'a visibility repair (when the log reports one) succeeds' -Passed ((-not $repaired) -or $hiddenAgain) -Detail $(if ($repaired) { 'the visibility cache was out of sync and was repaired from Win32' } else { 'no repair was needed' })

  Write-Host ''
  Write-Host '5. the window can still be brought back after a repair'
  $third = Start-Launcher -Launcher $launcherPath -Root $ScratchRoot
  $thirdExited = Wait-For -TimeoutSeconds 30 -Condition { $null -eq (Get-LauncherProcess -ProcessId $third.Id) }
  Test-Check -Name 'the third launch hands over to the running shell' -Passed $thirdExited -Detail "pid $($third.Id)"
  $shownAgain = Wait-ForWindowState -Handle $windowHandle -Visible $true -TimeoutSeconds $TransitionTimeoutSeconds
  Test-Check -Name 'the window can be restored again' -Passed $shownAgain

  Write-Host ''
  Write-Host '6. the UI thread stays responsive through the whole sequence'
  Test-Check -Name 'the window responds after three close/restore cycles' -Passed ([DpxWindowCheck]::Responds($windowHandle, 2000))
  Test-Check -Name 'Windows does not consider the window hung' -Passed (-not [DpxWindowCheck]::IsHungAppWindow($windowHandle))

  Write-Host ''
  Write-Host '7. "close = exit" stops the child tree and the launcher'
  $lines = Read-ShellLog -Root $ScratchRoot
  $childId = Get-DshChildId -Lines $lines
  $childWasAlive = $false
  if ($childId) {
    $childWasAlive = $null -ne (Get-Process -Id $childId -ErrorAction SilentlyContinue)
  }
  $startedAt = Get-Date
  Write-CloseAction -Root $ScratchRoot -Action 'exit'
  [DpxWindowCheck]::Close($windowHandle)
  $exited = Wait-For -TimeoutSeconds 20 -Condition { $null -eq (Get-LauncherProcess -ProcessId $primary.Id) }
  $elapsed = [int](((Get-Date) - $startedAt).TotalMilliseconds)
  Test-Check -Name 'the launcher exits' -Passed $exited -Detail "after $elapsed ms"
  $childGone = $true
  if ($childWasAlive) {
    $childGone = Wait-For -TimeoutSeconds 10 -Condition { $null -eq (Get-Process -Id $childId -ErrorAction SilentlyContinue) }
    Test-Check -Name 'the DSH child tree is gone' -Passed $childGone -Detail "pid $childId"
  } else {
    Test-Check -Name 'the DSH child tree is gone' -Passed $true -Detail 'no live DSH child to reap'
  }
} finally {
  Write-Host ''
  Write-Host 'cleanup'
  Stop-ScratchEnvironment -Root $ScratchRoot -ProcessId $(if ($primary) { $primary.Id } else { 0 })
  Remove-Junction -Path (Join-Path $ScratchRoot 'npm-prefix')
  if ($KeepScratch) {
    Write-Host "  kept: $ScratchRoot"
  } else {
    Remove-Item -LiteralPath $ScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $ScratchRoot) { Write-Host "  could not remove $ScratchRoot (a WebView2 process may still hold it)" }
  }
}

Write-Host ''
Write-Host 'summary'
$script:results | Format-Table -AutoSize | Out-String | Write-Host
$failed = @($script:results | Where-Object { $_.Result -eq 'FAIL' })
Write-Host ("{0} checks, {1} failed" -f $script:results.Count, $failed.Count)
if ($failed.Count -gt 0) { exit 1 }
exit 0
