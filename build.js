#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Terminal log styling
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const rootDir = process.cwd();

function log(msg) {
  console.log(`${colors.cyan}[BUILD]${colors.reset} ${msg}`);
}

function logSuccess(msg) {
  console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`);
}

function logWarn(msg) {
  console.log(`${colors.yellow}[WARNING]${colors.reset} ${msg}`);
}

function logError(msg) {
  console.error(`${colors.red}[ERROR]${colors.reset} ${msg}`);
}

function runCmd(cmd, opts = {}) {
  log(`Executing: ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', env: process.env, cwd: rootDir, ...opts });
    return true;
  } catch (err) {
    if (opts.allowFailure) {
      logWarn(`Command failed (handled): ${cmd}`);
      return false;
    }
    logError(`Command failed with exit code ${err.status}: ${cmd}`);
    throw err;
  }
}

// 1. Setup Environment Variables
const homeDir = os.homedir();
const isWin = os.platform() === 'win32';

// Detect Cargo binary paths across Windows and Linux, creating WSL shim fallback if needed
function ensureCargoEnv() {
  const candidates = [
    process.env.CARGO_HOME ? path.join(process.env.CARGO_HOME, 'bin') : null,
    path.join(homeDir, '.cargo', 'bin'),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.cargo', 'bin') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, '.cargo', 'bin') : null,
    '/home/akshh16/.cargo/bin',
    '/root/.cargo/bin',
    'C:\\Users\\Aksh\\.cargo\\bin',
    'C:\\.cargo\\bin',
    'C:\\Program Files\\Rust\\bin'
  ].filter(Boolean);

  const extraPaths = [];
  for (const p of candidates) {
    if (fs.existsSync(p) && !extraPaths.includes(p)) {
      extraPaths.push(p);
    }
  }

  let cargoFound = false;
  try {
    const tempEnv = { ...process.env, PATH: [...extraPaths, process.env.PATH || ''].join(path.delimiter) };
    const checkCmd = isWin ? 'where cargo' : 'which cargo';
    const foundCargo = execSync(checkCmd, { encoding: 'utf8', env: tempEnv }).trim().split(/[\r\n]+/)[0];
    if (foundCargo && fs.existsSync(foundCargo)) {
      cargoFound = true;
      const cargoBinDir = path.dirname(foundCargo.trim());
      if (!extraPaths.includes(cargoBinDir)) {
        extraPaths.push(cargoBinDir);
      }
    }
  } catch (_) {}

  // If executing natively on Windows and cargo is missing, auto-create WSL bridge shim
  if (isWin && !cargoFound) {
    try {
      execSync('wsl cargo --version', { stdio: 'ignore' });
      const shimDir = path.join(__dirname, '.cargo-wsl-shim');
      if (!fs.existsSync(shimDir)) {
        fs.mkdirSync(shimDir, { recursive: true });
      }
      fs.writeFileSync(path.join(shimDir, 'cargo.cmd'), '@echo off\r\nwsl.exe --cd "%CD%" cargo %*\r\n');
      fs.writeFileSync(path.join(shimDir, 'rustc.cmd'), '@echo off\r\nwsl.exe --cd "%CD%" rustc %*\r\n');
      fs.writeFileSync(path.join(shimDir, 'rustup.cmd'), '@echo off\r\nwsl.exe --cd "%CD%" rustup %*\r\n');
      if (!extraPaths.includes(shimDir)) {
        extraPaths.unshift(shimDir);
      }
      console.log('[ENV] Created WSL Cargo bridge shim with directory mapping.');
    } catch (_) {}
  }

  return extraPaths;
}

// Detect JDK and Android SDK paths across Linux / Windows
const JDK_DIR = process.env.JAVA_HOME || (isWin ? path.join(homeDir, 'jdk') : '/home/akshh16/jdk');
const ANDROID_SDK_DIR = process.env.ANDROID_HOME || (isWin ? path.join(homeDir, 'AppData', 'Local', 'Android', 'Sdk') : '/home/akshh16/android-sdk');

