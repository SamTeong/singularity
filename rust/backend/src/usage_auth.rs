use serde_json::{Value, json};
use std::process::{Command, Stdio};

fn credential_fields(stdout: &[u8]) -> Option<Value> {
    let envelope: Value = serde_json::from_slice(stdout).ok()?;
    let oauth = envelope.get("claudeAiOauth")?.as_object()?;
    let mut selected = serde_json::Map::new();
    for key in [
        "accessToken",
        "refreshToken",
        "expiresAt",
        "subscriptionType",
    ] {
        if let Some(value) = oauth.get(key) {
            selected.insert(key.to_owned(), value.clone());
        }
    }
    Some(Value::Object(selected))
}

fn keychain_with_args(
    platform: Option<&str>,
    bin: Option<&str>,
    args: &[&str],
    env: &Value,
) -> Value {
    if platform != Some("darwin") {
        return json!({ "ok": false });
    }
    let Some(bin) = bin else {
        return json!({ "ok": false });
    };
    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    if let Some(entries) = env.as_object() {
        for (key, value) in entries {
            if let Some(value) = value.as_str() {
                command.env(key, value);
            }
        }
    }
    let output = command.output();
    let Ok(output) = output else {
        return json!({ "ok": false });
    };
    if !output.status.success() {
        return json!({ "ok": false });
    }
    match credential_fields(&output.stdout) {
        Some(oauth) => json!({ "ok": true, "oauth": oauth }),
        None => json!({ "ok": false }),
    }
}

pub fn keychain(platform: Option<&str>, bin: Option<&str>, env: &Value) -> Value {
    keychain_with_args(
        platform,
        bin,
        &[
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ],
        env,
    )
}

pub fn auth_status(bin: Option<&str>, timeout_ms: f64, env: &Value) -> Value {
    let _ = auth_status_with_args(bin, &json!(["auth", "status"]), timeout_ms, env);
    json!({ "attempted": true })
}

