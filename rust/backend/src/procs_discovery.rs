use serde_json::{Value, json};
use std::collections::HashSet;

const MAX_BUFFER: f64 = 8.0 * 1024.0 * 1024.0;

pub fn scan_raw() -> Value {
    let (bin, args, darwin) = if cfg!(target_os = "macos") {
        ("ps", json!(["-axo", "pid=,ppid=,comm=,command="]), true)
    } else {
        (
            "powershell.exe",
            json!([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$rows = Get-CimInstance Win32_Process -Filter \"Name='claude.exe' or Name='node.exe' or Name='esbuild.exe' or Name='OpenConsole.exe'\" | ForEach-Object { [PSCustomObject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; started=$_.CreationDate.ToString('yyyy-MM-ddTHH:mm:ss'); cmd=$_.CommandLine } }; $alive = Get-Process | Select-Object -ExpandProperty Id; [PSCustomObject]@{ rows=$rows; alive=$alive } | ConvertTo-Json -Compress -Depth 4"
            ]),
            false,
        )
    };
    let output = super::oneshot::run(Some(bin), &args, Some(0.0), Some(MAX_BUFFER), None);
    if output["ok"] != true {
        return empty_snapshot(darwin);
    }
    let Some(stdout) = output["stdout"].as_str() else {
        return empty_snapshot(darwin);
    };
    if darwin {
        parse_darwin(stdout)
    } else {
        parse_windows(stdout)
    }
}

fn empty_snapshot(darwin: bool) -> Value {
    json!({ "platform": if darwin { "darwin" } else { "windows" }, "rows": [], "alive": [] })
}

fn parse_windows(stdout: &str) -> Value {
    let Ok(parsed) = serde_json::from_str::<Value>(stdout.trim()) else {
        return empty_snapshot(false);
    };
    let rows = as_array(parsed.get("rows"))
        .iter()
        .filter_map(normalize_windows_row)
        .collect::<Vec<_>>();
    let alive = as_array(parsed.get("alive"))
        .iter()
        .filter_map(as_pid)
        .collect::<Vec<_>>();
    json!({ "platform": "windows", "rows": rows, "alive": alive })
}

fn as_array(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(values)) => values.clone(),
        Some(Value::Null) | None => Vec::new(),
        Some(value) => vec![value.clone()],
    }
}

fn as_pid(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}

fn normalize_windows_row(value: &Value) -> Option<Value> {
    let pid = as_pid(value.get("pid")?)?;
    let ppid = as_pid(value.get("ppid")?)?;
    let name = value.get("name")?.as_str()?;
    let started = value
        .get("started")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::Null);
    let cmd = value
        .get("cmd")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::Null);
    Some(json!({ "pid": pid, "ppid": ppid, "name": name, "started": started, "cmd": cmd }))
}

fn parse_darwin(stdout: &str) -> Value {
    let mut rows = Vec::new();
    let mut alive = Vec::new();
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let mut start = None;
        let mut fields = Vec::new();
        for (index, ch) in line.char_indices() {
            if ch.is_whitespace() {
                if let Some(field_start) = start.take() {
                    fields.push((field_start, index));
                    if fields.len() == 3 {
                        break;
                    }
                }
            } else if start.is_none() {
                start = Some(index);
            }
        }
        if fields.len() < 3 {
            if let Some(field_start) = start {
                fields.push((field_start, line.len()));
            }
        }
        if fields.len() < 3 {
            continue;
        }
        let Some(pid) = line[fields[0].0..fields[0].1].parse::<i64>().ok() else {
            continue;
        };
        let Some(ppid) = line[fields[1].0..fields[1].1].parse::<i64>().ok() else {
            continue;
        };
        let name = &line[fields[2].0..fields[2].1];
        let cmd = line[fields[2].1..].trim_start();
        if cmd.is_empty() {
            continue;
        }
        alive.push(pid);
        rows.push(json!({ "pid": pid, "ppid": ppid, "name": name, "started": null, "cmd": cmd }));
    }
    json!({ "platform": "darwin", "rows": rows, "alive": alive })
}

