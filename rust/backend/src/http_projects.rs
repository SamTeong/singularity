//! Projects + project-review HTTP surface: `GET/POST/DELETE /api/projects`,
//! `PUT /api/projects/order`, `GET /api/projects/status`,
//! `POST /api/projects/git`, `GET /api/projects/summary`,
//! `GET /api/projects/review` and `GET /api/projects/review/file`.
//!
//! Ports `server/projects.mjs`, `server/project-review.mjs` and their mounts at
//! `server/index.mjs:799-847`. The host injects every path, the git binary and
//! timeout, and the provider one-shot call the summary LLM rung needs
//! (`server/history.mjs:defaultCallSummariser`); nothing here reads process env.
//!
//! Git runs through [`crate::oneshot::run_git`], the primitive the Node bridge
//! already used (`server/rust-backend.mjs:757`), and rebuilds the Node error
//! text (`git <args> failed: <execFile message>`) so `/projects/git` reports the
//! same `error` string. Paths resolve with `wiki_root::resolve_units`, i.e.
//! `path.resolve` semantics (lexical, separators normalized, no symlink
//! resolution), and comparisons case-fold on Windows only.

use crate::http_body::parse;
use crate::http_policy::query_values;
use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use regex::Regex;
use serde_json::{Value, json};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const PROJECTS_FILE: &str = "projects.json";
const SUMMARY_CACHE_DIR: &str = "projects-summary";
const RECENT_COMMIT_COUNT: usize = 10;
// ~20 KB — LLM input only, never the deterministic fallback.
const DIFF_CAP: usize = 20_000;
const GIT_MAX_BUFFER: f64 = 1024.0 * 1024.0;
const NOT_A_REPO: &str = "not a git repository";
const NOT_A_PERMUTATION: &str = "not a permutation";
const GIT_OP_PAIR_REQUIRED: &str = "path and op (fetch|rebase|sync) required";
const UNKNOWN_TARGET: &str = "not found";

/// The summariser model resolved from `state/models.json`
/// (`modelsSummariser`, `server/models.rs:332`).
pub struct SummaryModel {
    pub id: String,
    pub group: String,
}

/// Injected provider call for `GET /api/projects/summary`'s LLM rung:
/// `server/history.mjs:defaultCallSummariser`'s CLI invocation, given the final
/// prompt (the declawed guidance wrapper is already applied here). `Ok` is the
/// answer text — for `group == "claude"` the `result` field of the CLI's JSON
/// envelope, otherwise raw stdout — and `Err` is the thrown `e.message`, which
/// the response carries as `llm.error`.
pub trait SummaryCall: Send + Sync {
    fn call<'a>(
        &'a self,
        prompt: &'a str,
        model: &'a SummaryModel,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;
}

/// Everything the host must supply. `state_dir`/`cache_dir` are the Node
/// `STATE_DIR`/`CACHE_DIR` (`server/app-dir.mjs:18-19`), `home`/`cwd` are the
/// Node `os.homedir()`/`process.cwd()`, and the three `*_bin` fields are
/// `agents.mjs`' `resolveBin` results (`None` when unset or missing on disk).
pub struct ProjectsDeps {
    pub state_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub home: PathBuf,
    pub cwd: PathBuf,
    pub drive_cwds: Vec<(u16, PathBuf)>,
    /// `GIT_BIN` — absolute path from `.env`, else `"git"`.
    pub git_bin: String,
    /// `SING_GIT_TIMEOUT_MS`, else 10_000.
    pub git_timeout_ms: u64,
    /// `PROJECT_REVIEW_DIR`; `None` disables both review routes.
    pub review_dir: Option<PathBuf>,
    pub claude_bin: Option<PathBuf>,
    pub ollama_bin: Option<PathBuf>,
    pub codex_bin: Option<PathBuf>,
    pub summary_call: Arc<dyn SummaryCall>,
}

#[derive(Clone)]
struct ProjectsState {
    deps: Arc<ProjectsDeps>,
    // Serializes every projects.json read-modify-write, matching the sibling
    // state-file routers (`http_state.rs`); Node has no lock but interleaves at
    // each await, so this is strictly the safer ordering.
    lock: Arc<Mutex<()>>,
}

// VERIFY: http_projects-router-injection
/// Nine routes over one injected state; the host merges this into the `/api`
/// tree after `http_server`'s auth/origin layers.
// VERIFY: http_projects.rs: get(get_projects)
// VERIFY: http_projects.rs: post(post_projects)
// VERIFY: http_projects.rs: delete(delete_projects)
// VERIFY: http_projects.rs: put(put_order)
// VERIFY: http_projects.rs: get(get_status)
// VERIFY: http_projects.rs: post(post_git)
// VERIFY: http_projects.rs: get(get_summary)
// VERIFY: http_projects.rs: get(get_review)
// VERIFY: http_projects.rs: get(get_review_file)
pub fn router(deps: ProjectsDeps) -> Router {
    let state = ProjectsState {
        deps: Arc::new(deps),
        lock: Arc::new(Mutex::new(())),
    };
    Router::new()
        .route(
            "/api/projects",
            get(get_projects)
                .post(post_projects)
                .delete(delete_projects),
        )
        .route("/api/projects/order", put(put_order))
        .route("/api/projects/status", get(get_status))
        .route("/api/projects/git", post(post_git))
        .route("/api/projects/summary", get(get_summary))
        .route("/api/projects/review", get(get_review))
        .route("/api/projects/review/file", get(get_review_file))
        .with_state(state)
}

/// `server/tasks.mjs:66-76`'s `git()`: `-C repo -c core.askpass=`, the
/// non-interactive env, a hard timeout and the 1 MiB output cap.
struct Git<'a> {
    bin: &'a str,
    timeout_ms: u64,
}

impl Git<'_> {
    fn run(&self, repo: &str, args: &[&str]) -> Result<String, String> {
        let mut argv: Vec<String> = vec![
            "-C".to_owned(),
            repo.to_owned(),
            "-c".to_owned(),
            "core.askpass=".to_owned(),
        ];
        argv.extend(args.iter().map(|arg| (*arg).to_owned()));
        let payload = crate::oneshot::run_git(
            Some(self.bin),
            &Value::Array(argv.iter().cloned().map(Value::String).collect()),
            Some(self.timeout_ms as f64),
            Some(GIT_MAX_BUFFER),
            Some(&json!({
                "GIT_TERMINAL_PROMPT": "0",
                "GCM_INTERACTIVE": "never",
                "GIT_ASKPASS": "echo",
            })),
        );
        if payload.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(payload
                .get("stdout")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned());
        }
        Err(self.error_message(args, &argv, &payload))
    }

    /// `git <args> failed: <bridge error message>` — the exact text the Node
    /// route surfaces for `/projects/git`.
    fn error_message(&self, args: &[&str], argv: &[String], payload: &Value) -> String {
        let full = std::iter::once(self.bin.to_owned())
            .chain(argv.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");
        let inner = if payload.get("spawn_error").and_then(Value::as_bool) == Some(true) {
            format!("spawn {} {}", self.bin, spawn_code(payload))
        } else if let Some(error) = payload
            .get("error")
            .and_then(Value::as_str)
            .filter(|error| {
                matches!(
                    *error,
                    "stdout maxBuffer exceeded" | "stderr maxBuffer exceeded"
                )
            })
        {
            format!(
                "{} maxBuffer length exceeded",
                error.trim_end_matches(" maxBuffer exceeded")
            )
        } else if payload.get("timed_out").and_then(Value::as_bool) == Some(true) {
            format!("Command failed: {full}")
        } else {
            match payload.get("stderr").and_then(Value::as_str) {
                Some(stderr) if !stderr.is_empty() => format!("Command failed: {full}\n{stderr}"),
                _ => format!("Command failed: {full}"),
            }
        };
        format!("git {} failed: {inner}", args.join(" "))
    }
}

/// `server/rust-backend.mjs:765-775`'s errno mapping.
fn spawn_code(payload: &Value) -> &'static str {
    match payload
        .get("spawn_error_raw_os_code")
        .and_then(Value::as_i64)
    {
        Some(2) | Some(3) => "ENOENT",
        Some(5) | Some(13) | Some(193) => "EACCES",
        Some(32) => "EBUSY",
        Some(87) => "EINVAL",
        _ => match payload
            .get("spawn_error_kind")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            "NotFound" => "ENOENT",
            "PermissionDenied" => "EACCES",
            _ => "UNKNOWN",
        },
    }
}

