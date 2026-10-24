import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsearMeta } from './api';
import {
  MOTIVO_DE_EMERGENCIA,
  TIPO_DE_FOTO,
  esEmergencia,
  esFoto,
  esFotoEnVivo,
  reemplazarAbiertas,
  sinFotos,
} from './emergencias';
import { ETIQUETAS_DE_EVENTO, STATE_LABELS } from './format';
import {
  ESTADOS_ACTIVOS,
  ESTADO_DEL_RELEVO,
  MOTIVO_DEL_DESVIO,
  MOTIVO_DEL_DRON_DE_RELEVO,
  MOTIVO_DEL_RELEVO,
  MOTIVO_DE_FIN,
  duenioDeLaAlerta,
  esRelevo,
  reemplazarActivos,
} from './relevos';
import type { Alert, EmergenciaConFotos, EventRow } from './types';

/**
 * La consola contra el archivo de ejemplos que comparten las tres puntas
 * (docs/contrato/relevos.json, PROTOCOLS §1.b): si el contrato suma un estado,
 * un motivo o un evento, la consola tiene que saber decirlo en castellano, y
 * los mensajes de ejemplo para la consola tienen que pasar por los mismos
 * filtros que pasan los de verdad.
 */

interface Ejemplo {
  caso: string;
  mensaje: Record<string, unknown>;
}

interface Contrato {
  enumerados: Record<string, string[] | Record<string, string[]>>;
  mensajes: { hub_a_la_consola: Record<string, { validos: Ejemplo[] }> };
  rest: Record<string, { respuesta?: unknown; cuerpo?: unknown }>;
  eventos: Record<string, Omit<EventRow, 'id' | 'ts' | 'message' | 'meta'> & { meta: unknown }>;
}

// `dirname` y no `new URL('…', import.meta.url)`: Vite reescribe ese patrón como
// si fuera un asset y la ruta deja de ser un archivo (ver contraste.test.ts).
const contrato = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/contrato/relevos.json'), 'utf8'),
) as Contrato;

function lista(nombre: string): string[] {
  return contrato.enumerados[nombre] as string[];
}

function mensaje(tipo: string): Record<string, unknown> {
  return contrato.mensajes.hub_a_la_consola[tipo].validos[0].mensaje;
}

describe('cada enumeración del contrato tiene su rótulo en la consola', () => {
  it.each([
    ['estadosDelRelevo', ESTADO_DEL_RELEVO],
    ['motivoRelayRequest', MOTIVO_DEL_RELEVO],
    ['motivoRelayReject', MOTIVO_DEL_DRON_DE_RELEVO],
    ['motivoRelayAbort', MOTIVO_DEL_DRON_DE_RELEVO],
    ['motivoRthDiverted', MOTIVO_DEL_DESVIO],
    ['motivoEmergencia', MOTIVO_DE_EMERGENCIA],
    ['tipoDeFoto', TIPO_DE_FOTO],
    ['eventosDelHub', ETIQUETAS_DE_EVENTO],
    ['estadosNuevosDelPatrullaje', STATE_LABELS],
  ])('%s', (nombre, rotulos) => {
    const valores = lista(nombre);
    expect(valores.length).toBeGreaterThan(0);
    for (const valor of valores) expect(rotulos[valor], `${nombre}: ${valor}`).toBeTruthy();
  });

  it('cada motivo de fin, de cualquier estado terminal', () => {
    const porEstado = contrato.enumerados.motivoFin as Record<string, string[]>;
    for (const motivos of Object.values(porEstado)) {
      for (const motivo of motivos) expect(MOTIVO_DE_FIN[motivo], motivo).toBeTruthy();
    }
  });

  it('los estados activos son los mismos que usa la consola para las insignias', () => {
    expect([...ESTADOS_ACTIVOS]).toEqual(lista('estadosActivos'));
  });
});

describe('los mensajes de ejemplo para la consola pasan los filtros de la consola', () => {
  it('relay_updated trae un relevo', () => {
    expect(esRelevo(mensaje('relay_updated').relay)).toBe(true);
  });

  it('emergency_updated trae una emergencia y emergency_photo una foto con su emergencia', () => {
    expect(esEmergencia(mensaje('emergency_updated').emergencia)).toBe(true);
    expect(esFotoEnVivo(mensaje('emergency_photo'))).toBe(true);
  });

  it('alert_updated de un traspaso: la alerta pasa a ser de Bravo', () => {
    const alerta = mensaje('alert_updated').alert as Alert;
    expect(alerta.drone_id).not.toBe(alerta.seguidaPor);
    expect(duenioDeLaAlerta(alerta)).toBe(alerta.seguidaPor);
  });

  it('base_updated trae el punto para visitantes', () => {
    expect(mensaje('base_updated').base).toMatchObject({
      aterrizajeLat: expect.any(Number),
      aterrizajeLon: expect.any(Number),
    });
  });
});

describe('las respuestas REST de ejemplo', () => {
  it('GET /api/relevos?activos=1 entra entera a la lista de la consola', () => {
    const respuesta = contrato.rest['GET /api/relevos?activos=1'].respuesta;
    expect(reemplazarActivos([], respuesta)).toHaveLength((respuesta as unknown[]).length);
  });

  it('GET /api/emergencias?abiertas=1 entra entera, y la ficha trae fotos válidas', () => {
    const abiertas = contrato.rest['GET /api/emergencias?abiertas=1'].respuesta;
    expect(reemplazarAbiertas([], abiertas)).toHaveLength((abiertas as unknown[]).length);
    const ficha = contrato.rest['GET /api/emergencias/:id'].respuesta as EmergenciaConFotos;
    expect(ficha.fotos.every(esFoto)).toBe(true);
    expect(sinFotos(ficha).fotos).toBe(ficha.fotos.length);
  });
});

describe('las filas de ejemplo del registro', () => {
  it('el meta de las emergencias y de los relevos se lee entero', () => {
    const landing = parsearMeta(JSON.stringify(contrato.eventos.EMERGENCY_LANDING.meta));
    expect(landing.emergencia?.id).toBe(3);
    expect(landing.ubicacion).toBeDefined();
    const relevo = parsearMeta(JSON.stringify(contrato.eventos.RELAY_STARTED.meta));
    expect(relevo.detalle).toMatchObject({ relevoId: 7, estado: 'EN_CAMINO', relevoHash: expect.any(String) });
    expect(relevo.alerta?.id).toBe(12);
  });
});
