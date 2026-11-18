//! Usage-report history loading and forecast document persistence.
//!
//! Mirrors `_load_usage_snapshots` (stats.mjs:1201), `_gauge_windows` (:1223),
//! `_forecast_stale` (:1409), the write half of `_build_forecast`
//! (:1635-1689) and `_load_forecast` (:1693) from the bundled harness
//! usage-report script. Paths, the clock and the local zone are parameters;
//! nothing here reads environment variables, the real clock or real user state.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use serde_json::{Map, Value};

use crate::usage_report_forecast::Snapshot;
use crate::usage_snapshot::LocalZone;

/// stats.mjs:1409 default `max_age_days = 7`.
const FORECAST_MAX_AGE_S: f64 = 7.0 * 86400.0;

/// One parsed JSONL history record.
pub struct UsageRecord {
    /// `fetched_at` in epoch seconds; `None` mirrors JS `?? Infinity` sorting.
    pub fetched_epoch: Option<i64>,
    /// The record as parsed, so consumers read `raw[gauge]` like stats.mjs does.
    pub raw: Value,
}

/// JS `Number(v)`, which the Node code applies to `utilization` and accepts
/// anything (`"abc"` becomes `NaN`). Strings use the crate's full JavaScript
/// numeric grammar, so Rust-only spellings (`"inf"`, `"NaN"`) stay `NaN`.
// VERIFY: wave3-fix-forecast-4
// shortcut: arrays become NaN here (JS coerces them: `Number([])` is 0); add if real data carries them.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => crate::memory_backup::js_string_to_number(text),
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

/// `parseDateTime` (stats.mjs:1009-1014): strictly `YYYY-MM-DD HH:MM:SS`, then
/// JS `new Date(year, month - 1, day, hour, minute, second)`, which offsets
/// two-digit years by 1900 and rolls out-of-range fields over. The zone
/// resolves the offset per record, as Node does.
// VERIFY: wave3-fix-forecast-2
fn parse_fetched_at(text: &str, zone: LocalZone) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b' '
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let digits = |start: usize, end: usize| -> Option<i64> {
        let part = text.get(start..end)?;
        if !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let year = digits(0, 4)?;
    let day = digits(8, 10)?;
    let hour = digits(11, 13)?;
    let minute = digits(14, 16)?;
    let second = digits(17, 19)?;
    // `new Date(y, ...)` maps 0..=99 to 1900..=1999 before normalizing months.
    let year = if year <= 99 { year + 1900 } else { year };
    let month_index = digits(5, 7)? - 1;
    let year = year + month_index.div_euclid(12);
    let month = month_index.rem_euclid(12) + 1;
    let days = days_from_civil(year, month, 1) + day - 1;
    let local_secs = days * 86_400 + hour * 3_600 + minute * 60 + second;
    zone.to_epoch_secs(local_secs)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's
/// `days_from_civil`), reproducing JS `MakeDay` for rolled-over dates.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_prime = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// stats.mjs:1176-1184 `_parse_reset_at`: RFC3339, or a numeric epoch. A JSON
/// number or a string matching `/^\d+(\.\d+)?$/` is an epoch in seconds, or in
/// milliseconds when the magnitude is at least 1e12 inclusive, floored.
fn parse_reset_at(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_f64().map(epoch_secs),
        Value::String(text) if text.is_empty() => None,
        Value::String(text) if is_unsigned_decimal(text) => {
            text.parse::<f64>().ok().map(epoch_secs)
        }
        Value::String(text) => OffsetDateTime::parse(text, &Rfc3339)
            .ok()
            .map(|reset| reset.unix_timestamp()),
        _ => None,
    }
}

/// stats.mjs:1180 — `Math.floor(n >= 1e12 ? n / 1000 : n)`.
fn epoch_secs(epoch: f64) -> i64 {
    (if epoch >= 1e12 { epoch / 1000.0 } else { epoch }).floor() as i64
}