impl ProjectsState {
    fn git(&self) -> Git<'_> {
        Git {
            bin: &self.deps.git_bin,
            timeout_ms: self.deps.git_timeout_ms,
        }
    }

    /// Node `path.resolve` (lexical, native separators, `~` never expanded).
    fn resolve(&self, raw: &str) -> String {
        let units: Vec<u16> = raw.encode_utf16().collect();
        let resolved = crate::wiki_root::resolve_units(
            &units,
            &self.deps.home,
            &self.deps.cwd,
            &self.deps.drive_cwds,
            cfg!(windows),
            false,
        );
        String::from_utf16_lossy(&resolved)
    }

    /// Comparison key: resolved, case-folded on win32.
    fn key(&self, raw: &str) -> String {
        norm(&self.resolve(raw))
    }

    fn projects_file(&self) -> PathBuf {
        self.deps.state_dir.join(PROJECTS_FILE)
    }

    fn read_list(&self) -> Vec<String> {
        let Ok(bytes) = fs::read(self.projects_file()) else {
            return Vec::new();
        };
        let Ok(Value::Array(items)) =
            serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes))
        else {
            return Vec::new();
        };
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect()
    }

    fn write_list(&self, list: &[String]) -> Result<(), ()> {
        write_atomic(&self.projects_file(), pretty_array(list).as_bytes())
    }

    fn is_live_repo(&self, path: &str) -> bool {
        Path::new(path).exists()
            && self
                .git()
                .run(path, &["rev-parse", "--show-toplevel"])
                .is_ok()
    }

    fn list(&self) -> Result<Vec<String>, ()> {
        let stored = self.read_list();
        let kept: Vec<String> = stored
            .iter()
            .filter(|path| self.is_live_repo(path))
            .cloned()
            .collect();
        if kept.len() != stored.len() {
            self.write_list(&kept)?;
        }
        Ok(kept)
    }

    fn has(&self, path: &str) -> bool {
        let key = self.key(path);
        self.read_list()
            .iter()
            .any(|stored| self.key(stored) == key)
    }

    fn add(&self, raw: Option<&str>) -> AddOutcome {
        let Some(raw) = raw.filter(|value| !value.is_empty()) else {
            return AddOutcome::Invalid;
        };
        let resolved = self.resolve(raw);
        let target = Path::new(&resolved);
        if !target.exists() || !target.is_dir() {
            return AddOutcome::Invalid;
        }
        let Ok(toplevel) = self.git().run(&resolved, &["rev-parse", "--show-toplevel"]) else {
            return AddOutcome::Invalid;
        };
        let toplevel = self.resolve(&toplevel);
        let stored = self.read_list();
        let key = self.key(&toplevel);
        if stored.iter().any(|path| self.key(path) == key) {
            return AddOutcome::Ok(stored);
        }
        let mut next = stored;
        next.push(toplevel);
        match self.write_list(&next) {
            Ok(()) => AddOutcome::Ok(next),
            Err(()) => AddOutcome::Storage,
        }
    }

    fn remove(&self, raw: &str) -> Result<Vec<String>, ()> {
        let key = self.key(raw);
        let stored = self.read_list();
        let next: Vec<String> = stored
            .iter()
            .filter(|path| self.key(path) != key)
            .cloned()
            .collect();
        if next.len() != stored.len() {
            self.write_list(&next)?;
        }
        Ok(next)
    }

    fn reorder(&self, paths: Option<&Value>) -> ReorderOutcome {
        let Some(Value::Array(items)) = paths else {
            return ReorderOutcome::Invalid;
        };
        let stored = self.read_list();
        if items.len() != stored.len() {
            return ReorderOutcome::Invalid;
        }
        let stored_keys: Vec<String> = stored.iter().map(|path| self.key(path)).collect();
        let mut seen = std::collections::HashSet::new();
        let mut ordered_keys = Vec::with_capacity(items.len());
        for item in items {
            let Some(path) = item.as_str() else {
                return ReorderOutcome::Invalid;
            };
            let key = self.key(path);
            if !stored_keys.contains(&key) || !seen.insert(key.clone()) {
                return ReorderOutcome::Invalid;
            }
            ordered_keys.push(key);
        }
        let next: Vec<String> = ordered_keys
            .iter()
            .map(|key| {
                let index = stored_keys
                    .iter()
                    .position(|stored| stored == key)
                    .expect("membership checked above");
                stored[index].clone()
            })
            .collect();
        match self.write_list(&next) {
            Ok(()) => ReorderOutcome::Ok(next),
            Err(()) => ReorderOutcome::Storage,
        }
    }

    fn git_status(&self, path: &str) -> Result<Value, String> {
        let out = self
            .git()
            .run(path, &["status", "--porcelain=v2", "--branch"])?;
        let mut branch: Option<String> = None;
        let mut upstream: Option<String> = None;
        let (mut ahead, mut behind) = (0u64, 0u64);
        let (mut staged, mut modified, mut untracked, mut conflicted) = (0u64, 0u64, 0u64, 0u64);
        for line in out.split('\n') {
            if let Some(head) = line.strip_prefix("# branch.head ") {
                branch = (head != "(detached)").then(|| head.to_owned());
            } else if let Some(name) = line.strip_prefix("# branch.upstream ") {
                upstream = Some(name.to_owned());
            } else if let Some(ahead_behind) = line.strip_prefix("# branch.ab ") {
                if let Some(captures) = ahead_behind_re().captures(ahead_behind) {
                    ahead = captures[1].parse().unwrap_or(0);
                    behind = captures[2].parse().unwrap_or(0);
                }
            } else if line.starts_with("1 ") || line.starts_with("2 ") {
                let xy = line.split(' ').nth(1).unwrap_or("");
                let mut columns = xy.chars();
                if columns.next() != Some('.') {
                    staged += 1;
                }
                if columns.next() != Some('.') {
                    modified += 1;
                }
            } else if line.starts_with("u ") {
                conflicted += 1;
            } else if line.starts_with("? ") {
                untracked += 1;
            }
        }
        let stash_out = self.git().run(path, &["stash", "list"])?;
        let stash = if stash_out.is_empty() {
            0
        } else {
            stash_out
                .split('\n')
                .filter(|line| !line.is_empty())
                .count()
        };
        let last_commit = self
            .git()
            .run(path, &["log", "-1", "--format=%H%x00%s%x00%cI"])
            .ok()
            .map(|out| {
                let mut parts = out.split('\0');
                json!({
                    "sha": parts.next().unwrap_or(""),
                    "subject": parts.next().unwrap_or(""),
                    "date": parts.next().unwrap_or(""),
                })
            });
        Ok(json!({
            "path": path,
            "branch": branch,
            "upstream": upstream,
            "ahead": ahead,
            "behind": behind,
            "staged": staged,
            "modified": modified,
            "untracked": untracked,
            "conflicted": conflicted,
            "stash": stash,
            "lastCommit": last_commit,
        }))
    }

    fn git_op(&self, path: &str, op: &str) -> Value {
        let commands: &[&str] = match op {
            "fetch" => &["fetch"],
            "rebase" => &["rebase"],
            "sync" => &["fetch", "rebase"],
            // The route rejects anything else before this point.
            _ => return json!({ "ok": false, "error": GIT_OP_PAIR_REQUIRED }),
        };
        for command in commands {
            if let Err(message) = self.git().run(path, &[command]) {
                if *command == "rebase" {
                    let _ = self.git().run(path, &["rebase", "--abort"]);
                }
                return json!({ "ok": false, "error": message });
            }
        }
        json!({ "ok": true })
    }

    fn summariser(&self) -> Option<SummaryModel> {
        let path = self.deps.state_dir.join("models.json");
        let value = crate::models::summariser(&path.to_string_lossy());
        Some(SummaryModel {
            id: value.get("id")?.as_str()?.to_owned(),
            group: value.get("group")?.as_str()?.to_owned(),
        })
    }

    /// `server/history.mjs:317` `binFor`: falsy when that provider binary is
    /// not configured, which keeps a project card from triggering an implicit
    /// fallback LLM.
    fn bin_configured(&self, group: &str) -> bool {
        match group {
            "claude" => self.deps.claude_bin.is_some(),
            "ollama" => self.deps.ollama_bin.is_some(),
            "codex" => self.deps.codex_bin.is_some(),
            _ => false,
        }
    }

    /// `server/history.mjs:45` `declawedGuidance`: the Phase 2 slice of the
    /// installed skill, re-read on every call so installing or removing it takes
    /// effect without a restart.
    fn guidance(&self) -> String {
        let file = self
            .deps
            .home
            .join(".agents")
            .join("skills")
            .join("declawed")
            .join("SKILL.md");
        let Ok(bytes) = fs::read(&file) else {
            return String::new();
        };
        let text = String::from_utf8_lossy(&bytes);
        let Some(start) = phase2_re().find(&text) else {
            return String::new();
        };
        let from = start.start();
        let to = phase3_re()
            .find(&text[from..])
            .map_or(text.len(), |phase| from + phase.start());
        text[from..to].trim().to_owned()
    }

    fn commit_scope(&self, path: &str) -> (Vec<String>, &'static str) {
        let has_upstream = self
            .git()
            .run(path, &["rev-parse", "--abbrev-ref", "@{u}"])
            .is_ok();
        let (scope, out) = if has_upstream {
            (
                "unpushed",
                self.git()
                    .run(path, &["log", "@{u}..HEAD", "--format=%h%x00%s"]),
            )
        } else {
            let count = RECENT_COMMIT_COUNT.to_string();
            (
                "recent",
                self.git()
                    .run(path, &["log", "-n", &count, "--format=%h%x00%s"]),
            )
        };
        let out = out.unwrap_or_default();
        (
            out.split('\n')
                .filter(|line| !line.is_empty())
                .map(|line| line.split('\0').nth(1).unwrap_or("").to_owned())
                .collect(),
            scope,
        )
    }

    fn uncommitted_changes(&self, path: &str) -> (String, String, String) {
        (
            self.git()
                .run(path, &["diff", "HEAD", "--stat"])
                .unwrap_or_default(),
            self.git()
                .run(path, &["status", "--porcelain"])
                .unwrap_or_default(),
            self.git().run(path, &["diff", "HEAD"]).unwrap_or_default(),
        )
    }

    fn cache_file(
        &self,
        path: &str,
        head_sha: &str,
        scope: &str,
        subjects: &[String],
        diff: &str,
        porcelain: &str,
    ) -> PathBuf {
        let key = sha1_hex(&format!(
            "{path}\u{0}{head_sha}\u{0}{scope}\u{0}{}\u{0}{}\u{0}{}",
            subjects.join("\n"),
            sha1_hex(&format!("{diff}{porcelain}")),
            // `declawedGuidance()` is in the key so installing or removing the
            // skill doesn't keep serving bullets worded under the old rules.
            sha1_hex(&self.guidance()),
        ));
        self.deps
            .cache_dir
            .join(SUMMARY_CACHE_DIR)
            .join(format!("{key}.json"))
    }

    fn summary_prepare(&self, path: &str) -> SummaryPrep {
        let (subjects, scope) = self.commit_scope(path);
        let (stat, porcelain, diff) = self.uncommitted_changes(path);
        let head_sha = self
            .git()
            .run(path, &["rev-parse", "HEAD"])
            .unwrap_or_else(|_| "none".to_owned());
        let body = deterministic_body(path, scope, &subjects, &stat, &porcelain);

        let Some(model) = self
            .summariser()
            .filter(|model| self.bin_configured(&model.group))
        else {
            return SummaryPrep::Ready(with_llm(
                body,
                json!({ "ok": false, "reason": "no-summariser" }),
            ));
        };

        let cache_file = self.cache_file(path, &head_sha, scope, &subjects, &diff, &porcelain);
        if let Ok(bytes) = fs::read(&cache_file) {
            if let Ok(Value::Object(mut map)) =
                serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes))
            {
                map.insert("cached".to_owned(), Value::Bool(true));
                return SummaryPrep::Ready(Value::Object(map));
            }
        }

        let prompt =
            summariser_prompt(scope, &subjects, &stat, &porcelain, &diff, &self.guidance());
        SummaryPrep::Llm {
            prompt,
            model,
            cache_file,
            fallback: body,
            path: path.to_owned(),
            scope,
        }
    }

    fn review_status(&self, path: &str) -> Value {
        let Some(review_dir) = self.deps.review_dir.as_deref() else {
            return json!({ "enabled": false });
        };
        let ledger = review_dir.join("project-review-log.md");
        let Ok(bytes) = fs::read(&ledger) else {
            return json!({ "enabled": true, "runs": [], "latest": Value::Null });
        };
        let text = String::from_utf8_lossy(&bytes);
        let mut runs: Vec<Value> = Vec::new();
        for cells in parse_ledger_rows(&text) {
            if !session_id_re().is_match(&cells[0]) || !matches_worktree(&cells[1], path) {
                continue;
            }
            let session_id = cells[0].clone();
            runs.push(json!({
                "sessionId": session_id,
                "worktree": cells[1],
                "baseline": cells[2],
                "target": cells[3],
                "startedAt": cells[4],
                "completedAt": cells[5],
                "harness": cells[6],
                "model": cells[7],
                "status": cells[9],
                "artifacts": parse_artifacts(&cells[10]),
                "findings": self.read_run_findings(&session_id),
            }));
        }
        // Ledger rows are appended chronologically — newest first for the response.
        runs.reverse();
        if runs.is_empty() {
            return json!({ "enabled": true, "runs": runs, "latest": Value::Null });
        }

        let mut counts = counts_init();
        for run in &runs {
            add_counts(&mut counts, &run["findings"]);
        }
        let status = runs[0]["status"].as_str().unwrap_or("").to_owned();
        let target = runs[0]["target"].as_str().unwrap_or("").to_owned();
        let commits_since = if status == "DONE" && sha_re().is_match(&target) {
            self.git()
                .run(path, &["rev-list", "--count", &format!("{target}..HEAD")])
                .map(|out| js_number(&out))
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        json!({
            "enabled": true,
            "runs": runs,
            "latest": {
                "status": status,
                "target": target,
                "completedAt": runs[0]["completedAt"],
                "commitsSince": commits_since,
                "counts": counts,
            }
        })
    }

    fn read_run_findings(&self, session_id: &str) -> Vec<Value> {
        let Some(review_dir) = self.deps.review_dir.as_deref() else {
            return Vec::new();
        };
        let dir = review_dir.join(session_id).join("findings");
        if !session_id_re().is_match(session_id)
            || !path_contains(
                &self.resolve(&review_dir.to_string_lossy()),
                &self.resolve(&dir.to_string_lossy()),
            )
        {
            return Vec::new();
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.to_lowercase().ends_with(".md"))
            .collect();
        names.sort();
        let mut findings = Vec::new();
        for name in names {
            let kind = if preexisting_re().is_match(&name) {
                "preexisting"
            } else {
                "introduced"
            };
            let rel = format!("{session_id}/findings/{name}");
            let Ok(bytes) = fs::read(dir.join(&name)) else {
                continue;
            };
            for finding in parse_findings_file(&String::from_utf8_lossy(&bytes), kind) {
                let mut finding = finding;
                if let Some(map) = finding.as_object_mut() {
                    map.insert("rel".to_owned(), json!(rel));
                }
                findings.push(finding);
            }
        }
        findings
    }

    fn read_review_file(&self, rel: Option<&str>) -> Value {
        let Some(review_dir) = self.deps.review_dir.as_deref() else {
            return json!({ "ok": false, "error": "project review not configured" });
        };
        let Some(rel) = rel.filter(|value| !value.is_empty()) else {
            return json!({ "ok": false, "error": "bad path" });
        };
        if !rel.to_lowercase().ends_with(".md") {
            return json!({ "ok": false, "error": "bad path" });
        }
        let root = review_dir.to_string_lossy().into_owned();
        let joined = if is_absolute(rel) {
            rel.to_owned()
        } else {
            format!("{root}/{rel}")
        };
        let abs = self.resolve(&joined);
        if !path_contains(&self.resolve(&root), &abs) {
            return json!({ "ok": false, "error": "path outside project review dir" });
        }
        if !Path::new(&abs).exists() {
            return json!({ "ok": false, "error": UNKNOWN_TARGET });
        }
        match fs::read(&abs) {
            Ok(bytes) => json!({ "ok": true, "content": String::from_utf8_lossy(&bytes) }),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        }
    }
}

