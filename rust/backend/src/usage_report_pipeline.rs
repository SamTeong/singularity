//! Native usage-report pipeline: freshness, CSV load, forecast, roadmap, render.
//!
//! Mirrors `cmd_report`/`_ensure_fresh` (stats.mjs:1033-1119), the forecast
//! lazy-rebuild (stats.mjs:1693-1697), and the roadmap acquisition that
//! render.mjs performs by spawning improve.mjs (render.mjs:99-160). Every root,
//! the clock, and the local zone are injected; this module never reads the
//! environment, a real home directory, credentials, or the network.

use crate::usage_report_cost::Pricing;
use crate::usage_report_csv::{CsvTable, dict_reader};
use crate::usage_report_forecast_build::{
    ForecastBuildInputs, ForecastSession, build_forecast_document,
};
use crate::usage_report_freshness::decide_freshness;
use crate::usage_report_history::{
    ForecastPaths, load_forecast, load_usage_snapshots, write_forecast,
};
use crate::usage_report_prepare::{self as prepare, PrepareRoots};
use crate::usage_report_render::{ReportPayload, render_html};
use crate::usage_report_roadmap::build_roadmap;
use crate::usage_report_roadmap_inputs::{InventoryInput, build_inventory, build_stats_projection};
use crate::usage_report_sessions::{load_session_views, load_sessions};
use crate::usage_snapshot::LocalZone;
use serde_json::value::{RawValue, to_raw_value};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use time::OffsetDateTime;

/// Immediate-entry cap for the inventory directory counts; no recursion.
const MAX_ENTRIES: usize = 10_000;

/// Explicit paths and clock for one report run. `base_state_dir` is
/// `SKILL_STATE_DIR` (stats.csv, pricing.json, sessions.jsonl, forecast.json,
/// provider JSONL); cost-state snapshots live in `<base>/cost-state`.
pub struct PipelineEnv {
    pub base_state_dir: PathBuf,
    pub reports_dir: PathBuf,
    /// `~/.claude/projects`: transcripts at `<root>/<project>/<sid>.jsonl`.
    pub claude_projects_root: PathBuf,
    /// `~/.claude`: `history.jsonl`, `tasks/`, `file-history/`.
    pub claude_inventory_root: PathBuf,
    pub codex_home: PathBuf,
    pub now_secs: f64,
    /// Local zone shared by the CSV writer, row parsers and formatters.
    pub local_zone: LocalZone,
}

/// stats.mjs:1085-1119 + render.mjs:415-421. `rebuild` writes stats.csv (and
/// owns Codex ingestion); it is invoked only when the freshness decision says so.
pub fn generate_native(
    env: &PipelineEnv,
    rebuild: &mut dyn FnMut(Option<&str>) -> io::Result<()>,
) -> Result<PathBuf, String> {
    let csv_path = env.base_state_dir.join("stats.csv");
    let cost_state_dir = env.base_state_dir.join("cost-state");
    let roots = PrepareRoots {
        projects_dir: &env.claude_projects_root,
        state_dir: &cost_state_dir,
        csv_path: &csv_path,
        codex_home: &env.codex_home,
    };
    let snapshot = prepare::snapshot(&roots, env.now_secs);
    let decision = decide_freshness(&snapshot.freshness_input());
    if decision.needs_rebuild {
        rebuild(decision.active_sid.as_deref())
            .map_err(|error| format!("rebuilding {} failed: {error}", csv_path.display()))?;
    }

    let csv_text = fs::read_to_string(&csv_path).map_err(|error| {
        format!(
            "stats.csv not readable at {} ({error}); run the rebuild step first",
            csv_path.display()
        )
    })?;
    let table = dict_reader(&csv_text);
    let pricing = Pricing::load(&env.base_state_dir);
    let sessions = load_sessions(&csv_text, &pricing, env.local_zone);
    let forecast_sessions: Vec<ForecastSession> = load_session_views(&csv_text, env.local_zone)
        .into_iter()
        .map(|view| ForecastSession {
            ts_epoch: view.ts,
            model: view.model,
            rl5: view.rl5,
            rl7: view.rl7,
            day: local_day(view.ts, env.local_zone),
            tok: view.tok,
        })
        .collect();

    let stamp = local_stamp(env.now_secs, env.local_zone)?;
    let forecast = load_forecast(
        &ForecastPaths::new(&env.base_state_dir, &env.claude_projects_root),
        env.now_secs,
        || {
            let paths = ForecastPaths::new(&env.base_state_dir, &env.claude_projects_root);
            let claude_snaps =
                load_usage_snapshots(&paths.snapshots_jsonl(), true, env.local_zone)?;
            let ollama_snaps =
                load_usage_snapshots(&paths.ollama_usage_jsonl(), false, env.local_zone)?;
            let codex_snaps =
                load_usage_snapshots(&paths.codex_usage_jsonl(), false, env.local_zone)?;
            let document = build_forecast_document(&ForecastBuildInputs {
                claude_snaps: &claude_snaps,
                ollama_snaps: &ollama_snaps,
                codex_snaps: &codex_snaps,
                sessions: Some(&forecast_sessions),
                now_sec: env.now_secs.floor(),
                fit_at: stamp.clone(),
                // Caller-parity field: Node's forecast stores the offset at `now`.
                now_local_offset: env.local_zone.offset_at(env.now_secs),
            });
            write_forecast(&paths, &document)?;
            Ok(())
        },
    )
    .map_err(|error| format!("loading forecast.json failed: {error}"))?;
    let forecast_raw = match &forecast {
        Some(value) => Some(
            to_raw_value(value)
                .map_err(|error| format!("serializing forecast.json failed: {error}"))?,
        ),
        None => None,
    };

    let roadmap = roadmap_payload(env, &table)?;
    let html = render_html(&ReportPayload {
        sessions: &sessions,
        forecast: forecast_raw.as_deref(),
        roadmap: roadmap.as_deref(),
        generated_local: &stamp,
    })
    .map_err(|error| format!("rendering the report failed: {error}"))?;

    fs::create_dir_all(&env.reports_dir).map_err(|error| {
        format!(
            "cannot create reports directory {}: {error}",
            env.reports_dir.display()
        )
    })?;
    let path = env.reports_dir.join(format!(
        "report-{}.html",
        local_file_stamp(env.now_secs, env.local_zone)?
    ));
    write_report(&path, &html)?;
    Ok(path)
}

