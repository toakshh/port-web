#!/usr/bin/env node
'use strict';

/**
 * Unified multi-platform build pipeline (Android / Windows / macOS / iOS).
 *
 * Works from any directory on any OS: every path is derived from this file's
 * location, every toolchain is discovered at runtime, and missing npm packages
 * are installed on demand instead of crashing the build.
 *
 * Two modes shape how the web assets reach the app:
 *
 *   --mode fast   Reuse the committed baseline in dist/ and swap ONLY
 *                 static/files/ from the supplied web build. Compilation caches
 *                 are preserved, so the build is incremental. The baseline is
 *                 left untouched.
 *
 *   --mode clean  Wipe the compilation cache and build from the supplied web
 *                 build in full. On success the baseline in dist/ is updated,
 *                 so any new shared assets become the common data that every
 *                 later fast build starts from.
 *
 * Run `node build.js --help` for the full flag list.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('./lib/paths');
const fsx = require('./lib/fsx');
const tc = require('./lib/toolchain');
const wsl = require('./lib/wsl');
const slots = require('./lib/slots');

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, msg) => (useColor ? `\x1b[${code}m${msg}\x1b[0m` : msg);

const log = (msg) => console.log(`${paint(36, '[BUILD]')} ${msg}`);

/** Phase timings, so the log always shows where a build actually spent time. */
const phaseTimings = [];
function timed(label, fn) {
  const started = Date.now();
  try {
    return fn();
  } finally {
    const seconds = (Date.now() - started) / 1000;
    phaseTimings.push({ phase: label, seconds: Number(seconds.toFixed(1)) });
    console.log(`${paint(36, '[TIME]')} ${label}: ${seconds.toFixed(1)}s`);
  }
}
const logSuccess = (msg) => console.log(`${paint(32, '[SUCCESS]')} ${msg}`);
const logWarn = (msg) => console.log(`${paint(33, '[WARNING]')} ${msg}`);
const logError = (msg) => console.error(`${paint(31, '[ERROR]')} ${msg}`);

/* ------------------------------------------------------------------ *
 * CLI parsing
 * ------------------------------------------------------------------ */

function printHelp() {
  console.log(`
Usage: build [target-flags] [options]

Targets:
  --android              Build a signed Android APK
  --exe, --windows       Build the Windows executable and NSIS installer
  --mac, --dmg           Build the macOS app bundle / DMG   (macOS host only)
  --ios                  Build the iOS app package          (macOS host only)
  --all                  Build every target supported by this host

Build mode:
  --fast, --quick        Reuse caches; swap only static/files from --web-src
  --clean                Purge caches, rebuild fully, then update the baseline
  --mode fast|clean      The same choice, spelled out  (default: fast)

Web assets:
  --web-src <dir>        Web build to take assets from
                         (default: the committed baseline in dist/)

Customization:
  --name "<name>"        Product name, window title and installer name
  --logo, --icon <path>  PNG/JPG used to generate the whole icon set
  --identifier <id>      Bundle identifier, e.g. com.example.app

Speed:
  --no-installer         Produce the bare executable only, skipping the
                         installer step (the quickest possible build)
      (--no-bundle is an alias)
  --installer-only       Ship only the Windows setup installer; the bare
                         app.exe is built but not published
      (--setup-only is an alias)
  --bundles <list>       Desktop bundle formats (default: nsis on Windows).
                         e.g. --bundles nsis,msi
  --abis <list>          Android ABIs to compile. Fast mode builds aarch64
                         only; clean mode builds all four.
                         e.g. --abis aarch64,x86_64  or --abis all
      (--android-targets is an alias)

Display:
  --fullscreen           Launch fullscreen on every target. On Android this
                         hides the navigation/status bars and draws into the
                         notch; on desktop it opens borderless fullscreen.
  --no-fullscreen        Keep the system bars and window decorations.
                         (default: Android immersive on, desktop windowed)

Other:
  --out <dir>            Artifact output directory (default: dist-builds/)
  --slot <id>            Build in an isolated slot, so concurrent builds cannot
                         overwrite each other's files. The server sets this;
                         a plain command-line build does not need it.
  --no-wsl               Never delegate a Windows build to WSL
  --help, -h             Show this message
`);
}

const splitList = (value) =>
  String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

