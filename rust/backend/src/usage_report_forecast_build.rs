//! Pure assembly of the persisted `forecast.json` document.
//!
//! Mirrors `_window_balance*`, `_fit_gauge*`, the open-window projection,
//! `_build_ollama_forecast`, `_build_codex_forecast` and `_build_forecast`
//! (stats.mjs:1247-1689) on already-loaded history records and already-parsed
//! sessions. No filesystem, clock, environment or process access: the caller
//! supplies the records, `now_sec`, `fit_at` and the session view.
//!
//! Known deviation: `now_local_offset` is carried for caller parity with
//! `now_local()` but is not consumed here, because `fit_at` and the session
//! `day` values are already formatted by the caller.

use std::cmp::Ordering;

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::usage_report_forecast::{
    Calibration, CalibrationSession, CompletedWindow, ForecastConfig, ForecastInput, JsRng, Prior,
    calibrate_sigma_session_default, fit_prior, run_forecast,
};
use crate::usage_report_history::{ForecastDocument, GaugeWindow, UsageRecord, gauge_windows};

/// stats.mjs:39.
const OLLAMA_SERIES_CAP: usize = 400;
/// stats.mjs:1247-1249.
const WB_MIN_COVERAGE: f64 = 0.5;
const WB_MIN_D7: f64 = 20.0;
const WB_GAP_SEC: f64 = 5.0 * 3600.0;
/// stats.mjs:54.
const FIVE_HOUR_HOURS: f64 = 5.0;
const WEEKLY_HOURS: f64 = 7.0 * 24.0;
const HOUR_SEC: f64 = 3600.0;
const WEEK_SEC: f64 = 7.0 * 86400.0;
/// `FC.MODEL_VERSION` in the bundled forecast source.
const MODEL_VERSION: &str = "v2.1-js";

/// stats.mjs:938-941 — `_fnum` is `parseFloat`: a numeric prefix parses, the rest is ignored.
fn fnum(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(number)) => number
            .as_f64()
            .unwrap_or_else(|| crate::usage_report_cost::fnum(Some(&number.to_string()))),
        Some(Value::String(text)) => crate::usage_report_cost::fnum(Some(text)),
        Some(Value::Array(items)) => fnum(items.first()),
        Some(_) => 0.0,
    }
}

/// JS `Number(v)`.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) if text.trim().is_empty() => 0.0,
        Value::String(text) => text.trim().parse().unwrap_or(f64::NAN),
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

/// stats.mjs:1250 `_r2`: `Math.round(x * 100) / 100`. JS rounds an exact half toward
/// +Infinity, so `-0.125` → `-0.12`; `+ 0.0` normalises `-0.0`, as `JSON.stringify` does.
fn r2(value: f64) -> f64 {
    let scaled = value * 100.0;
    let floor = scaled.floor();
    let rounded = if scaled - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    };
    rounded / 100.0 + 0.0
}

fn gauge_duration_hours(gauge: &str) -> f64 {
    match gauge {
        "five_hour" | "session" => FIVE_HOUR_HOURS,
        "seven_day" | "weekly" => WEEKLY_HOURS,
        _ => FIVE_HOUR_HOURS,
    }
}

/// stats.mjs:1331 `new Date(sec * 1000).toISOString()` without milliseconds.
fn iso_utc(sec: f64) -> String {
    OffsetDateTime::from_unix_timestamp(sec as i64)
        .ok()
        .and_then(|value| value.format(&Rfc3339).ok())
        .unwrap_or_default()
}

/// One row of the window-balance tables (stats.mjs:1310-1315,1347-1353).
#[derive(Clone)]
struct BalanceWindow {
    resets_at: Value,
    reset_sec: f64,
    d5: f64,
    d7: f64,
    r: Option<f64>,
    coverage: Option<f64>,
    n5: Option<usize>,
    n_snaps: usize,
    included: bool,
}

impl BalanceWindow {
    fn to_value(&self) -> Value {
        json!({
            "resetsAt": self.resets_at,
            "resetSec": self.reset_sec,
            "d5": self.d5,
            "d7": self.d7,
            "r": self.r,
            "coverage": self.coverage,
            "n5": self.n5,
            "nSnaps": self.n_snaps,
            "included": self.included,
        })
    }
}

/// stats.mjs:1294-1320.
fn window_balance_oauth(
    records: &[UsageRecord],
    now_sec: f64,
    short_gauge: &str,
    long_gauge: &str,
) -> Vec<BalanceWindow> {
    let short = gauge_windows(records, short_gauge);
    let duration = WEEKLY_HOURS * HOUR_SEC;
    let mut windows = Vec::new();
    for window in gauge_windows(records, long_gauge) {
        if window.snaps.len() < 2 {
            continue;
        }
        let t0 = window.snaps[0].t;
        let t1 = window.snaps[window.snaps.len() - 1].t;
        let d7 = window.snaps[window.snaps.len() - 1].u - window.snaps[0].u;
        let mut d5 = 0.0;
        let mut n5 = 0usize;
        for five in &short {
            let opened = five.snaps[0].t;
            if opened >= t0 && opened <= t1 {
                d5 += five.u_final;
                n5 += 1;
            }
        }
        let mut seen = 0.0;
        for index in 1..window.snaps.len() {
            seen += (window.snaps[index].t - window.snaps[index - 1].t).min(WB_GAP_SEC);
        }
        let reset_sec = window.reset_sec as f64;
        let end = if now_sec.is_nan() {
            f64::NAN
        } else {
            reset_sec.min(now_sec)
        };
        let nominal = end - (reset_sec - duration);
        let coverage = if nominal > 0.0 {
            (seen / nominal).min(1.0)
        } else {
            0.0
        };
        windows.push(BalanceWindow {
            resets_at: Value::String(window.resets_at_canon),
            reset_sec,
            d5: r2(d5),
            d7: r2(d7),
            r: if d7 > 0.0 { Some(r2(d5 / d7)) } else { None },
            coverage: Some(r2(coverage)),
            n5: Some(n5),
            n_snaps: window.snaps.len(),
            included: coverage >= WB_MIN_COVERAGE && d7 >= WB_MIN_D7,
        });
    }
    windows
}

