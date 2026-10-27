// Node oracle for rust/backend/src/stats.rs: runs the retained stats.mjs parsers
// on fixture paths (from stdin) and prints JSON.stringify of the results.
// Caller sets SINGULARITY_HOME, USAGE_REPORT_STATE and CODEX_HOME to scratch dirs.
import fs from 'node:fs';
import process from 'node:process';

const { parseByPath, parseCodexRollout, parseSession, readCostFile } = await import('../../../server/stats.mjs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const result = {
  claude: [],
  codex: [],
  find: await parseSession(request.findCwd, 'x', 'codex'),
  costs: request.costIds.map(readCostFile),
};
for (const path of request.claude) result.claude.push(await parseByPath(path));
for (const path of request.codex) result.codex.push(await parseCodexRollout(path));
process.stdout.write(JSON.stringify(result), () => process.exit(0));
