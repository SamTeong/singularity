/**
 * Session-naming helpers — pure functions over the agent list.
 * Extracted from App.jsx so the naming rules are testable in isolation.
 */

/**
 * Copy/Fork target name: strip a trailing `_N` from the source, then pick the
 * lowest free `_N` across existing session names. An unnamed source (its name
 * still equals the id prefix) yields a blank name so the daemon auto-names it.
 *
 * @param {Array<{name: string}>} agents current sessions
 * @param {{name: string, id: string}} agent source session being copied/forked
 * @returns {string} the next free name, or '' for an unnamed source
 */
export function nextSessionName(agents, agent) {
  if (agent.name === agent.id.slice(0, 8)) return '';
  const base = agent.name.replace(/_\d+$/, '');
  const taken = new Set(agents.map((x) => x.name));
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/**
 * Next session id when cycling with Alt+Up/Down. Excludes detached sessions and
 * wraps around. Returns null when there are fewer than two cyclable sessions.
 *
 * @param {Array<{id: string, status: string}>} agents
 * @param {string|null} activeId currently selected session id
 * @param {1|-1} dir direction to move
 * @returns {string|null} the id to select next, or null if cycling is a no-op
 */
export function nextCycledSession(agents, activeId, dir) {
  const list = agents.filter((a) => a.status !== 'detached');
  if (list.length < 2) return null;
  const i = list.findIndex((a) => a.id === activeId);
  return list[(i + dir + list.length) % list.length].id;
}
