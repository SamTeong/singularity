import React from 'react';
import { createRoot } from 'react-dom/client';
import '@zapac/mui-theme/fonts';
import { AppThemeProvider } from '@/theme/index.js';
import App from '@/App.jsx';
import '@xterm/xterm/css/xterm.css';
import '@/style.css';

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
    <App />
  </AppThemeProvider>,
);
