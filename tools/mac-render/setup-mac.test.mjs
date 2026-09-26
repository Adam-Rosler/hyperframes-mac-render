import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const setup = readFileSync(new URL('./setup-mac.sh', import.meta.url), 'utf8');
const check = setup.match(/^check_dashboard\(\) \{[\s\S]*?^\}/m)?.[0];

async function checkFixture(t, respond) {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    respond(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const result = await new Promise((resolve) => {
    execFile('bash', ['-euo', 'pipefail', '-c', `${check}\ncheck_dashboard "$1"`, 'dashboard-check', `http://127.0.0.1:${server.address().port}`], {
      env: { ...process.env, NODE: process.execPath }, timeout: 10_000,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr }));
  });
  return { ...result, paths };
}

const snapshot = { observed_at: 123, service: { host: 'Test Mac', state: 'idle' }, active: null, queued: [], recent: [], recent_total: 0 };

test('installer accepts a dashboard snapshot only after all static routes answer', async (t) => {
  assert.equal(typeof check, 'string');
  const result = await checkFixture(t, (req, res) => {
    res.end(req.url === '/api/status' ? JSON.stringify(snapshot) : 'dashboard asset');
  });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.paths, ['/api/status', '/', '/app.js', '/style.css']);
});

test('installer rejects unrelated catch-all HTTP 200 servers', async (t) => {
  for (const body of ['<html>Unrelated app</html>', '{}', '{"status":"ok"}', 'null']) {
    const result = await checkFixture(t, (req, res) => res.end(body));
    assert.equal(result.code, 1, result.output);
    assert.deepEqual(result.paths, ['/api/status']);
  }
});

test('installer rejects a dashboard with a missing static asset', async (t) => {
  const result = await checkFixture(t, (req, res) => {
    if (req.url === '/app.js') res.statusCode = 404;
    res.end(req.url === '/api/status' ? JSON.stringify(snapshot) : 'dashboard asset');
  });
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(result.paths, ['/api/status', '/', '/app.js']);
});

function installerFixture(t, contents) {
  const root = mkdtempSync(join(tmpdir(), 'mac-render-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), bin = join(root, 'bin'), source = join(root, 'source');
  const config = join(home, '.config/hyperframes-mac-render/mac-render.json');
  const actions = join(root, 'actions');
  for (const dir of [bin, source, dirname(config)]) mkdirSync(dir, { recursive: true });
  if (contents !== undefined) writeFileSync(config, contents);
  const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  command('uname', 'echo Darwin');
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const name of ['npm', 'unzip', 'zipinfo', 'ffmpeg', 'ffprobe', 'caffeinate', 'otool', 'sandbox-exec']) command(name, 'exit 0');
  command('tailscale', 'if [ "$1" = status ]; then echo \'{"Self":{"DNSName":"fixture.tailnet.ts.net."}}\'; else echo funnel >> "$ACTIONS"; fi');
  command('launchctl', 'echo launchctl >> "$ACTIONS"; [ "$1" != print ]');
  command('pbcopy', 'cat >/dev/null; echo clipboard >> "$ACTIONS"');
  command('curl', `case "\${!#}" in */api/status) echo '${JSON.stringify(snapshot)}' ;; esac`);
  writeFileSync(join(source, 'e2e.sh'), 'echo render >> "$ACTIONS"\n');
  writeFileSync(join(source, 'capture-tuning.mjs'), readFileSync(new URL('./capture-tuning.mjs', import.meta.url)));
  for (const name of ['server.mjs', 'render-args.mjs', 'sandbox.mjs', 'dashboard.mjs', 'dashboard/index.html', 'dashboard/app.js', 'dashboard/style.css']) {
    mkdirSync(dirname(join(source, name)), { recursive: true });
    writeFileSync(join(source, name), 'fixture');
  }
  const script = join(source, 'setup-mac.sh');
  writeFileSync(script, setup
    .replaceAll('/Applications/Tailscale.app/Contents/MacOS/Tailscale', join(bin, 'tailscale'))
    .replaceAll('/usr/bin/otool', join(bin, 'otool'))
    .replaceAll('/usr/bin/sandbox-exec', join(bin, 'sandbox-exec')));
  return {
    home, bin, config,
    actions: () => existsSync(actions) ? readFileSync(actions, 'utf8').trim().split('\n') : [],
    run: (...args) => new Promise((resolve) => {
      execFile('/bin/bash', [script, ...args], {
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ACTIONS: actions }, timeout: 10_000,
      }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    }),
  };
}

const saved = { token: 'existing-fixture-key', publicUrl: 'https://saved.tailnet.ts.net', port: 8788, gpu: true, extra: 'keep-me' };

test('installer reruns preserve the key and settings with atomic private replacement', async (t) => {
  const fixture = installerFixture(t, JSON.stringify(saved));
  chmodSync(fixture.config, 0o644);
  const before = statSync(fixture.config);
  const result = await fixture.run('--no-copy');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(fixture.config, 'utf8')), { ...saved, publicUrl: 'https://fixture.tailnet.ts.net' });
  assert.notEqual(statSync(fixture.config).ino, before.ino, 'replace the complete file instead of truncating it');
  assert.equal(statSync(fixture.config).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(fixture.config)), ['mac-render.json']);
  assert.ok(fixture.actions().includes('render'));
  assert.equal((await fixture.run('--no-copy')).code, 0);
  assert.equal(JSON.parse(readFileSync(fixture.config, 'utf8')).token, saved.token);
});

