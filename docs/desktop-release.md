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
  * `desktop-latest.json` — the manifest below;
  * `desktop-<version>.spdx.json` — an SPDX 2.3 SBOM of the released files and the locked dependency sets.

`scripts/build-desktop-launcher.ps1 -OutputDirectory <dir>` produces the folder locally, and from one build it also refreshes `assets\windows\*` — the copy that is committed and shipped inside the npm package, and therefore the copy `dpx desktop install` puts into a new environment.
`.github/workflows/release-desktop.yml` produces and publishes it for a `desktop-v*` tag; `scripts/publish-desktop-release.ps1` publishes a folder that was verified locally, in two steps.

## Rules

Four rules bind every publication. Each one names where it is enforced today, because the two implementations are not at the same point.

* **Versions only move forward.** `dpx` never installs an older release: `checkDesktopUpdate()` reports `available: false` for it, and `updateDesktopLauncher()` refuses it with `reason: 'newer-installed'` (`installedNewer: true`), so the CLI and the settings window cannot downgrade.
  The shell does not enforce this yet: `apply()` in `desktop-shell/src-tauri/src/update.rs` installs whatever the manifest names without comparing versions, so this rule currently holds for `dpx` and not for the shell's own update button.
  Closing that gap is R1 in `dpx-吸收桌面端优点-工程量估算-2026-09-20.md` §2.1, scheduled for the 0.3 line; until it lands this document must not claim the shell enforces it.
* **A published version is never reused.** A `desktop-v<version>` release is created once and its assets are immutable afterwards: `release-desktop.yml` leaves an existing published release untouched, and `publish-desktop-release.ps1` refuses to modify a published release — it only ever creates or fills a draft. Publish something new by bumping the version, never by re-uploading over a tag people may already have downloaded.
* **The feed address is constant.** `github:T-Auto/dsh-dpx` resolves to `https://github.com/T-Auto/dsh-dpx/releases/latest/download/desktop-latest.json`, and `releases/latest` ignores drafts and pre-releases. Publishing therefore flips a draft with `--latest` and never marks it a pre-release, so the address every consumer already uses keeps naming the newest published version.
  There is exactly one feed — the release asset `desktop-latest.json`. No second feed, mirror or index is generated for it.
* **File integrity is not publication authorization.** A matching `sha256` proves the bytes arrived intact, and both `dpx` and the shell check it before installing; it authorizes nothing else. Publication is a separate, explicit operator action: `-Upload` writes a draft plus a receipt, and `-Publish` re-verifies every remote digest against that receipt before flipping the draft. The channel also has no publisher signature by default — `sha256` proves transfer, not authorship — and the optional `sig` field only closes that gap once keys are actually distributed.

## Publication

Building and publishing are separate authorities, and the publisher never rebuilds.

* One build produces both payloads: the release folder and the committed `assets\windows\*` copy, from identical bytes. `-SkipPackagedArtifact` is what let the two drift apart, so the release workflow never passes it, and `publish-desktop-release.ps1` refuses to publish a folder whose manifest digest or version does not match `assets\windows\desktop-manifest.json`.
* The workflow starts by refusing a tag whose committed `assets\windows\desktop-manifest.json` names a different version.
  CI can rebuild that file but cannot commit it, so a tag that was pushed without running `npm run desktop:build` and committing the refreshed assets is stopped there, instead of publishing a Release that differs from what `dpx desktop install` copies out of the npm package.
  By the same token, when a fresh build is not byte-identical to the committed launcher the workflow only emits a warning: rebuilding is not byte-for-byte reproducible in general, so that difference cannot be a gate.
  What these gates do guarantee is that both manifests name the same version and the same `sha256` inside one release run, and that a tag can never go out while the committed packaged launcher still names an older version — the failure mode where `dpx desktop install` reports success while installing the previous launcher.
  They do **not** guarantee byte identity between the launcher inside the npm package and the launcher attached to the release, because CI cannot commit and a rebuild is not required to be byte-identical; the warning above is the signal, and the version gate is the bound. Closing that residual would mean either publishing the committed artifact instead of a fresh build, or letting CI commit the refresh.
* Publication is two auditable steps. `-Upload` creates the release as a **draft** (or fills an existing draft), uploads the manifest before the launcher and then the remaining assets, and writes `desktop-upload-receipt.json` next to them, recording the tag, every asset name, its `sha256` and its size.
  `-Publish` re-reads that receipt, refuses if it is missing, belongs to another tag or repository, or no longer matches the local bytes, then re-verifies every asset against the GitHub API (`size`, `state`, and the `digest` GitHub computed) and only then runs `gh release edit --draft=false --latest`.