function parseArgs(argv) {
  const opts = {
    android: false,
    exe: false,
    mac: false,
    ios: false,
    mode: 'fast',
    webSrc: null,
    name: null,
    logo: null,
    identifier: null,
    out: P.DIST_BUILDS,
    allowWsl: true,
    slot: null,
    // null = auto: Android immersive on, desktop windowed.
    fullscreen: null,
    installer: true,
    // true = publish only the NSIS setup, not the bare app.exe.
    installerOnly: false,
    bundles: null,
    abis: null
  };

  const needsValue = (i, flag) => {
    if (i + 1 >= argv.length) {
      logError(`${flag} requires a value`);
      process.exit(2);
    }
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--android': opts.android = true; break;
      case '--exe':
      case '--windows': opts.exe = true; break;
      case '--mac':
      case '--dmg': opts.mac = true; break;
      case '--ios': opts.ios = true; break;
      case '--all':
        opts.android = true;
        opts.exe = true;
        opts.mac = true;
        opts.ios = true;
        break;
      case '--clean': opts.mode = 'clean'; break;
      case '--fast':
      case '--quick': opts.mode = 'fast'; break;
      case '--mode': opts.mode = needsValue(i, arg).toLowerCase(); i++; break;
      case '--web-src':
      case '--web': opts.webSrc = path.resolve(needsValue(i, arg)); i++; break;
      case '--name': opts.name = needsValue(i, arg); i++; break;
      case '--logo':
      case '--icon': opts.logo = path.resolve(needsValue(i, arg)); i++; break;
      case '--identifier': opts.identifier = needsValue(i, arg); i++; break;
      case '--out': opts.out = path.resolve(needsValue(i, arg)); i++; break;
      case '--no-wsl': opts.allowWsl = false; break;
      case '--fullscreen': opts.fullscreen = true; break;
      case '--no-fullscreen': opts.fullscreen = false; break;
      case '--slot': opts.slot = needsValue(i, arg); i++; break;
      case '--no-installer':
      case '--no-bundle': opts.installer = false; break;
      case '--setup-only':
      case '--installer-only': opts.installerOnly = true; break;
      case '--bundles': opts.bundles = splitList(needsValue(i, arg)); i++; break;
      case '--abis':
      case '--android-targets': opts.abis = splitList(needsValue(i, arg)); i++; break;
      case '--help':
      case '-h': printHelp(); process.exit(0); break;
      default:
        logWarn(`Ignoring unknown argument: ${arg}`);
    }
  }

  if (opts.mode !== 'fast' && opts.mode !== 'clean') {
    logError(`Unknown build mode "${opts.mode}" (expected fast or clean)`);
    process.exit(2);
  }
  if (opts.installerOnly && !opts.installer) {
    logError('--installer-only and --no-installer cannot be combined: one keeps only the installer, the other builds none.');
    process.exit(2);
  }
  return opts;
}

const rawArgs = process.argv.slice(2);
const opts = parseArgs(rawArgs);

if (!opts.android && !opts.exe && !opts.mac && !opts.ios) {
  logError('No build target specified.');
  printHelp();
  process.exit(2);
}

