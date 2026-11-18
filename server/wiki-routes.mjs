import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { STATE_DIR } from './app-dir.mjs';

const stateFile = () => resolve(STATE_DIR, 'wiki-root.json');

function operationContext() {
  const drive_cwds = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = String.fromCharCode(code);
    const path = process.env[`=${drive}:`];
    if (path !== undefined) drive_cwds.push({ drive, path });
  }
  return { state_file: stateFile(), home: homedir(), cwd: process.cwd(), drive_cwds };
}

export async function wikiAvailable(backend) {
  try {
    const { available } = await backend.wikiRootAvailable(operationContext());
    return available === true;
  } catch {
    return false;
  }
}

export function registerWikiRoutes(app, backend) {
  app.get('/wiki/root', async () => {
    const { root } = await backend.wikiRootGet(operationContext());
    return { root };
  });
  app.put('/wiki/root', async (req) => backend.wikiRootSet(operationContext(), req.body?.root));
  app.get('/wiki/file', async (req, reply) => {
    const { path, root } = req.query;
    if (!path || !root) {
      reply.code(400);
      return { ok: false, error: 'path outside wiki root' };
    }
    // Preserve the prior Node type errors for duplicate query parameters.
    root.startsWith('~');
    resolve(path);
    let authorization;
    try {
      authorization = await backend.wikiRootAuthorize(operationContext(), root, path);
    } catch (error) {
      app.log.error({ err: error.message }, 'Rust wiki file backend failed');
      reply.code(500);
      return { ok: false, error: 'wiki file backend unavailable' };
    }
    if (!authorization.authorized) {
      reply.code(400);
      return { ok: false, error: 'path outside wiki root' };
    }
    let result;
    try { result = await backend.readFile(path); }
    catch (error) {
      app.log.error({ err: error.message }, 'Rust wiki file backend failed');
      reply.code(500);
      return { ok: false, error: 'wiki file backend unavailable' };
    }
    if (!result.ok) reply.code(result.error === 'not found' ? 404 : 400);
    return result;
  });
}
