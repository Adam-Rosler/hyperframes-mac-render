// Drives the installed `hyperframes cloud` CLI and the raw API against the Mac
// render server, with stubs standing in for `hyperframes render`, so the contract
// and the failure handling are tested in seconds. `e2e.sh` does a real render.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer, get as httpGet, request as httpRequest } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderServer, migrateState } from './server.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '../..');
const CLI = process.env.HYPERFRAMES_CLI ?? join(ROOT, 'node_modules/hyperframes/bin/hyperframes.mjs');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const tmp = mkdtempSync(join(tmpdir(), 'mac-render-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiny real videos keep success-path tests honest without launching Chrome/GPU.
for (const format of ['mp4', 'webm', 'mov']) {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=16x16:r=1', '-frames:v', '1', '-c:v', format === 'webm' ? 'libvpx-vp9' : 'libx264', '-pix_fmt', 'yuv420p', join(tmp, `fixture.${format}`)]);
}

// The stub behaves per project marker files: FAIL exits 1; SLOW=<ms> renders that
// long, logging start/end and complaining on stderr when stopped.
const STUB = join(tmp, 'stub-render.mjs');
writeFileSync(STUB, `
import { appendFileSync, copyFileSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
const args = process.argv.slice(2);
const project = args[1];
const out = process.env.STUB_OUT;
writeFileSync(join(out, 'last-args.json'), JSON.stringify(args));
writeFileSync(join(out, 'last-env.json'), JSON.stringify({ HF_CAPTURE_PARALLEL_STREAM: process.env.HF_CAPTURE_PARALLEL_STREAM ?? null, PRODUCER_CORES_PER_WORKER: process.env.PRODUCER_CORES_PER_WORKER ?? null }));
const mark = (what) => appendFileSync(join(out, 'intervals.log'), process.pid + ' ' + what + ' ' + Date.now() + ' ' + project + '\\n');
if (existsSync(join(project, 'FAIL'))) { console.error('boom: composition is broken'); process.exit(1); }
const slow = existsSync(join(project, 'SLOW')) ? Number(readFileSync(join(project, 'SLOW'), 'utf8')) : 0;
mark('start');
if (existsSync(join(project, 'BROWSER'))) {
  // Like Chrome: a detached browser in its own process group, with a helper child,
  // both carrying a profile path under TMPDIR on their command lines.
  const { spawn } = await import('node:child_process');
  const profile = 'user-data-dir=' + join(process.env.TMPDIR ?? '/tmp', 'puppeteer_dev_chrome_profile-stub');
  const browser = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[1]], { stdio: 'ignore' }); setInterval(() => {}, 1000)", profile], { detached: true, stdio: 'ignore' });
  browser.unref(); // as with Chrome, the renderer does not wait for it
  appendFileSync(join(out, 'browsers.log'), browser.pid + ' ' + project + '\\n');
}
process.on('SIGTERM', () => { process.stderr.write('stub: stopping\\n'.repeat(50)); process.exit(143); });
setTimeout(() => {
  const output = args.find((a) => a.startsWith('--output=')).slice(9);
  if (existsSync(join(project, 'OUTPUT_LINK'))) symlinkSync(join(out, 'fixture' + extname(output)), output);
  else if (existsSync(join(project, 'INVALID_VIDEO'))) writeFileSync(output, readFileSync(join(project, 'INVALID_VIDEO')));
  else copyFileSync(join(out, 'fixture' + extname(output)), output);
  mark('end');
  console.log('rendered', output);
}, slow);
`);
const STUB_RENDERER = { argv: [process.execPath, STUB], version: 'stub' };
process.env.STUB_OUT = tmp;

let n = 0;
async function startServer({ dataDir = join(tmp, `data-${++n}`), renderer = STUB_RENDERER, limits, allowHttpProjectUrls, gpu, config = {}, versions } = {}) {
  const configPath = join(tmp, `config-${n}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify({ token: TOKEN, port: 0, ...config }));
  const s = createRenderServer({ isolate: false, configPath, dataDir, renderer: versions ? undefined : renderer, limits, allowHttpProjectUrls, gpu, ...versions });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  await s.ready;
  const readyAt = Date.now();
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const api = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'x-api-key': TOKEN, 'content-type': 'application/json', ...opts.headers } });
  const stop = async () => { await s.shutdown(); s.server.closeAllConnections?.(); };
  return { ...s, base, api, dataDir, stop, readyAt };
}

let main;
before(async () => { main = await startServer(); });
after(async () => { await main.stop(); rmSync(tmp, { recursive: true, force: true }); });

function project(name, files = {}, dims = 'data-width="1920" data-height="1080"') {
  const dir = join(tmp, 'projects', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), `<div data-composition-id="root" ${dims}></div>`);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

function cli(args, { base = main.base, key = TOKEN, cwd = tmp } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd, env: { ...process.env, HOME: tmp, CI: '1', NO_COLOR: '1', HEYGEN_API_URL: base, HEYGEN_API_KEY: key },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr, stdout }));
  });
}

const lastArgs = () => JSON.parse(readFileSync(join(tmp, 'last-args.json'), 'utf8'));
const lastEnv = () => JSON.parse(readFileSync(join(tmp, 'last-env.json'), 'utf8'));
const browserFor = (id) => Number(readFileSync(join(tmp, 'browsers.log'), 'utf8').trim().split('\n').filter((l) => l.includes(id)).at(-1)?.split(' ')[0]);
const running = (pid) => {
  try {
    process.kill(pid, 0);
    return process.platform !== 'linux' || !/\)\s+Z(?:\s|$)/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch { return false; }
};
const jsonOf = (out) => JSON.parse(out.slice(out.indexOf('{')));

async function zipOf(dir) {
  const zip = join(tmp, `${Math.random().toString(36).slice(2)}.zip`);
  await new Promise((r, j) => execFile('zip', ['-q', '-y', '-r', zip, '.'], { cwd: dir }, (e) => (e ? j(e) : r())));
  return readFileSync(zip);
}

async function uploadAsset(s, bytes, headers = {}) {
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const res = await s.api('/v3/assets/direct-uploads', { method: 'POST', headers, body: JSON.stringify({ filename: 'p.zip', content_type: 'application/zip', size_bytes: bytes.length, checksum_sha256: checksum }) });
  const { data } = await res.json();
  assert.equal((await fetch(data.upload_url, { method: 'PUT', body: bytes })).status, 200);
  assert.equal((await s.api(`/v3/assets/${data.asset_id}/complete`, { method: 'POST', body: JSON.stringify({ checksum_sha256: checksum }) })).status, 200);
  return data.asset_id;
}

async function submit(s, body, headers = {}) {
  const res = await s.api('/v3/hyperframes/renders', { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function waitFor(s, id, statuses = ['completed', 'failed'], ms = 20e3) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const res = await s.api(`/v3/hyperframes/renders/${id}`);
    const { data } = await res.json();
    if (data && statuses.includes(data.status)) return data;
    await sleep(100);
  }
  throw new Error(`render ${id} did not reach ${statuses.join('/')}`);
}

async function dashboardFor(s) {
  assert.equal(s.dashboard.address(), null);
  await new Promise((resolve) => s.dashboard.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${s.dashboard.address().port}`;
  return async () => {
    const response = await fetch(`${base}/api/status`);
    assert.equal(response.status, 200);
    return response.json();
  };
}

test('dashboard shows the authoritative active job, FIFO queue and terminal history across restart', async () => {
  let releasePreparation;
  const preparation = new Promise((resolve) => { releasePreparation = resolve; });
  let s = await startServer({
    gpu: true, versions: {
      lookupLatest: async () => { await preparation; return '1.0.0'; },
      prepareVersion: async () => true,
      rendererFor: () => ({ ...STUB_RENDERER, version: '1.0.0' }),
    },
  });
  try {
    const snapshot = await dashboardFor(s);
    const idle = await snapshot();
    assert.equal(idle.service.state, 'idle');
    assert.equal(idle.active, null);
    assert.deepEqual(idle.queued, []);
    assert.equal(idle.service.gpu_encode, true);
    assert.equal((await s.api('/api/status')).status, 404);
    assert.equal((await fetch(s.base + '/api/status')).status, 401);
    const slow = await uploadAsset(s, await zipOf(project('dashboard-slow', { SLOW: '1300' })));
    const failed = await uploadAsset(s, await zipOf(project('dashboard-failure', { FAIL: '' })));
    const ids = [];
    for (const [title, asset] of [['First', slow], ['Second', failed], ['Third', slow]]) {
      const result = await submit(s, { project: { type: 'asset_id', asset_id: asset }, title, variables: { private_parameter: 'not for the dashboard' } });
      assert.equal(result.status, 200);
      ids.push(result.body.data.render_id);
    }
    await waitFor(s, ids[0], ['rendering']);
    const preparing = await snapshot();
    assert.equal(preparing.service.state, 'busy');
    assert.equal(preparing.active.render_id, ids[0]);
    assert.equal(preparing.active.phase, 'preparing');
    assert.deepEqual(preparing.queued.map((r) => r.render_id), ids.slice(1));
    assert.deepEqual(preparing.queued.map((r) => r.title), ['Second', 'Third']);
    assert.equal(preparing.active.fps, 30);
    assert.equal(preparing.active.attempts, 1);
    assert.deepEqual(Object.keys(preparing.active).sort(), [
      'aspect_ratio', 'attempts', 'completed_at', 'created_at', 'failure_message', 'format', 'fps',
      'hyperframes_version', 'phase', 'quality', 'render_id', 'render_seconds', 'resolution', 'started_at', 'status', 'title',
      'sent_at', 'purge_after', 'purged_at',
    ].sort());
    releasePreparation();
    let rendering;
    for (let i = 0; i < 100; i++) {
      rendering = await snapshot();
      if (rendering.active?.phase === 'rendering') break;
      await sleep(20);
    }
    assert.equal(rendering.active.phase, 'rendering');
    assert.equal(rendering.active.hyperframes_version, '1.0.0');
    assert.equal(rendering.service.hyperframes_latest_seen, '1.0.0');
    for (const id of ids) await waitFor(s, id);
    const finished = await snapshot();
    assert.equal(finished.service.state, 'idle');
    assert.equal(finished.active, null);
    assert.deepEqual(finished.recent.map((r) => r.render_id), [...ids].reverse());
    assert.deepEqual(finished.recent.map((r) => r.status), ['completed', 'failed', 'completed']);
    assert.equal(finished.recent[1].failure_message, 'Render failed. Inspect the render log on this Mac.');
    assert.equal(finished.recent_total, 3);
    assert.doesNotMatch(JSON.stringify(finished), /private_parameter|not for the dashboard|video_sig|video_url|callback|boom: composition/);
    const dataDir = s.dataDir;
    await s.stop();
    s = await startServer({ dataDir });
    const restored = await (await dashboardFor(s))();
    assert.deepEqual(restored.recent, finished.recent);
    assert.equal(restored.service.state, 'idle');
  } finally { releasePreparation(); await s.stop(); }
});

test('an occupied dashboard port leaves the render API available and shuts down cleanly', async () => {
  const s = await startServer();
  try {
    const error = new Promise((resolve) => s.dashboard.once('error', resolve));
    s.dashboard.listen(main.server.address().port, '127.0.0.1');
    assert.equal((await error).code, 'EADDRINUSE');
    assert.equal((await s.api('/v3/users/me')).status, 200);
    assert.deepEqual(s.state(), { active: null, queued: [] });
  } finally { await s.stop(); }
  const next = await startServer({ dataDir: s.dataDir });
  await next.stop();
});

test('dashboard bounds retained history while preserving completion and submission order', async () => {
  const dataDir = join(tmp, 'dashboard-history');
  const completed = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 105; i++) {
    const dir = join(dataDir, 'renders', `hfr_history${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'render.json'), JSON.stringify({
      render_id: `hfr_history${i}`, seq: i, title: `History ${i}`, status: 'failed',
      created_at: completed - 10, completed_at: completed, format: 'mp4', quality: 'standard', resolution: '1080p',
    }));
  }
  const s = await startServer({ dataDir });
  try {
    const snapshot = await (await dashboardFor(s))();
    assert.equal(snapshot.recent_total, 105);
    assert.equal(snapshot.recent.length, 100);
    assert.equal(snapshot.recent[0].render_id, 'hfr_history104');
    assert.equal(snapshot.recent[99].render_id, 'hfr_history5');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- stock CLI contract

test('rejects missing and wrong keys; accepts x-api-key or a proxy-injected bearer', async () => {
  assert.equal((await fetch(`${main.base}/v3/users/me`)).status, 401);
  assert.equal((await fetch(`${main.base}/v3/users/me`, { headers: { 'x-api-key': 'nope' } })).status, 401);
  assert.equal((await main.api('/v3/users/me')).status, 200);
  assert.equal((await fetch(`${main.base}/v3/users/me`, { headers: { 'x-api-key': 'placeholder', authorization: `Bearer ${TOKEN}` } })).status, 200);
});

test('authentication counters expire, evict old clients, and never block a valid key', async () => {
  const s = await startServer({ limits: { authFailuresPerMinute: 1, authClients: 2, authWindowMs: 1500 } });
  const attempt = async (client) => (await fetch(`${s.base}/v3/users/me`, { headers: { 'x-forwarded-for': client } })).status;
  try {
    assert.equal(await attempt('client-a'), 401);
    assert.equal(await attempt('client-a'), 429);
    assert.equal(await attempt('client-b'), 401);
    assert.equal(await attempt('client-c'), 401);
    assert.equal(await attempt('client-b'), 429);
    assert.equal(await attempt('client-a'), 401);
    assert.equal(await attempt('client-a'), 429);
    assert.equal((await s.api('/v3/users/me', { headers: { 'x-forwarded-for': 'client-a' } })).status, 200);
    await sleep(1600);
    assert.equal(await attempt('client-a'), 401);
  } finally { await s.stop(); }
});

test('render enums reject inherited names and non-string values before queueing', async () => {
  for (const field of ['format', 'resolution', 'aspect_ratio']) {
    for (const value of ['constructor', '__proto__', 'toString', ['mp4'], {}]) {
      const result = await submit(main, { project: { type: 'url', url: 'https://example.invalid/project.zip' }, [field]: value });
      assert.equal(result.status, 400, `${field}: ${JSON.stringify(value)}`);
      assert.equal(result.body.error.param, field);
    }
  }
});

test('hyperframes cloud render: zips, uploads, renders, polls and downloads', async () => {
  const dir = project('basic', { 'assets/a.txt': 'x', 'renders/old.mp4': 'skip me' });
  const r = await cli(['cloud', 'render', dir, '-o', join(tmp, 'out/basic.mp4'), '--quality', 'high', '--fps', '60', '--poll-interval', '1', '--json']);
  assert.equal(r.code, 0, r.out);
  const result = jsonOf(r.stdout);
  assert.equal(result.render.status, 'completed');
  assert.equal(result.render.hyperframes_version, 'stub');
  assert.deepEqual(readFileSync(join(tmp, 'out/basic.mp4')), readFileSync(join(tmp, 'fixture.mp4')));
  const args = lastArgs();
  for (const a of ['--quality=high', '--fps=60', '--format=mp4', '--resolution=landscape']) assert.ok(args.includes(a), `${a} in ${args.join(' ')}`);
});

test('project inspection waits for inherited stdout after the launcher exits', async () => {
  const realZipinfo = execFileSync('/usr/bin/which', ['zipinfo'], { encoding: 'utf8' }).trim();
  const bin = join(tmp, 'delayed-zipinfo');
  mkdirSync(bin);
  writeFileSync(join(bin, 'zipinfo'), `#!${process.execPath}
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e',
  "setTimeout(() => process.stdout.write(require('node:child_process').execFileSync(process.argv[1], process.argv.slice(2))), 150)",
  ${JSON.stringify(realZipinfo)}, ...process.argv.slice(2)], { stdio: ['ignore', 'inherit', 'inherit'] });
process.exit(0);
`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${previousPath}`;
    const asset = await uploadAsset(main, await zipOf(project('delayed-inspection')));
    const result = await submit(main, { project: { type: 'asset_id', asset_id: asset } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const rendered = await waitFor(main, result.body.data.render_id);
    assert.equal(rendered.status, 'completed', JSON.stringify(rendered));
    assert.ok(rendered.video_url);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('default output lands in renders/<render_id>.mp4 like HeyGen', async () => {
  const dir = project('default-out');
  const r = await cli(['cloud', 'render', dir, '--poll-interval', '1'], { cwd: dir });
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(dir, 'renders', `${r.out.match(/hfr_[0-9a-f]+/)[0]}.mp4`)), r.out);
});

test('cloud defaults: 1080p and 30 fps, whatever the composition declares', async () => {
  const dir = project('small60', {}, 'data-width="540" data-height="960" data-fps="60"');
  const r = await cli(['cloud', 'render', dir, '-o', join(tmp, 'out/small60.mp4'), '--poll-interval', '1']);
  assert.equal(r.code, 0, r.out);
  const args = lastArgs();
  assert.ok(args.includes('--fps=30') && args.includes('--resolution=portrait'), args.join(' '));
});

test('composition, variables and 4k portrait map to hyperframes render flags', async () => {
  const dir = project('flags', { 'compositions/intro.html': '<div data-composition-id="intro" data-width="1080" data-height="1920"></div>' });
  const r = await cli(['cloud', 'render', dir, '-c', 'compositions/intro.html', '--variables', '{"title":"Hi"}', '--resolution', '4k', '-o', join(tmp, 'out/flags.mp4'), '--poll-interval', '1']);
  assert.equal(r.code, 0, r.out);
  const args = lastArgs();
  for (const a of ['--composition=compositions/intro.html', '--variables={"title":"Hi"}', '--resolution=portrait-4k']) assert.ok(args.includes(a), `${a} in ${args.join(' ')}`);
});

test('--asset-id and --url without an aspect ratio detect it from the project', async () => {
  const dir = project('detect', {}, 'data-width="1080" data-height="1920"');
  const bytes = await zipOf(dir);
  const asset = await uploadAsset(main, bytes);
  const viaAsset = await submit(main, { project: { type: 'asset_id', asset_id: asset } });
  assert.equal((await waitFor(main, viaAsset.body.data.render_id)).aspect_ratio, '9:16');
  assert.ok(lastArgs().includes('--resolution=portrait'));

  const files = createServer((req, res) => res.end(bytes));
  await new Promise((r) => files.listen(0, '127.0.0.1', r));
  const s = await startServer({ allowHttpProjectUrls: true });
  try {
    const viaUrl = await submit(s, { project: { type: 'url', url: `http://127.0.0.1:${files.address().port}/p.zip` } });
    const done = await waitFor(s, viaUrl.body.data.render_id);
    assert.equal(done.status, 'completed', done.failure_message);
    assert.equal(done.aspect_ratio, '9:16');
    assert.equal(existsSync(join(s.dataDir, 'renders', done.render_id, 'project.zip')), false);
  } finally { await s.stop(); files.close(); }
});

test('a failed render fails the CLI with the renderer output', async () => {
  const r = await cli(['cloud', 'render', project('broken', { FAIL: '1' }), '-o', join(tmp, 'out/broken.mp4'), '--poll-interval', '1']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Render failed/);
  assert.match(r.out, /boom: composition is broken/);
});

test('list pages through every render; get and delete work', async () => {
  const s = await startServer();
  try {
    const dir = project('listing');
    for (let i = 0; i < 3; i++) assert.equal((await cli(['cloud', 'render', dir, '--no-wait'], { base: s.base })).code, 0);
    const page = jsonOf((await cli(['cloud', 'list', '--json', '--limit', '2'], { base: s.base })).stdout);
    assert.equal(page.renders.length, 2);
    assert.equal(page.has_more, true);
    const all = jsonOf((await cli(['cloud', 'list', '--all', '--json', '--limit', '1'], { base: s.base })).stdout);
    assert.equal(new Set(all.renders.map((x) => x.render_id)).size, 3);
    const id = all.renders[0].render_id;
    await waitFor(s, id);
    assert.match((await cli(['cloud', 'get', id], { base: s.base })).out, new RegExp(id));
    assert.equal((await cli(['cloud', 'delete', id, '--no-confirm'], { base: s.base })).code, 0);
    assert.equal((await s.api(`/v3/hyperframes/renders/${id}`)).status, 404);
  } finally { await s.stop(); }
});

test('--asset-id re-renders an uploaded project without re-uploading', async () => {
  const dir = project('reuse');
  const first = await cli(['cloud', 'render', dir, '-o', join(tmp, 'out/reuse1.mp4'), '--poll-interval', '1']);
  const asset = first.out.match(/asst_[0-9a-f]+/)[0];
  const again = await cli(['cloud', 'render', '--asset-id', asset, '-o', join(tmp, 'out/reuse2.mp4'), '--poll-interval', '1']);
  assert.equal(again.code, 0, again.out);
  assert.doesNotMatch(again.out, /Uploading/);
});

// ---------------------------------------------------------------- audit regressions

test('deleting an active render stops it without crashing the server', async () => {
  const s = await startServer();
  try {
    const asset = await uploadAsset(s, await zipOf(project('del-active', { SLOW: '5000' })));
    const { body } = await submit(s, { project: { type: 'asset_id', asset_id: asset } });
    await waitFor(s, body.data.render_id, ['rendering']);
    await sleep(300);
    assert.equal((await s.api(`/v3/hyperframes/renders/${body.data.render_id}`, { method: 'DELETE' })).status, 200);
    await sleep(1000);
    assert.equal((await s.api('/v3/users/me')).status, 200, 'server still up after the renderer flushed stderr');
    assert.equal(existsSync(join(s.dataDir, 'renders', body.data.render_id)), false);
    const next = await submit(s, { project: { type: 'asset_id', asset_id: await uploadAsset(s, await zipOf(project('after-del'))) } });
    assert.equal((await waitFor(s, next.body.data.render_id)).status, 'completed');
  } finally { await s.stop(); }
});

test('concurrent PUTs to one upload URL: one wins, the other gets 409, the server survives', async () => {
  const bytes = Buffer.alloc(2e6, 7);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const { data } = await (await main.api('/v3/assets/direct-uploads', { method: 'POST', body: JSON.stringify({ size_bytes: bytes.length, checksum_sha256: checksum }) })).json();
  const slowBody = () => new ReadableStream({ async start(c) { for (let i = 0; i < 4; i++) { c.enqueue(bytes.subarray(i * 5e5, (i + 1) * 5e5)); await sleep(150); } c.close(); } });
  const put = () => fetch(data.upload_url, { method: 'PUT', body: slowBody(), duplex: 'half' }).then((r) => r.status);
  const statuses = (await Promise.all([put(), sleep(50).then(put)])).sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal((await fetch(data.upload_url, { method: 'PUT', body: bytes })).status, 200, 'a retry after success is accepted');
  assert.equal((await main.api(`/v3/assets/${data.asset_id}/complete`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await main.api('/v3/users/me')).status, 200);
});

test('idempotency keys persist across restarts, per endpoint, and reject conflicting reuse', async () => {
  const dataDir = join(tmp, 'idem-data');
  let s = await startServer({ dataDir });
  const bytes = await zipOf(project('idem'));
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const up = (sv) => sv.api('/v3/assets/direct-uploads', { method: 'POST', headers: { 'idempotency-key': 'k1' }, body: JSON.stringify({ filename: 'idem.zip', size_bytes: bytes.length, checksum_sha256: checksum }) }).then((r) => r.json());
  const a1 = (await up(s)).data.asset_id;
  const asset = await uploadAsset(s, bytes);
  const body = { project: { type: 'asset_id', asset_id: asset }, quality: 'draft' };
  const r1 = (await submit(s, body, { 'idempotency-key': 'k1' })).body.data.render_id;
  await waitFor(s, r1);
  await s.stop();
  s = await startServer({ dataDir });
  try {
    assert.equal((await up(s)).data.asset_id, a1, 'upload replay returns the same asset');
    assert.equal((await submit(s, body, { 'idempotency-key': 'k1' })).body.data.render_id, r1, 'render replay after restart');
    const conflict = await submit(s, { ...body, quality: 'high' }, { 'idempotency-key': 'k1' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'idempotency_key_reused');
  } finally { await s.stop(); }
});

test('failed logins are limited per client and never block a valid key', async () => {
  const s = await startServer();
  try {
    let last;
    for (let i = 0; i < 35; i++) last = (await fetch(`${s.base}/v3/users/me`, { headers: { 'x-api-key': 'bad' } })).status;
    assert.equal(last, 429);
    assert.equal((await s.api('/v3/users/me')).status, 200);
  } finally { await s.stop(); }
});

test('a crash mid-render: the next server stops the orphan, then resumes both renders without overlap', async () => {
  const dataDir = join(tmp, 'crash-data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(tmp, 'config.json'), JSON.stringify({ token: TOKEN, port: 0 }));
  const harness = join(tmp, 'harness.mjs');
  writeFileSync(harness, `import { createRenderServer } from ${JSON.stringify(join(HERE, 'server.mjs'))};
const s = createRenderServer({ isolate: false, configPath: ${JSON.stringify(join(tmp, 'config.json'))}, dataDir: ${JSON.stringify(dataDir)}, renderer: ${JSON.stringify(STUB_RENDERER)} });
s.server.listen(0, '127.0.0.1', () => console.log(s.server.address().port));`);
  const child = spawn(process.execPath, [harness], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => child.stdout.once('data', (d) => r(Number(d.toString()))));
  const crashed = { base: `http://127.0.0.1:${port}`, api: (p, o = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...o, headers: { 'x-api-key': TOKEN, 'content-type': 'application/json', ...o.headers } }) };
  const asset = await uploadAsset(crashed, await zipOf(project('crash', { SLOW: '1500' })));
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push((await submit(crashed, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id);
  await waitFor(crashed, ids[0], ['rendering']);
  await sleep(200);
  const orphan = JSON.parse(readFileSync(join(dataDir, 'renders', ids[0], 'render.json'), 'utf8')).pid;
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.ok(orphan && (() => { try { process.kill(orphan, 0); return true; } catch { return false; } })(), 'renderer outlived its server');
  const s = await startServer({ dataDir }); // resolves once the orphan's process group has exited
  try {
    assert.throws(() => process.kill(orphan, 0), 'orphaned renderer exited before any new work started');
    for (const id of ids) assert.equal((await waitFor(s, id)).status, 'completed');
    const ours = readFileSync(join(tmp, 'intervals.log'), 'utf8').trim().split('\n').map((l) => l.split(' '))
      .filter(([, , , dir]) => ids.some((id) => dir?.includes(id)));
    const restarts = ours.filter(([pid, what]) => what === 'start' && Number(pid) !== orphan).map(([, , t]) => Number(t));
    assert.equal(restarts.length, 2);
    assert.ok(Math.min(...restarts) >= s.readyAt, 'nothing rendered before the orphan was gone');
    const spans = {};
    for (const [pid, what, t] of ours) (spans[pid] ??= {})[what] = Number(t);
    const done = Object.values(spans).filter((x) => x.end).sort((a, b) => a.start - b.start);
    for (let i = 1; i < done.length; i++) assert.ok(done[i].start >= done[i - 1].end, 'renders never overlap');
  } finally { await s.stop(); }
});

test('shutdown returns the active render to the queue and the next server finishes it', async () => {
  const dataDir = join(tmp, 'shutdown-data');
  let s = await startServer({ dataDir });
  const asset = await uploadAsset(s, await zipOf(project('shutdown', { SLOW: '3000' })));
  const id = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
  await waitFor(s, id, ['rendering']);
  await s.stop();
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'renders', id, 'render.json'), 'utf8')).status, 'queued');
  s = await startServer({ dataDir });
  try { assert.equal((await waitFor(s, id)).status, 'completed'); } finally { await s.stop(); }
});

test('a second owner is rejected before it can stop an active render, including path aliases', async () => {
  const s = await startServer();
  const configPath = join(tmp, 'lease-config.json');
  writeFileSync(configPath, JSON.stringify({ token: TOKEN, port: 0 }));
  const alias = `${s.dataDir}-alias`;
  symlinkSync(s.dataDir, alias);
  try {
    const asset = await uploadAsset(s, await zipOf(project('lease-active', { SLOW: '1200' })));
    const id = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    await waitFor(s, id, ['rendering']);
    for (const dataDir of [s.dataDir, alias]) {
      assert.throws(() => createRenderServer({ isolate: false, configPath, dataDir, renderer: STUB_RENDERER }), /Another render server owns/);
    }
    assert.equal((await waitFor(s, id)).status, 'completed', 'losing startup never signals the current renderer');
    const starts = readFileSync(join(tmp, 'intervals.log'), 'utf8').split('\n').filter((l) => l.includes(id) && l.includes(' start '));
    assert.equal(starts.length, 1);
  } finally { await s.stop(); }
  const next = await startServer({ dataDir: alias });
  await next.stop();
});

test('simultaneous different-port launches elect one owner and SIGKILL releases the persistent lease', async () => {
  const dataDir = join(tmp, 'lease-race-data');
  const configPath = join(tmp, 'lease-race-config.json');
  writeFileSync(configPath, JSON.stringify({ token: TOKEN, port: 0 }));
  const harness = join(tmp, 'lease-race.mjs');
  writeFileSync(harness, `import { createRenderServer } from ${JSON.stringify(join(HERE, 'server.mjs'))};
process.on('message', () => {
  try {
    const s = createRenderServer({ isolate: false, configPath: ${JSON.stringify(configPath)}, dataDir: process.argv[2], renderer: ${JSON.stringify(STUB_RENDERER)} });
    s.server.listen(0, '127.0.0.1', () => process.send({ owned: true, port: s.server.address().port }));
  } catch (e) { process.send({ owned: false, message: e.message }); }
});`);
  const aliases = process.platform === 'darwin' ? [dataDir, join(tmp, 'LEASE-RACE-DATA')] : [dataDir];
  const children = Array.from({ length: 4 }, (_, i) => spawn(process.execPath, [harness, aliases[i % aliases.length]], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  try {
    const answers = children.map((c) => new Promise((ok) => c.once('message', ok)));
    for (const c of children) c.send('start');
    const results = await Promise.all(answers);
    assert.equal(results.filter((r) => r.owned).length, 1, JSON.stringify(results));
    for (const r of results.filter((r) => !r.owned)) assert.match(r.message, /Another render server owns/);
    const winner = children[results.findIndex((r) => r.owned)];
    const exited = new Promise((ok) => winner.once('exit', ok));
    winner.kill('SIGKILL');
    await exited;
    const restarted = await startServer({ dataDir });
    await restarted.stop();
    const again = await startServer({ dataDir }); // same lease file stays reusable
    await again.stop();
  } finally {
    await Promise.all(children.map((c) => c.exitCode !== null || c.signalCode !== null ? null : new Promise((ok) => { c.once('exit', ok); c.kill('SIGKILL'); })));
  }
});

test('initialization and bind failures release their lease after cleanup', async () => {
  const dataDir = join(tmp, 'lease-init-data');
  assert.throws(() => createRenderServer({ isolate: false, dataDir, configPath: join(tmp, 'absent-config.json') }), /ENOENT/);
  const s = await startServer({ dataDir });
  await s.stop();
  const configPath = join(tmp, 'lease-bind-config.json');
  writeFileSync(configPath, JSON.stringify({ token: TOKEN, port: 0 }));
  const blocked = createRenderServer({ isolate: false, dataDir, configPath, renderer: STUB_RENDERER });
  const error = new Promise((ok) => blocked.server.once('error', ok));
  blocked.server.listen(main.server.address().port, '127.0.0.1');
  assert.equal((await error).code, 'EADDRINUSE');
  await blocked.shutdown();
  const next = await startServer({ dataDir });
  await next.stop();
});

test('migration refuses a live legacy owner and reserves both locations until shutdown', async () => {
  const legacyData = join(tmp, 'legacy-lease');
  const dataDir = join(tmp, 'destination-lease');
  const configPath = join(tmp, 'migration-lease-config.json');
  writeFileSync(configPath, JSON.stringify({ token: TOKEN, port: 0 }));
  const legacy = await startServer({ dataDir: legacyData });
  try {
    const asset = await uploadAsset(legacy, await zipOf(project('legacy-lease', { SLOW: '1000' })));
    const id = (await submit(legacy, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    await waitFor(legacy, id, ['rendering']);
    assert.throws(() => createRenderServer({ isolate: false, dataDir, legacyData, configPath, renderer: STUB_RENDERER }), /Another render server owns/);
    assert.ok(existsSync(join(legacyData, 'renders', id, 'render.json')), 'legacy records were not moved');
    assert.equal(existsSync(dataDir), false);
    assert.equal((await waitFor(legacy, id)).status, 'completed');
  } finally { await legacy.stop(); }
  const moved = createRenderServer({ isolate: false, dataDir, legacyData, configPath, renderer: STUB_RENDERER });
  try {
    await moved.ready;
    assert.equal(existsSync(legacyData), false);
    assert.throws(() => createRenderServer({ isolate: false, dataDir: legacyData, configPath, renderer: STUB_RENDERER }), /Another render server owns/);
  } finally { await moved.shutdown(); }
  const next = await startServer({ dataDir });
  await next.stop();
});

test('shutdown keeps ownership through outstanding work and closes partial upload files before releasing it', async () => {
  let releaseLookup;
  let enteredLookup;
  const entered = new Promise((ok) => { enteredLookup = ok; });
  const lookup = new Promise((ok) => { releaseLookup = ok; });
  const s = await startServer({ versions: { lookupLatest: () => { enteredLookup(); return lookup; } } });
  const asset = await uploadAsset(s, await zipOf(project('lease-shutdown')));
  const id = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
  await entered;
  const { data } = await (await s.api('/v3/assets/direct-uploads', { method: 'POST', body: JSON.stringify({ size_bytes: 100000, checksum_sha256: 'a'.repeat(64) }) })).json();
  const upload = httpRequest(data.upload_url, { method: 'PUT', headers: { 'content-length': 100000 } });
  upload.on('error', () => {});
  upload.write(Buffer.alloc(100));
  for (let i = 0; i < 100 && !readdirSync(join(s.dataDir, 'assets')).some((f) => f.endsWith('.part')); i++) await sleep(10);
  assert.ok(readdirSync(join(s.dataDir, 'assets')).some((f) => f.endsWith('.part')));
  const stopping = s.shutdown();
  assert.equal(s.shutdown(), stopping, 'shutdown is idempotent');
  assert.throws(() => createRenderServer({ isolate: false, dataDir: s.dataDir }), /Another render server owns/);
  releaseLookup(null);
  await stopping;
  upload.destroy();
  assert.ok(!readdirSync(join(s.dataDir, 'assets')).some((f) => f.endsWith('.part')));
  assert.equal(JSON.parse(readFileSync(join(s.dataDir, 'renders', id, 'render.json'))).status, 'queued');
  const next = await startServer({ dataDir: s.dataDir });
  try { assert.equal((await waitFor(next, id)).status, 'completed'); } finally { await next.stop(); }
});

test('a missing renderer fails the job and does not stall the queue', async () => {
  const s = await startServer({ renderer: { argv: [join(tmp, 'no-such-renderer')], version: 'missing' } });
  try {
    const asset = await uploadAsset(s, await zipOf(project('missing')));
    const a = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    const b = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    assert.match((await waitFor(s, a, ['failed'], 5000)).failure_message, /could not start/);
    assert.equal((await waitFor(s, b, ['failed'], 5000)).status, 'failed');
  } finally { await s.stop(); }
});

test('a zero-exit renderer with empty or invalid output fails without offering a download', async () => {
  const s = await startServer();
  try {
    for (const [name, contents] of [['empty', ''], ['invalid', 'not a video']]) {
      const asset = await uploadAsset(s, await zipOf(project(`output-${name}`, { INVALID_VIDEO: contents })));
      const id = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
      const done = await waitFor(s, id);
      assert.equal(done.status, 'failed');
      assert.match(done.failure_message, /produced no readable video/);
      assert.equal(done.video_url, null);
    }
    const asset = await uploadAsset(s, await zipOf(project('after-invalid-video')));
    const id = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    const done = await waitFor(s, id);
    assert.equal(done.status, 'completed');
    assert.equal(done.duration, 1);
    assert.deepEqual(Buffer.from(await (await fetch(done.video_url)).arrayBuffer()), readFileSync(join(tmp, 'fixture.mp4')));
  } finally { await s.stop(); }
});

test('renderer output links are rejected before probing or publication', async () => {
  const s = await startServer();
  try {
    const asset = await uploadAsset(s, await zipOf(project('output-link', { OUTPUT_LINK: '1' })));
    const id = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    const failed = await waitFor(s, id, ['failed']);
    assert.match(failed.failure_message, /regular video file/);
    assert.equal(failed.video_url, null);
  } finally { await s.stop(); }
});

test('a render past its deadline is stopped and the queue moves on', async () => {
  const s = await startServer({ limits: { renderMs: 800 } });
  try {
    const slow = await uploadAsset(s, await zipOf(project('deadline', { SLOW: '20000' })));
    const quick = await uploadAsset(s, await zipOf(project('after-deadline')));
    const a = (await submit(s, { project: { type: 'asset_id', asset_id: slow } })).body.data.render_id;
    const b = (await submit(s, { project: { type: 'asset_id', asset_id: quick } })).body.data.render_id;
    assert.match((await waitFor(s, a, ['failed'], 10e3)).failure_message, /timed out/);
    assert.equal((await waitFor(s, b)).status, 'completed');
  } finally { await s.stop(); }
});

test('project URLs are size-limited while streaming', async () => {
  const big = createServer((req, res) => { res.write(Buffer.alloc(5000)); setTimeout(() => res.end(Buffer.alloc(5000)), 50); });
  await new Promise((r) => big.listen(0, '127.0.0.1', r));
  const s = await startServer({ allowHttpProjectUrls: true, limits: { projectUrlBytes: 4000 } });
  try {
    const id = (await submit(s, { project: { type: 'url', url: `http://127.0.0.1:${big.address().port}/p.zip` } })).body.data.render_id;
    assert.match((await waitFor(s, id, ['failed'])).failure_message, /larger than 4000 bytes/);
  } finally { await s.stop(); big.close(); }
});

test('project URL destination errors and interrupted sources fail only their job', async () => {
  let s;
  const source = createServer((req, res) => {
    if (req.url === '/disk-error') {
      // A genuine write error, without filling a disk or changing global I/O.
      mkdirSync(join(s.dataDir, 'renders', s.state().active, 'project.zip'));
      res.end('zip bytes');
    } else {
      res.writeHead(200, { 'content-length': 10000 });
      res.write('truncated zip');
      setTimeout(() => res.destroy(), 25);
    }
  });
  await new Promise((ok) => source.listen(0, '127.0.0.1', ok));
  s = await startServer({ allowHttpProjectUrls: true });
  try {
    for (const path of ['/disk-error', '/interrupted']) {
      const id = (await submit(s, { project: { type: 'url', url: `http://127.0.0.1:${source.address().port}${path}` } })).body.data.render_id;
      assert.equal((await waitFor(s, id)).status, 'failed');
      assert.equal((await s.api('/v3/users/me')).status, 200, 'the service survives stream errors');
      assert.equal(existsSync(join(s.dataDir, 'renders', id, 'project.zip')), false);
    }
    const asset = await uploadAsset(s, await zipOf(project('after-stream-failure')));
    const id = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    assert.equal((await waitFor(s, id)).status, 'completed');
  } finally { await s.stop(); source.closeAllConnections(); await new Promise((ok) => source.close(ok)); }
});

test('repeated aborted downloads close every source file descriptor', async () => {
  const s = await startServer();
  const streams = [];
  const original = fs.createReadStream;
  try {
    const asset = await uploadAsset(s, await zipOf(project('download-abort')));
    const id = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    const done = await waitFor(s, id);
    const file = join(s.dataDir, 'renders', id, 'video.mp4');
    truncateSync(file, 64 * 1024 * 1024); // sparse fixture, large enough to backpressure
    // Observe the real filesystem boundary; all requests still use the server's
    // signed URL, HTTP socket and real ReadStream with no fake implementation.
    fs.createReadStream = (...args) => {
      const stream = original(...args);
      if (args[0] === file) streams.push(stream);
      return stream;
    };
    syncBuiltinESMExports();
    for (let i = 0; i < 20; i++) {
      await new Promise((ok, reject) => {
        const req = httpGet(done.video_url, (res) => res.once('data', () => { res.destroy(); ok(); }));
        req.once('error', reject);
      });
      for (let j = 0; j < 100 && streams.some((stream) => !stream.closed); j++) await sleep(10);
      assert.equal(streams.length, i + 1);
      assert.ok(streams.every((stream) => stream.closed && stream.destroyed && stream.fd === null), 'aborted readers do not accumulate');
    }
  } finally {
    fs.createReadStream = original;
    syncBuiltinESMExports();
    for (const stream of streams) stream.destroy();
    await s.stop();
  }
});

async function waitForResult(s, id, predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { data } = await (await s.api(`/v3/hyperframes/renders/${id}`)).json();
    if (data && predicate(data)) return data;
    await sleep(20);
  }
  throw new Error(`Result lifecycle did not settle for ${id}`);
}

async function resultFixture(s, name) {
  const asset = await uploadAsset(s, await zipOf(project(name)));
  const body = { project: { type: 'asset_id', asset_id: asset }, variables: { title: 'Private input' }, title: name };
  const id = (await submit(s, body, { 'idempotency-key': name })).body.data.render_id;
  const done = await waitFor(s, id);
  assert.equal(done.status, 'completed');
  return { asset, body, id, done, file: join(s.dataDir, 'renders', id, 'video.mp4') };
}

function pausedDownload(url) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, (response) => {
      response.on('error', () => {});
      response.pause();
      resolve(response);
    });
    request.on('error', reject);
  });
}

function consumeDownload(response) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    response.on('data', (chunk) => { bytes += chunk.length; });
    response.once('end', () => resolve(bytes));
    response.once('error', reject);
    response.resume();
  });
}