// A target the host cannot possibly produce is dropped up front rather than
// producing a confusing "build succeeded but nothing was created" result.
if (opts.mac && process.platform !== 'darwin') {
  logWarn('macOS bundles can only be produced on a macOS host - skipping --mac.');
  opts.mac = false;
}
if (opts.ios && process.platform !== 'darwin') {
  logWarn('iOS packages can only be produced on a macOS host - skipping --ios.');
  opts.ios = false;
}
if (!opts.android && !opts.exe && !opts.mac && !opts.ios) {
  logError('None of the requested targets can be built on this host.');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Toolchain
 * ------------------------------------------------------------------ */

log(`Project root : ${P.ROOT}`);
log(`Host         : ${process.platform}-${process.arch} (node ${process.version})`);
log(`Build mode   : ${opts.mode}`);

const env = tc.setupEnv({ log });

if (!env.cargo) {
  const rust = tc.ensureRustToolchain();
  if (!rust.ok) {
    // Windows without native Rust can still build through WSL if it has one.
    if (opts.allowWsl && process.platform === 'win32') {
      const delegated = wsl.delegateBuild(P.ROOT, rawArgs, { log });
      if (delegated.delegated) process.exit(delegated.ok ? 0 : 1);
      logWarn(`WSL delegation unavailable: ${delegated.reason}`);
    }
    logError('No Rust toolchain found - Tauri cannot build without it.');
    if (rust.hint) logError(rust.hint);
    logError('Set AUTO_INSTALL_TOOLCHAIN=1 to let this script install Rust automatically.');
    process.exit(1);
  }
}

const tauri = tc.ensureTauriCli({ log });
const tauriCmd = (...args) => {
  // Logged so a slow or surprising build can be reproduced by hand.
  console.log(`${paint(36, '[CMD]')} tauri ${args.join(' ')}`);
  return [...tauri, ...args];
};

/* ------------------------------------------------------------------ *
 * Project context (repository, or an isolated build slot)
 * ------------------------------------------------------------------ */

/**
 * `--slot <id>` runs the build in its own project directory so that concurrent
 * jobs cannot overwrite each other's staged assets or generated Android
 * project. Without it, the build runs directly from the repository, which is
 * what a plain command-line build should do.
 */
const ctx = opts.slot ? slots.prepareSlot(opts.slot) : slots.repoContext();

if (opts.slot) log(`Build slot ${opts.slot}: ${ctx.projectDir}`);

// The Rust target directory is shared by every slot on purpose: cargo locks it,
// so concurrent compiles serialise instead of corrupting, and each slot starts
// from the same warm dependency cache rather than a cold multi-minute build.
process.env.CARGO_TARGET_DIR = ctx.targetDir;

/** Tauri always runs with the project directory as its working directory. */
const runTauri = (...args) => tc.run(tauriCmd(...args), { cwd: ctx.projectDir });

/* ------------------------------------------------------------------ *
 * Web asset staging (the fast / clean distinction)
 * ------------------------------------------------------------------ */

/**
 * Populate the workspace that Tauri compiles from.
 *
 * fast : baseline + only static/files replaced from the supplied build.
 * clean: exactly the supplied build (or the baseline when none was supplied).
 */
function stageWebAssets() {
  const source = opts.webSrc;
  if (source && !fsx.isDir(source)) {
    logError(`--web-src directory not found: ${source}`);
    process.exit(1);
  }

  fsx.ensureDir(P.WORKSPACE);

  if (!fsx.isDir(P.BASELINE_DIST) && !source) {
    logError(`No web assets to build: baseline ${P.BASELINE_DIST} is missing and --web-src was not given.`);
    process.exit(1);
  }

  if (opts.mode === 'clean' && source) {
    log(`Clean mode: staging the complete uploaded web build.`);
    const stats = fsx.syncDir(source, ctx.distDir);
    log(`Staged ${stats.copied} changed file(s), ${stats.skipped} unchanged, ${stats.removed} removed.`);
    return { swappedOnly: false };
  }

  // Both fast mode and plain CLI builds start from the committed baseline.
  log(`Staging baseline web build from ${P.BASELINE_DIST}`);
  const baseStats = fsx.syncDir(P.BASELINE_DIST, ctx.distDir);
  log(`Baseline: ${baseStats.copied} changed file(s), ${baseStats.skipped} unchanged, ${baseStats.removed} removed.`);

  if (!source) return { swappedOnly: false };

  const swapFrom = path.join(source, P.SWAP_SUBPATH);
  const swapTo = path.join(ctx.distDir, P.SWAP_SUBPATH);
  if (!fsx.isDir(swapFrom)) {
    logError(`Fast mode requires "${P.SWAP_SUBPATH}" inside the uploaded build, but it is missing.`);
    logError('Upload a build that contains it, or use clean mode to rebuild from the full upload.');
    process.exit(1);
  }

  const swapStats = fsx.syncDir(swapFrom, swapTo);
  logSuccess(
    `Fast swap: replaced ${P.SWAP_SUBPATH} ` +
      `(${swapStats.copied} changed, ${swapStats.skipped} unchanged, ${swapStats.removed} removed).`
  );
  return { swappedOnly: true };
}

/** Clean mode promotes the freshly built assets to the shared baseline. */
function promoteBaseline() {
  if (opts.mode !== 'clean' || !opts.webSrc) return;
  log('Clean mode: updating the committed baseline with this build\'s web assets...');
  const stats = fsx.syncDir(ctx.distDir, P.BASELINE_DIST);
  logSuccess(
    `Baseline updated (${stats.copied} changed, ${stats.skipped} unchanged, ${stats.removed} removed) - ` +
      'future fast builds now start from these files.'
  );
}

/* ------------------------------------------------------------------ *
 * Tauri configuration overrides (no mutation of tauri.conf.json)
 * ------------------------------------------------------------------ */

/**
 * Per-run config passed to the Tauri CLI with `--config`. Customising the app
 * this way keeps `src-tauri/tauri.conf.json` pristine, so a crashed build can
 * never leave the repository in a half-renamed state.
 */
/**
 * Android hides the system bars by default - navigation and status bars over a
 * full-screen 3D experience are almost never wanted. `--no-fullscreen` opts out.
 * Desktop stays windowed unless `--fullscreen` is passed explicitly.
 */
const androidImmersive = () => opts.fullscreen !== false;

function buildConfigOverride(iconPaths) {
  const override = {};
  const window = {};

  if (opts.name) {
    override.productName = opts.name;
    window.title = opts.name;
  }
  if (opts.fullscreen === true) {
    window.fullscreen = true;
    window.decorations = false;
  }
  if (Object.keys(window).length > 0) override.app = { windows: [window] };

  if (opts.identifier) override.identifier = opts.identifier;

  const bundle = {};
  if (iconPaths && iconPaths.length > 0) bundle.icon = iconPaths;

  // NSIS defaults to LZMA. On this payload - already-compressed .glb/.jpg
  // assets - LZMA costs ~14s more and saves ~0.1% of installer size, so the
  // trade is not worth making on any build.
  bundle.windows = { nsis: { compression: 'zlib' } };

  if (Object.keys(bundle).length > 0) override.bundle = bundle;
  return override;
}

let overrideFile = null;
function configArgs(iconPaths) {
  const override = buildConfigOverride(iconPaths);
  if (Object.keys(override).length === 0) return [];
  overrideFile = path.join(P.WORKSPACE, 'tauri.override.json');
  fsx.writeJson(overrideFile, override);
  return ['--config', overrideFile];
}

/* ------------------------------------------------------------------ *
 * Icons
 * ------------------------------------------------------------------ */

/**
 * Generate the icon set for this run into the workspace so a custom logo from
 * one job can never leak into the next one. Returns bundle.icon paths relative
 * to src-tauri (which is how Tauri resolves them), or null to keep defaults.
 */
function generateIcons() {
  if (!opts.logo) return null;
  if (!fsx.isFile(opts.logo)) {
    logError(`Icon file not found: ${opts.logo}`);
    process.exit(1);
  }

  const outDir = fsx.emptyDir(ctx.iconsDir);
  log(`Generating icon set from ${opts.logo}`);
  const res = runTauri('icon', opts.logo, '-o', outDir);
  if (!res.ok) {
    logWarn('Icon generation failed - continuing with the default icon set.');
    return null;
  }

  const wanted = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico'];
  const produced = wanted
    .filter((name) => fsx.isFile(path.join(outDir, name)))
    .map((name) => path.relative(ctx.srcTauri, path.join(outDir, name)).split(path.sep).join('/'));

  if (produced.length === 0) {
    logWarn('Icon generation produced no usable files - keeping the default icon set.');
    return null;
  }

  // Force the icon to actually be re-embedded. tauri-build embeds the .ico from
  // its build script but never declares it as a rerun trigger, and the path is
  // identical on every build - so with a warm cache Cargo skips the script and
  // the previous icon survives. src-tauri/build.rs declares this env var as a
  // trigger; changing its value is what makes a new icon take effect.
  const ico = path.join(outDir, 'icon.ico');
  if (fsx.isFile(ico)) {
    process.env.TRIPO_ICON_HASH = require('crypto')
      .createHash('sha256')
      .update(fs.readFileSync(ico))
      .digest('hex')
      .slice(0, 16);
  }

  logSuccess(`Generated ${produced.length} icon variant(s) in ${outDir}`);
  return produced;
}

/* ------------------------------------------------------------------ *
 * Android helpers
 * ------------------------------------------------------------------ */

/** The identifier baked into the generated Android project, if any. */
function generatedAndroidIdentifier() {
  const gradle = path.join(ctx.genAndroid, 'app', 'build.gradle.kts');
  if (!fsx.isFile(gradle)) return null;
  const match = fs.readFileSync(gradle, 'utf8').match(/namespace\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Tauri generates a Kotlin build task that hard-codes the `npx` executable
 * name, which does not exist on Windows (it is `npx.cmd`). Patch whatever
 * BuildTask.kt was generated, regardless of the package directory the current
 * identifier produced.
 */
function patchBuildTaskKt() {
  const kotlinRoot = path.join(ctx.genAndroid, 'buildSrc', 'src', 'main', 'java');
  const targets = fsx.walkFiles(kotlinRoot).filter((f) => path.basename(f) === 'BuildTask.kt');
  const replacement = 'val executable = if (Os.isFamily(Os.FAMILY_WINDOWS)) "npx.cmd" else "npx";';

  for (const file of targets) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes(replacement)) continue;
      const patched = content.replace(/val executable = .*?;/g, replacement);
      if (patched !== content) {
        fs.writeFileSync(file, patched, 'utf8');
        logSuccess(`Patched ${path.relative(P.ROOT, file)} for cross-platform execution`);
      }
    } catch (err) {
      logWarn(`Could not patch ${file}: ${err.message}`);
    }
  }
}

