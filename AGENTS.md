# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test,
release, architecture, and sharp-edge notes that should travel with the code.

## Commands

- `COMMANDS.md` is the user-facing reference for every flag, env var and API route. `npm test`
  fails if a build flag, setup flag, npm script or documented API route drifts out of sync with it —
  update the doc in the same change as the code.
- `./setup` (or `setup.cmd` / `npm run setup`) — installs the whole toolchain. `--dry-run` shows the
  plan, `--yes` is unattended, `--only`/`--skip` select steps.
- `npm start` — converter service on `PORT` (default 3000), binds `HOST` (default `0.0.0.0`).
- `npm test` — `scripts/selftest.js`. Needs no Rust/JDK/Android SDK; must stay that way.
- `npm run doctor` — reports which targets this host can build and the fix for each gap.
- `./build --exe --android` (or `build.cmd` on Windows) — the build pipeline. `--help` lists flags.

## Architecture

- **`lib/paths.js` owns every path.** Derived from the repo location, overridable by env var.
  Nothing anywhere else may hard-code an absolute path — `npm test` fails the build if a user home
  directory appears in any source file.
- **`lib/toolchain.js` owns every tool lookup.** JDK, Android SDK/NDK, cargo, and the Tauri CLI are
  discovered at runtime by scanning `PATH` and OS-conventional locations.
- **`lib/ensure-deps.js` runs before the first third-party `require()`** in `server.js`, so a fresh
  clone boots without a manual `npm install`. It also repairs npm's optional-dependency bug, which
  leaves the Tauri CLI without a native binding when `node_modules` was populated on another OS.
- **Builds never mutate tracked config.** Per-build product name, identifier and icons are passed to
  Tauri through a generated `--config` overlay in `.build-workspace/`, so a crashed build cannot
  leave `tauri.conf.json` or `package.json` half-rewritten.

## The baseline / workspace split (important)

- `dist/` is the **committed baseline** — the shared web build every generated app starts from.
- `.build-workspace/dist/` is what Tauri actually compiles (`tauri.conf.json` →
  `frontendDist: "../.build-workspace/dist"`). It is gitignored.
- **Fast mode** stages the baseline, replaces only `static/files/`, keeps the compile cache, and
  leaves `dist/` untouched.
- **Clean mode** purges `src-tauri/target/`, builds from the whole upload, then syncs it back into
  `dist/` — that is the only thing allowed to change the baseline.

Never point `frontendDist` back at `dist/`: that is what previously let an upload destroy the
committed baseline on every job.

## Build speed (do not regress these)

A warm Fast build is ~12s on Windows, down from ~60s. Four changes got it there, each backed by a
measurement — re-measure before undoing any of them:

- **`[profile.release]` in `src-tauri/Cargo.toml`** (`opt-level=1`, `codegen-units=256`,
  `incremental`, `panic="abort"`, `strip`): compile+link 27.5s → ~7s. Assets are embedded in the
  binary, so *every* build relinks; this is the single biggest lever. A 5 KB payload still cost
  22.3s before this, proving the bottleneck was the crate, not the assets.
- **Fast and Clean must share that one profile.** Cargo keys its cache on profile settings — giving
  Clean its own profile silently turns the next Fast build into a full rebuild.
- **NSIS only, no MSI/WiX** (`--bundles nsis`): saves ~12s. Nothing in this pipeline ever published
  the MSI.
- **NSIS `compression: zlib`** via the config overlay: 24.8s → 10.8s for +0.1% installer size. The
  payload is already-compressed `.glb`/`.jpg`, so lzma buys nothing here.
- **Android fast mode compiles `aarch64` only**; clean compiles all four ABIs. Default is four full
  Rust compilations per job. `pruneAndroidJniLibs()` must run before every Android build: Tauri
  symlinks each `.so` into `jniLibs/<abi>/` and those links outlive the run, so a single-ABI build
  inherits dangling links from a four-ABI one and Gradle dies with
  *"Cannot snapshot .../libapp_lib.so: not a regular file"*.

