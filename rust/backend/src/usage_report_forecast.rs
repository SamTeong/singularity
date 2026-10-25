//! Pure numerical core for the bundled usage-report forecast model v2.1-js.
//!
//! Inputs are already-prepared epoch-second snapshots and completed windows.
//! This module does not read histories, call a clock, persist a document, or
//! inspect provider state. The forecast source's observed posterior fallback
//! (including its `seSq`/`seOlsSq` name mismatch) is intentionally preserved.

use serde::Serialize;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;

const HOUR_SEC: f64 = 3600.0;
const Z90: f64 = 1.281_551_565_544_600_4;
const MODEL_VERSION: &str = "v2.1-js";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ForecastConfig {
    pub tau_recent_sec: f64,
    pub mc_traj: usize,
    pub mc_step_sec: f64,
    pub variance_eps: f64,
}

impl Default for ForecastConfig {
    fn default() -> Self {
        Self {
            tau_recent_sec: 1800.0,
            mc_traj: 400,
            mc_step_sec: 300.0,
            variance_eps: 1e-6,
        }
    }
}

impl ForecastConfig {
    /// Match JS `value || default`: zero and NaN select the default.
    pub fn with_js_falsy_defaults(self) -> Self {
        let defaults = Self::default();
        Self {
            tau_recent_sec: js_falsy(self.tau_recent_sec, defaults.tau_recent_sec),
            mc_traj: if self.mc_traj == 0 {
                defaults.mc_traj
            } else {
                self.mc_traj
            },
            mc_step_sec: js_falsy(self.mc_step_sec, defaults.mc_step_sec),
            variance_eps: js_falsy(self.variance_eps, defaults.variance_eps),
        }
    }
}

fn js_falsy(value: f64, default: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        default
    } else {
        value
    }
}

fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else if left > right {
        left
    } else {
        right
    }
}

