// One-shot CLI prompt execution for server/one-shot.mjs: runs a binary to
// completion with a deadline and returns its captured stdout. Ports Node's
// execFile semantics: stdin closed (Stdio::null = immediate EOF), windowsHide,
// timeout kill, and the 8MB maxBuffer cap (ONESHOT_MAX_BUFFER parity).
use serde_json::{Value, json};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const MAX_BUFFER: usize = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: f64 = 120_000.0;

enum Pipe {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
}

fn read_pipe<R: Read>(mut pipe: R, cap: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    // cap+1 so an oversized stream is detectable after EOF
    let _ = pipe.by_ref().take(cap as u64 + 1).read_to_end(&mut buf);
    buf
}

enum WaitOutcome {
    Exited(std::process::ExitStatus),
    TimedOut,
    Failed(String),
}

// Pipes at EOF can still leave a hung child (wedged cleanup, daemonizing
// spawn); an unbounded final wait would wedge the whole bridge queue.
fn wait_bounded(child: &mut std::process::Child, deadline: Option<Instant>) -> WaitOutcome {
    let Some(at) = deadline else {
        return match child.wait() {
            Ok(status) => WaitOutcome::Exited(status),
            Err(error) => WaitOutcome::Failed(error.to_string()),
        };
    };
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return WaitOutcome::Exited(status),
            Ok(None) => {}
            Err(error) => return WaitOutcome::Failed(error.to_string()),
        }
        let now = Instant::now();
        if now >= at {
            return WaitOutcome::TimedOut;
        }
        std::thread::sleep((at - now).min(Duration::from_millis(10)));
    }
}

fn lossy(buf: Option<Vec<u8>>) -> String {
    String::from_utf8_lossy(&buf.unwrap_or_default()).into_owned()
}

fn fail(
    child: &mut std::process::Child,
    error: &str,
    timed_out: bool,
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
) -> Value {
    let _ = child.kill();
    let _ = child.wait();
    json!({ "ok": false, "error": error, "timed_out": timed_out, "stdout": lossy(stdout), "stderr": lossy(stderr) })
}

