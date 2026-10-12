import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseEnv } from 'node:util';
import { loadConfig } from './lib/config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
console.log('\nMY REEF PHONE ACCESS\nStop the My Reef window with Control+C before changing its address.');
const input = createInterface({ input: stdin, output: stdout });
try {
  const entered = (await input.question('Paste your ngrok HTTPS address, then press Enter: ')).trim();
  if (!entered) throw Error('No address entered. Your settings were kept.');
  const candidate = entered.includes('://') ? entered : 'https://' + entered;
  const path = process.env.MY_REEF_SETTINGS_FILE || join(root, '.env');
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const config = loadConfig({ ...parseEnv(previous), ...process.env, PUBLIC_ORIGIN: candidate });
  const origin = config.origin;
  if (!origin.startsWith('https:')) throw Error('Phone access needs an HTTPS address.');
  if (config.port === 0) throw Error('Set a fixed app port before setting up a tunnel. The normal port is 3000.');
  const lines = previous.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?PUBLIC_ORIGIN\s*=/.test(line));
  const kept = lines.join('\n').replace(/\n*$/, '');
  const temporary = path + '.' + process.pid + '.tmp';
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, (kept ? kept + '\n' : '') + 'PUBLIC_ORIGIN=' + origin + '\n', { mode: 0o600 });
  renameSync(temporary, path);
  console.log('\nSaved. Start My Reef again using the same command or start file.');
  console.log('In a second Terminal or Command Prompt window, run:');
  console.log('ngrok http http://127.0.0.1:' + config.port + ' --url ' + origin + ' --inspect=false');
  console.log('\nThen open ' + origin + ' on your phone.');
} catch (error) {
  console.error('Address not saved: ' + error.message);
  process.exitCode = 1;
} finally {
  input.close();
}
