#!/usr/bin/env node
// Summarize NDJSON output from scripts/observe-runtime.ps1.
//
//   node scripts/summarize-runtime-observations.mjs <file-or-dir> [...]
//        [--json] [--self-test]
//
// Reads one or more observation files (a directory expands to its *.ndjson
// entries), tolerates a final line that is still being written, and reports
// per target, per process-identity epochs. Percentages are never mixed across
// epochs; CPU seconds and I/O deltas are additive and are labeled as sums.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const TOOL_VERSION = 1;

const IO_FIELDS = [
  'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount',
  'ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
];

export function parseObservations(text) {
  const lines = text.split(/\r?\n/);
  let lastContentIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') { lastContentIndex = i; break; }
  }
  const records = {
    runStarts: [], identities: [], samples: [], missing: [], warnings: [],
    errors: [], runEnds: [], observer: [], malformedLines: 0, unknownKinds: 0,
    trailingPartial: false,
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let value;
    try { value = JSON.parse(lines[i]); }
    catch {
      if (i === lastContentIndex) records.trailingPartial = true;
      else records.malformedLines++;
      continue;
    }
    switch (value.kind) {
      case 'run_start': records.runStarts.push(value); break;
      case 'identity': records.identities.push(value); break;
      case 'sample': records.samples.push(value); break;
      case 'missing': records.missing.push(value); break;
      case 'warning': records.warnings.push(value); break;
      case 'error': records.errors.push(value); break;
      case 'run_end': records.runEnds.push(value); break;
      case 'observer': records.observer.push(value); break;
      // Unknown kinds are forward-compatible schema additions, not corruption.
      default: records.unknownKinds++;
    }
  }
  return records;
}

function groupByTarget(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.label}\u0000${row.role}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function elapsedOf(row) {
  return typeof row.elapsedSeconds === 'number' ? row.elapsedSeconds : 0;
}