if (!process.env.JAVA_HOME && fs.existsSync(JDK_DIR)) {
  process.env.JAVA_HOME = JDK_DIR;
}
if (!process.env.ANDROID_HOME && fs.existsSync(ANDROID_SDK_DIR)) {
  process.env.ANDROID_HOME = ANDROID_SDK_DIR;
}

const extraPaths = ensureCargoEnv();

if (process.env.JAVA_HOME) {
  extraPaths.push(path.join(process.env.JAVA_HOME, 'bin'));
}
if (process.env.ANDROID_HOME) {
  const buildToolsDir = path.join(process.env.ANDROID_HOME, 'build-tools');
  if (fs.existsSync(buildToolsDir)) {
    try {
      const versions = fs.readdirSync(buildToolsDir).sort().reverse();
      for (const ver of versions) {
        extraPaths.push(path.join(buildToolsDir, ver));
      }
    } catch (_) {}
  }
  extraPaths.push(path.join(process.env.ANDROID_HOME, 'platform-tools'));
  extraPaths.push(path.join(process.env.ANDROID_HOME, 'cmdline-tools', 'latest', 'bin'));
}

process.env.PATH = [...extraPaths, process.env.PATH].join(path.delimiter);

// 2. Parse CLI Arguments
const args = process.argv.slice(2);

let buildAndroid = false;
let buildExe = false;
let buildMac = false;
let buildIos = false;
let buildAll = false;
let isClean = false;
let isFast = false;

let customName = null;
let customLogo = null;
let customIdentifier = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--android') buildAndroid = true;
  else if (arg === '--exe') buildExe = true;
  else if (arg === '--mac') buildMac = true;
  else if (arg === '--ios') buildIos = true;
  else if (arg === '--all') buildAll = true;
  else if (arg === '--clean') isClean = true;
  else if (arg === '--fast' || arg === '--quick') isFast = true;
  else if (arg === '--name' && i + 1 < args.length) {
    customName = args[++i];
  } else if ((arg === '--logo' || arg === '--icon') && i + 1 < args.length) {
    customLogo = args[++i];
  } else if (arg === '--identifier' && i + 1 < args.length) {
    customIdentifier = args[++i];
  } else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
}

if (buildAll) {
  buildAndroid = true;
  buildExe = true;
  buildMac = true;
  buildIos = true;
}

if (!buildAndroid && !buildExe && !buildMac && !buildIos) {
  logError('No build target specified.');
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`
Usage: build [target-flags] [customization-flags]

Targets:
  --android      Build Android APK (signed with debug keystore)
  --exe          Build Windows .exe application and installer setup
  --mac          Build macOS app bundle (.app / .dmg)
  --ios          Build iOS app package
  --all          Build all targets sequentially

Customization:
  --name "<name>"         Update app title, window title, and product name
  --logo "<path>"         Generate Tauri icon suite from PNG icon path
  --icon "<path>"         Alias for --logo
  --identifier "<id>"     Update app bundle identifier (e.g. com.example.app)
`);
}

const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const pkgJsonPath = path.join(rootDir, 'package.json');
const distBuildsDir = path.join(rootDir, 'dist-builds');

const buildStartTime = Date.now() - 5000;