`build.js` logs a `[TIME]` line per phase and writes `timings` into `build-result.json` — use those
rather than guessing where a slow build went.

## Build time estimates

`lib/estimate.js` records every **successful** build's duration in `.build-workspace/build-stats.json`,
keyed by `mode|targets|warm-or-cold-cache`. Estimates are the median of recent matching runs, blended
with a built-in default until three samples exist. Failed builds and implausible durations are never
recorded, so the median stays meaningful.

Progress percentage and ETA are computed **server-side** in `progressFor()` / `publicJob()` and
returned on every job — clients render, they do not invent. Do not reintroduce a client-side timer.

## Concurrency (build slots)

`BUILD_CONCURRENCY` (default 2) builds run at once, each in its own slot under
`.build-workspace/slots/<n>/` — a private project copy with its own staged `dist/` and its own
`src-tauri/gen/android`. `build.js --slot <id>` selects one; without it the build runs from the repo.

The Rust **target directory is shared** across slots on purpose (`CARGO_TARGET_DIR`): Cargo locks it,
so concurrent compiles serialise instead of corrupting, and every slot inherits the warm dependency
cache instead of a cold multi-minute first build. Everything that is not Cargo — staging, Gradle,
NSIS, signing — runs fully in parallel. Do not give slots private target dirs to "fix" the lock
contention; that trades ~10s of waiting for ~2min of cold rebuilds and gigabytes per slot.

The first build in a newly created slot is ~45s rather than ~12s while that slot's `app` artifacts
are produced. This is expected, not a regression.

## Cancellation

`POST /api/jobs/:id/cancel` and `/api/jobs/cancel-all`, or `npm run jobs -- cancel <id>`.
A running build's whole process tree must die — `build.js` spawns the Tauri CLI, which spawns cargo,
rustc, the linker, Gradle and makensis. POSIX uses `detached: true` plus a negative-pid group signal;
Windows uses `taskkill /T /F`. Killing only the direct child leaves orphans holding the slot's files.
Cancelled jobs get status `cancelled`, deliberately distinct from `failed`.

## Sharp edges
- `src-tauri/gen/android` is tracked and bakes in the bundle identifier. `build.js` re-runs
  `tauri android init` only when the requested identifier differs from the generated one, which does
  dirty those tracked files — expected, they are generated code.
- Tauri's generated `BuildTask.kt` hard-codes `npx`, which does not exist on Windows.
  `patchBuildTaskKt()` rewrites it after every `android init`; it searches for the file rather than
  assuming a package directory, because the path follows the identifier.
- Artifact freshness is checked by mtime against the build start time, so a failed build never
  publishes the previous run's binary.
- macOS and iOS targets are dropped up front unless the host is macOS.
- `.gitattributes` pins `build` to LF and `*.cmd` to CRLF. `build` is a real file with mode 100755,
  **not** a symlink — a symlink breaks on Windows checkouts.

## Toolchain

`npm run doctor` is authoritative. Summary: Android needs Rust + JDK 17 + Android SDK build-tools
(`zipalign`, `apksigner`) + NDK; Windows-from-Linux needs the `x86_64-pc-windows-gnu` target plus
`mingw-w64` and `nsis`; macOS/iOS need a Mac with Xcode. Rust targets are added automatically via
`rustup`. Installing Rust itself is opt-in via `AUTO_INSTALL_TOOLCHAIN=1`.

On Windows without native Rust, the build re-runs itself inside WSL — but only when WSL has both a
Linux Node.js and cargo (`lib/wsl.js` verifies both; a Windows `node.exe` reached through interop is
rejected because it would spawn Windows cargo again).

## Cloud

`Dockerfile` / `docker-compose.yml` build Android and cross-compiled Windows artifacts. Keep the
`rust-target` and `android-gen` volumes — they are what makes Fast mode fast across restarts.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