const ANDROID_ABI_TARGETS = {
  aarch64: 'aarch64-linux-android',
  armv7: 'armv7-linux-androideabi',
  i686: 'i686-linux-android',
  x86_64: 'x86_64-linux-android'
};

/**
 * Which ABIs to compile.
 *
 * `tauri android build` compiles all four by default - four full Rust
 * compilations per job. Fast mode builds arm64 only, which covers essentially
 * every real device shipped in the last decade; clean mode builds the universal
 * APK that also runs on emulators and older 32-bit hardware.
 */
function androidAbis() {
  if (opts.abis && opts.abis.length > 0) {
    if (opts.abis.includes('all')) return Object.keys(ANDROID_ABI_TARGETS);
    const valid = opts.abis.filter((a) => a in ANDROID_ABI_TARGETS);
    const unknown = opts.abis.filter((a) => !(a in ANDROID_ABI_TARGETS));
    for (const abi of unknown) logWarn(`Ignoring unknown Android ABI "${abi}".`);
    if (valid.length > 0) return valid;
  }
  return opts.mode === 'fast' ? ['aarch64'] : Object.keys(ANDROID_ABI_TARGETS);
}

/**
 * Explain an Android failure in one line.
 *
 * Tauri surfaces a Gradle failure by dumping the entire process environment,
 * which buries the actual cause. The Gradle wrapper downloads its own
 * distribution on first use, and a failed or half-finished download is by far
 * the most common first-run failure - it is also invisible in that dump.
 */
function diagnoseAndroidFailure() {
  const distRoot = path.join(os.homedir(), '.gradle', 'wrapper', 'dists');
  if (!fsx.isDir(distRoot)) return null;

  for (const versionDir of fsx.walkFiles(distRoot).map((f) => path.dirname(f))) {
    const entries = (() => {
      try {
        return fs.readdirSync(versionDir);
      } catch (_) {
        return [];
      }
    })();
    const partial = entries.find((e) => e.endsWith('.part') || e.endsWith('.lck'));
    const unpacked = entries.some((e) => !e.includes('.') || e.startsWith('gradle-'));
    const zip = entries.find((e) => e.endsWith('.zip'));

    if (partial && !zip && !unpacked) {
      const version = path.basename(path.dirname(versionDir));
      return (
        `Gradle could not download its distribution (${version}). This is a network problem, ` +
        `not a build error. Retry, or fetch it manually into ${versionDir} from ` +
        'https://services.gradle.org/distributions/'
      );
    }
  }
  return null;
}

