//! A self-contained shell copied into `<dpx-environment>/desktop/`.
//!
//! The launcher is deliberately independent of both DPX and the DSH core:
//!
//! * it derives its environment root from its own location (or
//!   `DSH_DESKTOP_ENV`), never from the DPX registry and never by running `dpx`;
//! * it discovers the installed DSH entry through that package's own
//!   `package.json` `bin` field (see [`dsh`]), so replacing or upgrading DSH
//!   packages never requires rebuilding this launcher;
//! * all of its own state lives in `<env-root>/desktop-state/`.
//!
//! Upgrading *this* file is the only thing that needs a new desktop build, which
//! is why [`update`] pulls it straight from GitHub Releases.
//!
//! Isolation between environments is a hard requirement, because every
//! environment runs the same executable:
//!
//! * [`instance`] scopes the single-instance guard to the environment root, so
//!   two environments run side by side and a second launch of the *same*
//!   environment restores its window instead of starting a second DSH server;
//! * [`job`] ties the DSH child's lifetime to this process, so a force-killed
//!   shell can never leave an orphan holding the environment's session locks;
//! * every piece of state lives under `<env-root>/desktop-state/`.

mod dsh;
mod instance;
mod job;
mod settings;
mod tray;
mod update;
mod windows;

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Held for the whole process lifetime; dropping it would release the guard.
static INSTANCE_LOCK: std::sync::OnceLock<instance::InstanceLock> = std::sync::OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    state: &'static str,
    url: Option<String>,
    message: Option<String>,
}

impl Default for Status {
    fn default() -> Self {
        Self { state: "starting", url: None, message: None }
    }
}

#[derive(Default)]
struct Inner {
    status: Status,
    child: Option<Child>,
    log: String,
    pending_close: bool,
}

#[derive(Clone, Default)]
struct AppState(Arc<Mutex<Inner>>);

impl AppState {
    fn set_error(&self, message: String) {
        let mut inner = self.0.lock().unwrap();
        if inner.status.state == "starting" {
            inner.status.state = "error";
            inner.status.message = Some(message);
        }
    }

    fn log_tail(&self, max_chars: usize) -> String {
        let inner = self.0.lock().unwrap();
        let log = inner.log.trim();
        if log.chars().count() <= max_chars {
            return log.to_string();
        }
        let tail: String = log.chars().rev().take(max_chars).collect::<String>().chars().rev().collect();
        format!("…\n{tail}")
    }
}

fn env_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("DSH_DESKTOP_ENV") {
        let root = PathBuf::from(value);
        if root.is_dir() {
            return Ok(root);
        }
        return Err(format!("DSH_DESKTOP_ENV 不是有效环境目录：{}", root.display()));
    }
    let exe = std::env::current_exe().map_err(|error| format!("无法解析启动器路径：{error}"))?;
    let root = exe
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "无法从桌面启动器推导环境根目录。".to_string())?
        .to_path_buf();
    if root.is_dir() {
        Ok(root)
    } else {
        Err(format!("桌面启动器的环境根目录不存在：{}", root.display()))
    }
}

pub fn log_ui(_app: &AppHandle, message: &str) {
    if let Ok(root) = env_root() {
        log_line(&root, message);
    }
}

