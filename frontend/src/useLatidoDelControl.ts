import { useCallback, useEffect, useRef } from 'react';
import { LATIDO_MS } from './control';

/**
 * La señal de vida de esta consola por cada dron cuyo control tiene
 * (`control_heartbeat`, PROTOCOLS §3.b). Es lo que el hub mira para saber que
 * el titular sigue ahí: 30 s sin ninguna, y suelta el control solo.
 *
 * Vive en la consola y no en la vista del dron ni en la de pilotaje, porque el
 * control es de la PERSONA: quien lo tiene puede estar mirando el tablero, otro
 * dron o el registro, y sigue estando ahí. Por lo mismo no depende de que
 * mande nada: con la pantalla abierta mirando el video, el control no se
 * pierde. Con el canal cerrado no hay a quién latirle, y al reconectarse late
 * en el acto.
 *
 * Late con un temporizador y, además, al llegar cualquier mensaje del hub si
 * ya toca (ver `alRecibirDelHub`): con la pestaña en segundo plano el navegador
 * espacia los temporizadores hasta un minuto, pero los mensajes del socket los
 * sigue entregando en el acto, y el status de cada dron llega una vez por
 * segundo. Sin eso, mirar otra pestaña cinco minutos costaba el control.
 */
export function useLatidoDelControl({
  enviar,
  conectado,
  drones,
}: Readonly<{
  /** El `enviar` del canal (useWebSocket): devuelve si el mensaje salió. */
  enviar: (mensaje: unknown) => boolean;
  conectado: boolean;
  /** Los `droneId` cuyo control tiene esta cuenta. */
  drones: readonly string[];
}>): { alRecibirDelHub: () => void } {
  // Una clave y no el arreglo: la lista se arma de nuevo en cada render, y el
  // temporizador no se puede reiniciar por eso (latiría de más, o nunca).
  const clave = [...drones].sort((a, b) => a.localeCompare(b)).join(',');
  const enviarRef = useRef(enviar);
  enviarRef.current = enviar;
  const latir = useRef<() => void>(() => {});
  const ultimo = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    if (!conectado || clave === '') {
      latir.current = () => {};
      return;
    }
    const ids = clave.split(',');
    latir.current = () => {
      ultimo.current = Date.now();
      for (const droneId of ids) enviarRef.current({ type: 'control_heartbeat', droneId });
    };
    latir.current();
    const id = setInterval(() => latir.current(), LATIDO_MS);
    return () => clearInterval(id);
  }, [conectado, clave]);

  const alRecibirDelHub = useCallback(() => {
    if (Date.now() - ultimo.current >= LATIDO_MS) latir.current();
  }, []);

  return { alRecibirDelHub };
}
