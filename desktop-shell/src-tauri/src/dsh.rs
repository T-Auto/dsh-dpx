//! DSH launch discovery.
//!
//! The desktop shell deliberately knows **nothing** about DSH internals. It
//! never reads the DPX registry, never calls `dpx`, and never assumes a fixed
//! entry file inside the DSH package. What it does is:
//!
//! 1. read the installed package manifest from `<env>/npm-prefix/node_modules/…`
//!    and follow the `bin` entry that package declares;
//! 2. start it with a documented, overridable argument list (default:
//!    `web --no-open --port 0`);
//! 3. read the readiness URL from the child's output with a tolerant parser.
//!
//! Every one of those three steps can be re-pointed without rebuilding this
//! shell through `<env-root>/desktop-state/shell.json`, so an upstream DSH that
//! renames its entry file, moves its CLI flags, or changes its log line stays
//! compatible with an already-installed launcher.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Deserialize;

pub const DEFAULT_DSH_PACKAGE: &str = "@deepseek-ai/dsh";
pub const SHELL_CONFIG_NAME: &str = "shell.json";
pub const DEFAULT_PORT: &str = "0";

/// Optional, shell-owned launch contract: `<env-root>/desktop-state/shell.json`.
///
/// ```json
/// {
///   "dshPackage": "@deepseek-ai/dsh",
///   "dshEntry": "npm-prefix/node_modules/@deepseek-ai/dsh/lib/bin.js",
///   "launchArgs": ["web", "--no-open", "--port", "0"],
///   "node": "C:/Program Files/nodejs/node.exe",
///   "extraEnv": { "EXAMPLE": "1" }
/// }
/// ```
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellConfig {
    pub dsh_package: Option<String>,
    pub dsh_entry: Option<String>,
    pub launch_args: Option<Vec<String>>,
    pub node: Option<String>,
    pub extra_env: Option<BTreeMap<String, String>>,
}

pub fn shell_config_path(env_root: &Path) -> PathBuf {
    env_root.join(super::settings::STATE_DIR).join(SHELL_CONFIG_NAME)
}

pub fn load_shell_config(env_root: &Path) -> Option<ShellConfig> {
    let text = std::fs::read_to_string(shell_config_path(env_root)).ok()?;
    serde_json::from_str(&text).ok()
}

/// The arguments this shell passes to the DSH entry by default.
pub fn default_launch_args() -> Vec<String> {
    ["web", "--no-open", "--port", DEFAULT_PORT].iter().map(|value| value.to_string()).collect()
}

pub struct LaunchPlan {
    pub package: String,
    pub package_version: Option<String>,
    pub entry: PathBuf,
    pub args: Vec<String>,
    pub node: PathBuf,
    pub env: Vec<(String, OsString)>,
}

impl LaunchPlan {
    /// A one-line, human-readable summary used by the settings window.
    pub fn command_line(&self) -> String {
        let mut parts = vec![self.node.display().to_string(), self.entry.display().to_string()];
        parts.extend(self.args.iter().cloned());
        parts.join(" ")
    }
}

fn package_dir(env_root: &Path, package: &str) -> PathBuf {
    let mut path = env_root.join("npm-prefix").join("node_modules");
    for segment in package.split('/') {
        path = path.join(segment);
    }
    path
}

