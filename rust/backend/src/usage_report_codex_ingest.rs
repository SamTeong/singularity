//! Codex rollout ingestion: discovery, mtime cache, usage history and rows.
//!
//! Mirrors the I/O half of `codexIngest` (codex.mjs:354-516),
//! `_rollout_files` (:78-93), `_thread_id_from_filename` (:94-99), the
//! `codex-cache.json` cache (:241-266), `_maybe_warn_unknown_model` (:303-311)
//! and `_append_usage_jsonl` (:324-352). Row production stays in
//! `usage_report_codex_rows`; this module owns paths, the clock offset and the
//! `CodexRow` -> `reconcile::Row` mapping.
//!
//! Deviations from the Node source: the cache stores this crate's thread
//! struct (the Node cache is not read or written after the native cutover),
//! the unknown-model condition is injected as a predicate, and
//! `epoch_from_iso` accepts RFC 3339 only.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

use crate::usage_report_codex_rows::{
    CodexRow, CodexThread, Gauge, RateReading, codex_rows_from_threads, parse_thread,
};
use crate::usage_report_csv::CsvValue;
use crate::usage_report_reconcile::Row;

/// codex.mjs:11.
const CACHE_VERSION: u32 = 1;
const CACHE_FILE: &str = "codex-cache.json";
const USAGE_FILE: &str = "codex-usage.jsonl";

/// Ingest every Codex rollout under `codex_home` and produce report rows.
///
/// `now` is accepted for the pipeline's uniform signature; `codexIngest` is
/// clock-free. `local_offset` is the UTC offset in seconds used for the row
/// timestamp and the `codex-usage.jsonl` `fetched_at`. Errors are returned for
/// the caller to swallow: the Node caller logs and keeps the pre-existing
/// Codex rows (stats.mjs:858-870).
pub fn codex_ingest(
    codex_home: &Path,
    state_dir: &Path,
    _now: f64,
    local_offset: i32,
    // Row costs: `Some` when the model is priced at those token counts.
    cost_fn: &dyn Fn(&str, f64, f64, f64, f64) -> Option<f64>,
    // The whole `_maybe_warn_unknown_model` condition (codex.mjs:303-311):
    // nonempty, `UNKNOWN_MODEL_RE`, and price key absent or the default key.
    warn_unknown_model: &dyn Fn(&str) -> bool,
) -> io::Result<Vec<Row>> {
    let cache_path = state_dir.join(CACHE_FILE);
    let usage_path = state_dir.join(USAGE_FILE);
    let local_fmt = |epoch: f64| format_local(epoch, local_offset);
    let mut cache = load_cache(&cache_path);

    let mut threads: Vec<CodexThread> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut fresh: Vec<RateReading> = Vec::new();

    for file in rollout_files(codex_home) {
        let key = thread_id_from_filename(&file);
        seen.insert(key.clone());
        let mtime = match mtime_secs(&file) {
            Ok(mtime) => mtime,
            Err(error) => {
                eprintln!("codex.mjs: stat failed for {}: {error}", file.display());
                continue;
            }
        };
        let cached = cache
            .threads
            .get(&key)
            .filter(|entry| entry.mtime == mtime)
            .map(|entry| entry.res.clone());
        let thread = match cached {
            Some(thread) => thread,
            None => {
                let text = match fs::read_to_string(&file) {
                    Ok(text) => text,
                    Err(error) => {
                        eprintln!("codex.mjs: unreadable rollout {}: {error}", file.display());
                        continue;
                    }
                };
                let thread = parse_thread(&text, &key, epoch_from_iso);
                fresh.extend(thread.rate_readings.iter().cloned());
                cache.threads.insert(
                    key.clone(),
                    CacheEntry {
                        mtime,
                        res: thread.clone(),
                    },
                );
                cache.dirty = true;
                thread
            }
        };
        // Two rollout files can carry the same thread id (sessions vs
        // archived_sessions); the JS object keeps the first position and the
        // last value.
        match positions.get(&key) {
            Some(&index) => threads[index] = thread,
            None => {
                positions.insert(key, threads.len());
                threads.push(thread);
            }
        }
    }

    let cached_count = cache.threads.len();
    cache.threads.retain(|key, _| seen.contains(key));
    if cache.threads.len() != cached_count {
        cache.dirty = true;
    }
    save_cache(&cache_path, &cache);

    warn_unknown_models(&threads, warn_unknown_model);
    let rows = codex_rows_from_threads(&threads, &local_fmt, cost_fn);

    // codex.mjs:344: only threads re-parsed this run feed the history, so an
    // unchanged ~/.codex appends nothing.
    fresh.sort_by(|left, right| {
        left.epoch
            .unwrap_or(0.0)
            .total_cmp(&right.epoch.unwrap_or(0.0))
    });
    append_usage(&usage_path, &fresh, &local_fmt);

    Ok(rows.iter().map(to_row).collect())
}

