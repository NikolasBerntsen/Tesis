import { posicionValida, rumbo } from './format';
import type { Emergencia, EmergenciaConFotos, FotoDeEmergencia } from './types';

/**
 * Lo que la consola hace con los aterrizajes de emergencia (RELEVOS §5 y §6):
 * llevar al día la lista de las abiertas, juntar las fotos que van llegando y
 * decir dónde hay que ir a buscar el dron.
 *
 * Una emergencia sólo avanza: se abre, llegan fotos, el dron toca tierra y
 * alguien la marca recuperada. Nada de eso se deshace, y es lo que permite
 * quedarse con "lo más avanzado" cuando dos versiones llegan cruzadas.
 */

export function emergenciaAbierta(e: Pick<Emergencia, 'recuperadaEn'>): boolean {
  return e.recuperadaEn === null;
}

/** Lo mínimo para tomar algo como una emergencia: un id y de qué dron es. */
export function esEmergencia(valor: unknown): valor is Emergencia {
  if (typeof valor !== 'object' || valor === null) return false;
  const e = valor as Partial<Emergencia>;
  return typeof e.id === 'number' && typeof e.droneId === 'string';
}

/**
 * Junta dos versiones de la misma emergencia quedándose con lo más avanzado de
 * cada una. La lista que vuelve por REST al reconectar pudo salir del hub antes
 * que un `emergency_updated` que ya llegó: sin esto, una recuperada volvía a
 * aparecer abierta y el aviso reaparecía en la pantalla de todos.
 */
export function fusionarEmergencia(vieja: Emergencia, nueva: Emergencia): Emergencia {
  const tocoTierra = nueva.aterrizadaEn === null && vieja.aterrizadaEn !== null;
  const recuperada = nueva.recuperadaEn === null && vieja.recuperadaEn !== null;
  return {
    ...nueva,
    ...(tocoTierra && {
      aterrizadaEn: vieja.aterrizadaEn,
      aterrizajeLat: vieja.aterrizajeLat,
      aterrizajeLon: vieja.aterrizajeLon,
      aterrizajeAlt: vieja.aterrizajeAlt,
    }),
    ...(recuperada && { recuperadaEn: vieja.recuperadaEn, recuperadaPor: vieja.recuperadaPor }),
    fotos: Math.max(vieja.fotos, nueva.fotos),
  };
}

/** Un `emergency_updated` (o la respuesta de marcarla recuperada): se fusiona por `id`. */
export function aplicarEmergencia(lista: Emergencia[], emergencia: Emergencia): Emergencia[] {
  const previa = lista.find((e) => e.id === emergencia.id);
  if (!previa) return [emergencia, ...lista];
  return lista.map((e) => (e.id === emergencia.id ? fusionarEmergencia(previa, emergencia) : e));
}

const NINGUNA: ReadonlySet<number> = new Set();

/**
 * La lista de `GET /api/emergencias?abiertas=1`. Una abierta que el hub ya no
 * nombra se recuperó mientras el canal estuvo caído: el aviso se va. Las
 * recuperadas que se conocían se quedan, para la ficha de un evento viejo.
 *
 * Salvo las de `vistasEnVivo`: las que trajo un `emergency_updated` mientras
 * el pedido iba y volvía (ver recarga.ts). La lista pudo salir del hub antes
 * de que se abrieran, y el aviso tiene que quedar hasta que alguien la marque
 * recuperada (RELEVOS §6), no hasta la próxima reconexión.
 */
export function reemplazarAbiertas(
  lista: Emergencia[],
  delHub: unknown,
  vistasEnVivo: ReadonlySet<number> = NINGUNA,
): Emergencia[] {
  if (!Array.isArray(delHub)) return lista;
  const validas = delHub.filter(esEmergencia);
  const nombradas = new Set(validas.map((e) => e.id));
  let resultado = lista.filter((e) => !emergenciaAbierta(e) || nombradas.has(e.id) || vistasEnVivo.has(e.id));
  for (const e of validas) resultado = aplicarEmergencia(resultado, e);
  return resultado;
}

/** La versión sin fotos de la ficha completa: la que va a la lista de la consola. */
export function sinFotos(e: EmergenciaConFotos): Emergencia {
  return { ...e, fotos: e.fotos.length };
}

// ---- Fotos ----

