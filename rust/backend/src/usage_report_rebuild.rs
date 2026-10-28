//! Filesystem rebuild of `stats.csv` for the bundled usage report.
//!
//! Mirrors `_rebuild_stats_csv` (stats.mjs:771-930), the totals cache
//! (:353-407), session aggregation (:307-331), cost-state extraction
//! (:245-260) and the archive record (:735-742). Roots, the clock and the
//! local UTC offset are parameters; nothing here reads the environment, the
//! real home directory or a live service, and Codex rows arrive pre-built as
//! `reconcile::Row`s so this module never depends on the Codex adapter.
//!
//! Roots mirror Node's layout (stats.mjs:17-26): cost-state snapshots live in
//! `cost_state_dir` (`<state>/cost-state`), while `sessions.jsonl` and
//! `totals-cache.json` live in the `state_dir` root above it.
//!
//! Deviations from the Node source, both deliberate:
//! - `epoch_from_iso` accepts RFC 3339 only; Node's `new Date` also parses
//!   space-separated local timestamps, which transcripts never contain.
//! - Transcript traversal is capped (MAX_WALK_DEPTH / MAX_WALK_ENTRIES) and
//!   fails before any write; Node walks unbounded.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::usage_report_cost::{CostState, Pricing, extract_state, inum, js_trim};
use crate::usage_report_csv::{CSV_COLUMNS, CsvValue, encode_row};
use crate::usage_report_reconcile::{ReconcileInput, Row, ZERO_UUID, dedup_existing, reconcile};
use crate::usage_report_transcript::{
    CountValue, JsonText, TranscriptFacets, TranscriptTotals, session_totals,
};

const TOTALS_CACHE_FILE: &str = "totals-cache.json";
/// Rust-specific cache version; Node's `_v:1` entries are ignored and rebuilt.
const TOTALS_CACHE_VERSION: u32 = 2;
const SESSIONS_FILE: &str = "sessions.jsonl";
const REAP_AFTER_S: f64 = 7.0 * 24.0 * 60.0 * 60.0;
const MAX_WALK_ENTRIES: usize = 10_000;
const MAX_WALK_DEPTH: usize = 64;

/// Roots for one rebuild; tests substitute synthetic temp paths.
pub struct RebuildRoots<'a> {
    /// Transcript root: files live at `<projects>/<project>/<sid>.jsonl`.
    pub projects_dir: &'a Path,
    /// Per-session cost-state snapshots: `<state>/cost-state/<sid>.json`.
    pub cost_state_dir: &'a Path,
    /// State root (`SKILL_STATE_DIR`): `sessions.jsonl` and `totals-cache.json`.
    pub state_dir: &'a Path,
    /// The stats CSV to rewrite.
    pub csv_path: &'a Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildSummary {
    pub sessions: usize,
    pub with_cost: usize,
    pub no_cost: usize,
    pub cleared: usize,
    pub reaped: usize,
}

/// Rebuild `stats.csv` from every main transcript plus the supplied Codex rows.
pub fn rebuild_stats_csv(
    roots: &RebuildRoots<'_>,
    active_sid: Option<&str>,
    codex_rows: &[Row],
    cost: &Pricing,
    local_offset: i32,
    now: f64,
) -> io::Result<RebuildSummary> {
    let existing_csv = read_existing_csv(roots.csv_path)?;
    let existing: BTreeMap<String, Row> = dedup_existing(&existing_csv).into_iter().collect();
    let listing = list_transcripts(roots.projects_dir)?;
    let cache_path = roots.state_dir.join(TOTALS_CACHE_FILE);
    let mut cache = load_totals_cache(&cache_path);

    let mut fresh = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut with_cost = 0;
    for (sid, main_path) in &listing.mains {
        if sid == ZERO_UUID || Some(sid.as_str()) == active_sid {
            continue;
        }
        let empty: &[PathBuf] = &[];
        let sub_paths = listing
            .nested
            .get(sid)
            .map_or(empty, |paths| paths.as_slice());
        let (totals, texts) = session_totals_cached(&mut cache, sid, main_path, sub_paths)?;
        let state = read_cost_state(roots.cost_state_dir, sid);
        let row = build_row(FreshInput {
            sid,
            main_path,
            sub_paths,
            totals: &totals,
            texts: texts.as_ref(),
            existing: existing.get(sid),
            state: state.as_ref(),
            cost,
            local_offset,
        });
        // Node counts the fresh cell untrimmed (stats.mjs:800-801).
        if !cell(&row, "total_cost_usd").is_empty() {
            with_cost += 1;
        }
        seen.insert(sid.clone());
        fresh.push(row);
    }

    let rows = reconcile(&ReconcileInput {
        existing_csv: &existing_csv,
        fresh: &fresh,
        codex: codex_rows,
        active_sid,
    });
    write_csv(roots.csv_path, &rows)?;

    // Codex and carried-forward rows count the trimmed cell (stats.mjs:866, :873).
    for row in codex_rows {
        seen.insert(cell(row, "session_id").to_owned());
        if !js_trim(cell(row, "total_cost_usd")).is_empty() {
            with_cost += 1;
        }
    }
    for (sid, row) in &existing {
        if Some(sid.as_str()) == active_sid || seen.contains(sid) {
            continue;
        }
        if !js_trim(cell(row, "total_cost_usd")).is_empty() {
            with_cost += 1;
        }
    }

    let (cleared, reaped) = clear_cost_state(
        roots.cost_state_dir,
        roots.state_dir,
        active_sid,
        &rows,
        local_offset,
        now,
    )?;
    save_totals_cache(&cache_path, &cache);

    Ok(RebuildSummary {
        sessions: rows.len(),
        with_cost,
        no_cost: rows.len() - with_cost,
        cleared,
        reaped,
    })
}