/// `_rollout_files` (codex.mjs:78-93): both areas, recursively, sorted for a
/// deterministic merge order (Node relies on glob's order).
fn rollout_files(codex_home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for base in [
        codex_home.join("sessions"),
        codex_home.join("archived_sessions"),
    ] {
        if !base.is_dir() {
            continue;
        }
        let mut found = Vec::new();
        collect_rollouts(&base, &mut found);
        found.sort();
        out.extend(found);
    }
    out
}

fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("codex.mjs: glob failed under {}: {error}", dir.display());
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, out);
        } else if is_rollout(&path) {
            out.push(path);
        }
    }
}

fn is_rollout(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy())
        .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
}

/// `_thread_id_from_filename` (codex.mjs:94-99).
fn thread_id_from_filename(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = name.strip_suffix(".jsonl").unwrap_or(&name);
    match uuid_suffix(stem) {
        Some(id) => id.to_owned(),
        None => stem.to_owned(),
    }
}

/// The `-<uuid>$` tail the Node regex captures, or `None`.
fn uuid_suffix(stem: &str) -> Option<&str> {
    let start = stem.len().checked_sub(36)?;
    let bytes = stem.as_bytes();
    if start == 0
        || bytes[start - 1] != b'-'
        || !stem.is_char_boundary(start)
        || !stem.is_char_boundary(start - 1)
    {
        return None;
    }
    let mut index = start;
    for (position, group) in [8usize, 4, 4, 4, 12].into_iter().enumerate() {
        if position > 0 {
            if bytes.get(index) != Some(&b'-') {
                return None;
            }
            index += 1;
        }
        for _ in 0..group {
            if !bytes.get(index)?.is_ascii_hexdigit() {
                return None;
            }
            index += 1;
        }
    }
    Some(&stem[start..])
}

fn mtime_secs(path: &Path) -> io::Result<f64> {
    let modified = fs::metadata(path)?.modified()?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs_f64())
        .unwrap_or(0.0))
}

/// `epoch_from_iso` (stats.mjs:229-233) for the RFC 3339 stamps rollouts carry.
fn epoch_from_iso(text: &str) -> Option<f64> {
    let stamp = OffsetDateTime::parse(text, &Rfc3339).ok()?;
    Some(stamp.unix_timestamp() as f64 + f64::from(stamp.nanosecond()) / 1e9)
}

/// `fmtLocal` in `local_fmt` (stats.mjs:281-305); an invalid epoch renders
/// empty because the row field is a string here.
fn format_local(epoch: f64, local_offset: i32) -> String {
    let offset = UtcOffset::from_whole_seconds(local_offset).unwrap_or(UtcOffset::UTC);
    let Ok(stamp) = OffsetDateTime::from_unix_timestamp(epoch as i64) else {
        return String::new();
    };
    let stamp = stamp.to_offset(offset);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        stamp.year(),
        u8::from(stamp.month()),
        stamp.day(),
        stamp.hour(),
        stamp.minute(),
        stamp.second()
    )
}

// ---- mtime-gated per-thread cache (codex-cache.json) ----

struct Cache {
    version: u32,
    threads: HashMap<String, CacheEntry>,
    dirty: bool,
}

#[derive(Serialize, Deserialize)]
struct CacheEntry {
    mtime: f64,
    res: CodexThread,
}

