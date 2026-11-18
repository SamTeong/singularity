//! Git lifecycle for board tasks: the [`GitPort`] seam plus the three helpers
//! `server/tasks.mjs` exposes (`git` `:66-76`, `isGitWorkTree` `:77-80`,
//! `cleanupGitTask` `:100-113`, `ensureWorktree` `:119-126`).
//!
//! The port is intentionally **blocking**: every caller in
//! [`crate::task_service`] runs it inside `spawn_blocking`, which is exactly
//! what Node's async `execFile` achieved without stalling the event loop. A
//! hung credential helper is bounded by [`DEFAULT_GIT_TIMEOUT_MS`]
//! (`SING_GIT_TIMEOUT_MS`) and the three non-interactive environment flags.
//!
//! Error text: Node wraps a failed call as `git <args> failed: <message>`
//! (`tasks.mjs:74`). The `<message>` here is the bridge's stderr, else its
//! `error` field — the full `execFile` envelope (`Command failed: <bin> …`) is
//! NOT reproduced (documented deviation; no caller parses it).
//!
//! This module deliberately does not share a runner with
//! [`crate::http_projects`]: that module already has its own git primitive and
//! an unrequested cross-module refactor is out of scope.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use crate::task_service::{Task, TaskKind};

/// `GIT_TIMEOUT_MS` fallback (`tasks.mjs:54`).
pub const DEFAULT_GIT_TIMEOUT_MS: u64 = 10_000;
/// `maxBuffer: 1024 * 1024` (`tasks.mjs:71`).
const GIT_MAX_BUFFER: f64 = 1024.0 * 1024.0;
/// The retry delay before the second `worktree remove` (`tasks.mjs:106`).
const WORKTREE_RETRY_DELAY: Duration = Duration::from_millis(1000);

// VERIFY: task-git-port
/// The one git primitive the task domain needs. Implemented by [`NativeGit`]
/// for the daemon and by a recorder in tests.
pub trait GitPort: Send + Sync {
    /// Runs `git -C <repo> -c core.askpass= <args>` and returns trimmed stdout.
    /// The error text is `git <args> failed: <detail>`.
    fn git(&self, repo: &str, args: &[&str]) -> Result<String, String>;
}

// VERIFY: task-git-native
/// `GIT_BIN` + `SING_GIT_TIMEOUT_MS` (`tasks.mjs:54-56`).
pub struct NativeGit {
    pub bin: String,
    pub timeout_ms: u64,
}

impl NativeGit {
    pub fn new(bin: impl Into<String>, timeout_ms: u64) -> Self {
        Self {
            bin: bin.into(),
            timeout_ms,
        }
    }
}

impl GitPort for NativeGit {
    fn git(&self, repo: &str, args: &[&str]) -> Result<String, String> {
        let mut argv: Vec<String> = vec![
            "-C".to_owned(),
            repo.to_owned(),
            "-c".to_owned(),
            "core.askpass=".to_owned(),
        ];
        argv.extend(args.iter().map(|arg| (*arg).to_owned()));
        let mut env = json!({
            "GIT_TERMINAL_PROMPT": "0",
            "GCM_INTERACTIVE": "never",
            "GIT_ASKPASS": "echo",
        });
        if crate::shadow::enabled() {
            env["GIT_OPTIONAL_LOCKS"] = json!("0"); // shadow: never take the index lock
        }
        let payload = crate::oneshot::run_git(
            Some(&self.bin),
            &Value::Array(argv.into_iter().map(Value::String).collect()),
            Some(self.timeout_ms as f64),
            Some(GIT_MAX_BUFFER),
            Some(&env),
        );
        if payload.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(payload
                .get("stdout")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned());
        }
        let detail = payload
            .get("stderr")
            .and_then(Value::as_str)
            .filter(|stderr| !stderr.is_empty())
            .or_else(|| payload.get("error").and_then(Value::as_str))
            .unwrap_or("");
        if detail.is_empty() {
            Err(format!("git {} failed", args.join(" ")))
        } else {
            Err(format!("git {} failed: {detail}", args.join(" ")))
        }
    }
}

// VERIFY: task-git-is-work-tree
/// `isGitWorkTree(repo)` (`tasks.mjs:77-80`): `rev-parse
/// --is-inside-work-tree` must print exactly `true`; any error is `false`.
pub fn is_git_work_tree(git: &dyn GitPort, repo: &str) -> bool {
    matches!(
        git.git(repo, &["rev-parse", "--is-inside-work-tree"]),
        Ok(stdout) if stdout == "true"
    )
}

