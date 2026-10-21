import { useState } from 'react';

export type Decision = 'VALIDATED' | 'DISMISSED';

/**
 * Lo que la consola ejecuta al validar o descartar. Si el backend la rechaza,
 * la promesa se rechaza con el motivo ya escrito para el operador (lo arma
 * `motivoDelRechazoDeDecision` en api.ts).
 */
export type DecidirAlerta = (id: number, decision: Decision) => Promise<void> | void;

/**
 * Validar y descartar se ofrecen en dos lugares —la campana del encabezado y la
 * tarjeta "Alerta en curso" de la vista del dron— y los dos tienen que hacer lo
 * mismo: frenar el doble click mientras el pedido viaja y dejar a la vista el
 * motivo si el backend dice que no. Repetirlo en cada componente era la forma
 * segura de que uno de los dos volviera a tragarse el error.
 */
export function useDecisionDeAlerta(onDecidir: DecidirAlerta) {
  const [errores, setErrores] = useState<Record<number, string>>({});
  // Un conjunto y no un solo id: en la campana hay varias pendientes, y con un
  // único "en curso" decidir la segunda rehabilitaba los botones de la primera
  // con su pedido todavía en viaje. Un segundo click ahí volvía como 409 y el
  // aviso culpaba a "otro operador" de lo que había hecho el mismo.
  const [enCurso, setEnCurso] = useState<ReadonlySet<number>>(() => new Set());

  async function decidir(id: number, decision: Decision) {
    setErrores(({ [id]: _anterior, ...resto }) => resto);
    setEnCurso((prev) => new Set(prev).add(id));
    try {
      await onDecidir(id, decision);
    } catch (e) {
      setErrores((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setEnCurso((prev) => {
        const resto = new Set(prev);
        resto.delete(id);
        return resto;
      });
    }
  }

  return {
    decidir,
    /** El motivo del último rechazo de esa alerta, o `null`. */
    errorDe: (id: number): string | null => errores[id] ?? null,
    /** Si esa alerta tiene un pedido de decisión en viaje. */
    decidiendo: (id: number): boolean => enCurso.has(id),
  };
}