function getTauriCmd() {
  const localTauriJs = path.join(rootDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (fs.existsSync(localTauriJs)) {
    try {
      execSync(`"${process.execPath}" "${localTauriJs}" --version`, { stdio: 'ignore', env: process.env });
      return `"${process.execPath}" "${localTauriJs}"`;
    } catch (e) {
      logWarn('Local Tauri CLI missing native binary binding. Attempting auto-installation...');
      if (isWin) {
        runCmd('npm install --no-save @tauri-apps/cli-win32-x64-msvc', { allowFailure: true });
      } else {
        runCmd('npm install --no-save @tauri-apps/cli-linux-x64-gnu', { allowFailure: true });
      }
      try {
        execSync(`"${process.execPath}" "${localTauriJs}" --version`, { stdio: 'ignore', env: process.env });
        return `"${process.execPath}" "${localTauriJs}"`;
      } catch (_) {}
    }
  }
  return 'npx --yes @tauri-apps/cli';
}

if (isClean) {
  log('Performing clean rebuild: clearing target release cache...');
  fs.rmSync(path.join(rootDir, 'src-tauri', 'target'), { recursive: true, force: true });
}

// Clear old output dist-builds directory
fs.rmSync(distBuildsDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distBuildsDir, 'android'), { recursive: true });
fs.mkdirSync(path.join(distBuildsDir, 'windows'), { recursive: true });
fs.mkdirSync(path.join(distBuildsDir, 'mac'), { recursive: true });
fs.mkdirSync(path.join(distBuildsDir, 'ios'), { recursive: true });

// 3. Apply Customizations
if (customName || customIdentifier) {
  log('Updating app configuration...');
  if (fs.existsSync(tauriConfPath)) {
    const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    if (customName) {
      conf.productName = customName;
      if (conf.app && conf.app.windows && conf.app.windows[0]) {
        conf.app.windows[0].title = customName;
      }
    }
    if (customIdentifier) {
      conf.identifier = customIdentifier;
    }
    fs.writeFileSync(tauriConfPath, JSON.stringify(conf, null, 2), 'utf8');
    logSuccess(`Updated tauri.conf.json`);
  }

  if (customName && fs.existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    pkg.name = customName.toLowerCase().trim().replace(/[^a-z0-9-_]/g, '-');
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2), 'utf8');
    logSuccess(`Updated package.json name to "${pkg.name}"`);
  }
}

if (customLogo) {
  const iconPath = path.resolve(rootDir, customLogo);
  if (!fs.existsSync(iconPath)) {
    logError(`Icon file not found: ${iconPath}`);
    process.exit(1);
  }
  log(`Generating Tauri icon suite from: ${iconPath}`);
  runCmd(`${getTauriCmd()} icon "${iconPath}"`);
  logSuccess('Generated icon suite in src-tauri/icons/');
}

// Helper: Ensure Rust toolchain target is installed
function ensureRustTarget(target) {
  try {
    const stdout = execSync('rustup target list', { encoding: 'utf8', env: process.env });
    if (!stdout.includes(`${target} (installed)`)) {
      log(`Auto-installing missing Rust target: ${target}...`);
      execSync(`rustup target add ${target}`, { stdio: 'inherit', env: process.env });
      logSuccess(`Installed Rust target: ${target}`);
    }
  } catch (err) {
    logWarn(`Could not auto-install Rust target ${target}: ${err.message}`);
  }
}

// Helper: Patch generated Android BuildTask.kt
function patchBuildTaskKt() {
  const buildTaskPath = path.join(rootDir, 'src-tauri', 'gen', 'android', 'buildSrc', 'src', 'main', 'java', 'com', 'tripo', 'app', 'kotlin', 'BuildTask.kt');
  if (fs.existsSync(buildTaskPath)) {
    try {
      let content = fs.readFileSync(buildTaskPath, 'utf8');
      if (!content.includes('val executable = if (Os.isFamily(Os.FAMILY_WINDOWS)) "npx.cmd" else "npx";')) {
        content = content.replace(
          /val executable = .*?;/g,
          'val executable = if (Os.isFamily(Os.FAMILY_WINDOWS)) "npx.cmd" else "npx";'
        );
        fs.writeFileSync(buildTaskPath, content, 'utf8');
        logSuccess('Patched Android BuildTask.kt for cross-platform execution');
      }
    } catch (e) {
      logWarn(`Failed to patch BuildTask.kt: ${e.message}`);
    }
  }
}

let successfulBuilds = 0;

