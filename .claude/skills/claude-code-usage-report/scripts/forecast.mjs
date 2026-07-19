// Empirical-Bayes rate-limit forecast, ported from claumon internal/forecast
// (MODEL spec v2.1; see claumon internal/forecast/MODEL.pdf). Node ESM, stdlib
// only, pure functions (no fs) — stats.mjs owns data assembly + persistence.
//
// Units: utilization U and threshold are in PERCENT (0..100), matching the
// OAuth usage API and statusline rate_limits.used_percentage. Rates are
// percent/hour; variances percent^2/hour (rate) and percent^2/hour (path noise).
// Times are epoch seconds at the boundaries; converted to hours inside fits.
//
// References in comments (§3, §4, §5, §8) point to MODEL.pdf sections.

export const MODEL_VERSION = "v2.1-js";
const Z90 = 1.2815515655446004; // Phi^{-1}(0.9), 80% CI half-width
const HOUR_S = 3600;            // seconds per hour (sec<->hour conversion)
const MIN_HOURS_S = 60;

export function defaultConfig() {
  return {
    tauRecentSec: 30 * 60,   // §3 recency window
    mcTraj: 400,             // §8 trajectories (reduced from claumon's 500 for local-report cost)
    mcStepSec: 5 * 60,       // §8 step size
    varianceEps: 1e-6,       // floor for variance estimates
  };
}

function withDefaults(cfg) {
  const d = defaultConfig();
  return {
    tauRecentSec: cfg.tauRecentSec || d.tauRecentSec,
    mcTraj: cfg.mcTraj || d.mcTraj,
    mcStepSec: cfg.mcStepSec || d.mcStepSec,
    varianceEps: cfg.varianceEps || d.varianceEps,
  };
}

function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function sampleVar(xs, m) {
  if (xs.length < 2) return 0;
  let s = 0;
  for (const x of xs) { const d = x - m; s += d * d; }
  return s / (xs.length - 1);
}

// §3: OLS fit u_i = alpha + r * t_i (times in hours since first snapshot).
// Returns {rHat, seOlsSq, ok}. ok=false when n<3 or S_tt==0.
function olsFit(snaps) {
  const n = snaps.length;
  if (n < 3) return { rHat: 0, seOlsSq: 0, ok: false };
  const t0 = snaps[0].t;
  const ts = new Array(n), us = new Array(n);
  let tBar = 0, uBar = 0;
  for (let i = 0; i < n; i++) {
    ts[i] = (snaps[i].t - t0) / HOUR_S;
    us[i] = snaps[i].u;
    tBar += ts[i]; uBar += us[i];
  }
  tBar /= n; uBar /= n;
  let sTT = 0, sTU = 0;
  for (let i = 0; i < n; i++) {
    const dt = ts[i] - tBar, du = us[i] - uBar;
    sTT += dt * dt; sTU += dt * du;
  }
  if (sTT <= 0) return { rHat: 0, seOlsSq: 0, ok: false };
  const rHat = sTU / sTT;
  const alpha = uBar - rHat * tBar;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const res = us[i] - alpha - rHat * ts[i];
    rss += res * res;
  }
  const sigmaEpsSq = rss / (n - 2);
  return { rHat, seOlsSq: sigmaEpsSq / sTT, ok: true };
}

// §3: fuse OLS on the recent window with the prior via normal-normal conjugacy.
export function estimatePosterior(recent, prior) {
  const { rHat: rOLS, seSq, ok } = olsFit(recent);
  if (!ok || seSq <= 0 || prior.tau0Sq <= 0) {
    return { rHat: prior.mu0, tauPostSq: prior.tau0Sq, n: recent.length, seOlsSq: 0, usedOLS: false };
  }
  const precPrior = 1 / prior.tau0Sq;
  const precData = 1 / seSq;
  const tauPostSq = 1 / (precPrior + precData);
  let rHat = tauPostSq * (prior.mu0 * precPrior + rOLS * precData);
  if (!Number.isFinite(rHat)) {
    return { rHat: prior.mu0, tauPostSq: prior.tau0Sq, n: recent.length, seOolsSq: 0, usedOLS: false };
  }
  return { rHat, tauPostSq, n: recent.length, seOlsSq: seSq, usedOLS: true };
}

