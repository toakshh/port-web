'use strict';

/**
 * OS-agnostic toolchain discovery.
 *
 * Nothing in here is hard-coded to a machine, a user name or a distro: every
 * location is either taken from the environment, derived from `os.homedir()`,
 * or found by scanning `PATH`. The same file therefore works on a developer's
 * Windows box, a macOS laptop, a Linux CI runner and a Docker image.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { ensureDeps, isInstalled } = require('./ensure-deps');
const { ROOT } = require('./paths');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const EXE = IS_WIN ? '.exe' : '';

/* ------------------------------------------------------------------ *
 * Small process helpers (argv arrays - safe with spaces in paths)
 * ------------------------------------------------------------------ */

/**
 * Prepare an argv array for spawnSync.
 *
 * Node refuses to spawn `.bat`/`.cmd` files directly (the CVE-2024-27980
 * hardening), which matters here because several Android SDK entry points are
 * batch wrappers on Windows - `apksigner.bat` and `sdkmanager.bat` among them.
 * Routing those through cmd.exe with verbatim arguments keeps paths containing
 * spaces intact without enabling shell interpolation on the arguments.
 */
function prepareSpawn(argv) {
  const [cmd, ...args] = argv;
  if (!IS_WIN || !/\.(bat|cmd)$/i.test(cmd)) return { file: cmd, args, extra: {} };

  const quote = (value) => `"${String(value).split('"').join('""')}"`;
  const line = [cmd, ...args].map(quote).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    // /s + the surrounding quotes make cmd treat the whole line as one command.
    args: ['/d', '/s', '/c', `"${line}"`],
    extra: { windowsVerbatimArguments: true }
  };
}

function run(argv, opts = {}) {
  const { file, args, extra } = prepareSpawn(argv);
  const res = spawnSync(file, args, {
    stdio: 'inherit',
    env: process.env,
    cwd: opts.cwd || ROOT,
    shell: false,
    ...extra,
    ...opts
  });
  if (res.error && res.error.code === 'ENOENT') {
    return { ok: false, status: 127, error: res.error };
  }
  return { ok: res.status === 0, status: res.status, error: res.error };
}

function runCapture(argv, opts = {}) {
  const { file, args, extra } = prepareSpawn(argv);
  const res = spawnSync(file, args, {
    encoding: 'utf8',
    env: process.env,
    cwd: opts.cwd || ROOT,
    shell: false,
    ...extra,
    ...opts
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || ''
  };
}

/* ------------------------------------------------------------------ *
 * PATH lookup
 * ------------------------------------------------------------------ */

function pathExtensions() {
  if (!IS_WIN) return [''];
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return ['', ...raw.split(';').filter(Boolean).map((e) => e.toLowerCase())];
}

/** Cross-platform `which` that does not depend on a shell being present. */
function which(command) {
  if (!command) return null;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of pathExtensions()) {
      const candidate = path.join(dir, command + ext);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch (_) {
        /* keep looking */
      }
    }
  }
  return null;
}

function existingDir(p) {
  try {
    return p && fs.statSync(p).isDirectory() ? p : null;
  } catch (_) {
    return null;
  }
}

function childDirs(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => path.join(parent, e.name));
  } catch (_) {
    return [];
  }
}

/** Newest-first sort for version-like directory names (26.1.1 > 9.0.0). */
function byVersionDesc(a, b) {
  const parse = (s) => (path.basename(s).match(/\d+/g) || []).map(Number);
  const va = parse(a);
  const vb = parse(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const diff = (vb[i] || 0) - (va[i] || 0);
    if (diff !== 0) return diff;
  }
  return path.basename(b).localeCompare(path.basename(a));
}

/* ------------------------------------------------------------------ *
 * JDK
 * ------------------------------------------------------------------ */

function isJdk(dir) {
  return !!(dir && fs.existsSync(path.join(dir, 'bin', `javac${EXE}`)));
}

