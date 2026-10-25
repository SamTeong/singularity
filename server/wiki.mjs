// Wiki traversal still resolves client-selected roots in Node; persistence and authorization run in Rust.
import { resolve, normalize } from 'node:path';
import { homedir } from 'node:os';

// Resolve a ~-prefixed client path to an absolute one (mirror /fs/browse).
export function resolveRoot(raw) {
  if (!raw) return null;
  let path = raw;
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = normalize(homedir() + path.slice(1));
  try { return resolve(path); } catch { return null; }
}