/// stats.mjs:1178 `/^\d+(\.\d+)?$/`: ASCII digits with an optional single
/// decimal part. No sign, whitespace or exponent.
fn is_unsigned_decimal(text: &str) -> bool {
    let (whole, fraction) = match text.split_once('.') {
        Some((_, fraction)) if fraction.contains('.') => return false,
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    let fraction_ok = match fraction {
        None => true,
        Some(part) => !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()),
    };
    !whole.is_empty() && whole.bytes().all(|byte| byte.is_ascii_digit()) && fraction_ok
}

/// stats.mjs:1183-1188: round to the nearest minute (JS `Math.round`, i.e.
/// half-up) so snapshots of one drifting window group together.
fn reset_key_secs(sec: i64) -> i64 {
    ((sec as f64 / 60.0) + 0.5).floor() as i64 * 60
}

fn reset_canon(sec: i64) -> String {
    OffsetDateTime::from_unix_timestamp(sec)
        .ok()
        .and_then(|reset| reset.format(&Rfc3339).ok())
        .unwrap_or_default()
}

fn is_file(path: &Path) -> bool {
    path.metadata().map(|meta| meta.is_file()).unwrap_or(false)
}

/// stats.mjs:1201-1218. The Claude live file also merges the monthly
/// `usage-snapshots-YYYY-MM.jsonl` archives, name-sorted, ahead of itself;
/// other providers pass `include_archives = false` and read a single file.
pub fn load_usage_snapshots(
    path: &Path,
    include_archives: bool,
    zone: LocalZone,
) -> io::Result<Vec<UsageRecord>> {
    let mut files: Vec<PathBuf> = Vec::new();
    if include_archives {
        let dir = path.parent().unwrap_or(Path::new("."));
        // stats.mjs:1205 — a missing state dir simply means no archives.
        let mut archives: Vec<PathBuf> = crate::fs_sorted::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name())
                    .filter(|name| is_archive(&name.to_string_lossy()))
                    .map(|name| dir.join(name))
                    .collect()
            })
            .unwrap_or_default();
        archives.sort();
        files.extend(archives);
    }
    files.push(path.to_path_buf());

    let mut out = Vec::new();
    for file in files {
        if !is_file(&file) {
            continue;
        }
        // stats.mjs:1210 — an unreadable selected file is not caught.
        for line in fs::read_to_string(&file)?.split('\n') {
            let text = line.trim();
            if text.is_empty() {
                continue;
            }
            // stats.mjs:1214 — a corrupt line is dropped, never fatal.
            let Ok(raw) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            let fetched_epoch = raw
                .get("fetched_at")
                .and_then(Value::as_str)
                .and_then(|text| parse_fetched_at(text, zone));
            out.push(UsageRecord { fetched_epoch, raw });
        }
    }
    out.sort_by_key(|record| record.fetched_epoch.unwrap_or(i64::MAX));
    Ok(out)
}

/// stats.mjs:1206 `/^usage-snapshots-\d{4}-\d{2}\.jsonl$/`.
fn is_archive(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix("usage-snapshots-")
        .and_then(|rest| rest.strip_suffix(".jsonl"))
    else {
        return false;
    };
    let bytes = stem.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || byte.is_ascii_digit())
}

/// One normalized-reset bucket of snapshots for a single gauge.
pub struct GaugeWindow {
    pub reset_sec: i64,
    pub resets_at_canon: String,
    /// Chronological, as `ForecastInput::snapshots` requires.
    pub snaps: Vec<Snapshot>,
    pub u_final: f64,
}