pub fn run(bin: Option<&str>, args: &Value, timeout_ms: Option<f64>) -> Value {
    let Some(bin) = bin else {
        return json!({ "ok": false, "error": "bad bin", "stdout": "", "stderr": "" });
    };
    let argv: Vec<String> = args
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let deadline = Some(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(0.0))
        .filter(|ms| *ms > 0.0) // Node treats timeout <= 0 as no timeout
        .map(|ms| Instant::now() + Duration::from_millis(ms as u64));

    let mut cmd = Command::new(bin);
    cmd.args(argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // execFile's windowsHide parity: never flash a console window.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            return json!({ "ok": false, "error": format!("Command failed: {bin}: {error}"), "stdout": "", "stderr": "" });
        }
    };

    let (tx, rx) = mpsc::channel();
    if let Some(pipe) = child.stdout.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Pipe::Stdout(read_pipe(pipe, MAX_BUFFER)));
        });
    }
    if let Some(pipe) = child.stderr.take() {
        std::thread::spawn(move || {
            let _ = tx.send(Pipe::Stderr(read_pipe(pipe, MAX_BUFFER)));
        });
    }

    let mut stdout = None;
    let mut stderr = None;
    while stdout.is_none() || stderr.is_none() {
        let received = match deadline {
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(pipe) => Some(pipe),
                Err(_) => None,
            },
            None => rx.recv().ok(),
        };
        match received {
            Some(Pipe::Stdout(buf)) => stdout = Some(buf),
            Some(Pipe::Stderr(buf)) => stderr = Some(buf),
            None => return fail(&mut child, "timeout", true, stdout.take(), stderr.take()),
        }
    }
    if stdout.as_ref().is_some_and(|buf| buf.len() > MAX_BUFFER) {
        return fail(
            &mut child,
            "stdout maxBuffer exceeded",
            false,
            stdout,
            stderr,
        );
    }
    let status = match wait_bounded(&mut child, deadline) {
        WaitOutcome::Exited(status) => status,
        WaitOutcome::TimedOut => {
            return fail(&mut child, "timeout", true, stdout.take(), stderr.take());
        }
        WaitOutcome::Failed(error) => {
            return json!({ "ok": false, "error": error, "stdout": lossy(stdout), "stderr": lossy(stderr) });
        }
    };
    if !status.success() {
        return json!({
            "ok": false,
            "error": format!("exit code {}", status.code().unwrap_or(-1)),
            "code": status.code(),
            "stdout": lossy(stdout),
            "stderr": lossy(stderr),
        });
    }
    json!({ "ok": true, "stdout": lossy(stdout), "stderr": lossy(stderr) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_stdout_and_passes_args_through() {
        #[cfg(windows)]
        let (bin, args) = ("cmd", json!(["/C", "echo one-shot-ok"]));
        #[cfg(not(windows))]
        let (bin, args) = ("sh", json!(["-c", "echo one-shot-ok"]));
        let out = run(Some(bin), &args, Some(10_000.0));
        assert_eq!(out["ok"], true, "expected success, got {out}");
        assert!(out["stdout"].as_str().unwrap().contains("one-shot-ok"));
    }

    #[test]
    fn non_zero_exit_reports_failure_with_stdout() {
        #[cfg(windows)]
        let (bin, args) = ("cmd", json!(["/C", "echo boom & exit 3"]));
        #[cfg(not(windows))]
        let (bin, args) = ("sh", json!(["-c", "echo boom; exit 3"]));
        let out = run(Some(bin), &args, Some(10_000.0));
        assert_eq!(out["ok"], false);
        assert_eq!(out["code"], 3);
        assert!(out["stdout"].as_str().unwrap().contains("boom"));
        assert_eq!(out["error"], "exit code 3");
    }

    #[test]
    fn kills_a_child_that_outlives_the_deadline() {
        #[cfg(windows)]
        let (bin, args) = ("ping", json!(["-n", "10", "127.0.0.1"]));
        #[cfg(not(windows))]
        let (bin, args) = ("sleep", json!(["1"]));
        let out = run(Some(bin), &args, Some(100.0));
        assert_eq!(out["ok"], false);
        assert_eq!(out["error"], "timeout");
    }

    #[test]
    fn wait_bounded_times_out_or_returns_the_exit_status() {
        // hung child past its deadline: EOF'd pipes left it running, so the
        // final wait must give up at the deadline instead of blocking
        #[cfg(windows)]
        let mut cmd = Command::new("ping");
        #[cfg(windows)]
        cmd.args(["-n", "10", "127.0.0.1"]);
        #[cfg(not(windows))]
        let mut cmd = Command::new("sleep");
        #[cfg(not(windows))]
        cmd.args(["10"]);
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(matches!(
            wait_bounded(
                &mut child,
                Some(Instant::now() + Duration::from_millis(200))
            ),
            WaitOutcome::TimedOut
        ));
        let _ = child.kill();
        let _ = child.wait();

        #[cfg(windows)]
        let (bin, args) = ("cmd", ["exit", "0"]);
        #[cfg(not(windows))]
        let (bin, args) = ("true", [] as [&str; 0]);
        let mut child = Command::new(bin)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(matches!(wait_bounded(&mut child, None), WaitOutcome::Exited(s) if s.success()));
    }

    #[test]
    fn missing_bin_reports_the_spawn_error() {
        let out = run(
            Some("definitely-not-a-binary-xyz"),
            &json!([]),
            Some(1000.0),
        );
        assert_eq!(out["ok"], false);
        assert!(
            out["error"]
                .as_str()
                .unwrap()
                .contains("definitely-not-a-binary-xyz")
        );
    }
}