test('delivered results purge after grace while receipts, idempotency and reusable assets remain', async () => {
  const s = await startServer({ limits: { graceMs: 250 } });
  try {
    const { asset, body, id, done, file } = await resultFixture(s, 'delivery-purge');
    assert.equal(done.sent_at, null);
    assert.deepEqual(Buffer.from(await (await fetch(done.video_url)).arrayBuffer()), readFileSync(join(tmp, 'fixture.mp4')));
    const sent = await waitForResult(s, id, (r) => r.sent_at !== null);
    assert.ok(Math.abs(sent.purge_after - sent.sent_at - 0.25) < 0.001);
    const purged = await waitForResult(s, id, (r) => r.purged_at !== null);
    assert.equal(purged.status, 'completed');
    assert.equal(purged.video_url, null);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(join(s.dataDir, 'renders', id, 'render.log')), false);
    const receipt = JSON.parse(readFileSync(join(s.dataDir, 'renders', id, 'render.json')));
    assert.equal(receipt.render_id, id);
    for (const field of ['project', 'variables', 'callback_url', 'video_file']) assert.equal(Object.hasOwn(receipt, field), false);
    const expired = await fetch(done.video_url);
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).error.code, 'result_deleted');
    assert.equal((await fetch(done.video_url.replace(/sig=.*/, 'sig=invalid'))).status, 404);
    const replay = await submit(s, body, { 'idempotency-key': 'delivery-purge' });
    assert.equal(replay.body.data.render_id, id);
    const snapshot = await (await dashboardFor(s))();
    assert.equal(snapshot.recent[0].purged_at, purged.purged_at);
    const rerender = await cli(['cloud', 'render', '--asset-id', asset, '--poll-interval', '1', '-o', join(tmp, 'out/reuse-after-purge.mp4')], { base: s.base });
    assert.equal(rerender.code, 0, rerender.out);
    assert.deepEqual(readFileSync(join(tmp, 'out/reuse-after-purge.mp4')), readFileSync(join(tmp, 'fixture.mp4')));
  } finally { await s.stop(); }
});

