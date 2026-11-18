//! Production adapters shared by the task and background services.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::background::{BackgroundTasks, BoxFuture, NewBackgroundTask, SessionTokens};
use crate::task_service::TaskService;

pub fn tasks(
    paths: &crate::app_paths::AppPaths,
    config: &crate::http_server::ConfigServices,
    registry: Arc<crate::agent_registry::Registry>,
) -> Arc<TaskService> {
    let mut options = crate::task_service::TasksConfig::for_paths(paths);
    options.daemon_port = std::env::var("DAEMON_PORT")
        .ok()
        .and_then(|v| v.parse().ok());
    options.token_header = if std::env::var("SING_TOKEN").is_ok_and(|v| !v.is_empty()) {
        " -H \"x-sing-token: $SING_TOKEN\"".to_owned()
    } else {
        String::new()
    };
    options.cavecrew = std::env::var("SING_CAVECREW").as_deref() == Ok("1");
    TaskService::new(
        registry.bus().clone(),
        registry,
        Arc::new(crate::task_git::NativeGit::new(
            std::env::var("GIT_BIN").unwrap_or_else(|_| "git".to_owned()),
            std::env::var("SING_GIT_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(crate::task_git::DEFAULT_GIT_TIMEOUT_MS),
        )),
        Arc::new(crate::task_service::NativeStats::new(
            config.home.clone(),
            config.codex_home.clone(),
            paths.usage_skill_state.clone(),
        )),
        options,
        crate::agent_registry::system_clock(),
        Arc::new(|line| eprintln!("{line}")),
    )
}

pub struct TaskAdapter(pub Arc<TaskService>);

impl BackgroundTasks for TaskAdapter {
    fn snapshot(&self) -> Value {
        self.0.snapshot()
    }

    fn create<'a>(&'a self, spec: NewBackgroundTask) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.0
                .create(&json!({
                    "repo": spec.repo, "title": spec.title, "description": spec.description,
                    "model": spec.model, "scopes": spec.scopes, "tags": spec.tags,
                    "background": spec.background, "backgroundJobId": spec.background_job_id,
                    "backgroundRunId": spec.background_run_id, "conclude": spec.conclude,
                    "permissionSettings": spec.permission_settings,
                }))
                .await
                .map_err(|error| error.message)
        })
    }

    fn update<'a>(&'a self, id: &'a str, patch: Value) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.0
                .update(id, &patch)
                .await
                .map_err(|error| error.message)
        })
    }
}

pub struct Tokens {
    pub home: PathBuf,
    pub codex_home: PathBuf,
    pub usage_state: PathBuf,
    pub stats: Mutex<crate::stats::StatsService>,
}

impl SessionTokens for Tokens {
    fn tokens<'a>(
        &'a self,
        cwd: String,
        session_id: String,
        tool: String,
    ) -> BoxFuture<'a, Result<i64, String>> {
        Box::pin(async move {
            let request = crate::stats::StatsRequest {
                stats_claude_home: Some(self.home.to_string_lossy().into_owned()),
                stats_codex_home: Some(self.codex_home.to_string_lossy().into_owned()),
                stats_usage_state: Some(self.usage_state.to_string_lossy().into_owned()),
                stats_agents: Some(vec![crate::stats::StatsAgent {
                    id: session_id.clone(),
                    cwd,
                    tool: Some(tool),
                }]),
                ..Default::default()
            };
            let response = self
                .stats
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .dispatch("agent_stats", &request);
            let crate::transcript_bridge::ResponseBody::Raw(raw) = response else {
                return Err("session stats returned an unexpected response".to_owned());
            };
            let stats: Value = serde_json::from_str(raw.get()).map_err(|e| e.to_string())?;
            Ok(stats[&session_id]["tokens"].as_f64().unwrap_or(0.0) as i64)
        })
    }
}
