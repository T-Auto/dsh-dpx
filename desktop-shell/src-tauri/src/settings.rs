//! Shell settings, persisted per environment.
//!
//! Everything the settings window edits lives in
//! `<env-root>/desktop-state/settings.json`, so two DPX environments never share
//! desktop preferences and `dpx env remove --purge` removes them with the rest of
//! the environment. The file is written atomically and is tolerant of missing or
//! unknown keys, so an older shell never fails to start because of a newer
//! settings file.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const STATE_DIR: &str = "desktop-state";
pub const SETTINGS_NAME: &str = "settings.json";
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

pub fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as u64).unwrap_or(0)
}

/// What the window close button does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    /// Ask the first time, then remember what the user picked.
    Ask,
    /// Hide to the notification area and keep DSH running.
    Tray,
    /// Stop DSH and exit the shell.
    Exit,
}

impl Default for CloseAction {
    fn default() -> Self {
        CloseAction::Ask
    }
}

impl CloseAction {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "ask" => Some(CloseAction::Ask),
            "tray" | "minimize" | "minimize-to-tray" => Some(CloseAction::Tray),
            "exit" | "quit" | "close" => Some(CloseAction::Exit),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CloseAction::Ask => "ask",
            CloseAction::Tray => "tray",
            CloseAction::Exit => "exit",
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LastCheck {
    pub at_millis: u64,
    pub source: String,
    pub available: bool,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub reason: String,
    pub message: Option<String>,
}

impl LastCheck {
    /// Whether this record still describes the launcher that is installed now.
    ///
    /// `installed_version` is the version that was on disk when the check ran, and
    /// the launcher can be replaced without this window ever seeing it — `dpx
    /// desktop update`, the self-update script, or this window's own update button
    /// followed by the restart. A record whose version no longer matches is
    /// therefore *history*, not status. Reading it as status is how the window came
    /// to show "桌面封装版本 0.3.1" next to "当前 0.2.5" with the update button
    /// still lit.
    pub fn is_current_for(&self, installed: Option<&str>) -> bool {
        self.installed_version.as_deref() == installed
    }

