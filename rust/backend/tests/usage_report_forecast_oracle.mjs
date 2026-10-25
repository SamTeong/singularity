// Synthetic Node oracle for the pure bundled forecast functions. This file
// deliberately imports forecast.mjs only (never stats.mjs or real state).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import process from 'node:process';
import * as FC from '../../../.claude/skills/harness-usage-report/scripts/forecast.mjs';

// SOURCE-BOUND: the Rust integration test feeds the exact same numeric JSON
// fixture to this bridge and to the public Rust API.
if (process.env.FORECAST_ORACLE_BRIDGE === '1') {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const fixture = JSON.parse(raw);
  const prior = FC.fitPrior(fixture.priorSessions, fixture.sigmaSessionSq, fixture.varianceEps);
  const calibration = FC.calibrateSigmaSession(
    fixture.calibrationSessions,
    fixture.prior,
    fixture.config,
    fixture.forecastsPerSession,
    fixture.minHorizonSec,
  );
  const forecast = FC.runForecast(fixture.forecastInput, fixture.config);
  process.stdout.write(JSON.stringify({
    prior,
    calibration,
    forecast,
    defaultedForecast: FC.runForecast(fixture.forecastInput, {
      tauRecentSec: 0, mcTraj: 0, mcStepSec: 0, varianceEps: 0,
    }),
    recent: FC.filterRecent(fixture.boundarySnapshots, fixture.nowSec, fixture.config.tauRecentSec),
    ineligible: FC.runForecast({ ...fixture.forecastInput, resetSec: fixture.nowSec }, fixture.config),
    nonfinite: JSON.parse(JSON.stringify([NaN, Infinity, -Infinity])),
  }));
} else {

const priorSessions = [
  { uFinal: 1, durationHours: 1 },
  { uFinal: 6, durationHours: 2 },
  { uFinal: 900, durationHours: 0 },
];

test('prior excludes nonpositive windows and applies calibration correction', () => {
  assert.deepEqual(FC.fitPrior(priorSessions, 0.25, 1e-6), {
    mu0: 2,
    tau0Sq: 1.8125,
    nSessions: 2,
    ok: true,
  });
});

test('recent cutoff is inclusive and the last drop precedes future filtering', () => {
  assert.deepEqual(FC.filterRecent([
    { t: 49, u: 20 },
    { t: 50, u: 25 },
    { t: 70, u: 35 },
    { t: 80, u: 5 },
    { t: 110, u: 7 },
  ], 100, 50), [{ t: 80, u: 5 }]);
});

test('valid OLS preserves the current undefined-seSq fallback and typo key', () => {
  const posterior = FC.estimatePosterior([
    { t: 0, u: 1 },
    { t: 1800, u: 2 },
    { t: 3600, u: 3 },
  ], { mu0: 4, tau0Sq: 2 });
  assert.deepEqual(posterior, {
    rHat: 4,
    tauPostSq: 2,
    n: 3,
    seOolsSq: 0,
    usedOLS: false,
  });
});

test('forecast keeps caller threshold order, seeded repeatability and reset eligibility', () => {
  const input = {
    nowSec: 10000,
    resetSec: 17200,
    uNow: 20,
    snapshots: [
      { t: 8000, u: 10 },
      { t: 9000, u: 15 },
      { t: 9900, u: 20 },
    ],
    prior: { mu0: 2, tau0Sq: 0.5, nSessions: 2 },
    calibration: { sigmaSessionSq: 0.1, barTauSq: 0 },
    thresholds: [20, 80],
  };
  const config = { ...FC.defaultConfig(), mcTraj: 12 };
  const first = FC.runForecast(input, config);
  assert.deepEqual(FC.runForecast(input, config), first);
  assert.equal(first.etas[20].median, input.nowSec);
  assert.equal(first.modelVersion, 'v2.1-js');
  assert.deepEqual(FC.runForecast({ ...input, resetSec: input.nowSec }, config), { ok: false });
});
}
