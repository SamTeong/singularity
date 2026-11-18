//! WebSocket protocol tests (tags_a); child of `http_ws::tests`.
//!
//! The spawn-shaped client tags — `create`, `fork`, `reattach` — plus `txmeta`
//! for an existing id. Node reference: the switch in `server/pty-ws.mjs:134-196`
//! dispatching into `server/agents.mjs` (`create` `:437-467`, `reattach`
//! `:501-515`, `fork` `:566-578`, `getWritten` `:134`).

// The parent's fixture helpers are named explicitly rather than glob-imported:
// a child module only reliably inherits items *declared* in its parent, and
// naming them keeps this file independent of the glob chain's reach.
use super::{FakePort, Fixture, RawClient, create_input, deps, run, serve, snapshot};
use crate::agent_registry::RING_MAX;
use crate::pty::PtyEvent;
use serde_json::{Value, json};
use std::fs;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

fn tag(frame: &Value) -> &str {
    frame.get("t").and_then(Value::as_str).unwrap_or_default()
}

fn frame_with<'a>(frames: &'a [Value], wanted: &str) -> &'a Value {
    frames
        .iter()
        .find(|frame| tag(frame) == wanted)
        .unwrap_or_else(|| panic!("no {wanted} frame in {frames:?}"))
}

fn object_keys(frame: &Value) -> Vec<&str> {
    frame
        .as_object()
        .expect("a JSON object")
        .keys()
        .map(|key| key.as_str())
        .collect()
}

// VERIFY: wave9-tags_a-1 — the frames a spawning tag produces: `list` (the
// registry's `emitList()` broadcast) and `attached` (the direct reply,
// `pty-ws.mjs:141-158`). Node runs `emitList()` synchronously inside
// `reg.create`/`reg.fork`/`reg.reattach` (`agents.mjs:465`, `:513`) and only
// then sends the reply, so Node's order is `list`, `attached`. The native
// socket task drains the frames the handler queued before its replies
// (`queued_then`, VERIFY wave10-ws_order-1), so the order is pinned.
async fn spawn_frames(client: &mut RawClient) -> Vec<Value> {
    let first = client.json().await;
    let second = client.json().await;
    let frames = vec![first, second];
    let tags: Vec<&str> = frames.iter().map(|frame| tag(frame)).collect();
    assert_eq!(tags, ["list", "attached"], "unexpected frames: {frames:?}");
    frames
}

// VERIFY: wave9-tags_a-2
#[test]
fn create_broadcasts_the_new_list_and_replies_attached() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        let server = serve(deps(
            &fixture,
            registry.clone(),
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut creator = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut creator).await;
        let mut observer = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut observer).await;

        creator
            .send_text(
                &json!({
                    "t": "create",
                    "cwd": fixture.repo(),
                    "title": "demo",
                    "model": "claude",
                    "scopes": ["coding"],
                    "sessionId": "ws-create",
                })
                .to_string(),
            )
            .await;

        // `reg.create` then `ws.attached.add(na.id); send(ws, {t:'attached'})`
        // (`pty-ws.mjs:139-147`), with `emitList()` broadcasting the new list to
        // every socket (`agents.mjs:465`, `:217`).
        let frames = spawn_frames(&mut creator).await;
        let list = frame_with(&frames, "list");
        let attached = frame_with(&frames, "attached");
        assert_eq!(*attached, json!({ "t": "attached", "id": "ws-create" }));

        assert_eq!(list["t"], "list");
        assert_eq!(list["recentRepos"], json!([fixture.repo()]));
        let agents = list["agents"].as_array().expect("an agents array");
        assert_eq!(agents.len(), 1, "{list}");
        let agent = &agents[0];
        // `snapshot()`'s field set, in the order `JSON.stringify` writes it
        // (`agents.mjs:126-128`); `pid`/`createdAt` are runtime values.
        assert_eq!(
            object_keys(agent),
            [
                "id",
                "title",
                "cwd",
                "status",
                "pid",
                "createdAt",
                "model",
                "scopes"
            ]
        );
        assert_eq!(agent["id"], "ws-create");
        assert_eq!(agent["title"], "demo");
        assert_eq!(agent["cwd"], json!(fixture.repo()));
        assert_eq!(agent["status"], "starting");
        assert_eq!(agent["model"], "claude");
        assert_eq!(agent["scopes"], json!(["coding"]));
        assert!(agent["pid"].is_u64(), "{list}");
        assert!(agent["createdAt"].is_i64(), "{list}");

        // The same broadcast reaches a socket that did not send the request.
        assert_eq!(observer.json().await, *list);

        // `ws.attached.add(na.id)`: output for the new agent now reaches the
        // creator (broadcast `status` first, then the filtered `output`).
        let generation = port.generation("ws-create");
        registry.on_pty_event(PtyEvent::Output {
            id: "ws-create".to_owned(),
            generation,
            bytes: b"hi".to_vec(),
        });
        assert_eq!(
            creator.json().await,
            json!({ "t": "status", "id": "ws-create", "status": "running" })
        );
        assert_eq!(
            creator.json().await,
            json!({ "t": "output", "id": "ws-create", "data": "hi" })
        );
    });
}

