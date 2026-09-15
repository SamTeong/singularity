// One-shot headless prompt: run a single prompt through a group's CLI and
// return its answer channel, shared by history.mjs (day summariser) and
// window-anchor.mjs (5h-window anchor pokes) so the argv builders live in one
// place. Returns the raw answer channel as a string:
//   claude  -> stdout, a single JSON envelope ({ result, usage: {...} })
//   codex   -> the --output-last-agent-message file's contents (agent chatter
//              goes to stdout, so the answer channel is the file)
//   ollama  -> stdout
//
// --no-session-persistence / --ephemeral are load-bearing: without them each
// call writes a transcript under ~/.claude/projects or CODEX_HOME/sessions that
// the next History scan reads and summarises — a self-referential feedback loop.
import { readFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { STATE_DIR, CLAUDE_BIN, OLLAMA_BIN, CODEX_BIN } from './agents.mjs';

const execFileP = promisify(execFile);

const ONESHOT_TIMEOUT_MS = 120_000;
const ONESHOT_MAX_BUFFER = 8 * 1024 * 1024;

export async function runOneShotPrompt(group, modelId, prompt, { timeoutMs = ONESHOT_TIMEOUT_MS, extraArgs = [], spawn = execFileP } = {}) {
  const opts = { maxBuffer: ONESHOT_MAX_BUFFER, timeout: timeoutMs };
  if (group === 'claude') {
    const { stdout } = await spawn(CLAUDE_BIN, [
      '-p', prompt,
      '--model', modelId,
      '--output-format', 'json',
      '--no-session-persistence',
      '--bare',
      ...extraArgs,
    ], opts);
    return stdout;
  }
  if (group === 'codex') {
    // -s read-only + --skip-git-repo-check: a one-shot only reads its prompt
    // string, it must never be able to write.
    const tmpFile = join(STATE_DIR, `.oneshot-${randomUUID()}.txt`);
    try {
      await spawn(CODEX_BIN, [
        'exec', '-m', modelId,
        '-s', 'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '-C', STATE_DIR,
        '-o', tmpFile,
        ...extraArgs,
        prompt,
      ], opts);
      return readFileSync(tmpFile, 'utf8');
    } finally {
      try { unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
    }
  }
  if (group === 'ollama') {
    const { stdout } = await spawn(OLLAMA_BIN, ['run', modelId, prompt], opts);
    return stdout;
  }
  throw new Error(`one-shot: unknown group '${group}'`);
}