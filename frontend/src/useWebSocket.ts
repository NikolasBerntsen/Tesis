import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken } from './api';

/**
 * El canal con el Comando Central visto desde la consola: si está vivo y cómo
 * hablarle. Antes el hook devolvía sólo el booleano porque el socket era de
 * una sola vía (el backend contaba, la consola escuchaba); el mando virtual lo
 * usa al revés, mandando ejes a 10 Hz, y abrir un POST por cada uno sería
 * absurdo.
 */
export type CanalWebSocket = {
  conectado: boolean;
  /** Serializa a JSON y manda. Devuelve si el mensaje llegó a salir. */
  enviar: (mensaje: unknown) => boolean;
};

/** Conexión WebSocket al backend con reconexión automática cada 3 s. */
export function useWebSocket(onMessage: (msg: any) => void): CanalWebSocket {
  const [conectado, setConectado] = useState(false);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  // El socket vive en un ref y no en el estado por dos razones: cambia en cada
  // reconexión y `enviar` tiene que apuntar siempre al vigente sin recrearse,
  // porque quien la usa la tiene en las dependencias de un temporizador —si la
  // función cambiara de identidad, el ritmo de 10 Hz del mando se reiniciaría
  // en cada render.
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${getToken()}`);
      socketRef.current = ws;
      ws.onopen = () => setConectado(true);
      ws.onmessage = (ev) => {
        try {
          handlerRef.current(JSON.parse(ev.data));
        } catch {
          /* mensaje no-JSON: ignorar */
        }
      };
      ws.onclose = () => {
        setConectado(false);
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  const enviar = useCallback((mensaje: unknown): boolean => {
    const socket = socketRef.current;
    // Con el socket cerrado o todavía reconectando no hay a dónde mandar: se
    // devuelve false y NO se encola nada. Un mensaje de mando vale 100 ms; un
    // eje viejo entregado tarde sería una orden equivocada, peor que perderlo.
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(mensaje));
    return true;
  }, []);

  return { conectado, enviar };
}