/// `_load_cache` (codex.mjs:243-254): a missing file is clean, an unreadable,
/// malformed or wrong-version one is emptied and marked dirty.
fn load_cache(path: &Path) -> Cache {
    let empty = |dirty| Cache {
        version: CACHE_VERSION,
        threads: HashMap::new(),
        dirty,
    };
    if !path.is_file() {
        return empty(false);
    }
    let Ok(text) = fs::read_to_string(path) else {
        return empty(true);
    };
    let Ok(Value::Object(mut document)) = serde_json::from_str::<Value>(&text) else {
        return empty(true);
    };
    if document.get("version").and_then(Value::as_u64) != Some(u64::from(CACHE_VERSION)) {
        return empty(true);
    }
    let mut cache = empty(false);
    if let Some(Value::Object(threads)) = document.remove("threads") {
        for (key, value) in threads {
            match serde_json::from_value::<CacheEntry>(value) {
                Ok(entry) => {
                    cache.threads.insert(key, entry);
                }
                // Node keeps an unvalidated `res`; a shape this crate cannot
                // read is dropped so the rollout is simply parsed again.
                Err(_) => cache.dirty = true,
            }
        }
    }
    cache
}

/// `_save_cache` (codex.mjs:256-266): non-fatal, mode 0600 on creation.
fn save_cache(path: &Path, cache: &Cache) {
    if !cache.dirty {
        return;
    }
    let document = serde_json::json!({"version": cache.version, "threads": cache.threads});
    let text = document.to_string();
    let write = || -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)?.write_all(text.as_bytes())
    };
    let _ = write();
}

// ---- unknown-model warning (codex.mjs:303-311) ----

/// `_maybe_warn_unknown_model`: the injected predicate carries the whole Node
/// condition (nonempty, `UNKNOWN_MODEL_RE`, and price key absent or the default
/// key), so no model filter is repeated here. Returns each warned model once.
fn warn_unknown_models<'a>(
    threads: &'a [CodexThread],
    warn_unknown_model: &dyn Fn(&str) -> bool,
) -> Vec<&'a str> {
    let mut warned: Vec<&str> = Vec::new();
    for thread in threads {
        let models = thread
            .turn_contexts
            .iter()
            .map(|context| context.model.as_str())
            .chain(
                thread
                    .token_readings
                    .iter()
                    .filter_map(|reading| reading.model.as_deref()),
            );
        for model in models {
            if warn_unknown_model(model) && !warned.iter().any(|seen| *seen == model) {
                eprintln!(
                    "codex.mjs: unrecognized Codex model \"{model}\" falls through to no or default pricing"
                );
                warned.push(model);
            }
        }
    }
    warned
}

// ---- codex-usage.jsonl (codex.mjs:324-352) ----

/// Append newly observed rate-limit readings, deduped against the file's last
/// line and within the pass. Records mirror the daemon's contract
/// (`{fetched_at, session, weekly}`) so stats.mjs can read both writers.
fn append_usage(path: &Path, readings: &[RateReading], local_fmt: &dyn Fn(f64) -> String) {
    if readings.is_empty() {
        return;
    }
    let mut last_key = last_usage_key(path);
    let mut out: Vec<String> = Vec::new();
    for reading in readings {
        let session = gauge_json(reading.session.as_ref());
        let weekly = gauge_json(reading.weekly.as_ref());
        let key = format!("[{session},{weekly}]");
        if last_key.as_deref() == Some(key.as_str()) {
            continue;
        }
        let fetched_at = match reading.epoch {
            Some(epoch) => json_string(&local_fmt(epoch)),
            None => "null".to_owned(),
        };
        out.push(format!(
            "{{\"fetched_at\":{fetched_at},\"session\":{session},\"weekly\":{weekly}}}"
        ));
        last_key = Some(key);
    }
    if out.is_empty() {
        return;
    }
    let mut text = out.join("\n");
    text.push('\n');
    let write = || -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)?.write_all(text.as_bytes())
    };
    if let Err(error) = write() {
        eprintln!("codex.mjs: failed to write {}: {error}", path.display());
    }
}

/// `JSON.stringify([last.session ?? null, last.weekly ?? null])`.
fn last_usage_key(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let line = text
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .next_back()?;
    let Value::Object(record) = serde_json::from_str::<Value>(line).ok()? else {
        return None;
    };
    let session = record.get("session").cloned().unwrap_or(Value::Null);
    let weekly = record.get("weekly").cloned().unwrap_or(Value::Null);
    serde_json::to_string(&Value::Array(vec![session, weekly])).ok()
}

