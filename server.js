'use strict';

/**
 * Cloud Web-to-App converter service.
 *
 * Accepts a web build ZIP, runs the multi-platform Tauri pipeline in a queued
 * background job, and serves the resulting native packages.
 *
 * Design notes:
 *  - Builds run asynchronously; the HTTP request never blocks on compilation.
 *  - Builds are serialised, because they share one Rust target cache and one
 *    generated Android project.
 *  - The committed baseline in dist/ is never destroyed by a job. Fast jobs
 *    read it, clean jobs update it (that is exactly what "clean" means here).
 */

// Install anything missing before the first third-party require, so a fresh
// clone on any OS boots without a manual `npm install`.
require('./lib/ensure-deps').ensureDeps(['express', 'cors', 'multer', 'adm-zip']);

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const P = require('./lib/paths');
const fsx = require('./lib/fsx');
const tc = require('./lib/toolchain');
const est = require('./lib/estimate');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 500;
const JOB_RETENTION = Number(process.env.JOB_RETENTION) || 20;
const LOG_TAIL_LINES = 400;

for (const dir of [P.UPLOADS, P.JOBS, P.DIST_BUILDS, P.WORKSPACE]) fsx.ensureDir(dir);

tc.setupEnv({ log: (m) => console.log(`[env] ${m}`) });

/* ------------------------------------------------------------------ *
 * Job store
 * ------------------------------------------------------------------ */

const jobs = new Map();

const JOB_ID_RE = /^job_[0-9]+_[a-z0-9]+$/;

function jobDir(jobId) {
  return path.join(P.JOBS, jobId);
}

function saveJob(job) {
  const { logBuffer, ...persisted } = job;
  try {
    fsx.writeJson(path.join(jobDir(job.jobId), 'job.json'), persisted);
  } catch (err) {
    console.error(`[job ${job.jobId}] could not persist state: ${err.message}`);
  }
}

/** Load a job from memory, falling back to disk after a server restart. */
function loadJob(jobId) {
  if (!JOB_ID_RE.test(jobId)) return null;
  if (jobs.has(jobId)) return jobs.get(jobId);

  const persisted = fsx.readJson(path.join(jobDir(jobId), 'job.json'));
  if (persisted) {
    persisted.logBuffer = [];
    jobs.set(jobId, persisted);
    return persisted;
  }
  return null;
}

function restoreJobsFromDisk() {
  if (!fsx.isDir(P.JOBS)) return;
  for (const name of fs.readdirSync(P.JOBS)) {
    if (!JOB_ID_RE.test(name)) continue;
    const persisted = fsx.readJson(path.join(P.JOBS, name, 'job.json'));
    if (!persisted) continue;
    // A job that was running when the process died can never finish.
    if (persisted.status === 'running' || persisted.status === 'queued') {
      persisted.status = 'failed';
      persisted.error = 'Server restarted while this build was in progress';
    }
    persisted.logBuffer = [];
    jobs.set(name, persisted);
  }
  console.log(`[jobs] restored ${jobs.size} previous job(s) from disk`);
}

/** Delete the oldest job directories so the disk does not fill up. */
function pruneOldJobs() {
  const entries = [...jobs.values()]
    .filter((j) => j.status === 'completed' || j.status === 'failed')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  for (const job of entries.slice(JOB_RETENTION)) {
    fsx.rmrf(jobDir(job.jobId));
    jobs.delete(job.jobId);
  }
}

