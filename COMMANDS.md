# Command reference

Everything you can run, what each flag does, and what has to be installed first.

Quick links: [Setup](#setup) · [Requirements](#requirements) · [Commands](#commands) ·
[Build flags](#build-flags) · [Exit from the app](#closing-the-app-from-the-web-layer) ·
[Server](#server) · [Concurrency](#concurrency) ·
[Managing builds](#managing-builds) · [HTTP API](#http-api) ·
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
| `npm run jobs` | List running/queued/finished builds on the service |
| `npm run jobs -- <cmd>` | Inspect, follow or stop a build (see [Managing builds](#managing-builds)) |
| `npm run cancel <id>` | Stop one build |

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
| `--installer-only` | Ship only the Windows setup installer; the bare `app.exe` is not published |
| `--bundles <list>` | Desktop bundle formats. Default `nsis`. e.g. `--bundles nsis,msi` |
| `--abis <list>` | Android ABIs. Fast builds `aarch64`; clean builds all four. `--abis all` for universal |
| `--no-bundle` | Alias for `--no-installer` |
| `--setup-only` | Alias for `--installer-only` |
| `--android-targets <list>` | Alias for `--abis` |

Valid ABIs: `aarch64`, `armv7`, `i686`, `x86_64`, or `all`.

Windows bundle formats are `nsis` (the installer this pipeline publishes) and `msi`. Only `nsis` is
built by default — the MSI added about 12s per build and was never downloaded.

### Display

| Flag | Meaning |
| ---- | ------- |
| `--fullscreen` | Fullscreen on every target — Android immersive **and** borderless desktop |
| `--no-fullscreen` | Keep system bars and window decorations |

**Default: Android is immersive, desktop is windowed.** Android hides the navigation and status
bars and draws into the display cutout (notch), because system bars over a full-screen 3D experience
are almost never wanted. Pass `--no-fullscreen` to opt out.

The bars stay hidden but remain swipe-accessible (`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`, the
Android-recommended "sticky immersive" behaviour) and are re-hidden when the app regains focus.

Tauri exposes no setting for this, so `build.js` patches the generated `MainActivity.kt` and
`themes.xml` after `android init` — the same approach already used for `BuildTask.kt`.

### Other

| Flag | Meaning |
| ---- | ------- |
| `--out <dir>` | Artifact output directory. Default `dist-builds/` |
| `--slot <id>` | Build in an isolated slot (see [Concurrency](#concurrency)). The server sets this; a plain CLI build does not need it |
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

Builds run in a background queue. Up to `BUILD_CONCURRENCY` of them run at once (default 2), each in
its own isolated slot — see [Concurrency](#concurrency).

---

## Closing the app from the web layer

The generated apps ship a native exit bridge, so your web build can shut itself down — an in-app
**Exit** button, a kiosk timeout, or an "end session" flow. Three routes work; all were verified by
running a real Windows build and reading its process exit code.

### 1. `@tauri-apps/plugin-process` — the standard API

```js
import { exit, relaunch } from '@tauri-apps/plugin-process';

async function closeApp() {
  await exit(0);
}
```

This is enabled: the Rust plugin is registered and `process:default` grants **`process:allow-exit`**
and `process:allow-restart`.

If your web build cannot add an npm dependency — the usual case here, since it is uploaded as a
pre-compiled bundle — call the identical function through the global instead. The plugin injects it
automatically because `withGlobalTauri` is on, so **nothing needs to be installed or bundled**:

```js
await window.__TAURI__.process.exit(0);       // same command as the import above
await window.__TAURI__.process.relaunch();
```

> **Caveat — `exit(code)` ignores a non-zero code.** The plugin routes through `AppHandle::exit`,
> which does not carry the status through. Measured: `exit(27)` closed the app but the process
> returned **0**. `exit(0)` behaves exactly as written. If the exit code matters, use route 3.

### 2. Closing the window

```js
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
await getCurrentWebviewWindow().close();
// or, with no bundled dependency:
await window.__TAURI__.webviewWindow.getCurrentWebviewWindow().close();
```

This needs **`core:window:allow-close`**, which is *not* part of `core:default` — that default grants
only read-only window queries. It is granted explicitly in
`src-tauri/capabilities/default.json`; `core:window:allow-destroy` is granted too, for `destroy()`
(force-close that skips the `close-requested` event). Without these the call is rejected at runtime
with **no build-time error**, which is the usual reason an exit button silently does nothing.

Closing the last window ends the process with exit code 0.

### 3. `exit_app` — when the exit code matters

A custom command that is the only route which reliably propagates a status code:

```js
await window.__TAURI__.core.invoke('exit_app');            // exit code 0
await window.__TAURI__.core.invoke('exit_app', { code: 7 });
```

Desktop runs Tauri's `cleanup_before_exit()` first, so teardown events still fire, then ends the
process with the requested code. Android ends the process directly, because `AppHandle::exit` can
leave the activity alive there.

### Detecting the native shell

`window.__TAURI__` exists **only inside the packaged app**, never in a browser, so it doubles as a
reliable "am I running natively?" check:

```js
const isNativeApp = typeof window.__TAURI__ !== 'undefined';
if (isNativeApp) showExitButton();
```

### Verified results

Measured on a real Windows build by reading the process exit code:

| Call | App closed | Exit code |
| --- | --- | --- |
| `__TAURI__.process.exit(27)` | yes | `0` — code dropped by the plugin |
| `getCurrentWebviewWindow().close()` | yes | `0` |
| `invoke('exit_app', { code: 27 })` | yes | `27` |

All three APIs were also confirmed present at runtime inside the packaged app.

Android was **not** verified on a physical device; the same permissions and code paths apply, and
the APK builds and installs, but the behaviour there is unconfirmed.

---

## Concurrency

Several people can build at once. Each build runs in its own **slot** — a private project directory
holding that build's staged web assets and its own generated Android project — so two users' files
can never mix. `BUILD_CONCURRENCY` sets how many run at a time (default `2`); anything beyond that
queues, and the queue position and wait are reported to the client.

```bash
BUILD_CONCURRENCY=4 npm start
```

Slots live in `.build-workspace/slots/<n>/`. The Rust **target directory is shared** between them on
purpose: Cargo locks it, so concurrent compiles wait for each other instead of corrupting anything,
and every slot inherits the same warm dependency cache rather than paying a cold multi-minute build
on first use. Everything that is not Cargo — staging, Gradle, NSIS, signing, packaging — runs fully
in parallel.

Practical consequences:

- The **first** build in a newly created slot is slower (roughly 45s instead of 12s) while that
  slot's own `app` crate artifacts are produced. It is fast from then on.
- Raising concurrency past the number of CPU cores will not help; compiles will just queue on the
  Cargo lock.
- Each slot costs a few hundred MB of disk for its project copy and generated Android project.

---

## Managing builds

`npm run jobs` talks to the running service, so it works locally or against a remote host with
`--url`.

| Command | Purpose |
| ------- | ------- |
| `npm run jobs` | List recent jobs and the queue |
| `npm run jobs -- show <id>` | Everything known about one job |
| `npm run jobs -- logs <id>` | Tail that job's build log |
| `npm run jobs -- watch <id>` | Follow a job until it finishes |
| `npm run jobs -- cancel <id>` | Stop one running or queued build |
| `npm run jobs -- cancel --all` | Stop everything running and queued |

| Option | Purpose |
| ------ | ------- |
| `--url <base>` | Service address. Default `http://127.0.0.1:3000` (or `$CONVERTER_URL`) |
| `--json` | Raw JSON instead of a table |
| `--help`, `-h` | Usage |

```bash
npm run jobs
```

```bash
npm run jobs -- cancel --all
```

Cancelling a **running** build kills its whole process tree — Cargo, rustc, the linker, Gradle and
makensis — then frees its slot for the next queued job. Cancelling a **queued** build just removes
it. Either way the job ends up with status `cancelled`, distinct from `failed`.

A local `./build` run has no server involved: stop it with Ctrl+C.

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
| `POST` | `/api/jobs/:jobId/cancel` | Stop one running or queued build |
| `POST` | `/api/jobs/cancel-all` | Stop everything running and queued |
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
| `BUILD_CONCURRENCY` | `2` | How many builds run at once, each in its own slot |
| `CONVERTER_URL` | `http://127.0.0.1:$PORT` | Service address used by the `jobs` CLI |
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
