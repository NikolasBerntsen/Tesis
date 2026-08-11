import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { clearSession, getToken } from './api';

vi.mock('./api', () => ({ getToken: vi.fn(), clearSession: vi.fn() }));
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

describe('App', () => {
  beforeEach(() => {
    getTokenMock.mockReset();
    clearSessionMock.mockReset();
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

  it('cierra sesión y vuelve al login', async () => {
    getTokenMock.mockReturnValue('tok');
    render(<App />);
    await userEvent.click(screen.getByText('salir-mock'));
    expect(clearSessionMock).toHaveBeenCalled();
    expect(screen.getByText('login-mock')).toBeInTheDocument();
  });
});