// ---- enumeration ----

struct Listing {
    /// Main transcripts in glob order: `<project>/<sid>.jsonl`.
    mains: Vec<(String, PathBuf)>,
    /// Nested `.jsonl` files per session id, full-path sorted like the glob.
    nested: BTreeMap<String, Vec<PathBuf>>,
}

struct Walk {
    entries: usize,
}

fn list_transcripts(projects_dir: &Path) -> io::Result<Listing> {
    let mut listing = Listing {
        mains: Vec::new(),
        nested: BTreeMap::new(),
    };
    let mut walk = Walk { entries: 0 };
    for (_, project) in listed(projects_dir) {
        if !project.is_dir() {
            continue;
        }
        let mut project_mains = Vec::new();
        for (name, path) in listed(&project) {
            if path.is_dir() || !name.ends_with(".jsonl") {
                continue;
            }
            project_mains.push((strip_ext(&name, ".jsonl").to_owned(), path));
        }
        for (sid, _) in &project_mains {
            let sid_dir = project.join(sid);
            if !sid_dir.is_dir() {
                continue;
            }
            let mut paths = Vec::new();
            walk_nested(&sid_dir, 1, &mut paths, &mut walk)?;
            listing
                .nested
                .entry(sid.clone())
                .or_default()
                .append(&mut paths);
        }
        listing.mains.append(&mut project_mains);
    }
    for paths in listing.nested.values_mut() {
        paths.sort();
    }
    Ok(listing)
}

fn walk_nested(
    dir: &Path,
    depth: usize,
    out: &mut Vec<PathBuf>,
    walk: &mut Walk,
) -> io::Result<()> {
    if depth > MAX_WALK_DEPTH {
        return Err(io::Error::other(format!(
            "usage report rebuild: transcript directory depth exceeds {MAX_WALK_DEPTH}"
        )));
    }
    for (name, path) in listed(dir) {
        walk.entries += 1;
        if walk.entries > MAX_WALK_ENTRIES {
            return Err(io::Error::other(format!(
                "usage report rebuild: transcript traversal exceeds {MAX_WALK_ENTRIES} entries"
            )));
        }
        if path.is_dir() {
            walk_nested(&path, depth + 1, out, walk)?;
        } else if name.ends_with(".jsonl") {
            out.push(path);
        }
    }
    Ok(())
}

// fs.globSync returns matches in sorted order; list the same way.
fn listed(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| Some((entry.file_name().to_str()?.to_owned(), entry.path())))
        .collect();
    out.sort();
    out
}

// path.basename(name, ext) leaves a name equal to the extension untouched.
fn strip_ext<'a>(name: &'a str, ext: &str) -> &'a str {
    name.strip_suffix(ext)
        .filter(|rest| !rest.is_empty())
        .unwrap_or(name)
}

// ---- totals cache ----

#[derive(Clone, Serialize, Deserialize)]
struct CachedTotals {
    last_model: String,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_creation_tokens: f64,
    end_epoch: Option<f64>,
    start_epoch: Option<f64>,
    turns: f64,
    tool_calls: f64,
    facets_json: String,
}

#[derive(Serialize, Deserialize)]
struct CacheEntry {
    main_mtime: f64,
    sub: BTreeMap<String, f64>,
    res: CachedTotals,
}

#[derive(Serialize, Deserialize)]
struct CacheDocument {
    #[serde(rename = "_v")]
    version: u32,
    sids: BTreeMap<String, CacheEntry>,
}

struct TotalsCache {
    document: CacheDocument,
    dirty: bool,
}

fn load_totals_cache(path: &Path) -> TotalsCache {
    let empty = |dirty| TotalsCache {
        document: CacheDocument {
            version: TOTALS_CACHE_VERSION,
            sids: BTreeMap::new(),
        },
        dirty,
    };
    let Ok(text) = fs::read_to_string(path) else {
        return empty(false);
    };
    match serde_json::from_str::<CacheDocument>(&text) {
        Ok(document) if document.version == TOTALS_CACHE_VERSION => TotalsCache {
            document,
            dirty: false,
        },
        // Malformed or older shape: every entry recalculates.
        _ => empty(true),
    }
}

fn save_totals_cache(path: &Path, cache: &TotalsCache) {
    if !cache.dirty {
        return;
    }
    if let Ok(text) = serde_json::to_string(&cache.document) {
        let _ = write_private(path, &text);
    }
}

struct TranscriptTexts {
    main: String,
    sub: Vec<String>,
}