function buildEpochs(samples, identities, intervalSeconds) {
  const sorted = [...samples].sort((a, b) => elapsedOf(a) - elapsedOf(b));
  const epochs = [];
  let current = null;
  for (const sample of sorted) {
    const identity = sample.process?.identity ?? `pid:${sample.process?.pid ?? 'unknown'}`;
    if (!current || current.identity !== identity) {
      const identityRow = identities.find((row) => row.process?.identity === identity);
      current = {
        identity,
        pid: sample.process?.pid ?? null,
        creationDate: sample.process?.creationDate ?? null,
        firstTimestampUtc: sample.timestampUtc ?? null,
        lastTimestampUtc: sample.timestampUtc ?? null,
        firstElapsed: elapsedOf(sample),
        lastElapsed: elapsedOf(sample),
        sampleCount: 0,
        cpuSeconds: 0,
        weightedPctSum: 0,
        weightSeconds: 0,
        peakCorePct: null,
        peakMachinePct: null,
        workingSetSum: 0,
        workingSetPeak: 0,
        privateSum: 0,
        privatePeak: 0,
        io: {
          readBytes: 0, writeBytes: 0, otherBytes: 0,
          readOperations: 0, writeOperations: 0, otherOperations: 0,
        },
        ioObserved: false,
        ioResets: 0,
        ioUnknownIntervals: 0,
        gaps: 0,
        revision: identityRow?.revision ?? null,
        expectedRevision: identityRow?.expectedRevision ?? null,
        revisionMatches: identityRow?.revisionMatches ?? null,
      };
      epochs.push(current);
    }
    current.sampleCount++;
    if (current.sampleCount > 1) {
      const previousElapsed = current.lastElapsed;
      const gap = elapsedOf(sample) - previousElapsed;
      if (intervalSeconds > 0 && gap > intervalSeconds * 1.8) current.gaps++;
    }
    current.lastElapsed = elapsedOf(sample);
    current.lastTimestampUtc = sample.timestampUtc ?? current.lastTimestampUtc;

    const counters = sample.counters ?? {};
    const workingSet = Number(counters.workingSetBytes) || 0;
    const privateBytes = Number(counters.privateBytes) || 0;
    current.workingSetSum += workingSet;
    current.privateSum += privateBytes;
    if (workingSet > current.workingSetPeak) current.workingSetPeak = workingSet;
    if (privateBytes > current.privatePeak) current.privatePeak = privateBytes;

    const cpu = sample.deltas?.cpu;
    if (cpu && typeof cpu.cpuSeconds === 'number') {
      current.cpuSeconds += cpu.cpuSeconds;
      const interval = Number(sample.deltas?.intervalSeconds) || 0;
      current.weightedPctSum += cpu.coreEquivalentPct * interval;
      current.weightSeconds += interval;
      if (typeof cpu.coreEquivalentPct === 'number') {
        current.peakCorePct = Math.max(current.peakCorePct ?? 0, cpu.coreEquivalentPct);
      }
      if (typeof cpu.machineCapacityPct === 'number') {
        current.peakMachinePct = Math.max(current.peakMachinePct ?? 0, cpu.machineCapacityPct);
      }
    }
    const io = sample.deltas?.io;
    if (io) {
      const reset = io.counterReset === true;
      const partial = IO_FIELDS.some((field) => io[field] === null || io[field] === undefined);
      if (reset || partial) {
        // A reset interval is unknown, not zero: skip it and count it so the
        // summary never understates I/O as measured traffic.
        current.ioUnknownIntervals++;
        if (reset) current.ioResets++;
      } else {
        current.ioObserved = true;
        current.io.readBytes += Number(io.ReadTransferCount) || 0;
        current.io.writeBytes += Number(io.WriteTransferCount) || 0;
        current.io.otherBytes += Number(io.OtherTransferCount) || 0;
        current.io.readOperations += Number(io.ReadOperationCount) || 0;
        current.io.writeOperations += Number(io.WriteOperationCount) || 0;
        current.io.otherOperations += Number(io.OtherOperationCount) || 0;
      }
    }
  }

  for (const epoch of epochs) {
    const observedSeconds = Math.max(0, epoch.lastElapsed - epoch.firstElapsed);
    epoch.observedSeconds = round(observedSeconds, 3);
    epoch.meanCorePct = epoch.weightSeconds > 0
      ? round(epoch.weightedPctSum / epoch.weightSeconds, 3)
      : null;
    epoch.workingSetMeanBytes = epoch.sampleCount > 0 ? round(epoch.workingSetSum / epoch.sampleCount, 0) : null;
    epoch.privateMeanBytes = epoch.sampleCount > 0 ? round(epoch.privateSum / epoch.sampleCount, 0) : null;
    epoch.expectedSamples = intervalSeconds > 0
      ? Math.floor(observedSeconds / intervalSeconds) + 1
      : epoch.sampleCount;
    epoch.coveragePct = epoch.expectedSamples > 0
      ? round(Math.min(100, (epoch.sampleCount / epoch.expectedSamples) * 100), 1)
      : null;
    if (!epoch.ioObserved) epoch.io = null;
  }
  return epochs;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summarizeFile(filePath, text) {
  const records = parseObservations(text);
  const runStart = records.runStarts[0] ?? null;
  const runEnd = records.runEnds[0] ?? null;
  const intervalSeconds = Number(runStart?.arguments?.intervalSeconds) || 0;
  const logicalCpuCount = Number(runStart?.host?.logicalCpuCount) || null;
  const declaredTargets = Array.isArray(runStart?.targets) ? runStart.targets : [];
  const targetKeys = new Set(declaredTargets.map((target) => `${target.label}\u0000${target.role}`));
  const sampleGroups = groupByTarget(records.samples);
  const missingGroups = groupByTarget(records.missing);
  const warningGroups = groupByTarget(records.warnings);
  for (const key of [...sampleGroups.keys(), ...missingGroups.keys()]) targetKeys.add(key);

  const targets = [];
  for (const key of [...targetKeys].sort()) {
    const [label, role] = key.split('\u0000');
    const declared = declaredTargets.find((target) => target.label === label && target.role === role);
    const samples = sampleGroups.get(key) ?? [];
    const identities = records.identities.filter((row) => row.label === label && row.role === role);
    const epochs = buildEpochs(samples, identities, intervalSeconds);
    for (const epoch of epochs) {
      epoch.meanMachinePct = epoch.meanCorePct === null || !logicalCpuCount
        ? null
        : round(epoch.meanCorePct / logicalCpuCount, 3);
    }
    targets.push({
      label,
      role,
      port: declared?.port ?? samples[0]?.port ?? missingGroups.get(key)?.[0]?.port ?? null,
      observed: samples.length > 0,
      epochs,
      restarts: identities.filter((row) => row.reason === 'restart').length,
      resumes: identities.filter((row) => row.reason === 'resume').length,
      resumeGapSeconds: round(identities
        .filter((row) => row.reason === 'resume')
        .reduce((sum, row) => sum + (Number(row.gapSeconds) || 0), 0), 3),
      ioResets: epochs.reduce((sum, epoch) => sum + epoch.ioResets, 0),
      missingRows: (missingGroups.get(key) ?? []).length,
      warningRows: (warningGroups.get(key) ?? []).length,
      cpuSecondsTotal: round(epochs.reduce((sum, epoch) => sum + epoch.cpuSeconds, 0), 3),
      io: epochs.some((epoch) => epoch.io)
        ? epochs.reduce((total, epoch) => {
            if (!epoch.io) return total;
            return {
              readBytes: total.readBytes + epoch.io.readBytes,
              writeBytes: total.writeBytes + epoch.io.writeBytes,
              otherBytes: total.otherBytes + epoch.io.otherBytes,
              readOperations: total.readOperations + epoch.io.readOperations,
              writeOperations: total.writeOperations + epoch.io.writeOperations,
              otherOperations: total.otherOperations + epoch.io.otherOperations,
            };
          }, {
            readBytes: 0, writeBytes: 0, otherBytes: 0,
            readOperations: 0, writeOperations: 0, otherOperations: 0,
          })
        : null,
    });
  }

  const maxElapsed = records.samples.reduce((max, sample) => Math.max(max, elapsedOf(sample)), 0);
  return {
    file: filePath,
    runId: runStart?.runId ?? null,
    startedUtc: runStart?.timestampUtc ?? null,
    endedUtc: runEnd?.timestampUtc ?? null,
    complete: runEnd !== null,
    stopReason: runEnd?.stopReason ?? null,
    intervalSeconds: intervalSeconds || null,
    logicalCpuCount,
    durationSeconds: runEnd?.elapsedSeconds ?? round(maxElapsed, 3),
    declaredTargets,
    targets,
    missingTotal: records.missing.length,
    restartTotal: records.identities.filter((row) => row.reason === 'restart').length,
    resumeTotal: records.identities.filter((row) => row.reason === 'resume').length,
    warningTotal: records.warnings.length,
    errorTotal: records.errors.length,
    malformedLines: records.malformedLines,
    unknownKindLines: records.unknownKinds,
    trailingPartialLine: records.trailingPartial,
    observer: records.observer.length > 0
      ? {
          samples: records.observer.length,
          cpuSeconds: round(records.observer.reduce((sum, row) => sum + (Number(row.cpuSeconds) || 0), 0), 6),
          peakWorkingSetBytes: Math.max(...records.observer.map((row) => Number(row.workingSetBytes) || 0)),
        }
      : (runEnd?.observer ?? null),
  };
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return 'n/a';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatPct(value) {
  return value === null || value === undefined ? 'n/a' : `${value.toFixed(1)}%`;
}

export function formatReport(summaries) {
  const lines = [`Runtime observations — ${summaries.length} file(s)`, ''];
  summaries.forEach((summary, index) => {
    lines.push(`[${index + 1}] ${summary.file}`);
    lines.push(
      `    run ${summary.runId ?? 'unknown'}  duration ${summary.durationSeconds ?? 'n/a'}s  ` +
      `${summary.complete ? 'complete' : 'INCOMPLETE (no run_end; file may still be written)'}` +
      `${summary.stopReason ? `  stop=${summary.stopReason}` : ''}`,
    );
    lines.push(
      `    interval ${summary.intervalSeconds ?? 'n/a'}s  logical CPUs ${summary.logicalCpuCount ?? 'n/a'}  ` +
      `missing rows ${summary.missingTotal}  restarts ${summary.restartTotal}` +
      `${summary.resumeTotal ? `  resumes ${summary.resumeTotal}` : ''}` +
      `${summary.warningTotal ? `  warnings ${summary.warningTotal}` : ''}` +
      `${summary.errorTotal ? `  errors ${summary.errorTotal}` : ''}`,
    );
    if (summary.malformedLines > 0) lines.push(`    WARN malformed lines skipped: ${summary.malformedLines}`);
    if (summary.unknownKindLines > 0) lines.push(`    note: ${summary.unknownKindLines} line(s) of an unrecognized kind were ignored`);
    if (summary.trailingPartialLine) lines.push('    note: final line was incomplete (read while the file was still being written)');
    for (const target of summary.targets) {
      const head = `    ${target.label}/${target.role}:${target.port ?? '?'}`;
      if (!target.observed) {
        lines.push(`${head}  NOT OBSERVED  missing rows ${target.missingRows}`);
        continue;
      }
      lines.push(
        `${head}  epochs ${target.epochs.length}  restarts ${target.restarts}  ` +
        `${target.resumes ? `resumes ${target.resumes}  ` : ''}` +
        `cpu ${target.cpuSecondsTotal.toFixed(3)}s total  missing rows ${target.missingRows}` +
        `${target.ioResets ? `  io resets ${target.ioResets}` : ''}`,
      );
      target.epochs.forEach((epoch, epochIndex) => {
        const revision = epoch.revision?.shortCommit
          ? `${epoch.revision.shortCommit}${epoch.revision.dirty ? ' (dirty)' : ''}`
          : 'unknown';
        const revisionState = epoch.revisionMatches === null || epoch.revisionMatches === undefined
          ? ''
          : epoch.revisionMatches ? '  expected-match' : '  EXPECTED-REVISION-MISMATCH';
        lines.push(
          `      epoch ${epochIndex + 1}  pid ${epoch.pid ?? '?'}  identity ${epoch.identity}  ` +
          `samples ${epoch.sampleCount}  coverage ${formatPct(epoch.coveragePct)}  revision ${revision}${revisionState}`,
        );
        lines.push(
          `        cpu ${epoch.cpuSeconds.toFixed(3)}s  mean ${formatPct(epoch.meanCorePct)}  peak ${formatPct(epoch.peakCorePct)}` +
          `${epoch.meanMachinePct === null ? '' : `  (machine mean ${formatPct(epoch.meanMachinePct)} / peak ${formatPct(epoch.peakMachinePct)})`}`,
        );
        lines.push(
          `        memory working set mean ${formatBytes(epoch.workingSetMeanBytes)}  peak ${formatBytes(epoch.workingSetPeak)}` +
          `  private mean ${formatBytes(epoch.privateMeanBytes)}  peak ${formatBytes(epoch.privatePeak)}`,
        );
        if (epoch.io) {
          lines.push(
            `        io (process counters) read ${formatBytes(epoch.io.readBytes)}/${epoch.io.readOperations.toFixed(0)} ops  ` +
            `write ${formatBytes(epoch.io.writeBytes)}/${epoch.io.writeOperations.toFixed(0)} ops  ` +
            `other ${formatBytes(epoch.io.otherBytes)}/${epoch.io.otherOperations.toFixed(0)} ops`,
          );
        }
        if (epoch.ioResets > 0) {
          lines.push(`        io: ${epoch.ioResets} interval(s) skipped after a counter reset (unknown, not zero)`);
        }
        if (epoch.gaps > 0) lines.push(`        partial: ${epoch.gaps} sampling gap(s) longer than the interval`);
      });
    }
    if (summary.observer) {
      lines.push(
        `    observer overhead: ${summary.observer.samples ?? 'n/a'} sample(s)  ` +
        `cpu ${summary.observer.cpuSeconds ?? summary.observer.totalCpuSeconds ?? 'n/a'}s  peak working set ${formatBytes(summary.observer.peakWorkingSetBytes)}`,
      );
    }
    lines.push('');
  });
  lines.push('Notes:');
  lines.push('- cpu percentages are process CPU time over interval wall time; machine % divides by logical CPU count.');
  lines.push('- io values come from Win32_Process process I/O counters, not physical disk I/O.');
  lines.push('- io intervals whose counters reset are skipped and counted as io resets; unknown is never reported as zero.');
  lines.push('- coverage is the share of nominal sampling slots filled, not proof of continuous measurement.');
  lines.push('- resumes mean a target reappeared with the same identity after a missing window; the next delta spans that gap.');
  lines.push('- descendant metrics are lifetime-cumulative values of currently alive children, not interval deltas, and are not summarized.');
  lines.push('- epochs are separate process identities; sums never mix epochs.');
  return lines.join('\n');
}

function expandInputs(paths) {
  const files = [];
  for (const path of paths) {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (extname(name).toLowerCase() === '.ndjson') files.push(join(path, name));
      }
    } else {
      files.push(path);
    }
  }
  return files;
}

