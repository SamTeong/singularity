#[cfg(not(windows))]
use portable_pty::ChildKiller;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};

#[cfg(windows)]
use std::os::windows::io::{BorrowedHandle, OwnedHandle};

type Master = Box<dyn MasterPty + Send>;
type Stdout = Arc<Mutex<io::BufWriter<io::Stdout>>>;

#[cfg(windows)]
type Killer = Arc<Mutex<OwnedHandle>>;
#[cfg(not(windows))]
type Killer = Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>;

/// Default terminal width for a spawn that does not specify one (node bridge parity).
pub const DEFAULT_COLS: u16 = 80;
/// Default terminal height for a spawn that does not specify one (node bridge parity).
pub const DEFAULT_ROWS: u16 = 24;

/// Session-scoped event emitted by the host on the sink.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PtyEvent {
    Output {
        id: String,
        generation: u64,
        bytes: Vec<u8>,
    },
    Exit {
        id: String,
        generation: u64,
        exit_code: Option<i32>,
    },
}

/// Event sink. Invoked from the per-session reader/waiter threads, so it must be
/// `Send + Sync`; ordering per session is output-before-exit.
pub type PtySink = Arc<dyn Fn(PtyEvent) + Send + Sync>;

/// Everything needed to start one PTY session.
#[derive(Clone, Debug)]
pub struct PtySpawnSpec {
    pub id: String,
    pub generation: u64,
    /// Absolute path to the executable (PATH lookup is never used).
    pub bin: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

impl PtySpawnSpec {
    pub fn new(
        id: impl Into<String>,
        generation: u64,
        bin: impl Into<String>,
        cwd: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            generation,
            bin: bin.into(),
            args: Vec::new(),
            cwd: cwd.into(),
            env: HashMap::new(),
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        }
    }
}

/// In-process PTY host: owns sessions and reports output/exit through a [`PtySink`].
pub struct PtyHost {
    inner: Arc<HostInner>,
}

struct HostInner {
    sink: PtySink,
    sessions: Mutex<HashMap<String, Session>>,
    waiters: Mutex<Vec<JoinHandle<()>>>,
}

struct Session {
    generation: u64,
    master: Arc<Mutex<Option<Master>>>,
    killer: Killer,
    writes: mpsc::Sender<WriteMessage>,
    cancelled: Arc<AtomicBool>,
}

#[cfg(windows)]
fn clone_killer(child: &dyn Child) -> io::Result<Killer> {
    let raw = child
        .as_raw_handle()
        .ok_or_else(|| io::Error::other("child process handle unavailable"))?;
    // SAFETY: portable-pty owns this process handle while `child` is alive;
    // duplicate it before the original child is moved to its waiter.
    let borrowed = unsafe { BorrowedHandle::borrow_raw(raw) };
    Ok(Arc::new(Mutex::new(borrowed.try_clone_to_owned()?)))
}

#[cfg(not(windows))]
fn clone_killer(child: &dyn Child) -> io::Result<Killer> {
    Ok(Arc::new(Mutex::new(child.clone_killer())))
}

#[cfg(windows)]
fn rollback_spawned_child(child: &mut Box<dyn Child + Send + Sync>) -> io::Result<()> {
    const STILL_ACTIVE: u32 = 259;

    let raw = child
        .as_raw_handle()
        .ok_or_else(|| io::Error::other("child process handle unavailable during rollback"))?;
    // SAFETY: portable-pty owns this process handle for the lifetime of `child`.
    if unsafe { TerminateProcess(raw, 1) } == 0 {
        let error = io::Error::last_os_error();
        let mut exit_code = 0;
        // SAFETY: `raw` remains valid while `child` is borrowed.
        if unsafe { GetExitCodeProcess(raw, &mut exit_code) } == 0 || exit_code == STILL_ACTIVE {
            return Err(error);
        }
    }
    child.wait().map(|_| ())
}

#[cfg(not(windows))]
fn rollback_spawned_child(child: &mut Box<dyn Child + Send + Sync>) -> io::Result<()> {
    child.kill()?;
    child.wait().map(|_| ())
}

