import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import EncabezadoDeVista from './EncabezadoDeVista';

describe('EncabezadoDeVista', () => {
  it('título, filtros al medio y, a la derecha, las opciones antes de la acción principal', () => {
    const { container } = render(
      <EncabezadoDeVista
        titulo="Usuarios"
        subtitulo="3 cuentas"
        filtros={<input aria-label="Buscar usuarios" />}
        opciones={<button type="button">Ver eliminados</button>}
        accion={<button type="button">Nuevo usuario</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Usuarios' })).toBeInTheDocument();
    expect(screen.getByText('3 cuentas')).toHaveClass('vista-subtitulo');
    expect(container.querySelector('.vista-filtros')).toContainElement(screen.getByRole('textbox'));

    // El orden del marcado es el del tabulador: la acción principal, última.
    const acciones = container.querySelector('.vista-acciones') as HTMLElement;
    expect(within(acciones).getAllByRole('button').map((b) => b.textContent)).toEqual(['Ver eliminados', 'Nuevo usuario']);
    expect(container.querySelector('.vista-opciones')).toContainElement(screen.getByRole('button', { name: 'Ver eliminados' }));
  });

  it('sin filtros ni acciones queda sólo el título, sin cajas vacías', () => {
    const { container } = render(<EncabezadoDeVista titulo="Bases" opciones={false} accion={false} />);
    expect(screen.getByRole('heading', { name: 'Bases' })).toBeInTheDocument();
    expect(container.querySelector('.vista-subtitulo')).toBeNull();
    expect(container.querySelector('.vista-filtros')).toBeNull();
    expect(container.querySelector('.vista-acciones')).toBeNull();
  });

  it('una acción principal sola no arma el grupo de opciones', () => {
    const { container } = render(<EncabezadoDeVista titulo="Drones" accion={<button type="button">Nuevo dron</button>} />);
    expect(container.querySelector('.vista-acciones')).toContainElement(screen.getByRole('button', { name: 'Nuevo dron' }));
    expect(container.querySelector('.vista-opciones')).toBeNull();
  });
});