fn resolve_node(config: &ShellConfig) -> Result<PathBuf, String> {
    if let Some(value) = config.node.as_ref().map(String::as_str).map(str::trim).filter(|value| !value.is_empty()) {
        let node = PathBuf::from(value);
        if node.is_file() {
            return Ok(node);
        }
        return Err(format!("shell.json 指定的 node 不是有效文件：{}", node.display()));
    }
    if let Some(value) = std::env::var_os("DSH_DESKTOP_NODE") {
        let node = PathBuf::from(value);
        if node.is_file() {
            return Ok(node);
        }
        return Err(format!("DSH_DESKTOP_NODE 不是有效 node.exe：{}", node.display()));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join("node.exe");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    let candidate = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
    if candidate.is_file() {
        Ok(candidate)
    } else {
        Err("找不到 node.exe。请安装 Node.js，或在 shell.json 中设置 node，或设置 DSH_DESKTOP_NODE。".to_string())
    }
}

/// Read `bin` from a package manifest and resolve the declared entry.
///
/// Accepts both npm shapes: `"bin": "lib/bin.js"` and
/// `"bin": { "dsh": "lib/bin.js" }`. The resolved path must stay inside the
/// package directory; anything else is rejected as unsafe.
fn resolve_package_entry(package_dir: &Path, package: &str) -> Result<(PathBuf, Option<String>), String> {
    let manifest = package_dir.join("package.json");
    let text = std::fs::read_to_string(&manifest).map_err(|_| format!(
        "找不到隔离环境内的 {package}。\n\n请在该环境中安装或升级它：\n  dpx npm install -g {package} --<环境名>"
    ))?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("{package} 的 package.json 无法解析：{error}"))?;
    let version = json.get("version").and_then(serde_json::Value::as_str).map(str::to_string);
    let bin_name = package.rsplit('/').next().unwrap_or(package);
    let declared = match json.get("bin") {
        Some(serde_json::Value::String(value)) => Some(value.as_str()),
        Some(serde_json::Value::Object(values)) => values
            .get(bin_name)
            .or_else(|| values.get("dsh"))
            .or_else(|| values.values().next())
            .and_then(serde_json::Value::as_str),
        _ => None,
    }
    .ok_or_else(|| format!("{package} 的 package.json 没有声明 bin 入口。"))?;
    let relative = Path::new(declared);
    if relative.is_absolute() {
        return Err(format!("{package} 的 package.json 声明了绝对 bin 路径，已拒绝：{declared}"));
    }
    let candidate = package_dir.join(relative);
    if !candidate.starts_with(package_dir) {
        return Err(format!("{package} 的 package.json 声明了不安全的 bin 入口：{declared}"));
    }
    if !candidate.is_file() {
        return Err(format!("{package} 声明的启动入口不存在：{}", candidate.display()));
    }
    Ok((candidate, version))
}

pub fn resolve_launch(env_root: &Path) -> Result<LaunchPlan, String> {
    let config = load_shell_config(env_root).unwrap_or_default();
    let package = config
        .dsh_package
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("DSH_DESKTOP_DSH_PACKAGE").ok().filter(|value| !value.trim().is_empty()))
        .unwrap_or_else(|| DEFAULT_DSH_PACKAGE.to_string());

    let (entry, package_version) = match config.dsh_entry.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(declared) => {
            let candidate = if Path::new(declared).is_absolute() {
                PathBuf::from(declared)
            } else {
                env_root.join(declared)
            };
            if !candidate.is_file() {
                return Err(format!("shell.json 指定的 dshEntry 不存在：{}", candidate.display()));
            }
            let version = std::fs::read_to_string(package_dir(env_root, &package).join("package.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .and_then(|json| json.get("version").and_then(serde_json::Value::as_str).map(str::to_string));
            (candidate, version)
        }
        None => resolve_package_entry(&package_dir(env_root, &package), &package)?,
    };

    let args = match config.launch_args.as_ref().filter(|args| !args.is_empty()) {
        Some(args) => args.clone(),
        None => match std::env::var("DSH_DESKTOP_LAUNCH_ARGS") {
            Ok(value) if !value.trim().is_empty() => value.split_whitespace().map(str::to_string).collect(),
            _ => default_launch_args(),
        },
    };
    let node = resolve_node(&config)?;
    let mut env = runtime_env(env_root);
    if let Some(extra) = config.extra_env.as_ref() {
        for (key, value) in extra {
            env.push((key.clone(), OsString::from(value)));
        }
    }
    Ok(LaunchPlan { package, package_version, entry, args, node, env })
}

/// The isolated environment variables every child DSH process receives.
///
/// This list is owned by the shell and mirrors what `dpx run` sets, so a
/// launcher started by double-click behaves exactly like one started through
/// the CLI without depending on it.
pub fn runtime_env(env_root: &Path) -> Vec<(String, OsString)> {
    let dir = |name: &str| env_root.join(name).into_os_string();
    let mut vars: Vec<(String, OsString)> = vec![
        ("DSH_HOME".into(), dir("dsh-home")),
        ("DSH_AGENTS_HOME".into(), dir("agents-home")),
        ("NPM_CONFIG_PREFIX".into(), dir("npm-prefix")),
        ("NPM_CONFIG_CACHE".into(), dir("npm-cache")),
        ("HOME".into(), dir("home")),
        ("USERPROFILE".into(), dir("home")),
        ("APPDATA".into(), dir("appdata")),
        ("LOCALAPPDATA".into(), dir("localappdata")),
        ("TEMP".into(), dir("tmp")),
        ("TMP".into(), dir("tmp")),
        ("XDG_CONFIG_HOME".into(), dir("xdg-config")),
        ("XDG_CACHE_HOME".into(), dir("xdg-cache")),
        ("XDG_DATA_HOME".into(), dir("xdg-data")),
        ("DSH_TELEMETRY_DISABLED".into(), OsString::from("1")),
    ];
    let mut search = vec![env_root.join("npm-prefix")];
    if let Some(existing) = std::env::var_os("PATH") {
        search.extend(std::env::split_paths(&existing));
    }
    if let Ok(joined) = std::env::join_paths(search) {
        vars.push(("PATH".into(), joined));
    }
    vars
}

