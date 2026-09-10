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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    pub close_action: CloseAction,
    pub tray_enabled: bool,
    pub update_source: Option<String>,
    pub update_proxy: Option<String>,
    pub auto_check_updates: bool,
    pub last_check: Option<LastCheck>,
    pub dsh_package: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            close_action: CloseAction::Ask,
            tray_enabled: true,
            update_source: None,
            update_proxy: None,
            auto_check_updates: false,
            last_check: None,
            dsh_package: None,
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

#[cfg(test)]
mod tests {
    use super::{settings_path, state_dir, CloseAction, Settings};
    use std::path::Path;

    #[test]
    fn defaults_ask_before_the_first_close() {
        let settings = Settings::default();
        assert_eq!(settings.close_action, CloseAction::Ask);
        assert!(settings.tray_enabled);
        assert!(!settings.auto_check_updates);
    }

    #[test]
    fn unknown_or_missing_keys_fall_back_to_defaults() {
        let parsed: Settings = serde_json::from_str(r#"{"closeAction":"tray","futureKey":42}"#).unwrap();
        assert_eq!(parsed.close_action, CloseAction::Tray);
        assert!(parsed.tray_enabled);
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
}
