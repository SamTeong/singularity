// Split a leading YAML frontmatter block (---\n...\n---) from the body. Each
// `key: value` line is parsed; `value` may be `[a, b, c]`. Returns {meta, body}.
// Shared by WikiPanel + SkillsPanel.
export function parseFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    if (k) meta[k] = v;
  }
  return { meta, body: src.slice(m[0].length) };
}