/**
 * Make the Android app run edge-to-edge with the system bars hidden and the
 * content extended into the display cutout (notch).
 *
 * Tauri exposes no configuration for this, so the generated activity and theme
 * are patched after `android init` - the same approach `patchBuildTaskKt()`
 * uses. Both files are regenerated by the Tauri CLI, so this must run after
 * every init, not once.
 */
function patchAndroidFullscreen() {
  const javaRoot = path.join(ctx.genAndroid, 'app', 'src', 'main', 'java');
  const activities = fsx.walkFiles(javaRoot).filter((f) => path.basename(f) === 'MainActivity.kt');

  for (const file of activities) {
    try {
      const original = fs.readFileSync(file, 'utf8');
      if (original.includes('IMMERSIVE_PATCHED')) continue;

      const pkg = (original.match(/^package\s+([\w.]+)/m) || [])[1];
      if (!pkg) {
        logWarn(`Could not read the package name from ${file}; skipping fullscreen patch.`);
        continue;
      }

      // BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE keeps the bars hidden but lets the
      // user swipe them back temporarily - the Android-recommended "sticky"
      // immersive behaviour. Re-hiding on focus change is required because the
      // bars stay visible after the user dismisses them or returns to the app.
      const patched = `package ${pkg}

// IMMERSIVE_PATCHED - generated by build.js (--fullscreen)
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Draw behind the notch instead of letter-boxing around it.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes.layoutInDisplayCutoutMode =
        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }
    hideSystemBars()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) hideSystemBars()
  }

  private fun hideSystemBars() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.systemBars())
  }
}
`;
      fs.writeFileSync(file, patched, 'utf8');
      logSuccess(`Patched ${path.relative(P.ROOT, file)} for immersive fullscreen`);
    } catch (err) {
      logWarn(`Could not patch ${file}: ${err.message}`);
    }
  }

  // The theme must also opt into the cutout area, or Android 9-11 devices letterbox.
  const themeFiles = fsx
    .walkFiles(path.join(ctx.genAndroid, 'app', 'src', 'main', 'res'))
    .filter((f) => path.basename(f) === 'themes.xml');

  for (const file of themeFiles) {
    try {
      const original = fs.readFileSync(file, 'utf8');
      if (original.includes('windowLayoutInDisplayCutoutMode')) continue;

      const patched = original.replace(
        /(<style name="Theme\.app"[^>]*>)/,
        `$1
        <item name="android:windowLayoutInDisplayCutoutMode" tools:targetApi="27">shortEdges</item>
        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>`
      );
      if (patched === original) continue;
      fs.writeFileSync(file, patched, 'utf8');
      logSuccess(`Patched ${path.relative(P.ROOT, file)} for display-cutout support`);
    } catch (err) {
      logWarn(`Could not patch ${file}: ${err.message}`);
    }
  }
}

/** Rust ABI name -> the jniLibs folder Android expects it in. */
const ABI_JNI_DIRS = {
  aarch64: 'arm64-v8a',
  armv7: 'armeabi-v7a',
  i686: 'x86',
  x86_64: 'x86_64'
};

/**
 * Drop jniLibs entries for ABIs this build is not producing.
 *
 * Tauri symlinks each compiled `libapp_lib.so` into `jniLibs/<abi>/`. Those
 * symlinks survive between builds, so switching from a four-ABI build to a
 * single-ABI one leaves dangling links behind - and Gradle's
 * `mergeUniversalRelease...` task fails hard on them:
 *   "Cannot snapshot .../armeabi-v7a/libapp_lib.so: not a regular file".
 * Pruning first is what makes Fast (one ABI) and Clean (all four) able to
 * follow each other in any order.
 */
/**
 * Install the generated launcher icons into the Android project.
 *
 * `tauri icon -o <dir>` writes the Android mipmaps to `<dir>/android/`, and
 * nothing ever reads them from there. Android takes its launcher icon from
 * `gen/android/app/src/main/res/mipmap-*`, and `bundle.icon` - which is what
 * the config overlay sets - only drives desktop icons. Without this copy the
 * uploaded logo is generated, ignored, and every APK ships Tauri's default.
 *
 * Must run after `android init`, which regenerates res/ with the stock icons.
 */
function applyAndroidIcons() {
  if (!ctx.iconsDir) return;
  const src = path.join(ctx.iconsDir, 'android');
  if (!fsx.isDir(src)) return;

  const res = path.join(ctx.genAndroid, 'app', 'src', 'main', 'res');
  if (!fsx.isDir(res)) {
    logWarn('Android res/ directory not found; launcher icons were not replaced.');
    return;
  }

  let copied = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = path.join(src, entry.name);
    const to = fsx.ensureDir(path.join(res, entry.name));
    for (const file of fs.readdirSync(from)) {
      fsx.copyPath(path.join(from, file), path.join(to, file));
      copied++;
    }
  }
  if (copied > 0) logSuccess(`Applied ${copied} Android launcher icon file(s) from the uploaded logo`);
}

