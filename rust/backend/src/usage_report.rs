//! Native usage-report request wiring: resolve roots from the request
//! environment, then render through `usage_report_pipeline`.
//!
//! Replaces the Node skill subprocess. `SING_USAGE_SKILL` and `skill_path` are
//! ignored, so the report is always available. All three operations share one
//! resolved reports root: `Request.reports_dir`, then `SING_USAGE_REPORTS`, then
//! `<dirname(state)>/reports`. Tests inject the clock and zone; production uses
//! the host zone, resolving each row's own offset (DST-aware).

use crate::claude_usage::ClaudeUsageResult;
use crate::usage_report_codex_ingest::codex_ingest;
use crate::usage_report_cost::Pricing;
use crate::usage_report_pipeline::{PipelineEnv, generate_native};
use crate::usage_report_rebuild::{RebuildRoots, rebuild_stats_csv};
use crate::usage_snapshot::{LocalZone, SnapshotService};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub reports_dir: String,
    #[serde(default)]
    pub env: Value,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Status {
    pub exists: bool,
    pub at: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Report {
    pub html: Option<String>,
}

fn latest_file(reports_dir: &Path) -> Option<PathBuf> {
    let mut names = fs::read_dir(reports_dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            (name.starts_with("report-") && name.ends_with(".html")).then_some(name)
        })
        .collect::<Vec<_>>();
    names.sort_by(|a, b| b.encode_utf16().cmp(a.encode_utf16()));
    names.into_iter().next().map(|name| reports_dir.join(name))
}

fn mtime_ms(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -error.duration().as_secs_f64() * 1000.0,
    })
}