fn rollback_error(
    child: &mut Box<dyn Child + Send + Sync>,
    cause: impl std::fmt::Display,
) -> String {
    match rollback_spawned_child(child) {
        Ok(()) => cause.to_string(),
        Err(cleanup) => format!("{cause}; child rollback failed: {cleanup}"),
    }
}

#[cfg(windows)]
fn terminate(killer: &mut OwnedHandle) -> io::Result<()> {
    const STILL_ACTIVE: u32 = 259;
    use std::os::windows::io::AsRawHandle;

    let handle = killer.as_raw_handle();
    let mut exit_code = 0;
    // SAFETY: `handle` is an owned duplicate of the child process handle.
    if unsafe { GetExitCodeProcess(handle, &mut exit_code) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if exit_code != STILL_ACTIVE {
        return Ok(());
    }
    // SAFETY: `handle` remains owned and valid for this call.
    if unsafe { TerminateProcess(handle, 1) } != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0 && exit_code != STILL_ACTIVE {
        return Ok(());
    }
    Err(error)
}

#[cfg(not(windows))]
fn terminate(killer: &mut Box<dyn ChildKiller + Send + Sync>) -> io::Result<()> {
    killer.kill()
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetExitCodeProcess(process: std::os::windows::io::RawHandle, exit_code: *mut u32) -> i32;
    fn TerminateProcess(process: std::os::windows::io::RawHandle, exit_code: u32) -> i32;
}

enum WriteMessage {
    Data(Vec<u8>),
    StartupComplete(bool),
    Stop,
}

fn frame(output: &Stdout, value: Value) -> io::Result<()> {
    let mut output = output.lock().unwrap();
    serde_json::to_writer(&mut *output, &value)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn response(
    output: &Stdout,
    id: &str,
    generation: u64,
    result: Result<Value, String>,
) -> io::Result<()> {
    let mut value = json!({"type":"response", "id":id, "generation":generation});
    match result {
        Ok(data) => {
            value["ok"] = json!(true);
            if let Some(object) = data.as_object() {
                for (key, field) in object {
                    value[key] = field.clone();
                }
            }
        }
        Err(error) => {
            value["ok"] = json!(false);
            value["error"] = json!(error);
        }
    }
    frame(output, value)
}

fn required_string(request: &Value, name: &str) -> Result<String, String> {
    request
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {name}"))
}

fn required_u64(request: &Value, name: &str) -> Result<u64, String> {
    request
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing {name}"))
}

fn required_u16(request: &Value, name: &str) -> Result<u16, String> {
    request
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("invalid {name}"))
}

impl PtyHost {
    pub fn new(sink: PtySink) -> Self {
        Self {
            inner: Arc::new(HostInner {
                sink,
                sessions: Mutex::new(HashMap::new()),
                waiters: Mutex::new(Vec::new()),
            }),
        }
    }

    /// Starts a session and returns the direct child PID.
    ///
    /// Replaces any live session with the same id (the old one is terminated).
    pub fn spawn(&self, spec: &PtySpawnSpec) -> Result<u32, String> {
        if !Path::new(&spec.bin).is_absolute() {
            return Err(format!("binary path must be absolute: {}", spec.bin));
        }
        if !Path::new(&spec.bin).exists() {
            return Err(format!("binary not found: {}", spec.bin));
        }
        if spec.cols == 0 || spec.rows == 0 {
            return Err("invalid pty size".to_owned());
        }

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: spec.rows,
                cols: spec.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        let mut command = CommandBuilder::new(&spec.bin);
        command.cwd(Path::new(&spec.cwd));
        command.env_clear();
        for arg in &spec.args {
            command.arg(arg);
        }
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);
        let pid = child.process_id().unwrap_or(0);
        let killer = match clone_killer(child.as_ref()) {
            Ok(killer) => killer,
            Err(error) => return Err(rollback_error(&mut child, error)),
        };
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                return Err(rollback_error(&mut child, error));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                return Err(rollback_error(&mut child, error));
            }
        };
        let master = Arc::new(Mutex::new(Some(pair.master)));
        let cancelled = Arc::new(AtomicBool::new(false));
        let (write_tx, write_rx) = mpsc::channel();
        let generation = spec.generation;
        let session = Session {
            generation,
            master: master.clone(),
            killer: killer.clone(),
            writes: write_tx.clone(),
            cancelled: cancelled.clone(),
        };

        {
            let mut sessions = self.inner.sessions.lock().unwrap();
            if let Some(previous) = sessions.remove(&spec.id) {
                previous.cancelled.store(true, Ordering::SeqCst);
                let _ = terminate(&mut previous.killer.lock().unwrap());
                let _ = previous.writes.send(WriteMessage::Stop);
            }
            sessions.insert(spec.id.clone(), session);
        }

        let writer_cancelled = cancelled.clone();
        let writer_thread =
            thread::spawn(move || writer_loop(writer, write_rx, writer_cancelled, cfg!(windows)));
        let output_open = Arc::new(Mutex::new(true));
        let gate = output_open.clone();
        let host_sink = self.inner.sink.clone();
        let reader_sink: PtySink = Arc::new(move |event| {
            let open = gate.lock().unwrap();
            if *open {
                host_sink(event);
            }
        });
        let reader_id = spec.id.clone();
        let reader_writes = write_tx.clone();
        let (reader_done_tx, reader_done) = mpsc::channel();
        let reader_thread = thread::spawn(move || {
            reader_loop(
                reader,
                &reader_id,
                generation,
                &reader_sink,
                reader_writes,
                cfg!(windows),
            );
            let _ = reader_done_tx.send(());
        });
        let waiter_inner = self.inner.clone();
        let waiter_id = spec.id.clone();
        let waiter = thread::spawn(move || {
            waiter_loop(
                &mut child,
                &waiter_id,
                generation,
                master,
                cancelled,
                write_tx,
                writer_thread,
                reader_thread,
                reader_done,
                output_open,
                &waiter_inner,
            )
        });
        self.inner.waiters.lock().unwrap().push(waiter);
        Ok(pid)
    }

    /// Writes bytes to the session's PTY.
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let (_, _, writes, _) = self.session_parts(id)?;
        writes
            .send(WriteMessage::Data(data.to_vec()))
            .map_err(|error| error.to_string())
    }

    /// Resizes the session's PTY.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Err("invalid pty size".to_owned());
        }
        let (master, _, _, _) = self.session_parts(id)?;
        let master = master.lock().map_err(|_| "master lock poisoned")?;
        master
            .as_ref()
            .ok_or("pty already closed")?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    }

    /// Terminates the session's child process.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let (_, killer, writes, cancelled) = self.session_parts(id)?;
        cancelled.store(true, Ordering::SeqCst);
        writes
            .send(WriteMessage::Stop)
            .map_err(|error| error.to_string())?;
        let mut killer = killer.lock().map_err(|_| "killer lock poisoned")?;
        terminate(&mut killer).map_err(|error| error.to_string())
    }

    /// Generation of the live session for `id`, if any.
    pub fn generation(&self, id: &str) -> Option<u64> {
        let sessions = self.inner.sessions.lock().ok()?;
        sessions.get(id).map(|session| session.generation)
    }

    /// Terminates every session and joins their waiter threads (the `run()` EOF branch).
    pub fn shutdown(&self) {
        let controls = {
            let sessions = self.inner.sessions.lock().unwrap();
            sessions
                .values()
                .map(|session| (session.writes.clone(), session.killer.clone()))
                .collect::<Vec<_>>()
        };
        for (writes, killer) in controls {
            let _ = writes.send(WriteMessage::Stop);
            let _ = terminate(&mut killer.lock().unwrap());
        }
        for waiter in self.inner.waiters.lock().unwrap().drain(..) {
            let _ = waiter.join();
        }
    }

    fn session_parts(
        &self,
        id: &str,
    ) -> Result<
        (
            Arc<Mutex<Option<Master>>>,
            Killer,
            mpsc::Sender<WriteMessage>,
            Arc<AtomicBool>,
        ),
        String,
    > {
        let sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| "session map poisoned".to_owned())?;
        let session = sessions
            .get(id)
            .ok_or_else(|| "unknown session".to_owned())?;
        Ok((
            session.master.clone(),
            session.killer.clone(),
            session.writes.clone(),
            session.cancelled.clone(),
        ))
    }
}

