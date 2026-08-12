// MirageJS server — the in-browser stand-in for the daemon's HTTP surface.
// Route groups register incrementally (tasks.md sections 3 and 5); this file
// wires them in the order the daemon's own Fastify routes demand: static
// siblings before parameterised (design.md D8). `/config/roots` and
// `/config/state` must register before `PUT /config/:scope`, and the same
// ordering applies to /codex-config, /skills, /wiki, /memory, /rules, /hooks.
//
// Mirage throws on unhandled requests — the "gaps must be visible" requirement
// (specs/mock-backend/spec.md). Route handlers return plain objects (the body
// shape) or `new Response(code, {}, body)` for non-200 status. The body shape
// must match the daemon exactly (bare arrays where the daemon returns bare
// arrays, bare keyed objects with no `ok`, error keys inside a 200, real 409s
// on stale-mtime writes). The helpers in helpers.js cover the two repeated
// shapes; the per-feature modules cover the rest.
import { Server } from 'miragejs';
import { registerCore } from './routes/core.js';

export function makeServer() {
  return new Server({
    environment: 'test', // disables Mirage's artificial response latency
    routes() {
      // Core singleton routes — registered first so the shell's boot-time
      // fetches (/health, /capabilities, /keys, /models) answer before any
      // panel-specific route group. Section 5's feature modules register after.
      registerCore(this);
    },
  });
}