test('partial first downloads do not arm deletion and shutdown releases their readers', async () => {
  let s = await startServer({ limits: { graceMs: 100 } });
  let response;
  try {
    const { id, done, file } = await resultFixture(s, 'partial-delivery');
    truncateSync(file, 64 * 1024 * 1024);
    response = await pausedDownload(done.video_url);
    response.destroy();
    await sleep(200);
    const retained = await waitFor(s, id);
    assert.equal(retained.sent_at, null);
    assert.equal(retained.purge_after, null);
    assert.equal(existsSync(file), true);
    response = await pausedDownload(done.video_url);
    const dataDir = s.dataDir;
    await s.stop();
    s = await startServer({ dataDir, limits: { graceMs: 100 } });
    assert.equal((await waitFor(s, id)).sent_at, null);
    assert.equal(existsSync(file), true);
  } finally { response?.destroy(); await s.stop(); }
});

test('a finished response with fewer source bytes than advertised does not arm result cleanup', async () => {
  const s = await startServer({ limits: { graceMs: 100 } });
  let response;
  try {
    const { id, done, file } = await resultFixture(s, 'short-source');
    truncateSync(file, 64 * 1024 * 1024);
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    s.server.on('request', (req, res) => {
      if (req.url.startsWith(`/v3/files/${id}/`)) {
        truncateSync(file, 1024);
        res.once('finish', () => finish(res.writableFinished));
      }
    });
    response = await pausedDownload(done.video_url);
    assert.equal(await finished, true);
    await sleep(200);
    const retained = await waitFor(s, id);
    assert.equal(retained.sent_at, null);
    assert.equal(retained.purge_after, null);
    assert.equal(existsSync(file), true);
  } finally { response?.destroy(); await s.stop(); }
});

