import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { createDashboardServer } from './dashboard.mjs';

async function start(t, snapshot = () => ({ observed_at: 123, active: null, queued: [], recent: [] })) {
  const server = createDashboardServer(snapshot);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('dashboard serves its page, assets and a fresh read-only snapshot', async (t) => {
  let observed = 123;
  const { base } = await start(t, () => ({ observed_at: observed++, active: null, queued: [], recent: [] }));
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.ok((await response.text()).length > 100);
  }
  assert.deepEqual(await (await fetch(base + '/api/status')).json(), { observed_at: 123, active: null, queued: [], recent: [] });
  assert.equal((await (await fetch(base + '/api/status')).json()).observed_at, 124);
  assert.equal((await fetch(base + '/missing')).status, 404);
  assert.equal((await fetch(base + '/api/status?anything=1')).status, 404);
  assert.equal((await fetch(base + '/api/status', { method: 'POST', body: '{}' })).status, 405);
});

test('dashboard accepts local navigation and same-origin polling only', async (t) => {
  const { base, server } = await start(t);
  const port = server.address().port;
  const status = (headers) => new Promise((resolve, reject) => {
    const req = request(base + '/api/status', { headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  for (const headers of [
    { host: `127.0.0.1:${port}`, origin: base, 'sec-fetch-site': 'same-origin' },
    { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'none' },
  ]) assert.equal(await status(headers), 200, JSON.stringify(headers));
  for (const headers of [
    { host: `example.com:${port}` }, { host: 'localhost:1' },
    { origin: 'http://localhost:1' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ]) assert.equal(await status(headers), 403, JSON.stringify(headers));
});

test('dashboard reports snapshot failure without disclosing error details', async (t) => {
  const { base } = await start(t, () => { throw new Error('private state path'); });
  const response = await fetch(base + '/api/status');
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'The dashboard is temporarily unavailable.');
});
