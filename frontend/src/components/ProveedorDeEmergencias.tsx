import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ContextoDeRelevosYEmergencias, type RelevosYEmergenciasEnVivo } from '../relevosYEmergencias';
import ModalDeEmergencia from './ModalDeEmergencia';

/**
 * Pone lo que la consola sabe en vivo de los relevos y las emergencias al
 * alcance de quien lo necesite, y muestra la ficha de una emergencia.
 *
 * La ficha vive acá, y no en lo que la abre, por lo mismo que el pop-up de las
 * alertas (ProveedorDeAlertas): lo que la abre se puede ir con ella abierta.
 * Marcar el dron como recuperado se lleva el aviso de arriba de la consola, y
 * si la ficha fuera hija del aviso se cerraría de golpe, sin dejar ver que la
 * recuperación quedó registrada.
 */
export default function ProveedorDeEmergencias({
  relevos,
  emergencias,
  fotos,
  marcarRecuperada,
  children,
}: Omit<RelevosYEmergenciasEnVivo, 'abrirEmergencia'> & { children: ReactNode }) {
  const [abierta, setAbierta] = useState<{ id: number; devolverFoco?: () => void } | null>(null);
  const abrirEmergencia = useCallback(
    (id: number, devolverFoco?: () => void) => setAbierta({ id, devolverFoco }),
    [],
  );

  // Memoizado, como todo valor de un contexto: la consola se repinta con cada
  // cuadro de video, y un objeto nuevo despertaría a todos sus lectores.
  const valor = useMemo<RelevosYEmergenciasEnVivo>(
    () => ({ relevos, emergencias, fotos, marcarRecuperada, abrirEmergencia }),
    [relevos, emergencias, fotos, marcarRecuperada, abrirEmergencia],
  );

  return (
    <ContextoDeRelevosYEmergencias.Provider value={valor}>
      {children}
      {abierta && (
        <ModalDeEmergencia
          emergenciaId={abierta.id}
          onCerrar={() => setAbierta(null)}
          onDevolverFoco={abierta.devolverFoco}
        />
      )}
    </ContextoDeRelevosYEmergencias.Provider>
  );
}