test('concurrent file readers defer purge and each full transfer refreshes grace', async () => {
  const s = await startServer({ limits: { graceMs: 200 } });
  let first;
  let second;
  try {
    const { id, done, file } = await resultFixture(s, 'concurrent-delivery');
    await (await fetch(done.video_url)).arrayBuffer();
    const initial = await waitForResult(s, id, (r) => r.sent_at !== null);
    truncateSync(file, 64 * 1024 * 1024);
    first = await pausedDownload(done.video_url);
    second = await pausedDownload(done.video_url);
    await sleep(350);
    assert.equal(existsSync(file), true);
    assert.equal((await waitFor(s, id)).purged_at, null);
    assert.equal(await consumeDownload(first), 64 * 1024 * 1024);
    const refreshed = await waitForResult(s, id, (r) => r.sent_at > initial.sent_at);
    assert.ok(refreshed.purge_after > initial.purge_after);
    await sleep(300);
    assert.equal(existsSync(file), true);
    second.destroy();
    await waitForResult(s, id, (r) => r.purged_at !== null);
    assert.equal(existsSync(file), false);
  } finally { first?.destroy(); second?.destroy(); await s.stop(); }
});

test('result cleanup resumes before or after its persisted deadline and stays purged after restart', async () => {
  for (const delay of [0, 650]) {
    let s = await startServer({ limits: { graceMs: 500 } });
    try {
      const { id, done, file } = await resultFixture(s, `delivery-restart-${delay}`);
      await (await fetch(done.video_url)).arrayBuffer();
      const sent = await waitForResult(s, id, (r) => r.sent_at !== null);
      const dataDir = s.dataDir;
      await s.stop();
      await sleep(delay);
      s = await startServer({ dataDir, limits: { graceMs: 500 } });
      const purged = await waitForResult(s, id, (r) => r.purged_at !== null);
      assert.equal(purged.purge_after, sent.purge_after);
      assert.equal(purged.sent_at, sent.sent_at);
      assert.equal(existsSync(file), false);
      await s.stop();
      s = await startServer({ dataDir });
      assert.equal((await waitFor(s, id)).purged_at, purged.purged_at);
      const signedPath = new URL(done.video_url).pathname + new URL(done.video_url).search;
      assert.equal((await fetch(s.base + signedPath)).status, 410);
    } finally { await s.stop(); }
  }
});

