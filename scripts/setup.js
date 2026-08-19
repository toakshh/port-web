#!/usr/bin/env node
'use strict';

/**
 * One-command environment setup.
 *
 *   ./setup            (macOS / Linux)
 *   setup.cmd          (Windows)
 *   npm run setup
 *
 * Installs and links everything needed to build Android APKs and desktop
 * binaries: npm packages, the Rust toolchain and cross targets, a JDK, the
 * Android SDK + NDK, platform build dependencies, and a debug keystore.
 *
 * Everything is installed to the location this project's toolchain detection
 * already looks in, so nothing has to be "linked" afterwards - no PATH edits,
 * no environment variables to export.
 *
 * Nothing is installed without saying so first. Run with --dry-run to see the
 * plan, or --yes to skip the confirmation prompt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const P = require('../lib/paths');
const fsx = require('../lib/fsx');
const tc = require('../lib/toolchain');
const { ensureDeps, runNpm } = require('../lib/ensure-deps');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

/* ------------------------------------------------------------------ *
 * Output helpers
 * ------------------------------------------------------------------ */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, msg) => (useColor ? `\x1b[${code}m${msg}\x1b[0m` : msg);
const heading = (msg) => console.log(`\n${paint(36, '==')} ${paint(1, msg)}`);
const info = (msg) => console.log(`   ${msg}`);
const ok = (msg) => console.log(`   ${paint(32, 'OK')}  ${msg}`);
const skip = (msg) => console.log(`   ${paint(90, '--')}  ${msg}`);
const warn = (msg) => console.log(`   ${paint(33, '!!')}  ${msg}`);
const fail = (msg) => console.log(`   ${paint(31, 'XX')}  ${msg}`);

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const ALL_STEPS = ['node', 'rust', 'jdk', 'android', 'platform', 'keystore'];

function printHelp() {
  console.log(`
Usage: setup [options]

Installs everything needed to build this project, on Windows, macOS or Linux.

Options:
  --yes, -y          Do not ask for confirmation (for CI / unattended runs)
  --dry-run          Show what would be installed and change nothing
  --skip <steps>     Comma-separated steps to skip
  --only <steps>     Comma-separated steps to run, ignoring the rest
  --desktop-only     Shorthand for --skip android,jdk,keystore
  --help, -h         Show this message

Steps:
  node       npm packages and the platform-specific Tauri CLI binary
  rust       Rust toolchain (rustup) and the cross-compilation targets
  jdk        JDK 17, required by the Android build
  android    Android SDK command-line tools, platform, build-tools and NDK
  platform   OS build dependencies (Linux webkit2gtk / mingw-w64 / NSIS)
  keystore   Debug keystore used to sign APKs

After it finishes, run "npm run doctor" to confirm what this host can build.
`);
}

