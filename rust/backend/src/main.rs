use serde::Deserialize;
use serde_json::Value;
use std::io::{self, BufRead, Write};

#[derive(Deserialize)]
struct Request {
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
}

fn default_op() -> String {
    "graph".to_owned()
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut stdout, &serde_json::json!({ "ready": true }))?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    for line in stdin.lock().lines() {
        let line = line?;
        let response = match serde_json::from_str::<Request>(&line) {
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
                )
            }
            Ok(request) if request.op == "usage_auth_status" => {
                singularity_backend::usage_auth::auth_status(
                    request.bin.as_str(),
                    request.timeout_ms.as_f64().unwrap_or(10_000.0),
                )
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
            Ok(request) => singularity_backend::wiki_read::dispatch(
                &request.op,
                &request.root,
                &request.q,
                &request.path,
                &request.wiki_order,
            ),
            Err(_) => serde_json::json!({ "error": "bad request" }),
        };
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}
