import { useState } from 'react';
import { clearSession, getToken } from './api';
import Console from './components/Console';
import LoginForm from './components/LoginForm';

export default function App() {
  const [authenticated, setAuthenticated] = useState(() => Boolean(getToken()));

  if (!authenticated) {
    return <LoginForm onLogin={() => setAuthenticated(true)} />;
  }
  return (
    <Console
      onLogout={() => {
        clearSession();
        setAuthenticated(false);
      }}
    />
  );
}