/// `process.env` truthiness: only an empty string is absent.
fn env_value(env: &Value, key: &str) -> Option<String> {
    env.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Explicit request HOME/USERPROFILE first, then the real process environment.
fn home_dir(env: &Value) -> Option<PathBuf> {
    env_value(env, "HOME")
        .or_else(|| env_value(env, "USERPROFILE"))
        .or_else(|| nonempty(std::env::var("HOME").ok()))
        .or_else(|| nonempty(std::env::var("USERPROFILE").ok()))
        .map(PathBuf::from)
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

/// `SKILL_STATE_DIR`: `USAGE_REPORT_STATE` else `<home>/.agents/.harness-usage-report/state`.
fn base_state_dir(env: &Value) -> Option<PathBuf> {
    env_value(env, "USAGE_REPORT_STATE").map_or_else(
        || home_dir(env).map(|home| home.join(".agents/.harness-usage-report/state")),
        |value| Some(PathBuf::from(value)),
    )
}

fn resolved_reports_dir(request: &Request) -> Option<PathBuf> {
    if !request.reports_dir.is_empty() {
        return Some(PathBuf::from(&request.reports_dir));
    }
    if let Some(value) = env_value(&request.env, "SING_USAGE_REPORTS") {
        return Some(PathBuf::from(value));
    }
    base_state_dir(&request.env)?
        .parent()
        .map(|parent| parent.join("reports"))
}

pub fn status(request: &Request) -> Status {
    let found = resolved_reports_dir(request)
        .and_then(|dir| latest_file(&dir))
        .and_then(|path| mtime_ms(&path));
    match found {
        Some(at) => Status {
            exists: true,
            at: Some(at),
        },
        None => Status {
            exists: false,
            at: None,
        },
    }
}

pub fn read(request: &Request) -> Report {
    let html = resolved_reports_dir(request)
        .and_then(|dir| latest_file(&dir))
        .and_then(|path| fs::read(path).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
    Report { html }
}

pub fn generate(request: &Request) -> Value {
    generate_with_sampler(request, now_secs(), LocalZone::Host, sample_claude_usage)
}

#[cfg(test)]
fn generate_with(request: &Request, now_secs: f64, local_zone: LocalZone) -> Value {
    generate_with_sampler(request, now_secs, local_zone, |_, _, _| {})
}

fn generate_with_sampler(
    request: &Request,
    now_secs: f64,
    local_zone: LocalZone,
    sampler: impl FnOnce(&str, &Path, f64),
) -> Value {
    match run_generation(request, now_secs, local_zone, sampler) {
        Ok(path) => json!({"ok": true, "at": mtime_ms(&path)}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

fn run_generation(
    request: &Request,
    now_secs: f64,
    local_zone: LocalZone,
    sampler: impl FnOnce(&str, &Path, f64),
) -> Result<PathBuf, String> {
    let base = base_state_dir(&request.env)
        .ok_or_else(|| "cannot resolve HOME to locate the usage report state".to_owned())?;
    let reports_dir = resolved_reports_dir(request)
        .ok_or_else(|| "cannot derive the reports directory".to_owned())?;
    let claude_root = env_value(&request.env, "CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir(&request.env).map(|home| home.join(".claude")))
        .ok_or_else(|| "cannot resolve HOME to locate the Claude config directory".to_owned())?;
    let codex_home = env_value(&request.env, "CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir(&request.env).map(|home| home.join(".codex")))
        .ok_or_else(|| "cannot resolve HOME to locate the Codex home".to_owned())?;
    let claude_projects_root = claude_root.join("projects");
    let env = PipelineEnv {
        base_state_dir: base.clone(),
        reports_dir,
        claude_projects_root,
        claude_inventory_root: claude_root.clone(),
        codex_home: codex_home.clone(),
        now_secs,
        local_zone,
    };
    if !crate::shadow::enabled() {
        if let Some(token) = saved_claude_token(&claude_root) {
            sampler(&token, &base, now_secs);
        }
    }
    let mut rebuild = |active_sid: Option<&str>| {
        rebuild_state(
            &base,
            &env.claude_projects_root,
            &codex_home,
            active_sid,
            now_secs,
            local_zone,
        )
    };
    generate_native(&env, &mut rebuild)
}

/// Report sampling mirrors stats.mjs: use only the saved OAuth access token and
/// let any credential, transport, response, or append failure fall through.
fn saved_claude_token(claude_root: &Path) -> Option<String> {
    let credentials = crate::claude_credentials::read(&claude_root.join(".credentials.json"));
    let crate::claude_credentials::ClaudeCredentialsRead::File(text) = credentials else {
        return None;
    };
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("claudeAiOauth")
        .and_then(|oauth| oauth.get("accessToken"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
}

fn sample_claude_usage(token: &str, state_dir: &Path, now_secs: f64) {
    if crate::shadow::enabled() {
        return;
    }
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let result = runtime.block_on(crate::claude_usage::fetch_claude_usage(token, 10_000));
    let ClaudeUsageResult::Response {
        status: 200,
        body: Ok(Some(body)),
        ..
    } = result
    else {
        return;
    };
    let Ok(raw) = RawValue::from_string(body) else {
        return;
    };
    if !serde_json::from_str::<Value>(raw.get()).is_ok_and(|value| value.is_object()) {
        return;
    }
    let live = state_dir.join("usage-snapshots.jsonl");
    let mut snapshots = SnapshotService::default();
    let now_ms = (now_secs * 1000.0) as i64;
    let result = snapshots.append_claude(&live, state_dir, false, &raw, now_ms, None, None);
    if let Some(error) = result.error {
        eprintln!("usage-report: Claude snapshot append failed: {error}");
    }
}

/// stats.mjs:858-870: a Codex failure is logged and the pre-existing Codex rows
/// carry forward, so ingest errors never block the CSV rewrite.
fn rebuild_state(
    base: &Path,
    projects_dir: &Path,
    codex_home: &Path,
    active_sid: Option<&str>,
    now_secs: f64,
    local_zone: LocalZone,
) -> std::io::Result<()> {
    fs::create_dir_all(base.join("cost-state"))?;
    let pricing = Pricing::load(base);
    let codex_rows = codex_ingest(
        codex_home,
        base,
        now_secs,
        local_zone,
        &|model, input, output, cache_read, cache_create| {
            pricing.msg_cost_tiered(model, input, output, cache_read, cache_create)
        },
        &|model| pricing.should_warn_unknown_model(model),
    )
    .unwrap_or_else(|error| {
        eprintln!("usage-report: Codex ingest failed: {error}");
        Vec::new()
    });
    let cost_state_dir = base.join("cost-state");
    let csv_path = base.join("stats.csv");
    rebuild_stats_csv(
        &RebuildRoots {
            projects_dir,
            cost_state_dir: &cost_state_dir,
            state_dir: base,
            csv_path: &csv_path,
        },
        active_sid,
        &codex_rows,
        &pricing,
        local_zone,
        now_secs,
    )?;
    Ok(())
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_report_csv::CSV_COLUMNS;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "usage-report-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        create_dir_all(&path).unwrap();
        path
    }

    fn request(reports_dir: &Path) -> Request {
        Request {
            reports_dir: reports_dir.to_string_lossy().into_owned(),
            env: json!({}),
        }
    }

    fn csv_text() -> String {
        format!(
            "{}\n2026-10-27 10:00:00,sid-a,1.5,claude-sonnet-5-5,10,20,0,0,\
             claude-sonnet-5-5,Sonnet,1000,500,5,2,42,17,10,200000,3,2,0,,1.5\n",
            CSV_COLUMNS.join(",")
        )
    }

    /// Request env pointing every root at `root`, with a fresh state CSV so the
    /// rebuild step is skipped and the render path is exercised.
    fn root_env(root: &Path) -> Value {
        let state = root.join("state");
        create_dir_all(&state).unwrap();
        create_dir_all(root.join("claude/projects")).unwrap();
        create_dir_all(root.join("codex")).unwrap();
        write(state.join("stats.csv"), csv_text()).unwrap();
        json!({
            "HOME": root.to_string_lossy(),
            "USAGE_REPORT_STATE": state.to_string_lossy(),
            "CLAUDE_CONFIG_DIR": root.join("claude").to_string_lossy(),
            "CODEX_HOME": root.join("codex").to_string_lossy(),
        })
    }

    #[test]
    fn missing_reports_dir_deserializes_empty() {
        let request: Request = serde_json::from_value(json!({"env": {}})).unwrap();
        assert_eq!(request.reports_dir, "");
        assert_eq!(request.env, json!({}));
    }

    #[test]
    fn status_and_read_select_descending_utf16_and_read_utf8_with_replacement() {
        let dir = temp_dir();
        write(dir.join("report-a.html"), "older").unwrap();
        write(dir.join("report-z.html"), [b'<', 0xff, b'>']).unwrap();
        write(dir.join("other.html"), "ignored").unwrap();
        let request = request(&dir);
        assert_eq!(read(&request).html.as_deref(), Some("<�>"));
        assert!(status(&request).exists);
        remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_directory_is_reported_as_absent() {
        let missing = request(&temp_dir().join("missing"));
        assert_eq!(
            status(&missing),
            Status {
                exists: false,
                at: None
            }
        );
        assert_eq!(read(&missing).html, None);
    }

    #[test]
    fn request_reports_dir_wins_over_env_and_env_is_used_when_empty() {
        let request_dir = temp_dir();
        let env_dir = temp_dir();
        write(request_dir.join("report-request.html"), "request").unwrap();
        write(env_dir.join("report-env.html"), "env").unwrap();
        let mut both = request(&request_dir);
        both.env = json!({"SING_USAGE_REPORTS": env_dir.to_string_lossy()});
        assert_eq!(read(&both).html.as_deref(), Some("request"));
        both.reports_dir = String::new();
        assert_eq!(read(&both).html.as_deref(), Some("env"));
        remove_dir_all(&request_dir).ok();
        remove_dir_all(&env_dir).ok();
    }

    #[test]
    fn native_generation_writes_html_that_status_and_read_see() {
        let root = temp_dir();
        let mut request = Request {
            reports_dir: String::new(),
            env: root_env(&root),
        };
        // An unavailable custom skill is ignored: generation never spawns it.
        request.env["SING_USAGE_SKILL"] = json!(root.join("missing.mjs").to_string_lossy());
        let result = generate_with(&request, 1_700_000_000.0, LocalZone::Fixed(0));
        assert_eq!(result["ok"], true, "{result}");
        assert!(result["at"].as_f64().is_some());
        let report = root.join("reports").join(
            fs::read_dir(root.join("reports"))
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.file_name())
                .find(|name| name.to_string_lossy().ends_with(".html"))
                .unwrap(),
        );
        let html = fs::read_to_string(&report).unwrap();
        assert!(html.to_lowercase().contains("<html"));
        assert!(html.contains("var SESSIONS="));
        assert_eq!(status(&request).exists, true);
        assert!(read(&request).html.unwrap().contains("var SESSIONS="));
        remove_dir_all(&root).ok();
    }

    #[test]
    fn configured_credentials_sample_before_generation_and_append_snapshot() {
        let root = temp_dir();
        let mut request = Request {
            reports_dir: String::new(),
            env: root_env(&root),
        };
        let claude_root = root.join("claude");
        write(
            claude_root.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"synthetic-token"}}"#,
        )
        .unwrap();
        request.env["CLAUDE_CONFIG_DIR"] = json!(claude_root.to_string_lossy());
        let sampled = std::cell::Cell::new(false);
        let result = generate_with_sampler(
            &request,
            1_700_000_000.0,
            LocalZone::Fixed(0),
            |token, state, now| {
                assert_eq!(token, "synthetic-token");
                let samples = [
                    (1_698_990_000.0, 1_699_000_000.0, 10.0),
                    (1_698_995_000.0, 1_699_000_000.0, 20.0),
                    (1_699_490_000.0, 1_699_500_000.0, 15.0),
                    (1_699_495_000.0, 1_699_500_000.0, 30.0),
                    (1_699_990_000.0, 1_700_100_000.0, 35.0),
                    (now, 1_700_100_000.0, 42.0),
                ];
                let mut snapshots = SnapshotService::default();
                for (fetched_at, reset_at, utilization) in samples {
                    let raw = RawValue::from_string(format!(
                        r#"{{"five_hour":{{"utilization":{utilization},"resets_at":{reset_at}}}}}"#
                    ))
                    .unwrap();
                    let appended = snapshots.append_claude(
                        &state.join("usage-snapshots.jsonl"),
                        state,
                        false,
                        &raw,
                        (fetched_at * 1000.0) as i64,
                        None,
                        None,
                    );
                    assert!(appended.appended);
                }
                sampled.set(true);
            },
        );
        assert_eq!(result["ok"], true, "{result}");
        assert!(sampled.get());
        assert!(root.join("state/usage-snapshots.jsonl").exists());
        assert!(status(&request).exists);
        let forecast: Value =
            serde_json::from_slice(&fs::read(root.join("state/forecast.json")).unwrap()).unwrap();
        assert_eq!(forecast["gauges"]["five_hour"]["source"], "oauth");
        assert_eq!(forecast["gauges"]["five_hour"]["result"]["uNow"], 42.0);
        remove_dir_all(&root).ok();
    }

    #[test]
    fn sampling_failure_and_missing_credentials_still_generate() {
        let root = temp_dir();
        let request = Request {
            reports_dir: String::new(),
            env: root_env(&root),
        };
        let state = root.join("state");
        let prior = b"{\"fetched_at\":\"2026-11-17T00:00:00Z\",\"raw\":{}}\n";
        write(state.join("usage-snapshots.jsonl"), prior).unwrap();
        let calls = std::cell::Cell::new(0);
        let failed_sample =
            generate_with_sampler(&request, 1_700_000_000.0, LocalZone::Fixed(0), |_, _, _| {
                calls.set(calls.get() + 1)
            });
        assert_eq!(failed_sample["ok"], true, "{failed_sample}");
        assert_eq!(calls.get(), 0, "missing credentials must skip sampling");
        assert_eq!(
            fs::read(state.join("usage-snapshots.jsonl")).unwrap(),
            prior
        );
        assert!(status(&request).exists);

        let claude_root = root.join("claude");
        write(
            claude_root.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"synthetic-token"}}"#,
        )
        .unwrap();
        let failed_sample =
            generate_with_sampler(&request, 1_700_000_001.0, LocalZone::Fixed(0), |_, _, _| {});
        assert_eq!(failed_sample["ok"], true, "{failed_sample}");
        assert_eq!(
            fs::read(state.join("usage-snapshots.jsonl")).unwrap(),
            prior
        );
        assert!(status(&request).exists);
        remove_dir_all(&root).ok();
    }

    #[test]
    fn state_derived_reports_dir_applies_when_request_and_env_are_empty() {
        let root = temp_dir();
        let request = Request {
            reports_dir: String::new(),
            env: root_env(&root),
        };
        let result = generate_with(&request, 1_700_000_000.0, LocalZone::Fixed(0));
        assert_eq!(result["ok"], true, "{result}");
        assert!(root.join("reports").is_dir());
        assert_eq!(status(&request).exists, true);
        remove_dir_all(&root).ok();
    }

    #[test]
    fn generation_reports_a_concrete_reports_directory_failure() {
        let root = temp_dir();
        let blocker = root.join("reports-file");
        write(&blocker, "not a directory").unwrap();
        let mut request = Request {
            reports_dir: blocker.to_string_lossy().into_owned(),
            env: root_env(&root),
        };
        request.env["CODEX_HOME"] = json!(root.join("codex").to_string_lossy());
        let result = generate_with(&request, 1_700_000_000.0, LocalZone::Fixed(0));
        assert_eq!(result["ok"], false);
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .contains("reports directory"),
            "{result}"
        );
        remove_dir_all(&root).ok();
    }

    #[test]
    fn rebuild_from_disk_writes_csv_and_survives_missing_codex_home() {
        let root = temp_dir();
        let projects = root.join("projects");
        create_dir_all(&projects).unwrap();
        let missing_codex = root.join("absent-codex");
        let state = root.join("state");
        rebuild_state(
            &state,
            &projects,
            &missing_codex,
            None,
            1_700_000_000.0,
            LocalZone::Fixed(0),
        )
        .unwrap();
        let csv = fs::read_to_string(state.join("stats.csv")).unwrap();
        assert_eq!(csv.lines().next(), Some(CSV_COLUMNS.join(",").as_str()));
        remove_dir_all(&root).ok();
    }
}
