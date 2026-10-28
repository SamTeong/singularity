//! `server/agents.mjs` spawn builder: binary choice, argv, cwd, env and PTY size.
//!
//! Port of `buildSpawn` (`server/agents.mjs:340-395`), `spawnEnv` (`:402-406`)
//! and the `80x24` size `create`/`reattach` hand the PTY backend (`:442`,
//! `:487`). Everything ambient is injected: the three `resolveBin` results
//! (`:31-37`), the model-route state file (`models::route`, `:341`), the codex
//! rollout root (`codex_thread_identity`), the parent environment, and the
//! home/scope/cache paths the argument builder probes.
//!
//! Two `create()`-level behaviours are deliberately not here: `untildify` on
//! `cwd` (`:418`, [`crate::app_paths::untildify`]) and the `toolModelError`
//! rejection (`:431`) — callers run those before calling [`build_launch`], as
//! `create` does around `buildSpawn`.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::app_paths;
use crate::codex_thread_identity;
use crate::models;

const COLS: u16 = 80;
const ROWS: u16 = 24;
const MOCK_USAGE_STATE: &str = "mock-usage-state";

// VERIFY: agent-spawn-paths
/// The filesystem roots `buildSpawn` probes, injected so no test touches the
/// real home or state root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnPaths {
    /// `os.homedir()` — `~/.claude/projects/...` session logs and the
    /// `~/.agents/skills/skill-manifest.json` fallback (`agents.mjs:305`).
    pub home: PathBuf,
    /// `SING_SCOPE_ROOT` (`agents.mjs:24`); `None` skips every `--add-dir`.
    pub scope_root: Option<PathBuf>,
    /// `CACHE_DIR` — parent of the mock `USAGE_REPORT_STATE` (`:404`).
    pub cache_dir: PathBuf,
    /// `CODEX_HOME`, scanned for rollout files (`codex-thread.mjs`).
    pub codex_home: PathBuf,
    /// `STATE_DIR/models.json` — the `getModelRoute` store (`:341`).
    pub models_state: PathBuf,
}

// VERIFY: agent-spawn-bins
/// The host-injected spawn dependencies. `claude`/`ollama`/`codex` are the
/// `resolveBin` results: `None` when the env value is unset, not absolute, or
/// absent on disk.
pub struct Bins {
    pub claude: Option<PathBuf>,
    pub ollama: Option<PathBuf>,
    pub codex: Option<PathBuf>,
    pub paths: SpawnPaths,
}

impl Bins {
    /// `resolveBin` (`agents.mjs:31-34`): the env value survives only when it
    /// exists on disk. A non-absolute value is also rejected: the daemon spawns
    /// binaries by absolute path (no PATH fallback).
    pub fn resolve(
        claude: Option<&str>,
        ollama: Option<&str>,
        codex: Option<&str>,
        paths: SpawnPaths,
    ) -> Self {
        Self {
            claude: resolve_bin(claude),
            ollama: resolve_bin(ollama),
            codex: resolve_bin(codex),
            paths,
        }
    }
}

fn resolve_bin(raw: Option<&str>) -> Option<PathBuf> {
    let path = Path::new(raw.filter(|value| !value.is_empty())?);
    (path.is_absolute() && path.exists()).then(|| path.to_path_buf())
}

// VERIFY: agent-spawn-input
/// The persisted agent-record fields `buildSpawn` reads (`agents.mjs:340`),
/// serde-camelCased to the `agents.json` shape. `created_at`/`thread_id` are
/// the codex discovery inputs; `prompt` is the fresh-spawn-only initial message.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchInput {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub model: String,
    pub scopes: Vec<String>,
    pub permission_mode: Option<String>,
    pub extra_args: Vec<String>,
    pub tool: Option<String>,
    pub created_at: Option<i64>,
    pub thread_id: Option<String>,
    pub prompt: Option<String>,
    pub mock: bool,
}

// VERIFY: agent-spawn-spec
/// What the PTY backend needs to spawn: `bin`, `args`, `cwd`, the full child
/// environment and the default window size, i.e. the `ptyBackend.spawn({...})`
/// payload of `agents.mjs:442`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub bin: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

