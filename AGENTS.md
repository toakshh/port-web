# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- **Cloud Web-to-App Converter Service**: Run `node server.js` or `npm start` (port 3000). Provides `POST /api/convert`, `GET /api/download/:jobId`, `GET /api/health`, and dashboard UI served at `GET /`.
- **Unified multi-platform build pipeline**: Run `./build` or `npm run build -- <args>`.
  - `./build --android` : Builds signed Android APK at `dist-builds/android/tripo-app-signed.apk`.
  - `./build --exe` : Builds Windows `.exe` executable & installer at `dist-builds/windows/`.
  - `./build --mac` : Builds macOS app bundle & `.dmg` at `dist-builds/mac/`.
  - `./build --ios` : Builds iOS app package at `dist-builds/ios/`.
  - `./build --all` : Sequentially builds all platform targets.
  - Options: `--name "<Custom App Name>"`, `--logo "<path/to/icon.png>"`, `--identifier "<com.custom.app>"`.
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