// §3: Gaussian prior on r from completed sessions, with the §5 noise correction.
// sessions: [{uFinal, durationHours}]. sigmaSessionSq=0 on first fit (no-op).
export function fitPrior(sessions, sigmaSessionSq, varianceEps) {
  const rhos = [], invDs = [];
  for (const s of sessions) {
    if (s.durationHours <= 0) continue;
    rhos.push(s.uFinal / s.durationHours);
    invDs.push(1 / s.durationHours);
  }
  if (rhos.length < 2) return { ok: false };
  const mu0 = mean(rhos);
  const rawVar = sampleVar(rhos, mu0);
  const correction = sigmaSessionSq * mean(invDs);
  let tau0Sq = rawVar - correction;
  if (tau0Sq < varianceEps) tau0Sq = varianceEps;
  return { mu0, tau0Sq, nSessions: rhos.length, ok: true };
}

export function effectiveRateVar(tauPostSq, barTauSq) {
  return barTauSq > tauPostSq ? barTauSq : tauPostSq;
}

// §4: Gaussian forecast at reset with analytic 80% CI (later overwritten by MC
// terminal p10/p90 in runForecast). Lower floored at uNow; both edges uncapped
// above (model v2.1: values >100 = demand beyond the window limit).
export function projectForecast(uNow, rHat, tauPostSq, sigmaSessionSq, deltaTHours) {
  const f = uNow + rHat * deltaTHours;
  const rateVar = deltaTHours * deltaTHours * tauPostSq;
  const pathVar = deltaTHours * sigmaSessionSq;
  const sigmaF = Math.sqrt(rateVar + pathVar);
  const floor = uNow < 0 ? 0 : uNow;
  const lo = f - Z90 * sigmaF, hi = f + Z90 * sigmaF;
  return { f, sigmaF, lower: Math.max(floor, lo), upper: Math.max(floor, hi), deltaT: deltaTHours };
}

// §3 recency window: snapshots in (now-tau, now], with §8 mid-window reset
// detection — if a drop (u_{i+1} < u_i) appears, truncate to the post-drop tail.
export function filterRecent(all, nowSec, tauSec) {
  const cutoff = nowSec - tauSec;
  let start = 0;
  for (let i = 0; i < all.length; i++) {
    if (all[i].t >= cutoff) { start = i; break; }
    start = i + 1;
  }
  let window = all.slice(start);
  let dropAt = -1;
  for (let i = 1; i < window.length; i++) {
    if (window[i].u < window[i - 1].u) dropAt = i;
  }
  if (dropAt >= 0) window = window.slice(dropAt);
  return window.filter((s) => s.t <= nowSec);
}

// Linear interpolation of u at tf; clips to nearest endpoint outside range.
function interpAt(snaps, tf) {
  if (!snaps.length) return { u: 0, ok: false };
  if (tf <= snaps[0].t) return { u: snaps[0].u, ok: true };
  const last = snaps[snaps.length - 1];
  if (tf >= last.t) return { u: last.u, ok: true };
  for (let i = 1; i < snaps.length; i++) {
    if (snaps[i].t >= tf) {
      const a = snaps[i - 1], b = snaps[i];
      const total = b.t - a.t;
      if (total === 0) return { u: a.u, ok: true };
      return { u: a.u + ((tf - a.t) / total) * (b.u - a.u), ok: true };
    }
  }
  return { u: last.u, ok: true };
}

// ---- RNG (deterministic from inputs; Marsaglia-Tsang Gamma + Box-Muller normal) ----

