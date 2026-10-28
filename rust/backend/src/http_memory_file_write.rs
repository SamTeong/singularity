// Memory file write HTTP surface: `PUT /api/memory/file`, mirroring
// `server/index.mjs:761` -> `memory.mjs` `createMemoryWriteHandler` (90-98) and
// `writeMemoryFile` (69-88), plus `backups.mjs` `backupFile` (57-78) and the Rust
// final check `memory::write_file`.
//
// Staged: `http_server::router` does not mount this module. The host injects the
// state dir (SINGULARITY_HOME/state), a
// resolved home, Node's cwd and per-drive cwd values, and the backups dir
// (`<home>/cache/backups`); this module reads no process env and no user data on
// its own. The injected `cwd` must be the daemon's process cwd: authorization
// resolves against it, while the filesystem/backup operations use the original
// raw path, which Node's `fs` resolves against the process cwd.
//
// Parity contract:
//   * Body parsing is `http_body::parse_raw` (Fastify media types, 1 MiB cap,
//     Content-Length, BOM, FST_ERR_* envelopes). A non-object body has no
//     fields, because Node destructures it without throwing.
//   * `path == null || content == null` -> 400 `path + content required`.
//   * `isMemoryPath` runs on the exact UTF-16 request path and root; the
//     persisted `memory-root.json` root must match, containment is lexical, and
//     the shape is `<root>/<project>/memory/<name>.md` (case-insensitive on
//     `memory`/`.md`, nested subdirectories allowed).
//   * Order: pre-backup mtime guard -> best-effort backup -> post-backup guard
//     -> final backend check. Only the exact error `changed on disk` maps to
//     409; every other failure maps to 400.
//   * `mtime` is `Number(mtime)` with JavaScript number semantics (NaN/Infinity
//     serialize to JSON `null`, disabling the backend guard); `force` is JS truthiness.
//   * The final check is `memory::write_file`: it never creates parent
//     directories and can answer `ok:false` after the bytes were written.
//
// Parity limits, reported rather than approximated:
//   * Filesystem failure text is Rust's `io::Error` text, not Node's
//     `e.message` (same choice as the root and read routes).
//   * A lone surrogate in `path`/`content` cannot cross the Node->Rust bridge:
//     serde_json rejects the escaped token, the uncorrelated reply tears the
//     bridge down, and `writeMemoryFile`'s inner catch reports 400
//     `memory write backend unavailable` after the backup. This route returns
//     that same 400 body and never substitutes U+FFFD into the file; it cannot
//     and must not reproduce the bridge teardown side effect.
//   * Backup hashing and `source.txt` use the Node-compatible lossy UTF-8 spelling;
//     the copy source and mtime checks use the exact filesystem path.
//   * Inherited `http_body` gaps apply (JSON responses without
//     `; charset=utf-8`).
use crate::http_body::{RawBody, parse_raw};
use crate::transcripts::raw_json_string_at;
use crate::wiki_root::resolve_units;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::put;
use axum::{Json, Router};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const OUTSIDE: &str = "path outside memory dirs";
const REQUIRED: &str = "path + content required";
const CHANGED: &str = "changed on disk";
const BACKEND_UNAVAILABLE: &str = "memory write backend unavailable";

#[derive(Clone)]
struct MemoryFileWrite {
    state_dir: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    // Windows only: Node's hidden per-drive cwd values (`=C:`), used by
    // `path.resolve` for drive-relative targets and roots.
    drive_cwds: Vec<(u16, PathBuf)>,
    backups_dir: PathBuf,
    // Shared with root changes and reads, including authorization and backup.
    lock: Arc<Mutex<()>>,
}

// VERIFY: memory-file-write-router-injection
pub fn router(
    state_dir: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
    backups_dir: PathBuf,
    lock: Arc<Mutex<()>>,
) -> Router {
    Router::new()
        .route("/api/memory/file", put(put_file))
        .with_state(MemoryFileWrite {
            state_dir,
            home,
            cwd,
            drive_cwds,
            backups_dir,
            lock,
        })
}

async fn put_file(State(state): State<MemoryFileWrite>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let fields = extract(body);
    match tokio::task::spawn_blocking(move || write(&state, fields)).await {
        Ok(response) => response,
        // Node's inner `catch` reports an unavailable write backend as 400.
        Err(_) => failure(BACKEND_UNAVAILABLE),
    }
}

// VERIFY: memory-file-write-body-fields
/// How JavaScript observes one body field. Only `Text` keeps the original
/// UTF-16 units; `Other` is any non-null, non-string JSON value.
enum Field {
    Absent,
    Null,
    Text(Vec<u16>),
    Other(Value),
}

impl Field {
    fn is_null(&self) -> bool {
        matches!(self, Field::Absent | Field::Null)
    }

