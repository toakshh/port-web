'use strict';

/**
 * Optional Windows -> WSL build delegation.
 *
 * Tauri needs a native Rust toolchain. When a Windows host has no native
 * `cargo` but a WSL distro does, the whole build can be re-run inside WSL
 * instead of failing. This is strictly a fallback: on Linux and macOS nothing
 * here is ever touched, and on Windows it is skipped when native Rust exists.
 *
 * Delegation is only attempted when BOTH a usable `node` and `cargo` are
 * proven to exist inside WSL - never assumed.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

function wslExec(command, { timeout = 30000 } = {}) {
  const res = spawnSync('wsl.exe', ['bash', '-lc', command], {
    encoding: 'utf8',
    timeout,
    windowsHide: true
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim()
  };
}

function available() {
  if (!IS_WIN) return false;
  const res = spawnSync('wsl.exe', ['-e', 'true'], { timeout: 20000, windowsHide: true });
  return res.status === 0;
}

/** Locate a Node.js binary inside the WSL distro, including interop fallbacks. */
function findWslNode() {
  const probe = [
    'command -v node',
    'command -v nodejs',
    'ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1',
    'ls -1 /usr/local/bin/node /usr/bin/node 2>/dev/null | head -1'
  ].join(' || ');
  const res = wslExec(probe);
  const found = res.ok && res.stdout ? res.stdout.split('\n').pop().trim() : null;
  // A Windows node.exe reached through interop would spawn Windows cargo again,
  // defeating the whole point of delegating - only a Linux binary is usable.
  if (!found || found.startsWith('/mnt/') || found.toLowerCase().endsWith('.exe')) return null;
  return found;
}

function findWslCargo() {
  const res = wslExec('command -v cargo || ls -1 "$HOME"/.cargo/bin/cargo 2>/dev/null');
  return res.ok && res.stdout ? res.stdout.split('\n')[0].trim() : null;
}

/** Convert a Windows path to its WSL equivalent (/mnt/e/...). */
function toWslPath(winPath) {
  const res = spawnSync('wsl.exe', ['wslpath', '-a', winPath.split('\\').join('/')], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  });
  if (res.status !== 0) return null;
  return (res.stdout || '').trim();
}

/**
 * Describe whether this build can be delegated to WSL.
 * Returns `{ usable, node, cargo, root, reason }`.
 */
function inspect(rootDir) {
  if (!IS_WIN) return { usable: false, reason: 'not a Windows host' };
  if (!available()) return { usable: false, reason: 'WSL is not installed or not running' };

  const node = findWslNode();
  if (!node) {
    return {
      usable: false,
      reason: 'WSL has no Node.js runtime (install it with: wsl -- sudo apt-get install -y nodejs)'
    };
  }

  const cargo = findWslCargo();
  if (!cargo) return { usable: false, reason: 'WSL has no Rust/cargo toolchain' };

  const root = toWslPath(rootDir);
  if (!root) return { usable: false, reason: 'could not translate the project path into WSL' };

  return { usable: true, node, cargo, root };
}

/** Shell-quote for the bash command line used inside WSL. */
function shQuote(value) {
  return `'${String(value).split("'").join(`'"'"'`)}'`;
}

/**
 * Re-run `build.js` inside WSL with the same arguments.
 * Returns the child exit status.
 */
function delegateBuild(rootDir, argv, { log = console.log } = {}) {
  const info = inspect(rootDir);
  if (!info.usable) return { ok: false, delegated: false, reason: info.reason };

  const cargoBin = path.posix.dirname(info.cargo);
  const inner = [
    `cd ${shQuote(info.root)}`,
    `export PATH=${shQuote(cargoBin)}:"$PATH"`,
    [shQuote(info.node), shQuote('build.js'), ...argv.map(shQuote)].join(' ')
  ].join(' && ');

  log(`No native Rust toolchain on Windows - delegating the build to WSL (${info.root}).`);
  const res = spawnSync('wsl.exe', ['bash', '-lc', inner], { stdio: 'inherit', windowsHide: true });
  return { ok: res.status === 0, delegated: true, status: res.status };
}

module.exports = { available, inspect, delegateBuild, toWslPath, findWslNode, findWslCargo };
