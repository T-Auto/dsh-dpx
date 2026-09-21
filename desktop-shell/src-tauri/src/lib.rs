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
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// How long the shell waits for a ready URL before it stops calling the startup
/// "starting" and starts calling it "slow". The wait itself is not bounded: the
/// official desktop client deliberately has no startup-timeout heuristic, and a
/// cold start of a large profile can legitimately take minutes, so passing this
/// deadline only changes what the window says.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);

/// How recent the DSH child's last output must be for a startup that passed
/// [`STARTUP_TIMEOUT`] to still read as progress rather than as a suspected hang.
const STARTUP_SILENCE: Duration = Duration::from_secs(60);

/// Size at which `shell.log` is rotated to `shell.log.1`.
const MAX_LOG_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Values shorter than this are not used for credential redaction. The name test
/// matches ordinary variables too (`KEY` is a substring of `KEYBOARD`-ish names),
/// and replacing a one- or two-character value would garble every log line
/// without protecting anything real.
const MIN_SECRET_CHARS: usize = 8;

/// How long the shell waits for a helper process it started (in practice
/// `taskkill`) before killing the helper and moving on.
const TASKKILL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the DSH child gets to disappear after being asked to die.
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(3);
/// Hard deadline for the whole shutdown. Nothing on this path may wait forever:
/// the shell is going away, and the job object ([`job::ChildJob`]) already
/// guarantees the DSH child tree dies with this process either way.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(8);

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
    /// When the DSH child last wrote to stdout or stderr. A startup that passed
    /// [`STARTUP_TIMEOUT`] reports how long ago this was, which is the difference
    /// between "slow but working" and "silent and probably stuck".
    last_output_at: Option<Instant>,
    pending_close: bool,
    /// Set once the shutdown teardown has been claimed, so a second close click
    /// (or a second tray "关闭程序") cannot start a competing `taskkill`.
    quitting: bool,
    /// Set while a restart teardown + relaunch is in flight, for the same reason.
    restarting: bool,
}

#[derive(Clone, Default)]
struct AppState(Arc<Mutex<Inner>>);

impl AppState {
    /// Lock the shell state, recovering from a poisoned mutex.
    ///
    /// Every window event, every tray action and every Tauri command locks this
    /// state, so one panicking thread holding the lock must not be able to turn
    /// the whole shell into "no click ever does anything again". A poisoned lock
    /// only means some thread panicked mid-update; the shell is better off
    /// reading the state it has than panicking on every later event.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Claim the shutdown. Returns `true` for the first caller only.
    fn begin_shutdown(&self) -> bool {
        let mut inner = self.lock();
        if inner.quitting {
            return false;
        }
        inner.quitting = true;
        true
    }

    /// Claim the DSH restart. Returns `true` only when no restart is in flight.
    fn begin_restart(&self) -> bool {
        let mut inner = self.lock();
        if inner.restarting || inner.quitting {
            return false;
        }
        inner.restarting = true;
        true
    }

    fn end_restart(&self) {
        self.lock().restarting = false;
    }

    fn set_error(&self, message: String) {
        let mut inner = self.lock();
        // "slow" is still a startup in flight, so a child that exits after the
        // startup deadline must be able to turn it into a real error too.
        if matches!(inner.status.state, "starting" | "slow") {
            inner.status.state = "error";
            inner.status.message = Some(message);
        }
    }

    /// The PID of the DSH child this shell started and that is still running.
    ///
    /// Only the shell's *own* child is visible here: a DSH started by
    /// `dpx run --desktop` in the same environment belongs to that process and is
    /// deliberately not searched for. [`kill_child`] also `take()`s the handle, so
    /// during a restart window this answers `None` even though a fresh child is
    /// about to exist — the caller must treat a `None` as "nothing to warn about",
    /// never as proof that no DSH is running.
    fn live_child_pid(&self) -> Option<u32> {
        let mut inner = self.lock();
        let child = inner.child.as_mut()?;
        match child.try_wait() {
            Ok(None) => Some(child.id()),
            Ok(Some(_)) | Err(_) => None,
        }
    }

