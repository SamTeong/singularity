//! Native port of `server/one-shot.mjs` (`runOneShotPrompt`): run a single
//! prompt through a group's CLI and return its answer channel.
//!
//! `claude` -> stdout, a single JSON envelope ({ result, usage: {...} });
//! `codex` -> the `--output-last-agent-message` file's contents (agent chatter
//! goes to stdout, so the answer channel is the file); `ollama` -> stdout.
//!
//! Bins are injected absolute paths (`CLAUDE_BIN`/`OLLAMA_BIN`/`CODEX_BIN`; no
//! PATH fallback), `state_dir` is the Node `STATE_DIR` that holds codex's
//! temporary answer file, and `env` is applied over the inherited environment.
//! Execution uses `crate::oneshot::run_with_input` to write the prompt, close
//! stdin, and apply the Windows process, timeout, and output buffer settings.
use crate::http_projects::{SummaryCall, SummaryModel};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// `ONESHOT_TIMEOUT_MS` (`server/one-shot.mjs:22`).
const ONESHOT_TIMEOUT_MS: u64 = 120_000;
/// `ONESHOT_MAX_BUFFER` (`server/one-shot.mjs:23`), handed to `oneshot::run`.
const ONESHOT_MAX_BUFFER: f64 = 8.0 * 1024.0 * 1024.0;

// VERIFY: prompt_run.rs: pub struct PromptRunDeps
/// Everything the host must supply. The three `*_bin` fields are `agents.mjs`'
/// `resolveBin` results (`None` when unset), `state_dir` is Node's `STATE_DIR`.
#[derive(Clone)]
pub struct PromptRunDeps {
    pub claude_bin: Option<PathBuf>,
    pub ollama_bin: Option<PathBuf>,
    pub codex_bin: Option<PathBuf>,
    pub state_dir: PathBuf,
    pub env: BTreeMap<String, String>,
}

// VERIFY: prompt_run.rs: pub struct PromptRunOpts
/// `runOneShotPrompt`'s option bag; `timeout_ms: None` means Node's default.
#[derive(Clone, Default)]
pub struct PromptRunOpts {
    pub timeout_ms: Option<u64>,
    pub extra_args: Vec<String>,
}

// VERIFY: prompt_run.rs: pub struct PromptRunAnswer
/// `includeMetadata: true`'s shape: the answer channel plus the parsed `usage`
/// (`None` where Node yields `null`).
pub struct PromptRunAnswer {
    pub answer: String,
    pub usage: Option<Value>,
}

/// `execFile(bin, args, { maxBuffer, timeout })` through `oneshot::run`, with
/// the prompt on stdin (argv would overflow Windows' 32,767-char limit).
fn exec(
    bin: &Path,
    args: &[String],
    prompt: &str,
    timeout_ms: u64,
    env: &BTreeMap<String, String>,
) -> Value {
    let file = bin.to_str().unwrap_or_default();
    let argv = Value::Array(args.iter().cloned().map(Value::String).collect());
    let env = Value::Object(
        env.iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect::<Map<String, Value>>(),
    );
    crate::oneshot::run_with_input(
        Some(file),
        &argv,
        Some(timeout_ms as f64),
        Some(ONESHOT_MAX_BUFFER),
        Some(&env),
        Some(prompt),
    )
}

/// Node's `execFile` rejection message (`Command failed: <file> <args>`); a
/// spawn failure keeps `oneshot`'s own text because Node's there is the raw
/// `spawn <bin> ENOENT`.
fn failure_message(bin: &Path, args: &[String], out: &Value) -> String {
    if out["spawn_error"] == Value::Bool(true) {
        return out["error"]
            .as_str()
            .unwrap_or("one-shot: spawn failed")
            .to_owned();
    }
    format!("Command failed: {} {}", bin.display(), args.join(" "))
}

/// `codex`'s stdout JSONL scan: the last `turn.completed` event's usage
/// (`event.usage ?? event.turn?.usage ?? null`).
fn codex_usage(stdout: &str) -> Option<Value> {
    let mut usage = None;
    for line in stdout.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if event["type"] == Value::String("turn.completed".to_owned()) {
            usage = event
                .get("usage")
                .filter(|value| !value.is_null())
                .or_else(|| event.get("turn").and_then(|turn| turn.get("usage")))
                .cloned();
        }
    }
    usage
}

