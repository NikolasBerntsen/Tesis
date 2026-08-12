import { useState } from 'react';
import { cerrarSesion, clearSession, getToken } from './api';
import Console from './components/Console';
import LoginForm from './components/LoginForm';

export default function App() {
  const [authenticated, setAuthenticated] = useState(() => Boolean(getToken()));

  if (!authenticated) {
    return <LoginForm onLogin={() => setAuthenticated(true)} />;
  }
  return (
    <Console
      onLogout={async () => {
        // El aviso va primero porque necesita el token: es lo que deja el
        // FIELD_SESSION_CLOSED del operador de campo. Que no llegue no puede
        // dejar a nadie encerrado en una consola de la que quiso salir.
        await cerrarSesion().catch(() => {});
        clearSession();
        setAuthenticated(false);
      }}
    />
  );
}
