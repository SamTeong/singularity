import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Phase 1: Vite dev server proxies WS to the daemon on 4317.
// Dev-only mirror of the daemon's serve-time SING_TOKEN injection (index.mjs) —
// without it the Vite-served shell has no window.__SING_TOKEN__ and every data
// call 401s. apply:'serve' keeps the token out of the built dist/index.html
// (the daemon injects at serve time there; baking it into dist would persist it).
const singTokenInject = {
  name: 'sing-token-inject',
  apply: 'serve',
  transformIndexHtml(html) {
    const t = process.env.SING_TOKEN;
    return t ? html.replace('</head>', `<script>window.__SING_TOKEN__=${JSON.stringify(t)};</script></head>`) : html;
  },
};

export default defineConfig({
  root: 'web',
  plugins: [react(), singTokenInject],
  server: {
    host: '127.0.0.1',
    port: 5317,
    open: false,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
      '/health': 'http://127.0.0.1:4317',
      '/agent-stats': 'http://127.0.0.1:4317',
      '/fs': 'http://127.0.0.1:4317',
      '/procs': 'http://127.0.0.1:4317',
      '/models': 'http://127.0.0.1:4317',
      '/skill-scopes': 'http://127.0.0.1:4317',
      '/skills': 'http://127.0.0.1:4317',
      '/skill': 'http://127.0.0.1:4317',
      '/config': 'http://127.0.0.1:4317',
      '/memory': 'http://127.0.0.1:4317',
      '/wiki': 'http://127.0.0.1:4317',
      '/sessions': 'http://127.0.0.1:4317',
      '/session': 'http://127.0.0.1:4317',
      '/usage': 'http://127.0.0.1:4317',
      '/spend': 'http://127.0.0.1:4317',
      '/tasks': 'http://127.0.0.1:4317',
      '/crons': 'http://127.0.0.1:4317',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split stable vendor code into its own cacheable chunks (index was ~1MB minified).
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (/[\\/](@mui|@emotion)[\\/]/.test(id)) return 'mui';
          if (/[\\/]@xterm[\\/]/.test(id)) return 'xterm';
        },
      },
    },
  },
});
