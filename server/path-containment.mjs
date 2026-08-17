// Path-containment guard shared by memory.mjs and wiki.mjs: both confine
// reads/writes to a caller-supplied root and must reject traversal identically
// — a fix applied to one and not the other would leave that surface with a
// weaker check than its sibling.
import { relative, isAbsolute } from 'node:path';

// Case-insensitive on Windows, where the same dir can arrive with either case.
export const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);

// path.relative-based containment: startsWith on a bare string would let a
// sibling like "<root>-evil" pass; relative() rejects unless it stays inside.
export function contains(root, target) {
  const rel = relative(norm(root), norm(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
