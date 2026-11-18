//! `GET /api/capabilities` — optional-feature flags for the shell
//! (`server/index.mjs:526-538`).
//!
//! Node builds the document from values captured at module load
//! (`reg.OLLAMA_BIN`/`reg.CODEX_BIN` are `resolveBin` results,
//! `server/agents.mjs:31-37`; `PLAN_ROOT` at `server/plans.mjs:6-8`;
//! `SING_TOKEN` at `server/index.mjs:60`), from one module-load constant
//! (`CODEX_HOME`, `server/usage.mjs:643`) and from three probes re-run on every
//! request (`CODEX_HOME/sessions`, `SING_SCOPE_ROOT`, and the persisted wiki
//! root through the Rust backend, `server/wiki-routes.mjs:17-24`).
//!
//! The host resolves all of that and injects it here; this module never reads
//! `std::env`. The flag document is emitted in Node's key order so the response
//! body is byte-identical.
use crate::wiki_root;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::path::PathBuf;

const WIKI_ROOT_FILE: &str = "wiki-root.json";

/// Host-resolved inputs for `/api/capabilities`.
#[derive(Clone)]
pub struct CapabilitiesDeps {
    /// `STATE_DIR`; `wiki-root.json` lives here (`server/wiki-routes.mjs:5`).
    pub state_dir: PathBuf,
    /// `homedir()`; resolves the persisted wiki root and the `CODEX_HOME` default.
    pub home: PathBuf,
    /// `process.cwd()` at startup; part of the wiki-root probe context.
    pub cwd: PathBuf,
    /// `=X:` drive-cwd entries (`wiki_root::current_drive_cwds`).
    pub drive_cwds: Vec<(u16, PathBuf)>,
    /// `process.env.CODEX_HOME || join(homedir(), '.codex')`.
    pub codex_home: PathBuf,
    /// `resolveBin(process.env.OLLAMA_BIN)` — a path that existed at startup.
    pub ollama_bin: Option<PathBuf>,
    /// `resolveBin(process.env.CODEX_BIN)` — a path that existed at startup.
    pub codex_bin: Option<PathBuf>,
    /// Raw `SING_SCOPE_ROOT`; `None` when unset or empty (a falsy env value).
    pub scope_root: Option<PathBuf>,
    /// `PLAN_ROOT != null` — `SING_PLANS_ROOT` was non-empty.
    pub plans_available: bool,
    /// `!!process.env.SING_TOKEN`.
    pub token_available: bool,
}

/// `server/agents.mjs:31-34` `resolveBin`: a non-empty env value that exists on
/// disk, else nothing.
pub fn resolve_bin(value: Option<&OsStr>) -> Option<PathBuf> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    path.exists().then_some(path)
}

// VERIFY: http_capabilities.rs: route("/api/capabilities", get(get_capabilities))
pub fn router(deps: CapabilitiesDeps) -> Router {
    Router::new()
        .route("/api/capabilities", get(get_capabilities))
        .with_state(deps)
}

async fn get_capabilities(State(deps): State<CapabilitiesDeps>) -> Response {
    let wiki_available = wiki_available(&deps).await;
    Json(document(&deps, wiki_available)).into_response()
}

/// `wikiAvailable` (`server/wiki-routes.mjs:17-24`) with its `catch` arm: any
/// backend failure reports the flag as unavailable, never an HTTP error.
async fn wiki_available(deps: &CapabilitiesDeps) -> bool {
    let state_file = deps.state_dir.join(WIKI_ROOT_FILE);
    let home = deps.home.clone();
    let cwd = deps.cwd.clone();
    let drive_cwds = deps.drive_cwds.clone();
    tokio::task::spawn_blocking(move || {
        let persisted = wiki_root::get(&state_file, &home);
        wiki_root::available_with_drive_cwds(&persisted, &home, &cwd, &drive_cwds)
    })
    .await
    .unwrap_or(false)
}