/// One stats.csv session, as the window-balance fallback and token yield need
/// it (stats.mjs:1331-1356,1457-1520).
#[derive(Clone, Debug)]
pub struct ForecastSession {
    pub ts_epoch: Option<f64>,
    pub model: String,
    pub rl5: f64,
    pub rl7: f64,
    /// `ts.slice(0, 10)` already taken by the caller.
    pub day: String,
    pub tok: f64,
}

/// stats.mjs:1331-1356.
fn window_balance_statusline(sessions: &[ForecastSession], anchor_sec: f64) -> Vec<BalanceWindow> {
    let mut ordered: Vec<&ForecastSession> = sessions
        .iter()
        .filter(|session| {
            session
                .model
                .get(..6)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("claude"))
                && session.rl5 > 0.0
                && session.rl7 > 0.0
        })
        .filter(|session| {
            session
                .ts_epoch
                .is_some_and(|secs| secs != 0.0 && !secs.is_nan())
        })
        .collect();
    if ordered.len() < 2 {
        return Vec::new();
    }
    ordered.sort_by(|left, right| {
        left.ts_epoch
            .unwrap()
            .partial_cmp(&right.ts_epoch.unwrap())
            .unwrap_or(Ordering::Equal)
    });

    // `(k, d5, d7, n)` in bin order; stats.mjs folds into a Map then sorts by key.
    let mut bins: Vec<(i64, f64, f64, usize)> = Vec::new();
    let mut prev5: Option<f64> = None;
    let mut prev7: Option<f64> = None;
    for session in ordered {
        let d5 = match prev5 {
            Some(prev) if session.rl5 >= prev => session.rl5 - prev,
            _ => session.rl5,
        };
        let d7 = match prev7 {
            Some(prev) if session.rl7 >= prev => session.rl7 - prev,
            _ => session.rl7,
        };
        prev5 = Some(session.rl5);
        prev7 = Some(session.rl7);
        let key = ((session.ts_epoch.unwrap() - anchor_sec) / WEEK_SEC).ceil() as i64;
        match bins.iter_mut().find(|(seen, ..)| *seen == key) {
            Some((_, bin5, bin7, count)) => {
                *bin5 += d5;
                *bin7 += d7;
                *count += 1;
            }
            None => bins.push((key, d5, d7, 1)),
        }
    }
    bins.sort_by_key(|(key, ..)| *key);
    bins.into_iter()
        .map(|(key, d5, d7, count)| {
            let reset_sec = anchor_sec + key as f64 * WEEK_SEC;
            BalanceWindow {
                resets_at: Value::String(iso_utc(reset_sec)),
                reset_sec,
                d5: r2(d5),
                d7: r2(d7),
                r: if d7 > 0.0 { Some(r2(d5 / d7)) } else { None },
                coverage: None,
                n5: None,
                n_snaps: count,
                included: false,
            }
        })
        .collect()
}

/// stats.mjs:1266-1292.
fn wb_pool(windows: &[BalanceWindow], source: &str) -> Option<Value> {
    let gated: Vec<&BalanceWindow> = windows.iter().filter(|window| window.included).collect();
    let mut rest: Vec<&BalanceWindow> = windows.iter().filter(|window| window.d7 > 0.0).collect();
    rest.sort_by(|left, right| {
        right
            .coverage
            .unwrap_or(0.0)
            .partial_cmp(&left.coverage.unwrap_or(0.0))
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.d7.partial_cmp(&left.d7).unwrap_or(Ordering::Equal))
    });
    let is_gated = !gated.is_empty();
    let pool: Vec<&BalanceWindow> = if is_gated {
        gated
    } else {
        rest.into_iter().take(1).collect()
    };
    let sum5: f64 = pool.iter().map(|window| window.d5).sum();
    let sum7: f64 = pool.iter().map(|window| window.d7).sum();
    if sum7 <= 0.0 {
        return None;
    }
    let ratio = sum5 / sum7;
    Some(json!({
        "source": source,
        "r": r2(ratio),
        "d5": r2(sum5),
        "d7": r2(sum7),
        "nWindows": pool.len(),
        "gated": is_gated,
        "hoursPer7dDay": r2(ratio * 5.0 / 7.0),
        "daysPer5hWindow": if ratio > 0.0 { json!(r2(7.0 / ratio)) } else { Value::Null },
    }))
}

fn balance_table(windows: &[BalanceWindow]) -> Value {
    Value::Array(windows.iter().map(BalanceWindow::to_value).collect())
}

