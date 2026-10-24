import escudo from '../assets/escudo-400.webp';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { login } from '../api';

export default function LoginForm({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const campoUsuario = useRef<HTMLInputElement>(null);

  // La pantalla de ingreso no tiene otra cosa que hacer que escribir el
  // usuario, así que el foco arranca ahí. Va por código y no con `autoFocus`,
  // que el análisis de accesibilidad (Sonar) marca en cualquier lado: acá mover
  // el foco solo es justo lo que espera quien abre la consola.
  useEffect(() => {
    campoUsuario.current?.focus();
  }, []);

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
        <img className="login-escudo" src={escudo} alt="" />
        {/* La misma marca que la barra de la consola: el nombre escrito como
            se dice (es lo que anuncia el lector de pantalla) y las mayúsculas
            y los colores, de la hoja. */}
        <div className="marca-textos login-marca">
          <h1 className="marca-nombre">
            Alta <span className="marca-en">en el</span> <span className="marca-cielo">Cielo</span>
          </h1>
          <p className="marca-lema">Comando de drones</p>
        </div>
        {/* La filigrana separa el encabezado de los campos como el grabado de
            una placa: se tiene que adivinar, nunca competir con el dato. */}
        <hr className="regla-ornamental" />
        {/* El rótulo va en su <span>: texto suelto y campo en renglones
            distintos dejan ambiguo si entre los dos va un espacio. */}
        <label>
          <span>Usuario</span>
          <input
            ref={campoUsuario}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          <span>Contraseña</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {/* role=alert: el rechazo de credenciales tiene que anunciarse solo,
            porque el foco se queda en el campo y nadie lo va a ir a buscar. */}
        {/* El mismo aviso que el resto de los errores de la consola: el texto
            rojo suelto de antes se perdía contra el mármol. */}
        {error && (
          <p className="aviso malo login-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </div>
  );
}
