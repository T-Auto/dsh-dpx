//! A self-contained shell copied into `<dpx-environment>/desktop/`.
//!
//! It never reads the DPX registry and has no dependency on the `dpx` executable.
//! Its environment is the parent of its own `desktop` directory, so replacing DSH
//! packages in `npm-prefix` does not replace or rebuild this launcher.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
        if log.chars().count() <= max_chars { return log.to_string(); }
        let tail: String = log.chars().rev().take(max_chars).collect::<String>().chars().rev().collect();
        format!("…\n{tail}")
    }
}

#[tauri::command]
fn webui_status(state: tauri::State<'_, AppState>) -> Status {
    state.0.lock().unwrap().status.clone()
}

#[tauri::command]
fn desktop_environment() -> String {
    resolve_env_root().map(|root| environment_name(&root)).unwrap_or_else(|_| "desktop".to_string())
}

#[tauri::command]
fn restart_webui(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    kill_child(&state);
    {
        let mut inner = state.0.lock().unwrap();
        inner.status = Status::default();
        inner.log.clear();
    }
    if let Err(error) = launch(&state, &app) { state.set_error(error); }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![webui_status, desktop_environment, restart_webui])
        .setup(|app| {
            let state = app.state::<AppState>().inner().clone();
            let handle = app.handle().clone();
            // The configured WebView2 data directory is absolute and unique to
            // this environment. Create it before WebView2 initializes.
            let root = resolve_env_root().unwrap_or_else(|_| {
                std::env::current_exe().ok()
                    .and_then(|exe| exe.parent().and_then(Path::parent).map(Path::to_path_buf))
                    .unwrap_or_else(|| PathBuf::from("."))
            });
            let data_dir = webview_data_dir(&root);
            std::fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建 WebView2 数据目录：{error}"))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("DSH DeepSeek Harness Desktop")
                .inner_size(1080.0, 720.0)
                .min_inner_size(760.0, 500.0)
                .center()
                .resizable(true)
                .data_directory(data_dir)
                .build()
                .map_err(|error| format!("无法创建桌面窗口：{error}"))?;
            if let Err(error) = launch(&state, &handle) { state.set_error(error); }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the desktop application")
        .run(|app, event| {
            if let RunEvent::Exit = event { kill_child(&app.state::<AppState>()); }
        });
}

fn launch(state: &AppState, app: &tauri::AppHandle) -> Result<(), String> {
    let root = resolve_env_root()?;
    let node = resolve_node()?;
    let bin = resolve_dsh_bin(&root)?;
    // DSH and Windows file pickers derive the initial workspace location from
    // USERPROFILE\\Desktop. The launcher overrides USERPROFILE with the
    // isolated profile, so create that directory before DSH starts. This also
    // repairs environments created by an older dpx version when the EXE is
    // opened directly (without going through the dpx CLI).
    let desktop = root.join("home").join("Desktop");
    std::fs::create_dir_all(&desktop).map_err(|error| format!("无法创建桌面工作目录：{error}"))?;
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).map_err(|error| format!("无法创建工作目录：{error}"))?;

    let mut cmd = Command::new(&node);
    cmd.arg(&bin).args(["web", "--no-open", "--port", "0"])
        .current_dir(&workspace).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.env_remove("NODE_OPTIONS");
    cmd.env_remove("NODE_PATH");
    for (key, value) in runtime_env(&root) { cmd.env(key, value); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|error| format!(
        "无法启动 DSH 服务。\nnode: {}\n入口: {}\n错误: {error}", node.display(), bin.display()
    ))?;
    log_line(&root, &format!("spawned DSH process {} for {}", child.id(), root.display()));
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
                if let Some(url) = extract_url(&line) {
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
                if inner.status.state != "starting" { return; }
                inner.child.as_mut().and_then(|child| child.try_wait().ok().flatten()).map(|status| status.code())
            };
            if let Some(code) = exited {
                monitor_state.set_error(format!("DSH 进程提前退出（exit code {}）。\n\n{}", code.map_or("unknown".to_string(), |n| n.to_string()), monitor_state.log_tail(4000)));
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

fn resolve_env_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("DSH_DESKTOP_ENV") {
        let root = PathBuf::from(value);
        if root.is_dir() { return Ok(root); }
        return Err(format!("DSH_DESKTOP_ENV 不是有效环境目录：{}", root.display()));
    }
    let exe = std::env::current_exe().map_err(|error| format!("无法解析启动器路径：{error}"))?;
    let root = exe.parent().and_then(Path::parent)
        .ok_or_else(|| "无法从桌面启动器推导环境根目录。".to_string())?.to_path_buf();
    if root.is_dir() { Ok(root) } else { Err(format!("桌面启动器的环境根目录不存在：{}", root.display())) }
}

fn resolve_dsh_bin(root: &Path) -> Result<PathBuf, String> {
    let package = root.join("npm-prefix").join("node_modules").join("@deepseek-ai").join("dsh").join("package.json");
    let text = std::fs::read_to_string(&package).map_err(|_| format!(
        "找不到隔离环境内的 @deepseek-ai/dsh。\n\n请在该环境中安装或升级它：\n  dpx npm install -g @deepseek-ai/dsh --{}", environment_name(root)
    ))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|error| format!("DSH package.json 无法解析：{error}"))?;
    let bin = match json.get("bin") {
        Some(serde_json::Value::String(value)) => Some(value.as_str()),
        Some(serde_json::Value::Object(values)) => values.get("dsh").and_then(serde_json::Value::as_str),
        _ => None,
    }.ok_or_else(|| "DSH package.json 没有声明 dsh 的 bin 入口。".to_string())?;
    let root_pkg = package.parent().expect("package has parent");
    let candidate = root_pkg.join(bin);
    if Path::new(bin).is_absolute() || !candidate.starts_with(root_pkg) {
        return Err("DSH package.json 声明了不安全的 bin 入口。".to_string());
    }
    if candidate.is_file() { Ok(candidate) } else { Err(format!("DSH package.json 声明的启动入口不存在：{}", candidate.display())) }
}

