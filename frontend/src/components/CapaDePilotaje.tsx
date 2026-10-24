import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';

/**
 * Dónde se cuelga lo que tiene que verse ENCIMA de la vista de pilotaje: el
 * pedido de control que le llega a quien está volando (AvisosDelControl).
 *
 * La vista de pilotaje deja inerte todo lo que hay en la página al abrirse, y
 * en pantalla completa el navegador pinta sólo ella: un aviso colgado del body
 * quedaría inerte, o directamente invisible, justo cuando el piloto tiene que
 * contestarlo. La vista se anota acá al abrirse y los avisos van adentro suyo;
 * sin la vista abierta, al body. Los diálogos también (Modal.tsx): la vista es
 * una capa fija con su propio z-index, y lo que se apila adentro solo compite
 * con lo que está adentro con él.
 */
interface VistaAbierta {
  /** El elemento de la vista de pilotaje abierta, o null. */
  capa: HTMLElement | null;
  /** El dron que se vuela en ella; null sin la vista, o si no lo dijo. */
  dron: string | null;
}

interface Capa extends VistaAbierta {
  anotar: (elemento: HTMLElement | null, dron: string | null) => void;
}

const SIN_VISTA: VistaAbierta = { capa: null, dron: null };

// Fuera de un proveedor no hay capa: la vista se prueba suelta y los avisos
// van al body, que es lo de siempre.
const ContextoDeLaCapa = createContext<Capa>({ ...SIN_VISTA, anotar: () => {} });

export function ProveedorDeCapaDePilotaje({ children }: Readonly<{ children: ReactNode }>) {
  const [vista, setVista] = useState<VistaAbierta>(SIN_VISTA);
  const anotar = useCallback((capa: HTMLElement | null, dron: string | null) => setVista({ capa, dron }), []);
  const valor = useMemo(() => ({ ...vista, anotar }), [vista, anotar]);
  return <ContextoDeLaCapa.Provider value={valor}>{children}</ContextoDeLaCapa.Provider>;
}

/** El elemento donde colgar un aviso que no puede quedar abajo del pilotaje. */
export function useCapaSobreElPilotaje(): Element {
  return useContext(ContextoDeLaCapa).capa ?? document.body;
}

/** Si la vista de pilotaje está abierta, y qué dron se vuela en ella (null si no lo dijo). */
export function useVistaDePilotaje(): { abierta: boolean; dron: string | null } {
  const { capa, dron } = useContext(ContextoDeLaCapa);
  return { abierta: capa !== null, dron };
}

/** La vista de pilotaje se anota mientras está abierta, con el dron que se vuela. */
export function useAnotarCapaDePilotaje(raiz: RefObject<HTMLElement>, dron: string | null = null) {
  const { anotar } = useContext(ContextoDeLaCapa);
  useEffect(() => {
    anotar(raiz.current, dron);
    return () => anotar(null, null);
  }, [anotar, raiz, dron]);
}