fn kill_child(state: &AppState) {
    let child = state.0.lock().unwrap().child.take();
    let Some(mut child) = child else { return };
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Stop the DSH child process tree and exit the shell.
pub fn quit(app: &AppHandle) {
    kill_child(&app.state::<AppState>());
    app.exit(0);
}

/// Kill the running DSH child and start a fresh one in the same window.
pub fn restart_service(app: &AppHandle) {
    let state = app.state::<AppState>();
    kill_child(&state);
    {
        let mut inner = state.0.lock().unwrap();
        inner.status = Status::default();
        inner.log.clear();
        inner.pending_close = false;
    }
    if let Err(error) = launch(&state, app) {
        state.set_error(error);
    }
}

#[tauri::command]
fn webui_status(state: tauri::State<'_, AppState>) -> Status {
    state.0.lock().unwrap().status.clone()
}

#[tauri::command]
fn desktop_environment() -> String {
    env_root().map(|root| environment_name(&root)).unwrap_or_else(|_| "desktop".to_string())
}

#[tauri::command]
fn restart_webui(app: tauri::AppHandle) {
    restart_service(&app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DshInfo {
    package: String,
    version: Option<String>,
    entry: String,
    args: Vec<String>,
    node: String,
    command_line: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    shell_version: String,
    environment: String,
    environment_root: String,
    state_dir: String,
    log_path: String,
    launcher: String,
    launcher_present: bool,
    launcher_version: Option<String>,
    dsh: Option<DshInfo>,
    launch_error: Option<String>,
    tray_available: bool,
}

#[tauri::command]
fn desktop_info(app: tauri::AppHandle) -> Result<DesktopInfo, String> {
    let root = env_root()?;
    let launcher = update::launcher_path(&root);
    let (dsh, launch_error) = match dsh::resolve_launch(&root) {
        Ok(plan) => (
            Some(DshInfo {
                package: plan.package.clone(),
                version: plan.package_version.clone(),
                entry: plan.entry.display().to_string(),
                args: plan.args.clone(),
                node: plan.node.display().to_string(),
                command_line: plan.command_line(),
            }),
            None,
        ),
        Err(error) => (None, Some(error)),
    };
    Ok(DesktopInfo {
        shell_version: env!("DPX_DESKTOP_BUILD_VERSION").to_string(),
        environment: environment_name(&root),
        environment_root: root.display().to_string(),
        state_dir: settings::state_dir(&root).display().to_string(),
        log_path: settings::logs_path(&root).display().to_string(),
        launcher: launcher.display().to_string(),
        launcher_present: launcher.is_file(),
        launcher_version: update::read_installed_version(&root),
        dsh,
        launch_error,
        tray_available: tray::exists(&app),
    })
}

#[tauri::command]
fn get_settings() -> Result<settings::Settings, String> {
    Ok(settings::load(&env_root()?))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SettingsPatch {
    close_action: Option<String>,
    tray_enabled: Option<bool>,
    update_source: Option<String>,
    update_proxy: Option<String>,
    auto_check_updates: Option<bool>,
}

fn trimmed(value: &Option<String>) -> Option<String> {
    value.as_deref().map(str::trim).filter(|text| !text.is_empty()).map(str::to_string)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, patch: SettingsPatch) -> Result<settings::Settings, String> {
    let root = env_root()?;
    let mut current = settings::load(&root);
    if let Some(action) = patch.close_action.as_deref() {
        current.close_action = settings::CloseAction::parse(action)
            .ok_or_else(|| format!("未知的关闭行为：{action}"))?;
    }
    if let Some(enabled) = patch.tray_enabled {
        current.tray_enabled = enabled;
    }
    if patch.update_source.is_some() {
        current.update_source = trimmed(&patch.update_source);
    }
    if patch.update_proxy.is_some() {
        current.update_proxy = trimmed(&patch.update_proxy);
    }
    if let Some(enabled) = patch.auto_check_updates {
        current.auto_check_updates = enabled;
    }
    settings::save(&root, &current)?;
    tray::sync(&app, current.tray_enabled);
    Ok(current)
}

#[tauri::command]
async fn check_desktop_update() -> Result<settings::LastCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = env_root()?;
        let mut current = settings::load(&root);
        let result = update::check(&root, &current);
        current.last_check = Some(result.clone());
        let _ = settings::save(&root, &current);
        log_line(&root, &format!("desktop update check: {} ({})", result.reason, result.message.clone().unwrap_or_default()));
        Ok(result)
    })
    .await
    .map_err(|error| format!("检查更新任务失败：{error}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyResult {
    version: String,
    launcher: String,
    restart: bool,
}

#[tauri::command]
async fn apply_desktop_update(app: tauri::AppHandle) -> Result<ApplyResult, String> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let root = env_root()?;
        let current = settings::load(&root);
        let outcome = update::apply(&root, &current)?;
        log_line(&root, &format!("desktop updated to {} ({})", outcome.version, outcome.launcher));
        Ok::<_, String>(outcome)
    })
    .await
    .map_err(|error| format!("更新任务失败：{error}"))??;

    let result = ApplyResult {
        version: outcome.version.clone(),
        launcher: outcome.launcher.clone(),
        restart: outcome.restart,
    };
    if outcome.restart {
        // The detached relauncher waits for this process to disappear, so give the
        // settings window a moment to render its message and then stop DSH.
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(800));
            quit(&handle);
        });
    }
    Ok(result)
}

