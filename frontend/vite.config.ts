import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// El proxy evita configurar CORS/URLs en el frontend: la app habla siempre con
// su propio origen y Vite reenvía al backend. En Docker el backend es otro
// contenedor, por eso el destino se toma de BACKEND_URL.
const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    // host: true expone el servidor fuera del contenedor / a la LAN
    host: true,
    port: 5173,
    proxy: {
      '/api': backendUrl,
      '/ws': { target: backendUrl.replace(/^http/, 'ws'), ws: true },
    },
  },
});
