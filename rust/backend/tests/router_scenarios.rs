//! Wave-4 router scenarios for the phase-17 gap list (`PLAN_ITEM:
//! p17.w4.fix-scenarios`).
//!
//! These are integration tests: they drive the crate's **public** routers over
//! ephemeral loopback (`127.0.0.1:0`) with `reqwest` for HTTP and a hand-rolled
//! RFC 6455 client for `/ws`, because `tower` is not a direct dependency of
//! this crate (so `ServiceExt::oneshot` is not available to an integration
//! test) and `Cargo.toml` must not change. Everything is injected: temp-dir
//! state, a fixed clock, fake transcript/summariser stores and a fake
//! [`PtyPort`], so no test spawns `claude`, reads the real home or binds
//! 4317.
//!
//! Covered rows:
//! - `GET /api/history` and `POST /api/history/regenerate` (matrix rows
//!   `implemented-untested`) through [`singularity_backend::http_history`].
//! - `WS resize` (matrix `implemented-untested`) plus the `create` / `fork` /
//!   `reattach` / `attach` / `txmeta` / `kill` / `reorder` / `respawn` /
//!   `respawnAll` / `chat` / `chat:stop` command envelopes and the tasks /
//!   crons / background / window-anchor / history / usage / list broadcast
//!   frames through [`singularity_backend::http_ws`].
//! - The `ui` `different-contract` row: UI routes are client-side; the Rust
//!   router answers only `/api` JSON and the shell layer owns `/` + deep links.
//!
//! - `POST /api/restart` through the now-public
//!   [`singularity_backend::http_server::restart_router`], with the restart
//!   channel injected by the test so a request can never exit the process.
//! - A non-empty `pending` on `GET /api/history`, made deterministic by a
//!   history path the backfill cannot write (see that test's comment).

use axum::Router;
use serde_json::{Value, json};
use singularity_backend::agent_registry::{CreateAgent, PtyPort, Registry, RegistryConfig};
use singularity_backend::agent_spawn::{Bins, LaunchSpec, SpawnPaths};
use singularity_backend::bus::{Bus, BusEvent};
use singularity_backend::chat::ChatDeps;
use singularity_backend::history::{
    Clock, DaySummariser, HistoryBins, HistoryDeps, HistoryService, ModelStore, SessionMessages,
    SessionTotals, SummaryAnswer, SummaryModel, TranscriptSession, TranscriptSource,
};
use singularity_backend::http_policy::HttpPolicy;
use singularity_backend::pty::PtyEvent;
use singularity_backend::transcript_service::{Inputs, TranscriptService};
use singularity_backend::window_anchor;
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Fixed instant used by every history assertion: `2026-10-28T12:00:00Z`.
const NOW_MS: f64 = 1_793_188_800_000.0;
const NOW_ISO: &str = "2026-10-28T12:00:00.000Z";
const TODAY: &str = "2026-10-28";

fn run<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

// ---------------------------------------------------------------------------
// Loopback harness
// ---------------------------------------------------------------------------

struct Server {
    address: SocketAddr,
    handle: tokio::task::JoinHandle<io::Result<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn bind() -> (tokio::net::TcpListener, SocketAddr) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral loopback listener");
    let address = listener.local_addr().expect("a bound address");
    (listener, address)
}

fn serve_listener(listener: tokio::net::TcpListener, router: Router) -> Server {
    let address = listener.local_addr().expect("a bound address");
    let handle = tokio::spawn(async move { axum::serve(listener, router).await });
    Server { address, handle }
}

