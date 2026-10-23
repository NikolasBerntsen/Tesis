import { describe, expect, it } from 'vitest';
import {
  LIMITES, posicionValida, validarAutonomia, validarEmergencyLanded, validarEmergencyLanding, validarEmergencyPhoto,
  validarLandedAtBase, validarLandingAtBase, validarObjetivo, validarRelayAbandon, validarRelayAbort, validarRelayReject,
  validarRelayRequest, validarRelevoInformado, validarRthDiverted, validarSoloRelayId, type Crudo, type Validado,
} from '../../src/contrato';
import { PLAZOS } from '../../src/relevos';
import { CONTRATO, TIPOS_HUB_A_LA_APP, cumpleContrato, ejemplos } from '../contrato';

/** El validador del hub para cada mensaje de la app (§1.b). */
const VALIDADORES: Record<string, (m: Crudo) => Validado<unknown>> = {
  relay_request: validarRelayRequest,
  relay_accept: validarSoloRelayId,
  relay_reject: validarRelayReject,
  relay_ready: validarSoloRelayId,
  relay_abort: validarRelayAbort,
  relay_abandon: validarRelayAbandon,
  relay_released: validarSoloRelayId,
  landing_at_base: validarLandingAtBase,
  landed_at_base: validarLandedAtBase,
  rth_diverted: validarRthDiverted,
  emergency_landing: validarEmergencyLanding,
  emergency_photo: validarEmergencyPhoto,
  emergency_landed: validarEmergencyLanded,
};

/** Campo que falló, o null si pasó. */
function falla(v: Validado<unknown>): string | null {
  return v.ok ? null : v.campo;
}

describe('contrato — los mensajes de la app contra docs/contrato/relevos.json', () => {
  it('cada tipo de §1.b del archivo tiene un validador en el hub, y viceversa', () => {
    const delArchivo = Object.keys(CONTRATO.mensajes.app_al_hub).filter((t) => t !== 'status').sort();
    expect(Object.keys(VALIDADORES).sort()).toEqual(delArchivo);
  });

  for (const tipo of Object.keys(VALIDADORES)) {
    it(`${tipo}: los válidos pasan y los inválidos no`, () => {
      const { validos, invalidos } = ejemplos('app_al_hub', tipo);
      for (const e of validos) expect(falla(VALIDADORES[tipo](e.mensaje)), e.caso).toBeNull();
      for (const e of invalidos) expect(falla(VALIDADORES[tipo](e.mensaje)), `${e.caso}: ${e.porque}`).not.toBeNull();
    });
  }

  it('status: relevo y autonomía de los válidos pasan; en los inválidos, el campo nombrado no pasa', () => {
    const { validos, invalidos } = ejemplos('app_al_hub', 'status');
    for (const e of validos) {
      expect(validarRelevoInformado(e.mensaje.relevo), e.caso).not.toBeNull();
      if (e.mensaje.autonomia !== undefined) expect(validarAutonomia(e.mensaje.autonomia), e.caso).not.toBeNull();
    }
    for (const e of invalidos) {
      const relevoMalo = e.mensaje.relevo !== undefined && validarRelevoInformado(e.mensaje.relevo) === null;
      const autonomiaMala = e.mensaje.autonomia !== undefined && validarAutonomia(e.mensaje.autonomia) === null;
      expect(relevoMalo || autonomiaMala, e.caso).toBe(true);
    }
  });

  it('los límites y plazos del hub son los del archivo', () => {
    for (const [clave, valor] of Object.entries(LIMITES)) {
      if (clave in CONTRATO.limites) expect(CONTRATO.limites[clave], clave).toBe(valor);
    }
    expect(CONTRATO.limites.pctParaVolverMaximo).toBe(LIMITES.pctMaximo);
    expect(CONTRATO.limites.alcanceMaximoM).toBe(LIMITES.alcanceMaximoM);
    for (const clave of ['respuestaDeBMs', 'relevoDespegueMs', 'traspasoSinConfirmarMs', 'relevoDesconectadoMs',
      'relayStatusEnCaminoMs', 'relayTargetSinEnlaceMs', 'aSinStatusParaSinEnlaceMs', 'bloqueoBaseDestinoMs'] as const) {
      expect(PLAZOS[clave], clave).toBe(CONTRATO.plazos[clave]);
    }
  });
});

