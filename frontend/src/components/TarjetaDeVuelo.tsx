import { useEffect, useState } from 'react';
import { ordenarAterrizaje, ordenarVolverABase } from '../api';
import type { Drone, DroneStatus, Me } from '../types';
import DialogoConfirmacion, { type PedidoDeConfirmacion } from './DialogoConfirmacion';
import { IconoAterrizar, IconoCasa } from './Iconos';

/** Las dos órdenes de llegada (VUELO §1, capa 3): volver a la base y aterrizar donde está. */
type OrdenDeLlegada = 'volver' | 'aterrizar';

/**
 * Los estados en los que el dron ya vuelve o baja solo: ahí «Volver a la base»
 * no agrega nada (VUELO §4), y la app lo dejaría en el registro sin hacer más.
 */
const YA_VOLVIENDO = ['RETURNING_HOME', 'RETURNING_HOME_BATTERY', 'RETURNING_HOME_SIGNAL', 'ATERRIZAJE_EMERGENCIA'];

/** Lo que se avisa mientras el dron no cumplió la orden que el Comando Central ya aceptó. */
const ORDEN_EN_CURSO: Record<OrdenDeLlegada, string> = {
  volver:
    'Regreso ordenado: el dron corta lo que estaba haciendo y vuelve solo a su base. Si no arranca, la app lo ' +
    'reintenta y el motivo queda en el registro de eventos.',
  aterrizar: 'Aterrizaje ordenado: el dron baja donde está. Si no puede, el motivo queda en el registro de eventos.',
};

const VOLVER = 'El dron deja lo que esté haciendo (la ruta o el objetivo) y vuelve solo a su base; las detecciones no lo frenan.';
const ATERRIZAR = 'El dron desciende y aterriza donde está ahora. Confirmá que abajo hay suelo firme y despejado.';

/**
 * Por qué las dos órdenes están apagadas, o `null` si se pueden dar. Con otro
 * al mando sólo un supervisor puede darlas igual (VUELO §7.1): el operador lee
 * quién lo tiene, en vez de un botón que no hace nada.
 */
function motivoDelImpedimento(
  drone: Drone,
  status: DroneStatus | null,
  controlador: string | null,
  soyControlador: boolean,
  esSupervisor: boolean,
): string | null {
  if (!drone.online) return 'El dron está desconectado.';
  if (status?.flying === false) return 'El dron está en el suelo.';
  if (status?.flying !== true) return 'El dron no informa si está en el aire.';
  if (controlador && !soyControlador && !esSupervisor) {
    return `Controlado por ${controlador}. Sólo un supervisor puede darle estas órdenes igual.`;
  }
  return null;
}

/**
 * «Volver a la base» y «Aterrizar acá» desde la vista del dron (VUELO §7 y §9).
 * Son órdenes de llegada: mandan sobre la ruta y el objetivo, no necesitan el
 * control manual y las detecciones no las frenan. Si el que ordena tiene el
 * control, el hub le suelta el lock; si lo tiene otro, un supervisor se lo
 * quita antes (`forzar`) y la pregunta lo dice con todas las letras.
 *
 * Las dos pasan por la confirmación de siempre, y el rechazo del hub (el 409
 * de «El control lo tiene X») se lee adentro de la pregunta, que queda abierta.
 */
