//! Native Ollama browser transport: the persistent-profile Chromium scrape
//! (`server/usage.mjs:372-403`) and the interactive connect workflow
//! (`:431-470`), without Playwright.
//!
//! Three layers, so the browser is only ever touched by the last one:
//!   * [`find_browser`] / [`browser_candidates`] — absolute-path discovery in
//!     Playwright's channel order (Edge first, Chrome as the fallback). No PATH
//!     lookup, no environment override.
//!   * [`OllamaBrowser`] — the workflow: one profile lock per call, the headless
//!     scrape, and connect's visible-then-headless sequence with main's exact
//!     classification gates.
//!   * [`CdpPageSession`] — process launch, `DevToolsActivePort` discovery and a
//!     minimal CDP client over `tokio-tungstenite`. It is behind the
//!     [`PageSession`] seam so the workflow is tested with a fake capture and
//!     without a browser.
//!
//! Contracts preserved from Node:
//!   * the persistent profile lives under the configured cache root
//!     (`CACHE_DIR/pw-ollama-profile`) and is owned exclusively while a browser
//!     runs — Chromium refuses a second instance on one `--user-data-dir`.
//!   * `scrapeOllamaOnce` classifies when the meter is missing **or** the URL is
//!     a case-sensitive `/signin`; `connectOllamaUsage` classifies only when the
//!     meter is missing, so a `/login` page that still renders a meter parses.
//!   * connect runs the visible leg first and only starts the headless
//!     verification after a successful parse; the caller persists the mode.
//!   * any launch/CDP/timeout failure is `unavailable`, never an error body.
//!   * every CDP operation (connect, send, matching reply) has a deadline, so a
//!     stalled renderer cannot wedge the usage lane the way an unbounded
//!     `Runtime.evaluate` would.
//!   * the launch is bounded by Playwright's 180 s browser-start timeout, and a
//!     launch that times out is `unavailable` without a retry — main never
//!     retries; the legacy `--headless` retry only covers a browser that exited.
//!   * the child process is always reaped (bounded grace, then kill) before the
//!     profile lock is released, and a cancelled capture kills it on drop.
use crate::ollama_scrape::{classify_ollama_page, is_sign_in_route, parse_ollama_html};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `OLLAMA_SETTINGS_URL` (`usage.mjs:28`).
pub const SETTINGS_URL: &str = "https://ollama.com/settings";
/// `connectOllamaUsage`'s `timeoutMs` default (`usage.mjs:431`): the visible leg
/// gets two minutes because a human may be logging in.
pub const CONNECT_TIMEOUT_MS: u64 = 120_000;
/// `REQ_TIMEOUT_MS` (`usage.mjs:68`), used by the headless scrape and by
/// connect's headless verification.
pub const SCRAPE_TIMEOUT_MS: u64 = 10_000;
/// Playwright's browser-instance start timeout, which is the bound main relies
/// on: both `launchPersistentContext` calls (`usage.mjs:375`, `:437`) pass no
/// `timeout`, so its default applies —
/// <https://playwright.dev/docs/api/class-browsertype> documents `launch` /
/// `launchPersistentContext` `timeout` as "Defaults to 180000 (3 minutes)".
/// One deadline covers the whole native launch — the `DevToolsActivePort` wait
/// and the `/json/list` poll.
// VERIFY: wave7-meter_deadline-3
const LAUNCH_BUDGET: Duration = Duration::from_secs(180);
const DEVTOOLS_POLL: Duration = Duration::from_millis(50);
/// One `/json/list` request against loopback; the caller polls until the launch
/// deadline runs out.
const PAGE_TARGET_REQUEST_TIMEOUT: Duration = Duration::from_secs(1);
/// The meter poll's cadence (`waitForSelector`'s analogue).
const METER_POLL: Duration = Duration::from_millis(100);
/// How long a closed browser may take to exit before it is killed.
const CLOSE_GRACE: Duration = Duration::from_secs(5);
const REAP_POLL: Duration = Duration::from_millis(50);
/// `pwHideWebdriver` (`usage.mjs:34`): the init script that hides the automation
/// flag on every document.
const HIDE_WEBDRIVER: &str = "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})";

// ---- Browser discovery ------------------------------------------------------

/// The ordered absolute candidates for this platform. Playwright's channel is
/// `msedge`, so Edge is the parity target and Chrome is the fallback.
pub fn browser_candidates() -> Vec<PathBuf> {
    if cfg!(windows) {
        let root = |name: &str| std::env::var_os(name).map(PathBuf::from);
        return windows_candidates(
            root("ProgramFiles").as_deref(),
            root("ProgramFiles(x86)").as_deref(),
            root("LOCALAPPDATA").as_deref(),
        );
    }
    if cfg!(target_os = "macos") {
        return macos_candidates();
    }
    linux_candidates()
}

