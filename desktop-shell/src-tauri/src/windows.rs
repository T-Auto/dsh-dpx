//! Window management for the desktop shell.
//!
//! Three windows exist:
//!   `main`          the DSH Web UI (or the startup screen before it is ready)
//!   `settings`      the "Desktop 设置" window, opened from the tray menu
//!   `close-dialog`  the first-close confirmation, styled like the DSH Web UI

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const MAIN: &str = "main";
pub const SETTINGS: &str = "settings";
pub const CLOSE_DIALOG: &str = "close-dialog";

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
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

/// Hide instead of destroy, so reopening the settings window is instant.
pub fn hide(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
    }
}