function pruneAndroidJniLibs(abis) {
  const jniRoot = path.join(ctx.genAndroid, 'app', 'src', 'main', 'jniLibs');
  if (!fsx.isDir(jniRoot)) return;

  const keep = new Set(abis.map((abi) => ABI_JNI_DIRS[abi]).filter(Boolean));

  for (const entry of fs.readdirSync(jniRoot, { withFileTypes: true })) {
    const dir = path.join(jniRoot, entry.name);
    if (!keep.has(entry.name)) {
      fsx.rmrf(dir);
      log(`Removed stale jniLibs/${entry.name} (not built in this run).`);
      continue;
    }
    // Keep the folder, but clear links whose target no longer exists.
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file);
      try {
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink() && !fs.existsSync(full)) {
          fs.rmSync(full, { force: true });
          log(`Removed dangling jniLibs/${entry.name}/${file}.`);
        }
      } catch (_) {
        fs.rmSync(full, { force: true });
      }
    }
  }
}

function ensureAndroidTargets(abis) {
  for (const abi of abis) {
    const target = ANDROID_ABI_TARGETS[abi];
    if (!tc.ensureRustTarget(target)) {
      logWarn(`Rust target ${target} is not installed and could not be added automatically.`);
    }
  }
}

function ensureDebugKeystore() {
  const keystore = path.join(os.homedir(), '.android', 'debug.keystore');
  if (fsx.isFile(keystore)) return keystore;

  const keytool = tc.which('keytool');
  if (!keytool) {
    logWarn('keytool not found (JDK missing) - cannot create a debug keystore.');
    return null;
  }

  log('Generating a debug keystore...');
  fsx.ensureDir(path.dirname(keystore));
  const ok = tc.run([
    keytool, '-genkeypair', '-v',
    '-keystore', keystore,
    '-storepass', 'android',
    '-alias', 'androiddebugkey',
    '-keypass', 'android',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-dname', 'CN=Android Debug,O=Android,C=US'
  ]).ok;
  return ok && fsx.isFile(keystore) ? keystore : null;
}

/* ------------------------------------------------------------------ *
 * Build orchestration
 * ------------------------------------------------------------------ */

if (opts.mode === 'clean') {
  log('Clean mode: purging the Rust build cache...');
  // Clear the contents rather than the directory: in Docker this path is the
  // `rust-target` volume mount point, and removing a mount point fails with
  // EBUSY. Emptying it has the same effect for Cargo.
  fsx.clearDir(ctx.targetDir);
} else if (!fsx.isDir(ctx.targetDir)) {
  log('No compilation cache yet - this first build will take as long as a clean one.');
}

timed('stage web assets', stageWebAssets);

if (!fsx.isFile(path.join(ctx.distDir, 'index.html'))) {
  logError(`Staged web build has no index.html at ${ctx.distDir}`);
  process.exit(1);
}

const outDir = opts.out;
// Emptied per requested platform so a run that produces fewer artifacts than
// the last one (e.g. --no-installer) cannot leave a stale binary behind that
// looks like part of this build.
const requestedPlatforms = { android: opts.android, windows: opts.exe, mac: opts.mac, ios: opts.ios };
for (const [platform, requested] of Object.entries(requestedPlatforms)) {
  const dir = path.join(outDir, platform);
  if (requested) fsx.emptyDir(dir);
  else fsx.ensureDir(dir);
}

const iconPaths = generateIcons();
const cfg = configArgs(iconPaths);

// Anything older than this is a leftover from a previous run, not our output.
const buildStartTime = Date.now() - 5000;

/**
 * Newest artifact matching `predicate`, ignoring anything older than `since`.
 */
function findNewest(dir, predicate, since) {
  let best = null;
  let bestTime = -1;
  for (const file of fsx.walkFiles(dir)) {
    if (!predicate(path.basename(file), file)) continue;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      continue;
    }
    if (stat.mtimeMs >= since && stat.mtimeMs > bestTime) {
      best = file;
      bestTime = stat.mtimeMs;
    }
  }
  return best;
}

/**
 * Locate an artifact this run is allowed to publish.
 *
 * Preference is always for something written during this run, so a build that
 * failed can never publish the previous run's binary. But an incremental build
 * that was fully up to date legitimately leaves the artifact untouched - Gradle
 * and Cargo both do this - so once the build command has *succeeded*, an
 * existing artifact is accepted even though its timestamp is older.
 */
function findFreshFile(dir, predicate, buildSucceeded = false) {
  const fresh = findNewest(dir, predicate, buildStartTime);
  if (fresh || !buildSucceeded) return fresh;

  const existing = findNewest(dir, predicate, 0);
  if (existing) {
    log(`Reusing up-to-date artifact (the build had nothing to rebuild): ${path.basename(existing)}`);
  }
  return existing;
}

const results = { android: null, windows: null, mac: null, ios: null };
const failures = [];

/* ---------------------------- Android ---------------------------- */

