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

fn fetch_bytes(url: &str, proxy: Option<&str>) -> Result<Vec<u8>, String> {
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
        let agent = agent(proxy).map_err(ManifestError::Message)?;
        match agent.get(url).header("Accept", "application/json").call() {
            Ok(mut response) => response
                .body_mut()
                .read_to_string()
                .map_err(|error| ManifestError::Message(format!("读取 {url} 响应失败：{error}")))?,
            Err(error) if is_not_found(&error) => return Err(ManifestError::NotFound),
            Err(error) => return Err(ManifestError::Message(describe_error(&error, url))),
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
        (false, false) => left_pre.cmp(&right_pre),
    }
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

/// Check the channel for a newer desktop launcher. Network only, never writes.
pub fn check(env_root: &Path, settings: &Settings) -> LastCheck {
    let source = settings.update_source.clone().unwrap_or_else(|| DEFAULT_SOURCE.to_string());
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
            let newer = compare_versions(&manifest.version, result.installed_version.as_deref().unwrap_or("0.0.0")) == Ordering::Greater;
            let identical = digest.as_deref() == Some(manifest.sha256.as_str());
            if !launcher_path(env_root).is_file() {
                result.available = true;
                result.reason = "not-installed".to_string();
                result.message = Some("该环境还没有桌面启动器，可直接安装。".to_string());
            } else if newer {
                result.available = true;
                result.reason = "newer-version".to_string();
                result.message = Some(format!("发现新版本 {}（当前 {}）。", manifest.version, result.installed_version.clone().unwrap_or_else(|| "未知".to_string())));
            } else if identical {
                result.reason = "up-to-date".to_string();
                result.message = Some(format!("已是最新版本 {}。", manifest.version));
            } else {
                result.available = true;
                result.reason = "different-build".to_string();
                result.message = Some(format!("发布源上的 {} 与本地构建不同（版本同为 {}）。", manifest.version, result.installed_version.clone().unwrap_or_else(|| "未知".to_string())));
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

/// Download, verify, and install the newest desktop launcher, then relaunch.
pub fn apply(env_root: &Path, settings: &Settings) -> Result<ApplyOutcome, String> {
    let source = settings.update_source.clone().unwrap_or_else(|| DEFAULT_SOURCE.to_string());
    let parsed = parse_source(&source)?;
    let proxy = effective_proxy(settings);
    let manifest = match fetch_manifest(&parsed, proxy.as_deref()) {
        Ok(manifest) => manifest,
        Err(ManifestError::NotFound) => return Err(format!("发布源 {} 还没有已发布的 desktop 版本。", parsed.label())),
        Err(ManifestError::Message(message)) => return Err(message),
    };
    let asset_url = resolve_asset_url(&manifest).ok_or_else(|| "发布清单没有可下载的资产地址。".to_string())?;
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

    let launcher = launcher_path(env_root);
    if let Some(parent) = launcher.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建启动器目录：{error}"))?;
    }
    let updates = updates_dir(env_root);
    std::fs::create_dir_all(&updates).map_err(|error| format!("无法创建更新目录：{error}"))?;
    let staged = updates.join(format!("{}-{}.staged.exe", manifest.version, std::process::id()));
    std::fs::write(&staged, &bytes).map_err(|error| format!("无法写入新启动器：{error}"))?;

    // Windows lets a running image be renamed but not overwritten, so move the
    // current launcher aside first and put the new one in its place.
    let running_here = same_file(&std::env::current_exe().unwrap_or_default(), &launcher);
    let displaced = updates.join(format!("{LAUNCHER_NAME}.old-{}", settings::now_millis()));
    if running_here && launcher.is_file() {
        std::fs::rename(&launcher, &displaced).map_err(|error| format!("无法替换正在运行的启动器：{error}"))?;
    }
    if let Err(error) = std::fs::copy(&staged, &launcher) {
        if running_here && displaced.is_file() {
            let _ = std::fs::rename(&displaced, &launcher);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(format!("无法安装新启动器：{error}"));
    }
    let _ = std::fs::remove_file(&staged);

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
        schedule_relaunch(&launcher)?;
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

/// Start a detached helper that waits for this process to exit, then relaunches
/// the (now replaced) launcher.
fn schedule_relaunch(launcher: &Path) -> Result<(), String> {
    let command = format!("ping -n 4 127.0.0.1 >NUL & start \"\" \"{}\"", launcher.display());
    let mut process = Command::new("cmd.exe");
    process.args(["/C", &command]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
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
    use super::{compare_versions, is_absolute_path, normalize_sha256, parse_source, resolve_asset_url, Source, ReleaseManifest};
    use std::cmp::Ordering;
    use std::path::PathBuf;

    #[test]
    fn version_comparison_follows_semver_ordering() {
        assert_eq!(compare_versions("0.2.1", "0.2.0"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.0", "0.2.0"), Ordering::Equal);
        assert_eq!(compare_versions("0.2.0", "0.10.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc.1"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0-rc.2", "1.0.0-rc.1"), Ordering::Greater);
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
}