pub fn classify(request: &Value) -> Value {
    let snapshot = &request["snapshot"];
    let darwin = snapshot["platform"] == "darwin";
    let root = request["repo_root"].as_str().unwrap_or("").to_lowercase();
    let host_pid = request["host_pid"].as_i64();
    let live_pids = number_set(&request["live_pids"]);
    let live_sessions = string_set(&request["live_sessions"]);
    let alive = number_set(&snapshot["alive"]);
    let rows = as_array(snapshot.get("rows"));
    let all_pids = rows
        .iter()
        .filter_map(|row| as_pid(&row["pid"]))
        .collect::<HashSet<_>>();
    let mut result = Vec::new();

    for row in rows {
        let Some(pid) = as_pid(&row["pid"]) else {
            continue;
        };
        let Some(ppid) = as_pid(&row["ppid"]) else {
            continue;
        };
        let Some(name) = row["name"].as_str() else {
            continue;
        };
        let cmd = row["cmd"].as_str().unwrap_or("");
        let is_claude = if darwin {
            name == "claude"
        } else {
            name == "claude.exe"
        };
        let is_dev_tool = if darwin {
            name == "node" || name == "esbuild"
        } else {
            name == "node.exe" || name == "esbuild.exe" || name == "OpenConsole.exe"
        };
        if !is_claude && !(is_dev_tool && cmd.to_lowercase().contains(&root)) {
            continue;
        }
        let (session, kind) = if is_claude {
            let session = extract_session(cmd);
            let tracked = live_pids.contains(&pid)
                || session
                    .as_ref()
                    .is_some_and(|id| live_sessions.contains(id));
            let kind = if tracked {
                "tracked"
            } else if session.is_some() {
                "stale"
            } else {
                "external"
            };
            (session, kind)
        } else {
            let parent_live = if darwin {
                ppid > 1 && all_pids.contains(&ppid)
            } else {
                alive.contains(&ppid)
            };
            let kind = if Some(pid) == host_pid || parent_live {
                "daemon"
            } else {
                "stale"
            };
            (None, kind)
        };
        result.push(json!({
            "pid": pid,
            "ppid": ppid,
            "name": name,
            "started": if darwin { Value::Null } else { row.get("started").cloned().unwrap_or(Value::Null) },
            "session": session,
            "kind": kind
        }));
    }
    Value::Array(result)
}

fn number_set(value: &Value) -> HashSet<i64> {
    as_array(Some(value)).iter().filter_map(as_pid).collect()
}

fn string_set(value: &Value) -> HashSet<String> {
    as_array(Some(value))
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

fn extract_session(command: &str) -> Option<String> {
    let words = command.split_whitespace().collect::<Vec<_>>();
    words.windows(2).find_map(|pair| {
        matches!(pair[0], "--session-id" | "--resume").then(|| pair[1].replace(['\'', '"'], ""))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_singleton_rows_and_missing_collections_normalize() {
        let result = parse_windows(
            r#"{"rows":{"pid":12,"ppid":3,"name":"claude.exe","started":"2025-01-02T03:04:05","cmd":"claude.exe --resume \"sid\""}}"#,
        );
        assert_eq!(result["rows"].as_array().unwrap().len(), 1);
        assert_eq!(result["alive"], json!([]));
        assert_eq!(parse_windows("not-json"), empty_snapshot(false));
    }

    #[test]
    fn darwin_parser_preserves_command_remainder_and_skips_malformed_rows() {
        let result = parse_darwin("bad row\n 12  3 claude claude --session-id sid with spaces\n");
        assert_eq!(
            result["rows"][0]["cmd"],
            "claude --session-id sid with spaces"
        );
        assert_eq!(result["rows"][0]["started"], Value::Null);
        assert_eq!(result["alive"], json!([12]));
    }

    #[test]
    fn classifier_scopes_tools_and_uses_explicit_host_and_live_session_snapshot() {
        let request = json!({
            "repo_root": "C:/repo",
            "host_pid": 40,
            "live_pids": [],
            "live_sessions": ["wrapper-session"],
            "snapshot": {
                "platform": "windows",
                "alive": [1],
                "rows": [
                    { "pid": 41, "ppid": 1, "name": "claude.exe", "started": "time", "cmd": "claude.exe --resume 'wrapper-session'" },
                    { "pid": 42, "ppid": 1, "name": "node.exe", "started": "time", "cmd": "node C:/repo/server.js" },
                    { "pid": 43, "ppid": 1, "name": "node.exe", "started": "time", "cmd": "node C:/other/server.js" },
                    { "pid": 40, "ppid": 1, "name": "esbuild.exe", "started": "time", "cmd": "C:/repo/esbuild" }
                ]
            }
        });
        let result = classify(&request);
        assert_eq!(result.as_array().unwrap().len(), 3);
        assert_eq!(result[0]["kind"], "tracked");
        assert_eq!(result[1]["kind"], "daemon");
        assert_eq!(result[2]["kind"], "daemon");
        assert_eq!(result[0]["session"], "wrapper-session");
    }
}
