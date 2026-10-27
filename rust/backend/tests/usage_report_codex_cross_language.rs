//! Differential oracle: Codex rollout rows from the Rust port vs the bundled
//! `codex.mjs` the port was made from, over checked-in synthetic fixtures.
use serde_json::{Value, json};
use singularity_backend::usage_report_codex_rows::{CodexRow, CodexThreadText, codex_rows};
use std::process::Command;

const ROOT_NAME: &str = "rollout-2026-01-01T00-00-00-aaaaaaaa-0000-4000-8000-000000000001.jsonl";
const SUB_NAME: &str = "rollout-2026-01-01T00-01-00-aaaaaaaa-0000-4000-8000-000000000002.jsonl";
const MALFORMED_NAME: &str =
    "rollout-2026-01-01T02-00-00-bbbbbbbb-0000-4000-8000-000000000003.jsonl";
const TIES_NAME: &str = "rollout-2026-01-01T03-00-00-cccccccc-0000-4000-8000-000000000004.jsonl";

const ROOT: &str = include_str!(
    "fixtures/codex-oracle/rollout-2026-01-01T00-00-00-aaaaaaaa-0000-4000-8000-000000000001.jsonl"
);
const SUB: &str = include_str!(
    "fixtures/codex-oracle/rollout-2026-01-01T00-01-00-aaaaaaaa-0000-4000-8000-000000000002.jsonl"
);
const MALFORMED: &str = include_str!(
    "fixtures/codex-oracle/rollout-2026-01-01T02-00-00-bbbbbbbb-0000-4000-8000-000000000003.jsonl"
);
const TIES: &str = include_str!(
    "fixtures/codex-oracle/rollout-2026-01-01T03-00-00-cccccccc-0000-4000-8000-000000000004.jsonl"
);

fn assert_equivalent(js: &Value, rust: &Value, path: &str) {
    match (js, rust) {
        (Value::Object(js), Value::Object(rust)) => {
            let mut js_keys: Vec<_> = js.keys().collect();
            let mut rust_keys: Vec<_> = rust.keys().collect();
            js_keys.sort();
            rust_keys.sort();
            assert_eq!(js_keys, rust_keys, "object keys differ at {path}");
            for key in js.keys() {
                assert_equivalent(&js[key], &rust[key], &format!("{path}.{key}"));
            }
        }
        (Value::Array(js), Value::Array(rust)) => {
            assert_eq!(js.len(), rust.len(), "array length differs at {path}");
            for (index, (left, right)) in js.iter().zip(rust).enumerate() {
                assert_equivalent(left, right, &format!("{path}[{index}]"));
            }
        }
        (Value::Number(js), Value::Number(rust)) => {
            let left = js.as_f64().unwrap();
            let right = rust.as_f64().unwrap();
            let (abs, rel) = (1e-12, 1e-10);
            assert!(
                (left - right).abs() <= abs + rel * left.abs().max(right.abs()),
                "numeric mismatch at {path}: JS={left:?}, Rust={right:?}"
            );
        }
        _ => assert_eq!(js, rust, "branch/type/value differs at {path}"),
    }
}

fn fixture_text(name: &str) -> &'static str {
    match name {
        ROOT_NAME => ROOT,
        SUB_NAME => SUB,
        MALFORMED_NAME => MALFORMED,
        TIES_NAME => TIES,
        other => panic!("unknown fixture: {other}"),
    }
}

/// `_thread_id_from_filename`: these fixture names all end with the thread id.
fn fallback_id(name: &str) -> &str {
    let base = name.strip_suffix(".jsonl").expect("fixture name suffix");
    &base[base.len() - 36..]
}

/// Days since 1970-01-01 (Howard Hinnant's civil calendar algorithm).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = (i64::from(month) + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The fixtures carry UTC `YYYY-MM-DDTHH:MM:SSZ` stamps only.
fn epoch_from_iso(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let shape_ok = bytes.len() == 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'Z';
    if !shape_ok {
        return None;
    }
    let year: i64 = text[0..4].parse().ok()?;
    let month: u32 = text[5..7].parse().ok()?;
    let day: u32 = text[8..10].parse().ok()?;
    let hour: i64 = text[11..13].parse().ok()?;
    let minute: i64 = text[14..16].parse().ok()?;
    let second: i64 = text[17..19].parse().ok()?;
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(seconds as f64)
}