fn environment_name(root: &Path) -> String {
    root.file_name().and_then(|name| name.to_str()).unwrap_or("desktop").to_string()
}

fn resolve_node() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("DSH_DESKTOP_NODE") {
        let node = PathBuf::from(value);
        if node.is_file() { return Ok(node); }
        return Err(format!("DSH_DESKTOP_NODE 不是有效 node.exe：{}", node.display()));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join("node.exe");
            if candidate.is_file() { return Ok(candidate); }
        }
    }
    let candidate = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
    if candidate.is_file() { Ok(candidate) } else { Err("找不到 node.exe。请安装 Node.js，或设置 DSH_DESKTOP_NODE。".to_string()) }
}

fn runtime_env(root: &Path) -> Vec<(&'static str, OsString)> {
    let dir = |name: &str| root.join(name).into_os_string();
    let mut vars = vec![
        ("DSH_HOME", dir("dsh-home")), ("DSH_AGENTS_HOME", dir("agents-home")),
        ("NPM_CONFIG_PREFIX", dir("npm-prefix")), ("NPM_CONFIG_CACHE", dir("npm-cache")),
        ("HOME", dir("home")), ("USERPROFILE", dir("home")), ("APPDATA", dir("appdata")),
        ("LOCALAPPDATA", dir("localappdata")), ("TEMP", dir("tmp")), ("TMP", dir("tmp")),
        ("XDG_CONFIG_HOME", dir("xdg-config")), ("XDG_CACHE_HOME", dir("xdg-cache")),
        ("XDG_DATA_HOME", dir("xdg-data")), ("DSH_TELEMETRY_DISABLED", OsString::from("1")),
    ];
    let mut search = vec![root.join("npm-prefix")];
    if let Some(existing) = std::env::var_os("PATH") { search.extend(std::env::split_paths(&existing)); }
    if let Ok(joined) = std::env::join_paths(search) { vars.push(("PATH", joined)); }
    vars
}

fn append_log(state: &AppState, line: &str) {
    let mut inner = state.0.lock().unwrap();
    inner.log.push_str(line); inner.log.push('\n');
    if inner.log.len() > 200_000 { let cut = inner.log.len() - 100_000; inner.log = inner.log.split_off(cut); }
}

fn extract_url(line: &str) -> Option<String> {
    let index = line.find("dsh web:")?;
    let url = line[index + "dsh web:".len()..].trim().split_whitespace().next()?;
    (url.starts_with("http://") || url.starts_with("https://")).then(|| url.to_string())
}

fn navigate(app: &tauri::AppHandle, url: &str) {
    let Ok(parsed) = tauri::Url::parse(url) else { return };
    let app_for_thread = app.clone();
    let app_for_window = app.clone();
    let fallback = url.to_string();
    let _ = app_for_thread.run_on_main_thread(move || {
        if let Some(window) = app_for_window.get_webview_window("main") {
            if window.navigate(parsed).is_err() {
                let literal = serde_json::to_string(&fallback).unwrap_or_else(|_| "\"/\"".to_string());
                let _ = window.eval(&format!("window.location.replace({literal})"));
            }
        }
    });
}

fn desktop_state_dir(root: &Path) -> PathBuf {
    root.join("desktop-state")
}

fn webview_data_dir(root: &Path) -> PathBuf {
    desktop_state_dir(root).join("webview2")
}

fn log_path(root: &Path) -> PathBuf {
    desktop_state_dir(root).join("shell.log")
}

fn log_line(root: &Path, message: &str) {
    let path = log_path(root);
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis()).unwrap_or(0);
        let _ = writeln!(file, "[{millis}] {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::{desktop_state_dir, log_path, webview_data_dir};
    use std::path::Path;

    #[test]
    fn desktop_state_is_below_environment_root() {
        let root = Path::new(r"C:\environments\desktop");
        assert_eq!(desktop_state_dir(root), root.join("desktop-state"));
        assert_eq!(log_path(root), root.join(r"desktop-state\shell.log"));
        assert_eq!(webview_data_dir(root), root.join(r"desktop-state\webview2"));
    }
}

fn kill_child(state: &AppState) {
    let child = state.0.lock().unwrap().child.take();
    let Some(mut child) = child else { return };
    #[cfg(windows)] {
        let _ = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}