    /// The record a successful in-app update leaves behind.
    ///
    /// The window restarts right after the launcher is replaced, and without this
    /// the record it loads when it comes back would still describe the launcher
    /// that just went away. Stamped the way a check would, so the two paths cannot
    /// disagree about what "installed" means.
    pub fn after_apply(version: &str, source: String, at_millis: u64) -> Self {
        Self {
            at_millis,
            source,
            available: false,
            installed_version: Some(version.to_string()),
            latest_version: Some(version.to_string()),
            reason: "applied".to_string(),
            message: Some(format!("已更新到 {version}。")),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    pub close_action: CloseAction,
    pub tray_enabled: bool,
    pub update_source: Option<String>,
    pub update_proxy: Option<String>,
    pub last_check: Option<LastCheck>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            close_action: CloseAction::Ask,
            tray_enabled: true,
            update_source: None,
            update_proxy: None,
            last_check: None,
        }
    }
}

pub fn state_dir(env_root: &Path) -> PathBuf {
    env_root.join(STATE_DIR)
}

pub fn settings_path(env_root: &Path) -> PathBuf {
    state_dir(env_root).join(SETTINGS_NAME)
}

pub fn logs_path(env_root: &Path) -> PathBuf {
    state_dir(env_root).join("shell.log")
}

pub fn load(env_root: &Path) -> Settings {
    match std::fs::read_to_string(settings_path(env_root)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(env_root: &Path, settings: &Settings) -> Result<(), String> {
    let path = settings_path(env_root);
    let directory = path.parent().ok_or_else(|| "设置文件路径无效。".to_string())?;
    std::fs::create_dir_all(directory).map_err(|error| format!("无法创建设置目录：{error}"))?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let body = format!("{}\n", serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?);
    std::fs::write(&temporary, body).map_err(|error| format!("无法写入设置：{error}"))?;
    std::fs::rename(&temporary, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("无法保存设置：{error}")
    })
}

/// A copy of `settings` whose recorded check is honest about the launcher that is
/// installed now.
///
/// This is the display half of [`LastCheck::is_current_for`]: an expired record is
/// kept (its time, source and the version the channel offered are still the answer
/// to "what did the last check say"), but it is no longer presented as current and
/// `available` is cleared with it — an expired result must never arm the update
/// button, whatever the window does with the flag.
///
/// Nothing is written. The record on disk keeps its original fields, so a stale
/// snapshot can be re-stamped as often as the window opens without losing what it
/// actually observed.
pub fn freshen_last_check(mut settings: Settings, installed: Option<&str>) -> Settings {
    let stale = settings
        .last_check
        .as_ref()
        .is_some_and(|check| !check.is_current_for(installed));
    if stale {
        if let Some(check) = settings.last_check.as_mut() {
            let was = check.installed_version.clone().unwrap_or_else(|| "未知版本".to_string());
            let now = installed.unwrap_or("未知版本").to_string();
            check.available = false;
            check.reason = "stale".to_string();
            check.message = Some(format!("上次检查针对 {was}，本机现在是 {now}；结果已过期，请重新检查更新。"));
        }
    }
    settings
}

#[cfg(test)]
mod tests {
    use super::{freshen_last_check, settings_path, state_dir, CloseAction, LastCheck, Settings};
    use std::path::Path;

    /// A record shaped the way `update::check` leaves one.
    fn recorded(installed: Option<&str>, available: bool) -> LastCheck {
        LastCheck {
            at_millis: 1_789_293_790_693,
            source: "github:T-Auto/dsh-dpx".to_string(),
            available,
            installed_version: installed.map(str::to_string),
            latest_version: Some("0.2.6".to_string()),
            reason: "newer-version".to_string(),
            message: Some("发现新版本 0.2.6（当前 0.2.5）。".to_string()),
        }
    }

    fn with_check(check: LastCheck) -> Settings {
        Settings { last_check: Some(check), ..Settings::default() }
    }

    #[test]
    fn defaults_ask_before_the_first_close() {
        let settings = Settings::default();
        assert_eq!(settings.close_action, CloseAction::Ask);
        assert!(settings.tray_enabled);
        assert!(settings.last_check.is_none());
    }

    /// A settings file written by an older shell keeps loading: the shell never
    /// fails to start because it meets a key it no longer uses.
    #[test]
    fn unknown_or_missing_keys_fall_back_to_defaults() {
        let parsed: Settings = serde_json::from_str(r#"{"closeAction":"tray","futureKey":42}"#).unwrap();
        assert_eq!(parsed.close_action, CloseAction::Tray);
        assert!(parsed.tray_enabled);

        let legacy: Settings =
            serde_json::from_str(r#"{"autoCheckUpdates":true,"dshPackage":"@deepseek-ai/dsh"}"#).unwrap();
        assert_eq!(legacy.close_action, CloseAction::Ask);
        assert!(legacy.update_source.is_none());
    }

    #[test]
    fn settings_are_stored_below_the_environment_root() {
        let root = Path::new(r"C:\environments\test");
        assert_eq!(state_dir(root), root.join("desktop-state"));
        assert_eq!(settings_path(root), root.join(r"desktop-state\settings.json"));
    }

    #[test]
    fn close_action_parsing_accepts_synonyms() {
        assert_eq!(CloseAction::parse("minimize-to-tray"), Some(CloseAction::Tray));
        assert_eq!(CloseAction::parse("QUIT"), Some(CloseAction::Exit));
        assert_eq!(CloseAction::parse("nonsense"), None);
    }

    /// The record is current only for the version it actually ran against, and a
    /// record that never learned a version cannot claim to be current either.
    #[test]
    fn a_record_is_current_only_for_the_version_it_ran_against() {
        assert!(recorded(Some("0.3.1"), true).is_current_for(Some("0.3.1")));
        assert!(!recorded(Some("0.2.5"), true).is_current_for(Some("0.3.1")));
        assert!(!recorded(None, true).is_current_for(Some("0.3.1")));
        assert!(!recorded(Some("0.3.1"), true).is_current_for(None));
    }

    /// The reported regression: a check recorded against 0.2.5 while 0.3.1 is
    /// installed must not read as status, and must not stay armed.
    #[test]
    fn a_stale_record_becomes_history_and_is_never_available() {
        let fresh = freshen_last_check(with_check(recorded(Some("0.2.5"), true)), Some("0.3.1"));
        let check = fresh.last_check.expect("the record is kept as history");
        assert!(!check.available, "an expired result must not arm the update button");
        assert_eq!(check.reason, "stale");
        assert_eq!(check.installed_version.as_deref(), Some("0.2.5"));
        assert_eq!(check.latest_version.as_deref(), Some("0.2.6"));
        assert_eq!(check.at_millis, 1_789_293_790_693, "the time of the check survives");
        let message = check.message.unwrap();
        assert!(message.contains("0.2.5") && message.contains("0.3.1"), "{message}");
    }

    #[test]
    fn a_current_record_is_left_exactly_as_it_was_recorded() {
        let original = recorded(Some("0.3.1"), true);
        let fresh = freshen_last_check(with_check(original.clone()), Some("0.3.1"));
        let check = fresh.last_check.expect("the record is kept");
        assert!(check.available);
        assert_eq!(check.reason, original.reason);
        assert_eq!(check.message, original.message);
    }

    /// The other half of the same bug: after the window's own update button
    /// installs a version, the record it wrote must describe that version.
    #[test]
    fn an_applied_update_is_not_stale_against_the_version_it_installed() {
        let applied = LastCheck::after_apply("0.3.2", "github:T-Auto/dsh-dpx".to_string(), 42);
        let fresh = freshen_last_check(with_check(applied), Some("0.3.2"));
        let check = fresh.last_check.expect("the record is kept");
        assert_eq!(check.reason, "applied");
        assert!(!check.available);
        assert_eq!(check.message.as_deref(), Some("已更新到 0.3.2。"));
        assert_eq!(check.source, "github:T-Auto/dsh-dpx");
        assert_eq!(check.at_millis, 42);
    }
}
