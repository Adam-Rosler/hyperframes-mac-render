#!/usr/bin/env node
// Mac render server: the slice of HeyGen's API that `hyperframes cloud` uses,
// backed by the real `hyperframes render` on this Mac's GPU. Cloud sessions set
// HEYGEN_API_URL to this server; the stock CLI then zips, uploads, submits,
// polls and downloads exactly as it does for HeyGen.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FPS, PRESET, RATIOS, detectAspectRatio, localRenderArgs, renderEnv } from './render-args.mjs';
import { captureBudget, parseCaptureTuning } from './capture-tuning.mjs';
import { SANDBOX_POLICY_REVISION, sandboxInvocation } from './sandbox.mjs';
import { createDashboardServer } from './dashboard.mjs';

// State (renders, uploads, keys, verified HyperFrames) is durable, so it lives in
// Application Support, apart from the app files uninstall removes. Earlier
// versions kept it in Library/Caches, which macOS may purge; it is moved once.
export const DEFAULTS = {
  config: join(homedir(), '.config/hyperframes-mac-render/mac-render.json'),
  data: join(homedir(), 'Library/Application Support/hyperframes-mac-render-state'),
  legacyData: join(homedir(), 'Library/Caches/hyperframes-mac-render'),
};

// Moves state from `legacy` to `dataDir` once (a single rename on one volume).
// The owner tag of the old location is kept, so processes a server left running
// there are still found and stopped. Record paths are derived from ids on load.
export function migrateState(legacy, dataDir) {
  if (!legacy || legacy === dataDir || !existsSync(legacy)) return false;
  if (existsSync(dataDir)) {
    // Only an empty folder may be replaced, and non-recursively: if anything
    // appears in it meanwhile, rmdir fails (ENOTEMPTY) and nothing is lost.
    try { rmdirSync(dataDir); } catch (e) {
      if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e;
      throw new Error(`Render state exists in both ${legacy} and ${dataDir}. Refusing to start rather than ignore either; merge or remove one, then restart.`);
    }
  }
  mkdirSync(join(dataDir, '..'), { recursive: true });
  const tagFile = join(legacy, 'owner-tag');
  if (existsSync(tagFile)) readOwnerTag(tagFile); // refuses an invalid tag before anything moves
  else writeOwnerTag(tagFile, sha256(legacy).slice(0, 16));
  renameSync(legacy, dataDir);
  console.log(new Date().toISOString(), `moved state from ${legacy} to ${dataDir}`);
  return true;
}
const LIMITS = {
  keepMs: 7 * 24 * 3600e3,
  graceMs: 5 * 60e3,
  uploadBytes: 4e9,
  projectUrlBytes: 4e9,
  zipEntries: 50000,
  zipExpandedBytes: 8e9,
  jsonBytes: 1e6,
  queued: 20,
  pendingUploads: 50,
  authFailuresPerMinute: 30,
  authClients: 1024,
  authWindowMs: 60e3,
  renderMs: 3 * 3600e3,
  stepMs: 15 * 60e3,
  reapAfterFailureMs: 15e3,
  attempts: 2,
};
const FAILED_RENDER = /✗\s+Render failed/; // HyperFrames 0.8.77 can print this and never exit.
const QUALITY = ['draft', 'standard', 'high'];
const FORMAT = { mp4: '.mp4', webm: '.webm', mov: '.mov' };

const log = (...a) => console.log(new Date().toISOString(), ...a);
const now = () => Math.floor(Date.now() / 1000);
const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const sign = () => randomBytes(24).toString('base64url');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

class ApiError extends Error {
  constructor(status, code, message, param = null) { super(message); Object.assign(this, { status, code, param }); }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

// A data folder's owner tag: exactly 16 lowercase hex characters, written
// atomically. Anything else is refused, since the tag is a prefix for which
// processes may be stopped.
const TAG = /^[0-9a-f]{16}$/;
function readOwnerTag(file) {
  const tag = readFileSync(file, 'utf8').trim();
  if (!TAG.test(tag)) throw new Error(`Invalid owner tag in ${file}; expected 16 lowercase hex characters. Refusing to start.`);
  return tag;
}
function writeOwnerTag(file, tag) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, tag);
  renameSync(tmp, file);
}

// ---- process ownership. Every child the server starts gets MAC_RENDER_OWNER=
// <instance>:<job>:<step> in its environment, which every descendant inherits,
// including detached ones such as Chrome's browser and helpers. A process group
// is owned once any of its processes carries the token, and stays owned until
// its last member exits (a group id cannot be reused while it has members), so a
// leader exiting first does not release its helpers. Nothing without the token is
// ever signalled: a user's `tail` of a render log is not ours.
const OWNER_VAR = 'MAC_RENDER_OWNER';
const PS_ENV = process.platform === 'darwin' ? ['-axwwE', '-o', 'pid=,pgid=,command='] : ['axwwe', '-o', 'pid=,pgid=,command='];