#[tauri::command]
fn close_request_pending(state: tauri::State<'_, AppState>) -> bool {
    state.0.lock().unwrap().pending_close
}

#[tauri::command]
fn resolve_close_request(app: tauri::AppHandle, state: tauri::State<'_, AppState>, action: String, remember: bool) -> Result<String, String> {
    let root = env_root()?;
    state.0.lock().unwrap().pending_close = false;
    windows::close(&app, windows::CLOSE_DIALOG);
    let action = action.trim().to_ascii_lowercase();
    if action == "cancel" {
        return Ok(settings::load(&root).close_action.as_str().to_string());
    }
    let parsed = settings::CloseAction::parse(&action).ok_or_else(|| format!("未知的关闭操作：{action}"))?;
    let mut current = settings::load(&root);
    if remember {
        current.close_action = parsed;
        settings::save(&root, &current)?;
    }
    match parsed {
        // "Ask" cannot be resolved into an action; treat it as cancel.
        settings::CloseAction::Ask => {}
        settings::CloseAction::Tray => {
            windows::hide(&app, windows::MAIN);
            log_line(&root, "close request: minimized to the notification area");
        }
        settings::CloseAction::Exit => {
            log_line(&root, "close request: exiting the desktop shell");
            quit(&app);
        }
    }
    Ok(parsed.as_str().to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    quit(&app);
}

#[tauri::command]
fn open_state_dir() -> Result<String, String> {
    let root = env_root()?;
    let directory = settings::state_dir(&root);
    std::fs::create_dir_all(&directory).ok();
    Command::new("explorer")
        .arg(directory.display().to_string())
        .spawn()
        .map_err(|error| format!("无法打开目录：{error}"))?;
    Ok(directory.display().to_string())
}

pub fn run() {
    update_cleanup_on_start();
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            webui_status,
            desktop_environment,
            restart_webui,
            desktop_info,
            get_settings,
            save_settings,
            check_desktop_update,
            apply_desktop_update,
            close_request_pending,
            resolve_close_request,
            quit_app,
            open_state_dir
        ])
        .setup(|app| {
            let state = app.state::<AppState>().inner().clone();
            let handle = app.handle().clone();
            let root = env_root().unwrap_or_else(|_| {
                std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().and_then(Path::parent).map(Path::to_path_buf))
                    .unwrap_or_else(|| PathBuf::from("."))
            });

            // Environment-scoped single instance. This runs before any window or
            // DSH process exists, so a second launch of the same environment never
            // touches its DSH_HOME (see `instance`).
            match instance::acquire(&root) {
                Ok(instance::Instance::Primary(lock)) => {
                    let _ = INSTANCE_LOCK.set(lock);
                }
                Ok(instance::Instance::AlreadyRunning(record)) => {
                    let focused = record.as_ref().map(instance::focus_existing).unwrap_or(false);
                    log_line(&root, &format!("another desktop shell already owns this environment (restored window: {focused}); exiting"));
                    std::process::exit(0);
                }
                Err(error) => log_line(&root, &format!("instance guard unavailable: {error}")),
            }

            let data_dir = webview_data_dir(&root);
            std::fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建 WebView2 数据目录：{error}"))?;

            let configured = settings::load(&root);
            tray::sync(&handle, configured.tray_enabled);
            if configured.tray_enabled && !tray::exists(&handle) {
                log_line(&root, "tray icon unavailable; the close button falls back to exiting");
            }

            // Created hidden on purpose: the close handler below must be in place
            // before the window can receive a WM_CLOSE, otherwise a click on the
            // title-bar X during WebView2 startup would close the app outright.
            let window = WebviewWindowBuilder::new(app, windows::MAIN, WebviewUrl::App("index.html".into()))
                .title("DSH DeepSeek Harness Desktop")
                .inner_size(1080.0, 720.0)
                .min_inner_size(760.0, 500.0)
                .center()
                .resizable(true)
                .visible(false)
                .data_directory(data_dir)
                .build()
                .map_err(|error| format!("无法创建桌面窗口：{error}"))?;

            let close_window = window.clone();
            window.on_window_event(move |event| {
                let WindowEvent::CloseRequested { api, .. } = event else { return };
                let app = close_window.app_handle().clone();
                let Ok(root) = env_root() else { return };
                match settings::load(&root).close_action {
                    settings::CloseAction::Exit => {
                        api.prevent_close();
                        log_line(&root, "close request: exiting the desktop shell");
                        quit(&app);
                    }
                    settings::CloseAction::Tray => {
                        api.prevent_close();
                        let _ = close_window.hide();
                        log_line(&root, "close request: minimized to the notification area");
                    }
                    settings::CloseAction::Ask => {
                        api.prevent_close();
                        {
                            let state = app.state::<AppState>();
                            state.0.lock().unwrap().pending_close = true;
                        }
                        if let Err(error) = windows::open_close_dialog(&app) {
                            // Never trap the user in an unclosable window.
                            log_line(&root, &format!("close dialog failed, hiding instead: {error}"));
                            let _ = close_window.hide();
                        }
                    }
                }
            });

            let _ = window.show();
            let _ = window.set_focus();
            #[cfg(windows)]
            {
                // Let the next launch of this environment restore this window.
                if let Ok(hwnd) = window.hwnd() {
                    instance::publish(&root, hwnd.0 as isize);
                }
            }
            if let Err(error) = launch(&state, &handle) {
                state.set_error(error);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the desktop application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                kill_child(&app.state::<AppState>());
                if let Ok(root) = env_root() {
                    instance::withdraw(&root);
                }
            }
        });
}

