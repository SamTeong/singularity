import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Phase 1: Vite dev server proxies WS to the daemon on 4317.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5317,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
      '/health': 'http://127.0.0.1:4317',
      '/agent-stats': 'http://127.0.0.1:4317',
      '/fs': 'http://127.0.0.1:4317',
      '/procs': 'http://127.0.0.1:4317',
      '/models': 'http://127.0.0.1:4317',
      '/skill-scopes': 'http://127.0.0.1:4317',
      '/config': 'http://127.0.0.1:4317',
      '/memory': 'http://127.0.0.1:4317',
      '/usage': 'http://127.0.0.1:4317',
      '/tasks': 'http://127.0.0.1:4317',
      '/crons': 'http://127.0.0.1:4317',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
