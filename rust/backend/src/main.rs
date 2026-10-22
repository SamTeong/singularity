use serde::Deserialize;
use serde_json::{Value, value::RawValue};
use std::io::{self, BufRead, BufWriter, Write};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default, rename = "type")]
    message_type: Option<String>,
    #[serde(default = "default_op")]
    op: String,
    #[serde(default)]
    root: Value,
    #[serde(default)]
    wiki: Value,
    #[serde(default)]
    q: Value,
    #[serde(default)]
    path: Value,
    #[serde(default)]
    temp_path: Value,
    #[serde(default)]
    credential_text: Value,
    #[serde(default)]
    credential_handle: Value,
    #[serde(default)]
    access_token: Value,
    #[serde(default)]
    oauth_body: Value,
    #[serde(default)]
    header_timeout_ms: Value,
    #[serde(default)]
    wiki_order: Value,
    #[serde(default)]
    sid: Value,
    #[serde(default)]
    roots: Value,
    #[serde(default)]
    scope: Value,
    #[serde(default)]
    skill: Value,
    #[serde(default)]
    flat: Value,
    #[serde(default)]
    file: Value,
    #[serde(default)]
    content: Value,
    #[serde(default)]
    mtime: Value,
    #[serde(default)]
    force: Value,
    #[serde(default)]
    model: Value,
    #[serde(default)]
    tool: Value,
    #[serde(default)]
    state: Value,
    #[serde(default)]
    patch: Value,
    #[serde(default)]
    from: Value,
    #[serde(default)]
    to: Value,
    #[serde(default)]
    kind: Value,
    #[serde(default)]
    bin: Value,
    #[serde(default)]
    cwd: Value,
    #[serde(default)]
    #[serde(rename = "identity_codex_home")]
    codex_identity_home: Value,
    #[serde(default)]
    spawned_at: Value,
    #[serde(default)]
    thread_id: Value,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    timeout_ms: Value,
    #[serde(default)]
    max_buffer: Value,
    #[serde(default)]
    env: Value,
    #[serde(default)]
    pid: Value,
    #[serde(default)]
    platform: Value,
    #[serde(default)]
    record: Value,
    #[serde(default)]
    usage_report: Value,
    #[serde(flatten)]
    transcript: singularity_backend::transcript_bridge::TranscriptRequest,
}

fn default_op() -> String {
    "graph".to_owned()
}

