import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// El proxy evita configurar CORS/URLs en desarrollo: el frontend habla
// siempre con su propio origen y Vite reenvía al backend en :4000.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
