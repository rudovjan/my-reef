import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('PORT must be an integer between 0 and 65535.');
  const host = env.HOST || '127.0.0.1';
  const dataDir = resolve(env.MY_REEF_DATA_DIR || join(homedir(), '.config', 'my-reef'));
  let origin = null;
  if (env.PUBLIC_ORIGIN) {
    let url;
    try { url = new URL(env.PUBLIC_ORIGIN); } catch { throw Error('PUBLIC_ORIGIN must be a complete URL.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw Error('PUBLIC_ORIGIN must be an HTTPS origin, or an HTTP localhost origin for local use.');
    }
    origin = url.origin;
  }
  return { port, host, dataDir, origin, authPath: join(dataDir, 'auth.json'), sessionPath: join(dataDir, 'sessions.json'), polling: env.REEF_POLLING !== 'off' };
}
