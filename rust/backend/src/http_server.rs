use crate::http_policy::HttpPolicy;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::State;
use axum::http::{HeaderValue, Request, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::json;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

pub struct HttpServices {
    pub state_dir: PathBuf,
    pub plans_root: Option<PathBuf>,
    pub report_request: Arc<crate::usage_report::Request>,
    pub sampler: Arc<crate::sysstats::Sampler>,
    pub status: crate::status::StatusService,
    pub memory: Option<crate::http_memory_root::MemoryServices>,
    pub config: Option<ConfigServices>,
    pub cutover: Option<CutoverServices>,
    /// Shared with the `/ws` bridge; `/api/health` reports it as `clients`.
    pub clients: Arc<AtomicUsize>,
    /// The live registry/PTY/anchor/chat assembly; `None` in unit tests and
    /// for `HttpServices::new`.
    pub(crate) runtime: Option<crate::lifecycle::RuntimeServices>,
}

/// Inputs for the TASK-42 cutover routers (shell, capabilities, hooks, rules,
/// explorer, skills, wiki, transcripts, model prices, projects).
#[derive(Clone)]
pub struct CutoverServices {
    pub paths: crate::app_paths::AppPaths,
    pub home: PathBuf,
    pub codex_home: PathBuf,
    pub cwd: PathBuf,
    pub drive_cwds: Vec<(u16, PathBuf)>,
    pub dist_dir: PathBuf,
    pub display_home: String,
    pub rules_reference_dir: PathBuf,
    pub git_bin: String,
    pub git_timeout_ms: u64,
    pub review_dir: Option<PathBuf>,
    pub claude_bin: Option<PathBuf>,
    pub ollama_bin: Option<PathBuf>,
    pub codex_bin: Option<PathBuf>,
    pub scope_root: Option<PathBuf>,
    pub plans_available: bool,
    pub plans_root: Option<PathBuf>,
    pub token_available: bool,
}

/// No live agents yet; the native registry replaces this in registry slice C.
struct NoRegistry;

impl crate::http_transcripts::TranscriptRegistry for NoRegistry {}

impl CutoverServices {
    fn from_env(paths: crate::app_paths::AppPaths, config: &ConfigServices) -> Self {
        let env = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty());
        let bin = |key: &str| crate::http_capabilities::resolve_bin(env(key).as_deref());
        let rules_reference_dir = match env("SING_RULES_REF") {
            Some(value) => crate::app_paths::resolve_from(&PathBuf::from(value), &config.cwd),
            None => config.home.join(".agents").join("rules-reference"),
        };
        Self {
            dist_dir: config.cwd.join("web").join("dist"),
            display_home: crate::http_shell::display_home()
                .unwrap_or_else(|_| config.home.to_string_lossy().into_owned()),
            rules_reference_dir,
            git_bin: env("GIT_BIN")
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| "git".to_owned()),
            // `Number(SING_GIT_TIMEOUT_MS) || 10_000`
            git_timeout_ms: env("SING_GIT_TIMEOUT_MS")
                .and_then(|value| value.to_str()?.trim().parse::<u64>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(10_000),
            review_dir: env("PROJECT_REVIEW_DIR").map(PathBuf::from),
            claude_bin: bin("CLAUDE_BIN"),
            ollama_bin: bin("OLLAMA_BIN"),
            codex_bin: bin("CODEX_BIN"),
            scope_root: env("SING_SCOPE_ROOT").map(PathBuf::from),
            plans_available: env("SING_PLANS_ROOT").is_some(),
            plans_root: env("SING_PLANS_ROOT").map(PathBuf::from),
            token_available: env("SING_TOKEN").is_some(),
            paths,
            home: config.home.clone(),
            codex_home: config.codex_home.clone(),
            cwd: config.cwd.clone(),
            drive_cwds: config.drive_cwds.clone(),
        }
    }

    /// The routers plus the shell fallback that replaces the JSON 404.
    fn routers(
        self,
        policy: &HttpPolicy,
        runtime: Option<crate::lifecycle::RuntimeServices>,
    ) -> (Router, Option<Router>) {
        let Self {
            paths,
            home,
            codex_home,
            cwd,
            drive_cwds,
            dist_dir,
            display_home,
            rules_reference_dir,
            git_bin,
            git_timeout_ms,
            review_dir,
            claude_bin,
            ollama_bin,
            codex_bin,
            scope_root,
            plans_available,
            plans_root,
            token_available,
        } = self;
        let state_dir = paths.state_dir.clone();
        let backups_dir = paths.backups_dir.clone();
        let locale = crate::memory_collation::system_locale();
        // One queue for hook and rule file writes, like Node's single bridge queue.
        let file_lock = Arc::new(Mutex::new(()));
        let models_path = state_dir.join("models.json").to_string_lossy().into_owned();
        // Clones the router needs after the chain below moves the originals.
        let transcript_registry: Arc<dyn crate::http_transcripts::TranscriptRegistry> =
            match runtime.as_ref() {
                Some(runtime) => runtime.registry.clone(),
                None => Arc::new(NoRegistry),
            };
        let agents_home = home.clone();
        let agents_cwd = cwd.clone();
        let agents_state_dir = state_dir.clone();
        let agents_codex_home = codex_home.clone();
        let agents_scope_root = scope_root.clone();
        let agents_bins = (claude_bin.clone(), ollama_bin.clone(), codex_bin.clone());
        let agents_cache_dir = paths.cache_dir.clone();
        let agents_usage_state = paths.usage_skill_state.clone();
        let services_scope_root = scope_root.clone();
        let services_models_path = models_path.clone();
        let routes = Router::new()
            .merge(crate::http_shell::router(
                policy.clone(),
                dist_dir.clone(),
                display_home.clone(),
            ))
            .merge(crate::http_capabilities::router(
                crate::http_capabilities::CapabilitiesDeps {
                    state_dir: state_dir.clone(),
                    home: home.clone(),
                    cwd: cwd.clone(),
                    drive_cwds: drive_cwds.clone(),
                    codex_home: codex_home.clone(),
                    ollama_bin: ollama_bin.clone(),
                    codex_bin: codex_bin.clone(),
                    scope_root,
                    plans_available,
                    token_available,
                },
            ))
            .merge(crate::http_hooks::router(
                state_dir.clone(),
                home.clone(),
                cwd.clone(),
                drive_cwds.clone(),
                backups_dir.clone(),
                locale.clone(),
                Arc::new(Mutex::new(())),
                file_lock.clone(),
            ))
            .merge(crate::http_rules::router(
                state_dir.clone(),
                home.clone(),
                cwd.clone(),
                drive_cwds.clone(),
                rules_reference_dir,
                Arc::new(Mutex::new(())),
                file_lock,
            ))
            .merge(crate::http_fs::router(
                state_dir.clone(),
                backups_dir.clone(),
                locale,
            ))
            .merge(crate::http_skills::router(
                state_dir.clone(),
                home.clone(),
                backups_dir,
                Arc::new(Mutex::new(())),
            ))
            .merge(crate::http_wiki::router(
                state_dir.clone(),
                home.clone(),
                cwd.clone(),
                drive_cwds.clone(),
                Arc::new(Mutex::new(())),
            ))
            .merge(crate::http_transcripts::router(
                crate::http_transcripts::TranscriptHost {
                    state_dir: state_dir.clone(),
                    claude_home: home.join(".claude"),
                    codex_home,
                    usage_state: paths.usage_skill_state.clone(),
                    model_catalog: Arc::new(move || {
                        crate::models::get(&models_path)["models"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default()
                    }),
                    registry: transcript_registry,
                },
            ))
            .merge(crate::http_model_prices::router(
                paths.usage_skill_state.join("pricing.json"),
            ))
            .merge(crate::http_projects::router(
                crate::http_projects::ProjectsDeps {
                    summary_call: Arc::new(crate::prompt_run::PromptRunSummary(
                        crate::prompt_run::PromptRunDeps {
                            claude_bin: claude_bin.clone(),
                            ollama_bin: ollama_bin.clone(),
                            codex_bin: codex_bin.clone(),
                            state_dir: state_dir.clone(),
                            env: std::env::vars().collect(),
                        },
                    )),
                    state_dir,
                    cache_dir: paths.cache_dir,
                    home,
                    cwd,
                    drive_cwds,
                    git_bin,
                    git_timeout_ms,
                    review_dir,
                    claude_bin,
                    ollama_bin,
                    codex_bin,
                },
            ));
        let routes = match runtime {
            None => routes,
            Some(runtime) => {
                let (claude_bin, ollama_bin, codex_bin) = agents_bins;
                let spawn_detached: crate::http_agents::SpawnDetached =
                    Arc::new(|launcher, args, cwd| {
                        let env = serde_json::json!(
                            std::env::vars()
                                .collect::<std::collections::BTreeMap<String, String>>()
                        );
                        let result = crate::detached::spawn(
                            Some(launcher),
                            &serde_json::json!(args),
                            cwd,
                            &env,
                        );
                        if result["ok"] == serde_json::Value::Bool(true) {
                            Ok(())
                        } else {
                            Err(result["error"]
                                .as_str()
                                .unwrap_or("detached spawn failed")
                                .to_owned())
                        }
                    });
                let bus = runtime.registry.bus().clone();
                // `CLAUDE_CONFIG_DIR || ~/.claude` (`usage.mjs:56-59`).
                let claude_config = std::env::var_os("CLAUDE_CONFIG_DIR")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| agents_home.join(".claude"));
                let history = crate::history::HistoryService::new(crate::history::HistoryDeps {
                    state_dir: agents_state_dir.clone(),
                    usage_state: agents_usage_state.clone(),
                    home: agents_home.clone(),
                    bins: crate::history::HistoryBins {
                        claude: claude_bin.clone(),
                        ollama: ollama_bin.clone(),
                        codex: codex_bin.clone(),
                    },
                    bus: bus.clone(),
                    clock: Arc::new(crate::history::SystemClock),
                    transcripts: Arc::new(
                        crate::history::NativeTranscriptSource::new(
                            crate::transcript_service::Inputs {
                                state_dir: agents_state_dir.clone(),
                                claude_home: agents_home.join(".claude"),
                                codex_home: agents_codex_home.clone(),
                                model_catalog: Vec::new(),
                            },
                        )
                        .with_catalog_source(Arc::new(move || {
                            crate::models::get(&services_models_path)["models"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default()
                        })),
                    ),
                    summariser: Arc::new(crate::history::PromptRunSummariser(
                        crate::prompt_run::PromptRunDeps {
                            claude_bin: claude_bin.clone(),
                            ollama_bin: ollama_bin.clone(),
                            codex_bin: codex_bin.clone(),
                            state_dir: agents_state_dir.clone(),
                            env: std::env::vars().collect(),
                        },
                    )),
                    models: Arc::new(crate::history::NativeModelStore {
                        models_path: agents_state_dir.join("models.json"),
                    }),
                });
                // Boot backfill like `index.mjs:904`: fire once, never block listen.
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    let backfill = history.clone();
                    handle.spawn(async move {
                        let _ = backfill.ensure(crate::history::BACKFILL_DAYS, None).await;
                    });
                }
                let anchor_core = Arc::new(crate::window_anchor_host::AnchorCore {
                    anchor: runtime.anchor.clone(),
                    bus: bus.clone(),
                    state_path: agents_state_dir.join("window-anchor.json"),
                    telemetry_path: agents_usage_state.join("window-anchor-runs.jsonl"),
                });
                let anchor_runner_deps = crate::prompt_run::PromptRunDeps {
                    claude_bin: claude_bin.clone(),
                    ollama_bin: ollama_bin.clone(),
                    codex_bin: codex_bin.clone(),
                    state_dir: agents_state_dir.clone(),
                    env: std::env::vars().collect(),
                };
                let (usage, usage_handle) =
                    crate::http_usage::router_with_handle(crate::http_usage::UsageDeps {
                        bus,
                        state_dir: agents_state_dir.clone(),
                        usage_state: agents_usage_state.clone(),
                        claude_home: claude_config,
                        codex_home: agents_codex_home.clone(),
                        platform: crate::http_agents::Platform::host(),
                        parent_env: std::env::vars().collect(),
                        security_bin: cfg!(target_os = "macos")
                            .then(|| PathBuf::from("/usr/bin/security")),
                        network: Arc::new(crate::http_usage::NativeUsageNetwork),
                        clock: Arc::new(|| {
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map_or(0, |elapsed| elapsed.as_millis() as i64)
                        }),
                    });
                // Timers and fire-and-forget actions need tokio; plain router
                // construction outside a runtime keeps the inert host.
                let anchor_host: Arc<dyn crate::http_utilities::AnchorHost> =
                    match tokio::runtime::Handle::try_current() {
                        Ok(handle) => {
                            let refresh: crate::window_anchor_host::UsageRefresh =
                                Arc::new(move |provider: &str| {
                                    let usage_handle = usage_handle.clone();
                                    let provider = provider.to_owned();
                                    Box::pin(async move { usage_handle.refresh(&provider).await })
                                });
                            let host = crate::window_anchor_host::NativeAnchorHost::new(
                                anchor_core,
                                handle.clone(),
                                refresh,
                                crate::window_anchor_host::native_runner(
                                    anchor_runner_deps,
                                    agents_state_dir.join("models.json"),
                                    handle,
                                ),
                                Arc::new(|| {
                                    std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map_or(0, |elapsed| elapsed.as_millis() as i64)
                                }),
                            );
                            host.subscribe_usage();
                            host
                        }
                        Err(_) => Arc::new(crate::lifecycle::DeferredAnchorHost),
                    };
                let utilities = crate::http_utilities::router(crate::http_utilities::UtilityDeps {
                    registry: runtime.registry.clone(),
                    anchor: runtime.anchor.clone(),
                    transcript: runtime.chat.transcripts.clone(),
                    scope_root: services_scope_root,
                    plans_root,
                    claude_projects_root: agents_home.join(".claude").join("projects"),
                    state_dir: agents_state_dir.clone(),
                    usage_state: agents_usage_state.clone(),
                    platform: crate::http_agents::Platform::host(),
                    system_root: std::env::var_os("SystemRoot")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| PathBuf::from("C:\\Windows")),
                    spawn_detached: spawn_detached.clone(),
                    anchor_host,
                });
                let agents = crate::http_agents::router(crate::http_agents::AgentsDeps {
                    registry: runtime.registry.clone(),
                    bins: crate::agent_spawn::Bins {
                        claude: claude_bin,
                        ollama: ollama_bin,
                        codex: codex_bin,
                        paths: crate::agent_spawn::SpawnPaths {
                            home: agents_home.clone(),
                            scope_root: agents_scope_root,
                            cache_dir: agents_cache_dir,
                            codex_home: agents_codex_home.clone(),
                            models_state: agents_state_dir.join("models.json"),
                        },
                    },
                    parent_env: std::env::vars().collect(),
                    repo_root: agents_cwd,
                    host_pid: std::process::id(),
                    platform: crate::http_agents::Platform::host(),
                    procs: Arc::new(crate::http_agents::NativeProcs),
                    spawn_detached,
                    stats: crate::http_agents::StatsPaths {
                        claude_home: agents_home.join(".claude"),
                        codex_home: agents_codex_home,
                        usage_state: agents_usage_state,
                        state_dir: agents_state_dir,
                    },
                });
                let ws = crate::http_ws::router(crate::http_ws::WsDeps {
                    registry: runtime.registry.clone(),
                    anchor: runtime.anchor,
                    chat: runtime.chat,
                    clients: runtime.clients.clone(),
                    policy: policy.clone(),
                    shutdown: Some(runtime.shutdown.subscribe()),
                });
                let restart = restart_router(runtime.restart_tx.clone());
                routes
                    .merge(ws)
                    .merge(agents)
                    .merge(restart)
                    .merge(crate::http_history::router(history))
                    .merge(usage)
                    .merge(utilities)
            }
        };
        // `hasShell`: without a built web/dist Node keeps a plain 404 for unknown paths.
        // shortcut: `/` and `/assets/*` stay mounted without dist (500, Node 404); unbuilt dist is dev-only.
        let fallback = dist_dir
            .exists()
            .then(|| crate::http_shell::fallback(policy.clone(), dist_dir, display_home));
        (routes, fallback)
    }
}