/* ------------------------------------------------------------------ *
 * Upload handling
 * ------------------------------------------------------------------ */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, P.UPLOADS),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    // Never trust the client's filename on disk - keep only a safe extension.
    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${file.fieldname}-${unique}${ext}`);
  }
});

const ALLOWED_LOGO_EXT = new Set(['.png', '.jpg', '.jpeg', '.ico', '.webp']);

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (file.fieldname === 'webBuild') {
      if (ext !== '.zip') return cb(new Error('The web build must be a .zip archive'));
      return cb(null, true);
    }
    if (file.fieldname === 'appLogo') {
      if (!ALLOWED_LOGO_EXT.has(ext)) return cb(new Error('The logo must be a PNG, JPG, ICO or WEBP image'));
      return cb(null, true);
    }
    return cb(new Error(`Unexpected upload field: ${file.fieldname}`));
  }
});

/* ------------------------------------------------------------------ *
 * Build queue (serialised - builds share one Rust target cache)
 * ------------------------------------------------------------------ */

const queue = [];
let running = false;

function enqueue(job) {
  queue.push(job);
  job.status = 'queued';
  job.queuePosition = queue.length;
  saveJob(job);
  setImmediate(drainQueue);
}

async function drainQueue() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;

  running = true;
  queue.forEach((q, i) => {
    q.queuePosition = i + 1;
  });

  try {
    await runJob(job);
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    appendLog(job, `[fatal] ${err.message}`);
    saveJob(job);
  } finally {
    running = false;
    pruneOldJobs();
    setImmediate(drainQueue);
  }
}

function appendLog(job, line) {
  const text = String(line).replace(/\s+$/, '');
  if (!text) return;
  job.logBuffer = job.logBuffer || [];
  job.logBuffer.push(text);
  if (job.logBuffer.length > LOG_TAIL_LINES) job.logBuffer.shift();
  try {
    fs.appendFileSync(path.join(jobDir(job.jobId), 'build.log'), `${text}\n`);
  } catch (_) {
    /* logging must never break a build */
  }
}

function setStage(job, stage, detail) {
  job.stage = stage;
  if (detail) appendLog(job, `[stage] ${stage}: ${detail}`);
  else appendLog(job, `[stage] ${stage}`);
  saveJob(job);
}

/* ------------------------------------------------------------------ *
 * The build itself
 * ------------------------------------------------------------------ */

function runBuildProcess(job, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(P.ROOT, 'build.js'), ...args], {
      cwd: P.ROOT,
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true
    });

    job.pid = child.pid;

    const pipe = (stream) => {
      let carry = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const lines = (carry + chunk).split(/\r?\n/);
        carry = lines.pop();
        for (const line of lines) appendLog(job, line);
      });
      stream.on('end', () => {
        if (carry) appendLog(job, carry);
      });
    };

    pipe(child.stdout);
    pipe(child.stderr);

    child.on('error', (err) => resolve({ ok: false, code: -1, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

async function runJob(job) {
  const dir = jobDir(job.jobId);
  const webDir = path.join(dir, 'web');
  const outDir = path.join(dir, 'build');
  const outputsDir = fsx.ensureDir(path.join(dir, 'outputs'));

  job.status = 'running';
  job.startedAt = new Date().toISOString();
  // Captured before the build purges or populates it, so the recorded sample is
  // labelled with the cache state the build actually started from.
  job.cacheWarm = job.mode === 'clean' ? false : est.isCacheWarm();
  const prediction = est.estimate({ mode: job.mode, targets: job.targets, cacheWarm: job.cacheWarm });
  job.estimate = { seconds: prediction.seconds, basis: prediction.basis, samples: prediction.samples };
  const startedMs = Date.now();
  delete job.queuePosition;
  saveJob(job);
  appendLog(job, `[estimate] about ${est.formatDuration(prediction.seconds)} (${prediction.basis})`);

  try {
    /* 1. Extract the upload (rejecting path-traversal entries). */
    setStage(job, 'extract', `unpacking ${path.basename(job.upload.originalName)}`);
    fsx.emptyDir(webDir);
    const count = fsx.safeExtractZip(AdmZip, job.upload.zipPath, webDir);
    fsx.normalizeWebRoot(webDir);
    appendLog(job, `[extract] ${count} entries extracted`);

    if (!fsx.isFile(path.join(webDir, 'index.html'))) {
      throw new Error('The uploaded archive has no index.html - it does not look like a web build');
    }

    if (job.mode === 'fast' && !fsx.isDir(path.join(webDir, P.SWAP_SUBPATH))) {
      throw new Error(
        `Fast mode needs "${P.SWAP_SUBPATH.split(path.sep).join('/')}" inside the ZIP. ` +
          'Use Clean Rebuild for an archive that does not contain it.'
      );
    }

    /* 2. Compose the build.js command line. */
    const args = [`--mode`, job.mode, '--web-src', webDir, '--out', outDir];
    for (const target of job.targets) {
      if (target === 'android') args.push('--android');
      else if (target === 'exe' || target === 'windows') args.push('--exe');
      else if (target === 'mac' || target === 'dmg') args.push('--mac');
      else if (target === 'ios') args.push('--ios');
    }
    if (job.appName) args.push('--name', job.appName);
    if (job.appIdentifier) args.push('--identifier', job.appIdentifier);
    if (job.upload.logoPath) args.push('--logo', job.upload.logoPath);

    setStage(job, 'build', `node build.js ${args.join(' ')}`);
    const result = await runBuildProcess(job, args);

    /* 3. Collect whatever the build actually produced. */
    setStage(job, 'package');
    const summary = fsx.readJson(path.join(outDir, 'build-result.json'), null);
    if (!summary) {
      throw new Error(
        result.error
          ? `Build process could not start: ${result.error}`
          : `Build failed before producing any artifact (exit code ${result.code}). See the log for details.`
      );
    }

    job.buildFailures = summary.failures || [];
    const artifacts = {};
    const files = {};
    const safeName = (job.appName || 'app').replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '') || 'app';

    const collect = (key, sourcePath, filename) => {
      if (!sourcePath || !fs.existsSync(sourcePath)) return;
      if (fsx.isDir(sourcePath)) {
        const inner = fsx.walkFiles(sourcePath);
        if (inner.length === 0) return;
        const destDir = path.join(outputsDir, key);
        fsx.copyPath(sourcePath, destDir);
        files[key] = destDir;
      } else {
        const dest = path.join(outputsDir, filename);
        fs.copyFileSync(sourcePath, dest);
        files[key] = dest;
      }
      artifacts[key] = `/api/download/${job.jobId}?file=${key}`;
    };

    collect('apk', summary.artifacts.android, `${safeName}-signed.apk`);
    collect('exe', path.join(outDir, 'windows', 'app.exe'), `${safeName}.exe`);
    collect('setup', path.join(outDir, 'windows', 'tripo-setup.exe'), `${safeName}-setup.exe`);
    collect('dmg', summary.artifacts.mac, `${safeName}.dmg`);
    collect('ios', summary.artifacts.ios, `${safeName}.ipa`);

    if (Object.keys(files).length === 0) {
      const why = (summary.failures || []).join('; ') || `exit code ${result.code}`;
      throw new Error(`No installable package was produced. ${why}`);
    }

    /* 4. One archive with everything. */
    const bundle = new AdmZip();
    for (const [key, filePath] of Object.entries(files)) {
      if (fsx.isDir(filePath)) bundle.addLocalFolder(filePath, key);
      else bundle.addLocalFile(filePath);
    }
    const zipPath = path.join(outputsDir, `${job.jobId}-outputs.zip`);
    bundle.writeZip(zipPath);
    files.zip = zipPath;
    artifacts.zip = `/api/download/${job.jobId}`;

    /* 5. Mirror the latest build into dist-builds/ for CLI parity. */
    try {
      for (const platform of ['android', 'windows', 'mac', 'ios']) {
        const from = path.join(outDir, platform);
        if (fsx.hasFiles(from)) fsx.syncDir(from, path.join(P.DIST_BUILDS, platform));
      }
      fs.copyFileSync(zipPath, path.join(P.DIST_BUILDS, `${job.jobId}-outputs.zip`));
    } catch (err) {
      appendLog(job, `[warn] could not mirror artifacts into dist-builds: ${err.message}`);
    }

    job.status = 'completed';
    job.artifacts = artifacts;
    job.artifactFiles = files;
    job.downloadUrl = `/api/download/${job.jobId}`;
    job.finishedAt = new Date().toISOString();
    job.durationSeconds = Math.round((Date.now() - startedMs) / 1000);

    // Only successful builds feed the estimator; a job that failed after ten
    // seconds says nothing about how long a real build takes.
    est.record({
      mode: job.mode,
      targets: job.targets,
      cacheWarm: job.cacheWarm,
      durationMs: Date.now() - startedMs
    });

    setStage(job, 'done', `produced ${Object.keys(artifacts).join(', ')} in ${est.formatDuration(job.durationSeconds)}`);
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    job.durationSeconds = Math.round((Date.now() - startedMs) / 1000);
    appendLog(job, `[error] ${err.message}`);
  } finally {
    delete job.pid;
    // The raw upload is large and no longer needed once it has been extracted.
    for (const temp of [job.upload.zipPath]) {
      if (temp && fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    }
    fsx.rmrf(webDir);
    saveJob(job);
  }
}

/* ------------------------------------------------------------------ *
 * HTTP API
 * ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(P.PUBLIC));

/**
 * Where a running job is, as a percentage, and how much longer it is likely to
 * take. Computed on the server so the dashboard, curl and any other client all
 * agree instead of each inventing their own animation.
 */
function progressFor(job, elapsedSeconds) {
  if (job.status === 'completed') return 100;
  if (job.status === 'failed') return 100;
  if (job.status === 'queued') return 2;

  const spans = { extract: [5, 15], build: [15, 92], package: [93, 99], done: [100, 100] };
  const [from, to] = spans[job.stage] || [3, 5];
  if (job.stage !== 'build') return from;

  // Compilation dominates: interpolate across the estimate, easing off as the
  // estimate is exceeded so the bar never stalls at 100% while still running.
  const total = (job.estimate && job.estimate.seconds) || 120;
  const ratio = total > 0 ? elapsedSeconds / total : 1;
  const eased = ratio <= 1 ? ratio : 1 - 1 / (1 + (ratio - 1) * 2) + 1 - 0.0001;
  return Math.min(to, Math.round(from + (to - from) * Math.min(eased, 0.999)));
}

function publicJob(job) {
  if (!job) return null;
  const { logBuffer, artifactFiles, upload, pid, ...rest } = job;

  const active = job.status === 'running' || job.status === 'queued';
  const elapsed = job.startedAt
    ? Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt)) / 1000)
    : 0;

  rest.elapsedSeconds = elapsed;
  rest.progress = progressFor(job, elapsed);

  if (active && job.estimate) {
    // Never promise "0s left" while work is still happening.
    rest.etaSeconds = Math.max(job.status === 'running' ? 5 : 0, job.estimate.seconds - elapsed);
  }
  return rest;
}

app.get('/api/health', (req, res) => {
  const caps = tc.capabilities();
  res.json({
    status: 'ok',
    service: 'Tripo Cloud Web-to-App Converter',
    uptime: Math.floor(process.uptime()),
    capabilities: caps,
    queue: { running, pending: queue.length },
    baseline: {
      path: P.BASELINE_DIST,
      present: fsx.isFile(path.join(P.BASELINE_DIST, 'index.html')),
      swapPath: P.SWAP_SUBPATH.split(path.sep).join('/')
    },
    environment: {
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
      root: P.ROOT
    },
    timestamp: new Date().toISOString()
  });
});

/**
 * How long a new job would wait before its own build starts: whatever is left
 * of the running build, plus everything already queued. Builds are serialised,
 * so this is real waiting time, not a rounding detail.
 */
function queueWaitSeconds(perJobSeconds) {
  let wait = queue.length * perJobSeconds;
  const active = [...jobs.values()].find((j) => j.status === 'running');
  if (active && active.estimate && active.startedAt) {
    const elapsed = (Date.now() - Date.parse(active.startedAt)) / 1000;
    wait += Math.max(0, active.estimate.seconds - elapsed);
  }
  return Math.round(wait);
}

/**
 * Predicted duration for both modes with the given targets, so the dashboard
 * can tell the user what each mode will cost before they commit to one.
 */
app.get('/api/estimate', (req, res) => {
  const known = new Set(['android', 'exe', 'windows', 'mac', 'dmg', 'ios']);
  const targets = String(req.query.targets || 'android,exe')
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .filter((t) => known.has(t));

  const result = est.estimateBothModes(targets);
  const decorate = (e) => ({ ...e, human: est.formatDuration(e.seconds) });

  res.json({
    targets: result.targets,
    cacheWarm: result.cacheWarm,
    queueAheadSeconds: queueWaitSeconds(result.fast.seconds || 0),
    fast: decorate(result.fast),
    clean: decorate(result.clean)
  });
});

const convertFields = upload.fields([
  { name: 'webBuild', maxCount: 1 },
  { name: 'appLogo', maxCount: 1 }
]);

app.post('/api/convert', (req, res) => {
  convertFields(req, res, async (uploadErr) => {
    const webBuildFile = req.files && req.files.webBuild ? req.files.webBuild[0] : null;
    const appLogoFile = req.files && req.files.appLogo ? req.files.appLogo[0] : null;

    const cleanup = () => {
      for (const file of [webBuildFile, appLogoFile]) {
        if (file && fs.existsSync(file.path)) fs.rmSync(file.path, { force: true });
      }
    };

    if (uploadErr) {
      cleanup();
      const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        status: 'failed',
        error: tooBig ? `Upload exceeds the ${MAX_UPLOAD_MB} MB limit` : uploadErr.message
      });
    }

    if (!webBuildFile) {
      cleanup();
      return res.status(400).json({ status: 'failed', error: 'Missing webBuild ZIP file' });
    }

    const appName = String(req.body.appName || '').trim().slice(0, 64);
    const appIdentifier = String(req.body.appIdentifier || '').trim().slice(0, 128);
    if (appIdentifier && !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(appIdentifier)) {
      cleanup();
      return res.status(400).json({
        status: 'failed',
        error: 'App identifier must look like com.example.app'
      });
    }

    const known = new Set(['android', 'exe', 'windows', 'mac', 'dmg', 'ios']);
    let targets = String(req.body.targets || 'android,exe')
      .toLowerCase()
      .split(',')
      .map((t) => t.trim())
      .filter((t) => known.has(t));
    if (String(req.body.targets || '').toLowerCase().includes('all')) {
      targets = ['android', 'exe', 'mac', 'ios'];
    }
    if (targets.length === 0) targets = ['android', 'exe'];

    // `mode` is the documented field; `clean=true` stays supported for older clients.
    const rawMode = String(req.body.mode || '').toLowerCase();
    const mode =
      rawMode === 'clean' || req.body.clean === 'true' || req.body.clean === '1' ? 'clean' : 'fast';

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const dir = fsx.ensureDir(jobDir(jobId));

    let logoPath = null;
    if (appLogoFile) {
      const ext = path.extname(appLogoFile.originalname).toLowerCase() || '.png';
      logoPath = path.join(dir, `logo${ext}`);
      fs.copyFileSync(appLogoFile.path, logoPath);
      fs.rmSync(appLogoFile.path, { force: true });
    }

    const job = {
      jobId,
      status: 'queued',
      stage: 'queued',
      mode,
      targets,
      appName: appName || null,
      appIdentifier: appIdentifier || null,
      createdAt: new Date().toISOString(),
      upload: {
        zipPath: webBuildFile.path,
        originalName: webBuildFile.originalname,
        sizeBytes: webBuildFile.size,
        logoPath
      },
      logBuffer: []
    };

    jobs.set(jobId, job);
    console.log(`[job ${jobId}] queued - mode=${mode} targets=${targets.join(',')}`);
    enqueue(job);

    // `?wait=1` keeps the connection open until the build finishes, which is
    // convenient for curl and CI but not used by the dashboard.
    if (req.query.wait === '1' || req.body.wait === '1') {
      const deadline = Date.now() + 60 * 60 * 1000;
      while (job.status !== 'completed' && job.status !== 'failed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      return res.status(job.status === 'completed' ? 200 : 500).json(publicJob(job));
    }

    return res.status(202).json({
      jobId,
      status: job.status,
      mode,
      targets,
      statusUrl: `/api/jobs/${jobId}`,
      logUrl: `/api/jobs/${jobId}/log`
    });
  });
});

app.get('/api/jobs', (req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 50)
    .map(publicJob);
  res.json({ jobs: list, queue: { running, pending: queue.length } });
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = loadJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: `Job ${req.params.jobId} not found` });
  res.json(publicJob(job));
});

app.get('/api/jobs/:jobId/log', (req, res) => {
  const job = loadJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: `Job ${req.params.jobId} not found` });

  let lines = job.logBuffer || [];
  if (lines.length === 0) {
    const logFile = path.join(jobDir(job.jobId), 'build.log');
    if (fsx.isFile(logFile)) {
      lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL_LINES);
    }
  }
  res.json({ jobId: job.jobId, status: job.status, stage: job.stage, lines });
});

/** Keep legacy `/api/status/:jobId` working. */
app.get('/api/status/:jobId', (req, res) => {
  const job = loadJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: `Job ${req.params.jobId} not found` });
  res.json(publicJob(job));
});

const DOWNLOAD_KEYS = new Set(['zip', 'apk', 'exe', 'setup', 'dmg', 'ios']);

app.get('/api/download/:jobId', (req, res) => {
  const job = loadJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: `Job ${req.params.jobId} not found` });
  if (job.status !== 'completed') {
    return res.status(409).json({ error: `Job ${job.jobId} is ${job.status}`, status: job.status });
  }

  const requested = String(req.query.file || 'zip').toLowerCase();
  const outputsDir = path.resolve(jobDir(job.jobId), 'outputs');
  let target = null;

  if (DOWNLOAD_KEYS.has(requested)) {
    target = job.artifactFiles && job.artifactFiles[requested];
    if (!target && requested === 'zip') {
      const found = fsx.isDir(outputsDir) && fs.readdirSync(outputsDir).find((f) => f.endsWith('.zip'));
      if (found) target = path.join(outputsDir, found);
    }
  } else {
    // A literal filename is allowed, but only a bare name inside this job's
    // own outputs directory - never a path the caller composed.
    const base = path.basename(requested);
    if (base === requested) target = path.join(outputsDir, base);
  }

  if (!target) return res.status(404).json({ error: `No '${requested}' artifact for job ${job.jobId}` });

  const resolved = path.resolve(target);
  const relative = path.relative(outputsDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return res.status(400).json({ error: 'Invalid file request' });
  }
  if (!fsx.isFile(resolved)) {
    return res.status(404).json({ error: `Artifact '${requested}' is not available for job ${job.jobId}` });
  }

  return res.download(resolved, path.basename(resolved), (err) => {
    if (err && !res.headersSent) {
      console.error(`[download] ${job.jobId}/${requested}: ${err.message}`);
      res.status(500).end();
    }
  });
});

app.use((err, req, res, next) => {
  console.error('[server]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

restoreJobsFromDisk();

// `exclusive` matters on Windows: without it a second instance silently binds
// the same port and the two processes split incoming requests, which looks like
// the server randomly forgetting its own state.
const server = app.listen({ port: PORT, host: HOST, exclusive: true }, () => {
  const caps = tc.capabilities();
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('====================================================');
  console.log(' Tripo Web-to-App Cloud Converter');
  console.log(` Listening : http://${shown}:${PORT}/`);
  console.log(` Health    : http://${shown}:${PORT}/api/health`);
  console.log(` Root      : ${P.ROOT}`);
  console.log(` Can build : ${Object.entries(caps)
    .filter(([k, v]) => k !== 'details' && v)
    .map(([k]) => k)
    .join(', ') || 'nothing (missing toolchains - see /api/health)'}`);
  console.log('====================================================');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port ${PORT} is already in use. Stop the other instance or set PORT.`);
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`[server] not allowed to bind ${HOST}:${PORT}. Choose a port above 1024.`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[server] ${signal} received - shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