    /// JavaScript `Number(value)`; `NaN`/`Infinity` are preserved here and only
    /// become `null` at the bridge boundary (`backend_number`).
    fn number(&self) -> f64 {
        match self {
            Field::Absent => f64::NAN,
            Field::Null => 0.0,
            Field::Text(units) => js_string_to_number(&String::from_utf16_lossy(units)),
            Field::Other(value) => js_value_number(value),
        }
    }

    /// `JSON.stringify(Number(value))`: non-finite numbers become `null`.
    fn backend_number(&self) -> Option<f64> {
        (!self.is_null())
            .then(|| self.number())
            .filter(|value| value.is_finite())
    }
}

struct WriteFields {
    path: Field,
    content: Field,
    root: Field,
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
        path: field("path"),
        content: field("content"),
        root: field("root"),
        mtime: field("mtime"),
        force: object
            .and_then(|object| object.get("force"))
            .is_some_and(js_truthy),
    }
}

// VERIFY: memory-file-write-authorization
/// `isMemoryPath(path, root)`: resolve the target against the injected cwd, fall
/// back to the persisted root for a falsy supplied root, then compare exact
/// UTF-16 units. The caller handles truthy non-string roots as Node errors.
fn authorized(state: &MemoryFileWrite, path: &[u16], root: &Field) -> bool {
    let windows = cfg!(windows);
    let supplied = match root {
        Field::Text(units) if !units.is_empty() => resolve_units(
            units,
            &state.home,
            &state.cwd,
            &state.drive_cwds,
            windows,
            true,
        ),
        Field::Text(_) | Field::Absent | Field::Null => Vec::new(),
        Field::Other(value) if js_truthy(value) => return false,
        Field::Other(_) => Vec::new(),
    };
    let persisted = crate::memory_root::get_root(&state.state_dir);
    let Ok(persisted_units) = persisted.units() else {
        return false;
    };
    let persisted_root = resolve_units(
        &persisted_units,
        &state.home,
        &state.cwd,
        &state.drive_cwds,
        windows,
        true,
    );
    let target = resolve_units(
        path,
        &state.home,
        &state.cwd,
        &state.drive_cwds,
        windows,
        false,
    );
    crate::memory_auth::is_memory_path(&target, &supplied, &persisted_root, windows)
}

// VERIFY: memory-file-write-order
fn write(state: &MemoryFileWrite, fields: WriteFields) -> Response {
    if fields.path.is_null() || fields.content.is_null() {
        return required();
    }
    let Field::Text(path_units) = &fields.path else {
        return match &fields.path {
            Field::Other(value) if js_truthy(value) => invalid_path_type(value),
            _ => outside(),
        };
    };
    if let Field::Other(value) = &fields.root {
        if !path_units.is_empty() && js_truthy(value) {
            return invalid_root_type();
        }
    }
    let guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    if path_units.is_empty() || !authorized(state, path_units, &fields.root) {
        return outside();
    }

    // The raw path is what Node hands to `fs` and to the bridge; only the
    // guarded existence/mtime checks use the platform-exact spelling.
    let target = os_path(path_units);
    let backup_path = String::from_utf16_lossy(path_units);
    let path_text = String::from_utf16(path_units).ok();
    let content_text = match &fields.content {
        Field::Text(units) => String::from_utf16(units).ok(),
        _ => None,
    };
    let content_invalid = matches!(&fields.content, Field::Text(_)) && content_text.is_none();
    let mtime_present = !fields.mtime.is_null();
    let mtime_number = fields.mtime.number();
    let backend_mtime = fields.mtime.backend_number();
    let force = fields.force;

    // Guard 1, before the backup: a stale save creates no backup.
    match stale(&target, mtime_present, mtime_number, force) {
        Ok(true) => return changed(),
        Ok(false) => {}
        Err(error) => return failure(&error.to_string()),
    }
    // Node yields while the backup runs, allowing other memory requests to start.
    drop(guard);
    // Best effort: any backup failure is swallowed and the save continues.
    let _ = crate::memory_backup::backup_file(&backup_path, &target, &state.backups_dir);
    // Guard 2, after the backup: covers a concurrent save landing in between.
    match stale(&target, mtime_present, mtime_number, force) {
        Ok(true) => return changed(),
        Ok(false) => {}
        Err(error) => return failure(&error.to_string()),
    }

    // The bridge cannot decode an escaped lone surrogate in `path`/`content`;
    // Node's inner catch reports the unavailable backend after the backup.
    if content_invalid || path_text.is_none() {
        return failure(BACKEND_UNAVAILABLE);
    }
    let path_text = path_text.expect("checked above");
    let payload = crate::memory::write_file(
        Some(path_text.as_str()),
        content_text.as_deref(),
        backend_mtime,
        force,
    );
    payload_response(payload)
}

/// `existsSync` + `statSync().mtimeMs` against the raw path, exactly like Node:
/// a missing path never blocks, and the tolerance is strictly `> 1` ms.
fn stale(path: &Path, present: bool, expected: f64, force: bool) -> std::io::Result<bool> {
    if !present || force || !path.exists() {
        return Ok(false);
    }
    let modified = std::fs::metadata(path)?.modified()?;
    Ok(stale_after(system_time_ms(modified), expected))
}