/// stats.mjs:1358-1372.
fn window_balance(
    records: &[UsageRecord],
    sessions: Option<&[ForecastSession]>,
    now_sec: f64,
) -> Value {
    let oauth = window_balance_oauth(records, now_sec, "five_hour", "seven_day");
    let anchor = oauth
        .last()
        .map(|window| window.reset_sec)
        .unwrap_or(now_sec);
    let statusline = sessions
        .map(|sessions| window_balance_statusline(sessions, anchor))
        .unwrap_or_default();
    let pooled = wb_pool(&oauth, "oauth").or_else(|| wb_pool(&statusline, "statusline"));
    let Some(pooled) = pooled else {
        return Value::Null;
    };
    json!({
        "pooled": pooled,
        "windows": balance_table(&oauth),
        "statuslineWindows": balance_table(&statusline),
        "minCoverage": WB_MIN_COVERAGE,
        "minD7": WB_MIN_D7,
    })
}

struct GaugeFit {
    prior: Prior,
    calibration: Calibration,
    n_windows: usize,
}

/// stats.mjs:1374-1388.
fn fit_gauge(
    gauge: &str,
    windows: &[GaugeWindow],
    now_sec: f64,
    config: ForecastConfig,
) -> Option<GaugeFit> {
    let duration_hours = gauge_duration_hours(gauge);
    let completed: Vec<&GaugeWindow> = windows
        .iter()
        .filter(|window| window.reset_sec as f64 <= now_sec && window.snaps.len() >= 2)
        .collect();
    let sessions: Vec<CalibrationSession> = completed
        .iter()
        .map(|window| CalibrationSession {
            reset_sec: window.reset_sec as f64,
            duration_hours,
            u_final: window.u_final,
            snapshots: window.snaps.clone(),
        })
        .collect();
    // `fit_prior` reads only duration/uFinal (forecast.mjs:99-112); `snapshots` stay in
    // `sessions`, which only the sigma calibration uses.
    let completed_windows: Vec<CompletedWindow> = completed
        .iter()
        .map(|window| CompletedWindow {
            reset_sec: window.reset_sec as f64,
            duration_hours,
            u_final: window.u_final,
        })
        .collect();
    let first = fit_prior(&completed_windows, 0.0, config.variance_eps)?;
    let calibration = calibrate_sigma_session_default(&sessions, first, config);
    let second = fit_prior(
        &completed_windows,
        calibration.sigma_session_sq,
        config.variance_eps,
    );
    Some(GaugeFit {
        prior: second.unwrap_or(first),
        calibration,
        n_windows: completed.len(),
    })
}

/// stats.mjs:1392-1404.
fn fit_gauge_statusline(sessions: &[ForecastSession], gauge: &str) -> Option<GaugeFit> {
    let read = |session: &ForecastSession| {
        if gauge == "five_hour" {
            session.rl5
        } else {
            session.rl7
        }
    };
    // stats.mjs:1392-1402 maps sessions with no `resetSec`; the prior reads duration/uFinal.
    let completed: Vec<CompletedWindow> = sessions
        .iter()
        .filter(|session| read(session) > 0.0)
        .map(|session| CompletedWindow {
            reset_sec: 0.0,
            duration_hours: gauge_duration_hours(gauge),
            u_final: read(session),
        })
        .collect();
    let prior = fit_prior(&completed, 0.0, ForecastConfig::default().variance_eps)?;
    Some(GaugeFit {
        prior,
        calibration: Calibration {
            sigma_session_sq: ForecastConfig::default().variance_eps,
            bar_tau_sq: 0.0,
        },
        n_windows: completed.len(),
    })
}

/// The `result` block of a fitted gauge: project the open window with the most
/// snapshots (stats.mjs:1381-1387,1531-1543,1596-1608).
fn open_window_result(
    windows: &[GaugeWindow],
    now_sec: f64,
    fit: &GaugeFit,
    config: ForecastConfig,
) -> Option<Value> {
    let mut open: Option<&GaugeWindow> = None;
    for window in windows
        .iter()
        .filter(|window| window.reset_sec as f64 > now_sec)
    {
        match open {
            Some(best) if best.snaps.len() >= window.snaps.len() => {}
            _ => open = Some(window),
        }
    }
    let open = open?;
    let last = open.snaps.last()?;
    let result = run_forecast(
        &ForecastInput {
            now_sec: last.t,
            reset_sec: open.reset_sec as f64,
            u_now: last.u,
            snapshots: open.snaps.clone(),
            prior: fit.prior,
            calibration: fit.calibration,
            thresholds: vec![100.0, 80.0],
        },
        config,
        &mut JsRng::new(0),
    );
    if result.get("ok") != Some(&Value::Bool(true)) {
        return None;
    }
    let posterior = result.get("posterior")?;
    let mut projected = Map::new();
    projected.insert(
        "rHat".to_owned(),
        posterior.get("rHat").cloned().unwrap_or(Value::Null),
    );
    projected.insert(
        "usedOLS".to_owned(),
        posterior.get("usedOLS").cloned().unwrap_or(Value::Null),
    );
    projected.insert(
        "n".to_owned(),
        posterior.get("n").cloned().unwrap_or(Value::Null),
    );
    Some(json!({
        "forecast": result.get("forecast").cloned().unwrap_or(Value::Null),
        "posterior": Value::Object(projected),
        "etas": result.get("etas").cloned().unwrap_or(Value::Null),
        "openResetSec": open.reset_sec,
        "uNow": last.u,
        "nSnaps": open.snaps.len(),
    }))
}

fn gauge_value(source: &str, fit: &GaugeFit, result: Option<Value>) -> Value {
    json!({
        "ok": true,
        "source": source,
        "nWindows": fit.n_windows,
        "prior": {
            "mu0": fit.prior.mu0,
            "tau0Sq": fit.prior.tau0_sq,
            "nSessions": fit.prior.n_sessions,
        },
        "calibration": {
            "sigmaSessionSq": fit.calibration.sigma_session_sq,
            "barTauSq": fit.calibration.bar_tau_sq,
        },
        "result": result,
    })
}

