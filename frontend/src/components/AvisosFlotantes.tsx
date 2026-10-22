import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Lo que dura en pantalla un aviso. Es el mismo valor que `--duracion-aviso`
 * en tokens.css, que es lo que mide la animación de salida: si uno cambia sin
 * el otro, el aviso se corta antes de desvanecerse o se queda quieto un rato.
 */
export const DURACION_AVISO_MS = 4500;

type Avisar = (texto: string) => void;

/**
 * Fuera de un proveedor no hay dónde mostrar nada, y eso no es un error: las
 * vistas se prueban y se pueden usar sueltas. Avisar ahí simplemente no hace
 * nada, y la vista sigue andando igual.
 */
const ContextoDeAvisos = createContext<Avisar>(() => {});

/** Para decir "listo" después de guardar, eliminar o restaurar algo. */
export function useAvisar(): Avisar {
  return useContext(ContextoDeAvisos);
}

/**
 * Los avisos de la consola: una línea chica abajo a la derecha que confirma lo
 * que acaba de pasar ("Dron Alfa eliminado") y se va sola. Antes guardar o
 * eliminar era silencioso: la fila cambiaba (o desaparecía) y nadie decía si
 * había andado, que es justo lo que hace volver a apretar el botón.
 *
 * No bloquea ni se toca: no lleva botones, deja pasar el mouse y no se lleva el
 * foco. Se anuncia por la región viva (`role="status"`, que es cortés: espera a
 * que el lector termine lo que está diciendo). La región está SIEMPRE en el
 * DOM, vacía o no: los lectores de pantalla sólo anuncian los cambios de una
 * región que ya existía, no una que aparece con el texto adentro.
 *
 * Los errores no pasan por acá: se quedan donde se produjeron, al lado del
 * botón o adentro del diálogo, que es donde el operador está mirando.
 */
export function ProveedorDeAvisos({ children }: { children: ReactNode }) {
  const [aviso, setAviso] = useState<{ id: number; texto: string } | null>(null);
  const contador = useRef(0);

  // El id cambia aunque el texto se repita: dos eliminaciones seguidas del
  // mismo nombre tienen que anunciarse dos veces y reiniciar el reloj.
  const avisar = useCallback<Avisar>((texto) => {
    contador.current += 1;
    setAviso({ id: contador.current, texto });
  }, []);

  useEffect(() => {
    if (!aviso) return;
    const id = setTimeout(() => setAviso(null), DURACION_AVISO_MS);
    return () => clearTimeout(id);
  }, [aviso]);

  return (
    <ContextoDeAvisos.Provider value={avisar}>
      {children}
      <div className="avisos-flotantes" role="status" aria-live="polite" aria-atomic="true">
        {aviso && (
          <p key={aviso.id} className="aviso-flotante">
            {aviso.texto}
          </p>
        )}
      </div>
    </ContextoDeAvisos.Provider>
  );
}