enum AddOutcome {
    Invalid,
    Ok(Vec<String>),
    Storage,
}

enum ReorderOutcome {
    Invalid,
    Ok(Vec<String>),
    Storage,
}

enum SummaryPrep {
    Ready(Value),
    Llm {
        prompt: String,
        model: SummaryModel,
        cache_file: PathBuf,
        fallback: Value,
        path: String,
        scope: &'static str,
    },
}

// --- handlers -------------------------------------------------------------

async fn get_projects(State(state): State<ProjectsState>) -> Response {
    blocking(state, |projects| match projects.list() {
        Ok(list) => Json(json!({ "projects": list })).into_response(),
        Err(()) => internal_error(),
    })
    .await
}

async fn post_projects(State(state): State<ProjectsState>, request: Request<Body>) -> Response {
    let body = match parse(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let raw = body
        .as_object()
        .and_then(|object| object.get("path"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    blocking(state, move |projects| match projects.add(raw.as_deref()) {
        AddOutcome::Invalid => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": NOT_A_REPO })),
        )
            .into_response(),
        AddOutcome::Ok(list) => Json(json!({ "ok": true, "projects": list })).into_response(),
        AddOutcome::Storage => internal_error(),
    })
    .await
}

async fn delete_projects(State(state): State<ProjectsState>, request: Request<Body>) -> Response {
    let body = match parse(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    // `remove()` resolves its argument first, so a non-string `path` is the
    // `path.resolve` TypeError Fastify reports as a 500.
    let raw = match body.as_object().and_then(|object| object.get("path")) {
        Some(Value::String(text)) => text.clone(),
        Some(other) => return type_error(&received_description(other)),
        None => return type_error("Received undefined"),
    };
    blocking(state, move |projects| match projects.remove(&raw) {
        Ok(list) => Json(json!({ "ok": true, "projects": list })).into_response(),
        Err(()) => internal_error(),
    })
    .await
}

async fn put_order(State(state): State<ProjectsState>, request: Request<Body>) -> Response {
    let body = match parse(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let paths = body
        .as_object()
        .and_then(|object| object.get("paths"))
        .cloned();
    blocking(state, move |projects| {
        match projects.reorder(paths.as_ref()) {
            ReorderOutcome::Invalid => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": NOT_A_PERMUTATION })),
            )
                .into_response(),
            ReorderOutcome::Ok(list) => {
                Json(json!({ "ok": true, "projects": list })).into_response()
            }
            ReorderOutcome::Storage => internal_error(),
        }
    })
    .await
}

async fn get_status(State(state): State<ProjectsState>, RawQuery(query): RawQuery) -> Response {
    let path = match path_param(query.as_deref()) {
        PathGate::Value(path) => path,
        PathGate::Response(response) => return response,
    };
    blocking(state, move |projects| {
        if !projects.has(&path) {
            return not_found();
        }
        // Stored but no longer a repo on disk (`list()` prunes it on next load).
        match projects.git_status(&path) {
            Ok(status) => Json(status).into_response(),
            Err(_) => not_found(),
        }
    })
    .await
}

async fn post_git(State(state): State<ProjectsState>, request: Request<Body>) -> Response {
    let body = match parse(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let object = body.as_object();
    let path = object.and_then(|object| object.get("path"));
    let op = object
        .and_then(|object| object.get("op"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if !matches!(op.as_str(), "fetch" | "rebase" | "sync") {
        return git_pair_required();
    }
    let path = match path {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::String(_)) | None => return git_pair_required(),
        Some(other) => return type_error(&received_description(other)),
    };
    blocking(state, move |projects| {
        if !projects.has(&path) {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "ok": false, "error": UNKNOWN_TARGET })),
            )
                .into_response();
        }
        Json(projects.git_op(&path, &op)).into_response()
    })
    .await
}

async fn get_summary(State(state): State<ProjectsState>, RawQuery(query): RawQuery) -> Response {
    let path = match path_param(query.as_deref()) {
        PathGate::Value(path) => path,
        PathGate::Response(response) => return response,
    };
    let prepared = {
        let state = state.clone();
        let path = path.clone();
        blocking_value(state, move |projects| {
            if !projects.has(&path) {
                return Err(not_found());
            }
            Ok(projects.summary_prepare(&path))
        })
        .await
    };
    let prep = match prepared {
        Ok(Ok(prep)) => prep,
        Ok(Err(response)) | Err(response) => return response,
    };
    let SummaryPrep::Llm {
        prompt,
        model,
        cache_file,
        fallback,
        path,
        scope,
    } = prep
    else {
        return match prep {
            SummaryPrep::Ready(value) => Json(value).into_response(),
            SummaryPrep::Llm { .. } => unreachable!("matched above"),
        };
    };

    let outcome = state.deps.summary_call.call(&prompt, &model).await;
    let (result, cache_text) = match outcome {
        Ok(text) => match parse_json_summary(&text) {
            Some((committed, uncommitted)) => {
                let result = json!({
                    "path": path,
                    "scope": scope,
                    "committed": committed,
                    "uncommitted": uncommitted,
                    "source": "llm",
                    "model": model.id,
                });
                // A cache write failure still returns the fresh result.
                (result.clone(), serde_json::to_string(&result).ok())
            }
            None => (
                with_llm(fallback, json!({ "ok": false, "error": Value::Null })),
                None,
            ),
        },
        Err(message) => (
            with_llm(fallback, json!({ "ok": false, "error": message })),
            None,
        ),
    };
    if let Some(text) = cache_text {
        let _ = blocking_value(state, move |_projects| {
            if let Some(parent) = cache_file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = write_atomic(&cache_file, text.as_bytes());
        })
        .await;
    }
    Json(result).into_response()
}

async fn get_review(State(state): State<ProjectsState>, RawQuery(query): RawQuery) -> Response {
    let path = match path_param(query.as_deref()) {
        PathGate::Value(path) => path,
        PathGate::Response(response) => return response,
    };
    blocking(state, move |projects| {
        if !projects.has(&path) {
            return not_found();
        }
        Json(projects.review_status(&path)).into_response()
    })
    .await
}

async fn get_review_file(
    State(state): State<ProjectsState>,
    RawQuery(query): RawQuery,
) -> Response {
    let rel = match query_param(query.as_deref(), "rel") {
        Param::Value(value) => Some(value),
        Param::Absent | Param::Repeated => None,
    };
    blocking(state, move |projects| {
        let result = projects.read_review_file(rel.as_deref());
        if result["ok"].as_bool() == Some(true) {
            return Json(result).into_response();
        }
        let status = if result["error"].as_str() == Some(UNKNOWN_TARGET) {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        (status, Json(result)).into_response()
    })
    .await
}

// --- shared plumbing ------------------------------------------------------

async fn blocking(
    state: ProjectsState,
    run: impl FnOnce(&ProjectsState) -> Response + Send + 'static,
) -> Response {
    match blocking_value(state, run).await {
        Ok(response) => response,
        Err(response) => response,
    }
}

async fn blocking_value<T, F>(state: ProjectsState, run: F) -> Result<T, Response>
where
    T: Send + 'static,
    F: FnOnce(&ProjectsState) -> T + Send + 'static,
{
    let state = state.clone();
    let joined = tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        run(&state)
    })
    .await;
    joined.map_err(|_| internal_error())
}