/// stats.mjs:1635-1681, Claude gauges only.
fn build_claude_gauges(
    records: &[UsageRecord],
    sessions: Option<&[ForecastSession]>,
    now_sec: f64,
    config: ForecastConfig,
) -> Map<String, Value> {
    let mut gauges = Map::new();
    for gauge in ["five_hour", "seven_day"] {
        let windows = gauge_windows(records, gauge);
        if let Some(fit) = fit_gauge(gauge, &windows, now_sec, config) {
            let result = open_window_result(&windows, now_sec, &fit, config);
            gauges.insert(gauge.to_owned(), gauge_value("oauth", &fit, result));
            continue;
        }
        if let Some(fit) = sessions.and_then(|sessions| fit_gauge_statusline(sessions, gauge)) {
            gauges.insert(gauge.to_owned(), gauge_value("statusline", &fit, None));
            continue;
        }
        gauges.insert(gauge.to_owned(), json!({"ok": false}));
    }
    gauges
}

/// stats.mjs:1437-1455.
fn ollama_window_balance(records: &[UsageRecord], now_sec: f64) -> Value {
    let windows = window_balance_oauth(records, now_sec, "session", "weekly");
    match wb_pool(&windows, "ollama") {
        Some(pooled) => json!({
            "pooled": pooled,
            "windows": balance_table(&windows),
            "statuslineWindows": Value::Array(Vec::new()),
            "minCoverage": WB_MIN_COVERAGE,
            "minD7": WB_MIN_D7,
        }),
        None => Value::Null,
    }
}

fn add_share(shares: &mut Vec<(String, Vec<(String, f64)>)>, name: &str, day: &str, share: f64) {
    match shares.iter_mut().find(|(model, _)| model == name) {
        Some((_, days)) => match days.iter_mut().find(|(seen, _)| seen == day) {
            Some((_, total)) => *total += share,
            None => days.push((day.to_owned(), share)),
        },
        None => shares.push((name.to_owned(), vec![(day.to_owned(), share)])),
    }
}

fn previous_requests(previous: &[(String, f64)], name: &str) -> f64 {
    previous
        .iter()
        .find(|(model, _)| model == name)
        .map(|(_, value)| *value)
        .unwrap_or(0.0)
}

