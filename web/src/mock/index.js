// Entry point for mock run mode. Invoked from main.jsx's guarded dynamic
// import, before the first render (see design.md D2).
import { setHome } from '@/lib/paths.js';
import { FAKE_HOME } from './fixtures.js';
import { makeServer } from './server.js';
import { startWs } from './ws.js';

export function startMock() {
  // window.__SING_HOME__ mirrors what the daemon/Vite dev proxy injects into
  // index.html in the real run paths. But web/src/lib/paths.js reads that
  // global exactly once, at its own module-evaluation time — which, by ES
  // module ordering, happens while main.jsx's *static* imports resolve,
  // before this dynamic import's body ever runs. Setting the window property
  // alone would be too late, so call setHome() directly as well.
  window.__SING_HOME__ = FAKE_HOME;
  setHome(FAKE_HOME);

  // Deliberately no window.__SING_TOKEN__ (design.md D3): it would append a
  // `?token=` query string that mock-socket's exact-URL matching would then
  // fail on, and it would arm the fetch-patching branch in main.jsx for no
  // benefit — the mock never checks auth.

  makeServer();
  startWs();
}
