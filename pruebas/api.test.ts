import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { crearAPI } from '../api/servidor.ts';
import { Estado } from '../api/estado.ts';
import { abrir, derivar, sellar } from '../api/protocolo.ts';

let carpeta: string;
let api: Awaited<ReturnType<typeof crearAPI>>;
let puerto: number;
let privado: number;
let reloj = Date.now();
let secretos: string;
const maestra = 'b1'.repeat(32);
const llaves = derivar(maestra, 'web');
let secuencia = 0;
const lectura = (cambios = {}) => ({ instancia: 'prueba', secuencia: ++secuencia, online: true, latencia_ms: 8, usuarios: null, capacidad: null, ...cambios });

before(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'status-pruebas-'));
  execFileSync(process.env.PYTHON || 'python', ['operacion/preparar.py', '--destino', join(carpeta, 'local')], { stdio: 'pipe' });
  secretos = join(carpeta, 'local/secretos');
  await writeFile(join(secretos, 'canales.json'), JSON.stringify({ web: maestra, juego: 'c2'.repeat(32) }));
  await writeFile(join(secretos, 'web.key'), maestra);
  api = await crearAPI({ secretos, archivo: join(carpeta, 'datos/estado.json'), reloj: () => reloj });
  await Promise.all([new Promise<void>(r => api.ingesta.listen(0, '127.0.0.1', r)), new Promise<void>(r => api.lectura.listen(0, '127.0.0.1', r))]);
  puerto = (api.ingesta.address() as AddressInfo).port;
  privado = (api.lectura.address() as AddressInfo).port;
});

after(async () => {
  for (const servidor of [api?.ingesta, api?.lectura]) {
    if (!servidor) continue;
    servidor.closeAllConnections();
    await new Promise<void>(r => servidor.close(() => r()));
  }
  if (carpeta) await rm(carpeta, { recursive: true, force: true });
});

async function peticion(ruta: string, opciones: { rol?: string; privado?: boolean; cuerpo?: string; headers?: Record<string, string>; method?: string } = {}) {
  const cert = opciones.rol ? await readFile(join(secretos, opciones.rol + '.crt')) : undefined;
  const key = opciones.rol ? await readFile(join(secretos, opciones.rol + '.key')) : undefined;
  const ca = await readFile(join(secretos, 'ca.crt'));
  return new Promise<{ codigo: number; cuerpo: string; headers: http.IncomingHttpHeaders }>((resolver, rechazar) => {
    const req = https.request({ hostname: '127.0.0.1', servername: 'status-api', port: opciones.privado ? privado : puerto, path: ruta, ca, cert, key, method: opciones.method || 'GET', headers: opciones.headers, agent: false }, res => {
      let cuerpo = '';
      res.setEncoding('utf8');
      res.on('data', p => { cuerpo += p; });
      res.on('end', () => resolver({ codigo: res.statusCode!, cuerpo, headers: res.headers }));
    });
    req.on('error', rechazar);
    req.end(opciones.cuerpo);
  });
}

test('lectura privada sin datos y salud separada', async () => {
  const r = await peticion('/api/v1/estado/web', { rol: 'monitor', privado: true });
  assert.equal(JSON.parse(r.cuerpo).estado, 'sin_datos');
  assert.equal((await peticion('/api/salud', { rol: 'salud', privado: true })).codigo, 200);
  assert.equal((await peticion('/api/v1/estado', { rol: 'salud', privado: true })).codigo, 403);
  await assert.rejects(peticion('/api/v1/estado', { privado: true }));
});

