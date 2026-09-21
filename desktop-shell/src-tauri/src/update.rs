//! Desktop launcher updates through GitHub Releases.
//!
//! This mirrors the Node implementation in `src/desktop-release.js`; the shared,
//! machine-readable contract is documented in `docs/desktop-release.md`.
//!
//! Update sources:
//!   `github` / `github:owner/repo` / `github:owner/repo@tag`
//!   `https://…` manifest URL, `file:…` or a local path (offline testing)
//!
//! A published release has the tag `desktop-v<version>` and ships
//! `desktop-latest.json` plus `DSH-DeepSeek-Harness-Desktop-<version>-x64.exe`.
//! Updating renames the running launcher aside (Windows allows renaming a running
//! executable), copies the verified download into place, and relaunches.

use std::cmp::Ordering;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::settings::{self, LastCheck, Settings};

pub const DEFAULT_REPOSITORY: &str = "T-Auto/dsh-dpx";
pub const DEFAULT_SOURCE: &str = "github:T-Auto/dsh-dpx";
pub const MANIFEST_ASSET: &str = "desktop-latest.json";
pub const ASSET_PREFIX: &str = "DSH-DeepSeek-Harness-Desktop-";
/// Release tag prefix of the desktop channel (`desktop-v0.2.0`). The shell reads
/// manifests rather than tags, but the constant is part of the published contract
/// and is asserted by the tests below.
#[allow(dead_code)]
pub const TAG_PREFIX: &str = "desktop-v";
pub const LAUNCHER_DIR: &str = "desktop";
pub const LAUNCHER_NAME: &str = "DSH DeepSeek Harness Desktop.exe";
pub const RELEASE_KIND: &str = "DPXDesktopRelease";
pub const USER_AGENT: &str = concat!("dsh-dpx-desktop/", env!("DPX_DESKTOP_BUILD_VERSION"));
const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    #[serde(default)]
    pub schema_version: Option<u32>,
    #[serde(default)]
    pub kind: Option<String>,
    pub version: String,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub asset_name: Option<String>,
    #[serde(default)]
    pub asset_url: Option<String>,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// Where the manifest itself came from; used to resolve a relative asset URL.
    #[serde(skip)]
    pub manifest_url: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Source {
    Github { repository: String, tag: Option<String> },
    Url(String),
    File(PathBuf),
}

impl Source {
    pub fn label(&self) -> String {
        match self {
            Source::Github { repository, tag: Some(tag) } => format!("github:{repository}@{tag}"),
            Source::Github { repository, tag: None } => format!("github:{repository}"),
            Source::Url(url) => url.clone(),
            Source::File(path) => path.display().to_string(),
        }
    }
}

pub fn parse_source(source: &str) -> Result<Source, String> {
    let value = source.trim();
    let value = if value.is_empty() { DEFAULT_SOURCE } else { value };
    if let Some(rest) = value.strip_prefix("github:") {
        let rest = rest.trim();
        let rest = if rest.is_empty() { DEFAULT_REPOSITORY } else { rest };
        let (repository, tag) = match rest.rsplit_once('@') {
            Some((repository, tag)) if !repository.is_empty() && !tag.is_empty() => (repository, Some(tag.to_string())),
            _ => (rest, None),
        };
        if !repository.contains('/') || repository.split('/').any(|part| part.is_empty()) {
            return Err(format!("GitHub 仓库名无效：{repository}"));
        }
        return Ok(Source::Github { repository: repository.to_string(), tag });
    }
    if value.starts_with("github") && !value.contains(':') {
        return Ok(Source::Github { repository: DEFAULT_REPOSITORY.to_string(), tag: None });
    }
    if value.starts_with("http://") || value.starts_with("https://") {
        return Ok(Source::Url(value.to_string()));
    }
    if let Some(rest) = value.strip_prefix("file://") {
        let path = rest.trim_start_matches('/');
        return Ok(Source::File(PathBuf::from(path.replace('/', "\\"))));
    }
    if value.starts_with("file:") {
        return Ok(Source::File(PathBuf::from(value.trim_start_matches("file:"))));
    }
    Ok(Source::File(PathBuf::from(value)))
}

pub fn manifest_url(source: &Source) -> String {
    match source {
        Source::Url(url) => url.clone(),
        Source::File(path) => path.display().to_string(),
        Source::Github { repository, tag } => {
            let release = match tag {
                Some(tag) => format!("releases/download/{tag}"),
                None => "releases/latest/download".to_string(),
            };
            format!("https://github.com/{repository}/{release}/{MANIFEST_ASSET}")
        }
    }
}

fn proxy_from_environment() -> Option<String> {
    const KEYS: [&str; 8] = [
        "DPX_HTTP_PROXY",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "DEFAULT_PROXY",
    ];
    KEYS.iter().find_map(|key| std::env::var(key).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty()))
}

pub fn effective_proxy(settings: &Settings) -> Option<String> {
    settings
        .update_proxy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(proxy_from_environment)
}

fn agent(proxy: Option<&str>) -> Result<ureq::Agent, String> {
    let mut builder = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .user_agent(USER_AGENT);
    if let Some(proxy) = proxy {
        let parsed = ureq::Proxy::new(proxy).map_err(|error| format!("代理地址无效（{proxy}）：{error}"))?;
        builder = builder.proxy(Some(parsed));
    }
    Ok(builder.build().into())
}

fn describe_error(error: &ureq::Error, url: &str) -> String {
    match error {
        ureq::Error::StatusCode(404) => format!("发布源没有可用的发行版（404）：{url}"),
        ureq::Error::StatusCode(code) => format!("请求 {url} 失败：HTTP {code}"),
        other => format!("请求 {url} 失败：{other}"),
    }
}