function detectJdk() {
  const home = os.homedir();
  const candidates = [];

  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);

  // Derive from javac/java already on PATH (…/bin/javac -> …).
  for (const bin of ['javac', 'java']) {
    const found = which(bin);
    if (found) {
      try {
        candidates.push(path.dirname(path.dirname(fs.realpathSync(found))));
      } catch (_) {
        candidates.push(path.dirname(path.dirname(found)));
      }
    }
  }

  candidates.push(path.join(home, 'jdk'));

  if (IS_WIN) {
    const programFiles = [
      process.env.ProgramFiles || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs')
    ];
    for (const base of programFiles) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft']) {
        candidates.push(...childDirs(path.join(base, vendor)).sort(byVersionDesc));
      }
      candidates.push(path.join(base, 'Android', 'Android Studio', 'jbr'));
    }
  } else if (IS_MAC) {
    for (const base of [
      '/Library/Java/JavaVirtualMachines',
      path.join(home, 'Library', 'Java', 'JavaVirtualMachines')
    ]) {
      candidates.push(...childDirs(base).sort(byVersionDesc).map((d) => path.join(d, 'Contents', 'Home')));
    }
    candidates.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
    const javaHomeTool = runCapture(['/usr/libexec/java_home']);
    if (javaHomeTool.ok) candidates.push(javaHomeTool.stdout.trim());
  } else {
    candidates.push(...childDirs('/usr/lib/jvm').sort(byVersionDesc));
    candidates.push(...childDirs('/usr/java').sort(byVersionDesc));
    candidates.push('/opt/java/openjdk', '/opt/android-studio/jbr');
  }

  return candidates.find(isJdk) || null;
}

/* ------------------------------------------------------------------ *
 * Android SDK / NDK
 * ------------------------------------------------------------------ */

function isAndroidSdk(dir) {
  if (!existingDir(dir)) return false;
  return ['platform-tools', 'cmdline-tools', 'build-tools', 'platforms'].some((sub) =>
    fs.existsSync(path.join(dir, sub))
  );
}

function detectAndroidSdk() {
  const home = os.homedir();
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    IS_WIN ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Android', 'Sdk') : null,
    IS_MAC ? path.join(home, 'Library', 'Android', 'sdk') : null,
    path.join(home, 'Android', 'Sdk'),
    path.join(home, 'android-sdk'),
    '/usr/lib/android-sdk',
    '/opt/android-sdk',
    '/usr/local/lib/android/sdk' // GitHub Actions runners
  ].filter(Boolean);

  return candidates.find(isAndroidSdk) || null;
}

function detectNdk(sdkDir) {
  const explicit = [process.env.NDK_HOME, process.env.ANDROID_NDK_HOME, process.env.ANDROID_NDK_ROOT]
    .filter(Boolean)
    .find(existingDir);
  if (explicit) return explicit;
  if (!sdkDir) return null;

  const versioned = childDirs(path.join(sdkDir, 'ndk')).sort(byVersionDesc);
  if (versioned.length > 0) return versioned[0];
  return existingDir(path.join(sdkDir, 'ndk-bundle'));
}