// VERIFY: task-git-cleanup
/// `cleanupGitTask(t)` (`tasks.mjs:100-113`): remove the worktree (one retry
/// after a beat — a just-killed pty may still hold Windows file locks), then
/// safe-delete the branch. `branch -d` refuses an unmerged branch, so that
/// error is deliberately swallowed and the branch is kept.
pub fn cleanup_git_task(git: &dyn GitPort, task: &Task, log: &dyn Fn(&str)) {
    if task.kind == TaskKind::Plain {
        return;
    }
    if let Some(worktree) = task.worktree.as_deref() {
        if Path::new(worktree).exists() {
            if let Err(error) = git.git(&task.repo, &["worktree", "remove", "--force", worktree]) {
                log(&format!("worktree remove failed — retrying once: {error}"));
                std::thread::sleep(WORKTREE_RETRY_DELAY);
                if let Err(error) =
                    git.git(&task.repo, &["worktree", "remove", "--force", worktree])
                {
                    log(&format!(
                        "worktree remove retry failed (already gone?): {error}"
                    ));
                }
            }
        }
        let branch = task.branch.as_deref().unwrap_or("");
        let _ = git.git(&task.repo, &["branch", "-d", branch]);
    }
}

// VERIFY: task-git-ensure-worktree
/// `ensureWorktree(t)` (`tasks.mjs:119-126`): no-op for a plain task or a
/// present worktree; otherwise reuse a surviving `refs/heads/<branch>`, else
/// branch fresh off `baseBranch`. Returns the git failure so the caller can log
/// it, like Node's unhandled rejection in the recovery path.
pub fn ensure_worktree(git: &dyn GitPort, task: &Task, worktrees_dir: &Path) -> Result<(), String> {
    if task.kind == TaskKind::Plain {
        return Ok(());
    }
    let Some(worktree) = task.worktree.as_deref() else {
        return Ok(());
    };
    if Path::new(worktree).exists() {
        return Ok(());
    }
    std::fs::create_dir_all(worktrees_dir).map_err(|error| error.to_string())?;
    let branch = task.branch.as_deref().unwrap_or("");
    let branch_exists = git
        .git(
            &task.repo,
            &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
        )
        .is_ok();
    if branch_exists {
        git.git(&task.repo, &["worktree", "add", worktree, branch])?;
    } else {
        let base = task.base_branch.as_deref().unwrap_or("");
        git.git(
            &task.repo,
            &["worktree", "add", worktree, "-b", branch, base],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_service::test_support::{fixture_git_repo, task};
    use std::sync::{Arc, Mutex};

    /// Records every call and answers the two read-only probes the helpers use.
    struct FakeGit {
        calls: Mutex<Vec<Vec<String>>>,
        branch_exists: bool,
        inside_work_tree: bool,
    }

    impl FakeGit {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                branch_exists: true,
                inside_work_tree: true,
            })
        }

        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl GitPort for FakeGit {
        fn git(&self, _repo: &str, args: &[&str]) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push(args.iter().map(|arg| (*arg).to_owned()).collect());
            match args {
                ["rev-parse", "--is-inside-work-tree"] => Ok(if self.inside_work_tree {
                    "true"
                } else {
                    "false"
                }
                .to_owned()),
                ["rev-parse", "--verify", _] => {
                    if self.branch_exists {
                        Ok("abc123".to_owned())
                    } else {
                        Err("no such branch".to_owned())
                    }
                }
                _ => Ok(String::new()),
            }
        }
    }

    // VERIFY: task-git-tests-work-tree
    #[test]
    fn work_tree_probe_requires_exactly_true() {
        let git = FakeGit::new();
        assert!(is_git_work_tree(git.as_ref(), "/repo"));
        let outside = Arc::new(FakeGit {
            calls: Mutex::new(Vec::new()),
            branch_exists: true,
            inside_work_tree: false,
        });
        assert!(!is_git_work_tree(outside.as_ref(), "/repo"));
    }

    // VERIFY: task-git-tests-cleanup-plain
    #[test]
    fn cleanup_is_a_no_op_for_plain_tasks() {
        let git = FakeGit::new();
        let mut plain = task("t1");
        plain.kind = TaskKind::Plain;
        plain.worktree = None;
        plain.branch = None;
        cleanup_git_task(git.as_ref(), &plain, &|_| {});
        assert!(git.calls().is_empty());
    }

    // VERIFY: task-git-tests-ensure-reuse
    #[test]
    fn ensure_worktree_reuses_an_existing_branch_and_skips_a_present_dir() {
        let git = FakeGit::new();
        let root = std::env::temp_dir().join(format!(
            "singularity-task-git-ensure-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let worktrees = root.join(".worktrees");
        let mut t = task("t2");
        t.kind = TaskKind::Git;
        t.repo = root.to_string_lossy().into_owned();
        t.branch = Some("task/abcd1234".to_owned());
        t.base_branch = Some("main".to_owned());
        t.worktree = Some(worktrees.join("abcd1234").to_string_lossy().into_owned());

        assert_eq!(ensure_worktree(git.as_ref(), &t, &worktrees), Ok(()));
        let calls = git.calls();
        assert_eq!(
            calls.last().unwrap(),
            &[
                "worktree",
                "add",
                t.worktree.as_deref().unwrap(),
                "task/abcd1234"
            ]
        );

        // already present → no further git call
        std::fs::create_dir_all(t.worktree.as_deref().unwrap()).unwrap();
        let before = git.calls().len();
        assert_eq!(ensure_worktree(git.as_ref(), &t, &worktrees), Ok(()));
        assert_eq!(git.calls().len(), before);
        let _ = std::fs::remove_dir_all(&root);
    }

    // VERIFY: task-git-tests-ensure-create
    #[test]
    fn ensure_worktree_branches_fresh_when_the_branch_is_gone() {
        let git = Arc::new(FakeGit {
            calls: Mutex::new(Vec::new()),
            branch_exists: false,
            inside_work_tree: true,
        });
        let root = std::env::temp_dir().join(format!(
            "singularity-task-git-create-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let worktrees = root.join(".worktrees");
        let mut t = task("t3");
        t.kind = TaskKind::Git;
        t.repo = root.to_string_lossy().into_owned();
        t.branch = Some("task/ffff0000".to_owned());
        t.base_branch = Some("main".to_owned());
        t.worktree = Some(worktrees.join("ffff0000").to_string_lossy().into_owned());

        assert_eq!(ensure_worktree(git.as_ref(), &t, &worktrees), Ok(()));
        assert_eq!(
            git.calls().last().unwrap(),
            &[
                "worktree",
                "add",
                t.worktree.as_deref().unwrap(),
                "-b",
                "task/ffff0000",
                "main"
            ]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // VERIFY: task-git-tests-real-merged
    #[test]
    fn real_git_cleanup_deletes_a_merged_branch_and_keeps_an_unmerged_one() {
        let root = fixture_git_repo("cleanup");
        let git = NativeGit::new("git", 20_000);
        let repo = root.to_string_lossy().into_owned();
        let worktrees = root.join(".worktrees");
        std::fs::create_dir_all(&worktrees).unwrap();
        let worktree = worktrees.join("abcd1234");
        git.git(
            &repo,
            &[
                "worktree",
                "add",
                &worktree.to_string_lossy(),
                "-b",
                "task/abcd1234",
            ],
        )
        .unwrap();
        // Merged: the branch tip is the base tip.
        let mut t = task("t4");
        t.kind = TaskKind::Git;
        t.repo = repo.clone();
        t.branch = Some("task/abcd1234".to_owned());
        t.worktree = Some(worktree.to_string_lossy().into_owned());
        cleanup_git_task(&git, &t, &|_| {});
        assert!(!worktree.exists());
        assert!(
            git.git(
                &repo,
                &["rev-parse", "--verify", "refs/heads/task/abcd1234"]
            )
            .is_err()
        );

        // Unmerged: a commit on the branch makes `branch -d` refuse.
        let worktree2 = worktrees.join("beef0000");
        git.git(
            &repo,
            &[
                "worktree",
                "add",
                &worktree2.to_string_lossy(),
                "-b",
                "task/beef0000",
            ],
        )
        .unwrap();
        std::fs::write(worktree2.join("new.txt"), "x").unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["-C", worktree2.to_string_lossy().as_ref(), "add", "-A"])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            std::process::Command::new("git")
                .args([
                    "-C",
                    worktree2.to_string_lossy().as_ref(),
                    "-c",
                    "user.email=t@example.com",
                    "-c",
                    "user.name=T",
                    "commit",
                    "-m",
                    "unmerged",
                ])
                .status()
                .unwrap()
                .success()
        );
        t.branch = Some("task/beef0000".to_owned());
        t.worktree = Some(worktree2.to_string_lossy().into_owned());
        cleanup_git_task(&git, &t, &|_| {});
        assert!(!worktree2.exists());
        assert!(
            git.git(
                &repo,
                &["rev-parse", "--verify", "refs/heads/task/beef0000"]
            )
            .is_ok(),
            "an unmerged branch must survive cleanup"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
