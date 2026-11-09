import { useEffect, useRef, useState } from 'react';
import { ordenarAterrizaje, ordenarVolverABase } from '../api';
import { marcaDeEventos, seCortoElAterrizaje } from '../aterrizaje';
import type { Drone, DroneStatus, EventRow, Me } from '../types';
import DialogoConfirmacion, { type PedidoDeConfirmacion } from './DialogoConfirmacion';
import { IconoAterrizar, IconoCasa } from './Iconos';

/** Las dos órdenes de llegada (VUELO §1, capa 3): volver a la base y aterrizar donde está. */
type OrdenDeLlegada = 'volver' | 'aterrizar';

/**
 * La pregunta abierta, con lo que había AL ABRIRLA. El texto y el pedido
 * salen de acá y no del render: si en el medio el control cambiaba de manos,
 * la misma pregunta que no decía nada de quitárselo a nadie salía con
 * `forzar: true`.
 */
interface Pregunta {
  orden: OrdenDeLlegada;
  /** Otro tenía el control y quien pregunta es supervisor: la orden se lo quita. */
  forzar: boolean;
  /** Quién tenía el control manual al abrirla, o `null`. */
  controlador: string | null;
  /** Si lo tenía quien pregunta. */
  soyControlador: boolean;
}

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
 * Por qué las dos órdenes están apagadas, o `null` si se pueden dar. Sin señal
 * con la aeronave la app no da ninguna de las dos (VUELO §4): el DJI vuelve
 * solo, y aterrizar se rechaza. Con otro al mando sólo un supervisor puede
 * darlas igual (VUELO §7.1): el operador lee quién lo tiene, en vez de un
 * botón que no hace nada.
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
  if (status.state === 'RETURNING_HOME_SIGNAL') return 'Sin enlace con la aeronave: el DJI vuelve solo.';
  if (controlador && !soyControlador && !esSupervisor) {
    return `Controlado por ${controlador}. Sólo un supervisor puede darle estas órdenes igual.`;
  }
  return null;
}

/**
 * Lo que se dice de un dron que ya vuelve o baja solo, con «Volver a la base»
 * apagado. En el aterrizaje de emergencia no se promete nada de «Aterrizar
 * acá»: ya está bajando en su última ubicación, y en el descenso final la app
 * lo rechaza (RELEVOS §5).
 */
