//! Differential oracle: `build_forecast_document` against the bundled
//! `_build_forecast` in stats.mjs, run source-bound under a fake clock.
//!
//! The Node bridge slices the checked-in forecast-assembly declarations from
//! stats.mjs and stubs only the state-dir reader, the clock and the writer.
//! Both sides receive the same synthetic records, sessions, `now` and `fitAt`;
//! OAuth refresh is out of scope by user decision, so neither side gets OAuth
//! data.

use serde_json::{Map, Value, json};
use singularity_backend::usage_report_forecast_build::{
    ForecastBuildInputs, ForecastSession, build_forecast_document,
};
use singularity_backend::usage_report_history::{ForecastPaths, UsageRecord, write_forecast};
use std::io::Write;
use std::process::{Command, Stdio};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const NOW_SEC: f64 = 1_000_000.0;
const FIT_AT: &str = "2024-05-01 12:34:56";

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
            let (abs, rel) = if path.contains(".prior") || path.contains(".calibration") {
                (1e-12, 1e-12)
            } else {
                // Design allows accumulated libm noise for seeded MC transforms.
                (1e-12, 1e-10)
            };
            assert!(
                (left - right).abs() <= abs + rel * left.abs().max(right.abs()),
                "numeric mismatch at {path}: JS={left:?}, Rust={right:?}"
            );
        }
        _ => assert_eq!(js, rust, "branch/type/value differs at {path}"),
    }
}

fn utc_stamp(epoch: i64) -> String {
    let rfc = OffsetDateTime::from_unix_timestamp(epoch)
        .unwrap()
        .format(&Rfc3339)
        .unwrap();
    format!("{} {}", &rfc[..10], &rfc[11..19])
}

fn reset_at(epoch: i64) -> String {
    OffsetDateTime::from_unix_timestamp(epoch)
        .unwrap()
        .format(&Rfc3339)
        .unwrap()
}

/// One synthetic usage-snapshot record, `fetched_at` derived from `epoch`.
fn record(epoch: i64, extra: Value) -> UsageRecord {
    let mut raw = extra.as_object().cloned().unwrap_or_else(Map::new);
    raw.insert("fetched_at".to_owned(), json!(utc_stamp(epoch)));
    UsageRecord {
        fetched_epoch: Some(epoch),
        raw: Value::Object(raw),
    }
}

fn gauge(utilization: f64, reset: i64) -> Value {
    json!({"utilization": utilization, "resets_at": reset_at(reset)})
}

/// The session view shared by both sides; Rust derives `ForecastSession`, Node
/// gets the same `ts`-bearing JS row `_load_stats` would hand `_build_forecast`.
struct SessionSpec {
    epoch: Option<i64>,
    model: &'static str,
    rl5: f64,
    rl7: f64,
    tok: f64,
}

fn session(spec: &SessionSpec) -> ForecastSession {
    ForecastSession {
        ts_epoch: spec.epoch.map(|epoch| epoch as f64),
        model: spec.model.to_owned(),
        rl5: spec.rl5,
        rl7: spec.rl7,
        day: spec
            .epoch
            .map(|epoch| utc_stamp(epoch)[..10].to_owned())
            .unwrap_or_default(),
        tok: spec.tok,
    }
}

fn session_json(spec: &SessionSpec) -> Value {
    json!({
        "ts": spec.epoch.map(utc_stamp),
        "model": spec.model,
        "rl5": spec.rl5,
        "rl7": spec.rl7,
        "tok": spec.tok,
    })
}

struct Case {
    name: &'static str,
    claude: Vec<UsageRecord>,
    ollama: Vec<UsageRecord>,
    codex: Vec<UsageRecord>,
    sessions: Option<Vec<SessionSpec>>,
}

