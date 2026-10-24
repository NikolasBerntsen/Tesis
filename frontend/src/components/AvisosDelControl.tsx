import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { segundosParaContestar, segundosRestantes, type AvisoDelControl, type PedidoDeControl } from '../control';
import { useCapaSobreElPilotaje, useVistaDePilotaje } from './CapaDePilotaje';
import { IconoCerrar, IconoMando, IconoReloj } from './Iconos';
import { esTeclaDeVuelo } from './useTecladoDeVuelo';

/** Cada cuánto se redibuja la cuenta regresiva: más fino que el segundo, para que no salte de a dos. */
const TICK_MS = 250;

/**
 * Lo que queda a la vista un aviso de cómo terminó, con la vista de pilotaje
 * abierta: va arriba al centro, encima de las lecturas del vuelo, y en modo
 * mouse el piloto ni siquiera puede apretar su cruz.
 */
export const AVISO_EN_VUELO_MS = 8_000;

/** `Date.now()` que se actualiza solo mientras haga falta (hay una cuenta regresiva en pantalla). */
function useAhora(activo: boolean): number {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    if (!activo) return;
    setAhora(Date.now());
    const id = setInterval(() => setAhora(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [activo]);
  return ahora;
}

/**
 * Lo que un aviso hace con el teclado mientras tiene el foco, y sólo entonces.
 *
 * El aviso nunca se lleva el foco solo: le llega a alguien que puede estar
 * volando con W/A/S/D, y moverle el foco haría que la tecla siguiente
 * conteste el aviso en vez de volar (un Espacio para subir apretaría un
 * botón). Al aviso se llega con el tabulador o con el mouse.
 *
 * Con el foco adentro, las teclas de vuelo son de los botones y no vuelan: su
 * keydown no sigue hasta la ventana, que es donde escucha el teclado de vuelo.
 * El keyup de una tecla que se apretó AFUERA sí sigue, para que la soltada
 * llegue al teclado de vuelo y el dron no quede comandado con una tecla que ya
 * nadie aprieta. Escape, si hay `onEscape`, es la respuesta que no cambia nada.
 */
function useTecladoDelAviso(onEscape?: () => void) {
  const caja = useRef<HTMLElement>(null);
  const escapar = useRef(onEscape);
  escapar.current = onEscape;
  useEffect(() => {
    // El aviso se monta con su caja: la ref ya está puesta cuando corre esto.
    const elemento = caja.current!;
    const adentro = new Set<string>();
    const alApretar = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && escapar.current) {
        ev.stopPropagation();
        ev.preventDefault();
        escapar.current();
        return;
      }
      if (!esTeclaDeVuelo(ev.code, true)) return;
      ev.stopPropagation();
      // La repetición del navegador de una tecla sostenida no es apretarla
      // acá: si se apretó afuera y el foco entró después, anotarla le comía la
      // soltada al teclado de vuelo, y el dron seguía volando con una tecla
      // que ya nadie apretaba.
      if (!ev.repeat) adentro.add(ev.code);
    };
    const alSoltar = (ev: KeyboardEvent) => {
      if (!adentro.delete(ev.code)) return;
      ev.stopPropagation();
    };
    elemento.addEventListener('keydown', alApretar);
    elemento.addEventListener('keyup', alSoltar);
    return () => {
      elemento.removeEventListener('keydown', alApretar);
      elemento.removeEventListener('keyup', alSoltar);
    };
  }, []);
  return caja;
}

/**
 * En modo mouse la vista de pilotaje captura el puntero, y todo clic va a ella:
 * los botones de un aviso que hay que contestar no se podrían apretar. Se suelta
 * al aparecer el aviso; el piloto vuelve al modo mouse con su botón.
 */
function useSoltarElPuntero() {
  useEffect(() => {
    if (!document.pointerLockElement) return;
    try {
      document.exitPointerLock();
    } catch {
      // El navegador no lo deja ahora: queda el tabulador para llegar al aviso.
    }
  }, []);
}

/** El texto del error de un pedido que el backend rechazó. */
function textoDelError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Una respuesta en viaje: los botones se apagan y, si falla, el motivo queda a la vista. */
function useRespuesta() {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const responder = (accion: () => Promise<void>) => {
    if (ocupado) return;
    setError('');
    setOcupado(true);
    accion().then(
      () => setOcupado(false),
      (e: unknown) => {
        setError(textoDelError(e));
        setOcupado(false);
      },
    );
  };
  return { ocupado, error, responder };
}