// `_cached_session_totals` (stats.mjs:394-407): reuse totals when the main and
// every nested transcript keep their mtimes.
fn session_totals_cached(
    cache: &mut TotalsCache,
    sid: &str,
    main_path: &Path,
    sub_paths: &[PathBuf],
) -> io::Result<(CachedTotals, Option<TranscriptTexts>)> {
    let main_mtime = mtime_s(main_path).unwrap_or(0.0);
    let sub: BTreeMap<String, f64> = sub_paths
        .iter()
        .filter_map(|path| Some((path.to_string_lossy().into_owned(), mtime_s(path)?)))
        .collect();
    if let Some(entry) = cache.document.sids.get(sid)
        && entry.main_mtime == main_mtime
        && entry.sub == sub
    {
        return Ok((entry.res.clone(), None));
    }
    let texts = read_texts(main_path, sub_paths);
    let sub_refs: Vec<&str> = texts.sub.iter().map(String::as_str).collect();
    let totals = session_totals(Some(texts.main.as_str()), &sub_refs, epoch_from_iso)
        .map_err(|error| io::Error::other(format!("usage report rebuild: {sid}: {error}")))?;
    let res = cached_totals(&totals);
    cache.document.sids.insert(
        sid.to_owned(),
        CacheEntry {
            main_mtime,
            sub,
            res: res.clone(),
        },
    );
    cache.dirty = true;
    Ok((res, Some(texts)))
}

fn read_texts(main_path: &Path, sub_paths: &[PathBuf]) -> TranscriptTexts {
    TranscriptTexts {
        // iter_jsonl swallows read failures (stats.mjs:211-217).
        main: read_lossy(main_path).unwrap_or_default(),
        sub: sub_paths
            .iter()
            .map(|path| read_lossy(path).unwrap_or_default())
            .collect(),
    }
}

/// `fs.readFileSync(p, "utf-8")` (stats.mjs:214) replaces invalid bytes with
/// U+FFFD instead of failing, so only the damaged lines are dropped.
fn read_lossy(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn cached_totals(totals: &TranscriptTotals) -> CachedTotals {
    CachedTotals {
        last_model: decode_json_string(totals.last_model.json_token()),
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        cache_read_tokens: totals.cache_read_tokens,
        cache_creation_tokens: totals.cache_creation_tokens,
        end_epoch: totals.end_epoch,
        start_epoch: totals.start_epoch,
        turns: totals.turns,
        tool_calls: totals.tool_calls,
        facets_json: facets_json(&totals.facets),
    }
}

fn decode_json_string(token: &str) -> String {
    serde_json::from_str::<String>(token).unwrap_or_default()
}

fn facets_json(facets: &TranscriptFacets) -> String {
    format!(
        "{{\"tools\":{},\"tool_errors\":{},\"agents\":{},\"skills\":{},\"compactions\":{},\"cwd\":{},\"branch\":{}}}",
        counts_json(&facets.tools),
        js_number(facets.tool_errors),
        counts_json(&facets.agents),
        counts_json(&facets.skills),
        js_number(facets.compactions),
        facets.cwd.json_token(),
        facets.branch.json_token(),
    )
}

fn counts_json(items: &[(JsonText, CountValue)]) -> String {
    let body = items
        .iter()
        .map(|(name, count)| match count {
            CountValue::Number(number) => {
                format!("{}:{}", name.json_token(), js_number(*number))
            }
            CountValue::String(text) => format!("{}:{}", name.json_token(), text.json_token()),
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{body}}}")
}

fn js_number(value: f64) -> String {
    if value.is_finite() {
        ryu_js::Buffer::new().format_finite(value).to_owned()
    } else {
        "null".into()
    }
}

// ---- fresh row construction ----

struct FreshInput<'a> {
    sid: &'a str,
    main_path: &'a Path,
    sub_paths: &'a [PathBuf],
    totals: &'a CachedTotals,
    texts: Option<&'a TranscriptTexts>,
    existing: Option<&'a Row>,
    state: Option<&'a CostState>,
    cost: &'a Pricing,
    local_offset: i32,
}