/// Both sides inject the timestamp formatter; the fixtures are whole seconds.
fn local_fmt(epoch: f64) -> String {
    format!("epoch:{epoch:.3}")
}

fn cost(
    _model: &str,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_creation: f64,
) -> Option<f64> {
    Some(input * 0.5 + output * 2.0 + cache_read * 0.25 + cache_creation * 0.5)
}

/// `""` is the JS row's blank; Rust models the same blank as `None`.
fn blank_or(value: Option<f64>) -> Value {
    value.map_or_else(|| json!(""), |number| json!(number))
}

fn text_or_blank(value: Option<&str>) -> Value {
    value.map_or_else(|| json!(""), |text| json!(text))
}

fn run_oracle(fixture_names: &[&str]) -> Value {
    let node = std::path::PathBuf::from(
        std::env::var_os("NODE_BINARY")
            .expect("NODE_BINARY must be an absolute Node executable path"),
    );
    assert!(
        node.is_absolute(),
        "NODE_BINARY must be an absolute Node executable path"
    );
    let bridge = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/usage_report_codex_oracle.mjs");
    // No real HOME/CODEX_HOME: the bridge is injected a synthetic codexHome.
    let cwd = std::env::temp_dir().join(format!("singularity-codex-oracle-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("create synthetic cwd");
    let mut command = Command::new(node);
    command
        .arg(bridge)
        .arg(fixture_names.join(","))
        .current_dir(&cwd)
        .env_clear();
    if cfg!(windows) {
        for name in ["SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
    for name in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "TMPDIR",
    ] {
        command.env(name, &cwd);
    }
    let output = command.output().expect("run the Node oracle");
    assert!(
        output.status.success(),
        "Node oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("parse the Node oracle result")
}

fn compare(fixture_names: &[&str]) {
    let texts = fixture_names
        .iter()
        .map(|name| (fixture_text(name), fallback_id(name)))
        .collect::<Vec<_>>();
    let threads = texts
        .iter()
        .map(|(text, fallback)| CodexThreadText {
            text,
            fallback_id: fallback,
        })
        .collect::<Vec<_>>();
    let rows = codex_rows(&threads, epoch_from_iso, local_fmt, &cost);
    let rust = Value::Array(rows.iter().map(row_json).collect());
    let js = run_oracle(fixture_names);
    assert_equivalent(&js, &rust, "$");
}

fn row_json(row: &CodexRow) -> Value {
    json!({
        "timestamp": row.timestamp,
        "session_id": row.session_id,
        "total_cost_usd": row.total_cost_usd,
        "last_model": row.last_model,
        "input_tokens": row.input_tokens,
        "output_tokens": row.output_tokens,
        "cache_read_tokens": row.cache_read_tokens,
        "cache_creation_tokens": row.cache_creation_tokens,
        "model_id": row.model_id,
        "model_display_name": row.model_display_name,
        "duration_ms": blank_or(row.duration_ms),
        "api_duration_ms": row.api_duration_ms,
        "lines_added": row.lines_added,
        "lines_removed": row.lines_removed,
        "rl_5h_pct": blank_or(row.rl_5h_pct),
        "rl_7d_pct": blank_or(row.rl_7d_pct),
        "context_pct": row.context_pct,
        "context_window_size": blank_or(row.context_window_size),
        "turns": row.turns,
        "tool_calls": row.tool_calls,
        "start_epoch": blank_or(row.start_epoch),
        "facets_json": row.facets_json,
        "est_cost_usd": text_or_blank(row.est_cost_usd.as_deref()),
    })
}

#[test]
fn root_and_sub_threads_fold_into_the_same_rows() {
    compare(&[ROOT_NAME, SUB_NAME]);
}

#[test]
fn malformed_blank_lines_and_unknown_models_match() {
    compare(&[MALFORMED_NAME]);
}

#[test]
fn missing_rate_limits_and_equal_timestamps_match() {
    compare(&[TIES_NAME]);
}

#[test]
fn every_fixture_together_matches() {
    compare(&[ROOT_NAME, SUB_NAME, MALFORMED_NAME, TIES_NAME]);
}