fn gauge_json(gauge: Option<&Gauge>) -> String {
    match gauge {
        Some(gauge) => format!(
            "{{\"utilization\":{},\"resets_at\":{}}}",
            js_number(gauge.utilization),
            gauge.resets_at
        ),
        None => "null".to_owned(),
    }
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).expect("a string always serializes")
}

/// JS `JSON.stringify` number formatting.
fn js_number(value: f64) -> String {
    if value.is_finite() {
        ryu_js::Buffer::new().format_finite(value).to_owned()
    } else {
        "null".to_owned()
    }
}

// ---- CodexRow -> reconcile::Row ----

/// Blank cells stay empty strings, as the JS row objects carry `""`, not null.
fn to_row(row: &CodexRow) -> Row {
    let text = |value: &str| CsvValue::String(value.to_owned());
    let optional = |value: Option<f64>| match value {
        Some(number) => CsvValue::Number(number),
        None => CsvValue::String(String::new()),
    };
    vec![
        ("timestamp".to_owned(), text(&row.timestamp)),
        ("session_id".to_owned(), text(&row.session_id)),
        ("total_cost_usd".to_owned(), text(&row.total_cost_usd)),
        ("last_model".to_owned(), text(&row.last_model)),
        (
            "input_tokens".to_owned(),
            CsvValue::Number(row.input_tokens),
        ),
        (
            "output_tokens".to_owned(),
            CsvValue::Number(row.output_tokens),
        ),
        (
            "cache_read_tokens".to_owned(),
            CsvValue::Number(row.cache_read_tokens),
        ),
        (
            "cache_creation_tokens".to_owned(),
            CsvValue::Number(row.cache_creation_tokens),
        ),
        ("model_id".to_owned(), text(&row.model_id)),
        (
            "model_display_name".to_owned(),
            text(&row.model_display_name),
        ),
        ("duration_ms".to_owned(), optional(row.duration_ms)),
        ("api_duration_ms".to_owned(), text(&row.api_duration_ms)),
        ("lines_added".to_owned(), text(&row.lines_added)),
        ("lines_removed".to_owned(), text(&row.lines_removed)),
        ("rl_5h_pct".to_owned(), optional(row.rl_5h_pct)),
        ("rl_7d_pct".to_owned(), optional(row.rl_7d_pct)),
        ("context_pct".to_owned(), text(&row.context_pct)),
        (
            "context_window_size".to_owned(),
            optional(row.context_window_size),
        ),
        ("turns".to_owned(), CsvValue::Number(row.turns)),
        ("tool_calls".to_owned(), CsvValue::Number(row.tool_calls)),
        ("start_epoch".to_owned(), optional(row.start_epoch)),
        ("facets_json".to_owned(), text(&row.facets_json)),
        (
            "est_cost_usd".to_owned(),
            text(row.est_cost_usd.as_deref().unwrap_or("")),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_report_csv::CSV_COLUMNS;

    const ROOT_ID: &str = "11111111-2222-4333-8444-555555555555";
    const SUB_ID: &str = "11111111-2222-4333-8444-666666666666";

    fn cost(
        _model: &str,
        input: f64,
        output: f64,
        cache_read: f64,
        cache_creation: f64,
    ) -> Option<f64> {
        Some((input + output + cache_read + cache_creation) * 0.000001)
    }

    fn no_warn(_model: &str) -> bool {
        false
    }

    struct TempTree(PathBuf);

    impl TempTree {
        fn new(label: &str) -> Self {
            let base = std::env::temp_dir()
                .join(format!("sgl-codex-ingest-{}-{label}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(&base).expect("temp tree");
            Self(base)
        }

        fn home(&self) -> PathBuf {
            self.0.join("home")
        }

        fn state(&self) -> PathBuf {
            self.0.join("state")
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn rollout_text(session_id: &str, model: &str, input: u32, cached: u32) -> String {
        let template = r#"
{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"session_id":"SID","cwd":"C:\\proj"}}
{"timestamp":"2026-01-01T00:00:01Z","type":"turn_context","payload":{"model":"MODEL"}}
{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"user_message"}}
{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":INPUT,"cached_input_tokens":CACHED,"output_tokens":10},"model_context_window":200000},"rate_limits":{"primary":{"used_percent":25,"window_minutes":300,"resets_at":1767225600},"secondary":{"used_percent":40,"window_minutes":10080,"resets_at":1767225600}}}}
"#;
        template
            .replace("SID", session_id)
            .replace("MODEL", model)
            .replace("INPUT", &input.to_string())
            .replace("CACHED", &cached.to_string())
    }

    fn write_rollout(home: &Path, area: &str, name: &str, text: &str) -> PathBuf {
        let dir = home.join(area).join("2026").join("01").join("01");
        fs::create_dir_all(&dir).expect("rollout dir");
        let path = dir.join(name);
        fs::write(&path, text).expect("rollout file");
        path
    }

    fn cell<'a>(row: &'a Row, column: &str) -> &'a str {
        row.iter()
            .find(|(key, _)| key == column)
            .and_then(|(_, value)| match value {
                CsvValue::String(text) => Some(text.as_str()),
                _ => None,
            })
            .unwrap_or("")
    }

    fn number(row: &Row, column: &str) -> Option<f64> {
        row.iter()
            .find(|(key, _)| key == column)
            .and_then(|(_, value)| match value {
                CsvValue::Number(number) => Some(*number),
                _ => None,
            })
    }

    #[test]
    fn ingests_both_areas_into_rows_and_writes_cache_and_history() {
        let tree = TempTree::new("both-areas");
        let (home, state) = (tree.home(), tree.state());
        write_rollout(
            &home,
            "sessions",
            &format!("rollout-2026-01-01T00-00-00-{ROOT_ID}.jsonl"),
            &rollout_text(ROOT_ID, "gpt-6-sol", 1000, 200),
        );
        write_rollout(
            &home,
            "archived_sessions",
            &format!("rollout-2026-01-02T00-00-00-{SUB_ID}.jsonl"),
            &rollout_text(ROOT_ID, "gpt-6-sol", 500, 0),
        );

        let rows = codex_ingest(&home, &state, 0.0, 0, &cost, &no_warn).expect("ingest");
        assert_eq!(rows.len(), 1, "sub thread folds into the root session");
        let row = &rows[0];
        assert_eq!(row.len(), CSV_COLUMNS.len());
        assert_eq!(cell(row, "session_id"), ROOT_ID);
        assert_eq!(cell(row, "last_model"), "gpt-6-sol");
        assert_eq!(cell(row, "model_display_name"), "GPT-6 Sol");
        assert_eq!(number(row, "input_tokens"), Some(1300.0), "cached excluded");
        assert_eq!(number(row, "output_tokens"), Some(20.0));
        assert_eq!(number(row, "cache_read_tokens"), Some(200.0));
        assert_eq!(number(row, "cache_creation_tokens"), Some(0.0));
        assert_eq!(number(row, "turns"), Some(2.0));
        assert_eq!(number(row, "rl_5h_pct"), Some(25.0));
        assert_eq!(number(row, "rl_7d_pct"), Some(40.0));
        assert_eq!(number(row, "start_epoch"), Some(1767225600.0));
        assert_eq!(number(row, "duration_ms"), Some(3000.0));
        assert_eq!(cell(row, "timestamp"), "2026-01-01 00:00:03");
        assert_eq!(cell(row, "total_cost_usd"), "");
        assert_eq!(cell(row, "est_cost_usd"), "0.0015");
        assert_eq!(cell(row, "context_pct"), "");

        let cache: Value = serde_json::from_str(
            &fs::read_to_string(state.join("codex-cache.json")).expect("cache file"),
        )
        .expect("cache json");
        assert_eq!(cache["version"], 1);
        let threads = cache["threads"].as_object().expect("threads map");
        assert_eq!(threads.len(), 2, "one entry per rollout file");
        assert!(threads.contains_key(ROOT_ID));
        assert!(threads.contains_key(SUB_ID));
        assert!(threads[ROOT_ID]["res"]["root_id"] == ROOT_ID);

        let usage = fs::read_to_string(state.join("codex-usage.jsonl")).expect("usage file");
        let lines = usage.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 1, "identical readings dedupe within the pass");
        let record: Value = serde_json::from_str(lines[0]).expect("usage json");
        assert_eq!(record["fetched_at"], "2026-01-01 00:00:03");
        assert_eq!(record["session"]["utilization"], 25.0);
        assert_eq!(record["session"]["resets_at"], 1767225600);
        assert_eq!(record["weekly"]["utilization"], 40.0);
        assert!(usage.ends_with('\n'));
    }

    #[test]
    fn local_offset_shifts_the_row_timestamp() {
        let tree = TempTree::new("offset");
        let (home, state) = (tree.home(), tree.state());
        write_rollout(
            &home,
            "sessions",
            &format!("rollout-2026-01-01T00-00-00-{ROOT_ID}.jsonl"),
            &rollout_text(ROOT_ID, "gpt-6-sol", 10, 0),
        );

        let rows = codex_ingest(&home, &state, 0.0, 3600, &cost, &no_warn).expect("ingest");
        assert_eq!(cell(&rows[0], "timestamp"), "2026-01-01 01:00:03");
    }

    #[test]
    fn second_run_reuses_the_cache_and_appends_no_history() {
        let tree = TempTree::new("cache-hit");
        let (home, state) = (tree.home(), tree.state());
        write_rollout(
            &home,
            "sessions",
            &format!("rollout-2026-01-01T00-00-00-{ROOT_ID}.jsonl"),
            &rollout_text(ROOT_ID, "gpt-6-sol", 1000, 200),
        );

        let first = codex_ingest(&home, &state, 0.0, 0, &cost, &no_warn).expect("first ingest");
        let cache_before = fs::read(state.join("codex-cache.json")).expect("cache");
        let usage_before = fs::read(state.join("codex-usage.jsonl")).expect("usage");

        let second = codex_ingest(&home, &state, 0.0, 0, &cost, &no_warn).expect("second ingest");
        assert_eq!(first, second);
        assert_eq!(
            fs::read(state.join("codex-cache.json")).unwrap(),
            cache_before
        );
        assert_eq!(
            fs::read(state.join("codex-usage.jsonl")).unwrap(),
            usage_before,
            "cache hits contribute no readings"
        );
    }

    #[test]
    fn stale_cache_entries_are_pruned_when_a_rollout_disappears() {
        let tree = TempTree::new("prune");
        let (home, state) = (tree.home(), tree.state());
        let path = write_rollout(
            &home,
            "sessions",
            &format!("rollout-2026-01-01T00-00-00-{ROOT_ID}.jsonl"),
            &rollout_text(ROOT_ID, "gpt-6-sol", 10, 0),
        );
        codex_ingest(&home, &state, 0.0, 0, &cost, &no_warn).expect("first ingest");

        fs::remove_file(&path).expect("remove rollout");
        let rows = codex_ingest(&home, &state, 0.0, 0, &cost, &no_warn).expect("second ingest");
        assert!(rows.is_empty());

        let cache: Value = serde_json::from_str(
            &fs::read_to_string(state.join("codex-cache.json")).expect("cache"),
        )
        .unwrap();
        assert_eq!(cache["threads"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn a_foreign_cache_version_is_discarded_and_reparsed() {
        let tree = TempTree::new("cache-version");
        let (home, state) = (tree.home(), tree.state());
        write_rollout(
            &home,
            "sessions",
            &format!("rollout-2026-01-01T00-00-00-{ROOT_ID}.jsonl"),
            &rollout_text(ROOT_ID, "gpt-6-sol", 10, 0),
        );
        fs::create_dir_all(&state).unwrap();
        fs::write(
            state.join("codex-cache.json"),
            r#"{"version":2,"threads":{"stale":{"mtime":1,"res":{}}}}"#,
        )
        .unwrap();

        let rows = codex_ingest(&home, &state, 0.0, 0, &cost, &no_warn).expect("ingest");
        assert_eq!(rows.len(), 1);
        let cache: Value = serde_json::from_str(
            &fs::read_to_string(state.join("codex-cache.json")).expect("cache"),
        )
        .unwrap();
        assert_eq!(cache["version"], 1);
        assert!(!cache["threads"].as_object().unwrap().contains_key("stale"));
    }

    #[test]
    fn duplicate_thread_ids_keep_one_thread_in_first_seen_order() {
        let tree = TempTree::new("duplicate");
        let (home, state) = (tree.home(), tree.state());
        let name = format!("rollout-2026-01-01T00-00-00-{ROOT_ID}.jsonl");
        write_rollout(
            &home,
            "sessions",
            &name,
            &rollout_text(ROOT_ID, "gpt-6-sol", 10, 0),
        );
        fs::create_dir_all(home.join("archived_sessions")).unwrap();
        let archived = home.join("archived_sessions").join(&name);
        fs::write(&archived, rollout_text(ROOT_ID, "gpt-6-sol", 70, 0)).unwrap();
        // A matching mtime reuses the SID cache in both implementations.
        fs::OpenOptions::new()
            .write(true)
            .open(&archived)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1))
            .unwrap();

        let rows = codex_ingest(&home, &state, 0.0, 0, &cost, &no_warn).expect("ingest");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            number(&rows[0], "input_tokens"),
            Some(70.0),
            "last value wins"
        );
    }

    #[test]
    fn thread_ids_come_from_the_filename_then_fall_back_to_the_stem() {
        assert_eq!(
            thread_id_from_filename(Path::new(&format!(
                "/x/rollout-2026-01-01T00-00-00-{ROOT_ID}.jsonl"
            ))),
            ROOT_ID
        );
        assert_eq!(
            thread_id_from_filename(Path::new(
                "/x/rollout-2026-01-01T00-00-00-ABCDEF12-2222-4333-8444-555555555555.jsonl"
            )),
            "ABCDEF12-2222-4333-8444-555555555555"
        );
        assert_eq!(
            thread_id_from_filename(Path::new("/x/rollout-weird.jsonl")),
            "rollout-weird"
        );
        assert_eq!(
            thread_id_from_filename(Path::new("/x/rollout-2222-4333-8444-555555555555.jsonl")),
            "rollout-2222-4333-8444-555555555555",
            "not a full uuid"
        );
    }

    #[test]
    fn a_non_copy_formatter_is_reused_across_sessions() {
        let first = rollout_text(ROOT_ID, "gpt-6-sol", 10, 0);
        let second = rollout_text(SUB_ID, "gpt-6-sol", 20, 0);
        let threads = vec![
            parse_thread(&first, ROOT_ID, epoch_from_iso),
            parse_thread(&second, SUB_ID, epoch_from_iso),
        ];
        // Captures its prefix and is not `Copy`; both `Option::map` sites in
        // `codex_rows_from_threads` must borrow it rather than move it.
        let prefix = String::from("local ");
        let formatter = move |epoch: f64| format!("{prefix}{}", format_local(epoch, 0));

        let rows = codex_rows_from_threads(&threads, formatter, &cost);
        assert_eq!(rows.len(), 2, "one row per root session");
        assert_eq!(rows[0].timestamp, "local 2026-01-01 00:00:03");
    }

    #[test]
    fn the_injected_predicate_decides_the_unknown_model_warning() {
        let text = rollout_text(ROOT_ID, "gpt-9-future", 10, 0);
        let threads = vec![parse_thread(&text, ROOT_ID, epoch_from_iso)];

        // Node warns for `gpt-*`/`codex*` when the price key is absent *or* is
        // the default key, even though the default tier still returns a cost.
        // That whole condition lives in the injected predicate, so a model the
        // cost callback prices is still flagged when the predicate says so.
        let warned = warn_unknown_models(&threads, &|model| model == "gpt-9-future");
        assert_eq!(warned, ["gpt-9-future"], "once per distinct model");

        assert!(
            warn_unknown_models(&threads, &no_warn).is_empty(),
            "the predicate rejects every model here"
        );
    }

    #[test]
    fn history_dedupes_against_the_last_recorded_reading() {
        let tree = TempTree::new("usage-dedup");
        let (home, state) = (tree.home(), tree.state());
        write_rollout(
            &home,
            "sessions",
            &format!("rollout-2026-01-01T00-00-00-{ROOT_ID}.jsonl"),
            &rollout_text(ROOT_ID, "gpt-6-sol", 10, 0),
        );
        fs::create_dir_all(&state).unwrap();
        let existing = concat!(
            r#"{"fetched_at":"2025-12-31 23:00:00","session":{"utilization":25,"resets_at":1767225600},"weekly":{"utilization":40,"resets_at":1767225600}}"#,
            "\n"
        );
        fs::write(state.join("codex-usage.jsonl"), existing).unwrap();

        codex_ingest(&home, &state, 0.0, 0, &cost, &no_warn).expect("ingest");
        assert_eq!(
            fs::read_to_string(state.join("codex-usage.jsonl")).unwrap(),
            existing,
            "the same reading is already the file's last line"
        );
    }
}
