import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// migrate-state.mjs runs its rewrites as an import side effect and reads
// TRUSTED_ROOT (for TICKETS_DIR/REPORTS_DIR) from app-dir.mjs — point both at
// scratch temp dirs before the dynamic import so this test never touches the
// real repo's .tickets/.reports, and so app-dir.mjs doesn't throw for a
// missing SINGULARITY_HOME (static imports hoist above env assignment).
const scratch = mkdtempSync(join(tmpdir(), 'sing-migrate-'));
process.env.SINGULARITY_HOME = join(scratch, 'home');
process.env.SING_TRUSTED_ROOT = join(scratch, 'trusted');

const { STATE_DIR, CACHE_DIR } = await import('./app-dir.mjs');
mkdirSync(STATE_DIR, { recursive: true });

// Pre-seed crons.json with the old `name`/`prompt` keys so the field-rename
// pass finds a change and rewrites the file.
const cronsFile = join(STATE_DIR, 'crons.json');
writeFileSync(cronsFile, JSON.stringify({ crons: [{ id: '1', name: 'old-name', prompt: 'old-prompt' }] }));

await import('./migrate-state.mjs');

test('rewrite is valid JSON with the field renamed', () => {
  const raw = JSON.parse(readFileSync(cronsFile, 'utf8'));
  assert.equal(raw.crons[0].title, 'old-name');
  assert.equal(raw.crons[0].description, 'old-prompt');
});

test('a backup of the pre-rewrite content exists', () => {
  const key = createHash('sha256').update(cronsFile).digest('hex').slice(0, 16);
  const backupDir = join(CACHE_DIR, 'backups', key);
  assert.ok(existsSync(backupDir), 'backup dir was created');
  const baks = readdirSync(backupDir).filter((f) => f.endsWith('.bak'));
  assert.ok(baks.length > 0, 'at least one .bak file written');
  const original = JSON.parse(readFileSync(join(backupDir, baks[0]), 'utf8'));
  assert.equal(original.crons[0].name, 'old-name', 'backup captured the pre-rewrite shape');
});

test('rewrite used a temp+rename, not a bare write (no leftover .tmp file)', () => {
  const leftovers = readdirSync(STATE_DIR).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