fn auth_status_with_args(bin: Option<&str>, args: &Value, timeout_ms: f64, env: &Value) -> Value {
    super::oneshot::run(bin, args, Some(timeout_ms), None, Some(env))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_darwin_never_invokes_keychain_command() {
        assert_eq!(
            keychain(Some("windows"), Some("missing"), &json!({})),
            json!({ "ok": false })
        );
    }

    #[test]
    fn keychain_returns_only_required_synthetic_credential_fields() {
        let result = credential_fields(
            br#"{"claudeAiOauth":{"accessToken":"synthetic-access","refreshToken":"synthetic-refresh","expiresAt":123,"subscriptionType":"pro","ignored":"extra"}}"#,
        ).unwrap();
        assert_eq!(result["accessToken"], "synthetic-access");
        assert_eq!(result["refreshToken"], "synthetic-refresh");
        assert!(result.get("ignored").is_none());
    }

    #[test]
    fn keychain_process_and_json_failures_are_quiet_nulls() {
        assert_eq!(
            keychain(
                Some("darwin"),
                Some("missing-usage-auth-command"),
                &json!({})
            )["ok"],
            false
        );
        #[cfg(windows)]
        let (bin, args) = ("cmd", vec!["/C", "echo not-json"]);
        #[cfg(not(windows))]
        let (bin, args) = ("sh", vec!["-c", "printf not-json"]);
        assert_eq!(
            keychain_with_args(Some("darwin"), Some(bin), &args, &json!({}))["ok"],
            false
        );
        #[cfg(windows)]
        let (bin, args) = ("cmd", vec!["/C", "exit 0"]);
        #[cfg(not(windows))]
        let (bin, args) = ("sh", vec!["-c", "true"]);
        assert_eq!(
            keychain_with_args(Some("darwin"), Some(bin), &args, &json!({}))["ok"],
            false
        );
        #[cfg(windows)]
        let (bin, args) = ("cmd", vec!["/C", "exit 2"]);
        #[cfg(not(windows))]
        let (bin, args) = ("sh", vec!["-c", "exit 2"]);
        assert_eq!(
            keychain_with_args(Some("darwin"), Some(bin), &args, &json!({}))["ok"],
            false
        );
    }

    fn synthetic_child(stdout: &str, stderr: &str, exit_code: i32) -> (String, Vec<String>) {
        #[cfg(windows)]
        {
            let command = format!(
                "[Console]::Out.Write('{}'); [Console]::Error.Write('{}'); exit {}",
                stdout, stderr, exit_code
            );
            (
                "powershell.exe".to_owned(),
                vec!["-NoProfile".into(), "-Command".into(), command],
            )
        }
        #[cfg(not(windows))]
        {
            let command = format!(
                "printf '%s' '{}' ; printf '%s' '{}' >&2; exit {}",
                stdout, stderr, exit_code
            );
            ("sh".to_owned(), vec!["-c".into(), command])
        }
    }

    #[test]
    fn synthetic_child_success_returns_only_the_private_oauth_projection() {
        let access = "synthetic-access-secret";
        let refresh = "synthetic-refresh-secret";
        let stdout = format!(
            r#"{{"claudeAiOauth":{{"accessToken":"{access}","refreshToken":"{refresh}","expiresAt":123,"subscriptionType":"pro","ignored":"synthetic-extra-secret"}}}}"#
        );
        let (bin, args) = synthetic_child(&stdout, "synthetic-stderr-secret", 0);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let response = keychain_with_args(Some("darwin"), Some(&bin), &args, &json!({}));
        assert_eq!(
            response,
            json!({"ok": true, "oauth": {
                "accessToken": access,
                "refreshToken": refresh,
                "expiresAt": 123,
                "subscriptionType": "pro"
            }})
        );
        let serialized = response.to_string();
        assert!(serialized.contains(access));
        assert!(serialized.contains(refresh));
        assert!(!serialized.contains("synthetic-stderr-secret"));
        assert!(!serialized.contains("synthetic-extra-secret"));
    }

    #[test]
    fn keychain_child_receives_request_environment_without_exposing_it() {
        let marker = "synthetic-auth-env-marker";
        #[cfg(windows)]
        let (bin, args) = (
            "powershell.exe".to_owned(),
            vec![
                "-NoProfile".into(),
                "-Command".into(),
                "if ($env:SINGULARITY_TEST_AUTH_ENV -eq 'synthetic-auth-env-marker') { [Console]::Out.Write('{\"claudeAiOauth\":{\"accessToken\":\"synthetic-access\"}}') } else { exit 2 }".into(),
            ],
        );
        #[cfg(not(windows))]
        let (bin, args) = (
            "sh".to_owned(),
            vec![
                "-c".into(),
                "[ \"$SINGULARITY_TEST_AUTH_ENV\" = 'synthetic-auth-env-marker' ] && printf '{\"claudeAiOauth\":{\"accessToken\":\"synthetic-access\"}}' || exit 2".into(),
            ],
        );
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let response = keychain_with_args(
            Some("darwin"),
            Some(&bin),
            &args,
            &json!({ "SINGULARITY_TEST_AUTH_ENV": marker }),
        );
        assert_eq!(
            response,
            json!({ "ok": true, "oauth": { "accessToken": "synthetic-access" } })
        );
        assert!(!response.to_string().contains(marker));
    }

    #[test]
    fn auth_status_child_receives_request_environment_without_exposing_it() {
        let marker = "synthetic-auth-status-env-marker";
        #[cfg(windows)]
        let (bin, args) = (
            "powershell.exe",
            json!([
                "-NoProfile",
                "-Command",
                "[Console]::Out.Write($env:SINGULARITY_TEST_AUTH_ENV)"
            ]),
        );
        #[cfg(not(windows))]
        let (bin, args) = (
            "sh",
            json!(["-c", "printf '%s' \"$SINGULARITY_TEST_AUTH_ENV\""]),
        );
        let result = auth_status_with_args(
            Some(bin),
            &args,
            10_000.0,
            &json!({ "SINGULARITY_TEST_AUTH_ENV": marker }),
        );
        assert_eq!(result["stdout"], marker);
        assert_eq!(
            auth_status(
                Some(bin),
                10_000.0,
                &json!({ "SINGULARITY_TEST_AUTH_ENV": marker })
            ),
            json!({ "attempted": true })
        );
    }

    #[test]
    fn synthetic_child_failure_discards_token_bearing_stdout_and_stderr() {
        let access = "failure-access-secret";
        let refresh = "failure-refresh-secret";
        let stdout = format!(r#"{{"accessToken":"{access}","refreshToken":"{refresh}"}}"#);
        let stderr = format!("child diagnostic {access} {refresh}");
        let (bin, args) = synthetic_child(&stdout, &stderr, 7);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let response = keychain_with_args(Some("darwin"), Some(&bin), &args, &json!({}));
        assert_eq!(response, json!({"ok": false}));
        let serialized = response.to_string();
        assert!(!serialized.contains(access));
        assert!(!serialized.contains(refresh));
    }

    #[test]
    fn auth_status_reports_attempt_even_when_spawn_fails() {
        assert_eq!(
            auth_status(Some("missing-usage-auth-command"), 10_000.0, &json!({}))["attempted"],
            true
        );
        assert_eq!(auth_status(None, 10_000.0, &json!({}))["attempted"], true);
        #[cfg(windows)]
        let failing_bin = "cmd";
        #[cfg(not(windows))]
        let failing_bin = "false";
        assert_eq!(
            auth_status(Some(failing_bin), 10_000.0, &json!({}))["attempted"],
            true
        );
    }
}