fn build_row(input: FreshInput<'_>) -> Row {
    let totals = input.totals;
    let state = input.state;
    let existing = input.existing;

    let billed_cost = {
        let existing_cost = js_trim(fwd(existing, "total_cost_usd"));
        if existing_cost.is_empty() {
            state.map(state_cost_text).unwrap_or_default()
        } else {
            existing_cost.to_owned()
        }
    };

    let number_field = |column: &str, state_value: Option<f64>| -> f64 {
        let value = inum(Some(fwd(existing, column)));
        if value != 0.0 {
            value
        } else {
            state_value.unwrap_or(0.0)
        }
    };

    // JS truthiness: NaN and 0 are both falsy (stats.mjs:819).
    let mut duration = number_field("duration_ms", state.map(|state| state.duration_ms));
    if duration == 0.0
        && let (Some(start), Some(end)) = (totals.start_epoch, totals.end_epoch)
        && start.is_finite()
        && end.is_finite()
        && start != 0.0
        && end != 0.0
    {
        duration = ((end - start) * 1000.0).trunc();
    }

    let raw_field = |column: &str, state_value: Option<&Value>| -> CsvValue {
        let existing_text = fwd(existing, column);
        if !existing_text.is_empty() {
            return CsvValue::String(existing_text.to_owned());
        }
        state_value.map_or_else(|| CsvValue::String(String::new()), json_cell)
    };

    let timestamp = {
        let existing_timestamp = js_trim(fwd(existing, "timestamp"));
        if !existing_timestamp.is_empty() {
            existing_timestamp.to_owned()
        } else {
            totals
                .end_epoch
                .and_then(|epoch| local_fmt(epoch, input.local_offset))
                .or_else(|| {
                    mtime_s(input.main_path).and_then(|mtime| local_fmt(mtime, input.local_offset))
                })
                .unwrap_or_default()
        }
    };

    let model_id = {
        let existing_model = fwd(existing, "model_id");
        if !existing_model.is_empty() {
            existing_model.to_owned()
        } else {
            state
                .map(|state| state.model_id.clone())
                .filter(|model| !model.is_empty())
                .unwrap_or_else(|| totals.last_model.clone())
        }
    };

    let display_name = {
        let existing_display = fwd(existing, "model_display_name");
        if !existing_display.is_empty() {
            existing_display.to_owned()
        } else {
            state.map_or_else(String::new, |state| state.model_display_name.clone())
        }
    };

    // Re-read only when the cache answered and the estimate is still needed.
    let est_cost = if billed_cost.is_empty() || input.cost.is_third_party(&totals.last_model) {
        let reloaded;
        let texts = if let Some(texts) = input.texts {
            texts
        } else {
            reloaded = read_texts(input.main_path, input.sub_paths);
            &reloaded
        };
        let sub_refs: Vec<&str> = texts.sub.iter().map(String::as_str).collect();
        let value = input
            .cost
            .computed_cost_from_transcript(&texts.main, &sub_refs);
        if value > 0.0 {
            to_fixed4(value)
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    vec![
        entry("timestamp", CsvValue::String(timestamp)),
        entry("session_id", CsvValue::String(input.sid.to_owned())),
        entry("total_cost_usd", CsvValue::String(billed_cost)),
        entry("last_model", CsvValue::String(totals.last_model.clone())),
        entry("input_tokens", CsvValue::Number(totals.input_tokens)),
        entry("output_tokens", CsvValue::Number(totals.output_tokens)),
        entry(
            "cache_read_tokens",
            CsvValue::Number(totals.cache_read_tokens),
        ),
        entry(
            "cache_creation_tokens",
            CsvValue::Number(totals.cache_creation_tokens),
        ),
        entry("model_id", CsvValue::String(model_id)),
        entry("model_display_name", CsvValue::String(display_name)),
        entry("duration_ms", CsvValue::Number(duration)),
        entry(
            "api_duration_ms",
            CsvValue::Number(number_field(
                "api_duration_ms",
                state.map(|state| state.api_duration_ms),
            )),
        ),
        entry(
            "lines_added",
            CsvValue::Number(number_field(
                "lines_added",
                state.map(|state| state.lines_added),
            )),
        ),
        entry(
            "lines_removed",
            CsvValue::Number(number_field(
                "lines_removed",
                state.map(|state| state.lines_removed),
            )),
        ),
        entry(
            "rl_5h_pct",
            raw_field(
                "rl_5h_pct",
                state.and_then(|state| state.rl_5h_pct.as_ref()),
            ),
        ),
        entry(
            "rl_7d_pct",
            raw_field(
                "rl_7d_pct",
                state.and_then(|state| state.rl_7d_pct.as_ref()),
            ),
        ),
        entry(
            "context_pct",
            raw_field(
                "context_pct",
                state.and_then(|state| state.context_pct.as_ref()),
            ),
        ),
        entry(
            "context_window_size",
            raw_field(
                "context_window_size",
                state.and_then(|state| state.context_window_size.as_ref()),
            ),
        ),
        entry("turns", CsvValue::Number(totals.turns)),
        entry("tool_calls", CsvValue::Number(totals.tool_calls)),
        entry(
            "start_epoch",
            totals
                .start_epoch
                .filter(|epoch| epoch.is_finite() && *epoch != 0.0)
                .map_or_else(
                    || CsvValue::String(String::new()),
                    |epoch| CsvValue::Number(epoch.trunc()),
                ),
        ),
        entry("facets_json", CsvValue::String(totals.facets_json.clone())),
        entry("est_cost_usd", CsvValue::String(est_cost)),
    ]
}

fn entry(name: &str, value: CsvValue) -> (String, CsvValue) {
    (name.to_owned(), value)
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

/// `fwd` (stats.mjs:786): the existing cell, or empty when the row is absent.
fn fwd<'a>(existing: Option<&'a Row>, column: &str) -> &'a str {
    existing.map_or("", |row| cell(row, column))
}

fn state_cost_text(state: &CostState) -> String {
    match state.cost.as_ref() {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) if text.is_empty() => String::new(),
        Some(value) => js_string_value(value),
    }
}