fn writer_loop(
    mut writer: Box<dyn Write + Send>,
    writes: mpsc::Receiver<WriteMessage>,
    cancelled: Arc<AtomicBool>,
    wait_for_startup: bool,
) {
    let mut startup_pending = wait_for_startup;
    let mut queued = std::collections::VecDeque::new();
    while let Ok(message) = writes.recv() {
        match message {
            WriteMessage::Stop => break,
            WriteMessage::Data(bytes) if !cancelled.load(Ordering::SeqCst) => {
                if startup_pending {
                    queued.push_back(bytes);
                    continue;
                }
                if writer.write_all(&bytes).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
            WriteMessage::Data(_) => {}
            WriteMessage::StartupComplete(answer_query) => {
                if startup_pending {
                    startup_pending = false;
                    if answer_query && writer.write_all(b"\x1b[1;1R").is_err() {
                        break;
                    }
                    if writer.flush().is_err() {
                        break;
                    }
                    for bytes in queued.drain(..) {
                        if cancelled.load(Ordering::SeqCst) {
                            break;
                        }
                        if writer.write_all(&bytes).is_err() {
                            return;
                        }
                        let _ = writer.flush();
                    }
                }
            }
        }
    }
}

fn reader_loop(
    mut reader: Box<dyn Read + Send>,
    id: &str,
    generation: u64,
    sink: &PtySink,
    writes: mpsc::Sender<WriteMessage>,
    startup_handshake: bool,
) {
    let mut bytes = [0_u8; 8192];
    let mut startup_filter = StartupFilter::default();
    loop {
        match reader.read(&mut bytes) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let visible = if startup_handshake {
                    let (visible, completed) = startup_filter.consume(&bytes[..count]);
                    if let Some(answer_query) = completed {
                        let _ = writes.send(WriteMessage::StartupComplete(answer_query));
                    }
                    visible
                } else {
                    bytes[..count].to_vec()
                };
                if !visible.is_empty() {
                    sink(PtyEvent::Output {
                        id: id.to_owned(),
                        generation,
                        bytes: visible,
                    });
                }
            }
        }
    }
    if startup_handshake {
        let (pending, completed) = startup_filter.finish();
        if let Some(answer_query) = completed {
            let _ = writes.send(WriteMessage::StartupComplete(answer_query));
        }
        if !pending.is_empty() {
            sink(PtyEvent::Output {
                id: id.to_owned(),
                generation,
                bytes: pending,
            });
        }
    }
}

