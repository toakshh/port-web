#!/usr/bin/env node
'use strict';

/**
 * `npm test` - exercises everything that must work identically on every OS,
 * without needing a Rust toolchain, a JDK or an Android SDK.
 *
 * Covers: path portability, fast/clean staging semantics, the zip-slip guard,
 * ZIP-root normalisation, the download path-traversal guard, and the live HTTP
 * API (health, upload validation, job lifecycle).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const P = require('../lib/paths');
const fsx = require('../lib/fsx');
const tc = require('../lib/toolchain');
require('../lib/ensure-deps').ensureDeps(['adm-zip']);
const AdmZip = require('adm-zip');

let passed = 0;
let failed = 0;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tripo-selftest-'));

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

const tmp = (...parts) => path.join(sandbox, ...parts);

function writeFile(file, content) {
  fsx.ensureDir(path.dirname(file));
  fs.writeFileSync(file, content);
  return file;
}

/**
 * Assemble a ZIP archive byte by byte (stored, no compression) so entry names
 * survive verbatim - zip libraries sanitise names on the way in, which would
 * defeat the point of a zip-slip test.
 */
function makeRawZip(entries) {
  const { crc32 } = require('zlib');
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ */

async function testPaths() {
  console.log('\npaths');

  await test('every path is absolute and rooted in the project', () => {
    for (const key of ['ROOT', 'BASELINE_DIST', 'WORKSPACE', 'DIST_BUILDS', 'JOBS', 'UPLOADS']) {
      assert.ok(path.isAbsolute(P[key]), `${key} is not absolute`);
    }
    assert.strictEqual(path.resolve(P.ROOT, 'dist'), P.BASELINE_DIST);
  });

  await test('paths do not depend on the current working directory', () => {
    const res = tc.runCapture(
      [process.execPath, '-e', 'process.stdout.write(require(process.argv[1]).ROOT)', path.join(P.ROOT, 'lib', 'paths.js')],
      { cwd: os.tmpdir() }
    );
    assert.ok(res.ok, res.stderr);
    assert.strictEqual(res.stdout.trim(), P.ROOT);
  });

  await test('no absolute machine-specific path is hard-coded in the sources', () => {
    const sources = [
      path.join(P.ROOT, 'server.js'),
      path.join(P.ROOT, 'build.js'),
      ...fsx.walkFiles(path.join(P.ROOT, 'lib')),
      ...fsx.walkFiles(path.join(P.ROOT, 'scripts'))
    ].filter((f) => f.endsWith('.js'));

    const offenders = [];
    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8');
      // A user's home directory baked into the source is the exact class of bug
      // that made this project machine-specific.
      for (const pattern of [/\/home\/[a-z0-9_-]+\//i, /C:\\+Users\\+(?!<)[A-Za-z0-9_-]+\\+/]) {
        if (pattern.test(text)) offenders.push(`${path.relative(P.ROOT, file)} :: ${text.match(pattern)[0]}`);
      }
    }
    assert.deepStrictEqual(offenders, [], `hard-coded paths found: ${offenders.join(', ')}`);
  });
}

async function testFsx() {
  console.log('\nfsx');

  await test('syncDir copies, skips unchanged files and removes extras', () => {
    const src = tmp('sync-src');
    const dst = tmp('sync-dst');
    writeFile(path.join(src, 'a.txt'), 'a');
    writeFile(path.join(src, 'nested', 'b.txt'), 'b');

    let stats = fsx.syncDir(src, dst);
    assert.strictEqual(stats.copied, 2);
    assert.strictEqual(fs.readFileSync(path.join(dst, 'nested', 'b.txt'), 'utf8'), 'b');

    stats = fsx.syncDir(src, dst);
    assert.strictEqual(stats.copied, 0, 'second sync should copy nothing');
    assert.strictEqual(stats.skipped, 2);

    writeFile(path.join(dst, 'stale.txt'), 'stale');
    stats = fsx.syncDir(src, dst);
    assert.strictEqual(stats.removed, 1);
    assert.ok(!fs.existsSync(path.join(dst, 'stale.txt')));
  });

  await test('safeExtractZip refuses to write outside the destination', () => {
    // adm-zip sanitises names passed to addFile(), so the hostile archive has
    // to be assembled byte by byte to reproduce a real "zip slip" payload.
    const zipPath = writeFile(
      tmp('evil.zip'),
      makeRawZip([
        { name: 'index.html', data: Buffer.from('<html></html>') },
        { name: '../../escaped.txt', data: Buffer.from('pwned') }
      ])
    );

    const out = tmp('nest', 'evil-out');
    let threw = false;
    try {
      fsx.safeExtractZip(AdmZip, zipPath, out);
    } catch (err) {
      threw = true;
      assert.match(err.message, /traversal|absolute/i);
    }
    assert.ok(!fs.existsSync(tmp('escaped.txt')), 'the traversal entry escaped the destination');
    assert.ok(!fs.existsSync(tmp('nest', 'escaped.txt')), 'the traversal entry escaped the destination');
    assert.ok(threw, 'a hostile archive should be rejected, not silently rewritten');
  });

  await test('safeExtractZip extracts a well-formed archive', () => {
    const zipPath = tmp('good.zip');
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html></html>'));
    zip.addFile('static/files/masterData.json', Buffer.from('{}'));
    zip.writeZip(zipPath);

    const out = tmp('good-out');
    const count = fsx.safeExtractZip(AdmZip, zipPath, out);
    assert.strictEqual(count, 2);
    assert.ok(fsx.isFile(path.join(out, 'static', 'files', 'masterData.json')));
  });

  await test('normalizeWebRoot hoists a nested build folder', () => {
    const dir = tmp('nested');
    writeFile(path.join(dir, 'my-app', 'build', 'index.html'), '<html></html>');
    writeFile(path.join(dir, 'my-app', 'build', 'static', 'files', 'a.glb'), 'x');
    fsx.normalizeWebRoot(dir);
    assert.ok(fsx.isFile(path.join(dir, 'index.html')), 'index.html should be hoisted to the root');
    assert.ok(fsx.isFile(path.join(dir, 'static', 'files', 'a.glb')));
  });
}

async function testToolchain() {
  console.log('\ntoolchain');

  await test('which() finds the running node executable', () => {
    const found = tc.which(process.platform === 'win32' ? 'node' : 'node');
    assert.ok(found, 'node should be discoverable on PATH');
  });

  await test('a Tauri CLI native package is mapped for this platform', () => {
    const pkg = tc.tauriNativePackage();
    assert.ok(pkg && pkg.startsWith('@tauri-apps/cli-'), `no mapping for ${process.platform}-${process.arch}`);
  });

  await test('commands run correctly from a path containing spaces', () => {
    const dir = fsx.ensureDir(tmp('dir with spaces'));
    // %~1 strips the quotes cmd keeps around an argument; the point of the test
    // is that the value survives a path with spaces, not how cmd quotes it.
    const script = process.platform === 'win32'
      ? writeFile(path.join(dir, 'echo test.cmd'), '@echo off\r\necho hello %~1\r\n')
      : writeFile(path.join(dir, 'echo test.sh'), '#!/bin/sh\necho "hello $1"\n');
    if (process.platform !== 'win32') fs.chmodSync(script, 0o755);

    const res = tc.runCapture([script, 'big world']);
    assert.ok(res.ok, `command failed: ${res.stderr}`);
    assert.match(res.stdout, /hello big world/);
  });

  await test('.bat and .cmd wrappers are spawnable (Android SDK ships them)', () => {
    if (process.platform !== 'win32') return; // nothing to prove off Windows
    // Node refuses to spawn .cmd/.bat directly since the CVE-2024-27980 fix;
    // apksigner.bat is one of these, so signing breaks without the wrapper.
    const script = writeFile(tmp('probe.cmd'), '@echo off\r\necho batch-ok\r\n');
    const res = tc.runCapture([script]);
    assert.ok(res.ok, `spawning a .cmd failed: ${res.stderr}`);
    assert.match(res.stdout, /batch-ok/);
  });

  await test('capabilities() reports without throwing', () => {
    const caps = tc.capabilities();
    for (const key of ['android', 'windows', 'mac', 'ios', 'details']) {
      assert.ok(key in caps, `capabilities is missing ${key}`);
    }
  });
}

async function testDocumentation() {
  console.log('\ndocumentation');

  const commandsPath = path.join(P.ROOT, 'COMMANDS.md');

  await test('COMMANDS.md exists', () => {
    assert.ok(fsx.isFile(commandsPath), 'COMMANDS.md is missing');
  });

  await test('every build flag the parser accepts is documented', () => {
    const source = fs.readFileSync(path.join(P.ROOT, 'build.js'), 'utf8');
    const docs = fs.readFileSync(commandsPath, 'utf8');
    const help = tc.runCapture([process.execPath, path.join(P.ROOT, 'build.js'), '--help'], { cwd: os.tmpdir() });
    assert.ok(help.ok, help.stderr);

    // Flags come from the switch statement in parseArgs, which is the single
    // place the CLI surface is defined.
    const parser = source.slice(source.indexOf('function parseArgs'), source.indexOf('const rawArgs'));
    const flags = [...new Set((parser.match(/case '(--[a-z-]+)'/g) || []).map((m) => m.slice(6, -1)))];
    assert.ok(flags.length > 10, `expected to find the flag list, found ${flags.length}`);

    const undocumented = flags.filter((flag) => !docs.includes(flag));
    assert.deepStrictEqual(undocumented, [], `flags missing from COMMANDS.md: ${undocumented.join(', ')}`);

    const missingFromHelp = flags.filter((flag) => !help.stdout.includes(flag));
    assert.deepStrictEqual(missingFromHelp, [], `flags missing from --help: ${missingFromHelp.join(', ')}`);
  });

  await test('every setup step and flag is documented', () => {
    const docs = fs.readFileSync(commandsPath, 'utf8');
    const help = tc.runCapture([process.execPath, path.join(P.ROOT, 'scripts', 'setup.js'), '--help'], {
      cwd: os.tmpdir()
    });
    assert.ok(help.ok, help.stderr);

    for (const step of ['node', 'rust', 'jdk', 'android', 'platform', 'keystore']) {
      assert.ok(docs.includes(`\`${step}\``), `setup step "${step}" is not documented`);
    }
    for (const flag of ['--dry-run', '--yes', '--skip', '--only', '--desktop-only']) {
      assert.ok(docs.includes(flag), `setup flag "${flag}" is not documented`);
      assert.ok(help.stdout.includes(flag), `setup flag "${flag}" is missing from --help`);
    }
  });

  await test('every npm script is documented', () => {
    const docs = fs.readFileSync(commandsPath, 'utf8');
    const pkg = fsx.readJson(path.join(P.ROOT, 'package.json'));
    const undocumented = Object.keys(pkg.scripts || {})
      .filter((name) => name !== 'tauri') // internal passthrough, not a user command
      .filter((name) => !docs.includes(`npm run ${name}`) && !docs.includes(`npm ${name}`));
    assert.deepStrictEqual(undocumented, [], `npm scripts missing from COMMANDS.md: ${undocumented.join(', ')}`);
  });

  await test('every documented API route exists in the server', () => {
    const docs = fs.readFileSync(commandsPath, 'utf8');
    const server = fs.readFileSync(path.join(P.ROOT, 'server.js'), 'utf8');
    const routes = [...new Set((docs.match(/`?\/api\/[a-z]+/gi) || []).map((r) => r.replace('`', '')))];
    assert.ok(routes.length >= 5, `expected several documented routes, found ${routes.length}`);

    const missing = routes.filter((route) => !server.includes(`'${route}`));
    assert.deepStrictEqual(missing, [], `documented routes not implemented: ${missing.join(', ')}`);
  });

  await test('the setup launchers exist and are wired up', () => {
    for (const launcher of ['setup', 'setup.cmd', 'build', 'build.cmd']) {
      assert.ok(fsx.isFile(path.join(P.ROOT, launcher)), `${launcher} is missing`);
    }
    // A symlink here breaks Windows checkouts, which is why these are real files.
    const stat = fs.lstatSync(path.join(P.ROOT, 'build'));
    assert.ok(!stat.isSymbolicLink(), '`build` must be a real file, not a symlink');
    assert.match(fs.readFileSync(path.join(P.ROOT, 'setup'), 'utf8'), /scripts\/setup\.js/);
    assert.match(fs.readFileSync(path.join(P.ROOT, 'setup.cmd'), 'utf8'), /scripts\\setup\.js/);
  });
}

async function testBuildSpeedConfig() {
  console.log('\nbuild speed configuration');

  // Each of these was chosen from a measurement (see AGENTS.md). Silently
  // losing one would quietly take a Fast build from ~12s back to ~60s.
  await test('Cargo.toml keeps the fast-rebuild release profile', () => {
    const cargo = fs.readFileSync(path.join(P.ROOT, 'src-tauri', 'Cargo.toml'), 'utf8');
    assert.match(cargo, /\[profile\.release\]/, 'the [profile.release] section is gone');
    for (const setting of ['incremental = true', 'codegen-units', 'opt-level']) {
      assert.ok(cargo.includes(setting), `[profile.release] is missing "${setting}"`);
    }
  });

  await test('Windows builds request NSIS only, never the unused MSI', () => {
    const source = fs.readFileSync(path.join(P.ROOT, 'build.js'), 'utf8');
    assert.match(source, /'--bundles'/, 'build.js no longer restricts the bundle list');
    assert.match(source, /\['nsis'\]/, "the default Windows bundle list is no longer ['nsis']");
  });

  await test('the NSIS installer uses zlib compression', () => {
    const source = fs.readFileSync(path.join(P.ROOT, 'build.js'), 'utf8');
    assert.match(source, /compression:\s*'zlib'/, 'NSIS compression is no longer set to zlib');
  });

  await test('fast Android builds one ABI, clean builds all four', () => {
    const res = tc.runCapture([process.execPath, path.join(P.ROOT, 'build.js'), '--help'], { cwd: os.tmpdir() });
    assert.ok(res.ok, res.stderr);
    assert.match(res.stdout, /--abis/, '--abis is no longer documented');
    assert.match(res.stdout, /--no-installer/, '--no-installer is no longer documented');
  });

  await test('stale jniLibs from other ABIs are pruned before an Android build', () => {
    // Tauri symlinks each compiled .so into jniLibs/<abi>/. Those links outlive
    // the build, so a single-ABI run inherits dangling links from an earlier
    // four-ABI run and Gradle fails with "Cannot snapshot ...: not a regular
    // file". Losing this prune silently breaks every Android build that follows
    // a mode switch.
    const source = fs.readFileSync(path.join(P.ROOT, 'build.js'), 'utf8');
    assert.match(source, /pruneAndroidJniLibs/, 'the jniLibs prune is gone');
    assert.match(source, /armeabi-v7a/, 'the ABI -> jniLibs folder mapping is gone');
    const callsBeforeBuild = source.indexOf('pruneAndroidJniLibs(abis)') < source.indexOf("'android', 'build'");
    assert.ok(callsBeforeBuild, 'the prune must run before the Android build is invoked');
  });

  await test('the frontend is compiled from the workspace, never the baseline', () => {
    const conf = fsx.readJson(path.join(P.ROOT, 'src-tauri', 'tauri.conf.json'));
    assert.ok(conf, 'tauri.conf.json is unreadable');
    assert.strictEqual(
      conf.build.frontendDist,
      '../.build-workspace/dist',
      'frontendDist must stay on the workspace or an upload can destroy the committed baseline'
    );
  });
}

async function testEstimates() {
  console.log('\nestimates');

  // Run against a sandboxed workspace so the real build history is untouched.
  const runInSandbox = (body) => {
    const script = `
      process.env.BUILD_WORKSPACE = ${JSON.stringify(tmp('est-ws'))};
      const est = require(${JSON.stringify(path.join(P.ROOT, 'lib', 'estimate.js'))});
      const out = (${body})(est);
      process.stdout.write(JSON.stringify(out));
    `;
    const res = tc.runCapture([process.execPath, '-e', script], { cwd: os.tmpdir() });
    assert.ok(res.ok, res.stderr);
    return JSON.parse(res.stdout);
  };

  await test('formatDuration renders seconds, minutes and hours', () => {
    const out = runInSandbox(`(est) => [est.formatDuration(9), est.formatDuration(60), est.formatDuration(150), est.formatDuration(3720)]`);
    assert.deepStrictEqual(out, ['9s', '1m', '2m 30s', '1h 2m']);
  });

  await test('a clean build is estimated to cost more than a fast one', () => {
    const out = runInSandbox(
      `(est) => { const b = est.estimateBothModes(['android','exe']); return { fast: b.fast.seconds, clean: b.clean.seconds, basis: b.fast.basis }; }`
    );
    assert.ok(out.clean > out.fast, `clean (${out.clean}s) should exceed fast (${out.fast}s)`);
    assert.strictEqual(out.basis, 'estimate', 'with no history the basis must be labelled an estimate');
  });

  await test('more targets cost more than fewer', () => {
    const out = runInSandbox(
      `(est) => ({ one: est.estimate({mode:'fast',targets:['exe'],cacheWarm:true}).seconds,
                   two: est.estimate({mode:'fast',targets:['exe','android'],cacheWarm:true}).seconds })`
    );
    assert.ok(out.two > out.one, `two targets (${out.two}s) should exceed one (${out.one}s)`);
  });

  await test('recorded builds move the estimate towards measured reality', () => {
    const out = runInSandbox(`(est) => {
      const opts = { mode: 'fast', targets: ['exe'], cacheWarm: true };
      const before = est.estimate(opts);
      for (let i = 0; i < 4; i++) est.record({ ...opts, durationMs: 40000 });
      const after = est.estimate(opts);
      return { before: before.seconds, beforeBasis: before.basis, after: after.seconds, afterBasis: after.basis, samples: after.samples };
    }`);
    assert.strictEqual(out.beforeBasis, 'estimate');
    assert.strictEqual(out.afterBasis, 'measured');
    assert.strictEqual(out.samples, 4);
    assert.strictEqual(out.after, 40, `after four 40s builds the estimate should be 40s, got ${out.after}s`);
    assert.notStrictEqual(out.before, out.after);
  });

  await test('absurd durations are ignored so one bad run cannot poison the median', () => {
    const out = runInSandbox(`(est) => {
      const opts = { mode: 'clean', targets: ['mac'], cacheWarm: false };
      est.record({ ...opts, durationMs: 30000 });
      est.record({ ...opts, durationMs: 1 });              // too short
      est.record({ ...opts, durationMs: 20 * 3600 * 1000 }); // too long
      return est.estimate(opts).samples;
    }`);
    assert.strictEqual(out, 1, 'only the plausible sample should be kept');
  });
}

async function testBuildModes() {
  console.log('\nbuild modes (staging semantics)');

  // A miniature baseline + upload, exercised through build.js's own staging
  // logic by pointing the path module at a sandbox via environment variables.
  const baseline = tmp('baseline');
  writeFile(path.join(baseline, 'index.html'), 'BASE');
  writeFile(path.join(baseline, 'static', 'js', 'main.js'), 'BASE-JS');
  writeFile(path.join(baseline, 'static', 'files', 'old.glb'), 'OLD');

  const upload = tmp('upload');
  writeFile(path.join(upload, 'index.html'), 'UPLOAD');
  writeFile(path.join(upload, 'static', 'js', 'main.js'), 'UPLOAD-JS');
  writeFile(path.join(upload, 'static', 'files', 'new.glb'), 'NEW');

  const runStaging = (mode) => {
    const workspace = tmp(`ws-${mode}`);
    const script = `
      process.env.BASELINE_DIST = ${JSON.stringify(baseline)};
      process.env.BUILD_WORKSPACE = ${JSON.stringify(workspace)};
      const P = require(${JSON.stringify(path.join(P.ROOT, 'lib', 'paths.js'))});
      const fsx = require(${JSON.stringify(path.join(P.ROOT, 'lib', 'fsx.js'))});
      const path = require('path');
      const mode = ${JSON.stringify(mode)};
      const src = ${JSON.stringify(upload)};
      if (mode === 'clean') {
        fsx.syncDir(src, P.WORKSPACE_DIST);
      } else {
        fsx.syncDir(P.BASELINE_DIST, P.WORKSPACE_DIST);
        fsx.syncDir(path.join(src, P.SWAP_SUBPATH), path.join(P.WORKSPACE_DIST, P.SWAP_SUBPATH));
      }
      process.stdout.write(P.WORKSPACE_DIST);
    `;
    const res = tc.runCapture([process.execPath, '-e', script], { cwd: os.tmpdir() });
    assert.ok(res.ok, res.stderr);
    return res.stdout.trim();
  };

  await test('fast mode swaps only static/files and keeps the baseline shell', () => {
    const ws = runStaging('fast');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'index.html'), 'utf8'), 'BASE');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'static', 'js', 'main.js'), 'utf8'), 'BASE-JS');
    assert.ok(fsx.isFile(path.join(ws, 'static', 'files', 'new.glb')), 'new payload should be present');
    assert.ok(!fsx.isFile(path.join(ws, 'static', 'files', 'old.glb')), 'old payload should be gone');
  });

  await test('clean mode stages the whole upload', () => {
    const ws = runStaging('clean');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'index.html'), 'utf8'), 'UPLOAD');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'static', 'js', 'main.js'), 'utf8'), 'UPLOAD-JS');
    assert.ok(fsx.isFile(path.join(ws, 'static', 'files', 'new.glb')));
  });

  await test('fast staging never mutates the baseline', () => {
    assert.strictEqual(fs.readFileSync(path.join(baseline, 'index.html'), 'utf8'), 'BASE');
    assert.ok(fsx.isFile(path.join(baseline, 'static', 'files', 'old.glb')));
  });

  await test('build.js --help exits cleanly', () => {
    const res = tc.runCapture([process.execPath, path.join(P.ROOT, 'build.js'), '--help'], { cwd: os.tmpdir() });
    assert.ok(res.ok, res.stderr);
    assert.match(res.stdout, /--mode|--fast/);
  });

  await test('build.js rejects an unknown mode', () => {
    const res = tc.runCapture(
      [process.execPath, path.join(P.ROOT, 'build.js'), '--exe', '--mode', 'sideways'],
      { cwd: os.tmpdir() }
    );
    assert.strictEqual(res.ok, false);
    assert.match(res.stdout + res.stderr, /Unknown build mode/);
  });
}