// Android
if (buildAndroid) {
  log('Starting Android build...');
  ensureRustTarget('aarch64-linux-android');
  ensureRustTarget('armv7-linux-androideabi');
  ensureRustTarget('i686-linux-android');
  ensureRustTarget('x86_64-linux-android');

  const genAndroidDir = path.join(rootDir, 'src-tauri', 'gen', 'android');
  let buildSuccess = false;
  if (isFast && fs.existsSync(genAndroidDir)) {
    log('Fast mode active: using existing Android Studio initialization...');
    buildSuccess = runCmd(`${getTauriCmd()} android build --apk`, { allowFailure: true });
  } else {
    if (!fs.existsSync(genAndroidDir)) {
      log('Initializing Android Studio project...');
      runCmd(`${getTauriCmd()} android init --ci`, { allowFailure: true });
    }
    patchBuildTaskKt();
    buildSuccess = runCmd(`${getTauriCmd()} android build --apk`, { allowFailure: true });
  }

  if (!buildSuccess && !isFast) {
    logWarn('Android build failed on first attempt. Retrying with init update...');
    runCmd(`${getTauriCmd()} android init --ci`, { allowFailure: true });
    patchBuildTaskKt();
    buildSuccess = runCmd(`${getTauriCmd()} android build --apk`, { allowFailure: true });
  }

  const apkDir = path.join(rootDir, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk');
  let foundApk = null;

  function findApk(dir) {
    if (!fs.existsSync(dir) || !buildSuccess) return;
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        findApk(fullPath);
      } else if (file.name.endsWith('.apk') && !file.name.endsWith('-signed.apk')) {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= buildStartTime) {
          foundApk = fullPath;
        }
      }
    }
  }

  findApk(apkDir);

  if (foundApk) {
    log(`Unsigned APK built at: ${foundApk}`);

    const homeDir = os.homedir();
    const androidDir = path.join(homeDir, '.android');
    const keystorePath = path.join(androidDir, 'debug.keystore');

    if (!fs.existsSync(keystorePath)) {
      log('Generating debug keystore...');
      fs.mkdirSync(androidDir, { recursive: true });
      runCmd(`keytool -genkeypair -v -keystore "${keystorePath}" -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"`, { allowFailure: true });
    }

    const alignedApk = path.join(distBuildsDir, 'android', 'aligned-temp.apk');
    const signedApk = path.join(distBuildsDir, 'android', 'tripo-app-signed.apk');

    log('Running zipalign...');
    const alignSuccess = runCmd(`zipalign -f -v 4 "${foundApk}" "${alignedApk}"`, { allowFailure: true });

    if (alignSuccess && fs.existsSync(alignedApk)) {
      log('Running apksigner...');
      const signSuccess = runCmd(`apksigner sign --ks "${keystorePath}" --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out "${signedApk}" "${alignedApk}"`, { allowFailure: true });

      if (fs.existsSync(alignedApk)) {
        fs.unlinkSync(alignedApk);
      }

      if (signSuccess && fs.existsSync(signedApk)) {
        log('Verifying signed APK...');
        runCmd(`apksigner verify "${signedApk}"`, { allowFailure: true });
        logSuccess(`Android build completed: ${signedApk}`);
        successfulBuilds++;
      } else {
        logWarn('APK signing failed.');
      }
    } else {
      logWarn('APK zipalign failed.');
    }
  } else {
    logWarn('Could not locate generated APK file.');
  }
}

