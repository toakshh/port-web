'use strict';

/**
 * Build-duration estimation.
 *
 * Every finished build records how long it actually took, keyed by mode, target
 * set and whether the Rust cache was warm. Estimates are the median of recent
 * matching runs, so they get more accurate the more this host is used. Built-in
 * defaults only cover the very first builds, before any history exists.
 */

const fs = require('fs');
const path = require('path');

const P = require('./paths');
const fsx = require('./fsx');

const STATS_FILE = path.join(P.WORKSPACE, 'build-stats.json');
const MAX_SAMPLES_PER_KEY = 12;
const SAMPLES_FOR_FULL_TRUST = 3;

/**
 * Bumped whenever a change to the pipeline invalidates recorded history.
 * Version 2: the tuned Cargo profile, NSIS-only bundling, zlib compression and
 * single-ABI fast Android builds made every earlier sample far too pessimistic.
 */
const STATS_VERSION = 2;

/** Rough per-target seconds, used only until this host has recorded real runs. */
const DEFAULT_TARGET_SECONDS = {
  fast: { android: 45, windows: 14, mac: 20, ios: 60 },
  clean: { android: 300, windows: 130, mac: 180, ios: 360 }
};

/** Fixed overhead: upload extraction, asset staging, signing, packaging. */
const BASE_OVERHEAD_SECONDS = 5;

/** A cold cache makes even a fast build pay full compilation cost. */
const COLD_CACHE_PENALTY = { fast: 6, clean: 1 };

function normalizeTargets(targets) {
  const canonical = (targets || []).map((t) => {
    if (t === 'exe' || t === 'windows') return 'windows';
    if (t === 'dmg' || t === 'mac') return 'mac';
    return t;
  });
  return [...new Set(canonical)].filter((t) => t in DEFAULT_TARGET_SECONDS.clean).sort();
}

function readStats() {
  const empty = { version: STATS_VERSION, samples: {} };
  const stored = fsx.readJson(STATS_FILE, empty);
  // History from an older, slower pipeline would make every estimate wrong.
  if (!stored || stored.version !== STATS_VERSION) return empty;
  return stored;
}

function writeStats(stats) {
  try {
    fsx.writeJson(STATS_FILE, stats);
  } catch (_) {
    /* estimation is a convenience - never fail a build over it */
  }
}

function keyFor(mode, targets, cacheWarm) {
  return `${mode}|${normalizeTargets(targets).join('+') || 'none'}|${cacheWarm ? 'warm' : 'cold'}`;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** True when a previous build left a Rust compilation cache behind. */
function isCacheWarm() {
  return fsx.isDir(P.TAURI_TARGET) && fsx.hasFiles(P.TAURI_TARGET);
}

function defaultSeconds(mode, targets, cacheWarm) {
  const table = DEFAULT_TARGET_SECONDS[mode] || DEFAULT_TARGET_SECONDS.clean;
  const sum = normalizeTargets(targets).reduce((total, t) => total + (table[t] || 120), 0);
  const penalty = cacheWarm ? 1 : COLD_CACHE_PENALTY[mode] || 1;
  return Math.round(sum * penalty + BASE_OVERHEAD_SECONDS);
}

/**
 * Estimated duration in seconds for one build.
 * Returns `{ seconds, basis, samples, cacheWarm }`.
 */
function estimate({ mode = 'fast', targets = [], cacheWarm = isCacheWarm() } = {}) {
  const normalized = normalizeTargets(targets);
  const fallback = defaultSeconds(mode, normalized, cacheWarm);
  if (normalized.length === 0) return { seconds: BASE_OVERHEAD_SECONDS, basis: 'no targets', samples: 0, cacheWarm };

  const stats = readStats();
  const exact = stats.samples[keyFor(mode, normalized, cacheWarm)] || [];
  const anyCache = exact.length
    ? exact
    : [
        ...(stats.samples[keyFor(mode, normalized, true)] || []),
        ...(stats.samples[keyFor(mode, normalized, false)] || [])
      ];

  const observed = median(anyCache);
  if (observed == null) {
    return { seconds: fallback, basis: 'estimate', samples: 0, cacheWarm };
  }

  // With only one or two samples, blend towards the default so a single
  // outlier (a machine hiccup, a network stall) does not skew the estimate.
  const count = anyCache.length;
  const weight = Math.min(count, SAMPLES_FOR_FULL_TRUST) / SAMPLES_FOR_FULL_TRUST;
  const seconds = Math.round(observed * weight + fallback * (1 - weight));

  return {
    seconds,
    basis: count >= SAMPLES_FOR_FULL_TRUST ? 'measured' : 'partly measured',
    samples: count,
    cacheWarm
  };
}

/** Estimates for both modes at once - what the dashboard shows after an upload. */
function estimateBothModes(targets) {
  const cacheWarm = isCacheWarm();
  return {
    targets: normalizeTargets(targets),
    cacheWarm,
    fast: estimate({ mode: 'fast', targets, cacheWarm }),
    // A clean build always starts from a purged cache, by definition.
    clean: estimate({ mode: 'clean', targets, cacheWarm: false })
  };
}

/** Record a finished build so future estimates improve. */
function record({ mode, targets, cacheWarm, durationMs }) {
  if (!durationMs || durationMs <= 0) return;
  const seconds = Math.round(durationMs / 1000);
  // Ignore absurd values (a machine suspended mid-build would poison the median).
  if (seconds < 2 || seconds > 6 * 3600) return;

  const stats = readStats();
  const key = keyFor(mode, targets, cacheWarm);
  const list = stats.samples[key] || [];
  list.push(seconds);
  stats.samples[key] = list.slice(-MAX_SAMPLES_PER_KEY);
  stats.version = STATS_VERSION;
  stats.updatedAt = new Date().toISOString();
  writeStats(stats);
}

/** "2m 30s" / "45s" - shared by the CLI and the API. */
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

module.exports = {
  estimate,
  estimateBothModes,
  record,
  isCacheWarm,
  formatDuration,
  normalizeTargets,
  STATS_FILE
};
