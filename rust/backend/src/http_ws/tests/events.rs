//! WebSocket protocol tests (events); child of `http_ws::tests`.
//!
//! Server-push frames and the close/error contract. Node reference:
//! `server/pty-ws.mjs:59-82` (bus fan-out) and `:134-136` (message handling).

use super::*;
use crate::bus::BusEvent;

/// The next text frame verbatim, so key order can be pinned (`JSON.stringify`
/// keeps insertion order, and `serde_json` runs with `preserve_order`).
async fn next_text(client: &mut RawClient) -> String {
    loop {
        let (opcode, payload) = client.frame().await;
        match opcode {
            0x1 => return String::from_utf8(payload).unwrap(),
            0x8 => panic!("socket closed during the test: {payload:?}"),
            0x9 => client.send_frame(0xa, &payload).await,
            _ => {}
        }
    }
}

/// A client frame MUST be masked (RFC 6455 §5.1); `RawClient` only writes
/// masked frames, so a protocol violation needs the raw bytes.
async fn send_unmasked_text(client: &mut RawClient, payload: &[u8]) {
    let mut frame = vec![0x81, payload.len() as u8];
    frame.extend_from_slice(payload);
    client.stream.write_all(&frame).await.unwrap();
}

/// The session frees its `/api/health` slot once it stops reading (`:199-205`).
async fn wait_for_session_end(clients: &AtomicUsize) {
    for _ in 0..100 {
        if clients.load(Ordering::SeqCst) == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(clients.load(Ordering::SeqCst), 0);
}

// VERIFY: wave9-events-1 — each bus topic produces Node's frame, byte for byte.
#[test]
fn domain_bus_pushes_match_the_node_frames() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let server = serve(deps(
            &fixture,
            registry.clone(),
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;

        // `reg.bus.on('usage', (data) => send({ t: 'usage', data }))` (`:59-62`).
        registry.bus().emit(&BusEvent::Usage(json!({
            "claude": { "ok": true, "session": null },
        })));
        assert_eq!(
            next_text(&mut client).await,
            r#"{"t":"usage","data":{"claude":{"ok":true,"session":null}}}"#
        );

        // `reg.bus.on('tasks', ({ tasks, history }) => send({ t: 'tasks', tasks, history }))`
        // (`:63-66`).
        registry.bus().emit(&BusEvent::Tasks(json!({
            "tasks": [{ "id": "task-1" }],
            "history": [{ "id": "task-0" }],
        })));
        assert_eq!(
            next_text(&mut client).await,
            r#"{"t":"tasks","tasks":[{"id":"task-1"}],"history":[{"id":"task-0"}]}"#
        );

        // `reg.bus.on('crons', (crons) => send({ t: 'crons', crons }))` (`:67-70`).
        registry
            .bus()
            .emit(&BusEvent::Crons(json!([{ "id": "cron-1" }])));
        assert_eq!(
            next_text(&mut client).await,
            r#"{"t":"crons","crons":[{"id":"cron-1"}]}"#
        );

        // `reg.bus.on('history', (data) => send({ t: 'history', ...data }))` (`:75-78`).
        registry.bus().emit(&BusEvent::History(json!({
            "entries": [{ "day": "2026-10-29" }],
            "pending": ["sess-1"],
        })));
        assert_eq!(
            next_text(&mut client).await,
            r#"{"t":"history","entries":[{"day":"2026-10-29"}],"pending":["sess-1"]}"#
        );

        // `reg.bus.on('background', (data) => send({ t: 'background', ...data }))`
        // (`:79-82`).
        registry.bus().emit(&BusEvent::Background(json!({
            "config": { "jobs": [] },
            "lastTick": null,
            "liveTaskId": "task-1",
            "nextDueAt": 3600000,
        })));
        assert_eq!(
            next_text(&mut client).await,
            r#"{"t":"background","config":{"jobs":[]},"lastTick":null,"liveTaskId":"task-1","nextDueAt":3600000}"#
        );
    });
}