async fn serve(router: Router) -> Server {
    let (listener, _) = bind().await;
    serve_listener(listener, router)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let root = std::env::temp_dir().join(format!(
            "singularity-router-scenarios-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        for dir in ["home", "repo", "state", "usage", "cache", "codex-home"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        Self { root }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn touch(&self, rel: &str) -> PathBuf {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"").unwrap();
        path
    }

    fn repo(&self) -> String {
        self.path("repo").to_string_lossy().into_owned()
    }

    fn bins(&self) -> Bins {
        let claude = self.touch("bin/claude.exe");
        let ollama = self.touch("bin/ollama.exe");
        let codex = self.touch("bin/codex.exe");
        Bins::resolve(
            Some(claude.to_str().unwrap()),
            Some(ollama.to_str().unwrap()),
            Some(codex.to_str().unwrap()),
            SpawnPaths {
                home: self.path("home"),
                scope_root: None,
                cache_dir: self.path("cache"),
                codex_home: self.path("codex-home"),
                models_state: self.path("state/models.json"),
            },
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A [`PtyPort`] that records every call and never starts a process.
#[derive(Default)]
struct FakePort {
    spawns: Mutex<Vec<String>>,
    generations: Mutex<HashMap<String, u64>>,
    writes: Mutex<Vec<(String, Vec<u8>)>>,
    resizes: Mutex<Vec<(String, u16, u16)>>,
    kills: Mutex<Vec<String>>,
    next_pid: AtomicU32,
}

impl FakePort {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            next_pid: AtomicU32::new(1000),
            ..Self::default()
        })
    }

    fn generation(&self, id: &str) -> u64 {
        *self
            .generations
            .lock()
            .unwrap()
            .get(id)
            .unwrap_or_else(|| panic!("{id} was never spawned"))
    }

    fn resizes(&self) -> Vec<(String, u16, u16)> {
        self.resizes.lock().unwrap().clone()
    }

    fn kills(&self) -> Vec<String> {
        self.kills.lock().unwrap().clone()
    }
}

impl PtyPort for FakePort {
    fn spawn(&self, id: &str, generation: u64, _spec: LaunchSpec) -> Result<u32, String> {
        self.spawns.lock().unwrap().push(id.to_owned());
        self.generations
            .lock()
            .unwrap()
            .insert(id.to_owned(), generation);
        Ok(self.next_pid.fetch_add(1, Ordering::SeqCst))
    }

    fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        self.writes
            .lock()
            .unwrap()
            .push((id.to_owned(), data.to_vec()));
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

// ---------------------------------------------------------------------------
// History fixtures
// ---------------------------------------------------------------------------

struct FixedClock;

impl Clock for FixedClock {
    fn now_ms(&self) -> f64 {
        NOW_MS
    }

    fn now_iso(&self) -> String {
        NOW_ISO.to_owned()
    }

    fn local_day(&self, ts_ms: f64) -> String {
        let stamp =
            time::OffsetDateTime::from_unix_timestamp((ts_ms / 1000.0).floor() as i64).unwrap();
        format!(
            "{:04}-{:02}-{:02}",
            stamp.year(),
            u8::from(stamp.month()),
            stamp.day()
        )
    }

    fn start_of_local_day_ms(&self, ts_ms: f64) -> f64 {
        let stamp =
            time::OffsetDateTime::from_unix_timestamp((ts_ms / 1000.0).floor() as i64).unwrap();
        stamp
            .date()
            .with_time(time::Time::MIDNIGHT)
            .assume_utc()
            .unix_timestamp() as f64
            * 1000.0
    }

    fn start_of_local_day_ymd(&self, year: i32, month: u8, day: u8) -> Option<f64> {
        let date =
            time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day).ok()?;
        Some(
            date.with_time(time::Time::MIDNIGHT)
                .assume_utc()
                .unix_timestamp() as f64
                * 1000.0,
        )
    }
}

#[derive(Default)]
struct FakeSource;

impl TranscriptSource for FakeSource {
    fn list(&self, _root: Option<&str>, _cap: usize) -> Result<Vec<TranscriptSession>, String> {
        Ok(Vec::new())
    }

    fn read_session(&self, _row: &TranscriptSession, _root: Option<&str>) -> SessionMessages {
        SessionMessages::default()
    }

    fn totals(&self, _row: &TranscriptSession, _root: Option<&str>) -> SessionTotals {
        SessionTotals::default()
    }
}

struct FakeSummariser;

impl DaySummariser for FakeSummariser {
    fn call<'a>(
        &'a self,
        _prompt: &'a str,
        _model: &'a SummaryModel,
    ) -> Pin<Box<dyn Future<Output = Result<SummaryAnswer, String>> + Send + 'a>> {
        Box::pin(async { Err("summariser must not run in these scenarios".to_owned()) })
    }
}

#[derive(Default)]
struct FakeModels;

impl ModelStore for FakeModels {
    fn summariser_model(&self) -> Option<SummaryModel> {
        None
    }
}

/// The empty-day entry `buildDayEntry` writes when a day has no work
/// (`server/history.mjs:379-384`, shape `:394-401`).
fn empty_entry(date: &str) -> Value {
    json!({
        "date": date,
        "projects": [],
        "topics": [],
        "repos": [],
        "sessions": [],
        "metrics": {
            "sessions": 0,
            "turns": 0,
            "tokens": 0,
            "costUsd": 0,
            "byHarness": {},
        },
        "llm": {
            "ok": false,
            "provider": null,
            "model": null,
            "reason": "empty",
        },
        "builtAt": NOW_ISO,
    })
}