#[derive(Default)]
struct StartupFilter {
    pending: Vec<u8>,
    complete: bool,
}

impl StartupFilter {
    const QUERY: &'static [u8] = b"\x1b[6n";

    fn consume(&mut self, input: &[u8]) -> (Vec<u8>, Option<bool>) {
        if self.complete {
            return (input.to_vec(), None);
        }
        let mut visible = Vec::new();
        let mut completed = None;
        for (index, byte) in input.iter().copied().enumerate() {
            if byte == Self::QUERY[self.pending.len()] {
                self.pending.push(byte);
                if self.pending.len() == Self::QUERY.len() {
                    self.pending.clear();
                    self.complete = true;
                    completed = Some(true);
                    visible.extend_from_slice(&input[index + 1..]);
                    break;
                }
            } else {
                visible.append(&mut self.pending);
                visible.push(byte);
                visible.extend_from_slice(&input[index + 1..]);
                self.complete = true;
                completed = Some(false);
                break;
            }
        }
        (visible, completed)
    }

    fn finish(&mut self) -> (Vec<u8>, Option<bool>) {
        if self.complete {
            return (Vec::new(), None);
        }
        self.complete = true;
        let pending = std::mem::take(&mut self.pending);
        (pending, Some(false))
    }
}

/// How long `waiter_loop` waits for the reader to hit EOF after the child exits.
const READER_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