    fn log_tail(&self, max_chars: usize) -> String {
        let inner = self.lock();
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

/// Run a helper process to completion, but never for longer than `limit`.
///
/// Every wait on the shutdown path is bounded on purpose. This used to be a
/// plain `.status()` followed by `Child::wait()` — both unbounded — and both ran
/// on the UI thread, so a `taskkill /T /F` that stalled against a large or partly
/// unkillable child tree parked the window in "not responding" with nothing in
/// the log to explain it.
///
/// Returns `None` when the helper outlived its deadline (it is killed first).
fn run_bounded(command: &mut Command, limit: Duration) -> Option<std::process::ExitStatus> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Err(_) => return None,
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.try_wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Stop the DSH child process tree.
///
/// Callers must run this off the UI thread: killing a long-running DSH tree
/// (node plus every shell, agent and MCP process it spawned) takes as long as it
/// takes, and the shell has to stay responsive while it happens.
fn kill_child(state: &AppState) {
    let child = state.lock().child.take();
    let Some(mut child) = child else { return };
    let pid = child.id();
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        if run_bounded(&mut command, TASKKILL_TIMEOUT).is_none() {
            if let Ok(root) = env_root() {
                log_line(
                    &root,
                    &format!("taskkill /T /F (pid {pid}) did not finish within {}s; falling back to a direct kill", TASKKILL_TIMEOUT.as_secs()),
                );
            }
        }
    }
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let deadline = Instant::now() + CHILD_EXIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            if let Ok(root) = env_root() {
                log_line(
                    &root,
                    &format!("DSH child (pid {pid}) was still alive after {}s; leaving it to the job object", CHILD_EXIT_TIMEOUT.as_secs()),
                );
            }
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Stop the DSH child process tree and exit the shell.
///
/// The teardown runs on its own thread, never on the caller's: this is called
/// from the window's close handler (the UI thread) and from Tauri commands, and a
/// UI thread parked inside `taskkill`/`wait` is exactly what "the window stopped
/// responding" looks like. The window is hidden immediately so the click has
/// visible feedback, and a deadline thread guarantees the process leaves even if
/// the teardown itself wedges.
pub fn quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.begin_shutdown() {
        return;
    }
    windows::set_main_visible(app, false);
    let teardown_app = app.clone();
    let teardown_state = state.inner().clone();
    std::thread::spawn(move || {
        kill_child(&teardown_state);
        teardown_app.exit(0);
    });
    std::thread::spawn(move || {
        std::thread::sleep(SHUTDOWN_GRACE);
        if let Ok(root) = env_root() {
            log_line(
                &root,
                &format!(
                    "shutdown did not finish within {}s; exiting anyway (the job object takes the DSH child tree with us)",
                    SHUTDOWN_GRACE.as_secs()
                ),
            );
        }
        std::process::exit(0);
    });
}

/// Kill the running DSH child and start a fresh one in the same window.
///
/// Like [`quit`], the kill runs off the UI thread; a second request while a
/// restart is already in flight is ignored rather than starting a second DSH
/// child against the same environment.
pub fn restart_service(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.begin_restart() {
        return;
    }
    {
        let mut inner = state.lock();
        inner.status = Status::default();
        inner.log.clear();
        // The previous child's output must not make the new startup look like it
        // is already making progress.
        inner.last_output_at = None;
        inner.pending_close = false;
    }
    let worker_app = app.clone();
    let worker_state = state.inner().clone();
    std::thread::spawn(move || {
        kill_child(&worker_state);
        if let Err(error) = launch(&worker_state, &worker_app) {
            worker_state.set_error(error);
        }
        worker_state.end_restart();
    });
}

#[tauri::command]
fn webui_status(state: tauri::State<'_, AppState>) -> Status {
    state.lock().status.clone()
}

#[tauri::command]
fn desktop_environment() -> String {
    env_root().map(|root| dsh::environment_name(&root)).unwrap_or_else(|_| "desktop".to_string())
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
        environment: dsh::environment_name(&root),
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
    let root = env_root()?;
    let installed = update::read_installed_version(&root);
    Ok(settings::freshen_last_check(settings::load(&root), installed.as_deref()))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SettingsPatch {
    close_action: Option<String>,
    tray_enabled: Option<bool>,
    update_source: Option<String>,
    update_proxy: Option<String>,
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
    settings::save(&root, &current)?;
    tray::sync(&app, current.tray_enabled);
    // Saving an unrelated preference must not turn an expired check back into a
    // current one, so the window gets the same re-stamped view `get_settings`
    // hands out. What was written above is the record as it was recorded.
    let installed = update::read_installed_version(&root);
    Ok(settings::freshen_last_check(current, installed.as_deref()))
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

/// Apply the pending desktop update to this environment.
///
/// Two acknowledgements travel with the click: `force` overrides the "same
/// version, different bytes" refusal inside [`update::apply`], and
/// `confirm_running` acknowledges that this environment's DSH is still running.
/// Neither is a lock — both exist so the settings window can show what is about
/// to happen and let the operator decide. The running-DSH probe only knows about
/// the child *this* shell started; a DSH launched by `dpx run --desktop` is not
/// visible to it (see [`AppState::live_child_pid`]).
#[tauri::command]
async fn apply_desktop_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    force: Option<bool>,
    confirm_running: Option<bool>,
) -> Result<ApplyResult, String> {
    let force = force.unwrap_or(false);
    if !confirm_running.unwrap_or(false) {
        if let Some(pid) = state.live_child_pid() {
            if let Ok(root) = env_root() {
                log_line(&root, &format!("desktop update preflight: DSH is still running (pid {pid}); waiting for confirmation"));
            }
            return Err(format!(
                "该环境内的 DSH 仍在运行（pid {pid}）。更新会替换启动器并重启桌面外壳，正在运行的这个 DSH 会被终止。\n\n确认要继续请再次点击“立即更新”。"
            ));
        }
    }
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let root = env_root()?;
        let mut current = settings::load(&root);
        let outcome = update::apply(&root, &current, force)?;
        // The launcher the window's recorded check describes is the one that just
        // went away, and this process is about to restart. Stamp the record with
        // what was installed, so the window that comes back cannot show the old
        // version next to the new one (the other half of that fix lives in
        // `settings::freshen_last_check`, which covers updates applied elsewhere).
        let source = update::effective_source(&current);
        current.last_check =
            Some(settings::LastCheck::after_apply(&outcome.version, source, settings::now_millis()));
        let _ = settings::save(&root, &current);
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
    state.lock().pending_close
}

#[tauri::command]
fn resolve_close_request(app: tauri::AppHandle, state: tauri::State<'_, AppState>, action: String, remember: bool) -> Result<String, String> {
    let root = env_root()?;
    state.lock().pending_close = false;
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
            windows::hide_main(&app);
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

/// Open a terminal that is *inside* this environment.
///
/// The launcher is the one place where "inside the environment" is certain: it
/// derived the environment root from its own location and applies the same
/// [`dsh::runtime_env`] the DSH child receives. A terminal opened here is a
/// concrete, testable answer to "which copy am I using?", instead of rules the
/// operator has to remember — and it is the desktop-side counterpart of
/// `dpx env use`.
#[tauri::command]
fn open_environment_shell() -> Result<String, String> {
    let root = env_root()?;
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).map_err(|error| format!("无法创建工作目录：{error}"))?;
    let name = dsh::environment_name(&root);
    let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| std::ffi::OsString::from("cmd.exe"));
    let mut cmd = Command::new(comspec);
    cmd.arg("/k")
        .arg(format!("title dsh-dpx {name}"))
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in dsh::SCRUBBED_ENV {
        cmd.env_remove(key);
    }
    for (key, value) in dsh::runtime_env(&root) {
        cmd.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    let child = cmd.spawn().map_err(|error| format!("无法打开环境终端：{error}"))?;
    log_line(&root, &format!("opened an environment shell (pid {}) in {}", child.id(), workspace.display()));
    Ok(workspace.display().to_string())
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
            open_state_dir,
            open_environment_shell
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
                        windows::hide_main(&app);
                        // Recorded because a hide that silently does nothing is
                        // the whole symptom this line exists to make visible.
                        let visible = windows::main_is_visible(&app);
                        log_line(
                            &root,
                            &format!("close request: minimized to the notification area (window visible afterwards: {visible})"),
                        );
                    }
                    settings::CloseAction::Ask => {
                        api.prevent_close();
                        {
                            let state = app.state::<AppState>();
                            state.lock().pending_close = true;
                        }
                        // The dialog is a WebView2 window: building one inside
                        // the WM_CLOSE dispatch can wedge the message loop, so
                        // open it once this handler has returned.
                        let dialog_app = app.clone();
                        let dialog_root = root.clone();
                        if let Err(error) = app.run_on_main_thread(move || {
                            if let Err(error) = windows::open_close_dialog(&dialog_app) {
                                // Never trap the user in an unclosable window.
                                log_line(&dialog_root, &format!("close dialog failed, hiding instead: {error}"));
                                windows::hide_main(&dialog_app);
                            }
                        }) {
                            log_line(&root, &format!("close dialog could not be scheduled, hiding instead: {error}"));
                            windows::hide_main(&app);
                        }
                    }
                }
            });

            windows::show_main(&handle);
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
    state.lock().child = Some(child);

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
                    adopt_ready_url(&reader_state, &url);
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
        let started = Instant::now();
        let deadline = started + STARTUP_TIMEOUT;
        let mut slow_reported = false;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let exited = {
                let mut inner = monitor_state.lock();
                // "slow" keeps this thread alive on purpose: a startup that is
                // merely late must still notice a child that dies later, and it
                // must still notice the ready line.
                if !matches!(inner.status.state, "starting" | "slow") {
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
            if !slow_reported && Instant::now() >= deadline {
                // Say it once, report whether the child is still producing
                // output, and keep waiting. This replaced a hard timeout that
                // killed the monitor thread and reported a failure for a startup
                // that was still perfectly healthy, just slow.
                slow_reported = true;
                let mut message = None;
                {
                    let mut inner = monitor_state.lock();
                    if inner.status.state == "starting" {
                        let slow = slow_start_message(started.elapsed(), inner.last_output_at.map(|at| at.elapsed()));
                        inner.status.state = "slow";
                        inner.status.message = Some(slow.clone());
                        message = Some(slow);
                    }
                }
                if let (Some(message), Ok(root)) = (message, env_root()) {
                    log_line(&root, &message);
                }
            }
        }
    });
    Ok(())
}

