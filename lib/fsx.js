'use strict';

/** Cross-platform filesystem helpers shared by the build script and the server. */

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Delete everything *inside* a directory but keep the directory itself.
 *
 * This is not the same as remove-and-recreate. In Docker, several of these
 * directories are volume mount points (src-tauri/target, dist, jobs), and a
 * mount point cannot be rmdir'd - the kernel fails it with EBUSY no matter
 * what permissions the process has. Clearing the contents works on a mount
 * point and on an ordinary directory alike.
 */
function clearDir(dir) {
  if (!isDir(dir)) return ensureDir(dir);
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  return dir;
}

function emptyDir(dir) {
  return clearDir(dir);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/** Recursively copy a file or directory. Replaces whatever is at `dest`. */
function copyPath(src, dest) {
  if (!fs.existsSync(src)) return false;
  const stats = fs.lstatSync(src);
  if (stats.isDirectory()) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src)) {
      copyPath(path.join(src, entry), path.join(dest, entry));
    }
  } else if (stats.isSymbolicLink()) {
    // Materialise symlinks as real files; Windows checkouts cannot follow them.
    const resolved = fs.realpathSync(src);
    if (fs.existsSync(resolved)) copyPath(resolved, dest);
  } else {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
  return true;
}

const MTIME_TOLERANCE_MS = 2000; // FAT/network filesystems round timestamps.

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.size === sb.size && Math.abs(sa.mtimeMs - sb.mtimeMs) <= MTIME_TOLERANCE_MS;
  } catch (_) {
    return false;
  }
}

/**
 * Mirror `src` into `dest`, copying only what actually changed and (by default)
 * deleting anything in `dest` that no longer exists in `src`.
 *
 * This is what keeps Fast mode fast: the 50 MB+ baseline is only copied once,
 * subsequent runs touch just the files that differ.
 */
function syncDir(src, dest, { del = true } = {}) {
  const stats = { copied: 0, skipped: 0, removed: 0 };
  if (!isDir(src)) return stats;
  ensureDir(dest);

  const srcEntries = fs.readdirSync(src, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));

  if (del && fs.existsSync(dest)) {
    for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
      if (!srcNames.has(entry.name)) {
        rmrf(path.join(dest, entry.name));
        stats.removed++;
      }
    }
  }

  for (const entry of srcEntries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (isFile(to)) rmrf(to);
      const sub = syncDir(from, to, { del });
      stats.copied += sub.copied;
      stats.skipped += sub.skipped;
      stats.removed += sub.removed;
    } else {
      if (isDir(to)) rmrf(to);
      if (sameFile(from, to)) {
        stats.skipped++;
      } else {
        ensureDir(path.dirname(to));
        fs.copyFileSync(from, to);
        stats.copied++;
      }
    }
  }
  return stats;
}

/** True when the directory exists and contains at least one regular file. */
function hasFiles(dir) {
  if (!isDir(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasFiles(path.join(dir, entry.name))) return true;
  }
  return false;
}

/** Depth-first walk yielding absolute file paths. */
function walkFiles(dir, out = []) {
  if (!isDir(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Extract a ZIP, rejecting entries that would escape `destDir` ("zip slip").
 * `AdmZip` is injected so this module stays dependency-free.
 */
function safeExtractZip(AdmZip, zipPath, destDir) {
  ensureDir(destDir);
  const resolvedDest = path.resolve(destDir);
  const zip = new AdmZip(zipPath);
  let extracted = 0;

  for (const entry of zip.getEntries()) {
    // Normalise separators; ZIPs always use forward slashes.
    const rawName = entry.entryName.split('\\').join('/');
    if (rawName.startsWith('/') || /^[a-zA-Z]:/.test(rawName)) {
      throw new Error(`Refusing absolute path in archive: ${rawName}`);
    }
    const target = path.resolve(resolvedDest, rawName);
    const rel = path.relative(resolvedDest, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Refusing path traversal entry in archive: ${rawName}`);
    }
    if (entry.isDirectory) {
      ensureDir(target);
      continue;
    }
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, entry.getData());
    extracted++;
  }

  if (extracted === 0) throw new Error('Archive contained no files');
  return extracted;
}

/**
 * Hoist the real web root to `dir` when the ZIP wrapped it in one or more
 * folders (the usual `build/`, `dist/`, `my-app/build/` shapes).
 */
function normalizeWebRoot(dir) {
  const hasIndex = () => isFile(path.join(dir, 'index.html'));

  // Peel single-child wrapper directories.
  for (let guard = 0; guard < 16 && !hasIndex(); guard++) {
    const entries = fs.readdirSync(dir).filter((n) => n !== '__MACOSX');
    if (entries.length !== 1) break;
    const only = path.join(dir, entries[0]);
    if (!isDir(only)) break;
    for (const item of fs.readdirSync(only)) {
      fs.renameSync(path.join(only, item), path.join(dir, item));
    }
    rmrf(only);
  }
  if (hasIndex()) return dir;

  // Otherwise search for the shallowest index.html and hoist its folder.
  let best = null;
  let bestDepth = Infinity;
  const visit = (current, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === 'index.html') {
        if (depth < bestDepth) {
          best = current;
          bestDepth = depth;
        }
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '__MACOSX') {
        visit(path.join(current, entry.name), depth + 1);
      }
    }
  };
  visit(dir, 0);

  if (best && best !== dir) {
    for (const item of fs.readdirSync(best)) {
      const from = path.join(best, item);
      const to = path.join(dir, item);
      rmrf(to);
      fs.renameSync(from, to);
    }
  }
  return dir;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Directory size in bytes (best effort). */
function dirSize(dir) {
  return walkFiles(dir).reduce((total, file) => {
    try {
      return total + fs.statSync(file).size;
    } catch (_) {
      return total;
    }
  }, 0);
}

module.exports = {
  ensureDir,
  rmrf,
  clearDir,
  emptyDir,
  isDir,
  isFile,
  copyPath,
  syncDir,
  hasFiles,
  walkFiles,
  safeExtractZip,
  normalizeWebRoot,
  readJson,
  writeJson,
  dirSize
};