// Windows (.exe)
if (buildExe) {
  log('Starting Windows (.exe) build...');
  let exeSuccess = false;
  if (isWin) {
    exeSuccess = runCmd(`${getTauriCmd()} build`, { allowFailure: true });
  } else {
    ensureRustTarget('x86_64-pc-windows-gnu');
    exeSuccess = runCmd(`${getTauriCmd()} build --target x86_64-pc-windows-gnu`, { allowFailure: true });
  }

  if (!exeSuccess) {
    logError('Windows build command failed. Rejecting stale binaries from previous runs.');
  } else {
    const possibleReleaseDirs = [
      path.join(rootDir, 'src-tauri', 'target', 'release'),
      path.join(rootDir, 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release'),
      path.join(rootDir, 'src-tauri', 'target', 'x86_64-pc-windows-gnu', 'release')
    ];

    const destWinDir = path.join(distBuildsDir, 'windows');

    // Copy app.exe (ensuring it was modified during current build run)
    let exeFound = false;
    for (const releaseDir of possibleReleaseDirs) {
      if (fs.existsSync(releaseDir)) {
        for (const file of fs.readdirSync(releaseDir)) {
          if (file.endsWith('.exe') && !file.includes('setup')) {
            const srcExe = path.join(releaseDir, file);
            const stat = fs.statSync(srcExe);
            if (stat.mtimeMs >= buildStartTime) {
              const destExe = path.join(destWinDir, 'app.exe');
              fs.copyFileSync(srcExe, destExe);
              exeFound = true;
              logSuccess(`Copied fresh binary to ${destExe}`);
              break;
            }
          }
        }
      }
      if (exeFound) break;
    }

    if (exeFound) {
      successfulBuilds++;
      // Copy installer tripo-setup.exe if available
      let setupFound = false;
      for (const releaseDir of possibleReleaseDirs) {
        const nsisDir = path.join(releaseDir, 'bundle', 'nsis');
        if (fs.existsSync(nsisDir)) {
          for (const file of fs.readdirSync(nsisDir)) {
            if (file.endsWith('.exe')) {
              const srcSetup = path.join(nsisDir, file);
              const stat = fs.statSync(srcSetup);
              if (stat.mtimeMs >= buildStartTime) {
                const destSetup = path.join(destWinDir, 'tripo-setup.exe');
                fs.copyFileSync(srcSetup, destSetup);
                setupFound = true;
                logSuccess(`Copied fresh setup installer to ${destSetup}`);
                break;
              }
            }
          }
        }
        if (setupFound) break;
      }

      if (!setupFound) {
        logWarn('NSIS setup executable not found in bundle directory.');
      } else {
        logSuccess(`Windows build completed: ${destWinDir}`);
      }
    } else {
      logError('Fresh Windows .exe binary not generated.');
    }
  }
}

// macOS (.app / .dmg)
if (buildMac) {
  log('Starting macOS build...');
  const destMacDir = path.join(distBuildsDir, 'mac');
  const macSuccess = runCmd(`${getTauriCmd()} build`, { allowFailure: true });

  if (macSuccess) {
    const bundleDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle');
    if (fs.existsSync(bundleDir)) {
      copyDir(bundleDir, destMacDir);
    }
    logSuccess(`macOS build completed: ${destMacDir}`);
    successfulBuilds++;
  } else {
    logWarn('macOS build failed or is unsupported on this host operating system.');
  }
}

// iOS
if (buildIos) {
  log('Starting iOS build...');
  const destIosDir = path.join(distBuildsDir, 'ios');
  let iosSuccess = runCmd(`${getTauriCmd()} ios build`, { allowFailure: true });
  if (!iosSuccess) {
    iosSuccess = runCmd(`${getTauriCmd()} ios init && ${getTauriCmd()} ios build`, { allowFailure: true });
  }

  if (iosSuccess) {
    const iosBundleDir = path.join(rootDir, 'src-tauri', 'gen', 'ios');
    if (fs.existsSync(iosBundleDir)) {
      copyDir(iosBundleDir, destIosDir);
    }
    logSuccess(`iOS build completed: ${destIosDir}`);
    successfulBuilds++;
  } else {
    logWarn('iOS build failed or is unsupported on this host operating system.');
  }
}

if (successfulBuilds > 0) {
  logSuccess(`Build process finished with ${successfulBuilds} target(s) successfully created!`);
} else {
  logError('All specified build targets failed.');
  process.exit(1);
}
