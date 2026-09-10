//! Embeds the desktop artifact version into the binary.
//!
//! The release pipeline passes `DPX_DESKTOP_VERSION`, so the running launcher can
//! report exactly which artifact it is without reading any sidecar file. When the
//! variable is absent (a plain `cargo build`), the crate version is used.

fn main() {
    println!("cargo:rerun-if-env-changed=DPX_DESKTOP_VERSION");
    let version = std::env::var("DPX_DESKTOP_VERSION")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_string()));
    println!("cargo:rustc-env=DPX_DESKTOP_BUILD_VERSION={version}");
    tauri_build::build()
}