test('installer rotates only when explicitly requested and keeps other settings', async (t) => {
  const fixture = installerFixture(t, JSON.stringify(saved));
  const result = await fixture.run('--rotate');
  assert.equal(result.code, 0, result.stderr);
  const updated = JSON.parse(readFileSync(fixture.config, 'utf8'));
  assert.notEqual(updated.token, saved.token);
  assert.match(updated.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(updated.gpu, true);
  assert.equal(updated.extra, 'keep-me');
});

test('installer creates a private key only when the configuration is missing', async (t) => {
  const fixture = installerFixture(t);
  const result = await fixture.run('--no-copy');
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(readFileSync(fixture.config, 'utf8'));
  assert.match(config.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(config.publicUrl, 'https://fixture.tailnet.ts.net');
  assert.equal(config.port, 8788);
  assert.equal(statSync(fixture.config).mode & 0o777, 0o600);
});

test('installer rejects malformed existing configuration before changing files or services', async (t) => {
  for (const contents of ['{bad', 'null', '[]', '{}', '{"token":false}']) {
    const fixture = installerFixture(t, contents);
    const before = statSync(fixture.config);
    const result = await fixture.run('--no-copy');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /configuration/i);
    assert.equal(readFileSync(fixture.config, 'utf8'), contents);
    assert.equal(statSync(fixture.config).ino, before.ino);
    assert.equal(statSync(fixture.config).mtimeMs, before.mtimeMs);
    assert.equal(existsSync(join(fixture.home, 'Library')), false);
    assert.deepEqual(fixture.actions(), []);
  }
});

test('installer rejects an unreadable configuration without replacing it', async (t) => {
  const fixture = installerFixture(t);
  mkdirSync(fixture.config);
  const result = await fixture.run('--no-copy');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /configuration/i);
  assert.equal(statSync(fixture.config).isDirectory(), true);
  assert.equal(existsSync(join(fixture.home, 'Library')), false);
  assert.deepEqual(fixture.actions(), []);
});

test('installer preserves a configuration it has no permission to read', { skip: process.getuid?.() === 0 }, async (t) => {
  const fixture = installerFixture(t, JSON.stringify(saved));
  const before = statSync(fixture.config);
  chmodSync(fixture.config, 0o000);
  const result = await fixture.run('--no-copy');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /configuration \(EACCES\)/);
  assert.equal(statSync(fixture.config).ino, before.ino);
  assert.equal(statSync(fixture.config).mode & 0o777, 0o000);
  assert.equal(existsSync(join(fixture.home, 'Library')), false);
  assert.deepEqual(fixture.actions(), []);
  chmodSync(fixture.config, 0o600);
  assert.equal(readFileSync(fixture.config, 'utf8'), JSON.stringify(saved));
});

test('--show reads the saved settings without installation, rendering or mutation', async (t) => {
  const fixture = installerFixture(t, JSON.stringify(saved));
  const before = statSync(fixture.config);
  for (const name of ['tailscale', 'ffmpeg', 'otool']) rmSync(join(fixture.bin, name));
  const result = await fixture.run('--show');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'HEYGEN_API_URL=https://saved.tailnet.ts.net\nHEYGEN_API_KEY=existing-fixture-key\nNODE_USE_ENV_PROXY=1\n');
  assert.equal(readFileSync(fixture.config, 'utf8'), JSON.stringify(saved));
  assert.equal(statSync(fixture.config).ino, before.ino);
  assert.equal(statSync(fixture.config).mtimeMs, before.mtimeMs);
  assert.equal(existsSync(join(fixture.home, 'Library')), false);
  assert.deepEqual(fixture.actions(), []);
});

test('--show fails clearly when no saved configuration exists and does not create one', async (t) => {
  const fixture = installerFixture(t);
  const result = await fixture.run('--show');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /configuration/i);
  assert.equal(existsSync(fixture.config), false);
  assert.deepEqual(fixture.actions(), []);
});


test('installer persists capture tuning, preserves credentials on rerun, and supports auto', async (t) => {
  const fixture = installerFixture(t, JSON.stringify(saved));
  assert.equal((await fixture.run('--capture-cores', '1.5@0.8.78')).code, 0);
  const tuning = { coresPerWorker: 1.5, hyperframesVersion: '0.8.78' };
  assert.deepEqual(JSON.parse(readFileSync(fixture.config)).captureTuning, tuning);
  assert.equal((await fixture.run('--no-copy')).code, 0);
  const persisted = JSON.parse(readFileSync(fixture.config));
  assert.equal(persisted.token, saved.token);
  assert.equal(persisted.gpu, true);
  assert.deepEqual(persisted.captureTuning, tuning);
  assert.equal(readFileSync(join(fixture.home, 'Library/Application Support/hyperframes-mac-render/capture-tuning.mjs'), 'utf8'), readFileSync(new URL('./capture-tuning.mjs', import.meta.url), 'utf8'));
  assert.ok(!fixture.actions().includes('clipboard'));
  assert.equal((await fixture.run('--capture-cores', 'auto')).code, 0);
  assert.equal(JSON.parse(readFileSync(fixture.config)).captureTuning, undefined);
  assert.equal(JSON.parse(readFileSync(fixture.config)).token, saved.token);
});

test('invalid capture tuning leaves settings and services untouched', async (t) => {
  const contents = JSON.stringify(saved);
  const fixture = installerFixture(t, contents);
  assert.equal((await fixture.run('--capture-cores', '1.5@latest')).code, 1);
  assert.equal(readFileSync(fixture.config, 'utf8'), contents);
  assert.deepEqual(fixture.actions(), []);
  assert.equal(existsSync(join(fixture.home, 'Library')), false);
});