/// stats.mjs:1223-1245: group records into per-gauge windows keyed by the
/// normalized `resets_at`, dropping records the gauge cannot use.
pub fn gauge_windows(records: &[UsageRecord], gauge: &str) -> Vec<GaugeWindow> {
    let mut by_reset: Vec<(i64, GaugeWindow)> = Vec::new();
    for record in records {
        let Some(window) = record.raw.get(gauge).filter(|value| !value.is_null()) else {
            continue;
        };
        let Some(utilization) = window.get("utilization") else {
            continue;
        };
        if utilization.is_null() {
            continue;
        }
        let Some(resets_at) = window.get("resets_at").filter(|value| !value.is_null()) else {
            continue;
        };
        let Some(fetched_epoch) = record.fetched_epoch else {
            continue;
        };
        let Some(reset_sec) = parse_reset_at(resets_at) else {
            continue;
        };
        let snap = Snapshot {
            t: fetched_epoch as f64,
            u: js_number(utilization),
        };
        let key = reset_key_secs(reset_sec);
        match by_reset.iter_mut().find(|(seen, _)| *seen == key) {
            Some((_, found)) => found.snaps.push(snap),
            None => by_reset.push((
                key,
                GaugeWindow {
                    reset_sec,
                    resets_at_canon: reset_canon(key),
                    snaps: vec![snap],
                    u_final: 0.0,
                },
            )),
        }
    }

    let mut windows: Vec<GaugeWindow> = by_reset.into_iter().map(|(_, window)| window).collect();
    for window in &mut windows {
        window
            .snaps
            .sort_by(|left, right| left.t.total_cmp(&right.t));
        // stats.mjs:1240 — fold from 0 and propagate NaN like Math.max.
        window.u_final = window.snaps.iter().fold(0.0, |seen, snap| {
            if seen.is_nan() || snap.u.is_nan() {
                f64::NAN
            } else {
                seen.max(snap.u)
            }
        });
    }
    windows.sort_by_key(|window| window.reset_sec);
    windows
}

/// File names under the forecast state dir and the transcript projects dir,
/// both supplied by the caller (stats.mjs:14,32,38,43,49).
pub struct ForecastPaths {
    pub state_dir: PathBuf,
    pub projects_dir: PathBuf,
}

impl ForecastPaths {
    pub fn new(state_dir: impl Into<PathBuf>, projects_dir: impl Into<PathBuf>) -> Self {
        Self {
            state_dir: state_dir.into(),
            projects_dir: projects_dir.into(),
        }
    }

    pub fn forecast_json(&self) -> PathBuf {
        self.state_dir.join("forecast.json")
    }

    pub fn snapshots_jsonl(&self) -> PathBuf {
        self.state_dir.join("usage-snapshots.jsonl")
    }

    pub fn ollama_usage_jsonl(&self) -> PathBuf {
        self.state_dir.join("ollama-usage.jsonl")
    }

    pub fn codex_usage_jsonl(&self) -> PathBuf {
        self.state_dir.join("codex-usage.jsonl")
    }
}

/// stats.mjs:91-93 — `statSync(p).mtimeMs / 1000`, uncaught.
fn mtime_secs(path: &Path) -> io::Result<f64> {
    let modified = path.metadata()?.modified()?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map(|age| age.as_secs_f64())
        .unwrap_or(0.0))
}

/// stats.mjs:1415-1417 — newest `projects/*/*.jsonl` mtime, `0` when none.
fn newest_project_jsonl_mtime(projects_dir: &Path) -> io::Result<f64> {
    let mut newest = 0.0_f64;
    let Ok(projects) = crate::fs_sorted::read_dir(projects_dir) else {
        return Ok(0.0);
    };
    for project in projects.flatten() {
        let Ok(files) = crate::fs_sorted::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "jsonl")
            {
                newest = newest.max(mtime_secs(&path)?);
            }
        }
    }
    Ok(newest)
}

