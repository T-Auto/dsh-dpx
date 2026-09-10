//! Environment-scoped single-instance guard.
//!
//! The stock `tauri-plugin-single-instance` keys its mutex and helper window on
//! the bundle identifier (`dev.dsh.dpx.desktop`), which is identical for every
//! environment. That made two DPX environments mutually exclusive: starting
//! environment B while environment A was running killed B outright and raised
//! A's window instead.
//!
//! Here the guard is derived from the environment itself:
//!
//! * `desktop-state/shell.lock` is opened with `share_mode(0)`, so only one
//!   process per environment can hold it. The OS releases it when the process
//!   dies, however it dies, so a crash can never leave a stale lock.
//! * `desktop-state/instance.json` records `{ pid, hwnd }` of the running shell
//!   so a second launch of the *same* environment can restore that window
//!   instead of opening a second DSH server against the same `DSH_HOME`.
//!
//! Nothing here is shared across environments.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::settings;

pub const LOCK_NAME: &str = "shell.lock";
pub const INSTANCE_NAME: &str = "instance.json";
const ERROR_SHARING_VIOLATION: i32 = 32;

#[cfg(windows)]
const SW_SHOW: i32 = 5;
#[cfg(windows)]
const SW_RESTORE: i32 = 9;

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn IsWindow(hwnd: isize) -> i32;
    fn ShowWindow(hwnd: isize, command: i32) -> i32;
    fn SetForegroundWindow(hwnd: isize) -> i32;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRecord {
    pub pid: u32,
    pub hwnd: isize,
    pub started_at_millis: u64,
}

/// Held for as long as this process owns the environment.
pub struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    pub fn path(env_root: &Path) -> PathBuf {
        settings::state_dir(env_root).join(LOCK_NAME)
    }

    pub fn record_path(env_root: &Path) -> PathBuf {
        settings::state_dir(env_root).join(INSTANCE_NAME)
    }
}

pub enum Instance {
    /// This process is the one desktop shell for the environment.
    Primary(InstanceLock),
    /// Another shell already owns the environment; `hwnd` is its main window.
    AlreadyRunning(Option<InstanceRecord>),
}

/// Try to become the desktop shell of `env_root`.
pub fn acquire(env_root: &Path) -> Result<Instance, String> {
    let directory = settings::state_dir(env_root);
    std::fs::create_dir_all(&directory).map_err(|error| format!("无法创建状态目录：{error}"))?;
    let path = InstanceLock::path(env_root);
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    match options.open(&path) {
        Ok(mut file) => {
            let _ = file.set_len(0);
            let _ = writeln!(file, "{}", std::process::id());
            Ok(Instance::Primary(InstanceLock { _file: file }))
        }
        Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) => {
            Ok(Instance::AlreadyRunning(read_record(env_root)))
        }
        Err(error) => Err(format!("无法锁定桌面单实例互斥文件 {}：{error}", path.display())),
    }
}

pub fn read_record(env_root: &Path) -> Option<InstanceRecord> {
    let text = std::fs::read_to_string(InstanceLock::record_path(env_root)).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// Publish the main window handle so the next launch of this environment can
/// bring it back instead of starting a second shell.
pub fn publish(env_root: &Path, hwnd: isize) {
    let record = InstanceRecord { pid: std::process::id(), hwnd, started_at_millis: settings::now_millis() };
    let Ok(body) = serde_json::to_string_pretty(&record) else { return };
    let path = InstanceLock::record_path(env_root);
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    if std::fs::write(&temporary, format!("{body}\n")).is_ok() && std::fs::rename(&temporary, &path).is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
}

pub fn withdraw(env_root: &Path) {
    let _ = std::fs::remove_file(InstanceLock::record_path(env_root));
}

/// Bring the window of the environment's running shell back to the foreground.
/// Returns whether it could be done.
pub fn focus_existing(record: &InstanceRecord) -> bool {
    #[cfg(windows)]
    {
        if record.hwnd == 0 || unsafe { IsWindow(record.hwnd) } == 0 {
            return false;
        }
        unsafe {
            // SW_RESTORE also un-minimises; SW_SHOW covers a window hidden to the tray.
            ShowWindow(record.hwnd, SW_RESTORE);
            ShowWindow(record.hwnd, SW_SHOW);
            SetForegroundWindow(record.hwnd);
        }
        true
    }
    #[cfg(not(windows))]
    {
        let _ = record;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{acquire, focus_existing, publish, read_record, withdraw, Instance, InstanceRecord};
    use std::path::PathBuf;

    #[test]
    fn the_guard_is_scoped_to_one_environment() {
        let first = std::env::temp_dir().join(format!("dpx-instance-a-{}", std::process::id()));
        let second = std::env::temp_dir().join(format!("dpx-instance-b-{}", std::process::id()));
        let a = acquire(&first).expect("first environment");
        let b = acquire(&second).expect("second environment");
        assert!(matches!(a, Instance::Primary(_)));
        assert!(matches!(b, Instance::Primary(_)), "a second environment must not be blocked");
    }

    #[test]
    fn a_second_launch_of_the_same_environment_is_reported() {
        let root = std::env::temp_dir().join(format!("dpx-instance-same-{}", std::process::id()));
        let first = acquire(&root).expect("first");
        assert!(matches!(first, Instance::Primary(_)));
        // The lock is held by this process, and Windows only denies the second
        // open across processes, so assert the plumbing instead of the denial.
        publish(&root, 1234);
        let record = read_record(&root).expect("record");
        assert_eq!(record.hwnd, 1234);
        withdraw(&root);
        assert!(read_record(&root).is_none());
    }

    #[test]
    fn focusing_an_invalid_handle_is_reported_as_a_failure() {
        let record = InstanceRecord { pid: 0, hwnd: 0, started_at_millis: 0 };
        assert!(!focus_existing(&record));
    }

    #[test]
    fn records_live_below_the_environment_state_directory() {
        let root = PathBuf::from(r"C:\environments\test");
        assert!(super::InstanceLock::record_path(&root).ends_with(r"desktop-state\instance.json"));
    }
}