/// Host paths the Claude and Codex config editor routes share.
#[derive(Clone)]
pub struct ConfigServices {
    pub home: PathBuf,
    pub codex_home: PathBuf,
    pub state_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub cwd: PathBuf,
    pub drive_cwds: Vec<(u16, PathBuf)>,
}

impl ConfigServices {
    fn from_env(state_dir: PathBuf, backups_dir: PathBuf) -> io::Result<Self> {
        let home = crate::memory_root::current_node_home()?;
        // `process.env.CODEX_HOME || join(homedir(), '.codex')`
        let codex_home = std::env::var_os("CODEX_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        Ok(Self {
            home,
            codex_home,
            state_dir,
            backups_dir,
            cwd: std::env::current_dir()?,
            drive_cwds: crate::wiki_root::current_drive_cwds(),
        })
    }

    fn router(self) -> Router {
        // One lock for both roots files, so reads and writes cannot interleave.
        let lock = Arc::new(Mutex::new(()));
        let Self {
            home,
            codex_home,
            state_dir,
            backups_dir,
            cwd,
            drive_cwds,
        } = self;
        Router::new()
            .merge(crate::http_config_roots::router(
                state_dir.clone(),
                lock.clone(),
            ))
            .merge(crate::http_config_scan::router())
            .merge(crate::http_claude_theme::router(home.clone()))
            .merge(crate::http_claude_config_read::router(home.clone()))
            .merge(crate::http_claude_config_search::router(home.clone()))
            .merge(crate::http_claude_config_write::router(
                home.clone(),
                state_dir.clone(),
                backups_dir.clone(),
                lock.clone(),
                cwd.clone(),
                drive_cwds.clone(),
            ))
            .merge(crate::http_codex_config_read::router(
                home.clone(),
                codex_home.clone(),
                state_dir.clone(),
                lock.clone(),
                cwd.clone(),
                drive_cwds.clone(),
            ))
            .merge(crate::http_codex_config_search::router(
                home.clone(),
                codex_home.clone(),
                state_dir.clone(),
                lock.clone(),
                cwd.clone(),
                drive_cwds.clone(),
            ))
            .merge(crate::http_codex_config_write::router(
                home,
                codex_home,
                state_dir,
                backups_dir,
                lock,
                cwd,
                drive_cwds,
            ))
    }
}