// VERIFY: wave9-events-2 — every socket receives the push (`for (const ws of sockets)`).
#[test]
fn bus_pushes_reach_every_connected_socket() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let server = serve(deps(
            &fixture,
            registry.clone(),
            Arc::new(AtomicUsize::new(0)),
            None,
        ))
        .await;
        let mut first = RawClient::connect(server.address, "/ws").await;
        let mut second = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut first).await;
        let _ = snapshot(&mut second).await;

        registry
            .bus()
            .emit(&BusEvent::Usage(json!({ "codex": { "ok": true } })));
        let expected = json!({ "t": "usage", "data": { "codex": { "ok": true } } });
        assert_eq!(first.json().await, expected);
        assert_eq!(second.json().await, expected);
    });
}

// VERIFY: wave9-events-3 — `switch (m.t)` has no default action: an unknown or
// non-string tag is ignored and the socket keeps serving (`:134-136`, `:196`).
#[test]
fn unknown_and_missing_tags_are_ignored() {
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

        client
            .send_text(&json!({ "t": "no-such-tag" }).to_string())
            .await;
        client.send_text(&json!({ "t": 42 }).to_string()).await;
        client
            .send_text(&json!({ "id": "no-tag" }).to_string())
            .await;
        client
            .send_text(&json!({ "t": "txmeta", "id": "after" }).to_string())
            .await;
        assert_eq!(
            client.json().await,
            json!({ "t": "txmeta", "id": "after", "written": 0, "ringMax": RING_MAX })
        );
    });
}

/// A Close frame payload: the big-endian status code followed by the UTF-8
/// reason (RFC 6455 §5.5.1). `send_frame` masks it like any client frame.
fn close_payload(code: u16, reason: &str) -> Vec<u8> {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(reason.as_bytes());
    payload
}

// VERIFY: wave21-wsclose-1 — a client-initiated Close is answered with the
// peer's own code and reason. Node `ws` completes that handshake; dropping the
// transport instead makes the peer observe 1006/EOF. Covers the normal code
// and an application-defined code, with its reason.
#[test]
fn client_close_is_echoed_with_its_code_and_reason() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let clients = Arc::new(AtomicUsize::new(0));
        let server = serve(deps(&fixture, registry, clients.clone(), None)).await;

        for (code, reason) in [(1000u16, ""), (4000, "custom close")] {
            let mut client = RawClient::connect(server.address, "/ws").await;
            let _ = snapshot(&mut client).await;
            assert_eq!(clients.load(Ordering::SeqCst), 1);

            client.send_frame(0x8, &close_payload(code, reason)).await;
            let (reply_code, reply_reason) = client.close().await;
            assert_eq!(reply_code, code, "close code echo");
            assert_eq!(reply_reason, reason, "close reason echo");
            wait_for_session_end(&clients).await;
        }
    });
}

// VERIFY: wave9-events-4 — a client close runs the close handler (`:199-205`):
// the session stops and its `/api/health` slot is released.
#[test]
fn client_close_ends_the_session() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let clients = Arc::new(AtomicUsize::new(0));
        let server = serve(deps(&fixture, registry, clients.clone(), None)).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;
        assert_eq!(clients.load(Ordering::SeqCst), 1);

        // Close, 1000 normal closure (`ws.on('close', ...)`).
        client.send_frame(0x8, &[0x03, 0xe8]).await;
        wait_for_session_end(&clients).await;
    });
}

// VERIFY: wave9-events-5 — an unmasked client frame is a protocol violation
// (`MASK must be set`); the session must be torn down instead of kept alive.
//
// Node `ws` answers it with a 1002 close frame. This port reads the violation
// as a `recv` error and drops the socket without one; the close code is
// therefore not asserted here (reported as an edit needed in `http_ws.rs`).
#[test]
fn a_protocol_violation_ends_the_session() {
    run(async {
        let fixture = Fixture::new();
        let port = FakePort::new();
        let registry = fixture.registry(port);
        let clients = Arc::new(AtomicUsize::new(0));
        let server = serve(deps(&fixture, registry, clients.clone(), None)).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        let _ = snapshot(&mut client).await;
        assert_eq!(clients.load(Ordering::SeqCst), 1);

        send_unmasked_text(&mut client, b"hi").await;
        // VERIFY: wave10-ws_1002-1 — `ws` closes 1002 on a protocol violation.
        assert_eq!(client.close().await.0, 1002);
        wait_for_session_end(&clients).await;
    });
}