fn first_local_url(text: &str) -> Option<String> {
    const LOCAL_PREFIXES: [&str; 3] = ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"];
    let mut best: Option<(usize, &str)> = None;
    for prefix in LOCAL_PREFIXES {
        if let Some(index) = text.find(prefix) {
            if best.map_or(true, |(current, _)| index < current) {
                best = Some((index, prefix));
            }
        }
    }
    let (index, prefix) = best?;
    Some(trim_url_token(&text[index..], prefix.len()))
}

fn first_any_url(text: &str) -> Option<String> {
    let mut best: Option<(usize, &str)> = None;
    for prefix in ["http://", "https://"] {
        if let Some(index) = text.find(prefix) {
            if best.map_or(true, |(current, _)| index < current) {
                best = Some((index, prefix));
            }
        }
    }
    let (index, prefix) = best?;
    Some(trim_url_token(&text[index..], prefix.len()))
}

fn trim_url_token(text: &str, minimum: usize) -> String {
    let end = text
        .find(|character: char| character.is_whitespace() || matches!(character, '"' | '\'' | ')' | '>' | ',' | ';'))
        .unwrap_or(text.len());
    let token = text[..end].trim_end_matches(['.', ',', ';', ':']);
    if token.len() > minimum { token.to_string() } else { String::new() }
}

/// Extract the Web UI URL from one line of DSH output.
///
/// Preferred: the documented readiness line `dsh web: <url>` (DSH itself parses
/// this with `/dsh web: (http:\/\/[^\s]+)/`). Fallbacks: any loopback URL on the
/// line, then any `http(s)://` token when the readiness marker was present.
/// This keeps working when upstream rewords its logging.
pub fn extract_url(line: &str) -> Option<String> {
    if let Some(index) = line.find("dsh web:") {
        let rest = &line[index + "dsh web:".len()..];
        if let Some(url) = first_local_url(rest).or_else(|| first_any_url(rest)) {
            return Some(url);
        }
    }
    let url = first_local_url(line)?;
    (!url.is_empty()).then_some(url)
}

#[cfg(test)]
mod tests {
    use super::{default_launch_args, extract_url, runtime_env, trim_url_token};
    use std::path::Path;

    #[test]
    fn reads_the_documented_readiness_line() {
        assert_eq!(
            extract_url("dsh web: http://127.0.0.1:3080/?token=abc").as_deref(),
            Some("http://127.0.0.1:3080/?token=abc")
        );
        assert_eq!(
            extract_url("dsh web: http://127.0.0.1:51234/?token=x (LAN: http://10.0.0.5:51234/?token=x)").as_deref(),
            Some("http://127.0.0.1:51234/?token=x")
        );
    }

    #[test]
    fn tolerates_reworded_log_lines() {
        assert_eq!(extract_url("listening on http://localhost:41000/?token=t").as_deref(), Some("http://localhost:41000/?token=t"));
        assert_eq!(extract_url("ready at http://127.0.0.1:9/ (pid 1)").as_deref(), Some("http://127.0.0.1:9/"));
        assert_eq!(extract_url("no server here"), None);
        assert_eq!(extract_url("see https://example.com/docs"), None);
    }

    #[test]
    fn token_trimming_drops_trailing_punctuation() {
        assert_eq!(trim_url_token("http://127.0.0.1:1/.", 7), "http://127.0.0.1:1/");
    }

    #[test]
    fn runtime_environment_is_isolated_below_the_environment_root() {
        let root = Path::new(r"C:\environments\test");
        let env = runtime_env(root);
        let lookup = |key: &str| env.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone());
        assert_eq!(lookup("DSH_HOME").unwrap(), root.join("dsh-home").into_os_string());
        assert_eq!(lookup("USERPROFILE").unwrap(), root.join("home").into_os_string());
        assert_eq!(lookup("DSH_TELEMETRY_DISABLED").unwrap(), std::ffi::OsString::from("1"));
        assert!(lookup("PATH").unwrap().to_string_lossy().starts_with(&root.join("npm-prefix").to_string_lossy().to_string()));
    }

    #[test]
    fn default_arguments_ask_dsh_for_an_ephemeral_loopback_port() {
        assert_eq!(default_launch_args(), vec!["web", "--no-open", "--port", "0"]);
    }
}