impl HttpServices {
    pub fn new(state_dir: PathBuf, report_request: crate::usage_report::Request) -> Self {
        Self {
            state_dir,
            plans_root: None,
            report_request: Arc::new(report_request),
            sampler: Arc::new(crate::sysstats::Sampler::start()),
            status: crate::status::StatusService::new(),
            memory: None,
            config: None,
            cutover: None,
            clients: Arc::new(AtomicUsize::new(0)),
            runtime: None,
        }
    }

    // VERIFY: http-server-take-lifecycle
    /// Moves the supervisor-side handles out before the router consumes the rest.
    pub(crate) fn take_lifecycle(&mut self) -> Option<crate::lifecycle::LifecycleHandles> {
        self.runtime
            .as_mut()
            .map(crate::lifecycle::RuntimeServices::handles)
    }

    fn from_env() -> io::Result<Self> {
        let home = std::env::var("SINGULARITY_HOME")
            .ok()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "SINGULARITY_HOME is required")
            })?;
        let env = [
            "HOME",
            "USERPROFILE",
            "USAGE_REPORT_STATE",
            "SING_USAGE_REPORTS",
        ]
        .into_iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| (key.to_owned(), json!(value)))
        })
        .collect();
        let mut services = Self::new(
            PathBuf::from(&home).join("state"),
            crate::usage_report::Request {
                reports_dir: String::new(),
                env: serde_json::Value::Object(env),
            },
        );
        let backups_dir = PathBuf::from(home).join("cache").join("backups");
        services.memory = Some(crate::http_memory_root::MemoryServices::from_env(
            services.state_dir.clone(),
            backups_dir.clone(),
        )?);
        let config = ConfigServices::from_env(services.state_dir.clone(), backups_dir)?;
        // `server/app-dir.mjs` resolves the repo root from its own location; the
        // daemon starts from the repo root, so cwd stands in for it.
        let paths = crate::app_paths::AppPaths::resolve(
            &crate::app_paths::AppEnv::from_process_env(),
            &config.home,
            &config.cwd,
        )
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        // `server/migrate-state.mjs` runs before any state reader.
        crate::state_migration::StateMigration::from_app_paths(&paths).run()?;
        let runtime = crate::lifecycle::RuntimeServices::from_env(&paths, &config)?;
        services.clients = runtime.clients.clone();
        services.cutover = Some(CutoverServices::from_env(paths, &config));
        services.config = Some(config);
        services.runtime = Some(runtime);
        if let Some(root) = std::env::var_os("SING_PLANS_ROOT").filter(|value| !value.is_empty()) {
            let root = PathBuf::from(root);
            services.plans_root = Some(if root.is_absolute() {
                root
            } else {
                std::env::current_dir()?.join(root)
            });
        }
        Ok(services)
    }
}

