import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function createDashboardServer(snapshot) {
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(body);
    };
    req.resume();
    const port = server.address()?.port;
    const host = req.headers.host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)
      || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)
      || (req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
      return send(403, 'This dashboard is available only on this Mac.');
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(405, 'Only GET is supported.');
    }
    try {
      if (req.url === '/api/status') return send(200, JSON.stringify(snapshot()), 'application/json; charset=utf-8');
      const asset = ASSETS.get(req.url);
      if (!asset) return send(404, 'Not found.');
      const [name, type] = asset;
      return send(200, await readFile(new URL(`./dashboard/${name}`, import.meta.url)), type);
    } catch {
      if (!res.destroyed) send(503, 'The dashboard is temporarily unavailable.');
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  return server;
}
