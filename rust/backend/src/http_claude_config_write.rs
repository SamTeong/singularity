// Config editor write HTTP surface: `PUT /api/config/:scope`, mirroring
// `server/index.mjs:602-608` -> `config.mjs` `writeConfig` (122-154),
// `isKnownConfigRoot` (112-120), `scopePaths` (10-21), plus `backups.mjs`
// `backupFile` (57-78) and the Rust final guard `config_write::write_file`.
//
// The host injects the editor's home (tilde expansion only), the state dir that
// holds `config-roots.json`, the backups dir, the shared roots lock, Node's
// process cwd and its per-drive cwd values. No handler reads process env, the
// real home dir or the process cwd on its own.
//
// Parity contract, in Node's exact order:
//   * Body parsing is `http_body::parse_raw` (Fastify media types, 1 MiB cap,
//     Content-Length, BOM, FST_ERR_* envelopes). A non-object body has no
//     fields, because Node destructures it without throwing.
//   * `!cwd || content == null` -> 400 `cwd + content required`. Both tests use
//     JavaScript truthiness/nullishness, so `cwd: false`, `0` or `""` is
//     missing while `content: false` or `0` is present.
//   * Any scope other than `project`/`local` -> 400 `bad scope` (checked after
//     the required-fields gate, as in the route handler -> `writeConfig`).
//   * Truthy non-string `cwd` throws in `resolveRoot` (`p.startsWith`) -> 500
//     with Fastify's `p.startsWith is not a function` envelope. Falsy ones were
//     already rejected by the required-fields gate.
//   * Authorization is `config_editor_auth::is_known` over the pinned picker
//     roots in `<state_dir>/config-roots.json` (`picker_roots::get_roots`),
//     read under the injected shared lock; failure -> 400
//     `cwd outside config roots`.
//   * Target path: `scopePaths(cwd)[scope]` — `~`, `~/` and `~\` expand to the
//     injected home, then `path.join(base, '.claude', filename)` via
//     `config_editor_paths::join_config` (which also normalizes). `user` is not
//     an edit scope.
//   * `JSON.parse(content)` is reproduced by serde_json's raw-value scanner:
//     escaped lone surrogates, duplicate keys and `1e400` are accepted; a
//     leading BOM, NBSP/other non-JSON whitespace, trailing commas and comments
//     are rejected. A non-string `content` is parsed as `String(content)`.
//     Failure -> 400 `invalid JSON: <serde_json reason>` (serde wording is the
//     approved message). The scanner runs on the JavaScript string, so a lone
//     surrogate in `content` stays valid (surrogates are never JSON syntax).
//   * Stale guard before the backup, then a best-effort `backup_file` into the
//     injected backups dir, `create_dir_all` of the parent when the backup is
//     `None` (first write, or a failed backup), then the stale guard again.
//     A stale file is 409 `changed on disk`; an `existsSync`/`statSync` or
//     `mkdirSync` failure is the file's error text at 400.
//   * `mtime` uses `Number(mtime)` semantics for the outer subtraction (NaN
//     disables the guard) and `mtime == null ? null : Number(mtime)` for the
//     backend; non-finite/absent values arrive as `None`, disabling the Rust
//     guard too. `force` is JavaScript truthiness.
//   * Final write is `config_write::write_file` over the derived path. Any
//     `ok:false` other than `changed on disk` maps to 400 `config write
//     failed`; `changed on disk` stays 409; success is
//     `{"ok":true,"mtime":<js number>,"backup":<path|null>,"path":<path>}`
//     (result keys, then backup, then path).
//
// Parity limits, reported rather than approximated:
//   * Filesystem failure text is Rust's `io::Error` text, not Node's
//     `e.message` (same choice as the sibling write routes).
//   * A `cwd` containing an unpaired surrogate cannot be represented as a Rust
//     string, and the Node->Rust bridge could not carry such a path either.
//     This route answers 400 `config write backend unavailable` after
//     authorization and JSON validation; Node would first back up the
//     surrogate-named file, a side effect this route cannot reproduce without
//     bypassing `config_editor_paths`.
//   * A string `content` containing an unpaired surrogate cannot cross the
//     bridge: Node's inner catch reports 400 `config write backend
//     unavailable` after the backup. This route reproduces the response (and
//     the backup) without the bridge-teardown side effect.
//   * Backup hashing and `source.txt` use the Node-compatible UTF-8 spelling of
//     the derived path; the copy source and mtime checks use the same path as
//     an OS path. Relative and drive-relative results resolve against the
//     daemon's process cwd, exactly as Node's `fs` does (the injected
//     `process_cwd` is used only for authorization).
//   * Inherited `http_body` gaps apply (JSON responses without
//     `; charset=utf-8`).
use crate::http_body::{RawBody, parse_raw};
use crate::memory_backup::js_string_to_number;
use crate::transcripts::raw_json_string_at;
use axum::body::Body;
use axum::extract::{Path as RoutePath, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::put;
use axum::{Json, Router};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const REQUIRED: &str = "cwd + content required";
const BAD_SCOPE: &str = "bad scope";
const OUTSIDE: &str = "cwd outside config roots";
const CHANGED: &str = "changed on disk";
const WRITE_FAILED: &str = "config write failed";
const BACKEND_UNAVAILABLE: &str = "config write backend unavailable";
const INVALID_JSON_PREFIX: &str = "invalid JSON: ";
const CONFIG_ROOTS_FILE: &str = "config-roots.json";
const PROJECT_FILE: &str = "settings.json";
const LOCAL_FILE: &str = "settings.local.json";

#[derive(Clone)]
struct ConfigWrite {
    home: PathBuf,
    state_dir: PathBuf,
    backups_dir: PathBuf,
    // Shared with the config-roots routes so a pinned-root change cannot
    // interleave with the authorization read.
    lock: Arc<Mutex<()>>,
    // Node's process cwd and hidden per-drive cwds, used by `path.resolve`.
    process_cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
}

// VERIFY: claude-config-write-router-injection
pub fn router(
    home: PathBuf,
    state_dir: PathBuf,
    backups_dir: PathBuf,
    lock: Arc<Mutex<()>>,
    process_cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
) -> Router {
    Router::new()
        // VERIFY: wave3-hostreview-5
        // Deliberate deviation: axum ranks the static `/api/config/search` and
        // `/api/config/scan` routes above this parameter, so `PUT` on them is a
        // 404 where Fastify writes scope "search"/"scan". Failing closed is
        // safer than a nonsense write, so the quirk is not reproduced.
        .route("/api/config/{scope}", put(put_config))
        .with_state(ConfigWrite {
            home,
            state_dir,
            backups_dir,
            lock,
            process_cwd,
            drive_cwds,
        })
}

async fn put_config(
    State(state): State<ConfigWrite>,
    RoutePath(scope): RoutePath<String>,
    request: Request<Body>,
) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let fields = extract(body);
    match tokio::task::spawn_blocking(move || write(&state, &scope, fields)).await {
        Ok(response) => response,
        // Unreachable on this route; reported like the bridge's own failure.
        Err(_) => failure(BACKEND_UNAVAILABLE),
    }
}

