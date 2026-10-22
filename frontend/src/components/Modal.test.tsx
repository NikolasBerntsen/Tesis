import { afterEach, describe, it, expect, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal, { SALIDA_MS } from './Modal';

/**
 * Hay pantallas que abren un diálogo arriba de otro: elegir las rutas de una
 * base y, sin cerrar eso, dibujar una ruta nueva. Como cada diálogo escucha el
 * teclado en `document`, el teclado tiene que ser del de arriba y de nadie más.
 */
function DosDialogos({ cerrarAbajo, cerrarArriba }: { cerrarAbajo: () => void; cerrarArriba: () => void }) {
  const [arriba, setArriba] = useState(false);
  return (
    <>
      <Modal etiquetadoPor="t-abajo" onCerrar={cerrarAbajo}>
        <h2 id="t-abajo">Rutas de la base</h2>
        <button type="button" onClick={() => setArriba(true)}>
          Nueva ruta
        </button>
      </Modal>
      {arriba && (
        <Modal
          etiquetadoPor="t-arriba"
          onCerrar={() => {
            cerrarArriba();
            setArriba(false);
          }}
        >
          <h2 id="t-arriba">Editor</h2>
          <button type="button">Guardar</button>
        </Modal>
      )}
    </>
  );
}

/**
 * jsdom no implementa la pantalla completa: se la simula con un elemento
 * colgado del body que `document.fullscreenElement` nombra. `cambiar` deja
 * mover lo que nombra con el diálogo ya abierto.
 */
let enPantalla: Element | null = null;
function enPantallaCompleta(): HTMLElement {
  const pantalla = document.createElement('section');
  document.body.appendChild(pantalla);
  enPantalla = pantalla;
  Object.defineProperty(document, 'fullscreenElement', { get: () => enPantalla, configurable: true });
  return pantalla;
}
function cambiarPantallaCompleta(elemento: Element | null) {
  enPantalla = elemento;
}
/** Se saca para no ensuciar el resto de los tests, que corren sin pantalla completa. */
function sinPantallaCompleta() {
  delete (document as { fullscreenElement?: Element | null }).fullscreenElement;
  enPantalla?.remove();
  enPantalla = null;
}

describe('Modal apilado', () => {
  it('Escape cierra sólo el diálogo de arriba, y después el de abajo', async () => {
    const abajo = vi.fn();
    const arriba = vi.fn();
    render(<DosDialogos cerrarAbajo={abajo} cerrarArriba={arriba} />);

    await userEvent.click(screen.getByRole('button', { name: 'Nueva ruta' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);

    await userEvent.keyboard('{Escape}');
    expect(arriba).toHaveBeenCalledTimes(1);
    // el de abajo sigue abierto: perder lo elegido ahí sería el bug
    expect(abajo).not.toHaveBeenCalled();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    // ya sin el de arriba, el teclado vuelve a ser del que quedó
    await userEvent.keyboard('{Escape}');
    expect(abajo).toHaveBeenCalledTimes(1);
  });

  it('el tabulador queda atrapado en el diálogo de arriba', async () => {
    render(<DosDialogos cerrarAbajo={vi.fn()} cerrarArriba={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Nueva ruta' }));

    const guardar = screen.getByRole('button', { name: 'Guardar' });
    await userEvent.tab();
    expect(guardar).toHaveFocus();
    await userEvent.tab();
    // no se escapa al diálogo de abajo: vuelve al único foco que hay arriba
    expect(guardar).toHaveFocus();
  });
});

describe('Modal con formulario', () => {
  it('con enfocarPrimerCampo, el foco arranca en el primer campo y no en la cruz', () => {
    render(
      <Modal etiquetadoPor="t-form" enfocarPrimerCampo onCerrar={vi.fn()}>
        <h2 id="t-form">Nuevo dron</h2>
        <button type="button">Cerrar</button>
        <input aria-label="Desactivado" disabled />
        <input aria-label="Nombre" />
        <input aria-label="Modelo" />
      </Modal>,
    );
    expect(screen.getByLabelText('Nombre')).toHaveFocus();
  });

  it('sin campos que enfocar, el foco cae en la caja como siempre', () => {
    render(
      <Modal etiquetadoPor="t-sin" enfocarPrimerCampo onCerrar={vi.fn()}>
        <h2 id="t-sin">Aviso</h2>
        <button type="button">Entendido</button>
      </Modal>,
    );
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('sin la opción, el foco sigue yendo a la caja aunque haya campos', () => {
    render(
      <Modal etiquetadoPor="t-caja" onCerrar={vi.fn()}>
        <h2 id="t-caja">Sticker</h2>
        <input aria-label="Nombre" />
      </Modal>,
    );
    expect(screen.getByRole('dialog')).toHaveFocus();
  });
});

/**
 * Cerrar deja un eco que se desvanece. Los tests de todas las vistas corren
 * sin `matchMedia` (jsdom no lo trae), así que ahí el eco no existe y nadie
 * encuentra un diálogo de más: estos lo encienden a propósito.
 */
describe('Modal — salida animada', () => {
  function conMovimiento(permitido: boolean) {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: permitido && q.includes('no-preference') }));
  }

  function ecos(): HTMLElement[] {
    return [...document.body.querySelectorAll<HTMLElement>('.modal-saliendo')];
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    ecos().forEach((n) => n.remove());
    sinPantallaCompleta();
  });

  function Alternable({ conOtro = false }: { conOtro?: boolean }) {
    const [cual, setCual] = useState<'uno' | 'otro' | null>('uno');
    return (
      <>
        <button type="button" onClick={() => setCual('otro')}>
          Pasar al otro
        </button>
        {cual === 'uno' && (
          <Modal etiquetadoPor="t-uno" onCerrar={() => setCual(null)}>
            <h2 id="t-uno">Nuevo dron</h2>
            <input id="campo-uno" aria-label="Nombre" defaultValue="Delta" />
          </Modal>
        )}
        {conOtro && cual === 'otro' && (
          <Modal etiquetadoPor="t-otro" onCerrar={() => setCual(null)}>
            <h2 id="t-otro">Sticker</h2>
          </Modal>
        )}
      </>
    );
  }

  it('al cerrar deja una copia muda que se desvanece y se borra sola', async () => {
    conMovimiento(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Alternable />);

    await userEvent.keyboard('{Escape}');
    await act(async () => {}); // el eco se inserta en una microtarea, después del commit

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const [eco] = ecos();
    expect(eco).toBeDefined();
    expect(eco).toHaveClass('modal-fondo', 'modal-saliendo');
    // invisible para los lectores, sin foco posible y sin ids repetidos
    expect(eco).toHaveAttribute('aria-hidden', 'true');
    expect(eco).toHaveAttribute('inert');
    expect(eco.querySelector('[id]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(SALIDA_MS);
    });
    expect(ecos()).toHaveLength(0);
  });

  it('si en el mismo gesto se abre otro diálogo, el eco queda debajo del nuevo', async () => {
    conMovimiento(true);
    render(<Alternable conOtro />);

    // El botón está detrás del velo: se lo acciona directo para cerrar uno y
    // abrir otro en un mismo render, como el alta de un dron y su sticker.
    act(() => screen.getByRole('button', { name: 'Pasar al otro', hidden: true }).click());
    await act(async () => {});

    const nuevo = screen.getByRole('dialog', { name: 'Sticker' }).parentElement!;
    const [eco] = ecos();
    expect(eco.compareDocumentPosition(nuevo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('con movimiento reducido no hay eco: el diálogo se va de una', async () => {
    conMovimiento(false);
    render(<Alternable />);

    await userEvent.keyboard('{Escape}');
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(ecos()).toHaveLength(0);
  });

  it('en pantalla completa el eco queda donde vivía el diálogo, que es lo único que se pinta', async () => {
    conMovimiento(true);
    const pantalla = enPantallaCompleta();
    render(<Alternable />);

    await userEvent.keyboard('{Escape}');
    await act(async () => {});

    const [eco] = ecos();
    // Colgado del body se desvanecía detrás del elemento en pantalla completa.
    expect(eco.parentElement).toBe(pantalla);
  });

  it('si el contenedor se fue junto con el diálogo, el eco va al body', async () => {
    conMovimiento(true);
    const pantalla = enPantallaCompleta();
    render(<Alternable />);
    // La vista de pilotaje se cierra con la confirmación abierta adentro.
    pantalla.remove();

    await userEvent.keyboard('{Escape}');
    await act(async () => {});

    const [eco] = ecos();
    expect(eco.parentElement).toBe(document.body);
  });

  it('el desmontaje de prueba de StrictMode no deja ecos al abrir', async () => {
    conMovimiento(true);
    render(
      <StrictMode>
        <Alternable />
      </StrictMode>,
    );
    await act(async () => {});

    // el diálogo sigue abierto y no hay ninguna copia saliendo encima
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(ecos()).toHaveLength(0);
  });
});

describe('Modal con algo en pantalla completa', () => {
  afterEach(sinPantallaCompleta);

  function Despegar({ texto }: { texto: string }) {
    return (
      <Modal etiquetadoPor="t-completa" onCerrar={vi.fn()}>
        <h2 id="t-completa">Despegar</h2>
        <p>{texto}</p>
      </Modal>
    );
  }

  it('se monta adentro del elemento en pantalla completa, que es lo único que el navegador pinta', () => {
    const pantalla = enPantallaCompleta();
    render(<Despegar texto="Revisá alrededor" />);
    expect(pantalla.contains(screen.getByRole('dialog', { name: 'Despegar' }))).toBe(true);
  });

  it('el contenedor se elige al abrir: si la pantalla completa cambia, el diálogo no se muda ni se vuelve a montar', () => {
    const pantalla = enPantallaCompleta();
    const { rerender } = render(<Despegar texto="Revisá alrededor" />);
    const caja = screen.getByRole('dialog', { name: 'Despegar' });

    // Se sale de la pantalla completa con el diálogo abierto, y algo hace que
    // el dueño vuelva a renderizar.
    cambiarPantallaCompleta(null);
    rerender(<Despegar texto="Revisá alrededor, ya" />);

    // El mismo nodo, en el mismo lugar: mudarlo era montar otro diálogo encima
    // del que el operador estaba leyendo (y dejar el primero suelto).
    const ahora = screen.getByRole('dialog', { name: 'Despegar' });
    expect(ahora).toBe(caja);
    expect(pantalla.contains(ahora)).toBe(true);
    expect(ahora).toHaveTextContent('Revisá alrededor, ya');
  });

  it('un elemento en pantalla completa que ya salió de la página no sirve de contenedor', () => {
    const pantalla = enPantallaCompleta();
    pantalla.remove();
    render(<Despegar texto="Revisá alrededor" />);
    // Colgado de un nodo suelto, el diálogo no se vería nunca.
    expect(screen.getByRole('dialog', { name: 'Despegar' }).parentElement?.parentElement).toBe(document.body);
  });

  /*
   * requestFullscreen tarda hasta que el navegador avisa, y en ese rato la vista
   * de pilotaje ya deja apretar "Salir del control manual". El diálogo nace en
   * el body; cuando la pantalla completa entra, el navegador sólo pinta la
   * vista, y sin mudarse quedaba abierto, atrapando el teclado, pero invisible.
   */
  it('un diálogo abierto mientras la pantalla completa todavía entraba se muda adentro al entrar, con el foco', () => {
    render(
      <Modal etiquetadoPor="t-entrando" onCerrar={vi.fn()}>
        <h2 id="t-entrando">¿Salir del control manual?</h2>
        <button type="button" data-autofoco>
          Seguir piloteando
        </button>
      </Modal>,
    );
    expect(screen.getByRole('dialog').parentElement?.parentElement).toBe(document.body);

    const pantalla = enPantallaCompleta();
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(pantalla.contains(screen.getByRole('dialog', { name: '¿Salir del control manual?' }))).toBe(true);
    // La caja se armó de nuevo adentro: el foco no puede quedar en el body.
    expect(screen.getByRole('button', { name: 'Seguir piloteando' })).toHaveFocus();
  });

  it('salir de la pantalla completa no muda el diálogo', () => {
    const pantalla = enPantallaCompleta();
    render(<Despegar texto="Revisá alrededor" />);
    const caja = screen.getByRole('dialog', { name: 'Despegar' });

    cambiarPantallaCompleta(null);
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(screen.getByRole('dialog', { name: 'Despegar' })).toBe(caja);
    expect(pantalla.contains(caja)).toBe(true);
  });

  it('una pantalla completa que entra con el diálogo ya adentro de otra no lo mueve', () => {
    const primera = enPantallaCompleta();
    render(<Despegar texto="Revisá alrededor" />);
    const caja = screen.getByRole('dialog', { name: 'Despegar' });

    const otra = document.createElement('section');
    document.body.appendChild(otra);
    cambiarPantallaCompleta(otra);
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(primera.contains(screen.getByRole('dialog', { name: 'Despegar' }))).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Despegar' })).toBe(caja);
    otra.remove();
  });

  it('después de mudarse, el eco del cierre queda en la pantalla completa y no se deja otro al mudarse', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('no-preference') }));
    try {
      const { unmount } = render(<Despegar texto="Revisá alrededor" />);
      const pantalla = enPantallaCompleta();
      await act(async () => {
        document.dispatchEvent(new Event('fullscreenchange'));
      });
      // Mudarse no es cerrar: ningún eco en ningún lado.
      expect(document.querySelectorAll('.modal-saliendo')).toHaveLength(0);

      unmount();
      await act(async () => {}); // el eco se inserta en una microtarea
      const ecos = document.querySelectorAll('.modal-saliendo');
      expect(ecos).toHaveLength(1);
      expect(pantalla.contains(ecos[0])).toBe(true);
      ecos.forEach((n) => n.remove());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Modal: dónde arranca el foco', () => {
  it('un elemento marcado con data-autofoco gana sobre la caja y sobre el primer campo', () => {
    render(
      <Modal etiquetadoPor="t-conf" enfocarPrimerCampo onCerrar={vi.fn()}>
        <h2 id="t-conf">Eliminar la base</h2>
        <input aria-label="Motivo" />
        <button type="button" data-autofoco>
          Cancelar
        </button>
        <button type="button">Eliminar</button>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  });

  it('con todo apagado, el tabulador se queda en la caja en vez de escaparse', async () => {
    render(
      <>
        <button type="button">Atrás del velo</button>
        <Modal etiquetadoPor="t-apagado" onCerrar={vi.fn()}>
          <h2 id="t-apagado">Eliminando…</h2>
          <button type="button" disabled>
            Cancelar
          </button>
        </Modal>
      </>,
    );
    const caja = screen.getByRole('dialog');
    expect(caja).toHaveFocus();
    await userEvent.tab();
    expect(caja).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(caja).toHaveFocus();
  });
});
