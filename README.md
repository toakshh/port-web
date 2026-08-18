# TRipo Tauri Application

This repository contains the Tauri v2 desktop and mobile wrapper for the TRipo 3D web application.

## Project Overview

- **App Identifier**: `com.tripo.app`
- **App Title**: `TRipo`
- **Frontend Assets**: Located in `dist/` (ported from `/home/akshh16/TRipo_test/`)
- **Tauri Core**: `src-tauri/`

---

## Toolchain Setup

### Environment Variables

Ensure the following environment variables are exported before running builds:

```bash
export JAVA_HOME="$HOME/jdk"
export ANDROID_HOME="$HOME/android-sdk"
export NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"
export PATH="$JAVA_HOME/bin:$HOME/.cargo/bin:$ANDROID_HOME/ndk/26.1.10909125/toolchains/llvm/prebuilt/linux-x86_64/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

### Installed Prerequisites

1. **Rust & Cargo**: Rust toolchain with targets:
   - `x86_64-pc-windows-gnu`
   - `x86_64-pc-windows-msvc`
   - `aarch64-linux-android`
   - `armv7-linux-androideabi`
   - `i686-linux-android`
   - `x86_64-linux-android`
2. **JDK**: OpenJDK 17 (`$HOME/jdk`)
3. **Android SDK & NDK**: Installed in `$HOME/android-sdk` with NDK version `26.1.10909125`
4. **Windows Cross-Compiler**: `mingw-w64`, `nsis`, and `cargo-xwin`

---

## Build Instructions

### 1. Build Android APK (`.apk`)

To initialize (if not already done):
```bash
npx tauri android init
```

To compile the Android APK:
```bash
npx tauri android build --apk
```

**Artifact Path**:
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`

---

### 2. Build Windows Executable (`.exe`)

#### Option A: GNU Target (via MinGW-w64 & NSIS)
```bash
npx tauri build --target x86_64-pc-windows-gnu
```

**Artifact Paths**:
- Binary: `src-tauri/target/x86_64-pc-windows-gnu/release/app.exe`
- Installer: `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/tripo_0.1.0_x64-setup.exe`

#### Option B: MSVC Target (via cargo-xwin)
```bash
npx tauri build --target x86_64-pc-windows-msvc --runner cargo-xwin
```

**Artifact Path**:
- Binary: `src-tauri/target/x86_64-pc-windows-msvc/release/app.exe`

---

## Verification & Testing

- `dist/index.html` uses relative asset URLs (`./favicon.png`, `./static/...`, `./manifest.json`, `./basis/`, `./draco/`) which resolve correctly under Tauri webview protocols (`tauri://localhost` / `http://tauri.localhost`).
- Both Android `.apk` and Windows `.exe` builds complete with zero compilation or bundling errors.
