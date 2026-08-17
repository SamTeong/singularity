import { test } from 'node:test';
import assert from 'node:assert/strict';
import viteConfig from '../vite.config.mjs';

// vite.config.mjs exports defineConfig(fn); defineConfig is a passthrough, so
// the default export IS the ({ mode }) => ({ ... }) factory. Calling it
// resolves the config object (plugins + server) for a mode without spinning up
// Vite — which is the whole "in-browser vs daemon" surface we can statically
// assert. Keeps `pnpm dev-mock` honest: mock mode must never wire a daemon
// proxy or inject machine token/home (CLAUDE.md mock contract).
const resolve = (mode) => (typeof viteConfig === 'function' ? viteConfig({ mode }) : viteConfig);
const pluginNames = (cfg) => (cfg.plugins ?? []).flat().map((p) => p?.name).filter(Boolean);

test('mock mode has only in-browser backends — no daemon proxy, no token/home injection', () => {
  const cfg = resolve('mock');
  assert.ok(
    !pluginNames(cfg).includes('sing-token-inject'),
    'mock mode must not inject window.__SING_TOKEN__/__SING_HOME__ — no machine, no .env',
  );
  assert.equal(
    cfg.server?.proxy,
    undefined,
    'mock mode must not proxy /api or /ws — Mirage + mock-socket answer in-browser',
  );
});

test('dev mode wires the daemon proxy + token/home injection', () => {
  const cfg = resolve('development');
  assert.ok(
    pluginNames(cfg).includes('sing-token-inject'),
    'dev mode injects token/home so the Vite-served shell can call the daemon',
  );
  assert.ok(cfg.server?.proxy?.['/api'], 'dev mode proxies /api to the daemon');
  assert.ok(cfg.server?.proxy?.['/ws'], 'dev mode proxies /ws to the daemon');
});