// VERIFY: agent-spawn-build
/// `buildSpawn(record, prompt)` + `spawnEnv(mock)` + the `80x24` PTY size.
///
/// Binary choice follows `tool === 'codex' || route.isCodexModel`; the claude
/// path falls through to the ollama wrapper unless the route says
/// `isClaudeModel`. `Err` is the exact `Error.message` `buildSpawn` throws.
pub fn build_launch(
    record: &LaunchInput,
    bins: &Bins,
    parent_env: &BTreeMap<String, String>,
) -> Result<LaunchSpec, String> {
    let tool = record.tool.clone().unwrap_or_default();
    let route = models::route(
        &bins.paths.models_state.to_string_lossy(),
        &Value::String(record.model.clone()),
        &if tool.is_empty() {
            Value::Null
        } else {
            Value::String(tool.clone())
        },
    );
    let (bin, args) = if tool == "codex" || route_flag(&route, "isCodexModel") {
        codex_spawn(record, bins)?
    } else {
        claude_spawn(record, bins, route_flag(&route, "isClaudeModel"))?
    };
    Ok(LaunchSpec {
        bin,
        args,
        cwd: record.cwd.clone(),
        env: spawn_env(record.mock, parent_env, &bins.paths.cache_dir),
        cols: COLS,
        rows: ROWS,
    })
}

fn route_flag(route: &Value, key: &str) -> bool {
    route.get(key).and_then(Value::as_bool) == Some(true)
}

/// The codex branch of `buildSpawn` (`agents.mjs:348-368`): codex mints its own
/// thread uuid and has no `--session-id`/`--name`, so resume is recovered from
/// the rollout file (time-based, else the caller's id when it is itself a known
/// thread for this `cwd`) and skill-scoping goes through a `skills.config` TOML
/// override instead of `--add-dir`.
fn codex_spawn(record: &LaunchInput, bins: &Bins) -> Result<(String, Vec<String>), String> {
    let bin = bins
        .codex
        .as_ref()
        .ok_or_else(|| "codex not found (CODEX_BIN not set in .env)".to_owned())?;
    let codex_home = bins.paths.codex_home.to_string_lossy().into_owned();
    let cwd = record.cwd.as_str();
    let thread_id = nonempty(&record.thread_id)
        .map(str::to_owned)
        .or_else(|| {
            let created_at = record.created_at?;
            codex_thread_identity::find(Some(&codex_home), Some(cwd), Some(created_at))
                .as_str()
                .map(str::to_owned)
        })
        .or_else(|| {
            (codex_thread_identity::exists(Some(&codex_home), Some(cwd), Some(&record.id))
                .as_bool()
                == Some(true))
            .then(|| record.id.clone())
        });
    let mut args = Vec::new();
    if let Some(thread) = thread_id.as_deref() {
        args.push("resume".to_owned());
        args.push(thread.to_owned());
    }
    if let Some(config) = codex_scope_config(&record.scopes, &bins.paths) {
        args.push("-c".to_owned());
        args.push(config);
    }
    args.push("-C".to_owned());
    args.push(cwd.to_owned());
    args.push("-s".to_owned());
    args.push("workspace-write".to_owned());
    args.push("-a".to_owned());
    args.push(
        if nonempty(&record.permission_mode).is_some() {
            "never"
        } else {
            "on-request"
        }
        .to_owned(),
    );
    if !record.model.is_empty() {
        args.push("-m".to_owned());
        args.push(record.model.clone());
    }
    if let Some(prompt) = nonempty(&record.prompt) {
        if thread_id.is_none() {
            args.push(prompt.to_owned());
        }
    }
    Ok((bin.to_string_lossy().into_owned(), args))
}