function fnv1a64Seed(parts) {
  // 64-bit FNV-1a over the IEEE754 bytes of each input; low 32 bits seed mulberry32.
  let h = 0xcbf29ce484222325n; // FNV offset basis (64-bit)
  const mask = 0xffffffffffffffffn;
  const buf = new Float64Array(1);
  const bytes = new Uint8Array(buf.buffer);
  for (const v of parts) {
    if (typeof v === "number") {
      buf[0] = v;
      for (let i = 0; i < 8; i++) h = ((h ^ BigInt(bytes[i])) * 0x100000001b3n) & mask;
    } else {
      for (let i = 0; i < v.length; i++) {
        h = ((h ^ BigInt(v.charCodeAt(i) & 0xff)) * 0x100000001b3n) & mask;
      }
    }
  }
  return Number(h & 0xffffffffn) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t ^ Math.imul(t ^ (t >>> 7), t | 61)) ^ (t >>> 14);
    return ((t + 0x80000000) >>> 0) / 0x100000000;
  };
}

function makeRng(seed) {
  const u = mulberry32(seed);
  // Box-Muller normal, cached pair.
  let spare = null;
  function norm() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let r = 0, m;
    do {
      const x = u() * 2 - 1, y = u() * 2 - 1;
      r = x * x + y * y;
      if (r > 0 && r < 1) {
        m = Math.sqrt((-2 * Math.log(r)) / r);
        spare = y * m;
        return x * m;
      }
    } while (true);
  }
  return { float: u, norm };
}

function sampleGammaMeanVar(rng, mean, variance) {
  if (mean <= 0) return 0;
  if (variance <= 0) return mean;
  const shape = (mean * mean) / variance;
  const scale = variance / mean;
  return sampleGamma(rng, shape, scale);
}

function sampleGamma(rng, shape, scale) {
  if (shape <= 0) return 0;
  if (shape < 1) {
    let uu = rng.float();
    while (uu <= 0) uu = rng.float();
    return sampleGamma(rng, shape + 1, scale) * Math.pow(uu, 1 / shape);
  }
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = rng.norm();
    const v = 1 + c * x;
    if (v <= 0) continue;
    const vv = v * v * v;
    const uu = rng.float();
    const x2 = x * x;
    if (uu < 1 - 0.0331 * x2 * x2) return d * vv * scale;
    if (Math.log(uu) < 0.5 * x2 + d * (1 - vv + Math.log(vv))) return d * vv * scale;
  }
}

// §8: monotone Gamma-process MC. Returns terminal utilization per trajectory
// (for the 80% CI), first-passage hours (for ETA), and PInf (never-crossed frac).
function runMC(nowSec, resetSec, uNow, post, cal, threshold, cfg, collectTraj) {
  cfg = withDefaults(cfg);
  const horizonSec = resetSec - nowSec;
  if (horizonSec <= 0) return { ok: false };
  let step = cfg.mcStepSec;
  if (step <= 0) step = 5 * 60;
  if (step > horizonSec) step = horizonSec;
  // Cap step so nSteps stays bounded for long horizons (weekly) — keeps the
  // local-report cost predictable. ~300 steps max.
  const maxSteps = 300;
  const minStepForCap = Math.ceil(horizonSec / maxSteps);
  if (step < minStepForCap) step = minStepForCap;
  let nSteps = Math.ceil(horizonSec / step);
  if (nSteps < 1) nSteps = 1;
  const dt = (horizonSec / nSteps) / HOUR_S; // hours per step
  const incVarStep = cal.sigmaSessionSq * dt;
  const rateVar = Math.max(effectiveRateVar(post.tauPostSq, cal.barTauSq), 0);

  const seed = fnv1a64Seed([nowSec, resetSec, uNow, post.rHat, post.tauPostSq,
    cal.sigmaSessionSq, cal.barTauSq, threshold]);
  const rng = makeRng(seed);

  const K = cfg.mcTraj;
  const finite = [];
  const terminal = new Array(K);
  const trajectories = collectTraj ? new Array(K) : null;
  let infCount = 0;

  for (let k = 0; k < K; k++) {
    // Per-path rate (per-hour): Gamma(mean=RHat, var=rateVar). Then each step's
    // increment is Gamma(mean=rk*dt, var=sigmaSessionSq*dt) — monotone, matches
    // the Brownian model's first two moments (claumon eta.go runMC).
    const rk = sampleGammaMeanVar(rng, post.rHat, rateVar);
    let u = uNow, hitHours = Infinity;
    const path = collectTraj ? new Array(nSteps + 1) : null;
    if (path) path[0] = uNow;
    for (let j = 1; j <= nSteps; j++) {
      const uPrev = u;
      u = uPrev + sampleGammaMeanVar(rng, rk * dt, incVarStep);
      if (path) path[j] = u;
      if (hitHours === Infinity && u >= threshold) {
        const frac = u !== uPrev ? (threshold - uPrev) / (u - uPrev) : 0;
        hitHours = (j - 1 + frac) * dt;
      }
    }
    terminal[k] = u;
    if (collectTraj) trajectories[k] = path;
    if (hitHours === Infinity) infCount++;
    else finite.push(hitHours);
  }
  return {
    ok: true, stepHours: dt, trajectories, crossingsH: finite, terminal,
    pInf: infCount / K, nTraj: K,
  };
}

