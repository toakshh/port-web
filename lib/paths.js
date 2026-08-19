'use strict';

/**
 * Single source of truth for every path the project uses.
 *
 * Everything is derived from this file's own location, so the project works
 * from any checkout directory, on any OS, regardless of the current working
 * directory the process was started from. Each location can still be
 * overridden with an environment variable for containerised / cloud runs.
 */

const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

function fromEnv(envName, fallback) {
  const raw = process.env[envName];
  if (!raw || !raw.trim()) return fallback;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ROOT, raw);
}

/** Committed baseline web build - the "common file data" shared by every app. */
const BASELINE_DIST = fromEnv('BASELINE_DIST', path.join(ROOT, 'dist'));

/** Scratch area that is never committed. */
const WORKSPACE = fromEnv('BUILD_WORKSPACE', path.join(ROOT, '.build-workspace'));

module.exports = {
  ROOT,
  BASELINE_DIST,
  WORKSPACE,
  /** What Tauri actually compiles (see tauri.conf.json -> build.frontendDist). */
  WORKSPACE_DIST: path.join(WORKSPACE, 'dist'),
  /** Per-run icon set, so a custom logo never leaks into the next build. */
  WORKSPACE_ICONS: path.join(WORKSPACE, 'icons'),
  /** Remembers what the last build produced, to decide what can be skipped. */
  STATE_FILE: path.join(WORKSPACE, 'state.json'),
  SRC_TAURI: path.join(ROOT, 'src-tauri'),
  TAURI_CONF: path.join(ROOT, 'src-tauri', 'tauri.conf.json'),
  TAURI_TARGET: path.join(ROOT, 'src-tauri', 'target'),
  GEN_ANDROID: path.join(ROOT, 'src-tauri', 'gen', 'android'),
  DEFAULT_ICONS: path.join(ROOT, 'src-tauri', 'icons'),
  DIST_BUILDS: fromEnv('DIST_BUILDS', path.join(ROOT, 'dist-builds')),
  UPLOADS: fromEnv('UPLOADS_DIR', path.join(ROOT, 'uploads')),
  JOBS: fromEnv('JOBS_DIR', path.join(ROOT, 'jobs')),
  PUBLIC: path.join(ROOT, 'public'),
  HOME: os.homedir(),
  /** Path, relative to the uploaded ZIP root, that Fast mode swaps. */
  SWAP_SUBPATH: path.join('static', 'files')
};
