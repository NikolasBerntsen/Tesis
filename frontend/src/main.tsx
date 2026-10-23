// Las tres tipografías viajan con la consola (ver --fuente-* en tokens.css):
// sin pedidos a Google, y en una red cerrada se ve igual. Sólo los pesos que
// usan las hojas (500 a 700; Inter es variable y trae todos en un archivo):
// el navegador baja cada uno recién cuando un texto lo pide, pero cada peso
// de más es un archivo más en el armado.
import '@fontsource/cinzel/500.css';
import '@fontsource/cinzel/600.css';
import '@fontsource/cinzel/700.css';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/700.css';
import '@fontsource-variable/inter';
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