const args = process.argv.slice(2);
const opts = { yes: false, dryRun: false, skip: new Set(), only: null };

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--yes' || arg === '-y') opts.yes = true;
  else if (arg === '--dry-run') opts.dryRun = true;
  else if (arg === '--desktop-only') ['android', 'jdk', 'keystore'].forEach((s) => opts.skip.add(s));
  else if (arg === '--skip') String(args[++i] || '').split(',').forEach((s) => s.trim() && opts.skip.add(s.trim()));
  else if (arg === '--only') opts.only = new Set(String(args[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
  else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unknown option: ${arg}`);
    printHelp();
    process.exit(2);
  }
}

const shouldRun = (step) => (opts.only ? opts.only.has(step) : !opts.skip.has(step));

/* ------------------------------------------------------------------ *
 * Package managers
 * ------------------------------------------------------------------ */

/** The system package manager, described as commands rather than a name. */
function detectPackageManager() {
  if (IS_WIN) {
    if (tc.which('winget')) return { name: 'winget', kind: 'winget' };
    if (tc.which('choco')) return { name: 'choco', kind: 'choco' };
    return null;
  }
  if (IS_MAC) {
    if (tc.which('brew')) return { name: 'homebrew', kind: 'brew' };
    return null;
  }
  for (const [bin, kind] of [
    ['apt-get', 'apt'],
    ['dnf', 'dnf'],
    ['pacman', 'pacman'],
    ['zypper', 'zypper'],
    ['apk', 'apk']
  ]) {
    if (tc.which(bin)) return { name: bin, kind };
  }
  return null;
}

const pm = detectPackageManager();

/** Prefix a command with sudo when we are not already root. */
function withSudo(argv) {
  if (IS_WIN || process.getuid === undefined || process.getuid() === 0) return argv;
  const sudo = tc.which('sudo');
  return sudo ? [sudo, ...argv] : argv;
}

function installSystemPackages(packages, { label }) {
  if (packages.length === 0) return true;
  if (!pm) {
    warn(`No supported package manager found - install manually: ${packages.join(' ')}`);
    return false;
  }

  const commands = {
    apt: () => [withSudo(['apt-get', 'update']), withSudo(['apt-get', 'install', '-y', ...packages])],
    dnf: () => [withSudo(['dnf', 'install', '-y', ...packages])],
    pacman: () => [withSudo(['pacman', '-Sy', '--noconfirm', ...packages])],
    zypper: () => [withSudo(['zypper', '--non-interactive', 'install', ...packages])],
    apk: () => [withSudo(['apk', 'add', '--no-cache', ...packages])],
    brew: () => [['brew', 'install', ...packages]],
    winget: () =>
      packages.map((pkg) => [
        'winget', 'install', '--id', pkg, '-e', '--silent',
        '--accept-source-agreements', '--accept-package-agreements'
      ]),
    choco: () => [['choco', 'install', '-y', ...packages]]
  };

  const list = (commands[pm.kind] || (() => []))();
  if (list.length === 0) {
    warn(`Do not know how to install with ${pm.name}: ${packages.join(' ')}`);
    return false;
  }

  info(`${label} via ${pm.name}: ${packages.join(', ')}`);
  if (opts.dryRun) return true;

  let allOk = true;
  for (const argv of list) {
    const res = tc.run(argv);
    // winget exits non-zero when a package is already installed; not an error.
    if (!res.ok && pm.kind !== 'winget') allOk = false;
  }
  return allOk;
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

const results = [];
const record = (step, status, detail) => results.push({ step, status, detail });

function stepNodePackages() {
  heading('npm packages');
  if (opts.dryRun) {
    info('would run: npm install, then repair the Tauri CLI native binding');
    return record('node', 'planned');
  }

  runNpm(['install']);
  ensureDeps(['express', 'cors', 'multer', 'adm-zip'], { optional: true });

  // npm's optional-dependency bug leaves the Tauri CLI without a native binary
  // whenever node_modules was first populated on a different OS.
  const argv = tc.ensureTauriCli({ log: info });
  const version = tc.runCapture([...argv, '--version']);
  if (version.ok) {
    ok(`Tauri CLI ready (${version.stdout.trim()})`);
    record('node', 'ok');
  } else {
    fail('Tauri CLI could not be prepared');
    record('node', 'failed', 'tauri cli');
  }
}

const RUST_TARGETS = {
  android: ['aarch64-linux-android', 'armv7-linux-androideabi', 'i686-linux-android', 'x86_64-linux-android'],
  windowsCross: ['x86_64-pc-windows-gnu']
};

function stepRust() {
  heading('Rust toolchain');

  if (tc.which('cargo')) {
    ok(`cargo already installed (${tc.which('cargo')})`);
  } else if (opts.dryRun) {
    info('would install Rust via rustup (https://rustup.rs)');
  } else {
    info('Installing Rust via rustup...');
    const res = tc.ensureRustToolchain({ autoInstall: true });
    if (!res.ok) {
      fail('Rust installation failed');
      if (res.hint) info(res.hint);
      return record('rust', 'failed', 'rustup');
    }
    tc.refreshPath();
    ok('Rust installed');
  }

  if (opts.dryRun) {
    info(`would add targets: ${RUST_TARGETS.android.join(', ')}`);
    return record('rust', 'planned');
  }

  // rustup lands in ~/.cargo/bin, which the running shell may not have on PATH.
  tc.refreshPath();
  if (!tc.which('rustup')) {
    warn('rustup is not on PATH yet - open a new terminal and re-run to add cross targets');
    return record('rust', 'partial', 'targets pending');
  }

  const wanted = shouldRun('android') ? [...RUST_TARGETS.android] : [];
  if (IS_LINUX || IS_MAC) wanted.push(...RUST_TARGETS.windowsCross);

  for (const target of wanted) {
    if (tc.ensureRustTarget(target)) ok(`target ${target}`);
    else warn(`could not add target ${target}`);
  }
  record('rust', 'ok');
}

function stepJdk() {
  heading('JDK 17');
  const existing = tc.detectJdk();
  if (existing) {
    ok(`JDK already installed (${existing})`);
    return record('jdk', 'ok');
  }

  const packages = {
    winget: ['EclipseAdoptium.Temurin.17.JDK'],
    choco: ['temurin17'],
    brew: ['temurin@17'],
    apt: ['openjdk-17-jdk'],
    dnf: ['java-17-openjdk-devel'],
    pacman: ['jdk17-openjdk'],
    zypper: ['java-17-openjdk-devel'],
    apk: ['openjdk17']
  }[pm && pm.kind] || [];

  if (packages.length === 0) {
    warn('Install JDK 17 manually: https://adoptium.net/temurin/releases/?version=17');
    return record('jdk', 'skipped', 'no package manager');
  }

  const installed = installSystemPackages(packages, { label: 'Installing JDK 17' });
  if (opts.dryRun) return record('jdk', 'planned');

  tc.refreshPath();
  const found = tc.detectJdk();
  if (found) {
    ok(`JDK ready (${found})`);
    record('jdk', 'ok');
  } else {
    warn(installed ? 'JDK installed but not detected yet - open a new terminal' : 'JDK installation failed');
    record('jdk', 'partial');
  }
}

const ANDROID = {
  cmdlineVersion: '11076708',
  platform: 'android-35',
  buildTools: '35.0.0',
  ndk: '27.1.12297006'
};

/** The OS-conventional SDK location, which toolchain.js already searches. */
function defaultSdkDir() {
  const home = os.homedir();
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Android', 'Sdk');
  if (IS_MAC) return path.join(home, 'Library', 'Android', 'sdk');
  return path.join(home, 'Android', 'Sdk');
}

async function download(url, destFile) {
  info(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fsx.ensureDir(path.dirname(destFile));
  fs.writeFileSync(destFile, buffer);
  info(`Downloaded ${(buffer.length / 1048576).toFixed(1)} MB`);
  return destFile;
}

/**
 * Everything the Android build actually needs, already present?
 *
 * An SDK installed through Android Studio has no `cmdline-tools` but is
 * otherwise complete. Fetching 130 MB of command-line tools to install packages
 * that already exist would be pure waste, so check the real requirements first.
 */
function androidRequirementsMet() {
  const env = tc.setupEnv({ quiet: true });
  const platforms = env.sdk ? path.join(env.sdk, 'platforms') : null;
  const missing = [
    !env.sdk && 'SDK',
    !env.ndk && 'NDK',
    !(platforms && fsx.isDir(platforms) && fs.readdirSync(platforms).length > 0) && 'a platform',
    !tc.which('zipalign') && 'zipalign',
    !tc.which('apksigner') && 'apksigner'
  ].filter(Boolean);
  return { met: missing.length === 0, missing, env };
}

async function stepAndroid() {
  heading('Android SDK and NDK');

  const current = androidRequirementsMet();
  if (current.met) {
    ok(`Android SDK complete (${current.env.sdk})`);
    ok(`NDK ${path.basename(current.env.ndk)}, zipalign and apksigner all present`);
    skip('Nothing to install');
    return record('android', 'ok');
  }

  let sdkDir = tc.detectAndroidSdk();
  if (sdkDir) {
    ok(`Android SDK found (${sdkDir})`);
    info(`Missing: ${current.missing.join(', ')}`);
  } else {
    sdkDir = defaultSdkDir();
    info(`No Android SDK found - installing to ${sdkDir}`);
  }

  const sdkManagerName = IS_WIN ? 'sdkmanager.bat' : 'sdkmanager';
  let sdkManager = path.join(sdkDir, 'cmdline-tools', 'latest', 'bin', sdkManagerName);

  if (!fsx.isFile(sdkManager)) {
    const osTag = IS_WIN ? 'win' : IS_MAC ? 'mac' : 'linux';
    const url = `https://dl.google.com/android/repository/commandlinetools-${osTag}-${ANDROID.cmdlineVersion}_latest.zip`;

    if (opts.dryRun) {
      info(`would download command-line tools to ${sdkDir}`);
    } else {
      try {
        const zipPath = path.join(os.tmpdir(), `android-cmdline-tools-${ANDROID.cmdlineVersion}.zip`);
        await download(url, zipPath);

        // The archive unpacks as cmdline-tools/; the SDK expects it at
        // cmdline-tools/latest/, which is what sdkmanager looks for.
        const staging = path.join(sdkDir, '.cmdline-staging');
        fsx.emptyDir(staging);
        fsx.safeExtractZip(require('adm-zip'), zipPath, staging);
        const inner = path.join(staging, 'cmdline-tools');
        const target = path.join(sdkDir, 'cmdline-tools', 'latest');
        fsx.rmrf(target);
        fsx.ensureDir(path.dirname(target));
        fs.renameSync(fsx.isDir(inner) ? inner : staging, target);
        fsx.rmrf(staging);
        fs.rmSync(zipPath, { force: true });

        if (!IS_WIN) {
          for (const file of fsx.walkFiles(path.join(target, 'bin'))) fs.chmodSync(file, 0o755);
        }
        ok(`Command-line tools installed to ${sdkDir}`);
      } catch (err) {
        fail(`Could not install the Android command-line tools: ${err.message}`);
        info(`Download them manually from https://developer.android.com/studio#command-tools into ${sdkDir}`);
        return record('android', 'failed', err.message);
      }
    }
    sdkManager = path.join(sdkDir, 'cmdline-tools', 'latest', 'bin', sdkManagerName);
  } else {
    ok('Command-line tools already present');
  }

  const packages = [
    'platform-tools',
    `platforms;${ANDROID.platform}`,
    `build-tools;${ANDROID.buildTools}`,
    `ndk;${ANDROID.ndk}`
  ];

  if (opts.dryRun) {
    info(`would accept licenses and install: ${packages.join(', ')}`);
    return record('android', 'planned');
  }

  process.env.ANDROID_HOME = sdkDir;
  process.env.ANDROID_SDK_ROOT = sdkDir;

  info('Accepting SDK licenses...');
  tc.runCapture([sdkManager, '--licenses'], { input: `${'y\n'.repeat(60)}` });

  info(`Installing: ${packages.join(', ')}`);
  const res = tc.run([sdkManager, ...packages]);
  if (!res.ok) {
    fail('sdkmanager reported an error - see the output above');
    return record('android', 'failed', 'sdkmanager');
  }

  tc.refreshPath();
  const env = tc.setupEnv({ quiet: true });
  const missing = [
    !env.sdk && 'SDK',
    !env.ndk && 'NDK',
    !tc.which('zipalign') && 'zipalign',
    !tc.which('apksigner') && 'apksigner'
  ].filter(Boolean);

  if (missing.length > 0) {
    warn(`Installed, but not detected yet: ${missing.join(', ')}. Open a new terminal and run "npm run doctor".`);
    return record('android', 'partial', missing.join(', '));
  }
  ok(`Android SDK ready (${env.sdk})`);
  ok(`Android NDK ready (${env.ndk})`);
  record('android', 'ok');
}

function stepPlatformDeps() {
  heading('Platform build dependencies');

  if (IS_MAC) {
    if (tc.which('xcodebuild') || tc.which('clang')) ok('Xcode command line tools present');
    else {
      info('Installing Xcode command line tools...');
      if (!opts.dryRun) tc.run(['xcode-select', '--install']);
    }
    return record('platform', 'ok');
  }

  if (IS_WIN) {
    // The MSVC linker comes from the Visual Studio Build Tools. Rustup prompts
    // for it during install; check rather than install it unattended.
    const hasLinker = tc.which('link') || fsx.isDir('C:\\Program Files (x86)\\Microsoft Visual Studio') ||
      fsx.isDir('C:\\Program Files\\Microsoft Visual Studio');
    if (hasLinker) ok('Visual Studio build tools present');
    else {
      warn('MSVC build tools not detected. Rust needs them to link Windows binaries.');
      info('Install with: winget install Microsoft.VisualStudio.2022.BuildTools');
    }
    return record('platform', hasLinker ? 'ok' : 'partial');
  }

  // Linux: Tauri's webview stack, plus the Windows cross-compilation toolchain.
  const packages = {
    apt: [
      'build-essential', 'curl', 'wget', 'file', 'pkg-config', 'libssl-dev',
      'libwebkit2gtk-4.1-dev', 'libgtk-3-dev', 'libayatana-appindicator3-dev',
      'librsvg2-dev', 'libsoup-3.0-dev', 'unzip', 'zip',
      'mingw-w64', 'nsis'
    ],
    dnf: [
      'gcc', 'gcc-c++', 'make', 'openssl-devel', 'webkit2gtk4.1-devel',
      'gtk3-devel', 'libappindicator-gtk3-devel', 'librsvg2-devel',
      'unzip', 'zip', 'mingw64-gcc', 'mingw64-winpthreads-static'
    ],
    pacman: [
      'base-devel', 'openssl', 'webkit2gtk-4.1', 'gtk3',
      'libappindicator-gtk3', 'librsvg', 'unzip', 'zip', 'mingw-w64-gcc', 'nsis'
    ],
    zypper: ['gcc', 'gcc-c++', 'make', 'libopenssl-devel', 'webkit2gtk3-devel', 'gtk3-devel', 'unzip', 'zip'],
    apk: ['build-base', 'openssl-dev', 'webkit2gtk-dev', 'gtk+3.0-dev', 'unzip', 'zip']
  }[pm && pm.kind] || [];

  if (packages.length === 0) {
    warn('Unknown Linux distribution - install the Tauri Linux prerequisites manually:');
    info('https://tauri.app/start/prerequisites/');
    return record('platform', 'skipped');
  }

  const installed = installSystemPackages(packages, { label: 'Installing build dependencies' });
  record('platform', opts.dryRun ? 'planned' : installed ? 'ok' : 'partial');
}

function stepKeystore() {
  heading('Android debug keystore');
  const keystore = path.join(os.homedir(), '.android', 'debug.keystore');

  if (fsx.isFile(keystore)) {
    ok(`Debug keystore already present (${keystore})`);
    return record('keystore', 'ok');
  }
  if (opts.dryRun) {
    info(`would create ${keystore}`);
    return record('keystore', 'planned');
  }

  tc.refreshPath();
  const keytool = tc.which('keytool');
  if (!keytool) {
    warn('keytool not found (it ships with the JDK) - re-run setup after the JDK is on PATH');
    return record('keystore', 'skipped', 'no keytool');
  }

  fsx.ensureDir(path.dirname(keystore));
  const res = tc.run([
    keytool, '-genkeypair', '-v',
    '-keystore', keystore,
    '-storepass', 'android',
    '-alias', 'androiddebugkey',
    '-keypass', 'android',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-dname', 'CN=Android Debug,O=Android,C=US'
  ]);

  if (res.ok && fsx.isFile(keystore)) {
    ok(`Created ${keystore}`);
    record('keystore', 'ok');
  } else {
    fail('Could not create the debug keystore');
    record('keystore', 'failed');
  }
}

/* ------------------------------------------------------------------ *
 * Plan and confirmation
 * ------------------------------------------------------------------ */

function describePlan() {
  const planned = ALL_STEPS.filter(shouldRun);
  console.log(`Project : ${P.ROOT}`);
  console.log(`Host    : ${process.platform}-${process.arch}, node ${process.version}`);
  console.log(`Packages: ${pm ? pm.name : paint(33, 'none detected')}`);
  console.log('');
  console.log('This will install, where missing:');
  const described = {
    node: 'npm packages and the Tauri CLI binary for this platform',
    rust: 'the Rust toolchain and cross-compilation targets',
    jdk: 'JDK 17 (needed for Android)',
    android: `Android SDK ${ANDROID.platform}, build-tools ${ANDROID.buildTools}, NDK ${ANDROID.ndk}`,
    platform: IS_LINUX ? 'Linux webview dependencies, mingw-w64 and NSIS' : 'OS build dependencies',
    keystore: 'a debug keystore for signing APKs'
  };
  for (const step of planned) console.log(`  - ${paint(1, step.padEnd(9))} ${described[step]}`);
  if (planned.length !== ALL_STEPS.length) {
    console.log(`  ${paint(90, `(skipping: ${ALL_STEPS.filter((s) => !shouldRun(s)).join(', ')})`)}`);
  }
  if (IS_LINUX || IS_MAC) console.log(`\n${paint(90, 'System packages are installed with sudo where required.')}`);
  return planned;
}

function confirm(question) {
  if (opts.yes || opts.dryRun) return Promise.resolve(true);
  if (!process.stdin.isTTY) {
    console.log('\nNot an interactive terminal - re-run with --yes to proceed.');
    return Promise.resolve(false);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

(async () => {
  console.log(paint(1, '\nWeb-to-App converter - environment setup\n'));

  // Detect what is already installed before reporting the plan: tools live in
  // OS-conventional locations that the current shell may not have on PATH, and
  // reporting them as missing would be wrong.
  tc.setupEnv({ quiet: true });

  const planned = describePlan();
  if (planned.length === 0) {
    console.log('\nNothing selected. See --help.');
    process.exit(0);
  }

  if (!(await confirm('Proceed?'))) {
    console.log('Cancelled. Nothing was changed.');
    process.exit(0);
  }
  if (opts.dryRun) console.log(paint(33, '\n(dry run - nothing will be installed)'));

  const steps = {
    node: stepNodePackages,
    rust: stepRust,
    jdk: stepJdk,
    android: stepAndroid,
    platform: stepPlatformDeps,
    keystore: stepKeystore
  };

  for (const step of planned) {
    try {
      await steps[step]();
    } catch (err) {
      fail(`${step} failed: ${err.message}`);
      record(step, 'failed', err.message);
    }
  }

  heading('Summary');
  const symbols = { ok: paint(32, 'OK'), planned: paint(90, '--'), partial: paint(33, '~~'), skipped: paint(90, '--'), failed: paint(31, 'XX') };
  for (const { step, status, detail } of results) {
    console.log(`   ${symbols[status] || status}  ${step.padEnd(9)} ${status}${detail ? ` (${detail})` : ''}`);
  }

  if (opts.dryRun) {
    console.log('\nDry run complete. Re-run without --dry-run to install.');
    process.exit(0);
  }

  console.log('\nVerifying with "npm run doctor"...\n');
  const doctor = tc.run([process.execPath, path.join(P.ROOT, 'scripts', 'doctor.js')]);

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    console.log(paint(33, `\n${failed.length} step(s) did not complete: ${failed.map((f) => f.step).join(', ')}`));
    console.log('Fix those, then re-run setup - completed steps are skipped automatically.');
  } else if (!doctor.ok) {
    console.log(paint(33, '\nSome tools are still missing. If they were just installed, open a new'));
    console.log(paint(33, 'terminal so PATH picks them up, then run "npm run doctor" again.'));
  } else {
    console.log(paint(32, '\nReady. Try:  npm start      (converter service on http://localhost:3000)'));
    console.log(paint(32, '             ./build --exe  (build from the command line)'));
  }

  process.exit(failed.length > 0 ? 1 : 0);
})();