// VERIFY: wave9-tags_a-3
#[test]
fn create_reports_the_node_errors_for_a_missing_cwd_and_a_taken_id() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        registry.create(create_input(&fixture, "taken")).unwrap();
        let server = serve(deps(
            &fixture,
            registry,
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // `if (!cwd || !existsSync(cwd)) throw new Error(...)` (`agents.mjs:451`)
        // surfaces as `spawn failed: …` (`pty-ws.mjs:146-147`).
        client
            .send_text(&json!({ "t": "create", "sessionId": "no-cwd" }).to_string())
            .await;
        assert_eq!(
            client.json().await,
            json!({
                "t": "error",
                "msg": "spawn failed: working directory does not exist: (empty)",
            })
        );

        // `if (existing.proc) throw new Error('session id already in use')`
        // (`agents.mjs:442`).
        client
            .send_text(
                &json!({
                    "t": "create",
                    "cwd": fixture.repo(),
                    "model": "claude",
                    "sessionId": "taken",
                })
                .to_string(),
            )
            .await;
        assert_eq!(
            client.json().await,
            json!({ "t": "error", "msg": "spawn failed: session id already in use" })
        );
    });
}

// VERIFY: wave9-tags_a-4
#[test]
fn create_on_a_detached_id_resumes_it_instead_of_erroring() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        // A restarted daemon reloads `agents.json` as detached, proc-less
        // entries (`init()` `agents.mjs:107-119`, `Registry::load`).
        fs::write(
            fixture.root.join("state/agents.json"),
            json!({
                "agents": [{
                    "id": "resume-me",
                    "title": "demo",
                    "cwd": fixture.repo(),
                    "createdAt": 1,
                    "model": "claude",
                    "activeMs": 0,
                    "status": "exited",
                }],
                "recentRepos": [fixture.repo()],
            })
            .to_string(),
        )
        .unwrap();
        registry.load().unwrap();
        let server = serve(deps(
            &fixture,
            registry,
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // `if (existing) { if (existing.proc) throw …; return reattach(id); }`
        // (`agents.mjs:441-448`): a dead id resumes and keeps its own title,
        // model and scopes instead of failing or duplicating the entry.
        client
            .send_text(
                &json!({
                    "t": "create",
                    "cwd": fixture.repo(),
                    "title": "ignored",
                    "model": "claude",
                    "sessionId": "resume-me",
                })
                .to_string(),
            )
            .await;

        let frames = spawn_frames(&mut client).await;
        let list = frame_with(&frames, "list");
        let attached = frame_with(&frames, "attached");
        assert_eq!(*attached, json!({ "t": "attached", "id": "resume-me" }));
        let agents = list["agents"].as_array().expect("an agents array");
        assert_eq!(agents.len(), 1, "{list}");
        assert_eq!(agents[0]["id"], "resume-me");
        assert_eq!(agents[0]["title"], "demo");
        assert_eq!(agents[0]["status"], "starting");
        assert!(agents[0]["pid"].is_u64(), "{list}");
        port.generation("resume-me");
    });
}