fn main() -> io::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--pty") {
        return singularity_backend::pty::run();
    }
    let mut sysstats = singularity_backend::sysstats::Sampler::start();
    let stdout = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("status runtime should start");
    let status = singularity_backend::status::StatusService::new();
    let shutting_down = Arc::new(AtomicBool::new(false));
    let mut transcript_services =
        singularity_backend::transcript_bridge::TranscriptServices::default();
    let mut usage_snapshots = singularity_backend::usage_snapshot::SnapshotService::default();
    let mut codex_usage_sessions = singularity_backend::codex_usage::CodexUsageSessions::default();
    let stdin = io::stdin();
    write_line(&stdout, &serde_json::json!({ "ready": true }))?;
    for line in stdin.lock().lines() {
        let line = line?;
        if let Ok(request) = serde_json::from_str::<SnapshotWireRequest>(&line) {
            if request.op == "provider_usage_snapshot" {
                let id = request.id.clone();
                let raw = match request.into_snapshot() {
                    Some(request) => serde_json::to_string(&usage_snapshots.execute(request))
                        .expect("snapshot response serialization is infallible"),
                    None => r#"{"error":"bad request"}"#.to_owned(),
                };
                let body = RawValue::from_string(raw).expect("serialized response is valid JSON");
                write_response_line(
                    &stdout,
                    id.as_ref(),
                    singularity_backend::transcript_bridge::ResponseBody::Raw(body),
                )?;
                continue;
            }
        }
        if let Ok(request) = serde_json::from_str::<ProviderUsageRequest>(&line) {
            if request.op == "provider_usage_normalize" {
                let payload = request
                    .payload
                    .unwrap_or_else(|| RawValue::from_string("null".into()).unwrap());
                let normalized = singularity_backend::provider_usage::normalize(
                    &singularity_backend::provider_usage::Request {
                        provider: request.provider.unwrap_or_default(),
                        payload_present: request.payload_present,
                        payload,
                        plan: request.plan,
                        fetched_at: request.fetched_at,
                    },
                );
                let body = match normalized {
                    Ok(raw) => singularity_backend::transcript_bridge::ResponseBody::Raw(raw),
                    Err(error) => singularity_backend::transcript_bridge::ResponseBody::Value(
                        serde_json::json!({"error": error}),
                    ),
                };
                write_response_line(&stdout, request.id.as_ref(), body)?;
                continue;
            }
        }
        let parsed = serde_json::from_str::<Request>(&line);
        if let Ok(request) = &parsed {
            if request.op == "status_get"
                && request.message_type.as_deref() == Some("status_request")
            {
                if let Some(id) = request.id.clone() {
                    let status = status.clone();
                    let stdout = stdout.clone();
                    let shutting_down = shutting_down.clone();
                    let force = request.force.as_bool().unwrap_or(false);
                    runtime.spawn(async move {
                        let response = status.get_status(force).await;
                        let reply = serde_json::json!({ "id": id, "type": "status_reply", "response": response });
                        let _ = write_status_line(&stdout, &shutting_down, &reply);
                    });
                    continue;
                }
            }
        }
        let id = parsed.as_ref().ok().and_then(|request| request.id.clone());
        let mut raw_response = None;
        let response = match parsed {
            Ok(request)
                if matches!(
                    request.op.as_str(),
                    "transcript_root_get"
                        | "transcript_root_set"
                        | "transcripts_list"
                        | "transcripts_read"
                        | "transcripts_search"
                        | "transcript_subagents"
                ) =>
            {
                raw_response = Some(transcript_services.dispatch(&request.op, &request.transcript));
                Value::Null
            }
            Ok(request) if request.op == "sysstats_get" => {
                serde_json::to_value(sysstats.snapshot())
                    .expect("sysstats serialization is infallible")
            }
            Ok(request) if request.op == "codex_usage_begin" => {
                match codex_usage_sessions
                    .begin(std::path::Path::new(request.path.as_str().unwrap_or("")))
                {
                    Some(handle) => serde_json::json!({"kind":"ready","handle":handle}),
                    None => serde_json::json!({"kind":"no_sessions"}),
                }
            }
            Ok(request) if request.op == "codex_usage_release" => {
                let released = request
                    .credential_handle
                    .as_str()
                    .is_some_and(|handle| codex_usage_sessions.release(handle));
                serde_json::json!({"released":released})
            }
            Ok(request) if request.op == "codex_usage_fetch" => {
                let result = request.credential_handle.as_str().map_or(
                    singularity_backend::codex_usage::CodexUsageResult::NoSessions,
                    |handle| runtime.block_on(codex_usage_sessions.fetch(handle)),
                );
                match result {
                    singularity_backend::codex_usage::CodexUsageResult::NoSessions => {
                        serde_json::json!({"kind":"no_sessions"})
                    }
                    singularity_backend::codex_usage::CodexUsageResult::TransportFailure => {
                        serde_json::json!({"kind":"transport_failure"})
                    }
                    singularity_backend::codex_usage::CodexUsageResult::TimeoutFailure => {
                        serde_json::json!({"kind":"timeout_failure"})
                    }
                    singularity_backend::codex_usage::CodexUsageResult::Response {
                        status,
                        retry_after,
                        body,
                    } => {
                        let body = match body {
                            Ok(value) => serde_json::json!({"ok":value}),
                            Err(singularity_backend::codex_usage::BodyReadFailure::Terminated) => {
                                serde_json::json!({"err":"terminated"})
                            }
                        };
                        serde_json::json!({"kind":"response","status":status,"retry_after":retry_after,"body":body})
                    }
                }
            }
            Ok(request) if request.op == "claude_usage_fetch" => {
                let result =
                    runtime.block_on(singularity_backend::claude_usage::fetch_claude_usage(
                        request.access_token.as_str().unwrap_or(""),
                        request
                            .header_timeout_ms
                            .as_u64()
                            .unwrap_or(10_000)
                            .min(10_000),
                    ));
                match result {
                    singularity_backend::claude_usage::ClaudeUsageResult::TransportFailure => {
                        serde_json::json!({"kind":"transport_failure"})
                    }
                    singularity_backend::claude_usage::ClaudeUsageResult::TimeoutFailure => {
                        serde_json::json!({"kind":"timeout_failure"})
                    }
                    singularity_backend::claude_usage::ClaudeUsageResult::Response {
                        status,
                        retry_after,
                        body,
                    } => {
                        let body = match body {
                            Ok(value) => serde_json::json!({"ok":value}),
                            Err(_) => serde_json::json!({"err":"terminated"}),
                        };
                        serde_json::json!({"kind":"response","status":status,"retry_after":retry_after,"body":body})
                    }
                }
            }
            Ok(request) if request.op == "claude_oauth_refresh" => {
                let result =
                    runtime.block_on(singularity_backend::claude_oauth::refresh_claude_oauth(
                        request.oauth_body.as_str().unwrap_or(""),
                        request
                            .header_timeout_ms
                            .as_u64()
                            .unwrap_or(10_000)
                            .min(10_000),
                    ));
                match result {
                    singularity_backend::claude_oauth::ClaudeOauthRefreshResult::TransportFailure => {
                        serde_json::json!({"kind":"transport_failure"})
                    }
                    singularity_backend::claude_oauth::ClaudeOauthRefreshResult::TimeoutFailure => {
                        serde_json::json!({"kind":"timeout_failure"})
                    }
                    singularity_backend::claude_oauth::ClaudeOauthRefreshResult::Response {
                        status,
                        retry_after,
                        body,
                    } => {
                        let body = match body {
                            Ok(value) => serde_json::json!({"ok":value}),
                            Err(_) => serde_json::json!({"err":"terminated"}),
                        };
                        serde_json::json!({"kind":"response","status":status,"retry_after":retry_after,"body":body})
                    }
                }
            }
            Ok(request) if request.op == "claude_credentials_read" => {
                match singularity_backend::claude_credentials::read(std::path::Path::new(
                    request.path.as_str().unwrap_or(""),
                )) {
                    singularity_backend::claude_credentials::ClaudeCredentialsRead::File(text) => {
                        serde_json::json!({"kind":"file","text":text})
                    }
                    singularity_backend::claude_credentials::ClaudeCredentialsRead::Missing => {
                        serde_json::json!({"kind":"missing"})
                    }
                    singularity_backend::claude_credentials::ClaudeCredentialsRead::ReadFailure => {
                        serde_json::json!({"kind":"read_failure"})
                    }
                }
            }
            Ok(request) if request.op == "claude_credentials_write" => {
                let path = request.path.as_str().unwrap_or("");
                let temp_path = request.temp_path.as_str().unwrap_or("");
                let text = request.credential_text.as_str().unwrap_or("");
                serde_json::json!({
                    "ok": singularity_backend::claude_credentials::write(
                        std::path::Path::new(path),
                        std::path::Path::new(temp_path),
                        text,
                    )
                })
            }
            Ok(request) if request.op == "codex_thread_find" => {
                singularity_backend::codex_thread_identity::find(
                    request.codex_identity_home.as_str(),
                    request.cwd.as_str(),
                    request.spawned_at.as_i64(),
                )
            }
            Ok(request) if request.op == "codex_thread_exists" => {
                singularity_backend::codex_thread_identity::exists(
                    request.codex_identity_home.as_str(),
                    request.cwd.as_str(),
                    request.thread_id.as_str(),
                )
            }
            Ok(request) if request.op == "status_get" => {
                serde_json::json!({"error":"status request requires correlated framing"})
            }
            Ok(request) if request.op == "graph" => {
                let root = request.root.as_str().unwrap_or("");
                let wiki = request.wiki.as_str().unwrap_or("");
                match singularity_backend::wiki_graph(root, wiki) {
                    Ok(graph) => {
                        serde_json::to_value(graph).expect("graph serialization is infallible")
                    }
                    Err(error) => {
                        serde_json::to_value(error).expect("error serialization is infallible")
                    }
                }
            }
            Ok(request) if request.op == "plan_sessions" => {
                singularity_backend::plans::list_sessions(request.root.as_str())
            }
            Ok(request) if request.op == "rule_reference" => {
                singularity_backend::rules::find_reference(
                    request.path.as_str(),
                    request.root.as_str(),
                )
            }
            Ok(request) if request.op == "rules_files" => {
                singularity_backend::rules::list_files(&request.roots)
            }
            Ok(request) if request.op == "rules_search" => {
                singularity_backend::rules::search(&request.roots, &request.q)
            }
            Ok(request) if request.op == "rules_write" => singularity_backend::rules::write_file(
                request.path.as_str(),
                request.content.as_str(),
                request.mtime.as_f64(),
                request.force.as_bool().unwrap_or(false),
            ),
            Ok(request) if request.op == "skills_list" => {
                singularity_backend::skills::list(&request.root)
            }
            Ok(request) if request.op == "skill_read" => singularity_backend::skills::read_skill(
                &request.root,
                &request.scope,
                &request.skill,
                &request.flat,
            ),
            Ok(request) if request.op == "skill_file_read" => {
                singularity_backend::skills::read_skill_file(
                    &request.root,
                    &request.scope,
                    &request.skill,
                    &request.file,
                    &request.flat,
                )
            }
            Ok(request) if request.op == "skill_write" => singularity_backend::skills::write_file(
                request.path.as_str(),
                request.content.as_str(),
                request.mtime.as_f64(),
                request.force.as_bool().unwrap_or(false),
            ),
            Ok(request) if request.op == "memory_write" => singularity_backend::memory::write_file(
                request.path.as_str(),
                request.content.as_str(),
                request.mtime.as_f64(),
                request.force.as_bool().unwrap_or(false),
            ),
            Ok(request) if request.op == "config_write" => {
                singularity_backend::config_write::write_file(
                    request.path.as_str(),
                    request.content.as_str(),
                    request.mtime.as_f64(),
                    request.force.as_bool().unwrap_or(false),
                )
            }
            Ok(request) if request.op == "codex_config_write" => {
                singularity_backend::codex_config_write::write_file(
                    request.path.as_str(),
                    request.content.as_str(),
                    request.mtime.as_f64(),
                    request.force.as_bool().unwrap_or(false),
                )
            }
            Ok(request) if request.op == "hooks_write" => {
                singularity_backend::hooks_write::write_file(
                    request.path.as_str(),
                    request.content.as_str(),
                    request.mtime.as_f64(),
                    request.force.as_bool().unwrap_or(false),
                )
            }
            Ok(request) if request.op == "explorer_state_get" => {
                singularity_backend::explorer_state::get(request.path.as_str().unwrap_or(""))
            }
            Ok(request) if request.op == "explorer_state_set" => {
                singularity_backend::explorer_state::set(
                    request.path.as_str().unwrap_or(""),
                    &request.state,
                )
            }
            Ok(request) if request.op == "explorer_write" => {
                singularity_backend::explorer_fs::write(
                    request.path.as_str(),
                    &request.content,
                    request.mtime.as_f64(),
                    request.force.as_bool().unwrap_or(false),
                )
            }
            Ok(request) if request.op == "explorer_create" => {
                singularity_backend::explorer_fs::create(
                    request.path.as_str(),
                    request.kind.as_str(),
                )
            }
            Ok(request) if request.op == "explorer_delete" => {
                singularity_backend::explorer_fs::delete(request.path.as_str())
            }
            Ok(request) if request.op == "explorer_rename" => {
                singularity_backend::explorer_fs::rename(request.from.as_str(), request.to.as_str())
            }
            Ok(request) if request.op == "oneshot" => singularity_backend::oneshot::run(
                request.bin.as_str(),
                &request.args,
                request.timeout_ms.as_f64(),
                request.max_buffer.as_f64(),
                Some(&request.env),
            ),
            Ok(request) if request.op == "git" => singularity_backend::oneshot::run_git(
                request.bin.as_str(),
                &request.args,
                request.timeout_ms.as_f64(),
                request.max_buffer.as_f64(),
                Some(&request.env),
            ),
            Ok(request) if request.op == "detached_spawn" => singularity_backend::detached::spawn(
                request.bin.as_str(),
                &request.args,
                request.cwd.as_str(),
                &request.env,
            ),
            Ok(request) if request.op == "usage_keychain" => {
                singularity_backend::usage_auth::keychain(
                    request.platform.as_str(),
                    request.bin.as_str(),
                    &request.env,
                )
            }
            Ok(request) if request.op == "usage_auth_status" => {
                singularity_backend::usage_auth::auth_status(
                    request.bin.as_str(),
                    request.timeout_ms.as_f64().unwrap_or(10_000.0),
                    &request.env,
                )
            }
            Ok(request) if request.op.starts_with("usage_report_") => {
                match serde_json::from_value::<singularity_backend::usage_report::Request>(
                    request.usage_report,
                ) {
                    Ok(report_request) => match request.op.as_str() {
                        "usage_report_status" => serde_json::to_value(
                            singularity_backend::usage_report::status(&report_request),
                        )
                        .unwrap_or(Value::Null),
                        "usage_report_read" => serde_json::to_value(
                            singularity_backend::usage_report::read(&report_request),
                        )
                        .unwrap_or(Value::Null),
                        "usage_report_generate" => singularity_backend::usage_report::generate(
                            &report_request,
                            |bin, args, timeout, cap, env| {
                                singularity_backend::oneshot::run(
                                    Some(bin),
                                    &serde_json::json!(args),
                                    Some(timeout),
                                    Some(cap),
                                    Some(env),
                                )
                            },
                        ),
                        _ => serde_json::json!({"error":"unknown usage report operation"}),
                    },
                    Err(_) => serde_json::json!({"error":"bad usage report request"}),
                }
            }
            Ok(request) if request.op == "procs_kill" => {
                singularity_backend::procs::kill(&request.pid)
            }
            Ok(request) if request.op == "plan_session" => {
                match (request.path.as_str(), request.sid.as_str()) {
                    (Some(path), Some(sid)) => singularity_backend::plans::get_session(path, sid),
                    _ => serde_json::json!({ "ok": false, "error": "not found" }),
                }
            }
            Ok(request) if request.op == "model_prices" => match request.path.as_str() {
                Some(path) => singularity_backend::model_prices::read_pricing(path),
                None => serde_json::json!({ "error": "pricing path missing" }),
            },
            Ok(request) if request.op == "models_get" => {
                singularity_backend::models::get(request.path.as_str().unwrap_or(""))
            }
            Ok(request) if request.op == "models_set" => singularity_backend::models::set(
                request.path.as_str().unwrap_or(""),
                &request.state,
            ),
            Ok(request) if request.op == "models_restore" => {
                singularity_backend::models::restore(request.path.as_str().unwrap_or(""))
            }
            Ok(request) if request.op == "model_route" => singularity_backend::models::route(
                request.path.as_str().unwrap_or(""),
                &request.model,
                &request.tool,
            ),
            Ok(request) if request.op == "models_summariser" => {
                singularity_backend::models::summariser(request.path.as_str().unwrap_or(""))
            }
            Ok(request) if request.op == "keys_get" => {
                singularity_backend::keys::get(request.path.as_str().unwrap_or(""))
            }
            Ok(request) if request.op == "keys_set" => {
                singularity_backend::keys::set(request.path.as_str().unwrap_or(""), &request.patch)
            }
            Ok(request) if request.op == "config_state_get" => {
                singularity_backend::config_state::get(request.path.as_str().unwrap_or(""))
            }
            Ok(request) if request.op == "config_state_set" => {
                singularity_backend::config_state::set(
                    request.path.as_str().unwrap_or(""),
                    &request.patch,
                )
            }
            Ok(request) if request.op == "window_anchor_load" => {
                singularity_backend::window_anchor::load(request.path.as_str().unwrap_or(""))
            }
            Ok(request) if request.op == "window_anchor_save" => {
                singularity_backend::window_anchor::save(
                    request.path.as_str().unwrap_or(""),
                    &request.state,
                )
            }
            Ok(request) if request.op == "window_anchor_telemetry" => {
                singularity_backend::window_anchor::append_telemetry(
                    request.path.as_str().unwrap_or(""),
                    &request.record,
                )
            }
            Ok(request) => singularity_backend::wiki_read::dispatch(
                &request.op,
                &request.root,
                &request.q,
                &request.path,
                &request.wiki_order,
            ),
            Err(_) => serde_json::json!({ "error": "bad request" }),
        };
        if let Some(raw) = raw_response {
            write_response_line(&stdout, id.as_ref(), raw)?;
        } else {
            let response = match id {
                Some(id) => serde_json::json!({ "id": id, "response": response }),
                None => response,
            };
            write_line(&stdout, &response)?;
        }
    }
    begin_shutdown(&stdout, &shutting_down)?;
    sysstats.stop();
    runtime.shutdown_timeout(std::time::Duration::from_secs(1));
    Ok(())
}