/// stats.mjs:1457-1520.
fn ollama_token_yield(records: &[UsageRecord], sessions: Option<&[ForecastSession]>) -> Value {
    struct Sample {
        t: i64,
        day: String,
        u: f64,
        /// Named entries in scrape order, duplicates kept: Node sums a delta
        /// per entry into `totalReq` (stats.mjs:1483-1491).
        entries: Vec<(String, f64)>,
        /// Requests over every entry, named or not (stats.mjs:1475).
        total: f64,
        /// Model id -> requests, first-insertion order, last write winning,
        /// like `prevReq` (stats.mjs:1500-1501).
        models: Vec<(String, f64)>,
    }

    let mut samples: Vec<Sample> = Vec::new();
    for record in records {
        let Some(weekly) = record.raw.get("weekly") else {
            continue;
        };
        if weekly.is_null() {
            continue;
        }
        let Some(utilization) = weekly.get("utilization") else {
            continue;
        };
        if utilization.is_null() {
            continue;
        }
        let Some(models) = record.raw.get("models").and_then(Value::as_array) else {
            continue;
        };
        let Some(t) = record.fetched_epoch else {
            continue;
        };
        let day: String = record
            .raw
            .get("fetched_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(10)
            .collect();
        if day.is_empty() {
            continue;
        }
        let mut entries: Vec<(String, f64)> = Vec::new();
        let mut collapsed: Vec<(String, f64)> = Vec::new();
        let mut total = 0.0;
        for model in models {
            let requests = fnum(model.get("requests"));
            total += requests;
            let Some(name) = model
                .get("model")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            entries.push((name.to_owned(), requests));
            match collapsed.iter_mut().find(|(seen, _)| seen == name) {
                Some((_, value)) => *value = requests,
                None => collapsed.push((name.to_owned(), requests)),
            }
        }
        samples.push(Sample {
            t,
            day,
            u: js_number(utilization),
            entries,
            total,
            models: collapsed,
        });
    }
    samples.sort_by_key(|sample| sample.t);

    // Day -> stripped model id -> token total, from the loaded stats.csv sessions.
    let mut tokens: Vec<(String, Vec<(String, f64)>)> = Vec::new();
    for session in sessions.unwrap_or(&[]) {
        let day = session.day.as_str();
        let model = session
            .model
            .strip_suffix(":cloud")
            .unwrap_or(session.model.as_str());
        if day.is_empty() || model.is_empty() {
            continue;
        }
        match tokens.iter_mut().find(|(seen, _)| seen == day) {
            Some((_, models)) => match models.iter_mut().find(|(seen, _)| seen == model) {
                Some((_, total)) => *total += session.tok,
                None => models.push((model.to_owned(), session.tok)),
            },
            None => tokens.push((day.to_owned(), vec![(model.to_owned(), session.tok)])),
        }
    }

    let mut shares: Vec<(String, Vec<(String, f64)>)> = Vec::new();
    let mut prev_u: Option<f64> = None;
    let mut prev_req: Vec<(String, f64)> = Vec::new();
    for sample in &samples {
        let current_total = sample.total;
        let previous_total: f64 = prev_req.iter().map(|(_, value)| value).sum();
        let reset =
            prev_u.is_none() || sample.u < prev_u.unwrap() || current_total < previous_total;
        let delta_pct = if reset {
            sample.u
        } else {
            sample.u - prev_u.unwrap()
        };
        prev_u = Some(sample.u);
        if delta_pct > 0.0 {
            let mut deltas: Vec<(String, f64)> = Vec::new();
            let mut total = 0.0;
            for (name, current) in &sample.entries {
                let previous = if reset {
                    0.0
                } else {
                    previous_requests(&prev_req, name)
                };
                let delta = (current - previous).max(0.0);
                match deltas.iter_mut().find(|(seen, _)| seen == name) {
                    Some((_, value)) => *value = delta,
                    None => deltas.push((name.clone(), delta)),
                }
                total += delta;
            }
            if total > 0.0 {
                for (name, delta) in &deltas {
                    if *delta <= 0.0 {
                        continue;
                    }
                    add_share(&mut shares, name, &sample.day, delta_pct * (delta / total));
                }
            }
        }
        prev_req = sample.models.clone();
    }

    let mut series = Map::new();
    let mut agg = Map::new();
    let mut models: Vec<String> = Vec::new();
    let mut days: Vec<String> = Vec::new();
    for (name, by_day) in &shares {
        let mut agg_tokens = 0.0;
        let mut agg_delta = 0.0;
        let mut day_series = Map::new();
        for (day, delta) in by_day {
            if *delta < 0.05 {
                continue;
            }
            let tokens_for_day = tokens
                .iter()
                .find(|(seen, _)| seen == day)
                .and_then(|(_, models)| {
                    models
                        .iter()
                        .find(|(seen, _)| seen == name)
                        .map(|(_, value)| *value)
                })
                .unwrap_or(0.0);
            day_series.insert(
                day.clone(),
                json!({
                    "e": (tokens_for_day / 1e6) / delta,
                    "t": tokens_for_day,
                    "d": delta,
                }),
            );
            if !days.iter().any(|seen| seen == day) {
                days.push(day.clone());
            }
            agg_tokens += tokens_for_day;
            agg_delta += delta;
        }
        series.insert(name.clone(), Value::Object(day_series));
        if agg_delta < 0.05 {
            continue;
        }
        agg.insert(
            name.clone(),
            json!({
                "e": (agg_tokens / 1e6) / agg_delta,
                "t": agg_tokens,
                "d": agg_delta,
            }),
        );
        models.push(name.clone());
    }
    days.sort();
    models.sort();
    json!({
        "days": days,
        "series": Value::Object(series),
        "agg": Value::Object(agg),
        "models": models,
    })
}

/// stats.mjs:1429-1435.
fn stride_indices(len: usize, cap: usize) -> Vec<usize> {
    if len <= cap {
        return (0..len).collect();
    }
    let step = len.div_ceil(cap);
    let mut out: Vec<usize> = (0..len).step_by(step).collect();
    if (len - 1) % step != 0 {
        out.push(len - 1);
    }
    out
}

/// Read one gauge's utilization, treating a missing/null value as absent.
fn series_utilization(record: &UsageRecord, gauge: &str) -> Option<f64> {
    let utilization = record.raw.get(gauge)?.get("utilization")?;
    if utilization.is_null() {
        return None;
    }
    Some(js_number(utilization))
}

/// stats.mjs:1564-1571,1624-1631.
fn series_from_snaps(records: &[UsageRecord]) -> Value {
    let mut out = Vec::new();
    for index in stride_indices(records.len(), OLLAMA_SERIES_CAP) {
        let record = &records[index];
        let session = series_utilization(record, "session");
        let weekly = series_utilization(record, "weekly");
        if session.is_none() && weekly.is_none() {
            continue;
        }
        let mut point = Map::new();
        if let Some(ts) = record.raw.get("fetched_at") {
            point.insert("ts".to_owned(), ts.clone());
        }
        point.insert("session".to_owned(), json!(session));
        point.insert("weekly".to_owned(), json!(weekly));
        out.push(Value::Object(point));
    }
    Value::Array(out)
}

/// stats.mjs:1522-1573.
fn build_ollama_forecast(
    records: &[UsageRecord],
    sessions: Option<&[ForecastSession]>,
    now_sec: f64,
    fit_at: &str,
    config: ForecastConfig,
) -> Option<Value> {
    if records.is_empty() {
        return None;
    }
    let mut gauges = Map::new();
    for gauge in ["session", "weekly"] {
        let windows = gauge_windows(records, gauge);
        let value = match fit_gauge(gauge, &windows, now_sec, config) {
            Some(fit) => gauge_value(
                "ollama",
                &fit,
                open_window_result(&windows, now_sec, &fit, config),
            ),
            None => json!({"ok": false}),
        };
        gauges.insert(gauge.to_owned(), value);
    }
    Some(json!({
        "modelVersion": MODEL_VERSION,
        "fitAt": fit_at,
        "gauges": Value::Object(gauges),
        "windowBalance": ollama_window_balance(records, now_sec),
        "tokenYield": ollama_token_yield(records, sessions),
        "series": series_from_snaps(records),
    }))
}

/// stats.mjs:1580-1585.
fn codex_window_balance(records: &[UsageRecord], now_sec: f64) -> Value {
    let windows = window_balance_oauth(records, now_sec, "session", "weekly");
    match wb_pool(&windows, "codex") {
        Some(pooled) => json!({
            "pooled": pooled,
            "windows": balance_table(&windows),
            "statuslineWindows": Value::Array(Vec::new()),
            "minCoverage": WB_MIN_COVERAGE,
            "minD7": WB_MIN_D7,
        }),
        None => Value::Null,
    }
}

/// stats.mjs:1587-1632. Gauge order is weekly then session.
fn build_codex_forecast(
    records: &[UsageRecord],
    now_sec: f64,
    fit_at: &str,
    config: ForecastConfig,
) -> Option<Value> {
    if records.is_empty() {
        return None;
    }
    let mut gauges = Map::new();
    for gauge in ["weekly", "session"] {
        let windows = gauge_windows(records, gauge);
        let value = match fit_gauge(gauge, &windows, now_sec, config) {
            Some(fit) => gauge_value(
                "codex",
                &fit,
                open_window_result(&windows, now_sec, &fit, config),
            ),
            None => json!({"ok": false}),
        };
        gauges.insert(gauge.to_owned(), value);
    }
    Some(json!({
        "modelVersion": MODEL_VERSION,
        "fitAt": fit_at,
        "gauges": Value::Object(gauges),
        "windowBalance": codex_window_balance(records, now_sec),
        "series": series_from_snaps(records),
    }))
}

/// Everything `_build_forecast` reads besides the filesystem and the clock.
pub struct ForecastBuildInputs<'a> {
    pub claude_snaps: &'a [UsageRecord],
    pub ollama_snaps: &'a [UsageRecord],
    pub codex_snaps: &'a [UsageRecord],
    /// `None` skips the statusline prior fallback, as passing `null` does.
    pub sessions: Option<&'a [ForecastSession]>,
    pub now_sec: f64,
    pub fit_at: String,
    /// Carried for caller parity with `now_local()`; unused here, since
    /// `fit_at` and the session `day` values are already formatted.
    pub now_local_offset: i32,
}