// VERIFY: claude-config-write-body-fields
/// How JavaScript observes one body field. Only `Text` keeps the original
/// UTF-16 units; `Other` is any non-null, non-string JSON value.
enum Field {
    Absent,
    Null,
    Text(Vec<u16>),
    Other(Value),
}

struct WriteFields {
    cwd: Field,
    content: Field,
    mtime: Field,
    force: bool,
}

fn extract(body: RawBody) -> WriteFields {
    let object = body.value.as_object();
    let field = |name: &str| match object.and_then(|object| object.get(name)) {
        None => Field::Absent,
        Some(Value::Null) => Field::Null,
        Some(Value::String(text)) if !text.contains('\u{fffd}') => {
            Field::Text(text.encode_utf16().collect())
        }
        Some(Value::String(text)) => Field::Text(
            // Re-scan the raw token so escaped lone surrogates survive; the
            // parsed `Value` only carries U+FFFD for them.
            body.raw
                .as_deref()
                .and_then(|raw| raw_json_string_at(raw.get(), &[name]))
                .and_then(|text| text.units().ok())
                .unwrap_or_else(|| text.encode_utf16().collect()),
        ),
        Some(other) => Field::Other(other.clone()),
    };
    WriteFields {
        cwd: field("cwd"),
        content: field("content"),
        mtime: field("mtime"),
        force: object
            .and_then(|object| object.get("force"))
            .is_some_and(js_truthy),
    }
}

impl Field {
    fn is_null(&self) -> bool {
        matches!(self, Field::Absent | Field::Null)
    }

    fn truthy(&self) -> bool {
        match self {
            Field::Absent | Field::Null => false,
            Field::Text(units) => !units.is_empty(),
            Field::Other(value) => js_truthy(value),
        }
    }

    /// `Number(value)`; `NaN`/`Infinity` survive here and become `null` only at
    /// the bridge boundary.
    fn number(&self) -> f64 {
        match self {
            Field::Absent => f64::NAN,
            Field::Null => 0.0,
            Field::Text(units) => js_string_to_number(&String::from_utf16_lossy(units)),
            Field::Other(value) => js_value_number(value),
        }
    }
}

// VERIFY: claude-config-write-order
fn write(state: &ConfigWrite, scope: &str, fields: WriteFields) -> Response {
    write_with_backup(state, scope, fields, crate::memory_backup::backup_file)
}