#[derive(Clone)]
struct RestartHandle(tokio::sync::mpsc::UnboundedSender<()>);

// VERIFY: http-restart-route
/// `POST /api/restart` (`index.mjs:563-575`): acknowledge immediately; the
/// supervisor drains, persists and only then respawns the daemon.
fn restart_router(sender: tokio::sync::mpsc::UnboundedSender<()>) -> Router {
    Router::new()
        .route("/api/restart", axum::routing::post(restart))
        .with_state(RestartHandle(sender))
}

async fn restart(State(handle): State<RestartHandle>) -> Json<serde_json::Value> {
    let _ = handle.0.send(());
    Json(json!({ "ok": true }))
}

pub fn router(policy: HttpPolicy, services: HttpServices) -> Router {
    let memory = services
        .memory
        .map(|memory| memory.router())
        .unwrap_or_default();
    let config = services
        .config
        .map(ConfigServices::router)
        .unwrap_or_default();
    let clients = services.clients.clone();
    let (cutover, fallback) = match services.cutover {
        Some(cutover) => cutover.routers(&policy, services.runtime),
        None => (Router::new(), None),
    };
    let router = Router::new()
        .merge(memory)
        .merge(config)
        .merge(cutover)
        .merge(crate::http_telemetry::router(
            services.sampler,
            services.status,
            clients,
        ))
        .merge(crate::http_models::router(services.state_dir.clone()))
        .merge(crate::http_plans::router(services.plans_root))
        .merge(crate::http_state::router(services.state_dir))
        .merge(crate::http_reports::router(services.report_request));
    let router = match fallback {
        Some(fallback) => router.fallback_service(fallback),
        None => router.fallback(not_found),
    };
    router
        .method_not_allowed_fallback(not_found)
        .layer(middleware::from_fn_with_state(
            policy,
            enforce_transport_policy,
        ))
        .layer(middleware::from_fn(fastify_json_charset))
}

