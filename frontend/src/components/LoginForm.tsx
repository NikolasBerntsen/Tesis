import { useState, type FormEvent } from 'react';
import { login } from '../api';

export default function LoginForm({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de autenticación');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrapper">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Comando Central</h1>
        <p className="login-subtitle">Sistema de patrullaje con drones</p>
        {/* La filigrana separa el encabezado de los campos como el grabado de
            una placa: se tiene que adivinar, nunca competir con el dato. */}
        <hr className="regla-ornamental" />
        <label>
          Usuario
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {/* role=alert: el rechazo de credenciales tiene que anunciarse solo,
            porque el foco se queda en el campo y nadie lo va a ir a buscar. */}
        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </div>
  );
}