fn write_with_backup(
    state: &ConfigWrite,
    scope: &str,
    fields: WriteFields,
    backup: impl FnOnce(&str, &Path, &Path) -> Option<PathBuf>,
) -> Response {
    if !fields.cwd.truthy() || fields.content.is_null() {
        return failure(REQUIRED);
    }
    if !matches!(scope, "project" | "local") {
        return failure(BAD_SCOPE);
    }
    let Field::Text(cwd_units) = &fields.cwd else {
        // `resolveRoot` calls `p.startsWith` on the truthy non-string cwd.
        return internal_error(&json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": "p.startsWith is not a function",
        }));
    };

    let authorized = {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        let roots = config_roots(&state.state_dir);
        crate::config_editor_auth::is_known(
            cwd_units,
            &roots,
            &state.home,
            &state.process_cwd,
            &state.drive_cwds,
        )
    };
    if !authorized {
        return failure(OUTSIDE);
    }

    // `JSON.parse(content)`, where a non-string is first coerced with
    // `String(content)`. Validity is checked before any filesystem side effect,
    // matching `writeConfig`'s inner try/catch placement.
    if let Err(error) = RawValue::from_string(content_js_string(&fields.content)) {
        return failure(&format!("{INVALID_JSON_PREFIX}{error}"));
    }

    let Ok(cwd) = String::from_utf16(cwd_units) else {
        return failure(BACKEND_UNAVAILABLE);
    };
    let path = config_path(&state.home, &cwd, scope);
    let target = PathBuf::from(&path);
    let mtime_present = !fields.mtime.is_null();
    let expected = fields.mtime.number();
    let force = fields.force;

    // Guard 1, before the backup: a stale save creates no backup.
    match stale(&target, mtime_present, expected, force) {
        Ok(true) => return changed(),
        Ok(false) => {}
        Err(error) => return failure(&error.to_string()),
    }
    // Best effort, exactly like `backupFile`: any failure yields `None`.
    let backup_path = backup(&path, &target, &state.backups_dir);
    if backup_path.is_none() {
        let parent = Path::new(&path)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        if let Err(error) = std::fs::create_dir_all(parent) {
            return failure(&error.to_string());
        }
    }
    // Guard 2, after the backup: covers a concurrent save landing in between.
    match stale(&target, mtime_present, expected, force) {
        Ok(true) => return changed(),
        Ok(false) => {}
        Err(error) => return failure(&error.to_string()),
    }

    let Field::Text(content_units) = &fields.content else {
        // The bridge forwards the raw non-string value; `config_write::write_file`
        // reports `content must be a string`, which Node maps to this 400.
        return failure(WRITE_FAILED);
    };
    let Ok(content) = String::from_utf16(content_units) else {
        // A lone surrogate cannot cross the Node->Rust bridge; Node's inner
        // catch reports the unavailable backend after the backup.
        return failure(BACKEND_UNAVAILABLE);
    };
    let backend_mtime = mtime_present
        .then_some(expected)
        .filter(|value| value.is_finite());
    let payload = crate::config_write::write_file(
        Some(path.as_str()),
        Some(content.as_str()),
        backend_mtime,
        force,
    );
    payload_response(payload, backup_path, path)
}

// VERIFY: claude-config-write-path
/// `scopePaths(cwd)[scope]`: expand a leading `~`, then Node's `path.join`.
fn config_path(home: &Path, cwd: &str, scope: &str) -> String {
    let filename = if scope == "project" {
        PROJECT_FILE
    } else {
        LOCAL_FILE
    };
    crate::config_editor_paths::join_config(
        &expand_tilde(cwd, home),
        ".claude",
        filename,
        cfg!(windows),
    )
}

/// `~`, `~/...` and `~\...` expand by appending the remainder to home, exactly
/// as `config.mjs` (its `path.normalize` is subsumed by the following join).
fn expand_tilde(cwd: &str, home: &Path) -> String {
    let expands = cwd == "~" || cwd.starts_with("~/") || cwd.starts_with("~\\");
    if !expands {
        return cwd.to_owned();
    }
    format!("{}{}", home.to_string_lossy(), &cwd[1..])
}

// VERIFY: claude-config-write-authorization-roots
/// The pinned picker roots as raw UTF-16 units. `picker_roots::get_roots`
/// already returns `["~"]` for a missing/invalid file; a scanner failure here
/// can only mean that fallback, so no roots authorize nothing extra.
fn config_roots(state_dir: &Path) -> Vec<Vec<u16>> {
    let text = crate::picker_roots::get_roots(&state_dir.join(CONFIG_ROOTS_FILE));
    let Ok(items) = serde_json::from_str::<Vec<Box<RawValue>>>(&text) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter(|item| item.get().starts_with('"'))
        .filter_map(|item| {
            crate::transcripts::TranscriptRawText::from_json_token(item.get().to_owned()).ok()
        })
        .filter_map(|text| text.units().ok())
        .collect()
}