pub async fn bind(port: u16) -> io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)).await
}

pub async fn serve<F>(
    listener: TcpListener,
    policy: HttpPolicy,
    services: HttpServices,
    shutdown: F,
) -> io::Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    axum::serve(listener, router(policy, services))
        .with_graceful_shutdown(shutdown)
        .await
}

pub async fn collect_raw_body(body: Body, limit: usize) -> Result<Bytes, axum::Error> {
    to_bytes(body, limit).await
}

pub fn run_from_env() -> io::Result<()> {
    load_dotenv()?;
    let policy = HttpPolicy::from_env()
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let mut services = HttpServices::from_env()?;
        let handles = services.take_lifecycle().ok_or_else(|| {
            io::Error::new(io::ErrorKind::Other, "native runtime failed to initialize")
        })?;
        // `reg.init(app.log)`: a malformed file is a warning, not a startup failure.
        if let Err(error) = handles.registry.load() {
            eprintln!("agents.json load failed: {error}");
        }
        let listener = crate::lifecycle::bind_with_retry(
            policy.daemon_port,
            crate::lifecycle::BIND_ATTEMPTS,
            crate::lifecycle::BIND_RETRY,
        )
        .await?;
        eprintln!("native HTTP listener bound to {}", listener.local_addr()?);
        crate::lifecycle::run(listener, policy, services, handles).await
    })
}

/// `node --env-file-if-exists=.env` plus `requireEnv`: file values fill only unset
/// variables, then every missing required variable fails startup at once.
fn load_dotenv() -> io::Result<()> {
    let path = std::path::Path::new(".env");
    let mut env = crate::env_file::process_env();
    let before = env.clone();
    let load = crate::env_file::load_env_file(path, &mut env)
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidData, message))?;
    if let Some(notice) = load.notice(path) {
        eprintln!("{notice}");
    }
    crate::env_file::require_env(&env)
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;
    for (key, value) in env.iter().filter(|(key, _)| !before.contains_key(*key)) {
        // SAFETY: called once at startup before the runtime spawns any thread.
        unsafe { std::env::set_var(key, value) };
    }
    Ok(())
}