if (opts.android) {
  log('=== Android ===');
  if (!env.jdk) failures.push('android: no JDK found (set JAVA_HOME or install a JDK 17+)');
  else if (!env.sdk) failures.push('android: no Android SDK found (set ANDROID_HOME)');
  else if (!env.ndk) failures.push('android: no Android NDK found (set NDK_HOME or install one via the SDK manager)');
  else {
    const abis = androidAbis();
    ensureAndroidTargets(abis);
    const abiArgs = ['--target', ...abis];
    log(
      abis.length === 1
        ? `Compiling the ${abis[0]} ABI only (fast mode). Use --abis all for a universal APK.`
        : `Compiling ${abis.length} ABIs: ${abis.join(', ')}.`
    );

    const wantedId = opts.identifier || null;
    const currentId = generatedAndroidIdentifier();
    const needsInit =
      !fsx.isDir(ctx.genAndroid) || (wantedId && currentId && wantedId !== currentId);

    if (needsInit) {
      if (currentId && wantedId && currentId !== wantedId) {
        log(`Android project identifier changes ${currentId} -> ${wantedId}; regenerating project.`);
      } else {
        log('Initializing the Android project...');
      }
      runTauri('android', 'init', '--ci', ...cfg);
    }
    patchBuildTaskKt();
    if (androidImmersive()) patchAndroidFullscreen();
    applyAndroidIcons();
    pruneAndroidJniLibs(abis);

    let ok = timed('android compile + package', () =>
      runTauri('android', 'build', '--apk', ...abiArgs, ...cfg).ok
    );
    if (!ok) {
      logWarn('Android build failed - re-running the project generator and retrying once...');
      runTauri('android', 'init', '--ci', ...cfg);
      patchBuildTaskKt();
      if (androidImmersive()) patchAndroidFullscreen();
      applyAndroidIcons();
      pruneAndroidJniLibs(abis);
      ok = timed('android compile + package (retry)', () =>
        runTauri('android', 'build', '--apk', ...abiArgs, ...cfg).ok
      );
    }

    const apkRoot = path.join(ctx.genAndroid, 'app', 'build', 'outputs', 'apk');
    const unsigned = ok
      ? findFreshFile(apkRoot, (name) => name.endsWith('.apk') && !name.endsWith('-signed.apk'), true)
      : null;

    if (!unsigned) {
      const reason = diagnoseAndroidFailure();
      failures.push(reason ? `android: ${reason}` : 'android: no APK was produced');
    } else {
      log(`Unsigned APK: ${unsigned}`);
      const keystore = ensureDebugKeystore();
      const zipalign = tc.which('zipalign');
      const apksigner = tc.which('apksigner');
      const alignedApk = path.join(outDir, 'android', 'aligned-temp.apk');
      const signedApk = path.join(outDir, 'android', 'tripo-app-signed.apk');

      if (!zipalign || !apksigner) {
        failures.push('android: zipalign/apksigner not found in the Android SDK build-tools');
      } else if (!keystore) {
        failures.push('android: no debug keystore available for signing');
      } else if (!timed('android zipalign', () => tc.run([zipalign, '-f', '4', unsigned, alignedApk]).ok)) {
        failures.push('android: zipalign failed');
      } else {
        const signed = timed('android sign', () => tc.run([
          apksigner, 'sign',
          '--ks', keystore,
          '--ks-pass', 'pass:android',
          '--key-pass', 'pass:android',
          '--ks-key-alias', 'androiddebugkey',
          '--out', signedApk,
          alignedApk
        ]).ok);
        fsx.rmrf(alignedApk);

        if (signed && fsx.isFile(signedApk)) {
          tc.run([apksigner, 'verify', signedApk]);
          results.android = signedApk;
          logSuccess(`Android APK: ${signedApk}`);
        } else {
          failures.push('android: APK signing failed');
        }
      }
    }
  }
}

/* ---------------------------- Windows ---------------------------- */

