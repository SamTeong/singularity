// Machine-wide CPU% + RAM readout. Pure node:os, no persisted state.
// os.loadavg() is always 0 on Windows, so CPU% is derived from a rolling
// delta of os.cpus() core times instead (sampled every 2s).
import os from 'node:os';

function sampleCpus() {
  let idle = 0, total = 0;
  for (const { times } of os.cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

let prevSample = sampleCpus();
let lastCpu = null;

// One sample per 2s tick, capped at 1800 = 1 h of history (client slices the
// tail for its selected 5 min / 30 min / 1 h window).
const HISTORY_CAP = 1800;
const history = [];

function tick() {
  const sample = sampleCpus();
  const idleDelta = sample.idle - prevSample.idle;
  const totalDelta = sample.total - prevSample.total;
  if (totalDelta > 0) lastCpu = Math.round(100 * (1 - idleDelta / totalDelta));
  prevSample = sample;

  const memPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  history.push({ cpu: lastCpu, mem: memPct });
  if (history.length > HISTORY_CAP) history.shift();
}

const timer = setInterval(tick, 2000);
timer.unref();

export function getSysStats() {
  const total = os.totalmem();
  const used = total - os.freemem();
  return {
    cpu: lastCpu,
    mem: { total, used, pct: Math.round((used / total) * 100) },
    history: {
      cpu: history.map((h) => h.cpu),
      mem: history.map((h) => h.mem),
      stepMs: 2000,
    },
  };
}
