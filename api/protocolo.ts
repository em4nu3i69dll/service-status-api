import { hkdfSync, randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const ruta = '/api/v1/estado';
export const identificador = /^[a-z0-9][a-z0-9-]{0,39}$/;
export type Llaves = { cifrado: Buffer; firma: Buffer };

export function derivar(maestra: string, canal: string): Llaves {
  if (!/^[a-f0-9]{64}$/.test(maestra) || !identificador.test(canal)) throw new Error('Clave o canal inválido');
  const base = Buffer.from(maestra, 'hex');
  return {
    cifrado: Buffer.from(hkdfSync('sha256', base, `status-v1:${canal}`, 'cifrado', 32)),
    firma: Buffer.from(hkdfSync('sha256', base, `status-v1:${canal}`, 'firma', 32))
  };
}

function contexto(canal: string, direccion: string, tiempo: string, nonce: string): string {
  return ['status-v1', direccion, ruta, canal, tiempo, nonce].join('\n');
}

export function sellar(datos: unknown, llaves: Llaves, canal: string, direccion = 'POST', ahora = Date.now()) {
  const tiempo = String(Math.floor(ahora / 1000));
  const nonce = randomBytes(12).toString('hex');
  const adicional = contexto(canal, direccion, tiempo, nonce);
  const cifrador = createCipheriv('aes-256-gcm', llaves.cifrado, Buffer.from(nonce, 'hex'));
  cifrador.setAAD(Buffer.from(adicional));
  const plano = Buffer.from(JSON.stringify(datos));
  if (plano.length > 2048) throw new Error('Mensaje demasiado grande');
  const cifrado = Buffer.concat([cifrador.update(plano), cifrador.final()]);
  const cuerpo = JSON.stringify({ datos: cifrado.toString('base64'), etiqueta: cifrador.getAuthTag().toString('base64') });
  return { cuerpo, nonce, cabeceras: {
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(cuerpo)),
    'x-status-canal': canal, 'x-status-tiempo': tiempo, 'x-status-nonce': nonce,
    'x-status-firma': createHmac('sha256', llaves.firma).update(adicional + '\n' + cuerpo).digest('hex')
  } };
}

export function abrir(cuerpo: string, cabeceras: IncomingHttpHeaders, llaves: Llaves, canal: string, direccion = 'POST', ahora = Date.now()) {
  const tiempo = cabeceras['x-status-tiempo'];
  const nonce = cabeceras['x-status-nonce'];
  const firma = cabeceras['x-status-firma'];
  if (cabeceras['x-status-canal'] !== canal || typeof tiempo !== 'string' || !/^\d{10}$/.test(tiempo)
    || typeof nonce !== 'string' || !/^[a-f0-9]{24}$/.test(nonce)
    || typeof firma !== 'string' || !/^[a-f0-9]{64}$/.test(firma) || Buffer.byteLength(cuerpo) > 4096) throw new Error('Mensaje no autorizado');
  const diferencia = ahora / 1000 - Number(tiempo);
  if (diferencia > 90 || diferencia < -15) throw new Error('Mensaje vencido');
  const adicional = contexto(canal, direccion, tiempo, nonce);
  const esperada = createHmac('sha256', llaves.firma).update(adicional + '\n' + cuerpo).digest();
  if (!timingSafeEqual(esperada, Buffer.from(firma, 'hex'))) throw new Error('Firma incorrecta');
  const sobre = JSON.parse(cuerpo);
  if (!sobre || Array.isArray(sobre) || Object.keys(sobre).sort().join(',') !== 'datos,etiqueta') throw new Error('Sobre inválido');
  function base64(valor: unknown): Buffer {
    if (typeof valor !== 'string') throw new Error('Codificación inválida');
    const salida = Buffer.from(valor, 'base64');
    if (salida.toString('base64') !== valor) throw new Error('Codificación inválida');
    return salida;
  }
  const cifrado = base64(sobre.datos);
  const etiqueta = base64(sobre.etiqueta);
  if (etiqueta.length !== 16 || cifrado.length > 2048) throw new Error('Sobre inválido');
  const descifrador = createDecipheriv('aes-256-gcm', llaves.cifrado, Buffer.from(nonce, 'hex'));
  descifrador.setAAD(Buffer.from(adicional));
  descifrador.setAuthTag(etiqueta);
  const datos: unknown = JSON.parse(Buffer.concat([descifrador.update(cifrado), descifrador.final()]).toString('utf8'));
  return { datos, nonce, tiempo: Number(tiempo) };
}