async fn enforce_transport_policy(
    State(policy): State<HttpPolicy>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if let Err(error) = policy.request_allowed(request.headers()) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": error }))).into_response();
    }

    let path = request.uri().path();
    let method = request.method();
    let is_api = path == "/api" || path.starts_with("/api/");
    let api_exempt = matches!(path, "/api/health" | "/api/capabilities");
    let open_asset = path == "/assets" || path.starts_with("/assets/");
    if is_api && !api_exempt && !open_asset {
        match policy.api_authenticated(request.headers(), request.uri().query()) {
            Ok(true) => {}
            Ok(false) => return api_unauthorized_response(),
            Err(_) => return cookie_decode_error_response(),
        }
    }

    if policy.is_shell_request(
        method,
        path,
        request
            .headers()
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok()),
    ) && policy.token.is_some()
    {
        if let Some(token) = policy.shell_token_query(request.uri().query()) {
            let location = policy.shell_redirect_location(path, request.uri().query());
            let mut response = StatusCode::FOUND.into_response();
            if let Ok(value) = HeaderValue::try_from(location) {
                response.headers_mut().insert(header::LOCATION, value);
            }
            if let Ok(value) = HeaderValue::try_from(shell_token_cookie(&token)) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            return response;
        }
        match policy.shell_authenticated(request.headers()) {
            Ok(true) => {}
            Ok(false) => return shell_unauthorized_response(),
            Err(_) => return cookie_decode_error_response(),
        }
    }

    next.run(request).await
}

/// Fastify serializes object payloads as `application/json; charset=utf-8`;
/// axum's `Json` emits bare `application/json`.
async fn fastify_json_charset(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    if response.headers().get(header::CONTENT_TYPE)
        == Some(&HeaderValue::from_static("application/json"))
    {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
    }
    response
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response()
}

fn api_unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
        .into_response()
}

fn cookie_decode_error_response() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": "URI malformed"
        })),
    )
        .into_response()
}