/// Adopt the ready URL parsed out of the child's output.
///
/// Both `starting` and `slow` are startups in flight: a launch that crossed the
/// startup deadline and was reported as slow must still be able to become ready
/// when its URL finally arrives, otherwise the window would keep announcing a
/// slow startup behind an already loaded UI.
fn adopt_ready_url(state: &AppState, url: &str) {
    let mut inner = state.lock();
    if matches!(inner.status.state, "starting" | "slow") {
        inner.status.state = "ready";
        inner.status.url = Some(url.to_string());
        inner.status.message = None;
    }
}

/// The one-time "still starting" line the startup screen shows past
/// [`STARTUP_TIMEOUT`].
///
/// `since_output` is how long ago the child last wrote to stdout or stderr:
/// output within [`STARTUP_SILENCE`] means the startup is still making progress,
/// and a long silence is worth saying out loud because it is what a real hang
/// looks like.
fn slow_start_message(elapsed: Duration, since_output: Option<Duration>) -> String {
    let progress = match since_output {
        Some(silence) if silence <= STARTUP_SILENCE => format!("最近一次输出在 {} 秒前，看起来仍在推进", silence.as_secs()),
        Some(silence) => format!("已经 {} 秒没有新的输出", silence.as_secs()),
        None => "还没有收到任何输出".to_string(),
    };
    format!(
        "DSH 仍在启动（已等待 {} 秒；{progress}）。继续等待不会被中断；若长时间没有变化，可点击“重试”或查看日志。",
        elapsed.as_secs()
    )
}