/* ------------------------------------------------------------------ */

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(P.ROOT, 'server.js')], {
      cwd: P.ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        JOBS_DIR: tmp('srv-jobs'),
        UPLOADS_DIR: tmp('srv-uploads'),
        DIST_BUILDS: tmp('srv-dist-builds'),
        NO_COLOR: '1'
      },
      windowsHide: true
    });

    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 60000);

    const onData = (chunk) => {
      output += chunk;
      if (output.includes('Listening :')) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}:\n${output}`));
    });
  });
}

async function testHttpApi() {
  console.log('\nhttp api');

  const port = 3100 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = await startServer(port);
  } catch (err) {
    failed++;
    console.log('  FAIL server startup');
    console.log(`       ${err.message}`);
    return;
  }

  try {
    await test('GET /api/health reports capabilities and baseline', async () => {
      const res = await fetch(`${base}/api/health`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, 'ok');
      assert.ok(body.capabilities && 'android' in body.capabilities);
      assert.ok(body.baseline && typeof body.baseline.present === 'boolean');
      assert.strictEqual(body.baseline.swapPath, 'static/files');
    });

    await test('GET / serves the dashboard', async () => {
      const res = await fetch(`${base}/`);
      assert.strictEqual(res.status, 200);
      assert.match(await res.text(), /<html/i);
    });

    await test('GET /api/estimate returns a time for both modes', async () => {
      const res = await fetch(`${base}/api/estimate?targets=android,exe`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      for (const mode of ['fast', 'clean']) {
        assert.ok(body[mode], `missing ${mode} estimate`);
        assert.ok(body[mode].seconds > 0, `${mode} estimate must be positive`);
        assert.match(body[mode].human, /^\d+[smh]/, `${mode} estimate must be human-readable`);
      }
      assert.ok(body.clean.seconds > body.fast.seconds, 'clean should be estimated slower than fast');
      assert.deepStrictEqual(body.targets, ['android', 'windows']);
    });

    await test('GET /api/estimate ignores unknown targets', async () => {
      const body = await (await fetch(`${base}/api/estimate?targets=exe,haiku,../etc`)).json();
      assert.deepStrictEqual(body.targets, ['windows']);
    });

    await test('POST /api/convert rejects a request with no ZIP', async () => {
      const res = await fetch(`${base}/api/convert`, { method: 'POST', body: new FormData() });
      assert.strictEqual(res.status, 400);
      assert.match((await res.json()).error, /webBuild/i);
    });

    await test('POST /api/convert rejects a non-ZIP upload', async () => {
      const form = new FormData();
      form.append('webBuild', new Blob(['not a zip'], { type: 'text/plain' }), 'payload.txt');
      const res = await fetch(`${base}/api/convert`, { method: 'POST', body: form });
      assert.strictEqual(res.status, 400);
      assert.match((await res.json()).error, /\.zip/i);
    });

    await test('POST /api/convert rejects a malformed identifier', async () => {
      const zip = new AdmZip();
      zip.addFile('index.html', Buffer.from('<html></html>'));
      const form = new FormData();
      form.append('webBuild', new Blob([zip.toBuffer()]), 'build.zip');
      form.append('appIdentifier', 'not a bundle id');
      const res = await fetch(`${base}/api/convert`, { method: 'POST', body: form });
      assert.strictEqual(res.status, 400);
      assert.match((await res.json()).error, /identifier/i);
    });

    let jobId = null;

    await test('POST /api/convert queues a job and returns 202 immediately', async () => {
      const zip = new AdmZip();
      zip.addFile('index.html', Buffer.from('<html>hello</html>'));
      const form = new FormData();
      form.append('webBuild', new Blob([zip.toBuffer()]), 'build.zip');
      form.append('targets', 'exe');
      form.append('mode', 'fast');

      const started = Date.now();
      const res = await fetch(`${base}/api/convert`, { method: 'POST', body: form });
      assert.strictEqual(res.status, 202, `expected 202, got ${res.status}`);
      const body = await res.json();
      assert.match(body.jobId, /^job_/);
      assert.strictEqual(body.mode, 'fast');
      assert.ok(Date.now() - started < 20000, 'the request must not block on the build');
      jobId = body.jobId;
    });

    await test('a fast job without static/files fails with an actionable message', async () => {
      assert.ok(jobId, 'no job was queued');
      const deadline = Date.now() + 90000;
      let job;
      while (Date.now() < deadline) {
        job = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
        if (job.status === 'completed' || job.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.strictEqual(job.status, 'failed');
      assert.match(job.error, /static\/files/i);
      assert.ok(typeof job.durationSeconds === 'number', 'a finished job must report how long it took');
      assert.strictEqual(job.progress, 100, 'a finished job must not leave the bar mid-way');
    });

    await test('a job exposes progress and an ETA while it runs', async () => {
      const zip = new AdmZip();
      zip.addFile('index.html', Buffer.from('<html></html>'));
      zip.addFile('static/files/payload.bin', Buffer.from('payload'));
      const form = new FormData();
      form.append('webBuild', new Blob([zip.toBuffer()]), 'build.zip');
      form.append('targets', 'exe');
      const { jobId: id } = await (await fetch(`${base}/api/convert`, { method: 'POST', body: form })).json();

      const deadline = Date.now() + 30000;
      let sawProgress = false;
      while (Date.now() < deadline) {
        const job = await (await fetch(`${base}/api/jobs/${id}`)).json();
        if (job.status === 'running') {
          assert.ok(typeof job.progress === 'number' && job.progress >= 0 && job.progress <= 100,
            `progress out of range: ${job.progress}`);
          assert.ok(job.estimate && job.estimate.seconds > 0, 'a running job must carry an estimate');
          assert.ok(typeof job.etaSeconds === 'number', 'a running job must report an ETA');
          assert.ok(typeof job.elapsedSeconds === 'number', 'a running job must report elapsed time');
          sawProgress = true;
          break;
        }
        if (job.status === 'completed' || job.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(sawProgress, 'never observed the job in a running state');
    });

    await test('GET /api/jobs/:id/log returns the build log', async () => {
      const body = await (await fetch(`${base}/api/jobs/${jobId}/log`)).json();
      assert.ok(Array.isArray(body.lines) && body.lines.length > 0, 'log should not be empty');
    });

    await test('download rejects path traversal in the file parameter', async () => {
      for (const attack of ['../../../../etc/passwd', '..%2F..%2Fpackage.json', '../job.json']) {
        const res = await fetch(`${base}/api/download/${jobId}?file=${encodeURIComponent(attack)}`);
        assert.ok(res.status >= 400, `traversal "${attack}" returned ${res.status}`);
        const text = await res.text();
        assert.ok(!text.includes('root:'), 'a system file leaked');
        assert.ok(!text.includes('"dependencies"'), 'a project file leaked');
      }
    });

    await test('download rejects an unknown job id', async () => {
      const res = await fetch(`${base}/api/download/..%2F..%2Fpackage.json`);
      assert.ok(res.status >= 400);
    });

    await test('GET /api/jobs lists the job', async () => {
      const body = await (await fetch(`${base}/api/jobs`)).json();
      assert.ok(body.jobs.some((j) => j.jobId === jobId));
      assert.ok(body.jobs.every((j) => !('artifactFiles' in j)), 'internal paths must not be exposed');
    });
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ------------------------------------------------------------------ */

(async () => {
  console.log(`Self-test on ${process.platform}-${process.arch}, node ${process.version}`);
  try {
    await testPaths();
    await testFsx();
    await testToolchain();
    await testDocumentation();
    await testBuildSpeedConfig();
    await testEstimates();
    await testBuildModes();
    await testHttpApi();
  } finally {
    fsx.rmrf(sandbox);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
