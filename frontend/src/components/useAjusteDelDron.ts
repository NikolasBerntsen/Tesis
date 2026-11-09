import { useCallback, useEffect, useRef, useState } from 'react';
import { ajustarDron } from '../api';
import { AJUSTES_DE_FABRICA, ajusteDelDron, type AjustesDelDron, type ClaveDeAjuste } from '../ajustesDelDron';
import type { Drone } from '../types';

/** Cuánto se espera con la mano quieta sobre un control antes de guardar. */
export const ESPERA_PARA_GUARDAR_MS = 600;

/** Un ajuste del dron en edición: lo que se muestra y cómo cambiarlo. */
export interface AjusteEnEdicion<C extends ClaveDeAjuste> {
  /** Lo que se muestra: lo elegido, o lo de fábrica mientras no se eligió nada. */
  valor: AjustesDelDron[C];
  /** Lo que vale (elegido o guardado) es lo de fábrica: `null` en la ficha. */
  esDeFabrica: boolean;
  guardando: boolean;
  /** Por qué el Comando Central rechazó el último cambio, o vacío. */
  error: string;
  /** Elige un valor (`null` es lo de fábrica) y lo guarda cuando la mano se queda quieta. */
  cambiar: (valor: AjustesDelDron[C] | null) => void;
  /** Vuelve a lo de fábrica en el acto. */
  restablecer: () => void;
  /**
   * Guarda en el acto lo que esperaba la mano quieta y devuelve la promesa de
   * ese guardado, o la del que ya viaja; `null` si no hay nada que esperar. No
   * se rechaza nunca: un rechazo queda en `error`, como siempre. Es para lo que
   * no puede salir antes que el ajuste (un descarte, con el silencio recién
   * movido).
   */
  guardarYa: () => Promise<void> | null;
}

/**
 * Un ajuste del dron (VUELO §10) para cambiarlo desde la consola. Es un dato
 * del dron y no de un vuelo: el Comando Central lo guarda, se lo manda a la app
 * en el acto y otra vez en cada conexión, y la ficha (`drone_updated`) lo trae
 * de vuelta.
 *
 * Se guarda solo cuando la mano se queda quieta: arrastrar un deslizador no
 * manda un pedido por cada posición intermedia, y un interruptor que se prende
 * y se apaga dos veces manda sólo lo último. Hasta que la ficha nueva llegue,
 * el control muestra lo que la persona eligió: volver al valor viejo mientras
 * el pedido viaja hacía saltar la cifra para atrás un instante. Lo rechazado no
 * quedó: vuelve a lo guardado, con el motivo a la vista.
 */
export function useAjusteDelDron<C extends ClaveDeAjuste>(drone: Drone, clave: C): AjusteEnEdicion<C> {
  type Valor = AjustesDelDron[C];
  // Lo guardado en la ficha. `null` es lo de fábrica, y lo que falta (la ficha
  // de un hub viejo) se trata igual: no hay otro valor que mostrar.
  const crudo = drone[clave];
  const guardado = (crudo === null || crudo === undefined ? null : ajusteDelDron(drone, clave)) as Valor | null;
  const guardadoRef = useRef(guardado);
  guardadoRef.current = guardado;

  const [elegido, setElegido] = useState<Valor | null>(guardado);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const temporizador = useRef<ReturnType<typeof setTimeout>>();
  /** Lo que espera su turno para guardarse, si hay algo. */
  const pendiente = useRef<{ valor: Valor | null } | null>(null);
  /** El guardado que está viajando, si hay uno: lo que `guardarYa` hace esperar. */
  const enVuelo = useRef<Promise<void> | null>(null);
  const droneId = drone.droneId;

  // Cuando la ficha cambia, manda: es lo guardado (lo que otra consola fijó, o
  // lo que el hub aceptó de ésta).
  useEffect(() => {
    setElegido(guardado);
  }, [guardado]);

  // Si el control se va con un cambio esperando su turno (se cerró el globo del
  // silencio, se decidió la alerta), el cambio sale igual: lo que la persona
  // eligió último es lo que prometió guardar. Sin estado: ya no hay nada que
  // pintar.
  // El pendiente se olvida al salir: si el dron cambia sin desmontar (la alerta
  // pasa de A a B en un relevo), el que sale es el de A, una sola vez, y a B no
  // le llega después un valor que nadie eligió para él.
  useEffect(
    () => () => {
      clearTimeout(temporizador.current);
      const ultimo = pendiente.current;
      pendiente.current = null;
      if (ultimo) void ajustarDron(droneId, { [clave]: ultimo.valor }).catch(() => {});
    },
    [droneId, clave],
  );

  const guardar = useCallback(
    async (valor: Valor | null) => {
      pendiente.current = null;
      setError('');
      setGuardando(true);
      try {
        await ajustarDron(droneId, { [clave]: valor });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        // Lo rechazado no quedó: el control vuelve a lo guardado.
        setElegido(guardadoRef.current);
      } finally {
        setGuardando(false);
      }
    },
    [droneId, clave],
  );

  /** Guarda y deja anotado el viaje, para que `guardarYa` lo pueda esperar. */
  const lanzar = useCallback(
    (valor: Valor | null): Promise<void> => {
      const viaje = guardar(valor);
      enVuelo.current = viaje;
      // `guardar` no se rechaza nunca (el rechazo queda en `error`).
      void viaje.finally(() => {
        if (enVuelo.current === viaje) enVuelo.current = null;
      });
      return viaje;
    },
    [guardar],
  );

  const cambiar = useCallback(
    (valor: Valor | null) => {
      setElegido(valor);
      clearTimeout(temporizador.current);
      pendiente.current = { valor };
      temporizador.current = setTimeout(() => void lanzar(valor), ESPERA_PARA_GUARDAR_MS);
    },
    [lanzar],
  );

  const restablecer = useCallback(() => {
    clearTimeout(temporizador.current);
    setElegido(null);
    void lanzar(null);
  }, [lanzar]);

  const guardarYa = useCallback((): Promise<void> | null => {
    const ultimo = pendiente.current;
    if (!ultimo) return enVuelo.current;
    clearTimeout(temporizador.current);
    return lanzar(ultimo.valor);
  }, [lanzar]);

  return {
    valor: elegido ?? AJUSTES_DE_FABRICA[clave],
    esDeFabrica: elegido === null,
    guardando,
    error,
    cambiar,
    restablecer,
    guardarYa,
  };
}