/// How much of the DSH child's output the startup screen keeps in memory.
const MAX_LOG_BYTES: usize = 200_000;

fn append_log(state: &AppState, line: &str) {
    // Redact before buffering, not only on the way to disk: this buffer is what
    // `log_tail` renders into the startup page, and the child inherits this
    // process's environment, so a `*_KEY`/`*_TOKEN` value can appear in its
    // output verbatim.
    let line = redact(line, secret_values());
    let mut inner = state.lock();
    inner.last_output_at = Some(Instant::now());
    inner.log.push_str(&line);
    inner.log.push('\n');
    if inner.log.len() > MAX_LOG_BYTES {
        // `String::split_off` panics unless the index sits on a character
        // boundary, and this buffer holds arbitrary child output — Chinese
        // paths, agent text, stack traces. Splitting mid-character would take
        // the reader thread down (and poison the state lock) over a *log line*,
        // so walk back to a boundary instead.
        let mut cut = inner.log.len() - MAX_LOG_BYTES / 2;
        while cut > 0 && !inner.log.is_char_boundary(cut) {
            cut -= 1;
        }
        inner.log = inner.log.split_off(cut);
    }
}

/// True when a variable name looks like it holds a credential.
///
/// The same name test the official packaging script uses (`KEY|SECRET|TOKEN|
/// PASSWORD`, case-insensitive). It is deliberately blunt: the cost of a missed
/// credential in `shell.log` is a leaked key, the cost of a false positive is a
/// redacted line.
fn is_secret_name(name: &str) -> bool {
    const MARKERS: [&str; 4] = ["KEY", "SECRET", "TOKEN", "PASSWORD"];
    let upper = name.to_ascii_uppercase();
    MARKERS.iter().any(|marker| upper.contains(marker))
}

/// The credential values worth redacting: named like a credential and long
/// enough to be one.
///
/// Sorted longest first so the left-to-right scan in [`redact`] behaves like
/// leftmost-longest matching when one value is a prefix of another.
fn credential_values(entries: impl Iterator<Item = (String, String)>) -> Vec<String> {
    let mut values: Vec<String> = entries
        .filter(|(name, _)| is_secret_name(name))
        .map(|(_, value)| value)
        .filter(|value| value.len() >= MIN_SECRET_CHARS)
        .collect();
    values.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    values.dedup();
    values
}