#[derive(Deserialize)]
struct SnapshotWireRequest {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    op: String,
    operation: Option<String>,
    path: Option<std::path::PathBuf>,
    live_path: Option<std::path::PathBuf>,
    archive_dir: Option<std::path::PathBuf>,
    selected_archive_path: Option<std::path::PathBuf>,
    directory: Option<std::path::PathBuf>,
    reading: Option<Box<RawValue>>,
    raw: Option<Box<RawValue>>,
    cost_reading: Option<singularity_backend::usage_snapshot::ClaudeCostReading>,
    cost_state: Option<bool>,
    fetched_at_ms: Option<i64>,
    now_ms: Option<i64>,
    max_age_ms: Option<i64>,
}

impl SnapshotWireRequest {
    fn into_snapshot(self) -> Option<singularity_backend::usage_snapshot::SnapshotRequest> {
        use singularity_backend::usage_snapshot::SnapshotRequest;
        let now_ms = self.now_ms?;
        Some(match self.operation.as_deref()? {
            "append_ollama" => SnapshotRequest::AppendOllama {
                path: self.path?,
                reading: self.reading?,
                now_ms,
            },
            "append_codex" => SnapshotRequest::AppendCodex {
                path: self.path?,
                reading: self.reading?,
                now_ms,
            },
            "append_claude" => SnapshotRequest::AppendClaude {
                live_path: self.live_path?,
                archive_dir: self.archive_dir?,
                cost_state: self.cost_state?,
                raw: self.raw?,
                now_ms,
                cost_reading: self.cost_reading.map(|mut reading| {
                    reading.fetched_at_ms = self.fetched_at_ms.or(reading.fetched_at_ms);
                    reading
                }),
            },
            "read_claude" => SnapshotRequest::ReadClaude {
                live_path: self.live_path?,
                selected_archive_path: self.selected_archive_path,
                max_age_ms: self.max_age_ms?,
                now_ms,
            },
            "read_codex" => SnapshotRequest::ReadCodex {
                path: self.path?,
                max_age_ms: self.max_age_ms?,
                now_ms,
            },
            "read_cost_state" => SnapshotRequest::ReadCostState {
                directory: self.directory?,
                max_age_ms: self.max_age_ms?,
                now_ms,
            },
            _ => return None,
        })
    }
}