function processList() {
  try {
    return execFileSync('ps', PS_ENV, { timeout: 10e3, maxBuffer: 256e6 }).toString().split('\n')
      .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
      .map(([, pid, pgid, command]) => ({ pid: Number(pid), pgid: Number(pgid), command }));
  } catch { return null; }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Exact token, or any token under a prefix (recovery after a crash).
function ownerMatcher(token, { prefix = false } = {}) {
  // A prefix covers this instance's tokens (`<tag>:`) and its validation servers' (`<tag>-v`).
  const re = new RegExp(`(?:^|\\s)${OWNER_VAR}=${escapeRe(token)}${prefix ? '(?::|-v[0-9a-f]{6}:)' : '(?=\\s|$)'}`);
  return (p) => re.test(p.command);
}

// Stops every group owned under `matches` (plus `groups`, the ids of children
// just started) and resolves once none has a member left. Fails closed: when ps
// cannot run, nothing counts as gone.
async function stopOwned(matches, groups = [], onSlow = () => {}) {
  const known = new Set(groups);
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const list = processList();
    if (list) {
      for (const p of list) if (matches(p)) known.add(p.pgid);
      known.delete(list.find((p) => p.pid === process.pid)?.pgid);
      const live = [...known].filter((g) => g > 1 && list.some((p) => p.pgid === g));
      // A group this snapshot shows empty is finished; forget it, so a recycled
      // id is never signalled while another group keeps cleanup waiting.
      for (const g of [...known]) if (!live.includes(g)) known.delete(g);
      if (live.length === 0) return;
      for (const g of live) try { process.kill(-g, 'SIGKILL'); } catch {}
    }
    if (attempt > 0 && attempt % 200 === 0) onSlow(Math.round((Date.now() - started) / 1000), list === null);
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

// A connection owns this local state directory until it closes or its process
// dies. Keep the file outside the directory so migration cannot move it, and
// never unlink it: replacing a locked inode would let a second owner in.
function acquireStateLease(dataDirs) {
  const canonical = [...new Set(dataDirs.filter(Boolean).map((dataDir) => {
    const absolute = resolve(dataDir);
    mkdirSync(dirname(absolute), { recursive: true });
    return existsSync(absolute) ? realpathSync.native(absolute) : join(realpathSync.native(dirname(absolute)), basename(absolute));
  }))].sort();
  const held = [];
  try {
    for (const dir of canonical) {
      // Also coalesce first-open case aliases before the directory exists on Mac.
      const identity = process.platform === 'darwin' ? dir.normalize('NFD').toLowerCase() : dir;
      const db = new DatabaseSync(join(dirname(dir), `.mac-render-${sha256(identity)}.lease.sqlite`));
      held.push(db);
      // First-open contenders can briefly block each other's schema reads. A
      // bounded wait lets one win; a live owner still rejects this launch.
      try { db.exec('PRAGMA busy_timeout = 1000; BEGIN EXCLUSIVE'); } catch (e) {
        if (e.errcode === 5 || e.errcode === 6) throw new Error(`Another render server owns ${dir}. Stop it before starting this instance.`);
        throw e;
      }
    }
  } catch (e) {
    for (const db of held.reverse()) db.close();
    throw e;
  }
  return () => { while (held.length) held.pop().close(); };
}

export function createRenderServer(options = {}) {
  const dataDir = options.dataDir ?? DEFAULTS.data;
  // Keep the old location reserved too: its owner prefix moves with the state,
  // and a second instance must not recreate the old store while this one runs.
  const releaseLease = acquireStateLease([dataDir, options.legacyData]);
  try {
    if (options.legacyData) migrateState(options.legacyData, dataDir);
    return createOwnedRenderServer({ ...options, dataDir }, releaseLease);
  } catch (e) {
    releaseLease();
    throw e;
  }
}

function createOwnedRenderServer(options, releaseLease) {
  const {
    configPath = DEFAULTS.config, dataDir = DEFAULTS.data, renderer, limits: overrides = {},
    allowHttpProjectUrls = false, ownerTag: ownerTagOption = null,
    // Seams for tests of the version policy; production uses npm and HyperFrames.
    lookupLatest = null, prepareVersion = null, rendererFor = null, npmEnv = {},
    // Tests use injected renderers on Linux; deployed services always isolate.
    isolate = true,
  } = options;
  const guarded = (argv, settings) => {
    if (!isolate) return { argv, env: settings.env ?? process.env };
    mkdirSync(settings.scratchDir, { recursive: true });
    const scratchDir = mkdtempSync(join(settings.scratchDir, 'stage-'));
    return sandboxInvocation(argv, { ...settings, scratchDir });
  };
  const limits = { ...LIMITS, ...overrides };
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // GPU encoding for MP4: MAC_RENDER_GPU=1/0 overrides the config's persisted `gpu`.
  const gpu = options.gpu ?? (process.env.MAC_RENDER_GPU ? process.env.MAC_RENDER_GPU === '1' : config.gpu === true);
  const captureTuning = parseCaptureTuning(options.captureTuning ?? process.env.MAC_RENDER_CAPTURE_CORES ?? config.captureTuning);
  const renderProfile = (version) => ({ gpu, captureCoresPerWorker: captureBudget({ tuning: captureTuning, version, gpu, quality: 'high', resolution: '4k' }) });
  const key = Buffer.from(config.token);
  const dirs = Object.fromEntries(['assets', 'renders', 'hyperframes', 'quarantine', 'smoke']
    .map((d) => [d, join(dataDir, d)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // The prefix of every owner token this data folder's servers use, kept with the
  // data so that it survives a move of the folder.
  const tagFile = join(dataDir, 'owner-tag');
  let ownerTag = ownerTagOption;
  if (ownerTag !== null && !/^[0-9a-f]{16}(-v[0-9a-f]{6})?$/.test(ownerTag)) throw new Error(`Invalid owner tag option ${JSON.stringify(ownerTag)}.`);
  if (ownerTag === null) {
    if (!existsSync(tagFile)) writeOwnerTag(tagFile, sha256(dataDir).slice(0, 16));
    ownerTag = readOwnerTag(tagFile);
  }

  const assets = new Map();
  const renders = new Map();
  const idemIndex = new Map();
  const queue = [];
  let active = null;
  let activePhase = null;
  let activeWork = null;
  let stopping = false;
  let shutdownPromise = null;
  const requests = new Set();
  const fileReaders = new Map();
  let purgeTimer = null;
  const authFailures = new Map();

  // ---- persistence: one JSON record per asset and per render, written atomically.
  const assetFile = (a) => join(dirs.assets, `${a.asset_id}.json`);
  const renderDir = (r) => join(dirs.renders, r.render_id);
  const saveAsset = (a) => writeJsonAtomic(assetFile(a), a);
  const saveRender = (r) => { if (!r.deleted) writeJsonAtomic(join(renderDir(r), 'render.json'), r); };

  function load(file) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      const dest = join(dirs.quarantine, `${Date.now()}-${basename(file)}`);
      try { renameSync(file, dest); } catch {}
      log(`quarantined unreadable record ${file}: ${e.message}`);
      return null;
    }
  }
  for (const f of readdirSync(dirs.assets).filter((n) => n.endsWith('.json'))) {
    const a = load(join(dirs.assets, f));
    if (a) { a.uploading = false; a.file = join(dirs.assets, `${a.asset_id}.zip`); assets.set(a.asset_id, a); indexKey(a, a.asset_id); }
  }
  const restored = [];
  const tombstones = [];
  for (const d of readdirSync(dirs.renders)) {
    const file = join(dirs.renders, d, 'render.json');
    if (!existsSync(file)) continue;
    const r = load(file);
    if (r?.deleted) { tombstones.push(r); continue; }
    if (r?.video_file) r.video_file = join(dirs.renders, r.render_id, basename(r.video_file));
    if (r) { renders.set(r.render_id, r); restored.push(r); indexKey(r, r.render_id); }
  }
  // Upgrade: earlier versions kept idempotency keys in idempotency/<kind>-<hash>.json.
  // Each is written into its asset or render record first, then removed, so an
  // interrupted migration resumes on the next start without losing a key.
  const legacyIdem = join(dataDir, 'idempotency');
  if (existsSync(legacyIdem)) {
    for (const f of readdirSync(legacyIdem).filter((n) => /^(upload|render)-[0-9a-f]{64}\.json$/.test(n))) {
      const file = join(legacyIdem, f);
      const entry = load(file);
      const [kind, hash] = f.replace(/\.json$/, '').split('-');
      const record = entry && (kind === 'upload' ? assets.get(entry.id) : renders.get(entry.id));
      if (record && !record.idempotency) {
        record.idempotency = { slot: `${kind}:${hash}`, fingerprint: entry.fingerprint };
        if (kind === 'upload') saveAsset(record); else saveRender(record);
        indexKey(record, entry.id);
      }
      rmSync(file, { force: true });
    }
    if (readdirSync(legacyIdem).length === 0) rmSync(legacyIdem, { recursive: true, force: true });
  }

  // Reconcile work from a previous process: stop any renderer it left behind,
  // then resume in submission order. A render interrupted mid-way gets one retry.
  for (const r of restored.sort((a, b) => a.created_at - b.created_at || a.seq - b.seq)) {
    if (r.status !== 'queued' && r.status !== 'rendering') continue;
    if (r.status === 'rendering') {
      if ((r.attempts ?? 0) >= limits.attempts) {
        Object.assign(r, { status: 'failed', completed_at: now(), failure_message: 'The render was interrupted twice by a restart of the Mac render server.' });
        saveRender(r);
        continue;
      }
      Object.assign(r, { status: 'queued', pid: null });
      saveRender(r);
    }
    queue.push(r);
  }
  // A render deleted just before a crash stays deleted: stop anything it left
  // running, and remove its folder once that has exited.
  let seq = Math.max(0, ...restored.map((r) => r.seq ?? 0), ...tombstones.map((r) => r.seq ?? 0));

  // ---- jobs: one cancellation owner per render covers every stage (download,
  // unzip, install, validation, render). Each stage checks it before starting, and
  // cancelling stops whichever child is running.
  const controls = new Map();
  class Cancelled extends Error {}
  function control(r) {
    const c = { abort: new AbortController(), reason: null, current: null, record: r };
    controls.set(r.render_id, c);
    return c;
  }
  function cancel(r, reason) {
    const c = controls.get(r.render_id);
    if (!c || c.abort.signal.aborted) return;
    c.reason = reason;
    c.abort.abort(new Cancelled(reason));
    c.current?.stop(reason);
  }
  const checkpoint = (c) => { if (c?.abort.signal.aborted) throw new Cancelled(c.reason); };

  // ---- processes: every child is detached into its own group, logged, time-bounded
  // and killed as a group, so neither a hang nor a restart leaves a renderer behind.
  function run(argv, { cwd, logTo, env = process.env, timeoutMs = limits.stepMs, job, owner, step = 'step', reapOnFailureLog = false, capture = false, maxStdoutBytes = null }) {
    const token = `${ownerTag}:${owner?.render_id ?? 'server'}:${step}:${randomBytes(4).toString('hex')}`;
    const owns = ownerMatcher(token);
    return new Promise((resolve) => {
      if (job?.abort.signal.aborted) return resolve({ code: 1, reason: job.reason, stdout: '' });
      let stdout = '';
      let stdoutBytes = 0;
      let settled = false;
      let chain = Promise.resolve();
      const append = (d) => { chain = chain.then(() => appendFile(logTo, d)).catch(() => {}); };
      let child;
      let stopReason = null;
      let reap = null;
      let deadline = null;
      // SIGTERM/SIGKILL for the child's group and every group marked with this job.
      const signalOwned = (sig) => {
        const list = processList() ?? [];
        const groups = new Set(list.filter(owns).map((p) => p.pgid));
        if (child?.pid) groups.add(child.pid);
        groups.delete(list.find((p) => p.pid === process.pid)?.pgid);
        for (const g of groups) if (g > 1) try { process.kill(-g, sig); } catch {}
      };
      // The job keeps its processes (and its place at the head of the queue) until
      // every one of them is gone.
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(reap);
        if (job) job.current = null;
        chain
          .then(() => stopOwned(owns, child?.pid ? [child.pid] : [], (s, blind) => append(`[mac-render] still stopping processes after ${s}s${blind ? ' (ps unavailable)' : ''}\n`)))
          .then(() => { if (owner) { owner.pid = null; saveRender(owner); } return chain; })
          .then(() => resolve({ ...result, stdout }));
      };
      const stop = (reason) => {
        if (settled) return;
        stopReason ??= reason;
        signalOwned('SIGTERM');
        setTimeout(() => { if (!settled) signalOwned('SIGKILL'); }, 5e3).unref();
      };
      try {
        child = spawn(argv[0], argv.slice(1), { cwd, env: { ...env, [OWNER_VAR]: token }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (e) {
        append(`[mac-render] could not start ${argv[0]}: ${e.message}\n`);
        return finish({ code: 127, reason: `could not start ${basename(argv[0])}: ${e.message}` });
      }
      child.on('error', (e) => {
        append(`[mac-render] could not start ${argv[0]}: ${e.message}\n`);
        finish({ code: 127, reason: `could not start ${basename(argv[0])}: ${e.message}` });
      });
      if (!child.pid) return;
      deadline = setTimeout(() => stop(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
      if (job) job.current = { stop };
      if (owner) { owner.pid = child.pid; saveRender(owner); }
      spawn('caffeinate', ['-i', '-w', String(child.pid)], { stdio: 'ignore' }).on('error', () => {});
      const onData = (d) => {
        append(d);
        if (reapOnFailureLog && !reap && FAILED_RENDER.test(d.toString())) {
          reap = setTimeout(() => stop('hyperframes reported failure but did not exit'), limits.reapAfterFailureMs);
        }
      };
      child.stdout.on('data', (d) => {
        if (maxStdoutBytes !== null) {
          stdoutBytes += d.length;
          if (stdoutBytes > maxStdoutBytes && !stopReason) stop(`expanded project exceeds the ${maxStdoutBytes} byte limit`);
          return;
        }
        if (capture && stdout.length < 1e6) stdout += d;
        onData(d);
      });
      child.stderr.on('data', onData);
      child.on(capture || maxStdoutBytes !== null ? 'close' : 'exit', (code, signal) => {
        if (stopReason) append(`\n[mac-render] ${stopReason}\n`);
        finish({ code: stopReason ? 1 : code ?? (signal ? 128 : 1), reason: stopReason });
      });
    });
  }

  // ---- HyperFrames version: every job renders with the latest release on npm,
  // looked up when the job starts. A release is installed and must pass the stock
  // `hyperframes cloud render` contract against a private copy of this server
  // before its first use; once verified it is reused until npm has a newer one.
  // If the lookup, install or validation fails, the job fails: an older release
  // is never used instead. A failed candidate is tried again by the next job.
  const knownGoodFile = join(dirs.hyperframes, 'known-good.json');
  const receipt = existsSync(knownGoodFile) ? load(knownGoodFile) : null;
  let verified = receipt?.policy === SANDBOX_POLICY_REVISION
    && JSON.stringify(receipt.render_profile) === JSON.stringify(renderProfile(receipt.version)) ? receipt.version : null;
  let latestSeen = null;

  const binFor = (version) => {
    const pkgDir = join(dirs.hyperframes, version, 'node_modules/hyperframes');
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    return join(pkgDir, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.hyperframes);
  };

  const nativeRenderer = (version) => ({ argv: [process.execPath, binFor(version)], version, readOnly: [join(dirs.hyperframes, version, 'node_modules')] });

  async function probe(file, logTo, job, owner) {
    const command = guarded(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=width,height,nb_read_packets:format=duration', '-of', 'json', file], {
      scratchDir: join(owner ? renderDir(owner) : dirname(file), 'stages'), readOnly: [file],
    });
    const { code, stdout } = await run(command.argv, { env: command.env, cwd: dirname(file), logTo, job, owner, step: 'probe', timeoutMs: 120e3, capture: true });
    if (code !== 0) return null;
    try {
      const result = JSON.parse(stdout);
      const stream = result.streams?.[0];
      return { duration: Number(result.format?.duration), frames: Number(stream?.nb_read_packets), width: stream?.width, height: stream?.height };
    } catch { return null; }
  }

  async function install(version, logTo, job) {
    // Only called for a release not yet verified, so npm always runs: a
    // package.json left by an interrupted install is not proof of a complete one.
    const prefix = join(dirs.hyperframes, version);
    mkdirSync(prefix, { recursive: true });
    writeFileSync(join(prefix, 'package.json'), '{"private":true}\n');
    await appendFile(logTo, `[mac-render] installing hyperframes@${version}\n`);
    const installed = await run(['npm', 'install', '--no-audit', '--no-fund', `hyperframes@${version}`], { cwd: prefix, logTo, job, step: `install-${version}` });
    checkpoint(job);
    if (installed.code !== 0) return false;
    const { code } = await run([process.execPath, binFor(version), 'browser', 'ensure'], { cwd: prefix, logTo, job, step: `browser-${version}` });
    checkpoint(job);
    return code === 0;
  }

  // Runs the candidate's own CLI (`hyperframes cloud render`) against a private
  // instance of this server that renders with the candidate under the same GPU
  // policy as real jobs, then fully decodes the result. The fixture is 2 s (60
  // frames), long enough that capture uses more than one worker.
  async function validate(version, logTo, job) {
    const root = join(dirs.smoke, `${version}-${randomBytes(4).toString('hex')}`);
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'index.html'), '<!doctype html><html><body style="margin:0"><div data-composition-id="root" data-no-timeline data-width="320" data-height="180" data-duration="2" style="width:320px;height:180px;background:linear-gradient(90deg,#123,#39f);filter:blur(1px)"></div></body></html>');
    const token = randomBytes(24).toString('base64url');
    writeFileSync(join(root, 'config.json'), JSON.stringify({ token, port: 0 }));
    const bin = binFor(version);
    const inner = createRenderServer({ configPath: join(root, 'config.json'), dataDir: join(root, 'data'), renderer: nativeRenderer(version), limits: { renderMs: 10 * 60e3 }, gpu, captureTuning: captureTuning ?? 'auto', isolate, ownerTag: `${ownerTag}-v${randomBytes(3).toString('hex')}` });
    try {
      await new Promise((ok, reject) => {
        inner.server.once('error', reject);
        inner.server.listen(0, '127.0.0.1', () => { inner.server.off('error', reject); ok(); });
      });
      const out = join(root, 'contract.mp4');
      const tuned = renderProfile(version).captureCoresPerWorker !== null;
      const { code } = await run([process.execPath, bin, 'cloud', 'render', project, '-o', out, '--quality', tuned ? 'high' : 'draft', '--resolution', tuned ? '4k' : '1080p', '--poll-interval', '1'], {
        cwd: root, logTo, job, step: `validate-${version}`, timeoutMs: 10 * 60e3,
        env: { ...process.env, CI: '1', NO_COLOR: '1', HYPERFRAMES_SKIP_SKILLS: '1', HEYGEN_API_URL: `http://127.0.0.1:${inner.server.address().port}`, HEYGEN_API_KEY: token },
      });
      checkpoint(job);
      const info = code === 0 && existsSync(out) ? await probe(out, logTo, job) : null;
      if (!(info?.frames === 60 && info.width === (tuned ? 3840 : 1920) && info.height === (tuned ? 2160 : 1080))) return false;
      const decode = guarded(['ffmpeg', '-v', 'error', '-xerror', '-i', out, '-f', 'null', '-'], { scratchDir: join(root, 'stages'), readOnly: [out] });
      const decoded = await run(decode.argv, { env: decode.env, cwd: root, logTo, job, step: 'validate-decode', timeoutMs: 120e3 });
      checkpoint(job);
      return decoded.code === 0;
    } finally {
      await inner.shutdown();
      inner.server.closeAllConnections?.();
      rmSync(root, { recursive: true, force: true });
    }
  }

  // The release npm's registry tags `latest` right now. npm falls back to its
  // cache once retries run out, even with --prefer-online, so each lookup gets
  // its own empty cache and no retries: the answer can only come from the registry.
  // Registry, proxy and auth settings still apply. Owned, cancellable and
  // time-bounded like every other step; null if the registry does not answer.
  async function npmLatest(logTo, job) {
    const cache = mkdtempSync(join(tmpdir(), 'mac-render-npm-view-'));
    try {
      const { code, stdout } = await run(['npm', 'view', 'hyperframes@latest', 'version', '--cache', cache, '--fetch-retries=0'], { cwd: dataDir, logTo, job, step: 'lookup', timeoutMs: 60e3, capture: true, env: { ...process.env, ...npmEnv } });
      return code === 0 ? stdout.trim() || null : null;
    } finally { rmSync(cache, { recursive: true, force: true }); }
  }

  async function hyperframes(logTo, job) {
    if (renderer) return renderer;
    const latest = await (lookupLatest ?? npmLatest)(logTo, job);
    checkpoint(job);
    if (!latest || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(latest)) {
      throw new Error('Could not look up the latest HyperFrames release on npm. The Mac renders only with the latest release, so this render did not start.');
    }
    latestSeen = latest;
    if (job?.record) job.record.hyperframes_checked_at = now();
    await appendFile(logTo, `[mac-render] latest HyperFrames on npm at ${new Date().toISOString()}: ${latest}\n`).catch(() => {});
    if (verified !== latest) {
      await appendFile(logTo, `[mac-render] validating hyperframes@${latest} against the cloud render contract\n`).catch(() => {});
      let ok = false;
      try {
        ok = await (prepareVersion ?? (async (v) => await install(v, logTo, job) && await validate(v, logTo, job)))(latest, logTo, job);
      } catch (e) { if (e instanceof Cancelled) throw e; }
      checkpoint(job);
      if (!ok) {
        log(`hyperframes ${latest} failed installation or validation`);
        throw new Error(`HyperFrames ${latest}, the latest release, failed to install or pass validation on the Mac, so this render did not start. An older release is never used; the next render tries ${latest} again.`);
      }
      verified = latest;
      writeJsonAtomic(knownGoodFile, { version: verified, policy: SANDBOX_POLICY_REVISION, render_profile: renderProfile(verified), promoted_at: now() });
      log(`verified hyperframes ${verified}`);
    }
    return rendererFor ? rendererFor(latest) : nativeRenderer(latest);
  }

  // ---- rendering
  async function execute(r) {
    const dir = renderDir(r);
    const logTo = join(dir, 'render.log');
    const projectDir = join(dir, 'project');
    const job = control(r);
    activePhase = 'preparing';
    r.attempts = (r.attempts ?? 0) + 1;
    Object.assign(r, { status: 'rendering', started_at: now() });
    saveRender(r);
    try {
      const zip = await projectZip(r, dir, logTo, job);
      checkpoint(job);
      await unzip(zip, projectDir, logTo, job, r);
      checkpoint(job);
      // Like HeyGen, render the composition's authored ratio; never reshape it.
      const entry = join(projectDir, r.composition ?? 'index.html');
      if (!existsSync(entry)) throw new Error(`Composition "${r.composition ?? 'index.html'}" is not in the project.`);
      const authored = detectAspectRatio(readFileSync(entry, 'utf8'));
      if (r.aspect_ratio && authored && authored !== r.aspect_ratio) {
        throw new Error(`aspect_ratio ${r.aspect_ratio} doesn't match the composition (${authored}); the renderer can't reshape it.`);
      }
      r.aspect_ratio ??= authored ?? '16:9';
      const hf = await hyperframes(logTo, job);
      checkpoint(job);
      r.hyperframes_version = hf.version;
      const jobTmp = join(dir, 'tmp');
      mkdirSync(jobTmp, { recursive: true });
      const output = join(jobTmp, `video${FORMAT[r.format]}`);
      await appendFile(logTo, `[mac-render] ${hostname()} (${chip()}) hyperframes ${hf.version}\n`);
      const t0 = Date.now();
      const args = localRenderArgs({
        dir: projectDir, output, quality: r.quality, format: r.format, fps: r.fps, resolution: r.resolution,
        aspectRatio: r.aspect_ratio, composition: r.composition, variables: r.variables, gpu,
      });
      const encoder = args.find((a) => a.startsWith('--video-bitrate='));
      await appendFile(logTo, `[mac-render] requested encoder: ${encoder ? `GPU at ${encoder.slice(16)} (HyperFrames may fall back to CPU)` : 'CPU'}\n`);
      const captureCoresPerWorker = captureBudget({ tuning: captureTuning, version: hf.version, gpu, format: r.format, quality: r.quality, fps: r.fps ?? DEFAULT_FPS, resolution: r.resolution });
      if (captureCoresPerWorker !== null) await appendFile(logTo, `[mac-render] automatic capture sizing: ${captureCoresPerWorker} cores per worker (configured for HyperFrames ${hf.version})\n`);
      const command = guarded([...hf.argv, ...args], {
        scratchDir: join(dir, 'stages'), readOnly: hf.readOnly ?? [], readWrite: [projectDir, jobTmp], browserCaches: true,
        browserPath: process.env.PRODUCER_HEADLESS_SHELL_PATH ?? process.env.HYPERFRAMES_BROWSER_PATH,
        env: {
          ...process.env, PRODUCER_CORES_PER_WORKER: undefined, CI: '1', NO_COLOR: '1', HYPERFRAMES_SKIP_SKILLS: '1', ...renderEnv({ format: r.format, gpu, captureCoresPerWorker }),
          TMPDIR: jobTmp, HYPERFRAMES_EXTRACT_CACHE_DIR: join(jobTmp, 'extract-cache'),
        },
      });
      activePhase = 'rendering';
      const { code, reason } = await run(command.argv, {
        env: command.env, cwd: projectDir, logTo, job, owner: r, step: 'render', timeoutMs: limits.renderMs, reapOnFailureLog: true,
      });
      r.render_seconds = (Date.now() - t0) / 1000;
      checkpoint(job);
      if (code !== 0 || !existsSync(output)) throw new Error(`hyperframes render ${reason ?? `exited with ${code}`}\n${tail(logTo)}`);
      const published = join(dir, `video${FORMAT[r.format]}`);
      renameSync(output, published);
      if (!lstatSync(published).isFile() || lstatSync(published).isSymbolicLink()) throw new Error('Renderer output must be a regular video file.');
      const info = await probe(published, logTo, job, r);
      checkpoint(job);
      if (!info || ![info.duration, info.frames, info.width, info.height].every((value) => Number.isFinite(value) && value > 0)) {
        throw new Error('hyperframes render exited successfully but produced no readable video with frames, dimensions and duration.');
      }
      Object.assign(r, { status: 'completed', completed_at: now(), duration: info.duration, video_file: published, video_sig: sign() });
    } catch (e) {
      if (!(e instanceof Cancelled) && !job.abort.signal.aborted) {
        Object.assign(r, { status: 'failed', completed_at: now(), failure_message: e.message.slice(0, 4000) });
      }
    } finally {
      controls.delete(r.render_id);
      r.pid = null;
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(join(dir, 'tmp'), { recursive: true, force: true });
      rmSync(join(dir, 'stages'), { recursive: true, force: true });
      if (!r.requeue) rmSync(join(dir, 'project.zip'), { recursive: true, force: true });
      if (r.deleted) rmSync(dir, { recursive: true, force: true });
      else if (r.requeue) { delete r.requeue; r.status = 'queued'; saveRender(r); }
      else { saveRender(r); notify(r); }
      log(`render ${r.render_id} ${r.deleted ? 'deleted' : r.status} after ${r.render_seconds ?? '-'}s`);
    }
  }

  async function projectZip(r, dir, logTo, job) {
    if (r.project.type === 'asset_id') {
      const a = assets.get(r.project.asset_id);
      if (!a?.completed || !existsSync(a.file)) throw new Error(`asset ${r.project.asset_id} is not available`);
      return a.file;
    }
    const file = join(dir, 'project.zip');
    const res = await fetch(r.project.url, { signal: AbortSignal.any([job.abort.signal, AbortSignal.timeout(limits.stepMs)]) });
    if (!res.ok || !res.body) throw new Error(`could not download project zip: HTTP ${res.status}`);
    let bytes = 0;
    await pipeline(async function* () {
      for await (const chunk of res.body) {
        bytes += chunk.length;
        if (bytes > limits.projectUrlBytes) throw new Error(`project zip is larger than ${limits.projectUrlBytes} bytes`);
        yield chunk;
      }
    }, createWriteStream(file), { signal: job.abort.signal });
    await appendFile(logTo, `[mac-render] downloaded project zip (${bytes} bytes)\n`);
    return file;
  }

  async function unzip(zip, dest, logTo, job, owner) {
    // Metadata is a quick rejection only; count actual inflated bytes as well.
    const settings = { scratchDir: join(dirname(dest), 'stages'), readOnly: [zip], readWrite: [dest] };
    mkdirSync(dest, { recursive: true });
    const list = guarded(['zipinfo', '-t', zip], settings);
    let summary = '';
    const listed = await run(list.argv, { env: list.env, cwd: dest, logTo, job, owner, step: 'zipinfo', timeoutMs: 60e3, capture: true });
    checkpoint(job);
    if (listed.code !== 0) throw new Error('project zip could not be read');
    summary = listed.stdout;
    const [, entries, expanded] = summary.match(/(\d+) files?, (\d+) bytes uncompressed/) ?? [];
    if (entries === undefined) throw new Error('project zip could not be read');
    if (Number(entries) > limits.zipEntries) throw new Error(`project zip has ${entries} entries; the limit is ${limits.zipEntries}`);
    if (Number(expanded) > limits.zipExpandedBytes) throw new Error(`project zip expands to ${expanded} bytes; the limit is ${limits.zipExpandedBytes}`);
    const inflate = guarded(['unzip', '-p', zip], settings);
    const inflated = await run(inflate.argv, {
      env: inflate.env, cwd: dest, logTo, job, owner, step: 'inflate-check', maxStdoutBytes: limits.zipExpandedBytes,
    });
    checkpoint(job);
    if (inflated.code !== 0) throw new Error(inflated.reason ?? 'project zip could not be fully decompressed');
    const extract = guarded(['unzip', '-q', '-o', zip, '-d', dest], settings);
    const { code } = await run(extract.argv, { env: extract.env, cwd: dest, logTo, job, owner, step: 'unzip' });
    checkpoint(job);
    if (code !== 0) throw new Error('project zip could not be extracted');
    // unzip skips `..` entries; also refuse links, which could point outside the project.
    const walk = (d) => readdirSync(d).forEach((n) => {
      const p = join(d, n);
      const s = lstatSync(p);
      if (s.isSymbolicLink()) throw new Error(`project zip contains a symbolic link: ${n}`);
      if (s.isDirectory()) walk(p);
    });
    walk(dest);
  }

  function notify(r) {
    if (!r.callback_url) return;
    fetch(r.callback_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_type: `hyperframes.render.${r.status}`, event_data: detail(r, config.publicUrl) }),
      signal: AbortSignal.timeout(30e3),
    }).catch((e) => log(`callback for ${r.render_id} failed: ${e.message}`));
  }

  async function pump() {
    if (!recovered || active || stopping || queue.length === 0) return;
    active = queue.shift();
    activeWork = execute(active);
    try { await activeWork; } catch (e) { log(`render ${active.render_id} crashed the runner: ${e.stack}`); } finally {
      active = null;
      activePhase = null;
      activeWork = null;
      setImmediate(pump);
    }
  }

  function detail(r, base) {
    const out = {
      render_id: r.render_id, status: r.status, format: r.format, quality: r.quality, fps: r.fps ?? DEFAULT_FPS,
      resolution: r.resolution, aspect_ratio: r.aspect_ratio ?? null, composition: r.composition ?? null,
      title: r.title ?? null, callback_id: r.callback_id ?? null, duration: r.duration ?? null,
      created_at: r.created_at, completed_at: r.completed_at ?? null, failure_message: r.failure_message ?? null,
      video_url: null, thumbnail_url: null, hyperframes_version: r.hyperframes_version ?? null,
      hyperframes_checked_at: r.hyperframes_checked_at ?? null,
      sent_at: r.sent_at ?? null, purge_after: r.purge_after ?? null, purged_at: r.purged_at ?? null,
    };
    if (r.status === 'completed' && r.video_file && existsSync(r.video_file)) {
      out.video_url = `${base}/v3/files/${r.render_id}/video${FORMAT[r.format]}?sig=${r.video_sig}`;
    }
    return out;
  }

  function dashboardJob(r, phase = null) {
    return {
      render_id: r.render_id, title: typeof r.title === 'string' ? r.title : null, status: r.status, phase,
      created_at: r.created_at, started_at: r.started_at ?? null, completed_at: r.completed_at ?? null,
      render_seconds: r.render_seconds ?? null, attempts: r.attempts ?? 0,
      format: r.format, resolution: r.resolution, quality: r.quality, fps: r.fps ?? DEFAULT_FPS,
      aspect_ratio: r.aspect_ratio ?? null, hyperframes_version: r.hyperframes_version ?? null,
      sent_at: r.sent_at ?? null, purge_after: r.purge_after ?? null, purged_at: r.purged_at ?? null,
      failure_message: r.status === 'failed' ? 'Render failed. Inspect the render log on this Mac.' : null,
    };
  }

  const dashboard = createDashboardServer(() => {
    const recent = [...renders.values()].filter((r) => !r.deleted && ['completed', 'failed'].includes(r.status))
      .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0) || (b.seq ?? 0) - (a.seq ?? 0));
    return {
      observed_at: now(),
      service: {
        host: hostname(), chip: chip(), state: stopping ? 'stopping' : !recovered ? 'recovering' : active ? 'busy' : 'idle',
        gpu_encode: gpu, hyperframes_version: renderer?.version ?? verified, hyperframes_latest_seen: latestSeen,
        queue_capacity: limits.queued,
      },
      active: active && !active.deleted ? dashboardJob(active, activePhase) : null,
      queued: queue.filter((r) => !r.deleted).map((r) => dashboardJob(r)),
      recent: recent.slice(0, 100).map((r) => dashboardJob(r)), recent_total: recent.length,
    };
  });
  dashboard.on('error', (e) => log(`dashboard unavailable: ${e.message}; render API stays available`));

  // ---- HTTP
  const publicBase = (req) => (config.publicUrl && req.headers.host === new URL(config.publicUrl).host ? config.publicUrl : `http://${req.headers.host}`);

  // HyperFrames sends `x-api-key`. A Claude cloud environment can instead inject
  // `Authorization: Bearer` at its proxy, so the session never holds the key.
  function authorized(req) {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    return [req.headers['x-api-key'], bearer].some((value) => {
      const given = Buffer.from(String(value ?? ''));
      return given.length === key.length && timingSafeEqual(given, key);
    });
  }

  // Failed attempts are limited per client, and never block a request with a valid key.
  function rejectUnauthorized(req) {
    const time = Date.now();
    for (const [client, entry] of authFailures) {
      if (time - entry.since < limits.authWindowMs) break;
      authFailures.delete(client);
    }
    const client = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    const fresh = authFailures.get(client) ?? { since: time, count: 0 };
    if (!authFailures.has(client) && authFailures.size >= limits.authClients) authFailures.delete(authFailures.keys().next().value);
    fresh.count++;
    authFailures.set(client, fresh);
    if (fresh.count > limits.authFailuresPerMinute) throw new ApiError(429, 'rate_limit_exceeded', 'Too many failed authentication attempts.');
    throw new ApiError(401, 'authentication_failed', 'Invalid API key.');
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limits.jsonBytes) throw new ApiError(413, 'payload_too_large', 'Request body is too large.');
      chunks.push(c);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'invalid_parameter', 'Body is not valid JSON.'); }
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // Idempotency keys are bound to the request they first came with, per endpoint
  // (the CLI reuses one key for the upload and the render). The key's hash and
  // request fingerprint are stored inside the asset or render record itself, so
  // they are committed in the same atomic write; the index is rebuilt on start.
  function idempotent(kind, req, fingerprint) {
    const k = req.headers['idempotency-key'];
    if (!k) return { prior: null, stamp: null };
    const slot = `${kind}:${sha256(k)}`;
    const prior = idemIndex.get(slot);
    if (prior && prior.fingerprint !== fingerprint) {
      throw new ApiError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
    }
    return { prior: prior?.id ?? null, stamp: { slot, fingerprint } };
  }
  function indexKey(record, id) { if (record.idempotency) idemIndex.set(record.idempotency.slot, { id, fingerprint: record.idempotency.fingerprint }); }

  function drain(req) {
    return new Promise((resolve) => {
      // After an early response, Node can close the socket without ending the request.
      const socket = req.socket;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        req.off('end', done); req.off('error', done); req.off('aborted', done);
        socket.off('close', done);
        if (socket.destroyed && !req.destroyed) req.destroy();
        resolve();
      };
      if (req.readableEnded || req.destroyed || socket.destroyed) { done(); return; }
      req.once('end', done); req.once('error', done); req.once('aborted', done);
      socket.once('close', done);
      req.resume();
    });
  }

  function receiveUpload(req, a) {
    const tmp = `${a.file}.${randomBytes(6).toString('hex')}.part`;
    const hash = createHash('sha256');
    let size = 0;
    return new Promise((resolve, reject) => {
      const out = createWriteStream(tmp);
      let failure = null;
      const fail = (e) => {
        if (failure) return;
        failure = e;
        req.unpipe(out);
        out.destroy();
      };
      req.on('data', (d) => {
        size += d.length;
        hash.update(d);
        if (size > a.size_bytes) { req.unpipe(out); fail(new ApiError(413, 'payload_too_large', 'Upload is larger than declared.')); req.resume(); }
      });
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (failure) return;
        try {
          if (size !== a.size_bytes) throw new ApiError(400, 'invalid_parameter', `Uploaded ${size} bytes, expected ${a.size_bytes}.`);
          renameSync(tmp, a.file);
          Object.assign(a, { uploaded: true, received_sha256: hash.digest('hex') });
          saveAsset(a);
        } catch (e) { fail(e); }
      });
      // A route must not settle while its file descriptor can still write: the
      // state lease may be released as soon as the last route has settled.
      out.on('close', () => {
        if (failure) { rmSync(tmp, { force: true }); reject(failure); }
        else resolve();
      });
      req.pipe(out);
    });
  }

  function validateRender(body) {
    const p = body.project;
    if (!p || !['asset_id', 'url'].includes(p.type)) throw new ApiError(400, 'invalid_parameter', 'project.type must be asset_id or url.', 'project');
    if (p.type === 'asset_id' && !assets.get(p.asset_id)?.completed) throw new ApiError(400, 'invalid_parameter', 'Unknown or incomplete asset_id.', 'project.asset_id');
    if (p.type === 'url' && !(allowHttpProjectUrls ? /^https?:\/\//.test(p.url ?? '') : /^https:\/\//.test(p.url ?? ''))) {
      throw new ApiError(400, 'invalid_parameter', 'project.url must be https.', 'project.url');
    }
    const quality = body.quality ?? 'standard';
    const format = body.format ?? 'mp4';
    const resolution = body.resolution ?? '1080p';
    if (!QUALITY.includes(quality)) throw new ApiError(400, 'invalid_parameter', `quality must be one of ${QUALITY.join(', ')}.`, 'quality');
    if (typeof format !== 'string' || !Object.hasOwn(FORMAT, format)) throw new ApiError(400, 'invalid_parameter', 'format must be mp4, webm or mov.', 'format');
    if (typeof resolution !== 'string' || !Object.hasOwn(PRESET, resolution)) throw new ApiError(400, 'invalid_parameter', 'resolution must be 1080p or 4k.', 'resolution');
    if (resolution === '4k' && format !== 'mp4') throw new ApiError(400, 'invalid_parameter', '4k renders must be mp4.', 'format');
    if (body.fps != null && !(Number.isInteger(body.fps) && body.fps >= 1 && body.fps <= 240)) throw new ApiError(400, 'invalid_parameter', 'fps must be 1-240.', 'fps');
    if (body.aspect_ratio != null && (typeof body.aspect_ratio !== 'string' || !Object.hasOwn(RATIOS, body.aspect_ratio))) throw new ApiError(400, 'invalid_parameter', 'aspect_ratio must be 16:9, 9:16 or 1:1.', 'aspect_ratio');
    if (body.composition != null && (typeof body.composition !== 'string' || body.composition.startsWith('/') || body.composition.split(/[\\/]/).includes('..'))) {
      throw new ApiError(400, 'invalid_parameter', 'composition must be a path inside the project.', 'composition');
    }
    if (body.variables != null && (typeof body.variables !== 'object' || Array.isArray(body.variables))) throw new ApiError(400, 'invalid_parameter', 'variables must be an object.', 'variables');
    return { quality, format, resolution };
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const base = publicBase(req);

    // Capability URLs, like presigned S3 URLs: no API key, a per-object signature.
    if (req.method === 'PUT' && parts[0] === 'v3' && parts[1] === 'uploads' && parts.length === 3) {
      const a = assets.get(parts[2]);
      if (!a || a.upload_sig !== url.searchParams.get('sig')) throw new ApiError(403, 'forbidden', 'Invalid upload URL.');
      if (a.uploaded) {
        // The immutable archive was already received; a retry need not send it again.
        send(res, 200, {});
        await drain(req);
        return;
      }
      if (a.uploading) throw new ApiError(409, 'upload_in_progress', 'Another upload to this URL is in progress.');
      a.uploading = true;
      try { await receiveUpload(req, a); } finally { a.uploading = false; }
      return send(res, 200, {});
    }
    if (req.method === 'GET' && parts[0] === 'v3' && parts[1] === 'files' && parts.length === 4) {
      const r = renders.get(parts[2]);
      if (!r || r.deleted || r.status !== 'completed' || r.video_sig !== url.searchParams.get('sig')) {
        throw new ApiError(404, 'not_found', 'File not found.');
      }
      if (r.purged_at != null) throw new ApiError(410, 'result_deleted', 'This result was deleted from the Mac after its download grace period. The completed job receipt remains available.');
      if (!r.video_file || !existsSync(r.video_file)) throw new ApiError(404, 'not_found', 'File not found.');
      const size = statSync(r.video_file).size;
      fileReaders.set(r.render_id, (fileReaders.get(r.render_id) ?? 0) + 1);
      try {
        const source = createReadStream(r.video_file);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
        await pipeline(source, res);
        if (source.bytesRead === size && res.writableFinished && !r.deleted) {
          const sent_at = Date.now() / 1000;
          const delivery = { sent_at, purge_after: sent_at + limits.graceMs / 1000 };
          try { saveRender({ ...r, ...delivery }); Object.assign(r, delivery); }
          catch (e) { log(`could not schedule result cleanup for ${r.render_id}: ${e.message}`); }
        }
      } finally {
        const readers = fileReaders.get(r.render_id) - 1;
        if (readers) fileReaders.set(r.render_id, readers); else fileReaders.delete(r.render_id);
        schedulePurge();
      }
      return;
    }

    if (!authorized(req)) rejectUnauthorized(req);
    const path = url.pathname.replace(/\/+$/, '');
    if (req.method === 'GET' && path === '/v3/users/me') {
      return send(res, 200, { data: {
        username: 'mac-render', first_name: hostname(), email: null, host: hostname(), chip: chip(),
        hyperframes_version: renderer?.version ?? verified, hyperframes_latest_seen: latestSeen, gpu_encode: gpu,
        busy: Boolean(active), queued: queue.length,
      } });
    }
    if (req.method === 'POST' && path === '/v3/assets/direct-uploads') {
      const body = await readJson(req);
      if (!Number.isInteger(body.size_bytes) || body.size_bytes <= 0 || body.size_bytes > limits.uploadBytes) throw new ApiError(400, 'invalid_parameter', 'size_bytes is invalid.', 'size_bytes');
      if (!/^[0-9a-f]{64}$/.test(body.checksum_sha256 ?? '')) throw new ApiError(400, 'invalid_parameter', 'checksum_sha256 must be sha256 hex.', 'checksum_sha256');
      const idem = idempotent('upload', req, sha256(canonical({ size: body.size_bytes, checksum: body.checksum_sha256, filename: body.filename ?? null })));
      let a = idem.prior && assets.get(idem.prior);
      if (!a) {
        if ([...assets.values()].filter((x) => !x.completed).length >= limits.pendingUploads) throw new ApiError(429, 'rate_limit_exceeded', 'Too many unfinished uploads.');
        a = {
          asset_id: newId('asst'), filename: String(body.filename ?? 'project.zip').slice(0, 200), size_bytes: body.size_bytes,
          checksum_sha256: body.checksum_sha256, upload_sig: sign(), created_at: now(), uploaded: false, completed: false,
          idempotency: idem.stamp,
        };
        a.file = join(dirs.assets, `${a.asset_id}.zip`);
        saveAsset(a);
        assets.set(a.asset_id, a);
        indexKey(a, a.asset_id);
      }
      return send(res, 200, { data: { asset_id: a.asset_id, upload_url: `${base}/v3/uploads/${a.asset_id}?sig=${a.upload_sig}`, upload_headers: { 'content-type': 'application/zip' } } });
    }
    if (req.method === 'POST' && parts[0] === 'v3' && parts[1] === 'assets' && parts[3] === 'complete' && parts.length === 4) {
      const a = assets.get(parts[2]);
      if (!a) throw new ApiError(404, 'not_found', 'Asset not found.');
      const body = await readJson(req);
      if (!a.uploaded) throw new ApiError(409, 'upload_incomplete', 'The upload has not been received yet.');
      if (a.received_sha256 !== a.checksum_sha256 || (body.checksum_sha256 && body.checksum_sha256 !== a.checksum_sha256)) {
        Object.assign(a, { uploaded: false, received_sha256: null });
        rmSync(a.file, { force: true });
        saveAsset(a);
        throw new ApiError(400, 'checksum_mismatch', 'Uploaded bytes do not match checksum_sha256.');
      }
      if (!a.completed) { a.completed = true; saveAsset(a); }
      return send(res, 200, { data: { asset_id: a.asset_id, size_bytes: a.size_bytes } });
    }
    if (req.method === 'POST' && path === '/v3/hyperframes/renders') {
      const body = await readJson(req);
      const idem = idempotent('render', req, sha256(canonical(body)));
      const existing = idem.prior && renders.get(idem.prior);
      if (existing) return send(res, 200, { data: { render_id: existing.render_id, status: existing.status } });
      const { quality, format, resolution } = validateRender(body);
      if (stopping) throw new ApiError(503, 'unavailable', 'The Mac render server is restarting.');
      if (queue.length >= limits.queued) throw new ApiError(429, 'rate_limit_exceeded', 'The render queue is full.');
      const r = {
        render_id: newId('hfr'), seq: ++seq, status: 'queued', project: body.project, quality, format, resolution,
        fps: body.fps ?? null, aspect_ratio: body.aspect_ratio ?? null, composition: body.composition ?? null,
        variables: body.variables ?? null, title: body.title ?? null, callback_url: body.callback_url ?? null,
        callback_id: body.callback_id ?? null, created_at: now(), idempotency: idem.stamp,
      };
      mkdirSync(renderDir(r), { recursive: true });
      saveRender(r);
      renders.set(r.render_id, r);
      indexKey(r, r.render_id);
      queue.push(r);
      setImmediate(pump);
      log(`render ${r.render_id} queued (${format}, ${quality}, ${resolution})`);
      return send(res, 200, { data: { render_id: r.render_id, status: r.status } });
    }
    if (req.method === 'GET' && path === '/v3/hyperframes/renders') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 10) || 10, 1), 100);
      const all = [...renders.values()].filter((r) => !r.deleted).sort((a, b) => b.created_at - a.created_at || (b.seq ?? 0) - (a.seq ?? 0));
      const token = url.searchParams.get('token');
      const start = token ? all.findIndex((r) => r.render_id === token) : 0;
      if (start < 0) throw new ApiError(400, 'invalid_parameter', 'Unknown pagination token.', 'token');
      const page = all.slice(start, start + limit);
      const next = all[start + limit];
      return send(res, 200, { data: page.map((r) => detail(r, base)), has_more: Boolean(next), ...(next ? { next_token: next.render_id } : {}) });
    }
    if (parts[0] === 'v3' && parts[1] === 'hyperframes' && parts[2] === 'renders' && parts.length === 4) {
      const r = renders.get(parts[3]);
      if (!r || r.deleted) throw new ApiError(404, 'hyperframes_render_not_found', 'Render not found.');
      if (req.method === 'GET') return send(res, 200, { data: detail(r, base) });
      if (req.method === 'DELETE') {
        // Durable before the reply: a crash after this point must not resume the job.
        writeJsonAtomic(join(renderDir(r), 'render.json'), { ...r, deleted: true, status: 'deleted' });
        r.deleted = true;
        renders.delete(r.render_id);
        if (r.idempotency) idemIndex.delete(r.idempotency.slot);
        const i = queue.indexOf(r);
        if (i >= 0) queue.splice(i, 1);
        if (r === active) cancel(r, 'deleted'); // execute() removes its folder once its current step has stopped
        else rmSync(renderDir(r), { recursive: true, force: true });
        return send(res, 200, { data: { render_id: r.render_id } });
      }
    }
    throw new ApiError(404, 'not_found', `No route for ${req.method} ${url.pathname}.`);
  }

  function purgeResults() {
    for (const r of renders.values()) {
      if (r.status !== 'completed' || r.purged_at != null || !Number.isFinite(r.purge_after)
        || r.purge_after * 1000 > Date.now() || fileReaders.has(r.render_id)) continue;
      try {
        if (r.video_file) rmSync(r.video_file, { force: true });
        rmSync(join(renderDir(r), 'render.log'), { force: true });
        const receipt = { ...r, purged_at: Date.now() / 1000 };
        for (const field of ['video_file', 'project', 'variables', 'callback_url']) delete receipt[field];
        saveRender(receipt);
        renders.set(r.render_id, receipt);
      } catch (e) { log(`could not purge result ${r.render_id}: ${e.message}`); }
    }
  }

  function schedulePurge(retryDelay = 0) {
    clearTimeout(purgeTimer);
    if (stopping) return;
    let deadline = Infinity;
    for (const r of renders.values()) {
      if (r.status === 'completed' && r.purged_at == null && Number.isFinite(r.purge_after)
        && !fileReaders.has(r.render_id)) deadline = Math.min(deadline, r.purge_after * 1000);
    }
    if (!Number.isFinite(deadline)) return;
    const delay = Math.max(retryDelay, deadline - Date.now());
    purgeTimer = setTimeout(() => { purgeResults(); schedulePurge(1000); }, Math.min(delay, 2 ** 31 - 1));
    purgeTimer.unref();
  }

  function cleanup() {
    const cutoff = now() - limits.keepMs / 1000;
    const inUse = new Set([...queue, active].filter(Boolean).map((r) => r.project?.asset_id));
    for (const a of assets.values()) {
      if (a.created_at < cutoff && !inUse.has(a.asset_id)) {
        rmSync(a.file, { force: true });
        rmSync(assetFile(a), { force: true });
        assets.delete(a.asset_id);
        if (a.idempotency) idemIndex.delete(a.idempotency.slot);
      }
    }
    for (const f of readdirSync(dirs.assets)) {
      const p = join(dirs.assets, f);
      if (/\.(part|tmp)$/.test(f) && statSync(p).mtimeMs < Date.now() - 24 * 3600e3) rmSync(p, { force: true });
    }
    for (const r of renders.values()) {
      if ((r.completed_at ?? Infinity) < cutoff && !fileReaders.has(r.render_id)) {
        rmSync(renderDir(r), { recursive: true, force: true });
        renders.delete(r.render_id);
        if (r.idempotency) idemIndex.delete(r.idempotency.slot);
      }
    }
  }

  const server = createServer((req, res) => {
    if (stopping) { req.resume(); return send(res, 503, { error: { code: 'unavailable', message: 'The Mac render server is restarting.' } }); }
    const request = route(req, res).catch((e) => {
      if (res.destroyed) return;
      const status = e instanceof ApiError ? e.status : 500;
      if (status === 500) log('request failed', req.method, req.url.split('?')[0], e.stack ?? e.message);
      if (res.headersSent || res.destroyed) return res.destroy();
      req.resume();
      send(res, status, { error: { code: e.code ?? 'internal_error', message: e.message, param: e.param ?? null, doc_url: null } });
    });
    requests.add(request);
    request.then(() => requests.delete(request), () => requests.delete(request));
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60e3;
  cleanup();
  schedulePurge();
  const cleaner = setInterval(cleanup, Math.min(3600e3, limits.keepMs));
  cleaner.unref();
  // No work starts until every process a previous server with this data folder
  // started (its owner prefix) has exited; renders submitted meanwhile wait.
  let recovered = false;
  const ready = stopOwned(ownerMatcher(ownerTag, { prefix: true }), [], (s, blind) => log(`still stopping processes left by the previous server after ${s}s${blind ? ' (ps unavailable)' : ''}`))
    .then(() => {
      for (const r of tombstones) rmSync(renderDir(r), { recursive: true, force: true });
      recovered = true;
      setImmediate(pump);
    });

  // Stops taking work, returns an in-flight render to the queue and ends its
  // renderer, so the next server process resumes it without an overlap.
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    clearInterval(cleaner);
    clearTimeout(purgeTimer);
    const closed = new Promise((done) => server.close(done));
    server.closeAllConnections?.();
    const dashboardClosed = new Promise((done) => dashboard.close(done));
    dashboard.closeAllConnections?.();
    const r = active;
    if (r) {
      r.requeue = true;
      r.attempts = Math.max(0, (r.attempts ?? 1) - 1);
      cancel(r, 'server shutting down');
    }
    shutdownPromise = (async () => {
      await Promise.allSettled([ready, activeWork, closed, dashboardClosed]);
      while (requests.size) await Promise.allSettled([...requests]);
      releaseLease();
    })();
    return shutdownPromise;
  }
  server.once('error', () => { void shutdown(); });

  return { server, dashboard, ready, port: Number(config.port ?? 8788), renders, queue, shutdown, state: () => ({ active: active?.render_id ?? null, queued: queue.map((r) => r.render_id) }) };
}

let cachedChip;
function chip() {
  try { return (cachedChip ??= execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim()); } catch { return (cachedChip = 'unknown'); }
}

function tail(file, lines = 40) {
  try { return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dataDir = process.env.MAC_RENDER_DATA ?? DEFAULTS.data;
  const { server, dashboard, port, shutdown } = createRenderServer({ configPath: process.env.MAC_RENDER_CONFIG ?? DEFAULTS.config, dataDir, legacyData: process.env.MAC_RENDER_DATA ? null : DEFAULTS.legacyData });
  // While the service runs, keep the Mac from sleeping on AC power (caffeinate -s
  // holds only on AC); the display may still sleep. Released when the service exits.
  spawn('caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {});
  server.listen(port, '127.0.0.1', () => log(`mac render server on 127.0.0.1:${port} (${chip()})`));
  dashboard.listen(8789, '127.0.0.1', () => log('render dashboard at http://127.0.0.1:8789'));
  server.once('error', (e) => { log(`could not listen: ${e.message}`); shutdown().finally(() => process.exit(1)); });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => { log(`${sig}: shutting down`); shutdown().finally(() => process.exit(0)); });
  }
}