/// stats.mjs:1409-1418: missing, older than seven days (strictly), any history
/// input newer than it (strictly), or any transcript newer than it. Monthly
/// archives are deliberately excluded, as in the source.
pub fn forecast_stale(paths: &ForecastPaths, now_sec: f64) -> io::Result<bool> {
    let forecast = paths.forecast_json();
    if !is_file(&forecast) {
        return Ok(true);
    }
    let forecast_mtime = mtime_secs(&forecast)?;
    if now_sec - forecast_mtime > FORECAST_MAX_AGE_S {
        return Ok(true);
    }
    for input in [
        paths.snapshots_jsonl(),
        paths.ollama_usage_jsonl(),
        paths.codex_usage_jsonl(),
    ] {
        if is_file(&input) && mtime_secs(&input)? > forecast_mtime {
            return Ok(true);
        }
    }
    Ok(newest_project_jsonl_mtime(&paths.projects_dir)? > forecast_mtime)
}

/// The persisted `forecast.json` document, in the source key order
/// (stats.mjs:1639,1682-1686).
pub struct ForecastDocument {
    pub fit_at: String,
    pub model_version: String,
    pub gauges: Map<String, Value>,
    pub window_balance: Value,
    pub ollama: Option<Value>,
    pub codex: Option<Value>,
}

impl ForecastDocument {
    fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("fitAt".to_owned(), Value::String(self.fit_at.clone()));
        out.insert(
            "modelVersion".to_owned(),
            Value::String(self.model_version.clone()),
        );
        out.insert("gauges".to_owned(), Value::Object(self.gauges.clone()));
        out.insert("windowBalance".to_owned(), self.window_balance.clone());
        if let Some(ollama) = &self.ollama {
            out.insert("ollama".to_owned(), ollama.clone());
        }
        if let Some(codex) = &self.codex {
            out.insert("codex".to_owned(), codex.clone());
        }
        Value::Object(out)
    }
}

/// stats.mjs:1687 — one pretty write after the whole document is built, mode
/// 0600 on creation only. No mkdir and no temp-and-rename, as in the source.
pub fn write_forecast(paths: &ForecastPaths, document: &ForecastDocument) -> io::Result<Value> {
    let value = document.to_value();
    let text = serde_json::to_string_pretty(&value).map_err(io::Error::other)?;
    let path = paths.forecast_json();
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(text.as_bytes())?;
    }
    #[cfg(not(unix))]
    fs::write(&path, text)?;
    Ok(value)
}

