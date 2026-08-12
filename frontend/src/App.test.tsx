import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { cerrarSesion, clearSession, getToken } from './api';

vi.mock('./api', () => ({ getToken: vi.fn(), clearSession: vi.fn(), cerrarSesion: vi.fn() }));
vi.mock('./components/Console', () => ({
  default: ({ onLogout }: { onLogout: () => void }) => (
    <button onClick={onLogout}>salir-mock</button>
  ),
}));
vi.mock('./components/LoginForm', () => ({
  default: ({ onLogin }: { onLogin: () => void }) => (
    <button onClick={onLogin}>login-mock</button>
  ),
}));

const getTokenMock = vi.mocked(getToken);
const clearSessionMock = vi.mocked(clearSession);
const cerrarSesionMock = vi.mocked(cerrarSesion);

describe('App', () => {
  beforeEach(() => {
    getTokenMock.mockReset();
    clearSessionMock.mockReset();
    cerrarSesionMock.mockReset();
    cerrarSesionMock.mockResolvedValue();
  });

  it('muestra el login cuando no hay sesión y entra tras loguearse', async () => {
    getTokenMock.mockReturnValue(null);
    render(<App />);
    expect(screen.getByText('login-mock')).toBeInTheDocument();

    await userEvent.click(screen.getByText('login-mock'));
    expect(screen.getByText('salir-mock')).toBeInTheDocument();
  });

  it('muestra la consola directamente cuando ya hay token', () => {
    getTokenMock.mockReturnValue('tok');
    render(<App />);
    expect(screen.getByText('salir-mock')).toBeInTheDocument();
  });

  it('avisa al backend, cierra sesión y vuelve al login', async () => {
    getTokenMock.mockReturnValue('tok');
    render(<App />);
    await userEvent.click(screen.getByText('salir-mock'));
    // El aviso va antes de borrar el token: es lo que deja el
    // FIELD_SESSION_CLOSED del operador de campo.
    expect(cerrarSesionMock).toHaveBeenCalled();
    expect(clearSessionMock).toHaveBeenCalled();
    expect(await screen.findByText('login-mock')).toBeInTheDocument();
  });

  it('vuelve al login aunque el aviso de salida falle', async () => {
    getTokenMock.mockReturnValue('tok');
    cerrarSesionMock.mockRejectedValue(new Error('sin red'));
    render(<App />);
    await userEvent.click(screen.getByText('salir-mock'));
    expect(await screen.findByText('login-mock')).toBeInTheDocument();
  });
});
