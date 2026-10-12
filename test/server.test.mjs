import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../lib/config.mjs';
import { httpFetch } from '../support/http-helper.mjs';

function temporary() { return mkdtempSync(join(tmpdir(), 'my-reef-test-')); }
function setup(dir, args = []) {
  return spawnSync(process.execPath, ['setup-password.mjs', ...args], { env: { ...process.env, MY_REEF_DATA_DIR: dir }, encoding: 'utf8' });
}
async function start(dir, origin) {
  const env = { ...process.env, MY_REEF_DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', REEF_POLLING: 'off' };
  delete env.PUBLIC_ORIGIN;
  if (origin) env.PUBLIC_ORIGIN = origin;
  const child = spawn(process.execPath, ['server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', data => { errors += data; });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error('Server did not start: ' + errors)); }, 10000);
    child.stdout.on('data', data => { output += data; const match = /listening on port (\d+)/.exec(output); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
    child.once('exit', () => { clearTimeout(timeout); reject(Error('Server exited: ' + errors)); });
  });
  const publicOrigin = origin || 'http://localhost:' + port;
  async function request(path, options = {}) {
    return httpFetch('http://127.0.0.1:' + port + path, { ...options, headers: { Host: new URL(publicOrigin).host, ...options.headers } });
  }
  async function stop() { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
  return { request, publicOrigin, stop };
}

test('standalone configuration supports local use and requires HTTPS for remote origins', () => {
  assert.equal(loadConfig({}).port, 3000);
  assert.equal(loadConfig({}).host, '127.0.0.1');
  assert.equal(loadConfig({ PUBLIC_ORIGIN: 'http://localhost:3000/' }).origin, 'http://localhost:3000');
  assert.equal(loadConfig({ PUBLIC_ORIGIN: 'https://reef.example/' }).origin, 'https://reef.example');
  for (const PUBLIC_ORIGIN of ['http://reef.example', 'https://user:secret@reef.example', 'https://reef.example/path', 'https://reef.example/?token=secret', 'https://reef.example/#token', 'invalid']) assert.throws(() => loadConfig({ PUBLIC_ORIGIN }), /PUBLIC_ORIGIN/);
  for (const PORT of ['bad', '-1', '65536', '1.5']) assert.throws(() => loadConfig({ PORT }), /PORT/);
});

test('first-run setup creates a private independent password and container setup retains it', () => {
  const dir = temporary();
  try {
    const result = setup(dir);
    assert.equal(result.status, 0, result.stderr);
    const password = readFileSync(join(dir, 'password.txt'), 'utf8').trim();
    assert.ok(password.length >= 24);
    assert.ok(!result.stdout.includes(password));
    const auth = readFileSync(join(dir, 'auth.json'), 'utf8');
    assert.ok(!auth.includes(password));
    assert.equal(statSync(join(dir, 'password.txt')).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'auth.json')).mode & 0o777, 0o600);
    assert.equal(setup(dir).status, 1);
    assert.equal(setup(dir, ['--if-missing']).status, 0);
    assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), auth);
    assert.equal(setup(dir, ['--rotate']).status, 0);
    assert.notEqual(readFileSync(join(dir, 'auth.json'), 'utf8'), auth);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('independent server authenticates its root dashboard, protects equipment and files, and supplies install metadata', async () => {
  const dir = temporary();
  assert.equal(setup(dir).status, 0);
  const running = await start(dir, 'https://reef.example');
  const { request } = running;
  try {
    assert.equal((await request('/healthz')).status, 200);
    assert.equal((await request('/', { headers: { Host: 'attacker.example' } })).status, 400);
    assert.equal((await request('/')).headers.get('location'), '/login');
    const login = await request('/login');
    assert.equal(login.status, 200);
    assert.match(await login.text(), /Welcome to My Reef/);
    const manifest = await request('/manifest.webmanifest');
    assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
    const metadata = await manifest.json();
    assert.equal(metadata.start_url, '/');
    assert.equal(metadata.display, 'standalone');
    for (const icon of metadata.icons) assert.equal((await request(icon.src)).status, 200);
    for (const vendor of ['reef', 'aquawiz']) {
      const response = await request('/api/' + vendor + '/state');
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, 'MY_REEF_AUTH_REQUIRED');
    }
    const password = readFileSync(join(dir, 'password.txt'), 'utf8').trim();
    const post = (value, headers = {}) => request('/login', { method: 'POST', headers: { Origin: running.publicOrigin, ...headers }, body: new URLSearchParams({ password: value }) });
    assert.equal((await post(password, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await post('wrong')).status, 401);
    const signedIn = await post(password);
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get('location'), '/');
    const setCookie = signedIn.headers.get('set-cookie');
    for (const flag of ['my_reef_session=', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=34560000']) assert.ok(setCookie.includes(flag));
    const Cookie = setCookie.split(';')[0];
    const home = await request('/', { headers: { Cookie } });
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Alkalinity &amp; salinity/);
    assert.doesNotMatch(html, /Playground|on this Mac/);
    for (const path of ['/app.js', '/ranges.js', '/refresh-loop.js']) assert.equal((await request(path, { headers: { Cookie } })).status, 200);
    for (const vendor of ['reef', 'aquawiz']) assert.equal((await (await request('/api/' + vendor + '/state', { headers: { Cookie } })).json()).connected, false);
    for (const path of ['/server.mjs', '/package.json', '/lib/backend.mjs', '/.git/config', '/auth.json', '/password.txt', '/sessions.json', '/reef-sessions.key', '/reef-sessions.enc.json', '/apps/reef-dashboard/']) assert.equal((await request(path, { headers: { Cookie } })).status, 404);
    assert.equal((await post(password, { Cookie })).headers.get('set-cookie').split(';')[0], Cookie);
    const logout = await request('/logout', { method: 'POST', headers: { Cookie, Origin: running.publicOrigin } });
    assert.equal(logout.headers.get('location'), '/login');
    assert.equal((await request('/', { headers: { Cookie } })).status, 303);
  } finally { await running.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('localhost login survives restart and password rotation revokes permanent browser sessions', async () => {
  const dir = temporary();
  assert.equal(setup(dir).status, 0);
  let running = await start(dir);
  try {
    const password = readFileSync(join(dir, 'password.txt'), 'utf8').trim();
    const login = await running.request('/login', { method: 'POST', headers: { Origin: running.publicOrigin }, body: new URLSearchParams({ password }) });
    const setCookie = login.headers.get('set-cookie');
    assert.ok(!setCookie.includes('Secure'));
    const Cookie = setCookie.split(';')[0];
    await running.stop();
    running = await start(dir);
    assert.equal((await running.request('/', { headers: { Cookie } })).status, 200);
    await running.stop();
    assert.equal(setup(dir, ['--rotate']).status, 0);
    running = await start(dir);
    assert.equal((await running.request('/', { headers: { Cookie } })).status, 303);
  } finally { await running.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('setup command can load a data location from .env without shell-specific exports', () => {
  const dir = temporary();
  try {
    const settings = join(dir, 'config.env');
    const dataDir = join(dir, 'data');
    writeFileSync(settings, 'MY_REEF_DATA_DIR=' + dataDir + '\nPORT=3100\n');
    const env = { ...process.env };
    delete env.MY_REEF_DATA_DIR;
    const result = spawnSync(process.execPath, ['--env-file=' + settings, 'setup-password.mjs'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(join(dataDir, 'password.txt'), 'utf8').trim().length >= 24);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
