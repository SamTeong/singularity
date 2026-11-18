//! WebSocket protocol tests (tags_b); child of `http_ws::tests`.
//!
//! Covers the `resize`, `kill` and `reorder` tags (`pty-ws.mjs:145-147`) against
//! the pinned Node reference `agents.mjs:559-637`:
//!
//! - `resize` forwards the dimensions to a live pty and never replies;
//!   an unknown or detached id is a silent no-op (`:563-565`).
//! - `kill` kills a live pty and leaves the entry to its exit path (`:573-577`);
//!   a detached entry is dropped, persisted and broadcast as a `list` (`:578-580`).
//! - `reorder` accepts only a permutation of every current id and answers with a
//!   `list` broadcast; anything else is a no-op (`:628-637`).
//!
//! The `list` broadcast is asserted twice: on the bus (deterministic, no
//! `select!` scheduling involved) and on the socket (the frame the browser sees).

use super::*;

/// A pty port that records `resize`/`kill` so the registry's side effects are
/// observable without spawning anything.
#[derive(Default)]
struct RecordingPort {
    next_pid: AtomicU32,
    resizes: Mutex<Vec<(String, u16, u16)>>,
    kills: Mutex<Vec<String>>,
}

impl RecordingPort {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            next_pid: AtomicU32::new(2000),
            ..Self::default()
        })
    }

    fn resizes(&self) -> Vec<(String, u16, u16)> {
        self.resizes.lock().unwrap().clone()
    }

    fn kills(&self) -> Vec<String> {
        self.kills.lock().unwrap().clone()
    }
}

impl PtyPort for RecordingPort {
    fn spawn(&self, _id: &str, _generation: u64, _spec: LaunchSpec) -> Result<u32, String> {
        Ok(self.next_pid.fetch_add(1, Ordering::SeqCst))
    }

    fn write(&self, _id: &str, _data: &[u8]) -> Result<(), String> {
        Ok(())
    }

    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.resizes
            .lock()
            .unwrap()
            .push((id.to_owned(), cols, rows));
        Ok(())
    }

    fn kill(&self, id: &str) -> Result<(), String> {
        self.kills.lock().unwrap().push(id.to_owned());
        Ok(())
    }
}

/// A registry whose pty port records calls, over a bus the test also observes.
fn recording_registry(fixture: &Fixture, bus: Bus, port: Arc<RecordingPort>) -> Arc<Registry> {
    Arc::new(Registry::new(
        bus,
        port,
        RegistryConfig {
            state_file: fixture.root.join("state/agents.json"),
            bins: fixture.bins(),
            parent_env: Default::default(),
            clock: crate::agent_registry::system_clock(),
        },
    ))
}

/// Seed `state/agents.json` with entries `Registry::load` marks `live: false`
/// (`agents.mjs:107-123`): a restart's leftovers, which have no pty.
fn seed_dead(fixture: &Fixture, ids: &[&str]) {
    let agents: Vec<Value> = ids
        .iter()
        .map(|id| json!({ "id": id, "title": format!("title-{id}"), "cwd": fixture.repo() }))
        .collect();
    let file = json!({ "agents": agents, "recentRepos": [fixture.repo()] });
    fs::write(fixture.root.join("state/agents.json"), file.to_string()).unwrap();
}