fn waiter_loop(
    child: &mut Box<dyn Child + Send + Sync>,
    id: &str,
    generation: u64,
    master: Arc<Mutex<Option<Master>>>,
    cancelled: Arc<AtomicBool>,
    writes: mpsc::Sender<WriteMessage>,
    writer: JoinHandle<()>,
    reader: JoinHandle<()>,
    reader_done: mpsc::Receiver<()>,
    output_open: Arc<Mutex<bool>>,
    inner: &Arc<HostInner>,
) {
    let exit_code = child.wait().ok().map(|status| status.exit_code());
    cancelled.store(true, Ordering::SeqCst);
    let _ = writes.send(WriteMessage::Stop);
    if let Ok(mut handle) = master.lock() {
        handle.take();
    }
    let _ = writer.join();
    // A process spawned concurrently elsewhere (std `Command` inherits handles
    // on Windows) can hold the output pipe's write end, so EOF waits for that
    // foreign process. Drain for a bounded grace, then close the output gate so
    // a detached reader can never emit after `Exit`.
    match reader_done.recv_timeout(READER_DRAIN_GRACE) {
        Err(mpsc::RecvTimeoutError::Timeout) => {}
        _ => {
            let _ = reader.join();
        }
    }
    *output_open.lock().unwrap() = false;
    {
        let mut sessions = inner.sessions.lock().unwrap();
        if sessions.get(id).map(|session| session.generation) == Some(generation) {
            sessions.remove(id);
        }
    }
    (inner.sink)(PtyEvent::Exit {
        id: id.to_owned(),
        generation,
        exit_code: exit_code.map(|code| code as i32),
    });
}

/// JSON frame for one sink event (the `--pty` stdout protocol).
fn event_frame(event: PtyEvent) -> Value {
    match event {
        PtyEvent::Output {
            id,
            generation,
            bytes,
        } => {
            json!({"type":"event","event":"output","id":id,"generation":generation,"data_bytes":bytes})
        }
        PtyEvent::Exit {
            id,
            generation,
            exit_code,
        } => {
            let mut value = json!({"type":"event","event":"exit","id":id,"generation":generation});
            value["exitCode"] = exit_code.map_or(Value::Null, |code| json!(code));
            value
        }
    }
}

fn operate(request: &Value, host: &PtyHost) -> Result<Value, String> {
    let id = required_string(request, "id")?;
    let generation = required_u64(request, "generation")?;
    let operation = request
        .get("op")
        .and_then(Value::as_str)
        .ok_or("missing op")?;
    if operation == "spawn" {
        let spec = spawn_spec(request, id, generation)?;
        return host.spawn(&spec).map(|pid| json!({"pid":pid}));
    }
    if host.generation(&id) != Some(generation) {
        return Err("stale or unknown generation".to_owned());
    }
    match operation {
        "write" => {
            let bytes = request
                .get("data_bytes")
                .and_then(Value::as_array)
                .ok_or("missing data_bytes")?
                .iter()
                .map(|value| {
                    value
                        .as_u64()
                        .and_then(|byte| u8::try_from(byte).ok())
                        .ok_or("invalid byte")
                })
                .collect::<Result<Vec<_>, _>>()?;
            host.write(&id, &bytes)?;
            Ok(json!({"accepted":true}))
        }
        "resize" => {
            let cols = required_u16(request, "cols")?;
            let rows = required_u16(request, "rows")?;
            host.resize(&id, cols, rows)?;
            Ok(json!({"resized":true}))
        }
        "kill" => {
            host.kill(&id)?;
            Ok(json!({"accepted":true}))
        }
        _ => Err(format!("unknown operation: {operation}")),
    }
}

