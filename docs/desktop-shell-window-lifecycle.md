# The desktop shell's window lifecycle

Two defects lived in this shell and neither could be seen by the Rust unit tests:

* the title-bar **X stopped working** once the shell had been running for a while —
  it logged `close request: minimized to the notification area` and did nothing,
  click after click, until some unrelated code path happened to re-show the
  window;
* closing (or restarting) the shell could leave the window in **"not responding"**
  for as long as the DSH child tree took to die, with nothing in `shell.log` to
  explain it.

Both were reproduced against a packaged launcher, and both are now guarded by
[`scripts/verify-desktop-shell-window.ps1`](../scripts/verify-desktop-shell-window.ps1),
which drives a real EXE in a scratch environment root (`DSH_DESKTOP_ENV`).

## 1. Visibility is cached by the toolkit, and two processes disagree

`tao` (through `tauri`) keeps its own copy of a window's visibility in
`WindowFlags` and **skips the `ShowWindow` call when the cached value already
equals the request**:

```rust
// tao-0.35.x, platform_impl/windows/window_state.rs
fn apply_diff(mut self, window: HWND, mut new: WindowFlags) {
    let mut diff = self ^ new;
    if diff == WindowFlags::empty() {
        return;                       // <- nothing is applied to the real window
    }
    ...
    if !new.contains(WindowFlags::VISIBLE) {
        let _ = ShowWindow(window, SW_HIDE);
    }
}
```

This shell changes the real Win32 visibility **without going through that cache**
on purpose: a second launch of the same environment restores the already-running
window from another process, because that is the only way one process can bring
another process's window back:

```rust
// instance.rs — focus_existing, run by the *second* process
ShowWindow(record.hwnd, SW_RESTORE);
ShowWindow(record.hwnd, SW_SHOW);
SetForegroundWindow(record.hwnd);
```

After that restore:

| | Windows | tao's cache |
| --- | --- | --- |
| after the X (hide) | hidden | hidden ✅ |
| after a second launch (restore) | **visible** | hidden ❌ |
| after the next X (`hide()`) | visible | hidden — `diff` empty, **nothing happens** |

Every later `hide()` short-circuits, so the X is dead until something calls a tao
`show()` again (the tray's "打开主窗口", for instance). That is why the bug grew
with uptime: it needs one hide → restore cycle, and a fresh launch never has one.

`windows::set_main_visible` now treats Win32 as the authority: it calls the tao
API (so tao's and wry's bookkeeping run in the normal case) and then verifies the
**real** state through `WebviewWindow::is_visible()`, which tao answers with
`IsWindowVisible`. A disagreement is repaired with a direct `ShowWindow` and
logged:

```
window visibility was out of sync with the window toolkit (asked for visible=false); repaired with a direct Win32 ShowWindow call
close request: minimized to the notification area (window visible afterwards: false)
```

The desync itself is unavoidable while a second process restores the window;
what is not acceptable is that it is silent. Every close now records the
visibility *after* the action, so a dead button names itself in one line.

## 2. Nothing on the shutdown path may wait forever — or on the UI thread

`kill_child` used to run `taskkill /PID <pid> /T /F` with `.status()` and then
`child.wait()`, both unbounded, and both were reached from the UI thread (the
close handler, the tray menu, a Tauri command). Killing a long-running DSH tree —
node plus every shell, agent and MCP process under it — takes as long as it
takes, and a `taskkill` that stalls leaves a window that Windows marks as
"not responding" with no log line, because the handler is parked before it can
log anything.

Now:

* `run_bounded` gives every helper process a deadline (`TASKKILL_TIMEOUT`, 5 s)
  and kills the helper if it overruns;
* the DSH child gets `CHILD_EXIT_TIMEOUT` (3 s) to disappear after being killed;
* `quit` and `restart_service` do their teardown on their own thread, hide the
  window immediately so the click has feedback, and a `SHUTDOWN_GRACE` (8 s)
  watchdog calls `std::process::exit(0)` if the teardown wedges — the kill-on-close
  job object ([`job.rs`](../desktop-shell/src-tauri/src/job.rs)) takes the child
  tree with the process either way;
* re-entry is claimed once (`AppState::begin_shutdown` / `begin_restart`), so
  clicking X three times cannot start three `taskkill`s or two DSH children;
* the close confirmation window (the "ask" action) is created *after* the
  `WM_CLOSE` dispatch returns, because building a WebView2 window inside that
  dispatch can wedge the message loop.

## Verifying

```powershell
npm run desktop:verify:window
# or against any packaged launcher, keeping the scratch environment for inspection
powershell -ExecutionPolicy Bypass -File scripts\verify-desktop-shell-window.ps1 `
  -Launcher "assets\windows\DSH DeepSeek Harness Desktop.exe" -KeepScratch
```

The script starts the launcher against a scratch environment root, then:

1. waits for the main window and pings its message queue;
2. sends `WM_CLOSE` and requires the window to be hidden and the close line to
   report `window visible afterwards: false`;
3. launches the EXE a second time — the real `focus_existing` path — and requires
   the window back;
4. sends `WM_CLOSE` again: **0.2.6 fails here**, every later release must pass;
5. launches a third time and requires the window back, i.e. the repair must not
   trap the user;
6. requires the window to still answer and to not be flagged hung;
7. switches the scratch settings to `closeAction: exit` and requires the launcher
   and its DSH child to be gone within the deadline.

Exit code 0 means every check passed.