fn js_sort_cmp(left: &f64, right: &f64) -> Ordering {
    left.partial_cmp(right).unwrap_or(Ordering::Equal)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Snapshot {
    pub t: f64,
    pub u: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CompletedWindow {
    pub reset_sec: f64,
    pub duration_hours: f64,
    pub u_final: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CalibrationSession {
    pub reset_sec: f64,
    pub duration_hours: f64,
    pub u_final: f64,
    pub snapshots: Vec<Snapshot>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Prior {
    pub mu0: f64,
    pub tau0_sq: f64,
    pub n_sessions: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Calibration {
    pub sigma_session_sq: f64,
    pub bar_tau_sq: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ForecastInput {
    pub now_sec: f64,
    pub reset_sec: f64,
    pub u_now: f64,
    /// Chronological order is an input contract, as in forecast.mjs.
    pub snapshots: Vec<Snapshot>,
    pub prior: Prior,
    pub calibration: Calibration,
    pub thresholds: Vec<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Posterior {
    r_hat: f64,
    tau_post_sq: f64,
    n: usize,
    se_ols_sq: f64,
    used_ols: bool,
    exceptional_key: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct OlsFit {
    r_hat: f64,
    se_ols_sq: f64,
    ok: bool,
}

/// A caller-controlled uniform stream. `reset_for_seed` lets the compatibility
/// implementation reproduce forecast.mjs's per-threshold reseeding; fixtures
/// may leave it as a no-op and provide a fixed sequence instead.
pub trait UniformSource {
    fn next_f64(&mut self) -> f64;

    fn reset_for_seed(&mut self, _seed: u32) {}

    fn next_normal(&mut self) -> f64 {
        loop {
            let x = self.next_f64() * 2.0 - 1.0;
            let y = self.next_f64() * 2.0 - 1.0;
            let r = x * x + y * y;
            if r > 0.0 && r < 1.0 {
                return x * ((-2.0 * r.ln()) / r).sqrt();
            }
        }
    }
}

/// FNV-1a-64 / Mulberry32 / Box-Muller stream used by forecast.mjs.
#[derive(Clone, Debug)]
pub struct JsRng {
    state: u32,
    spare_normal: Option<f64>,
}

impl JsRng {
    pub fn new(seed: u32) -> Self {
        Self {
            state: seed,
            spare_normal: None,
        }
    }

    pub fn for_forecast(input: &ForecastInput, threshold: f64) -> Self {
        Self::new(forecast_seed(input, threshold))
    }

    fn normal(&mut self) -> f64 {
        if let Some(value) = self.spare_normal.take() {
            return value;
        }
        loop {
            let x = self.next_f64() * 2.0 - 1.0;
            let y = self.next_f64() * 2.0 - 1.0;
            let r = x * x + y * y;
            if r > 0.0 && r < 1.0 {
                let multiplier = ((-2.0 * r.ln()) / r).sqrt();
                self.spare_normal = Some(y * multiplier);
                return x * multiplier;
            }
        }
    }
}

impl UniformSource for JsRng {
    fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t = (t ^ (t ^ (t >> 7)).wrapping_mul(t | 61)) ^ (t >> 14);
        (t.wrapping_add(0x8000_0000) as f64) / 4_294_967_296.0
    }

    fn reset_for_seed(&mut self, seed: u32) {
        self.state = seed;
        self.spare_normal = None;
    }

    fn next_normal(&mut self) -> f64 {
        self.normal()
    }
}

fn forecast_seed(input: &ForecastInput, threshold: f64) -> u32 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for value in [
        input.now_sec,
        input.reset_sec,
        input.u_now,
        // This is the observed OLS typo's actual value: OLS is not fused and
        // the posterior rate is the prior mean.
        input.prior.mu0,
        input.prior.tau0_sq,
        input.calibration.sigma_session_sq,
        input.calibration.bar_tau_sq,
        threshold,
    ] {
        for byte in value.to_le_bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3);
        }
    }
    hash as u32
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().fold(0.0, |sum, value| sum + value) / values.len() as f64
}

fn sample_var(values: &[f64], avg: f64) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    values.iter().fold(0.0, |sum, value| {
        let delta = value - avg;
        sum + delta * delta
    }) / (values.len() - 1) as f64
}

/// Completed-window Gaussian prior; only positive-duration windows count.
pub fn fit_prior(
    sessions: &[CompletedWindow],
    sigma_session_sq: f64,
    variance_eps: f64,
) -> Option<Prior> {
    let mut rates = Vec::new();
    let mut inverse_durations = Vec::new();
    for session in sessions {
        if session.duration_hours <= 0.0 {
            continue;
        }
        rates.push(session.u_final / session.duration_hours);
        inverse_durations.push(1.0 / session.duration_hours);
    }
    if rates.len() < 2 {
        return None;
    }
    let mu0 = mean(&rates);
    let raw_var = sample_var(&rates, mu0);
    let mut tau0_sq = raw_var - sigma_session_sq * mean(&inverse_durations);
    if tau0_sq < variance_eps {
        tau0_sq = variance_eps;
    }
    Some(Prior {
        mu0,
        tau0_sq,
        n_sessions: rates.len(),
    })
}

fn ols_fit(snaps: &[Snapshot]) -> OlsFit {
    let n = snaps.len();
    if n < 3 {
        return OlsFit {
            r_hat: 0.0,
            se_ols_sq: 0.0,
            ok: false,
        };
    }
    let t0 = snaps[0].t;
    let times: Vec<f64> = snaps.iter().map(|s| (s.t - t0) / HOUR_SEC).collect();
    let utilizations: Vec<f64> = snaps.iter().map(|s| s.u).collect();
    let t_bar = mean(&times);
    let u_bar = mean(&utilizations);
    let mut s_tt = 0.0;
    let mut s_tu = 0.0;
    for (t, u) in times.iter().zip(&utilizations) {
        let dt = t - t_bar;
        s_tt += dt * dt;
        s_tu += dt * (u - u_bar);
    }
    if s_tt <= 0.0 {
        return OlsFit {
            r_hat: 0.0,
            se_ols_sq: 0.0,
            ok: false,
        };
    }
    let r_hat = s_tu / s_tt;
    let alpha = u_bar - r_hat * t_bar;
    let mut rss = 0.0;
    for (t, u) in times.iter().zip(&utilizations) {
        let residual = u - alpha - r_hat * t;
        rss += residual * residual;
    }
    OlsFit {
        r_hat,
        se_ols_sq: (rss / (n - 2) as f64) / s_tt,
        ok: true,
    }
}

fn estimate_posterior(recent: &[Snapshot], prior: Prior) -> Posterior {
    let ols = ols_fit(recent);
    // forecast.mjs destructures `seSq`, but olsFit returns `seOlsSq`. This
    // makes every valid OLS path non-finite and triggers the misspelled key.
    let se_sq = f64::NAN;
    if !ols.ok || se_sq <= 0.0 || prior.tau0_sq <= 0.0 {
        return Posterior {
            r_hat: prior.mu0,
            tau_post_sq: prior.tau0_sq,
            n: recent.len(),
            se_ols_sq: 0.0,
            used_ols: false,
            exceptional_key: false,
        };
    }
    let prior_precision = 1.0 / prior.tau0_sq;
    let data_precision = 1.0 / se_sq;
    let tau_post_sq = 1.0 / (prior_precision + data_precision);
    let r_hat = tau_post_sq * (prior.mu0 * prior_precision + ols.r_hat * data_precision);
    if !r_hat.is_finite() {
        return Posterior {
            r_hat: prior.mu0,
            tau_post_sq: prior.tau0_sq,
            n: recent.len(),
            se_ols_sq: 0.0,
            used_ols: false,
            exceptional_key: true,
        };
    }
    Posterior {
        r_hat,
        tau_post_sq,
        n: recent.len(),
        se_ols_sq: ols.se_ols_sq,
        used_ols: true,
        exceptional_key: false,
    }
}

fn posterior_json(p: Posterior) -> Value {
    let mut value = Map::new();
    value.insert("rHat".into(), json!(p.r_hat));
    value.insert("tauPostSq".into(), json!(p.tau_post_sq));
    value.insert("n".into(), json!(p.n));
    value.insert(
        if p.exceptional_key {
            "seOolsSq"
        } else {
            "seOlsSq"
        }
        .into(),
        json!(p.se_ols_sq),
    );
    value.insert("usedOLS".into(), json!(p.used_ols));
    Value::Object(value)
}

pub fn effective_rate_var(tau_post_sq: f64, bar_tau_sq: f64) -> f64 {
    if bar_tau_sq > tau_post_sq {
        bar_tau_sq
    } else {
        tau_post_sq
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Projection {
    #[serde(rename = "f")]
    pub forecast: f64,
    #[serde(rename = "sigmaF")]
    pub sigma_f: f64,
    pub lower: f64,
    pub upper: f64,
    #[serde(rename = "deltaT")]
    pub delta_t: f64,
}

pub fn project_forecast(
    u_now: f64,
    r_hat: f64,
    tau_post_sq: f64,
    sigma_session_sq: f64,
    delta_t: f64,
) -> Projection {
    let forecast = u_now + r_hat * delta_t;
    let sigma_f = (delta_t * delta_t * tau_post_sq + delta_t * sigma_session_sq).sqrt();
    let floor = if u_now < 0.0 { 0.0 } else { u_now };
    Projection {
        forecast,
        sigma_f,
        lower: js_max(floor, forecast - Z90 * sigma_f),
        upper: js_max(floor, forecast + Z90 * sigma_f),
        delta_t,
    }
}

/// Inclusive `[now-tau, now]` filter; detects the last reset drop before
/// removing future points, matching the bundled source's ordering.
pub fn filter_recent(all: &[Snapshot], now_sec: f64, tau_sec: f64) -> Vec<Snapshot> {
    let cutoff = now_sec - tau_sec;
    let mut start = 0;
    for (i, snapshot) in all.iter().enumerate() {
        if snapshot.t >= cutoff {
            start = i;
            break;
        }
        start = i + 1;
    }
    let mut window = all[start..].to_vec();
    let mut drop_at = None;
    for i in 1..window.len() {
        if window[i].u < window[i - 1].u {
            drop_at = Some(i);
        }
    }
    if let Some(index) = drop_at {
        window = window[index..].to_vec();
    }
    window.into_iter().filter(|s| s.t <= now_sec).collect()
}

fn interp_at(snaps: &[Snapshot], tf: f64) -> (f64, bool) {
    if snaps.is_empty() {
        return (0.0, false);
    }
    if tf <= snaps[0].t {
        return (snaps[0].u, true);
    }
    let last = snaps[snaps.len() - 1];
    if tf >= last.t {
        return (last.u, true);
    }
    for i in 1..snaps.len() {
        if snaps[i].t >= tf {
            let a = snaps[i - 1];
            let b = snaps[i];
            let total = b.t - a.t;
            if total == 0.0 {
                return (a.u, true);
            }
            return (a.u + ((tf - a.t) / total) * (b.u - a.u), true);
        }
    }
    (last.u, true)
}

pub fn calibrate_sigma_session(
    sessions: &[CalibrationSession],
    prior: Prior,
    config: ForecastConfig,
    forecasts_per_session: usize,
    min_horizon_sec: f64,
) -> Calibration {
    let cfg = config.with_js_falsy_defaults();
    let mut samples = Vec::<(f64, f64)>::new();
    for session in sessions {
        if session.snapshots.len() < 3 || session.duration_hours <= 0.0 {
            continue;
        }
        let earliest = session.snapshots[0].t + cfg.tau_recent_sec;
        let latest = session.reset_sec - min_horizon_sec;
        if latest <= earliest {
            continue;
        }
        for k in 0..forecasts_per_session {
            let frac = (k as f64 + 0.5) / forecasts_per_session as f64;
            let tf = earliest + frac * (latest - earliest);
            let recent = filter_recent(&session.snapshots, tf, cfg.tau_recent_sec);
            if recent.len() < 3 {
                continue;
            }
            let (u_at_tf, ok) = interp_at(&session.snapshots, tf);
            if !ok {
                continue;
            }
            let post = estimate_posterior(&recent, prior);
            let delta = (session.reset_sec - tf) / HOUR_SEC;
            if delta <= 0.0 {
                continue;
            }
            let forecast = u_at_tf + post.r_hat * delta;
            let error = session.u_final - forecast;
            samples.push((delta, error * error));
        }
    }
    if samples.len() < 2 {
        return Calibration {
            sigma_session_sq: cfg.variance_eps,
            bar_tau_sq: 0.0,
        };
    }
    let mut n = 0.0;
    let mut sx = 0.0;
    let mut sxx = 0.0;
    let mut sz_over_x = 0.0;
    let mut sz = 0.0;
    for (delta, error_sq) in samples {
        if delta <= 0.0 {
            continue;
        }
        n += 1.0;
        sx += delta;
        sxx += delta * delta;
        sz_over_x += error_sq / delta;
        sz += error_sq;
    }
    let det = n * sxx - sx * sx;
    if det == 0.0 {
        return Calibration {
            sigma_session_sq: cfg.variance_eps,
            bar_tau_sq: 0.0,
        };
    }
    let mut a_hat = (sz_over_x * sxx - sz * sx) / det;
    let mut b_hat = (n * sz - sx * sz_over_x) / det;
    if !a_hat.is_finite() || a_hat < cfg.variance_eps {
        a_hat = cfg.variance_eps;
    }
    if !b_hat.is_finite() || b_hat < 0.0 {
        b_hat = 0.0;
    }
    Calibration {
        sigma_session_sq: a_hat,
        bar_tau_sq: b_hat,
    }
}

pub fn calibrate_sigma_session_default(
    sessions: &[CalibrationSession],
    prior: Prior,
    config: ForecastConfig,
) -> Calibration {
    calibrate_sigma_session(sessions, prior, config, 6, 1800.0)
}

fn sample_gamma(rng: &mut impl UniformSource, shape: f64, scale: f64) -> f64 {
    if shape <= 0.0 {
        return 0.0;
    }
    if shape < 1.0 {
        let mut uniform = rng.next_f64();
        while uniform <= 0.0 {
            uniform = rng.next_f64();
        }
        return sample_gamma(rng, shape + 1.0, scale) * uniform.powf(1.0 / shape);
    }
    let d = shape - 1.0 / 3.0;
    let c = 1.0 / (9.0 * d).sqrt();
    loop {
        let x = rng.next_normal();
        let v = 1.0 + c * x;
        if v <= 0.0 {
            continue;
        }
        let vv = v * v * v;
        let uniform = rng.next_f64();
        let x2 = x * x;
        if uniform < 1.0 - 0.0331 * x2 * x2 {
            return d * vv * scale;
        }
        if uniform.ln() < 0.5 * x2 + d * (1.0 - vv + vv.ln()) {
            return d * vv * scale;
        }
    }
}

fn sample_gamma_mean_var(rng: &mut impl UniformSource, mean: f64, variance: f64) -> f64 {
    if mean <= 0.0 {
        return 0.0;
    }
    if variance <= 0.0 {
        return mean;
    }
    sample_gamma(rng, mean * mean / variance, variance / mean)
}

#[derive(Debug)]
struct McResult {
    crossings_hours: Vec<f64>,
    terminal: Vec<f64>,
    p_inf: f64,
    n_traj: usize,
}

fn run_mc(
    rng: &mut impl UniformSource,
    input: &ForecastInput,
    post: Posterior,
    threshold: f64,
    cfg: ForecastConfig,
) -> Option<McResult> {
    let horizon_sec = input.reset_sec - input.now_sec;
    if horizon_sec <= 0.0 {
        return None;
    }
    let mut step = cfg.mc_step_sec;
    if step <= 0.0 {
        step = 300.0;
    }
    if step > horizon_sec {
        step = horizon_sec;
    }
    let min_step_for_cap = (horizon_sec / 300.0).ceil();
    if step < min_step_for_cap {
        step = min_step_for_cap;
    }
    let mut n_steps = (horizon_sec / step).ceil() as usize;
    if n_steps < 1 {
        n_steps = 1;
    }
    let dt = (horizon_sec / n_steps as f64) / HOUR_SEC;
    let increment_variance = input.calibration.sigma_session_sq * dt;
    let effective = effective_rate_var(post.tau_post_sq, input.calibration.bar_tau_sq);
    let rate_variance = if effective.is_nan() {
        f64::NAN
    } else if effective < 0.0 {
        0.0
    } else {
        effective
    };
    rng.reset_for_seed(forecast_seed(input, threshold));
    let k = cfg.mc_traj;
    let mut crossings_hours = Vec::with_capacity(k);
    let mut terminal = Vec::with_capacity(k);
    let mut infinite_count = 0usize;
    for _ in 0..k {
        let rate = sample_gamma_mean_var(rng, post.r_hat, rate_variance);
        let mut utilization = input.u_now;
        let mut hit_hours = f64::INFINITY;
        for j in 1..=n_steps {
            let previous = utilization;
            utilization += sample_gamma_mean_var(rng, rate * dt, increment_variance);
            if hit_hours == f64::INFINITY && utilization >= threshold {
                let fraction = if utilization != previous {
                    (threshold - previous) / (utilization - previous)
                } else {
                    0.0
                };
                hit_hours = (j as f64 - 1.0 + fraction) * dt;
            }
        }
        terminal.push(utilization);
        if hit_hours == f64::INFINITY {
            infinite_count += 1;
        } else {
            crossings_hours.push(hit_hours);
        }
    }
    Some(McResult {
        crossings_hours,
        terminal,
        p_inf: infinite_count as f64 / k as f64,
        n_traj: k,
    })
}

fn percentile_sorted(sorted: &[f64], p: f64, total_n: usize) -> f64 {
    if total_n == 0 {
        return f64::NAN;
    }
    if sorted.is_empty() {
        return f64::INFINITY;
    }
    let rank = p * (total_n - 1) as f64;
    if rank >= sorted.len() as f64 {
        return f64::INFINITY;
    }
    let low = rank.floor() as usize;
    let high = (rank.ceil() as usize).min(sorted.len() - 1);
    if low == high {
        return sorted[low];
    }
    let fraction = rank - low as f64;
    sorted[low] * (1.0 - fraction) + sorted[high] * fraction
}

fn terminal_ci(terminal: &[f64]) -> (f64, f64) {
    if terminal.is_empty() {
        return (f64::NAN, f64::NAN);
    }
    let mut sorted = terminal.to_vec();
    sorted.sort_by(js_sort_cmp);
    (
        percentile_sorted(&sorted, 0.1, sorted.len()),
        percentile_sorted(&sorted, 0.9, sorted.len()),
    )
}

fn eta_json(now_sec: f64, sample: &McResult) -> Value {
    if sample.p_inf >= 0.5 {
        return json!({"pInf": sample.p_inf});
    }
    let mut finite = sample.crossings_hours.clone();
    finite.sort_by(js_sort_cmp);
    let inf_count = sample.n_traj - finite.len();
    let median = now_sec + percentile_sorted(&finite, 0.5, finite.len() + inf_count) * HOUR_SEC;
    let (lower, upper) = if sample.p_inf < 0.1 {
        (
            json!(now_sec + percentile_sorted(&finite, 0.1, finite.len()) * HOUR_SEC),
            json!(now_sec + percentile_sorted(&finite, 0.9, finite.len()) * HOUR_SEC),
        )
    } else {
        (
            json!(now_sec + percentile_sorted(&finite, 0.1, finite.len()) * HOUR_SEC),
            Value::Null,
        )
    };
    json!({"median": median, "lower": lower, "upper": upper, "pInf": sample.p_inf})
}

fn threshold_key(threshold: f64) -> String {
    if threshold == 0.0 {
        return "0".into();
    }
    if threshold.is_nan() {
        return "NaN".into();
    }
    if threshold == f64::INFINITY {
        return "Infinity".into();
    }
    if threshold == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    format!("{threshold}")
}

/// Produce one pure per-gauge forecast document value. A supplied `JsRng`
/// reseeds at each MC pass to preserve the bundled source's threshold seeding.
pub fn run_forecast(
    input: &ForecastInput,
    config: ForecastConfig,
    rng: &mut impl UniformSource,
) -> Value {
    let cfg = config.with_js_falsy_defaults();
    if input.prior.n_sessions < 2 || input.reset_sec <= input.now_sec {
        return json!({"ok": false});
    }
    let recent = filter_recent(&input.snapshots, input.now_sec, cfg.tau_recent_sec);
    let post = estimate_posterior(&recent, input.prior);
    let delta_t = (input.reset_sec - input.now_sec) / HOUR_SEC;
    let rate_variance = effective_rate_var(post.tau_post_sq, input.calibration.bar_tau_sq);
    let projection = project_forecast(
        input.u_now,
        post.r_hat,
        rate_variance,
        input.calibration.sigma_session_sq,
        delta_t,
    );
    let ci_threshold = input.thresholds.first().copied().unwrap_or(100.0);
    let ci_sample = run_mc(rng, input, post, ci_threshold, cfg);
    let mut projection_value = serde_json::to_value(projection).unwrap_or(Value::Null);
    if let Some(mc) = &ci_sample {
        if !mc.terminal.is_empty() {
            let (lower, upper) = terminal_ci(&mc.terminal);
            if let Some(object) = projection_value.as_object_mut() {
                object.insert("lower".into(), json!(lower));
                object.insert("upper".into(), json!(upper));
            }
        }
    }
    let mut etas = Map::new();
    for threshold in &input.thresholds {
        let eta = if *threshold <= input.u_now {
            json!({"median": input.now_sec, "lower": input.now_sec, "upper": input.now_sec, "pInf": 0})
        } else if *threshold == ci_threshold {
            if let Some(mc) = &ci_sample {
                eta_json(input.now_sec, mc)
            } else {
                continue;
            }
        } else {
            match run_mc(rng, input, post, *threshold, cfg) {
                Some(mc) => eta_json(input.now_sec, &mc),
                None => continue,
            }
        };
        etas.insert(threshold_key(*threshold), eta);
    }
    let mut result = Map::new();
    result.insert("ok".into(), json!(true));
    result.insert("forecast".into(), projection_value);
    result.insert("posterior".into(), posterior_json(post));
    result.insert("etas".into(), Value::Object(etas));
    result.insert("modelVersion".into(), json!(MODEL_VERSION));
    Value::Object(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prior_uses_completed_positive_duration_windows_and_noise_correction() {
        let prior = fit_prior(
            &[
                CompletedWindow {
                    reset_sec: 0.0,
                    duration_hours: 1.0,
                    u_final: 1.0,
                },
                CompletedWindow {
                    reset_sec: 0.0,
                    duration_hours: 2.0,
                    u_final: 6.0,
                },
                CompletedWindow {
                    reset_sec: 0.0,
                    duration_hours: 0.0,
                    u_final: 900.0,
                },
            ],
            0.25,
            1e-6,
        )
        .unwrap();
        assert_eq!(prior.mu0, 2.0);
        assert_eq!(prior.tau0_sq, 1.8125);
        assert_eq!(prior.n_sessions, 2);
    }

    #[test]
    fn recent_cutoff_is_inclusive_drop_detection_precedes_future_filter() {
        let recent = filter_recent(
            &[
                Snapshot { t: 49.0, u: 20.0 },
                Snapshot { t: 50.0, u: 25.0 },
                Snapshot { t: 70.0, u: 35.0 },
                Snapshot { t: 80.0, u: 5.0 },
                Snapshot { t: 110.0, u: 7.0 },
            ],
            100.0,
            50.0,
        );
        assert_eq!(recent, vec![Snapshot { t: 80.0, u: 5.0 }]);
    }

    #[test]
    fn valid_ols_preserves_source_fallback_and_exceptional_key_spelling() {
        let recent = [
            Snapshot { t: 0.0, u: 1.0 },
            Snapshot { t: 1800.0, u: 2.0 },
            Snapshot { t: 3600.0, u: 3.0 },
        ];
        let posterior = estimate_posterior(
            &recent,
            Prior {
                mu0: 4.0,
                tau0_sq: 2.0,
                n_sessions: 2,
            },
        );
        assert!(posterior.exceptional_key);
        assert_eq!(posterior.r_hat, 4.0);
        assert_eq!(posterior.tau_post_sq, 2.0);
        let value = posterior_json(posterior);
        assert_eq!(value["usedOLS"], false);
        assert_eq!(value["seOolsSq"], 0.0);
        assert!(value.get("seOlsSq").is_none());
    }

    #[test]
    fn js_config_falsy_defaults_and_eta_reporting_boundaries_are_kept() {
        let config = ForecastConfig {
            tau_recent_sec: 0.0,
            mc_traj: 0,
            mc_step_sec: 0.0,
            variance_eps: f64::NAN,
        }
        .with_js_falsy_defaults();
        assert_eq!(config, ForecastConfig::default());
        assert_eq!(
            eta_json(
                100.0,
                &McResult {
                    crossings_hours: vec![1.0],
                    terminal: vec![],
                    p_inf: 0.5,
                    n_traj: 2
                }
            ),
            json!({"pInf":0.5})
        );
        let open = eta_json(
            100.0,
            &McResult {
                crossings_hours: vec![1.0, 2.0],
                terminal: vec![],
                p_inf: 0.1,
                n_traj: 3,
            },
        );
        assert_eq!(open["upper"], Value::Null);
        assert!(open["median"].is_number());
    }

    #[test]
    fn forecast_reseeds_per_threshold_and_enforces_reset_eligibility() {
        let input = ForecastInput {
            now_sec: 10_000.0,
            reset_sec: 10_000.0 + 7200.0,
            u_now: 20.0,
            snapshots: vec![
                Snapshot { t: 8000.0, u: 10.0 },
                Snapshot { t: 9000.0, u: 15.0 },
                Snapshot { t: 9900.0, u: 20.0 },
            ],
            prior: Prior {
                mu0: 2.0,
                tau0_sq: 0.5,
                n_sessions: 2,
            },
            calibration: Calibration {
                sigma_session_sq: 0.1,
                bar_tau_sq: 0.0,
            },
            thresholds: vec![20.0, 80.0],
        };
        let config = ForecastConfig {
            mc_traj: 12,
            ..ForecastConfig::default()
        };
        let mut first_rng = JsRng::new(0);
        let first = run_forecast(&input, config, &mut first_rng);
        let mut second_rng = JsRng::new(123);
        let second = run_forecast(&input, config, &mut second_rng);
        assert_eq!(first, second);
        assert_eq!(first["etas"]["20"]["median"], json!(input.now_sec));
        assert_eq!(first["modelVersion"], json!("v2.1-js"));

        let mut ineligible = input.clone();
        ineligible.reset_sec = ineligible.now_sec;
        let mut rng = JsRng::new(1);
        assert_eq!(
            run_forecast(&ineligible, config, &mut rng),
            json!({"ok":false})
        );
    }
}
