import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
if (existsSync(config.authPath)) {
  if (process.argv.includes('--if-missing')) process.exit(0);
  if (!process.argv.includes('--rotate')) throw Error('My Reef is already configured. Use npm run setup -- --rotate to replace its password, then restart.');
}
const password = randomBytes(18).toString('base64url');
const salt = randomBytes(16).toString('hex');
const temporary = config.authPath + '.' + process.pid + '.tmp';
writeFileSync(temporary, JSON.stringify({ salt, hash: scryptSync(password, salt, 64).toString('hex') }), { mode: 0o600 });
renameSync(temporary, config.authPath);
chmodSync(config.authPath, 0o600);
const passwordPath = join(config.dataDir, 'password.txt');
writeFileSync(passwordPath, password + '\n', { mode: 0o600 });
chmodSync(passwordPath, 0o600);
console.log('My Reef password saved in ' + passwordPath);
console.log('Read that file privately, then start My Reef. Never commit or share the data directory.');
