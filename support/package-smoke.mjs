import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { httpFetch } from './http-helper.mjs';

const target = process.argv[2];
assert.ok(target, 'Run npm run test:package -- <package tarball or HTTPS tarball URL>.');
assert.ok(process.env.npm_execpath, 'Run this check through npm run test:package.');
const npx = join(dirname(process.env.npm_execpath), 'npx-cli.js');
assert.ok(existsSync(npx), 'npx is missing from this npm installation.');
const spec = /^https?:\/\//.test(target) ? target : 'file:' + resolve(target.replace(/^file:/, ''));
const command = [process.execPath, npx, '--yes', spec];
const work = mkdtempSync(join(tmpdir(), 'my-reef-npx-smoke-'));
const privateDir = join(work, 'private data');
const env = { ...process.env, MY_REEF_DATA_DIR: privateDir, PORT: '0', HOST: '127.0.0.1', REEF_POLLING: 'off' };
delete env.PUBLIC_ORIGIN;
delete env.MY_REEF_SETTINGS_FILE;
let child;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (process.platform === 'win32') {
    const { spawnSync } = await import('node:child_process');
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    process.kill(-child.pid, 'SIGTERM');
  }
  await exited;
}
async function launch() {
  child = spawn(command[0], command.slice(1), { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let output = '', errors = '';
  child.stderr.on('data', data => { errors += data; });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { void stop(); reject(Error('npx did not start the packaged app.')); }, 60000);
    child.stdout.on('data', data => { output += data; const match = /Open http:\/\/localhost:(\d+)/.exec(output); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
    child.once('exit', () => { clearTimeout(timeout); reject(Error('npx exited before startup: ' + errors)); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  const origin = 'http://localhost:' + port;
  return { output, origin, request: (path, options = {}) => httpFetch('http://127.0.0.1:' + port + path, { ...options, headers: { Host: 'localhost:' + port, ...options.headers } }) };
}
try {
  let running = await launch();
  const password = readFileSync(join(privateDir, 'password.txt'), 'utf8').trim();
  const auth = readFileSync(join(privateDir, 'auth.json'), 'utf8');
  assert.ok(running.output.includes(password));
  const login = await running.request('/login', { method: 'POST', headers: { Origin: running.origin }, body: new URLSearchParams({ password }) });
  assert.equal(login.status, 303);
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const home = await running.request('/', { headers: { Cookie } });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Alkalinity &amp; salinity/);
  await stop();
  // Confirm another cached-package launch reads the persistent settings by
  // checking it rejects a deliberately invalid address.
  writeFileSync(join(privateDir, 'settings.env'), 'PUBLIC_ORIGIN=http://reef.example\n');
  child = spawn(command[0], command.slice(1), { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timeout = setTimeout(() => { void stop(); }, 15000);
  const [exit] = await once(child, 'exit');
  clearTimeout(timeout);
  assert.notEqual(exit, 0);
  assert.match(output, /PUBLIC_ORIGIN/);
  rmSync(join(privateDir, 'settings.env'));
  running = await launch();
  assert.equal(readFileSync(join(privateDir, 'auth.json'), 'utf8'), auth);
  assert.equal((await running.request('/', { headers: { Cookie } })).status, 200);
  assert.deepEqual(readdirSync(work), ['private data']);
  assert.equal(existsSync(join(work, '.env')), false);
  console.log('npx package: first setup, authenticated dashboard, private settings and persistent browser login verified.');
} finally {
  await stop();
  rmSync(work, { recursive: true, force: true });
}