/// `.oneshot-<id>.txt`'s id; Node uses `crypto.randomUUID()` (v4).
fn temp_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!(
        "{nanos:x}-{:x}-{:x}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn codex_answer(
    bin: &Path,
    args: &[String],
    prompt: &str,
    tmp: &Path,
    timeout_ms: u64,
    env: &BTreeMap<String, String>,
) -> Result<PromptRunAnswer, String> {
    let out = exec(bin, args, prompt, timeout_ms, env);
    if out["ok"] != Value::Bool(true) {
        // Node's execFile rejects before `readFileSync`, so the file is unused.
        return Err(failure_message(bin, args, &out));
    }
    let answer = std::fs::read_to_string(tmp).map_err(|error| error.to_string())?;
    Ok(PromptRunAnswer {
        answer,
        usage: codex_usage(out["stdout"].as_str().unwrap_or_default()),
    })
}

pub(crate) fn run_blocking(
    deps: &PromptRunDeps,
    group: &str,
    model_id: &str,
    prompt: &str,
    opts: &PromptRunOpts,
) -> Result<PromptRunAnswer, String> {
    let configured = match group {
        "claude" => deps.claude_bin.clone(),
        "codex" => deps.codex_bin.clone(),
        "ollama" => deps.ollama_bin.clone(),
        other => return Err(format!("one-shot: unknown group '{other}'")),
    };
    let bin = configured.ok_or_else(|| format!("one-shot: {group} binary is not configured"))?;
    let timeout_ms = opts.timeout_ms.unwrap_or(ONESHOT_TIMEOUT_MS);

    if group == "claude" {
        // No --bare: it skips the credential plumbing, so every headless call
        // dies with "Not logged in".
        let mut args: Vec<String> = vec![
            "-p".to_owned(),
            "--model".to_owned(),
            model_id.to_owned(),
            "--output-format".to_owned(),
            "json".to_owned(),
            "--no-session-persistence".to_owned(),
        ];
        args.extend(opts.extra_args.iter().cloned());
        let out = exec(&bin, &args, prompt, timeout_ms, &deps.env);
        if out["ok"] != Value::Bool(true) {
            // claude puts the real reason in its JSON envelope on stdout;
            // execFile's "Command failed: <argv>" hides it.
            let reason = out["stdout"]
                .as_str()
                .and_then(|stdout| serde_json::from_str::<Value>(stdout).ok())
                .and_then(|envelope| {
                    envelope
                        .get("result")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .filter(|reason| !reason.is_empty());
            return Err(reason.unwrap_or_else(|| failure_message(&bin, &args, &out)));
        }
        let stdout = out["stdout"].as_str().unwrap_or_default().to_owned();
        let envelope = serde_json::from_str::<Value>(&stdout).ok();
        // claude can exit 0 with an error envelope (e.g. a usage limit).
        if let Some(envelope) = envelope
            .as_ref()
            .filter(|envelope| envelope.get("is_error") == Some(&Value::Bool(true)))
        {
            let text = |key: &str| {
                envelope
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(str::to_owned)
            };
            return Err(text("result")
                .or_else(|| text("subtype").filter(|subtype| subtype != "success"))
                .unwrap_or_else(|| "claude one-shot failed".to_owned()));
        }
        let usage = envelope.and_then(|envelope| envelope.get("usage").cloned());
        return Ok(PromptRunAnswer {
            answer: stdout,
            usage,
        });
    }

    if group == "codex" {
        // -s read-only + --skip-git-repo-check: a one-shot only reads its
        // prompt string, it must never be able to write.
        let state_dir = deps.state_dir.to_string_lossy().into_owned();
        let tmp = deps.state_dir.join(format!(".oneshot-{}.txt", temp_id()));
        let mut args: Vec<String> = vec![
            "exec".to_owned(),
            "-m".to_owned(),
            model_id.to_owned(),
            "-s".to_owned(),
            "read-only".to_owned(),
            "--skip-git-repo-check".to_owned(),
            "--ephemeral".to_owned(),
            "-C".to_owned(),
            state_dir,
            "-o".to_owned(),
            tmp.to_string_lossy().into_owned(),
        ];
        args.extend(opts.extra_args.iter().cloned());
        args.push("-".to_owned()); // read the prompt from stdin
        // Node's `finally`: best-effort cleanup on every path.
        let result = codex_answer(&bin, &args, prompt, &tmp, timeout_ms, &deps.env);
        let _ = std::fs::remove_file(&tmp);
        return result;
    }

    // ollama: without these, stdout carries a "Thinking..." block and terminal
    // wrap escapes that corrupt the answer.
    let args: Vec<String> = vec![
        "run".to_owned(),
        "--hidethinking".to_owned(),
        "--nowordwrap".to_owned(),
        model_id.to_owned(),
    ];
    let out = exec(&bin, &args, prompt, timeout_ms, &deps.env);
    if out["ok"] != Value::Bool(true) {
        return Err(failure_message(&bin, &args, &out));
    }
    Ok(PromptRunAnswer {
        answer: out["stdout"].as_str().unwrap_or_default().to_owned(),
        usage: None,
    })
}

// VERIFY: prompt_run.rs: pub async fn run_prompt
/// `runOneShotPrompt`'s answer channel, blocking work off the async runtime.
pub async fn run_prompt(
    deps: &PromptRunDeps,
    group: &str,
    model_id: &str,
    prompt: &str,
    opts: PromptRunOpts,
) -> Result<String, String> {
    run_prompt_with_metadata(deps, group, model_id, prompt, opts)
        .await
        .map(|answer| answer.answer)
}

// VERIFY: prompt_run.rs: pub async fn run_prompt_with_metadata
/// `runOneShotPrompt(..., { includeMetadata: true })`.
pub async fn run_prompt_with_metadata(
    deps: &PromptRunDeps,
    group: &str,
    model_id: &str,
    prompt: &str,
    opts: PromptRunOpts,
) -> Result<PromptRunAnswer, String> {
    let deps = deps.clone();
    let group = group.to_owned();
    let model_id = model_id.to_owned();
    let prompt = prompt.to_owned();
    match tokio::task::spawn_blocking(move || {
        run_blocking(&deps, &group, &model_id, &prompt, &opts)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("one-shot: prompt runner task failed".to_owned()),
    }
}

// VERIFY: prompt_run.rs: pub struct PromptRunSummary
/// `GET /api/projects/summary`'s LLM rung: `server/projects.mjs:216`
/// (`callProjectSummariser` -> `history.mjs`'s `defaultCallSummariser` with
/// `system: null`).
pub struct PromptRunSummary(pub PromptRunDeps);

// VERIFY: prompt_run.rs: impl SummaryCall for PromptRunSummary
impl SummaryCall for PromptRunSummary {
    fn call<'a>(
        &'a self,
        prompt: &'a str,
        model: &'a SummaryModel,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move {
            let raw = run_prompt(
                &self.0,
                &model.group,
                &model.id,
                prompt,
                PromptRunOpts::default(),
            )
            .await?;
            // `callClaudeSummariser` parses the envelope and answers `result`;
            // codex/ollama (and the fallthrough group) answer raw stdout.
            if model.group != "claude" {
                return Ok(raw);
            }
            let envelope: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            match envelope.get("result").and_then(Value::as_str) {
                Some(text) => Ok(text.to_owned()),
                None => Err("summariser response had no result field".to_owned()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    /// Temp dir per test; removed on drop. Never the real home or STATE_DIR.
    struct Scratch {
        dir: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "singularity-prompt-run-{tag}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch { dir }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.dir.join(name)
        }

        /// Fake CLI: `windows` is the `.cmd` body, `unix` the `sh` body.
        fn bin(&self, name: &str, windows: &str, unix: &str) -> PathBuf {
            #[cfg(windows)]
            {
                let _ = unix;
                let file = self.dir.join(format!("{name}.cmd"));
                fs::write(&file, format!("@echo off\r\n{windows}")).unwrap();
                file
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = windows;
                let file = self.dir.join(format!("{name}.sh"));
                fs::write(&file, format!("#!/bin/sh\n{unix}")).unwrap();
                fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
                file
            }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn deps(scratch: &Scratch, claude: &Path, ollama: &Path, codex: &Path) -> PromptRunDeps {
        let mut env = BTreeMap::new();
        env.insert(
            "ONESHOT_ARGS_FILE".to_owned(),
            scratch.path("args.txt").to_string_lossy().into_owned(),
        );
        PromptRunDeps {
            claude_bin: Some(claude.to_path_buf()),
            ollama_bin: Some(ollama.to_path_buf()),
            codex_bin: Some(codex.to_path_buf()),
            state_dir: scratch.dir.clone(),
            env,
        }
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    /// The argv the fake bin saw, space-joined (cmd `%*` / sh `"$*"`). cmd
    /// keeps the quoting Rust put around arguments containing spaces, so quotes
    /// are dropped before comparing against the flat expected argv.
    fn recorded_args(scratch: &Scratch) -> String {
        fs::read_to_string(scratch.path("args.txt"))
            .unwrap_or_default()
            .trim()
            .replace('"', "")
    }

    /// What the fake bin read from stdin (`more` / `cat` into `<args>.stdin`).
    fn recorded_stdin(scratch: &Scratch) -> String {
        fs::read_to_string(scratch.path("args.txt.stdin"))
            .unwrap_or_default()
            .trim()
            .to_owned()
    }

    const CLAUDE_ENVELOPE: &str =
        r#"{"result":"answer text","usage":{"input_tokens":3,"output_tokens":5}}"#;

    #[test]
    fn claude_branch_builds_read_only_argv_and_returns_the_stdout_envelope() {
        let scratch = Scratch::new("claude-ok");
        let claude = scratch.bin(
            "fake-claude",
            "echo %* > \"%ONESHOT_ARGS_FILE%\"\n\
             more > \"%ONESHOT_ARGS_FILE%.stdin\"\n\
             echo {\"result\":\"answer text\",\"usage\":{\"input_tokens\":3,\"output_tokens\":5}}\n",
            "printf '%s' \"$*\" > \"$ONESHOT_ARGS_FILE\"\n\
             cat > \"$ONESHOT_ARGS_FILE.stdin\"\n\
             echo '{\"result\":\"answer text\",\"usage\":{\"input_tokens\":3,\"output_tokens\":5}}'\n",
        );
        let deps = deps(
            &scratch,
            &claude,
            &scratch.path("unused-ollama"),
            &scratch.path("unused-codex"),
        );

        let out = block_on(run_prompt(
            &deps,
            "claude",
            "haiku",
            "summarise day",
            PromptRunOpts::default(),
        ))
        .unwrap();
        assert_eq!(out.trim_end(), CLAUDE_ENVELOPE);
        // The prompt rides stdin, never argv.
        assert_eq!(
            recorded_args(&scratch),
            "-p --model haiku --output-format json --no-session-persistence"
        );
        assert_eq!(recorded_stdin(&scratch), "summarise day");

        let meta = block_on(run_prompt_with_metadata(
            &deps,
            "claude",
            "haiku",
            "summarise day",
            PromptRunOpts::default(),
        ))
        .unwrap();
        assert_eq!(meta.answer.trim_end(), CLAUDE_ENVELOPE);
        assert_eq!(
            meta.usage,
            Some(json!({"input_tokens": 3, "output_tokens": 5}))
        );

        // extraArgs land after the fixed flags.
        block_on(run_prompt(
            &deps,
            "claude",
            "haiku",
            "p",
            PromptRunOpts {
                timeout_ms: None,
                extra_args: vec!["--boom".to_owned()],
            },
        ))
        .unwrap();
        assert_eq!(
            recorded_args(&scratch),
            "-p --model haiku --output-format json --no-session-persistence --boom"
        );
    }

    #[test]
    fn claude_branch_rejects_an_is_error_envelope_on_exit_zero() {
        let scratch = Scratch::new("claude-is-error");
        let claude = scratch.bin(
            "fake-claude-is-error",
            "echo {\"is_error\":true,\"subtype\":\"success\",\"result\":\"usage limit reached\"}\n",
            "echo '{\"is_error\":true,\"subtype\":\"success\",\"result\":\"usage limit reached\"}'\n",
        );
        let deps = deps(
            &scratch,
            &claude,
            &scratch.path("unused-ollama"),
            &scratch.path("unused-codex"),
        );
        let error = block_on(run_prompt(
            &deps,
            "claude",
            "haiku",
            "p",
            PromptRunOpts::default(),
        ))
        .unwrap_err();
        assert_eq!(error, "usage limit reached");

        // No result text: the subtype is the reason.
        let bare = scratch.bin(
            "fake-claude-is-error-bare",
            "echo {\"is_error\":true,\"subtype\":\"error_max_turns\"}\n",
            "echo '{\"is_error\":true,\"subtype\":\"error_max_turns\"}'\n",
        );
        let deps = PromptRunDeps {
            claude_bin: Some(bare),
            ..deps
        };
        let error = block_on(run_prompt(
            &deps,
            "claude",
            "haiku",
            "p",
            PromptRunOpts::default(),
        ))
        .unwrap_err();
        assert_eq!(error, "error_max_turns");

        let misleading = scratch.bin(
            "fake-claude-is-error-empty",
            "echo {\"is_error\":true,\"subtype\":\"success\",\"result\":\"\"}\n",
            "echo '{\"is_error\":true,\"subtype\":\"success\",\"result\":\"\"}'\n",
        );
        let deps = PromptRunDeps {
            claude_bin: Some(misleading),
            ..deps
        };
        let error = block_on(run_prompt(
            &deps,
            "claude",
            "haiku",
            "p",
            PromptRunOpts::default(),
        ))
        .unwrap_err();
        assert_eq!(error, "claude one-shot failed");
    }

    #[test]
    fn claude_branch_extracts_the_failure_reason_from_the_error_stdout_envelope() {
        let scratch = Scratch::new("claude-fail");
        let claude = scratch.bin(
            "fake-claude-fail",
            "echo {\"result\":\"not logged in - run /login\"}\nexit /b 1\n",
            "echo '{\"result\":\"not logged in - run /login\"}'\nexit 1\n",
        );
        let deps = deps(
            &scratch,
            &claude,
            &scratch.path("unused-ollama"),
            &scratch.path("unused-codex"),
        );
        let error = block_on(run_prompt(
            &deps,
            "claude",
            "haiku",
            "p",
            PromptRunOpts::default(),
        ))
        .unwrap_err();
        assert_eq!(error, "not logged in - run /login");
    }

    #[test]
    fn codex_branch_reads_the_output_file_parses_usage_and_cleans_up() {
        let scratch = Scratch::new("codex");
        let codex = scratch.bin(
            "fake-codex",
            "echo %* > \"%ONESHOT_ARGS_FILE%\"\n\
             setlocal\n\
             set \"out=\"\n\
             set \"prev=\"\n\
             :loop\n\
             if \"%~1\"==\"\" goto done\n\
             if \"%prev%\"==\"-o\" set \"out=%~1\"\n\
             set \"prev=%~1\"\n\
             shift\n\
             goto loop\n\
             :done\n\
             <nul set /p \"=ok\" > \"%out%\"\n\
             echo {\"type\":\"turn.started\"}\n\
             echo {\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":1}}\n",
            "printf '%s' \"$*\" > \"$ONESHOT_ARGS_FILE\"\n\
             out=\"\"\n\
             prev=\"\"\n\
             for a in \"$@\"; do\n\
               if [ \"$prev\" = \"-o\" ]; then out=\"$a\"; fi\n\
               prev=\"$a\"\n\
             done\n\
             printf '%s' 'ok' > \"$out\"\n\
             printf '%s\\n' '{\"type\":\"turn.started\"}'\n\
             printf '%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":1}}'\n",
        );
        let deps = deps(
            &scratch,
            &scratch.path("unused-claude"),
            &scratch.path("unused-ollama"),
            &codex,
        );

        let answer = block_on(run_prompt(
            &deps,
            "codex",
            "gpt-6",
            "p",
            PromptRunOpts::default(),
        ))
        .unwrap();
        assert_eq!(answer, "ok");

        let recorded = recorded_args(&scratch);
        let tokens: Vec<&str> = recorded.split(' ').collect();
        assert_eq!(
            &tokens[..7],
            [
                "exec",
                "-m",
                "gpt-6",
                "-s",
                "read-only",
                "--skip-git-repo-check",
                "--ephemeral"
            ]
        );
        assert_eq!(tokens[7], "-C");
        assert_eq!(tokens[8], scratch.dir.to_string_lossy());
        assert_eq!(tokens[9], "-o");
        let tmp = tokens[10];
        assert!(tmp.starts_with(&*scratch.dir.to_string_lossy()));
        assert_eq!(tokens.last(), Some(&"-"), "prompt read from stdin");
        assert!(!Path::new(tmp).exists(), "temp answer file removed");

        let meta = block_on(run_prompt_with_metadata(
            &deps,
            "codex",
            "gpt-6",
            "p",
            PromptRunOpts::default(),
        ))
        .unwrap();
        assert_eq!(meta.answer, "ok");
        assert_eq!(
            meta.usage,
            Some(json!({"input_tokens": 12, "output_tokens": 1}))
        );
    }

    #[test]
    fn ollama_branch_passes_prompt_and_flags_through_and_returns_stdout() {
        let scratch = Scratch::new("ollama");
        let ollama = scratch.bin(
            "fake-ollama",
            "echo %* > \"%ONESHOT_ARGS_FILE%\"\necho raw answer\n",
            "printf '%s' \"$*\" > \"$ONESHOT_ARGS_FILE\"\necho 'raw answer'\n",
        );
        let deps = deps(
            &scratch,
            &scratch.path("unused-claude"),
            &ollama,
            &scratch.path("unused-codex"),
        );

        let out = block_on(run_prompt(
            &deps,
            "ollama",
            "llama",
            "p",
            PromptRunOpts::default(),
        ))
        .unwrap();
        assert_eq!(out.trim_end(), "raw answer");
        assert_eq!(
            recorded_args(&scratch),
            "run --hidethinking --nowordwrap llama"
        );

        let meta = block_on(run_prompt_with_metadata(
            &deps,
            "ollama",
            "llama",
            "p",
            PromptRunOpts::default(),
        ))
        .unwrap();
        assert_eq!(meta.answer.trim_end(), "raw answer");
        assert!(meta.usage.is_none());
    }

    #[test]
    fn timeout_ms_reaches_the_executor_and_an_unknown_group_is_rejected() {
        let scratch = Scratch::new("timeout");
        let slow = scratch.bin(
            "slow-claude",
            "\"%SystemRoot%\\System32\\ping.exe\" -n 20 127.0.0.1 > nul\n",
            "/bin/sleep 5\n",
        );
        let deps = deps(
            &scratch,
            &slow,
            &scratch.path("unused-ollama"),
            &scratch.path("unused-codex"),
        );

        let started = std::time::Instant::now();
        let error = block_on(run_prompt(
            &deps,
            "claude",
            "haiku",
            "p",
            PromptRunOpts {
                timeout_ms: Some(200),
                extra_args: Vec::new(),
            },
        ))
        .unwrap_err();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(4),
            "the deadline killed the child: {error}"
        );
        assert!(error.starts_with("Command failed: "), "got {error}");

        assert_eq!(
            block_on(run_prompt(
                &deps,
                "unknown",
                "m",
                "p",
                PromptRunOpts::default()
            ))
            .unwrap_err(),
            "one-shot: unknown group 'unknown'"
        );
    }

    #[test]
    fn summary_call_returns_the_claude_result_field_and_raw_stdout_for_other_groups() {
        let scratch = Scratch::new("summary");
        let claude = scratch.bin(
            "fake-claude",
            "echo %* > \"%ONESHOT_ARGS_FILE%\"\necho {\"result\":\"summary text\",\"usage\":{\"input_tokens\":7,\"output_tokens\":9}}\n",
            "printf '%s' \"$*\" > \"$ONESHOT_ARGS_FILE\"\necho '{\"result\":\"summary text\",\"usage\":{\"input_tokens\":7,\"output_tokens\":9}}'\n",
        );
        let ollama = scratch.bin("fake-ollama", "echo raw summary\n", "echo 'raw summary'\n");
        let summary = PromptRunSummary(deps(
            &scratch,
            &claude,
            &ollama,
            &scratch.path("unused-codex"),
        ));

        let text = block_on(summary.call(
            "digest",
            &SummaryModel {
                id: "haiku".to_owned(),
                group: "claude".to_owned(),
            },
        ))
        .unwrap();
        assert_eq!(text, "summary text");

        let raw = block_on(summary.call(
            "digest",
            &SummaryModel {
                id: "llama".to_owned(),
                group: "ollama".to_owned(),
            },
        ))
        .unwrap();
        assert_eq!(raw.trim_end(), "raw summary");

        // Non-envelope claude output is the JSON.parse throw Node reports.
        let broken = PromptRunSummary(PromptRunDeps {
            claude_bin: Some(ollama),
            ..deps(
                &scratch,
                &claude,
                &scratch.path("unused-ollama"),
                &scratch.path("unused-codex"),
            )
        });
        assert!(
            block_on(broken.call(
                "digest",
                &SummaryModel {
                    id: "haiku".to_owned(),
                    group: "claude".to_owned(),
                },
            ))
            .is_err()
        );
    }
}
