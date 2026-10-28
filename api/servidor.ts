import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { Estado, fallo } from './estado.ts';
import { abrir, derivar, identificador, ruta, sellar } from './protocolo.ts';

export function responder(res: ServerResponse, codigo: number, datos: unknown) {
  if (res.destroyed || res.writableEnded) return;
  const cuerpo = typeof datos === 'string' ? datos : JSON.stringify(datos);
  res.writeHead(codigo, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(cuerpo),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
  });
  res.end(cuerpo);
}

async function leerCuerpo(req: IncomingMessage) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) throw fallo(415, 'Formato no permitido');
  if (Number(req.headers['content-length'] || 0) > 4096) throw fallo(413, 'Mensaje demasiado grande');
  let cantidad = 0;
  const partes: Buffer[] = [];
  for await (const parte of req) {
    cantidad += parte.length;
    if (cantidad > 4096) throw fallo(413, 'Mensaje demasiado grande');
    partes.push(parte);
  }
  return Buffer.concat(partes).toString('utf8');
}

export async function crearAPI(opciones: { secretos: string; archivo: string; vencimiento?: number; reloj?: () => number }) {
  const reloj = opciones.reloj || Date.now;
  const claves = JSON.parse(readFileSync(join(opciones.secretos, 'canales.json'), 'utf8'));
  if (!claves || Array.isArray(claves) || Object.keys(claves).length < 1 || Object.keys(claves).length > 32) throw new Error('Canales inválidos');
  const canales = new Map(Object.entries(claves).map(([canal, clave]) => [canal, derivar(String(clave), canal)]));
  const estado = new Estado(opciones.archivo, opciones.vencimiento || 90, reloj);
  await estado.cargar();
  const tls = { key: readFileSync(join(opciones.secretos, 'servidor.key')), cert: readFileSync(join(opciones.secretos, 'servidor.crt')), minVersion: 'TLSv1.3' as const, handshakeTimeout: 5000, maxHeaderSize: 4096 };
  let fichas = 40;
  let momento = reloj();
  function permitido() {
    const ahora = reloj();
    fichas = Math.min(40, fichas + Math.max(0, ahora - momento) / 1000 * 10);
    momento = ahora;
    if (fichas < 1) return false;
    fichas--;
    return true;
  }
  const ingesta = https.createServer(tls, async (req, res) => {
    let mensaje;
    let llaves;
    let canal = '';
    try {
      if (!permitido()) throw fallo(429, 'Límite temporal');
      if (req.url !== ruta) throw fallo(404, 'Ruta no disponible');
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); throw fallo(405, 'Método no permitido'); }
      const cuerpo = await leerCuerpo(req);
      canal = typeof req.headers['x-status-canal'] === 'string' ? req.headers['x-status-canal'] : '';
      llaves = canales.get(canal);
      if (!llaves) throw fallo(401, 'Mensaje no autorizado');
      try { mensaje = abrir(cuerpo, req.headers, llaves, canal, 'POST', reloj()); }
      catch { throw fallo(401, 'Mensaje no autorizado'); }
      const acuse = await estado.guardar(canal, mensaje);
      const salida = sellar(acuse, llaves, canal, 'RESPUESTA', reloj());
      for (const [nombre, valor] of Object.entries(salida.cabeceras)) res.setHeader(nombre, valor);
      responder(res, 200, salida.cuerpo);
    } catch (error) {
      const codigo = (error as { codigo?: number }).codigo || 503;
      if (codigo === 429) res.setHeader('retry-after', '2');
      const datos = { aceptado: false, error: codigo === 503 ? 'No se pudo guardar la lectura' : (error as Error).message, solicitud: mensaje?.nonce || null };
      if (mensaje && llaves) {
        const salida = sellar(datos, llaves, canal, 'RESPUESTA', reloj());
        for (const [nombre, valor] of Object.entries(salida.cabeceras)) res.setHeader(nombre, valor);
        responder(res, codigo, salida.cuerpo);
      } else responder(res, codigo, { error: datos.error });
      req.resume();
    }
  });
  const lectura = https.createServer({ ...tls, ca: readFileSync(join(opciones.secretos, 'clientes-ca.crt')), requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const socket = req.socket as TLSSocket;
    const identidad = socket.getPeerCertificate().subject?.CN;
    if (!socket.authorized || !['monitor', 'ia', 'salud'].includes(String(identidad))) return responder(res, 403, { error: 'Acceso denegado' });
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); return responder(res, 405, { error: 'Método no permitido' }); }
    if (req.url === '/api/salud') return responder(res, 200, { estado: 'ok', servicio: 'service-status-api', version: '1.0.0' });
    if (identidad === 'salud') return responder(res, 403, { error: 'Acceso denegado' });
    if (req.url === ruta) return responder(res, 200, { canales: [...canales.keys()].map(c => estado.resumen(c)) });
    const match = /^\/api\/v1\/(estado|historial)\/([a-z0-9-]+)$/.exec(req.url || '');
    if (!match || !identificador.test(match[2]) || !canales.has(match[2])) return responder(res, 404, { error: 'Canal no disponible' });
    responder(res, 200, match[1] === 'estado' ? estado.resumen(match[2]) : { canal: match[2], lecturas: estado.historial(match[2]) });
  });
  for (const servidor of [ingesta, lectura]) {
    servidor.requestTimeout = 8000;
    servidor.headersTimeout = 5000;
    servidor.keepAliveTimeout = 3000;
    servidor.maxConnections = 64;
    servidor.maxRequestsPerSocket = 30;
    servidor.on('clientError', (_, socket) => socket.destroy());
  }
  return { ingesta, lectura, estado };
}

async function main() {
  const api = await crearAPI({ secretos: process.env.STATUS_SECRETOS || 'local/secretos', archivo: process.env.STATUS_ARCHIVO || 'local/datos/estado.json', vencimiento: 90 });
  api.ingesta.listen(3444, process.env.STATUS_HOST || '127.0.0.1');
  api.lectura.listen(3443, process.env.STATUS_HOST || '127.0.0.1');
  const detener = () => {
    api.ingesta.close();
    api.lectura.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  for (const servidor of [api.ingesta, api.lectura]) servidor.on('error', () => { console.error('No se pudo iniciar la API'); process.exit(1); });
  process.on('SIGINT', detener);
  process.on('SIGTERM', detener);
  console.log('API preparada: ingesta HTTPS 3444, lectura mTLS 3443');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Configuración o estado inválido'); process.exitCode = 1; });