test('no-wait, callbacks and get leave an unclaimed result available', async () => {
  let callback;
  const receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { callback = JSON.parse(body); res.end('ok'); });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const s = await startServer({ limits: { graceMs: 100 } });
  try {
    const result = await cli(['cloud', 'render', project('unclaimed'), '--no-wait', '--callback-url', `http://127.0.0.1:${receiver.address().port}/done`], { base: s.base });
    assert.equal(result.code, 0, result.out);
    const id = result.out.match(/hfr_[0-9a-f]+/)[0];
    await waitFor(s, id);
    assert.equal((await cli(['cloud', 'get', id], { base: s.base })).code, 0);
    await sleep(200);
    assert.equal(callback.event_data.render_id, id);
    assert.equal(callback.event_data.sent_at, null);
    const unclaimed = await waitFor(s, id);
    assert.equal(unclaimed.sent_at, null);
    assert.equal(unclaimed.purge_after, null);
    assert.equal(existsSync(join(s.dataDir, 'renders', id, 'video.mp4')), true);
    await (await fetch(unclaimed.video_url)).arrayBuffer();
    await waitForResult(s, id, (r) => r.purged_at !== null);
    const receipt = JSON.parse(readFileSync(join(s.dataDir, 'renders', id, 'render.json')));
    assert.equal(Object.hasOwn(receipt, 'callback_url'), false);
    assert.equal(Object.hasOwn(receipt, 'project'), false);
  } finally { await s.stop(); receiver.closeAllConnections(); await new Promise((resolve) => receiver.close(resolve)); }
});

test('failed result deletion retains durable intent and retries without a false purged receipt', async () => {
  const s = await startServer({ limits: { graceMs: 100 } });
  try {
    const { id, done, file } = await resultFixture(s, 'purge-retry');
    const logFile = join(s.dataDir, 'renders', id, 'render.log');
    rmSync(logFile);
    mkdirSync(logFile);
    await (await fetch(done.video_url)).arrayBuffer();
    const pending = await waitForResult(s, id, (r) => r.purge_after !== null && !existsSync(file));
    assert.equal(existsSync(file), false);
    assert.equal(pending.purged_at, null);
    assert.ok(pending.purge_after !== null);
    const record = JSON.parse(readFileSync(join(s.dataDir, 'renders', id, 'render.json')));
    assert.equal(record.purge_after, pending.purge_after);
    assert.equal(record.purged_at, undefined);
    rmSync(logFile, { recursive: true });
    await waitForResult(s, id, (r) => r.purged_at !== null);
  } finally { await s.stop(); }
});

test('metadata expiry waits for an active file transfer', async () => {
  const s = await startServer({ limits: { keepMs: 1000, graceMs: 100 } });
  let response;
  try {
    const { id, done, file } = await resultFixture(s, 'expiry-reader');
    truncateSync(file, 64 * 1024 * 1024);
    response = await pausedDownload(done.video_url);
    await sleep(2500);
    assert.equal((await s.api(`/v3/hyperframes/renders/${id}`)).status, 200);
    assert.equal(existsSync(file), true);
    response.destroy();
    for (let i = 0; i < 100 && (await s.api(`/v3/hyperframes/renders/${id}`)).status === 200; i++) await sleep(20);
    assert.equal((await s.api(`/v3/hyperframes/renders/${id}`)).status, 404);
    assert.equal(existsSync(file), false);
  } finally { response?.destroy(); await s.stop(); }
});

test('a full queue answers 429', async () => {
  const s = await startServer({ limits: { queued: 1 } });
  try {
    const asset = await uploadAsset(s, await zipOf(project('full', { SLOW: '1500' })));
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await submit(s, { project: { type: 'asset_id', asset_id: asset } })).status);
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally { await s.stop(); }
});

test('a corrupt record is quarantined instead of stopping startup', async () => {
  const dataDir = join(tmp, 'corrupt-data');
  mkdirSync(join(dataDir, 'renders/hfr_bad'), { recursive: true });
  writeFileSync(join(dataDir, 'renders/hfr_bad/render.json'), '{not json');
  const s = await startServer({ dataDir });
  try {
    assert.equal((await s.api('/v3/users/me')).status, 200);
    assert.equal(readdirSync(join(dataDir, 'quarantine')).length, 1);
  } finally { await s.stop(); }
});

