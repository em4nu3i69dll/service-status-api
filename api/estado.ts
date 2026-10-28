import { readFile, writeFile, open, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { identificador } from './protocolo.ts';

export type Lectura = { instancia: string; secuencia: number; online: boolean; latencia_ms: number | null; usuarios: number | null; capacidad: number | null };
type Registro = { datos: Lectura; recibida: number; enviada: number };
type Archivo = { version: number; canales: Record<string, Registro[]>; nonces: { id: string; hasta: number }[]; secuencias: Record<string, { valor: number; hasta: number }> };

export function fallo(codigo: number, mensaje: string): Error & { codigo: number } {
  return Object.assign(new Error(mensaje), { codigo });
}

export function validar(datos: unknown): Lectura {
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw fallo(422, 'Lectura inválida');
  const d = datos as Record<string, unknown>;
  if (Object.keys(d).sort().join(',') !== 'capacidad,instancia,latencia_ms,online,secuencia,usuarios'
    || typeof d.instancia !== 'string' || !identificador.test(d.instancia)
    || !Number.isSafeInteger(d.secuencia) || Number(d.secuencia) < 1 || typeof d.online !== 'boolean') throw fallo(422, 'Lectura inválida');
  for (const nombre of ['usuarios', 'capacidad', 'latencia_ms']) {
    const valor = d[nombre];
    if (valor !== null && (!Number.isSafeInteger(valor) || Number(valor) < 0 || Number(valor) > 1000000)) throw fallo(422, 'Métrica inválida');
  }
  if ((d.usuarios === null) !== (d.capacidad === null) || (d.usuarios !== null && Number(d.usuarios) > Number(d.capacidad))) throw fallo(422, 'Capacidad inválida');
  return d as Lectura;
}

export class Estado {
  archivo: string;
  reloj: () => number;
  vencimiento: number;
  valor: Archivo = { version: 1, canales: {}, nonces: [], secuencias: {} };
  cola: Promise<unknown> = Promise.resolve();

  constructor(archivo: string, vencimiento = 90, reloj = Date.now) {
    this.archivo = archivo;
    this.vencimiento = vencimiento;
    this.reloj = reloj;
  }

  async cargar() {
    try {
      const contenido = await readFile(this.archivo, 'utf8');
      if (Buffer.byteLength(contenido) > 4000000) throw new Error('Estado demasiado grande');
      const valor = JSON.parse(contenido);
      if (valor.version !== 1 || !valor.canales || typeof valor.canales !== 'object' || Array.isArray(valor.canales) || !Array.isArray(valor.nonces) || !valor.secuencias || typeof valor.secuencias !== 'object' || Array.isArray(valor.secuencias)) throw new Error('Estado inválido');
      for (const [canal, lecturas] of Object.entries(valor.canales)) {
        if (!identificador.test(canal) || !Array.isArray(lecturas) || lecturas.length > 60) throw new Error('Estado inválido');
        for (const lectura of lecturas) {
          validar(lectura.datos);
          if (!Number.isFinite(lectura.recibida) || !Number.isFinite(lectura.enviada)) throw new Error('Fecha inválida');
        }
      }
      if (valor.nonces.length > 4096 || Object.keys(valor.secuencias).length > 1024) throw new Error('Estado inválido');
      if (Object.keys(valor.canales).length > 32 || valor.nonces.some((n: { id: unknown; hasta: unknown }) => !n || typeof n.id !== 'string' || !Number.isFinite(n.hasta))) throw new Error('Estado inválido');
      for (const secuencia of Object.values(valor.secuencias) as { valor: number; hasta: number }[]) {
        if (!secuencia || !Number.isSafeInteger(secuencia.valor) || !Number.isFinite(secuencia.hasta)) throw new Error('Secuencia persistida inválida');
      }
      this.valor = valor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async guardar(canal: string, mensaje: { datos: unknown; nonce: string; tiempo: number }) {
    const tarea = this.cola.then(async () => {
      const datos = validar(mensaje.datos);
      const ahora = this.reloj();
      if (ahora / 1000 - mensaje.tiempo > 90 || ahora / 1000 - mensaje.tiempo < -15) throw fallo(401, 'Mensaje vencido');
      const nonces = this.valor.nonces.filter(n => n.hasta >= ahora);
      const id = canal + ':' + mensaje.nonce;
      if (nonces.some(n => n.id === id)) throw fallo(409, 'Mensaje repetido');
      const secuencias = Object.fromEntries(Object.entries(this.valor.secuencias).filter(([, v]) => v.hasta >= ahora));
      const clave = canal + ':' + datos.instancia;
      if (secuencias[clave] && secuencias[clave].valor >= datos.secuencia) throw fallo(409, 'Secuencia repetida');
      const anteriores = Object.hasOwn(this.valor.canales, canal) ? this.valor.canales[canal] : [];
      if (anteriores.length && anteriores.at(-1)!.enviada > mensaje.tiempo) throw fallo(409, 'Lectura fuera de orden');
      if (nonces.length >= 4096 || (!secuencias[clave] && Object.keys(secuencias).length >= 1024)) throw fallo(429, 'Límite temporal');
      const siguiente: Archivo = {
        version: 1,
        canales: { ...this.valor.canales, [canal]: [...anteriores, { datos, recibida: ahora, enviada: mensaje.tiempo }].slice(-60) },
        nonces: [...nonces, { id, hasta: (mensaje.tiempo + 91) * 1000 }],
        secuencias: { ...secuencias, [clave]: { valor: datos.secuencia, hasta: ahora + 86400000 } }
      };
      await mkdir(dirname(this.archivo), { recursive: true });
      const temporal = this.archivo + '.tmp';
      await writeFile(temporal, JSON.stringify(siguiente), { mode: 0o600 });
      const descriptor = await open(temporal, 'r+');
      try { await descriptor.sync(); } finally { await descriptor.close(); }
      await rename(temporal, this.archivo);
      if (process.platform !== 'win32') {
        const carpeta = await open(dirname(this.archivo), 'r');
        try { await carpeta.sync(); } finally { await carpeta.close(); }
      }
      this.valor = siguiente;
      return { aceptado: true, solicitud: mensaje.nonce, secuencia: datos.secuencia };
    });
    this.cola = tarea.catch(() => {});
    return tarea;
  }

  resumen(canal: string) {
    const lecturas = Object.hasOwn(this.valor.canales, canal) ? this.valor.canales[canal] : [];
    const ultima = lecturas.at(-1);
    const edad = ultima ? Math.floor((this.reloj() - ultima.recibida) / 1000) : null;
    const reciente = edad !== null && edad >= 0 && edad <= this.vencimiento;
    return {
      canal,
      estado: !ultima ? 'sin_datos' : !reciente ? 'sin_senal' : ultima.datos.online ? 'online' : 'offline',
      online: reciente ? ultima!.datos.online : null,
      latencia_ms: reciente ? ultima!.datos.latencia_ms : null,
      usuarios: reciente ? ultima!.datos.usuarios : null,
      capacidad: reciente ? ultima!.datos.capacidad : null,
      ultima_lectura: ultima ? new Date(ultima.recibida).toISOString() : null,
      antiguedad_segundos: edad,
      muestras: lecturas.length
    };
  }

  historial(canal: string) {
    return (Object.hasOwn(this.valor.canales, canal) ? this.valor.canales[canal] : []).map(r => ({ recibida: new Date(r.recibida).toISOString(), online: r.datos.online, latencia_ms: r.datos.latencia_ms }));
  }
}
