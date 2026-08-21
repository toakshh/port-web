# Tripo Web-to-App Converter

Turn a web build (a ZIP containing `index.html`) into native **Android**, **Windows**, **macOS**
and **iOS** packages, either from the command line or through a small cloud service with a web
dashboard. The native shell is [Tauri v2](https://tauri.app); this repository is the pipeline
around it.

Everything here is path-independent and OS-independent: clone it anywhere, on Windows, Linux or
macOS, and run it. Missing npm packages install themselves; missing system toolchains are reported
with the exact command to fix them.

---

**[COMMANDS.md](COMMANDS.md) is the full command reference** — every flag, every environment
variable, every API route, and a troubleshooting table.

---

## Quick start

One script installs and links the whole toolchain — Rust, JDK, Android SDK/NDK, platform
dependencies and npm packages — on Windows, macOS or Linux:

```bash
./setup
```

On Windows use `setup.cmd`, or run `npm run setup` anywhere. It installs only what is missing, into
the locations this project already looks in, so there is nothing to link afterwards. Add `--dry-run`
to see the plan first, or `--yes` for unattended runs.

The only prerequisite is Node.js 18.17+, and the launcher will try to install even that.

Then check what the machine can build:

```bash
npm run doctor
```

It prints what is present, what is missing, and the exact command to fix each gap:

```
Toolchain
  [OK  ] Rust / cargo      /home/you/.cargo/bin/cargo
  [OK  ] JDK               /usr/lib/jvm/java-17-openjdk-amd64
  [MISS] Android NDK       sdkmanager "ndk;27.1.12297006"
...
Ready to build: windows
```

Then either start the service:

```bash
npm start
```

and open <http://localhost:3000>, or build straight from the CLI:

```bash
./build --exe --android
```

On Windows use `build.cmd` (or `npm run build -- --exe`); `./build` is a real POSIX script, not a
symlink, so both work from a fresh clone on any OS.

---

## The two build modes

The repository keeps a **baseline web build** in `dist/`. It is the "common file data" that every
generated app shares — the HTML shell, the JS/CSS chunks, the loaders. Uploaded ZIPs differ from it
only in `static/files/` (the 3D models, `masterData.json`, and similar payloads).

### Fast Hot-Swap — `--mode fast` (default)

Stages the committed baseline, then replaces **only `static/files/`** with the folder from the
uploaded ZIP. The Rust compilation cache and the generated Android project are kept, so the build is
incremental instead of starting from scratch. `dist/` is never modified.

Use it for the common case: same app, new payload.

Requires the uploaded ZIP to contain `static/files/`. If it does not, the job fails with a message
saying so rather than silently building the wrong thing.

### Clean Full Rebuild — `--mode clean`

Purges `src-tauri/target/`, builds from the **entire** uploaded ZIP, and on success syncs those
assets back into `dist/`, permanently updating the baseline. Every later fast build then starts from
the new common files.

Use it when the shared app shell itself changed — a new feature, an upgraded framework bundle, new
shared assets.

```bash
./build --exe --mode clean --web-src /path/to/extracted-web-build
```

Nothing outside `dist/` is written by a clean build: `src-tauri/tauri.conf.json` and `package.json`
are never rewritten (per-build customisation goes through Tauri's `--config` overlay), so an
interrupted build cannot leave the repository in a half-renamed state.

---

## CLI reference

```
Usage: build [target-flags] [options]

Targets:
  --android              Signed Android APK
  --exe, --windows       Windows executable + NSIS installer
  --mac                  macOS app bundle / DMG   (macOS host only)
  --ios                  iOS app package          (macOS host only)
  --all                  Everything this host supports

Build mode:
  --fast                 Reuse caches; swap only static/files from --web-src (default)
  --clean                Purge caches, rebuild fully, then update the baseline

Web assets:
  --web-src <dir>        Web build to take assets from (default: the baseline in dist/)

Customization:
  --name "<name>"        Product name, window title and installer name
  --logo, --icon <path>  PNG/JPG used to generate the whole icon set
  --identifier <id>      Bundle identifier, e.g. com.example.app

Speed:
  --no-installer         Bare executable only, skipping the installer step
  --bundles <list>       Desktop bundle formats (default: nsis on Windows)
  --abis <list>          Android ABIs (fast: aarch64, clean: all four)

Other:
  --out <dir>            Artifact output directory (default: dist-builds/)
  --no-wsl               Never delegate a Windows build to WSL
```

Artifacts land in `dist-builds/{android,windows,mac,ios}/`, alongside a machine-readable
`dist-builds/build-result.json` describing exactly what was produced and what failed.

Targets the host cannot possibly build (macOS/iOS off a Mac) are skipped up front with a warning
instead of producing a mislabelled binary.

---

## HTTP API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET`  | `/api/health` | Service status, host capabilities, queue depth, baseline state |
| `GET`  | `/api/estimate?targets=android,exe` | Predicted duration of a fast vs clean build |
| `POST` | `/api/convert` | Upload a build and queue a job — returns `202` with a `jobId` |
| `GET`  | `/api/jobs` | Recent jobs |
| `GET`  | `/api/jobs/:jobId` | Job status, stage and artifact list |
| `GET`  | `/api/jobs/:jobId/log` | Tail of the build log |
| `GET`  | `/api/download/:jobId` | The all-in-one ZIP |
| `GET`  | `/api/download/:jobId?file=apk\|exe\|setup\|dmg\|ios\|zip` | One artifact |

`POST /api/convert` fields (multipart):

| Field | Required | Notes |
| ----- | -------- | ----- |
| `webBuild` | yes | `.zip` containing `index.html` |
| `appLogo` | no | PNG/JPG/ICO/WEBP |
| `appName` | no | Product name |
| `appIdentifier` | no | Must look like `com.example.app` |
| `targets` | no | Comma-separated: `android,exe,mac,ios` (default `android,exe`) |
| `mode` | no | `fast` (default) or `clean` |

Builds run in a background queue. Up to `BUILD_CONCURRENCY` of them run at once (default 10), each in
its own isolated slot, so simultaneous users can never overwrite each other's files. The upload
request returns immediately; poll the job for progress.

Stop a build from the command line:

```bash
npm run jobs -- cancel <jobId>
```

```bash
# queue a job
curl -F webBuild=@build.zip -F targets=android -F mode=fast \
     http://localhost:3000/api/convert

# or block until it finishes (handy in CI)
curl -F webBuild=@build.zip "http://localhost:3000/api/convert?wait=1"
```

### Why Fast mode is fast

Tauri embeds the web assets *into* the compiled binary, so swapping `static/files/` unavoidably
recompiles and relinks the `app` crate. Measured on a Windows host, the original 60s Fast build
broke down as:

| Phase | Before | After | How |
| ----- | -----: | ----: | --- |
| Stage web assets | 0.2s | 0.2s | Incremental sync — only changed files are copied |
| Compile + link `app` | 27.5s | ~7s | Tuned `[profile.release]` in `src-tauri/Cargo.toml` |
| MSI / WiX bundle | 12.2s | 0s | Not built — nothing in this pipeline ever shipped it |
| NSIS installer | 17.8s | ~9s | `zlib` compression instead of `lzma` |
| **Total** | **~60s** | **~12s** | |

Two measurements drove those choices:

- Building with a 5 KB payload instead of the full 56 MB one still cost 22.3s, so asset embedding
  was never the bottleneck — the fixed compile and link of the `app` crate was.
- Running the NSIS bundle on its own, `lzma` produced a 47.63 MB installer in 24.8s while `zlib`
  produced 47.68 MB in 10.8s. The payload is already-compressed `.glb`/`.jpg` data, so the stronger
  algorithm bought 0.1% of size for 14s of wall clock.

Fast and Clean deliberately **share one Cargo profile**. Cargo keys its cache on profile settings,
so giving Clean a different profile would invalidate the cache and make the *next* Fast build a full
rebuild.

For Android, `tauri android build` compiles all four ABIs by default — four full Rust compilations.
Fast mode builds `aarch64` only (every real device shipped in the last decade); Clean mode builds
the universal APK that also runs on emulators and 32-bit hardware. Override with `--abis`.

Measured Fast builds on a warm cache, with a real payload swap:

| Targets | Time |
| ------- | ---: |
| `--exe` | ~9-12s |
| `--exe --no-installer` | ~7s |
| `--android` | ~14s |
| `--android --exe` | ~23s |

Every build prints a `[TIME]` line per phase and writes a `timings` array into
`dist-builds/build-result.json`, so a slow build can be diagnosed instead of guessed at.

### Build time estimates

As soon as a ZIP is selected the dashboard shows how long each mode is expected to take, and during
a build it shows a live percentage plus the remaining time.

Estimates are **measured, not guessed**. Every successful build records its duration in
`.build-workspace/build-stats.json`, keyed by mode, target set, and whether the Rust cache was warm.
An estimate is the median of recent matching runs; the built-in defaults only apply until this host
has a history, and the UI labels which is which:

| Label | Meaning |
| ----- | ------- |
| `estimate` | No matching builds recorded yet — a default |
| `partly measured` | 1–2 real builds recorded, blended with the default so one outlier cannot skew it |
| `measured` | Median of 3+ real builds on this host (shown in green) |

Implausible samples (under 2s, over 6h) are discarded, and failed builds are never recorded — a job
that died in ten seconds says nothing about how long a real build takes.

A worked example from this project's own host: a Windows fast build was first predicted at 82s and
actually took 49s; after three runs the estimate settled at 49s and flipped to `measured`.

Progress and ETA are computed **server-side** and returned on every job, so the dashboard, `curl`
and any other client all show the same number instead of each animating its own guess.

### Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `MAX_UPLOAD_MB` | `500` | Upload size limit |
| `JOB_RETENTION` | `20` | Finished jobs kept on disk |
| `BUILD_CONCURRENCY` | `10` | How many builds run at once, each in its own slot |
| `BASELINE_DIST` | `./dist` | Baseline web build |
| `BUILD_WORKSPACE` | `./.build-workspace` | Scratch area Tauri compiles from |
| `DIST_BUILDS`, `JOBS_DIR`, `UPLOADS_DIR` | `./dist-builds`, `./jobs`, `./uploads` | Output/state |
| `AUTO_INSTALL_TOOLCHAIN` | unset | `1` lets the build install Rust itself |

---

## Running in the cloud

```bash
docker compose up --build
```

The image ships Node, Rust, JDK 17, the Android SDK/NDK, and mingw-w64 + NSIS, so it builds Android
APKs and cross-compiles Windows installers. macOS and iOS need Apple toolchains and are reported as
unavailable by `/api/health`.

Keep the named volumes: `rust-target` and `android-gen` are the caches that make Fast mode fast
across restarts. Without them every job behaves like a clean rebuild.

Any Node host works too — the service reads `PORT`/`HOST`, binds `0.0.0.0` by default, and needs no
writable location outside the project directory.

---

## Toolchain requirements

| Target | Needs |
| ------ | ----- |
| Android | Rust + Android targets, JDK 17+, Android SDK (build-tools for `zipalign`/`apksigner`), NDK |
| Windows (on Windows) | Rust + MSVC build tools |
| Windows (from Linux) | Rust + `x86_64-pc-windows-gnu` target, `mingw-w64`, `nsis` |
| macOS / iOS | A macOS host with Xcode |

`npm run doctor` checks all of it and prints the fix for each gap. Rust targets are added
automatically via `rustup` when they are missing.

**Windows without native Rust:** if WSL has both Node.js and cargo, the build is transparently
re-run inside WSL. Otherwise install Rust natively (`winget install Rustlang.Rustup`) — the build
tells you which it did.

---

## Tests

```bash
npm test
```

Runs `scripts/selftest.js`: path portability, fast/clean staging semantics, ZIP-slip rejection,
ZIP-root normalisation, download path-traversal rejection, and the live HTTP API. It needs no Rust,
JDK or Android SDK, so it passes on a bare machine and in CI.

---

## Layout

```
COMMANDS.md              Full command, flag and API reference
setup / setup.cmd        One-command toolchain installer
build / build.cmd        Cross-platform launchers for build.js
build.js                 The multi-platform build pipeline
server.js                HTTP service, upload handling, job queue
lib/paths.js             Every path, derived from the repo location
lib/toolchain.js         JDK / Android SDK / NDK / Rust / Tauri CLI discovery
lib/ensure-deps.js       Installs missing npm packages before first use
lib/fsx.js               Incremental sync, safe ZIP extraction
lib/estimate.js          Build-duration history and time estimates
lib/slots.js             Isolated project directories for concurrent builds
lib/wsl.js               Optional Windows -> WSL build delegation
scripts/setup.js         Toolchain installer (the setup launchers call this)
scripts/doctor.js        Environment report
scripts/jobs.js          List / follow / cancel builds on the service
scripts/selftest.js      Test suite
public/                  Dashboard
dist/                    Baseline web build (the shared "common file data")
src-tauri/               Tauri app crate
```