function assertClose(actual, expected, label, tolerance = 1e-6) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    throw new Error(`self-test failed: ${label} expected ${expected}, got ${actual}`);
  }
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`self-test failed: ${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function selfTest() {
  const rows = [
    { kind: 'run_start', schemaVersion: 1, runId: 'testrun', timestampUtc: '2026-01-01T00:00:00.0000000Z',
      arguments: { intervalSeconds: 2, durationSeconds: 8 }, host: { logicalCpuCount: 4 },
      targets: [
        { label: 'main', role: 'backend', port: 4317, checkoutPath: 'C:/main' },
        { label: 'rust', role: 'backend', port: 4318, checkoutPath: 'C:/rust' },
      ] },
    { kind: 'identity', runId: 'testrun', label: 'main', role: 'backend', port: 4317, reason: 'start',
      process: { pid: 100, creationDate: 'c1', identity: '100@c1' },
      revision: { commit: 'abc123456789', shortCommit: 'abc123456789', dirty: true, changedFileCount: 2 },
      expectedRevision: 'abc123', revisionMatches: true },
    { kind: 'sample', runId: 'testrun', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 0,
      timestampUtc: '2026-01-01T00:00:00.0000000Z', process: { pid: 100, creationDate: 'c1', identity: '100@c1' },
      counters: { workingSetBytes: 100e6, privateBytes: 80e6 }, deltas: { intervalSeconds: 0, cpu: null, io: null } },
    { kind: 'sample', runId: 'testrun', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 2,
      timestampUtc: '2026-01-01T00:00:02.0000000Z', process: { pid: 100, creationDate: 'c1', identity: '100@c1' },
      counters: { workingSetBytes: 120e6, privateBytes: 90e6 },
      deltas: { intervalSeconds: 2, cpu: { cpuSeconds: 1, coreEquivalentPct: 50, machineCapacityPct: 12.5 },
        io: { ReadTransferCount: 1000, WriteTransferCount: 200, OtherTransferCount: 0,
          ReadOperationCount: 2, WriteOperationCount: 3, OtherOperationCount: 0 } } },
    { kind: 'sample', runId: 'testrun', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 4,
      timestampUtc: '2026-01-01T00:00:04.0000000Z', process: { pid: 100, creationDate: 'c1', identity: '100@c1' },
      counters: { workingSetBytes: 80e6, privateBytes: 70e6 },
      deltas: { intervalSeconds: 2, cpu: { cpuSeconds: 0.4, coreEquivalentPct: 20, machineCapacityPct: 5 },
        io: { ReadTransferCount: 500, WriteTransferCount: 100, OtherTransferCount: 0,
          ReadOperationCount: 1, WriteOperationCount: 1, OtherOperationCount: 0 } } },
    { kind: 'identity', runId: 'testrun', label: 'main', role: 'backend', port: 4317, reason: 'restart',
      process: { pid: 200, creationDate: 'c2', identity: '200@c2' },
      revision: { commit: 'def456789012', shortCommit: 'def456789012', dirty: false },
      expectedRevision: null, revisionMatches: null },
    { kind: 'sample', runId: 'testrun', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 6,
      timestampUtc: '2026-01-01T00:00:06.0000000Z', process: { pid: 200, creationDate: 'c2', identity: '200@c2' },
      counters: { workingSetBytes: 50e6, privateBytes: 40e6 }, deltas: { intervalSeconds: 0, cpu: null, io: null } },
    { kind: 'sample', runId: 'testrun', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 8,
      timestampUtc: '2026-01-01T00:00:08.0000000Z', process: { pid: 200, creationDate: 'c2', identity: '200@c2' },
      counters: { workingSetBytes: 60e6, privateBytes: 45e6 },
      deltas: { intervalSeconds: 2, cpu: { cpuSeconds: 2, coreEquivalentPct: 100, machineCapacityPct: 25 },
        io: { ReadTransferCount: 0, WriteTransferCount: 0, OtherTransferCount: 0,
          ReadOperationCount: 0, WriteOperationCount: 0, OtherOperationCount: 0 } } },
    { kind: 'missing', runId: 'testrun', label: 'rust', role: 'backend', port: 4318, elapsedSeconds: 0,
      timestampUtc: '2026-01-01T00:00:00.0000000Z', reason: 'no-listener' },
    { kind: 'run_end', runId: 'testrun', timestampUtc: '2026-01-01T00:00:08.5000000Z', elapsedSeconds: 8.5,
      stopReason: 'duration', observer: { totalCpuSeconds: 0.1, peakWorkingSetBytes: 50e6 } },
  ];
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const summary = summarizeFile('synthetic.ndjson', text);
  assertEqual(summary.complete, true, 'run complete');
  assertEqual(summary.restartTotal, 1, 'restart total');
  assertEqual(summary.missingTotal, 1, 'missing total');
  assertEqual(summary.targets.length, 2, 'target count');

  const main = summary.targets.find((target) => target.label === 'main');
  assertEqual(main.epochs.length, 2, 'main epoch count');
  assertClose(main.cpuSecondsTotal, 3.4, 'main cpu total');
  const first = main.epochs[0];
  assertClose(first.cpuSeconds, 1.4, 'epoch 1 cpu seconds');
  assertClose(first.meanCorePct, 35, 'epoch 1 mean core pct');
  assertClose(first.peakCorePct, 50, 'epoch 1 peak core pct');
  assertClose(first.meanMachinePct, 8.75, 'epoch 1 mean machine pct');
  assertClose(first.workingSetMeanBytes, 100e6, 'epoch 1 memory mean');
  assertClose(first.workingSetPeak, 120e6, 'epoch 1 memory peak');
  assertClose(first.io.readBytes, 1500, 'epoch 1 read bytes');
  assertClose(first.io.writeOperations, 4, 'epoch 1 write ops');
  assertClose(first.coveragePct, 100, 'epoch 1 coverage');
  assertEqual(first.revision.shortCommit, 'abc123456789', 'epoch 1 revision');
  assertEqual(first.revisionMatches, true, 'epoch 1 expected match');
  const second = main.epochs[1];
  assertClose(second.cpuSeconds, 2, 'epoch 2 cpu seconds');
  assertClose(second.meanCorePct, 100, 'epoch 2 mean core pct');
  assertClose(second.meanMachinePct, 25, 'epoch 2 mean machine pct');
  assertEqual(second.revision.shortCommit, 'def456789012', 'epoch 2 revision');
  const rust = summary.targets.find((target) => target.label === 'rust');
  assertEqual(rust.observed, false, 'rust not observed');
  assertEqual(rust.missingRows, 1, 'rust missing rows');

  const incomplete = summarizeFile('synthetic.ndjson', rows.slice(0, -1).map((row) => JSON.stringify(row)).join('\n'));
  assertEqual(incomplete.complete, false, 'run_end missing marks incomplete');
  assertEqual(incomplete.targets.find((target) => target.label === 'rust').missingRows, 1, 'incomplete keeps rows');

  const partial = parseObservations(text + '{"kind":"sample"');
  assertEqual(partial.trailingPartial, true, 'trailing partial line detected');
  assertEqual(partial.malformedLines, 0, 'trailing partial is not counted as malformed');

  const malformed = parseObservations('{"kind":"run_start"}\nnot json\n{"kind":"run_end"}');
  assertEqual(malformed.malformedLines, 1, 'interior malformed line counted');

  const unknownKinds = parseObservations('{"kind":"run_start"}\n{"kind":"future_row","x":1}\n{"kind":"run_end"}');
  assertEqual(unknownKinds.unknownKinds, 1, 'unknown record kind counted separately');
  assertEqual(unknownKinds.malformedLines, 0, 'unknown record kind is not malformed');

  // Missing window -> same identity reappears: one epoch, the post-gap delta is
  // kept, and the loss is visible as a resume rather than a silent restart.
  const resumeRows = [
    { kind: 'run_start', runId: 'r', arguments: { intervalSeconds: 2 }, host: { logicalCpuCount: 4 },
      targets: [{ label: 'main', role: 'backend', port: 4317 }] },
    { kind: 'identity', runId: 'r', label: 'main', role: 'backend', port: 4317, reason: 'start', elapsedSeconds: 0,
      process: { pid: 100, creationDate: 'c1', identity: '100@c1' } },
    { kind: 'sample', runId: 'r', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 0,
      process: { pid: 100, creationDate: 'c1', identity: '100@c1' },
      counters: { workingSetBytes: 1e6, privateBytes: 1e6 }, deltas: { intervalSeconds: 0, cpu: null, io: null } },
    { kind: 'sample', runId: 'r', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 2,
      process: { pid: 100, creationDate: 'c1', identity: '100@c1' },
      counters: { workingSetBytes: 1e6, privateBytes: 1e6 },
      deltas: { intervalSeconds: 2, cpu: { cpuSeconds: 1, coreEquivalentPct: 50, machineCapacityPct: 12.5 },
        io: { ReadTransferCount: 500, WriteTransferCount: 0, OtherTransferCount: 0,
          ReadOperationCount: 1, WriteOperationCount: 0, OtherOperationCount: 0 } } },
    { kind: 'missing', runId: 'r', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 4,
      reason: 'process-gone', process: { pid: 100 } },
    { kind: 'identity', runId: 'r', label: 'main', role: 'backend', port: 4317, reason: 'resume', elapsedSeconds: 10,
      gapSeconds: 8, process: { pid: 100, creationDate: 'c1', identity: '100@c1' } },
    { kind: 'sample', runId: 'r', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 10,
      process: { pid: 100, creationDate: 'c1', identity: '100@c1' },
      counters: { workingSetBytes: 1e6, privateBytes: 1e6 },
      deltas: { intervalSeconds: 8, cpu: { cpuSeconds: 1.5, coreEquivalentPct: 18.75, machineCapacityPct: 4.6875 },
        io: { ReadTransferCount: null, WriteTransferCount: null, OtherTransferCount: null,
          ReadOperationCount: null, WriteOperationCount: null, OtherOperationCount: null, counterReset: true } } },
  ];
  const resumeSummary = summarizeFile('resume.ndjson', resumeRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const resumeTarget = resumeSummary.targets[0];
  assertEqual(resumeTarget.epochs.length, 1, 'same identity after a gap stays one epoch');
  assertEqual(resumeTarget.restarts, 0, 'same-identity reappearance is not a restart');
  assertEqual(resumeTarget.resumes, 1, 'resume counted');
  assertClose(resumeTarget.resumeGapSeconds, 8, 'resume gap seconds');
  assertClose(resumeTarget.cpuSecondsTotal, 2.5, 'cpu consumed across the gap is retained');
  assertClose(resumeTarget.epochs[0].cpuSeconds, 2.5, 'epoch cpu includes the post-gap delta');
  assertClose(resumeTarget.epochs[0].io.readBytes, 500, 'reset interval contributes no bytes');
  assertEqual(resumeTarget.ioResets, 1, 'io reset counted at target level');
  assertEqual(resumeTarget.epochs[0].ioResets, 1, 'io reset counted at epoch level');
  assertEqual(resumeTarget.epochs[0].ioObserved, true, 'valid io interval still observed');
  assertClose(resumeTarget.epochs[0].coveragePct, 50, 'coverage reflects the missing window');
  assertEqual(resumeTarget.epochs[0].gaps, 1, 'the missing window counts as a sampling gap');

  // A changed identity after the same missing window is a restart: a new epoch,
  // a baseline sample with no delta, and no CPU crossing identities.
  const changedRows = resumeRows.slice(0, 4).concat([
    { kind: 'missing', runId: 'r', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 4,
      reason: 'process-gone', process: { pid: 100 } },
    { kind: 'identity', runId: 'r', label: 'main', role: 'backend', port: 4317, reason: 'restart', elapsedSeconds: 10,
      process: { pid: 200, creationDate: 'c2', identity: '200@c2' } },
    { kind: 'sample', runId: 'r', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 10,
      process: { pid: 200, creationDate: 'c2', identity: '200@c2' },
      counters: { workingSetBytes: 1e6, privateBytes: 1e6 }, deltas: { intervalSeconds: 0, cpu: null, io: null } },
    { kind: 'sample', runId: 'r', label: 'main', role: 'backend', port: 4317, elapsedSeconds: 12,
      process: { pid: 200, creationDate: 'c2', identity: '200@c2' },
      counters: { workingSetBytes: 1e6, privateBytes: 1e6 },
      deltas: { intervalSeconds: 2, cpu: { cpuSeconds: 2, coreEquivalentPct: 100, machineCapacityPct: 25 }, io: null } },
  ]);
  const changedSummary = summarizeFile('changed.ndjson', changedRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const changedTarget = changedSummary.targets[0];
  assertEqual(changedTarget.epochs.length, 2, 'changed identity starts a new epoch');
  assertEqual(changedTarget.restarts, 1, 'changed identity is a restart');
  assertEqual(changedTarget.resumes, 0, 'changed identity is not a resume');
  assertClose(changedTarget.cpuSecondsTotal, 3, 'epoch deltas sum without crossing identities');
  assertEqual(changedTarget.epochs[1].sampleCount, 2, 'new epoch has its own baseline');
  assertClose(changedTarget.epochs[1].cpuSeconds, 2, 'new epoch cpu comes only from its own delta');

  console.log('self-test: all checks passed');
}

export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      'self-test': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values['self-test']) { selfTest(); return; }
  if (values.help || positionals.length === 0) {
    console.log('Usage: node scripts/summarize-runtime-observations.mjs <file-or-dir> [...] [--json] [--self-test]');
    if (values.help) return;
    process.exitCode = 1;
    return;
  }
  const files = expandInputs(positionals);
  const summaries = files.map((file) => summarizeFile(file, readFileSync(file, 'utf8')));
  if (values.json) console.log(JSON.stringify({ toolVersion: TOOL_VERSION, summaries }, null, 2));
  else console.log(formatReport(summaries));
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