fn spawn_spec(request: &Value, id: String, generation: u64) -> Result<PtySpawnSpec, String> {
    let bin = required_string(request, "bin")?;
    let cwd = required_string(request, "cwd")?;
    let cols = required_u16(request, "cols")?;
    let rows = required_u16(request, "rows")?;
    let args = request
        .get("args")
        .and_then(Value::as_array)
        .ok_or("missing args")?
        .iter()
        .map(|arg| {
            arg.as_str()
                .map(str::to_owned)
                .ok_or("args must be strings")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut env = HashMap::new();
    for (key, value) in request
        .get("env")
        .and_then(Value::as_object)
        .ok_or("missing env")?
    {
        env.insert(
            key.clone(),
            value
                .as_str()
                .ok_or("env values must be strings")?
                .to_owned(),
        );
    }
    Ok(PtySpawnSpec {
        id,
        generation,
        bin,
        args,
        cwd,
        env,
        cols,
        rows,
    })
}

pub fn run() -> io::Result<()> {
    let output: Stdout = Arc::new(Mutex::new(io::BufWriter::new(io::stdout())));
    let sink_output = output.clone();
    let sink: PtySink = Arc::new(move |event| {
        let _ = frame(&sink_output, event_frame(event));
    });
    let host = PtyHost::new(sink);
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let _ = frame(
                    &output,
                    json!({"type":"response","ok":false,"error":error.to_string()}),
                );
                continue;
            }
        };
        let id = request
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let generation = request
            .get("generation")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let result = operate(&request, &host);
        response(&output, &id, generation, result)?;
    }
    host.shutdown();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn recording_sink() -> (PtySink, Arc<Mutex<Vec<PtyEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let sink: PtySink = Arc::new(move |event| sink_events.lock().unwrap().push(event));
        (sink, events)
    }

    fn wait_for_exit(events: &Arc<Mutex<Vec<PtyEvent>>>) -> Option<Option<i32>> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(code) = events.lock().unwrap().iter().find_map(|event| match event {
                PtyEvent::Exit { exit_code, .. } => Some(*exit_code),
                PtyEvent::Output { .. } => None,
            }) {
                return Some(code);
            }
            thread::sleep(Duration::from_millis(10));
        }
        None
    }

    fn output_text(events: &[PtyEvent]) -> String {
        let mut bytes = Vec::new();
        for event in events {
            if let PtyEvent::Output { bytes: chunk, .. } = event {
                bytes.extend_from_slice(chunk);
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[cfg(windows)]
    fn shell_path() -> String {
        std::env::var("COMSPEC").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_owned())
    }

    #[cfg(not(windows))]
    fn shell_path() -> String {
        "/bin/sh".to_owned()
    }

    fn cwd() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    /// Short-lived child: prints a marker and exits 0.
    ///
    /// The env map carries one variable because an empty environment block makes
    /// `CreateProcessW` fail on Windows (real callers always forward an env).
    fn echo_spec(id: &str, generation: u64) -> PtySpawnSpec {
        let mut spec = PtySpawnSpec::new(id, generation, shell_path(), cwd());
        spec.env.insert("PTY_HOST_TEST".to_owned(), "1".to_owned());
        spec.args = if cfg!(windows) {
            vec!["/c".to_owned(), "echo pty-host-marker".to_owned()]
        } else {
            vec!["-c".to_owned(), "echo pty-host-marker".to_owned()]
        };
        spec
    }

    /// Long-lived child: interactive shell that stays alive until killed.
    fn long_lived_spec(id: &str, generation: u64) -> PtySpawnSpec {
        let mut spec = PtySpawnSpec::new(id, generation, shell_path(), cwd());
        spec.env.insert("PTY_HOST_TEST".to_owned(), "1".to_owned());
        spec.args = if cfg!(windows) {
            vec!["/k".to_owned()]
        } else {
            vec!["-i".to_owned()]
        };
        spec
    }

    #[test]
    fn rejects_invalid_dimensions() {
        assert!(required_u16(&json!({"cols":0}), "cols").is_err());
        assert!(required_u16(&json!({"cols":80}), "cols").is_ok());
    }

    #[test]
    fn event_bytes_are_json_arrays() {
        let value = json!({"data_bytes":[0, 226, 130, 172]});
        assert_eq!(value["data_bytes"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn startup_query_is_suppressed_across_every_fragment_split() {
        for split in 0..=StartupFilter::QUERY.len() {
            let mut filter = StartupFilter::default();
            let (first, first_complete) = filter.consume(&StartupFilter::QUERY[..split]);
            let (second, second_complete) = filter.consume(&StartupFilter::QUERY[split..]);
            assert!(first.is_empty(), "split {split}");
            assert!(second.is_empty(), "split {split}");
            assert_eq!(
                first_complete.or(second_complete),
                Some(true),
                "split {split}"
            );
        }
    }

    #[test]
    fn startup_filter_forwards_later_queries_and_mismatched_prefixes() {
        let mut filter = StartupFilter::default();
        let (visible, completed) = filter.consume(b"\x1b[6napp\x1b[6n");
        assert_eq!(completed, Some(true));
        assert_eq!(visible, b"app\x1b[6n");

        for split in 0..StartupFilter::QUERY.len() {
            let mut filter = StartupFilter::default();
            let mut visible = filter.consume(&StartupFilter::QUERY[..split]).0;
            let mut mismatched = StartupFilter::QUERY[split..].to_vec();
            if mismatched.is_empty() {
                mismatched.push(b'x');
            } else {
                mismatched[0] = b'x';
            }
            let (tail, completed) = filter.consume(&mismatched);
            visible.extend(tail);
            assert_eq!(completed, Some(false), "split {split}");
            assert_eq!(
                visible,
                [StartupFilter::QUERY[..split].to_vec(), mismatched].concat(),
                "split {split}"
            );
        }
    }

    #[test]
    fn startup_filter_preserves_a_partial_prefix_at_eof() {
        let mut filter = StartupFilter::default();
        let (visible, completed) = filter.consume(b"\x1b[");
        assert!(visible.is_empty());
        assert_eq!(completed, None);
        assert_eq!(filter.finish(), (b"\x1b[".to_vec(), Some(false)));
    }

    #[test]
    fn startup_reply_precedes_user_input_queued_while_prefix_is_pending() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let (sender, receiver) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let writer_output = written.clone();
        let writer = thread::spawn(move || {
            writer_loop(
                Box::new(SharedWriter(writer_output)),
                receiver,
                cancelled,
                true,
            )
        });
        sender.send(WriteMessage::Data(b"user".to_vec())).unwrap();
        sender.send(WriteMessage::StartupComplete(true)).unwrap();
        sender.send(WriteMessage::Stop).unwrap();
        writer.join().unwrap();
        assert_eq!(*written.lock().unwrap(), b"\x1b[1;1Ruser");
    }

    #[test]
    fn event_frames_match_the_stdout_protocol() {
        assert_eq!(
            event_frame(PtyEvent::Output {
                id: "a".to_owned(),
                generation: 2,
                bytes: vec![104, 105],
            }),
            json!({"type":"event","event":"output","id":"a","generation":2,"data_bytes":[104,105]})
        );
        assert_eq!(
            event_frame(PtyEvent::Exit {
                id: "a".to_owned(),
                generation: 2,
                exit_code: None,
            }),
            json!({"type":"event","event":"exit","id":"a","generation":2,"exitCode":null})
        );
    }

    /// A foreign child spawned concurrently can inherit the output pipe's write
    /// end (Windows), so reader EOF waits for it; `Exit` must still arrive, last.
    #[test]
    fn exit_arrives_while_a_concurrent_child_holds_the_output_pipe() {
        let stop = Arc::new(AtomicBool::new(false));
        let spawner_stop = stop.clone();
        let spawner = thread::spawn(move || {
            let sleeper = if cfg!(windows) {
                vec!["/c", "ping -n 6 127.0.0.1 >NUL"]
            } else {
                vec!["-c", "sleep 5"]
            };
            let mut kids = Vec::new();
            while !spawner_stop.load(Ordering::SeqCst) {
                if let Ok(kid) = std::process::Command::new(shell_path())
                    .args(&sleeper)
                    .stdout(std::process::Stdio::null())
                    .spawn()
                {
                    kids.push(kid);
                }
                thread::sleep(Duration::from_millis(20));
            }
            for mut kid in kids {
                let _ = kid.kill();
                let _ = kid.wait();
            }
        });
        let exits: Vec<_> = (0..4)
            .map(|round| {
                let (sink, events) = recording_sink();
                let host = PtyHost::new(sink);
                host.spawn(&echo_spec("echo", round)).expect("spawn");
                let exit = wait_for_exit(&events);
                let last_is_exit =
                    matches!(events.lock().unwrap().last(), Some(PtyEvent::Exit { .. }));
                (exit, last_is_exit)
            })
            .collect();
        stop.store(true, Ordering::SeqCst);
        spawner.join().unwrap();
        for (round, (exit, last_is_exit)) in exits.into_iter().enumerate() {
            assert_eq!(exit, Some(Some(0)), "round {round}");
            assert!(last_is_exit, "round {round}: no output after Exit");
        }
    }

    #[test]
    fn host_emits_output_then_exit_for_a_short_lived_child() {
        let (sink, events) = recording_sink();
        let host = PtyHost::new(sink);
        let pid = host.spawn(&echo_spec("echo", 4)).expect("spawn");
        assert!(pid > 0, "spawn returns the direct child pid");
        assert_eq!(host.generation("echo"), Some(4));
        let exit = wait_for_exit(&events).expect("exit event");
        assert_eq!(exit, Some(0));
        let events = events.lock().unwrap();
        assert!(output_text(&events).contains("pty-host-marker"));
        assert!(events.iter().all(|event| match event {
            PtyEvent::Output { id, generation, .. } | PtyEvent::Exit { id, generation, .. } =>
                id == "echo" && *generation == 4,
        }));
        assert!(matches!(events.last(), Some(PtyEvent::Exit { .. })));
        assert_eq!(host.generation("echo"), None, "exited session is dropped");
    }

    #[test]
    fn host_refuses_relative_or_missing_binaries() {
        let (sink, _events) = recording_sink();
        let host = PtyHost::new(sink);

        let mut relative = echo_spec("relative", 1);
        relative.bin = if cfg!(windows) { "cmd.exe" } else { "sh" }.to_owned();
        let error = host.spawn(&relative).expect_err("relative bin must fail");
        assert!(error.contains("must be absolute"), "error: {error}");

        let missing = std::env::temp_dir()
            .join(format!("pty-host-missing-{}", std::process::id()))
            .join("no-such-binary");
        assert!(missing.is_absolute());
        let mut absent = echo_spec("absent", 1);
        absent.bin = missing.to_string_lossy().into_owned();
        let error = host.spawn(&absent).expect_err("missing bin must fail");
        assert!(error.contains("not found"), "error: {error}");

        let mut zero = echo_spec("zero", 1);
        zero.cols = 0;
        assert!(host.spawn(&zero).is_err());
    }

    #[test]
    fn host_operations_on_unknown_sessions_error() {
        let (sink, _events) = recording_sink();
        let host = PtyHost::new(sink);
        assert_eq!(host.generation("nope"), None);
        assert!(host.write("nope", b"x").is_err());
        assert!(host.resize("nope", 80, 24).is_err());
        assert!(host.kill("nope").is_err());
        host.shutdown();
    }

    #[test]
    fn host_kill_terminates_a_live_child_and_emits_exit() {
        let (sink, events) = recording_sink();
        let host = PtyHost::new(sink);
        host.spawn(&long_lived_spec("live", 3)).expect("spawn");
        host.write("live", b"\r\n").expect("write");
        host.resize("live", 100, 40).expect("resize");
        host.kill("live").expect("kill");
        let exit = wait_for_exit(&events).expect("exit event");
        #[cfg(windows)]
        assert_eq!(exit, Some(1), "TerminateProcess(1) exit code");
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            PtyEvent::Exit { id, generation: 3, .. } if id == "live"
        )));
    }

    #[test]
    fn host_shutdown_terminates_live_children_and_joins_waiters() {
        let (sink, events) = recording_sink();
        let host = PtyHost::new(sink);
        host.spawn(&long_lived_spec("drain", 9)).expect("spawn");
        host.shutdown();
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            PtyEvent::Exit { id, generation: 9, .. } if id == "drain"
        )));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, PtyEvent::Exit { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn host_spawn_replaces_a_live_session_with_the_same_id() {
        let (sink, events) = recording_sink();
        let host = PtyHost::new(sink);
        host.spawn(&long_lived_spec("same", 1))
            .expect("first spawn");
        host.spawn(&long_lived_spec("same", 2))
            .expect("second spawn");
        assert_eq!(host.generation("same"), Some(2));
        host.shutdown();
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            PtyEvent::Exit { id, generation: 1, .. } if id == "same"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            PtyEvent::Exit { id, generation: 2, .. } if id == "same"
        )));
    }
}
