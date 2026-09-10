//! Notification-area icon and its context menu.
//!
//! The tray icon is the shell's always-available entry point once the window is
//! hidden: left click restores the window, right click offers the settings
//! window and the only sanctioned way to stop the environment from there.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

pub const TRAY_ID: &str = "dpx-desktop-tray";

const ITEM_SHOW: &str = "show";
const ITEM_SETTINGS: &str = "settings";
const ITEM_RESTART: &str = "restart";
const ITEM_QUIT: &str = "quit";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, ITEM_SHOW, "打开主窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, ITEM_SETTINGS, "设置", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, ITEM_RESTART, "重启 DSH 服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, "关闭程序", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &settings, &restart, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("DSH DeepSeek Harness Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            ITEM_SHOW => crate::windows::show_main(app),
            ITEM_SETTINGS => {
                if let Err(error) = crate::windows::open_settings(app) {
                    crate::log_ui(app, &error);
                }
            }
            ITEM_RESTART => crate::restart_service(app),
            ITEM_QUIT => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::windows::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

pub fn set_visible(app: &AppHandle, visible: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(visible);
    }
}

/// Install the icon on first use and reflect the configured visibility.
pub fn sync(app: &AppHandle, enabled: bool) {
    if enabled {
        if !exists(app) {
            let _ = install(app);
        }
        set_visible(app, true);
    } else {
        set_visible(app, false);
    }
}

pub fn exists(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}
