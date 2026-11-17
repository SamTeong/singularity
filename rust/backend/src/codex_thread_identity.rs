use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const FILE_CAP: usize = 2000;
const HEAD_BYTES: usize = 256 * 1024;
const SPAWN_SKEW_MS: i64 = 5000;

pub fn find(codex_home: Option<&str>, cwd: Option<&str>, spawned_at: Option<i64>) -> Value {
    let (Some(home), Some(cwd), Some(spawned_at)) = (codex_home, cwd, spawned_at) else {
        return Value::Null;
    };
    if cwd.is_empty() || spawned_at == 0 {
        return Value::Null;
    }
    let Some(files) = rollout_files(home, FILE_CAP) else {
        return Value::Null;
    };
    let want_cwd = normalized_path(cwd);
    let threshold = spawned_at.saturating_sub(SPAWN_SKEW_MS);
    let mut best: Option<(i64, String)> = None;
    for path in files {
        if modified_ms(&path).is_none_or(|mtime| mtime < threshold) {
            continue;
        }
        let Some(meta) = first_line(&path) else {
            continue;
        };
        let Some(payload) = eligible_payload(&meta, &want_cwd) else {
            continue;
        };
        let Some(timestamp) = payload
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_ms)
        else {
            continue;
        };
        if timestamp < threshold {
            continue;
        }
        let id = payload
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| payload.get("id").and_then(Value::as_str))
            .unwrap_or("");
        if !id.is_empty()
            && best
                .as_ref()
                .is_none_or(|(best_ts, _)| timestamp > *best_ts)
        {
            best = Some((timestamp, id.to_owned()));
        }
    }
    best.map_or(Value::Null, |(_, id)| json!(id))
}

pub fn exists(codex_home: Option<&str>, cwd: Option<&str>, thread_id: Option<&str>) -> Value {
    let (Some(home), Some(cwd), Some(thread_id)) = (codex_home, cwd, thread_id) else {
        return json!(false);
    };
    if cwd.is_empty() || thread_id.is_empty() {
        return json!(false);
    }
    let Some(files) = rollout_files(home, FILE_CAP) else {
        return json!(false);
    };
    let want_cwd = normalized_path(cwd);
    let suffix = format!("-{thread_id}").to_lowercase();
    for path in files {
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !filename
            .strip_suffix(".jsonl")
            .unwrap_or(&filename)
            .ends_with(&suffix)
        {
            continue;
        }
        if first_line(&path)
            .and_then(|meta| eligible_payload(&meta, &want_cwd).map(|_| ()))
            .is_some()
        {
            return json!(true);
        }
    }
    json!(false)
}

fn rollout_files(home: &str, cap: usize) -> Option<Vec<PathBuf>> {
    fn walk(dir: &Path, files: &mut Vec<PathBuf>, cap: usize) {
        if files.len() >= cap {
            return;
        }
        let Ok(entries) = crate::fs_sorted::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if files.len() >= cap {
                return;
            }
            let path = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                if entry.file_name() != "archived_sessions" {
                    walk(&path, files, cap);
                }
            } else if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
            {
                files.push(path);
            }
        }
    }
    let sessions = Path::new(home).join("sessions");
    if !sessions.is_dir() {
        return None;
    }
    let mut files = Vec::new();
    walk(&sessions, &mut files, cap);
    Some(files)
}

fn first_line(path: &Path) -> Option<Value> {
    let mut file = File::open(path).ok()?;
    let mut bytes = vec![0; HEAD_BYTES];
    let count = file.read(&mut bytes).ok()?;
    bytes.truncate(count);
    let newline = bytes.iter().position(|byte| *byte == b'\n')?;
    serde_json::from_slice(&bytes[..newline]).ok()
}

fn eligible_payload<'a>(meta: &'a Value, cwd: &str) -> Option<&'a Value> {
    if meta.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = meta.get("payload")?;
    if payload.get("thread_source")?.as_str()? != "user" {
        return None;
    }
    let payload_cwd = payload.get("cwd")?.as_str()?;
    (normalized_path(payload_cwd) == cwd).then_some(payload)
}

fn normalized_path(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let path = Path::new(&normalized);
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::RootDir if cfg!(windows) && normalized.as_bytes().get(1) == Some(&b':') => {}
            Component::ParentDir => {
                parts.pop();
            }
            other => parts.push(other.as_os_str().to_string_lossy().into_owned()),
        }
    }
    let mut result = parts.join("/");
    if cfg!(windows) {
        result = result.to_lowercase();
    }
    result
}

