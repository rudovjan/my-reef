import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { httpFetch } from '../support/http-helper.mjs';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'my-reef launcher test-'));
  const root = join(directory, 'app with spaces');
  for (const name of ['server.mjs', 'setup-password.mjs', 'start.mjs', 'configure-phone.mjs', 'lib', 'public', 'Start My Reef.command', 'Start My Reef.bat', 'Set Up Phone Access.command', 'Set Up Phone Access.bat']) cpSync(join(source, name), join(root, name), { recursive: true });
  const data = join(directory, 'private data');
  const env = { ...process.env, REEF_POLLING: 'off' };
  for (const name of ['PORT', 'HOST', 'PUBLIC_ORIGIN', 'MY_REEF_DATA_DIR']) delete env[name];
  return { directory, root, data, env, remove: () => rmSync(directory, { recursive: true, force: true }) };
}
async function start(f) {
  const child = spawn(process.execPath, [join(f.root, 'start.mjs')], { cwd: f.directory, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', data => { errors += data; });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error('Launcher did not become ready.')); }, 10000);
    child.stdout.on('data', data => { output += data; const match = /Open http:\/\/localhost:(\d+)/.exec(output); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
    child.once('exit', () => { clearTimeout(timeout); reject(Error('Launcher exited before startup: ' + errors)); });
  });
  return {
    output,
    request: (path, options = {}) => httpFetch('http://127.0.0.1:' + port + path, { ...options, headers: { Host: 'localhost:' + port, ...options.headers } }),
    origin: 'http://localhost:' + port,
    stop: async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done; } },
  };
}

test('beginner launch sets up once, loads its folder settings, and preserves browser login across starts', async () => {
  const f = fixture();
  writeFileSync(join(f.root, '.env'), 'MY_REEF_DATA_DIR=' + JSON.stringify(f.data) + '\nPORT=0\n');
  let running;
  try {
    running = await start(f);
    const password = readFileSync(join(f.data, 'password.txt'), 'utf8').trim();
    const auth = readFileSync(join(f.data, 'auth.json'), 'utf8');
    assert.ok(running.output.includes(password));
    assert.match(running.output, /Leave this window open/);
    const response = await running.request('/login', { method: 'POST', headers: { Origin: running.origin }, body: new URLSearchParams({ password }) });
    assert.equal(response.status, 303);
    const Cookie = response.headers.get('set-cookie').split(';')[0];
    await running.stop();
    running = await start(f);
    assert.equal(readFileSync(join(f.data, 'auth.json'), 'utf8'), auth);
    assert.equal(readFileSync(join(f.data, 'password.txt'), 'utf8').trim(), password);
    assert.equal((await running.request('/', { headers: { Cookie } })).status, 200);
  } finally { await running?.stop(); f.remove(); }
});

test('phone helper accepts a pasted hostname, keeps other settings, and replaces the old origin once', () => {
  const f = fixture();
  const path = join(f.root, '.env');
  const original = '# Keep my settings\r\nPORT=3210\r\nMY_REEF_DATA_DIR="some path"\r\nPUBLIC_ORIGIN=https://old.example\r\n export PUBLIC_ORIGIN = "https://duplicate.example"\r\n';
  writeFileSync(path, original);
  try {
    const result = spawnSync(process.execPath, [join(f.root, 'configure-phone.mjs')], { cwd: f.directory, env: f.env, input: 'my-tank.ngrok-free.app/\n', encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const changed = readFileSync(path, 'utf8');
    assert.match(changed, /# Keep my settings\nPORT=3210\nMY_REEF_DATA_DIR="some path"/);
    assert.equal((changed.match(/PUBLIC_ORIGIN=/g) || []).length, 1);
    assert.match(changed, /PUBLIC_ORIGIN=https:\/\/my-tank.ngrok-free.app\n$/);
    assert.match(result.stdout, /ngrok http http:\/\/127.0.0.1:3210 --url https:\/\/my-tank.ngrok-free.app --inspect=false/);
    assert.equal(existsSync(join(f.data, 'auth.json')), false);
  } finally { f.remove(); }
});

test('phone helper rejects insecure or credential-bearing addresses without changing settings', () => {
  const f = fixture();
  const path = join(f.root, '.env');
  const original = 'PORT=3000\nPUBLIC_ORIGIN=https://existing.example\n';
  writeFileSync(path, original);
  try {
    for (const input of ['http://reef.example', 'https://user:secret@reef.example', 'https://reef.example/path', 'https://reef.example?token=secret', '']) {
      const result = spawnSync(process.execPath, [join(f.root, 'configure-phone.mjs')], { cwd: f.directory, env: f.env, input: input + '\n', encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.equal(readFileSync(path, 'utf8'), original);
      assert.ok(!result.stderr.includes('user:secret') && !result.stderr.includes('token=secret'));
    }
  } finally { f.remove(); }
});

test('Windows phone-access button runs from a folder with spaces', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', '""' + join(f.root, 'Set Up Phone Access.bat') + '""'], { cwd: f.directory, env: f.env, input: 'button-test.ngrok-free.app\n\n', encoding: 'utf8', windowsVerbatimArguments: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.root, '.env'), 'utf8'), /PUBLIC_ORIGIN=https:\/\/button-test.ngrok-free.app/);
  } finally { f.remove(); }
});
