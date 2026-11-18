import { resolve } from 'node:path';

export function createExternalSessionLaunchHandler({ reg, rustBackend }) {
  return async (req, reply) => {
    const id = req.body?.id;
    if (!id) return reply.code(400).send({ ok: false, error: 'id required' });
    const launch = await reg.externalLaunch(id);
    if (!launch.ok) return reply.code(400).send(launch);
    try {
      await rustBackend.spawnDetached(launch.launcher, launch.launcherArgs, launch.cwd);
    } catch (error) {
      return reply.code(500).send({ ok: false, error: error.message });
    }
    reg.remove(id);
    return { ok: true };
  };
}

export function createSessionFolderOpenHandler({
  resolveSessionDirectory,
  rustBackend,
  platform = process.platform,
  systemRoot = process.env.SystemRoot || 'C:\\Windows',
}) {
  return async (req, reply) => {
    const session = await resolveSessionDirectory(req.body?.sid);
    if (!session.ok) {
      reply.code(session.error === 'bad sid' ? 400 : 404);
      return session;
    }
    if (platform !== 'win32') {
      reply.code(501);
      return { ok: false, error: 'unsupported platform' };
    }
    try {
      await rustBackend.spawnDetached(resolve(systemRoot, 'explorer.exe'), [session.dir]);
      return { ok: true };
    } catch {
      reply.code(500);
      return { ok: false, error: 'failed to open session folder' };
    }
  };
}