/// The claude/ollama branch of `buildSpawn` (`agents.mjs:369-394`).
fn claude_spawn(
    record: &LaunchInput,
    bins: &Bins,
    is_claude_model: bool,
) -> Result<(String, Vec<String>), String> {
    let mut args = Vec::new();
    if let Some(scope_root) = &bins.paths.scope_root {
        for scope in &record.scopes {
            if scope.is_empty() {
                continue;
            }
            let dir = app_paths::join(scope_root, scope);
            if dir.exists() {
                args.push("--add-dir".to_owned());
                args.push(dir.to_string_lossy().into_owned());
            }
        }
    }
    // A session that never had a turn has no log to resume — `--resume` would
    // error "No conversation found", so only an existing log flips the flag.
    let resuming = session_log_exists(&bins.paths.home, &record.cwd, &record.id);
    args.push(if resuming { "--resume" } else { "--session-id" }.to_owned());
    args.push(record.id.clone());
    args.push("--name".to_owned());
    args.push(record.title.clone());
    if let Some(mode) = nonempty(&record.permission_mode) {
        args.push("--permission-mode".to_owned());
        args.push(mode.to_owned());
    }
    args.extend(record.extra_args.iter().cloned());
    if let Some(prompt) = nonempty(&record.prompt) {
        if !resuming {
            args.push(prompt.to_owned());
        }
    }
    if is_claude_model {
        // claude bin; --model only for a specific (non-default) alias or full id.
        if !record.model.is_empty() && record.model != "claude" {
            args.push("--model".to_owned());
            args.push(record.model.clone());
        }
        let bin = bins
            .claude
            .as_ref()
            .ok_or_else(|| "claude not found (CLAUDE_BIN not set in .env)".to_owned())?;
        return Ok((bin.to_string_lossy().into_owned(), args));
    }
    let bin = bins
        .ollama
        .as_ref()
        .ok_or_else(|| "ollama not found (OLLAMA_BIN not set in .env)".to_owned())?;
    // On resume the transcript recorded the ollama model with its tag stripped
    // (glm-5.2:cloud -> glm-5.2); claude would request the stripped name and
    // ollama rejects it. --model overrides the transcript model on resume.
    if resuming {
        args.push("--model".to_owned());
        args.push(record.model.clone());
    }
    let mut wrapped = vec![
        "launch".to_owned(),
        "claude".to_owned(),
        "--model".to_owned(),
        record.model.clone(),
        "--".to_owned(),
    ];
    wrapped.extend(args);
    Ok((bin.to_string_lossy().into_owned(), wrapped))
}

/// `spawnEnv` (`agents.mjs:402-406`): the full parent environment plus the
/// launch-source marker; mock demo sessions additionally point
/// `USAGE_REPORT_STATE` at a disposable dir under `CACHE_DIR` so they never
/// write cost-state into the user's real store.
fn spawn_env(
    mock: bool,
    parent_env: &BTreeMap<String, String>,
    cache_dir: &Path,
) -> BTreeMap<String, String> {
    let mut env = parent_env.clone();
    env.insert("HARNESS_LAUNCH_SOURCE".to_owned(), "singularity".to_owned());
    if mock {
        env.insert(
            "USAGE_REPORT_STATE".to_owned(),
            app_paths::join(cache_dir, MOCK_USAGE_STATE)
                .to_string_lossy()
                .into_owned(),
        );
    }
    env
}

// VERIFY: agent-spawn-encode-cwd
/// `encodeCwd` (`agents.mjs:455`): Claude's session dir for `cwd` is the abs
/// path with every non-alphanumeric replaced by `-` (UTF-16 units, like the
/// JavaScript regex — an astral character becomes two dashes).
pub fn encode_cwd(cwd: &str) -> String {
    let mut encoded = String::with_capacity(cwd.len());
    for character in cwd.chars() {
        if character.is_ascii_alphanumeric() {
            encoded.push(character);
        } else {
            for _ in 0..character.len_utf16() {
                encoded.push('-');
            }
        }
    }
    encoded
}

/// `sessionLogExists` (`agents.mjs:472-474`).
fn session_log_exists(home: &Path, cwd: &str, id: &str) -> bool {
    home.join(".claude")
        .join("projects")
        .join(encode_cwd(cwd))
        .join(format!("{id}.jsonl"))
        .exists()
}