function notaDelRegreso(estado: string): string {
  if (estado === 'ATERRIZAJE_EMERGENCIA') {
    return 'Está aterrizando de emergencia en su última ubicación: no alcanza ninguna base.';
  }
  return (
    'Ya está volviendo a la base: «Aterrizar acá» le corta el regreso y lo baja donde está, salvo un regreso ' +
    'del propio DJI que la app no discute (lo avisa en el registro de eventos).'
  );
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
  eventos,
}: Readonly<{
  me: Me;
  drone: Drone;
  status: DroneStatus | null;
  /** Quién tiene el control manual, o `null`. */
  controlador: string | null;
  /** Los eventos en vivo de la consola: dicen si el aterrizaje ordenado se cortó. */
  eventos: readonly EventRow[];
}>) {
  const [pregunta, setPregunta] = useState<Pregunta | null>(null);
  /** La orden aceptada que el dron todavía no cumplió, con el evento más nuevo al darla. */
  const [enCurso, setEnCurso] = useState<{ orden: OrdenDeLlegada; desde: number } | null>(null);
  /** La orden de la pregunta está viajando: el cambio de manos que provoca es suyo. */
  const enviando = useRef(false);

  const esSupervisor = me.role === 'supervisor' || me.role === 'admin';
  const soyControlador = controlador === me.username;
  /** Otro tiene el control y quien mira puede quitárselo: la orden va con `forzar`. */
  const forzar = controlador !== null && !soyControlador && esSupervisor;
  const yaVolviendo = status !== null && YA_VOLVIENDO.includes(status.state);
  const impedimento = motivoDelImpedimento(drone, status, controlador, soyControlador, esSupervisor);
  const nota = !impedimento && status !== null && yaVolviendo ? notaDelRegreso(status.state) : null;
  const aterrizajeCortado =
    enCurso?.orden === 'aterrizar' && seCortoElAterrizaje(eventos, drone.droneId, enCurso.desde);

  // El aviso se va cuando el dron confirma: su estado dice que vuelve, o está
  // en el suelo (ahí ya no hay regreso que esperar). El de aterrizar, también
  // cuando la app dice que no sigue: una palanca lo cortó, no se pudo o no se
  // da en ese estado. Y si se desconecta: ya no hay a quién esperarle nada.
  useEffect(() => {
    if (enCurso === null) return;
    const enElSuelo = status?.flying === false;
    const cumplida = enCurso.orden === 'volver' ? yaVolviendo || enElSuelo : enElSuelo || aterrizajeCortado;
    if (cumplida || !drone.online) setEnCurso(null);
  }, [enCurso, yaVolviendo, status?.flying, drone.online, aterrizajeCortado]);

  // Una pregunta que le quitaba el control a alguien con nombre no sobrevive a
  // un cambio de manos: confirmarla le quitaría el dron a otro, o a nadie. Se
  // descarta, como «Quitar control» en DroneDetail. La que no forzaba queda:
  // si en el medio otro tomó el control, el hub contesta 409 «El control lo
  // tiene X» y se lee adentro. El cambio que trae la propia orden (el hub
  // suelta el lock antes de contestar) no la descarta.
  useEffect(() => {
    if (pregunta?.forzar && pregunta.controlador !== controlador && !enviando.current) setPregunta(null);
  }, [pregunta, controlador]);

  function pedido(p: Pregunta): PedidoDeConfirmacion {
    const quitar = p.forzar ? `${p.controlador} tiene el control manual: se le quita en el acto. ` : '';
    const accion = async () => {
      const ordenar = p.orden === 'volver' ? ordenarVolverABase : ordenarAterrizaje;
      // La marca, antes del pedido: la respuesta de la app puede llegar por el
      // canal en vivo antes que la del POST.
      const desde = marcaDeEventos(eventos);
      enviando.current = true;
      try {
        await ordenar(drone.droneId, { forzar: p.forzar });
      } finally {
        enviando.current = false;
      }
      setEnCurso({ orden: p.orden, desde });
    };
    if (p.orden === 'volver') {
      return {
        titulo: `Volver a la base: ${drone.displayName}`,
        consecuencia: `${quitar}${VOLVER}${p.soyControlador ? ' Si tenés el control manual, lo soltás.' : ''}`,
        detalle: p.forzar
          ? 'Queda en el registro que el control se soltó a la fuerza, y quién lo hizo.'
          : 'Si el regreso no arranca, la app lo reintenta y avisa en el registro de eventos. Tomar el control manual lo corta.',
        confirmar: p.forzar ? 'Quitarle el control y volver a la base' : 'Volver a la base',
        enCurso: 'Ordenando…',
        tono: p.forzar ? 'peligro' : 'primario',
        accion,
      };
    }
    return {
      titulo: `Aterrizar acá: ${drone.displayName}`,
      consecuencia: `${quitar}${ATERRIZAR}`,
      detalle: p.soyControlador
        ? 'El control manual sigue tomado en el suelo: después lo podés volver a despegar.'
        : 'Mientras baja, una palanca deliberada de quien tenga el control corta el aterrizaje.',
      confirmar: p.forzar ? 'Quitarle el control y aterrizar acá' : 'Aterrizar acá',
      enCurso: 'Ordenando…',
      accion,
    };
  }

  const abrir = (orden: OrdenDeLlegada) => setPregunta({ orden, forzar, controlador, soyControlador });

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
          onClick={() => abrir('volver')}
        >
          <IconoCasa tamano={18} />
          Volver a la base
        </button>
        <button type="button" className="dismiss" disabled={impedimento !== null} onClick={() => abrir('aterrizar')}>
          <IconoAterrizar tamano={18} />
          Aterrizar acá
        </button>
      </div>
      {impedimento && (
        <p className="muted" role="note" data-testid="vuelo-motivo">
          {impedimento}
        </p>
      )}
      {nota && (
        <p className="muted" role="note" data-testid="vuelo-motivo">
          {nota}
        </p>
      )}
      {!impedimento && forzar && (
        <p className="muted" role="note" data-testid="vuelo-motivo">
          {`Controlado por ${controlador}: cualquiera de las dos órdenes le quita el control antes.`}
        </p>
      )}
      {enCurso && (
        <p className="aviso" role="status" data-testid="vuelo-en-curso">
          {ORDEN_EN_CURSO[enCurso.orden]}
        </p>
      )}
      {pregunta && <DialogoConfirmacion pedido={pedido(pregunta)} onCerrar={() => setPregunta(null)} />}
    </div>
  );
}