fn windows_candidates(
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    local_app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let edge =
        |root: Option<&Path>| root.map(|root| root.join(r"Microsoft\Edge\Application\msedge.exe"));
    let chrome =
        |root: Option<&Path>| root.map(|root| root.join(r"Google\Chrome\Application\chrome.exe"));
    [
        edge(program_files_x86),
        edge(program_files),
        // Playwright's `msedge` channel also resolves a per-user install through
        // `HKCU\...\App Paths\msedge.exe`; the literal path covers it without a
        // registry dependency.
        // VERIFY: wave3-ollama-5
        edge(local_app_data),
        chrome(program_files),
        chrome(program_files_x86),
        chrome(local_app_data),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn macos_candidates() -> Vec<PathBuf> {
    [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

fn linux_candidates() -> Vec<PathBuf> {
    [
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

/// The first candidate the caller says exists. `exists` is injected so the
/// order is testable without an install.
pub fn find_browser(candidates: &[PathBuf], exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|path| exists(path)).cloned()
}

/// The browser this machine has, resolved once at startup.
pub fn installed_browser() -> Option<PathBuf> {
    find_browser(&browser_candidates(), |path| path.exists())
}

// ---- The workflow -----------------------------------------------------------

/// Which leg of the workflow a capture belongs to. The visible leg is the only
/// one that may show a window, and it is the only one a human interacts with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Leg {
    Visible,
    Headless,
}

/// What one browser visit produced. `has_meter` is
/// `page.waitForSelector('[data-usage-meter]')`'s outcome; `url`/`html` are
/// `page.url()` and `page.content()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageSnapshot {
    pub url: String,
    pub html: String,
    pub has_meter: bool,
}

/// One browser visit. Injected so the workflow can be tested without launching
/// anything; `Err` is any throw from `launchPersistentContext`/`goto`/
/// `page.content()`.
pub trait PageSession: Send + Sync + 'static {
    fn capture<'a>(&'a self, leg: Leg, timeout_ms: u64) -> BoxFuture<'a, Result<PageSnapshot, ()>>;
}

/// `scrapeOllamaOnce(pw, true)` and `connectOllamaUsage`, serialising the legs of
/// one workflow call so a visible login and its headless verification never
/// overlap. Production builds one browser per call, so Node's module-level
/// `ollamaProfileTail` — which serialises whole calls — is the usage network
/// seam's outer lock, not this one.
#[derive(Clone)]
pub struct OllamaBrowser {
    session: Arc<dyn PageSession>,
    profile_lock: Arc<AsyncMutex<()>>,
}

impl OllamaBrowser {
    /// The production browser: a CDP session over `profile_dir`.
    pub fn new(profile_dir: PathBuf, browser_bin: Option<PathBuf>) -> Self {
        Self::with_session(Arc::new(CdpPageSession::new(profile_dir, browser_bin)))
    }

    /// The same workflow over an injected session (tests).
    pub fn with_session(session: Arc<dyn PageSession>) -> Self {
        Self {
            session,
            profile_lock: Arc::new(AsyncMutex::new(())),
        }
    }

    /// `fetchOllamaBrowser` (`usage.mjs:394`): one headless visit on the shared
    /// profile. Returns the raw reading (or failure) the cache stores; `pull`
    /// adds `fetchedAt` and `preserve_stale` handles a failure over a good read.
    pub async fn scrape(&self) -> Value {
        let _profile = self.profile_lock.lock().await;
        match self.session.capture(Leg::Headless, SCRAPE_TIMEOUT_MS).await {
            Ok(page) => scrape_result(&page),
            Err(()) => unavailable(),
        }
    }

    /// `connectOllamaUsage` (`usage.mjs:431`): the visible login leg, then the
    /// headless verification on the same profile. Never writes the mode itself —
    /// the route persists it only when this answers `ok`.
    pub async fn connect(&self) -> Value {
        let _profile = self.profile_lock.lock().await;
        let interactive = match self.session.capture(Leg::Visible, CONNECT_TIMEOUT_MS).await {
            Ok(page) => connect_result(&page),
            Err(()) => return unavailable(),
        };
        if !is_ok(&interactive) {
            return interactive;
        }
        match self.session.capture(Leg::Headless, SCRAPE_TIMEOUT_MS).await {
            Ok(page) => scrape_result(&page),
            Err(()) => unavailable(),
        }
    }
}

/// The interactive leg's result (`usage.mjs:451-455`): a missing meter is
/// classified, a metered page is parsed.
fn connect_result(page: &PageSnapshot) -> Value {
    if !page.has_meter {
        return classified(page);
    }
    parse_ollama_html(&page.html).unwrap_or_else(incompatible)
}

/// The headless leg's result (`usage.mjs:378-384`): a missing meter **or** a
/// `/signin` URL is classified.
fn scrape_result(page: &PageSnapshot) -> Value {
    if !page.has_meter || is_sign_in_route(&page.url) {
        return classified(page);
    }
    parse_ollama_html(&page.html).unwrap_or_else(incompatible)
}

fn classified(page: &PageSnapshot) -> Value {
    let error = classify_ollama_page(&page.url, &page.html);
    json!({
        "ok": false,
        "source": "ollama",
        "needsAuth": error == "auth-expired",
        "error": error,
    })
}

fn incompatible() -> Value {
    json!({ "ok": false, "source": "ollama", "error": "scrape-incompatible" })
}

fn unavailable() -> Value {
    json!({ "ok": false, "source": "ollama", "error": "unavailable" })
}

fn is_ok(value: &Value) -> bool {
    value.get("ok") == Some(&Value::Bool(true))
}

// ---- The CDP session --------------------------------------------------------

type WsSocket = Pin<Box<WebSocketStream<MaybeTlsStream<TcpStream>>>>;

/// A Chromium-family browser driven over its own DevTools protocol.
pub struct CdpPageSession {
    profile_dir: PathBuf,
    browser_bin: Option<PathBuf>,
}

impl CdpPageSession {
    pub fn new(profile_dir: PathBuf, browser_bin: Option<PathBuf>) -> Self {
        Self {
            profile_dir,
            browser_bin,
        }
    }

    async fn capture_inner(&self, leg: Leg, timeout_ms: u64) -> Result<PageSnapshot, ()> {
        let Some(binary) = self.browser_bin.clone() else {
            return Err(());
        };
        let profile = self.profile_dir.clone();
        tokio::task::spawn_blocking(move || std::fs::create_dir_all(&profile))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        if leg == Leg::Headless {
            // Modern builds want `--headless=new`; an older build answers by
            // exiting before it opens the DevTools port, so that one case
            // retries with the legacy flag. Only an early exit is `Refused`: a
            // launch that times out is `Broken` and is not retried, because main
            // lets Playwright's launch time out and answers `unavailable`.
            match self.visit(&binary, leg, timeout_ms, true).await {
                Ok(page) => return Ok(page),
                Err(LaunchFailure::Broken) => return Err(()),
                Err(LaunchFailure::Refused) => {}
            }
        }
        self.visit(&binary, leg, timeout_ms, false)
            .await
            .map_err(|_| ())
    }

    async fn visit(
        &self,
        binary: &Path,
        leg: Leg,
        timeout_ms: u64,
        new_headless: bool,
    ) -> Result<PageSnapshot, LaunchFailure> {
        let active_port = self.profile_dir.join("DevToolsActivePort");
        // A crashed run leaves this behind, pointing at a port nobody listens
        // on; the launch writes its own.
        let _ = std::fs::remove_file(&active_port);

        let child = spawn(binary, &launch_args(&self.profile_dir, leg, new_headless))
            .map_err(|()| LaunchFailure::Broken)?;
        let mut guard = ChildGuard(Some(child));
        let result = async {
            // Playwright's launch timeout covers the whole browser start, so one
            // deadline spans both the port file and the page target.
            // VERIFY: wave5-fix_ollama-1
            let launch_deadline = tokio::time::Instant::now() + LAUNCH_BUDGET;
            let port = devtools_port(guard.child(), &active_port, launch_deadline).await?;
            self.capture_page(port, timeout_ms, launch_deadline).await
        }
        .await;
        if guard.0.is_some() {
            // The guard keeps ownership through the grace period, so a cancel
            // here still kills the browser on drop.
            reap(guard.child()).await;
            guard.take();
        }
        result
    }

    async fn capture_page(
        &self,
        port: u16,
        timeout_ms: u64,
        launch_deadline: tokio::time::Instant,
    ) -> Result<PageSnapshot, LaunchFailure> {
        let call_timeout = Duration::from_millis(timeout_ms);
        let target = page_target(port, launch_deadline).await?;
        let (socket, _) = tokio::time::timeout(
            call_timeout,
            tokio_tungstenite::connect_async(target.as_str()),
        )
        .await
        .map_err(|_| LaunchFailure::Broken)?
        .map_err(|_| LaunchFailure::Broken)?;
        let mut socket: WsSocket = Box::pin(socket);
        let mut cdp = Cdp::new(call_timeout);
        let broken = |_| LaunchFailure::Broken;

        cdp.call(&mut socket, "Page.enable", json!({}))
            .await
            .map_err(broken)?;
        cdp.call(
            &mut socket,
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": HIDE_WEBDRIVER }),
        )
        .await
        .map_err(broken)?;
        cdp.call(&mut socket, "Page.navigate", json!({ "url": SETTINGS_URL }))
            .await
            .map_err(broken)?;

        let has_meter = wait_for_meter(&mut cdp, &mut socket, timeout_ms).await?;
        let url = cdp
            .evaluate(&mut socket, "location.href")
            .await
            .map_err(broken)?;
        let html = cdp
            .evaluate(&mut socket, "document.documentElement.outerHTML")
            .await
            .map_err(broken)?;
        // Best effort: `reap` is what actually guarantees the process is gone.
        let _ = cdp.call(&mut socket, "Browser.close", json!({})).await;

        Ok(PageSnapshot {
            url: url.as_str().unwrap_or_default().to_owned(),
            html: html.as_str().unwrap_or_default().to_owned(),
            has_meter,
        })
    }
}

impl PageSession for CdpPageSession {
    fn capture<'a>(&'a self, leg: Leg, timeout_ms: u64) -> BoxFuture<'a, Result<PageSnapshot, ()>> {
        Box::pin(async move { self.capture_inner(leg, timeout_ms).await })
    }
}

