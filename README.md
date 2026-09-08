# dsh-dpx

`dsh-dpx` creates **named, fully isolated DeepSeek Harness (DSH) environments** on one machine. It is intended for DSH/TUI development, version debugging, and future third-party DSH distributions.

An environment owns its own:

- npm global prefix and npm download cache;
- DSH profile/config/session/storage tree (`DSH_HOME`);
- DSH agents/skills tree (`DSH_AGENTS_HOME`);
- user-home/app-data/temp variables used by launched DSH processes;
- working directory and a local `dsh-distribution.json` descriptor.

It does **not** alter the system npm prefix, the user’s normal `~/.dsh` / `~/.agents`, or another DPX environment.

> Status: experimental, Windows-first. Version `0.1.0` implements the requested isolated npm workflow and a documented DPX v1 discovery profile. It deliberately does not claim that its Windows registry location is mandated by the portable `dsh-distribution` protocol.

## Install dpx

```powershell
npm install -g dsh-dpx
```

For local development from this repository:

```powershell
npm link
```

Node.js 22.19+ is required. npm package downloads follow the current npm proxy configuration; on this workstation that is Clash at `http://127.0.0.1:7897`.

## Create and populate an isolated DSH environment

The first command gives the environment its name and its storage parent:

```powershell
dpx npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui --test --"D:\DevEnvs\Projects"
```

The command creates this structure:

```text
D:\DevEnvs\Projects\dsh-environments\test\
├── npm-prefix\       # this environment's npm global packages and shims
├── npm-cache\        # this environment's npm cache
├── dsh-home\         # DSH profiles, settings, sessions, storage
├── agents-home\      # DSH agent/skill configuration
├── workspace\        # dpx launch working directory
├── dsh-distribution.json
└── .dpx-environment.json
```

Later installs target the registered environment and need no storage path:

```powershell
dpx npm install -g @deepseek-harness-tui/dsh-tui --test
```

`dpx` accepts only npm global installs in this initial release. It controls `--prefix` itself, so callers must not supply it. Package lifecycle scripts retain normal user permissions: an isolated directory is **not** an OS sandbox.

## Launch an isolated environment

```powershell
dpx run --test dsh-tui
dpx run --test dsh web --no-open
```

`dpx run` preserves target arguments after the target name. Every DSH launch receives absolute, environment-local `DSH_HOME` and `DSH_AGENTS_HOME`, so it cannot accidentally use the normal global DSH state.

The isolated `dsh-tui` package is launched directly from the environment npm prefix. Its first profile bootstrap calls DSH's `plugin` command, which requires `pnpm` on `PATH`; install/enable pnpm before first TUI bootstrap if needed:

```powershell
npm install -g pnpm
# or: corepack enable pnpm
```

## Inspect environments

```powershell
dpx env list
dpx env show --test
dpx descriptor --test
```

Each environment has a distinct `urn:uuid:` instance identity. Its public/static distribution identity remains `urn:dsh:distribution:t-auto:dsh-dpx`; this follows the `dsh-distribution` distinction between a distribution descriptor and an installation instance.

## Discovery and registration contract

Portable `dsh-distribution` currently defines descriptor, reference discovery, and optional Lodgement record semantics, but does **not** prescribe a global filesystem directory, environment variable, or Windows Registry key for installed environments. DPX therefore defines an implementation profile instead of pretending a universal registry exists:

| Contract | DPX v1 behavior |
| --- | --- |
| Static descriptor | `dsh-dpx/dsh-distribution.json`, plus one identical-format descriptor in every environment root |
| Instance record | `.dpx-environment.json` in the environment root with `EnvironmentInstance` and `DiscoverableEntry`-shaped records |
| Enumerable carrier | DPX's atomic `registry.json` under `DPX_HOME` |
| Windows discovery pointer | `HKCU\Software\DSH\DPX`: `Profile=dpx.dsh.dev/v1alpha1`, `RegistryPath=<absolute DPX registry path>` |
| Default DPX registry | `%LOCALAPPDATA%\DSH\DPX\registry.json`; override with absolute `DPX_HOME` |

The registry pointer only lets a compatible package manager locate DPX's registry without scanning disks. It conveys **no executable authority**, does not replace independent validation/trust checks, and intentionally does **not** write `HKCU\Software\DSH\EnvironmentInstallations`: that key is reserved for the separately verified fixed-environment installer managed by `dsh-distribution-manager`.

Registry writes use a short directory lock and atomic replacement. On a malformed registry, DPX fails closed and never overwrites it.

## `dsh-tui --test` compatibility plan

This project cannot install a command into another globally installed package, so `dpx run --test dsh-tui` is the supported implementation today. To make the exact desired command work both with and without a global dpx installation, the `dsh-tui` project should add a small compatibility adapter to its existing global launcher:

1. Parse an initial `--<environment-name>` selector before ordinary TUI arguments.
2. Read `HKCU\Software\DSH\DPX` and require `Profile=dpx.dsh.dev/v1alpha1`.
3. Read and schema-check the pointed `registry.json`; resolve only an exact name match; do not scan directories or execute registry-provided commands.
4. Derive fixed paths from the record root (`npm-prefix`, `dsh-home`, `agents-home`, and the package's own known `bin/dsh-tui.js`), set the same isolated environment variables as DPX, and delegate directly to the installed TUI package.
5. If no DPX pointer or matching environment exists, emit a concise actionable diagnostic: install dpx, use `dpx run --test dsh-tui`, or create the environment.

That adapter lets `dsh-tui --test` succeed when only the globally installed TUI launcher is present, while `dpx run --test dsh-tui` keeps working if only dpx is installed and TUI lives solely in the selected isolated environment. The adapter must not use the unrelated `EnvironmentInstallations` registry described above.

## Development

```powershell
npm test
npm run check
npm run pack:check
```

No production dependencies are required. Tests create temporary directories only and do not install upstream packages or launch a DSH profile.

## Security boundaries

- Names are constrained to ASCII aliases and all resolved storage roots must be absolute.
- First creation refuses to adopt a non-empty target directory.
- Registry corruption, duplicate names, and mismatched identities fail closed.
- npm, DSH runtime state, cache, and agent configuration are isolated directory roots, not security sandboxes.
- `NODE_OPTIONS` and `NODE_PATH` are cleared before dpx-launched npm/DSH processes; proxy variables are preserved for normal npm/DSH behavior.
- `DSH_TELEMETRY_DISABLED=1` is set for dpx-launched DSH processes.

## No automatic destructive action

Version `0.1.0` has no remove/erase command. Deleting environment state is irreversible and needs an explicit, separately designed workflow; unregistering must not silently remove files.