* A draft is **not** a publication. `gh release view` sees drafts, so the immutability check tests `isDraft` rather than tag existence; a published release is left untouched, while a draft is the first half of this same procedure. This is the order `gh release create --help` documents.
* Every asset must be in the upload list of the run that publishes: a published release's assets cannot be added or replaced afterwards. That is why the SBOM is generated before the upload instead of after.
* The workflow publishes a build provenance attestation (`actions/attest-build-provenance`) for the launcher, the manifest and the SBOM, which needs `id-token: write` and `attestations: write` on the publishing job.
* CI holds no signing key, mirroring the official desktop channel's rule that the private key stays on hardware the operator controls. Signing is an offline operator step performed before `-Publish`; the workflow only ever publishes, and the trusted **public** key travels with the package.

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
  "notes": "optional human-readable note",
  "sig": { "algorithm": "ed25519", "signature": "…base64…", "keyId": "optional" }
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
* `sig` is optional and never produced by the release pipeline. `schemaVersion` stays `1` whether or not it is present.

## Signatures

`sig` is a publisher signature over the artifact digest, verified by `dpx` and by the shell when a trusted public key is configured.

* Algorithm: Ed25519, through `node:crypto`; no third-party dependency.
* Signed message (UTF-8, `\n` separated, trailing newline), built by `desktopSignatureMessage()`:

  ```text
  dpx-desktop-release/v1
  <version>
  <assetName>
  <sha256>
  ```

* The message covers the **digest, not the manifest bytes**, deliberately: the manifest is produced by more than one tool (PowerShell `ConvertTo-Json` in the build script, Node `JSON.stringify` in `dpx`) and the two do not agree on bytes, while `sha256` is one lowercase hex string everywhere. Because the downloader already refuses an artifact whose digest differs from that value, a valid signature transitively authenticates the installed bytes.
* The public key is **never** read from the manifest — a manifest carrying its own key could be forged together with it. It comes from the explicit `publicKey` / `publicKeys` options or from `DPX_DESKTOP_PUBLIC_KEY` (one PEM block or one base64 key) / `DPX_DESKTOP_PUBLIC_KEYS` (several base64 keys separated by `,` `;` or whitespace).
* Policy: **no key configured means today's behaviour exactly** — nothing is verified and an unsigned manifest installs as before. **A key configured means strict**: a signature that does not verify is refused, and a manifest with no `sig` is refused too, because otherwise stripping the signature would bypass the whole check. `requireSignature: false` relaxes that during a transition.
* The offline tool is `scripts/sign-desktop-manifest.mjs`; it produces, signs and verifies, and it never contacts the network:

  ```sh
  # 1. once, on an offline machine (creates --out-dir)
  node scripts/sign-desktop-manifest.mjs --generate-key --out-dir <dir>
  #    <dir>/desktop-release-key.pem   PKCS#8 PEM private key, keep it offline, mode 0600
  #    <dir>/desktop-release-pub.txt   single-line base64 SPKI DER, the distributable half
  #    stdout prints the fingerprint (sha256 of the SPKI DER) and a DPX_DESKTOP_PUBLIC_KEY=<base64> line

  # 2. sign the built manifest (in place; --out writes it elsewhere)
  node scripts/sign-desktop-manifest.mjs --manifest dist/desktop-latest.json --key <dir>/desktop-release-key.pem
  #    writes sig: { algorithm: 'ed25519', signature: <base64, 64 bytes>, keyId: <first 16 hex of the fingerprint> }
  #    --key also accepts hex:<64 hex> or base64:<32-byte seed>; --key-id overrides keyId

  # 3. verify before publishing (public key only, so it is safe to run in CI)
  node scripts/sign-desktop-manifest.mjs --verify --manifest dist/desktop-latest.json --public-key <base64 SPKI DER>
  #    pass: prints {signed:true, verified:true, algorithm:'ed25519', keyId} and exits 0
  #    fail: prints a Chinese refusal reason on stderr and exits non-zero
  ```

  `npm run desktop:sign -- --key <pem>` and `npm run desktop:verify -- --public-key <base64>` are the same two steps; both need the extra argument, and neither is required by the release workflow.
