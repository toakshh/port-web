#!/usr/bin/env node
'use strict';

/**
 * `npm run doctor` - report exactly what this host can build and what is
 * missing, with the command to fix each gap. Safe to run anywhere; it only
 * inspects the environment.
 */

const path = require('path');
const P = require('../lib/paths');
const fsx = require('../lib/fsx');
const tc = require('../lib/toolchain');
const wsl = require('../lib/wsl');

const tick = (ok) => (ok ? 'OK  ' : 'MISS');

const FIXES = {
  rust:
    process.platform === 'win32'
      ? 'winget install Rustlang.Rustup   (or https://rustup.rs)'
      : "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
  jdk:
    process.platform === 'darwin'
      ? 'brew install --cask temurin@17'
      : process.platform === 'win32'
        ? 'winget install EclipseAdoptium.Temurin.17.JDK'
        : 'sudo apt-get install -y openjdk-17-jdk',
  androidSdk: 'Install Android Studio, or the command-line tools from https://developer.android.com/studio#command-tools, then set ANDROID_HOME',
  androidNdk: 'sdkmanager "ndk;27.1.12297006"',
  zipalign: 'sdkmanager "build-tools;35.0.0"   (zipalign and apksigner live there)',
  apksigner: 'sdkmanager "build-tools;35.0.0"',
  keytool: 'Comes with the JDK - fix the JDK entry first',
  mingw: 'sudo apt-get install -y mingw-w64 nsis   (only needed to cross-build Windows apps from Linux)'
};

function main() {
  console.log(`Project root : ${P.ROOT}`);
  console.log(`Host         : ${process.platform}-${process.arch}, node ${process.version}`);
  console.log('');

  const caps = tc.capabilities();
  const d = caps.details;

  console.log('Toolchain');
  console.log(`  [${tick(!!d.rust)}] Rust / cargo      ${d.rust || FIXES.rust}`);
  console.log(`  [${tick(!!d.rustup)}] rustup            ${d.rustup || '(optional, needed to add cross targets)'}`);
  console.log(`  [${tick(!!d.jdk)}] JDK               ${d.jdk || FIXES.jdk}`);
  console.log(`  [${tick(!!d.androidSdk)}] Android SDK       ${d.androidSdk || FIXES.androidSdk}`);
  console.log(`  [${tick(!!d.androidNdk)}] Android NDK       ${d.androidNdk || FIXES.androidNdk}`);
  console.log(`  [${tick(!!d.zipalign)}] zipalign          ${d.zipalign || FIXES.zipalign}`);
  console.log(`  [${tick(!!d.apksigner)}] apksigner         ${d.apksigner || FIXES.apksigner}`);
  console.log(`  [${tick(!!d.keytool)}] keytool           ${d.keytool || FIXES.keytool}`);
  if (process.platform !== 'win32') {
    const mingw = tc.which('x86_64-w64-mingw32-gcc');
    console.log(`  [${tick(!!mingw)}] mingw-w64         ${mingw || FIXES.mingw}`);
  }

  console.log('');
  console.log('Build targets available on this host');
  for (const key of ['android', 'windows', 'mac', 'ios']) {
    console.log(`  [${tick(caps[key])}] ${key}`);
  }

  console.log('');
  console.log('Web assets');
  const baselineIndex = path.join(P.BASELINE_DIST, 'index.html');
  const swapDir = path.join(P.BASELINE_DIST, P.SWAP_SUBPATH);
  console.log(`  [${tick(fsx.isFile(baselineIndex))}] baseline          ${P.BASELINE_DIST}`);
  console.log(`  [${tick(fsx.isDir(swapDir))}] fast-swap folder  ${swapDir}`);
  if (fsx.isDir(P.BASELINE_DIST)) {
    console.log(`       size              ${(fsx.dirSize(P.BASELINE_DIST) / 1048576).toFixed(1)} MB`);
  }

  if (process.platform === 'win32' && !d.rust) {
    const info = wsl.inspect(P.ROOT);
    console.log('');
    console.log('Windows fallback');
    console.log(`  [${tick(info.usable)}] WSL delegation    ${info.usable ? info.root : info.reason}`);
  }

  console.log('');
  const buildable = ['android', 'windows', 'mac', 'ios'].filter((k) => caps[k]);
  if (buildable.length === 0) {
    console.log('No target can be built yet. Fix the MISS entries above and re-run "npm run doctor".');
    process.exitCode = 1;
  } else {
    console.log(`Ready to build: ${buildable.join(', ')}`);
  }
}

main();