fn cases() -> Vec<Case> {
    let now = NOW_SEC as i64;
    vec![
        // 1. No OAuth history: both gauges and the window balance fall back to
        // the statusline sessions supplied by the caller.
        Case {
            name: "statusline-only",
            claude: Vec::new(),
            ollama: Vec::new(),
            codex: Vec::new(),
            sessions: Some(vec![
                SessionSpec {
                    epoch: Some(now - 100),
                    model: "claude-opus-4",
                    rl5: 10.0,
                    rl7: 5.0,
                    tok: 0.0,
                },
                SessionSpec {
                    epoch: Some(now - 50),
                    model: "Claude-sonnet-4",
                    rl5: 25.0,
                    rl7: 40.0,
                    tok: 0.0,
                },
                // Dropped by the statusline balance, still a prior row for daily.
                SessionSpec {
                    epoch: Some(now - 60),
                    model: "gpt-5",
                    rl5: 10.0,
                    rl7: 10.0,
                    tok: 0.0,
                },
                // Zero five-hour gauge: five_hour skips it, seven_day keeps it.
                SessionSpec {
                    epoch: Some(now - 70),
                    model: "claude-haiku",
                    rl5: 0.0,
                    rl7: 10.0,
                    tok: 0.0,
                },
                // Unparseable ts: dropped from the window balance, kept by the prior.
                SessionSpec {
                    epoch: None,
                    model: "claude-haiku",
                    rl5: 10.0,
                    rl7: 10.0,
                    tok: 0.0,
                },
            ]),
        },
        // 2. Ollama and Codex windows: per-gauge fits, open-window projections,
        // token yield split by request share, and the strided trend series.
        Case {
            name: "codex-and-ollama-windows",
            claude: Vec::new(),
            ollama: {
                let weekly = |epoch: i64, utilization: f64, reset: i64, models: Value| {
                    record(
                        epoch,
                        json!({"weekly": gauge(utilization, reset), "models": models}),
                    )
                };
                vec![
                    weekly(
                        now - 644_800,
                        5.0,
                        now - 604_800,
                        json!([{"model": "llama3", "requests": 2}]),
                    ),
                    weekly(
                        now - 624_800,
                        40.0,
                        now - 604_800,
                        json!([{"model": "llama3", "requests": 4}]),
                    ),
                    weekly(
                        now - 33_600,
                        10.0,
                        now - 3_600,
                        json!([{"model": "llama3", "requests": 5}]),
                    ),
                    weekly(
                        now - 13_600,
                        60.0,
                        now - 3_600,
                        json!([{"model": "llama3", "requests": 7}, {"model": "mistral", "requests": 1}]),
                    ),
                    weekly(
                        now - 5_000,
                        70.0,
                        now + 86_400,
                        json!([{"model": "llama3", "requests": 9}]),
                    ),
                    weekly(
                        now - 1_000,
                        75.0,
                        now + 86_400,
                        json!([{"model": "llama3", "requests": 12}, {"model": "mistral", "requests": 2}]),
                    ),
                    record(now - 9_000, json!({"session": gauge(10.0, now - 7_200)})),
                    record(now - 8_000, json!({"session": gauge(50.0, now - 7_200)})),
                    record(now - 3_000, json!({"session": gauge(20.0, now - 1_800)})),
                    record(now - 2_500, json!({"session": gauge(60.0, now - 1_800)})),
                    record(now - 600, json!({"session": gauge(30.0, now + 3_600)})),
                    record(now - 300, json!({"session": gauge(45.0, now + 3_600)})),
                ]
            },
            codex: vec![
                record(now - 640_000, json!({"weekly": gauge(10.0, now - 604_800)})),
                record(now - 620_000, json!({"weekly": gauge(45.0, now - 604_800)})),
                record(now - 40_000, json!({"weekly": gauge(5.0, now - 7_200)})),
                record(now - 20_000, json!({"weekly": gauge(35.0, now - 7_200)})),
                record(now - 2_000, json!({"weekly": gauge(60.0, now + 172_800)})),
                record(now - 500, json!({"weekly": gauge(66.0, now + 172_800)})),
                record(now - 10_000, json!({"session": gauge(12.0, now - 7_200)})),
                record(now - 8_000, json!({"session": gauge(40.0, now - 7_200)})),
                record(now - 4_000, json!({"session": gauge(8.0, now - 1_800)})),
                record(now - 2_000, json!({"session": gauge(30.0, now - 1_800)})),
                record(now - 900, json!({"session": gauge(25.0, now + 7_200)})),
                record(now - 200, json!({"session": gauge(55.0, now + 7_200)})),
            ],
            sessions: Some(vec![
                SessionSpec {
                    epoch: Some(now - 1_000),
                    model: "llama3:cloud",
                    rl5: 0.0,
                    rl7: 0.0,
                    tok: 2_000_000.0,
                },
                SessionSpec {
                    epoch: Some(now - 2_000),
                    model: "mistral:cloud",
                    rl5: 0.0,
                    rl7: 0.0,
                    tok: 500_000.0,
                },
                SessionSpec {
                    epoch: Some(now - 3_000),
                    model: "other",
                    rl5: 0.0,
                    rl7: 0.0,
                    tok: 100.0,
                },
            ]),
        },
        // 3. No history at all and no session list: both providers drop out.
        Case {
            name: "empty-history",
            claude: Vec::new(),
            ollama: Vec::new(),
            codex: Vec::new(),
            sessions: None,
        },
        // 4. Window-balance boundaries: coverage and d7 gating, the pooled
        // fallback, gap capping, a nominal-length-0 window, and statusline bins
        // anchored on the last OAuth reset (negative ceil bin keys).
        Case {
            name: "window-balance-boundaries",
            claude: {
                let mut snaps = vec![
                    record(
                        now - 200_000,
                        json!({"seven_day": gauge(10.0, now + 86_400)}),
                    ),
                    record(
                        now - 150_000,
                        json!({"seven_day": gauge(35.0, now + 86_400)}),
                    ),
                    record(
                        now - 100_000,
                        json!({"seven_day": gauge(60.0, now + 86_400)}),
                    ),
                    record(
                        now - 160_000,
                        json!({"five_hour": gauge(20.0, now + 3_600)}),
                    ),
                    record(
                        now - 155_000,
                        json!({"five_hour": gauge(33.0, now + 3_600)}),
                    ),
                    // d7 below the gate and a nominal length of zero.
                    record(
                        now - 10_000,
                        json!({"seven_day": gauge(10.0, now + 604_800)}),
                    ),
                    record(
                        now - 9_000,
                        json!({"seven_day": gauge(12.0, now + 604_800)}),
                    ),
                    // d7 exactly at the gate, coverage far below it.
                    record(now - 100_000, json!({"seven_day": gauge(5.0, now - 3_600)})),
                    record(now - 50_000, json!({"seven_day": gauge(25.0, now - 3_600)})),
                ];
                // A gated window: 19 capped gaps over a 504,800 s nominal span.
                for index in 0..20 {
                    snaps.push(record(
                        now - 342_000 + index * 18_000,
                        json!({"seven_day": gauge(index as f64 * 3.0, now + 100_000)}),
                    ));
                }
                snaps
            },
            ollama: Vec::new(),
            codex: Vec::new(),
            sessions: Some(vec![
                SessionSpec {
                    epoch: Some(now - 100),
                    model: "claude-opus-4",
                    rl5: 10.0,
                    rl7: 5.0,
                    tok: 0.0,
                },
                SessionSpec {
                    epoch: Some(now - 50),
                    model: "claude-sonnet-4",
                    rl5: 25.0,
                    rl7: 40.0,
                    tok: 0.0,
                },
                SessionSpec {
                    epoch: Some(now - 80),
                    model: "claude-haiku",
                    rl5: 5.0,
                    rl7: 0.0,
                    tok: 0.0,
                },
            ]),
        },
        // 5. Series striding past the 400-point cap keeps the newest reading;
        // records with no gauge are strided but dropped from the series.
        Case {
            name: "series-striding",
            claude: Vec::new(),
            ollama: (0..402)
                .map(|index| {
                    if index == 5 || index == 6 {
                        record(now - 500_000 + index * 60, json!({}))
                    } else {
                        record(
                            now - 500_000 + index * 60,
                            json!({"session": gauge((index % 100) as f64, now + 7_200)}),
                        )
                    }
                })
                .collect(),
            codex: Vec::new(),
            sessions: None,
        },
        // 6. Ollama model ids with duplicates, Unicode, quotes, backslashes and
        // control characters: they become JSON keys and a duplicate id adds
        // its delta to the share total once per entry (stats.mjs:1483-1491).
        Case {
            name: "ollama-unicode-escaped-duplicate-models",
            claude: Vec::new(),
            ollama: {
                let weekly = |epoch: i64, utilization: f64, models: Value| {
                    record(
                        epoch,
                        json!({"weekly": gauge(utilization, now + 86_400), "models": models}),
                    )
                };
                vec![
                    weekly(
                        now - 7_200,
                        10.0,
                        json!([
                            {"model": "qwen–ü✓", "requests": 4},
                            {"model": "q\"w\\e\n\u{1}\u{7f}\u{2028}</x>&", "requests": 4},
                            {"model": "", "requests": 3},
                        ]),
                    ),
                    weekly(
                        now - 3_600,
                        30.0,
                        json!([
                            {"model": "qwen–ü✓", "requests": 5},
                            {"model": "qwen–ü✓", "requests": 5},
                            {"model": "q\"w\\e\n\u{1}\u{7f}\u{2028}</x>&", "requests": 6},
                            {"model": "", "requests": 3},
                        ]),
                    ),
                ]
            },
            codex: Vec::new(),
            sessions: Some(vec![
                SessionSpec {
                    epoch: Some(now - 3_000),
                    model: "qwen–ü✓:cloud",
                    rl5: 0.0,
                    rl7: 0.0,
                    tok: 2_000_000.0,
                },
                SessionSpec {
                    epoch: Some(now - 2_900),
                    model: "q\"w\\e\n\u{1}\u{7f}\u{2028}</x>&",
                    rl5: 0.0,
                    rl7: 0.0,
                    tok: 3_000_000.0,
                },
            ]),
        },
    ]
}

