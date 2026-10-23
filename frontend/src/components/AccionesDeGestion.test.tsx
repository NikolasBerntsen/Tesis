import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BotonEditar, BotonEliminar, BotonRestaurar } from './AccionesDeGestion';

describe('acciones de las vistas de gestión', () => {
  it('Editar es el lápiz: se anuncia por su nombre y lo muestra bajo el mouse', async () => {
    const editar = vi.fn();
    render(<BotonEditar onClick={editar} />);
    const boton = screen.getByRole('button', { name: 'Editar' });
    expect(boton).toHaveAttribute('title', 'Editar');
    expect(boton).toHaveClass('icono-boton', 'cuadrado');
    // El dibujo no habla: el nombre lo pone el botón.
    expect(boton.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(boton).toHaveTextContent('');
    await userEvent.click(boton);
    expect(editar).toHaveBeenCalledOnce();
  });

  it('el nombre se puede precisar cuando el grupo no alcanza ("Editar a oper1")', () => {
    render(<BotonEditar etiqueta="Editar a oper1" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Editar a oper1' })).toHaveAttribute('title', 'Editar a oper1');
  });

  it('Eliminar es el tacho, con el filo óxido de lo que borra', async () => {
    const eliminar = vi.fn();
    render(<BotonEliminar onClick={eliminar} />);
    const boton = screen.getByRole('button', { name: 'Eliminar' });
    expect(boton).toHaveClass('dismiss');
    expect(boton).toHaveAttribute('title', 'Eliminar');
    await userEvent.click(boton);
    expect(eliminar).toHaveBeenCalledOnce();
  });

  it('Restaurar va escrito, con la flecha que vuelve; en una fila de tabla, chico', () => {
    const { rerender } = render(<BotonRestaurar onClick={() => {}} />);
    const boton = screen.getByRole('button', { name: 'Restaurar' });
    expect(boton).toHaveTextContent('Restaurar');
    expect(boton).not.toHaveClass('chico');
    expect(boton.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    rerender(<BotonRestaurar chico onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Restaurar' })).toHaveClass('chico');
  });
});