enum Param {
    Absent,
    Value(String),
    Repeated,
}

enum PathGate {
    Value(String),
    Response(Response),
}

/// Fastify hands a single `path` through as a string and repeats as an array;
/// the array reaches `path.resolve` and throws, so it maps to the Node 500.
fn path_param(query: Option<&str>) -> PathGate {
    match query_param(query, "path") {
        Param::Absent => PathGate::Response(path_required()),
        Param::Value(value) if value.is_empty() => PathGate::Response(path_required()),
        Param::Value(value) => PathGate::Value(value),
        Param::Repeated => PathGate::Response(type_error("Received an instance of Array")),
    }
}

fn query_param(query: Option<&str>, name: &str) -> Param {
    let Some(query) = query else {
        return Param::Absent;
    };
    match query_values(query, name).as_slice() {
        [] => Param::Absent,
        [value] => Param::Value(value.clone()),
        _ => Param::Repeated,
    }
}

fn path_required() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "path required" })),
    )
        .into_response()
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": UNKNOWN_TARGET })),
    )
        .into_response()
}

fn git_pair_required() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "error": GIT_OP_PAIR_REQUIRED })),
    )
        .into_response()
}

/// `path.resolve`'s TypeError, which the Node handlers surface as a Fastify 500.
fn type_error(received: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": format!("The \"paths[0]\" argument must be of type string. {received}"),
        })),
    )
        .into_response()
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": "Internal Server Error",
        })),
    )
        .into_response()
}

/// `util.inspect`'s value description inside `ERR_INVALID_ARG_TYPE`.
fn received_description(value: &Value) -> String {
    match value {
        Value::Null => "Received null".to_owned(),
        Value::Bool(flag) => format!("Received type boolean ({flag})"),
        Value::Number(number) => format!("Received type number ({})", js_number_text(number)),
        Value::String(text) => format!("Received type string ('{text}')"),
        Value::Array(_) => "Received an instance of Array".to_owned(),
        Value::Object(_) => "Received an instance of Object".to_owned(),
    }
}

fn js_number_text(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(value) if value.is_nan() => "NaN".to_owned(),
        Some(value) if value == f64::INFINITY => "Infinity".to_owned(),
        Some(value) if value == f64::NEG_INFINITY => "-Infinity".to_owned(),
        Some(value) => format!("{value}"),
        // `arbitrary_precision` keeps tokens `as_f64` cannot decode.
        None => number.to_string(),
    }
}

// --- helpers --------------------------------------------------------------

fn norm(value: &str) -> String {
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.to_owned()
    }
}

/// `path-containment.mjs:contains`: `relative()` never leaves a `..` step.
fn path_contains(root: &str, target: &str) -> bool {
    let root = components(&norm(root));
    let target = components(&norm(target));
    target.len() >= root.len() && target[..root.len()] == root[..]
}

fn components(value: &str) -> Vec<String> {
    value
        .split(['\\', '/'])
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

fn is_absolute(value: &str) -> bool {
    let units: Vec<u16> = value.encode_utf16().collect();
    units
        .first()
        .is_some_and(|unit| *unit == b'/' as u16 || (cfg!(windows) && *unit == b'\\' as u16))
        || (cfg!(windows) && units.get(1) == Some(&(b':' as u16)))
}

/// `JSON.stringify(list, null, 2)`; an empty list stays on one line.
fn pretty_array(list: &[String]) -> String {
    if list.is_empty() {
        return "[]".to_owned();
    }
    let items: Vec<String> = list
        .iter()
        .map(|item| serde_json::to_string(item).expect("a string always serializes"))
        .collect();
    format!("[\n  {}\n]", items.join(",\n  "))
}

/// `agents.mjs:69` `writeAtomic`: scratch file beside the target, then rename
/// with the Windows sharing-violation retry ladder.
fn write_atomic(file: &Path, bytes: &[u8]) -> Result<(), ()> {
    let mut scratch = file.as_os_str().to_owned();
    scratch.push(format!(".{}.tmp", std::process::id()));
    let scratch = PathBuf::from(scratch);
    fs::write(&scratch, bytes).map_err(|_| ())?;
    for attempt in 1..=5u32 {
        match fs::rename(&scratch, file) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if attempt >= 5 || !retryable(&error) {
                    return Err(());
                }
                std::thread::sleep(Duration::from_millis(u64::from(20 * attempt)));
            }
        }
    }
    Err(())
}

fn retryable(error: &std::io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(5) | Some(13) | Some(32) | Some(33)
    ) || error.kind() == std::io::ErrorKind::PermissionDenied
}

fn sha1_hex(input: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, input.as_bytes());
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn or_none(value: &str) -> &str {
    if value.is_empty() { "(none)" } else { value }
}

/// `projects.mjs:174` — the LLM input cap, sliced by UTF-16 code units like
/// `String.prototype.slice`.
fn truncated_diff(diff: &str) -> String {
    let units: Vec<u16> = diff.encode_utf16().collect();
    if units.len() <= DIFF_CAP {
        return diff.to_owned();
    }
    format!(
        "{}\n… (truncated)",
        String::from_utf16_lossy(&units[..DIFF_CAP])
    )
}

