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
    execSync(cmd, { stdio: 'inherit', env: process.env, ...opts });
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
const JDK_DIR = '/home/akshh16/jdk';
const ANDROID_SDK_DIR = '/home/akshh16/android-sdk';

if (!process.env.JAVA_HOME && fs.existsSync(JDK_DIR)) {
  process.env.JAVA_HOME = JDK_DIR;
}
if (!process.env.ANDROID_HOME && fs.existsSync(ANDROID_SDK_DIR)) {
  process.env.ANDROID_HOME = ANDROID_SDK_DIR;
}

const extraPaths = [];
if (process.env.JAVA_HOME) {
  extraPaths.push(path.join(process.env.JAVA_HOME, 'bin'));
}
if (process.env.ANDROID_HOME) {
  extraPaths.push(path.join(process.env.ANDROID_HOME, 'build-tools', '35.0.0'));
  extraPaths.push(path.join(process.env.ANDROID_HOME, 'build-tools', '34.0.0'));
  extraPaths.push(path.join(process.env.ANDROID_HOME, 'platform-tools'));
}

process.env.PATH = [...extraPaths, process.env.PATH].join(path.delimiter);

// 2. Parse CLI Arguments
const args = process.argv.slice(2);

let buildAndroid = false;
let buildExe = false;
let buildMac = false;
let buildIos = false;
let buildAll = false;

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

const rootDir = process.cwd();
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const pkgJsonPath = path.join(rootDir, 'package.json');
const distBuildsDir = path.join(rootDir, 'dist-builds');

// Create output dist-builds directories
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
  runCmd(`npx tauri icon "${iconPath}"`);
  logSuccess('Generated icon suite in src-tauri/icons/');
}

// Helper to copy directory recursively
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 4. Build Targets

// Android
if (buildAndroid) {
  log('Starting Android build...');
  if (customIdentifier) {
    log('Re-initializing Android project for updated identifier...');
    const genAndroidDir = path.join(rootDir, 'src-tauri', 'gen', 'android');
    if (fs.existsSync(genAndroidDir)) {
      fs.rmSync(genAndroidDir, { recursive: true, force: true });
    }
    runCmd('npx tauri android init');
  }

  let buildSuccess = runCmd('npx tauri android build --apk', { allowFailure: true });
  if (!buildSuccess) {
    logWarn('Android build failed. Attempting clean re-init of gen/android...');
    const genAndroidDir = path.join(rootDir, 'src-tauri', 'gen', 'android');
    if (fs.existsSync(genAndroidDir)) {
      fs.rmSync(genAndroidDir, { recursive: true, force: true });
    }
    runCmd('npx tauri android init');
    runCmd('npx tauri android build --apk');
  }

  const apkDir = path.join(rootDir, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk');
  let foundApk = null;

  function findApk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        findApk(fullPath);
      } else if (file.name.endsWith('.apk') && !file.name.endsWith('-signed.apk')) {
        foundApk = fullPath;
      }
    }
  }

  findApk(apkDir);

  if (!foundApk) {
    logError('Could not locate generated APK file.');
    process.exit(1);
  }

  log(`Unsigned APK built at: ${foundApk}`);

  // Ensure Keystore
  const homeDir = os.homedir();
  const androidDir = path.join(homeDir, '.android');
  const keystorePath = path.join(androidDir, 'debug.keystore');

  if (!fs.existsSync(keystorePath)) {
    log('Generating debug keystore...');
    fs.mkdirSync(androidDir, { recursive: true });
    runCmd(`keytool -genkeypair -v -keystore "${keystorePath}" -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"`);
  }

  const alignedApk = path.join(distBuildsDir, 'android', 'aligned-temp.apk');
  const signedApk = path.join(distBuildsDir, 'android', 'tripo-app-signed.apk');

  log('Running zipalign...');
  runCmd(`zipalign -f -v 4 "${foundApk}" "${alignedApk}"`);

  log('Running apksigner...');
  runCmd(`apksigner sign --ks "${keystorePath}" --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out "${signedApk}" "${alignedApk}"`);

  if (fs.existsSync(alignedApk)) {
    fs.unlinkSync(alignedApk);
  }

  log('Verifying signed APK...');
  runCmd(`apksigner verify "${signedApk}"`);

  logSuccess(`Android build completed: ${signedApk}`);
}

// Windows (.exe)
if (buildExe) {
  log('Starting Windows (.exe) build...');
  runCmd('npx tauri build --target x86_64-pc-windows-gnu');

  const releaseDir = path.join(rootDir, 'src-tauri', 'target', 'x86_64-pc-windows-gnu', 'release');
  const destWinDir = path.join(distBuildsDir, 'windows');

  // Copy app.exe
  let exeFound = false;
  if (fs.existsSync(releaseDir)) {
    for (const file of fs.readdirSync(releaseDir)) {
      if (file.endsWith('.exe')) {
        const srcExe = path.join(releaseDir, file);
        const destExe = path.join(destWinDir, 'app.exe');
        fs.copyFileSync(srcExe, destExe);
        exeFound = true;
        logSuccess(`Copied binary to ${destExe}`);
        break;
      }
    }
  }

  if (!exeFound) {
    logError('Windows .exe binary not found in release directory.');
    process.exit(1);
  }

  // Copy installer tripo-setup.exe
  const nsisDir = path.join(releaseDir, 'bundle', 'nsis');
  let setupFound = false;
  if (fs.existsSync(nsisDir)) {
    for (const file of fs.readdirSync(nsisDir)) {
      if (file.endsWith('.exe')) {
        const srcSetup = path.join(nsisDir, file);
        const destSetup = path.join(destWinDir, 'tripo-setup.exe');
        fs.copyFileSync(srcSetup, destSetup);
        setupFound = true;
        logSuccess(`Copied setup installer to ${destSetup}`);
        break;
      }
    }
  }

  if (!setupFound) {
    logWarn('NSIS setup executable not found in bundle directory.');
  } else {
    logSuccess(`Windows build completed: ${destWinDir}`);
  }
}

// macOS (.app / .dmg)
if (buildMac) {
  log('Starting macOS build...');
  const destMacDir = path.join(distBuildsDir, 'mac');
  const macSuccess = runCmd('npx tauri build', { allowFailure: true });

  if (macSuccess) {
    const bundleDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle');
    if (fs.existsSync(bundleDir)) {
      copyDir(bundleDir, destMacDir);
    }
    logSuccess(`macOS build completed: ${destMacDir}`);
  } else {
    logWarn('macOS build failed or is unsupported on this host operating system.');
  }
}

// iOS
if (buildIos) {
  log('Starting iOS build...');
  const destIosDir = path.join(distBuildsDir, 'ios');
  let iosSuccess = runCmd('npx tauri ios build', { allowFailure: true });
  if (!iosSuccess) {
    iosSuccess = runCmd('npx tauri ios init && npx tauri ios build', { allowFailure: true });
  }

  if (iosSuccess) {
    const iosBundleDir = path.join(rootDir, 'src-tauri', 'gen', 'ios');
    if (fs.existsSync(iosBundleDir)) {
      copyDir(iosBundleDir, destIosDir);
    }
    logSuccess(`iOS build completed: ${destIosDir}`);
  } else {
    logWarn('iOS build failed or is unsupported on this host operating system.');
  }
}

logSuccess('Build process finished successfully!');
