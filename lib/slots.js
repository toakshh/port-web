'use strict';

/**
 * Build slots - isolation for concurrent builds.
 *
 * Two jobs cannot share a project directory: they would overwrite each other's
 * staged web assets and each other's generated Android project. A slot is a
 * self-contained copy of the project that one job owns for its duration:
 *
 *   .build-workspace/slots/<n>/
 *     package.json          copied, so the Tauri CLI's version check works
 *     src-tauri/            source synced from the repo each time
 *       tauri.conf.json     rewritten to point at this slot's dist/
 *       gen/                this slot's generated Android project (persistent)
 *     dist/                 web assets staged for the job using this slot
 *     icons/                icon set generated for the job using this slot
 *
 * The Rust **target directory is deliberately shared** across slots via
 * CARGO_TARGET_DIR. Cargo takes a file lock on it, so concurrent compiles are
 * serialised rather than corrupted, and every slot inherits the same warm
 * dependency cache instead of paying a multi-minute cold build on first use.
 * Only the `app` crate is rebuilt per job - which happens on every job anyway,
 * because the web assets are embedded in it.
 *
 * Everything that is NOT cargo - staging, Gradle, NSIS, signing, packaging -
 * runs fully in parallel, which is most of a build's wall clock.
 */

const fs = require('fs');
const path = require('path');

const P = require('./paths');
const fsx = require('./fsx');

const SLOTS_ROOT = path.join(P.WORKSPACE, 'slots');

/** Source files copied into a slot. `target/` and `gen/` are never copied. */
const SRC_TAURI_ENTRIES = [
  'Cargo.toml',
  'Cargo.lock',
  'build.rs',
  'src',
  'icons',
  'capabilities',
  '.gitignore'
];

function slotDir(id) {
  return path.join(SLOTS_ROOT, String(id));
}

/**
 * Create or refresh a slot so it mirrors the current project sources.
 * Returns the paths a build should use.
 */
function prepareSlot(id) {
  const dir = fsx.ensureDir(slotDir(id));
  const srcTauri = fsx.ensureDir(path.join(dir, 'src-tauri'));

  // Sync the crate sources. gen/ and target/ live inside the slot and are
  // owned by it, so they are never touched by this sync.
  for (const entry of SRC_TAURI_ENTRIES) {
    const from = path.join(P.SRC_TAURI, entry);
    const to = path.join(srcTauri, entry);
    if (!fs.existsSync(from)) continue;
    if (fsx.isDir(from)) fsx.syncDir(from, to);
    else fs.copyFileSync(from, to);
  }

  // The slot's config points at the slot's own staged assets.
  const conf = fsx.readJson(P.TAURI_CONF);
  if (!conf) throw new Error(`Cannot read ${P.TAURI_CONF}`);
  conf.build = { ...(conf.build || {}), frontendDist: '../dist' };
  delete conf.$schema; // relative to the repo's node_modules; meaningless here
  fsx.writeJson(path.join(srcTauri, 'tauri.conf.json'), conf);

  // The CLI reads package.json to check for mismatched tauri versions.
  const pkg = fsx.readJson(path.join(P.ROOT, 'package.json'));
  if (pkg) fsx.writeJson(path.join(dir, 'package.json'), pkg);

  return context(dir);
}

/** The set of paths a build uses for a given project directory. */
function context(projectDir) {
  const srcTauri = path.join(projectDir, 'src-tauri');
  return {
    projectDir,
    srcTauri,
    tauriConf: path.join(srcTauri, 'tauri.conf.json'),
    distDir: path.join(projectDir, 'dist'),
    iconsDir: path.join(projectDir, 'icons'),
    genAndroid: path.join(srcTauri, 'gen', 'android'),
    // Shared on purpose - see the note at the top of this file.
    targetDir: P.TAURI_TARGET
  };
}

/** The default (non-slot) context: build straight from the repository. */
function repoContext() {
  return {
    projectDir: P.ROOT,
    srcTauri: P.SRC_TAURI,
    tauriConf: P.TAURI_CONF,
    distDir: P.WORKSPACE_DIST,
    iconsDir: P.WORKSPACE_ICONS,
    genAndroid: P.GEN_ANDROID,
    targetDir: P.TAURI_TARGET
  };
}

/* ------------------------------------------------------------------ *
 * Pool
 * ------------------------------------------------------------------ */

/**
 * A fixed pool of slot ids. Jobs acquire one for their duration; when all are
 * busy, callers wait. Keeping the pool fixed is what bounds disk use and stops
 * an unbounded number of Gradle/Rust processes from thrashing the machine.
 */
function createPool(size) {
  const total = Math.max(1, Number(size) || 1);
  const free = Array.from({ length: total }, (_, i) => i + 1);
  const waiting = [];

  return {
    size: total,
    get available() {
      return free.length;
    },
    get busy() {
      return total - free.length;
    },
    /** Resolves with a slot id once one is free. */
    acquire() {
      if (free.length > 0) return Promise.resolve(free.shift());
      return new Promise((resolve) => waiting.push(resolve));
    },
    release(id) {
      if (id == null) return;
      const next = waiting.shift();
      if (next) next(id);
      else if (!free.includes(id)) free.push(id);
    }
  };
}

/** Remove every slot directory (used by tooling, never mid-build). */
function purge() {
  fsx.rmrf(SLOTS_ROOT);
}

module.exports = { SLOTS_ROOT, slotDir, prepareSlot, context, repoContext, createPool, purge };