// Los validadores de las pruebas para lo que el HUB manda: se los pasa por los
// ejemplos del archivo antes de usarlos sobre los mensajes reales del hub.
describe('contrato — la vara de las pruebas para los mensajes del hub (§2.b)', () => {
  it('cubre todos los tipos de §2.b del archivo', () => {
    expect(TIPOS_HUB_A_LA_APP.sort()).toEqual(Object.keys(CONTRATO.mensajes.hub_a_la_app).sort());
  });

  for (const tipo of Object.keys(CONTRATO.mensajes.hub_a_la_app)) {
    it(`${tipo}: acepta los válidos y rechaza los inválidos`, () => {
      const { validos, invalidos } = ejemplos('hub_a_la_app', tipo);
      for (const e of validos) expect(cumpleContrato(e.mensaje), e.caso).toBe(true);
      for (const e of invalidos) {
        // relay_cancel con un motivo desconocido es inválido aunque la app lo aplique igual
        expect(cumpleContrato(e.mensaje), `${e.caso}: ${e.porque}`).toBe(false);
      }
    });
  }
});

describe('contrato — reglas que los ejemplos no cubren', () => {
  const pedidoPatrulla = { type: 'relay_request', ref: 'r', motivo: 'patrulla', routeId: 1, fromIndex: 0 };
  const pedidoSeguimiento = { type: 'relay_request', ref: 'r', motivo: 'seguimiento', alertId: 3, segundosDisponibles: 10 };

  it('relay_request: ref, ids y segundos, sin convertir nada', () => {
    expect(falla(validarRelayRequest(pedidoPatrulla))).toBeNull();
    expect(falla(validarRelayRequest({ ...pedidoPatrulla, ref: '' }))).toBe('ref');
    expect(falla(validarRelayRequest({ ...pedidoPatrulla, ref: 7 }))).toBe('ref');
    expect(falla(validarRelayRequest({ ...pedidoPatrulla, ref: 'x'.repeat(64) }))).toBeNull();
    expect(falla(validarRelayRequest({ ...pedidoPatrulla, routeId: 0 }))).toBe('routeId');
    expect(falla(validarRelayRequest({ ...pedidoPatrulla, fromIndex: 1.5 }))).toBe('fromIndex');
    expect(falla(validarRelayRequest({ ...pedidoPatrulla, fromIndex: null }))).toBe('fromIndex');
    // los campos del otro motivo se ignoran
    expect(validarRelayRequest({ ...pedidoPatrulla, alertId: 'basura' })).toEqual({
      ok: true,
      valor: { ref: 'r', motivo: 'patrulla', routeId: 1, fromIndex: 0 },
    });
    expect(falla(validarRelayRequest({ ...pedidoSeguimiento, alertId: null }))).toBe('alertId');
    expect(falla(validarRelayRequest({ ...pedidoSeguimiento, segundosDisponibles: 3600.5 }))).toBe('segundosDisponibles');
    expect(falla(validarRelayRequest({ ...pedidoSeguimiento, segundosDisponibles: -1 }))).toBe('segundosDisponibles');
    expect(validarRelayRequest({ ...pedidoSeguimiento, segundosDisponibles: 0, routeId: 'x' })).toEqual({
      ok: true,
      valor: { ref: 'r', motivo: 'seguimiento', alertId: 3, segundosDisponibles: 0 },
    });
  });

  it('relay_reject y relay_abort: detalle opcional de hasta 200 caracteres', () => {
    expect(validarRelayReject({ relayId: 1, motivo: 'ocupado' })).toEqual({
      ok: true,
      valor: { relayId: 1, motivo: 'ocupado', detalle: null },
    });
    expect(falla(validarRelayReject({ relayId: 1, motivo: 'ocupado', detalle: 'x'.repeat(200) }))).toBeNull();
    expect(falla(validarRelayReject({ relayId: 1, motivo: 'ocupado', detalle: 'x'.repeat(201) }))).toBe('detalle');
    expect(falla(validarRelayReject({ relayId: 1, motivo: 'ocupado', detalle: null }))).toBe('detalle');
    expect(falla(validarRelayReject({ relayId: '1', motivo: 'ocupado' }))).toBe('relayId');
    expect(falla(validarRelayAbort({ relayId: 1, motivo: 'otro', detalle: 5 }))).toBe('detalle');
    expect(falla(validarRelayAbort({ relayId: 1.2, motivo: 'otro' }))).toBe('relayId');
    expect(validarRelayAbort({ relayId: 2, motivo: 'bateria', detalle: 'al 20 %' })).toEqual({
      ok: true,
      valor: { relayId: 2, motivo: 'bateria', detalle: 'al 20 %' },
    });
  });

  it('relay_abandon: el motivo es opcional pero, si viene, es uno de la lista', () => {
    expect(validarRelayAbandon({ relayId: 4, motivo: 'senial' })).toEqual({ ok: true, valor: { relayId: 4, motivo: 'senial' } });
    expect(falla(validarRelayAbandon({ relayId: 4, motivo: null }))).toBe('motivo');
    expect(falla(validarRelayAbandon({ relayId: 4, motivo: 'cansado' }))).toBe('motivo');
  });

  it('landing_at_base y landed_at_base: los nullables tienen que estar', () => {
    const base = { ref: 'r', relayId: null, baseId: null, lat: null, lon: null, routeId: 1, fromIndex: 0 };
    expect(falla(validarLandingAtBase(base))).toBeNull();
    expect(falla(validarLandingAtBase({ ...base, relayId: undefined }))).toBe('relayId');
    expect(falla(validarLandingAtBase({ ...base, baseId: 0 }))).toBe('baseId');
    expect(falla(validarLandingAtBase({ ...base, ref: undefined }))).toBe('ref');
    expect(falla(validarLandingAtBase({ ...base, fromIndex: -2 }))).toBe('fromIndex');
    expect(falla(validarLandedAtBase({ relayId: null, baseId: null, lat: null }))).toBe('lat/lon');
    expect(falla(validarLandedAtBase({ relayId: 'a', baseId: null, lat: null, lon: null }))).toBe('relayId');
    expect(falla(validarLandedAtBase({ relayId: null, baseId: 1.5, lat: null, lon: null }))).toBe('baseId');
  });

  it('rth_diverted: el motivo manda sobre la base y la posición puede faltar entera', () => {
    expect(falla(validarRthDiverted({ relayId: null, baseId: 2, lat: null, lon: null, motivo: 'otra_base' }))).toBeNull();
    expect(falla(validarRthDiverted({ relayId: null, baseId: 2, lat: null, lon: null, motivo: 'rescate' }))).toBe('motivo');
    expect(falla(validarRthDiverted({ relayId: 0, baseId: 2, lat: null, lon: null, motivo: 'otra_base' }))).toBe('relayId');
    expect(falla(validarRthDiverted({ relayId: null, baseId: 2, lat: 95, lon: 0, motivo: 'otra_base' }))).toBe('lat/lon');
  });

  const aviso = { ref: 'e', motivo: 'autonomia', lat: -34.8, lon: -56.1, alt: 40, bateria: 9, ts: 1 };
  const foto = {
    ref: 'e', seq: 7, tipo: 'cenital', rumbo: 360, inclinacion: 30, lat: null, lon: null, alt: -200, jpegBase64: '/9j/AA==', ts: 5,
  };

  it('emergencias: altura, batería, ts y la foto en base64 de un JPEG', () => {
    expect(falla(validarEmergencyLanding(aviso))).toBeNull();
    expect(falla(validarEmergencyLanding({ ...aviso, ref: undefined }))).toBe('ref');
    expect(falla(validarEmergencyLanding({ ...aviso, lat: null }))).toBe('lat/lon');
    expect(falla(validarEmergencyLanding({ ...aviso, alt: 1000.5 }))).toBe('alt');
    expect(falla(validarEmergencyLanding({ ...aviso, bateria: '9' }))).toBe('bateria');
    expect(falla(validarEmergencyLanding({ ...aviso, ts: 1.5 }))).toBe('ts');

    expect(falla(validarEmergencyPhoto(foto))).toBeNull();
    expect(falla(validarEmergencyPhoto({ ...foto, ref: '' }))).toBe('ref');
    expect(falla(validarEmergencyPhoto({ ...foto, seq: -1 }))).toBe('seq');
    expect(falla(validarEmergencyPhoto({ ...foto, seq: '1' }))).toBe('seq');
    expect(falla(validarEmergencyPhoto({ ...foto, tipo: 'selfie' }))).toBe('tipo');
    expect(falla(validarEmergencyPhoto({ ...foto, rumbo: 361 }))).toBe('rumbo');
    expect(falla(validarEmergencyPhoto({ ...foto, lat: 0, lon: 0 }))).toBe('lat/lon');
    expect(falla(validarEmergencyPhoto({ ...foto, alt: null }))).toBe('alt');
    expect(falla(validarEmergencyPhoto({ ...foto, ts: 0 }))).toBe('ts');
    // base64 de verdad: sin espacios ni caracteres de afuera del alfabeto
    expect(falla(validarEmergencyPhoto({ ...foto, jpegBase64: '/9j/ AA==' }))).toBe('jpegBase64');
    expect(falla(validarEmergencyPhoto({ ...foto, jpegBase64: '' }))).toBe('jpegBase64');
    expect(falla(validarEmergencyPhoto({ ...foto, jpegBase64: 42 }))).toBe('jpegBase64');
    // 400 000 justos sí; uno más, no
    const justa = `/9j/${'A'.repeat(LIMITES.jpegBase64MaxCaracteres - 4)}`;
    expect(falla(validarEmergencyPhoto({ ...foto, jpegBase64: justa }))).toBeNull();
    expect(falla(validarEmergencyPhoto({ ...foto, jpegBase64: `${justa}A` }))).toBe('jpegBase64');

    expect(falla(validarEmergencyLanded({ ref: 'e', lat: null, lon: null, alt: 0, ts: 9 }))).toBeNull();
    expect(falla(validarEmergencyLanded({ ref: 'e', lat: null, lon: null, alt: '0', ts: 9 }))).toBe('alt');
    expect(falla(validarEmergencyLanded({ ref: 7, lat: null, lon: null, alt: 0, ts: 9 }))).toBe('ref');
    expect(falla(validarEmergencyLanded({ ref: 'e', lat: 1, lon: null, alt: 0, ts: 9 }))).toBe('lat/lon');
  });

  it('status.relevo: cada combinación que el contrato prohíbe', () => {
    const libre = { enEspera: true, disponible: true, relayId: null, rol: null, fase: null };
    expect(validarRelevoInformado(libre)).toEqual(libre);
    expect(validarRelevoInformado(null)).toBeNull();
    expect(validarRelevoInformado([libre])).toBeNull();
    expect(validarRelevoInformado({ ...libre, enEspera: 'si' })).toBeNull();
    expect(validarRelevoInformado({ ...libre, fase: 'pedido' })).toBeNull();
    expect(validarRelevoInformado({ ...libre, relayId: 0, rol: 'origen', fase: 'pedido' })).toBeNull();
    expect(validarRelevoInformado({ ...libre, relayId: 3, rol: 'origen', fase: 'pedido' })).toMatchObject({ rol: 'origen' });
    expect(validarRelevoInformado({ ...libre, relayId: 3, rol: 'origen', fase: 'traspaso' })).toBeNull();
    expect(validarRelevoInformado({ ...libre, relayId: 3, rol: 'relevo', fase: 'traspaso' })).toMatchObject({ rol: 'relevo' });
    expect(validarRelevoInformado({ ...libre, relayId: 3, rol: null, fase: null })).toBeNull();
    expect(validarRelevoInformado({ ...libre, relayId: 3, rol: 'testigo', fase: 'pedido' })).toBeNull();
  });

  it('status.autonomia: un campo ausente o fuera de rango invalida el objeto entero', () => {
    const toda = { pctParaVolver: 14, pctParaAterrizar: 3, alcanceM: 2400, segundosParaVolver: 95 };
    expect(validarAutonomia(toda)).toEqual(toda);
    expect(validarAutonomia('x')).toBeNull();
    expect(validarAutonomia({ ...toda, segundosParaVolver: undefined })).toBeNull();
    expect(validarAutonomia({ ...toda, alcanceM: 100_001 })).toBeNull();
    expect(validarAutonomia({ ...toda, pctParaAterrizar: -1 })).toBeNull();
    expect(validarAutonomia({ ...toda, segundosParaVolver: 36_001 })).toBeNull();
  });

  describe('objetivo de un relevo', () => {
    const alerta = { id: 12, type: 'VEHICLE' as const };
    const target = {
      alertId: 12, type: 'VEHICLE', lat: -34.85, lon: -56.2, speedMs: 4, courseDeg: 90, moving: true, lost: false,
      lastSeenMs: 600, decision: 'PENDING', extra: 'no viaja',
    };

    it('sin vNorte/vEste (app vieja), el hub los saca de la velocidad y el rumbo', () => {
      const o = validarObjetivo(target, alerta, 'VALIDATED');
      expect(o).not.toBeNull();
      expect(o!.vNorteMs).toBeCloseTo(0, 9);
      expect(o!.vEsteMs).toBeCloseTo(4, 9);
      // la decisión es la de la base, y lo que no es del contrato no viaja
      expect(o!.decision).toBe('VALIDATED');
      expect(o).not.toHaveProperty('extra');
      // quieto: cero y cero aunque tenga velocidad residual
      expect(validarObjetivo({ ...target, moving: false }, alerta, 'PENDING')).toMatchObject({ vNorteMs: 0, vEsteMs: 0 });
    });

    it('con vNorte/vEste los respeta si tienen sentido', () => {
      expect(validarObjetivo({ ...target, vNorteMs: -1, vEsteMs: 3 }, alerta, 'PENDING')).toMatchObject({ vNorteMs: -1, vEsteMs: 3 });
      expect(validarObjetivo({ ...target, vNorteMs: 1 }, alerta, 'PENDING')).toBeNull();
      expect(validarObjetivo({ ...target, vNorteMs: 30, vEsteMs: 30 }, alerta, 'PENDING')).toBeNull();
    });

    it('rechaza el de otra alerta, otra clase, sin posición o con valores imposibles', () => {
      for (const malo of [
        null, [], { ...target, alertId: 11 }, { ...target, type: 'PERSON' }, { ...target, lat: 0, lon: 0 },
        { ...target, speedMs: 41 }, { ...target, courseDeg: -1 }, { ...target, moving: 'si' },
        { ...target, lost: undefined }, { ...target, lastSeenMs: -1 }, { ...target, lastSeenMs: 1.5 },
      ]) {
        expect(validarObjetivo(malo, alerta, 'PENDING'), JSON.stringify(malo)).toBeNull();
      }
    });
  });

  it('posicionValida: el 0,0 y lo que está fuera de rango no son posiciones', () => {
    expect(posicionValida(-34.85, -56.2)).toEqual({ lat: -34.85, lon: -56.2 });
    expect(posicionValida(0, 0)).toBeNull();
    expect(posicionValida(-91, 0)).toBeNull();
    expect(posicionValida('1', 1)).toBeNull();
  });
});