/// `resolveSkillManifest` (`agents.mjs:302-307`): `<dirname(SCOPE_ROOT)>/skills/
/// skill-manifest.json`, else `~/.agents/skills/skill-manifest.json`.
fn resolve_skill_manifest(paths: &SpawnPaths) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(parent) = paths.scope_root.as_deref().and_then(Path::parent) {
        candidates.push(parent.join("skills").join("skill-manifest.json"));
    }
    candidates.push(
        paths
            .home
            .join(".agents")
            .join("skills")
            .join("skill-manifest.json"),
    );
    candidates.into_iter().find(|path| path.exists())
}

/// `codexScopeConfig` (`agents.mjs:308-332`): codex has no `--add-dir`, so every
/// skill whose scopes do not intersect the chosen scopes (+ `common`) is
/// disabled in a `skills.config=[{path="...",enabled=false},...]` override. No
/// manifest means no disable (codex's default keeps every skill on).
fn codex_scope_config(scopes: &[String], paths: &SpawnPaths) -> Option<String> {
    let manifest_path = resolve_skill_manifest(paths)?;
    let manifest: Value = serde_json::from_str(&fs::read_to_string(&manifest_path).ok()?).ok()?;
    let mut keep: HashSet<&str> = scopes.iter().map(String::as_str).collect();
    keep.insert("common");
    let skills = match manifest.as_array() {
        Some(entries) => entries.iter().map(array_skill).collect(),
        None => object_skills(&manifest, &manifest_path),
    };
    let disable: Vec<String> = skills
        .iter()
        .filter(|skill| {
            !skill
                .scopes
                .iter()
                .any(|scope| keep.contains(scope.as_str()))
        })
        .map(|skill| {
            let skill_md = app_paths::join(&skill.path, "SKILL.md");
            format!(
                "{{path=\"{}\",enabled=false}}",
                skill_md.to_string_lossy().replace('\\', "/")
            )
        })
        .collect();
    (!disable.is_empty()).then(|| format!("skills.config=[{}]", disable.join(",")))
}

struct Skill {
    path: PathBuf,
    scopes: Vec<String>,
}

