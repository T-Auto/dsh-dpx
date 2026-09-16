//! Window management for the desktop shell.
//!
//! Three windows exist:
//!   `main`          the DSH Web UI (or the startup screen before it is ready)
//!   `settings`      the "Desktop 设置" window, opened from the tray menu
//!   `close-dialog`  the first-close confirmation, styled like the DSH Web UI
//!
//! # The main window's visibility can desynchronise, and this module repairs it
//!
//! `tao` (through `tauri`) keeps its own copy of a window's visibility in
//! `WindowFlags` and **skips the `ShowWindow` call when the cached value already
//! equals the request**. Anything that changes the real Win32 visibility without
//! going through that cache therefore leaves it stale — and this shell does
//! exactly that on purpose: a second launch of the same environment restores the
//! already-running window with a raw `ShowWindow`/`SetForegroundWindow` pair from
//! another process ([`crate::instance::focus_existing`]).
//!
//! After such a restore tao still believed the window was hidden, so
//! `WebviewWindow::hide()` became a silent no-op: pressing the title-bar X logged
//! "close request: minimized to the notification area" and did nothing at all, on
//! every later click, until some other code path happened to call a tao `show()`
//! again. Two processes, one window, two opinions — and nothing in the log said so.
//!
//! [`set_main_visible`] therefore treats Win32 as the authority: it calls the tao
//! API (so tao's bookkeeping, and wry's, run in the normal case) and then verifies
//! the **real** state through [`tauri::WebviewWindow::is_visible`], which tao
//! answers with `IsWindowVisible`. When the two disagree, a raw `ShowWindow`
//! repairs the window, and the disagreement is logged so the next occurrence names
//! itself instead of looking like a dead button.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const MAIN: &str = "main";
pub const SETTINGS: &str = "settings";
pub const CLOSE_DIALOG: &str = "close-dialog";

/// How long [`set_main_visible`] gives a visibility change to become real before
/// concluding that the toolkit skipped it. Only reached when the first check
/// already disagrees, so the normal path costs a single `IsWindowVisible` call.
const VISIBILITY_SETTLE: Duration = Duration::from_millis(200);
const VISIBILITY_POLL: Duration = Duration::from_millis(25);

#[cfg(windows)]
const SW_HIDE: i32 = 0;
#[cfg(windows)]
const SW_SHOW: i32 = 5;

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn ShowWindow(hwnd: isize, command: i32) -> i32;
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

/// Whether the main window is *really* visible, as Windows sees it.
///
/// `WebviewWindow::is_visible` is answered by `IsWindowVisible`, not by tao's
/// cached flag, which is what makes it usable as the tie-breaker.
pub fn main_is_visible(app: &AppHandle) -> bool {
    main_window(app).and_then(|window| window.is_visible().ok()).unwrap_or(false)
}

/// Force the real, Win32-level visibility of `window`.
fn force_visible(window: &WebviewWindow, visible: bool) -> bool {
    #[cfg(windows)]
    {
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                ShowWindow(hwnd.0 as isize, if visible { SW_SHOW } else { SW_HIDE });
            }
            return true;
        }
    }
    let _ = (window, visible);
    false
}

/// Apply `visible` to the main window and make sure it really ends up that way.
///
/// Returns whether the Win32 state had to be repaired — a sign that something
/// changed this window's visibility behind the toolkit's back. A failed
/// verification (`is_visible` erroring) is deliberately *not* treated as a
/// disagreement: a blind `ShowWindow` on a guess would be worse than leaving
/// tao's result alone.
pub fn set_main_visible(app: &AppHandle, visible: bool) -> bool {
    let Some(window) = main_window(app) else { return false };
    if visible {
        let _ = window.show();
        let _ = window.unminimize();
    } else {
        let _ = window.hide();
    }

    let deadline = Instant::now() + VISIBILITY_SETTLE;
    loop {
        match window.is_visible() {
            Ok(current) if current == visible => return false,
            // Cannot verify: keep tao's result rather than guess.
            Err(_) => return false,
            Ok(_) => {}
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(VISIBILITY_POLL);
    }

    let repaired = force_visible(&window, visible);
    if repaired {
        crate::log_ui(
            app,
            &format!(
                "window visibility was out of sync with the window toolkit (asked for visible={visible}); repaired with a direct Win32 ShowWindow call"
            ),
        );
    }
    repaired
}

/// Bring the main window back to the foreground (tray click, second launch).
pub fn show_main(app: &AppHandle) {
    set_main_visible(app, true);
    if let Some(window) = main_window(app) {
        let _ = window.set_focus();
    }
}

/// Hide the main window to the notification area (the title-bar X with the
/// "minimize to tray" close action).
pub fn hide_main(app: &AppHandle) {
    set_main_visible(app, false);
    if main_is_visible(app) {
        crate::log_ui(app, "the main window is still visible after being hidden");
    }
}

pub fn open_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("settings.html".into()))
        .title("Desktop 设置")
        .inner_size(640.0, 760.0)
        .min_inner_size(540.0, 480.0)
        .resizable(true)
        .center()
        .build()
        .map(|_| ())
        .map_err(|error| format!("无法打开设置窗口：{error}"))
}

pub fn open_close_dialog(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CLOSE_DIALOG) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, CLOSE_DIALOG, WebviewUrl::App("close-dialog.html".into()))
        .title("关闭 DSH DeepSeek Harness Desktop")
        .inner_size(520.0, 400.0)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .build()
        .map(|_| ())
        .map_err(|error| format!("无法打开关闭确认窗口：{error}"))
}

pub fn close(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }
}
