# Command reference

Everything you can run, what each flag does, and what has to be installed first.

Quick links: [Setup](#setup) · [Requirements](#requirements) · [Commands](#commands) ·
[Build flags](#build-flags) · [Server](#server) · [HTTP API](#http-api) ·
[Environment variables](#environment-variables) · [Troubleshooting](#troubleshooting)

---

## Setup

One script installs and links everything, on Windows, macOS and Linux:

```bash
./setup
```

```bash
setup.cmd
```

Or through npm, which works identically everywhere:

```bash
npm run setup
```

It installs only what is missing, into the locations this project already looks in — there are no
PATH edits or environment variables to export afterwards. It prints exactly what it will do and asks
before touching anything.

| Flag | Effect |
| ---- | ------ |
| `--dry-run` | Show the plan and change nothing |
| `--yes`, `-y` | Skip the confirmation prompt (CI / unattended) |
| `--skip <steps>` | Comma-separated steps to skip |
| `--only <steps>` | Run just these steps |
| `--desktop-only` | Shorthand for `--skip android,jdk,keystore` |
| `--help`, `-h` | Usage |

Steps are `node`, `rust`, `jdk`, `android`, `platform`, `keystore`. Re-running is safe: anything
already installed is detected and skipped.

```bash
./setup --dry-run
```

Only the desktop build, skipping the Android toolchain:

```bash
./setup --desktop-only --yes
```

Then confirm what the machine can build:

```bash
npm run doctor
```

---

## Requirements

The only thing you need before `setup` is **Node.js 18.17+**. The launcher will try to install even
that for you if it is missing.

Everything below is what `setup` installs — listed so you know what is on your machine, and what to
install by hand if you would rather not run the script.

### npm packages

Installed automatically by `setup`, and also on demand the first time the server or a build runs —
a fresh clone boots without a manual `npm install`.

| Package | Why |
| ------- | --- |
| `express` | HTTP service |
| `cors` | Cross-origin requests to the API |
| `multer` | Upload handling |
| `adm-zip` | Reading uploaded ZIPs, writing artifact bundles |
| `@tauri-apps/cli` | The Tauri build tool (dev dependency) |
| `@tauri-apps/cli-<platform>` | Native binary for the CLI, one per OS/arch (optional dependency) |

The last one is the usual cause of a broken checkout: npm has a
[long-standing bug](https://github.com/npm/cli/issues/4828) that leaves only the *other* platform's
binary behind when `node_modules` was populated on a different OS. This project detects and repairs
that automatically.

### System toolchains

| Target | Needs |
| ------ | ----- |
| **Android** | Rust + 1-4 Android targets, JDK 17, Android SDK (a platform + build-tools for `zipalign`/`apksigner`), NDK |
| **Windows** (on Windows) | Rust + MSVC build tools (the linker) |
| **Windows** (from Linux) | Rust + `x86_64-pc-windows-gnu` target, `mingw-w64`, `nsis` |
| **macOS / iOS** | A macOS host with Xcode — cannot be cross-compiled |
| **Linux desktop** | `webkit2gtk`, `gtk3`, `librsvg`, `libsoup3` and build essentials |

`npm run doctor` is the authority on all of this. It reports what is present, what is missing, and
the exact command to fix each gap:

```bash
npm run doctor
```

Rust cross-compilation targets are added automatically by the build when they are missing. Installing
Rust *itself* during a build is opt-in — set `AUTO_INSTALL_TOOLCHAIN=1`, or just run `./setup`.

---

## Commands

| Command | What it does |
| ------- | ------------ |
| `npm run setup` | Install and link the whole toolchain |
| `npm run doctor` | Report what this host can build, and how to fix gaps |
| `npm start` | Start the converter service and web dashboard |
| `npm run dev` | Same, restarting on file changes |
| `npm test` | Self-test — needs no Rust, JDK or Android SDK |
| `npm run build -- <flags>` | The build pipeline (note the `--`) |
| `npm run build:exe` | Windows executable and installer |
| `npm run build:android` | Signed Android APK |
| `npm run build:mac` | macOS bundle (macOS host only) |
| `npm run build:all` | Everything this host supports |
| `./build <flags>` | The build pipeline directly (macOS/Linux) |
| `build.cmd <flags>` | The build pipeline directly (Windows) |

`./build`, `build.cmd` and `npm run build --` are the same program; use whichever fits your shell.
They work from any directory — every path is derived from the repository location.

---

## Build flags

```bash
./build --help
```

### Targets — pick at least one

| Flag | Produces |
| ---- | -------- |
| `--android` | Signed APK → `dist-builds/android/tripo-app-signed.apk` |
| `--exe`, `--windows` | `dist-builds/windows/app.exe` + `tripo-setup.exe` |
| `--mac`, `--dmg` | macOS bundle → `dist-builds/mac/` *(macOS host only)* |
| `--ios` | iOS package → `dist-builds/ios/` *(macOS host only)* |
| `--all` | Every target this host supports |

Targets the host cannot build are dropped up front with a warning, rather than producing a
mislabelled binary.

### Build mode

| Flag | Meaning |
| ---- | ------- |
| `--fast` | **Default.** Reuse the baseline, swap only `static/files/`, keep compile caches |
| `--clean` | Purge caches, build from the whole upload, then update the shared baseline |
| `--mode fast\|clean` | Same thing, spelled out |
| `--quick` | Alias for `--fast` |

Fast is the default everywhere — the CLI, the API, and the dashboard.

### Web assets

| Flag | Meaning |
| ---- | ------- |
| `--web-src <dir>` | Build from this web build. Default: the committed baseline in `dist/` |

In **fast** mode only `<dir>/static/files/` is taken; everything else comes from the baseline. In
**clean** mode the whole directory is used, and on success it replaces the baseline.

### Customization

| Flag | Meaning |
| ---- | ------- |
| `--name "<name>"` | Product name, window title and installer name |
| `--logo <path>`, `--icon <path>` | PNG/JPG used to generate the entire icon set |
| `--identifier <id>` | Bundle identifier, e.g. `com.example.app` |

These are applied through a Tauri config overlay, so `tauri.conf.json`, `package.json` and
`src-tauri/icons/` are never rewritten — an interrupted build cannot leave the repo half-renamed.

### Speed

| Flag | Meaning |
| ---- | ------- |
| `--no-installer` | Bare executable only, skipping the installer step (the quickest build) |
| `--bundles <list>` | Desktop bundle formats. Default `nsis`. e.g. `--bundles nsis,msi` |
| `--abis <list>` | Android ABIs. Fast builds `aarch64`; clean builds all four. `--abis all` for universal |
| `--no-bundle` | Alias for `--no-installer` |
| `--android-targets <list>` | Alias for `--abis` |

Valid ABIs: `aarch64`, `armv7`, `i686`, `x86_64`, or `all`.

Windows bundle formats are `nsis` (the installer this pipeline publishes) and `msi`. Only `nsis` is
built by default — the MSI added about 12s per build and was never downloaded.

### Other

| Flag | Meaning |
| ---- | ------- |
| `--out <dir>` | Artifact output directory. Default `dist-builds/` |
| `--no-wsl` | Never delegate a Windows build to WSL |
| `--help`, `-h` | Usage |

### Examples

Fastest possible desktop build:

```bash
./build --exe --no-installer
```

Rebuild everything from a new upload and update the shared baseline:

```bash
./build --android --exe --mode clean --web-src /path/to/web-build
```

Branded APK that runs on emulators and 32-bit devices too:

```bash
./build --android --abis all --name "My App" --identifier com.example.myapp --logo ./logo.png
```

On Windows:

```bash
build.cmd --exe --name "My App"
```

### What a build writes

```
dist-builds/
  android/tripo-app-signed.apk
  windows/app.exe, tripo-setup.exe
  mac/, ios/
  build-result.json      what was produced, what failed, per-phase timings
```

Every build prints a `[TIME]` line per phase, so a slow build can be diagnosed rather than guessed at.

---

## Server

```bash
npm start
```

Then open <http://localhost:3000>. Upload a ZIP, pick targets and a mode, and download the results.
The dashboard shows an estimated time for each mode before you commit, and a live percentage and
ETA while the build runs.

Builds run in a background queue, **one at a time** — they share a single Rust compile cache and one
generated Android project, so running two at once would corrupt both.

---

## HTTP API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/api/health` | Status, host capabilities, queue depth, baseline state |
| `GET` | `/api/estimate?targets=android,exe` | Predicted duration for fast vs clean |
| `POST` | `/api/convert` | Upload and queue a job — returns `202` with a `jobId` |
| `GET` | `/api/jobs` | Recent jobs |
| `GET` | `/api/jobs/:jobId` | Status, stage, progress, ETA, artifacts |
| `GET` | `/api/jobs/:jobId/log` | Build log tail |
| `GET` | `/api/download/:jobId` | All artifacts as one ZIP |
| `GET` | `/api/download/:jobId?file=apk\|exe\|setup\|dmg\|ios\|zip` | A single artifact |

`POST /api/convert` fields (multipart form):

| Field | Required | Notes |
| ----- | -------- | ----- |
| `webBuild` | yes | `.zip` containing `index.html` |
| `appLogo` | no | PNG / JPG / ICO / WEBP |
| `appName` | no | Product name |
| `appIdentifier` | no | Must look like `com.example.app` |
| `targets` | no | `android,exe,mac,ios` — default `android,exe` |
| `mode` | no | `fast` (default) or `clean` |

Queue a job and poll it:

```bash
curl -F webBuild=@build.zip -F targets=android,exe -F mode=fast http://localhost:3000/api/convert
```

Or block until it finishes, which is handy in CI:

```bash
curl -F webBuild=@build.zip "http://localhost:3000/api/convert?wait=1" -o result.json
```

Download the finished artifacts:

```bash
curl -O -J "http://localhost:3000/api/download/job_1234567890_abcde?file=apk"
```

---

## Environment variables

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `MAX_UPLOAD_MB` | `500` | Upload size limit |
| `JOB_RETENTION` | `20` | Finished jobs kept on disk |
| `BASELINE_DIST` | `./dist` | The shared baseline web build |
| `BUILD_WORKSPACE` | `./.build-workspace` | Scratch area Tauri compiles from |
| `DIST_BUILDS` | `./dist-builds` | CLI artifact output |
| `JOBS_DIR` | `./jobs` | Per-job state and outputs |
| `UPLOADS_DIR` | `./uploads` | Temporary upload storage |
| `AUTO_INSTALL_TOOLCHAIN` | unset | `1` lets a build install Rust itself |
| `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME` | auto-detected | Override toolchain discovery |

---

## Docker

```bash
docker compose up --build
```

Builds Android APKs and cross-compiled Windows installers. macOS and iOS need Apple toolchains and
are reported as unavailable by `/api/health`.

Keep the named volumes — `rust-target` and `android-gen` are the caches that make fast mode fast
across restarts. Without them every job behaves like a clean rebuild.

---

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `No Rust toolchain found` | Run `./setup`, or `winget install Rustlang.Rustup` / `curl https://sh.rustup.rs -sSf \| sh` |
| `Cannot find native binding` from Tauri | `node_modules` came from another OS. Re-run `./setup`, or `npm install` |
| `Fast mode needs "static/files"` | The ZIP has no `static/files/` folder. Use Clean Rebuild instead |
| `android: no JDK found` | `./setup --only jdk`, then open a new terminal |
| `zipalign/apksigner not found` | Build-tools missing: `./setup --only android` |
| Gradle "failed: timeout" on first Android build | Gradle downloads itself on first use; retry, or fetch the zip named in the error into the folder it names |
| `Cannot snapshot .../libapp_lib.so` | Stale ABI links — handled automatically now; if seen, delete `src-tauri/gen/android/app/src/main/jniLibs/` |
| `port 3000 is already in use` | Another instance is running; stop it or set `PORT` |
| macOS/iOS targets skipped | Expected off a Mac — Apple toolchains cannot be cross-compiled |
| Everything looks installed but is "MISS" | Open a new terminal so `PATH` picks up the new tools, then `npm run doctor` |

When a build fails, the per-phase `[TIME]` lines and `dist-builds/build-result.json` show exactly
which stage failed and why.
