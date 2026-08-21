#!/usr/bin/env node
'use strict';

/**
 * Command-line control for builds running on the converter service.
 *
 *   npm run jobs                    list recent jobs
 *   npm run jobs -- cancel <id>     stop one build
 *   npm run jobs -- cancel --all    stop everything running and queued
 *
 * Talks to the service over its HTTP API, so it works against a local server or
 * a remote one via --url.
 */

const est = require('../lib/estimate');

require('../lib/env').loadEnv();

const DEFAULT_URL = process.env.CONVERTER_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, msg) => (useColor ? `\x1b[${code}m${msg}\x1b[0m` : msg);

const STATUS_COLOR = {
  running: 33,
  queued: 36,
  completed: 32,
  failed: 31,
  cancelled: 90
};

function printHelp() {
  console.log(`
Usage: jobs [command] [options]

Commands:
  list                    Recent jobs and queue state (default)
  show <id>               Everything known about one job
  logs <id>               Tail of a job's build log
  cancel <id>             Stop a running or queued build
  cancel --all            Stop every running and queued build
  watch <id>              Follow a job until it finishes

Options:
  --url <base>            Service address (default: ${DEFAULT_URL})
  --json                  Print raw JSON instead of a table
  --help, -h              Show this message

Examples:
  npm run jobs
  npm run jobs -- cancel job_1787083734127_uuo9f
  npm run jobs -- cancel --all
  npm run jobs -- logs job_1787083734127_uuo9f
`);
}

/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const opts = { url: DEFAULT_URL, json: false, all: false };
const positional = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--url') opts.url = argv[++i];
  else if (arg === '--json') opts.json = true;
  else if (arg === '--all' || arg === '-a') opts.all = true;
  else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  } else if (arg.startsWith('-')) {
    console.error(`Unknown option: ${arg}`);
    process.exit(2);
  } else positional.push(arg);
}

const command = positional[0] || 'list';
const target = positional[1];
const base = String(opts.url).replace(/\/+$/, '');