// percentile on a sorted array, treating sample size as totalN (so a +Inf tail
// via totalN > len returns Infinity when the rank falls past the finite count).
function pctSorted(sorted, p, totalN) {
  if (totalN === 0) return NaN;
  if (!sorted.length) return Infinity;
  const rank = p * (totalN - 1);
  const finiteCount = sorted.length;
  if (rank >= finiteCount) return Infinity;
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  const hiC = hi >= finiteCount ? finiteCount - 1 : hi;
  if (lo === hiC) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hiC] * frac;
}

function terminalCI(terminal) {
  if (!terminal.length) return { lo: NaN, hi: NaN };
  const s = terminal.slice().sort((a, b) => a - b);
  return { lo: pctSorted(s, 0.1, s.length), hi: pctSorted(s, 0.9, s.length) };
}

// §8 reporting rules. Median nil when ≥half never crossed; Upper nil when
// 10%–50% never crossed (open-ended). Times returned as epoch seconds.
function summarizeETA(nowSec, s) {
  if (s.pInf >= 0.5) return { pInf: s.pInf };
  const finite = s.crossingsH.slice().sort((a, b) => a - b);
  const infCount = s.nTraj - finite.length;
  const medianHours = pctSorted(finite, 0.5, finite.length + infCount);
  const median = nowSec + medianHours * HOUR_S;
  let lower = null, upper = null;
  if (s.pInf < 0.1) {
    lower = nowSec + pctSorted(finite, 0.1, finite.length) * HOUR_S;
    upper = nowSec + pctSorted(finite, 0.9, finite.length) * HOUR_S;
  } else {
    lower = nowSec + pctSorted(finite, 0.1, finite.length) * HOUR_S;
  }
  return { median, lower, upper, pInf: s.pInf };
}

