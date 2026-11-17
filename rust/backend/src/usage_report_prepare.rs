//! Read-side filesystem adapter for usage-report preparation.
//!
//! One enumeration pass collects everything the freshness decision needs —
//! project transcripts, cost-state files, the stats CSV mtime, and Codex
//! rollouts — into a single snapshot, so selection and rebuild observe the
//! same files (`stats.mjs:1033-1082`). Roots and the clock are parameters;
//! this module never reads the environment or a real home directory. A path
//! that vanishes between listing and stat is skipped, never an error
//! (`codex.mjs:104-108`); `stats.mjs:91-93` aborts instead, and the skip is
//! the deliberate native policy.

use crate::usage_report_freshness::FreshnessInput;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Roots for one enumeration pass; tests substitute synthetic temp paths.
pub struct PrepareRoots<'a> {
    /// Transcript root: files live at `<projects>/<project>/<sid>.jsonl`.
    pub projects_dir: &'a Path,
    /// Cost-state directory: `<sid>.json` files.
    pub state_dir: &'a Path,
    /// The stats CSV whose mtime is the rebuild baseline.
    pub csv_path: &'a Path,
    /// Codex home; both `sessions/` and `archived_sessions/` are scanned.
    pub codex_home: &'a Path,
}

/// Every input to `FreshnessInput`, taken in one pass.
#[derive(Debug, Default, PartialEq)]
pub struct PrepareSnapshot {
    pub now_s: f64,
    pub csv_mtime_s: f64,
    pub transcripts: Vec<(String, f64)>,
    pub state_files: Vec<(String, f64)>,
    pub codex_mtimes: Vec<f64>,
}

impl PrepareSnapshot {
    pub fn freshness_input(&self) -> FreshnessInput<'_> {
        FreshnessInput {
            now_s: self.now_s,
            csv_mtime_s: self.csv_mtime_s,
            transcripts: &self.transcripts,
            state_files: &self.state_files,
            codex_mtimes: &self.codex_mtimes,
        }
    }
}

pub fn snapshot(roots: &PrepareRoots<'_>, now_s: f64) -> PrepareSnapshot {
    PrepareSnapshot {
        now_s,
        csv_mtime_s: csv_mtime(roots.csv_path),
        transcripts: transcript_entries(roots.projects_dir),
        state_files: state_entries(roots.state_dir),
        codex_mtimes: codex_mtimes(roots.codex_home),
    }
}

fn seconds(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(delta) => delta.as_secs_f64(),
        Err(before) => -before.duration().as_secs_f64(),
    }
}

// Any stat failure (vanished, unreadable) drops the entry instead of failing.
fn mtime_s(path: &Path) -> Option<f64> {
    Some(seconds(fs::metadata(path).ok()?.modified().ok()?))
}

// stats.mjs:1059 — isFile() then mtime; no stat-able file means the zero epoch.
fn csv_mtime(path: &Path) -> f64 {
    fs::metadata(path)
        .ok()
        .filter(fs::Metadata::is_file)
        .and_then(|meta| meta.modified().ok())
        .map_or(0.0, seconds)
}

// fs.globSync returns matches in sorted order; list the same way so equal
// mtimes resolve to the same first entry (stats.mjs:1037-1038).
fn listed(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = crate::fs_sorted::read_dir(dir) else {
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

// stats.mjs:1037 — `<projects>/<project>/<sid>.jsonl`, one project level only.
fn transcript_entries(projects_dir: &Path) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for (_, project) in listed(projects_dir) {
        if !project.is_dir() {
            continue; // the glob only descends into directories
        }
        for (name, path) in listed(&project) {
            if !name.ends_with(".jsonl") {
                continue;
            }
            if let Some(mtime) = mtime_s(&path) {
                out.push((strip_ext(&name, ".jsonl").to_owned(), mtime));
            }
        }
    }
    out
}

// stats.mjs:1038 — direct children of the cost-state directory.
fn state_entries(state_dir: &Path) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for (name, path) in listed(state_dir) {
        if !name.ends_with(".json") {
            continue;
        }
        if let Some(mtime) = mtime_s(&path) {
            out.push((strip_ext(&name, ".json").to_owned(), mtime));
        }
    }
    out
}

// codex.mjs:78-111 — both session roots, recursive, rollout-*.jsonl only;
// a rollout whose stat fails (archived mid-scan) contributes nothing.
fn codex_mtimes(codex_home: &Path) -> Vec<f64> {
    let mut files = Vec::new();
    for base in ["sessions", "archived_sessions"] {
        collect_rollouts(&codex_home.join(base), &mut files);
    }
    files.iter().filter_map(|path| mtime_s(path)).collect()
}

fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = crate::fs_sorted::read_dir(dir) else {
        return; // absent root: nothing to scan (codex.mjs:81)
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_rollouts(&entry.path(), out);
        } else if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            out.push(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_report_freshness::decide_freshness;
    use std::time::Duration;

    const NOW_S: f64 = 1_700_000_000.0;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "usage-report-prepare-{}-{name}",
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

    fn write_at(root: &TempRoot, relative: &str, mtime_s: f64) -> PathBuf {
        let path = root.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = fs::File::create(&path).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_secs_f64(mtime_s))
            .unwrap();
        path
    }

    fn approx(actual: f64, expected: f64) -> bool {
        (actual - expected).abs() < 1e-3
    }

    #[test]
    fn snapshot_enumerates_transcripts_state_csv_and_both_codex_roots() {
        let root = TempRoot::new("full");
        let projects = root.0.join("projects");
        let state = root.0.join("cost-state");
        let codex = root.0.join("codex");
        let csv = write_at(&root, "stats.csv", NOW_S - 1_000.0);
        write_at(&root, "projects/p1/a.jsonl", NOW_S - 20.0);
        write_at(&root, "projects/p2/b.jsonl", NOW_S - 10.0);
        write_at(&root, "projects/p1/notes.txt", NOW_S - 5.0);
        write_at(&root, "projects/stray.jsonl", NOW_S - 5.0); // glob needs one project level
        write_at(&root, "cost-state/live.json", NOW_S - 10.0);
        write_at(&root, "cost-state/old.json", NOW_S - 5_000.0);
        write_at(
            &root,
            "codex/sessions/2026/10/rollout-a.jsonl",
            NOW_S - 30.0,
        );
        write_at(
            &root,
            "codex/archived_sessions/rollout-b.jsonl",
            NOW_S - 40.0,
        );
        write_at(&root, "codex/sessions/other.jsonl", NOW_S - 30.0);

        let roots = PrepareRoots {
            projects_dir: &projects,
            state_dir: &state,
            csv_path: &csv,
            codex_home: &codex,
        };
        let snapshot = snapshot(&roots, NOW_S);

        assert_eq!(snapshot.now_s, NOW_S);
        assert!(approx(snapshot.csv_mtime_s, NOW_S - 1_000.0));
        let sids: Vec<&str> = snapshot
            .transcripts
            .iter()
            .map(|(sid, _)| sid.as_str())
            .collect();
        assert_eq!(sids, ["a", "b"]);
        assert!(snapshot.transcripts.iter().all(|(_, mtime)| *mtime < NOW_S));
        let state_sids: Vec<&str> = snapshot
            .state_files
            .iter()
            .map(|(sid, _)| sid.as_str())
            .collect();
        assert_eq!(state_sids, ["live", "old"]);
        let mut codex_mtimes = snapshot.codex_mtimes.clone();
        codex_mtimes.sort_by(f64::total_cmp);
        assert_eq!(codex_mtimes.len(), 2);
        assert!(approx(codex_mtimes[0], NOW_S - 40.0));
        assert!(approx(codex_mtimes[1], NOW_S - 30.0));
    }

    #[test]
    fn snapshot_decides_freshness_from_the_same_enumeration() {
        let root = TempRoot::new("freshness");
        let projects = root.0.join("projects");
        let state = root.0.join("cost-state");
        let codex = root.0.join("codex");
        let csv = write_at(&root, "stats.csv", NOW_S - 1_000.0);
        write_at(&root, "projects/p1/live.jsonl", NOW_S - 900.0);
        write_at(&root, "cost-state/live.json", NOW_S - 10.0);

        let roots = PrepareRoots {
            projects_dir: &projects,
            state_dir: &state,
            csv_path: &csv,
            codex_home: &codex,
        };
        let snapshot = snapshot(&roots, NOW_S);
        let decision = decide_freshness(&snapshot.freshness_input());

        assert_eq!(decision.active_sid.as_deref(), Some("live"));
        assert!(!decision.needs_rebuild);
    }

    #[test]
    fn missing_roots_yield_an_empty_snapshot_and_a_zero_csv_mtime() {
        let root = TempRoot::new("missing");
        let projects = root.0.join("projects");
        let state = root.0.join("cost-state");
        let csv = root.0.join("stats.csv");
        let codex = root.0.join("codex");

        let roots = PrepareRoots {
            projects_dir: &projects,
            state_dir: &state,
            csv_path: &csv,
            codex_home: &codex,
        };
        let snapshot = snapshot(&roots, NOW_S);

        assert_eq!(
            snapshot,
            PrepareSnapshot {
                now_s: NOW_S,
                ..Default::default()
            }
        );
        let decision = decide_freshness(&snapshot.freshness_input());
        assert_eq!(decision.active_sid, None);
        assert!(decision.needs_rebuild);
    }

    #[test]
    fn vanished_path_is_skipped_not_an_error() {
        let root = TempRoot::new("vanish");
        write_at(&root, "cost-state/kept.json", NOW_S - 5.0);
        let gone = write_at(&root, "cost-state/gone.json", NOW_S - 5.0);
        fs::remove_file(&gone).unwrap();

        let entries = state_entries(&root.0.join("cost-state"));

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "kept");
        assert!(mtime_s(&gone).is_none());
    }
}