/// stats.mjs:1693-1697: rebuild only when stale (the rebuild writes), then read;
/// a missing, unreadable or malformed file loads as `None` without rebuilding.
pub fn load_forecast<F>(
    paths: &ForecastPaths,
    now_sec: f64,
    rebuild: F,
) -> io::Result<Option<Value>>
where
    F: FnOnce() -> io::Result<()>,
{
    if forecast_stale(paths, now_sec)? {
        rebuild()?;
    }
    let path = paths.forecast_json();
    if !is_file(&path) {
        return Ok(None);
    }
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&text).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    const NOW_S: f64 = 1_700_000_000.0;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-history-{id}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn put(&self, name: &str, text: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, text).unwrap();
            path
        }

        fn paths(&self) -> ForecastPaths {
            ForecastPaths::new(&self.0, self.0.join("projects"))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn set_mtime(path: &Path, secs: f64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        let modified = UNIX_EPOCH + Duration::from_secs_f64(secs);
        file.set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }

    fn record(raw: Value, fetched_epoch: Option<i64>) -> UsageRecord {
        UsageRecord { fetched_epoch, raw }
    }

    #[test]
    fn load_merges_archives_drops_corrupt_lines_and_sorts() {
        let fixture = Fixture::new();
        fixture.put(
            "usage-snapshots-2024-01.jsonl",
            "{\"fetched_at\":\"2024-01-02 00:00:00\",\"five_hour\":{}}\n",
        );
        fixture.put(
            "usage-snapshots-2024-02.jsonl",
            "{\"fetched_at\":\"2024-02-01 00:00:00\",\"five_hour\":{}}\n",
        );
        // Valid JSON, so only the archive-name filter can exclude it.
        fixture.put(
            "usage-snapshots-notes.jsonl",
            "{\"fetched_at\":\"2024-04-01 00:00:00\"}\n",
        );
        let live = fixture.put(
            "usage-snapshots.jsonl",
            "{\"fetched_at\":\"2024-03-01 00:00:00\"}\n\n{broken\n{\"gauge\":null}\n",
        );

        let records = load_usage_snapshots(&live, true, LocalZone::Fixed(0)).unwrap();
        let order: Vec<Option<i64>> = records.iter().map(|record| record.fetched_epoch).collect();
        let january = parse_fetched_at("2024-01-02 00:00:00", LocalZone::Fixed(0));
        let february = parse_fetched_at("2024-02-01 00:00:00", LocalZone::Fixed(0));
        let march = parse_fetched_at("2024-03-01 00:00:00", LocalZone::Fixed(0));
        assert_eq!(order, vec![january, february, march, None]);

        // A non-Claude path reads that single file only.
        let single = load_usage_snapshots(&live, false, LocalZone::Fixed(0)).unwrap();
        assert_eq!(single.len(), 2);
        assert_eq!(single[1].fetched_epoch, None);
        assert_eq!(
            parse_fetched_at("2024-01-02 00:00:00", LocalZone::Fixed(3600)),
            january.map(|secs| secs - 3600)
        );
    }

    #[test]
    fn gauge_windows_match_js_nan_and_empty_string_coercion() {
        let snap = |fetched: i64, utilization: Value| {
            record(
                serde_json::json!({
                    "five_hour": { "utilization": utilization, "resets_at": "2024-01-02T05:00:00Z" },
                }),
                Some(fetched),
            )
        };
        // Math.max(NaN, 40) stays NaN for the rest of the window.
        let poisoned = gauge_windows(
            &[
                snap(100, serde_json::json!("abc")),
                snap(200, serde_json::json!(40)),
            ],
            "five_hour",
        );
        assert!(poisoned[0].u_final.is_nan());
        // Number("") === 0.
        let empty = gauge_windows(&[snap(100, serde_json::json!(""))], "five_hour");
        assert_eq!(empty[0].snaps[0].u, 0.0);
        assert_eq!(empty[0].u_final, 0.0);
    }

    #[test]
    fn gauge_windows_groups_by_minute_and_drops_unusable_records() {
        let usable = |fetched: i64, reset: &str, utilization: Value| {
            record(
                serde_json::json!({
                    "five_hour": { "utilization": utilization, "resets_at": reset },
                }),
                Some(fetched),
            )
        };
        let records = vec![
            // Same reset spelled two ways, drifting by 20s → one window.
            usable(100, "2024-01-02T05:00:20Z", serde_json::json!(10)),
            usable(200, "2024-01-02T05:00:00+00:00", serde_json::json!(40)),
            // Earlier window whose values are all negative → uFinal clamps to 0.
            usable(50, "2024-01-01T05:00:00Z", serde_json::json!(-5)),
            usable(60, "2024-01-01T05:00:00Z", serde_json::json!(-1)),
            // Dropped: no fetched_at, missing gauge, null utilization, null
            // resets_at, unparseable resets_at.
            record(
                serde_json::json!({"five_hour": {"utilization": 1, "resets_at": "2024-01-03T05:00:00Z"}}),
                None,
            ),
            record(serde_json::json!({"seven_day": {}}), Some(300)),
            record(
                serde_json::json!({"five_hour": {"utilization": null, "resets_at": "2024-01-03T05:00:00Z"}}),
                Some(300),
            ),
            record(
                serde_json::json!({"five_hour": {"utilization": 1, "resets_at": null}}),
                Some(300),
            ),
            record(
                serde_json::json!({"five_hour": {"utilization": 1, "resets_at": "yesterday"}}),
                Some(300),
            ),
        ];

        let windows = gauge_windows(&records, "five_hour");
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].u_final, 0.0);
        assert_eq!(windows[1].resets_at_canon, "2024-01-02T05:00:00Z");
        assert_eq!(
            windows[1].snaps,
            vec![
                Snapshot { t: 100.0, u: 10.0 },
                Snapshot { t: 200.0, u: 40.0 }
            ]
        );
        assert_eq!(windows[1].u_final, 40.0);
    }

    fn reset_record(fetched: i64, resets_at: Value) -> UsageRecord {
        record(
            serde_json::json!({
                "five_hour": { "utilization": 10, "resets_at": resets_at },
            }),
            Some(fetched),
        )
    }

    fn reset_sec(resets_at: Value) -> i64 {
        let windows = gauge_windows(&[reset_record(100, resets_at)], "five_hour");
        assert_eq!(windows.len(), 1);
        windows[0].reset_sec
    }

    #[test]
    fn gauge_windows_accepts_numeric_epochs_and_numeric_strings() {
        // 2026-01-01T00:00:00Z, the canonical spelling native formats to.
        const ISO: &str = "2026-01-01T00:00:00Z";
        const SECS: i64 = 1_767_225_600;
        let iso = gauge_windows(&[reset_record(100, serde_json::json!(ISO))], "five_hour");
        assert_eq!(iso[0].reset_sec, SECS);
        assert_eq!(iso[0].resets_at_canon, ISO);

        // A JSON number in seconds and the same epoch as a numeric string are
        // equivalent to the RFC3339 spelling, down to the canonical form.
        for epoch in [
            serde_json::json!(SECS),
            serde_json::json!("1767225600"),
            serde_json::json!("001767225600"),
            serde_json::json!("1767225600.9"),
            serde_json::json!(1_767_225_600.9_f64),
        ] {
            let windows = gauge_windows(&[reset_record(100, epoch)], "five_hour");
            assert_eq!(windows.len(), 1);
            assert_eq!(windows[0].reset_sec, SECS);
            assert_eq!(windows[0].resets_at_canon, iso[0].resets_at_canon);
        }

        // Milliseconds normalize to the same second; 1e12 is the inclusive
        // boundary between seconds and milliseconds.
        for millis in [
            serde_json::json!(1_767_225_600_000_i64),
            serde_json::json!("1767225600000"),
        ] {
            let windows = gauge_windows(&[reset_record(100, millis)], "five_hour");
            assert_eq!(windows[0].reset_sec, SECS);
            assert_eq!(windows[0].resets_at_canon, iso[0].resets_at_canon);
        }
        assert_eq!(
            reset_sec(serde_json::json!(1_000_000_000_000_i64)),
            1_000_000_000
        );
        assert_eq!(
            reset_sec(serde_json::json!(999_999_999_999_i64)),
            999_999_999_999
        );

        // Math.floor, not truncation toward zero.
        assert_eq!(reset_sec(serde_json::json!(-1.5_f64)), -2);
    }

    #[test]
    fn gauge_windows_drops_unparseable_resets() {
        // Inputs pinned main `_parse_reset_at` also rejects.
        for resets_at in [
            serde_json::json!(null),
            serde_json::json!(""),
            serde_json::json!("yesterday"),
            serde_json::json!("not-a-date"),
            serde_json::json!("1e5"),
            serde_json::json!(" 1767225600"),
            serde_json::json!("1767225600 "),
            serde_json::json!([]),
            serde_json::json!({}),
        ] {
            let label = resets_at.to_string();
            assert!(
                gauge_windows(&[reset_record(100, resets_at)], "five_hour").is_empty(),
                "{label} must be dropped"
            );
        }
    }

    #[test]
    fn parse_fetched_at_matches_node_strict_shape_and_date_rollover() {
        // Pairs derived from stats.mjs:1009-1014 (`new Date(y, m-1, d, H, M, S)`)
        // under a UTC local zone.
        // VERIFY: wave3-fix-forecast-3
        for (text, expected) in [
            ("2024-01-02 05:00:00", 1_704_171_600),
            ("2024-13-01 00:00:00", 1_735_689_600),
            ("2024-00-01 00:00:00", 1_701_388_800),
            ("2024-02-30 00:00:00", 1_709_251_200),
            ("2024-01-00 00:00:00", 1_703_980_800),
            ("2024-01-32 00:00:00", 1_706_745_600),
            ("2024-01-02 24:00:00", 1_704_240_000),
            ("2024-01-02 99:99:99", 1_704_516_039),
            ("0024-01-01 00:00:00", -1_451_692_800),
            ("0099-12-31 23:59:59", 946_684_799),
            ("0100-01-01 00:00:00", -59_011_459_200),
            ("0000-01-01 00:00:00", -2_208_988_800),
            ("9999-99-99 99:99:99", 253_637_152_839),
            ("2024-12-31 23:59:59", 1_735_689_599),
            ("1970-01-01 00:00:00", 0),
            ("1969-12-31 23:59:59", -1),
        ] {
            assert_eq!(
                parse_fetched_at(text, LocalZone::Fixed(0)),
                Some(expected),
                "{text}"
            );
        }
        // Shapes the anchored two-digit regex rejects.
        for rejected in [
            "2024-01-02 05:00:00.500",
            "2024-1-2 5:0:0",
            "2024-01-02-03 00:00:00",
            "2024-01-02 00:00:00:00",
            " 2024-01-02 05:00:00",
            "2024-01-02 05:00:00 ",
            "2024-01-02T05:00:00",
            "2024-01-02 05:00:00\n",
            "",
        ] {
            assert_eq!(
                parse_fetched_at(rejected, LocalZone::Fixed(0)),
                None,
                "{rejected:?}"
            );
        }
        assert_eq!(
            parse_fetched_at("2024-01-02 05:00:00", LocalZone::Fixed(3600)),
            Some(1_704_171_600 - 3600)
        );
    }

    #[test]
    fn js_number_matches_javascript_string_forms() {
        // Pairs derived from JS `Number(s)`: the Rust-only `inf`/`NaN` spellings
        // are `NaN`, while the exact `Infinity` spelling is not.
        // VERIFY: wave3-fix-forecast-5
        for (text, expected) in [
            ("inf", f64::NAN),
            ("infinity", f64::NAN),
            ("NaN", f64::NAN),
            ("nan", f64::NAN),
            ("+inf", f64::NAN),
            ("-inf", f64::NAN),
            ("1_000", f64::NAN),
            ("Infinity", f64::INFINITY),
            ("+Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("1e400", f64::INFINITY),
            ("40", 40.0),
            (" 40 ", 40.0),
            ("\u{feff}40", 40.0),
            ("", 0.0),
            (" ", 0.0),
            ("0x10", 16.0),
            ("0b101", 5.0),
            ("0o17", 15.0),
            (".5", 0.5),
            ("1.", 1.0),
            ("+.5", 0.5),
            ("1e-400", 0.0),
        ] {
            assert_eq!(
                js_number(&Value::String(text.to_owned())).to_bits(),
                expected.to_bits(),
                "{text:?}"
            );
        }
        assert!(js_number(&Value::String("-0".to_owned())).is_sign_negative());
        // `Number("inf")` is NaN in Node, so the window folds to NaN rather than inf.
        let windows = gauge_windows(
            &[record(
                serde_json::json!({"five_hour": {"utilization": "inf", "resets_at": 1_767_225_600_i64}}),
                Some(100),
            )],
            "five_hour",
        );
        assert!(windows[0].u_final.is_nan());
    }

    #[test]
    fn forecast_stale_follows_strict_mtime_rules() {
        let fixture = Fixture::new();
        let paths = fixture.paths();
        assert!(forecast_stale(&paths, NOW_S).unwrap());

        let forecast = fixture.put("forecast.json", "{}");
        set_mtime(&forecast, NOW_S - FORECAST_MAX_AGE_S - 1.0);
        assert!(forecast_stale(&paths, NOW_S).unwrap());
        set_mtime(&forecast, NOW_S - FORECAST_MAX_AGE_S);
        assert!(!forecast_stale(&paths, NOW_S).unwrap());

        let forecast_mtime = mtime_secs(&forecast).unwrap();
        let snapshots = fixture.put("usage-snapshots.jsonl", "");
        set_mtime(&snapshots, forecast_mtime);
        assert!(!forecast_stale(&paths, NOW_S).unwrap());
        set_mtime(&snapshots, forecast_mtime + 1.0);
        assert!(forecast_stale(&paths, NOW_S).unwrap());

        // Monthly archives are not staleness inputs.
        set_mtime(&snapshots, forecast_mtime);
        let archive = fixture.put("usage-snapshots-2024-01.jsonl", "");
        set_mtime(&archive, forecast_mtime + 10.0);
        assert!(!forecast_stale(&paths, NOW_S).unwrap());

        // Transcripts are.
        let project = fixture.0.join("projects").join("p1");
        fs::create_dir_all(&project).unwrap();
        let transcript = project.join("session.jsonl");
        fs::write(&transcript, "").unwrap();
        set_mtime(&transcript, forecast_mtime + 10.0);
        assert!(forecast_stale(&paths, NOW_S).unwrap());
        fs::remove_file(&transcript).unwrap();
        assert!(!forecast_stale(&paths, NOW_S).unwrap());
    }

    #[test]
    fn write_persists_key_order_and_load_rebuilds_only_when_stale() {
        let fixture = Fixture::new();
        let paths = fixture.paths();
        let mut gauges = Map::new();
        gauges.insert("five_hour".to_owned(), serde_json::json!({"ok": false}));
        let document = |fit_at: &str| ForecastDocument {
            fit_at: fit_at.to_owned(),
            model_version: "v1".to_owned(),
            gauges: gauges.clone(),
            window_balance: serde_json::json!({"r": 0.5}),
            ollama: Some(serde_json::json!({"ok": true})),
            codex: None,
        };

        let written = write_forecast(&paths, &document("fit-a")).unwrap();
        let text = fs::read_to_string(paths.forecast_json()).unwrap();
        let keys: Vec<usize> = ["fitAt", "modelVersion", "gauges", "windowBalance", "ollama"]
            .iter()
            .map(|key| text.find(key).unwrap())
            .collect();
        assert!(keys.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(!text.contains("codex"));
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), written);

        let fresh_now = mtime_secs(&paths.forecast_json()).unwrap() + 1.0;
        let loaded = load_forecast(&paths, fresh_now, || {
            panic!("fresh forecast must not rebuild")
        })
        .unwrap()
        .unwrap();
        assert_eq!(loaded["fitAt"], "fit-a");

        let stale_now = fresh_now + FORECAST_MAX_AGE_S + 1.0;
        let rebuilt = load_forecast(&paths, stale_now, || {
            write_forecast(&paths, &document("fit-b")).map(|_| ())
        })
        .unwrap()
        .unwrap();
        assert_eq!(rebuilt["fitAt"], "fit-b");

        // Fresh but malformed → None, and no rebuild.
        let malformed = fixture.put("forecast.json", "{not json");
        set_mtime(&malformed, NOW_S);
        assert_eq!(
            load_forecast(&paths, NOW_S, || panic!("malformed")).unwrap(),
            None
        );

        // A failing rebuild propagates before any read.
        set_mtime(&malformed, NOW_S - FORECAST_MAX_AGE_S - 1.0);
        let error =
            load_forecast(&paths, NOW_S, || Err(io::Error::other("write failed"))).unwrap_err();
        assert_eq!(error.to_string(), "write failed");
    }
}