test('upload and download URLs require their signatures; bad checksums can be re-uploaded', async () => {
  const { data } = await (await main.api('/v3/assets/direct-uploads', { method: 'POST', body: JSON.stringify({ size_bytes: 3, checksum_sha256: 'a'.repeat(64) }) })).json();
  assert.equal((await fetch(data.upload_url.replace(/sig=.*/, 'sig=forged'), { method: 'PUT', body: 'abc' })).status, 403);
  assert.equal((await fetch(data.upload_url, { method: 'PUT', body: 'abc' })).status, 200);
  assert.equal((await main.api(`/v3/assets/${data.asset_id}/complete`, { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await main.api(`/v3/assets/${data.asset_id}/complete`, { method: 'POST', body: '{}' })).status, 409, 'bytes were discarded');
  assert.equal((await fetch(`${main.base}/v3/files/hfr_x/video.mp4?sig=x`)).status, 404);
});

test('rejects unsafe render requests and zips with links', async () => {
  assert.equal((await submit(main, { project: { type: 'asset_id', asset_id: 'asst_missing' } })).status, 400);
  assert.equal((await submit(main, { project: { type: 'url', url: 'http://insecure/p.zip' } })).status, 400);
  const dir = project('linked');
  symlinkSync('/etc/hosts', join(dir, 'hosts'));
  const asset = await uploadAsset(main, await zipOf(dir));
  const bad = await submit(main, { project: { type: 'asset_id', asset_id: asset }, composition: '../../etc/passwd' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.param, 'composition');
  const linked = await submit(main, { project: { type: 'asset_id', asset_id: asset } });
  assert.match((await waitFor(main, linked.body.data.render_id)).failure_message, /symbolic link/);
});

test('cancelling during preparation stops it and never launches the renderer', async () => {
  const stall = createServer((req, res) => { res.writeHead(200); res.write(Buffer.alloc(100)); }); // never ends
  await new Promise((r) => stall.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${stall.address().port}/p.zip`;
  const dataDir = join(tmp, 'prep-data');
  let s = await startServer({ dataDir, allowHttpProjectUrls: true });
  try {
    const starts = () => (existsSync(join(tmp, 'intervals.log')) ? readFileSync(join(tmp, 'intervals.log'), 'utf8').split('start').length : 0);
    const before = starts();
    const deleted = (await submit(s, { project: { type: 'url', url } })).body.data.render_id;
    await waitFor(s, deleted, ['rendering']);
    assert.equal((await s.api(`/v3/hyperframes/renders/${deleted}`, { method: 'DELETE' })).status, 200);
    const requeued = (await submit(s, { project: { type: 'url', url } })).body.data.render_id;
    await waitFor(s, requeued, ['rendering']);
    for (let i = 0; i < 100 && !existsSync(join(dataDir, 'renders', requeued, 'project.zip')); i++) await sleep(10);
    await s.stop();
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'renders', requeued, 'render.json'), 'utf8')).status, 'queued');
    assert.equal(existsSync(join(dataDir, 'renders', requeued, 'project.zip')), true);
    assert.equal(existsSync(join(dataDir, 'renders', deleted)), false);
    await sleep(300);
    assert.equal(starts(), before, 'no renderer was launched for cancelled work');
  } finally { stall.closeAllConnections?.(); stall.close(); }
});

test('a requested aspect ratio that does not match the asset fails instead of reshaping', async () => {
  const asset = await uploadAsset(main, await zipOf(project('aspect', {}, 'data-width="1080" data-height="1920"')));
  const id = (await submit(main, { project: { type: 'asset_id', asset_id: asset }, aspect_ratio: '16:9' })).body.data.render_id;
  assert.match((await waitFor(main, id)).failure_message, /aspect_ratio 16:9 doesn't match the composition \(9:16\)/);
});

test('variables are validated strictly; WebM and MOV keep the composition size', async () => {
  const asset = await uploadAsset(main, await zipOf(project('vars')));
  const a = (await submit(main, { project: { type: 'asset_id', asset_id: asset }, variables: { title: 1 } })).body.data.render_id;
  await waitFor(main, a);
  assert.ok(lastArgs().includes('--strict-variables'));
  const b = (await submit(main, { project: { type: 'asset_id', asset_id: asset }, format: 'webm' })).body.data.render_id;
  await waitFor(main, b);
  assert.ok(!lastArgs().some((x) => x.startsWith('--resolution')), lastArgs().join(' '));
  assert.equal((await submit(main, { project: { type: 'asset_id', asset_id: asset }, format: 'mov', resolution: '4k' })).status, 400);
});

test('a completed upload acknowledges a partial retry and releases state after disconnect', async () => {
  const s = await startServer();
  const bytes = await zipOf(project('partial-upload-retry'));
  const assetId = await uploadAsset(s, bytes);
  const asset = JSON.parse(readFileSync(join(s.dataDir, 'assets', `${assetId}.json`), 'utf8'));
  let retry;
  try {
    const status = await new Promise((resolve, reject) => {
      retry = httpRequest(`${s.base}/v3/uploads/${assetId}?sig=${asset.upload_sig}`, {
        method: 'PUT', headers: { 'content-length': 64 * 1024 * 1024 },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      retry.on('error', reject);
      retry.write(Buffer.alloc(1024));
    });
    assert.equal(status, 200);
    retry.destroy();
    await s.stop();
    const restored = await startServer({ dataDir: s.dataDir });
    try {
      assert.deepEqual(readFileSync(join(s.dataDir, 'assets', `${assetId}.zip`)), bytes);
      assert.equal((await restored.api('/v3/users/me')).status, 200);
    } finally { await restored.stop(); }
  } finally { retry?.destroy(); await s.stop(); }
});

test('actual decompressed bytes enforce the archive limit even when metadata understates size', async () => {
  const s = await startServer({ limits: { zipExpandedBytes: 1000 } });
  try {
    const bytes = await zipOf(project('understated-size', { 'large.txt': 'x'.repeat(200000) }));
    for (const [signature, sizeOffset, nameOffset, nameLengthOffset] of [[0x04034b50, 22, 30, 26], [0x02014b50, 24, 46, 28]]) {
      const marker = Buffer.alloc(4);
      marker.writeUInt32LE(signature);
      for (let offset = bytes.indexOf(marker); offset >= 0; offset = bytes.indexOf(marker, offset + 4)) {
        const length = bytes.readUInt16LE(offset + nameLengthOffset);
        if (bytes.subarray(offset + nameOffset, offset + nameOffset + length).toString() === 'large.txt') bytes.writeUInt32LE(1, offset + sizeOffset);
      }
    }
    const asset = await uploadAsset(s, bytes);
    const id = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    const result = await waitFor(s, id, ['failed']);
    assert.match(result.failure_message, /expanded project exceeds.*1000 byte limit/);
    const next = await uploadAsset(s, await zipOf(project('after-inflate-limit')));
    const nextId = (await submit(s, { project: { type: 'asset_id', asset_id: next } })).body.data.render_id;
    assert.equal((await waitFor(s, nextId)).status, 'completed');
  } finally { await s.stop(); }
});

test('zips are sized before extraction', async () => {
  const s = await startServer({ limits: { zipExpandedBytes: 1000 } });
  try {
    const asset = await uploadAsset(s, await zipOf(project('bomb', { 'big.bin': 'x'.repeat(50000) })));
    const id = (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    assert.match((await waitFor(s, id)).failure_message, /expands to \d+ bytes; the limit is 1000/);
  } finally { await s.stop(); }
  const t = await startServer({ limits: { zipEntries: 2 } });
  try {
    const asset = await uploadAsset(t, await zipOf(project('many', { a: '1', b: '2', c: '3' })));
    const id = (await submit(t, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
    assert.match((await waitFor(t, id)).failure_message, /entries; the limit is 2/);
  } finally { await t.stop(); }
});

test('a delete acknowledged just before a crash is never resumed', async () => {
  const dataDir = join(tmp, 'delete-crash-data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(tmp, 'config.json'), JSON.stringify({ token: TOKEN, port: 0 }));
  const harness = join(tmp, 'harness-delete.mjs');
  writeFileSync(harness, `import { createRenderServer } from ${JSON.stringify(join(HERE, 'server.mjs'))};
const s = createRenderServer({ isolate: false, configPath: ${JSON.stringify(join(tmp, 'config.json'))}, dataDir: ${JSON.stringify(dataDir)}, renderer: ${JSON.stringify(STUB_RENDERER)} });
s.server.listen(0, '127.0.0.1', () => console.log(s.server.address().port));`);
  const child = spawn(process.execPath, [harness], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => child.stdout.once('data', (d) => r(Number(d.toString()))));
  const doomed = { api: (p, o = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...o, headers: { 'x-api-key': TOKEN, 'content-type': 'application/json', ...o.headers } }) };
  const asset = await uploadAsset(doomed, await zipOf(project('delete-crash', { SLOW: '8000' })));
  const id = (await submit(doomed, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
  await waitFor(doomed, id, ['rendering']);
  await sleep(200);
  const renderer = JSON.parse(readFileSync(join(dataDir, 'renders', id, 'render.json'), 'utf8')).pid;
  assert.equal((await doomed.api(`/v3/hyperframes/renders/${id}`, { method: 'DELETE' })).status, 200);
  child.kill('SIGKILL'); // before the server has seen its renderer exit
  await new Promise((r) => child.once('exit', r));
  const s = await startServer({ dataDir });
  try {
    assert.equal(running(renderer), false, 'the deleted render\'s renderer was stopped');
    assert.equal((await s.api(`/v3/hyperframes/renders/${id}`)).status, 404);
    assert.deepEqual(s.state(), { active: null, queued: [] });
    assert.equal(existsSync(join(dataDir, 'renders', id)), false);
    await sleep(500);
    const starts = readFileSync(join(tmp, 'intervals.log'), 'utf8').split('\n').filter((l) => l.includes(id) && l.includes(' start '));
    assert.equal(starts.length, 1, 'rendered once, never resumed');
  } finally { await s.stop(); }
});

test('idempotency keys are committed with their records and survive a hard kill', async () => {
  const dataDir = join(tmp, 'idem-crash-data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(tmp, 'config.json'), JSON.stringify({ token: TOKEN, port: 0 }));
  const harness = join(tmp, 'harness-idem.mjs');
  writeFileSync(harness, `import { createRenderServer } from ${JSON.stringify(join(HERE, 'server.mjs'))};
const s = createRenderServer({ isolate: false, configPath: ${JSON.stringify(join(tmp, 'config.json'))}, dataDir: ${JSON.stringify(dataDir)}, renderer: ${JSON.stringify(STUB_RENDERER)} });
s.server.listen(0, '127.0.0.1', () => console.log(s.server.address().port));`);
  const child = spawn(process.execPath, [harness], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => child.stdout.once('data', (d) => r(Number(d.toString()))));
  const killed = { api: (p, o = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...o, headers: { 'x-api-key': TOKEN, 'content-type': 'application/json', ...o.headers } }) };
  const bytes = await zipOf(project('idem-crash', { SLOW: '8000' }));
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const up = (sv) => sv.api('/v3/assets/direct-uploads', { method: 'POST', headers: { 'idempotency-key': 'crash-key' }, body: JSON.stringify({ filename: 'c.zip', size_bytes: bytes.length, checksum_sha256: checksum }) }).then((r) => r.json());
  const assetId = (await up(killed)).data.asset_id;
  const asset = await uploadAsset(killed, bytes);
  const body = { project: { type: 'asset_id', asset_id: asset } };
  const renderId = (await submit(killed, body, { 'idempotency-key': 'crash-key' })).body.data.render_id;
  // The key is committed in the same atomic write as each record, so no crash can
  // leave a record on disk without it.
  assert.ok(JSON.parse(readFileSync(join(dataDir, 'renders', renderId, 'render.json'), 'utf8')).idempotency?.slot);
  assert.ok(JSON.parse(readFileSync(join(dataDir, 'assets', `${assetId}.json`), 'utf8')).idempotency?.slot);
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  const s = await startServer({ dataDir });
  try {
    assert.equal((await up(s)).data.asset_id, assetId);
    assert.equal((await submit(s, body, { 'idempotency-key': 'crash-key' })).body.data.render_id, renderId);
    assert.equal((await submit(s, { ...body, quality: 'high' }, { 'idempotency-key': 'crash-key' })).status, 409);
  } finally { await s.stop(); }
});

test('upgrade: keys from the old idempotency/ files move into their records', async () => {
  const dataDir = join(tmp, 'legacy-data');
  let s = await startServer({ dataDir });
  const bytes = await zipOf(project('legacy'));
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const uploadBody = { filename: 'l.zip', size_bytes: bytes.length, checksum_sha256: checksum };
  const assetId = (await (await s.api('/v3/assets/direct-uploads', { method: 'POST', body: JSON.stringify(uploadBody) })).json()).data.asset_id;
  const asset = await uploadAsset(s, bytes);
  const renderBody = { project: { type: 'asset_id', asset_id: asset } };
  const renderId = (await submit(s, renderBody)).body.data.render_id;
  await waitFor(s, renderId);
  await s.stop();
  // What the previous version left behind: keys only in idempotency/, not in the records.
  const hash = (k) => createHash('sha256').update(k).digest('hex');
  const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  const fp = (v) => createHash('sha256').update(canonical(v)).digest('hex');
  mkdirSync(join(dataDir, 'idempotency'), { recursive: true });
  writeFileSync(join(dataDir, 'idempotency', `upload-${hash('old-key')}.json`), JSON.stringify({ id: assetId, fingerprint: fp({ size: bytes.length, checksum, filename: 'l.zip' }) }));
  writeFileSync(join(dataDir, 'idempotency', `render-${hash('old-key')}.json`), JSON.stringify({ id: renderId, fingerprint: fp(renderBody) }));
  s = await startServer({ dataDir });
  try {
    const replayUpload = await (await s.api('/v3/assets/direct-uploads', { method: 'POST', headers: { 'idempotency-key': 'old-key' }, body: JSON.stringify(uploadBody) })).json();
    assert.equal(replayUpload.data.asset_id, assetId);
    assert.equal((await submit(s, renderBody, { 'idempotency-key': 'old-key' })).body.data.render_id, renderId);
    assert.equal((await submit(s, { ...renderBody, quality: 'high' }, { 'idempotency-key': 'old-key' })).status, 409);
    assert.equal(existsSync(join(dataDir, 'idempotency')), false, 'legacy files removed once migrated');
    assert.ok(JSON.parse(readFileSync(join(dataDir, 'renders', renderId, 'render.json'), 'utf8')).idempotency);
  } finally { await s.stop(); }
  // An interrupted migration (record already updated, legacy file still present) finishes cleanly.
  mkdirSync(join(dataDir, 'idempotency'), { recursive: true });
  writeFileSync(join(dataDir, 'idempotency', `render-${hash('old-key')}.json`), JSON.stringify({ id: renderId, fingerprint: fp(renderBody) }));
  s = await startServer({ dataDir });
  try {
    assert.equal((await submit(s, renderBody, { 'idempotency-key': 'old-key' })).body.data.render_id, renderId);
    assert.equal(existsSync(join(dataDir, 'idempotency')), false);
  } finally { await s.stop(); }
});

test('GPU encoding: MP4 gets --gpu and a size-based bitrate; other formats and CPU mode do not', async () => {
  const s = await startServer({ gpu: true });
  try {
    const asset = await uploadAsset(s, await zipOf(project('gpu', {}, 'data-width="1080" data-height="1920"')));
    const run = async (body) => { await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset }, ...body })).body.data.render_id); return lastArgs(); };
    const hi4k = await run({ resolution: '4k', quality: 'high' });
    assert.ok(hi4k.includes('--gpu') && hi4k.includes('--video-bitrate=60M'), hi4k.join(' '));
    assert.equal(lastEnv().HF_CAPTURE_PARALLEL_STREAM, 'true', 'GPU MP4 streams frames to the encoder');
    assert.ok((await run({ quality: 'draft' })).includes('--video-bitrate=5M'));
    const webm = await run({ format: 'webm' });
    assert.ok(!webm.includes('--gpu') && !webm.some((a) => a.startsWith('--video-bitrate')), webm.join(' '));
    assert.equal(lastEnv().HF_CAPTURE_PARALLEL_STREAM, null, 'WebM keeps the default capture');
    assert.equal((await (await s.api('/v3/users/me')).json()).data.gpu_encode, true);
  } finally { await s.stop(); }
  const cpu = await startServer({ gpu: false });
  try {
    const asset = await uploadAsset(cpu, await zipOf(project('cpu')));
    await waitFor(cpu, (await submit(cpu, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id);
    assert.ok(!lastArgs().includes('--gpu'));
    assert.equal(lastEnv().HF_CAPTURE_PARALLEL_STREAM, null, 'CPU mode keeps the default capture');
  } finally { await cpu.stop(); }
});

test('GPU setting persists in config and MAC_RENDER_GPU overrides it', async () => {
  const fromConfig = await startServer({ config: { gpu: true } });
  try { assert.equal((await (await fromConfig.api('/v3/users/me')).json()).data.gpu_encode, true); } finally { await fromConfig.stop(); }
  process.env.MAC_RENDER_GPU = '0';
  try {
    const overridden = await startServer({ config: { gpu: true } });
    try { assert.equal((await (await overridden.api('/v3/users/me')).json()).data.gpu_encode, false); } finally { await overridden.stop(); }
  } finally { delete process.env.MAC_RENDER_GPU; }
  const off = await startServer();
  try { assert.equal((await (await off.api('/v3/users/me')).json()).data.gpu_encode, false); } finally { await off.stop(); }
});

test('a crash mid-render: browser process groups the renderer detached are stopped before new work', async () => {
  const dataDir = join(tmp, 'browser-crash-data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(tmp, 'config.json'), JSON.stringify({ token: TOKEN, port: 0 }));
  const harness = join(tmp, 'harness-browser.mjs');
  writeFileSync(harness, `import { createRenderServer } from ${JSON.stringify(join(HERE, 'server.mjs'))};
const s = createRenderServer({ isolate: false, configPath: ${JSON.stringify(join(tmp, 'config.json'))}, dataDir: ${JSON.stringify(dataDir)}, renderer: ${JSON.stringify(STUB_RENDERER)} });
s.server.listen(0, '127.0.0.1', () => console.log(s.server.address().port));`);
  const child = spawn(process.execPath, [harness], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => child.stdout.once('data', (d) => r(Number(d.toString()))));
  const crashed = { api: (p, o = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...o, headers: { 'x-api-key': TOKEN, 'content-type': 'application/json', ...o.headers } }) };
  const asset = await uploadAsset(crashed, await zipOf(project('browser-crash', { SLOW: '2500', BROWSER: '1' })));
  const id = (await submit(crashed, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id;
  await waitFor(crashed, id, ['rendering']);
  await sleep(300);
  const browser = browserFor(id);
  const renderer = JSON.parse(readFileSync(join(dataDir, 'renders', id, 'render.json'), 'utf8')).pid;
  assert.ok(browser && running(browser) && running(renderer));
  // An unrelated process that merely names the render folder, like `tail -f` on its log.
  const viewer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(dataDir, 'renders', id, 'render.log')], { detached: true, stdio: 'ignore' });
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  const s = await startServer({ dataDir }); // resolves once the old groups have exited
  try {
    assert.equal(running(viewer.pid), true, 'a process without the owner token is never signalled');
    assert.equal(running(browser), false, 'the detached browser group was stopped before new work');
    assert.equal(running(renderer), false);
    assert.equal((await waitFor(s, id)).status, 'completed');
    assert.equal(running(browserFor(id)), false, 'the resumed render\'s browser was stopped when it finished');
    assert.equal(running(viewer.pid), true);
  } finally { viewer.kill('SIGKILL'); await s.stop(); }
});

test('a finished or deleted render leaves no detached browser behind', async () => {
  const s = await startServer();
  try {
    const quick = await uploadAsset(s, await zipOf(project('browser-done', { SLOW: '1200', BROWSER: '1' })));
    const done = (await submit(s, { project: { type: 'asset_id', asset_id: quick } })).body.data.render_id;
    assert.equal((await waitFor(s, done)).status, 'completed');
    assert.equal(running(browserFor(done)), false, 'completion stops groups the renderer left');
    const slow = await uploadAsset(s, await zipOf(project('browser-delete', { SLOW: '8000', BROWSER: '1' })));
    const deleted = (await submit(s, { project: { type: 'asset_id', asset_id: slow } })).body.data.render_id;
    await waitFor(s, deleted, ['rendering']);
    await sleep(300);
    const browser = browserFor(deleted);
    assert.ok(running(browser));
    assert.equal((await s.api(`/v3/hyperframes/renders/${deleted}`, { method: 'DELETE' })).status, 200);
    for (let i = 0; i < 100 && running(browser); i++) await sleep(100);
    assert.equal(running(browser), false, 'DELETE stops the detached browser group');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- latest-only HyperFrames

// A fake npm and installer: `latest` is what npm reports (null = lookup fails),
// `bad` holds versions whose install or validation fails.
function versionPolicy() {
  const state = { latest: '1.0.0', bad: new Set(), prepared: [] };
  return {
    state,
    versions: {
      lookupLatest: async () => state.latest,
      prepareVersion: async (v) => { state.prepared.push(v); return !state.bad.has(v); },
      rendererFor: (v) => ({ argv: [process.execPath, STUB], version: v }),
    },
  };
}
const startsFor = (dir) => (existsSync(join(tmp, 'intervals.log')) ? readFileSync(join(tmp, 'intervals.log'), 'utf8').split('\n').filter((l) => l.includes(dir) && l.includes(' start ')).length : 0);

test('latest-only: every job renders with the release npm reports; a verified release is reused', async () => {
  const dataDir = join(tmp, 'latest-data');
  const { state, versions } = versionPolicy();
  let s = await startServer({ dataDir, versions });
  try {
    const asset = await uploadAsset(s, await zipOf(project('latest')));
    const a = await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id);
    const b = await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id);
    assert.deepEqual([a.status, a.hyperframes_version, b.status, b.hyperframes_version], ['completed', '1.0.0', 'completed', '1.0.0']);
    assert.deepEqual(state.prepared, ['1.0.0'], 'validated once, then reused');
    state.latest = '1.1.0';
    const c = await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id);
    assert.equal(c.hyperframes_version, '1.1.0', 'a new release is picked up by the next job');
  } finally { await s.stop(); }
  s = await startServer({ dataDir, versions });
  try {
    const asset = await uploadAsset(s, await zipOf(project('latest-restart')));
    assert.equal((await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id)).hyperframes_version, '1.1.0');
    assert.deepEqual(state.prepared, ['1.0.0', '1.1.0'], 'verification survives a restart');
  } finally { await s.stop(); }
});

test('capture tuning reaches only measured settings and cannot leak into future releases', async () => {
  const inherited = process.env.PRODUCER_CORES_PER_WORKER;
  process.env.PRODUCER_CORES_PER_WORKER = '0.5';
  const { state, versions } = versionPolicy();
  const s = await startServer({ gpu: true, config: { captureTuning: '1.5@1.0.0' }, versions });
  try {
    const asset = await uploadAsset(s, await zipOf(project('capture-tuning')));
    const run = async (settings = {}) => {
      const body = { project: { type: 'asset_id', asset_id: asset }, quality: 'high', resolution: '4k', ...settings };
      const result = await waitFor(s, (await submit(s, body)).body.data.render_id);
      assert.equal(result.status, 'completed');
      return lastEnv().PRODUCER_CORES_PER_WORKER;
    };
    assert.equal(await run(), '1.5');
    assert.ok(!lastArgs().some((arg) => arg.startsWith('--workers')));
    for (const settings of [{ quality: 'standard' }, { quality: 'draft' }, { fps: 60 }, { resolution: '1080p' },
      { format: 'webm', resolution: '1080p' }, { format: 'mov', resolution: '1080p' }]) {
      assert.equal(await run(settings), null);
    }
    state.latest = '1.1.0';
    assert.equal(await run(), null);
    assert.deepEqual(state.prepared, ['1.0.0', '1.1.0']);
  } finally {
    await s.stop();
    if (inherited === undefined) delete process.env.PRODUCER_CORES_PER_WORKER;
    else process.env.PRODUCER_CORES_PER_WORKER = inherited;
  }
});

test('GPU and capture profile changes revalidate once; auto environment override survives restart', async () => {
  const dataDir = join(tmp, 'capture-profile');
  const { state, versions } = versionPolicy();
  const prior = process.env.MAC_RENDER_CAPTURE_CORES;
  delete process.env.MAC_RENDER_CAPTURE_CORES;
  const render = async (config) => {
    const s = await startServer({ dataDir, config, versions });
    try {
      const asset = await uploadAsset(s, await zipOf(project('capture-profile')));
      const result = await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset }, quality: 'high', resolution: '4k' })).body.data.render_id);
      assert.equal(result.status, 'completed');
      return lastEnv().PRODUCER_CORES_PER_WORKER;
    } finally { await s.stop(); }
  };
  try {
    assert.equal(await render({ gpu: false }), null);
    assert.equal(await render({ gpu: false }), null);
    assert.equal(state.prepared.length, 1);
    assert.equal(await render({ gpu: true }), null);
    assert.equal(state.prepared.length, 2);
    const config = { gpu: true, captureTuning: '1.5@1.0.0' };
    assert.equal(await render(config), '1.5');
    assert.equal(await render(config), '1.5');
    assert.equal(state.prepared.length, 3);
    process.env.MAC_RENDER_CAPTURE_CORES = 'auto';
    assert.equal(await render(config), null);
    assert.equal(await render(config), null);
    assert.equal(state.prepared.length, 4);
    const receipt = JSON.parse(readFileSync(join(dataDir, 'hyperframes/known-good.json')));
    assert.deepEqual(receipt.render_profile, { gpu: true, captureCoresPerWorker: null });
  } finally {
    if (prior === undefined) delete process.env.MAC_RENDER_CAPTURE_CORES;
    else process.env.MAC_RENDER_CAPTURE_CORES = prior;
  }
});

test('latest-only: a failed npm lookup fails the job without rendering', async () => {
  const { state, versions } = versionPolicy();
  const s = await startServer({ versions });
  try {
    const dir = project('lookup-fails');
    const asset = await uploadAsset(s, await zipOf(dir));
    state.latest = null;
    const failed = await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.failure_message, /Could not look up the latest HyperFrames release on npm/);
    assert.equal(startsFor('lookup-fails'), 0, 'no renderer started');
  } finally { await s.stop(); }
});

test('a release verified before the isolation policy is validated again', async () => {
  const dataDir = join(tmp, 'old-policy-data');
  mkdirSync(join(dataDir, 'hyperframes'), { recursive: true });
  writeFileSync(join(dataDir, 'hyperframes', 'known-good.json'), JSON.stringify({ version: '1.0.0', promoted_at: 1 }));
  const { state, versions } = versionPolicy();
  const s = await startServer({ dataDir, versions });
  try {
    const asset = await uploadAsset(s, await zipOf(project('old-policy')));
    const result = await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(state.prepared, ['1.0.0']);
    assert.equal(typeof JSON.parse(readFileSync(join(dataDir, 'hyperframes', 'known-good.json'))).policy, 'string');
  } finally { await s.stop(); }
});

test('latest-only: a candidate that fails never falls back to an older verified release, and is retried next job', async () => {
  const { state, versions } = versionPolicy();
  const s = await startServer({ versions });
  try {
    const asset = await uploadAsset(s, await zipOf(project('candidate')));
    const ok = await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id);
    assert.equal(ok.hyperframes_version, '1.0.0');
    const before = startsFor('candidate');
    state.latest = '2.0.0';
    state.bad.add('2.0.0');
    const failed = await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.failure_message, /HyperFrames 2\.0\.0, the latest release, failed to install or pass validation/);
    assert.equal(startsFor('candidate'), before, '1.0.0 was not used instead');
    state.bad.delete('2.0.0'); // a transient failure clears
    const retried = await waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id);
    assert.deepEqual([retried.status, retried.hyperframes_version], ['completed', '2.0.0']);
    assert.deepEqual(state.prepared, ['1.0.0', '2.0.0', '2.0.0']);
  } finally { await s.stop(); }
});

test('state moves out of Library/Caches once, keeping ids, keys, downloads and old-process cleanup', async () => {
  const legacy = join(tmp, 'Caches-like', 'hyperframes-mac-render');
  const moved = join(tmp, 'Support-like', 'hyperframes-mac-render-state');
  let s = await startServer({ dataDir: legacy });
  const bytes = await zipOf(project('migrate'));
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const uploadBody = { filename: 'm.zip', size_bytes: bytes.length, checksum_sha256: checksum };
  const up = (sv) => sv.api('/v3/assets/direct-uploads', { method: 'POST', headers: { 'idempotency-key': 'move-key' }, body: JSON.stringify(uploadBody) }).then((r) => r.json());
  const assetId = (await up(s)).data.asset_id;
  const asset = await uploadAsset(s, bytes);
  const body = { project: { type: 'asset_id', asset_id: asset } };
  const renderId = (await submit(s, body, { 'idempotency-key': 'move-key' })).body.data.render_id;
  await waitFor(s, renderId);
  await s.stop();
  const oldTag = readFileSync(join(legacy, 'owner-tag'), 'utf8').trim();
  // A process the old server left running, carrying its owner token.
  const leftover = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, MAC_RENDER_OWNER: `${oldTag}:${renderId}:render:abcd` } });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', legacy], { detached: true, stdio: 'ignore' });
  await sleep(300);

  assert.equal(migrateState(legacy, moved), true);
  assert.equal(existsSync(legacy), false);
  s = await startServer({ dataDir: moved });
  try {
    assert.equal(running(leftover.pid), false, 'processes from the old location are still stopped');
    assert.equal(running(unrelated.pid), true);
    assert.equal(readFileSync(join(moved, 'owner-tag'), 'utf8').trim(), oldTag);
    assert.equal((await up(s)).data.asset_id, assetId, 'upload key kept');
    assert.equal((await submit(s, body, { 'idempotency-key': 'move-key' })).body.data.render_id, renderId, 'render key kept');
    const detail = (await (await s.api(`/v3/hyperframes/renders/${renderId}`)).json()).data;
    assert.equal(detail.status, 'completed');
    const video = await fetch(detail.video_url);
    assert.equal(video.status, 200, 'the finished video is served from its new location');
    assert.deepEqual(Buffer.from(await video.arrayBuffer()), readFileSync(join(tmp, 'fixture.mp4')));
    const again = await waitFor(s, (await submit(s, body)).body.data.render_id);
    assert.equal(again.status, 'completed', 'the moved upload renders again');
  } finally { unrelated.kill('SIGKILL'); await s.stop(); }
  assert.equal(migrateState(legacy, moved), false, 'nothing to move a second time');
  mkdirSync(join(legacy, 'renders'), { recursive: true });
  assert.throws(() => migrateState(legacy, moved), /Render state exists in both/, 'conflicting state is refused, not ignored');
  assert.equal(existsSync(legacy), true);
  const fresh = join(tmp, 'Support-like', 'empty-target');
  mkdirSync(fresh, { recursive: true });
  assert.equal(migrateState(legacy, fresh), true, 'an empty target folder holds no state');
  assert.ok(existsSync(join(fresh, 'renders')));
});

test('owner tags: a missing, empty or malformed tag refuses startup; recovery matches only this instance', async () => {
  for (const bad of ['', 'ABCDEF0123456789', '0123', '0123456789abcdef0']) {
    const dataDir = join(tmp, `bad-tag-${bad.length}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'owner-tag'), bad);
    await assert.rejects(startServer({ dataDir }), /Invalid owner tag/, JSON.stringify(bad));
  }
  const legacy = join(tmp, 'bad-legacy');
  mkdirSync(join(legacy, 'renders'), { recursive: true });
  writeFileSync(join(legacy, 'owner-tag'), '');
  assert.throws(() => migrateState(legacy, join(tmp, 'bad-legacy-target')), /Invalid owner tag/);
  assert.equal(existsSync(join(legacy, 'renders')), true, 'nothing moved');

  const dataDir = join(tmp, 'tag-scope');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'owner-tag'), 'aaaaaaaaaaaaaaaa');
  const env = (v) => ({ detached: true, stdio: 'ignore', env: { ...process.env, MAC_RENDER_OWNER: v } });
  const loop = ['-e', 'setInterval(() => {}, 1000)'];
  const ours = spawn(process.execPath, loop, env('aaaaaaaaaaaaaaaa:hfr_x:render:0000'));
  const oursValidation = spawn(process.execPath, loop, env('aaaaaaaaaaaaaaaa-vabcdef:hfr_y:render:0000'));
  const other = spawn(process.execPath, loop, env('aaaaaaaaaaaaaaaab:hfr_z:render:0000'));
  await sleep(300);
  const s = await startServer({ dataDir });
  try {
    assert.equal(running(ours.pid), false);
    assert.equal(running(oursValidation.pid), false);
    assert.equal(running(other.pid), true, 'a longer tag that merely starts with ours is another instance');
  } finally { other.kill('SIGKILL'); await s.stop(); }
});