test('ingesta cifrada, acuse vinculado y estado real', async () => {
  const datos = lectura();
  const sobre = sellar(datos, llaves, 'web', 'POST', reloj);
  assert.ok(!sobre.cuerpo.includes('online'));
  const r = await peticion('/api/v1/estado', { method: 'POST', cuerpo: sobre.cuerpo, headers: sobre.cabeceras });
  assert.equal(r.codigo, 200);
  const acuse = abrir(r.cuerpo, r.headers, llaves, 'web', 'RESPUESTA', reloj).datos as Record<string, unknown>;
  assert.equal(acuse.solicitud, sobre.nonce);
  assert.equal(acuse.secuencia, datos.secuencia);
  const estado = JSON.parse((await peticion('/api/v1/estado/web', { rol: 'ia', privado: true })).cuerpo);
  assert.equal(estado.estado, 'online');
  assert.equal(estado.latencia_ms, 8);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('firma alterada, canal incorrecto y respuesta como petición se rechazan', async () => {
  const s = sellar(lectura(), llaves, 'web', 'POST', reloj);
  const alterado = await peticion('/api/v1/estado', { method: 'POST', cuerpo: s.cuerpo + ' ', headers: { ...s.cabeceras, 'content-length': String(Buffer.byteLength(s.cuerpo + ' ')) } });
  assert.equal(alterado.codigo, 401);
  assert.equal((await peticion('/api/v1/estado', { method: 'POST', cuerpo: s.cuerpo, headers: { ...s.cabeceras, 'x-status-canal': 'juego' } })).codigo, 401);
  const reflejo = sellar(lectura(), llaves, 'web', 'RESPUESTA', reloj);
  assert.equal((await peticion('/api/v1/estado', { method: 'POST', cuerpo: reflejo.cuerpo, headers: reflejo.cabeceras })).codigo, 401);
});

test('repetición concurrente: una sola escritura aceptada', async () => {
  const s = sellar(lectura(), llaves, 'web', 'POST', reloj);
  const resultados = await Promise.all([1, 2].map(() => peticion('/api/v1/estado', { method: 'POST', cuerpo: s.cuerpo, headers: s.cabeceras })));
  assert.deepEqual(resultados.map(r => r.codigo).sort(), [200, 409]);
});

test('persistencia conserva protección de replay tras reinicio', async () => {
  const e = new Estado(join(carpeta, 'reinicio/estado.json'), 90, () => reloj);
  const mensaje = { datos: lectura(), nonce: 'd'.repeat(24), tiempo: Math.floor(reloj / 1000) };
  await e.guardar('web', mensaje);
  const cargado = new Estado(e.archivo, 90, () => reloj);
  await cargado.cargar();
  assert.equal(cargado.resumen('web').estado, 'online');
  await assert.rejects(cargado.guardar('web', mensaje), { codigo: 409 });
});

test('offline y vencimiento no inventan disponibilidad', async () => {
  const s = sellar(lectura({ online: false, latencia_ms: null }), llaves, 'web', 'POST', reloj);
  assert.equal((await peticion('/api/v1/estado', { method: 'POST', cuerpo: s.cuerpo, headers: s.cabeceras })).codigo, 200);
  assert.equal(api.estado.resumen('web').estado, 'offline');
  reloj += 91000;
  const r = api.estado.resumen('web');
  assert.equal(r.estado, 'sin_senal');
  assert.equal(r.online, null);
  assert.equal(r.latencia_ms, null);
  reloj = Date.now();
});

test('mensaje vencido y esquema inválido se rechazan', async () => {
  const viejo = sellar(lectura(), llaves, 'web', 'POST', reloj - 100000);
  assert.equal((await peticion('/api/v1/estado', { method: 'POST', cuerpo: viejo.cuerpo, headers: viejo.cabeceras })).codigo, 401);
  const invalido = sellar(lectura({ online: 'sí' }), llaves, 'web', 'POST', reloj);
  assert.equal((await peticion('/api/v1/estado', { method: 'POST', cuerpo: invalido.cuerpo, headers: invalido.cabeceras })).codigo, 422);
});

test('métodos, formatos, tamaño y rutas', async () => {
  assert.equal((await peticion('/api/v1/estado')).codigo, 405);
  assert.equal((await peticion('/otra')).codigo, 404);
  assert.equal((await peticion('/api/v1/estado', { method: 'POST', cuerpo: '{}', headers: { 'content-type': 'text/plain' } })).codigo, 415);
  assert.equal((await peticion('/api/v1/estado', { method: 'POST', cuerpo: 'a'.repeat(5000), headers: { 'content-type': 'application/json' } })).codigo, 413);
});

test('estado corrupto detiene el arranque', async () => {
  const archivo = join(carpeta, 'corrupto.json');
  await writeFile(archivo, 'no es json');
  await assert.rejects(new Estado(archivo).cargar());
});

test('Go publica por HTTPS y verifica la confirmación de TypeScript', async () => {
  reloj = Date.now() + 1000;
  const binario = join(carpeta, process.platform === 'win32' ? 'agente.exe' : 'agente');
  execFileSync('go', ['build', '-o', binario, '.'], { cwd: resolve('agente'), stdio: 'pipe' });
  const objetivo = http.createServer((_, res) => { res.writeHead(302, { location: '/login' }); res.end(); });
  await new Promise<void>(r => objetivo.listen(0, '127.0.0.1', r));
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const r = await promisify(execFile)(binario, ['-api', `https://127.0.0.1:${puerto}`, '-ca', join(secretos, 'ca.crt'), '-nombre-tls', 'status-api', '-clave', join(secretos, 'web.key'), '-objetivo', `http://127.0.0.1:${(objetivo.address() as AddressInfo).port}`]);
    assert.match(r.stdout, /confirmada, online=true/);
    assert.equal(api.estado.resumen('web').estado, 'online');
  } finally { await new Promise<void>(r => objetivo.close(() => r())); }
});