fn modified_ms(path: &Path) -> Option<i64> {
    let duration = fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?;
    Some(duration.as_millis().min(i64::MAX as u128) as i64)
}

fn parse_timestamp_ms(raw: &str) -> Option<i64> {
    let parsed =
        time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339).ok()?;
    Some(parsed.unix_timestamp_nanos().div_euclid(1_000_000) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, SystemTime};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "codex-identity-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(dir.join("sessions")).unwrap();
            Self(dir)
        }
        fn rollout(&self, name: &str, meta: &Value) -> PathBuf {
            let path = self.0.join("sessions").join(name);
            fs::write(&path, format!("{}\n{{}}\n", meta)).unwrap();
            path
        }
        fn home(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn meta(id: &str, cwd: &str, timestamp: &str, source: &str) -> Value {
        json!({"type":"session_meta","payload":{"session_id":id,"cwd":cwd,"timestamp":timestamp,"thread_source":source}})
    }

    #[test]
    fn finds_latest_fresh_user_session_and_uses_id_fallback() {
        let fixture = Fixture::new();
        fixture.rollout(
            "rollout-stale.jsonl",
            &meta("stale", "/repo", "2024-12-31T23:59:00Z", "user"),
        );
        fixture.rollout(
            "rollout-other-cwd.jsonl",
            &meta("other-cwd", "/different", "2025-01-01T00:00:04Z", "user"),
        );
        fixture.rollout(
            "rollout-1-older.jsonl",
            &meta("older", "/repo", "2025-01-01T00:00:00Z", "user"),
        );
        fixture.rollout("rollout-2-newer.jsonl", &json!({"type":"session_meta","payload":{"id":"newer","cwd":"/repo","timestamp":"2025-01-01T00:00:03Z","thread_source":"user"}}));
        fixture.rollout(
            "rollout-3-subagent.jsonl",
            &meta("fork", "/repo", "2025-01-01T00:00:04Z", "subagent"),
        );
        assert_eq!(
            find(
                Some(fixture.home()),
                Some("/repo/./"),
                Some(1_735_689_600_000)
            ),
            json!("newer")
        );
    }

    #[test]
    fn excludes_archived_and_exists_does_not_apply_freshness() {
        let fixture = Fixture::new();
        let archived = fixture.0.join("sessions/archived_sessions");
        fs::create_dir_all(&archived).unwrap();
        fs::write(
            archived.join("rollout-old-thread.jsonl"),
            format!(
                "{}\n",
                meta("thread", "/repo", "2020-01-01T00:00:00Z", "user")
            ),
        )
        .unwrap();
        assert_eq!(
            exists(Some(fixture.home()), Some("/repo"), Some("thread")),
            json!(false)
        );
    }

    #[test]
    fn requires_bounded_first_line_and_missing_home_returns_empty() {
        let fixture = Fixture::new();
        let path = fixture.rollout(
            "rollout-bad.jsonl",
            &meta("bad", "/repo", "2025-01-01T00:00:00Z", "user"),
        );
        let oversized = format!(
            "{}{}\n",
            " ".repeat(HEAD_BYTES),
            meta("bad", "/repo", "2025-01-01T00:00:00Z", "user")
        );
        fs::write(path, oversized).unwrap();
        assert_eq!(
            find(Some(fixture.home()), Some("/repo"), Some(1_735_689_600_000)),
            Value::Null
        );
        assert_eq!(find(None, Some("/repo"), Some(1)), Value::Null);
        assert_eq!(exists(None, Some("/repo"), Some("id")), json!(false));
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_windows_separators_and_case() {
        assert_eq!(
            normalized_path(r"C:\Repo\src\..\project"),
            "c:/repo/project"
        );
    }

    #[test]
    fn uses_mtime_prefilter_and_five_second_start_tolerance() {
        let fixture = Fixture::new();
        let spawned_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let timestamp = time::OffsetDateTime::from_unix_timestamp_nanos(
            (spawned_at - 1000) as i128 * 1_000_000,
        )
        .unwrap()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
        let path = fixture.rollout(
            "rollout-stale.jsonl",
            &meta("stale", "/repo", &timestamp, "user"),
        );
        let old = SystemTime::now() - Duration::from_secs(60);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        assert_eq!(
            find(Some(fixture.home()), Some("/repo"), Some(spawned_at)),
            Value::Null
        );
    }
}
