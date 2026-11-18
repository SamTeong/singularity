// Guarded PID kill for server/procs.mjs (POST /procs/kill). Node keeps every
// decision — scan, classification, daemon-kind denial, TOCTOU re-query — and
// this op performs only the final terminate, so no child-process or signal
// primitive stays in Node. Never a shell: argv arrays only, no interpolation.
use serde_json::{Value, json};
use std::process::{Command, Stdio};

pub fn kill(pid: &Value) -> Value {
    let Some(pid) = pid.as_i64() else {
        return json!({ "ok": false, "error": "bad pid" });
    };
    // 0/negative would target a process group (unix) and must never be
    // reachable from the loopback route; an out-of-range pid cannot exist.
    if pid <= 0 || pid > i32::MAX as i64 {
        return json!({ "ok": false, "error": "kill ESRCH" });
    }
    match kill_raw(pid as i32) {
        0 => json!({ "ok": true }),
        code => {
            // Node parity: process.kill failures surface as "kill ESRCH"
            // (no such process) / "kill EPERM" (not ours to kill).
            let name = if esrch(code) { "ESRCH" } else { "EPERM" };
            json!({ "ok": false, "error": format!("kill {name}") })
        }
    }
}

#[cfg(windows)]
fn kill_raw(pid: i32) -> i32 {
    // libc has no kill() on windows; taskkill /F terminates via
    // TerminateProcess — the same primitive uv_kill uses for process.kill().
    let exe = std::env::var("SystemRoot")
        .map(|root| format!("{root}\\System32\\taskkill.exe"))
        .unwrap_or_else(|_| "taskkill".to_owned());
    let mut cmd = Command::new(exe);
    cmd.args(["/PID", &pid.to_string(), "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // windowsHide parity: never flash a console window.
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.status() {
        Ok(status) if status.success() => 0,
        Ok(status) => status.code().unwrap_or(-1),
        Err(_) => -1,
    }
}

#[cfg(windows)]
fn esrch(code: i32) -> bool {
    code == 128 // taskkill exit code for "process not found"
}

#[cfg(not(windows))]
fn kill_raw(pid: i32) -> i32 {
    // Node parity: process.kill sends SIGTERM.
    unsafe { libc::kill(pid, libc::SIGTERM) }
}

#[cfg(not(windows))]
fn esrch(code: i32) -> bool {
    code == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_pids_without_touching_any_process() {
        assert_eq!(kill(&json!("4321"))["error"], "bad pid");
        assert_eq!(kill(&json!(null))["error"], "bad pid");
        assert_eq!(kill(&json!(0))["error"], "kill ESRCH");
        assert_eq!(kill(&json!(-1))["error"], "kill ESRCH");
    }

    #[test]
    fn terminates_a_scratch_child_and_reports_a_gone_pid() {
        #[cfg(windows)]
        let mut cmd = Command::new("ping");
        #[cfg(windows)]
        cmd.args(["-n", "30", "127.0.0.1"]);
        #[cfg(not(windows))]
        let mut cmd = Command::new("sleep");
        #[cfg(not(windows))]
        cmd.args(["30"]);
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let out = kill(&json!(child.id() as i64));
        assert_eq!(out["ok"], true, "expected kill success, got {out}");
        let _ = child.wait();
        // the scratch pid is gone now: refused again, never silently ok
        let gone = kill(&json!(child.id() as i64));
        assert_eq!(gone["ok"], false, "expected failure, got {gone}");
        assert!(
            gone["error"].as_str().unwrap().starts_with("kill E"),
            "expected a kill E* error, got {gone}"
        );
    }
}