// VERIFY: wave9-tags_a-5
#[test]
fn fork_copies_the_transcript_and_broadcasts_the_new_list() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        registry.create(create_input(&fixture, "src-fork")).unwrap();
        // `fork` copies `~/.claude/projects/<encoded-cwd>/<src>.jsonl` with every
        // source id rewritten to the new one (`agents.mjs:547-557`).
        let dir = fixture
            .root
            .join("home")
            .join(".claude")
            .join("projects")
            .join(crate::agent_spawn::encode_cwd(&fixture.repo()));
        fs::create_dir_all(&dir).unwrap();
        let source = "{\"uuid\":\"src-fork\"}\nsrc-fork again\n".to_owned();
        fs::write(dir.join("src-fork.jsonl"), &source).unwrap();

        let server = serve(deps(
            &fixture,
            registry,
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        client
            .send_text(&json!({ "t": "fork", "id": "src-fork", "title": "copy" }).to_string())
            .await;

        let frames = spawn_frames(&mut client).await;
        let list = frame_with(&frames, "list");
        let attached = frame_with(&frames, "attached");
        let new_id = attached["id"].as_str().expect("a forked id").to_owned();
        assert_ne!(new_id, "src-fork");
        assert_eq!(new_id.len(), 36, "randomUUID shape: {new_id}");

        let agents = list["agents"].as_array().expect("an agents array");
        assert_eq!(agents.len(), 2, "{list}");
        let forked = agents
            .iter()
            .find(|agent| agent.get("id").and_then(Value::as_str) == Some(new_id.as_str()))
            .expect("the fork in the list");
        assert_eq!(forked["title"], "copy");
        assert_eq!(forked["cwd"], json!(fixture.repo()));
        assert_eq!(forked["model"], "claude");
        assert_eq!(forked["status"], "starting");
        assert!(forked["pid"].is_u64(), "{list}");
        port.generation(&new_id);

        // The copied log carries the new id everywhere the source id appeared;
        // the source log is untouched.
        let copied = fs::read_to_string(dir.join(format!("{new_id}.jsonl"))).unwrap();
        assert_eq!(copied, source.replace("src-fork", &new_id));
        assert_eq!(
            fs::read_to_string(dir.join("src-fork.jsonl")).unwrap(),
            source
        );
    });
}

// VERIFY: wave9-tags_a-6
#[test]
fn fork_of_an_unknown_id_reports_the_node_error() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let server = serve(deps(
            &fixture,
            registry,
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // `if (!src) throw new Error('source not found')` (`agents.mjs:567`) →
        // `fork failed: …` (`pty-ws.mjs:151-152`); nothing joins the list.
        client
            .send_text(&json!({ "t": "fork", "id": "missing", "title": "copy" }).to_string())
            .await;
        assert_eq!(
            client.json().await,
            json!({ "t": "error", "msg": "fork failed: source not found" })
        );
    });
}

// VERIFY: wave9-tags_a-7
#[test]
fn reattach_of_a_live_agent_replies_attached_without_a_list() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        let agent = registry.create(create_input(&fixture, "live")).unwrap();
        let server = serve(deps(
            &fixture,
            registry.clone(),
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // `if (!a || a.proc) return a` (`agents.mjs:502`): a live entry comes
        // back unchanged, so no pty is spawned, `emitList()` never runs and the
        // only frame is `attached` (`pty-ws.mjs:156-159`).
        client
            .send_text(&json!({ "t": "reattach", "id": agent.id }).to_string())
            .await;
        assert_eq!(
            client.json().await,
            json!({ "t": "attached", "id": agent.id })
        );

        // `ws.attached.add(a.id)`: output for this agent now reaches the socket.
        let generation = port.generation(&agent.id);
        registry.on_pty_event(PtyEvent::Output {
            id: agent.id.clone(),
            generation,
            bytes: b"hi".to_vec(),
        });
        assert_eq!(
            client.json().await,
            json!({ "t": "status", "id": agent.id, "status": "running" })
        );
        assert_eq!(
            client.json().await,
            json!({ "t": "output", "id": agent.id, "data": "hi" })
        );
    });
}