/// `_load_usage_snapshots` hands the builder records sorted by fetched epoch
/// (missing epoch last); replicate that caller contract for the Rust side.
fn loaded(records: &[UsageRecord]) -> Vec<UsageRecord> {
    let mut out: Vec<UsageRecord> = records
        .iter()
        .map(|record| UsageRecord {
            fetched_epoch: record.fetched_epoch,
            raw: record.raw.clone(),
        })
        .collect();
    out.sort_by_key(|record| record.fetched_epoch.unwrap_or(i64::MAX));
    out
}

fn case_fixture(case: &Case) -> Value {
    let raws = |records: &[UsageRecord]| {
        records
            .iter()
            .map(|record| record.raw.clone())
            .collect::<Vec<_>>()
    };
    json!({
        "name": case.name,
        "claudeSnaps": raws(&case.claude),
        "ollamaSnaps": raws(&case.ollama),
        "codexSnaps": raws(&case.codex),
        "sessions": case.sessions.as_ref().map(|sessions| {
            sessions.iter().map(session_json).collect::<Vec<_>>()
        }),
    })
}

#[test]
fn compares_forecast_document_against_the_bundled_js_source() {
    let cases = cases();
    assert_eq!(cases.len(), 6, "every oracle case must be compared");
    let fixture = json!({
        "nowSec": NOW_SEC,
        "fitAt": FIT_AT,
        "cases": cases.iter().map(case_fixture).collect::<Vec<_>>(),
    });

    let node = std::path::PathBuf::from(
        std::env::var_os("NODE_BINARY")
            .expect("NODE_BINARY must be an absolute Node executable path"),
    );
    assert!(
        node.is_absolute(),
        "NODE_BINARY must be an absolute Node executable path"
    );
    let bridge = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/usage_report_forecast_build_oracle.mjs");
    let cwd = std::env::temp_dir().join(format!(
        "singularity-forecast-build-oracle-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&cwd).expect("create synthetic cwd");
    let synthetic = [
        ("HOME", "home"),
        ("USERPROFILE", "profile"),
        ("APPDATA", "appdata"),
        ("LOCALAPPDATA", "localappdata"),
        ("TEMP", "temp"),
        ("TMP", "tmp"),
        ("TMPDIR", "tmpdir"),
    ]
    .map(|(name, directory)| {
        let path = cwd.join(directory);
        std::fs::create_dir_all(&path).expect("create synthetic Node home");
        (name, path)
    });
    let mut command = Command::new(node);
    command
        .arg(bridge)
        .current_dir(&cwd)
        .env_clear()
        .env("FORECAST_BUILD_ORACLE_BRIDGE", "1")
        // Session `ts` strings are parsed as local time; pin it so both sides
        // agree on the epoch the Rust fixture supplies.
        .env("TZ", "UTC");
    if cfg!(windows) {
        for name in ["SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
    for (name, path) in synthetic {
        command.env(name, path);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("launch absolute Node binary");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(fixture.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().expect("wait for Node oracle");
    assert!(
        output.status.success(),
        "Node oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let js: Value = serde_json::from_slice(&output.stdout).expect("parse Node oracle result");
    let js = js
        .as_array()
        .expect("Node oracle returns one document per case");
    assert_eq!(js.len(), cases.len(), "Node oracle case count");

    let paths = ForecastPaths::new(cwd.join("state"), cwd.join("projects"));
    std::fs::create_dir_all(paths.state_dir.clone()).expect("create forecast state dir");
    let mut documents = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let sessions: Option<Vec<ForecastSession>> = case
            .sessions
            .as_ref()
            .map(|sessions| sessions.iter().map(session).collect());
        let document = build_forecast_document(&ForecastBuildInputs {
            claude_snaps: &loaded(&case.claude),
            ollama_snaps: &loaded(&case.ollama),
            codex_snaps: &loaded(&case.codex),
            sessions: sessions.as_deref(),
            now_sec: NOW_SEC,
            fit_at: FIT_AT.to_owned(),
            now_local_offset: 0,
        });
        let value = write_forecast(&paths, &document).expect("serialize forecast document");
        documents.push(value);
        assert_equivalent(&js[index], &documents[index], &format!("$.cases[{index}]"));
    }

    // Striding proof independent of Node: 402 records stride to 202 points and
    // the empty row at index 6 is dropped, leaving 201.
    let series = documents[4]["ollama"]["series"]
        .as_array()
        .expect("series array");
    assert_eq!(series.len(), 201, "strided series keeps the newest point");
    assert_eq!(series.last().unwrap()["session"].as_f64(), Some(1.0));

    // Case 6 must really reach the yield split, not compare two empty maps.
    let tokens = &documents[5]["ollama"]["tokenYield"]["series"];
    assert!(
        tokens.get("qwen–ü✓").is_some(),
        "duplicate Unicode model id reached the token-yield series: {tokens}"
    );
}