/**
 * El pedido que le llega a quien tiene el control: «Y quiere tomar el control»,
 * con la cuenta regresiva y las dos respuestas. Sin respuesta, el control pasa
 * solo (lo decide el hub, a los 10 s): es lo que destraba una sesión que el
 * sistema cree viva y nadie mira.
 *
 * «Mantener el control» va primero en el orden del tabulador: es la que no le
 * pasa un dron en vuelo a otra persona por un Enter apurado. Escape, con el
 * foco adentro, también mantiene.
 *
 * La cuenta va con el margen del titular (`segundosParaContestar`): se termina
 * antes que el plazo del hub, para que la respuesta no le llegue vencida.
 */
function PedidoAlTitular({
  pedido,
  nombre,
  ahora,
  onContestar,
}: Readonly<{
  pedido: PedidoDeControl;
  nombre: string;
  ahora: number;
  onContestar: (respuesta: 'ceder' | 'mantener') => Promise<void>;
}>) {
  const idTitulo = useId();
  const { ocupado, error, responder } = useRespuesta();
  const mantener = () => responder(() => onContestar('mantener'));
  const caja = useTecladoDelAviso(mantener);
  useSoltarElPuntero();
  const segundos = segundosParaContestar(pedido, ahora);
  // El plazo que se le anuncia es el que quedaba al aparecer: una consola que
  // recargó en el medio recibe el pedido con menos de diez.
  const [plazo] = useState(segundos);
  return (
    <section ref={caja} className="aviso-control aviso-control-pedido" aria-labelledby={idTitulo} data-testid="pedido-al-titular">
      <h2 className="aviso-control-titulo" id={idTitulo}>
        <IconoMando tamano={20} />
        {pedido.solicitante} quiere tomar el control
      </h2>
      <p>
        Le pidió a la consola el control de <strong>{nombre}</strong>. Si no contestás, el control pasa a{' '}
        {pedido.solicitante}: si lo estás volando a mano, el dron queda quieto donde está, a la espera de sus órdenes.
      </p>
      {/* La cuenta cambia cada segundo: para el lector de pantalla va el
          plazo una sola vez, en la oración de abajo, y no un número por segundo. */}
      <p className="aviso-control-cuenta" aria-hidden="true" data-testid="cuenta-regresiva">
        <IconoReloj tamano={18} />
        {segundos} s
      </p>
      <p className="aviso-control-solo-lector">Tenés {plazo} segundos para contestar.</p>
      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}
      <div className="aviso-control-acciones">
        <button type="button" onClick={mantener} disabled={ocupado}>
          Mantener el control
        </button>
        <button type="button" className="primario" onClick={() => responder(() => onContestar('ceder'))} disabled={ocupado}>
          Ceder el control
        </button>
      </div>
    </section>
  );
}

/**
 * Lo que ve quien pidió el control mientras el titular decide. Como en el
 * pedido al titular, la cuenta que cambia cada segundo no se le lee al lector
 * de pantalla —en la región asertiva lo interrumpía diez veces—: oye el plazo
 * una vez, y después que el control está pasando.
 */
function PedidoEnEspera({
  pedido,
  nombre,
  ahora,
  onCancelar,
}: Readonly<{ pedido: PedidoDeControl; nombre: string; ahora: number; onCancelar: () => Promise<void> }>) {
  const idTitulo = useId();
  const { ocupado, error, responder } = useRespuesta();
  const caja = useTecladoDelAviso();
  const segundos = segundosRestantes(pedido, ahora);
  const [plazo] = useState(segundos);
  return (
    <section ref={caja} className="aviso-control" aria-labelledby={idTitulo} data-testid="pedido-en-espera">
      <h2 className="aviso-control-titulo" id={idTitulo}>
        <IconoReloj tamano={20} />
        Pediste el control de {nombre}
      </h2>
      {segundos > 0 ? (
        <>
          <p aria-hidden="true">
            {`Esperando que ${pedido.titular} conteste: si no contesta en ${segundos} s, el control pasa a vos.`}
          </p>
          <p className="aviso-control-solo-lector">
            {`Esperando que ${pedido.titular} conteste: si no contesta en ${plazo} segundos, el control pasa a vos.`}
          </p>
        </>
      ) : (
        <p>{`${pedido.titular} no contestó: el control está pasando a vos.`}</p>
      )}
      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}
      <div className="aviso-control-acciones">
        <button type="button" onClick={() => responder(onCancelar)} disabled={ocupado || segundos === 0}>
          Cancelar el pedido
        </button>
      </div>
    </section>
  );
}

