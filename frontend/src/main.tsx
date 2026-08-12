import 'leaflet/dist/leaflet.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { aplicarTema, temaGuardado } from './tema';

// El tema se fija antes del primer pintado: si se aplicara dentro de React,
// la consola en oscuro entraría con un destello claro.
aplicarTema(temaGuardado());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