/// Seed `state/history.jsonl`; `readHistory` keeps the last line per date and
/// sorts ascending (`server/history.mjs:97-110`).
fn seed_history(fixture: &Fixture, dates: &[&str]) {
    let lines = dates
        .iter()
        .map(|date| serde_json::to_string(&empty_entry(date)).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(fixture.path("state/history.jsonl"), format!("{lines}\n")).unwrap();
}

fn history_service(fixture: &Fixture) -> Arc<HistoryService> {
    HistoryService::new(HistoryDeps {
        state_dir: fixture.path("state"),
        usage_state: fixture.path("usage"),
        home: fixture.path("home"),
        bins: HistoryBins {
            claude: Some(fixture.path("bin/claude.exe")),
            ollama: None,
            codex: None,
        },
        bus: Bus::new(),
        clock: Arc::new(FixedClock),
        transcripts: Arc::new(FakeSource),
        summariser: Arc::new(FakeSummariser),
        models: Arc::new(FakeModels),
    })
}

fn date_days_ago(days: i64) -> String {
    FixedClock.local_day(NOW_MS - days as f64 * 86_400_000.0)
}

async fn get_history(address: SocketAddr, query: &str) -> (u16, Value, String) {
    let response = reqwest::Client::new()
        .get(format!("http://{address}/api/history{query}"))
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let text = response.text().await.unwrap();
    let value = serde_json::from_str(&text).unwrap();
    (status, value, text)
}

async fn post_regenerate(address: SocketAddr, body: Value) -> (u16, Value) {
    let response = reqwest::Client::new()
        .post(format!("http://{address}/api/history/regenerate"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap())
}

// ---------------------------------------------------------------------------
// GET /api/history
// ---------------------------------------------------------------------------

/// `GET /api/history` answers `{ok, entries, pending, today}` with `entries`
/// reversed and sliced to `days` when neither `from` nor `to` is given
/// (`server/index.mjs:972-987`), and `today` from `liveToday`
/// (`server/history.mjs:472-486`).
// VERIFY: wave4-scenarios-1
#[test]
fn history_get_returns_the_node_envelope_with_entries_reversed() {
    run(async {
        let fixture = Fixture::new("history-envelope");
        let dates = [date_days_ago(3), date_days_ago(2), date_days_ago(1)];
        let dates: Vec<&str> = dates.iter().map(String::as_str).collect();
        seed_history(&fixture, &dates);
        let server = serve(singularity_backend::http_history::router(history_service(
            &fixture,
        )))
        .await;

        let (status, body, raw) = get_history(server.address, "?days=3").await;
        assert_eq!(status, 200);
        assert_eq!(
            body,
            json!({
                "ok": true,
                "entries": [
                    empty_entry(&date_days_ago(1)),
                    empty_entry(&date_days_ago(2)),
                    empty_entry(&date_days_ago(3)),
                ],
                "pending": [],
                "today": {
                    "date": TODAY,
                    "live": true,
                    "repos": [],
                    "sessions": [],
                    "metrics": {
                        "sessions": 0,
                        "turns": 0,
                        "tokens": 0,
                        "costUsd": 0,
                        "byHarness": {},
                    },
                },
            })
        );
        // Node emits the object keys in this order (`index.mjs:985`).
        assert!(
            raw.starts_with(r#"{"ok":true,"entries":["#),
            "unexpected envelope order: {raw}"
        );
        assert!(
            raw.contains(r#""pending":[],"today":{"date":"2026-10-28","live":true"#),
            "unexpected envelope order: {raw}"
        );
    });
}

/// `from`/`to` filter the persisted entries and suppress the `slice(-days)`
/// (`server/index.mjs:979-980`).
// VERIFY: wave4-scenarios-2
#[test]
fn history_get_from_and_to_filter_without_reslicing() {
    run(async {
        let fixture = Fixture::new("history-window");
        let dates = [date_days_ago(3), date_days_ago(2), date_days_ago(1)];
        let dates: Vec<&str> = dates.iter().map(String::as_str).collect();
        seed_history(&fixture, &dates);
        let server = serve(singularity_backend::http_history::router(history_service(
            &fixture,
        )))
        .await;

        let (status, body, _) = get_history(
            server.address,
            &format!("?days=3&from={}&to={}", date_days_ago(2), date_days_ago(1)),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(
            body["entries"],
            json!([
                empty_entry(&date_days_ago(1)),
                empty_entry(&date_days_ago(2))
            ])
        );
        assert_eq!(body["pending"], json!([]));
    });
}

/// `Number(req.query.days) || 7`: absent, `0` and non-numeric values all mean
/// seven days (`server/index.mjs:973`).
// VERIFY: wave4-scenarios-3
#[test]
fn history_get_coerces_days_like_number_or_seven() {
    run(async {
        let fixture = Fixture::new("history-days");
        let dates: Vec<String> = (1..=7).map(date_days_ago).collect();
        let dates: Vec<&str> = dates.iter().map(String::as_str).collect();
        seed_history(&fixture, &dates);
        let server = serve(singularity_backend::http_history::router(history_service(
            &fixture,
        )))
        .await;

        for query in ["", "?days=0", "?days=abc"] {
            let (status, body, _) = get_history(server.address, query).await;
            assert_eq!(status, 200, "query {query}");
            assert_eq!(
                body["entries"].as_array().unwrap().len(),
                7,
                "query {query}"
            );
            assert_eq!(body["entries"][0]["date"], json!(date_days_ago(1)));
        }

        let (_, body, _) = get_history(server.address, "?days=2").await;
        assert_eq!(
            body["entries"],
            json!([
                empty_entry(&date_days_ago(1)),
                empty_entry(&date_days_ago(2))
            ])
        );
    });
}

// ---------------------------------------------------------------------------
// POST /api/history/regenerate
// ---------------------------------------------------------------------------

/// `if (!date) return reply.code(400).send({ ok: false, error: 'date
/// required' })` (`server/index.mjs:989-991`); `''`, `0` and an absent member
/// are all falsy in JavaScript.
// VERIFY: wave4-scenarios-4
#[test]
fn history_regenerate_requires_a_truthy_date() {
    run(async {
        let fixture = Fixture::new("regenerate-required");
        let server = serve(singularity_backend::http_history::router(history_service(
            &fixture,
        )))
        .await;

        for body in [json!({}), json!({ "date": "" }), json!({ "date": 0 })] {
            let (status, reply) = post_regenerate(server.address, body.clone()).await;
            assert_eq!(status, 400, "body {body}");
            assert_eq!(reply, json!({ "ok": false, "error": "date required" }));
        }
    });
}

/// Disclosed deviation: a truthy non-string `date` has no single Node contract
/// (`regenerateDay` sorts with `a.date.localeCompare`, `server/history.mjs:464`,
/// which throws once a second entry exists and `errStatus` answers 400 —
/// `server/index.mjs:253`; a one-entry file answers 200). Rust answers a
/// deterministic `400 invalid date` and writes nothing.
#[test]
fn history_regenerate_rejects_a_truthy_non_string_date() {
    run(async {
        let fixture = Fixture::new("regenerate-non-string");
        seed_history(&fixture, &[date_days_ago(1).as_str()]);
        let before = std::fs::read_to_string(fixture.path("state/history.jsonl")).unwrap();
        let server = serve(singularity_backend::http_history::router(history_service(
            &fixture,
        )))
        .await;

        for body in [
            json!({ "date": 42 }),
            json!({ "date": true }),
            json!({ "date": ["x"] }),
        ] {
            let (status, reply) = post_regenerate(server.address, body.clone()).await;
            assert_eq!(status, 400, "body {body}");
            assert_eq!(reply, json!({ "ok": false, "error": "invalid date" }));
        }
        let after = std::fs::read_to_string(fixture.path("state/history.jsonl")).unwrap();
        assert_eq!(after, before);
    });
}

/// `regenerateDay` rebuilds one day, rewrites the whole file sorted by date and
/// returns the new entry (`server/history.mjs:457-467`); the route answers
/// `{ok: true, entry}` (`server/index.mjs:993`).
// VERIFY: wave4-scenarios-5
#[test]
fn history_regenerate_writes_a_sorted_file_and_returns_the_entry() {
    run(async {
        let fixture = Fixture::new("regenerate-write");
        seed_history(
            &fixture,
            &[date_days_ago(3).as_str(), date_days_ago(1).as_str()],
        );
        let target = date_days_ago(2);
        let server = serve(singularity_backend::http_history::router(history_service(
            &fixture,
        )))
        .await;

        let (status, reply) = post_regenerate(server.address, json!({ "date": &target })).await;
        assert_eq!(status, 200);
        assert_eq!(reply, json!({ "ok": true, "entry": empty_entry(&target) }));

        let text = std::fs::read_to_string(fixture.path("state/history.jsonl")).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let dates: Vec<&str> = lines
            .iter()
            .map(|entry| entry["date"].as_str().unwrap())
            .collect();
        assert_eq!(
            dates,
            [
                date_days_ago(3).as_str(),
                target.as_str(),
                date_days_ago(1).as_str()
            ]
        );
        assert_eq!(lines[1], empty_entry(&target));
        assert!(text.ends_with('\n'), "the rewrite keeps a trailing newline");
    });
}

/// The Node route validates nothing beyond truthiness (`server/index.mjs:989-992`),
/// so `2026-02-30` reaches `regenerateDay` (`server/history.mjs:457-467`): the
/// scan window comes from `startOfLocalDay(new Date('<date>T00:00:00'))` but the
/// day is read back by the raw body string (`:460`), so a date that does not
/// exist yields `emptyDayAgg()` and is still persisted under the literal key —
/// `200 {ok:true, entry}` with the `empty` entry shape (`:380`, `:393-402`,
/// `server/index.mjs:992`). Rust matches that contract.
// VERIFY: wave4-scenarios-6
// VERIFY: wave6-history_parity-2
#[test]
fn history_regenerate_persists_an_impossible_calendar_date_like_node() {
    run(async {
        let fixture = Fixture::new("regenerate-invalid");
        let prior = date_days_ago(1);
        seed_history(&fixture, &[prior.as_str()]);
        let server = serve(singularity_backend::http_history::router(history_service(
            &fixture,
        )))
        .await;

        let (status, reply) =
            post_regenerate(server.address, json!({ "date": "2026-02-30" })).await;
        assert_eq!(status, 200);
        assert_eq!(
            reply,
            json!({ "ok": true, "entry": empty_entry("2026-02-30") })
        );

        // Node rewrites the whole file with the entry sorted by date
        // (`server/history.mjs:462-466`); the raw key sorts before the seeded day.
        let text = std::fs::read_to_string(fixture.path("state/history.jsonl")).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines, [empty_entry("2026-02-30"), empty_entry(&prior)]);
        assert!(text.ends_with('\n'), "the rewrite keeps a trailing newline");
    });
}

// ---------------------------------------------------------------------------
// WebSocket harness
// ---------------------------------------------------------------------------

/// A minimal RFC 6455 client: manual upgrade plus frame encode/decode, so the
/// test needs no WebSocket crate.
struct RawClient {
    stream: TcpStream,
}

impl RawClient {
    async fn connect(address: SocketAddr, path: &str) -> Self {
        let mut stream = TcpStream::connect(address).await.unwrap();
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
            address.port()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            stream.read_exact(&mut byte).await.unwrap();
            head.push(byte[0]);
            if head.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let head = String::from_utf8(head).unwrap();
        assert!(head.starts_with("HTTP/1.1 101"), "{head}");
        Self { stream }
    }

    async fn read_exact(&mut self, buffer: &mut [u8]) {
        tokio::time::timeout(Duration::from_secs(5), self.stream.read_exact(buffer))
            .await
            .expect("a frame within five seconds")
            .unwrap();
    }

    async fn send_text(&mut self, text: &str) {
        self.send_frame(0x1, text.as_bytes()).await;
    }

    async fn send_value(&mut self, value: Value) {
        self.send_text(&serde_json::to_string(&value).unwrap())
            .await;
    }

    async fn send_frame(&mut self, opcode: u8, payload: &[u8]) {
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let mut frame = vec![0x80 | opcode];
        if payload.len() < 126 {
            frame.push(0x80 | payload.len() as u8);
        } else {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.stream.write_all(&frame).await.unwrap();
    }

    async fn frame(&mut self) -> (u8, Vec<u8>) {
        let mut head = [0u8; 2];
        self.read_exact(&mut head).await;
        let opcode = head[0] & 0x0f;
        let masked = head[1] & 0x80 != 0;
        let mut length = usize::from(head[1] & 0x7f);
        if length == 126 {
            let mut extended = [0u8; 2];
            self.read_exact(&mut extended).await;
            length = usize::from(u16::from_be_bytes(extended));
        } else if length == 127 {
            let mut extended = [0u8; 8];
            self.read_exact(&mut extended).await;
            length = u64::from_be_bytes(extended) as usize;
        }
        let mut mask = [0u8; 4];
        if masked {
            self.read_exact(&mut mask).await;
        }
        let mut payload = vec![0u8; length];
        self.read_exact(&mut payload).await;
        if masked {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }
        }
        (opcode, payload)
    }

    /// The next text frame, answering pings on the way.
    async fn text(&mut self) -> String {
        loop {
            let (opcode, payload) = self.frame().await;
            match opcode {
                0x1 => return String::from_utf8(payload).unwrap(),
                0x8 => panic!("socket closed during the test: {payload:?}"),
                0x9 => self.send_frame(0xa, &payload).await,
                _ => {}
            }
        }
    }

    async fn json(&mut self) -> Value {
        serde_json::from_str(&self.text().await).unwrap()
    }

    /// Reads past unrelated bus frames until one carries `tag`.
    async fn expect_tag(&mut self, tag: &str) -> Value {
        for _ in 0..16 {
            let frame = self.json().await;
            if frame["t"] == json!(tag) {
                return frame;
            }
        }
        panic!("no {tag} frame arrived");
    }

    /// Consumes Node's five connection-time frames (`pty-ws.mjs:107-111`).
    async fn handshake(&mut self) {
        for _ in 0..5 {
            let _ = self.json().await;
        }
    }

    /// A frame-less command is confirmed by a `txmeta` round trip
    /// (`pty-ws.mjs:156`).
    async fn ping_txmeta(&mut self, id: &str) -> Value {
        self.send_value(json!({ "t": "txmeta", "id": id })).await;
        self.expect_tag("txmeta").await
    }
}

fn ws_deps(fixture: &Fixture, registry: Arc<Registry>) -> singularity_backend::http_ws::WsDeps {
    singularity_backend::http_ws::WsDeps {
        registry,
        anchor: Arc::new(Mutex::new(window_anchor::Service::default())),
        chat: ChatDeps::new(
            Arc::new(TranscriptService::new(Inputs {
                state_dir: fixture.path("state"),
                claude_home: fixture.path("home/.claude"),
                codex_home: fixture.path("codex-home"),
                model_catalog: Vec::new(),
            })),
            fixture.path("home/.claude/.credentials.json"),
        ),
        clients: Arc::new(AtomicUsize::new(0)),
        policy: HttpPolicy {
            daemon_port: 4317,
            vite_port: 5317,
            token: None,
        },
        shutdown: None,
        snapshots: None,
    }
}

fn registry(fixture: &Fixture, port: Arc<FakePort>) -> Arc<Registry> {
    Arc::new(Registry::new(
        Bus::new(),
        port,
        RegistryConfig {
            state_file: fixture.path("state/agents.json"),
            bins: fixture.bins(),
            parent_env: Default::default(),
            clock: singularity_backend::agent_registry::system_clock(),
        },
    ))
}

fn create_input(fixture: &Fixture, id: &str) -> CreateAgent {
    CreateAgent {
        cwd: Some(fixture.repo()),
        title: Some("demo".to_owned()),
        model: Some("claude".to_owned()),
        session_id: Some(id.to_owned()),
        ..CreateAgent::default()
    }
}

async fn ws_server(fixture: &Fixture, registry: Arc<Registry>) -> Server {
    serve(singularity_backend::http_ws::router(ws_deps(
        fixture, registry,
    )))
    .await
}

// ---------------------------------------------------------------------------
// WS: resize (matrix `implemented-untested`) and the command envelopes
// ---------------------------------------------------------------------------

/// `case 'resize': reg.resize(m.id, m.cols, m.rows)` (`server/pty-ws.mjs:157`)
/// forwards the frame's dimensions to the live pty (`server/agents.mjs:581`)
/// and answers nothing. An unknown id is a silent no-op (`?.`).
// VERIFY: wave4-scenarios-7
#[test]
fn ws_resize_forwards_dimensions_to_the_live_pty() {
    run(async {
        let fixture = Fixture::new("ws-resize");
        let port = FakePort::new();
        let registry = registry(&fixture, port.clone());
        registry.create(create_input(&fixture, "rs1")).unwrap();
        let server = ws_server(&fixture, registry.clone()).await;

        let mut client = RawClient::connect(server.address, "/ws").await;
        client.handshake().await;

        client
            .send_value(json!({ "t": "resize", "id": "rs1", "cols": 120, "rows": 40 }))
            .await;
        let reply = client.ping_txmeta("rs1").await;
        assert_eq!(reply["id"], json!("rs1"));
        assert_eq!(port.resizes(), [("rs1".to_owned(), 120u16, 40u16)]);

        client
            .send_value(json!({ "t": "resize", "id": "missing", "cols": 10, "rows": 10 }))
            .await;
        let _ = client.ping_txmeta("rs1").await;
        assert_eq!(
            port.resizes().len(),
            1,
            "an unknown session must not reach the pty"
        );
    });
}

/// `create` answers `{t:'attached', id}` on success and
/// `{t:'error', msg:'spawn failed: …'}` on failure
/// (`server/pty-ws.mjs:117-125`); a live duplicate id is the registry's
/// `session id already in use` (`server/agents.mjs:442`).
// VERIFY: wave4-scenarios-8
#[test]
fn ws_create_replies_attached_then_the_spawn_failure_envelope() {
    run(async {
        let fixture = Fixture::new("ws-create");
        let port = FakePort::new();
        let registry = registry(&fixture, port);
        let server = ws_server(&fixture, registry.clone()).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        client.handshake().await;

        client
            .send_value(json!({
                "t": "create",
                "sessionId": "c1",
                "cwd": fixture.repo(),
                "model": "claude",
                "title": "demo",
            }))
            .await;
        let attached = client.expect_tag("attached").await;
        assert_eq!(attached, json!({ "t": "attached", "id": "c1" }));

        client
            .send_value(json!({ "t": "create", "sessionId": "c1", "cwd": fixture.repo() }))
            .await;
        let error = client.expect_tag("error").await;
        assert_eq!(
            error,
            json!({ "t": "error", "msg": "spawn failed: session id already in use" })
        );
    });
}

/// `fork` of an unknown id throws `source not found`
/// (`server/agents.mjs:566-568`) and the socket prefixes `fork failed: `
/// (`server/pty-ws.mjs:134-136`). `reattach` of an unknown id sends nothing
/// (`server/pty-ws.mjs:139-146`).
// VERIFY: wave4-scenarios-9
#[test]
fn ws_fork_and_reattach_unknown_ids_match_node() {
    run(async {
        let fixture = Fixture::new("ws-fork");
        let port = FakePort::new();
        let registry = registry(&fixture, port);
        let server = ws_server(&fixture, registry.clone()).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        client.handshake().await;

        client
            .send_value(json!({ "t": "fork", "id": "nope" }))
            .await;
        let error = client.expect_tag("error").await;
        assert_eq!(
            error,
            json!({ "t": "error", "msg": "fork failed: source not found" })
        );

        client
            .send_value(json!({ "t": "reattach", "id": "nope" }))
            .await;
        let reply = client.ping_txmeta("none").await;
        assert_eq!(
            reply,
            json!({ "t": "txmeta", "id": "none", "written": 0, "ringMax": 262_144 })
        );
    });
}

/// `attach` replays the scrollback with terminal queries stripped, then the
/// current status (`server/pty-ws.mjs:148-153`; query regex `:29-36`).
// VERIFY: wave4-scenarios-10
#[test]
fn ws_attach_replays_stripped_scrollback_then_status() {
    run(async {
        let fixture = Fixture::new("ws-attach");
        let port = FakePort::new();
        let registry = registry(&fixture, port.clone());
        registry.create(create_input(&fixture, "at1")).unwrap();
        let generation = port.generation("at1");
        registry.on_pty_event(PtyEvent::Output {
            id: "at1".to_owned(),
            generation,
            bytes: b"hi\x1b[0c".to_vec(),
        });
        let server = ws_server(&fixture, registry.clone()).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        client.handshake().await;

        client
            .send_value(json!({ "t": "attach", "id": "at1" }))
            .await;
        let output = client.expect_tag("output").await;
        assert_eq!(output["id"], json!("at1"));
        assert_eq!(output["data"], json!("hi"), "DA1 query must be stripped");
        let status = client.expect_tag("status").await;
        assert_eq!(status["id"], json!("at1"));
        assert_eq!(
            status["status"],
            json!(registry.get_status("at1").unwrap().as_str())
        );
    });
}

/// `txmeta` reports the cumulative written bytes and the ring cap
/// (`server/pty-ws.mjs:156`; `RING_MAX` `server/agents.mjs:14`).
// VERIFY: wave4-scenarios-11
#[test]
fn ws_txmeta_reports_written_bytes_and_ring_max() {
    run(async {
        let fixture = Fixture::new("ws-txmeta");
        let port = FakePort::new();
        let registry = registry(&fixture, port.clone());
        registry.create(create_input(&fixture, "tx1")).unwrap();
        let generation = port.generation("tx1");
        registry.on_pty_event(PtyEvent::Output {
            id: "tx1".to_owned(),
            generation,
            bytes: b"hello".to_vec(),
        });
        let server = ws_server(&fixture, registry.clone()).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        client.handshake().await;

        let reply = client.ping_txmeta("tx1").await;
        assert_eq!(
            reply,
            json!({ "t": "txmeta", "id": "tx1", "written": 5, "ringMax": 262_144 })
        );
    });
}

/// `kill` reaches the registry (a live pty is killed, `server/agents.mjs:584-590`)
/// and `reorder` accepts only a permutation, then re-emits the list
/// (`server/agents.mjs:628-636`). Neither sends a direct reply
/// (`server/pty-ws.mjs:158-159`).
// VERIFY: wave4-scenarios-12
#[test]
fn ws_kill_and_reorder_dispatch_to_the_registry() {
    run(async {
        let fixture = Fixture::new("ws-kill-reorder");
        let port = FakePort::new();
        let registry = registry(&fixture, port.clone());
        registry.create(create_input(&fixture, "k1")).unwrap();
        registry.create(create_input(&fixture, "k2")).unwrap();
        let server = ws_server(&fixture, registry.clone()).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        client.handshake().await;

        client
            .send_value(json!({ "t": "reorder", "ids": ["k2", "k1"] }))
            .await;
        let list = client.expect_tag("list").await;
        let ids: Vec<&str> = list["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|agent| agent["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["k2", "k1"]);

        client.send_value(json!({ "t": "kill", "id": "k1" })).await;
        let _ = client.ping_txmeta("k1").await;
        assert_eq!(port.kills(), ["k1"]);
    });
}

/// `respawn` and `respawnAll` kill the live pty and arm a resume
/// (`server/agents.mjs:609-625`); the dispatch awaits the registry call before
/// the next frame is processed (`server/pty-ws.mjs:160-161`).
// VERIFY: wave4-scenarios-13
#[test]
fn ws_respawn_and_respawn_all_dispatch_to_the_registry() {
    run(async {
        let fixture = Fixture::new("ws-respawn");
        let port = FakePort::new();
        let registry = registry(&fixture, port.clone());
        registry.create(create_input(&fixture, "r1")).unwrap();
        registry.create(create_input(&fixture, "r2")).unwrap();
        let server = ws_server(&fixture, registry.clone()).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        client.handshake().await;

        client
            .send_value(json!({ "t": "respawn", "id": "r1" }))
            .await;
        let _ = client.ping_txmeta("r1").await;
        assert!(port.kills().contains(&"r1".to_owned()));

        client.send_value(json!({ "t": "respawnAll" })).await;
        let _ = client.ping_txmeta("r2").await;
        assert!(port.kills().contains(&"r2".to_owned()));
    });
}

/// A `chat` frame without credentials produces Node's auth error frame
/// (`server/chat.mjs:101`) and `chat:stop` cancels silently
/// (`server/pty-ws.mjs:170`).
// VERIFY: wave4-scenarios-14
#[test]
fn ws_chat_without_credentials_sends_the_node_auth_frame() {
    run(async {
        let fixture = Fixture::new("ws-chat");
        let port = FakePort::new();
        let registry = registry(&fixture, port);
        let server = ws_server(&fixture, registry.clone()).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        client.handshake().await;

        client
            .send_value(json!({ "t": "chat", "chatId": "c9", "question": "hi" }))
            .await;
        let frame = client.expect_tag("chat:error").await;
        assert_eq!(
            frame,
            json!({
                "t": "chat:error",
                "chatId": "c9",
                "needsAuth": true,
                "msg": "Claude not signed in — run `claude` to log in",
            })
        );

        client.send_value(json!({ "t": "chat:stop" })).await;
        let _ = client.ping_txmeta("c9").await;
    });
}

// ---------------------------------------------------------------------------
// WS: broadcast frames (matrix `ws-events` gap)
// ---------------------------------------------------------------------------

/// Every bus event reaches the socket as the exact Node frame
/// (`server/pty-ws.mjs:47-82`): `{t, ...payload}` for tasks/history/background,
/// `{t, crons}`, `{t, anchor}`, `{t, data}` for usage and `{t, agents,
/// recentRepos}` for list.
// VERIFY: wave4-scenarios-15
#[test]
fn ws_broadcast_frames_match_the_node_event_payloads() {
    run(async {
        let fixture = Fixture::new("ws-broadcast");
        let port = FakePort::new();
        let registry = registry(&fixture, port);
        let server = ws_server(&fixture, registry.clone()).await;
        let mut client = RawClient::connect(server.address, "/ws").await;
        client.handshake().await;
        let bus = registry.bus().clone();

        let cases: Vec<(BusEvent, Value)> = vec![
            (
                BusEvent::Tasks(json!({ "tasks": [{ "id": "t1" }], "history": [] })),
                json!({ "t": "tasks", "tasks": [{ "id": "t1" }], "history": [] }),
            ),
            (
                BusEvent::Crons(json!([{ "id": "c1" }])),
                json!({ "t": "crons", "crons": [{ "id": "c1" }] }),
            ),
            (
                BusEvent::Background(json!({
                    "config": { "jobs": [] },
                    "lastTick": null,
                    "liveTaskId": null,
                    "nextDueAt": 0,
                })),
                json!({
                    "t": "background",
                    "config": { "jobs": [] },
                    "lastTick": null,
                    "liveTaskId": null,
                    "nextDueAt": 0,
                }),
            ),
            (
                BusEvent::WindowAnchor(json!({ "provider": "claude" })),
                json!({ "t": "window-anchor", "anchor": { "provider": "claude" } }),
            ),
            (
                BusEvent::History(json!({ "entries": [], "pending": ["2026-10-27"] })),
                json!({ "t": "history", "entries": [], "pending": ["2026-10-27"] }),
            ),
            (
                BusEvent::Usage(json!({ "claude": { "session": 1 } })),
                json!({ "t": "usage", "data": { "claude": { "session": 1 } } }),
            ),
        ];

        for (event, expected) in cases {
            let tag = expected["t"].as_str().unwrap().to_owned();
            bus.emit(&event);
            let frame = client.expect_tag(&tag).await;
            assert_eq!(
                serde_json::to_string(&frame).unwrap(),
                serde_json::to_string(&expected).unwrap(),
                "frame order must match Node"
            );
        }

        // `output` is filtered by the socket's attached set (`pty-ws.mjs:47-50`).
        bus.emit(&BusEvent::Output {
            id: "other".to_owned(),
            data: "x".to_owned(),
        });
        let _ = client.ping_txmeta("none").await;
    });
}

// ---------------------------------------------------------------------------
// The `ui` different-contract row
// ---------------------------------------------------------------------------

/// The `ui` matrix row is a browser surface, not Rust routes: UI paths are
/// client-side and the Rust router only owns `/api`, so every path in the root
/// namespace falls through to its own fallback — `404 {"error":"not found"}`
/// (`src/http_server.rs:777-780`, `:930-932`). Node differs in both
/// configurations, so this pins the Rust contract and not a Node one: with a
/// built `web/dist`, `GET /` and the HTML navigations (incl. `/tasks`) are
/// `isShellRequest` (`server/index.mjs:163-170`) and get the SPA shell, 200 HTML
/// (`:287`, `:293-297`); without it no custom not-found handler is registered
/// at all — the whole block is `if (hasShell)` and its `else` only warns
/// (`:266`, `:304-305`) — so Fastify's default 404 body applies. Only the
/// non-GET `/api/health` case below matches Node, which reaches the handler and
/// answers `404 {error:'not found'}`.
// VERIFY: wave4-scenarios-16
#[test]
fn ui_routes_are_client_side_and_the_router_answers_json_404() {
    run(async {
        let fixture = Fixture::new("ui-contract");
        let (listener, address) = bind().await;
        let services = singularity_backend::http_server::HttpServices::new(
            fixture.path("state"),
            singularity_backend::usage_report::Request {
                reports_dir: String::new(),
                env: json!({}),
            },
        );
        let policy = HttpPolicy {
            daemon_port: address.port(),
            vite_port: 5317,
            token: None,
        };
        let server = serve_listener(
            listener,
            singularity_backend::http_server::router(policy, services),
        );

        let client = reqwest::Client::new();
        for path in ["/", "/tasks", "/api/does-not-exist"] {
            let response = client
                .get(format!(
                    "http://{}/{}",
                    server.address,
                    path.trim_start_matches('/')
                ))
                .header("accept", "text/html")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 404, "path {path}");
            let body: Value = response.json().await.unwrap();
            assert_eq!(body, json!({ "error": "not found" }), "path {path}");
        }

        // A mounted GET route rejects other methods with the same body.
        let response = client
            .post(format!("http://{}/api/health", server.address))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 404);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body, json!({ "error": "not found" }));
    });
}

// ---------------------------------------------------------------------------
// POST /api/restart
// ---------------------------------------------------------------------------

async fn post_restart(address: SocketAddr) -> (u16, Value, String) {
    let response = reqwest::Client::new()
        .post(format!("http://{address}/api/restart"))
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let text = response.text().await.unwrap();
    let value = serde_json::from_str(&text).unwrap();
    (status, value, content_type)
}

/// `POST /api/restart` acknowledges immediately with `{ok:true}`
/// (`server/index.mjs:532-533`, inside the `/api` plugin registered at `:996`)
/// and hands exactly one request to the injected supervisor channel. The test
/// owns the receiver, so the 100 ms drain/respawn (`:538-543`) never runs.
// VERIFY: wave5-restart-2
#[test]
fn restart_post_acknowledges_with_the_node_body_and_signals_the_injected_supervisor() {
    run(async {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<()>();
        let server = serve(singularity_backend::http_server::restart_router(sender)).await;

        let (status, body, content_type) = post_restart(server.address).await;
        assert_eq!(status, 200);
        assert_eq!(body, json!({ "ok": true }));
        // `reply.send` serializes a JSON object; the assembled router's
        // `fastify_json_charset` layer (`http_server.rs:908-921`) upgrades the
        // standalone module's bare header to `application/json; charset=utf-8`.
        assert_eq!(content_type, "application/json");

        // The handler sends before returning `Json`, so the signal is already
        // queued once the response is in hand.
        assert_eq!(receiver.try_recv(), Ok(()));
        assert_eq!(
            receiver.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty),
            "one restart signal per request"
        );
    });
}

