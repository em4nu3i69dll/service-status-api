import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const carpeta = process.env.STATUS_SECRETOS || 'local/secretos';
const req = https.get('https://127.0.0.1:3443/api/salud', {
  servername: 'status-api', ca: readFileSync(join(carpeta, 'ca.crt')),
  cert: readFileSync(join(carpeta, 'salud.crt')), key: readFileSync(join(carpeta, 'salud.key')),
  timeout: 3000, minVersion: 'TLSv1.3'
}, res => { res.resume(); process.exitCode = res.statusCode === 200 ? 0 : 1; });
req.on('timeout', () => req.destroy());
req.on('error', () => { process.exitCode = 1; });