/// `existsSync` + `statSync().mtimeMs` against the derived path, exactly like
/// Node: a missing path never blocks, and the tolerance is strictly `> 1` ms.
fn stale(path: &Path, present: bool, expected: f64, force: bool) -> std::io::Result<bool> {
    if !present || force || !path.exists() {
        return Ok(false);
    }
    let modified = std::fs::metadata(path)?.modified()?;
    Ok((system_time_ms(modified) - expected).abs() > 1.0)
}

fn system_time_ms(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    }
}

/// `JSON.parse`'s input: the string itself, or `String(value)` for a non-string.
fn content_js_string(field: &Field) -> String {
    match field {
        // Unreachable: the required-fields gate rejects both.
        Field::Absent | Field::Null => String::new(),
        Field::Text(units) => String::from_utf16_lossy(units),
        Field::Other(value) => js_string(value),
    }
}

// VERIFY: claude-config-write-status
/// Relay `config_write::write_file`'s payload the way Node does: success keeps
/// the ECMAScript number text for `mtime` and appends `backup` then `path`;
/// only the exact error `changed on disk` is a 409, everything else a 400.
fn payload_response(payload: Value, backup: Option<PathBuf>, path: String) -> Response {
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        let Some(mtime) = payload
            .get("mtime")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        else {
            return failure(WRITE_FAILED);
        };
        let mut buffer = ryu_js::Buffer::new();
        let Ok(mtime) = RawValue::from_string(buffer.format_finite(mtime).to_owned()) else {
            return failure(WRITE_FAILED);
        };
        return Json(WriteOk {
            ok: true,
            mtime: mtime.as_ref(),
            backup: backup.map(|path| path.to_string_lossy().into_owned()),
            path,
        })
        .into_response();
    }
    let error = payload
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or(WRITE_FAILED);
    if error == CHANGED {
        changed()
    } else {
        failure(WRITE_FAILED)
    }
}

#[derive(serde::Serialize)]
struct WriteOk<'a> {
    ok: bool,
    // `mtime` stays a JSON number; its text follows ECMAScript number rules.
    mtime: &'a RawValue,
    backup: Option<String>,
    path: String,
}

fn failure(error: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "error": error })),
    )
        .into_response()
}

fn changed() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "ok": false, "error": CHANGED })),
    )
        .into_response()
}

fn internal_error(payload: &Value) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(payload.clone())).into_response()
}

// VERIFY: claude-config-write-js-coercion
/// `String(value)` for the JSON values a body can hold. Arrays join their
/// elements with `,` (nested arrays flatten, `null` becomes empty); objects are
/// `[object Object]`.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_text(json_number(number)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JavaScript `Number(value)`.
fn js_value_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => json_number(number),
        Value::String(text) => js_string_to_number(text),
        // `Number(array)` is `Number(array.join(","))`.
        Value::Array(items) => {
            let joined = items.iter().map(js_string).collect::<Vec<_>>().join(",");
            js_string_to_number(&joined)
        }
        Value::Object(_) => f64::NAN,
    }
}

/// JavaScript truthiness: only `false`, `0`, `""`, `null`/`undefined` and `NaN`
/// are falsy; every array and object (even empty) is truthy.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => {
            let value = json_number(number);
            value != 0.0 && !value.is_nan()
        }
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn json_number(number: &serde_json::Number) -> f64 {
    number
        .as_f64()
        .unwrap_or_else(|| number.to_string().parse().unwrap_or(f64::NAN))
}

fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value.is_sign_positive() {
            "Infinity".to_owned()
        } else {
            "-Infinity".to_owned()
        };
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(value).to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        BACKEND_UNAVAILABLE, BAD_SCOPE, CHANGED, ConfigWrite, Field, OUTSIDE, REQUIRED, RoutePath,
        WRITE_FAILED, WriteFields, put_config, system_time_ms, write_with_backup,
    };
    use axum::body::{Body, to_bytes};
    use axum::extract::State;
    use axum::http::{Method, Request, header};
    use axum::response::Response;
    use serde_json::{Value, json};
    use std::fs::{self, File, FileTimes};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "http-claude-config-write-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn home(&self) -> PathBuf {
            self.0.join("home")
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        fn backups(&self) -> PathBuf {
            self.0.join("backups")
        }

        fn root(&self) -> PathBuf {
            let path = self.0.join("roots").join("project");
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn state(&self) -> ConfigWrite {
            ConfigWrite {
                home: self.home(),
                state_dir: self.state_dir(),
                backups_dir: self.backups(),
                lock: Arc::new(Mutex::new(())),
                process_cwd: self.0.clone(),
                drive_cwds: Vec::new(),
            }
        }

        /// Persist the picker roots exactly as `picker_roots::set_roots` does
        /// (a bare JSON array), then build the shared state.
        fn state_for(&self, roots: &[&str]) -> ConfigWrite {
            fs::create_dir_all(self.state_dir()).unwrap();
            fs::write(
                self.state_dir().join(super::CONFIG_ROOTS_FILE),
                serde_json::to_string(roots).unwrap(),
            )
            .unwrap();
            self.state()
        }

        fn put(&self, rel: &str, content: &str) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }

        fn mkdir(&self, rel: &str) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn text(path: &Path) -> String {
        path.to_str().unwrap().to_owned()
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn send_with(
        state: &ConfigWrite,
        scope: &str,
        content_type: Option<&str>,
        body: &str,
    ) -> (u16, String) {
        let mut builder = Request::builder()
            .method(Method::PUT)
            .uri(format!("/api/config/{scope}"));
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        let request = builder.body(Body::from(body.to_owned())).unwrap();
        let response = put_config(State(state.clone()), RoutePath(scope.to_owned()), request).await;
        collect(response).await
    }

    async fn send(state: &ConfigWrite, scope: &str, body: &str) -> (u16, String) {
        send_with(state, scope, Some("application/json"), body).await
    }

    async fn collect(response: Response) -> (u16, String) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn failure_body(error: &str) -> String {
        format!(r#"{{"ok":false,"error":"{error}"}}"#)
    }

    fn mtime_ms(path: &Path) -> f64 {
        system_time_ms(fs::metadata(path).unwrap().modified().unwrap())
    }

    fn set_mtime(path: &Path, time: SystemTime) {
        File::options()
            .write(true)
            .open(path)
            .and_then(|file| file.set_times(FileTimes::new().set_modified(time)))
            .unwrap();
    }

    fn backup_dirs(root: &Path) -> Vec<PathBuf> {
        match crate::fs_sorted::read_dir(root) {
            Ok(entries) => entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    fn bak_names(dir: &Path) -> Vec<String> {
        crate::fs_sorted::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.ends_with(".bak"))
            .collect()
    }

    #[test]
    fn required_fields_scope_and_authorization_follow_node_order() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let outside = text(&fixture.0.join("elsewhere"));
        let state = fixture.state_for(&[root_text.as_str()]);
        let valid_cwd = json!(root_text.as_str()).to_string();
        let valid_content = json!("{}").to_string();
        run(async {
            // Missing fields win over the scope check.
            assert_eq!(
                send(&state, "user", r#"{"content":"{}"}"#).await,
                (400, failure_body(REQUIRED))
            );
            assert_eq!(
                send(&state, "user", r#"{"cwd":"/x"}"#).await,
                (400, failure_body(REQUIRED))
            );
            assert_eq!(
                send(&state, "user", r#"{"cwd":"/x","content":null}"#).await,
                (400, failure_body(REQUIRED))
            );
            // Falsy cwd is missing, even when it is not a string.
            for body in [
                r#"{"cwd":"","content":"{}"}"#,
                r#"{"cwd":false,"content":"{}"}"#,
                r#"{"cwd":0,"content":"{}"}"#,
                r#"{"cwd":null,"content":"{}"}"#,
            ] {
                assert_eq!(
                    send(&state, "project", body).await,
                    (400, failure_body(REQUIRED)),
                    "{body}"
                );
            }
            // `content: false`/`0` are present and then fail the write.
            for body in [
                format!(r#"{{"cwd":{valid_cwd},"content":false}}"#),
                format!(r#"{{"cwd":{valid_cwd},"content":0}}"#),
            ] {
                assert_eq!(
                    send(&state, "project", &body).await,
                    (400, failure_body(WRITE_FAILED)),
                    "{body}"
                );
            }
            // Unknown scopes, including the non-editable `user` scope.
            for scope in ["user", "global", "Project", "project2"] {
                assert_eq!(
                    send(
                        &state,
                        scope,
                        &format!(r#"{{"cwd":{valid_cwd},"content":{valid_content}}}"#)
                    )
                    .await,
                    (400, failure_body(BAD_SCOPE)),
                    "{scope}"
                );
            }
            // Non-object bodies carry no fields.
            for body in ["[]", "null", "42", r#""text""#] {
                assert_eq!(
                    send(&state, "project", body).await,
                    (400, failure_body(REQUIRED)),
                    "{body}"
                );
            }
            assert_eq!(
                send_with(
                    &state,
                    "project",
                    Some("text/plain"),
                    r#"{"cwd":"/x","content":"{}"}"#
                )
                .await,
                (400, failure_body(REQUIRED))
            );
            // A cwd outside every pinned root.
            assert_eq!(
                send(
                    &state,
                    "project",
                    &json!({ "cwd": outside, "content": "{}" }).to_string()
                )
                .await,
                (400, failure_body(OUTSIDE))
            );
            // Truthy non-string cwd throws in `resolveRoot`.
            for body in [
                format!(r#"{{"cwd":true,"content":{valid_content}}}"#),
                format!(r#"{{"cwd":5,"content":{valid_content}}}"#),
                format!(r#"{{"cwd":[],"content":{valid_content}}}"#),
                format!(r#"{{"cwd":{{}},"content":{valid_content}}}"#),
            ] {
                let (status, response) = send(&state, "project", &body).await;
                assert_eq!(status, 500, "{body}");
                let payload: Value = serde_json::from_str(&response).unwrap();
                assert_eq!(payload["statusCode"], json!(500));
                assert_eq!(payload["error"], json!("Internal Server Error"));
                assert_eq!(payload["message"], json!("p.startsWith is not a function"));
            }
        });
    }

    #[test]
    fn writes_project_and_local_with_backup_and_result_key_order() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        let project = fixture.put("roots/project/.claude/settings.json", "old project");
        let local = fixture.put("roots/project/.claude/settings.local.json", "old local");
        let project_path = text(&root.join(".claude").join("settings.json"));
        let local_path = text(&root.join(".claude").join("settings.local.json"));
        run(async {
            let body = json!({
                "cwd": root_text.as_str(),
                "content": r#"{"a":1}"#,
                "mtime": mtime_ms(&project),
            })
            .to_string();
            let (status, response) = send(&state, "project", &body).await;
            assert_eq!(status, 200, "{response}");
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["ok"], json!(true));
            assert_eq!(payload["path"], json!(project_path));
            assert!(
                payload["mtime"]
                    .as_f64()
                    .is_some_and(|value| value > 0.0 && value.is_finite())
            );
            let backup = payload["backup"].as_str().expect("backup path").to_owned();
            assert_eq!(fs::read_to_string(&backup).unwrap(), "old project");
            // Key order: result keys, then backup, then path.
            let ok = response.find("\"ok\"").unwrap();
            let mtime = response.find("\"mtime\"").unwrap();
            assert!(response.find("\"backup\"").unwrap() > mtime);
            assert!(response.find("\"path\"").unwrap() > response.find("\"backup\"").unwrap());
            assert!(ok < mtime);

            let body = json!({
                "cwd": root_text.as_str(),
                "content": r#"{"b":2}"#,
                "mtime": mtime_ms(&local),
                "force": false,
            })
            .to_string();
            let (status, response) = send(&state, "local", &body).await;
            assert_eq!(status, 200, "{response}");
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["path"], json!(local_path));
            assert_eq!(
                fs::read_to_string(payload["backup"].as_str().unwrap()).unwrap(),
                "old local"
            );
        });
        assert_eq!(fs::read_to_string(&project).unwrap(), r#"{"a":1}"#);
        assert_eq!(fs::read_to_string(&local).unwrap(), r#"{"b":2}"#);
    }

    #[test]
    fn first_write_creates_the_claude_directory_with_a_null_backup() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        let target = root.join(".claude").join("settings.json");
        let target_text = text(&target);
        run(async {
            let body =
                json!({ "cwd": root_text.as_str(), "content": r#"{"theme":"dark"}"# }).to_string();
            let (status, response) = send(&state, "project", &body).await;
            assert_eq!(status, 200, "{response}");
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["backup"], Value::Null);
            assert_eq!(payload["path"], json!(target_text));
            assert!(response.contains(r#""backup":null"#), "{response}");
        });
        assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"theme":"dark"}"#);
        assert!(backup_dirs(&fixture.backups()).is_empty());
    }

    #[test]
    fn a_stale_mtime_returns_409_before_any_backup() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        let file = fixture.put("roots/project/.claude/settings.json", "old");
        let body = json!({
            "cwd": root_text.as_str(),
            "content": "{}",
            "mtime": mtime_ms(&file) + 10_000.0,
        })
        .to_string();
        run(async {
            assert_eq!(
                send(&state, "project", &body).await,
                (409, failure_body(CHANGED))
            );
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
        assert!(backup_dirs(&fixture.backups()).is_empty());
    }

    #[test]
    fn force_skips_both_stale_guards() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        let file = fixture.put("roots/project/.claude/settings.json", "old");
        let stale = mtime_ms(&file) + 10_000.0;
        let body = |force: Value| {
            json!({
                "cwd": root_text.as_str(),
                "content": "{}",
                "mtime": stale,
                "force": force,
            })
            .to_string()
        };
        run(async {
            assert_eq!(send(&state, "project", &body(json!(false))).await.0, 409);
            assert_eq!(send(&state, "project", &body(json!(0))).await.0, 409);
            // A non-empty string and an array are truthy in JavaScript.
            assert_eq!(send(&state, "project", &body(json!("false"))).await.0, 200);
            assert_eq!(send(&state, "project", &body(json!([]))).await.0, 200);
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
        assert_eq!(backup_dirs(&fixture.backups()).len(), 1);
    }

    #[test]
    fn the_post_backup_guard_rejects_a_newer_file() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let file = fixture.put("roots/project/.claude/settings.json", "old");
        let old = SystemTime::now() - Duration::from_secs(120);
        set_mtime(&file, old);
        let state = fixture.state_for(&[&text(&root)]);
        let fields = WriteFields {
            cwd: Field::Text(text(&root).encode_utf16().collect()),
            content: Field::Text("{}".encode_utf16().collect()),
            mtime: Field::Other(json!(mtime_ms(&file))),
            force: false,
        };
        let response = write_with_backup(&state, "project", fields, |_, target, _| {
            set_mtime(target, old + Duration::from_secs(60));
            None
        });
        assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
    }

    #[test]
    fn backups_are_pruned_to_the_five_newest() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        run(async {
            for index in 0..7 {
                let body = json!({
                    "cwd": root_text.as_str(),
                    "content": format!("{{\"n\":{index}}}"),
                })
                .to_string();
                let (status, response) = send(&state, "project", &body).await;
                assert_eq!(status, 200, "{response}");
            }
        });
        let dirs = backup_dirs(&fixture.backups());
        assert_eq!(dirs.len(), 1);
        assert_eq!(bak_names(&dirs[0]).len(), 5);
    }

    #[test]
    fn json_parse_validity_matches_the_edge_corpus() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        let accepted = [
            "{}",
            "[]",
            "null",
            "true",
            "42",
            "-0",
            "1e400",
            r#""\ud800""#,
            r#"{"a":1,"a":2}"#,
            " \t\r\n{}\r\n\t ",
            r#"{"a":"\ud800"}"#,
        ];
        let rejected = [
            "",
            " ",
            "\u{feff}{}",
            "\u{00a0}{}",
            "\u{000b}{}",
            "\u{000c}{}",
            "\u{2028}{}",
            r#"{"a":1,}"#,
            "{} trailing",
            "// comment\n{}",
            "/* comment */ {}",
            "undefined",
            "NaN",
            "{'a':1}",
        ];
        run(async {
            for content in accepted {
                let body = json!({ "cwd": root_text.as_str(), "content": content }).to_string();
                let (status, response) = send(&state, "project", &body).await;
                assert_eq!(status, 200, "{content:?} -> {response}");
            }
            for content in rejected {
                let body = json!({ "cwd": root_text.as_str(), "content": content }).to_string();
                let (status, response) = send(&state, "project", &body).await;
                assert_eq!(status, 400, "{content:?} -> {response}");
                let payload: Value = serde_json::from_str(&response).unwrap();
                let error = payload["error"].as_str().unwrap();
                assert!(
                    error.starts_with("invalid JSON: "),
                    "{content:?} -> {error}"
                );
                assert!(error.len() > "invalid JSON: ".len(), "{content:?}");
            }
        });
    }

    #[test]
    fn non_string_content_is_parsed_as_string_content_then_rejected_by_the_write() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        let file = fixture.put("roots/project/.claude/settings.json", "kept");
        let body =
            |content: Value| json!({ "cwd": root_text.as_str(), "content": content }).to_string();
        run(async {
            // `String(content)` is valid JSON for these, so `JSON.parse` passes
            // and the bridge's own `content must be a string` maps to 400.
            for content in [json!(5), json!(true), json!([1]), json!(["{}"])] {
                assert_eq!(
                    send(&state, "project", &body(content.clone())).await,
                    (400, failure_body(WRITE_FAILED)),
                    "{content}"
                );
            }
            // These coerce to text that is not JSON.
            for content in [
                json!({}),
                json!([]),
                json!([[]]),
                json!([null]),
                json!([1, 2]),
                json!({"a": 1}),
            ] {
                let (status, response) = send(&state, "project", &body(content.clone())).await;
                assert_eq!(status, 400, "{content} -> {response}");
                let error = serde_json::from_str::<Value>(&response).unwrap()["error"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                assert!(error.starts_with("invalid JSON: "), "{content} -> {error}");
            }
            // `1e400` in the body is `Infinity`, whose `String` is not JSON.
            let overflow = format!(
                r#"{{"cwd":{},"content":1e400}}"#,
                json!(root_text.as_str()).to_string()
            );
            let (status, response) = send(&state, "project", &overflow).await;
            assert_eq!(status, 400, "{response}");
            assert!(
                serde_json::from_str::<Value>(&response).unwrap()["error"]
                    .as_str()
                    .unwrap()
                    .starts_with("invalid JSON: ")
            );
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "kept");
        // Every accepted-JSON non-string save still backed up the old file.
        let dirs = backup_dirs(&fixture.backups());
        assert_eq!(dirs.len(), 1);
        assert_eq!(bak_names(&dirs[0]).len(), 4);
    }

    #[test]
    fn mtime_uses_javascript_number_semantics() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        let file = fixture.put("roots/project/.claude/settings.json", "old");
        let body = |mtime: Value| {
            json!({
                "cwd": root_text.as_str(),
                "content": "{}",
                "mtime": mtime,
            })
            .to_string()
        };
        run(async {
            // Numeric strings and coercible values take part in the guard.
            let overflow: Value = serde_json::from_str("1e400").unwrap();
            for stale in [json!("0"), json!([]), json!(true), json!([0]), overflow] {
                assert_eq!(
                    send(&state, "project", &body(stale.clone())).await.0,
                    409,
                    "{stale}"
                );
            }
            // NaN (or an object) disables the guard, and `null` is absent.
            for absent in [json!("abc"), json!({}), Value::Null] {
                let (status, response) = send(&state, "project", &body(absent.clone())).await;
                assert_eq!(status, 200, "{absent} -> {response}");
            }
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
        assert_eq!(backup_dirs(&fixture.backups()).len(), 1);
    }

    #[test]
    fn surrogate_content_reports_the_unavailable_backend_after_a_backup() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        let file = fixture.put("roots/project/.claude/settings.json", "kept");
        // A JSON document that is a string holding a literal lone surrogate.
        let body = format!(
            r#"{{"cwd":{},"content":"\"\ud800\""}}"#,
            json!(root_text.as_str()).to_string()
        );
        run(async {
            assert_eq!(
                send(&state, "project", &body).await,
                (400, failure_body(BACKEND_UNAVAILABLE))
            );
            // A surrogate next to JSON syntax simply makes the content invalid.
            let invalid = format!(
                r#"{{"cwd":{},"content":"\ud800{{"}}"#,
                json!(root_text.as_str()).to_string()
            );
            let (status, response) = send(&state, "project", &invalid).await;
            assert_eq!(status, 400, "{response}");
            assert!(
                serde_json::from_str::<Value>(&response).unwrap()["error"]
                    .as_str()
                    .unwrap()
                    .starts_with("invalid JSON: ")
            );
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "kept");
        let dirs = backup_dirs(&fixture.backups());
        assert_eq!(dirs.len(), 1);
        assert_eq!(
            fs::read_to_string(dirs[0].join("source.txt")).unwrap(),
            text(&root.join(".claude").join("settings.json"))
        );
    }

    #[test]
    fn a_directory_target_fails_the_final_write_after_a_backup_attempt() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        let target = fixture.mkdir("roots/project/.claude/settings.json");
        let body = json!({ "cwd": root_text.as_str(), "content": "{}" }).to_string();
        run(async {
            assert_eq!(
                send(&state, "project", &body).await,
                (400, failure_body(WRITE_FAILED))
            );
        });
        assert!(target.is_dir());
    }

    #[test]
    fn the_default_root_list_authorizes_the_home_directory() {
        let fixture = Fixture::new();
        let project = fixture.mkdir("home/project");
        // No config-roots.json: `picker_roots::get_roots` falls back to `["~"]`.
        let state = fixture.state();
        let body = json!({ "cwd": text(&project), "content": "{}" }).to_string();
        run(async {
            let (status, response) = send(&state, "project", &body).await;
            assert_eq!(status, 200, "{response}");
        });
        assert!(project.join(".claude").join("settings.json").exists());
    }

    #[test]
    fn duplicate_body_keys_use_the_last_member() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let root_text = text(&root);
        let state = fixture.state_for(&[root_text.as_str()]);
        let outside = text(&fixture.0.join("elsewhere"));
        let accepted = format!(
            r#"{{"cwd":{},"cwd":{},"content":"bad","content":"{{}}"}}"#,
            json!(outside.as_str()),
            json!(root_text.as_str())
        );
        let rejected = format!(
            r#"{{"cwd":{},"cwd":{},"content":"{{}}"}}"#,
            json!(root_text.as_str()),
            json!(outside.as_str())
        );
        run(async {
            assert_eq!(send(&state, "project", &accepted).await.0, 200);
            assert_eq!(
                send(&state, "project", &rejected).await,
                (400, failure_body(OUTSIDE))
            );
        });
    }

    #[test]
    fn payload_mapping_keeps_only_changed_on_disk_as_409() {
        let fixture = Fixture::new();
        let state = fixture.state_for(&["~"]);
        let changed = super::payload_response(
            json!({ "ok": false, "error": "changed on disk" }),
            None,
            "/x".to_owned(),
        );
        assert_eq!(changed.status(), axum::http::StatusCode::CONFLICT);
        let failed = super::payload_response(
            json!({ "ok": false, "error": "disk full" }),
            None,
            "/x".to_owned(),
        );
        assert_eq!(failed.status(), axum::http::StatusCode::BAD_REQUEST);
        let _ = state;
    }

    #[test]
    fn router_builds_with_the_injected_state() {
        let fixture = Fixture::new();
        let _router = super::router(
            fixture.home(),
            fixture.state_dir(),
            fixture.backups(),
            Arc::new(Mutex::new(())),
            fixture.0.clone(),
            Vec::new(),
        );
    }
}
