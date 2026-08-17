import { createRoot } from 'react-dom/client';
import '@zapac/mui-theme/fonts';
import { AppThemeProvider } from '@/theme/index.js';
import { KeysProvider } from '@/providers/KeysProvider.jsx';
import App from '@/App.jsx';
import '@xterm/xterm/css/xterm.css';
import '@/style.css';

// Mock run mode: must be a *dynamic* import, and it must run before the first
// render. Static imports above (KeysProvider, App, ...) already resolved by
// the time this line runs, but KeysProvider's `/keys` fetch fires from a mount
// effect, not module scope — so installing the mock here, above createRoot,
// still beats the first request. import.meta.env.VITE_MOCK is statically
// substituted, so Rollup eliminates this branch (and all of web/src/mock/)
// from the production bundle.
if (import.meta.env.VITE_MOCK) (await import('@/mock/index.js')).startMock();

// Optional loopback token: if the daemon injected one, attach it to every
// same-origin API request. No-op when the token is absent (default).
if (window.__SING_TOKEN__) {
  const token = window.__SING_TOKEN__;
  const orig = window.fetch;
  window.fetch = (input, init) => {
    // Request-object first arg: clone it (merging init) and stamp the header.
    if (input instanceof Request) {
      const req = new Request(input, init);
      req.headers.set('x-sing-token', token);
      return orig(req);
    }
    // Headers is not spreadable ({...headers} === {}); normalize via Headers API
    // so string/array/object/Headers inputs all keep their entries.
    const opts = { ...init };
    const headers = new Headers(opts.headers || {});
    headers.set('x-sing-token', token);
    opts.headers = headers;
    return orig(input, opts);
  };
}

createRoot(document.getElementById('root')).render(
  <AppThemeProvider defaultMode="dark">
    <KeysProvider>
      <App />
    </KeysProvider>
  </AppThemeProvider>,
);