/// Credential values from this process's environment, read once.
///
/// Cached because this runs on the child-output reader thread for every line,
/// and the environment cannot change under a running process.
fn secret_values() -> &'static [String] {
    static VALUES: OnceLock<Vec<String>> = OnceLock::new();
    VALUES.get_or_init(|| {
        credential_values(
            std::env::vars_os()
                .map(|(name, value)| (name.to_string_lossy().to_string(), value.to_string_lossy().to_string())),
        )
    })
}

/// Replace every credential value in `message` with `[REDACTED]`.
///
/// Two rules, because a value inherited from this process's environment is not
/// the only way a credential reaches the log:
///
/// * by value — the shell hands its own environment to the DSH child, so any
///   value of a variable named like a credential is replaced wherever the child
///   echoes it back;
/// * by query parameter name — the ready URL's `?token=…` is generated by DSH
///   itself and is not in this environment at all, so only the *name* can
///   identify it.
///
/// Values are replaced first: that pass scans the caller's text, so the marker it
/// inserts can never be matched again by the parameter pass.
fn redact(message: &str, secrets: &[String]) -> String {
    redact_query_parameters(&redact_values(message, secrets))
}

/// Replace the given literal values with `[REDACTED]`.
///
/// A hand-written scan rather than a pattern match: this crate has no regex
/// dependency, and replacing exact inherited values cannot be defeated by the
/// escaping that would fool a regex. Only whole characters and whole values are
/// copied, so multi-byte text around a value survives intact.
fn redact_values(message: &str, secrets: &[String]) -> String {
    const MARKER: &str = "[REDACTED]";
    if secrets.is_empty() || message.is_empty() {
        return message.to_string();
    }
    let bytes = message.as_bytes();
    let mut redacted = String::with_capacity(message.len());
    let mut index = 0;
    while index < bytes.len() {
        match secrets.iter().find(|secret| bytes[index..].starts_with(secret.as_bytes())) {
            Some(secret) => {
                redacted.push_str(MARKER);
                index += secret.len();
            }
            None => {
                // Every step advanced by a whole character or a whole secret, and
                // secrets are UTF-8 themselves, so `index` is always a boundary.
                let character = message[index..].chars().next().expect("index is on a character boundary");
                redacted.push(character);
                index += character.len_utf8();
            }
        }
    }
    redacted
}

/// The longest parameter name that is still treated as a name.
const MAX_PARAM_NAME_CHARS: usize = 64;

/// Replace the value of every `name=value` query parameter whose name looks like
/// a credential, keeping the `?`/`&`, the name and the `=` as they were.
///
/// This does not parse URLs: a parameter is any run of name characters after
/// `?` or `&` and before `=`, and its value ends at `&`, whitespace, or a
/// character that would be a delimiter in the surrounding text (so a URL inside
/// a JSON line keeps its closing quote).
fn redact_query_parameters(message: &str) -> String {
    const MARKER: &str = "[REDACTED]";
    let bytes = message.as_bytes();
    let mut redacted = String::with_capacity(message.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'?' || byte == b'&' {
            let pair = query_parameter(message, index + 1).filter(|(name_end, value_end)| {
                is_secret_name(&message[index + 1..*name_end]) && *value_end > *name_end + 1
            });
            if let Some((name_end, value_end)) = pair {
                // `?name=` verbatim, then the marker instead of the value.
                redacted.push(byte as char);
                redacted.push_str(&message[index + 1..=name_end]);
                redacted.push_str(MARKER);
                index = value_end;
                continue;
            }
        }
        let character = message[index..].chars().next().expect("index is on a character boundary");
        redacted.push(character);
        index += character.len_utf8();
    }
    redacted
}

/// The bounds of the `name=value` pair starting at `start`, as
/// `(index of '=', index just past the value)`; `None` when `start` does not
/// begin a parameter.
fn query_parameter(message: &str, start: usize) -> Option<(usize, usize)> {
    let bytes = message.as_bytes();
    let mut cursor = start;
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if byte == b'=' {
            // An empty name is not a parameter, and an unbroken 64-character run
            // is prose rather than a name; both would turn this into a redactor
            // that fires on ordinary text.
            return (cursor > start && cursor - start <= MAX_PARAM_NAME_CHARS)
                .then(|| (cursor, parameter_value_end(message, cursor + 1)));
        }
        if !(byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'[' | b']')) {
            return None;
        }
        cursor += 1;
    }
    None
}

/// The end of a parameter value starting at `start`: the next `&`, whitespace,
/// or delimiter, whichever comes first.
fn parameter_value_end(message: &str, start: usize) -> usize {
    let bytes = message.as_bytes();
    let mut cursor = start;
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if byte == b'&' || byte.is_ascii_whitespace() || matches!(byte, b'"' | b'\'' | b'<' | b'>' | b')' | b']' | b'}') {
            break;
        }
        cursor += 1;
    }
    // The value is copied as text, so it must end on a character boundary.
    while cursor > start && !message.is_char_boundary(cursor) {
        cursor -= 1;
    }
    cursor
}

