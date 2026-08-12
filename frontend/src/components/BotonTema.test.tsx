import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BotonTema from './BotonTema';

describe('BotonTema', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.tema;
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
  });

  it('desde el modo claro ofrece ir al oscuro, y al tocarlo cambia el documento', async () => {
    render(<BotonTema />);
    const boton = screen.getByRole('button', { name: /modo oscuro/i });
    await userEvent.click(boton);

    expect(document.documentElement.dataset.tema).toBe('oscuro');
    expect(localStorage.getItem('cc_tema')).toBe('oscuro');
    // y ahora ofrece la vuelta
    expect(screen.getByRole('button', { name: /modo claro/i })).toBeInTheDocument();
  });

  it('arranca en oscuro si es lo que estaba guardado', () => {
    localStorage.setItem('cc_tema', 'oscuro');
    render(<BotonTema />);
    expect(screen.getByRole('button', { name: /modo claro/i })).toBeInTheDocument();
  });
});
