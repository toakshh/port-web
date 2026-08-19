# Cloud image for the Web-to-App converter.
#
# Builds Android APKs and cross-compiles Windows .exe installers. macOS and iOS
# targets are impossible in a Linux container (Apple toolchains are required)
# and the service reports them as unavailable via /api/health.
#
#   docker build -t tripo-converter .
#   docker run -p 3000:3000 -v tripo-cache:/app/src-tauri/target tripo-converter
#
# Mounting a volume on src-tauri/target is what makes Fast mode fast across
# container restarts: it is the incremental Rust compilation cache.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH

# --- Base toolchain -------------------------------------------------------
# Tauri's Linux build needs webkit2gtk/libsoup; mingw-w64 + nsis provide the
# Windows cross-compilation and installer generation.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip zip xz-utils file pkg-config build-essential \
      openjdk-17-jdk-headless \
      libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
      libgtk-3-dev libsoup-3.0-dev \
      mingw-w64 nsis \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js --------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- Rust + the targets the pipeline needs --------------------------------
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --default-toolchain stable \
    && rustup target add \
        x86_64-pc-windows-gnu \
        aarch64-linux-android armv7-linux-androideabi \
        i686-linux-android x86_64-linux-android

# --- Android SDK + NDK ----------------------------------------------------
ARG ANDROID_CMDLINE_VERSION=11076708
ARG ANDROID_PLATFORM=android-35
ARG ANDROID_BUILD_TOOLS=35.0.0
ARG ANDROID_NDK=27.1.12297006

RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && curl -fsSL -o /tmp/cmdline-tools.zip \
        "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_VERSION}_latest.zip" \
    && unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools" \
    && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
    && rm /tmp/cmdline-tools.zip \
    && yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null \
    && "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
        "platform-tools" \
        "platforms;${ANDROID_PLATFORM}" \
        "build-tools;${ANDROID_BUILD_TOOLS}" \
        "ndk;${ANDROID_NDK}" > /dev/null

ENV NDK_HOME=/opt/android-sdk/ndk/${ANDROID_NDK} \
    ANDROID_NDK_HOME=/opt/android-sdk/ndk/${ANDROID_NDK} \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/${ANDROID_BUILD_TOOLS}:$PATH

# --- Application ----------------------------------------------------------
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .

# Warm the debug keystore so the first Android job does not have to create it.
RUN mkdir -p /root/.android \
    && keytool -genkeypair -v -keystore /root/.android/debug.keystore \
        -storepass android -alias androiddebugkey -keypass android \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=Android Debug,O=Android,C=US" > /dev/null

ENV PORT=3000 \
    HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