export default function TarjetaDeVuelo({
  me,
  drone,
  status,
  controlador,
}: Readonly<{
  me: Me;
  drone: Drone;
  status: DroneStatus | null;
  /** Quién tiene el control manual, o `null`. */
  controlador: string | null;
}>) {
  const [aConfirmar, setAConfirmar] = useState<OrdenDeLlegada | null>(null);
  const [enCurso, setEnCurso] = useState<OrdenDeLlegada | null>(null);

  const esSupervisor = me.role === 'supervisor' || me.role === 'admin';
  const soyControlador = controlador === me.username;
  /** Otro tiene el control y quien mira puede quitárselo: la orden va con `forzar`. */
  const forzar = controlador !== null && !soyControlador && esSupervisor;
  const yaVolviendo = status !== null && YA_VOLVIENDO.includes(status.state);
  const impedimento = motivoDelImpedimento(drone, status, controlador, soyControlador, esSupervisor);

  // El aviso se va cuando el dron confirma: su estado dice que vuelve, o está
  // en el suelo. También si se desconecta: ya no hay a quién esperarle nada.
  useEffect(() => {
    if (enCurso === null) return;
    const confirmado = enCurso === 'volver' ? yaVolviendo : status?.flying === false;
    if (confirmado || !drone.online) setEnCurso(null);
  }, [enCurso, yaVolviendo, status?.flying, drone.online]);

  function pedido(orden: OrdenDeLlegada): PedidoDeConfirmacion {
    const quitar = forzar ? `${controlador} tiene el control manual: se le quita en el acto. ` : '';
    const accion = async () => {
      const ordenar = orden === 'volver' ? ordenarVolverABase : ordenarAterrizaje;
      await ordenar(drone.droneId, { forzar });
      setEnCurso(orden);
    };
    if (orden === 'volver') {
      return {
        titulo: `Volver a la base: ${drone.displayName}`,
        consecuencia: `${quitar}${VOLVER}${soyControlador ? ' Si tenés el control manual, lo soltás.' : ''}`,
        detalle: forzar
          ? 'Queda en el registro que el control se soltó a la fuerza, y quién lo hizo.'
          : 'Si el regreso no arranca, la app lo reintenta y avisa en el registro de eventos. Tomar el control manual lo corta.',
        confirmar: forzar ? 'Quitarle el control y volver a la base' : 'Volver a la base',
        enCurso: 'Ordenando…',
        tono: forzar ? 'peligro' : 'primario',
        accion,
      };
    }
    return {
      titulo: `Aterrizar acá: ${drone.displayName}`,
      consecuencia: `${quitar}${ATERRIZAR}`,
      detalle: soyControlador
        ? 'El control manual sigue tomado en el suelo: después lo podés volver a despegar.'
        : 'Mientras baja, una palanca deliberada de quien tenga el control corta el aterrizaje.',
      confirmar: forzar ? 'Quitarle el control y aterrizar acá' : 'Aterrizar acá',
      enCurso: 'Ordenando…',
      accion,
    };
  }

  return (
    <div className="card tarjeta-vuelo">
      <h2>
        <IconoCasa />
        Vuelo
      </h2>
      <p className="muted">
        Las órdenes que traen el dron: mandan sobre la ruta y el objetivo, no necesitan el control manual y las
        detecciones no las frenan.
      </p>
      <div className="vuelo-ordenes">
        <button
          type="button"
          className="primario"
          disabled={impedimento !== null || yaVolviendo}
          onClick={() => setAConfirmar('volver')}
        >
          <IconoCasa tamano={18} />
          Volver a la base
        </button>
        <button type="button" className="dismiss" disabled={impedimento !== null} onClick={() => setAConfirmar('aterrizar')}>
          <IconoAterrizar tamano={18} />
          Aterrizar acá
        </button>
      </div>
      {impedimento && (
        <p className="muted" role="note" data-testid="vuelo-motivo">
          {impedimento}
        </p>
      )}
      {!impedimento && yaVolviendo && (
        <p className="muted" role="note" data-testid="vuelo-motivo">
          Ya está volviendo a la base o bajando: «Aterrizar acá» lo corta y lo baja donde está.
        </p>
      )}
      {!impedimento && forzar && (
        <p className="muted" role="note" data-testid="vuelo-motivo">
          {`Controlado por ${controlador}: cualquiera de las dos órdenes le quita el control antes.`}
        </p>
      )}
      {enCurso && (
        <p className="aviso" role="status" data-testid="vuelo-en-curso">
          {ORDEN_EN_CURSO[enCurso]}
        </p>
      )}
      {aConfirmar && <DialogoConfirmacion pedido={pedido(aConfirmar)} onCerrar={() => setAConfirmar(null)} />}
    </div>
  );
}