/// Node object-literal order: `ollama, codex, codexSpawn, skillScopes,
/// usageReport, wiki, plans, token`; each entry is `{available, hint}`.
fn document(deps: &CapabilitiesDeps, wiki_available: bool) -> Value {
    let codex_available = deps.codex_home.join("sessions").exists();
    let skill_scopes_available = deps.scope_root.as_deref().is_some_and(|root| root.exists());
    json!({
        "ollama": {
            "available": deps.ollama_bin.is_some(),
            "hint": "Set OLLAMA_BIN in .env to enable Ollama model spawns.",
        },
        "codex": {
            "available": codex_available,
            "hint": "Run Codex CLI once to enable the Codex usage card.",
        },
        "codexSpawn": {
            "available": deps.codex_bin.is_some(),
            "hint": "Set CODEX_BIN in .env to enable Codex agent/task spawns.",
        },
        "skillScopes": {
            "available": skill_scopes_available,
            "hint": "Set SING_SCOPE_ROOT in .env to enable skill-scope picking.",
        },
        "usageReport": {
            "available": true,
            "hint": "Optional: set SING_USAGE_REPORTS to override the default reports directory.",
        },
        "wiki": {
            "available": wiki_available,
            "hint": "Pick a wiki root in the Wiki panel to enable it.",
        },
        "plans": {
            "available": deps.plans_available,
            "hint": "Set SING_PLANS_ROOT in .env to enable the Plans view.",
        },
        "token": {
            "available": deps.token_available,
            "hint": "Set SING_TOKEN in .env to require an auth token on data endpoints.",
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{CapabilitiesDeps, resolve_bin, router};
    use serde_json::Value;
    use std::ffi::OsStr;
    use std::fs;
    use std::io;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;

    const DEFAULT_DOCUMENT: &str = r#"{"ollama":{"available":false,"hint":"Set OLLAMA_BIN in .env to enable Ollama model spawns."},"codex":{"available":false,"hint":"Run Codex CLI once to enable the Codex usage card."},"codexSpawn":{"available":false,"hint":"Set CODEX_BIN in .env to enable Codex agent/task spawns."},"skillScopes":{"available":false,"hint":"Set SING_SCOPE_ROOT in .env to enable skill-scope picking."},"usageReport":{"available":true,"hint":"Optional: set SING_USAGE_REPORTS to override the default reports directory."},"wiki":{"available":false,"hint":"Pick a wiki root in the Wiki panel to enable it."},"plans":{"available":false,"hint":"Set SING_PLANS_ROOT in .env to enable the Plans view."},"token":{"available":false,"hint":"Set SING_TOKEN in .env to require an auth token on data endpoints."}}"#;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "singularity-http-capabilities-{name}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }

        fn mkdir(&self, rel: &str) -> PathBuf {
            let path = self.path(rel);
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn write_file(&self, rel: &str) -> PathBuf {
            let path = self.path(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, b"x").unwrap();
            path
        }

        fn deps(&self) -> CapabilitiesDeps {
            CapabilitiesDeps {
                state_dir: self.mkdir("state"),
                home: self.mkdir("home"),
                cwd: self.mkdir("cwd"),
                drive_cwds: Vec::new(),
                codex_home: self.mkdir("codex"),
                ollama_bin: None,
                codex_bin: None,
                scope_root: None,
                plans_available: false,
                token_available: false,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn start(
        deps: CapabilitiesDeps,
    ) -> (SocketAddr, oneshot::Sender<()>, JoinHandle<io::Result<()>>) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let (stop, stopped) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(deps))
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await
        });
        (address, stop, server)
    }

    async fn capabilities(address: SocketAddr) -> (u16, Value) {
        let response = reqwest::get(format!("http://{address}/api/capabilities"))
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body = response.text().await.unwrap();
        (status, serde_json::from_str(&body).unwrap())
    }

    #[test]
    fn default_document_matches_node_byte_for_byte() {
        let fixture = Fixture::new("defaults");
        let deps = fixture.deps();
        run(async {
            let (address, stop, server) = start(deps).await;

            let response = reqwest::get(format!("http://{address}/api/capabilities"))
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.headers()["content-type"], "application/json");
            assert_eq!(response.text().await.unwrap(), DEFAULT_DOCUMENT);

            let head = reqwest::Client::new()
                .head(format!("http://{address}/api/capabilities"))
                .send()
                .await
                .unwrap();
            assert_eq!(head.status(), 200);
            assert!(head.bytes().await.unwrap().is_empty());

            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn resolved_binaries_and_env_snapshots_drive_their_flags() {
        let fixture = Fixture::new("flags");
        let mut deps = fixture.deps();
        deps.ollama_bin = Some(fixture.write_file("bin/ollama.exe"));
        deps.codex_bin = Some(fixture.write_file("bin/codex.exe"));
        deps.plans_available = true;
        deps.token_available = true;
        run(async {
            let (address, stop, server) = start(deps).await;
            let (status, body) = capabilities(address).await;
            assert_eq!(status, 200);
            assert_eq!(body["ollama"]["available"], true);
            assert_eq!(body["codexSpawn"]["available"], true);
            assert_eq!(body["plans"]["available"], true);
            assert_eq!(body["token"]["available"], true);
            // Untouched flags keep their startup values.
            assert_eq!(body["codex"]["available"], false);
            assert_eq!(body["skillScopes"]["available"], false);
            assert_eq!(body["wiki"]["available"], false);
            assert_eq!(body["usageReport"]["available"], true);

            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn codex_sessions_and_scope_root_probes_follow_the_filesystem() {
        let fixture = Fixture::new("probes");
        let mut deps = fixture.deps();
        fs::create_dir_all(deps.codex_home.join("sessions")).unwrap();
        deps.scope_root = Some(fixture.mkdir("scopes"));
        run(async {
            let (address, stop, server) = start(deps).await;
            let (status, body) = capabilities(address).await;
            assert_eq!(status, 200);
            assert_eq!(body["codex"]["available"], true);
            assert_eq!(body["skillScopes"]["available"], true);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });

        // `existsSync` is true for a file as well, and the probe is per request.
        let mut deps = fixture.deps();
        deps.scope_root = Some(fixture.path("missing-scopes"));
        run(async {
            let (address, stop, server) = start(deps.clone()).await;
            assert_eq!(
                capabilities(address).await.1["skillScopes"]["available"],
                false
            );
            fs::write(fixture.path("missing-scopes"), b"x").unwrap();
            assert_eq!(
                capabilities(address).await.1["skillScopes"]["available"],
                true
            );
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn wiki_flag_tracks_the_persisted_root_probe() {
        let fixture = Fixture::new("wiki");
        let deps = fixture.deps();
        let home = deps.home.clone();
        let state_dir = deps.state_dir.clone();
        run(async {
            let (address, stop, server) = start(deps).await;
            // No state file: the persisted default is `~/wiki`, which is absent.
            assert_eq!(capabilities(address).await.1["wiki"]["available"], false);

            // The probe re-runs per request, so a root that appears is picked up.
            fs::create_dir_all(home.join("wiki").join("pages")).unwrap();
            assert_eq!(capabilities(address).await.1["wiki"]["available"], true);

            // A persisted root wins over `~/wiki`; only dot entries are ignored.
            let root = fixture.mkdir("other-wiki");
            fs::create_dir_all(root.join(".hidden")).unwrap();
            let token = serde_json::to_string(&root.to_string_lossy()).unwrap();
            fs::write(
                state_dir.join("wiki-root.json"),
                format!("{{\"root\":{token}}}"),
            )
            .unwrap();
            assert_eq!(capabilities(address).await.1["wiki"]["available"], false);

            fs::create_dir_all(root.join("visible")).unwrap();
            assert_eq!(capabilities(address).await.1["wiki"]["available"], true);

            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
    }

    #[test]
    fn resolve_bin_requires_a_non_empty_existing_path() {
        let fixture = Fixture::new("resolve-bin");
        let file = fixture.write_file("bin/tool.exe");
        assert_eq!(resolve_bin(None), None);
        assert_eq!(resolve_bin(Some(OsStr::new(""))), None);
        assert_eq!(
            resolve_bin(Some(fixture.path("bin/missing.exe").as_os_str())),
            None
        );
        assert_eq!(resolve_bin(Some(file.as_os_str())), Some(file));
    }
}