fn launch(state: &AppState, app: &tauri::AppHandle) -> Result<(), String> {
    let root = env_root()?;
    let plan = dsh::resolve_launch(&root)?;
    // DSH and Windows file pickers derive the initial workspace location from
    // USERPROFILE\\Desktop. The launcher overrides USERPROFILE with the isolated
    // profile, so create that directory before DSH starts. This also repairs
    // environments created by an older dpx version when the EXE is opened
    // directly (without going through the dpx CLI).
    std::fs::create_dir_all(root.join("home").join("Desktop")).map_err(|error| format!("无法创建桌面工作目录：{error}"))?;
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).map_err(|error| format!("无法创建工作目录：{error}"))?;

    let mut cmd = Command::new(&plan.node);
    cmd.arg(&plan.entry)
        .args(&plan.args)
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in dsh::SCRUBBED_ENV {
        cmd.env_remove(key);
    }
    for (key, value) in plan.env.iter() {
        cmd.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|error| {
        format!("无法启动 DSH 服务。\n命令: {}\n错误: {error}", plan.command_line())
    })?;
    // Tie the child's lifetime to this process: if the shell is force-killed the
    // OS tears the child down too, so it can never linger as an orphan holding the
    // environment's DSH session write handles.
    match job::ChildJob::new() {
        Ok(child_job) => {
            if let Err(error) = child_job.assign(&child) {
                log_line(&root, &format!("could not tie the DSH child to a job object: {error}"));
            }
        }
        Err(error) => log_line(&root, &format!("could not create a job object: {error}")),
    }
    log_line(&root, &format!("spawned DSH (pid {}) with: {}", child.id(), plan.command_line()));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    state.0.lock().unwrap().child = Some(child);

    if let Some(stdout) = stdout {
        let reader_state = state.clone();
        let reader_app = app.clone();
        let log_root = root.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                append_log(&reader_state, &line);
                log_line(&log_root, &format!("stdout: {line}"));
                if let Some(url) = dsh::extract_url(&line) {
                    {
                        let mut inner = reader_state.0.lock().unwrap();
                        if inner.status.state == "starting" {
                            inner.status.state = "ready";
                            inner.status.url = Some(url.clone());
                        }
                    }
                    navigate(&reader_app, &url);
                }
            }
        });
    }
    if let Some(stderr) = stderr {
        let reader_state = state.clone();
        let log_root = root.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                append_log(&reader_state, &line);
                log_line(&log_root, &format!("stderr: {line}"));
            }
        });
    }

    let monitor_state = state.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let exited = {
                let mut inner = monitor_state.0.lock().unwrap();
                if inner.status.state != "starting" {
                    return;
                }
                inner.child.as_mut().and_then(|child| child.try_wait().ok().flatten()).map(|status| status.code())
            };
            if let Some(code) = exited {
                monitor_state.set_error(format!(
                    "DSH 进程提前退出（exit code {}）。\n\n{}",
                    code.map_or("unknown".to_string(), |n| n.to_string()),
                    monitor_state.log_tail(4000)
                ));
                return;
            }
            if Instant::now() >= deadline {
                monitor_state.set_error(format!("启动超时（{} 秒）。\n\n{}", STARTUP_TIMEOUT.as_secs(), monitor_state.log_tail(4000)));
                return;
            }
        }
    });
    Ok(())
}

