// ~-collapse presentation layer. Pure frontend — the backend only ever sees
// full paths. tildify() for display, untildify() before any fetch/WS send.
// Seeded synchronously from the shell (daemon + Vite both inject
// window.__SING_HOME__ into index.html) — an async fetch here meant one dropped
// request left `~` unresolved for the tab's lifetime. setHome stays for tests.
let HOME = (typeof window !== 'undefined' && window.__SING_HOME__) || '';
export const setHome = (h) => { HOME = h || ''; };

const escSeg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function tildify(p) {
  if (!p || !HOME) return p || '';
  if (p[0] === '~') return p;
  // Escape each path segment individually, then join with a separator class —
  // escaping HOME as a whole first would double-escape its own `\` separators.
  const pattern = HOME.split(/[\\/]/).map(escSeg).join('[\\\\/]');
  return p.replace(new RegExp('^' + pattern + '(?=[\\\\/]|$)', 'i'), '~');
}

export function untildify(p) {
  if (!p || !HOME) return p || '';
  if (p === '~') return HOME;
  if (p[0] === '~' && (p[1] === '/' || p[1] === '\\')) return HOME + p.slice(1);
  return p;
}

// Last path segment (repo/basename), trailing separators trimmed first.
export const repoName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