// §5: replay the forecaster across past completed sessions, fit
// e^2 = a*delta + b*delta^2 (weighted 1/delta^2); a = sigmaSessionSq, b = barTauSq.
// sessions: [{resetSec, durationHours, uFinal, snapshots:[{t,u}]}].
export function calibrateSigmaSession(sessions, prior, cfg, forecastsPerSession = 6, minHorizonSec = 30 * MIN_HOURS_S) {
  cfg = withDefaults(cfg);
  const samples = [];
  for (const s of sessions) {
    if (s.snapshots.length < 3 || s.durationHours <= 0) continue;
    const tStart = s.snapshots[0].t;
    const earliest = tStart + cfg.tauRecentSec;
    const latest = s.resetSec - minHorizonSec;
    if (latest <= earliest) continue;
    for (let k = 0; k < forecastsPerSession; k++) {
      const frac = (k + 0.5) / forecastsPerSession;
      const tf = earliest + frac * (latest - earliest);
      const recent = filterRecent(s.snapshots, tf, cfg.tauRecentSec);
      if (recent.length < 3) continue;
      const { u: uAtTf, ok } = interpAt(s.snapshots, tf);
      if (!ok) continue;
      const post = estimatePosterior(recent, prior);
      const delta = (s.resetSec - tf) / HOUR_S;
      if (delta <= 0) continue;
      const fHat = uAtTf + post.rHat * delta;
      const e = s.uFinal - fHat;
      samples.push({ delta, eSq: e * e });
    }
  }
  if (samples.length < 2) return { sigmaSessionSq: cfg.varianceEps, barTauSq: 0 };
  // Weighted (w=1/delta^2) no-intercept fit of z = a*x + b*x^2:
  //   a*n + b*Sx = S(z/x); a*Sx + b*Sxx = Sz.
  let n = 0, sx = 0, sxx = 0, szOverX = 0, sz = 0;
  for (const p of samples) {
    if (p.delta <= 0) continue;
    n++; sx += p.delta; sxx += p.delta * p.delta;
    szOverX += p.eSq / p.delta; sz += p.eSq;
  }
  const det = n * sxx - sx * sx;
  if (det === 0) return { sigmaSessionSq: cfg.varianceEps, barTauSq: 0 };
  let aHat = (szOverX * sxx - sz * sx) / det;
  let bHat = (n * sz - sx * szOverX) / det;
  if (!Number.isFinite(aHat) || aHat < cfg.varianceEps) aHat = cfg.varianceEps;
  if (!Number.isFinite(bHat) || bHat < 0) bHat = 0;
  return { sigmaSessionSq: aHat, barTauSq: bHat };
}

// Full per-gauge forecast. input: {nowSec, resetSec, uNow, snapshots, prior,
// calibration, thresholds}. Returns {ok, forecast, posterior, etas} or {ok:false}.
export function runForecast(input, cfg) {
  cfg = withDefaults(cfg);
  if (input.prior.nSessions < 2) return { ok: false };
  if (input.resetSec <= input.nowSec) return { ok: false };
  const recent = filterRecent(input.snapshots, input.nowSec, cfg.tauRecentSec);
  const post = estimatePosterior(recent, input.prior);
  const deltaT = (input.resetSec - input.nowSec) / HOUR_S;
  const rateVar = effectiveRateVar(post.tauPostSq, input.calibration.barTauSq);
  const fc = projectForecast(input.uNow, post.rHat, rateVar, input.calibration.sigmaSessionSq, deltaT);
  const ciThr = input.thresholds.length ? input.thresholds[0] : 100;
  const mc = runMC(input.nowSec, input.resetSec, input.uNow, post, input.calibration, ciThr, cfg, false);
  let ciSamples = null;
  if (mc.ok && mc.terminal.length) {
    const ci = terminalCI(mc.terminal);
    fc.lower = ci.lo; fc.upper = ci.hi;
    ciSamples = mc;
  }
  const etas = {};
  for (const thr of input.thresholds) {
    if (thr <= input.uNow) {
      etas[thr] = { median: input.nowSec, lower: input.nowSec, upper: input.nowSec, pInf: 0 };
      continue;
    }
    if (ciSamples && thr === ciThr) {
      etas[thr] = summarizeETA(input.nowSec, ciSamples);
      continue;
    }
    const m2 = runMC(input.nowSec, input.resetSec, input.uNow, post, input.calibration, thr, cfg, false);
    if (m2.ok) etas[thr] = summarizeETA(input.nowSec, m2);
  }
  return { ok: true, forecast: fc, posterior: post, etas, modelVersion: MODEL_VERSION };
}