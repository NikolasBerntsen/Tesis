import { useEffect, useState, type ReactNode } from 'react';
import { useAlertasEnVivo } from '../alertasEnVivo';
import { api } from '../api';
import {
  coordenadas,
  coordenadasODato,
  fechaHoraLarga,
  hashCorto,
  posicionDelDron,
  posicionValida,
  situacionDelObjetivo,
  stateLabel,
  textoSinGps,
  tipoDeAlerta,
} from '../format';
import type { Alert, Drone, MetaAlerta, MetaDron } from '../types';
import { useDecisionDeAlerta, type Decision } from '../useDecisionDeAlerta';
import MapaDeAlerta from './MapaDeAlerta';

const ESTADO: Record<Alert['status'], string> = {
  PENDING: 'Pendiente',
  VALIDATED: 'Validada',
  DISMISSED: 'Descartada',
};

/** El punto de color del estado: óxido lo que espera, verde lo confirmado, apagado lo descartado. */
const TONO: Record<Alert['status'], string> = {
  PENDING: 'bad',
  VALIDATED: 'ok',
  DISMISSED: 'muted',
};

/** La batería llega del celular sin que nadie la revise: un texto ahí no es un porcentaje. */
function porcentaje(valor: unknown): string {
  return typeof valor === 'number' && Number.isFinite(valor) ? `${Math.round(valor)} %` : '—';
}

/**
 * Si el dron sigue en la flota y conectado. Sin la consola alrededor (el
 * componente montado suelto) no se sabe, y se dice con la raya.
 */
function conexion(dron: Drone | null, hayConsola: boolean): string {
  if (dron) return dron.online ? 'En línea' : 'Desconectado';
  return hayConsola ? 'Ya no está en la flota' : '—';
}

/**
 * Todo lo que hace falta para decidir una alerta y mandar gente: la captura con
 * el recuadro de la detección (la app la manda ya marcada), cuándo fue, el dron
 * que la vio, un mapa con el punto de la detección y —si el seguimiento sigue—
 * dónde están ahora el objetivo y el dron, el camino al video en vivo y los
 * botones de Validar y Descartar.
 *
 * Es el cuerpo del pop-up de una alerta, y el mismo bloque aparece adentro del
 * detalle de un evento que la nombra (en el Registro y en el historial del
 * dron): una alerta se lee igual venga de donde venga.
 *
 * Lo que está en vivo sale de la consola (`useAlertasEnVivo`): si la alerta
 * cambia mientras el pop-up está abierto —otro operador la decide— se ve en el
 * acto. Lo que la consola no tiene, se pide al backend.
 */