test('latest-only with real npm: each job asks the registry; a registry outage fails the job even with a cached answer', async () => {
  let latest = '1.0.0';
  let online = true;
  const registry = createServer((req, res) => {
    if (!online) { req.socket.destroy(); return; }
    const doc = { name: 'hyperframes', 'dist-tags': { latest, beta: '9.9.9-beta.1' }, versions: { [latest]: { name: 'hyperframes', version: latest }, '9.9.9-beta.1': { name: 'hyperframes', version: '9.9.9-beta.1' } } };
    res.writeHead(200, { 'content-type': 'application/json', etag: `"${latest}"` });
    res.end(JSON.stringify(doc));
  });
  await new Promise((r) => registry.listen(0, '127.0.0.1', r));
  const prepared = [];
  const s = await startServer({
    versions: {
      prepareVersion: async (v) => { prepared.push(v); return true; },
      rendererFor: (v) => ({ argv: [process.execPath, STUB], version: v }),
      npmEnv: {
        npm_config_registry: `http://127.0.0.1:${registry.address().port}/`,
        npm_config_cache: join(tmp, 'npm-cache'), // shared, so a stale answer is available
        npm_config_fetch_retries: '0', npm_config_fetch_timeout: '3000', npm_config_userconfig: join(tmp, 'no-npmrc'),
        npm_config_tag: 'beta', // a configured default tag must not replace `latest`
      },
    },
  });
  try {
    const asset = await uploadAsset(s, await zipOf(project('real-npm')));
    const render = async () => waitFor(s, (await submit(s, { project: { type: 'asset_id', asset_id: asset } })).body.data.render_id, ['completed', 'failed'], 60e3);
    assert.equal((await render()).hyperframes_version, '1.0.0');
    latest = '1.1.0';
    assert.equal((await render()).hyperframes_version, '1.1.0', 'a newly tagged release is seen by the next job');
    online = false;
    const offline = await render();
    assert.equal(offline.status, 'failed', `rendered with ${offline.hyperframes_version} while the registry was down`);
    assert.match(offline.failure_message, /Could not look up the latest HyperFrames release on npm/);
  } finally { await s.stop(); registry.closeAllConnections?.(); registry.close(); }
});