/// Rotate `shell.log` to `shell.log.1` once it reaches `limit` bytes.
///
/// One generation is kept: the log explains the current startup, and an
/// unbounded append is what let a long-running environment's log grow without
/// limit. Returns whether a rotation happened.
fn rotate_log(path: &Path, limit: u64) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else { return false };
    if metadata.len() < limit {
        return false;
    }
    let Some(name) = path.file_name().map(|name| name.to_string_lossy().to_string()) else { return false };
    let previous = path.with_file_name(format!("{name}.1"));
    let _ = std::fs::remove_file(&previous);
    std::fs::rename(path, &previous).is_ok()
}

/// Append one line to `<env-root>/desktop-state/shell.log`.
///
/// This is the only place that writes the log, which is why rotation and value
/// redaction live here: every line from the shell, the tray, the update path and
/// the DSH child itself passes through this function.
pub fn log_line(root: &Path, message: &str) {
    let path = log_path(root);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    rotate_log(&path, MAX_LOG_FILE_BYTES);
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis()).unwrap_or(0);
    let message = redact(message, secret_values());
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{millis}] {message}");
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

fn webview_data_dir(root: &Path) -> PathBuf {
    settings::state_dir(root).join("webview2")
}

fn log_path(root: &Path) -> PathBuf {
    settings::logs_path(root)
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
    use crate::{run_bounded, AppState, CHILD_EXIT_TIMEOUT, MAX_LOG_BYTES, SHUTDOWN_GRACE, TASKKILL_TIMEOUT};
    use std::path::Path;
    use std::process::Command;
    use std::time::{Duration, Instant};

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

    /// Clicking X twice while the first shutdown is still tearing down the DSH
    /// child must not start a second `taskkill`/teardown.
    #[test]
    fn a_shutdown_is_only_started_once() {
        let state = AppState::default();
        assert!(state.begin_shutdown());
        assert!(!state.begin_shutdown());
    }

    /// The tray's "restart DSH" must not stack two DSH children on one
    /// environment, and must not race a shutdown.
    #[test]
    fn a_restart_is_only_started_once_until_it_finishes() {
        let state = AppState::default();
        assert!(state.begin_restart());
        assert!(!state.begin_restart(), "a second restart must wait for the first");
        state.end_restart();
        assert!(state.begin_restart());

        let closing = AppState::default();
        assert!(closing.begin_shutdown());
        assert!(!closing.begin_restart(), "a restart must not start while the shell is exiting");
    }

    /// The shutdown path used to `wait()` without a deadline. A helper that
    /// ignores its work must be abandoned at the deadline instead of parking the
    /// shell.
    #[test]
    fn a_helper_that_outlives_its_deadline_is_abandoned() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping", "-n", "20", "127.0.0.1"]);
            command
        } else {
            let mut command = Command::new("sleep");
            command.arg("20");
            command
        };
        let started = Instant::now();
        let status = run_bounded(&mut command, Duration::from_millis(300));
        assert!(status.is_none(), "a helper past its deadline must be reported as abandoned");
        assert!(started.elapsed() < Duration::from_secs(5), "run_bounded must not outlive its deadline");
    }

    /// Every wait on the shutdown path has a deadline, and the whole teardown
    /// stays well inside the range a user reads as "slow" rather than "hung".
    #[test]
    fn shutdown_waits_are_bounded() {
        assert!(TASKKILL_TIMEOUT <= Duration::from_secs(10));
        assert!(CHILD_EXIT_TIMEOUT <= Duration::from_secs(10));
        assert!(
            SHUTDOWN_GRACE <= TASKKILL_TIMEOUT + CHILD_EXIT_TIMEOUT + Duration::from_secs(5),
            "the shutdown deadline must cover the bounded waits and still be short"
        );
    }

    /// One panicking thread used to be enough to disable the shell: every window
    /// event and command locks this state, and a poisoned `Mutex` made every
    /// later `unwrap()` panic too — which is indistinguishable from "the window
    /// stopped reacting".
    #[test]
    fn a_poisoned_state_lock_does_not_disable_the_shell() {
        let state = AppState::default();
        let poisoner = state.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock();
            panic!("a shell thread panicked while holding the state lock");
        })
        .join();

        assert!(state.begin_shutdown(), "the shell must still be able to act after a poisoned lock");
        assert!(!state.begin_shutdown());
        state.end_restart();
    }

    /// The in-memory log carries arbitrary child output, so truncating it must
    /// never slice a multi-byte character in half.
    #[test]
    fn log_truncation_never_splits_a_character() {
        let state = AppState::default();
        let line = "环境日志".repeat(15_000);
        for _ in 0..2 {
            crate::append_log(&state, &line);
        }
        let log = state.lock().log.clone();
        assert!(log.len() <= MAX_LOG_BYTES + line.len(), "the log must stay bounded, got {}", log.len());
        assert!(log.chars().count() > 0);
        assert!(log.contains('环') || log.contains('境'), "truncation must keep whole characters");
    }

    /// Child output is what makes a late startup "slow but working" rather than
    /// "silent and probably stuck", so every line must stamp the time.
    #[test]
    fn child_output_is_recorded_as_startup_progress() {
        let state = AppState::default();
        assert!(state.lock().last_output_at.is_none(), "a fresh shell has seen no output");
        crate::append_log(&state, "dsh is working");
        let first = state.lock().last_output_at.expect("output must be stamped");
        std::thread::sleep(Duration::from_millis(5));
        crate::append_log(&state, "dsh is still working");
        let second = state.lock().last_output_at.expect("output must be stamped");
        assert!(second > first, "the stamp must move forward with each line");
    }

    /// A startup that passed the deadline is a prompt, not a failure: the
    /// message reports elapsed time and progress, and the state has to still be
    /// able to become an error when the child dies after it.
    #[test]
    fn a_late_startup_is_a_prompt_that_can_still_fail() {
        let recent = crate::slow_start_message(Duration::from_secs(181), Some(Duration::from_secs(3)));
        assert!(recent.contains("仍在启动"), "{recent}");
        assert!(recent.contains("仍在推进"), "{recent}");
        let silent = crate::slow_start_message(Duration::from_secs(181), Some(Duration::from_secs(300)));
        assert!(silent.contains("没有新的输出"), "{silent}");
        let nothing = crate::slow_start_message(Duration::from_secs(181), None);
        assert!(nothing.contains("还没有收到任何输出"), "{nothing}");

        let state = AppState::default();
        state.lock().status.state = "slow";
        state.set_error("DSH 进程提前退出（exit code 1）。".to_string());
        let inner = state.lock();
        assert_eq!(inner.status.state, "error", "a slow startup must still be able to fail");
    }

    /// A startup reported as slow is still the startup: the ready line that
    /// arrives after the deadline has to be adopted, and it has to clear the
    /// notice so the startup page does not keep announcing a slow start.
    #[test]
    fn a_slow_startup_still_becomes_ready() {
        let state = AppState::default();
        {
            let mut inner = state.lock();
            inner.status.state = "slow";
            inner.status.message = Some("DSH 仍在启动…".to_string());
        }
        crate::adopt_ready_url(&state, "http://127.0.0.1:3080/?token=x");
        // The guard is scoped on purpose: this is a plain `std::sync::Mutex`, so
        // holding it while locking again on the same thread deadlocks the whole
        // test binary instead of failing the assertion.
        {
            let inner = state.lock();
            assert_eq!(inner.status.state, "ready");
            assert_eq!(inner.status.url.as_deref(), Some("http://127.0.0.1:3080/?token=x"));
            assert!(inner.status.message.is_none());
        }

        // An already ready or failed startup is not overwritten by a later line.
        crate::adopt_ready_url(&state, "http://127.0.0.1:1/");
        assert_eq!(state.lock().status.url.as_deref(), Some("http://127.0.0.1:3080/?token=x"));
    }

    /// Only credential-looking names are collected, and only values long enough
    /// to be a credential: a two-character value would rewrite ordinary log text.
    #[test]
    fn credential_values_are_selected_by_name_and_length() {
        let entries = [
            ("DEEPSEEK_API_KEY".to_string(), "sk-0123456789abcdef".to_string()),
            ("MY_TOKEN".to_string(), "abcdefgh".to_string()),
            ("SHORT_PASSWORD".to_string(), "pw".to_string()),
            ("HTTPS_PROXY".to_string(), "http://127.0.0.1:7897".to_string()),
            ("PATH".to_string(), "C:\\Windows".to_string()),
        ];
        let values = crate::credential_values(entries.into_iter());
        assert_eq!(values, vec!["sk-0123456789abcdef".to_string(), "abcdefgh".to_string()]);
    }

    /// The token in the ready URL is generated by DSH, so it is not in this
    /// shell's environment and the value pass cannot know it. Only its name can
    /// identify it — and hiding it must not mangle the rest of the URL, because
    /// that URL is the main diagnostic in the log.
    #[test]
    fn query_parameters_named_like_credentials_are_redacted_by_name() {
        let ready = "dsh web: http://127.0.0.1:3080/?token=abc123";
        assert_eq!(
            crate::redact(ready, &[]),
            "dsh web: http://127.0.0.1:3080/?token=[REDACTED]",
            "the ready URL's token is not in the shell's environment"
        );

        let several = "GET /?a=1&token=xyz&b=2 done";
        assert_eq!(crate::redact(several, &[]), "GET /?a=1&token=[REDACTED]&b=2 done");

        // Name matching is case-insensitive and substring-based like the rest of
        // the credential test, but `tok` is not a credential name.
        assert_eq!(crate::redact("?TOKEN=abc", &[]), "?TOKEN=[REDACTED]");
        assert_eq!(crate::redact("?access_token=abc", &[]), "?access_token=[REDACTED]");
        assert_eq!(crate::redact("?tok=abc", &[]), "?tok=abc");
        assert_eq!(crate::redact("?a=1 normal text", &[]), "?a=1 normal text");
        // A URL inside a JSON line keeps its closing quote.
        assert_eq!(
            crate::redact(r#"{"url":"http://127.0.0.1:1/?password=hunter2"}"#, &[]),
            r#"{"url":"http://127.0.0.1:1/?password=[REDACTED]"}"#
        );
    }

    /// Replacing values must never cut a multi-byte character, in the value pass
    /// or around a redacted query parameter.
    #[test]
    fn redaction_never_splits_a_character() {
        let secrets = vec!["sk-0123456789abcdef".to_string()];
        let line = "日志：环境密钥 sk-0123456789abcdef 已加载（中文说明）";
        let redacted = crate::redact(line, &secrets);
        assert_eq!(redacted, "日志：环境密钥 [REDACTED] 已加载（中文说明）");
        assert!(redacted.contains('环') && redacted.contains('境'));

        let url = "启动完成：http://127.0.0.1:3080/?token=中文令牌&done=是";
        let redacted = crate::redact(url, &[]);
        assert_eq!(redacted, "启动完成：http://127.0.0.1:3080/?token=[REDACTED]&done=是");
        // The token's own characters are gone with it; the text around it is not.
        assert!(redacted.contains('启') && redacted.contains('完') && redacted.contains("done=是"));
    }

    /// One runaway session must not be able to grow `shell.log` without limit,
    /// and the generation it displaces is the one worth keeping.
    #[test]
    fn the_log_rotates_to_one_generation() {
        let root = std::env::temp_dir().join(format!("dpx-log-rotate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let path = crate::log_path(&root);
        std::fs::create_dir_all(path.parent().expect("log directory")).expect("log directory");
        std::fs::write(&path, "first generation").expect("write log");

        assert!(!crate::rotate_log(&path, 1024), "an under-limit log must not rotate");
        assert!(path.is_file());
        assert!(crate::rotate_log(&path, 4), "an over-limit log must rotate");
        assert!(!path.exists(), "the rotated log is renamed away, not truncated");
        assert_eq!(std::fs::read_to_string(path.with_file_name("shell.log.1")).expect("generation"), "first generation");

        // The next append recreates the live file beside the kept generation.
        crate::log_line(&root, "second generation");
        assert!(std::fs::read_to_string(&path).expect("live log").contains("second generation"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The end-to-end claim the settings window and the acceptance script both
    /// depend on: whatever reaches `log_line` reaches the file with the token
    /// gone. This is the real sink, so it is tested through the real file.
    #[test]
    fn the_log_file_never_contains_a_plaintext_token() {
        let root = std::env::temp_dir().join(format!("dpx-log-token-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("log root");
        crate::log_line(&root, "stdout: dsh web: http://127.0.0.1:3080/?token=abc123");
        let text = std::fs::read_to_string(crate::log_path(&root)).expect("log file");
        assert!(!text.contains("?token=abc123"), "{text}");
        assert!(text.contains("?token=[REDACTED]"), "{text}");
        assert!(text.contains("http://127.0.0.1:3080/"), "the URL must stay diagnosable: {text}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// R2's probe only ever reports this shell's own child: no child means no
    /// prompt, and a child that already exited is not "still running".
    #[test]
    fn only_a_live_child_is_reported() {
        use std::process::{Command, Stdio};

        let state = AppState::default();
        assert!(state.live_child_pid().is_none(), "no child means nothing to warn about");

        let mut child = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping", "-n", "20", "127.0.0.1"]);
            command
        } else {
            let mut command = Command::new("sleep");
            command.arg("20");
            command
        };
        let child = child.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("helper child");
        let pid = child.id();
        state.lock().child = Some(child);
        assert_eq!(state.live_child_pid(), Some(pid), "a live child must be reported with its pid");

        let mut child = state.lock().child.take().expect("child handle");
        let _ = child.kill();
        let _ = child.wait();
        state.lock().child = Some(child);
        assert!(state.live_child_pid().is_none(), "an exited child must not be reported");
    }
}