/// `projects.mjs:182` — no LLM: `--stat` file lines plus its summary line, and
/// an untracked count from porcelain (`diff HEAD` never sees untracked files).
fn deterministic_body(
    path: &str,
    scope: &str,
    subjects: &[String],
    stat: &str,
    porcelain: &str,
) -> Value {
    let lines: Vec<&str> = stat.split('\n').filter(|line| !line.is_empty()).collect();
    let mut uncommitted: Vec<String> = Vec::new();
    if !lines.is_empty() {
        uncommitted.extend(
            lines[..lines.len() - 1]
                .iter()
                .take(RECENT_COMMIT_COUNT)
                .map(|line| (*line).to_owned()),
        );
        uncommitted.push(lines[lines.len() - 1].to_owned());
    }
    let untracked = porcelain
        .split('\n')
        .filter(|line| line.starts_with("?? "))
        .count();
    if untracked > 0 {
        uncommitted.push(format!(
            "{untracked} untracked file{}",
            if untracked == 1 { "" } else { "s" }
        ));
    }
    json!({
        "path": path,
        "scope": scope,
        "committed": subjects.iter().take(RECENT_COMMIT_COUNT).cloned().collect::<Vec<_>>(),
        "uncommitted": uncommitted,
        "source": "deterministic",
    })
}

fn with_llm(mut body: Value, llm: Value) -> Value {
    if let Some(map) = body.as_object_mut() {
        map.insert("llm".to_owned(), llm);
    }
    body
}

/// `projects.mjs:234` — the project prompt, wrapped in the declawed Phase 2
/// guidance exactly as `defaultCallSummariser(prompt, model, {system:null})`.
fn summariser_prompt(
    scope: &str,
    subjects: &[String],
    stat: &str,
    porcelain: &str,
    diff: &str,
    guidance: &str,
) -> String {
    let project = format!(
        "Summarize a git repo's committed and uncommitted changes into strict JSON \
{{\"committed\":string[],\"uncommitted\":string[]}}. Max 5 terse bullets each, no prose, no markdown fence.\n\n\
## Commits ({scope})\n{}\n\n\
## Uncommitted --stat\n{}\n\n\
## Uncommitted status --porcelain\n{}\n\n\
## Uncommitted diff\n{}",
        or_none(&subjects.join("\n")),
        or_none(stat),
        or_none(porcelain),
        or_none(&truncated_diff(diff)),
    );
    if guidance.is_empty() {
        return project;
    }
    format!(
        "Write every bullet in plain, specific human prose. Apply these rules from the declawed \
skill to the wording only; the output format stays exactly as requested above/below:\n\n\
{guidance}\n\n{project}"
    )
}

/// `projects.mjs:190` — the first `{` through the last `}`.
fn parse_json_summary(text: &str) -> Option<(Vec<String>, Vec<String>)> {
    let blob = json_blob_re().find(text)?.as_str();
    let object = serde_json::from_str::<Value>(blob).ok()?;
    let committed = object.get("committed");
    let uncommitted = object.get("uncommitted");
    if !committed.is_some_and(Value::is_array) && !uncommitted.is_some_and(Value::is_array) {
        return None;
    }
    Some((bullets(committed), bullets(uncommitted)))
}

fn bullets(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let text = js_to_string(item);
                    let trimmed = text.trim();
                    (!trimmed.is_empty()).then(|| trimmed.to_owned())
                })
                .take(5)
                .collect()
        })
        .unwrap_or_default()
}

/// `String(value)` for the bullet coercion.
fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_text(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `Number(text)`, with `NaN` serialized as `null`.
fn js_number(text: &str) -> Value {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return json!(0);
    }
    match trimmed.parse::<f64>() {
        Ok(number) if number.is_finite() => {
            if number.fract() == 0.0 && number.abs() < 9.0e15 {
                json!(number as i64)
            } else {
                json!(number)
            }
        }
        _ => Value::Null,
    }
}

fn counts_init() -> Value {
    json!({ "P0": 0, "P1": 0, "P2": 0, "P3": 0, "open": 0, "resolved": 0 })
}

fn add_counts(counts: &mut Value, findings: &Value) {
    let Some(items) = findings.as_array() else {
        return;
    };
    for finding in items {
        let severity = finding["sev"].as_str().unwrap_or("").to_owned();
        let open = finding["status"].as_str() == Some("open");
        let Some(map) = counts.as_object_mut() else {
            return;
        };
        if let Some(entry) = map.get_mut(&severity) {
            let next = entry.as_u64().unwrap_or(0) + 1;
            *entry = json!(next);
        }
        let key = if open { "open" } else { "resolved" };
        if let Some(entry) = map.get_mut(key) {
            let next = entry.as_u64().unwrap_or(0) + 1;
            *entry = json!(next);
        }
    }
}

fn parse_ledger_rows(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim();
        if !trimmed.starts_with('|') || ledger_separator_re().is_match(trimmed) {
            continue;
        }
        let parts: Vec<&str> = trimmed.split('|').collect();
        if parts.len() < 2 {
            continue;
        }
        let cells: Vec<String> = parts[1..parts.len() - 1]
            .iter()
            .map(|cell| cell.trim().to_owned())
            .collect();
        if cells.len() < 11 || cells[0] == "Session ID" {
            continue;
        }
        rows.push(cells);
    }
    rows
}

fn parse_artifacts(cell: &str) -> Vec<Value> {
    artifact_re()
        .captures_iter(cell)
        .map(|captures| json!({ "label": &captures[1], "rel": &captures[2] }))
        .collect()
}

/// `project-review.mjs:18` — forward-slash normalization plus the
/// case-insensitive prefix match that catches a ticket worktree row.
fn slash_key(path: &str) -> String {
    let mut chars: Vec<char> = path
        .chars()
        .map(|value| if value == '\\' { '/' } else { value })
        .collect();
    while chars.len() > 1 && chars.last() == Some(&'/') {
        chars.pop();
    }
    norm(&chars.into_iter().collect::<String>())
}

fn matches_worktree(worktree: &str, project: &str) -> bool {
    let worktree = slash_key(worktree);
    let project = slash_key(project);
    worktree == project || worktree.starts_with(&format!("{project}/"))
}

fn parse_findings_file(content: &str, kind: &str) -> Vec<Value> {
    let without_h1 = leading_h1_re().replace(content, "");
    if without_h1.trim() == "No findings." {
        return Vec::new();
    }

    struct Current {
        severity: &'static str,
        title: String,
        status_line: Option<String>,
    }

    fn flush(current: &mut Option<Current>, findings: &mut Vec<Value>, kind: &str) {
        let Some(entry) = current.take() else {
            return;
        };
        let status = entry
            .status_line
            .as_deref()
            .and_then(|line| status_re().captures(line))
            .map_or_else(|| "open".to_owned(), |captures| captures[1].to_lowercase());
        findings.push(json!({
            "sev": entry.severity,
            "title": entry.title,
            "status": status,
            "kind": kind,
        }));
    }

    let mut findings = Vec::new();
    let mut category: Option<&'static str> = None;
    let mut current: Option<Current> = None;
    for line in content.split('\n') {
        if let Some(captures) = category_re().captures(line) {
            category = Some(match &captures[1] {
                "Blocker" => "P0",
                "Major" => "P1",
                "Minor" => "P2",
                _ => "P3",
            });
            continue;
        }
        if let Some(captures) = p_heading_re().captures(line) {
            flush(&mut current, &mut findings, kind);
            current = Some(Current {
                severity: match &captures[1] {
                    "0" => "P0",
                    "1" => "P1",
                    "2" => "P2",
                    _ => "P3",
                },
                title: captures[2].trim().to_owned(),
                status_line: None,
            });
            continue;
        }
        if let Some(captures) = f_heading_re().captures(line) {
            flush(&mut current, &mut findings, kind);
            current = Some(Current {
                severity: category.unwrap_or("P3"),
                title: captures[1].trim().to_owned(),
                status_line: None,
            });
            continue;
        }
        if let Some(entry) = current.as_mut() {
            if entry.status_line.is_none() && !line.trim().is_empty() {
                entry.status_line = Some(line.trim().to_owned());
            }
        }
    }
    flush(&mut current, &mut findings, kind);
    findings
}

// --- compiled patterns ----------------------------------------------------

fn ahead_behind_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\+([0-9]+) -([0-9]+)").expect("constant regex is valid"))
}

fn phase2_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^## Phase 2.*$").expect("constant regex is valid"))
}

fn phase3_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^## Phase 3.*$").expect("constant regex is valid"))
}

fn json_blob_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)\{.*\}").expect("constant regex is valid"))
}

fn ledger_separator_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\|\s*-+\s*\|").expect("constant regex is valid"))
}

fn artifact_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").expect("constant regex is valid"))
}

fn session_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_-]+$").expect("constant regex is valid"))
}

fn sha_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[0-9a-f]{7,40}$").expect("constant regex is valid"))
}

fn preexisting_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^preexisting").expect("constant regex is valid"))
}

fn p_heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^#{1,3}\s+P([0-3])\s+—\s+(.+)$").expect("constant regex is valid")
    })
}

fn category_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^##\s+(Blocker|Major|Minor|Nit)\s*$").expect("constant regex is valid")
    })
}

