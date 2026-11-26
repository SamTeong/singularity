#!/usr/bin/env node
// Instruction-file check: frontmatter, agent/skill required fields, and relative
// links / @imports in the agent instruction surface. No dependencies.
//
//   node scripts/check-instructions.mjs            check the repo, exit 1 on problems
//   node scripts/check-instructions.mjs --root <d> check another root (tests)
//
// Covers CLAUDE.md, AGENTS.md, .claude/rules/**, .claude/rules-reference/**,
// .claude/agents/*.md, .claude/skills/*/SKILL.md and openspec/specs/**/*.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, accept, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, out);
    else if (accept(entry.name)) out.push(full);
  }
  return out;
}

const isMd = (name) => name.toLowerCase().endsWith('.md');

/** Every instruction file under root, as absolute paths. */
export function collectFiles(root) {
  const files = ['CLAUDE.md', 'AGENTS.md'].map((f) => join(root, f)).filter(existsSync);
  files.push(...walk(join(root, '.claude', 'rules'), isMd));
  files.push(...walk(join(root, '.claude', 'rules-reference'), isMd));
  const agents = join(root, '.claude', 'agents');
  if (existsSync(agents)) {
    files.push(...readdirSync(agents).filter(isMd).map((f) => join(agents, f)));
  }
  const skills = join(root, '.claude', 'skills');
  if (existsSync(skills)) {
    for (const d of readdirSync(skills, { withFileTypes: true })) {
      const skillFile = join(skills, d.name, 'SKILL.md');
      if (d.isDirectory() && existsSync(skillFile)) files.push(skillFile);
    }
  }
  files.push(...walk(join(root, 'openspec', 'specs'), isMd));
  return files;
}

const unquote = (v) => {
  const s = v.trim();
  return /^(["']).*\1$/.test(s) && s.length >= 2 ? s.slice(1, -1) : s;
};

/**
 * Minimal YAML-subset frontmatter parser: top-level `key: value`, block scalars
 * (`>`/`|`), and indented continuation/list/nested lines. Returns
 * { data, errors:[{line,message}], present } with 1-based file line numbers.
 */
export function parseFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { present: false, data: {}, errors: [] };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { present: true, data: {}, errors: [{ line: 1, message: 'frontmatter is not closed with ---' }] };
  const data = {};
  const errors = [];
  let current = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line) || /^-\s/.test(line)) {
      if (current === null) errors.push({ line: i + 1, message: 'indented line without a parent key' });
      else if (typeof data[current] === 'string' && !/^[>|]/.test(data[current])) data[current] += ` ${line.trim()}`;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*)|\s*)$/);
    if (!m) {
      errors.push({ line: i + 1, message: `frontmatter line is not "key: value": ${line.trim().slice(0, 60)}` });
      current = null;
      continue;
    }
    current = m[1];
    const raw = (m[2] ?? '').trim();
    if (Object.hasOwn(data, current)) errors.push({ line: i + 1, message: `duplicate frontmatter key "${current}"` });
    if (/^["']/.test(raw) && !/^(["']).*\1\s*(#.*)?$/.test(raw)) {
      errors.push({ line: i + 1, message: `unterminated quoted value for "${current}"` });
    }
    data[current] = /^[>|]/.test(raw) ? '' : unquote(raw);
    if (/^[>|]/.test(raw)) {
      // block scalar: the value is the following indented lines
      let j = i + 1;
      const body = [];
      while (j < end && (/^\s/.test(lines[j]) || !lines[j].trim())) body.push(lines[j++].trim());
      data[current] = body.join(' ').trim();
      i = j - 1;
    }
  }
  return { present: true, data, errors };
}

const hasValue = (v) => typeof v === 'string' && v.trim().length > 0;

/** Links and @imports outside fenced/inline code, with 1-based line numbers. */
export function extractRefs(text) {
  const refs = [];
  let fence = null;
  text.split(/\r?\n/).forEach((raw, idx) => {
    const fm = raw.match(/^\s*(```+|~~~+)/);
    if (fm) {
      if (!fence) fence = fm[1][0];
      else if (fm[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const line = raw.replace(/`[^`]*`/g, '');
    for (const m of line.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) {
      refs.push({ line: idx + 1, kind: 'link', target: m[1] });
    }
    const imp = line.match(/^@(\S+)\s*$/);
    if (imp && (imp[1].includes('/') || /\.[A-Za-z0-9]+$/.test(imp[1]))) {
      refs.push({ line: idx + 1, kind: '@import', target: imp[1] });
    }
  });
  return refs;
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//');
}

/** @returns {{file:string,line:number,message:string}[]} file is root-relative, forward slashes */
export function checkRoot(root = DEFAULT_ROOT) {
  const problems = [];
  for (const abs of collectFiles(root)) {
    const file = relative(root, abs).split('\\').join('/');
    const add = (line, message) => problems.push({ file, line, message });
    const text = readFileSync(abs, 'utf8');

    const fm = parseFrontmatter(text);
    fm.errors.forEach((e) => add(e.line, e.message));
    const isAgent = /^\.claude\/agents\/[^/]+\.md$/.test(file);
    const skill = file.match(/^\.claude\/skills\/([^/]+)\/SKILL\.md$/);
    if (isAgent || skill) {
      if (!fm.present) add(1, `${isAgent ? 'agent' : 'skill'} needs YAML frontmatter with name and description`);
      else {
        if (!hasValue(fm.data.name)) add(1, 'frontmatter is missing "name"');
        if (!hasValue(fm.data.description)) add(1, 'frontmatter is missing "description"');
        if (skill && hasValue(fm.data.name) && fm.data.name !== skill[1]) {
          add(1, `skill name "${fm.data.name}" must equal its directory "${skill[1]}"`);
        }
      }
    }

    for (const ref of extractRefs(text)) {
      if (isExternal(ref.target)) continue;
      let path = ref.target.split('#')[0].split('?')[0];
      if (!path) continue;
      try { path = decodeURIComponent(path); } catch { /* keep raw */ }
      const target = path.startsWith('/') ? resolve(root, `.${path}`) : resolve(dirname(abs), path);
      if (!existsSync(target)) add(ref.line, `${ref.kind} does not resolve: ${ref.target}`);
      else if (ref.kind === '@import' && statSync(target).isDirectory()) add(ref.line, `@import is a directory: ${ref.target}`);
    }
  }
  return problems;
}

function main(argv) {
  const i = argv.indexOf('--root');
  const root = i >= 0 ? resolve(argv[i + 1] ?? '.') : DEFAULT_ROOT;
  const problems = checkRoot(root);
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.message}`);
  if (problems.length) {
    console.error(`check-instructions: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`check-instructions: ${collectFiles(root).length} files ok`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