fn is_not_found(error: &ureq::Error) -> bool {
    matches!(error, ureq::Error::StatusCode(404))
}

/// Failures worth trying again: a stalled or reset connection, or a status the
/// server says is temporary. Release downloads go through proxies and CDNs that
/// occasionally stall, and one flake should not fail a user's update check.
fn is_transient(message: &str) -> bool {
    const MARKERS: [&str; 9] = [
        "timed out", "timeout", "connection reset", "connection refused", "broken pipe",
        "unexpected eof", "closed", "HTTP 408", "HTTP 5",
    ];
    let lowered = message.to_ascii_lowercase();
    MARKERS.iter().any(|marker| lowered.contains(&marker.to_ascii_lowercase()))
}

fn with_retries<T>(what: &str, mut attempt: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    const ATTEMPTS: u32 = 3;
    let mut last = String::new();
    for round in 0..ATTEMPTS {
        match attempt() {
            Ok(value) => return Ok(value),
            Err(message) => {
                let retryable = is_transient(&message);
                last = message;
                if !retryable || round + 1 == ATTEMPTS {
                    break;
                }
                log_backoff(what, round + 1, &last);
                std::thread::sleep(Duration::from_millis(700 * u64::from(round + 1)));
            }
        }
    }
    Err(last)
}

fn log_backoff(what: &str, round: u32, message: &str) {
    if let Ok(root) = crate::env_root() {
        crate::log_line(&root, &format!("{what}: transient failure (retry {round}): {message}"));
    }
}

fn fetch_bytes(url: &str, proxy: Option<&str>) -> Result<Vec<u8>, String> {
    with_retries("desktop update download", || {
        let agent = agent(proxy)?;
        let mut response = agent
            .get(url)
            .header("Accept", "application/octet-stream")
            .call()
            .map_err(|error| describe_error(&error, url))?;
        response
            .body_mut()
            .with_config()
            .limit(MAX_ASSET_BYTES)
            .read_to_vec()
            .map_err(|error| format!("下载 {url} 失败：{error}"))
    })
}

fn normalize_sha256(value: &str) -> Option<String> {
    let hex = value.trim().trim_start_matches("sha256:").to_ascii_lowercase();
    (hex.len() == 64 && hex.chars().all(|character| character.is_ascii_hexdigit())).then_some(hex)
}

fn resolve_asset_url(manifest: &ReleaseManifest) -> Option<String> {
    let raw = manifest.asset_url.as_deref().map(str::trim).filter(|value| !value.is_empty());
    if let Some(raw) = raw {
        if raw.starts_with("http://") || raw.starts_with("https://") || raw.starts_with("file:") || is_absolute_path(raw) {
            return Some(raw.to_string());
        }
        if let Some(base) = manifest.manifest_url.as_deref() {
            if base.starts_with("http://") || base.starts_with("https://") {
                let directory = base.rsplit_once('/').map(|(head, _)| head).unwrap_or(base);
                return Some(format!("{directory}/{raw}"));
            }
            let directory = Path::new(base).parent()?.to_path_buf();
            return Some(directory.join(raw).display().to_string());
        }
        return Some(raw.to_string());
    }
    let name = manifest.asset_name.clone().unwrap_or_else(|| format!("{ASSET_PREFIX}{}-x64.exe", manifest.version));
    let base = manifest.manifest_url.as_deref()?;
    if base.starts_with("http://") || base.starts_with("https://") {
        let directory = base.rsplit_once('/').map(|(head, _)| head).unwrap_or(base);
        return Some(format!("{directory}/{name}"));
    }
    Some(Path::new(base).parent()?.join(name).display().to_string())
}

fn is_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')) || value.starts_with("\\\\")
}

enum ManifestError {
    NotFound,
    Message(String),
}

fn read_manifest(url: &str, proxy: Option<&str>) -> Result<ReleaseManifest, ManifestError> {
    let text = if url.starts_with("http://") || url.starts_with("https://") {
        match with_retries("desktop update check", || {
            let agent = agent(proxy)?;
            match agent.get(url).header("Accept", "application/json").call() {
                Ok(mut response) => response
                    .body_mut()
                    .read_to_string()
                    .map_err(|error| format!("读取 {url} 响应失败：{error}")),
                Err(error) if is_not_found(&error) => Err("__NOT_FOUND__".to_string()),
                Err(error) => Err(describe_error(&error, url)),
            }
        }) {
            Ok(text) => text,
            Err(message) if message == "__NOT_FOUND__" => return Err(ManifestError::NotFound),
            Err(message) => return Err(ManifestError::Message(message)),
        }
    } else {
        std::fs::read_to_string(url).map_err(|error| ManifestError::Message(format!("无法读取发布清单 {url}：{error}")))?
    };
    parse_manifest(&text, url).map_err(ManifestError::Message)
}

fn fetch_manifest(source: &Source, proxy: Option<&str>) -> Result<ReleaseManifest, ManifestError> {
    read_manifest(&manifest_url(source), proxy)
}

fn parse_manifest(text: &str, url: &str) -> Result<ReleaseManifest, String> {
    // PowerShell's `Set-Content -Encoding utf8` writes a BOM; tolerate it.
    let text = text.trim_start_matches('\u{feff}');
    let mut manifest: ReleaseManifest =
        serde_json::from_str(text).map_err(|error| format!("发布清单 {url} 不是有效 JSON：{error}"))?;
    if let Some(kind) = manifest.kind.as_deref() {
        if kind != RELEASE_KIND {
            return Err(format!("发布清单类型不是 {RELEASE_KIND}：{kind}"));
        }
    }
    manifest.version = manifest.version.trim().trim_start_matches('v').to_string();
    if manifest.version.is_empty() {
        return Err("发布清单没有 version。".to_string());
    }
    manifest.sha256 = normalize_sha256(&manifest.sha256)
        .ok_or_else(|| format!("发布清单 {} 缺少有效的 sha256 摘要。", manifest.version))?;
    manifest.manifest_url = Some(url.to_string());
    Ok(manifest)
}