fn f_heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^###\s+F[0-9]+\.\s+(.+)$").expect("constant regex is valid"))
}

fn status_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^Status:\s*(open|fixed|wontfix)\b").expect("constant regex is valid")
    })
}

fn leading_h1_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^#[^\n]*\n?").expect("constant regex is valid"))
}

#[cfg(test)]
mod tests {
    use super::{
        ProjectsDeps, ProjectsState, SummaryCall, SummaryModel, delete_projects, get_projects,
        get_review, get_review_file, get_status, get_summary, post_git, post_projects, put_order,
    };
    use axum::body::{Body, to_bytes};
    use axum::extract::{RawQuery, State};
    use axum::http::{Method, Request, header};
    use axum::response::Response;
    use serde_json::{Value, json};
    use std::fs;
    use std::future::Future;
    use std::path::{Path, PathBuf};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "http-projects-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn state_dir(&self) -> PathBuf {
            let dir = self.path("state");
            fs::create_dir_all(&dir).unwrap();
            dir
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            force_remove(&self.0);
        }
    }

    /// git writes loose objects read-only, which Windows refuses to unlink.
    fn force_remove(path: &Path) {
        let Ok(entries) = fs::read_dir(path) else {
            let _ = fs::remove_file(path);
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let child = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                force_remove(&child);
            } else {
                if let Ok(metadata) = fs::metadata(&child) {
                    let mut permissions = metadata.permissions();
                    permissions.set_readonly(false);
                    let _ = fs::set_permissions(&child, permissions);
                }
                let _ = fs::remove_file(&child);
            }
        }
        let _ = fs::remove_dir(path);
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git is installed");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    const IDENTITY: [&str; 6] = [
        "-c",
        "user.email=x@x.com",
        "-c",
        "user.name=x",
        "-c",
        "commit.gpgsign=false",
    ];

    fn init_repo(dir: &Path) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let output = std::process::Command::new("git")
            .args(["-c", "init.defaultBranch=main", "init", "-q"])
            .arg(dir)
            .output()
            .expect("git is installed");
        assert!(
            output.status.success(),
            "git init: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        fs::write(dir.join("f.txt"), "x").unwrap();
        let mut add = IDENTITY.to_vec();
        add.extend(["add", "."]);
        git(dir, &add);
        let mut commit = IDENTITY.to_vec();
        commit.extend(["commit", "-q", "-m", "init"]);
        git(dir, &commit);
        dir.to_path_buf()
    }

    fn commit_all(dir: &Path, message: &str) {
        let mut add = IDENTITY.to_vec();
        add.extend(["add", "."]);
        git(dir, &add);
        let mut commit = IDENTITY.to_vec();
        commit.extend(["commit", "-q", "-m", message]);
        git(dir, &commit);
    }

    struct StubCall {
        replies: Mutex<Vec<Result<String, String>>>,
        prompts: Mutex<Vec<String>>,
    }

    impl StubCall {
        fn new(replies: Vec<Result<String, String>>) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(replies),
                prompts: Mutex::new(Vec::new()),
            })
        }

        fn call_count(&self) -> usize {
            self.prompts.lock().unwrap().len()
        }

        fn prompt(&self, index: usize) -> String {
            self.prompts.lock().unwrap()[index].clone()
        }
    }

    impl SummaryCall for StubCall {
        fn call<'a>(
            &'a self,
            prompt: &'a str,
            _model: &'a SummaryModel,
        ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
            self.prompts.lock().unwrap().push(prompt.to_owned());
            let reply = {
                let mut replies = self.replies.lock().unwrap();
                if replies.is_empty() {
                    Ok(String::new())
                } else {
                    replies.remove(0)
                }
            };
            Box::pin(async move { reply })
        }
    }

    fn deps(fixture: &Fixture, call: Arc<dyn SummaryCall>) -> ProjectsDeps {
        ProjectsDeps {
            state_dir: fixture.state_dir(),
            cache_dir: fixture.path("cache"),
            home: fixture.path("home"),
            cwd: fixture.0.clone(),
            drive_cwds: Vec::new(),
            git_bin: "git".to_owned(),
            git_timeout_ms: 60_000,
            review_dir: None,
            claude_bin: None,
            ollama_bin: None,
            codex_bin: None,
            summary_call: call,
        }
    }

    fn state(fixture: &Fixture, call: Arc<dyn SummaryCall>) -> ProjectsState {
        ProjectsState {
            deps: Arc::new(deps(fixture, call)),
            lock: Arc::new(Mutex::new(())),
        }
    }

    fn run<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn json_request(method: Method, body: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap()
    }

    fn empty_request(method: Method) -> Request<Body> {
        Request::builder()
            .method(method)
            .body(Body::empty())
            .unwrap()
    }

    async fn collect(response: Response) -> (u16, Value) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn query(pairs: &[(&str, &str)]) -> Option<String> {
        Some(
            pairs
                .iter()
                .map(|(key, value)| format!("{key}={}", encode(value)))
                .collect::<Vec<_>>()
                .join("&"),
        )
    }

    fn encode(value: &str) -> String {
        value
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b':')
                {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect()
    }

    async fn projects(state: &ProjectsState) -> (u16, Value) {
        collect(get_projects(State(state.clone())).await).await
    }

    async fn status(state: &ProjectsState, pairs: &[(&str, &str)]) -> (u16, Value) {
        collect(get_status(State(state.clone()), RawQuery(query(pairs))).await).await
    }

    async fn summary(state: &ProjectsState, pairs: &[(&str, &str)]) -> (u16, Value) {
        collect(get_summary(State(state.clone()), RawQuery(query(pairs))).await).await
    }

    async fn review(state: &ProjectsState, pairs: &[(&str, &str)]) -> (u16, Value) {
        collect(get_review(State(state.clone()), RawQuery(query(pairs))).await).await
    }

    async fn review_file(state: &ProjectsState, pairs: &[(&str, &str)]) -> (u16, Value) {
        collect(get_review_file(State(state.clone()), RawQuery(query(pairs))).await).await
    }

    // VERIFY: http_projects-list-lifecycle
    #[test]
    fn list_add_remove_reorder_and_prune_match_the_node_contract() {
        let fixture = Fixture::new();
        let repo = init_repo(&fixture.path("repo"));
        let other = init_repo(&fixture.path("other"));
        fs::create_dir_all(repo.join("sub")).unwrap();
        let projects_state = state(&fixture, StubCall::new(Vec::new()));
        let repo_text = repo.to_str().unwrap();
        let other_text = other.to_str().unwrap();
        run(async {
            assert_eq!(
                projects(&projects_state).await,
                (200, json!({ "projects": [] }))
            );

            // a subfolder resolves to the toplevel and never duplicates
            let (code, body) = collect(
                post_projects(
                    State(projects_state.clone()),
                    json_request(
                        Method::POST,
                        &json!({ "path": repo.join("sub").to_str().unwrap() }).to_string(),
                    ),
                )
                .await,
            )
            .await;
            assert_eq!(code, 200);
            assert_eq!(body["ok"], json!(true));
            let stored = body["projects"][0].as_str().unwrap().to_owned();
            assert_eq!(projects_state.key(&stored), projects_state.key(repo_text));
            assert!(
                !stored.ends_with('\\') && !stored.ends_with('/'),
                "{stored}"
            );

            let (_, body) = collect(
                post_projects(
                    State(projects_state.clone()),
                    json_request(Method::POST, &json!({ "path": repo_text }).to_string()),
                )
                .await,
            )
            .await;
            assert_eq!(
                body["projects"].as_array().unwrap().len(),
                1,
                "no duplicate"
            );

            collect(
                post_projects(
                    State(projects_state.clone()),
                    json_request(Method::POST, &json!({ "path": other_text }).to_string()),
                )
                .await,
            )
            .await;

            // a valid permutation keeps the stored spelling and order
            let swapped = json!({ "paths": [other_text, repo_text] }).to_string();
            let (code, body) = collect(
                put_order(
                    State(projects_state.clone()),
                    json_request(Method::PUT, &swapped),
                )
                .await,
            )
            .await;
            assert_eq!(code, 200);
            assert_eq!(body["ok"], json!(true));
            assert_eq!(
                body["projects"].as_array().unwrap().len(),
                2,
                "both projects kept"
            );

            for rejected in [
                json!({ "paths": [repo_text] }).to_string(),
                json!({ "paths": [repo_text, "/not/in/list"] }).to_string(),
                json!({ "paths": [repo_text, repo_text] }).to_string(),
                json!({ "paths": 3 }).to_string(),
                json!({}).to_string(),
            ] {
                let (code, body) = collect(
                    put_order(
                        State(projects_state.clone()),
                        json_request(Method::PUT, &rejected),
                    )
                    .await,
                )
                .await;
                assert_eq!(code, 400, "{rejected}");
                assert_eq!(body, json!({ "ok": false, "error": "not a permutation" }));
            }

            // remove of an unknown path is a no-op ok
            let (code, body) = collect(
                delete_projects(
                    State(projects_state.clone()),
                    json_request(
                        Method::DELETE,
                        &json!({ "path": fixture.path("absent").to_str().unwrap() }).to_string(),
                    ),
                )
                .await,
            )
            .await;
            assert_eq!(code, 200);
            assert_eq!(body["ok"], json!(true));
            assert_eq!(body["projects"].as_array().unwrap().len(), 2);

            // deleting the repo on disk prunes the entry and persists the prune
            force_remove(&other);
            let (_, body) = projects(&projects_state).await;
            assert_eq!(body["projects"].as_array().unwrap().len(), 1);
            let persisted: Value = serde_json::from_str(
                &fs::read_to_string(fixture.state_dir().join("projects.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(persisted.as_array().unwrap().len(), 1);

            // remove drops the remaining entry
            let (code, body) = collect(
                delete_projects(
                    State(projects_state.clone()),
                    json_request(Method::DELETE, &json!({ "path": repo_text }).to_string()),
                )
                .await,
            )
            .await;
            assert_eq!(code, 200);
            assert_eq!(body, json!({ "ok": true, "projects": [] }));
        });
    }

    // VERIFY: http_projects-route-status-matrix
    #[test]
    fn routes_report_the_node_status_codes_and_bodies() {
        let fixture = Fixture::new();
        let repo = init_repo(&fixture.path("repo"));
        let not_repo = fixture.path("notrepo");
        fs::create_dir_all(&not_repo).unwrap();
        let projects_state = state(&fixture, StubCall::new(Vec::new()));
        let repo_text = repo.to_str().unwrap();
        run(async {
            // POST rejects a non-repo directory and a missing path
            for body in [
                json!({ "path": not_repo.to_str().unwrap() }).to_string(),
                json!({ "path": fixture.path("nope").to_str().unwrap() }).to_string(),
                json!({ "path": "" }).to_string(),
                json!({ "path": 3 }).to_string(),
                json!({}).to_string(),
                json!(null).to_string(),
            ] {
                let (code, payload) = collect(
                    post_projects(
                        State(projects_state.clone()),
                        json_request(Method::POST, &body),
                    )
                    .await,
                )
                .await;
                assert_eq!(code, 400, "{body}");
                assert_eq!(
                    payload,
                    json!({ "ok": false, "error": "not a git repository" })
                );
            }
            // absent content type with an empty body has no `path` at all
            let (code, _) = collect(
                post_projects(State(projects_state.clone()), empty_request(Method::POST)).await,
            )
            .await;
            assert_eq!(code, 400);

            // DELETE without a string path is the path.resolve TypeError
            let (code, payload) = collect(
                delete_projects(State(projects_state.clone()), empty_request(Method::DELETE)).await,
            )
            .await;
            assert_eq!(code, 500);
            assert_eq!(
                payload["message"],
                json!("The \"paths[0]\" argument must be of type string. Received undefined")
            );
            let (code, payload) = collect(
                delete_projects(
                    State(projects_state.clone()),
                    json_request(Method::DELETE, &json!({ "path": [repo_text] }).to_string()),
                )
                .await,
            )
            .await;
            assert_eq!(code, 500);
            assert_eq!(
                payload["message"],
                json!(
                    "The \"paths[0]\" argument must be of type string. \
Received an instance of Array"
                )
            );

            // status: missing / empty path is 400, unlisted is 404
            for pairs in [&[][..], &[("path", "")][..]] {
                let (code, payload) = status(&projects_state, pairs).await;
                assert_eq!(code, 400);
                assert_eq!(payload, json!({ "error": "path required" }));
            }
            let (code, payload) = status(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(code, 404);
            assert_eq!(payload, json!({ "error": "not found" }));
            let (code, payload) =
                status(&projects_state, &[("path", repo_text), ("path", repo_text)]).await;
            assert_eq!(code, 500, "Fastify's repeated query array throws");
            assert_eq!(
                payload["message"],
                json!(
                    "The \"paths[0]\" argument must be of type string. \
Received an instance of Array"
                )
            );

            // git: missing or unknown op is 400, unlisted path is 404
            for body in [
                json!({ "path": repo_text, "op": "push" }).to_string(),
                json!({ "path": repo_text }).to_string(),
                json!({}).to_string(),
            ] {
                let (code, payload) = collect(
                    post_git(
                        State(projects_state.clone()),
                        json_request(Method::POST, &body),
                    )
                    .await,
                )
                .await;
                assert_eq!(code, 400, "{body}");
                assert_eq!(
                    payload,
                    json!({ "ok": false, "error": "path and op (fetch|rebase|sync) required" })
                );
            }
            let (code, payload) = collect(
                post_git(
                    State(projects_state.clone()),
                    json_request(
                        Method::POST,
                        &json!({ "path": repo_text, "op": "fetch" }).to_string(),
                    ),
                )
                .await,
            )
            .await;
            assert_eq!(code, 404);
            assert_eq!(payload, json!({ "ok": false, "error": "not found" }));

            // summary: the same path gate
            let (code, payload) = summary(&projects_state, &[]).await;
            assert_eq!(code, 400);
            assert_eq!(payload, json!({ "error": "path required" }));
            let (code, _) = summary(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(code, 404);

            // review is disabled until PROJECT_REVIEW_DIR is set
            let (code, _) = review(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(code, 404);
            let (code, payload) = review_file(&projects_state, &[("rel", "a.md")]).await;
            assert_eq!(code, 400);
            assert_eq!(
                payload,
                json!({ "ok": false, "error": "project review not configured" })
            );
        });
    }

    // VERIFY: http_projects-status-and-git-op
    #[test]
    fn status_reports_porcelain_fields_and_git_op_surfaces_git_errors() {
        let fixture = Fixture::new();
        let repo = init_repo(&fixture.path("repo"));
        let projects_state = state(&fixture, StubCall::new(Vec::new()));
        let repo_text = repo.to_str().unwrap();
        run(async {
            collect(
                post_projects(
                    State(projects_state.clone()),
                    json_request(Method::POST, &json!({ "path": repo_text }).to_string()),
                )
                .await,
            )
            .await;

            // one staged file, one modified file, one untracked file
            fs::write(repo.join("staged.txt"), "s").unwrap();
            git(&repo, &["add", "staged.txt"]);
            fs::write(repo.join("f.txt"), "modified").unwrap();
            fs::write(repo.join("untracked.txt"), "u").unwrap();

            let (code, body) = status(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(code, 200);
            assert_eq!(body["path"], json!(repo_text));
            assert_eq!(body["branch"], json!("main"));
            assert_eq!(body["upstream"], Value::Null);
            assert_eq!(body["ahead"], json!(0));
            assert_eq!(body["behind"], json!(0));
            assert_eq!(body["staged"], json!(1));
            assert_eq!(body["modified"], json!(1));
            assert_eq!(body["untracked"], json!(1));
            assert_eq!(body["conflicted"], json!(0));
            assert_eq!(body["stash"], json!(0));
            assert_eq!(body["lastCommit"]["subject"], json!("init"));

            // rebase without an upstream fails, and the message keeps the Node
            // `git <args> failed: Command failed: ...` chain
            let (code, payload) = collect(
                post_git(
                    State(projects_state.clone()),
                    json_request(
                        Method::POST,
                        &json!({ "path": repo_text, "op": "rebase" }).to_string(),
                    ),
                )
                .await,
            )
            .await;
            assert_eq!(code, 200);
            assert_eq!(payload["ok"], json!(false));
            let message = payload["error"].as_str().unwrap();
            assert!(
                message.starts_with("git rebase failed: Command failed: git -C "),
                "{message}"
            );
            assert!(message.contains("rebase"), "{message}");

            // fetch with no remotes succeeds
            let (code, payload) = collect(
                post_git(
                    State(projects_state.clone()),
                    json_request(
                        Method::POST,
                        &json!({ "path": repo_text, "op": "fetch" }).to_string(),
                    ),
                )
                .await,
            )
            .await;
            assert_eq!(code, 200);
            assert_eq!(payload, json!({ "ok": true }));
        });
    }

    // VERIFY: http_projects-summary-rungs
    #[test]
    fn summary_falls_back_deterministically_and_caches_the_llm_rung() {
        let fixture = Fixture::new();
        let repo = init_repo(&fixture.path("repo"));
        let repo_text = repo.to_str().unwrap();
        let call = StubCall::new(vec![
            Ok(json!({ "committed": ["did x"], "uncommitted": ["changed y"] }).to_string()),
            Ok("not json".to_owned()),
        ]);
        let projects_state = state(&fixture, call.clone());
        run(async {
            collect(
                post_projects(
                    State(projects_state.clone()),
                    json_request(Method::POST, &json!({ "path": repo_text }).to_string()),
                )
                .await,
            )
            .await;

            // no summariser configured -> deterministic, never calls the LLM
            let (code, body) = summary(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(code, 200);
            assert_eq!(body["scope"], json!("recent"));
            assert_eq!(body["committed"], json!(["init"]));
            assert_eq!(body["uncommitted"], json!([]));
            assert_eq!(body["source"], json!("deterministic"));
            assert_eq!(
                body["llm"],
                json!({ "ok": false, "reason": "no-summariser" })
            );
            assert_eq!(call.call_count(), 0);

            // configured summariser without its binary stays deterministic
            write_summariser(&fixture, "opus", "claude");
            let (_, body) = summary(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(
                body["llm"],
                json!({ "ok": false, "reason": "no-summariser" })
            );

            // binary configured -> LLM result, then a cache hit that skips the call
            let mut with_bin = deps(&fixture, call.clone());
            with_bin.claude_bin = Some(fixture.path("claude"));
            let projects_state = ProjectsState {
                deps: Arc::new(with_bin),
                lock: Arc::new(Mutex::new(())),
            };
            let (_, first) = summary(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(first["source"], json!("llm"));
            assert_eq!(first["model"], json!("opus"));
            assert_eq!(first["committed"], json!(["did x"]));
            assert_eq!(call.call_count(), 1);
            assert!(call.prompt(0).contains("## Commits (recent)"));
            assert!(first.get("cached").is_none());

            let (_, second) = summary(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(second["cached"], json!(true));
            assert_eq!(call.call_count(), 1, "a cache hit skips the model call");

            // a changed working tree busts the cache and re-calls the model
            fs::write(repo.join("new.txt"), "x").unwrap();
            let (_, third) = summary(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(call.call_count(), 2);
            assert_eq!(third["source"], json!("deterministic"), "unparsable JSON");
            assert_eq!(third["llm"], json!({ "ok": false, "error": Value::Null }));

            // an error from the provider is carried through as llm.error
            let failing = StubCall::new(vec![Err("boom".to_owned())]);
            let mut with_bin = deps(&fixture, failing.clone());
            with_bin.claude_bin = Some(fixture.path("claude"));
            let failing_state = ProjectsState {
                deps: Arc::new(with_bin),
                lock: Arc::new(Mutex::new(())),
            };
            fs::write(repo.join("newer.txt"), "x").unwrap();
            let (_, failed) = summary(&failing_state, &[("path", repo_text)]).await;
            assert_eq!(failed["source"], json!("deterministic"));
            assert_eq!(failed["llm"], json!({ "ok": false, "error": "boom" }));
        });
    }

    fn write_summariser(fixture: &Fixture, id: &str, group: &str) {
        fs::write(
            fixture.state_dir().join("models.json"),
            json!({
                "models": [{ "id": id, "group": group, "label": id, "enabled": true }],
                "defaultModel": id,
                "summariserModel": id,
            })
            .to_string(),
        )
        .unwrap();
    }

    // VERIFY: http_projects-review-ledger
    #[test]
    fn review_routes_match_the_ledger_and_findings_contract() {
        let fixture = Fixture::new();
        let repo = init_repo(&fixture.path("repo"));
        let repo_text = repo.to_str().unwrap();
        let head = git(&repo, &["rev-parse", "HEAD"]);
        let review_dir = fixture.path("review");
        fs::create_dir_all(&review_dir).unwrap();
        fs::write(repo.join("g.txt"), "x").unwrap();
        commit_all(&repo, "g");

        write_run(
            &review_dir,
            "sid-fformat",
            "introduced.md",
            "# F-format legacy findings\n\n## Blocker\n\n### F1. Something severe (CONFIRMED)\n- detail\n\n## Minor\n\n### F2. Something minor\n- detail\n",
        );
        write_run(
            &review_dir,
            "sid-legacy",
            "introduced.md",
            "# Introduced findings\n\n## P1 — Something bad\n`config/foo.js:8` description.\n\n## P2 — Another issue\nSome other text.\n",
        );
        write_run(
            &review_dir,
            "sid-legacy",
            "preexisting.md",
            "# Preexisting findings\n\n## P0 — Old bug already there\nStatus: wontfix — acceptable risk\n",
        );
        write_run(
            &review_dir,
            "sid-new",
            "introduced.md",
            "# Introduced findings\n\n## P2 — Race condition on save\nStatus: open\n\nCONFIRMED via test run.\n\n## P1 — Second finding\nStatus: fixed — abc1234\n",
        );
        write_run(
            &review_dir,
            "sid-new",
            "preexisting.md",
            "# P\n\nNo findings.\n",
        );

        let worktree = repo_text.replace('\\', "/");
        fs::write(
            review_dir.join("project-review-log.md"),
            format!(
                "# Project Review Log\n\n\
| Session ID | Worktree | Baseline SHA | Target SHA | Started at | Completed at | Harness | Model | Effort | Status | Artifacts |\n\
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n\
| sid-fformat | {worktree} | none | deadbeef1 | t1 | t2 | Claude Code | claude-opus-5-5 | unknown | DONE | [report](sid-fformat/reports/review.md), [findings](sid-fformat/findings/introduced.md) |\n\
| sid-legacy | {worktree} | none | deadbeef2 | t1 | t2 | Codex | unknown | unknown | DONE | [report](sid-legacy/reports/review.md) |\n\
| sid-new | {worktree}/sub | {head} | {head} | t1 | t2 | Claude Code | claude-sonnet-5 | unknown | DONE | [report](sid-new/reports/review.md) |\n\
| sid-blocked | /some/other/repo | none | cafef00d | t1 |  | Codex | unknown | unknown | BLOCKED | |\n"
            ),
        )
        .unwrap();

        let mut base = deps(&fixture, StubCall::new(Vec::new()));
        base.review_dir = Some(review_dir.clone());
        let projects_state = ProjectsState {
            deps: Arc::new(base),
            lock: Arc::new(Mutex::new(())),
        };
        run(async {
            // the status route keeps the hasProject gate
            let (code, _) = review(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(code, 404);
            collect(
                post_projects(
                    State(projects_state.clone()),
                    json_request(Method::POST, &json!({ "path": repo_text }).to_string()),
                )
                .await,
            )
            .await;

            let (code, body) = review(&projects_state, &[("path", repo_text)]).await;
            assert_eq!(code, 200);
            assert_eq!(body["enabled"], json!(true));
            let runs = body["runs"].as_array().unwrap();
            assert_eq!(runs.len(), 3, "trailing slash and subdir both match");
            let sessions: Vec<&str> = runs
                .iter()
                .map(|run| run["sessionId"].as_str().unwrap())
                .collect();
            assert_eq!(sessions, ["sid-new", "sid-legacy", "sid-fformat"]);

            let severities = |run: &Value| -> Vec<(String, String, String)> {
                run["findings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|finding| {
                        (
                            finding["sev"].as_str().unwrap().to_owned(),
                            finding["status"].as_str().unwrap().to_owned(),
                            finding["kind"].as_str().unwrap().to_owned(),
                        )
                    })
                    .collect()
            };
            assert_eq!(
                severities(&runs[2]),
                [
                    ("P0".to_owned(), "open".to_owned(), "introduced".to_owned()),
                    ("P2".to_owned(), "open".to_owned(), "introduced".to_owned()),
                ]
            );
            assert_eq!(
                severities(&runs[1]),
                [
                    ("P1".to_owned(), "open".to_owned(), "introduced".to_owned()),
                    ("P2".to_owned(), "open".to_owned(), "introduced".to_owned()),
                    (
                        "P0".to_owned(),
                        "wontfix".to_owned(),
                        "preexisting".to_owned()
                    ),
                ]
            );
            assert_eq!(
                runs[0]["findings"][0]["rel"],
                json!("sid-new/findings/introduced.md")
            );
            assert_eq!(
                runs[0]["artifacts"][0],
                json!({ "label": "report", "rel": "sid-new/reports/review.md" })
            );

            assert_eq!(body["latest"]["status"], json!("DONE"));
            assert_eq!(body["latest"]["target"], json!(head));
            assert_eq!(body["latest"]["commitsSince"], json!(1));
            assert_eq!(
                body["latest"]["counts"],
                json!({ "P0": 2, "P1": 2, "P2": 3, "P3": 0, "open": 5, "resolved": 2 })
            );

            // a BLOCKED latest run never asks git for a commit count; the route
            // itself still gates on the stored project list
            let blocked = projects_state.review_status("/some/other/repo/");
            assert_eq!(blocked["latest"]["status"], json!("BLOCKED"));
            assert_eq!(blocked["latest"]["commitsSince"], Value::Null);
            let (code, _) = review(&projects_state, &[("path", "/some/other/repo/")]).await;
            assert_eq!(code, 404);

            // no matching row -> empty runs, null latest
            let empty = projects_state.review_status("/unrelated/repo");
            assert_eq!(
                empty,
                json!({ "enabled": true, "runs": [], "latest": null })
            );

            // file route: valid artifact, then each rejection
            let (code, payload) = review_file(
                &projects_state,
                &[("rel", "sid-new/findings/introduced.md")],
            )
            .await;
            assert_eq!(code, 200);
            assert!(
                payload["content"]
                    .as_str()
                    .unwrap()
                    .contains("Race condition on save")
            );
            for (rel, error) in [
                ("../outside.md", "path outside project review dir"),
                ("sid-new/findings/introduced.txt", "bad path"),
            ] {
                let (code, payload) = review_file(&projects_state, &[("rel", rel)]).await;
                assert_eq!(code, 400, "{rel}");
                assert_eq!(payload, json!({ "ok": false, "error": error }));
            }
            let (code, payload) = review_file(&projects_state, &[]).await;
            assert_eq!(code, 400);
            assert_eq!(payload, json!({ "ok": false, "error": "bad path" }));
            let (code, payload) =
                review_file(&projects_state, &[("rel", "sid-new/findings/missing.md")]).await;
            assert_eq!(code, 404);
            assert_eq!(payload, json!({ "ok": false, "error": "not found" }));
        });
    }

    fn write_run(dir: &Path, session: &str, name: &str, content: &str) {
        let findings = dir.join(session).join("findings");
        fs::create_dir_all(&findings).unwrap();
        fs::write(findings.join(name), content).unwrap();
    }
}
