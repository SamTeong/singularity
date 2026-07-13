import React from 'react';
import { createRoot } from 'react-dom/client';
import '@zapac/mui-theme/fonts';
import { ZapacThemeProvider } from '@zapac/mui-theme';
import App from './App.jsx';
import '@xterm/xterm/css/xterm.css';
import './style.css';

// Optional loopback token: if the daemon injected one, attach it to every
// same-origin API request. No-op when the token is absent (default).
if (window.__SING_TOKEN__) {
  const token = window.__SING_TOKEN__;
  const orig = window.fetch;
  window.fetch = (url, opts = {}) => orig(url, { ...opts, headers: { ...(opts.headers || {}), 'x-sing-token': token } });
}

createRoot(document.getElementById('root')).render(
  <ZapacThemeProvider defaultMode="dark">
    <App />
  </ZapacThemeProvider>,
);