if (opts.exe) {
  log('=== Windows ===');
  const crossCompiling = process.platform !== 'win32';
  const buildArgs = ['build'];

  if (crossCompiling) {
    // Cross-compiling from Linux/macOS needs the GNU target plus mingw-w64.
    tc.ensureRustTarget('x86_64-pc-windows-gnu');
    buildArgs.push('--target', 'x86_64-pc-windows-gnu');
    if (!tc.which('x86_64-w64-mingw32-gcc')) {
      logWarn('mingw-w64 was not found; a cross-compiled Windows build will likely fail.');
      logWarn('Install it with: sudo apt-get install -y mingw-w64 nsis   (or the equivalent for your distro)');
    }
  }

  if (!opts.installer) {
    log('Installer skipped (--no-installer): producing the bare executable.');
    buildArgs.push('--no-bundle');
  } else {
    // Only NSIS is ever published by this pipeline. Building the WiX/MSI bundle
    // as well costs ~12s per job and produces an artifact nothing downloads.
    const bundles = opts.bundles && opts.bundles.length > 0 ? opts.bundles : ['nsis'];
    buildArgs.push('--bundles', bundles.join(','));
  }

  buildArgs.push(...cfg);

  const ok = timed('windows compile + bundle', () => runTauri(...buildArgs).ok);
  if (!ok) {
    failures.push('windows: the Tauri build command failed');
  } else {
    const releaseDirs = [
      path.join(ctx.targetDir, 'release'),
      path.join(ctx.targetDir, 'x86_64-pc-windows-msvc', 'release'),
      path.join(ctx.targetDir, 'x86_64-pc-windows-gnu', 'release'),
      path.join(ctx.targetDir, 'aarch64-pc-windows-msvc', 'release')
    ].filter(fsx.isDir);

    let exe = null;
    let setup = null;
    for (const dir of releaseDirs) {
      // Only the top level holds the app binary; bundles live in bundle/.
      if (!exe) {
        exe = findFreshFile(dir, (name, full) =>
          name.endsWith('.exe') &&
          !name.toLowerCase().includes('setup') &&
          path.dirname(full) === dir, true);
      }
      if (!setup) {
        const nsis = path.join(dir, 'bundle', 'nsis');
        if (fsx.isDir(nsis)) setup = findFreshFile(nsis, (name) => name.endsWith('.exe'), true);
      }
    }

    if (opts.installerOnly) {
      // The raw binary is not shippable on its own anyway - it needs the
      // WebView2 bootstrapper and the sidecar files the installer lays down.
      log('Installer-only: the bare app.exe is not published for this build.');
      if (!exe) failures.push('windows: no freshly built .exe was found');
    } else if (exe) {
      const dest = path.join(outDir, 'windows', 'app.exe');
      fs.copyFileSync(exe, dest);
      results.windows = dest;
      logSuccess(`Windows executable: ${dest}`);
    } else {
      failures.push('windows: no freshly built .exe was found');
    }

    if (setup) {
      const dest = path.join(outDir, 'windows', 'tripo-setup.exe');
      fs.copyFileSync(setup, dest);
      results.windowsSetup = dest;
      logSuccess(`Windows installer: ${dest}`);
    } else if (opts.installer) {
      logWarn('No NSIS installer was produced (only the raw executable is available).');
    }
  }
}

/* ---------------------------- macOS ------------------------------ */

if (opts.mac) {
  log('=== macOS ===');
  const ok = runTauri('build', ...cfg).ok;
  const bundleDir = path.join(ctx.targetDir, 'release', 'bundle');
  if (ok && fsx.isDir(bundleDir)) {
    const destMac = path.join(outDir, 'mac');
    for (const sub of ['dmg', 'macos']) {
      const from = path.join(bundleDir, sub);
      if (fsx.isDir(from)) fsx.copyPath(from, path.join(destMac, sub));
    }
    if (fsx.hasFiles(destMac)) {
      const dmg = fsx.walkFiles(destMac).find((f) => f.endsWith('.dmg'));
      results.mac = dmg || destMac;
      logSuccess(`macOS bundle: ${results.mac}`);
    } else {
      failures.push('macos: the build produced no bundle files');
    }
  } else {
    failures.push('macos: the Tauri build command failed');
  }
}

/* ----------------------------- iOS ------------------------------- */

if (opts.ios) {
  log('=== iOS ===');
  let ok = runTauri('ios', 'build', ...cfg).ok;
  if (!ok) {
    runTauri('ios', 'init', '--ci', ...cfg);
    ok = runTauri('ios', 'build', ...cfg).ok;
  }
  const iosBuildDir = path.join(P.ROOT, 'src-tauri', 'gen', 'apple', 'build');
  if (ok && fsx.hasFiles(iosBuildDir)) {
    const destIos = path.join(outDir, 'ios');
    fsx.copyPath(iosBuildDir, destIos);
    const ipa = fsx.walkFiles(destIos).find((f) => f.endsWith('.ipa'));
    results.ios = ipa || destIos;
    logSuccess(`iOS package: ${results.ios}`);
  } else {
    failures.push('ios: the build produced no package');
  }
}

/* ---------------------------- Summary ---------------------------- */

// windowsSetup counts as a Windows result in its own right: --installer-only
// deliberately publishes the setup and no app.exe, and that is a success, not
// a build that produced nothing.
const produced = ['android', 'windows', 'windowsSetup', 'mac', 'ios'].filter((k) => results[k]);

if (produced.length > 0) promoteBaseline();

// A machine-readable summary so the server does not have to guess what exists.
fsx.writeJson(path.join(outDir, 'build-result.json'), {
  mode: opts.mode,
  host: `${process.platform}-${process.arch}`,
  requested: { android: opts.android, windows: opts.exe, mac: opts.mac, ios: opts.ios },
  artifacts: results,
  failures,
  timings: phaseTimings,
  finishedAt: new Date().toISOString()
});

if (phaseTimings.length > 0) {
  const total = phaseTimings.reduce((sum, t) => sum + t.seconds, 0);
  log(`Time breakdown: ${phaseTimings.map((t) => `${t.phase} ${t.seconds}s`).join(' | ')} (total ${total.toFixed(1)}s)`);
}

if (overrideFile) fsx.rmrf(overrideFile);

for (const failure of failures) logWarn(failure);

if (produced.length === 0) {
  logError('No build target completed successfully.');
  process.exit(1);
}

logSuccess(`Build finished - ${produced.length} target(s) produced: ${produced.join(', ')}`);
if (failures.length > 0) {
  logWarn(`${failures.length} target(s) did not complete; see the warnings above.`);
}