/// improve.mjs:64-81: absent inventory files contribute empty counts.
fn roadmap_payload(env: &PipelineEnv, table: &CsvTable) -> Result<Option<Box<RawValue>>, String> {
    let sessions_jsonl = env.base_state_dir.join("sessions.jsonl");
    let sessions_text = fs::read_to_string(&sessions_jsonl).ok();
    let inventory = build_inventory(&InventoryInput {
        sessions_jsonl: sessions_text.as_deref(),
        history: env.claude_inventory_root.join("history.jsonl").is_file(),
        tasks: count_entries(&env.claude_inventory_root.join("tasks"))?,
        file_history: count_entries(&env.claude_inventory_root.join("file-history"))?,
    });
    let suggestions = build_roadmap(&inventory, &build_stats_projection(table));
    let entries: Vec<Value> = suggestions
        .iter()
        .map(|s| json!({ "area": s.area, "status": s.status, "text": s.text }))
        .collect();
    let text = serde_json::to_string(&entries)
        .map_err(|error| format!("serializing the roadmap failed: {error}"))?;
    RawValue::from_string(text)
        .map(Some)
        .map_err(|error| format!("serializing the roadmap failed: {error}"))
}

/// improve.mjs `countDir`: immediate entries only; a missing directory counts 0.
fn count_entries(dir: &Path) -> Result<usize, String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(0);
    };
    let mut count = 0usize;
    for entry in entries {
        entry.map_err(|error| format!("cannot list {}: {error}", dir.display()))?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(format!(
                "directory entry cap {MAX_ENTRIES} exceeded at {}",
                dir.display()
            ));
        }
    }
    Ok(count)
}

fn local_time(secs: f64, local_zone: LocalZone) -> Result<OffsetDateTime, String> {
    OffsetDateTime::from_unix_timestamp(secs.floor() as i64 + i64::from(local_zone.offset_at(secs)))
        .map_err(|error| format!("local time for {secs} is out of range: {error}"))
}

/// `now_local()` (stats.mjs:280-299): `YYYY-MM-DD HH:MM:SS` in local time.
fn local_stamp(secs: f64, local_zone: LocalZone) -> Result<String, String> {
    let t = local_time(secs, local_zone)?;
    Ok(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.year(),
        t.month() as u8,
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    ))
}

/// `reportStamp` (stats.mjs:1108-1114): local `YYYY-MM-DD_HHMMSS`.
fn local_file_stamp(secs: f64, local_zone: LocalZone) -> Result<String, String> {
    Ok(local_stamp(secs, local_zone)?
        .replacen(' ', "_", 1)
        .replace(':', ""))
}

/// `ts.slice(0, 10)` is the local date of the CSV timestamp.
fn local_day(ts: Option<f64>, local_zone: LocalZone) -> String {
    ts.and_then(|secs| {
        OffsetDateTime::from_unix_timestamp(
            secs.floor() as i64 + i64::from(local_zone.offset_at(secs)),
        )
        .ok()
    })
    .map(|t| format!("{:04}-{:02}-{:02}", t.year(), t.month() as u8, t.day()))
    .unwrap_or_default()
}

