import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import mockAssetsPlugin from './mock-assets.plugin.mjs';

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
    // Mirrors the daemon's displayHome() (server/index.mjs) — dev proxies /env
    // to the daemon, so honouring the override in only one of them would leave
    // the injected home and the route disagreeing.
    const home = process.env.SING_HOME_DISPLAY || homedir();
    let out = html.replace('</head>', `<script>window.__SING_HOME__=${JSON.stringify(home)};</script></head>`);
    if (t) out = out.replace('</head>', `<script>window.__SING_TOKEN__=${JSON.stringify(t)};</script></head>`);
    return out;
  },
};

export default defineConfig(({ mode }) => ({
  root: 'web',
  plugins: [react(), singTokenInject, ...(mode === 'mock' ? [mockAssetsPlugin()] : [])],
  resolve: { alias: { '@': srcDir } },
  server: {
    host: '127.0.0.1',
    port: vitePort,
    strictPort: true,
    open: false,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${backendPort}`, ws: true },
      '/api': apiTarget,
    },
  },
  build: {
    // mock mode emits to a sibling dir so `build:mock` can never clobber the
    // real production output (`web/dist`).
    outDir: mode === 'mock' ? 'dist-mock' : 'dist',
    // Default target (es2020) predates top-level await; main.jsx's guarded
    // `await import('@/mock/index.js')` only survives esbuild's dead-code
    // elimination in mock mode (VITE_MOCK=1), so only mock mode needs a
    // target new enough to allow it. Production keeps Vite's default.
    target: mode === 'mock' ? 'es2022' : undefined,
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
          // `react-router(?:-dom)?`: the trailing [\\/] means a bare `react-router`
          // alternative would miss node_modules/react-router-dom/, splitting the
          // router across chunks — the same TDZ hazard as above.
          if (/[\\/](react|react-dom|react-router(?:-dom)?|scheduler|@mui|@emotion|@zapac)[\\/]/.test(id)) return 'vendor';
        },
      },
    },
  },
}));
