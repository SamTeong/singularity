import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `@/` → web/src, so imports are location-independent (no fragile ../../..).
// Node's test runner does NOT resolve this alias — *.test.mjs files must keep
// relative imports to their co-located source.
const srcDir = fileURLToPath(new URL('./src', import.meta.url));

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
  resolve: { alias: { '@': srcDir } },
  server: {
    host: '127.0.0.1',
    port: 5317,
    open: false,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
      '/health': 'http://127.0.0.1:4317',
      '/agent-stats': 'http://127.0.0.1:4317',
      '/sysstats': 'http://127.0.0.1:4317',
      '/fs': 'http://127.0.0.1:4317',
      '/procs': 'http://127.0.0.1:4317',
      '/restart': 'http://127.0.0.1:4317',
      '/models': 'http://127.0.0.1:4317',
      '/env': 'http://127.0.0.1:4317',
      '/skill-scopes': 'http://127.0.0.1:4317',
      '/skills': 'http://127.0.0.1:4317',
      '/skill': 'http://127.0.0.1:4317',
      '/config': 'http://127.0.0.1:4317',
      '/capabilities': 'http://127.0.0.1:4317',
      '/hooks': 'http://127.0.0.1:4317',
      '/rules': 'http://127.0.0.1:4317',
      '/memory': 'http://127.0.0.1:4317',
      '/wiki': 'http://127.0.0.1:4317',
      '/sessions': 'http://127.0.0.1:4317',
      '/subagents': 'http://127.0.0.1:4317',
      '/session': 'http://127.0.0.1:4317',
      '/usage': 'http://127.0.0.1:4317',
      '/claude': 'http://127.0.0.1:4317',
      '/spend': 'http://127.0.0.1:4317',
      '/tasks': 'http://127.0.0.1:4317',
      '/crons': 'http://127.0.0.1:4317',
      '/background': 'http://127.0.0.1:4317',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split stable vendor code into cacheable chunks (index was ~1MB minified).
        // React/MUI/emotion/@zapac stay in ONE chunk: splitting them apart put a
        // circular dep across chunk boundaries → TDZ crash in the minified prod
        // build ("Cannot access X before initialization"). xterm is independent.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]@xterm[\\/]/.test(id)) return 'xterm';
          if (/[\\/](react|react-dom|scheduler|@mui|@emotion|@zapac)[\\/]/.test(id)) return 'vendor';
        },
      },
    },
  },
});