/// stats.mjs:1635-1689, minus the write.
pub fn build_forecast_document(inputs: &ForecastBuildInputs<'_>) -> ForecastDocument {
    let config = ForecastConfig::default();
    ForecastDocument {
        fit_at: inputs.fit_at.clone(),
        model_version: MODEL_VERSION.to_owned(),
        gauges: build_claude_gauges(inputs.claude_snaps, inputs.sessions, inputs.now_sec, config),
        window_balance: window_balance(inputs.claude_snaps, inputs.sessions, inputs.now_sec),
        ollama: build_ollama_forecast(
            inputs.ollama_snaps,
            inputs.sessions,
            inputs.now_sec,
            &inputs.fit_at,
            config,
        ),
        codex: build_codex_forecast(inputs.codex_snaps, inputs.now_sec, &inputs.fit_at, config),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW_S: f64 = 1_000_000.0;

    fn record(fetched: i64, raw: Value) -> UsageRecord {
        UsageRecord {
            fetched_epoch: Some(fetched),
            raw,
        }
    }

    fn reset_at(epoch: i64) -> String {
        OffsetDateTime::from_unix_timestamp(epoch)
            .unwrap()
            .format(&Rfc3339)
            .unwrap()
    }

    fn gauge_record(fetched: i64, gauge: &str, reset: i64, utilization: f64) -> UsageRecord {
        let mut raw = Map::new();
        raw.insert(
            gauge.to_owned(),
            json!({"utilization": utilization, "resets_at": reset_at(reset)}),
        );
        record(fetched, Value::Object(raw))
    }

    fn session(model: &str, rl5: f64, rl7: f64, ts: f64) -> ForecastSession {
        ForecastSession {
            ts_epoch: Some(ts),
            model: model.to_owned(),
            rl5,
            rl7,
            day: String::new(),
            tok: 0.0,
        }
    }

    #[test]
    fn fnum_parses_a_numeric_prefix_like_parse_float() {
        assert_eq!(fnum(Some(&json!("12abc"))), 12.0);
        assert_eq!(fnum(Some(&json!(" -3.5e2 rest"))), -350.0);
        assert_eq!(fnum(Some(&json!(".5"))), 0.5);
        assert_eq!(fnum(Some(&json!("1e"))), 1.0);
        assert_eq!(fnum(Some(&json!("abc"))), 0.0);
        assert_eq!(fnum(Some(&json!(""))), 0.0);
        assert_eq!(fnum(None), 0.0);
        assert_eq!(fnum(Some(&Value::Null)), 0.0);
        assert_eq!(fnum(Some(&json!(7))), 7.0);
        assert_eq!(fnum(Some(&json!("Infinity"))), f64::INFINITY);
        assert_eq!(fnum(Some(&json!("inf"))), 0.0);
        assert_eq!(fnum(Some(&json!("\u{feff}1.5"))), 1.5);
        assert_eq!(fnum(Some(&json!([["12tail"], 2]))), 12.0);
    }

    #[test]
    fn r2_rounds_exact_halves_toward_positive_infinity() {
        assert_eq!(r2(0.125), 0.13);
        assert_eq!(r2(-0.125), -0.12);
        assert_eq!(r2(0.0), 0.0);
        assert_eq!(r2(-0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(json!(r2(-0.0)).to_string(), "0.0");
    }

    #[test]
    fn ollama_token_yield_counts_each_duplicate_model_entry_in_the_total() {
        let records = vec![
            record(
                1_000,
                json!({
                    "fetched_at": "2024-01-01 00:00:00",
                    "weekly": {"utilization": 10},
                    "models": [
                        {"model": "a", "requests": 4},
                        {"model": "b", "requests": 4},
                    ],
                }),
            ),
            record(
                2_000,
                json!({
                    "fetched_at": "2024-01-02 00:00:00",
                    "weekly": {"utilization": 20},
                    "models": [
                        {"model": "a", "requests": 5},
                        {"model": "a", "requests": 5},
                        {"model": "b", "requests": 6},
                    ],
                }),
            ),
        ];
        let yield_ = ollama_token_yield(&records, None);
        // Node keys the delta by id but adds every entry to the total
        // (stats.mjs:1483-1491): a=1 counted twice, b=2, so the total is 4.
        assert_eq!(
            yield_["series"]["a"]["2024-01-02"]["d"].as_f64(),
            Some(10.0 * (1.0 / 4.0))
        );
        assert_eq!(
            yield_["series"]["b"]["2024-01-02"]["d"].as_f64(),
            Some(10.0 * (2.0 / 4.0))
        );
    }

    #[test]
    fn oauth_window_balance_pairs_five_hour_windows_and_gates_coverage() {
        let weekly_reset = 900_000;
        let mut records = vec![gauge_record(400_000, "five_hour", 418_000, 30.0)];
        for index in 0..19 {
            records.push(gauge_record(
                295_200 + index * 18_000,
                "seven_day",
                weekly_reset,
                (index * 5) as f64,
            ));
        }

        let windows = window_balance_oauth(&records, NOW_S, "five_hour", "seven_day");
        assert_eq!(windows.len(), 1);
        let window = &windows[0];
        assert_eq!(window.d5, 30.0);
        assert_eq!(window.d7, 90.0);
        assert_eq!(window.r, Some(0.33));
        assert_eq!(window.coverage, Some(0.54));
        assert_eq!(window.n5, Some(1));
        assert_eq!(window.n_snaps, 19);
        assert!(window.included);

        let pooled = wb_pool(&windows, "oauth").unwrap();
        assert_eq!(pooled["gated"], json!(true));
        assert_eq!(pooled["nWindows"], json!(1));
        assert_eq!(pooled["r"].as_f64(), Some(0.33));
        assert_eq!(pooled["daysPer5hWindow"].as_f64(), Some(21.0));
        assert_eq!(pooled["hoursPer7dDay"].as_f64(), Some(0.24));
    }

    #[test]
    fn window_balance_pool_falls_back_to_best_observed_window() {
        let records = vec![
            gauge_record(100, "seven_day", 604_900, 10.0),
            gauge_record(200, "seven_day", 604_900, 40.0),
        ];
        let windows = window_balance_oauth(&records, NOW_S, "five_hour", "seven_day");
        assert_eq!(windows.len(), 1);
        assert!(!windows[0].included);
        // No 5h windows at all → ratio 0 → no division.
        let pooled = wb_pool(&windows, "oauth").unwrap();
        assert_eq!(pooled["gated"], json!(false));
        assert_eq!(pooled["r"].as_f64(), Some(0.0));
        assert_eq!(pooled["daysPer5hWindow"], Value::Null);
    }

    #[test]
    fn statusline_windows_are_reset_aware_and_week_binned() {
        let sessions = vec![
            session("claude-opus-4", 10.0, 5.0, NOW_S),
            session("Claude-sonnet-4", 25.0, 40.0, 1_600_000.0),
            // Dropped: non-Claude model, zero gauge, unparseable ts.
            session("gpt-5", 10.0, 10.0, 1_600_000.0),
            session("claude-haiku", 0.0, 10.0, 1_600_000.0),
            ForecastSession {
                ts_epoch: None,
                ..session("claude-haiku", 10.0, 10.0, 1_600_000.0)
            },
        ];
        let windows = window_balance_statusline(&sessions, NOW_S);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].reset_sec, 1_000_000.0);
        assert_eq!(windows[0].d5, 10.0);
        assert_eq!(windows[0].d7, 5.0);
        assert_eq!(windows[0].r, Some(2.0));
        assert_eq!(windows[0].coverage, None);
        assert_eq!(windows[0].n5, None);
        assert!(!windows[0].included);
        assert_eq!(windows[1].reset_sec, 1_604_800.0);
        assert_eq!(windows[1].d5, 15.0);
        assert_eq!(windows[1].d7, 35.0);
        assert_eq!(windows[1].r, Some(0.43));
        assert_eq!(windows[1].n_snaps, 1);
        assert_eq!(
            windows[1].resets_at,
            Value::String("1970-01-19T13:46:40Z".to_owned())
        );
    }

    #[test]
    fn claude_gauges_prefer_oauth_then_statusline_then_report_unfitted() {
        let config = ForecastConfig::default();
        let empty = build_claude_gauges(&[], None, NOW_S, config);
        assert_eq!(empty["five_hour"], json!({"ok": false}));
        assert_eq!(empty["seven_day"], json!({"ok": false}));

        let sessions = vec![
            session("claude-opus-4", 10.0, 5.0, NOW_S),
            session("claude-opus-4", 20.0, 15.0, NOW_S + 60.0),
        ];
        let fallback = build_claude_gauges(&[], Some(&sessions), NOW_S, config);
        assert_eq!(fallback["five_hour"]["source"], json!("statusline"));
        assert_eq!(fallback["five_hour"]["result"], Value::Null);
        assert_eq!(fallback["five_hour"]["prior"]["mu0"].as_f64(), Some(3.0));
        assert_eq!(fallback["seven_day"]["prior"]["nSessions"], json!(2));
    }

    #[test]
    fn open_window_projection_uses_latest_snapshot_and_reset() {
        let records = vec![
            gauge_record(400_000, "five_hour", 500_000, 20.0),
            gauge_record(430_000, "five_hour", 500_000, 30.0),
            gauge_record(500_000, "five_hour", 600_000, 40.0),
            gauge_record(530_000, "five_hour", 600_000, 50.0),
            gauge_record(997_000, "five_hour", 1_100_000, 70.0),
            gauge_record(999_000, "five_hour", 1_100_000, 80.0),
            gauge_record(900_000, "five_hour", 1_100_000, 60.0),
        ];
        let windows = gauge_windows(&records, "five_hour");
        let fit = fit_gauge("five_hour", &windows, NOW_S, ForecastConfig::default()).unwrap();
        assert_eq!(fit.n_windows, 2);
        let result = open_window_result(&windows, NOW_S, &fit, ForecastConfig::default()).unwrap();
        assert_eq!(result["openResetSec"], json!(1_100_000));
        assert_eq!(result["nSnaps"], json!(3));
        assert_eq!(result["uNow"].as_f64(), Some(80.0));
        assert!(result["forecast"]["f"].is_number());
        assert!(result["posterior"]["usedOLS"].is_boolean());
    }

    #[test]
    fn ollama_token_yield_splits_by_request_share_and_pairs_session_tokens() {
        let records = vec![
            record(
                1_000,
                json!({
                    "fetched_at": "2024-01-01 00:00:00",
                    "weekly": {"utilization": 10},
                    "models": [{"model": "llama3", "requests": 2}],
                }),
            ),
            record(
                2_000,
                json!({
                    "fetched_at": "2024-01-02 00:00:00",
                    "weekly": {"utilization": 20},
                    "models": [{"model": "llama3", "requests": 5}],
                }),
            ),
        ];
        let sessions = vec![ForecastSession {
            ts_epoch: None,
            model: "llama3:cloud".to_owned(),
            rl5: 0.0,
            rl7: 0.0,
            day: "2024-01-01".to_owned(),
            tok: 1_000_000.0,
        }];

        let yield_ = ollama_token_yield(&records, Some(&sessions));
        assert_eq!(yield_["models"], json!(["llama3"]));
        assert_eq!(yield_["days"], json!(["2024-01-01", "2024-01-02"]));
        assert_eq!(
            yield_["series"]["llama3"]["2024-01-01"]["e"].as_f64(),
            Some(0.1)
        );
        assert_eq!(
            yield_["series"]["llama3"]["2024-01-01"]["t"].as_f64(),
            Some(1_000_000.0)
        );
        assert_eq!(
            yield_["series"]["llama3"]["2024-01-02"]["d"].as_f64(),
            Some(10.0)
        );
        assert_eq!(yield_["agg"]["llama3"]["e"].as_f64(), Some(0.05));
        assert_eq!(yield_["agg"]["llama3"]["d"].as_f64(), Some(20.0));
    }

    #[test]
    fn series_is_strided_to_cap_keeping_the_newest_point() {
        assert_eq!(stride_indices(3, 400), vec![0, 1, 2]);
        let even = stride_indices(401, 400);
        assert_eq!(even.len(), 201);
        assert_eq!(even.last(), Some(&400));
        let odd = stride_indices(402, 400);
        assert_eq!(odd.len(), 202);
        assert_eq!(odd.last(), Some(&401));

        let records: Vec<UsageRecord> = (0..402)
            .map(|index| {
                record(
                    index,
                    json!({
                        "fetched_at": format!("2024-01-01 00:00:{:02}", index % 60),
                        "session": {"utilization": index % 100},
                    }),
                )
            })
            .collect();
        let series = series_from_snaps(&records);
        assert_eq!(series.as_array().unwrap().len(), 202);
        assert_eq!(series[1]["session"].as_f64(), Some(2.0));
        assert_eq!(series[1]["weekly"], Value::Null);
    }

    #[test]
    fn codex_gauges_are_ordered_weekly_then_session() {
        let records = vec![gauge_record(1_000, "session", 2_000_000, 10.0)];
        let codex = build_codex_forecast(
            &records,
            NOW_S,
            "2024-01-01 00:00:00",
            ForecastConfig::default(),
        )
        .unwrap();
        let gauges = codex["gauges"].as_object().unwrap();
        let keys: Vec<&String> = gauges.keys().collect();
        assert_eq!(keys, vec!["weekly", "session"]);
        assert_eq!(codex["gauges"]["weekly"], json!({"ok": false}));
        assert_eq!(codex["modelVersion"], json!("v2.1-js"));
        assert_eq!(codex["fitAt"], json!("2024-01-01 00:00:00"));
        assert_eq!(
            build_codex_forecast(&[], NOW_S, "fit", ForecastConfig::default()),
            None
        );
    }

    #[test]
    fn document_omits_absent_providers_and_keeps_the_contract_fields() {
        let inputs = ForecastBuildInputs {
            claude_snaps: &[],
            ollama_snaps: &[],
            codex_snaps: &[],
            sessions: None,
            now_sec: NOW_S,
            fit_at: "2024-01-01 00:00:00".to_owned(),
            now_local_offset: 3600,
        };
        let document = build_forecast_document(&inputs);
        assert_eq!(document.model_version, "v2.1-js");
        assert_eq!(document.fit_at, "2024-01-01 00:00:00");
        assert_eq!(document.gauges.len(), 2);
        assert_eq!(document.gauges["seven_day"], json!({"ok": false}));
        assert_eq!(document.window_balance, Value::Null);
        assert!(document.ollama.is_none());
        assert!(document.codex.is_none());
    }
}
