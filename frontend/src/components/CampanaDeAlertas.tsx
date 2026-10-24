import { useEffect, useId, useRef, useState } from 'react';
import { useAlertasEnVivo } from '../alertasEnVivo';
import { time, tipoDeAlerta } from '../format';
import type { Alert, Drone } from '../types';
import { useDecisionDeAlerta, type DecidirAlerta } from '../useDecisionDeAlerta';
import { IconoCampana, IconoChevronDerecha } from './Iconos';
import { BotonesDeDecision, ChipDeTipo } from './PiezasDeAlerta';

/**
 * Las alertas de detección son lo único de la consola que no se puede esperar a
 * mirar: llegan solas y hay que decidirlas. Por eso viven en una campana del
 * encabezado y no en una tarjeta al pie de una vista —ahí sólo las veía quien
 * ya estaba mirando ese dron—, y desde el desplegable se validan o se descartan
 * sin salir de donde uno esté. El tablero y la vista del dron las repiten en un
 * carrusel con la captura grande (AlertaEnCurso), y todos deciden con el mismo
 * hook: un rechazo del backend se ve igual en cada uno, al lado de los botones.
 */
export default function CampanaDeAlertas({
  alerts,
  drones,
  onDecidir,
  onVerDron,
}: {
  alerts: Alert[];
  drones: Drone[];
  onDecidir: DecidirAlerta;
  onVerDron: (droneId: string) => void;
}) {
  const [abierta, setAbierta] = useState(false);
  const caja = useRef<HTMLDivElement>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const idPanel = useId();
  const { decidir, errorDe, decidiendo } = useDecisionDeAlerta(onDecidir);
  const { abrirAlerta } = useAlertasEnVivo();

  const pendientes = alerts.filter((a) => a.status === 'PENDING');
  const decididas = alerts.filter((a) => a.status !== 'PENDING').slice(0, 5);

  // Un desplegable del encabezado tiene que cerrarse solo: si queda abierto
  // tapa la vista de abajo y se lo confunde con parte de la barra.
  useEffect(() => {
    if (!abierta) return;
    function afuera(ev: MouseEvent) {
      if (!caja.current?.contains(ev.target as Node)) setAbierta(false);
    }
    function escape(ev: KeyboardEvent) {
      if (ev.key !== 'Escape') return;
      // Si el foco estaba adentro (en "Validar", por ejemplo), cerrar lo dejaba
      // caer en <body> y el teclado tenía que volver a recorrer toda la barra.
      // Vuelve a la campana, que es lo que abrió el panel.
      const estabaAdentro = caja.current?.contains(document.activeElement) ?? false;
      setAbierta(false);
      if (estabaAdentro) boton.current?.focus();
    }
    document.addEventListener('mousedown', afuera);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', afuera);
      document.removeEventListener('keydown', escape);
    };
  }, [abierta]);

  function nombre(droneId: string | null): string {
    if (!droneId) return 'Dron desconocido';
    return drones.find((d) => d.droneId === droneId)?.displayName ?? 'Dron desconocido';
  }

  /**
   * Abre el pop-up de la alerta y pliega el desplegable: abierto atrás, un
   * Escape o un clic en el pop-up lo cerraban igual, y quedaba a medio camino.
   * El foco pasa antes por la campana, que es adonde el pop-up lo devuelve al
   * cerrarse: el botón que se tocó se va con el desplegable.
   */
  function abrir(alerta: Alert, abrirEnLaConsola: (a: Alert) => void) {
    boton.current?.focus();
    setAbierta(false);
    abrirEnLaConsola(alerta);
  }

  return (
    <div className="campana" ref={caja}>
      <button
        ref={boton}
        type="button"
        className={pendientes.length > 0 ? 'campana-boton con-pendientes' : 'campana-boton'}
        aria-expanded={abierta}
        aria-controls={abierta ? idPanel : undefined}
        aria-label={
          pendientes.length === 0
            ? 'Alertas: ninguna pendiente'
            : `Alertas: ${pendientes.length} ${pendientes.length === 1 ? 'pendiente' : 'pendientes'}`
        }
        onClick={() => setAbierta((v) => !v)}
      >
        <IconoCampana />
        {pendientes.length > 0 && <span className="badge-count">{pendientes.length}</span>}
      </button>

      {abierta && (
        <div id={idPanel} className="campana-panel" role="region" aria-label="Alertas de detección">
          <div className="campana-cabecera">
            <span className="etiqueta">Alertas de detección</span>
          </div>

          {pendientes.length === 0 && <p className="vacio">Sin alertas pendientes.</p>}

          {pendientes.map((a) => (
            <div key={a.id} className="campana-alerta">
              <div className="campana-alerta-head">
                {/* La misma placa óxido con su ícono que la tarjeta y el pop-up:
                    la alerta se reconoce igual venga de donde venga. */}
                <ChipDeTipo tipo={a.type} tamanoIcono={18} />
                <button type="button" className="enlace" onClick={() => { onVerDron(a.drone_id!); setAbierta(false); }} disabled={!a.drone_id}>
                  {nombre(a.drone_id)}
                </button>
                <time className="mono muted" dateTime={a.created_at}>
                  {time(a.created_at)}
                </time>
                {abrirAlerta && (
                  <button type="button" className="enlace versal alerta-ver-detalle" onClick={() => abrir(a, abrirAlerta)}>
                    Ver detalle
                    <IconoChevronDerecha tamano={16} />
                  </button>
                )}
              </div>
              {a.snapshot && abrirAlerta && (
                <button
                  type="button"
                  className="snapshot-boton"
                  aria-label={`Ampliar la captura de la alerta #${a.id}`}
                  onClick={() => abrir(a, abrirAlerta)}
                >
                  <img className="snapshot" src={`data:image/jpeg;base64,${a.snapshot}`} alt="Detección" />
                </button>
              )}
              {a.snapshot && !abrirAlerta && (
                <img className="snapshot" src={`data:image/jpeg;base64,${a.snapshot}`} alt="Detección" />
              )}
              {/* El mismo par de la tarjeta del tablero, con el tilde y el tacho:
                  se reconoce igual en los dos lugares. */}
              <BotonesDeDecision ocupado={decidiendo(a.id)} tamanoIcono={18} onDecidir={(d) => decidir(a.id, d)} />
              {/* Pegado a los botones de ESA alerta: con tres pendientes en la
                  lista, un aviso suelto arriba no diría cuál falló. */}
              {errorDe(a.id) && (
                <p className="aviso malo" role="alert">
                  {errorDe(a.id)}
                </p>
              )}
            </div>
          ))}

          {decididas.length > 0 && (
            <>
              <hr className="regla" />
              <span className="etiqueta">Últimas decididas</span>
              {decididas.map((a) => {
                const renglon = (
                  <>
                    <span className={`estado etiqueta ${a.status === 'VALIDATED' ? 'ok' : 'muted'}`}>
                      {a.status === 'VALIDATED' ? 'Validada' : 'Descartada'}
                    </span>
                    <span className="muted">
                      {tipoDeAlerta(a.type)} · {nombre(a.drone_id)}
                    </span>
                    <time className="mono muted" dateTime={a.created_at}>
                      {time(a.created_at)}
                    </time>
                  </>
                );
                // Una decidida también se abre: quién la decidió, la captura y
                // dónde fue siguen haciendo falta para el parte del turno.
                return abrirAlerta ? (
                  <button
                    key={a.id}
                    type="button"
                    className="campana-decidida campana-decidida-boton"
                    onClick={() => abrir(a, abrirAlerta)}
                  >
                    {renglon}
                  </button>
                ) : (
                  <div key={a.id} className="campana-decidida">
                    {renglon}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
