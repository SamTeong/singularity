// MirageJS server — the in-browser stand-in for the daemon's HTTP surface.
// Route groups are registered incrementally (tasks.md sections 3 and 5); this
// file currently boots a server with no routes mounted, so every request
// falls through to Mirage's default behaviour: throw loudly, identifying the
// unhandled request, rather than silently resolving. That is exactly the
// "gaps must be visible" requirement — see specs/mock-backend/spec.md.
import { Server } from 'miragejs';

export function makeServer() {
  return new Server({
    environment: 'test', // disables Mirage's artificial response latency
    routes() {
      // Route groups land here, static siblings before parameterised routes
      // (see design.md D8). Empty for now — see file header.
    },
  });
}