/// A manifest array entry: `{ refs: [{ path }], scopes: [...] }`.
fn array_skill(entry: &Value) -> Skill {
    Skill {
        path: PathBuf::from(
            entry
                .pointer("/refs/0/path")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        scopes: string_array(entry.get("scopes")),
    }
}

/// The `{ scopes: { scope: [skillName] }, external: { skillName: path } }`
/// manifest shape, preserving the object's insertion order like a JS `Map`.
fn object_skills(manifest: &Value, manifest_path: &Path) -> Vec<Skill> {
    let Some(scopes) = manifest.get("scopes").and_then(Value::as_object) else {
        return Vec::new();
    };
    let external = manifest.get("external");
    let dir = manifest_path.parent().unwrap_or(Path::new(""));
    let mut skills: Vec<(String, Skill)> = Vec::new();
    for (scope, names) in scopes {
        for name in string_array(Some(names)) {
            match skills.iter_mut().find(|(key, _)| key == &name) {
                Some((_, skill)) => skill.scopes.push(scope.clone()),
                None => {
                    let path = external
                        .and_then(|map| map.get(&name))
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(PathBuf::from)
                        .unwrap_or_else(|| app_paths::join(dir, &name));
                    skills.push((
                        name,
                        Skill {
                            path,
                            scopes: vec![scope.clone()],
                        },
                    ));
                }
            }
        }
    }
    skills.into_iter().map(|(_, skill)| skill).collect()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn nonempty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    const FRESH_ID: &str = "00000000-1111-2222-3333-444444444444";
    const CWD: &str = "C:\\definitely\\not\\a\\real\\repo\\path\\xyz";

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "singularity-agent-spawn-{}-{stamp}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("home")).unwrap();
            Self { root }
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }

        fn touch(&self, rel: &str) -> String {
            let path = self.path(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"").unwrap();
            path.to_string_lossy().into_owned()
        }

        fn paths(&self) -> SpawnPaths {
            SpawnPaths {
                home: self.path("home"),
                scope_root: None,
                cache_dir: self.path("cache"),
                codex_home: self.path("codex-home"),
                models_state: self.path("state/models.json"),
            }
        }

        fn bins(&self) -> Bins {
            let claude = self.touch("bin/claude");
            let ollama = self.touch("bin/ollama");
            let codex = self.touch("bin/codex");
            Bins::resolve(Some(&claude), Some(&ollama), Some(&codex), self.paths())
        }

        fn write_session_log(&self, id: &str) {
            let log = self
                .path("home/.claude/projects")
                .join(encode_cwd(CWD))
                .join(format!("{id}.jsonl"));
            fs::create_dir_all(log.parent().unwrap()).unwrap();
            fs::write(&log, b"{}\n").unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn record(model: &str) -> LaunchInput {
        LaunchInput {
            id: FRESH_ID.to_owned(),
            title: "demo".to_owned(),
            cwd: CWD.to_owned(),
            model: model.to_owned(),
            ..LaunchInput::default()
        }
    }

    fn parent_env() -> BTreeMap<String, String> {
        BTreeMap::from([("PATH".to_owned(), "/usr/bin".to_owned())])
    }

    fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        let index = args.iter().position(|arg| arg == flag)?;
        args.get(index + 1).map(String::as_str)
    }

    // agents.test.mjs:177-181.
    #[test]
    fn encode_cwd_replaces_every_non_alphanumeric_with_a_dash() {
        assert_eq!(encode_cwd("C:\\git\\singularity"), "C--git-singularity");
        assert_eq!(encode_cwd("C:\\Users\\x\\.claude"), "C--Users-x--claude");
        assert_eq!(encode_cwd("/home/u/proj"), "-home-u-proj");
    }

    // agents.test.mjs:194-203.
    #[test]
    fn fresh_claude_session_uses_session_id_and_name_without_model() {
        let fixture = Fixture::new();
        let spec = build_launch(&record("claude"), &fixture.bins(), &parent_env()).unwrap();
        assert_eq!(spec.bin, fixture.path("bin/claude").to_string_lossy());
        assert_eq!(value_after(&spec.args, "--session-id"), Some(FRESH_ID));
        assert_eq!(value_after(&spec.args, "--name"), Some("demo"));
        assert!(!spec.args.iter().any(|arg| arg == "--resume"));
        assert!(!spec.args.iter().any(|arg| arg == "--model"));
        assert_eq!((spec.cwd.as_str(), spec.cols, spec.rows), (CWD, 80, 24));
    }

    // agents.test.mjs:205-208.
    #[test]
    fn non_existent_skill_scope_is_not_added_as_add_dir() {
        let fixture = Fixture::new();
        let mut input = record("claude");
        input.scopes = vec!["__no_such_scope__".to_owned()];
        let spec = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert!(!spec.args.iter().any(|arg| arg == "--add-dir"));
    }

    #[test]
    fn existing_scope_dir_under_the_scope_root_is_added() {
        let fixture = Fixture::new();
        let scope_root = fixture.path("scope-parent/skill-scopes");
        let scope_dir = app_paths::join(&scope_root, "coding");
        fs::create_dir_all(&scope_dir).unwrap();
        let mut paths = fixture.paths();
        paths.scope_root = Some(scope_root);
        let bins = Bins {
            paths,
            ..fixture.bins()
        };
        let mut input = record("claude");
        input.scopes = vec!["coding".to_owned()];
        let spec = build_launch(&input, &bins, &parent_env()).unwrap();
        assert_eq!(
            value_after(&spec.args, "--add-dir"),
            Some(scope_dir.to_string_lossy().as_ref())
        );
    }

    // agents.test.mjs:210-222.
    #[test]
    fn claude_aliases_and_full_ids_run_via_the_claude_bin_with_model() {
        let fixture = Fixture::new();
        for model in ["opus", "claude-opus-4-8"] {
            let spec = build_launch(&record(model), &fixture.bins(), &parent_env()).unwrap();
            assert!(!spec.args.iter().any(|arg| arg == "launch"));
            assert_eq!(value_after(&spec.args, "--model"), Some(model));
            assert_eq!(value_after(&spec.args, "--session-id"), Some(FRESH_ID));
        }
    }

    // agents.test.mjs:228-235.
    #[test]
    fn spawn_env_marks_the_launch_source_and_redirects_mock_usage_state() {
        let fixture = Fixture::new();
        let bins = fixture.bins();
        let mut input = record("claude");
        input.mock = true;
        let spec = build_launch(&input, &bins, &parent_env()).unwrap();
        let expected = fixture
            .path("cache")
            .join(MOCK_USAGE_STATE)
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            spec.env.get("HARNESS_LAUNCH_SOURCE").map(String::as_str),
            Some("singularity")
        );
        assert_eq!(spec.env.get("USAGE_REPORT_STATE"), Some(&expected));
        assert_eq!(spec.env.get("PATH").map(String::as_str), Some("/usr/bin"));

        input.mock = false;
        let spec = build_launch(&input, &bins, &parent_env()).unwrap();
        assert_eq!(
            spec.env.get("HARNESS_LAUNCH_SOURCE").map(String::as_str),
            Some("singularity")
        );
        assert!(!spec.env.contains_key("USAGE_REPORT_STATE"));
    }

    // agents.test.mjs:237-249.
    #[test]
    fn existing_session_log_switches_to_resume() {
        let fixture = Fixture::new();
        fixture.write_session_log(FRESH_ID);
        let spec = build_launch(&record("claude"), &fixture.bins(), &parent_env()).unwrap();
        assert_eq!(value_after(&spec.args, "--resume"), Some(FRESH_ID));
        assert!(!spec.args.iter().any(|arg| arg == "--session-id"));
    }

    // agents.test.mjs:590-608.
    #[test]
    fn ollama_model_on_resume_injects_model_to_override_the_stripped_transcript_model() {
        let fixture = Fixture::new();
        fixture.write_session_log(FRESH_ID);
        let spec = build_launch(&record("glm-5.2:cloud"), &fixture.bins(), &parent_env()).unwrap();
        assert_eq!(
            spec.args[..4],
            ["launch", "claude", "--model", "glm-5.2:cloud"]
        );
        assert!(spec.args.iter().any(|arg| arg == "--resume"));
        assert_eq!(spec.args.iter().filter(|arg| *arg == "--model").count(), 2);
    }

    // agents.test.mjs:614-626.
    #[test]
    fn codex_fresh_spawn_uses_config_flags_and_the_positional_prompt() {
        let fixture = Fixture::new();
        let mut input = record("gpt-5.3-codex-spark");
        input.tool = Some("codex".to_owned());
        input.prompt = Some("do the work".to_owned());
        let spec = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert_eq!(spec.bin, fixture.path("bin/codex").to_string_lossy());
        assert_eq!(value_after(&spec.args, "-C"), Some(CWD));
        assert_eq!(value_after(&spec.args, "-s"), Some("workspace-write"));
        assert_eq!(value_after(&spec.args, "-a"), Some("on-request"));
        assert_eq!(value_after(&spec.args, "-m"), Some("gpt-5.3-codex-spark"));
        assert!(spec.args.iter().any(|arg| arg == "do the work"));
        for absent in ["--resume", "--session-id", "launch", "--name"] {
            assert!(!spec.args.iter().any(|arg| arg == absent));
        }
    }

    // agents.test.mjs:628-633 and 754-768.
    #[test]
    fn codex_disables_skills_outside_the_selected_scopes() {
        let fixture = Fixture::new();
        let manifest_dir = fixture.path("scope-parent/skills");
        fs::create_dir_all(&manifest_dir).unwrap();
        let coding = fixture.path("skills/coding-skill");
        let harness = fixture.path("skills/harness-skill");
        fs::create_dir_all(&coding).unwrap();
        fs::create_dir_all(&harness).unwrap();
        fs::write(coding.join("SKILL.md"), "# coding skill").unwrap();
        fs::write(harness.join("SKILL.md"), "# harness skill").unwrap();
        fs::write(
            manifest_dir.join("skill-manifest.json"),
            json!({
                "scopes": { "coding": ["coding-skill"], "harness": ["harness-skill"] },
                "external": {
                    "coding-skill": coding.to_string_lossy(),
                    "harness-skill": harness.to_string_lossy(),
                },
            })
            .to_string(),
        )
        .unwrap();
        let mut paths = fixture.paths();
        paths.scope_root = Some(fixture.path("scope-parent/skill-scopes"));
        let bins = Bins {
            paths,
            ..fixture.bins()
        };
        let mut input = record("gpt-5.3-codex-spark");
        input.tool = Some("codex".to_owned());
        input.scopes = vec!["coding".to_owned()];
        let spec = build_launch(&input, &bins, &parent_env()).unwrap();
        let config = value_after(&spec.args, "-c").unwrap();
        let harness_md = harness
            .join("SKILL.md")
            .to_string_lossy()
            .replace('\\', "/");
        let coding_md = coding.join("SKILL.md").to_string_lossy().replace('\\', "/");
        assert!(config.starts_with("skills.config=["));
        assert!(config.ends_with(']'));
        assert!(config.contains(&format!("{{path=\"{harness_md}\",enabled=false}}")));
        assert!(!config.contains(&coding_md));
        assert!(!spec.args.iter().any(|arg| arg == "--add-dir"));
    }

    // agents.test.mjs:635-652.
    #[test]
    fn codex_permission_mode_forces_never_and_model_driven_routing_uses_the_codex_bin() {
        let fixture = Fixture::new();
        let mut input = record("gpt-5.3-codex-spark");
        input.tool = Some("codex".to_owned());
        input.permission_mode = Some("acceptEdits".to_owned());
        input.prompt = Some("do the work".to_owned());
        let spec = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert_eq!(value_after(&spec.args, "-a"), Some("never"));

        // gpt-* routes to codex even with tool="claude" (model-driven).
        let mut input = record("gpt-6-luna");
        input.tool = Some("claude".to_owned());
        input.prompt = Some("do the work".to_owned());
        let spec = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert_eq!(spec.bin, fixture.path("bin/codex").to_string_lossy());
        assert_eq!(value_after(&spec.args, "-m"), Some("gpt-6-luna"));
        assert!(spec.args.iter().any(|arg| arg == "do the work"));
        assert!(!spec.args.iter().any(|arg| arg == "--session-id"));
    }

    // agents.test.mjs:640-643.
    #[test]
    fn codex_without_a_model_has_no_model_flag() {
        let fixture = Fixture::new();
        let mut input = record("");
        input.tool = Some("codex".to_owned());
        input.prompt = Some("work".to_owned());
        let spec = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert!(!spec.args.iter().any(|arg| arg == "-m"));
    }

    fn rollout(fixture: &Fixture, cwd: &str, thread_id: &str) {
        let dir = fixture.path("codex-home/sessions/2026/08/03");
        fs::create_dir_all(&dir).unwrap();
        let timestamp = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        let meta = json!({
            "timestamp": timestamp,
            "type": "session_meta",
            "payload": {
                "session_id": thread_id,
                "id": thread_id,
                "timestamp": timestamp,
                "cwd": cwd,
                "originator": "codex-tui",
                "source": "cli",
                "thread_source": "user",
                "model_provider": "openai",
            },
        });
        fs::write(
            dir.join(format!("rollout-{thread_id}.jsonl")),
            format!("{meta}\n"),
        )
        .unwrap();
    }

    fn now_ms() -> i64 {
        (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()) as i64
    }

    // agents.test.mjs:673-691.
    #[test]
    fn codex_resume_recovers_the_thread_from_a_matching_rollout_and_drops_the_prompt() {
        let fixture = Fixture::new();
        let thread = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        rollout(&fixture, CWD, thread);
        let mut input = record("gpt-5.3-codex-spark");
        input.tool = Some("codex".to_owned());
        input.created_at = Some(now_ms());
        input.prompt = Some("do the work".to_owned());
        let spec = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert_eq!(spec.args[..2], ["resume", thread]);
        assert_eq!(value_after(&spec.args, "-C"), Some(CWD));
        assert_eq!(value_after(&spec.args, "-s"), Some("workspace-write"));
        assert_eq!(value_after(&spec.args, "-m"), Some("gpt-5.3-codex-spark"));
        assert!(!spec.args.iter().any(|arg| arg == "do the work"));

        // A rollout for another cwd, or a missing createdAt, never resumes.
        let other = "C:\\some\\other\\cwd\\not-matching";
        let call_cwd = "C:\\yet\\another\\cwd\\never-fixtured";
        rollout(&fixture, other, "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz");
        let mut input = record("gpt-5.3-codex-spark");
        input.tool = Some("codex".to_owned());
        input.cwd = call_cwd.to_owned();
        input.created_at = Some(now_ms());
        input.prompt = Some("work".to_owned());
        let mismatched = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert!(!mismatched.args.iter().any(|arg| arg == "resume"));
        assert!(mismatched.args.iter().any(|arg| arg == "work"));

        input.created_at = None;
        let no_created_at = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert!(!no_created_at.args.iter().any(|arg| arg == "resume"));
        assert!(no_created_at.args.iter().any(|arg| arg == "work"));
    }

    // agents.test.mjs:715-734.
    #[test]
    fn codex_resume_by_caller_id_requires_a_rollout_for_this_cwd() {
        let fixture = Fixture::new();
        let thread = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
        rollout(&fixture, CWD, thread);
        let mut input = record("gpt-5.3-codex-spark");
        input.tool = Some("codex".to_owned());
        input.id = thread.to_owned();
        let spec = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert_eq!(spec.args[..2], ["resume", thread]);

        // Same rollout, different call cwd → no resume.
        let mut input = record("gpt-5.3-codex-spark");
        input.tool = Some("codex".to_owned());
        input.id = thread.to_owned();
        input.cwd = "C:\\some\\unrelated\\cwd\\for-this-thread".to_owned();
        let spec = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert!(!spec.args.iter().any(|arg| arg == "resume"));

        // Random id with no rollout → fresh spawn keeps the prompt.
        let mut input = record("gpt-5.3-codex-spark");
        input.tool = Some("codex".to_owned());
        input.id = "11111111-2222-3333-4444-555555555555".to_owned();
        input.prompt = Some("do the work".to_owned());
        let spec = build_launch(&input, &fixture.bins(), &parent_env()).unwrap();
        assert!(!spec.args.iter().any(|arg| arg == "resume"));
        assert!(spec.args.iter().any(|arg| arg == "do the work"));
    }

    // agents.test.mjs:736-752.
    #[test]
    fn missing_or_non_absolute_binaries_keep_the_node_errors() {
        let fixture = Fixture::new();
        let mut paths = fixture.paths();
        paths.codex_home = fixture.path("codex-home");

        let missing = Bins::resolve(
            Some(&fixture.touch("bin/claude")),
            Some(&fixture.touch("bin/ollama")),
            Some(&fixture.path("no-such-codex-bin").to_string_lossy()),
            paths.clone(),
        );
        assert!(missing.codex.is_none(), "absent binary resolves to None");
        let mut input = record("gpt-5.3-codex-spark");
        input.tool = Some("codex".to_owned());
        assert_eq!(
            build_launch(&input, &missing, &parent_env()).unwrap_err(),
            "codex not found (CODEX_BIN not set in .env)"
        );

        // A relative path is rejected even when it exists (absolute-only spawn).
        let relative = Bins::resolve(None, None, Some("bin/codex"), paths);
        assert!(
            relative.codex.is_none(),
            "non-absolute binary resolves to None"
        );
        assert_eq!(
            build_launch(&input, &relative, &parent_env()).unwrap_err(),
            "codex not found (CODEX_BIN not set in .env)"
        );

        let no_ollama = Bins::resolve(
            Some(&fixture.touch("bin/claude")),
            None,
            Some(&fixture.touch("bin/codex")),
            fixture.paths(),
        );
        assert_eq!(
            build_launch(&record("glm-5.2:cloud"), &no_ollama, &parent_env()).unwrap_err(),
            "ollama not found (OLLAMA_BIN not set in .env)"
        );
    }
}
