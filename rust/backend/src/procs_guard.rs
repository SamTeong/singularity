use serde_json::{Value, json};

const BIN: &str = "powershell.exe";

fn args(pid: &Value, name: &str) -> Vec<String> {
    vec![
        "-NoProfile".to_owned(),
        "-NonInteractive".to_owned(),
        "-Command".to_owned(),
        format!(
            "[bool](Get-CimInstance Win32_Process -Filter \"ProcessId={pid} AND Name='{name}'\")"
        ),
    ]
}

fn trim_ecmascript_whitespace(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(
            character,
            '\u{0009}'
                | '\u{000A}'
                | '\u{000B}'
                | '\u{000C}'
                | '\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200A}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202F}'
                    | '\u{205F}'
                    | '\u{3000}'
                    | '\u{FEFF}'
        )
    })
}

pub fn kill_guarded(pid: &Value, name: &str, kind: &str, is_darwin: bool) -> Value {
    kill_guarded_with(
        pid,
        name,
        kind,
        is_darwin,
        || {
            let args = args(pid, name);
            (
                args.clone(),
                crate::oneshot::run(
                    Some(BIN),
                    &json!(args),
                    Some(0.0),
                    Some((8 * 1024 * 1024) as f64),
                    None,
                ),
            )
        },
        || crate::procs::kill(pid),
    )
}

fn kill_guarded_with<Q, K>(
    _pid: &Value,
    _name: &str,
    kind: &str,
    is_darwin: bool,
    mut query: Q,
    kill: K,
) -> Value
where
    Q: FnMut() -> (Vec<String>, Value),
    K: FnOnce() -> Value,
{
    if kind == "daemon" {
        return json!({"ok": false, "error": "daemon process — cannot stop from here"});
    }
    if !is_darwin {
        let (argv, result) = query();
        if result["ok"] != true {
            return json!({
                "oneshot_failure": result,
                "bin": BIN,
                "args": argv,
                "timeout_ms": 0
            });
        }
        if trim_ecmascript_whitespace(result["stdout"].as_str().unwrap_or_default()) != "True" {
            return json!({"ok": false, "error": "process changed before kill"});
        }
    }
    kill()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn success(stdout: &str) -> Value {
        json!({"ok": true, "stdout": stdout})
    }

    #[test]
    fn daemon_is_denied_before_query_and_kill() {
        let query_called = Cell::new(false);
        let kill_called = Cell::new(false);
        let result = kill_guarded_with(
            &json!(42),
            "claude.exe",
            "daemon",
            false,
            || {
                query_called.set(true);
                (vec![], success("True"))
            },
            || {
                kill_called.set(true);
                json!({"ok": true})
            },
        );
        assert_eq!(result["error"], "daemon process — cannot stop from here");
        assert!(!query_called.get());
        assert!(!kill_called.get());
    }

    #[test]
    fn query_uses_exact_windows_command_and_only_trimmed_true_kills() {
        let seen = Cell::new(false);
        let result = kill_guarded_with(
            &json!(4321),
            "claude.exe",
            "tracked",
            false,
            || {
                seen.set(true);
                let argv = args(&json!(4321), "claude.exe");
                assert_eq!(
                    argv,
                    [
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "[bool](Get-CimInstance Win32_Process -Filter \"ProcessId=4321 AND Name='claude.exe'\")"
                    ]
                );
                (argv, success("\r\n True \r\n"))
            },
            || json!({"ok": true}),
        );
        assert!(seen.get());
        assert_eq!(result["ok"], true);
        let bom_result = kill_guarded_with(
            &json!(4321),
            "claude.exe",
            "tracked",
            false,
            || (vec![], success("\u{FEFF}True\u{FEFF}")),
            || json!({"ok": true}),
        );
        assert_eq!(bom_result["ok"], true);
        for output in ["False", "", "true", "yes"] {
            let killed = Cell::new(false);
            let result = kill_guarded_with(
                &json!(4321),
                "claude.exe",
                "tracked",
                false,
                || (vec![], success(output)),
                || {
                    killed.set(true);
                    json!({"ok": true})
                },
            );
            assert_eq!(result["error"], "process changed before kill");
            assert!(!killed.get());
        }
        let nel_killed = Cell::new(false);
        let nel_result = kill_guarded_with(
            &json!(4321),
            "claude.exe",
            "tracked",
            false,
            || (vec![], success("\u{0085}True\u{0085}")),
            || {
                nel_killed.set(true);
                json!({"ok": true})
            },
        );
        assert_eq!(nel_result["error"], "process changed before kill");
        assert!(!nel_killed.get());
    }

    #[test]
    fn trim_predicate_matches_ecmascript_whitespace_boundaries() {
        const ECMASCRIPT_TRIM_CODEPOINTS: &[char] = &[
            '\u{0009}', '\u{000A}', '\u{000B}', '\u{000C}', '\u{000D}', '\u{0020}', '\u{00A0}',
            '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}',
            '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}', '\u{200A}', '\u{2028}', '\u{2029}',
            '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}',
        ];
        for character in ECMASCRIPT_TRIM_CODEPOINTS {
            let value = format!("{character}True{character}");
            assert_eq!(
                trim_ecmascript_whitespace(&value),
                "True",
                "U+{:04X}",
                *character as u32
            );
        }
        for codepoint in [
            0x0000, 0x0008, 0x000E, 0x001F, 0x0085, 0x180E, 0x200B, 0x2027, 0xFEFE, 0xFFFD,
        ] {
            let character = char::from_u32(codepoint).unwrap();
            let value = format!("{character}True{character}");
            assert_eq!(
                trim_ecmascript_whitespace(&value),
                value,
                "U+{codepoint:04X}"
            );
        }
    }

    #[test]
    fn query_failures_keep_the_raw_one_shot_envelope_for_node_formatting() {
        for failure in [
            json!({"ok": false, "error": "spawn failed", "stderr": "", "timed_out": false}),
            json!({"ok": false, "error": "exit 1", "stderr": "ignored\nlast error\n", "timed_out": false}),
            json!({"ok": false, "error": "timeout", "stderr": "", "timed_out": true}),
        ] {
            let result = kill_guarded_with(
                &json!(4321),
                "claude.exe",
                "stale",
                false,
                || (args(&json!(4321), "claude.exe"), failure.clone()),
                || panic!("query failure must not kill"),
            );
            assert_eq!(result["oneshot_failure"], failure);
            assert_eq!(result["timeout_ms"], 0);
            assert_eq!(result["bin"], BIN);
        }
    }

    #[test]
    fn darwin_skips_query_and_returns_kill_result() {
        let killed = Cell::new(false);
        let result = kill_guarded_with(
            &json!(7),
            "claude",
            "external",
            true,
            || panic!("Darwin must not query CIM"),
            || {
                killed.set(true);
                json!({"ok": false, "error": "kill ESRCH"})
            },
        );
        assert!(killed.get());
        assert_eq!(result["error"], "kill ESRCH");
    }
}