/** Lo mínimo de una foto para mostrarla: su número y la imagen. */
export function esFoto(valor: unknown): valor is FotoDeEmergencia {
  if (typeof valor !== 'object' || valor === null) return false;
  const f = valor as Partial<FotoDeEmergencia>;
  return typeof f.seq === 'number' && typeof f.jpegBase64 === 'string';
}

/** Un `emergency_photo`: la foto, con la emergencia a la que pertenece. */
export type FotoEnVivo = { emergenciaId: number } & FotoDeEmergencia;

export function esFotoEnVivo(valor: unknown): valor is FotoEnVivo {
  return esFoto(valor) && typeof (valor as Partial<FotoEnVivo>).emergenciaId === 'number';
}

/**
 * Suma fotos a las que ya había, sin repetir `seq` y en orden. Una foto
 * repetida es la misma (el hub guarda una por número), así que gana la que ya
 * estaba: no hay nada nuevo que pintar.
 */
export function juntarFotos(
  previas: readonly FotoDeEmergencia[],
  nuevas: readonly FotoDeEmergencia[],
): FotoDeEmergencia[] {
  const porSeq = new Map<number, FotoDeEmergencia>();
  for (const f of [...previas, ...nuevas]) if (!porSeq.has(f.seq)) porSeq.set(f.seq, f);
  return [...porSeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Un `emergency_photo`: la foto se guarda con las de su emergencia. */
export function sumarFotoEnVivo(
  fotos: Record<number, FotoDeEmergencia[]>,
  mensaje: FotoEnVivo,
): Record<number, FotoDeEmergencia[]> {
  const { emergenciaId, seq, tipo, rumbo, inclinacion, lat, lon, alt, ts, jpegBase64 } = mensaje;
  const foto: FotoDeEmergencia = { seq, tipo, rumbo, inclinacion, lat, lon, alt, ts, jpegBase64 };
  const previas = fotos[emergenciaId] ?? [];
  if (previas.some((f) => f.seq === seq)) return fotos;
  return { ...fotos, [emergenciaId]: juntarFotos(previas, [foto]) };
}

// ---- Rótulos ----

export const MOTIVO_DE_EMERGENCIA: Record<string, string> = {
  autonomia: 'No le alcanzaba la batería para volver',
  bateria_critica_dji: 'Batería crítica: el propio DJI forzó el aterrizaje',
};

export function motivoDeEmergencia(motivo: string): string {
  return MOTIVO_DE_EMERGENCIA[motivo] ?? motivo;
}

export const TIPO_DE_FOTO: Record<string, string> = {
  oblicua: 'Oblicua',
  cenital: 'Cenital',
  panoramica: 'Panorámica',
};

export function tipoDeFoto(tipo: string): string {
  return TIPO_DE_FOTO[tipo] ?? tipo;
}

/** "−70°": hacia abajo con el signo tipográfico, como lo escribiría un piloto. */
export function inclinacion(grados: number): string {
  if (!Number.isFinite(grados)) return '—';
  const g = Math.round(grados);
  return g < 0 ? `−${Math.abs(g)}°` : `${g}°`;
}

/** El pie de una foto: qué toma es, hacia dónde mira y cuánto baja la cámara. */
export function pieDeFoto(f: Pick<FotoDeEmergencia, 'tipo' | 'rumbo' | 'inclinacion'>): string {
  return `${tipoDeFoto(f.tipo)} · rumbo ${rumbo(f.rumbo)} · inclinación ${inclinacion(f.inclinacion)}`;
}

/**
 * Dónde ir a buscar el dron: la última posición al tocar tierra si llegó; si
 * no, dónde estaba al disparar el protocolo. `null` si no se sabe ninguna.
 */
export function dondeBuscar(
  e: Pick<Emergencia, 'lat' | 'lon' | 'aterrizajeLat' | 'aterrizajeLon'>,
): { lat: number; lon: number; aterrizo: boolean } | null {
  if (posicionValida(e.aterrizajeLat, e.aterrizajeLon)) {
    return { lat: e.aterrizajeLat as number, lon: e.aterrizajeLon as number, aterrizo: true };
  }
  if (posicionValida(e.lat, e.lon)) return { lat: e.lat as number, lon: e.lon as number, aterrizo: false };
  return null;
}