/// Why a visit failed. `Refused` means the browser exited without ever opening
/// its DevTools port (a rejected flag or an early exit) and is the only case
/// worth retrying; `Broken` means it launched and then failed, or outlived the
/// launch budget.
enum LaunchFailure {
    Refused,
    Broken,
}

/// The launch command line. No `--enable-automation` (Playwright's
/// `ignoreDefaultArgs`), and `--headless=new` only on the verification leg.
fn launch_args(profile_dir: &Path, leg: Leg, new_headless: bool) -> Vec<String> {
    let mut args = vec![
        "--remote-debugging-port=0".to_owned(),
        format!("--user-data-dir={}", profile_dir.display()),
        "--no-first-run".to_owned(),
        "--no-default-browser-check".to_owned(),
        "--disable-blink-features=AutomationControlled".to_owned(),
    ];
    if leg == Leg::Headless {
        args.push(
            if new_headless {
                "--headless=new"
            } else {
                "--headless"
            }
            .to_owned(),
        );
    }
    args.push("about:blank".to_owned());
    args
}

fn spawn(binary: &Path, args: &[String]) -> Result<Child, ()> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Keep the console window out of the way; the visible leg's browser window
    // is the process's own UI, not this console.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map_err(|_| ())
}

/// `--remote-debugging-port=0` makes the browser pick a port and write it (line
/// 1) to `<profile>/DevToolsActivePort`; poll that file instead of guessing.
/// An early exit is [`LaunchFailure::Refused`] — the only case the legacy
/// `--headless` retry explains; outliving the launch deadline is
/// [`LaunchFailure::Broken`], because main's launch just times out.
async fn devtools_port<C: BrowserChild>(
    child: &mut C,
    active_port: &Path,
    deadline: tokio::time::Instant,
) -> Result<u16, LaunchFailure> {
    loop {
        if let Ok(true) = child.poll() {
            return Err(LaunchFailure::Refused);
        }
        // A few bytes off a local file: the read is cheap enough to keep inline.
        if let Ok(text) = std::fs::read_to_string(active_port) {
            if let Some(port) = text
                .lines()
                .next()
                .and_then(|line| line.trim().parse::<u16>().ok())
            {
                return Ok(port);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            // VERIFY: wave5-fix_ollama-2
            return Err(LaunchFailure::Broken);
        }
        tokio::time::sleep(DEVTOOLS_POLL).await;
    }
}

/// `GET /json/list` and the first `page` target's debugger URL, polled: the port
/// file appears before Chromium publishes the `about:blank` page target, so a
/// listing without one is a launch that has not finished. It shares the launch
/// deadline, and exhaustion is [`LaunchFailure::Broken`]: main waits inside
/// `launchPersistentContext` and never retries, so this must not reach the
/// legacy `--headless` retry, which only explains a browser that exited.
async fn page_target(port: u16, deadline: tokio::time::Instant) -> Result<String, LaunchFailure> {
    // VERIFY: wave3-ollama-3
    let client = reqwest::Client::new();
    loop {
        if let Some(target) = page_target_once(&client, port).await {
            return Ok(target);
        }
        if tokio::time::Instant::now() >= deadline {
            // VERIFY: wave5-fix_ollama-3
            return Err(LaunchFailure::Broken);
        }
        tokio::time::sleep(DEVTOOLS_POLL).await;
    }
}

async fn page_target_once(client: &reqwest::Client, port: u16) -> Option<String> {
    let listing = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .timeout(PAGE_TARGET_REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    page_ws_url(&serde_json::from_str(&listing).ok()?)
}

fn page_ws_url(listing: &Value) -> Option<String> {
    listing
        .as_array()?
        .iter()
        .find(|target| target.get("type").and_then(Value::as_str) == Some("page"))
        .and_then(|target| target.get("webSocketDebuggerUrl"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// `page.waitForSelector('[data-usage-meter]', {timeout})`: poll until the meter
/// exists or the budget runs out. Main binds that call with
/// `.then(() => true).catch(() => false)` (`usage.mjs:379-380`, `:447`), so any
/// selector rejection is "no meter yet" and the caller still reads the page and
/// classifies it. In this client a protocol `error` reply and an elapsed
/// per-call deadline are both that rejection — whether or not the error is a
/// replaced execution context — while a transport failure is the session dying,
/// which main surfaces one call later at `page.content()` (`:381`) as
/// `unavailable`.
async fn wait_for_meter(
    cdp: &mut Cdp,
    socket: &mut WsSocket,
    timeout_ms: u64,
) -> Result<bool, LaunchFailure> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match cdp
            .evaluate(socket, "!!document.querySelector('[data-usage-meter]')")
            .await
        {
            Ok(Value::Bool(true)) => return Ok(true),
            Ok(_) => {}
            // A navigation that replaced the document's execution context is the
            // common rejection; any other protocol error is swallowed the same way.
            // VERIFY: wave3-ollama-4
            // VERIFY: wave5-fix_ollama-4
            Err(CdpError::Protocol) => {}
            // `waitForSelector`'s own `timeout` rejects the promise as well, and
            // main's `.catch(() => false)` (`usage.mjs:379-380`) turns that into
            // `gotMeter = false`; the page is still read and classified.
            // VERIFY: wave7-meter_deadline-2
            Err(CdpError::Deadline) => return Ok(false),
            // A dead socket is not that rejection: main reaches the same failure
            // one call later at `page.content()` (`usage.mjs:381`), and the whole
            // scrape answers `unavailable`.
            Err(CdpError::Transport) => return Err(LaunchFailure::Broken),
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(METER_POLL).await;
    }
}

/// The process operations a visit needs. A trait so the kill-on-cancel guard can
/// be exercised with a fake child instead of a browser.
trait BrowserChild {
    /// `Ok(true)` once the process has exited.
    fn poll(&mut self) -> std::io::Result<bool>;
    fn terminate(&mut self);
    fn collect(&mut self);
}

impl BrowserChild for Child {
    fn poll(&mut self) -> std::io::Result<bool> {
        self.try_wait().map(|status| status.is_some())
    }

    fn terminate(&mut self) {
        let _ = Child::kill(self);
    }

    fn collect(&mut self) {
        let _ = Child::wait(self);
    }
}

/// Owns the browser process until [`reap`] takes it. `Child` does not kill on
/// drop, so a cancelled capture (a dropped future) would otherwise orphan a
/// browser that keeps the persistent profile locked.
struct ChildGuard<C: BrowserChild>(Option<C>);

impl<C: BrowserChild> ChildGuard<C> {
    fn child(&mut self) -> &mut C {
        self.0
            .as_mut()
            .expect("the guard owns the child until it is reaped")
    }

    fn take(&mut self) -> Option<C> {
        self.0.take()
    }
}

impl<C: BrowserChild> Drop for ChildGuard<C> {
    // VERIFY: wave3-ollama-2
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            child.terminate();
            child.collect();
        }
    }
}

/// Close the browser, then make sure the child is gone. `Browser.close` is
/// best-effort, so the grace is followed by a kill; the profile directory must
/// not be reused by the next leg while a browser still owns it.
async fn reap<C: BrowserChild>(child: &mut C) {
    reap_with_grace(child, CLOSE_GRACE).await;
}

/// [`reap`] with an injectable grace, so the kill path is testable without a
/// five-second wait. A `poll` error means the state is unknown: assume the
/// process may still be alive and take the kill path, or a live browser keeps
/// the profile locked. `Ok(true)` returns at once — `try_wait` already collected
/// the exit status, so no `terminate`/`collect` is owed there.
async fn reap_with_grace<C: BrowserChild>(child: &mut C, grace: Duration) {
    let deadline = tokio::time::Instant::now() + grace;
    loop {
        match child.poll() {
            // VERIFY: wave5-fix_ollama-5
            Ok(true) => return,
            Ok(false) | Err(_) => {}
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(REAP_POLL).await;
    }
    child.terminate();
    // The child is already signalled; this only collects the exit status.
    child.collect();
}

/// A minimal CDP request/response client: correlated by `id`, ignoring events.
/// Every call — the send and the read that matches its reply — is bounded by
/// `timeout`; without that bound a stalled renderer wedges the caller forever.
struct Cdp {
    next_id: u64,
    timeout: Duration,
}

/// Why a CDP call failed.
#[derive(Debug, PartialEq, Eq)]
enum CdpError {
    /// The browser answered with a protocol `error` object.
    Protocol,
    /// The per-call deadline elapsed before the browser answered. Playwright
    /// rejects the same way when a call's own `timeout` expires, which is why
    /// the meter poll treats this like a rejection and a dead socket unlike one.
    Deadline,
    /// The socket failed or the connection closed.
    Transport,
}

impl Cdp {
    fn new(timeout: Duration) -> Self {
        Self {
            next_id: 1,
            timeout,
        }
    }

    async fn call(
        &mut self,
        socket: &mut WsSocket,
        method: &str,
        params: Value,
    ) -> Result<Value, CdpError> {
        // A stalled renderer must not hold the usage lane: every send and the read
        // that matches its reply are bounded by the leg's own timeout.
        // VERIFY: wave3-ollama-1
        tokio::time::timeout(self.timeout, self.call_inner(socket, method, params))
            .await
            // VERIFY: wave7-meter_deadline-1
            .map_err(|_| CdpError::Deadline)?
    }

    async fn call_inner(
        &mut self,
        socket: &mut WsSocket,
        method: &str,
        params: Value,
    ) -> Result<Value, CdpError> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "id": id, "method": method, "params": params });
        socket
            .send(Message::text(request.to_string()))
            .await
            .map_err(|_| CdpError::Transport)?;
        loop {
            let message = socket
                .next()
                .await
                .ok_or(CdpError::Transport)?
                .map_err(|_| CdpError::Transport)?;
            let Message::Text(text) = message else {
                continue;
            };
            let Ok(reply) = serde_json::from_str::<Value>(text.as_str()) else {
                continue;
            };
            if reply.get("id").and_then(Value::as_u64) != Some(id) {
                // A protocol event, or another request's reply.
                continue;
            }
            if reply.get("error").is_some() {
                return Err(CdpError::Protocol);
            }
            return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// `Runtime.evaluate` with `returnByValue`, unwrapped to the JSON value.
    async fn evaluate(
        &mut self,
        socket: &mut WsSocket,
        expression: &str,
    ) -> Result<Value, CdpError> {
        let result = self
            .call(
                socket,
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await?;
        if result.get("exceptionDetails").is_some() {
            return Err(CdpError::Transport);
        }
        Ok(result
            .get("result")
            .and_then(|value| value.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A page as the parser sees it: two meters, both windows, one model row.
    fn metered_page() -> String {
        r#"
        <div class="capitalize">pro</div>
        <span aria-label="Session usage 40% used"></span>
        <span data-time="2026-10-29T05:00:00.000Z"></span>
        <span aria-label="Weekly usage 5% used"></span>
        <span data-time="2026-11-04T00:00:00.000Z"></span>
        <li data-model="llama3.3:70b" data-requests="7"></li>
        "#
        .to_owned()
    }

    fn snapshot(url: &str, html: &str, has_meter: bool) -> PageSnapshot {
        PageSnapshot {
            url: url.to_owned(),
            html: html.to_owned(),
            has_meter,
        }
    }

    /// Records every capture and replays scripted outcomes.
    struct FakeSession {
        replies: Mutex<VecDeque<Result<PageSnapshot, ()>>>,
        legs: Mutex<Vec<(Leg, u64)>>,
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
    }

    impl FakeSession {
        fn new(replies: Vec<Result<PageSnapshot, ()>>) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(replies.into()),
                legs: Mutex::new(Vec::new()),
                in_flight: AtomicUsize::new(0),
                max_in_flight: AtomicUsize::new(0),
            })
        }

        fn legs(&self) -> Vec<(Leg, u64)> {
            self.legs.lock().unwrap().clone()
        }
    }

    impl PageSession for FakeSession {
        fn capture<'a>(
            &'a self,
            leg: Leg,
            timeout_ms: u64,
        ) -> BoxFuture<'a, Result<PageSnapshot, ()>> {
            self.legs.lock().unwrap().push((leg, timeout_ms));
            let in_flight = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(in_flight, Ordering::SeqCst);
            let reply = self.replies.lock().unwrap().pop_front().unwrap_or(Err(()));
            Box::pin(async move {
                // Long enough for a second concurrent capture to overlap if the
                // profile lock were not there.
                tokio::time::sleep(Duration::from_millis(5)).await;
                self.in_flight.fetch_sub(1, Ordering::SeqCst);
                reply
            })
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    // VERIFY: ollama-browser-discovery
    #[test]
    fn discovery_prefers_edge_then_chrome_and_never_uses_path() {
        let program_files = PathBuf::from(r"C:\Program Files");
        let program_files_x86 = PathBuf::from(r"C:\Program Files (x86)");
        let local_app_data = PathBuf::from(r"C:\Users\someone\AppData\Local");
        let candidates = windows_candidates(
            Some(&program_files),
            Some(&program_files_x86),
            Some(&local_app_data),
        );

        assert_eq!(
            candidates,
            vec![
                program_files_x86.join(r"Microsoft\Edge\Application\msedge.exe"),
                program_files.join(r"Microsoft\Edge\Application\msedge.exe"),
                local_app_data.join(r"Microsoft\Edge\Application\msedge.exe"),
                program_files.join(r"Google\Chrome\Application\chrome.exe"),
                program_files_x86.join(r"Google\Chrome\Application\chrome.exe"),
                local_app_data.join(r"Google\Chrome\Application\chrome.exe"),
            ],
            "Edge (Playwright's `msedge` channel, including the per-user install) \
             comes first, Chrome is the fallback"
        );
        // VERIFY: wave15-platform-4
        #[cfg(windows)] // Windows path syntax
        assert!(
            candidates.iter().all(|path| path.is_absolute()),
            "every candidate is an absolute path: {candidates:?}"
        );

        // Only Chrome installed: Edge is skipped rather than falling back to a
        // PATH search.
        let installed = program_files.join(r"Google\Chrome\Application\chrome.exe");
        assert_eq!(
            find_browser(&candidates, |path| path == installed.as_path()),
            Some(installed.clone())
        );
        assert_eq!(find_browser(&candidates, |_| false), None);

        // A per-user Edge install (Playwright's `HKCU` App Paths entry) is found.
        let per_user_edge = local_app_data.join(r"Microsoft\Edge\Application\msedge.exe");
        assert_eq!(
            find_browser(&candidates, |path| path == per_user_edge.as_path()),
            Some(per_user_edge)
        );
    }

    #[test]
    fn the_host_platform_candidates_are_absolute() {
        assert!(
            browser_candidates().iter().all(|path| path.is_absolute()),
            "discovery never resolves a bare name through PATH"
        );
    }

    // VERIFY: ollama-visible-120s
    #[test]
    fn the_launch_command_hides_automation_and_only_verification_is_headless() {
        let profile = PathBuf::from(r"C:\cache\pw-ollama-profile");
        let visible = launch_args(&profile, Leg::Visible, false);
        assert!(
            visible.iter().all(|arg| !arg.starts_with("--headless")),
            "the interactive leg is never headless: {visible:?}"
        );
        assert!(
            visible.iter().all(|arg| arg != "--enable-automation"),
            "Playwright's ignoreDefaultArgs keeps the automation banner off: {visible:?}"
        );
        assert!(visible.contains(&format!("--user-data-dir={}", profile.display())));
        assert!(visible.contains(&"--remote-debugging-port=0".to_owned()));

        // VERIFY: ollama-headless-verify
        let headless = launch_args(&profile, Leg::Headless, true);
        assert!(
            headless.contains(&"--headless=new".to_owned()),
            "{headless:?}"
        );
    }

    // VERIFY: ollama-profile-lock
    #[test]
    fn the_profile_lock_serialises_concurrent_connects() {
        let runtime = runtime();
        runtime.block_on(async {
            let page = snapshot("https://ollama.com/settings", &metered_page(), true);
            let session = FakeSession::new(vec![
                Ok(page.clone()),
                Ok(page.clone()),
                Ok(page.clone()),
                Ok(page),
            ]);
            let browser = OllamaBrowser::with_session(session.clone());
            // `tokio::join!` needs tokio's `macros` feature, which the daemon
            // does not enable; two spawned tasks overlap just as well.
            let first = {
                let browser = browser.clone();
                tokio::spawn(async move { browser.connect().await })
            };
            let second = {
                let browser = browser.clone();
                tokio::spawn(async move { browser.connect().await })
            };
            let first = first.await.unwrap();
            let second = second.await.unwrap();
            assert!(is_ok(&first) && is_ok(&second));
            assert_eq!(
                session.max_in_flight.load(Ordering::SeqCst),
                1,
                "one profile owner at a time: {:?}",
                session.legs()
            );
        });
    }

    #[test]
    fn connect_runs_the_visible_leg_then_the_headless_verification() {
        let runtime = runtime();
        runtime.block_on(async {
            let page = snapshot("https://ollama.com/settings", &metered_page(), true);
            let session = FakeSession::new(vec![Ok(page.clone()), Ok(page)]);
            let browser = OllamaBrowser::with_session(session.clone());

            let result = browser.connect().await;
            assert!(is_ok(&result), "{result}");
            assert_eq!(
                session.legs(),
                vec![
                    (Leg::Visible, CONNECT_TIMEOUT_MS),
                    (Leg::Headless, SCRAPE_TIMEOUT_MS),
                ],
                "the visible login leg gets 120s, verification the scrape budget"
            );
        });
    }

    #[test]
    fn a_failed_visible_leg_never_starts_the_verification() {
        let runtime = runtime();
        runtime.block_on(async {
            let session = FakeSession::new(vec![Err(())]);
            let browser = OllamaBrowser::with_session(session.clone());

            assert_eq!(
                browser.connect().await,
                json!({ "ok": false, "source": "ollama", "error": "unavailable" })
            );
            assert_eq!(session.legs().len(), 1, "no verification after a failure");
        });
    }

    #[test]
    fn an_expired_login_on_the_visible_leg_reports_needs_auth() {
        let runtime = runtime();
        runtime.block_on(async {
            let session = FakeSession::new(vec![Ok(snapshot(
                "https://ollama.com/signin?next=/settings",
                "<h1>Sign in</h1>",
                false,
            ))]);
            let browser = OllamaBrowser::with_session(session.clone());

            assert_eq!(
                browser.connect().await,
                json!({
                    "ok": false,
                    "source": "ollama",
                    "needsAuth": true,
                    "error": "auth-expired",
                })
            );
            assert_eq!(session.legs().len(), 1);
        });
    }

    #[test]
    fn a_challenge_page_is_reported_without_needs_auth() {
        let runtime = runtime();
        runtime.block_on(async {
            let session = FakeSession::new(vec![Ok(snapshot(
                "https://ollama.com/settings",
                "<div class=\"cf-turnstile\"></div>",
                false,
            ))]);
            let browser = OllamaBrowser::with_session(session.clone());
            let result = browser.connect().await;
            assert_eq!(result["error"], json!("challenge-required"));
            assert_eq!(result["needsAuth"], json!(false));
        });
    }

    #[test]
    fn a_failed_verification_is_returned_instead_of_the_reading() {
        let runtime = runtime();
        runtime.block_on(async {
            let session = FakeSession::new(vec![
                Ok(snapshot(
                    "https://ollama.com/settings",
                    &metered_page(),
                    true,
                )),
                Ok(snapshot("https://ollama.com/signin", "", false)),
            ]);
            let browser = OllamaBrowser::with_session(session.clone());
            let result = browser.connect().await;
            assert_eq!(
                result,
                json!({
                    "ok": false,
                    "source": "ollama",
                    "needsAuth": true,
                    "error": "auth-expired",
                })
            );
        });
    }

    // VERIFY: ollama-scrape-gate
    #[test]
    fn the_scrape_classifies_a_sign_in_url_even_when_a_meter_rendered() {
        let runtime = runtime();
        runtime.block_on(async {
            let session = FakeSession::new(vec![Ok(snapshot(
                "https://ollama.com/signin?next=/settings",
                &metered_page(),
                true,
            ))]);
            let browser = OllamaBrowser::with_session(session.clone());
            assert_eq!(
                browser.scrape().await,
                json!({
                    "ok": false,
                    "source": "ollama",
                    "needsAuth": true,
                    "error": "auth-expired",
                })
            );
            assert_eq!(session.legs(), vec![(Leg::Headless, SCRAPE_TIMEOUT_MS)]);
        });
    }

    #[test]
    fn connect_parses_a_login_url_that_still_renders_a_meter() {
        // `connectOllamaUsage` gates on the meter alone, so a `/login` URL with a
        // meter is parsed rather than classified — unlike `scrapeOllamaOnce`.
        let runtime = runtime();
        runtime.block_on(async {
            let page = snapshot("https://ollama.com/login", &metered_page(), true);
            let session = FakeSession::new(vec![Ok(page.clone()), Ok(page)]);
            let browser = OllamaBrowser::with_session(session.clone());
            let result = browser.connect().await;
            assert!(is_ok(&result), "{result}");
            assert_eq!(result["session"]["pctUsed"].as_f64(), Some(40.0));
        });
    }

    #[test]
    fn an_unparseable_metered_page_is_scrape_incompatible() {
        let runtime = runtime();
        runtime.block_on(async {
            let session = FakeSession::new(vec![
                Ok(snapshot(
                    "https://ollama.com/settings",
                    "<h1>Settings</h1>",
                    true,
                )),
                Ok(snapshot(
                    "https://ollama.com/settings",
                    "<h1>Settings</h1>",
                    true,
                )),
            ]);
            let browser = OllamaBrowser::with_session(session.clone());
            assert_eq!(
                browser.connect().await,
                json!({ "ok": false, "source": "ollama", "error": "scrape-incompatible" })
            );
            assert_eq!(
                browser.scrape().await,
                json!({ "ok": false, "source": "ollama", "error": "scrape-incompatible" })
            );
        });
    }

    #[test]
    fn a_missing_browser_is_unavailable_and_never_spawns() {
        let runtime = runtime();
        runtime.block_on(async {
            let browser = OllamaBrowser::new(PathBuf::from("unused-profile"), None);
            assert_eq!(
                browser.scrape().await,
                json!({ "ok": false, "source": "ollama", "error": "unavailable" })
            );
            assert_eq!(
                browser.connect().await,
                json!({ "ok": false, "source": "ollama", "error": "unavailable" })
            );
        });
    }

    #[test]
    fn the_page_target_is_the_first_page_entry() {
        let listing = json!([
            { "type": "background_page", "webSocketDebuggerUrl": "ws://background" },
            { "type": "page", "webSocketDebuggerUrl": "ws://page" },
            { "type": "page", "webSocketDebuggerUrl": "ws://second" },
        ]);
        assert_eq!(page_ws_url(&listing), Some("ws://page".to_owned()));
        assert_eq!(page_ws_url(&json!([])), None);
        assert_eq!(page_ws_url(&json!({ "error": "nope" })), None);
    }

    // VERIFY: ollama-cdp-client
    #[test]
    fn the_cdp_client_correlates_replies_and_ignores_events() {
        let runtime = runtime();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = Box::pin(tokio_tungstenite::accept_async(stream).await.unwrap());
                // An event with no `id` arrives before any reply.
                socket
                    .send(Message::text(
                        r#"{"method":"Page.loadEventFired","params":{}}"#,
                    ))
                    .await
                    .unwrap();
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let request: Value = serde_json::from_str(text.as_str()).unwrap();
                    let id = request["id"].clone();
                    let reply = if request["method"] == json!("Runtime.evaluate") {
                        json!({
                            "id": id,
                            "result": { "result": { "type": "boolean", "value": true } },
                        })
                    } else {
                        json!({ "id": id, "result": {} })
                    };
                    socket.send(Message::text(reply.to_string())).await.unwrap();
                }
            });

            let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
                .await
                .unwrap();
            let mut socket: WsSocket = Box::pin(socket);
            let mut cdp = Cdp::new(Duration::from_secs(1));
            assert_eq!(
                cdp.call(&mut socket, "Page.enable", json!({})).await,
                Ok(json!({})),
                "`Page.enable` answers with an empty result object"
            );
            assert_eq!(
                cdp.evaluate(
                    &mut socket,
                    "!!document.querySelector('[data-usage-meter]')"
                )
                .await,
                Ok(Value::Bool(true)),
                "the event ahead of the reply is skipped"
            );
            drop(socket);
            let _ = server.await;
        });
    }

    #[test]
    fn a_cdp_error_reply_fails_the_call() {
        let runtime = runtime();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = Box::pin(tokio_tungstenite::accept_async(stream).await.unwrap());
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let request: Value = serde_json::from_str(text.as_str()).unwrap();
                    let reply = json!({
                        "id": request["id"].clone(),
                        "error": { "code": -32000, "message": "nope" },
                    });
                    socket.send(Message::text(reply.to_string())).await.unwrap();
                }
            });

            let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
                .await
                .unwrap();
            let mut socket: WsSocket = Box::pin(socket);
            let mut cdp = Cdp::new(Duration::from_secs(1));
            assert_eq!(
                cdp.call(&mut socket, "Page.navigate", json!({})).await,
                Err(CdpError::Protocol)
            );
            drop(socket);
            let _ = server.await;
        });
    }

    #[test]
    fn a_stalled_cdp_reply_times_out_instead_of_wedging_the_lane() {
        let runtime = runtime();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = Box::pin(tokio_tungstenite::accept_async(stream).await.unwrap());
                // Read requests, never answer: a renderer that stopped responding.
                while let Some(Ok(_)) = socket.next().await {}
            });

            let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
                .await
                .unwrap();
            let mut socket: WsSocket = Box::pin(socket);
            let mut cdp = Cdp::new(Duration::from_millis(50));
            let started = tokio::time::Instant::now();
            assert_eq!(
                cdp.call(&mut socket, "Page.enable", json!({})).await,
                Err(CdpError::Deadline),
                "the per-call deadline is its own failure, distinct from a dead socket"
            );
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "the call is deadline-bounded, not left awaiting forever"
            );
            drop(socket);
            let _ = server.await;
        });
    }

    #[test]
    fn a_cancelled_capture_kills_the_browser_child() {
        let runtime = runtime();
        runtime.block_on(async {
            let child = FakeChild::default();
            let state = child.state.clone();
            let capture = async move {
                let _guard = ChildGuard(Some(child));
                std::future::pending::<()>().await;
            };
            assert!(
                tokio::time::timeout(Duration::from_millis(10), capture)
                    .await
                    .is_err(),
                "the capture is cancelled mid-await"
            );
            assert_eq!(
                state.kills.load(Ordering::SeqCst),
                1,
                "a cancelled capture kills its browser instead of orphaning it"
            );
            assert_eq!(
                state.waits.load(Ordering::SeqCst),
                1,
                "and collects it, so no zombie keeps the profile locked"
            );
        });
    }

    #[test]
    fn reap_kills_and_collects_a_child_whose_state_cannot_be_read() {
        // A `try_wait` error leaves the state unknown; the browser may still be
        // alive and hold the profile lock, so the grace must end in a kill.
        let runtime = runtime();
        runtime.block_on(async {
            let mut child = FakeChild {
                mode: FakeMode::Unpollable,
                ..Default::default()
            };
            reap_with_grace(&mut child, Duration::from_millis(20)).await;
            assert_eq!(
                child.state.kills.load(Ordering::SeqCst),
                1,
                "an unreadable child state still gets the kill"
            );
            assert_eq!(
                child.state.waits.load(Ordering::SeqCst),
                1,
                "and is collected, so the profile is not left locked"
            );
        });
    }

    #[test]
    fn reap_leaves_an_exited_child_to_try_wait() {
        // `Ok(true)` means `try_wait` already collected the exit status; a
        // redundant kill or `wait` here would be wrong, not merely wasteful.
        let runtime = runtime();
        runtime.block_on(async {
            let mut child = FakeChild {
                mode: FakeMode::Exited,
                ..Default::default()
            };
            reap_with_grace(&mut child, Duration::from_millis(20)).await;
            assert_eq!(child.state.kills.load(Ordering::SeqCst), 0);
            assert_eq!(child.state.waits.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn the_page_target_is_polled_until_chromium_publishes_it() {
        let (port, server) = listing_server(vec![
            json!([]).to_string(),
            json!([{ "type": "page", "webSocketDebuggerUrl": "ws://page" }]).to_string(),
        ]);
        let runtime = runtime();
        runtime.block_on(async {
            assert_eq!(
                page_target(port, tokio::time::Instant::now() + LAUNCH_BUDGET)
                    .await
                    .ok(),
                Some("ws://page".to_owned()),
                "a listing taken before the page target exists is retried"
            );
        });
        server.join().unwrap();
    }

    #[test]
    fn the_launch_budget_is_playwrights_browser_start_timeout() {
        // `launchPersistentContext` (`usage.mjs:375`, `:437`) passes no `timeout`,
        // so Playwright's 180 000 ms default is the launch bound main relies on.
        assert_eq!(LAUNCH_BUDGET, Duration::from_secs(180));
    }

    #[test]
    fn a_launch_that_outlives_its_budget_is_broken_not_refused() {
        let (port, server) = listing_server(vec![json!([]).to_string()]);
        let runtime = runtime();
        runtime.block_on(async {
            assert!(
                matches!(
                    page_target(port, tokio::time::Instant::now()).await,
                    Err(LaunchFailure::Broken)
                ),
                "main's launch times out and answers `unavailable`; it never \
                 retries, so page-target exhaustion must not reach the legacy \
                 `--headless` retry"
            );
        });
        server.join().unwrap();
    }

    #[test]
    fn a_browser_that_exits_before_its_port_is_refused() {
        // The one retryable case: an old build rejects `--headless=new` by exiting.
        let mut child = FakeChild {
            mode: FakeMode::Exited,
            ..Default::default()
        };
        let missing = PathBuf::from(r"C:\cache\no-such-profile\DevToolsActivePort");
        let runtime = runtime();
        runtime.block_on(async {
            let deadline = tokio::time::Instant::now() + LAUNCH_BUDGET;
            assert!(
                matches!(
                    devtools_port(&mut child, &missing, deadline).await,
                    Err(LaunchFailure::Refused)
                ),
                "an early exit is the only launch failure the retry explains"
            );
        });
    }

    #[test]
    fn a_browser_that_never_writes_a_port_is_broken() {
        let mut child = FakeChild::default();
        let missing = PathBuf::from(r"C:\cache\no-such-profile\DevToolsActivePort");
        let runtime = runtime();
        runtime.block_on(async {
            assert!(
                matches!(
                    devtools_port(&mut child, &missing, tokio::time::Instant::now()).await,
                    Err(LaunchFailure::Broken)
                ),
                "outliving the launch budget is a launch timeout, not a refusal"
            );
            assert_eq!(
                child.state.kills.load(Ordering::SeqCst),
                0,
                "the port wait does not own the kill; the guard does"
            );
        });
    }

    #[test]
    fn a_navigation_destroyed_context_keeps_the_meter_poll_alive() {
        let runtime = runtime();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = Box::pin(tokio_tungstenite::accept_async(stream).await.unwrap());
                let mut evaluations = 0;
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let request: Value = serde_json::from_str(text.as_str()).unwrap();
                    let id = request["id"].clone();
                    let reply = if request["method"] == json!("Runtime.evaluate") {
                        evaluations += 1;
                        if evaluations <= 2 {
                            json!({
                                "id": id,
                                "error": {
                                    "code": -32000,
                                    "message": "Cannot find context with specified id",
                                },
                            })
                        } else {
                            json!({
                                "id": id,
                                "result": { "result": { "type": "boolean", "value": true } },
                            })
                        }
                    } else {
                        json!({ "id": id, "result": {} })
                    };
                    socket.send(Message::text(reply.to_string())).await.unwrap();
                }
            });

            let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
                .await
                .unwrap();
            let mut socket: WsSocket = Box::pin(socket);
            let mut cdp = Cdp::new(Duration::from_secs(1));
            assert_eq!(
                wait_for_meter(&mut cdp, &mut socket, 2_000).await.ok(),
                Some(true),
                "a document replaced by navigation is not a failed visit"
            );
            drop(socket);
            let _ = server.await;
        });
    }

    #[test]
    fn a_swallowed_selector_rejection_keeps_the_meter_poll_alive() {
        // `waitForSelector(...).then(() => true).catch(() => false)`
        // (`usage.mjs:379-380`): a protocol rejection is "no meter yet", and the
        // visit goes on to classify the page instead of failing.
        let runtime = runtime();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = Box::pin(tokio_tungstenite::accept_async(stream).await.unwrap());
                let mut evaluations = 0;
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let request: Value = serde_json::from_str(text.as_str()).unwrap();
                    let id = request["id"].clone();
                    let reply = if request["method"] == json!("Runtime.evaluate") {
                        evaluations += 1;
                        if evaluations <= 2 {
                            json!({
                                "id": id,
                                "error": { "code": -32601, "message": "method not found" },
                            })
                        } else {
                            json!({
                                "id": id,
                                "result": { "result": { "type": "boolean", "value": true } },
                            })
                        }
                    } else {
                        json!({ "id": id, "result": {} })
                    };
                    socket.send(Message::text(reply.to_string())).await.unwrap();
                }
            });

            let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
                .await
                .unwrap();
            let mut socket: WsSocket = Box::pin(socket);
            let mut cdp = Cdp::new(Duration::from_secs(1));
            assert_eq!(
                wait_for_meter(&mut cdp, &mut socket, 2_000).await.ok(),
                Some(true),
                "a non-navigation protocol rejection is swallowed like \
                 `waitForSelector`'s `.catch(() => false)`, so the poll continues"
            );
            drop(socket);
            let _ = server.await;
        });
    }

    #[test]
    fn selector_rejections_that_outlast_the_budget_classify_as_no_meter() {
        // Main then falls through to `page.content()` and
        // `classifyOllamaPage` (`usage.mjs:381-386`), not to `unavailable`.
        let runtime = runtime();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = Box::pin(tokio_tungstenite::accept_async(stream).await.unwrap());
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let request: Value = serde_json::from_str(text.as_str()).unwrap();
                    let reply = json!({
                        "id": request["id"].clone(),
                        "error": { "code": -32601, "message": "method not found" },
                    });
                    socket.send(Message::text(reply.to_string())).await.unwrap();
                }
            });

            let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
                .await
                .unwrap();
            let mut socket: WsSocket = Box::pin(socket);
            let mut cdp = Cdp::new(Duration::from_secs(1));
            assert_eq!(
                wait_for_meter(&mut cdp, &mut socket, 300).await.ok(),
                Some(false),
                "the rejection becomes `gotMeter = false`, not a failed visit"
            );
            drop(socket);
            let _ = server.await;
        });
    }

    #[test]
    fn a_meter_call_timeout_reads_as_no_meter() {
        // `waitForSelector`'s own `timeout` rejects the promise, and
        // `.catch(() => false)` (`usage.mjs:379-380`) turns that rejection into
        // `gotMeter = false`: main then reads the page and classifies it.
        // VERIFY: wave7-meter_deadline-4
        let runtime = runtime();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = Box::pin(tokio_tungstenite::accept_async(stream).await.unwrap());
                // Take requests, never answer: the per-call deadline elapses.
                while let Some(Ok(_)) = socket.next().await {}
            });

            let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
                .await
                .unwrap();
            let mut socket: WsSocket = Box::pin(socket);
            let mut cdp = Cdp::new(Duration::from_millis(50));
            assert_eq!(
                wait_for_meter(&mut cdp, &mut socket, 2_000).await.ok(),
                Some(false),
                "a selector call that times out is the rejection \
                 `.catch(() => false)` swallows, not a failed visit"
            );
            drop(socket);
            let _ = server.await;
        });
    }

    #[test]
    fn a_dead_socket_during_the_meter_poll_stays_fatal() {
        // The per-call deadline above is swallowed; a closed socket is not.
        // Main hits the same failure one call later at `page.content()`
        // (`usage.mjs:381`) and the scrape answers `unavailable`.
        // VERIFY: wave7-meter_deadline-5
        let runtime = runtime();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                // Complete the handshake, then drop the connection.
                let _socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            });

            let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
                .await
                .unwrap();
            let mut socket: WsSocket = Box::pin(socket);
            let mut cdp = Cdp::new(Duration::from_secs(1));
            assert!(
                matches!(
                    wait_for_meter(&mut cdp, &mut socket, 2_000).await,
                    Err(LaunchFailure::Broken)
                ),
                "a transport failure is the session dying, not `gotMeter = false`"
            );
            let _ = server.await;
        });
    }

    /// A fake browser process: records the cleanup the guard performs.
    #[derive(Default)]
    struct FakeChild {
        state: Arc<FakeChildState>,
        mode: FakeMode,
    }

    #[derive(Default, Clone, Copy)]
    enum FakeMode {
        /// Still running: `try_wait` answers `Ok(false)`.
        #[default]
        Running,
        /// Exited and already reaped by `try_wait`: `Ok(true)`.
        Exited,
        /// `try_wait` itself fails: the state is unknown.
        Unpollable,
    }

    #[derive(Default)]
    struct FakeChildState {
        kills: AtomicUsize,
        waits: AtomicUsize,
    }

    impl BrowserChild for FakeChild {
        fn poll(&mut self) -> std::io::Result<bool> {
            match self.mode {
                FakeMode::Running => Ok(false),
                FakeMode::Exited => Ok(true),
                FakeMode::Unpollable => Err(std::io::Error::other("process state unavailable")),
            }
        }

        fn terminate(&mut self) {
            self.state.kills.fetch_add(1, Ordering::SeqCst);
        }

        fn collect(&mut self) {
            self.state.waits.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// A loopback HTTP responder that answers one `/json/list` request per
    /// scripted body, so the target poll is testable without a browser. It gives
    /// up after two seconds rather than block a failed test forever.
    fn listing_server(bodies: Vec<String>) -> (u16, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            for body in bodies {
                loop {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            // Windows accepted sockets inherit the listener's non-blocking mode.
                            stream.set_nonblocking(false).unwrap();
                            // A stray or abandoned connection must not block this
                            // helper past the test's own budget.
                            // VERIFY: wave5-fix_ollama-6
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut buffer = [0u8; 1024];
                            let _ = stream.read(&mut buffer);
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes());
                            break;
                        }
                        Err(_) if std::time::Instant::now() >= deadline => return,
                        Err(_) => std::thread::sleep(Duration::from_millis(10)),
                    }
                }
            }
        });
        (port, handle)
    }
}