async function api(pathname, init = {}) {
  let res;
  try {
    // This CLI is the operator's tool: it lists and cancels other people's
    // jobs, which the server only allows with the dashboard key.
    const headers = { ...(init.headers || {}) };
    const key = (process.env.DASHBOARD_TOKEN || '').trim();
    if (key) headers['X-Dashboard-Key'] = key;
    res = await fetch(`${base}${pathname}`, { ...init, headers });
  } catch (err) {
    console.error(`Cannot reach the converter service at ${base}`);
    console.error('Is it running?  npm start');
    process.exit(1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(body.error || `Request failed with status ${res.status}`);
    if (res.status === 401) {
      console.error('Set DASHBOARD_TOKEN (or put it in .env) to use this command.');
    }
    process.exit(1);
  }
  return body;
}

const colored = (status) => paint(STATUS_COLOR[status] || 0, status);

function requireId() {
  if (!target) {
    console.error(`A job id is required:  npm run jobs -- ${command} <id>`);
    process.exit(2);
  }
  return target;
}

/* ------------------------------------------------------------------ */

async function cmdList() {
  const body = await api('/api/jobs');
  if (opts.json) return console.log(JSON.stringify(body, null, 2));

  const q = body.queue || {};
  console.log(
    `Queue: ${q.running || 0} running, ${q.pending || 0} pending ` +
      `(${q.concurrency || 1} slot${q.concurrency === 1 ? '' : 's'})`
  );

  if (!body.jobs || body.jobs.length === 0) return console.log('\nNo jobs yet.');

  console.log('');
  console.log(['JOB ID', 'STATUS', 'MODE', 'TARGETS', 'TIME', 'DETAIL'].map((h, i) =>
    paint(1, h.padEnd([26, 10, 7, 16, 8, 0][i]))).join(''));

  for (const job of body.jobs.slice(0, 20)) {
    const time = job.durationSeconds != null
      ? est.formatDuration(job.durationSeconds)
      : job.elapsedSeconds != null
        ? `${est.formatDuration(job.elapsedSeconds)}+`
        : '-';
    const detail = job.status === 'running'
      ? `${job.progress != null ? `${job.progress}%` : ''} ${job.stage || ''}`.trim()
      : job.status === 'queued'
        ? `position ${job.queuePosition || '?'}`
        : job.error
          ? job.error.slice(0, 48)
          : Object.keys(job.artifacts || {}).join(',');

    console.log(
      job.jobId.padEnd(26) +
        colored(job.status).padEnd(10 + (useColor ? 9 : 0)) +
        String(job.mode || '-').padEnd(7) +
        (job.targets || []).join(',').padEnd(16) +
        String(time).padEnd(8) +
        detail
    );
  }
}

async function cmdShow() {
  const job = await api(`/api/jobs/${requireId()}`);
  if (opts.json) return console.log(JSON.stringify(job, null, 2));

  const rows = [
    ['Job', job.jobId],
    ['Status', colored(job.status)],
    ['Stage', job.stage || '-'],
    ['Mode', job.mode],
    ['Targets', (job.targets || []).join(', ')],
    ['Slot', job.slot != null ? job.slot : '-'],
    ['Progress', job.progress != null ? `${job.progress}%` : '-'],
    ['Elapsed', job.elapsedSeconds != null ? est.formatDuration(job.elapsedSeconds) : '-'],
    ['Estimate', job.estimate ? `${est.formatDuration(job.estimate.seconds)} (${job.estimate.basis})` : '-'],
    ['ETA', job.etaSeconds != null ? est.formatDuration(job.etaSeconds) : '-'],
    ['Created', job.createdAt],
    ['Finished', job.finishedAt || '-'],
    ['Artifacts', Object.keys(job.artifacts || {}).join(', ') || '-'],
    ['Error', job.error || '-']
  ];
  for (const [label, value] of rows) console.log(`${paint(1, `${label}:`.padEnd(11))} ${value}`);
  if (job.buildFailures && job.buildFailures.length > 0) {
    console.log(`${paint(1, 'Failures:'.padEnd(11))} ${job.buildFailures.join('\n' + ' '.repeat(12))}`);
  }
}

async function cmdLogs() {
  const body = await api(`/api/jobs/${requireId()}/log`);
  if (opts.json) return console.log(JSON.stringify(body, null, 2));
  console.log((body.lines || []).join('\n'));
  console.log(paint(90, `\n-- ${body.status}${body.stage ? ` (${body.stage})` : ''} --`));
}

async function cmdCancel() {
  if (opts.all) {
    const body = await api('/api/jobs/cancel-all', { method: 'POST' });
    if (opts.json) return console.log(JSON.stringify(body, null, 2));
    if (body.cancelled === 0) return console.log('Nothing was running or queued.');
    console.log(`Cancelled ${body.cancelled} job(s):`);
    for (const j of body.jobs) console.log(`  ${j.jobId}  (was ${j.was})`);
    return;
  }

  const id = requireId();
  const body = await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
  if (opts.json) return console.log(JSON.stringify(body, null, 2));
  console.log(`Cancelled ${body.jobId} (was ${body.was}).`);
}

async function cmdWatch() {
  const id = requireId();
  let lastLine = 0;
  for (;;) {
    const job = await api(`/api/jobs/${id}`);
    const logs = await api(`/api/jobs/${id}/log`);
    const lines = logs.lines || [];
    for (const line of lines.slice(lastLine)) console.log(line);
    lastLine = lines.length;

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      const took = job.durationSeconds != null ? ` in ${est.formatDuration(job.durationSeconds)}` : '';
      console.log(paint(90, `\n-- ${job.status}${took} --`));
      process.exit(job.status === 'completed' ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const commands = { list: cmdList, show: cmdShow, logs: cmdLogs, cancel: cmdCancel, watch: cmdWatch };

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(2);
}

commands[command]().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
