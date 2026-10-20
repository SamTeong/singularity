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
type Output = Arc<Mutex<io::BufWriter<io::Stdout>>>;
type Sessions = Arc<Mutex<HashMap<String, Session>>>;

#[cfg(windows)]
type Killer = Arc<Mutex<OwnedHandle>>;
#[cfg(not(windows))]
type Killer = Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>;

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

fn frame(output: &Output, value: Value) -> io::Result<()> {
    let mut output = output.lock().unwrap();
    serde_json::to_writer(&mut *output, &value)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn response(
    output: &Output,
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

fn spawn(
    request: &Value,
    sessions: &Sessions,
    output: &Output,
    waiters: &Arc<Mutex<Vec<JoinHandle<()>>>>,
) -> Result<Value, String> {
    let id = required_string(request, "id")?;
    let generation = required_u64(request, "generation")?;
    let bin = required_string(request, "bin")?;
    let cwd = required_string(request, "cwd")?;
    let cols = required_u16(request, "cols")?;
    let rows = required_u16(request, "rows")?;
    let args = request
        .get("args")
        .and_then(Value::as_array)
        .ok_or("missing args")?;
    let env = request
        .get("env")
        .and_then(Value::as_object)
        .ok_or("missing env")?;

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut command = CommandBuilder::new(bin);
    command.cwd(Path::new(&cwd));
    command.env_clear();
    for arg in args {
        command.arg(arg.as_str().ok_or("args must be strings")?);
    }
    for (key, value) in env {
        command.env(key, value.as_str().ok_or("env values must be strings")?);
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
    let session = Session {
        generation,
        master: master.clone(),
        killer: killer.clone(),
        writes: write_tx.clone(),
        cancelled: cancelled.clone(),
    };

    {
        let mut sessions = sessions.lock().unwrap();
        if let Some(previous) = sessions.remove(&id) {
            previous.cancelled.store(true, Ordering::SeqCst);
            let _ = terminate(&mut previous.killer.lock().unwrap());
            let _ = previous.writes.send(WriteMessage::Stop);
        }
        sessions.insert(id.clone(), session);
    }

    let writer_cancelled = cancelled.clone();
    let writer_thread =
        thread::spawn(move || writer_loop(writer, write_rx, writer_cancelled, cfg!(windows)));
    let reader_output = output.clone();
    let reader_id = id.clone();
    let reader_writes = write_tx.clone();
    let reader_thread = thread::spawn(move || {
        reader_loop(
            reader,
            &reader_id,
            generation,
            &reader_output,
            reader_writes,
            cfg!(windows),
        )
    });
    let waiter_sessions = sessions.clone();
    let waiter_output = output.clone();
    let waiter_id = id.clone();
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
            &waiter_sessions,
            &waiter_output,
        )
    });
    waiters.lock().unwrap().push(waiter);
    Ok(json!({"pid":pid}))
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
    output: &Output,
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
                if !visible.is_empty()
                    && frame(output, json!({"type":"event","event":"output","id":id,"generation":generation,"data_bytes":visible})).is_err()
                {
                    break;
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
            let _ = frame(
                output,
                json!({"type":"event","event":"output","id":id,"generation":generation,"data_bytes":pending}),
            );
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

fn waiter_loop(
    child: &mut Box<dyn Child + Send + Sync>,
    id: &str,
    generation: u64,
    master: Arc<Mutex<Option<Master>>>,
    cancelled: Arc<AtomicBool>,
    writes: mpsc::Sender<WriteMessage>,
    writer: JoinHandle<()>,
    reader: JoinHandle<()>,
    sessions: &Sessions,
    output: &Output,
) {
    let exit_code = child.wait().ok().map(|status| status.exit_code());
    cancelled.store(true, Ordering::SeqCst);
    let _ = writes.send(WriteMessage::Stop);
    if let Ok(mut handle) = master.lock() {
        handle.take();
    }
    let _ = writer.join();
    let _ = reader.join();
    {
        let mut sessions = sessions.lock().unwrap();
        if sessions.get(id).map(|session| session.generation) == Some(generation) {
            sessions.remove(id);
        }
    }
    let mut event = json!({"type":"event","event":"exit","id":id,"generation":generation});
    event["exitCode"] = exit_code.map_or(Value::Null, |code| json!(code));
    let _ = frame(output, event);
}

fn operate(
    request: &Value,
    sessions: &Sessions,
    output: &Output,
    waiters: &Arc<Mutex<Vec<JoinHandle<()>>>>,
) -> Result<Value, String> {
    let id = required_string(request, "id")?;
    let generation = required_u64(request, "generation")?;
    let operation = request
        .get("op")
        .and_then(Value::as_str)
        .ok_or("missing op")?;
    if operation == "spawn" {
        return spawn(request, sessions, output, waiters);
    }
    let (master, killer, writes, cancelled) = {
        let sessions = sessions.lock().map_err(|_| "session map poisoned")?;
        let session = sessions
            .get(&id)
            .filter(|session| session.generation == generation)
            .ok_or("stale or unknown generation")?;
        (
            session.master.clone(),
            session.killer.clone(),
            session.writes.clone(),
            session.cancelled.clone(),
        )
    };
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
            writes
                .send(WriteMessage::Data(bytes))
                .map_err(|error| error.to_string())?;
            Ok(json!({"accepted":true}))
        }
        "resize" => {
            let cols = required_u16(request, "cols")?;
            let rows = required_u16(request, "rows")?;
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
                .map_err(|error| error.to_string())?;
            Ok(json!({"resized":true}))
        }
        "kill" => {
            cancelled.store(true, Ordering::SeqCst);
            writes
                .send(WriteMessage::Stop)
                .map_err(|error| error.to_string())?;
            let mut killer = killer.lock().map_err(|_| "killer lock poisoned")?;
            terminate(&mut killer).map_err(|error| error.to_string())?;
            Ok(json!({"accepted":true}))
        }
        _ => Err(format!("unknown operation: {operation}")),
    }
}

pub fn run() -> io::Result<()> {
    let output = Arc::new(Mutex::new(io::BufWriter::new(io::stdout())));
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let waiters: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
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
        let result = operate(&request, &sessions, &output, &waiters);
        response(&output, &id, generation, result)?;
    }
    let controls = {
        let sessions = sessions.lock().unwrap();
        sessions
            .values()
            .map(|session| (session.writes.clone(), session.killer.clone()))
            .collect::<Vec<_>>()
    };
    for (writes, killer) in controls {
        let _ = writes.send(WriteMessage::Stop);
        let _ = terminate(&mut killer.lock().unwrap());
    }
    for waiter in waiters.lock().unwrap().drain(..) {
        let _ = waiter.join();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