fn stale_after(actual: f64, expected: f64) -> bool {
    (actual - expected).abs() > 1.0
}

fn system_time_ms(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    }
}

// VERIFY: memory-file-write-surrogates
/// The path Node's `fs` calls see: exact UTF-16 on Windows (lone surrogates
/// included), UTF-8 with U+FFFD substitution elsewhere — Node's own conversion.
#[cfg(windows)]
fn os_path(units: &[u16]) -> PathBuf {
    use std::os::windows::ffi::OsStringExt;
    PathBuf::from(std::ffi::OsString::from_wide(units))
}

#[cfg(not(windows))]
fn os_path(units: &[u16]) -> PathBuf {
    PathBuf::from(String::from_utf16_lossy(units))
}

// VERIFY: memory-file-write-status
/// Relay `memory::write_file`'s payload the way Node does: success keeps the
/// ECMAScript number text for `mtime`; only `changed on disk` is a 409.
fn payload_response(payload: Value) -> Response {
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        let Some(mtime) = payload
            .get("mtime")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        else {
            return failure(BACKEND_UNAVAILABLE);
        };
        let mut buffer = ryu_js::Buffer::new();
        let Ok(mtime) = RawValue::from_string(buffer.format_finite(mtime).to_owned()) else {
            return failure(BACKEND_UNAVAILABLE);
        };
        return Json(WriteOk {
            ok: true,
            mtime: mtime.as_ref(),
        })
        .into_response();
    }
    let error = payload
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or(BACKEND_UNAVAILABLE);
    if error == CHANGED {
        changed()
    } else {
        failure(error)
    }
}

#[derive(serde::Serialize)]
struct WriteOk<'a> {
    ok: bool,
    // `mtime` stays a JSON number; its text follows ECMAScript number rules.
    mtime: &'a RawValue,
}

fn required() -> Response {
    failure_with(StatusCode::BAD_REQUEST, REQUIRED)
}

fn outside() -> Response {
    failure_with(StatusCode::BAD_REQUEST, OUTSIDE)
}

fn invalid_path_type(value: &Value) -> Response {
    let received = match value {
        Value::Bool(value) => format!("type boolean ({value})"),
        Value::Number(value) => format!("type number ({})", js_number_text(json_number(value))),
        Value::Array(_) => "an instance of Array".to_owned(),
        _ => "an instance of Object".to_owned(),
    };
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
        "statusCode": 500, "code": "ERR_INVALID_ARG_TYPE", "error": "Internal Server Error",
        "message": format!("The \"paths[0]\" argument must be of type string. Received {received}"),
    }))).into_response()
}

fn invalid_root_type() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
        "statusCode": 500, "error": "Internal Server Error", "message": "p.startsWith is not a function",
    }))).into_response()
}

fn failure(error: &str) -> Response {
    failure_with(StatusCode::BAD_REQUEST, error)
}

fn changed() -> Response {
    failure_with(StatusCode::CONFLICT, CHANGED)
}

fn failure_with(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

// VERIFY: memory-file-write-js-coercion
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
        Value::Array(items) => js_string_to_number(&js_join(items)),
        Value::Object(_) => f64::NAN,
    }
}

fn js_join(items: &[Value]) -> String {
    items.iter().map(js_string).collect::<Vec<_>>().join(",")
}

/// `String(value)` for the JSON values an array can contain.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_text(json_number(number)),
        Value::String(text) => text.clone(),
        Value::Array(items) => js_join(items),
        Value::Object(_) => "[object Object]".to_owned(),
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

/// `Number(string)` with JavaScript's white-space set and numeric grammar.
fn js_string_to_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(is_js_whitespace);
    if trimmed.is_empty() {
        return 0.0;
    }
    if let Some(digits) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return radix_digits(digits, 16);
    }
    if let Some(digits) = trimmed
        .strip_prefix("0b")
        .or_else(|| trimmed.strip_prefix("0B"))
    {
        return radix_digits(digits, 2);
    }
    if let Some(digits) = trimmed
        .strip_prefix("0o")
        .or_else(|| trimmed.strip_prefix("0O"))
    {
        return radix_digits(digits, 8);
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if !decimal_literal(trimmed) {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// `StringNumericLiteral` with a radix prefix: unsigned ASCII digits only.
fn radix_digits(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value = 0.0;
    for byte in digits.bytes() {
        let Some(digit) = (byte as char).to_digit(radix) else {
            return f64::NAN;
        };
        value = value * radix as f64 + digit as f64;
    }
    value
}

/// `[+-]? (Digits '.'? Digits? | '.' Digits) Exp?`
fn decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    if bytes
        .first()
        .is_some_and(|byte| *byte == b'+' || *byte == b'-')
    {
        index += 1;
    }
    let integer_start = index;
    while bytes.get(index).is_some_and(|byte| byte.is_ascii_digit()) {
        index += 1;
    }
    let integer_digits = index - integer_start;
    let mut fraction_digits = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(|byte| byte.is_ascii_digit()) {
            index += 1;
        }
        fraction_digits = index - fraction_start;
    }
    if integer_digits == 0 && fraction_digits == 0 {
        return false;
    }
    if bytes
        .get(index)
        .is_some_and(|byte| *byte == b'e' || *byte == b'E')
    {
        index += 1;
        if bytes
            .get(index)
            .is_some_and(|byte| *byte == b'+' || *byte == b'-')
        {
            index += 1;
        }
        let exponent_start = index;
        while bytes.get(index).is_some_and(|byte| byte.is_ascii_digit()) {
            index += 1;
        }
        if index == exponent_start {
            return false;
        }
    }
    index == bytes.len()
}

