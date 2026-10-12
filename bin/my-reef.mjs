#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('My Reef\n\nmy-reef        Start the dashboard and keep existing logins\nmy-reef phone  Set up your HTTPS address for phone access\nmy-reef --version  Show the version\n\nInstall Node.js 24 LTS first. Stop the dashboard with Control+C.');
  process.exit(0);
}
if (args.includes('--version')) {
  const { readFileSync } = await import('node:fs');
  console.log(JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8')).version);
  process.exit(0);
}
if (args.length && (args.length !== 1 || args[0] !== 'phone')) {
  console.error('Use my-reef to start, or my-reef phone to set up phone access.');
  process.exit(1);
}
try {
  process.env.MY_REEF_SETTINGS_FILE ||= join(loadConfig().dataDir, 'settings.env');
} catch (error) {
  console.error('My Reef could not start: ' + error.message);
  process.exit(1);
}
await import(args[0] === 'phone' ? '../configure-phone.mjs' : '../start.mjs');