// VERIFY: wave9-tags_a-8
#[test]
fn reattach_of_an_unknown_id_replies_nothing() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let server = serve(deps(
            &fixture,
            registry,
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // `reattach` returns undefined when the id is unknown, so `if (a)` skips
        // both the attach and the frame (`pty-ws.mjs:156-159`).
        client
            .send_text(&json!({ "t": "reattach", "id": "missing" }).to_string())
            .await;
        // The next frame is the probe below: the reattach answered nothing.
        client
            .send_text(&json!({ "t": "txmeta", "id": "missing" }).to_string())
            .await;
        assert_eq!(
            client.json().await,
            json!({ "t": "txmeta", "id": "missing", "written": 0, "ringMax": RING_MAX })
        );
    });
}

// VERIFY: wave9-tags_a-9
#[test]
fn reattach_of_a_detached_agent_resumes_and_broadcasts_the_list() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        fs::write(
            fixture.root.join("state/agents.json"),
            json!({
                "agents": [{
                    "id": "detached-one",
                    "title": "old title",
                    "cwd": fixture.repo(),
                    "createdAt": 1,
                    "model": "claude",
                    "activeMs": 0,
                    "status": "exited",
                }],
                "recentRepos": [fixture.repo()],
            })
            .to_string(),
        )
        .unwrap();
        registry.load().unwrap();
        let server = serve(deps(
            &fixture,
            registry,
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // A detached entry is resumed with its own config, re-registered live,
        // and the list broadcast follows (`agents.mjs:501-515`).
        client
            .send_text(&json!({ "t": "reattach", "id": "detached-one" }).to_string())
            .await;

        let frames = spawn_frames(&mut client).await;
        let list = frame_with(&frames, "list");
        let attached = frame_with(&frames, "attached");
        assert_eq!(*attached, json!({ "t": "attached", "id": "detached-one" }));
        let agents = list["agents"].as_array().expect("an agents array");
        assert_eq!(agents.len(), 1, "{list}");
        assert_eq!(agents[0]["id"], "detached-one");
        assert_eq!(agents[0]["title"], "old title");
        assert_eq!(agents[0]["status"], "starting");
        assert!(agents[0]["pid"].is_u64(), "{list}");
        port.generation("detached-one");
    });
}

// VERIFY: wave9-tags_a-10
#[test]
fn txmeta_for_an_existing_id_reports_written_bytes_and_the_ring_cap() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port.clone());
        let agent = registry.create(create_input(&fixture, "tx")).unwrap();
        // `getWritten()` is cumulative pty output (`agents.mjs:134`, `:235`);
        // emitted before a socket exists, so no frame is fanned out here.
        let generation = port.generation(&agent.id);
        registry.on_pty_event(PtyEvent::Output {
            id: agent.id.clone(),
            generation,
            bytes: b"abc".to_vec(),
        });
        let server = serve(deps(
            &fixture,
            registry,
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // `send(ws, { t:'txmeta', id, written: reg.getWritten(id), ringMax:
        // reg.RING_MAX })` (`pty-ws.mjs:171`).
        client
            .send_text(&json!({ "t": "txmeta", "id": agent.id }).to_string())
            .await;
        let frame = client.json().await;
        assert_eq!(
            frame,
            json!({ "t": "txmeta", "id": agent.id, "written": 3, "ringMax": RING_MAX })
        );
        assert_eq!(object_keys(&frame), ["t", "id", "written", "ringMax"]);
    });
}