/**
 * Cómo terminó un pedido, o un control que se soltó solo: una línea con su
 * cruz. Con la vista de pilotaje abierta se va sola a los `AVISO_EN_VUELO_MS`.
 */
function AvisoDelFin({
  aviso,
  nombre,
  seVaSolo,
  onDescartar,
}: Readonly<{ aviso: AvisoDelControl; nombre: string; seVaSolo: boolean; onDescartar: (id: number) => void }>) {
  // En una ref: el padre pasa una función nueva en cada render, y el plazo no
  // puede volver a empezar por eso.
  const descartar = useRef(onDescartar);
  descartar.current = onDescartar;
  useEffect(() => {
    if (!seVaSolo) return;
    const id = setTimeout(() => descartar.current(aviso.id), AVISO_EN_VUELO_MS);
    return () => clearTimeout(id);
  }, [seVaSolo, aviso.id]);
  return (
    <p className={`aviso-control aviso-control-fin ${aviso.tono}`} data-testid="aviso-del-control">
      <span>{aviso.texto}</span>
      <button
        type="button"
        className="icono-boton"
        aria-label={`Cerrar el aviso de ${nombre}`}
        onClick={() => onDescartar(aviso.id)}
      >
        <IconoCerrar tamano={16} />
      </button>
    </p>
  );
}

/**
 * Los avisos del control manual de esta consola, encima de todo: también de
 * la vista de pilotaje, que es donde está quien recibe un pedido mientras
 * vuela (ver CapaDePilotaje), y de un diálogo abierto, que con
 * `data-sobre-los-dialogos` los suma a la vuelta de su tabulador (Modal.tsx).
 * No bloquean nada ni se llevan el foco; la región es asertiva y está siempre
 * en el DOM, porque los lectores de pantalla sólo anuncian lo que cambia en
 * una región que ya existía, y un pedido con diez segundos de plazo no espera
 * a que el lector termine lo que dice.
 *
 * Volando, de los avisos de cómo terminó solo se ven los del dron que se vuela,
 * y se van solos: los de otro dron le tapaban las lecturas del vuelo por algo
 * que puede esperar, y aparecen al cerrar la vista. Los pedidos se ven siempre.
 */
export default function AvisosDelControl({
  yo,
  pedidos,
  nombreDe,
  avisos,
  onContestar,
  onCancelar,
  onDescartar,
}: Readonly<{
  yo: string;
  pedidos: readonly PedidoDeControl[];
  nombreDe: (droneId: string) => string;
  avisos: readonly AvisoDelControl[];
  onContestar: (droneId: string, respuesta: 'ceder' | 'mantener') => Promise<void>;
  onCancelar: (droneId: string) => Promise<void>;
  onDescartar: (id: number) => void;
}>) {
  const contenedor = useCapaSobreElPilotaje();
  const vista = useVistaDePilotaje();
  const propios = pedidos.filter((p) => p.titular === yo || p.solicitante === yo);
  const ahora = useAhora(propios.length > 0);
  // Al titular el aviso se le va solo al vencer su plazo: desde ahí el control
  // ya no es suyo para decidir, y enseguida llega cómo terminó.
  const alTitular = propios.filter((p) => p.titular === yo && segundosParaContestar(p, ahora) > 0);
  const enEspera = propios.filter((p) => p.solicitante === yo);
  const aLaVista = vista.abierta ? avisos.filter((a) => vista.dron === null || a.droneId === vista.dron) : avisos;

  return createPortal(
    <div className="avisos-del-control" aria-live="assertive" data-sobre-los-dialogos="">
      {alTitular.map((p) => (
        <PedidoAlTitular
          key={`titular-${p.droneId}`}
          pedido={p}
          nombre={nombreDe(p.droneId)}
          ahora={ahora}
          onContestar={(respuesta) => onContestar(p.droneId, respuesta)}
        />
      ))}
      {enEspera.map((p) => (
        <PedidoEnEspera
          key={`espera-${p.droneId}`}
          pedido={p}
          nombre={nombreDe(p.droneId)}
          ahora={ahora}
          onCancelar={() => onCancelar(p.droneId)}
        />
      ))}
      {aLaVista.map((a) => (
        <AvisoDelFin key={a.id} aviso={a} nombre={nombreDe(a.droneId)} seVaSolo={vista.abierta} onDescartar={onDescartar} />
      ))}
    </div>,
    contenedor,
  );
}