/// Compare dotted versions, treating a missing pre-release as newer.
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    fn split(value: &str) -> (Vec<String>, String) {
        let cleaned = value.trim().trim_start_matches(['v', 'V']);
        let cleaned = cleaned.split('+').next().unwrap_or(cleaned);
        match cleaned.split_once('-') {
            Some((core, pre)) => (core.split('.').map(str::to_string).collect(), pre.to_string()),
            None => (cleaned.split('.').map(str::to_string).collect(), String::new()),
        }
    }
    let (left_core, left_pre) = split(left);
    let (right_core, right_pre) = split(right);
    let length = left_core.len().max(right_core.len());
    for index in 0..length {
        let a = left_core.get(index).map(String::as_str).unwrap_or("0");
        let b = right_core.get(index).map(String::as_str).unwrap_or("0");
        if a == b {
            continue;
        }
        let ordering = match (a.parse::<u64>(), b.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            _ => a.cmp(b),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    match (left_pre.is_empty(), right_pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => compare_prerelease(&left_pre, &right_pre),
    }
}

/// Compare two pre-release fields the way semver orders identifiers.
///
/// Comparing the fields as whole strings is wrong in the one case that matters
/// for an update channel: `rc.10` sorts *before* `rc.2` as text, so a release
/// sequence that passed `rc.9` would look like a downgrade and be refused
/// forever. Identifiers are therefore compared one dot-separated field at a
/// time, numerically when both are numbers; a numeric identifier ranks below an
/// alphanumeric one, and the side with fewer fields ranks lower
/// (`1.0.0-rc < 1.0.0-rc.1`). This mirrors `compareVersions` in
/// `src/desktop-release.js`.
fn compare_prerelease(left: &str, right: &str) -> Ordering {
    let left_fields: Vec<&str> = left.split('.').collect();
    let right_fields: Vec<&str> = right.split('.').collect();
    let length = left_fields.len().max(right_fields.len());
    for index in 0..length {
        let ordering = match (left_fields.get(index).copied(), right_fields.get(index).copied()) {
            (None, None) => break,
            // A shorter set of identifiers is the lower precedence.
            (None, Some(_)) => Ordering::Less,
            (Some(_), None) => Ordering::Greater,
            (Some(a), Some(b)) => match (a.parse::<u64>(), b.parse::<u64>()) {
                (Ok(x), Ok(y)) => x.cmp(&y),
                // Numeric identifiers always have lower precedence.
                (Ok(_), Err(_)) => Ordering::Less,
                (Err(_), Ok(_)) => Ordering::Greater,
                (Err(_), Err(_)) => a.cmp(b),
            },
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

pub fn launcher_path(env_root: &Path) -> PathBuf {
    env_root.join(LAUNCHER_DIR).join(LAUNCHER_NAME)
}

pub fn updates_dir(env_root: &Path) -> PathBuf {
    settings::state_dir(env_root).join("updates")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// The digest of the launcher currently installed in the environment.
pub fn installed_digest(env_root: &Path) -> Option<String> {
    let bytes = std::fs::read(launcher_path(env_root)).ok()?;
    Some(sha256_hex(&bytes))
}

/// The channel a settings record points at: its own source, else the default feed.
///
/// Three places read that field — a check, an install, and the record an applied
/// install writes back — and one function keeps them naming the same feed, so the
/// `source` in a stamped record always matches the channel it came from.
pub fn effective_source(settings: &Settings) -> String {
    settings.update_source.clone().unwrap_or_else(|| DEFAULT_SOURCE.to_string())
}

/// Check the channel for a newer desktop launcher. Network only, never writes.
///
/// The only-upgrade rule is the same one `src/desktop-release.js` applies: an
/// older release is never `available`, and a same-version release is available
/// only when its bytes differ (a republished build), which the settings window
/// has to confirm explicitly before [`apply`] accepts it.
pub fn check(env_root: &Path, settings: &Settings) -> LastCheck {
    let source = effective_source(settings);
    let installed_version = read_installed_version(env_root);
    let digest = installed_digest(env_root);
    let mut result = LastCheck {
        at_millis: settings::now_millis(),
        source: source.clone(),
        available: false,
        installed_version,
        latest_version: None,
        reason: "unknown".to_string(),
        message: None,
    };
    let parsed = match parse_source(&source) {
        Ok(parsed) => parsed,
        Err(message) => {
            result.reason = "invalid-source".to_string();
            result.message = Some(message);
            return result;
        }
    };
    let proxy = effective_proxy(settings);
    match fetch_manifest(&parsed, proxy.as_deref()) {
        Err(ManifestError::NotFound) => {
            result.reason = "no-release".to_string();
            result.message = Some(format!("发布源 {} 还没有已发布的 desktop 版本。", parsed.label()));
        }
        Err(ManifestError::Message(message)) => {
            result.reason = "error".to_string();
            result.message = Some(message);
        }
        Ok(manifest) => {
            result.latest_version = Some(manifest.version.clone());
            let installed = result.installed_version.clone().unwrap_or_else(|| "0.0.0".to_string());
            let ordering = compare_versions(&manifest.version, &installed);
            let newer = ordering == Ordering::Greater;
            let identical = digest.as_deref() == Some(manifest.sha256.as_str());
            if !launcher_path(env_root).is_file() {
                result.available = true;
                result.reason = "not-installed".to_string();
                result.message = Some("该环境还没有桌面启动器，可直接安装。".to_string());
            } else if newer {
                result.available = true;
                result.reason = "newer-version".to_string();
                result.message = Some(format!("发现新版本 {}（当前 {installed}）。", manifest.version));
            } else if identical {
                result.reason = "up-to-date".to_string();
                result.message = Some(format!("已是最新版本 {}。", manifest.version));
            } else if ordering == Ordering::Less {
                // Only-upgrade: an older release is never available, however
                // different its bytes are. `reason` stays `different-build` for
                // the shell/CLI contract; `available: false` is what disables the
                // settings window's button and what `apply` refuses to cross.
                result.reason = "different-build".to_string();
                result.message = Some(format!(
                    "发布源上的 {} 比本地安装的 {installed} 更旧，已拒绝降级；确实要装旧版请使用 dpx desktop install --force。",
                    manifest.version
                ));
            } else {
                result.available = true;
                result.reason = "different-build".to_string();
                result.message = Some(format!(
                    "发布源上的 {} 与本地构建不同（版本同为 {installed}、字节不同），需要显式确认后才能覆盖安装。",
                    manifest.version
                ));
            }
        }
    }
    result
}

/// The desktop version recorded by the dpx installer, when present.
pub fn read_installed_version(env_root: &Path) -> Option<String> {
    let path = env_root.join(LAUNCHER_DIR).join(".dpx-desktop.json");
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version").and_then(serde_json::Value::as_str).map(str::to_string)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub version: String,
    pub launcher: String,
    pub restart: bool,
}

/// Name of the append-only update record inside `desktop-state/`.
pub const UPDATES_LOG_NAME: &str = "updates.jsonl";

/// `<env-root>/desktop-state/updates.jsonl`.
///
/// A sibling of the `updates/` staging directory rather than a file inside it:
/// [`cleanup_updates`] deletes every `.old-*` and `*.staged.exe` entry there on
/// startup, and evidence about updates must outlive the update.
pub fn updates_log_path(env_root: &Path) -> PathBuf {
    settings::state_dir(env_root).join(UPDATES_LOG_NAME)
}

/// The fixed fields of one `updates.jsonl` line.
///
/// No free text: the record says which version gave way to which, for which
/// asset digest, and whether the attempt succeeded. There is no date library in
/// this crate, so `time` is epoch milliseconds.
#[derive(Debug)]
struct ApplyRecord {
    action: &'static str,
    from_version: Option<String>,
    to_version: Option<String>,
    sha256: Option<String>,
    result: &'static str,
}

/// Append one update record. Never fails the update: evidence is worth less than
/// the update itself, so a write error only reaches `shell.log`.
fn record_update(env_root: &Path, record: &ApplyRecord) {
    let path = updates_log_path(env_root);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let line = serde_json::json!({
        "schemaVersion": 1,
        "time": settings::now_millis(),
        "action": record.action,
        "fromVersion": record.from_version,
        "toVersion": record.to_version,
        "sha256": record.sha256,
        "result": record.result,
    });
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| writeln!(file, "{line}"));
    if let Err(error) = written {
        crate::log_line(env_root, &format!("could not record the desktop update in {}: {error}", path.display()));
    }
}

/// Download, verify, and install the newest desktop launcher, then relaunch.
///
/// Only upgrades land without `force`, and `force` is the only way past both
/// refusals: a release older than the installed one, and a same-version release
/// whose bytes differ. Every attempt — including one that returns early — leaves
/// a line in `desktop-state/updates.jsonl` (see [`record_update`]).
pub fn apply(env_root: &Path, settings: &Settings, force: bool) -> Result<ApplyOutcome, String> {
    let mut record = ApplyRecord {
        action: if launcher_path(env_root).is_file() { "update" } else { "install" },
        from_version: read_installed_version(env_root),
        to_version: None,
        sha256: None,
        result: "failed",
    };
    let outcome = apply_inner(env_root, settings, force, &mut record);
    record.result = if outcome.is_ok() { "succeeded" } else { "failed" };
    record_update(env_root, &record);
    outcome
}

/// The install itself, with the record's `toVersion`/`sha256` filled in as soon
/// as the manifest is known.
fn apply_inner(env_root: &Path, settings: &Settings, force: bool, record: &mut ApplyRecord) -> Result<ApplyOutcome, String> {
    let source = effective_source(settings);
    let parsed = parse_source(&source)?;
    let proxy = effective_proxy(settings);
    let manifest = match fetch_manifest(&parsed, proxy.as_deref()) {
        Ok(manifest) => manifest,
        Err(ManifestError::NotFound) => return Err(format!("发布源 {} 还没有已发布的 desktop 版本。", parsed.label())),
        Err(ManifestError::Message(message)) => return Err(message),
    };
    let asset_url = resolve_asset_url(&manifest).ok_or_else(|| "发布清单没有可下载的资产地址。".to_string())?;
    record.to_version = Some(manifest.version.clone());
    record.sha256 = Some(manifest.sha256.clone());

    // The update door: never downgrade, and never silently swap the bytes of the
    // version that is already installed. `check()` already reports an older
    // release as unavailable, but `apply` is also reachable directly (and the
    // settings window's check result can be stale), so the rule is enforced here
    // as well — this is the last point before the launcher is replaced.
    let launcher = launcher_path(env_root);
    if launcher.is_file() {
        let installed = record.from_version.clone().unwrap_or_else(|| "0.0.0".to_string());
        match compare_versions(&manifest.version, &installed) {
            Ordering::Less => {
                return Err(format!(
                    "本地启动器版本（{installed}）比发布源上的 {} 更新，已拒绝降级；确实要装旧版请使用 dpx desktop install --force。",
                    manifest.version
                ));
            }
            Ordering::Equal if !force && installed_digest(env_root).as_deref() != Some(manifest.sha256.as_str()) => {
                return Err(format!(
                    "发布源上的 {} 与本地构建不同（同版本、不同字节），未自动替换；确认要覆盖时请显式使用强制更新。",
                    manifest.version
                ));
            }
            _ => {}
        }
    }

    let bytes = if asset_url.starts_with("http://") || asset_url.starts_with("https://") {
        fetch_bytes(&asset_url, proxy.as_deref())?
    } else {
        std::fs::read(asset_url.trim_start_matches("file:")).map_err(|error| format!("无法读取本地资产：{error}"))?
    };
    if let Some(size) = manifest.size {
        if bytes.len() as u64 != size {
            return Err(format!("下载大小不符：期望 {size} 字节，实际 {} 字节。", bytes.len()));
        }
    }
    let digest = sha256_hex(&bytes);
    if digest != manifest.sha256 {
        return Err(format!("下载摘要不符：期望 {}，实际 {digest}。已放弃安装。", manifest.sha256));
    }

    if let Some(parent) = launcher.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建启动器目录：{error}"))?;
    }
    let updates = updates_dir(env_root);
    std::fs::create_dir_all(&updates).map_err(|error| format!("无法创建更新目录：{error}"))?;
    let staged = updates.join(format!("{}-{}.staged.exe", manifest.version, std::process::id()));
    std::fs::write(&staged, &bytes).map_err(|error| format!("无法写入新启动器：{error}"))?;

    // Windows lets a running image be renamed but not overwritten, so move the
    // current launcher aside first and put the new one in its place.
    //
    // The staged file is renamed rather than copied: both live below the
    // environment root, so this is a same-volume `MoveFileEx`, which is atomic.
    // `fs::copy` truncated the destination first, so a kill in the middle of the
    // copy left an unlaunchable half-written EXE.
    let running_here = same_file(&std::env::current_exe().unwrap_or_default(), &launcher);
    let displaced = updates.join(format!("{LAUNCHER_NAME}.old-{}", settings::now_millis()));
    if running_here && launcher.is_file() {
        std::fs::rename(&launcher, &displaced).map_err(|error| format!("无法替换正在运行的启动器：{error}"))?;
    }
    if let Err(error) = std::fs::rename(&staged, &launcher) {
        if running_here && displaced.is_file() {
            let _ = std::fs::rename(&displaced, &launcher);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(format!("无法安装新启动器：{error}"));
    }

    // Record the version dpx and the settings window report.
    let stamp = env_root.join(LAUNCHER_DIR).join(".dpx-desktop.json");
    let stamp_body = serde_json::json!({
        "schemaVersion": 1,
        "platform": "win32-x64",
        "version": manifest.version,
        "sha256": digest,
        "source": source,
        "tag": manifest.tag,
        "installedAtMillis": settings::now_millis(),
        "installedBy": "desktop-shell",
    });
    let _ = std::fs::write(&stamp, format!("{stamp_body:#}\n"));

    let restart = running_here;
    if restart {
        // Record the handover in `desktop-state/shell.log`: the relaunch is the
        // one step of an update the user cannot see, and its failure used to look
        // like a successful update followed by an unexplained error dialog.
        crate::log_line(env_root, &format!("relaunching after updating to {}", manifest.version));
        if let Err(error) = schedule_relaunch(&launcher) {
            crate::log_line(env_root, &format!("could not schedule the relaunch: {error}"));
            return Err(error);
        }
    }
    Ok(ApplyOutcome { version: manifest.version, launcher: launcher.display().to_string(), restart })
}

fn same_file(left: &Path, right: &Path) -> bool {
    if left.as_os_str().is_empty() {
        return false;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy()),
    }
}

/// How long the detached helper waits before relaunching: enough for this
/// process to exit and release the per-environment single-instance lock.
pub const RELAUNCH_WAIT_TICKS: u32 = 4;

/// The command line handed to `cmd.exe /C` by [`schedule_relaunch`].
///
/// `ping` is the portable sleep (this must work with no console and no
/// PowerShell policy assumptions); `start ""` detaches the relaunch so it does
/// not die with this process. Both paths are quoted for **cmd**, not for the C
/// runtime — see [`schedule_relaunch`].
pub fn relaunch_command_line(launcher: &Path, wait_ticks: u32) -> String {
    format!("/C ping -n {wait_ticks} 127.0.0.1 >NUL & start \"\" \"{}\"", launcher.display())
}

/// Start a detached helper that waits for this process to exit, then relaunches
/// the (now replaced) launcher.
///
/// The command line is appended with `raw_arg` on purpose. `Command::args`
/// quotes arguments for the **C runtime** convention, where an embedded `"` is
/// escaped as `\"` — but `cmd.exe` parses its own command line and does not know
/// that escape, so `start "" "C:\… with spaces\…exe"` arrived mangled and Windows
/// answered with `Windows cannot find '\'`. Passing the line verbatim is the only
/// form cmd is guaranteed to read as written.
fn schedule_relaunch(launcher: &Path) -> Result<(), String> {
    schedule_relaunch_after(launcher, RELAUNCH_WAIT_TICKS)
}

fn schedule_relaunch_after(launcher: &Path, wait_ticks: u32) -> Result<(), String> {
    let line = relaunch_command_line(launcher, wait_ticks);
    let mut process = Command::new("cmd.exe");
    process.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.raw_arg(&line);
        process.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    #[cfg(not(windows))]
    {
        process.arg(&line);
    }
    process.spawn().map(|_| ()).map_err(|error| format!("无法安排重启：{error}"))
}

/// Remove launcher copies displaced by earlier updates. Safe to call on startup:
/// a file is only deletable once the process that used it has exited.
pub fn cleanup_updates(env_root: &Path) {
    let directory = updates_dir(env_root);
    let Ok(entries) = std::fs::read_dir(&directory) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains(".old-") || name.ends_with(".staged.exe") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply, check, compare_versions, effective_proxy, fetch_manifest, installed_digest, is_absolute_path, launcher_path,
        normalize_sha256, parse_source, read_installed_version, resolve_asset_url, sha256_hex, updates_dir, updates_log_path,
        ManifestError, ReleaseManifest, Source, DEFAULT_SOURCE, RELEASE_KIND,
    };
    use crate::settings::Settings;
    use std::cmp::Ordering;
    use std::path::{Path, PathBuf};

    #[test]
    fn version_comparison_follows_semver_ordering() {
        assert_eq!(compare_versions("0.2.1", "0.2.0"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.0", "0.2.0"), Ordering::Equal);
        assert_eq!(compare_versions("0.2.0", "0.10.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc.1"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0-rc.2", "1.0.0-rc.1"), Ordering::Greater);
    }

    /// Pre-release identifiers are compared field by field, the way semver
    /// orders them. Comparing the whole field as text made `rc.10` sort below
    /// `rc.2`, so the shell read a legitimate upgrade as a downgrade and refused
    /// it — for an update channel that is the difference between "works" and
    /// "the user can never install this build".
    #[test]
    fn pre_release_identifiers_follow_semver_ordering() {
        assert_eq!(compare_versions("0.3.0-rc.10", "0.3.0-rc.2"), Ordering::Greater);
        assert_eq!(compare_versions("0.3.0-rc.2", "0.3.0-rc.10"), Ordering::Less);
        // Fewer identifiers rank lower.
        assert_eq!(compare_versions("0.3.0-rc", "0.3.0-rc.1"), Ordering::Less);
        // A numeric identifier always ranks below an alphanumeric one.
        assert_eq!(compare_versions("0.3.0-rc.1", "0.3.0-rc.a"), Ordering::Less);
        assert_eq!(compare_versions("0.3.0-rc.a", "0.3.0-rc.1"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc.1"), Ordering::Greater);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
    }

    /// A hermetic environment root: an optional installed launcher, and a
    /// published manifest plus asset beside it. `Source::File` reads both from
    /// disk, so the whole update path runs with no network.
    struct Fixture {
        root: PathBuf,
        settings: Settings,
    }

    /// Put a launcher and its version stamp in place the way the installer does.
    fn write_launcher(root: &Path, version: &str, bytes: &[u8]) {
        let launcher = launcher_path(root);
        std::fs::create_dir_all(launcher.parent().expect("launcher directory")).expect("launcher directory");
        std::fs::write(&launcher, bytes).expect("launcher");
        std::fs::write(
            root.join("desktop").join(".dpx-desktop.json"),
            serde_json::json!({ "schemaVersion": 1, "version": version }).to_string(),
        )
        .expect("version stamp");
    }

    impl Fixture {
        fn new(tag: &str, installed: Option<(&str, &[u8])>, published: (&str, &[u8])) -> Self {
            let root = std::env::temp_dir().join(format!("dpx-update-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("release")).expect("release directory");
            if let Some((version, bytes)) = installed {
                write_launcher(&root, version, bytes);
            }
            let (version, bytes) = published;
            let asset = root.join(format!("DSH-DeepSeek-Harness-Desktop-{version}-x64.exe"));
            std::fs::write(&asset, bytes).expect("asset");
            let manifest = root.join("release").join("desktop-latest.json");
            let body = serde_json::json!({
                "schemaVersion": 1,
                "kind": RELEASE_KIND,
                "version": version,
                "assetName": asset.file_name().expect("asset name").to_string_lossy(),
                "assetUrl": asset.display().to_string(),
                "sha256": sha256_hex(bytes),
                "size": bytes.len(),
            });
            std::fs::write(&manifest, body.to_string()).expect("manifest");
            Self {
                root,
                settings: Settings { update_source: Some(manifest.display().to_string()), ..Settings::default() },
            }
        }

        fn launcher_bytes(&self) -> Vec<u8> {
            std::fs::read(launcher_path(&self.root)).expect("launcher")
        }

        fn records(&self) -> Vec<serde_json::Value> {
            std::fs::read_to_string(updates_log_path(&self.root))
                .expect("update record")
                .lines()
                .map(|line| serde_json::from_str(line).expect("one JSON object per line"))
                .collect()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// Only-upgrade, shared with `src/desktop-release.js`: an older release is
    /// reported `different-build` for the contract but is never `available`.
    #[test]
    fn an_older_release_is_never_available() {
        let fixture = Fixture::new("older", Some(("0.3.0-rc.10", b"installed")), ("0.3.0-rc.2", b"published"));
        let result = check(&fixture.root, &fixture.settings);
        assert!(!result.available, "an older release must not be installable: {result:?}");
        assert_eq!(result.reason, "different-build");
        assert_eq!(result.installed_version.as_deref(), Some("0.3.0-rc.10"));
        assert_eq!(result.latest_version.as_deref(), Some("0.3.0-rc.2"));

        let plain = Fixture::new("older-plain", Some(("0.3.0", b"installed")), ("0.2.9", b"published"));
        assert!(!check(&plain.root, &plain.settings).available, "a plain older release must not be installable");
    }

    /// A republished build (same version, different bytes) stays available so it
    /// can be force-installed; an identical one is up to date.
    #[test]
    fn an_identical_build_is_up_to_date_and_a_rebuild_is_available() {
        let identical = Fixture::new("identical", Some(("0.3.0", b"launcher bytes")), ("0.3.0", b"launcher bytes"));
        let result = check(&identical.root, &identical.settings);
        assert!(!result.available);
        assert_eq!(result.reason, "up-to-date");

        let rebuild = Fixture::new("rebuild", Some(("0.3.0", b"old bytes")), ("0.3.0", b"new bytes"));
        let result = check(&rebuild.root, &rebuild.settings);
        assert!(result.available, "a republished build must still be offered");
        assert_eq!(result.reason, "different-build");
    }

    /// The door itself, not just the report: even with `force` the shell never
    /// downgrades — the documented escape hatch for that is
    /// `dpx desktop install --force`.
    #[test]
    fn applying_an_older_release_is_refused_and_recorded_as_failed() {
        let fixture = Fixture::new("apply-older", Some(("0.3.0-rc.10", b"installed")), ("0.3.0-rc.2", b"published"));
        let error = apply(&fixture.root, &fixture.settings, false).expect_err("an older release must be refused");
        assert!(error.contains("拒绝降级"), "{error}");
        assert!(apply(&fixture.root, &fixture.settings, true).is_err(), "the shell must not downgrade even when forced");
        assert_eq!(fixture.launcher_bytes(), b"installed", "the installed launcher must be untouched");

        let records = fixture.records();
        assert_eq!(records.len(), 2, "every attempt is recorded, including the refused ones");
        assert_eq!(records[0]["schemaVersion"], 1);
        assert_eq!(records[0]["action"], "update");
        assert_eq!(records[0]["fromVersion"], "0.3.0-rc.10");
        assert_eq!(records[0]["toVersion"], "0.3.0-rc.2");
        assert_eq!(records[0]["sha256"], serde_json::json!(sha256_hex(b"published")));
        assert_eq!(records[0]["result"], "failed");
        assert!(records[0]["time"].as_u64().unwrap_or(0) > 0, "epoch milliseconds: {records:?}");
    }

    /// Same version, different bytes: refused until the caller says so
    /// explicitly, then installed.
    #[test]
    fn applying_a_rebuilt_same_version_needs_force() {
        let fixture = Fixture::new("apply-rebuild", Some(("0.3.0", b"old bytes")), ("0.3.0", b"new bytes"));
        let error = apply(&fixture.root, &fixture.settings, false).expect_err("a silent build swap must be refused");
        assert!(error.contains("同版本"), "{error}");
        assert_eq!(fixture.launcher_bytes(), b"old bytes");
        assert_eq!(fixture.records()[0]["result"], "failed");

        let outcome = apply(&fixture.root, &fixture.settings, true).expect("a forced rebuild must install");
        assert_eq!(outcome.version, "0.3.0");
        assert!(!outcome.restart, "a hermetic environment root is not the running launcher");
        assert_eq!(fixture.launcher_bytes(), b"new bytes");
        assert_eq!(read_installed_version(&fixture.root).as_deref(), Some("0.3.0"));
        let records = fixture.records();
        assert_eq!(records.len(), 2);
        assert_eq!(records[1]["result"], "succeeded");
        assert_eq!(records[1]["sha256"], serde_json::json!(sha256_hex(b"new bytes")));
        assert_eq!(records[1]["fromVersion"], "0.3.0");
    }

    /// The ordinary upgrade: the staged file is renamed into place, the stamp is
    /// rewritten, and no staging file survives.
    #[test]
    fn an_upgrade_replaces_the_launcher_and_leaves_no_staged_file() {
        let fixture = Fixture::new("apply-newer", Some(("0.3.0", b"old bytes")), ("0.3.1", b"new bytes"));
        let outcome = apply(&fixture.root, &fixture.settings, false).expect("upgrade");
        assert_eq!(outcome.version, "0.3.1");
        assert!(!outcome.restart);
        assert_eq!(fixture.launcher_bytes(), b"new bytes");
        assert_eq!(read_installed_version(&fixture.root).as_deref(), Some("0.3.1"));
        assert_eq!(installed_digest(&fixture.root), Some(sha256_hex(b"new bytes")));

        let remaining: Vec<String> = std::fs::read_dir(updates_dir(&fixture.root))
            .expect("updates directory")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert!(!remaining.iter().any(|name| name.ends_with(".staged.exe")), "left behind: {remaining:?}");
        assert_eq!(fixture.records()[0]["result"], "succeeded");
    }

    /// W2 measurement: the install step renames the staged file over the launcher
    /// that is already there. `fs::copy` truncated the destination first, so a
    /// kill mid-write left a half-written EXE; on Windows `fs::rename` is
    /// `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, which swaps the directory
    /// entry in one step.
    #[test]
    fn renaming_replaces_an_existing_launcher_without_a_copy_window() {
        let root = std::env::temp_dir().join(format!("dpx-update-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("desktop")).expect("launcher directory");
        let launcher = launcher_path(&root);
        let staged = root.join("staged.exe");
        std::fs::write(&launcher, b"old").expect("old launcher");
        std::fs::write(&staged, b"new").expect("staged launcher");

        std::fs::rename(&staged, &launcher).expect("rename must replace an existing non-running file");
        assert_eq!(std::fs::read(&launcher).expect("launcher"), b"new");
        assert!(!staged.exists(), "the staged name must be gone after the rename");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sources_parse_with_a_default_repository_and_optional_tag() {
        assert!(matches!(parse_source("").unwrap(), Source::Github { tag: None, .. }));
        match parse_source("github:T-Auto/dsh-dpx@desktop-v0.2.1").unwrap() {
            Source::Github { repository, tag } => {
                assert_eq!(repository, "T-Auto/dsh-dpx");
                assert_eq!(tag.as_deref(), Some("desktop-v0.2.1"));
            }
            other => panic!("unexpected source {other:?}"),
        }
        assert!(matches!(parse_source("https://example.com/desktop-latest.json").unwrap(), Source::Url(_)));
        assert!(matches!(parse_source(r"D:\releases\desktop-latest.json").unwrap(), Source::File(_)));
    }

    #[test]
    fn digests_are_validated_before_use() {
        assert!(normalize_sha256("sha256:ABCD").is_none());
        assert_eq!(normalize_sha256(&"a".repeat(64)).as_deref(), Some("a".repeat(64).as_str()));
        assert_eq!(normalize_sha256(&"A".repeat(64)).as_deref(), Some("a".repeat(64).as_str()));
    }

    #[test]
    fn relative_assets_resolve_against_the_manifest_location() {
        let manifest = ReleaseManifest {
            schema_version: Some(1),
            kind: None,
            version: "0.2.1".to_string(),
            tag: None,
            platform: None,
            asset_name: Some("DSH-DeepSeek-Harness-Desktop-0.2.1-x64.exe".to_string()),
            asset_url: Some("DSH-DeepSeek-Harness-Desktop-0.2.1-x64.exe".to_string()),
            sha256: "a".repeat(64),
            size: None,
            published_at: None,
            notes: None,
            manifest_url: Some("https://github.com/o/r/releases/download/desktop-v0.2.1/desktop-latest.json".to_string()),
        };
        assert_eq!(
            resolve_asset_url(&manifest).as_deref(),
            Some("https://github.com/o/r/releases/download/desktop-v0.2.1/DSH-DeepSeek-Harness-Desktop-0.2.1-x64.exe")
        );
        let local = ReleaseManifest { manifest_url: Some(PathBuf::from(r"D:\releases\desktop-latest.json").display().to_string()), asset_url: None, ..manifest };
        assert_eq!(resolve_asset_url(&local).as_deref(), Some(r"D:\releases\DSH-DeepSeek-Harness-Desktop-0.2.1-x64.exe"));
    }

    #[test]
    fn absolute_paths_are_recognized_on_windows() {
        assert!(is_absolute_path(r"D:\releases\a.exe"));
        assert!(is_absolute_path("D:/releases/a.exe"));
        assert!(!is_absolute_path("a.exe"));
    }

    /// The relaunch helper must survive a launcher path with spaces.
    ///
    /// This is a real end-to-end check of the cmd command line (it spawns the
    /// same helper `apply` uses and waits for the marker the target writes), not
    /// a string assertion: the 0.2.2 release shipped a line that looked correct
    /// but reached `cmd.exe` mangled, and Windows answered with
    /// `Windows cannot find '\'` while the update itself had already succeeded.
    #[cfg(windows)]
    #[test]
    fn the_relaunch_helper_starts_a_target_whose_path_contains_spaces() {
        use super::{relaunch_command_line, schedule_relaunch_after};
        use std::time::{Duration, Instant};

        let root = std::env::temp_dir().join(format!("dpx relaunch test {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir with a space");
        let marker = root.join("relaunched.txt");
        let target = root.join("fake launcher.cmd");
        std::fs::write(&target, format!("@echo off\r\necho ok> \"{}\"\r\n", marker.display())).expect("write target");

        // The production line, only with a shorter wait so the test stays quick.
        let line = relaunch_command_line(&target, 1);
        assert!(line.contains("start \"\""), "cmd needs an explicit empty title: {line}");
        schedule_relaunch_after(&target, 1).expect("spawn relaunch helper");

        let deadline = Instant::now() + Duration::from_secs(20);
        while !marker.is_file() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
        }
        let started = marker.is_file();
        let _ = std::fs::remove_dir_all(&root);
        assert!(started, "the relaunch helper never started {target:?} (command line: {line})");
    }

    /// Not hermetic: exercises the real published channel exactly the way the
    /// settings window does (manifest fetch, asset download, sha256 verification,
    /// install into an environment, version stamp). Run it explicitly:
    ///
    ///   $env:DPX_TEST_PROXY='http://127.0.0.1:7897'
    ///   cargo test -- --ignored --nocapture
    ///
    /// Without `DPX_TEST_PROXY` it goes direct, which is fine on an unrestricted
    /// network and flaky on one that needs a proxy.
    #[test]
    #[ignore = "requires network access to the published release channel"]
    fn the_live_channel_installs_a_verified_launcher() {
        let proxy = std::env::var("DPX_TEST_PROXY").ok().filter(|value| !value.trim().is_empty());
        let settings = Settings { update_proxy: proxy, ..Settings::default() };
        let root = std::env::temp_dir().join(format!("dpx-desktop-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp environment");

        let source = parse_source(DEFAULT_SOURCE).expect("default source");
        let manifest = match fetch_manifest(&source, effective_proxy(&settings).as_deref()) {
            Ok(manifest) => manifest,
            Err(ManifestError::NotFound) => panic!("no desktop release is published yet"),
            Err(ManifestError::Message(message)) => panic!("{message}"),
        };
        assert!(!manifest.version.is_empty(), "manifest version");
        assert_eq!(manifest.sha256.len(), 64, "manifest digest");

        let outcome = apply(&root, &settings, false).expect("apply");
        assert_eq!(outcome.version, manifest.version);
        assert_eq!(installed_digest(&root).as_deref(), Some(manifest.sha256.as_str()), "installed digest");
        assert_eq!(read_installed_version(&root).as_deref(), Some(manifest.version.as_str()), "version stamp");
        assert!(launcher_path(&root).is_file(), "launcher file");
        let _ = std::fs::remove_dir_all(&root);
    }
}
