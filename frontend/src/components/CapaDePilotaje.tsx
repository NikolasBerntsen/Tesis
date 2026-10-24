import { createContext, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';

/**
 * Dónde se cuelga lo que tiene que verse ENCIMA de la vista de pilotaje: el
 * pedido de control que le llega a quien está volando (AvisosDelControl).
 *
 * La vista de pilotaje deja inerte todo lo que hay en la página al abrirse, y
 * en pantalla completa el navegador pinta sólo ella: un aviso colgado del body
 * quedaría inerte, o directamente invisible, justo cuando el piloto tiene que
 * contestarlo. La vista se anota acá al abrirse y los avisos van adentro suyo;
 * sin la vista abierta, al body.
 */
interface Capa {
  /** El elemento de la vista de pilotaje abierta, o null. */
  capa: HTMLElement | null;
  anotar: (elemento: HTMLElement | null) => void;
}

// Fuera de un proveedor no hay capa: la vista se prueba suelta y los avisos
// van al body, que es lo de siempre.
const ContextoDeLaCapa = createContext<Capa>({ capa: null, anotar: () => {} });

export function ProveedorDeCapaDePilotaje({ children }: Readonly<{ children: ReactNode }>) {
  const [capa, anotar] = useState<HTMLElement | null>(null);
  const valor = useMemo(() => ({ capa, anotar }), [capa]);
  return <ContextoDeLaCapa.Provider value={valor}>{children}</ContextoDeLaCapa.Provider>;
}

/** El elemento donde colgar un aviso que no puede quedar abajo del pilotaje. */
export function useCapaSobreElPilotaje(): Element {
  return useContext(ContextoDeLaCapa).capa ?? document.body;
}

/** La vista de pilotaje se anota mientras está abierta. */
export function useAnotarCapaDePilotaje(raiz: RefObject<HTMLElement>) {
  const { anotar } = useContext(ContextoDeLaCapa);
  useEffect(() => {
    anotar(raiz.current);
    return () => anotar(null);
  }, [anotar, raiz]);
}
