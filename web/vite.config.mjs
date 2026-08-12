import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `@/` → web/src, so imports are location-independent (no fragile ../../..).
// Node's test runner does NOT resolve this alias — *.test.mjs files must keep
// relative imports to their co-located source.
const srcDir = fileURLToPath(new URL('./src', import.meta.url));
const backendPort = process.env.DAEMON_PORT ?? '4317';
const vitePort = Number(process.env.VITE_PORT ?? 5317);
const apiTarget = `http://127.0.0.1:${backendPort}`;

// Phase 1: Vite dev server proxies WS to the daemon on DAEMON_PORT.
// Dev-only mirror of the daemon's serve-time SING_TOKEN + home injection
// (index.mjs) — without it the Vite-served shell has no window.__SING_TOKEN__
// (every data call 401s) and no window.__SING_HOME__ (`~` never resolves).
// apply:'serve' keeps both out of the built dist/index.html (the daemon injects
// at serve time there; baking the token into dist would persist it).
const singTokenInject = {
  name: 'sing-token-inject',
  apply: 'serve',
  transformIndexHtml(html) {
    const t = process.env.SING_TOKEN;
    let out = html.replace('</head>', `<script>window.__SING_HOME__=${JSON.stringify(homedir())};</script></head>`);
    if (t) out = out.replace('</head>', `<script>window.__SING_TOKEN__=${JSON.stringify(t)};</script></head>`);
    return out;
  },
};

export default defineConfig({
  root: 'web',
  plugins: [react(), singTokenInject],
  resolve: { alias: { '@': srcDir } },
  server: {
    host: '127.0.0.1',
    port: vitePort,
    strictPort: true,
    open: false,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${backendPort}`, ws: true },
      '/health': apiTarget,
      '/agent-stats': apiTarget,
      '/sysstats': apiTarget,
      '/fs': apiTarget,
      '/procs': apiTarget,
      '/restart': apiTarget,
      '/models': apiTarget,
      '/env': apiTarget,
      '/skill-scopes': apiTarget,
      '/skills': apiTarget,
      '/skill': apiTarget,
      '/config': apiTarget,
      '/codex-config': apiTarget,
      '/capabilities': apiTarget,
      '/hooks': apiTarget,
      '/rules': apiTarget,
      '/memory': apiTarget,
      '/wiki': apiTarget,
      '/sessions': apiTarget,
      '/subagents': apiTarget,
      '/session': apiTarget,
      '/usage': apiTarget,
      '/status': apiTarget,
      '/claude': apiTarget,
      '/usagereport': apiTarget,
      '/tasks': apiTarget,
      '/crons': apiTarget,
      '/background': apiTarget,
      '/history': apiTarget,
      '/keys': apiTarget,
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