/// Node schedules one respawn per `POST /restart` (`server/index.mjs:538-543`);
/// a second request must not be swallowed by the first.
// VERIFY: wave5-restart-3
#[test]
fn restart_post_emits_one_signal_per_request() {
    run(async {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<()>();
        let server = serve(singularity_backend::http_server::restart_router(sender)).await;
        let client = reqwest::Client::new();

        for _ in 0..2 {
            let response = client
                .post(format!("http://{}/api/restart", server.address))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);
            assert_eq!(
                response.json::<Value>().await.unwrap(),
                json!({ "ok": true })
            );
        }

        assert_eq!(receiver.try_recv(), Ok(()));
        assert_eq!(receiver.try_recv(), Ok(()));
        assert_eq!(
            receiver.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        );
    });
}

// ---------------------------------------------------------------------------
// GET /api/history with a non-empty `pending`
// ---------------------------------------------------------------------------

/// The wave-4 record could only pin `pending: []`, because every day the
/// route reports as pending is also a day the fire-and-forget backfill fills.
/// A directory at the history file path removes that race: `readHistory`
/// swallows the read error and `appendEntry` rejects, so Node still answers
/// with every in-window day pending (`server/index.mjs:977-987`, warning
/// logged by the `.catch` at `:975`). The Rust `get` spawns the same backfill
/// (`history.rs:1731-1733`) and `read_history` returns empty on the same
/// state, so `pending` is deterministic with no sleeps or write ordering.
// VERIFY: wave5-restart-4
#[test]
fn history_get_reports_pending_days_when_the_backfill_cannot_write() {
    run(async {
        let fixture = Fixture::new("history-pending");
        let history_file = fixture.path("state/history.jsonl");
        std::fs::create_dir_all(&history_file).unwrap();
        let server = serve(singularity_backend::http_history::router(history_service(
            &fixture,
        )))
        .await;

        let (status, body, _) = get_history(server.address, "?days=3").await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], json!(true));
        assert_eq!(body["entries"], json!([]));
        assert_eq!(
            body["pending"],
            json!([date_days_ago(1), date_days_ago(2), date_days_ago(3)])
        );
        assert_eq!(body["today"]["date"], json!(TODAY));
        assert_eq!(body["today"]["live"], json!(true));
        // The failed backfill wrote nothing: the path is still the directory
        // the test created.
        assert!(history_file.is_dir());
    });
}