/// JavaScript `trim()` white space: `WhiteSpace` + `LineTerminator`. Rust's
/// `char::is_whitespace` differs (it includes U+0085, which JavaScript does not).
fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}' | '\u{000B}' | '\u{000C}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
                | '\n'
                | '\r'
    )
}

#[cfg(test)]
mod tests {
    use super::{
        MemoryFileWrite, js_string_to_number, js_truthy, js_value_number, put_file, stale_after,
        system_time_ms,
    };
    use axum::body::{Body, to_bytes};
    use axum::extract::State;
    use axum::http::{Method, Request, header};
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
            let base = std::env::temp_dir().join(format!(
                "http-memory-write-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&base).unwrap();
            Self(base)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        fn root(&self) -> PathBuf {
            self.0.join("projects")
        }

        fn backups(&self) -> PathBuf {
            self.0.join("backups")
        }

        fn state(&self) -> MemoryFileWrite {
            MemoryFileWrite {
                state_dir: self.state_dir(),
                home: self.0.join("home"),
                cwd: self.0.clone(),
                drive_cwds: Vec::new(),
                backups_dir: self.backups(),
                lock: Arc::new(Mutex::new(())),
            }
        }

        fn put(&self, rel: &str, content: &str) -> PathBuf {
            let path = self.root().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }

        fn mkdir(&self, rel: &str) -> PathBuf {
            let path = self.root().join(rel);
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn persist_root(&self, root: &str) {
            self.persist_root_token(&serde_json::to_string(root).unwrap());
        }

        // Writes the persisted picker root exactly as a raw JSON string token.
        fn persist_root_token(&self, token: &str) {
            fs::create_dir_all(self.state_dir()).unwrap();
            fs::write(
                self.state_dir().join("memory-root.json"),
                format!("{{\"root\":{token}}}"),
            )
            .unwrap();
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
        state: &MemoryFileWrite,
        content_type: Option<&str>,
        body: &str,
    ) -> (u16, String) {
        let mut builder = Request::builder()
            .method(Method::PUT)
            .uri("/api/memory/file");
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        let request = builder.body(Body::from(body.to_owned())).unwrap();
        let response = put_file(State(state.clone()), request).await;
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    async fn send(state: &MemoryFileWrite, body: &str) -> (u16, String) {
        send_with(state, Some("application/json"), body).await
    }

    #[test]
    fn authorization_observes_root_change_before_shared_lock_is_released() {
        let fixture = Fixture::new();
        let file = fixture.put("proj/memory/fact.md", "old");
        let old_root = text(&fixture.root());
        fixture.persist_root(&old_root);
        let state = fixture.state();
        let body = json!({ "path": text(&file), "root": old_root, "content": "new" }).to_string();
        run(async {
            let guard = state.lock.lock().unwrap();
            let worker_state = state.clone();
            let mut task = tokio::spawn(async move { send(&worker_state, &body).await });
            assert!(
                tokio::time::timeout(Duration::from_millis(100), &mut task)
                    .await
                    .is_err()
            );
            fixture.persist_root(&text(&fixture.0.join("other")));
            drop(guard);
            assert_eq!(task.await.unwrap(), (400, OUTSIDE_BODY.to_owned()));
        });
        assert_eq!(fs::read_to_string(file).unwrap(), "old");
    }

    fn mtime_ms(path: &Path) -> f64 {
        system_time_ms(fs::metadata(path).unwrap().modified().unwrap())
    }

    fn backup_dirs(root: &Path) -> Vec<PathBuf> {
        match fs::read_dir(root) {
            Ok(entries) => entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    fn bak_names(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.ends_with(".bak"))
            .collect()
    }

    // A raw JSON string token whose middle is an escaped lone surrogate.
    fn json_token_with_surrogate(prefix: &str, suffix: &str) -> String {
        let head = serde_json::to_string(prefix).unwrap();
        let tail = serde_json::to_string(suffix).unwrap();
        format!("{}\\ud800{}", &head[..head.len() - 1], &tail[1..])
    }

    const REQUIRED_BODY: &str = r#"{"ok":false,"error":"path + content required"}"#;
    const OUTSIDE_BODY: &str = r#"{"ok":false,"error":"path outside memory dirs"}"#;
    const CHANGED_BODY: &str = r#"{"ok":false,"error":"changed on disk"}"#;
    const BRIDGE_FAILURE_BODY: &str = r#"{"ok":false,"error":"memory write backend unavailable"}"#;

    #[test]
    fn writes_an_authorized_file_and_backs_up_the_previous_content() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let file = fixture.put("proj/memory/a.md", "old");
        let body = json!({
            "path": text(&file),
            "content": "new",
            "root": text(&fixture.root()),
            "mtime": mtime_ms(&file),
        })
        .to_string();
        let state = fixture.state();
        run(async {
            let (status, response) = send(&state, &body).await;
            assert_eq!(status, 200, "{response}");
            assert!(
                response.starts_with("{\"ok\":true,\"mtime\":"),
                "{response}"
            );
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");

        let dirs = backup_dirs(&fixture.backups());
        assert_eq!(dirs.len(), 1);
        let baks = bak_names(&dirs[0]);
        assert_eq!(baks.len(), 1);
        assert_eq!(fs::read_to_string(dirs[0].join(&baks[0])).unwrap(), "old");
        assert_eq!(
            fs::read_to_string(dirs[0].join("source.txt")).unwrap(),
            text(&file)
        );
    }

    #[test]
    fn a_stale_mtime_returns_409_before_any_backup() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let file = fixture.put("proj/memory/a.md", "old");
        let body = json!({
            "path": text(&file),
            "content": "new",
            "root": text(&fixture.root()),
            "mtime": mtime_ms(&file) + 10.0,
        })
        .to_string();
        let state = fixture.state();
        run(async {
            assert_eq!(send(&state, &body).await, (409, CHANGED_BODY.to_owned()));
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
        assert!(backup_dirs(&fixture.backups()).is_empty());
    }

    #[test]
    fn force_uses_javascript_truthiness() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let file = fixture.put("proj/memory/a.md", "old");
        let stale = mtime_ms(&file) + 10.0;
        let path = text(&file);
        let root = text(&fixture.root());
        let state = fixture.state();
        let body = |force: Value| {
            json!({
                "path": path.as_str(),
                "content": "forced",
                "root": root.as_str(),
                "mtime": stale,
                "force": force,
            })
            .to_string()
        };
        run(async {
            assert_eq!(send(&state, &body(json!(false))).await.0, 409);
            assert_eq!(send(&state, &body(json!(0))).await.0, 409);
            // A non-empty string and an array are truthy in JavaScript.
            assert_eq!(send(&state, &body(json!("false"))).await.0, 200);
            assert_eq!(send(&state, &body(json!([]))).await.0, 200);
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "forced");
    }

    #[test]
    fn backup_failure_never_blocks_the_save() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let file = fixture.put("proj/memory/a.md", "old");
        fs::write(fixture.backups(), "not a directory").unwrap();
        let body = json!({
            "path": text(&file),
            "content": "new",
            "root": text(&fixture.root()),
        })
        .to_string();
        let state = fixture.state();
        run(async {
            let (status, response) = send(&state, &body).await;
            assert_eq!(status, 200, "{response}");
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(
            fs::read_to_string(fixture.backups()).unwrap(),
            "not a directory"
        );
    }

    #[test]
    fn a_failed_write_still_keeps_the_backup_it_made() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        // A directory named like the target exists (so it is backed up) and
        // makes the final write fail after the backup.
        let target = fixture.mkdir("proj/memory/blocked.md");
        let body = json!({
            "path": text(&target),
            "content": "x",
            "root": text(&fixture.root()),
        })
        .to_string();
        let state = fixture.state();
        run(async {
            let (status, response) = send(&state, &body).await;
            assert_eq!(status, 400, "{response}");
            let value: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(value["ok"], false);
            assert!(
                value["error"]
                    .as_str()
                    .is_some_and(|error| !error.is_empty())
            );
        });
        let dirs = backup_dirs(&fixture.backups());
        assert_eq!(dirs.len(), 1);
        let baks = bak_names(&dirs[0]);
        assert_eq!(baks.len(), 1);
        // The failed copy leaves the claimed, still empty, backup file.
        assert_eq!(fs::read(dirs[0].join(&baks[0])).unwrap(), b"");
    }

    #[test]
    fn the_final_write_never_creates_parent_directories() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        fixture.mkdir("proj/memory");
        let target = fixture.root().join("proj/memory/absent/a.md");
        let body = json!({
            "path": text(&target),
            "content": "x",
            "root": text(&fixture.root()),
        })
        .to_string();
        let state = fixture.state();
        run(async {
            let (status, response) = send(&state, &body).await;
            assert_eq!(status, 400, "{response}");
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["ok"],
                false
            );
        });
        assert!(!target.parent().unwrap().exists());
    }

    #[test]
    fn backups_are_pruned_to_the_five_newest() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let file = fixture.put("proj/memory/a.md", "0");
        let path = text(&file);
        let root = text(&fixture.root());
        let state = fixture.state();
        run(async {
            for index in 1..=7 {
                let body = json!({
                    "path": path.as_str(),
                    "content": index.to_string(),
                    "root": root.as_str(),
                })
                .to_string();
                let (status, response) = send(&state, &body).await;
                assert_eq!(status, 200, "{response}");
            }
        });
        let dirs = backup_dirs(&fixture.backups());
        assert_eq!(dirs.len(), 1);
        assert_eq!(bak_names(&dirs[0]).len(), 5);
    }

    #[test]
    fn content_coercion_and_surrogates_match_the_node_route() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let file = fixture.put("proj/memory/a.md", "kept");
        let path = text(&file);
        let root = text(&fixture.root());
        let state = fixture.state();
        let body = |content: Value| {
            json!({
                "path": path.as_str(),
                "content": content,
                "root": root.as_str(),
            })
            .to_string()
        };
        let surrogate_body = format!(
            "{{\"path\":{},\"content\":\"a\\ud800b\",\"root\":{}}}",
            serde_json::to_string(&path).unwrap(),
            serde_json::to_string(&root).unwrap(),
        );
        run(async {
            assert_eq!(
                send(&state, &body(json!(5))).await,
                (
                    400,
                    r#"{"ok":false,"error":"content must be a string"}"#.to_owned()
                )
            );
            assert_eq!(
                send(&state, &body(json!(null))).await,
                (400, REQUIRED_BODY.to_owned())
            );
            // A lone surrogate cannot cross the bridge: Node reports the
            // unavailable backend after the backup and writes nothing.
            assert_eq!(
                send(&state, &surrogate_body).await,
                (400, BRIDGE_FAILURE_BODY.to_owned())
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), "kept");
            assert_eq!(backup_dirs(&fixture.backups()).len(), 1);
            // Empty content is a legal string and writes a zero-byte file.
            let (status, response) = send(&state, &body(json!(""))).await;
            assert_eq!(status, 200, "{response}");
        });
        assert_eq!(fs::read(&file).unwrap(), b"");
    }

    #[test]
    fn non_object_and_malformed_bodies_have_no_fields() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let state = fixture.state();
        run(async {
            for body in [
                r#""text""#,
                "null",
                "[]",
                "42",
                "true",
                "{}",
                r#"{"path":"/x"}"#,
                r#"{"content":"x"}"#,
            ] {
                assert_eq!(
                    send(&state, body).await,
                    (400, REQUIRED_BODY.to_owned()),
                    "{body}"
                );
            }
            // `text/plain` parses to a string, so it carries no fields either.
            assert_eq!(
                send_with(&state, Some("text/plain"), r#"{"path":"/x","content":"y"}"#)
                    .await
                    .0,
                400
            );
            let (status, response) = send_with(&state, Some("application/json"), "{").await;
            assert_eq!(status, 400);
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["code"],
                "FST_ERR_CTP_INVALID_JSON_BODY"
            );
            assert_eq!(
                send_with(&state, Some("application/xml"), "<x/>").await.0,
                415
            );
            assert_eq!(send_with(&state, None, "").await.0, 400);
        });
    }

    #[test]
    fn containment_and_root_semantics_match_the_node_route() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let inside = fixture.put("proj/memory/a.md", "old");
        fixture.mkdir("proj/memory/sub");
        fixture.mkdir("PROJ/MEMORY");
        let root = text(&fixture.root());
        let path = text(&inside);
        let nested = text(&fixture.root().join("proj/memory/sub/nested.md"));
        let upper = text(&fixture.root().join("PROJ/MEMORY/UPPER.MD"));
        let escape = text(&fixture.root().join("proj/memory/../../../escape.md"));
        let sibling = text(&PathBuf::from(format!("{root}-evil")).join("proj/memory/a.md"));
        let widened = text(fixture.root().parent().unwrap());
        let dot_md = text(&fixture.root().join("proj/memory/.md"));
        let wrong_ext = text(&fixture.root().join("proj/memory/a.txt"));
        let state = fixture.state();
        let body = |path: &str, root: &str| {
            json!({ "path": path, "content": "x", "root": root }).to_string()
        };
        run(async {
            // Accepted shapes, including nested dirs and case folding.
            for accepted in [path.as_str(), nested.as_str(), upper.as_str()] {
                assert_eq!(
                    send(&state, &body(accepted, root.as_str())).await.0,
                    200,
                    "{accepted}"
                );
            }
            // An omitted or empty root falls back to the persisted one.
            let omitted = json!({ "path": path.as_str(), "content": "x" }).to_string();
            assert_eq!(send(&state, &omitted).await.0, 200);
            assert_eq!(send(&state, &body(path.as_str(), "")).await.0, 200);
            // Everything else is outside, never written.
            for rejected in [
                body(escape.as_str(), root.as_str()),
                body(sibling.as_str(), root.as_str()),
                body(path.as_str(), widened.as_str()),
                body(dot_md.as_str(), root.as_str()),
                body(wrong_ext.as_str(), root.as_str()),
                body("", root.as_str()),
            ] {
                assert_eq!(
                    send(&state, &rejected).await,
                    (400, OUTSIDE_BODY.to_owned()),
                    "{rejected}"
                );
            }
            // Falsy non-string roots fall back; truthy ones throw in Node.
            for falsy in [json!(0), json!(false), Value::Null] {
                let body = json!({
                    "path": path.as_str(),
                    "content": "x",
                    "root": falsy,
                })
                .to_string();
                assert_eq!(send(&state, &body).await.0, 200, "{body}");
            }
            for truthy in [json!([]), json!({}), json!(5), json!(true)] {
                let body = json!({
                    "path": path.as_str(),
                    "content": "x",
                    "root": truthy,
                })
                .to_string();
                let (status, response) = send(&state, &body).await;
                assert_eq!(status, 500, "{body}");
                assert_eq!(
                    serde_json::from_str::<Value>(&response).unwrap()["message"],
                    "p.startsWith is not a function"
                );
            }
            // Falsy non-string paths are outside; truthy ones throw.
            for invalid in [json!(0), json!(5), json!([]), json!(false)] {
                let expected_status = if js_truthy(&invalid) { 500 } else { 400 };
                let expected_message = match &invalid {
                    Value::Number(number) if number.as_i64() == Some(5) => Some(
                        "The \"paths[0]\" argument must be of type string. Received type number (5)",
                    ),
                    Value::Array(_) => Some(
                        "The \"paths[0]\" argument must be of type string. Received an instance of Array",
                    ),
                    _ => None,
                };
                let body = json!({
                    "path": invalid,
                    "content": "x",
                    "root": root.as_str(),
                })
                .to_string();
                let (status, response) = send(&state, &body).await;
                assert_eq!(status, expected_status, "{body}");
                if let Some(message) = expected_message {
                    let value: Value = serde_json::from_str(&response).unwrap();
                    assert_eq!(value["code"], "ERR_INVALID_ARG_TYPE");
                    assert_eq!(value["message"], message);
                }
            }
        });
    }