fn append_log(state: &AppState, line: &str) {
    let mut inner = state.0.lock().unwrap();
    inner.log.push_str(line);
    inner.log.push('\n');
    if inner.log.len() > 200_000 {
        let cut = inner.log.len() - 100_000;
        inner.log = inner.log.split_off(cut);
    }
}

fn navigate(app: &tauri::AppHandle, url: &str) {
    let Ok(parsed) = tauri::Url::parse(url) else { return };
    let app_for_thread = app.clone();
    let app_for_window = app.clone();
    let fallback = url.to_string();
    let _ = app_for_thread.run_on_main_thread(move || {
        if let Some(window) = app_for_window.get_webview_window(windows::MAIN) {
            if window.navigate(parsed).is_err() {
                let literal = serde_json::to_string(&fallback).unwrap_or_else(|_| "\"/\"".to_string());
                let _ = window.eval(&format!("window.location.replace({literal})"));
            }
        }
    });
}

fn environment_name(root: &Path) -> String {
    root.file_name().and_then(|name| name.to_str()).unwrap_or("desktop").to_string()
}

fn webview_data_dir(root: &Path) -> PathBuf {
    settings::state_dir(root).join("webview2")
}

fn log_path(root: &Path) -> PathBuf {
    settings::logs_path(root)
}

fn log_line(root: &Path, message: &str) {
    let path = log_path(root);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis()).unwrap_or(0);
        let _ = writeln!(file, "[{millis}] {message}");
    }
}

fn update_cleanup_on_start() {
    if let Ok(root) = env_root() {
        update::cleanup_updates(&root);
    }
}

#[cfg(test)]
mod tests {
    use crate::dsh::extract_url;
    use crate::settings::{self, STATE_DIR};
    use crate::update;
    use std::path::Path;

    #[test]
    fn desktop_state_is_below_environment_root() {
        let root = Path::new(r"C:\environments\desktop");
        assert_eq!(settings::state_dir(root), root.join(STATE_DIR));
        assert_eq!(settings::logs_path(root), root.join(r"desktop-state\shell.log"));
        assert_eq!(crate::webview_data_dir(root), root.join(r"desktop-state\webview2"));
    }

    #[test]
    fn launcher_and_updates_live_below_the_environment_root() {
        let root = Path::new(r"C:\environments\desktop");
        assert_eq!(update::launcher_path(root), root.join(r"desktop\DSH DeepSeek Harness Desktop.exe"));
        assert_eq!(update::updates_dir(root), root.join(r"desktop-state\updates"));
    }

    #[test]
    fn url_extraction_is_shared_with_the_launcher() {
        assert!(extract_url("dsh web: http://127.0.0.1:1/?token=x").is_some());
    }
}