fn js_string_value(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number
            .as_f64()
            .map_or_else(|| number.to_string(), js_number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string_value(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn json_cell(value: &Value) -> CsvValue {
    match value {
        Value::Null => CsvValue::String(String::new()),
        Value::Bool(flag) => CsvValue::Bool(*flag),
        Value::Number(number) => CsvValue::Number(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => CsvValue::String(text.clone()),
        Value::Array(items) => CsvValue::Array(items.iter().map(json_cell).collect()),
        Value::Object(_) => CsvValue::Object,
    }
}

// ---- CSV write ----

fn read_existing_csv(path: &Path) -> io::Result<String> {
    if !path.is_file() {
        return Ok(String::new());
    }
    // Node decodes with replacement but propagates a read failure (stats.mjs:773-774).
    Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
}

fn write_csv(path: &Path, rows: &[Row]) -> io::Result<()> {
    let mut out = CSV_COLUMNS.join(",");
    out.push('\n');
    for row in rows {
        out.push_str(&encode_row(row).row);
    }
    write_private(path, &out)
}

fn write_private(path: &Path, contents: &str) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())
}

// ---- cost-state archive and reap ----

fn clear_cost_state(
    cost_state_dir: &Path,
    state_dir: &Path,
    active_sid: Option<&str>,
    rows: &[Row],
    local_offset: i32,
    now: f64,
) -> io::Result<(usize, usize)> {
    let written: Vec<&str> = rows.iter().map(|row| cell(row, "session_id")).collect();
    let recorded_at = local_fmt(now, local_offset).unwrap_or_default();
    let mut cleared = 0;
    let mut reaped = 0;
    for (name, path) in listed(cost_state_dir) {
        if !name.ends_with(".json") {
            continue;
        }
        let sid = strip_ext(&name, ".json");
        if Some(sid) == active_sid {
            continue;
        }
        let state = read_cost_state_path(&path);
        if !written.contains(&sid) {
            // Orphan reaper (stats.mjs:901-917): a snapshot can never land a row
            // once its transcript is gone, so drop it after a week.
            if transcript_missing(state.as_ref()) {
                let mtime = mtime_s(&path).ok_or_else(|| {
                    io::Error::other(format!(
                        "usage report rebuild: cannot stat {}",
                        path.display()
                    ))
                })?;
                if now - mtime > REAP_AFTER_S {
                    archive(state.as_ref(), state_dir, sid, &recorded_at);
                    if fs::remove_file(&path).is_ok() {
                        reaped += 1;
                    }
                }
            }
            continue;
        }
        archive(state.as_ref(), state_dir, sid, &recorded_at);
        if fs::remove_file(&path).is_ok() {
            cleared += 1;
        }
    }
    Ok((cleared, reaped))
}

/// stats.mjs:907: `st && st.raw && st.raw.transcript_path`, then `isFile(tp)`.
/// A corrupt state (`st` null), a path-less document and a non-string path all
/// count as missing.
fn transcript_missing(state: Option<&CostState>) -> bool {
    state
        .and_then(|state| state.raw.get("transcript_path"))
        .and_then(Value::as_str)
        .is_none_or(|transcript| !Path::new(transcript).is_file())
}

fn archive(state: Option<&CostState>, state_dir: &Path, sid: &str, recorded_at: &str) {
    let Some(state) = state else {
        return;
    };
    if state.raw.is_null() {
        return;
    }
    let record = serde_json::json!({
        "recorded_at": recorded_at,
        "session_id": sid,
        "statusline": &state.raw,
    });
    let Ok(line) = serde_json::to_string(&record) else {
        return;
    };
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(state_dir.join(SESSIONS_FILE)) {
        let _ = writeln!(file, "{line}");
    }
}

fn read_cost_state(state_dir: &Path, sid: &str) -> Option<CostState> {
    read_cost_state_path(&state_dir.join(format!("{sid}.json")))
}

fn read_cost_state_path(path: &Path) -> Option<CostState> {
    let text = fs::read_to_string(path).ok()?;
    let document: Value = serde_json::from_str(&text).ok()?;
    Some(extract_state(&document))
}

// ---- clock and number helpers ----

fn mtime_s(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(delta) => delta.as_secs_f64(),
        Err(before) => -before.duration().as_secs_f64(),
    })
}

/// `local_fmt` (stats.mjs:295-300) with the offset injected instead of the OS zone.
fn local_fmt(epoch_s: f64, offset_s: i32) -> Option<String> {
    if !epoch_s.is_finite() {
        return None;
    }
    let offset = time::UtcOffset::from_whole_seconds(offset_s).ok()?;
    let stamp = time::OffsetDateTime::from_unix_timestamp(epoch_s.floor() as i64)
        .ok()?
        .to_offset(offset);
    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        stamp.year(),
        u8::from(stamp.month()),
        stamp.day(),
        stamp.hour(),
        stamp.minute(),
        stamp.second()
    ))
}

/// `epoch_from_iso` (stats.mjs:224-228) for RFC 3339 timestamps.
fn epoch_from_iso(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let parsed =
        time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    Some(parsed.unix_timestamp() as f64 + f64::from(parsed.nanosecond()) / 1e9)
}