export default function DetalleDeAlerta({
  alertaId,
  conocida,
  referencia,
  dronDeRespaldo,
  conTitulo = true,
  onIrAlVideo,
}: {
  alertaId: number;
  /** La alerta como la tiene quien abrió el pop-up (el carrusel, la campana). */
  conocida?: Alert;
  /** Lo que el evento guardó de la alerta: se muestra si no se la puede traer. */
  referencia?: MetaAlerta;
  /** La ficha del dron que guardó el evento, para el dron que ya no está en la flota. */
  dronDeRespaldo?: MetaDron;
  /** "Alerta #N" arriba. El pop-up propio de la alerta lo lleva en su cabecera. */
  conTitulo?: boolean;
  /** Qué hace quien lo contiene después de ir al video: cerrarse. */
  onIrAlVideo: () => void;
}) {
  const vivo = useAlertasEnVivo();
  const viva = vivo.alertas.find((a) => a.id === alertaId) ?? null;
  const hayViva = viva !== null;
  const [traida, setTraida] = useState<Alert | null>(null);
  const [error, setError] = useState('');
  /** Sube después de decidir una alerta que la consola no sigue: hay que volver a pedirla. */
  const [recarga, setRecarga] = useState(0);
  // Se pide al backend sólo lo que la consola no tiene: la alerta de un evento
  // viejo, que ya salió de la lista de las últimas cien.
  const debeTraer = !hayViva && (conocida === undefined || recarga > 0);
  const [cargando, setCargando] = useState(debeTraer);

  useEffect(() => {
    if (!debeTraer) return;
    let vigente = true;
    api<Alert>(`/alerts/${alertaId}`)
      .then((a) => {
        if (!vigente) return;
        setTraida(a);
        setError('');
      })
      .catch((e) => {
        if (vigente) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [alertaId, debeTraer, recarga]);

  async function decidirYRefrescar(id: number, decision: Decision) {
    await vivo.decidir?.(id, decision);
    // La consola sigue por el WebSocket sólo las alertas de su lista: una que
    // no está se vuelve a pedir, para que el pop-up no siga diciendo
    // "Pendiente" después de decidirla.
    if (!hayViva) setRecarga((n) => n + 1);
  }
  const { decidir, errorDe, decidiendo } = useDecisionDeAlerta(decidirYRefrescar);

  // Lo más fresco primero: la de la consola, la recién traída, la del que abrió.
  const alerta = viva ?? traida ?? conocida ?? null;
  const tipo = alerta?.type ?? referencia?.tipo ?? '';
  const lat = alerta?.lat ?? referencia?.lat ?? null;
  const lon = alerta?.lon ?? referencia?.lon ?? null;
  const momento = alerta?.created_at ?? referencia?.ts ?? null;
  const droneId = alerta?.drone_id ?? null;
  const dron = vivo.drones.find((d) => d.droneId === droneId) ?? null;
  const status = droneId ? (vivo.statuses[droneId] ?? null) : null;
  // El objetivo de ESTA alerta: el dron puede estar sobre otro, más nuevo.
  const seguido = status?.target?.alertId === alertaId ? status.target : null;
  // El hub reenvía `target` tal cual lo manda la app (ver ws.ts): una posición
  // en null rompía el render con `toFixed` y una en NaN, a Leaflet con "Invalid
  // LatLng"; sin un límite de errores, la consola entera quedaba en blanco.
  // Sin posición válida el seguimiento sigue siendo un dato, pero no se dibuja.
  const objetivo = seguido && posicionValida(seguido.lat, seguido.lon) ? seguido : null;
  const posicionDron = posicionDelDron(status);
  const deteccion: [number, number] | null = posicionValida(lat, lon) ? [lat as number, lon as number] : null;
  const nombre = dron?.displayName || dronDeRespaldo?.displayName || '';

  let resolucion = 'Sin resolver';
  if (alerta && alerta.status !== 'PENDING') {
    resolucion = `${ESTADO[alerta.status]} por ${alerta.decided_by ?? '—'} · ${fechaHoraLarga(alerta.decided_at)}`;
  }
  const puedeDecidir = alerta?.status === 'PENDING' && vivo.decidir !== null;
  const ocupado = decidiendo(alertaId);
  const errorDeDecision = errorDe(alertaId);
  const verDron = vivo.verDron;

  let mapa: ReactNode = null;
  if (deteccion || objetivo || posicionDron) {
    mapa = (
      <MapaDeAlerta
        deteccion={deteccion}
        objetivo={objetivo}
        dron={posicionDron ? { nombre: nombre || 'Dron', posicion: posicionDron } : null}
      />
    );
  } else if (!cargando) {
    mapa = <p className="vacio">No hay coordenadas para ubicarla en el mapa.</p>;
  }

  return (
    <div className="detalle-alerta" data-testid="detalle-alerta">
      {conTitulo && (
        <h3 className="etiqueta detalle-alerta-titulo">
          Alerta #{alertaId}
          {alerta && <span className={`estado ${TONO[alerta.status]}`}>{ESTADO[alerta.status]}</span>}
        </h3>
      )}
      {error && <p className="aviso malo">No se pudo traer la alerta: {error}</p>}
      {cargando && <p className="muted">Trayendo la alerta…</p>}

      {/* La captura y el mapa, lado a lado si entran: son las dos cosas que se
          miran juntas para decidir adónde mandar a alguien. */}
      <div className="detalle-alerta-vistas">
        <div className="detalle-alerta-captura">
          {alerta?.snapshot && (
            <img className="snapshot" src={`data:image/jpeg;base64,${alerta.snapshot}`} alt="Captura de la detección" />
          )}
          {alerta && !alerta.snapshot && <p className="vacio">La detección no dejó captura.</p>}
        </div>
        {mapa}
      </div>

      <dl className="datos">
        <dt>Tipo</dt>
        <dd>{tipo ? <span className={`badge ${tipo.toLowerCase()}`}>{tipoDeAlerta(tipo)}</span> : '—'}</dd>
        <dt>Detectada</dt>
        <dd>{momento ? <time dateTime={momento}>{fechaHoraLarga(momento)}</time> : '—'}</dd>
        <dt>Coordenadas</dt>
        <dd className="mono">{coordenadasODato(lat, lon)}</dd>
        {seguido && (
          <>
            <dt>Objetivo ahora</dt>
            <dd>
              {objetivo ? (
                <span className="mono">{coordenadas(objetivo.lat, objetivo.lon)}</span>
              ) : (
                <span className="muted">Sin posición estimada</span>
              )}
              {` · ${situacionDelObjetivo(seguido)}`}
            </dd>
          </>
        )}
        <dt>Resolución</dt>
        {/* Se anuncia al cambiar: otro operador la puede decidir con el pop-up abierto. */}
        <dd aria-live="polite">{resolucion}</dd>
      </dl>

      <h3 className="etiqueta">Dron</h3>
      <dl className="datos">
        <dt>Nombre</dt>
        <dd>{nombre || 'Dron desconocido'}</dd>
        <dt>Modelo</dt>
        <dd>{dron?.model || dronDeRespaldo?.model || '—'}</dd>
        <dt>Identificador</dt>
        <dd>
          <span className="hash mono">{hashCorto(dron?.hash || dronDeRespaldo?.hash || droneId)}</span>
        </dd>
        <dt>Conexión</dt>
        <dd>{conexion(dron, verDron !== null)}</dd>
        {status && (
          <>
            <dt>Estado</dt>
            <dd>{stateLabel(status.state)}</dd>
            <dt>Batería</dt>
            <dd>{porcentaje(status.battery)}</dd>
            <dt>Posición actual</dt>
            <dd className="mono">
              {posicionDron ? coordenadas(posicionDron[0], posicionDron[1]) : textoSinGps(status.satellites)}
            </dd>
          </>
        )}
      </dl>

      {(verDron || puedeDecidir || errorDeDecision) && (
        <div className="detalle-alerta-acciones">
          {verDron && (
            <button
              type="button"
              className="detalle-alerta-video"
              disabled={!dron}
              title={dron ? `Abrir la vista de ${dron.displayName}` : 'El dron de esta alerta ya no está en la flota'}
              onClick={
                dron
                  ? () => {
                      verDron(dron.droneId);
                      onIrAlVideo();
                    }
                  : undefined
              }
            >
              Ver feed en vivo
            </button>
          )}
          {puedeDecidir && (
            <>
              <div className="alert-actions">
                <button
                  type="button"
                  className="validate"
                  disabled={ocupado}
                  onClick={() => {
                    void decidir(alertaId, 'VALIDATED');
                  }}
                >
                  Validar
                </button>
                <button
                  type="button"
                  className="dismiss"
                  disabled={ocupado}
                  onClick={() => {
                    void decidir(alertaId, 'DISMISSED');
                  }}
                >
                  Descartar
                </button>
              </div>
              {/* Lo que hace cada botón con el dron, dicho antes de apretarlo,
                  como en el carrusel. */}
              <p className="muted alerta-consecuencias">
                Validar: el dron se queda sobre el objetivo hasta que lo mandes a patrullar. Descartar: retoma la ruta
                hacia el próximo nodo.
              </p>
            </>
          )}
          {errorDeDecision && (
            <p className="aviso malo" role="alert">
              {errorDeDecision}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