#[derive(Deserialize)]
struct ProviderUsageRequest {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    op: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    payload_present: bool,
    #[serde(default)]
    payload: Option<Box<RawValue>>,
    #[serde(default)]
    plan: Option<Box<RawValue>>,
    #[serde(default)]
    fetched_at: Option<String>,
}

fn write_line<W: Write>(stdout: &Mutex<W>, value: &Value) -> io::Result<()> {
    let mut stdout = stdout
        .lock()
        .map_err(|_| io::Error::other("stdout writer poisoned"))?;
    write_value(&mut *stdout, value)
}

fn write_response_line<W: Write>(
    stdout: &Mutex<W>,
    id: Option<&Value>,
    body: singularity_backend::transcript_bridge::ResponseBody,
) -> io::Result<()> {
    let mut stdout = stdout
        .lock()
        .map_err(|_| io::Error::other("stdout writer poisoned"))?;
    match body {
        singularity_backend::transcript_bridge::ResponseBody::Raw(raw) => match id {
            Some(id) => serde_json::to_writer(
                &mut *stdout,
                &singularity_backend::transcript_bridge::RawEnvelope { id, response: &raw },
            )?,
            None => serde_json::to_writer(&mut *stdout, &raw)?,
        },
        singularity_backend::transcript_bridge::ResponseBody::Value(value) => {
            let response = match id {
                Some(id) => serde_json::json!({ "id": id, "response": value }),
                None => value,
            };
            serde_json::to_writer(&mut *stdout, &response)?;
        }
    }
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn write_status_line<W: Write>(
    stdout: &Mutex<W>,
    shutting_down: &AtomicBool,
    value: &Value,
) -> io::Result<bool> {
    let mut stdout = stdout
        .lock()
        .map_err(|_| io::Error::other("stdout writer poisoned"))?;
    if shutting_down.load(Ordering::Acquire) {
        return Ok(false);
    }
    write_value(&mut *stdout, value)?;
    Ok(true)
}

fn begin_shutdown<W: Write>(stdout: &Mutex<W>, shutting_down: &AtomicBool) -> io::Result<()> {
    let _stdout = stdout
        .lock()
        .map_err(|_| io::Error::other("stdout writer poisoned"))?;
    shutting_down.store(true, Ordering::Release);
    Ok(())
}

fn write_value<W: Write>(writer: &mut W, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[cfg(test)]
mod status_shutdown_tests {
    use super::*;
    use std::sync::Barrier;
    use std::thread;

    #[test]
    fn shutdown_and_status_reply_share_one_output_linearization_lock() {
        let stdout = Arc::new(Mutex::new(Vec::<u8>::new()));
        let shutting_down = Arc::new(AtomicBool::new(false));
        let start = Arc::new(Barrier::new(3));
        let reply = serde_json::json!({ "type": "status_reply" });

        let writer = {
            let stdout = stdout.clone();
            let shutting_down = shutting_down.clone();
            let start = start.clone();
            let reply = reply.clone();
            thread::spawn(move || {
                start.wait();
                write_status_line(&stdout, &shutting_down, &reply).unwrap();
            })
        };
        let shutdown = {
            let stdout = stdout.clone();
            let shutting_down = shutting_down.clone();
            let start = start.clone();
            thread::spawn(move || {
                start.wait();
                begin_shutdown(&stdout, &shutting_down).unwrap();
            })
        };

        start.wait();
        writer.join().unwrap();
        shutdown.join().unwrap();
        let bytes_after_shutdown = stdout.lock().unwrap().len();
        assert!(!write_status_line(&stdout, &shutting_down, &reply).unwrap());
        assert_eq!(stdout.lock().unwrap().len(), bytes_after_shutdown);
        assert!(shutting_down.load(Ordering::Acquire));
    }
}

#[cfg(test)]
mod transcript_framing_tests {
    use super::*;
    use serde_json::value::RawValue;

    #[test]
    fn raw_transcript_body_keeps_correlated_envelope_and_newline_flush() {
        let stdout = Mutex::new(Vec::<u8>::new());
        let id = Value::String("transcript-1".into());
        let raw = RawValue::from_string(r#"{"messages":[{"text":"\ud800"}]}"#.into()).unwrap();
        write_response_line(
            &stdout,
            Some(&id),
            singularity_backend::transcript_bridge::ResponseBody::Raw(raw),
        )
        .unwrap();
        let output = stdout.into_inner().unwrap();
        assert_eq!(output.last(), Some(&b'\n'));
        assert_eq!(output.iter().filter(|byte| **byte == b'\n').count(), 1);
        let line = std::str::from_utf8(&output).unwrap();
        assert!(
            line.contains(r#""id":"transcript-1","response":{"messages":[{"text":"\ud800"}]}"#)
        );
    }

    #[test]
    fn flat_transcript_request_fields_do_not_collide_with_legacy_root_and_query() {
        let request: Request = serde_json::from_str(
            r#"{"op":"transcripts_search","root":"wiki-root","q":"wiki-query","transcript_root":"claude-root","transcript_q_units":[55296]}"#,
        )
        .unwrap();
        assert_eq!(request.root.as_str(), Some("wiki-root"));
        assert_eq!(request.q.as_str(), Some("wiki-query"));
        assert_eq!(request.transcript.root.as_deref(), Some("claude-root"));
        assert_eq!(request.transcript.q_units.as_deref(), Some(&[0xd800][..]));
    }
}
