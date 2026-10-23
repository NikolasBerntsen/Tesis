import { useMemo, useState, type ReactNode } from 'react';
import { ContextoDeAlertas, type AlertasEnVivo } from '../alertasEnVivo';
import type { Alert } from '../types';
import ModalDeAlerta from './ModalDeAlerta';

/**
 * Pone lo que la consola sabe en vivo al alcance del pop-up de una alerta, y
 * es el que lo muestra.
 *
 * El pop-up vive acá y no en lo que lo abre por una razón concreta: lo que lo
 * abre puede irse con el pop-up abierto. Validar desde el pop-up la última
 * pendiente de un dron saca el carrusel de la vista (ya no hay nada que
 * recorrer), y si el pop-up fuera hijo del carrusel se cerraba de golpe, sin
 * dejar ver que la decisión se registró. Colgado de la consola, sólo se cierra
 * cuando el operador lo cierra o se va al video.
 */
export default function ProveedorDeAlertas({
  alertas,
  drones,
  statuses,
  decidir,
  verDron,
  children,
}: Omit<AlertasEnVivo, 'abrirAlerta'> & { children: ReactNode }) {
  const [abierta, setAbierta] = useState<Alert | null>(null);

  // Memoizado, como todo valor de un contexto: un objeto nuevo en cada render
  // de la consola —y la consola se pinta con cada cuadro de video— le avisaría
  // a cada lector que algo cambió aunque no haya cambiado nada.
  const valor = useMemo<AlertasEnVivo>(
    () => ({ alertas, drones, statuses, decidir, verDron, abrirAlerta: setAbierta }),
    [alertas, drones, statuses, decidir, verDron],
  );

  return (
    <ContextoDeAlertas.Provider value={valor}>
      {children}
      {abierta && <ModalDeAlerta alerta={abierta} onCerrar={() => setAbierta(null)} />}
    </ContextoDeAlertas.Provider>
  );
}
