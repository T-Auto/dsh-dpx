# Desktop launcher release channel

This document is the shared contract between the `dpx` CLI
(`src/desktop-release.js`) and the desktop shell
(`desktop-shell/src-tauri/src/update.rs`). Both implementations must stay aligned
with it; the JavaScript side is the reference and the Rust side is verified by
the tests in `desktop-shell/src-tauri/src/update.rs`.

The channel exists because the desktop launcher is **decoupled** from DSH: the
launcher is a thin shell that discovers the DSH entry from whatever package is
installed inside the environment. Upgrading DSH never needs a new launcher, and
upgrading the launcher never touches DSH. The two therefore version and ship
independently.

## Versioning

| Thing | Where it lives | Example |
| --- | --- | --- |
| DPX distribution version | `src/index.js` `DISTRIBUTION.version` | `0.1.0` |
| Desktop artifact version | `desktop-shell/package.json`, `src-tauri/Cargo.toml`, `tauri.conf.json` | `0.2.0` |

The desktop artifact version is compiled into the launcher (see
`src-tauri/build.rs`, `DPX_DESKTOP_VERSION`) and reported by the settings window,
so a running launcher always knows exactly which artifact it is.

## Release shape

A desktop release is a GitHub Release:

* tag: `desktop-v<version>` (for example `desktop-v0.2.0`);
* assets:
  * `DSH-DeepSeek-Harness-Desktop-<version>-x64.exe` — the launcher;
  * `desktop-latest.json` — the manifest below.

`scripts/build-desktop-launcher.ps1 -OutputDirectory <dir>` produces exactly this
folder locally; `.github/workflows/release-desktop.yml` produces and publishes it
for a `desktop-v*` tag; `scripts/publish-desktop-release.ps1` publishes a folder
that was verified locally.

## Manifest (`desktop-latest.json`)

```json
{
  "schemaVersion": 1,
  "kind": "DPXDesktopRelease",
  "channel": "desktop",
  "version": "0.2.0",
  "tag": "desktop-v0.2.0",
  "platform": "win32-x64",
  "assetName": "DSH-DeepSeek-Harness-Desktop-0.2.0-x64.exe",
  "assetUrl": "DSH-DeepSeek-Harness-Desktop-0.2.0-x64.exe",
  "sha256": "…64 hex characters…",
  "size": 3845120,
  "publishedAt": "2026-01-01T00:00:00Z",
  "notes": "optional human-readable note"
}
```

Rules:

* `version` is required and compared with `semver`-like ordering, where a missing
  pre-release suffix counts as newer (`1.0.0` > `1.0.0-rc.1`).
* `sha256` is required; a download whose digest does not match is rejected and
  never installed.
* `assetUrl` may be absolute (`https://…`, `file:…`, a local path) or relative.
  A relative value resolves against the manifest URL's directory, which makes the
  same manifest work both from `releases/latest/download/` and from a local
  folder.
* `size`, when present, is verified before the digest.

## Sources

`dpx desktop …` and the shell's settings window accept the same source syntax:

| Source | Meaning |
| --- | --- |
| `github` / `github:T-Auto/dsh-dpx` | `https://github.com/<repo>/releases/latest/download/desktop-latest.json` |
| `github:T-Auto/dsh-dpx@desktop-v0.2.0` | one exact release tag |
| `https://…/desktop-latest.json` | any manifest URL (self-hosted, CI artifact, test server) |
| `file:…` or a local path | a manifest on disk (offline testing) |

`releases/latest` deliberately ignores pre-releases, which is why the "latest"
path needs no GitHub API call and therefore no API rate limit or token.
Pre-releases are only considered when a caller asks for them
(`--prerelease`), and that path does use the API (`DPX_GITHUB_TOKEN`,
`GITHUB_TOKEN` and `GH_TOKEN` are honored when present).

HTTP requests accept a proxy from `--proxy`, the shell setting `updateProxy`, or
the ambient `DPX_HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY`
variables. The shell additionally reads the Windows system proxy.

## Installing

Both sides verify, stage, and then move the new launcher into place:

1. download to memory and verify `size` + `sha256`;
2. write a staged copy next to the launcher;
3. if the target file is the **running** launcher, rename it aside first —
   Windows allows renaming a running executable but not overwriting it;
4. copy the staged file into `desktop/DSH DeepSeek Harness Desktop.exe`;
5. record `desktop/.dpx-desktop.json` (version, digest, source, tag);
6. the shell schedules a detached relaunch and exits; `dpx` leaves the file in
   place for the next double-click.

Stale files from earlier updates are cleaned from
`desktop-state/updates/` on the next start.
