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
            Ok(request) if request.op == "plan_session" => {
                match (request.path.as_str(), request.sid.as_str()) {
                    (Some(path), Some(sid)) => singularity_backend::plans::get_session(path, sid),
                    _ => serde_json::json!({ "ok": false, "error": "not found" }),
                }
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