* Enforcement point: `publish-desktop-release.ps1 -RequireSignature [-PublicKey <path|base64>]` runs that same `--verify` before `gh release edit --draft=false` and aborts on a non-zero exit. The key comes from `-PublicKey`, then `DPX_DESKTOP_PUBLIC_KEY`, then the public key shipped in `assets\windows\`.
  The switch is **off by default**: every manifest published so far is unsigned, so requiring a signature by default would block the existing flow. Without it, no signature is read, checked or required.
  The release workflow passes `-RequireSignature` as soon as `assets\windows\desktop-release-pub.txt` exists and otherwise only emits a notice, so enforcement follows key distribution on the authoritative path instead of racing it.
* Because a published release is immutable, signing happens **before** `-Publish`. A draft is still mutable, so a signed manifest can replace the draft's unsigned one before it goes live.
* Migration order, which must not be reordered:
  1. ship the capability to verify (implemented, and inert while no key is configured);
  2. generate the key pair offline, ship the **public** key as `assets\windows\desktop-release-pub.txt`, and publish its fingerprint in `README.md` and in the release notes, keeping the private key off every networked machine;
  3. start signing manifests offline before they are published;
  4. only then turn on enforcement — `-RequireSignature` on the publish path, and `DPX_DESKTOP_PUBLIC_KEY` in operator environments.
     Enforcement cannot come first: strict mode rejects the unsigned manifests that every published release has today.

## Sources

`dpx desktop …` and the shell's settings window accept the same source syntax:

| Source | Meaning |
| --- | --- |
| `github` / `github:T-Auto/dsh-dpx` | `https://github.com/<repo>/releases/latest/download/desktop-latest.json` |
| `github:T-Auto/dsh-dpx@desktop-v0.2.0` | one exact release tag |
| `https://…/desktop-latest.json` | any manifest URL (self-hosted, CI artifact, test server) |
| `file:…` or a local path | a manifest on disk (offline testing) |

`--tag` and `--prerelease` only apply to `github:` sources; for a `url:` manifest and for `file:` / local paths the last path segment already *is* the manifest, so both options are ignored (silently, and without any API call).

`releases/latest` deliberately ignores pre-releases, which is why the "latest"
path needs no GitHub API call and therefore no API rate limit or token.
Pre-releases are only considered when a caller asks for them
(`--prerelease`), and that path does use the API (`DPX_GITHUB_TOKEN`,
`GITHUB_TOKEN` and `GH_TOKEN` are honored when present).
When `--prerelease` finds no `desktop-v*` pre-release, `fetchDesktopRelease()` fails with `HttpError` 404 and `dpx desktop check --prerelease` reports `{ available: false, reason: 'no-release' }` instead of exiting non-zero.

`DPX_GITHUB_API` overrides the GitHub REST base used for that lookup, for a mirror or a local test server. Precedence is the explicit `apiBase` argument, then `DPX_GITHUB_API`, then `https://api.github.com`.

HTTP requests accept a proxy from `--proxy`, the shell setting `updateProxy`, or the ambient `DPX_HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY` variables (`DEFAULT_PROXY` is also read by the shell).
The shell attaches a proxy only when one of those is configured: `Cargo.toml` enables `ureq`'s `win-system-proxy` feature, but `update.rs` never calls a system-proxy API, so whether Windows system proxy settings take effect on their own is **unverified** and this document does not promise it.

## Installing

Both sides verify, stage, and then move the new launcher into place:

1. download to memory and verify `size` + `sha256`;
2. when a trusted public key is configured, verify `sig` as well, and refuse an unsigned manifest;
3. write a staged copy next to the launcher;
4. if the target file is the **running** launcher, rename it aside first —
   Windows allows renaming a running executable but not overwriting it;
5. copy the staged file into `desktop/DSH DeepSeek Harness Desktop.exe`;
6. record `desktop/.dpx-desktop.json` (version, digest, source, tag);
7. the shell schedules a detached relaunch and exits; `dpx` leaves the file in
   place for the next double-click.

Stale files from earlier updates are cleaned from
`desktop-state/updates/` on the next start.

The install stamp is written by two programs: `dpx` writes the ISO `installedAt`, the shell writes the epoch `installedAtMillis`, and readers accept both shapes — the stamp now carries both fields so neither side loses the install time it does not write itself.
Its `schemaVersion` is validated against `DESKTOP_STAMP_SCHEMA_VERSIONS` (`[1]`) instead of being accepted silently; a stamp outside that list is reported as damaged (`stampDamaged`, `stampReason`, `stampMessage`) rather than read as if it were version 1, and a damaged stamp never blocks an update.
