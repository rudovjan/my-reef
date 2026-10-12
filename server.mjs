import http from 'node:http';
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReefApi } from './lib/backend.mjs';
import { AquaWizClient } from './lib/aquawiz.mjs';
import { createSessionStore } from './lib/session-store.mjs';
import { loadConfig } from './lib/config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = realpathSync(join(root, 'public'));
const config = loadConfig();
let auth;
try { auth = JSON.parse(readFileSync(config.authPath)); }
catch { throw Error('My Reef is not set up. Run npm run setup first (using the same MY_REEF_DATA_DIR).'); }
if (!/^[a-f0-9]{32}$/.test(auth.salt) || !/^[a-f0-9]{128}$/.test(auth.hash)) throw Error('Invalid My Reef authentication configuration.');
const dataDir = realpathSync(config.dataDir);
if (dataDir === publicDir || dataDir.startsWith(publicDir + sep)) throw Error('MY_REEF_DATA_DIR must be outside the public assets directory.');

function loadSessions() {
  try {
    const saved = JSON.parse(readFileSync(config.sessionPath));
    if (saved.version !== 2 || saved.authSalt !== auth.salt) return new Map();
    return new Map(Object.entries(saved.sessions).filter(([token, expiry]) => /^[a-zA-Z0-9_-]{43}$/.test(token) && (expiry === null || (Number.isFinite(expiry) && expiry > Date.now()))).map(([token]) => [token, null]));
  } catch { return new Map(); }
}
const sessions = loadSessions();
function saveSessions() {
  const temporary = config.sessionPath + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify({ version: 2, authSalt: auth.salt, sessions: Object.fromEntries(sessions) }), { mode: 0o600 });
  renameSync(temporary, config.sessionPath);
  chmodSync(config.sessionPath, 0o600);
}
saveSessions();
const store = createSessionStore({ path: join(config.dataDir, 'reef-sessions.enc.json'), keyPath: join(config.dataDir, 'reef-sessions.key') });
const valid = token => sessions.has(token);
const ownerScope = 'owner:' + auth.salt;
const reef = createReefApi({ store, isSessionValid: valid, sharedScope: ownerScope });
const aqua = createReefApi({ prefix: '/api/aquawiz/', vendor: 'AquaWiz', refreshInterval: 900000, makeClient: () => new AquaWizClient(), store, isSessionValid: valid, sharedScope: ownerScope });
reef.prune(sessions);
aqua.prune(sessions);
const cookieAge = 400 * 24 * 60 * 60;
let publicOrigin = config.origin;
let attempts = [];
const cookie = (token, age) => `my_reef_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${publicOrigin.startsWith('https:') ? '; Secure' : ''}`;
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, status, body = '', extra = {}) { res.writeHead(status, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8', ...extra }); res.end(body); }
function redirect(res, path, extra = {}) { send(res, 303, '', { Location: path, ...extra }); }
function json(res, status, value) { send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json' }); }
function login(res, invalid = false) {
  const page = readFileSync(join(publicDir, 'login.html'), 'utf8').replace('<!--ERROR-->', invalid ? '<p role="alert" class="error">Incorrect password. Try again.</p>' : '');
  send(res, invalid ? 401 : 200, page);
}
function serve(res, path, head) {
  try {
    const candidate = resolve(publicDir, '.' + (path === '/' ? '/index.html' : path));
    if (!candidate.startsWith(publicDir + sep)) return send(res, 404, 'Not found');
    const file = realpathSync(candidate);
    if (!file.startsWith(publicDir + sep) || !statSync(file).isFile()) return send(res, 404, 'Not found');
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
    send(res, 200, head ? '' : readFileSync(file), { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
  } catch { send(res, 404, 'Not found'); }
}
const publicAssets = new Set(['/styles.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']);
const server = http.createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path.includes('\0') || path.split('/').some(p => p.startsWith('.'))) return send(res, 404, 'Not found');
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return send(res, 405, 'Method not allowed');
    if (req.method === 'POST' && req.headers.origin !== publicOrigin) return send(res, 403, 'Invalid origin');
    if (path === '/healthz' && ['GET', 'HEAD'].includes(req.method)) return send(res, 200, req.method === 'HEAD' ? '' : 'ok', { 'Content-Type': 'text/plain' });
    if (req.headers.host !== new URL(publicOrigin).host) return send(res, 400, 'Unrecognized host');
    const token = /(?:^|;\s*)my_reef_session=([a-zA-Z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
    const authenticated = valid(token);
    if (authenticated) res.setHeader('Set-Cookie', cookie(token, cookieAge));
    if (path === '/login' && req.method === 'POST') {
      const now = Date.now();
      attempts = attempts.filter(t => t > now - 60000);
      if (attempts.length >= 20) return send(res, 429, 'Too many attempts. Try again in a minute.', { 'Retry-After': '60' });
      attempts.push(now);
      let size = 0, chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 4096) { send(res, 413, 'Request too large'); req.destroy(); return; } chunks.push(chunk); }
      const password = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('password') || '';
      if (!timingSafeEqual(scryptSync(password, auth.salt, 64), Buffer.from(auth.hash, 'hex'))) return login(res, true);
      if (authenticated) return redirect(res, '/', { 'Set-Cookie': cookie(token, cookieAge) });
      if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
      const next = randomBytes(32).toString('base64url');
      sessions.set(next, null);
      saveSessions();
      return redirect(res, '/', { 'Set-Cookie': cookie(next, cookieAge) });
    }
    if (path === '/login' && req.method === 'GET') return authenticated ? redirect(res, '/') : login(res);
    if (publicAssets.has(path) && ['GET', 'HEAD'].includes(req.method)) return serve(res, path, req.method === 'HEAD');
    if (!authenticated) {
      if (path.startsWith('/api/')) return json(res, 401, { error: 'Sign in to My Reef.', code: 'MY_REEF_AUTH_REQUIRED' });
      return redirect(res, '/login');
    }
    if (path === '/logout' && req.method === 'POST') {
      if (sessions.delete(token)) saveSessions();
      return redirect(res, '/login', { 'Set-Cookie': cookie('', 0) });
    }
    for (const [prefix, api] of [['/api/reef/', reef], ['/api/aquawiz/', aqua]]) {
      if (path.startsWith(prefix)) {
        const result = await api.handle(req, path, token);
        return send(res, result.status, req.method === 'HEAD' ? '' : JSON.stringify(result.data), { 'Content-Type': 'application/json' });
      }
    }
    if (req.method === 'POST') return send(res, 405, 'Method not allowed');
    serve(res, path, req.method === 'HEAD');
  } catch { if (!res.headersSent) send(res, 400, 'Bad request'); else res.end(); }
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
async function poll() {
  const results = await Promise.allSettled([reef.poll(), aqua.poll()]);
  if (results.some(r => r.status === 'rejected')) console.error('Aquarium polling encountered an error; saved connections retained.');
}
const timer = config.polling ? setInterval(poll, 60000) : null;
timer?.unref();
server.on('close', () => { if (timer) clearInterval(timer); });
server.listen(config.port, config.host, () => {
  const port = server.address().port;
  publicOrigin ||= 'http://localhost:' + port;
  console.log('My Reef listening on port ' + port);
  console.log('Open ' + publicOrigin);
  if (config.polling) void poll();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
