import { useState } from 'react';
import { clearSession, getToken } from './api';
import Dashboard from './components/Dashboard';
import LoginForm from './components/LoginForm';

export default function App() {
  const [authenticated, setAuthenticated] = useState(() => Boolean(getToken()));

  if (!authenticated) {
    return <LoginForm onLogin={() => setAuthenticated(true)} />;
  }
  return (
    <Dashboard
      onLogout={() => {
        clearSession();
        setAuthenticated(false);
      }}
    />
  );
}
