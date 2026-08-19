'use strict';

/**
 * Zero-dependency npm bootstrapper.
 *
 * Required by server.js / build.js BEFORE any third-party `require()` so that a
 * fresh `git clone` on any OS can run without a manual `npm install`, and so a
 * partially-installed `node_modules` (the classic npm optional-dependency bug)
 * repairs itself instead of crashing.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

function log(msg) {
  console.log(`[deps] ${msg}`);
}

/** True when `name` can be resolved from the project root. */
function isInstalled(name, rootDir = ROOT) {
  try {
    require.resolve(name, { paths: [rootDir] });
    return true;
  } catch (_) {
    // Packages without a resolvable main entry (native binding stubs, CLI-only
    // packages) still count as installed when their directory is present.
    return fs.existsSync(path.join(rootDir, 'node_modules', ...name.split('/')));
  }
}

function runNpm(args, { rootDir = ROOT, allowFailure = true } = {}) {
  const full = [...args, '--no-audit', '--no-fund'];
  // On Windows npm is a .cmd shim, which modern Node refuses to spawn directly;
  // going through cmd.exe avoids that without enabling shell interpolation.
  const [cmd, argv] = IS_WIN ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...full]] : ['npm', full];

  const res = spawnSync(cmd, argv, { cwd: rootDir, stdio: 'inherit', windowsHide: true });
  if (res.status === 0) return true;

  const reason = res.error ? res.error.message : `exit code ${res.status}`;
  if (!allowFailure) throw new Error(`npm ${args.join(' ')} failed: ${reason}`);
  log(`npm ${args.join(' ')} failed: ${reason}`);
  return false;
}

/**
 * Make sure every package in `names` is importable, installing what is missing.
 * Returns the list of packages that were (re)installed.
 */
function ensureDeps(names, { rootDir = ROOT, optional = false } = {}) {
  const wanted = Array.isArray(names) ? names : [names];
  let missing = wanted.filter((n) => !isInstalled(n, rootDir));
  if (missing.length === 0) return [];

  log(`missing package(s): ${missing.join(', ')} - installing automatically...`);

  // Anything declared in package.json is best installed via a plain `npm install`
  // so the lockfile and declared version ranges are respected.
  let declared = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const declaredSet = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {})
    ]);
    declared = missing.filter((n) => declaredSet.has(n));
  } catch (_) {}

  if (declared.length > 0) {
    runNpm(['install']);
    missing = missing.filter((n) => !isInstalled(n, rootDir));
  }

  if (missing.length > 0) {
    const flags = optional ? ['--no-save', '--force'] : ['--no-save'];
    runNpm(['install', ...missing, ...flags]);
    missing = missing.filter((n) => !isInstalled(n, rootDir));
  }

  if (missing.length > 0 && !optional) {
    throw new Error(
      `Could not install required package(s): ${missing.join(', ')}. ` +
        `Run "npm install" in ${rootDir} and retry.`
    );
  }

  return wanted.filter((n) => isInstalled(n, rootDir));
}

module.exports = { ensureDeps, isInstalled, runNpm, ROOT };