    #[test]
    fn duplicate_body_keys_use_the_last_member() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let file = fixture.put("proj/memory/a.md", "old");
        let path = text(&file);
        let root = text(&fixture.root());
        let outside = text(&fixture.root().join("proj/notes/a.md"));
        let accepted = format!(
            "{{\"path\":{},\"path\":{},\"content\":\"x\",\"root\":{}}}",
            serde_json::to_string(&outside).unwrap(),
            serde_json::to_string(&path).unwrap(),
            serde_json::to_string(&root).unwrap(),
        );
        let rejected = format!(
            "{{\"path\":{},\"path\":{},\"content\":\"x\",\"root\":{}}}",
            serde_json::to_string(&path).unwrap(),
            serde_json::to_string(&outside).unwrap(),
            serde_json::to_string(&root).unwrap(),
        );
        let state = fixture.state();
        run(async {
            assert_eq!(send(&state, &accepted).await.0, 200);
            assert_eq!(
                send(&state, &rejected).await,
                (400, OUTSIDE_BODY.to_owned())
            );
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "x");
    }

    #[test]
    fn mtime_strings_use_javascript_number_semantics() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let file = fixture.put("proj/memory/a.md", "old");
        let path = text(&file);
        let root = text(&fixture.root());
        let state = fixture.state();
        let body = |mtime: Value| {
            json!({
                "path": path.as_str(),
                "content": "x",
                "root": root.as_str(),
                "mtime": mtime,
            })
            .to_string()
        };
        run(async {
            // NaN disables the guard and writes.
            assert_eq!(send(&state, &body(json!("abc"))).await.0, 200);
            // A numeric string is honoured; 0 ms is stale for any real file.
            assert_eq!(send(&state, &body(json!("0"))).await.0, 409);
            // Infinity is present and stale in Node's outer guard.
            assert_eq!(send(&state, &body(json!("Infinity"))).await.0, 409);
            // An object coerces to NaN and writes.
            assert_eq!(send(&state, &body(json!({}))).await.0, 200);
        });
    }

    #[test]
    fn the_mtime_tolerance_is_strictly_greater_than_one_millisecond() {
        assert!(!stale_after(1000.0, 1001.0));
        assert!(!stale_after(1000.0, 999.0));
        assert!(stale_after(1000.0, 1001.001));
        assert!(stale_after(1000.0, 998.999));
        assert!(!stale_after(f64::NAN, 1000.0));
    }

    #[test]
    fn javascript_number_and_truthiness_semantics() {
        let number = |value: Value| js_value_number(&value);
        assert_eq!(number(json!(null)), 0.0);
        assert_eq!(number(json!(true)), 1.0);
        assert_eq!(number(json!(false)), 0.0);
        assert_eq!(number(json!(12.5)), 12.5);
        assert_eq!(number(json!("123")), 123.0);
        assert_eq!(number(json!(" 12 ")), 12.0);
        assert_eq!(number(json!("")), 0.0);
        assert_eq!(number(json!("   ")), 0.0);
        assert_eq!(number(json!("\u{00a0}5")), 5.0);
        assert_eq!(number(json!("0x10")), 16.0);
        assert_eq!(number(json!("0b101")), 5.0);
        assert_eq!(number(json!("0o17")), 15.0);
        assert_eq!(number(json!("1e3")), 1000.0);
        assert_eq!(number(json!(".5")), 0.5);
        assert_eq!(number(json!("1.")), 1.0);
        assert_eq!(number(json!("Infinity")), f64::INFINITY);
        assert_eq!(number(json!("-Infinity")), f64::NEG_INFINITY);
        let overflow: Value = serde_json::from_str("1e400").unwrap();
        assert_eq!(number(overflow.clone()), f64::INFINITY);
        assert!(js_truthy(&overflow));
        assert_eq!(number(json!([])), 0.0);
        assert_eq!(number(json!([5])), 5.0);
        assert_eq!(number(json!(["7"])), 7.0);
        assert_eq!(number(json!([null])), 0.0);
        for invalid in [
            json!("abc"),
            json!("1_0"),
            json!("+0x1"),
            json!("\u{0085}5"),
            json!([1, 2]),
            json!({}),
        ] {
            assert!(number(invalid.clone()).is_nan(), "{invalid}");
        }

        for falsy in [json!(null), json!(false), json!(0), json!("")] {
            assert!(!js_truthy(&falsy), "{falsy}");
        }
        for truthy in [
            json!(true),
            json!(1),
            json!(-1),
            json!("0"),
            json!("false"),
            json!([]),
            json!({}),
        ] {
            assert!(js_truthy(&truthy), "{truthy}");
        }
        assert!(js_string_to_number("\u{0085}5").is_nan());
    }

    #[test]
    fn authorization_uses_exact_utf16_units() {
        let fixture = Fixture::new();
        let separator = std::path::MAIN_SEPARATOR;
        let prefix = format!("{}{separator}", text(&fixture.root()));
        let root_token = json_token_with_surrogate(&prefix, "");
        fixture.persist_root_token(&root_token);
        let path_token = json_token_with_surrogate(
            &prefix,
            &format!("{separator}proj{separator}memory{separator}a.md"),
        );
        let body = format!("{{\"path\":{path_token},\"content\":\"x\",\"root\":{root_token}}}");
        let mut target_units: Vec<u16> = prefix.encode_utf16().collect();
        target_units.push(0xd800);
        target_units
            .extend(format!("{separator}proj{separator}memory{separator}a.md").encode_utf16());
        let lossy_root = format!("{prefix}\u{fffd}");
        let lossy_body = format!(
            "{{\"path\":{},\"content\":\"x\",\"root\":{}}}",
            serde_json::to_string(&format!(
                "{lossy_root}{separator}proj{separator}memory{separator}a.md"
            ))
            .unwrap(),
            serde_json::to_string(&lossy_root).unwrap(),
        );
        let state = fixture.state();
        run(async {
            // Exact units authorize, then the bridge rejects the escaped
            // surrogate exactly as Node does; nothing is substituted or written.
            assert_eq!(
                send(&state, &body).await,
                (400, BRIDGE_FAILURE_BODY.to_owned())
            );
            assert!(!super::os_path(&target_units).exists());
            // A lossy spelling of the same root never matches the persisted one.
            assert_eq!(
                send(&state, &lossy_body).await,
                (400, OUTSIDE_BODY.to_owned())
            );
        });
        assert!(backup_dirs(&fixture.backups()).is_empty());
    }

    #[test]
    fn concurrent_saves_allow_node_write_race() {
        let fixture = Fixture::new();
        fixture.persist_root(&text(&fixture.root()));
        let file = fixture.put("proj/memory/a.md", "old");
        let old = SystemTime::now() - Duration::from_secs(60);
        let set = File::options()
            .write(true)
            .open(&file)
            .and_then(|file| file.set_times(FileTimes::new().set_modified(old)));
        if let Err(error) = set {
            eprintln!("SKIP concurrent save check: file times unsupported: {error}");
            return;
        }
        let body = json!({
            "path": text(&file),
            "content": "new",
            "root": text(&fixture.root()),
            "mtime": mtime_ms(&file),
        })
        .to_string();
        let state = fixture.state();
        run(async {
            let (first, second) = tokio::join!(send(&state, &body), send(&state, &body));
            let mut statuses = [first.0, second.0];
            statuses.sort_unstable();
            assert!(
                matches!(statuses, [200, 200] | [200, 409]),
                "{first:?} {second:?}"
            );
        });
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
    }
}
