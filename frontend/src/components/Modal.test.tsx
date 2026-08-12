import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from './Modal';

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
