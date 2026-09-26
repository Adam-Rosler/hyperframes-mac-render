import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { sandboxInvocation, SANDBOX_POLICY_REVISION } from './sandbox.mjs';

const native = { skip: process.platform !== 'darwin' };
function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac-render-sandbox-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['scratch', 'project', 'records']) fs.mkdirSync(path.join(root, name));
  return root;
}

test('filesystem boundary grants project/output, denies sibling records, and is inherited by children', native, (t) => {
  const root = workspace(t);
  const project = path.join(root, 'project');
  const record = path.join(root, 'records', 'render.json');
  const output = path.join(root, 'records', 'output.txt');
  fs.writeFileSync(path.join(project, 'asset.txt'), 'owned project asset');
  fs.writeFileSync(record, 'owned synthetic control metadata');
  const source = `
    const fs = require('node:fs'), cp = require('node:child_process');
    const [project, record, output] = process.argv.slice(1);
    const r = {};
    r.project = fs.readFileSync(project + '/asset.txt', 'utf8');
    fs.writeFileSync(project + '/new.txt', 'project write');
    fs.writeFileSync(output, 'output write');
    try { fs.readFileSync(record); r.readDenied = false; } catch(e) { r.readDenied = ['EPERM','EACCES'].includes(e.code); }
    try { fs.writeFileSync(record, 'changed'); r.writeDenied = false; } catch(e) { r.writeDenied = ['EPERM','EACCES'].includes(e.code); }
    const child = cp.spawnSync(process.execPath, ['-e', 'try { require("fs").readFileSync(process.argv[1]); process.exit(8); } catch(e) { process.exit(["EPERM","EACCES"].includes(e.code) ? 0 : 9); }', record]);
    r.childDenied = child.status === 0;
    r.secretAbsent = !process.env.HEYGEN_API_KEY && !process.env.NODE_OPTIONS;
    r.captureCores = process.env.PRODUCER_CORES_PER_WORKER;
    console.log(JSON.stringify(r));
  `;
  const invocation = sandboxInvocation([process.execPath, '-e', source, project, record, output], {
    scratchDir: path.join(root, 'scratch'), readWrite: [project], writeFiles: [output],
    env: { HEYGEN_API_KEY: 'synthetic-secret', NODE_OPTIONS: '--inspect', HF_CAPTURE_PARALLEL_STREAM: 'true', PRODUCER_CORES_PER_WORKER: '1.5' },
  });
  const result = spawnSync(invocation.argv[0], invocation.argv.slice(1), {
    cwd: project, env: invocation.env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    project: 'owned project asset', readDenied: true, writeDenied: true, childDenied: true, secretAbsent: true, captureCores: '1.5',
  });
  assert.equal(fs.readFileSync(record, 'utf8'), 'owned synthetic control metadata');
  assert.equal(fs.readFileSync(output, 'utf8'), 'output write');
  assert.equal(fs.readFileSync(path.join(project, 'new.txt'), 'utf8'), 'project write');
  assert.equal(invocation.env.HF_CAPTURE_PARALLEL_STREAM, 'true');
  for (const key of ['HOME', 'CFFIXED_USER_HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'HYPERFRAMES_EXTRACT_CACHE_DIR']) {
    assert.ok(invocation.env[key].startsWith(path.join(root, 'scratch') + '/'), key);
  }
  assert.match(SANDBOX_POLICY_REVISION, /^mac-filesystem-v/);
});

test('explicit readonly input cannot be overwritten by the native process', native, (t) => {
  const root = workspace(t);
  const input = path.join(root, 'project', 'input.txt');
  fs.writeFileSync(input, 'readonly asset');
  const invocation = sandboxInvocation([process.execPath, '-e', `
    const fs = require('node:fs');
    if (fs.readFileSync(process.argv[1], 'utf8') !== 'readonly asset') process.exit(8);
    try { fs.writeFileSync(process.argv[1], 'changed'); process.exit(9); }
    catch(e) { process.exit(['EPERM','EACCES'].includes(e.code) ? 0 : 10); }
  `, input], { scratchDir: path.join(root, 'scratch'), readOnly: [input] });
  const result = spawnSync(invocation.argv[0], invocation.argv.slice(1), {
    env: invocation.env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(input, 'utf8'), 'readonly asset');
});

test('browser caches preserve native lookup layout without forcing a Chrome version', native, (t) => {
  const root = workspace(t);
  const invocation = sandboxInvocation([process.execPath, '--version'], {
    scratchDir: path.join(root, 'scratch'), browserCaches: true,
    env: { LANG: 'en_US.UTF-8', TZ: 'America/Los_Angeles', HF_CAPTURE_PARALLEL_STREAM: 'invalid', PATH: '/untrusted' },
  });
  assert.equal(invocation.env.HYPERFRAMES_BROWSER_PATH, undefined);
  assert.equal(invocation.env.HF_CAPTURE_PARALLEL_STREAM, undefined);
  assert.equal(invocation.env.LANG, 'en_US.UTF-8');
  assert.equal(invocation.env.TZ, 'America/Los_Angeles');
  assert.ok(!invocation.env.PATH.includes('/untrusted'));
  for (const relative of ['.cache/hyperframes/chrome', '.cache/puppeteer/chrome-headless-shell']) {
    const host = path.join(os.homedir(), relative);
    if (!fs.existsSync(host)) continue;
    const mirror = path.join(invocation.env.HOME, relative);
    assert.ok(fs.lstatSync(mirror).isSymbolicLink());
    assert.equal(fs.realpathSync(mirror), fs.realpathSync(host));
    assert.ok(invocation.profile.includes(JSON.stringify(fs.realpathSync(host))));
  }
});

test('invalid or broad scratch inputs fail closed', native, (t) => {
  const root = workspace(t);
  assert.throws(() => sandboxInvocation([process.execPath, '--version'], { scratchDir: os.homedir() }), /dedicated private/);
  assert.throws(() => sandboxInvocation([process.execPath, '--version'], { scratchDir: 'relative' }), /absolute/);
  fs.symlinkSync(path.join(root, 'project'), path.join(root, 'scratch', 'home'));
  assert.throws(() => sandboxInvocation([process.execPath, '--version'], { scratchDir: path.join(root, 'scratch') }), /must not be symlinks/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'project')), [], 'rejection precedes private-directory creation');
  fs.symlinkSync(path.join(root, 'project'), path.join(root, 'scratch-alias'));
  assert.throws(() => sandboxInvocation([process.execPath, '--version'], { scratchDir: path.join(root, 'scratch-alias') }), /must not be symlinks/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'project')), []);
});

test('other platforms have no unsandboxed production fallback', { skip: process.platform === 'darwin' }, () => {
  assert.throws(() => sandboxInvocation([process.execPath, '--version'], { scratchDir: '/tmp' }), /requires macOS/);
});

test('native capture budget forwards only a finite positive numeric value', native, (t) => {
  const root = workspace(t);
  for (const [i, value] of ['0', '-1', 'Infinity', '1e999', '1.5 extra', '', 'NaN'].entries()) {
    const invocation = sandboxInvocation([process.execPath, '--version'], {
      scratchDir: path.join(root, 'invalid-' + i), env: { PRODUCER_CORES_PER_WORKER: value },
    });
    assert.equal(invocation.env.PRODUCER_CORES_PER_WORKER, undefined);
  }
});