/// Count `list` broadcasts on the registry's bus. Counting here instead of
/// relying on the socket makes "no frame" assertions independent of `select!`
/// branch order; the socket assertion then only proves the counter's frame
/// actually reaches the browser.
fn count_lists(registry: &Registry) -> Arc<AtomicUsize> {
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    registry.bus().subscribe(Arc::new(move |event: &BusEvent| {
        if matches!(event, BusEvent::List(_)) {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    }));
    count
}

/// Send a `txmeta` probe and assert it is the next frame. Every handler under
/// test replies with nothing, so the probe's own reply must be next.
async fn probe_txmeta(client: &mut RawClient, id: &str) -> Value {
    client
        .send_text(&json!({ "t": "txmeta", "id": id }).to_string())
        .await;
    let frame = client.json().await;
    assert_eq!(frame["t"], "txmeta", "unexpected frame: {frame}");
    assert_eq!(frame["id"], id);
    frame
}

fn snapshot_ids(registry: &Registry) -> Vec<String> {
    registry
        .snapshot()
        .into_iter()
        .map(|wire| wire.id)
        .collect()
}

// VERIFY: wave9-tags_b-resize-1
#[test]
fn ws_resize_forwards_cols_and_rows_and_never_replies() {
    run(async {
        let fixture = Fixture::new();
        let port = RecordingPort::new();
        let registry = recording_registry(&fixture, Bus::new(), port.clone());
        let agent = registry.create(create_input(&fixture, "resize")).unwrap();
        let lists = count_lists(&registry);
        let server = serve(deps(
            &fixture,
            registry,
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // `case 'resize': reg.resize(m.id, m.cols, m.rows); break;` — no send.
        client
            .send_text(
                &json!({ "t": "resize", "id": agent.id.clone(), "cols": 120, "rows": 40 })
                    .to_string(),
            )
            .await;

        let probe = probe_txmeta(&mut client, "probe").await;
        assert_eq!(probe["written"], json!(0));

        assert_eq!(port.resizes(), vec![(agent.id.clone(), 120, 40)]);
        assert_eq!(lists.load(Ordering::SeqCst), 0, "resize must not broadcast");
    });
}

// VERIFY: wave9-tags_b-resize-2
#[test]
fn registry_resize_forwards_to_live_agents_and_ignores_unknown_or_dead_ids() {
    let fixture = Fixture::new();
    seed_dead(&fixture, &["dead-resize"]);
    let port = RecordingPort::new();
    let registry = recording_registry(&fixture, Bus::new(), port.clone());
    registry.load().unwrap();
    let live = registry.create(create_input(&fixture, "live")).unwrap();

    // `agents.get(id)?.proc?.resize(cols, rows)` (`agents.mjs:564`): only a live
    // pty receives the dimensions.
    registry.resize(&live.id, 132, 43);
    assert_eq!(port.resizes(), vec![(live.id.clone(), 132, 43)]);

    // Unknown id: `agents.get(id)` is undefined, the call is skipped.
    registry.resize("missing", 80, 24);
    // A detached entry (`load`, `:118`) has no `proc`, so `?.proc` skips it too.
    registry.resize("dead-resize", 100, 30);

    assert_eq!(
        port.resizes(),
        vec![(live.id.clone(), 132, 43)],
        "only the live agent's pty is resized"
    );
}

// VERIFY: wave9-tags_b-kill-1
#[test]
fn ws_kill_of_a_live_agent_kills_the_pty_without_broadcasting() {
    run(async {
        let fixture = Fixture::new();
        let port = RecordingPort::new();
        let registry = recording_registry(&fixture, Bus::new(), port.clone());
        let agent = registry
            .create(create_input(&fixture, "kill-live"))
            .unwrap();
        let lists = count_lists(&registry);
        let server = serve(deps(
            &fixture,
            registry.clone(),
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        client
            .send_text(&json!({ "t": "kill", "id": agent.id.clone() }).to_string())
            .await;

        let _ = probe_txmeta(&mut client, "probe").await;

        // `if (a.proc) { a.proc.kill(); return; }` (`agents.mjs:574`): the exit
        // path owns the removal, so kill itself neither broadcasts nor drops the
        // entry — it stays until its pty reports the exit.
        assert_eq!(port.kills(), vec![agent.id.clone()]);
        assert_eq!(lists.load(Ordering::SeqCst), 0, "kill must not broadcast");
        assert_eq!(snapshot_ids(&registry), vec![agent.id.clone()]);
    });
}

// VERIFY: wave9-tags_b-kill-2
#[test]
fn ws_kill_of_a_detached_agent_removes_it_and_broadcasts_the_list() {
    run(async {
        let fixture = Fixture::new();
        seed_dead(&fixture, &["dead-a", "dead-b"]);
        let port = RecordingPort::new();
        let registry = recording_registry(&fixture, Bus::new(), port.clone());
        registry.load().unwrap();
        let lists = count_lists(&registry);
        let server = serve(deps(
            &fixture,
            registry,
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let frames = snapshot(&mut client).await;
        assert_eq!(frames[0]["agents"].as_array().unwrap().len(), 2);

        client
            .send_text(&json!({ "t": "kill", "id": "dead-a" }).to_string())
            .await;

        // `agents.delete(id); persist(); emitList();` (`agents.mjs:578-580`):
        // the survivor is the only agent in the broadcast the browser applies.
        let list = client.json().await;
        assert_eq!(list["t"], "list", "unexpected frame: {list}");
        assert_eq!(
            list["agents"],
            json!([{
                "id": "dead-b",
                "title": "title-dead-b",
                "cwd": fixture.repo(),
                "status": "detached",
            }])
        );
        assert_eq!(list["recentRepos"], json!([fixture.repo()]));
        assert_eq!(lists.load(Ordering::SeqCst), 1);

        // A detached entry has no pty: `if (a.proc)` is false on both sides.
        assert!(port.kills().is_empty(), "no pty to kill");
        let persisted: Value = serde_json::from_str(
            &fs::read_to_string(fixture.root.join("state/agents.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(persisted["agents"].as_array().unwrap().len(), 1);
        assert_eq!(persisted["agents"][0]["id"], "dead-b");
        assert_eq!(persisted["recentRepos"], json!([fixture.repo()]));
    });
}

// VERIFY: wave9-tags_b-reorder-1
#[test]
fn ws_reorder_applies_a_permutation_and_broadcasts_the_list() {
    run(async {
        let fixture = Fixture::new();
        let port = RecordingPort::new();
        let registry = recording_registry(&fixture, Bus::new(), port);
        let first = registry.create(create_input(&fixture, "one")).unwrap();
        let second = registry.create(create_input(&fixture, "two")).unwrap();
        let lists = count_lists(&registry);
        let server = serve(deps(
            &fixture,
            registry.clone(),
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let frames = snapshot(&mut client).await;
        assert_eq!(
            snapshot_ids(&registry),
            vec![first.id.clone(), second.id.clone()]
        );

        client
            .send_text(
                &json!({ "t": "reorder", "ids": [second.id.clone(), first.id.clone()] })
                    .to_string(),
            )
            .await;

        // `... rebuilds the Map in that insertion order, persists, and re-emits
        // the list` (`agents.mjs:634-636`).
        let list = client.json().await;
        assert_eq!(list["t"], "list", "unexpected frame: {list}");
        let order: Vec<&str> = list["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|agent| agent["id"].as_str().unwrap())
            .collect();
        assert_eq!(order, [second.id.as_str(), first.id.as_str()]);
        assert_eq!(frames[0]["agents"].as_array().unwrap().len(), 2);
        assert_eq!(lists.load(Ordering::SeqCst), 1);

        assert_eq!(
            snapshot_ids(&registry),
            vec![second.id.clone(), first.id.clone()],
            "the registry keeps the requested order"
        );
        let persisted: Value = serde_json::from_str(
            &fs::read_to_string(fixture.root.join("state/agents.json")).unwrap(),
        )
        .unwrap();
        let persisted_ids: Vec<&str> = persisted["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| record["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            persisted_ids,
            [second.id.as_str(), first.id.as_str()],
            "reorder persists the new order"
        );
    });
}

// VERIFY: wave9-tags_b-reorder-2
#[test]
fn ws_reorder_rejects_non_permutations_without_side_effects() {
    run(async {
        let fixture = Fixture::new();
        let port = RecordingPort::new();
        let registry = recording_registry(&fixture, Bus::new(), port);
        let first = registry.create(create_input(&fixture, "one")).unwrap();
        let second = registry.create(create_input(&fixture, "two")).unwrap();
        // A known baseline on disk, so "no persist" below is observable.
        registry.persist().unwrap();
        let lists = count_lists(&registry);
        let server = serve(deps(
            &fixture,
            registry.clone(),
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // `if (!Array.isArray(ids) || ids.length !== agents.size) return;` and
        // `if (!a) return;` — every rejected shape is the same silent no-op.
        let rejected = [
            json!({ "t": "reorder" }),                            // no `ids` at all
            json!({ "t": "reorder", "ids": "one,two" }),          // not an array
            json!({ "t": "reorder", "ids": [first.id.clone()] }), // wrong length
            json!({ "t": "reorder", "ids": [first.id.clone(), "missing"] }), // unknown id
            json!({ "t": "reorder", "ids": [first.id.clone(), first.id.clone()] }), // duplicate id
            json!({ "t": "reorder", "ids": [second.id.clone(), 42] }), // non-string id
        ];
        for (index, message) in rejected.iter().enumerate() {
            client.send_text(&message.to_string()).await;
            let _ = probe_txmeta(&mut client, &format!("probe-{index}")).await;
        }

        assert_eq!(
            lists.load(Ordering::SeqCst),
            0,
            "a rejected reorder is silent"
        );
        assert_eq!(
            snapshot_ids(&registry),
            vec![first.id.clone(), second.id.clone()]
        );
        let persisted: Value = serde_json::from_str(
            &fs::read_to_string(fixture.root.join("state/agents.json")).unwrap(),
        )
        .unwrap();
        let persisted_ids: Vec<&str> = persisted["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| record["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            persisted_ids,
            [first.id.as_str(), second.id.as_str()],
            "a rejected reorder never persists"
        );
    });
}

// VERIFY: wave9-tags_b-reorder-3
#[test]
fn ws_reorder_without_an_id_array_is_a_no_op_on_an_empty_registry() {
    run(async {
        let fixture = Fixture::new();
        let port = RecordingPort::new();
        let registry = recording_registry(&fixture, Bus::new(), port);
        let lists = count_lists(&registry);
        let server = serve(deps(
            &fixture,
            registry,
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // Node returns at `!Array.isArray(ids)` (`agents.mjs:629`): no persist,
        // no `list`. `ids: []` is the only empty shape Node accepts.
        client
            .send_text(&json!({ "t": "reorder" }).to_string())
            .await;
        let _ = probe_txmeta(&mut client, "probe-missing").await;
        client
            .send_text(&json!({ "t": "reorder", "ids": "one" }).to_string())
            .await;
        let _ = probe_txmeta(&mut client, "probe-string").await;

        assert_eq!(lists.load(Ordering::SeqCst), 0);
        assert!(
            !fixture.root.join("state/agents.json").exists(),
            "a rejected reorder must not persist"
        );

        // An empty array *is* a permutation of an empty registry (`agents.mjs:632-636`).
        client
            .send_text(&json!({ "t": "reorder", "ids": [] }).to_string())
            .await;
        let list = client.json().await;
        assert_eq!(list["t"], "list", "unexpected frame: {list}");
        assert_eq!(list["agents"], json!([]));
        assert_eq!(lists.load(Ordering::SeqCst), 1);
    });
}

// VERIFY: wave10-txmeta_id-1 — `id: m.id`: an absent id is omitted, null kept.
#[test]
fn ws_txmeta_echoes_the_raw_id_shape() {
    run(async {
        let fixture = Fixture::new();
        let registry = recording_registry(&fixture, Bus::new(), RecordingPort::new());
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
            .send_text(&json!({ "t": "txmeta" }).to_string())
            .await;
        let absent = client.json().await;
        assert_eq!(
            absent,
            json!({ "t": "txmeta", "written": 0, "ringMax": RING_MAX })
        );
        client
            .send_text(&json!({ "t": "txmeta", "id": null }).to_string())
            .await;
        let null = client.json().await;
        assert_eq!(
            null,
            json!({ "t": "txmeta", "id": null, "written": 0, "ringMax": RING_MAX })
        );
    });
}
