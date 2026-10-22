import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EsqueletoDeTabla, EstadoVacio } from './EstadosDeVista';

describe('EsqueletoDeTabla', () => {
  it('se anuncia con su texto y dibuja las franjas fuera del árbol de accesibilidad', () => {
    const { container } = render(<EsqueletoDeTabla texto="Trayendo los drones…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Trayendo los drones…');
    const filas = container.querySelector('.esqueleto-filas') as HTMLElement;
    expect(filas).toHaveAttribute('aria-hidden', 'true');
    // Por defecto, tres filas: lo que mide una tabla corta.
    expect(filas.querySelectorAll('.esqueleto-fila')).toHaveLength(3);
  });

  it('acepta cuántas filas reservar', () => {
    const { container } = render(<EsqueletoDeTabla texto="Trayendo el registro…" filas={5} />);
    expect(container.querySelectorAll('.esqueleto-fila')).toHaveLength(5);
  });
});

describe('EstadoVacio', () => {
  it('dice qué falta y, debajo, qué hacer', () => {
    const { container } = render(<EstadoVacio titulo="Todavía no hay bases.">Con «Nueva base» la das de alta.</EstadoVacio>);
    expect(screen.getByText('Todavía no hay bases.')).toHaveClass('vacio');
    expect(screen.getByText('Con «Nueva base» la das de alta.')).toHaveClass('muted');
    expect(container.firstElementChild).toHaveClass('vacio-guia');
  });

  it('sin guía es el cartel solo', () => {
    const { container } = render(<EstadoVacio titulo="No hay usuarios para mostrar." />);
    expect(container.firstElementChild).toHaveClass('vacio');
    expect(container.querySelector('.vacio-guia')).toBeNull();
  });
});
