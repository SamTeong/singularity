use serde_json::{Value, json};
#[cfg(unix)]
use std::io;
use std::process::{Command, Stdio};

fn string_args(args: &Value) -> Vec<String> {
    args.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

pub fn spawn(bin: Option<&str>, args: &Value, cwd: Option<&str>, env: &Value) -> Value {
    let Some(bin) = bin.filter(|bin| !bin.is_empty()) else {
        return json!({"ok": false, "error": "binary required"});
    };

    let mut command = Command::new(bin);
    command
        .args(string_args(args))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    if let Some(entries) = env.as_object() {
        for (key, value) in entries {
            if let Some(value) = value.as_str() {
                command.env(key, value);
            }
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and uses no captured data.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    match command.spawn() {
        Ok(mut child) => {
            // Keep the Child alive until it exits so Unix can reap it.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            json!({"ok": true})
        }
        Err(error) => json!({
            "ok": false,
            "error": format!("failed to spawn {bin}: {error}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn detached_child_probe() {
        let _probe_env_guard = ENV_LOCK.lock().unwrap();
        let Ok(marker) = std::env::var("SINGULARITY_DETACHED_PROBE") else {
            return;
        };
        thread::sleep(Duration::from_millis(350));
        fs::write(
            marker,
            format!(
                "{}:{}",
                std::env::current_dir().unwrap().display(),
                std::env::var("SINGULARITY_DETACHED_VALUE").unwrap()
            ),
        )
        .unwrap();
    }

    fn marker_path() -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("singularity-detached-{id}.txt"))
    }

    #[test]
    fn spawn_returns_before_child_exits_and_preserves_arguments_cwd_and_environment() {
        let _guard = ENV_LOCK.lock().unwrap();
        let marker = marker_path();
        let cwd = marker.parent().unwrap();
        let previous_marker = std::env::var_os("SINGULARITY_DETACHED_PROBE");
        let previous_value = std::env::var_os("SINGULARITY_DETACHED_VALUE");
        // SAFETY: this test serializes environment mutation and restores both keys.
        unsafe {
            std::env::set_var("SINGULARITY_DETACHED_PROBE", &marker);
            std::env::set_var("SINGULARITY_DETACHED_VALUE", "inherited-value");
        }
        let args = json!([
            "--exact",
            "detached::tests::detached_child_probe",
            "--nocapture"
        ]);
        let started = Instant::now();
        let result = spawn(
            std::env::current_exe().unwrap().to_str(),
            &args,
            Some(cwd.to_str().unwrap()),
            &Value::Null,
        );
        unsafe {
            match previous_marker {
                Some(value) => std::env::set_var("SINGULARITY_DETACHED_PROBE", value),
                None => std::env::remove_var("SINGULARITY_DETACHED_PROBE"),
            }
            match previous_value {
                Some(value) => std::env::set_var("SINGULARITY_DETACHED_VALUE", value),
                None => std::env::remove_var("SINGULARITY_DETACHED_VALUE"),
            }
        }
        assert_eq!(result, json!({"ok": true}));
        assert!(started.elapsed() < Duration::from_millis(300));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let text = fs::read_to_string(&marker).expect("child should write its marker");
        assert!(text.starts_with(&cwd.display().to_string()));
        assert!(text.ends_with(":inherited-value"));
        let _ = fs::remove_file(marker);
    }

    #[test]
    fn spawn_failure_returns_a_typed_error() {
        let result = spawn(
            Some("singularity-command-that-does-not-exist"),
            &json!([]),
            None,
            &Value::Null,
        );
        assert_eq!(result["ok"], false);
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .contains("failed to spawn")
        );
    }
}
