'use strict';

/**
 * Minimal `.env` loader.
 *
 * Docker Compose already substitutes `.env` into `docker-compose.yml`, but a
 * bare `npm start` does not, so the same secrets would only work in one of the
 * two ways this service is run. This closes that gap without pulling in a
 * dependency, and never overwrites a variable the environment already set -
 * a real environment variable always wins over the file.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnv(file = path.join(ROOT, '.env')) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return 0;
  }

  let applied = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
    applied++;
  }
  return applied;
}

module.exports = { loadEnv };
