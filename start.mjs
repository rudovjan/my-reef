import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './lib/config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 9)) {
  console.error('Please install Node.js 24 LTS from https://nodejs.org/en/download, then start My Reef again.');
  process.exit(1);
}
if (process.argv.includes('--help')) {
  console.log('Start My Reef: node start.mjs\nCreates the first login automatically, keeps existing connections, and loads this folder\'s .env file.');
  process.exit(0);
}

try {
  const settings = process.env.MY_REEF_SETTINGS_FILE || join(root, '.env');
  if (existsSync(settings)) process.loadEnvFile(settings);
  const config = loadConfig();
  const setup = spawnSync(process.execPath, [join(root, 'setup-password.mjs'), '--if-missing'], { encoding: 'utf8' });
  if (setup.status !== 0) throw Error(setup.stderr.trim() || 'First-time setup could not complete.');
  console.log('\nMY REEF\n');
  const passwordPath = join(config.dataDir, 'password.txt');
  if (existsSync(passwordPath)) {
    console.log('Your My Reef login password (copy it into the browser):');
    console.log(readFileSync(passwordPath, 'utf8').trim());
    console.log('Keep this password private. This is separate from your equipment logins.\n');
  } else {
    console.log('Use your existing My Reef password to sign in.\n');
  }
  console.log('Leave this window open and keep the computer awake.');
  console.log('To stop My Reef, press Control+C.\n');
} catch (error) {
  console.error('My Reef could not start: ' + error.message);
  process.exit(1);
}

process.once('uncaughtException', error => {
  if (error.code === 'EADDRINUSE') {
    console.error('This port is already in use. My Reef may already be running in another window.');
    console.error('Use that window, or stop the other app using the port and try again.');
  } else {
    console.error('My Reef stopped: ' + error.message);
  }
  process.exit(1);
});
await import('./server.mjs');
