import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import EditableName from './EditableName';

describe('EditableName', () => {
  it('muestra el nombre y un botón para renombrar', () => {
    render(<EditableName name="Alfa" onRename={() => {}} />);
    expect(screen.getByText('Alfa')).toBeInTheDocument();
    expect(screen.getByTitle('Renombrar dron')).toBeInTheDocument();
  });

  it('entra en edición y guarda un nombre nuevo con el botón de guardar', async () => {
    const onRename = vi.fn();
    render(<EditableName name="Alfa" onRename={onRename} />);
    await userEvent.click(screen.getByTitle('Renombrar dron'));

    const input = screen.getByDisplayValue('Alfa');
    await userEvent.clear(input);
    await userEvent.type(input, 'Bravo');
    await userEvent.click(screen.getByTitle('Guardar'));

    expect(onRename).toHaveBeenCalledWith('Bravo');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('guarda con la tecla Enter', async () => {
    const onRename = vi.fn();
    render(<EditableName name="Alfa" onRename={onRename} />);
    await userEvent.click(screen.getByTitle('Renombrar dron'));
    const input = screen.getByDisplayValue('Alfa');
    await userEvent.clear(input);
    await userEvent.type(input, 'Charlie{Enter}');
    expect(onRename).toHaveBeenCalledWith('Charlie');
  });

  it('no renombra si el nombre no cambió', async () => {
    const onRename = vi.fn();
    render(<EditableName name="Alfa" onRename={onRename} />);
    await userEvent.click(screen.getByTitle('Renombrar dron'));
    await userEvent.click(screen.getByTitle('Guardar'));
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('Alfa')).toBeInTheDocument();
  });

  it('no renombra si queda vacío', async () => {
    const onRename = vi.fn();
    render(<EditableName name="Alfa" onRename={onRename} />);
    await userEvent.click(screen.getByTitle('Renombrar dron'));
    await userEvent.clear(screen.getByDisplayValue('Alfa'));
    await userEvent.click(screen.getByTitle('Guardar'));
    expect(onRename).not.toHaveBeenCalled();
  });

  it('cancela con la tecla Escape sin renombrar', async () => {
    const onRename = vi.fn();
    render(<EditableName name="Alfa" onRename={onRename} />);
    await userEvent.click(screen.getByTitle('Renombrar dron'));
    const input = screen.getByDisplayValue('Alfa');
    await userEvent.type(input, 'XYZ{Escape}');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('Alfa')).toBeInTheDocument();
  });

  it('cancela con el botón de cancelar', async () => {
    const onRename = vi.fn();
    render(<EditableName name="Alfa" onRename={onRename} />);
    await userEvent.click(screen.getByTitle('Renombrar dron'));
    await userEvent.click(screen.getByTitle('Cancelar'));
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('Alfa')).toBeInTheDocument();
  });
});
