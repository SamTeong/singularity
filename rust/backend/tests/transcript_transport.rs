//! Real-stdio transport for the transcript wire protocol.
//!
//! `Request` (`rust/backend/src/main.rs`) owns the legacy `cap`/`now_ms` keys,
//! so serde never hands them to the flattened `TranscriptRequest`. Drive the
//! built binary and assert both transcript framings still honor an explicit
//! `cap`/`now_ms`, and fall back to the transcript defaults when they are absent.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!("transcript-transport-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let project = root.join("projects").join("p");
    std::fs::create_dir_all(&project).unwrap();
    for id in ["a", "b"] {
        std::fs::write(
            project.join(format!("{id}.jsonl")),
            "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n",
        )
        .unwrap();
    }
    root
}

struct Wire {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

impl Wire {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_singularity-backend"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the backend stdio binary");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Self { child, stdin, lines }
    }

    fn send(&mut self, value: &Value) {
        writeln!(self.stdin, "{value}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn next(&self) -> Value {
        let line = self
            .lines
            .recv_timeout(Duration::from_secs(30))
            .expect("the backend answered on stdout");
        serde_json::from_str(&line).unwrap()
    }

    fn reply(&self, id: &str) -> Value {
        loop {
            let value = self.next();
            if value["id"] == id {
                return value;
            }
        }
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn list_request(root: &Path, id: &str, framing: Value) -> Value {
    let mut request = json!({
        "op": "transcripts_list",
        "id": id,
        "state_dir": root.join("state"),
        "claude_home": root,
        "codex_home": root.join("codex"),
        "model_catalog": [],
        "transcript_root": root.join("projects"),
    });
    for (key, value) in framing.as_object().unwrap() {
        request[key] = value.clone();
    }
    request
}

fn assert_one_row(reply: &Value, recent: bool) {
    let rows = reply["response"].as_array().expect("list returns a raw array");
    assert_eq!(rows.len(), 1, "requested cap 1: {reply}");
    assert_eq!(rows[0]["activityRecent"], recent, "{reply}");
}

// VERIFY: transcript-stdio-cap-clock
#[test]
fn transcript_cap_and_clock_survive_both_stdio_framings() {
    let root = fixture();
    let mut wire = Wire::start();
    assert_eq!(wire.next()["ready"], true);

    // Typed framing: `{type:"transcript_reply",…}`. now_ms 0 matches the direct
    // `TranscriptServices` dispatch (`recent(0, mtime)` is true).
    wire.send(&list_request(
        &root,
        "typed",
        json!({"type": "transcript_request", "cap": 1, "now_ms": 0}),
    ));
    let typed = wire.reply("typed");
    assert_eq!(typed["type"], "transcript_reply", "{typed}");
    assert_one_row(&typed, true);

    // Legacy ordinary framing: `{id, response}`. A clock past the fixture's
    // mtime must reach the service, so this row is no longer "recent".
    wire.send(&list_request(
        &root,
        "legacy",
        json!({"cap": 1, "now_ms": 1_000_000_000_000_000u64}),
    ));
    assert_one_row(&wire.reply("legacy"), false);

    // Defaults: no cap/now_ms keeps the transcript-service behavior.
    wire.send(&list_request(&root, "defaults", json!({"type": "transcript_request"})));
    let defaults = wire.reply("defaults");
    let rows = defaults["response"].as_array().expect("list returns a raw array");
    assert_eq!(rows.len(), 2, "default cap keeps both rows: {defaults}");
    assert!(
        rows.iter().all(|row| row["activityRecent"] == true),
        "default clock marks fresh rows recent: {defaults}"
    );
    std::fs::remove_dir_all(root).unwrap();
}
