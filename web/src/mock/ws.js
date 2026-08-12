// mock-socket server — the in-browser stand-in for the daemon's /ws protocol.
// Bound to the exact URL AgentsProvider.jsx computes so the client's own
// `new WebSocket(...)` call is transparently intercepted. Frame handling (the
// on-connect burst, attach/input/chat, and mutation broadcasts) lands
// incrementally — see tasks.md section 4. For now the server accepts
// connections and does nothing with them, so panels that depend on the live
// layer are expected to still show an empty/error state at this stage.
import { Server } from 'mock-socket';

let wsServer;

export function startWs() {
  // No __SING_TOKEN__ is ever set in mock mode (see index.js), so this always
  // matches the client's URL exactly — mock-socket matches on exact URL.
  const url = `ws://${location.host}/ws`;
  wsServer = new Server(url);
  return wsServer;
}