/// stats.mjs:1115 — UTF-8, mode 0600, truncating (same-second runs overwrite).
fn write_report(path: &Path, html: &str) -> Result<(), String> {
    let failure = |error: io::Error| format!("writing {} failed: {error}", path.display());
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(failure)?;
        file.write_all(html.as_bytes()).map_err(failure)?;
    }
    #[cfg(not(unix))]
    fs::write(path, html).map_err(failure)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_report_csv::CSV_COLUMNS;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn real_now() -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
    }

    fn csv_text() -> String {
        format!(
            "{}\n2026-10-27 10:00:00,sid-a,1.5,claude-sonnet-5-5,10,20,0,0,\
             claude-sonnet-5-5,Sonnet,1000,500,5,2,42,17,10,200000,3,2,0,,1.5\n",
            CSV_COLUMNS.join(",")
        )
    }

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!("usage-pipeline-{id}"));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn env(&self, now_secs: f64) -> PipelineEnv {
            PipelineEnv {
                base_state_dir: self.root.join("state"),
                reports_dir: self.root.join("reports"),
                claude_projects_root: self.root.join("claude/projects"),
                claude_inventory_root: self.root.join("claude"),
                codex_home: self.root.join("codex"),
                now_secs,
                local_zone: LocalZone::Fixed(0),
            }
        }

        fn with_inventory(self) -> Self {
            fs::create_dir_all(self.root.join("claude/projects")).unwrap();
            self
        }

        fn write_csv(&self) {
            fs::create_dir_all(self.root.join("state")).unwrap();
            fs::write(self.root.join("state/stats.csv"), csv_text()).unwrap();
        }
    }

    fn noop(_sid: Option<&str>) -> io::Result<()> {
        Ok(())
    }

    #[test]
    fn missing_csv_triggers_rebuild_and_renders_full_report() {
        let fixture = Fixture::new().with_inventory();
        let env = fixture.env(real_now());
        let mut calls = 0;
        let path = generate_native(&env, &mut |_sid| {
            calls += 1;
            fs::create_dir_all(&env.base_state_dir).unwrap();
            fs::write(env.base_state_dir.join("stats.csv"), csv_text())
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(path.parent(), Some(env.reports_dir.as_path()));
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("report-") && name.ends_with(".html"));
        assert_eq!(name.len(), "report-".len() + 17 + ".html".len());
        let html = fs::read_to_string(&path).unwrap();
        assert!(html.to_lowercase().contains("<html"));
        assert!(html.contains("var SESSIONS="));
        assert!(html.contains("var FORECAST="));
        assert!(html.contains("</html>"));
        assert!(html.contains("id='road-sgs'"));
    }

    #[test]
    fn fresh_csv_skips_rebuild() {
        let fixture = Fixture::new().with_inventory();
        fixture.write_csv();
        let env = fixture.env(real_now());
        let mut calls = 0;
        generate_native(&env, &mut |_sid| {
            calls += 1;
            noop(None)
        })
        .unwrap();
        assert_eq!(calls, 0);
    }

    #[test]
    fn active_sid_propagates_to_rebuild() {
        let fixture = Fixture::new().with_inventory();
        std::thread::sleep(Duration::from_millis(20));
        let cost_state = fixture.root.join("state/cost-state");
        fs::create_dir_all(&cost_state).unwrap();
        fs::write(cost_state.join("sid-live.json"), "{}").unwrap();
        let env = fixture.env(real_now());
        let mut seen: Option<String> = None;
        generate_native(&env, &mut |sid| {
            seen = sid.map(str::to_owned);
            fixture.write_csv();
            Ok(())
        })
        .unwrap();
        assert_eq!(seen.as_deref(), Some("sid-live"));
    }

    #[test]
    fn missing_inventory_root_still_renders_native_roadmap() {
        let fixture = Fixture::new().with_inventory();
        fixture.write_csv();
        let mut env = fixture.env(real_now());
        env.claude_inventory_root = fixture.root.join("absent-claude");
        let path = generate_native(&env, &mut noop).unwrap();
        let html = fs::read_to_string(&path).unwrap();
        assert!(html.contains("id='road-sgs'"));
    }

    #[test]
    fn write_failure_is_reported() {
        let fixture = Fixture::new().with_inventory();
        fixture.write_csv();
        let mut env = fixture.env(real_now());
        env.reports_dir = fixture.root.join("reports-file");
        fs::write(&env.reports_dir, "not a directory").unwrap();
        let error = generate_native(&env, &mut noop).unwrap_err();
        assert!(error.contains("reports directory"), "{error}");
    }
}