/// JS `Number.prototype.toFixed(4)`; ties round away from zero.
fn to_fixed4(value: f64) -> String {
    let scaled = value * 10_000.0;
    if scaled.is_finite() && scaled.fract().abs() == 0.5 {
        return format!("{:.4}", (scaled.trunc() + scaled.signum() * 0.5) / 10_000.0);
    }
    format!("{value:.4}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_report_csv::{CsvTable, dict_reader, row_value};
    use std::time::Duration;

    const NOW: f64 = 1_800_000_000.0;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "usage-report-rebuild-{}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct Fixture {
        root: TempRoot,
        projects: PathBuf,
        state: PathBuf,
        cost_state: PathBuf,
        csv: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = TempRoot::new(name);
            let projects = root.0.join("projects");
            let state = root.0.join("state");
            let cost_state = state.join("cost-state");
            fs::create_dir_all(&projects).unwrap();
            fs::create_dir_all(&cost_state).unwrap();
            let csv = state.join("stats.csv");
            Self {
                root,
                projects,
                state,
                cost_state,
                csv,
            }
        }

        fn roots(&self) -> RebuildRoots<'_> {
            RebuildRoots {
                projects_dir: &self.projects,
                cost_state_dir: &self.cost_state,
                state_dir: &self.state,
                csv_path: &self.csv,
            }
        }

        fn transcript(&self, project: &str, sid: &str, lines: &[String]) -> PathBuf {
            let path = self.projects.join(project).join(format!("{sid}.jsonl"));
            write(&path, &(lines.join("\n") + "\n"));
            path
        }

        fn state_file(&self, sid: &str, body: &str) -> PathBuf {
            let path = self.cost_state.join(format!("{sid}.json"));
            write(&path, body);
            path
        }

        fn rows(&self) -> CsvTable {
            dict_reader(&fs::read_to_string(&self.csv).unwrap())
        }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn set_mtime(path: &Path, seconds: f64) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_secs_f64(seconds))
            .unwrap();
    }

    fn assistant(ts: &str, model: &str, i: u32, o: u32, cr: u32, cc: u32) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"model":"{model}","usage":{{"input_tokens":{i},"output_tokens":{o},"cache_read_input_tokens":{cr},"cache_creation_input_tokens":{cc}}}}}}}"#
        )
    }

    fn existing_csv(entries: &[(&str, &str)]) -> String {
        let line = CSV_COLUMNS
            .iter()
            .map(|column| {
                entries
                    .iter()
                    .find(|(name, _)| name == column)
                    .map_or("", |(_, value)| *value)
            })
            .collect::<Vec<_>>()
            .join(",");
        format!("{}\n{line}\n", CSV_COLUMNS.join(","))
    }

    fn column<'a>(table: &'a CsvTable, index: usize, column: &str) -> &'a str {
        row_value(table, &table.rows[index], column).unwrap_or("")
    }

    fn rebuild(
        fixture: &Fixture,
        active: Option<&str>,
        cost: &Pricing,
    ) -> io::Result<RebuildSummary> {
        rebuild_stats_csv(&fixture.roots(), active, &[], cost, 0, NOW)
    }

    fn json_path(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn rebuild_prefers_billed_cost_and_transcript_fallbacks() {
        let fixture = Fixture::new("billed");
        fixture.transcript(
            "p1",
            "s1",
            &[
                assistant("2026-10-27T10:00:05Z", "claude-sonnet-5-5", 10, 20, 30, 40),
                assistant("2026-10-27T10:00:25Z", "claude-sonnet-5-5", 1, 2, 3, 4),
            ],
        );
        write(
            &fixture.csv,
            &existing_csv(&[
                ("timestamp", "2026-10-27 09:00:00"),
                ("session_id", "s1"),
                ("total_cost_usd", "1.2500"),
                ("duration_ms", "500"),
                ("model_display_name", "Sonnet"),
                ("rl_5h_pct", "42"),
            ]),
        );

        let summary = rebuild(&fixture, None, &Pricing::default()).unwrap();
        assert_eq!(
            summary,
            RebuildSummary {
                sessions: 1,
                with_cost: 1,
                no_cost: 0,
                cleared: 0,
                reaped: 0,
            }
        );
        let table = fixture.rows();
        assert_eq!(column(&table, 0, "total_cost_usd"), "1.2500");
        assert_eq!(column(&table, 0, "timestamp"), "2026-10-27 09:00:00");
        assert_eq!(column(&table, 0, "duration_ms"), "500");
        assert_eq!(column(&table, 0, "model_display_name"), "Sonnet");
        assert_eq!(column(&table, 0, "rl_5h_pct"), "42");
        assert_eq!(column(&table, 0, "input_tokens"), "11");
        assert_eq!(column(&table, 0, "model_id"), "claude-sonnet-5-5");
        assert_eq!(column(&table, 0, "est_cost_usd"), "");
        assert!(fs::read_to_string(&fixture.csv).unwrap().ends_with('\n'));
    }

    #[test]
    fn rebuild_falls_back_to_cost_state_and_transcript_duration() {
        let fixture = Fixture::new("state");
        fixture.transcript(
            "p1",
            "s2",
            &[
                assistant("2026-10-27T10:00:05Z", "claude-sonnet-5-5", 1, 1, 1, 1),
                assistant("2026-10-27T10:00:25Z", "claude-sonnet-5-5", 2, 2, 2, 2),
            ],
        );
        let state_path = fixture.state_file(
            "s2",
            r#"{"cost":{"total_cost_usd":0.5,"total_duration_ms":0},"model":{"id":"m-1","display_name":"Display"},"rate_limits":{"five_hour":{"used_percentage":12}},"context_window":{"used_percentage":34,"context_window_size":200000}}"#,
        );

        let summary = rebuild(&fixture, None, &Pricing::default()).unwrap();
        assert_eq!(summary.cleared, 1);
        let table = fixture.rows();
        assert_eq!(column(&table, 0, "total_cost_usd"), "0.5");
        assert_eq!(column(&table, 0, "duration_ms"), "20000");
        assert_eq!(column(&table, 0, "model_id"), "m-1");
        assert_eq!(column(&table, 0, "model_display_name"), "Display");
        assert_eq!(column(&table, 0, "rl_5h_pct"), "12");
        assert_eq!(column(&table, 0, "context_pct"), "34");
        assert_eq!(column(&table, 0, "context_window_size"), "200000");
        assert_eq!(column(&table, 0, "timestamp"), "2026-10-27 10:00:25");
        assert!(!state_path.exists());

        let sessions = fs::read_to_string(fixture.state.join(SESSIONS_FILE)).unwrap();
        let record: Value = serde_json::from_str(sessions.trim()).unwrap();
        assert_eq!(record["session_id"], "s2");
        assert_eq!(record["recorded_at"], local_fmt(NOW, 0).unwrap());
        assert_eq!(record["statusline"]["cost"]["total_cost_usd"], 0.5);
    }

    #[test]
    fn third_party_model_gets_token_estimate() {
        let fixture = Fixture::new("third-party");
        fixture.transcript(
            "p1",
            "s3",
            &[assistant("2026-10-27T10:00:00Z", "glm-4", 10, 20, 30, 40)],
        );
        let cost = Pricing::from_json(r#"{"base":{"glm":[1,2,3,4]}}"#);

        let summary = rebuild(&fixture, None, &cost).unwrap();
        assert_eq!(summary.with_cost, 0);
        assert_eq!(summary.no_cost, 1);
        let table = fixture.rows();
        assert_eq!(column(&table, 0, "total_cost_usd"), "");
        assert_eq!(column(&table, 0, "est_cost_usd"), "0.0003");
    }

    #[test]
    fn totals_cache_reuses_unchanged_transcripts_and_recovers_from_corruption() {
        let fixture = Fixture::new("cache");
        let path = fixture.transcript(
            "p1",
            "s4",
            &[assistant(
                "2026-10-27T10:00:00Z",
                "claude-sonnet-5-5",
                10,
                20,
                30,
                40,
            )],
        );
        // Pin a whole-second mtime so the cache key does not depend on the
        // clock's sub-second value that `set_mtime` has to round-trip via f64.
        set_mtime(&path, NOW - 3_600.0);
        let original = mtime_s(&path).unwrap();
        assert_eq!(original, NOW - 3_600.0);
        rebuild(&fixture, None, &Pricing::default()).unwrap();
        let cache_path = fixture.state.join(TOTALS_CACHE_FILE);
        let cache: Value = serde_json::from_str(&fs::read_to_string(&cache_path).unwrap()).unwrap();
        assert_eq!(cache["_v"], 2);

        // Same mtimes: the cached totals win even though the content changed.
        write(
            &path,
            &(assistant("2026-10-27T10:00:00Z", "claude-sonnet-5-5", 99, 99, 99, 99) + "\n"),
        );
        set_mtime(&path, original);
        rebuild(&fixture, None, &Pricing::default()).unwrap();
        assert_eq!(column(&fixture.rows(), 0, "input_tokens"), "10");

        // A newer mtime invalidates the entry.
        set_mtime(&path, original + 60.0);
        rebuild(&fixture, None, &Pricing::default()).unwrap();
        assert_eq!(column(&fixture.rows(), 0, "input_tokens"), "99");

        // A corrupt cache recalculates and is rewritten.
        write(&cache_path, "not json");
        rebuild(&fixture, None, &Pricing::default()).unwrap();
        assert_eq!(column(&fixture.rows(), 0, "input_tokens"), "99");
        let cache: Value = serde_json::from_str(&fs::read_to_string(&cache_path).unwrap()).unwrap();
        assert_eq!(cache["_v"], 2);
    }

    #[test]
    fn active_session_is_excluded_and_keeps_its_snapshot() {
        let fixture = Fixture::new("active");
        fixture.transcript(
            "p1",
            "a1",
            &[assistant(
                "2026-10-27T10:00:00Z",
                "claude-sonnet-5-5",
                1,
                1,
                1,
                1,
            )],
        );
        fixture.transcript(
            "p1",
            "a2",
            &[assistant(
                "2026-10-27T10:00:00Z",
                "claude-sonnet-5-5",
                2,
                2,
                2,
                2,
            )],
        );
        let active_state = fixture.state_file("a1", r#"{"cost":{"total_cost_usd":1}}"#);
        let other_state = fixture.state_file("a2", r#"{"cost":{"total_cost_usd":2}}"#);

        let summary = rebuild(&fixture, Some("a1"), &Pricing::default()).unwrap();
        assert_eq!(summary.sessions, 1);
        assert_eq!(column(&fixture.rows(), 0, "session_id"), "a2");
        assert!(active_state.exists());
        assert!(!other_state.exists());

        let sessions = fs::read_to_string(fixture.state.join(SESSIONS_FILE)).unwrap();
        assert!(sessions.contains("\"a2\""));
        assert!(!sessions.contains("\"a1\""));
    }

    #[test]
    fn archive_and_reap_cost_state_after_csv_write() {
        let fixture = Fixture::new("reap");
        let missing = fixture.root.0.join("gone.jsonl");
        let body = format!(
            r#"{{"transcript_path":"{}","cost":{{"total_cost_usd":1}}}}"#,
            json_path(&missing)
        );
        let orphan = fixture.state_file("orphan", &body);
        set_mtime(&orphan, NOW - 8.0 * 86_400.0);
        let recent = fixture.state_file(
            "recent",
            &format!(
                r#"{{"transcript_path":"{}"}}"#,
                json_path(&fixture.root.0.join("gone-too.jsonl"))
            ),
        );
        set_mtime(&recent, NOW - 86_400.0);

        let summary = rebuild(&fixture, None, &Pricing::default()).unwrap();
        assert_eq!(
            summary,
            RebuildSummary {
                sessions: 0,
                with_cost: 0,
                no_cost: 0,
                cleared: 0,
                reaped: 1,
            }
        );
        assert!(!orphan.exists());
        assert!(recent.exists());

        let sessions = fs::read_to_string(fixture.state.join(SESSIONS_FILE)).unwrap();
        let record: Value = serde_json::from_str(sessions.trim()).unwrap();
        assert_eq!(record["session_id"], "orphan");
        assert_eq!(record["statusline"]["transcript_path"], json_path(&missing));
    }

    #[test]
    fn reaps_old_corrupt_and_pathless_snapshots_but_keeps_parent_state_files() {
        let fixture = Fixture::new("corrupt-reap");
        let corrupt = fixture.state_file("corrupt", "not json");
        set_mtime(&corrupt, NOW - 8.0 * 86_400.0);
        let pathless = fixture.state_file("pathless", r#"{"cost":{"total_cost_usd":1}}"#);
        set_mtime(&pathless, NOW - 8.0 * 86_400.0);
        let young = fixture.state_file("young", "not json");
        set_mtime(&young, NOW - 86_400.0);
        // The reap glob is `<state>/cost-state/*.json`; the state root's own
        // pricing/forecast/cache files are never swept (stats.mjs:898).
        let pricing = fixture.state.join("pricing.json");
        write(&pricing, r#"{"m":1}"#);
        set_mtime(&pricing, NOW - 8.0 * 86_400.0);
        let cache = fixture.state.join(TOTALS_CACHE_FILE);
        write(&cache, r#"{"_v":2,"sids":{}}"#);
        set_mtime(&cache, NOW - 8.0 * 86_400.0);

        let summary = rebuild(&fixture, None, &Pricing::default()).unwrap();
        assert_eq!(summary.reaped, 2);
        assert_eq!(summary.cleared, 0);
        assert!(!corrupt.exists());
        assert!(!pathless.exists());
        assert!(young.exists());
        assert!(pricing.exists());
        assert!(cache.exists());

        // Only the parseable snapshot is archived.
        let sessions = fs::read_to_string(fixture.state.join(SESSIONS_FILE)).unwrap();
        assert_eq!(sessions.lines().count(), 1);
        assert!(sessions.contains("\"pathless\""));
    }

    #[test]
    fn whitespace_only_state_cost_counts_as_with_cost() {
        let fixture = Fixture::new("ws-cost");
        fixture.transcript(
            "p1",
            "w1",
            &[assistant(
                "2026-10-27T10:00:00Z",
                "claude-sonnet-5-5",
                1,
                1,
                1,
                1,
            )],
        );
        fixture.state_file("w1", r#"{"cost":{"total_cost_usd":" "}}"#);

        // Node counts the untrimmed state cost (stats.mjs:799-801).
        let summary = rebuild(&fixture, None, &Pricing::default()).unwrap();
        assert_eq!(summary.with_cost, 1);
        assert_eq!(summary.no_cost, 0);
        assert_eq!(column(&fixture.rows(), 0, "total_cost_usd"), " ");
    }

    #[test]
    fn traversal_limit_fails_without_writing_csv() {
        let fixture = Fixture::new("limit");
        fixture.transcript(
            "p1",
            "deep",
            &[assistant(
                "2026-10-27T10:00:00Z",
                "claude-sonnet-5-5",
                1,
                1,
                1,
                1,
            )],
        );
        let mut dir = fixture.projects.join("p1").join("deep");
        for index in 0..70 {
            dir = dir.join(format!("d{index}"));
        }
        write(
            &dir.join("nested.jsonl"),
            &(assistant("2026-10-27T10:00:01Z", "claude-sonnet-5-5", 1, 1, 1, 1) + "\n"),
        );

        let error = rebuild(&fixture, None, &Pricing::default()).unwrap_err();
        assert!(error.to_string().contains("depth"));
        assert!(!fixture.csv.exists());
    }
}
