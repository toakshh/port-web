# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- **Frontend static assets**: Located in `dist/` and bundled directly into Tauri app (`tauri.conf.json` -> `frontendDist: "../dist"`).
- **Environment variables required for builds**:
  ```bash
  export JAVA_HOME="$HOME/jdk"
  export ANDROID_HOME="$HOME/android-sdk"
  export NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"
  export PATH="$JAVA_HOME/bin:$HOME/.cargo/bin:$ANDROID_HOME/ndk/26.1.10909125/toolchains/llvm/prebuilt/linux-x86_64/bin:$PATH"
  ```
- **Android APK build command**:
  ```bash
  npx tauri android build --apk
  ```
- **Windows EXE build command**:
  ```bash
  npx tauri build --target x86_64-pc-windows-gnu
  ```

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