function ndkToolchainBin(ndkDir) {
  if (!ndkDir) return null;
  const prebuilt = path.join(ndkDir, 'toolchains', 'llvm', 'prebuilt');
  // The host tag differs per OS (linux-x86_64 / darwin-x86_64 / windows-x86_64).
  const hosts = childDirs(prebuilt);
  for (const host of hosts) {
    const bin = path.join(host, 'bin');
    if (existingDir(bin)) return bin;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Rust / Cargo
 * ------------------------------------------------------------------ */

function detectCargoBin() {
  const home = os.homedir();
  const candidates = [
    process.env.CARGO_HOME ? path.join(process.env.CARGO_HOME, 'bin') : null,
    path.join(home, '.cargo', 'bin'),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.cargo', 'bin') : null,
    '/usr/local/cargo/bin',
    '/opt/rust/bin'
  ].filter(Boolean);

  const found = candidates.find((dir) => fs.existsSync(path.join(dir, `cargo${EXE}`)));
  if (found) return found;

  const onPath = which('cargo');
  return onPath ? path.dirname(onPath) : null;
}

/**
 * Install the Rust toolchain when it is missing.
 * Downloading and executing a remote installer is only done when the operator
 * opts in with AUTO_INSTALL_TOOLCHAIN=1; otherwise we report exactly what to run.
 */
function ensureRustToolchain({ autoInstall = process.env.AUTO_INSTALL_TOOLCHAIN === '1' } = {}) {
  if (which('cargo')) return { ok: true, installed: false };
  if (!autoInstall) {
    return {
      ok: false,
      installed: false,
      hint: IS_WIN
        ? 'Rust is required. Install it from https://rustup.rs (or run: winget install Rustlang.Rustup), then restart the server.'
        : 'Rust is required. Install it with: curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y'
    };
  }

  if (IS_WIN) {
    const winget = which('winget');
    if (winget) {
      run([winget, 'install', '--id', 'Rustlang.Rustup', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements']);
    }
  } else {
    const sh = which('sh');
    const curl = which('curl');
    if (sh && curl) {
      const res = runCapture([curl, '--proto', '=https', '--tlsv1.2', '-sSf', 'https://sh.rustup.rs']);
      if (res.ok) {
        const script = path.join(os.tmpdir(), 'rustup-init.sh');
        fs.writeFileSync(script, res.stdout, { mode: 0o700 });
        run([sh, script, '-s', '--', '-y', '--no-modify-path']);
        fs.rmSync(script, { force: true });
      }
    }
  }

  refreshPath();
  return { ok: !!which('cargo'), installed: !!which('cargo') };
}

/** Add a Rust target triple if `rustup` does not already have it. */
function ensureRustTarget(target) {
  const rustup = which('rustup');
  if (!rustup) return false;
  const listed = runCapture([rustup, 'target', 'list', '--installed']);
  if (listed.ok && listed.stdout.split(/\r?\n/).map((l) => l.trim()).includes(target)) {
    return true;
  }
  return run([rustup, 'target', 'add', target]).ok;
}

/* ------------------------------------------------------------------ *
 * Tauri CLI (with automatic native-binding repair)
 * ------------------------------------------------------------------ */

function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    const report = process.report.getReport();
    return !report.header.glibcVersionRuntime;
  } catch (_) {
    return false;
  }
}

/** The platform-specific package that ships the Tauri CLI native binary. */
function tauriNativePackage() {
  const key = `${process.platform}-${process.arch}`;
  const libc = isMusl() ? 'musl' : 'gnu';
  const map = {
    'win32-x64': 'cli-win32-x64-msvc',
    'win32-arm64': 'cli-win32-arm64-msvc',
    'win32-ia32': 'cli-win32-ia32-msvc',
    'darwin-x64': 'cli-darwin-x64',
    'darwin-arm64': 'cli-darwin-arm64',
    'linux-x64': `cli-linux-x64-${libc}`,
    'linux-arm64': `cli-linux-arm64-${libc}`,
    'linux-arm': 'cli-linux-arm-gnueabihf',
    'linux-riscv64': `cli-linux-riscv64-${libc}`,
    'freebsd-x64': 'cli-freebsd-x64'
  };
  return map[key] ? `@tauri-apps/${map[key]}` : null;
}

let cachedTauriArgv = null;

/**
 * Return an argv prefix that invokes the Tauri CLI, installing the CLI and its
 * platform-specific native binding on demand.
 *
 * This is what makes a repo cloned on Linux work when `node_modules` was
 * populated on Windows (and vice versa) - npm's optional-dependency bug leaves
 * only the *other* platform's binary behind, which is the exact failure this
 * project was hitting.
 */
function ensureTauriCli({ log = console.log } = {}) {
  if (cachedTauriArgv) return cachedTauriArgv;

  const cliEntry = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const works = () => runCapture([process.execPath, cliEntry, '--version']).ok;

  if (!isInstalled('@tauri-apps/cli')) {
    log('Tauri CLI not installed - installing...');
    ensureDeps(['@tauri-apps/cli'], { optional: true });
  }

  if (fs.existsSync(cliEntry) && works()) {
    cachedTauriArgv = [process.execPath, cliEntry];
    return cachedTauriArgv;
  }

  const nativePkg = tauriNativePackage();
  if (nativePkg) {
    log(`Tauri CLI native binding missing for ${process.platform}-${process.arch}; installing ${nativePkg}...`);
    ensureDeps([nativePkg], { optional: true });
    if (fs.existsSync(cliEntry) && works()) {
      cachedTauriArgv = [process.execPath, cliEntry];
      return cachedTauriArgv;
    }
  }

  // Last resort: let npx resolve a matching CLI build for this platform.
  const npx = which(IS_WIN ? 'npx.cmd' : 'npx') || (IS_WIN ? 'npx.cmd' : 'npx');
  log('Falling back to "npx @tauri-apps/cli" for this platform.');
  cachedTauriArgv = [npx, '--yes', '@tauri-apps/cli'];
  return cachedTauriArgv;
}

/* ------------------------------------------------------------------ *
 * Environment assembly
 * ------------------------------------------------------------------ */

let envReady = null;

function prependPath(dirs) {
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const additions = dirs.filter((d) => d && existingDir(d) && !current.includes(d));
  if (additions.length > 0) {
    process.env.PATH = [...additions, ...current].join(path.delimiter);
  }
  return additions;
}

function refreshPath() {
  envReady = null;
  return setupEnv({ quiet: true });
}

/**
 * Discover and export JAVA_HOME / ANDROID_HOME / NDK_HOME and extend PATH.
 * Idempotent - safe to call from both the server and the build script.
 */
function setupEnv({ quiet = false, log = console.log } = {}) {
  if (envReady) return envReady;

  const jdk = detectJdk();
  if (jdk) process.env.JAVA_HOME = jdk;

  const sdk = detectAndroidSdk();
  if (sdk) {
    process.env.ANDROID_HOME = sdk;
    process.env.ANDROID_SDK_ROOT = sdk;
  }

  const ndk = detectNdk(sdk);
  if (ndk) {
    process.env.NDK_HOME = ndk;
    process.env.ANDROID_NDK_HOME = ndk;
    process.env.ANDROID_NDK_ROOT = ndk;
  }

  const cargoBin = detectCargoBin();

  const dirs = [];
  if (cargoBin) dirs.push(cargoBin);
  if (jdk) dirs.push(path.join(jdk, 'bin'));
  if (sdk) {
    // Newest build-tools first: that is where zipalign/apksigner live.
    dirs.push(...childDirs(path.join(sdk, 'build-tools')).sort(byVersionDesc));
    dirs.push(path.join(sdk, 'platform-tools'));
    dirs.push(path.join(sdk, 'cmdline-tools', 'latest', 'bin'));
    dirs.push(path.join(sdk, 'tools', 'bin'));
  }
  const ndkBin = ndkToolchainBin(ndk);
  if (ndkBin) dirs.push(ndkBin);

  prependPath(dirs);

  envReady = {
    jdk,
    sdk,
    ndk,
    cargoBin,
    cargo: which('cargo'),
    rustup: which('rustup'),
    zipalign: which('zipalign'),
    apksigner: which('apksigner'),
    keytool: which('keytool'),
    java: which('java')
  };

  if (!quiet) {
    log(`JAVA_HOME    : ${jdk || '(not found)'}`);
    log(`ANDROID_HOME : ${sdk || '(not found)'}`);
    log(`NDK_HOME     : ${ndk || '(not found)'}`);
    log(`cargo        : ${envReady.cargo || '(not found)'}`);
  }

  return envReady;
}

/** Snapshot of what this host can actually build - used by /api/health. */
function capabilities() {
  const env = setupEnv({ quiet: true });
  const hasRust = !!env.cargo;
  return {
    android: hasRust && !!env.jdk && !!env.sdk && !!env.ndk,
    windows: hasRust && (IS_WIN || !!which('x86_64-w64-mingw32-gcc')),
    mac: hasRust && IS_MAC,
    ios: hasRust && IS_MAC && !!which('xcodebuild'),
    details: {
      rust: env.cargo || null,
      rustup: env.rustup || null,
      jdk: env.jdk || null,
      androidSdk: env.sdk || null,
      androidNdk: env.ndk || null,
      zipalign: env.zipalign || null,
      apksigner: env.apksigner || null,
      keytool: env.keytool || null
    }
  };
}

module.exports = {
  IS_WIN,
  IS_MAC,
  EXE,
  run,
  runCapture,
  which,
  existingDir,
  childDirs,
  byVersionDesc,
  detectJdk,
  detectAndroidSdk,
  detectNdk,
  detectCargoBin,
  ensureRustToolchain,
  ensureRustTarget,
  tauriNativePackage,
  ensureTauriCli,
  setupEnv,
  refreshPath,
  capabilities
};