fn shell_unauthorized_response() -> Response {
    let mut response = (
        StatusCode::UNAUTHORIZED,
        "Unauthorized — open this URL with ?token=<your SING_TOKEN>",
    )
        .into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::{
        ConfigServices, HttpServices, api_unauthorized_response, bind,
        cookie_decode_error_response, router, serve, shell_token_cookie,
        shell_unauthorized_response,
    };
    use crate::http_policy::HttpPolicy;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    fn test_services() -> HttpServices {
        HttpServices::new(
            std::env::temp_dir().join(format!("unused-http-test-state-{}", std::process::id())),
            crate::usage_report::Request {
                reports_dir: String::new(),
                env: serde_json::json!({}),
            },
        )
    }

    #[test]
    fn http_listener_lifecycle_uses_ephemeral_loopback_and_injected_shutdown() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = bind(0).await.unwrap();
                let address = listener.local_addr().unwrap();
                assert!(address.ip().is_loopback());
                let (stop, stopped) = oneshot::channel::<()>();
                let server = tokio::spawn(serve(
                    listener,
                    HttpPolicy {
                        daemon_port: address.port(),
                        vite_port: 5317,
                        token: None,
                    },
                    test_services(),
                    async move {
                        let _ = stopped.await;
                    },
                ));

                let mut connection = tokio::net::TcpStream::connect(address).await.unwrap();
                connection
                    .write_all(
                        format!(
                            "GET /lifecycle HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
                            address.port()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                let mut response = Vec::new();
                connection.read_to_end(&mut response).await.unwrap();
                let response = String::from_utf8(response).unwrap();
                assert!(response.starts_with("HTTP/1.1 404"), "{response}");
                assert!(response.contains("{\"error\":\"not found\"}"), "{response}");
                assert!(
                    response.contains("content-type: application/json; charset=utf-8\r\n"),
                    "{response}"
                );

                stop.send(()).unwrap();
                server.await.unwrap().unwrap();
                assert!(tokio::net::TcpStream::connect(address).await.is_err());
            });
    }

    #[test]
    fn http_config_editor_routes_mount_beside_existing_routes() {
        let root =
            std::env::temp_dir().join(format!("http-config-mount-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mut services = HttpServices::new(
            root.join("state"),
            crate::usage_report::Request {
                reports_dir: String::new(),
                env: serde_json::json!({}),
            },
        );
        services.config = Some(ConfigServices {
            home: root.join("home"),
            codex_home: root.join("home").join(".codex"),
            state_dir: root.join("state"),
            backups_dir: root.join("backups"),
            cwd: root.clone(),
            drive_cwds: Vec::new(),
        });
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = bind(0).await.unwrap();
                let address = listener.local_addr().unwrap();
                let (stop, stopped) = oneshot::channel::<()>();
                let server = tokio::spawn(serve(
                    listener,
                    HttpPolicy {
                        daemon_port: address.port(),
                        vite_port: 5317,
                        token: None,
                    },
                    services,
                    async move {
                        let _ = stopped.await;
                    },
                ));
                for (path, expected) in [
                    ("/api/config/roots", "{\"roots\":[\"~\"]}"),
                    ("/api/codex-config/roots", "{\"roots\":[\"~\"]}"),
                    ("/api/claude/theme", "{\"theme\":\"dark\"}"),
                ] {
                    let mut connection =
                        tokio::net::TcpStream::connect(address).await.unwrap();
                    connection
                        .write_all(
                            format!(
                                "GET {path} HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
                                address.port()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                    let mut response = Vec::new();
                    connection.read_to_end(&mut response).await.unwrap();
                    let response = String::from_utf8(response).unwrap();
                    assert!(response.starts_with("HTTP/1.1 200"), "{path}: {response}");
                    assert!(response.ends_with(expected), "{path}: {response}");
                    assert!(
                        response.contains("content-type: application/json; charset=utf-8\r\n"),
                        "{path}: {response}"
                    );
                }
                stop.send(()).unwrap();
                server.await.unwrap().unwrap();
            });
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn http_configured_token_middleware_authenticates_on_ephemeral_loopback() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = bind(0).await.unwrap();
                let address = listener.local_addr().unwrap();
                let (stop, stopped) = oneshot::channel::<()>();
                let server = tokio::spawn(async move {
                    axum::serve(
                        listener,
                        router(HttpPolicy {
                            daemon_port: address.port(),
                            vite_port: 5317,
                            token: Some("token_1".to_owned()),
                        }, test_services()),
                    )
                    .with_graceful_shutdown(async move {
                        let _ = stopped.await;
                    })
                    .await
                });

                let api = send_request(
                    address,
                    &format!(
                        "GET /api/private HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
                        address.port()
                    ),
                )
                .await;
                assert!(api.starts_with("HTTP/1.1 401"), "{api}");

                for path in ["/api/sysstats", "/api/status", "/api/keys", "/api/config/state", "/api/usagereport/status", "/api/usagereport/report", "/api/plans/sessions", "/api/plans/session?sid=bad"] {
                    let denied = send_request(address, &format!(
                        "GET {path} HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n", address.port()
                    )).await;
                    assert!(denied.starts_with("HTTP/1.1 401"), "{path}: {denied}");
                }
                let health = send_request(address, &format!(
                    "GET /api/health HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n", address.port()
                )).await;
                assert!(health.starts_with("HTTP/1.1 200"), "{health}");
                assert!(health.contains("\"ok\":true"), "{health}");
                for auth in ["X-Sing-Token: token_1", "Cookie: sing_token=token_1"] {
                    let allowed = send_request(address, &format!(
                        "GET /api/keys HTTP/1.1\r\nHost: localhost:{}\r\n{auth}\r\nConnection: close\r\n\r\n", address.port()
                    )).await;
                    assert!(allowed.starts_with("HTTP/1.1 200"), "{allowed}");
                    assert!(allowed.contains("{\"keys\":{}}"), "{allowed}");
                }
                let bad_origin = send_request(address, &format!(
                    "GET /api/keys HTTP/1.1\r\nHost: localhost:{}\r\nOrigin: https://evil.test\r\nX-Sing-Token: token_1\r\nConnection: close\r\n\r\n", address.port()
                )).await;
                assert!(bad_origin.starts_with("HTTP/1.1 403"), "{bad_origin}");
                let wrong_method = send_request(address, &format!(
                    "POST /api/keys HTTP/1.1\r\nHost: localhost:{}\r\nX-Sing-Token: token_1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", address.port()
                )).await;
                assert!(wrong_method.starts_with("HTTP/1.1 404"), "{wrong_method}");

                let evil_host = send_request(
                    address,
                    &format!(
                        "GET /api/private HTTP/1.1\r\nHost: evil.test:{}\r\nConnection: close\r\n\r\n",
                        address.port()
                    ),
                )
                .await;
                assert!(evil_host.starts_with("HTTP/1.1 403"), "{evil_host}");

                let query_token = send_request(
                    address,
                    &format!(
                        "GET /?keep=yes&token=token_1 HTTP/1.1\r\nHost: localhost:{}\r\nAccept: text/html\r\nConnection: close\r\n\r\n",
                        address.port()
                    ),
                )
                .await;
                assert!(query_token.starts_with("HTTP/1.1 302"), "{query_token}");
                let location = query_token
                    .lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("location:"))
                    .unwrap();
                assert_eq!(location.to_ascii_lowercase(), "location: /?keep=yes");
                assert!(!location.contains("token_1"));
                assert!(query_token.to_ascii_lowercase().contains(
                    "set-cookie: sing_token=token_1; httponly; samesite=strict; path=/"
                ));

                let cookie_shell = send_request(
                    address,
                    &format!(
                        "GET /deep HTTP/1.1\r\nHost: localhost:{}\r\nAccept: text/html\r\nCookie: sing_token=token_1\r\nConnection: close\r\n\r\n",
                        address.port()
                    ),
                )
                .await;
                assert!(cookie_shell.starts_with("HTTP/1.1 404"), "{cookie_shell}");

                stop.send(()).unwrap();
                server.await.unwrap().unwrap();
            });
    }

    #[test]
    fn http_mutation_routes_authenticate_before_parsing_or_writing() {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let root = std::env::temp_dir().join(format!(
                    "http-mutations-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                let services = HttpServices::new(
                    root.clone(),
                    crate::usage_report::Request {
                        reports_dir: String::new(),
                        env: serde_json::json!({}),
                    },
                );
                let listener = bind(0).await.unwrap();
                let address = listener.local_addr().unwrap();
                let policy = HttpPolicy {
                    daemon_port: address.port(),
                    vite_port: 5317,
                    token: Some("token_1".into()),
                };
                let (stop, stopped) = oneshot::channel();
                let server = tokio::spawn(serve(listener, policy, services, async {
                    let _ = stopped.await;
                }));
                let client = reqwest::Client::new();
                for path in ["/api/keys", "/api/config/state", "/api/models"] {
                    let denied = client
                        .put(format!("http://{address}{path}"))
                        .header("content-type", "application/json")
                        .body("{")
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(denied.status().as_u16(), 401, "{path}");
                }
                let denied = client
                    .post(format!("http://{address}/api/models/restore-defaults"))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(denied.status().as_u16(), 401);
                assert!(!root.exists());
                let denied = client
                    .put(format!("http://{address}/api/keys"))
                    .header("x-sing-token", "token_1")
                    .header("origin", "https://evil.test")
                    .json(&serde_json::json!({"alpha":{"key":"x"}}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(denied.status().as_u16(), 403);
                assert!(!root.exists());
                let bad = client
                    .put(format!("http://{address}/api/keys"))
                    .header("x-sing-token", "token_1")
                    .header("content-type", "application/json")
                    .body("{")
                    .send()
                    .await
                    .unwrap();
                assert_eq!(bad.status().as_u16(), 400);
                assert!(!root.exists());
                let saved = client
                    .put(format!("http://{address}/api/keys"))
                    .header("x-sing-token", "token_1")
                    .json(&serde_json::json!({"alpha":{"key":"x"}}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(saved.status().as_u16(), 200);
                assert_eq!(
                    saved.json::<serde_json::Value>().await.unwrap()["keys"]["alpha"]["key"],
                    "x"
                );
                let saved = client
                    .put(format!("http://{address}/api/config/state"))
                    .header("cookie", "sing_token=token_1")
                    .json(&serde_json::json!({"active":"owned"}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(saved.status().as_u16(), 200);
                assert_eq!(
                    saved.json::<serde_json::Value>().await.unwrap()["state"]["active"],
                    "owned"
                );
                let restored = client
                    .post(format!("http://{address}/api/models/restore-defaults"))
                    .header("x-sing-token", "token_1")
                    .send()
                    .await
                    .unwrap();
                assert_eq!(restored.status().as_u16(), 200);
                assert_eq!(
                    restored.json::<serde_json::Value>().await.unwrap()["ok"],
                    true
                );
                assert!(root.join("models.json").is_file());
                drop(client);
                stop.send(()).unwrap();
                server.await.unwrap().unwrap();
                std::fs::remove_dir_all(root).unwrap();
            });
    }

    async fn send_request(address: std::net::SocketAddr, request: &str) -> String {
        let mut connection = tokio::net::TcpStream::connect(address).await.unwrap();
        connection.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        connection.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    }

    #[test]
    fn http_unauthorized_responses_match_shared_legacy_fixture() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/http-policy.json")).unwrap();
        assert_eq!(
            shell_token_cookie("token_1"),
            fixtures["responses"]["shell_cookie"].as_str().unwrap()
        );
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let shell = shell_unauthorized_response();
                assert_eq!(shell.status(), StatusCode::UNAUTHORIZED);
                assert_eq!(
                    shell.headers()[axum::http::header::CONTENT_TYPE],
                    "text/plain; charset=utf-8"
                );
                let shell_body = to_bytes(shell.into_body(), usize::MAX).await.unwrap();
                assert_eq!(
                    std::str::from_utf8(&shell_body).unwrap(),
                    fixtures["responses"]["shell_unauthorized"]
                        .as_str()
                        .unwrap()
                );

                let api = api_unauthorized_response();
                assert_eq!(
                    api.status().as_u16(),
                    fixtures["responses"]["api_unauthorized"]["status"]
                        .as_u64()
                        .unwrap() as u16
                );
                let api_body = to_bytes(api.into_body(), usize::MAX).await.unwrap();
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&api_body).unwrap(),
                    fixtures["responses"]["api_unauthorized"]["body"]
                );
            });
    }

    #[test]
    fn http_malformed_cookie_response_matches_legacy_uri_error_shape() {
        let response = cookie_decode_error_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/http-policy.json")).unwrap();
        let expected = &fixtures["cookie_policy"]["error_response"];
        assert_eq!(
            response.status().as_u16(),
            expected["status"].as_u64().unwrap() as u16
        );
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                    expected["body"]
                );
            });
    }
}

fn shell_token_cookie(token: &str) -> String {
    format!("sing_token={token}; HttpOnly; SameSite=Strict; Path=/")
}

#[cfg(unix)]
pub(crate) async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};

    let Ok(mut terminate) = signal(SignalKind::terminate()) else {
        let _ = tokio::signal::ctrl_c().await;
        return;
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = terminate.recv() => {},
    }
}

#[cfg(not(unix))]
pub(crate) async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
