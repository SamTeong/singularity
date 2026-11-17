// Codex config editor write HTTP surface: `PUT /api/codex-config/:scope`,
// mirroring `server/index.mjs:633-639` -> `codex-config.mjs` `writeConfig`
// (118-156), `isKnownConfigRoot` (108-116), `scopePaths` (16-21), plus
// `backups.mjs` `backupFile` (57-78) and the Rust final guard
// `codex_config_write::write_file`.
//
// The host injects the editor's home (tilde expansion and the `~` = home test),
// the resolved `CODEX_HOME` (`process.env.CODEX_HOME || join(homedir(), '.codex')`
// in Node), the state dir that holds `codex-config-roots.json`, the backups dir,
// the shared roots lock, Node's process cwd and its per-drive cwd values. No
// handler reads process env, the real home dir or the process cwd on its own.
//
// Parity contract, in Node's exact order:
//   * Body parsing is `http_body::parse_raw` (Fastify media types, 1 MiB cap,
//     Content-Length, BOM, FST_ERR_* envelopes). A non-object body has no
//     fields, because Node destructures it without throwing.
//   * `!cwd || content == null` -> 400 `cwd + content required`. Both tests use
//     JavaScript truthiness/nullishness, so `cwd: false`, `0` or `""` is
//     missing while `content: false` or `0` is present.
//   * Any scope other than `project`/`user` -> 400 `bad scope` (checked after
//     the required-fields gate, as in the route handler -> `writeConfig`).
//   * Truthy non-string `cwd` throws in `resolveRoot` (`p.startsWith`) -> 500
//     with Fastify's `p.startsWith is not a function` envelope. Falsy ones were
//     already rejected by the required-fields gate.
//   * Authorization is `config_editor_auth::is_known` over the pinned picker
//     roots in `<state_dir>/codex-config-roots.json` (`picker_roots::get_roots`),
//     read under the injected shared lock; failure -> 400
//     `cwd outside config roots`.
//   * cwd/scope invariant: `resolveRoot(cwd) === resolve(home)` is exact UTF-16
//     equality after tilde expansion. `user` requires it (else 400 `user scope
//     requires cwd ~`), `project` requires its negation (else 400 `project scope
//     requires a non-home cwd`).
//   * Target path: `user` = `path.join(CODEX_HOME, 'config.toml')`, `project` =
//     `path.join(cwd, '.codex', 'config.toml')`, both through
//     `config_editor_paths::join_config` so Node's normalization and its tilde
//     rules (never expanded here) hold.
//   * TOML validation is `codex_config_toml::validate` (toml_edit, TOML 1.1)
//     where Node used `@iarna/toml` (TOML 0.5); failure -> 400
//     `invalid TOML: <one-line reason>`. What the Node parser consumes is
//     measured, not assumed: a string is the document, an **array** is its
//     `Array.prototype.toString` text (so `[1, 2]` is a parse error while
//     `["x = 1"]` parses), and every other non-string is read as no input at
//     all, so it never invalidates the save.
//   * Stale guard before the backup, then a best-effort `backup_file` into the
//     injected backups dir, `create_dir_all` of the parent when the backup is
//     `None` (first write, or a failed backup), then the stale guard again.
//     A stale file is 409 `changed on disk`; an `existsSync`/`statSync` or
//     `mkdirSync` failure is the file's error text at 400.
//   * `mtime` uses `Number(mtime)` semantics for the outer subtraction (NaN
//     disables the guard) and `mtime == null ? null : Number(mtime)` for the
//     backend; non-finite/absent values arrive as `None`, disabling the Rust
//     guard too. `force` is JavaScript truthiness.
//   * Final write is `codex_config_write::write_file` over the derived path. A
//     non-string `content` reaches it as `None` and its `content must be a
//     string` maps to 400 `codex config write failed`, like every other
//     `ok:false` except `changed on disk` (409). Success is
//     `{"ok":true,"mtime":<js number>,"backup":<path|null>,"path":<path>}`
//     (result keys, then backup, then path).
//
// Parity limits, reported rather than approximated:
//   * Filesystem failure text is Rust's `io::Error` text, not Node's
//     `e.message` (same choice as the sibling write routes).
//   * A `cwd` containing an unpaired surrogate cannot be represented as a Rust
//     string, and the Node->Rust bridge could not carry such a path either.
//     This route answers 400 `codex config write backend unavailable` after
//     authorization and TOML validation; Node would first back up the
//     surrogate-named file, a side effect this route cannot reproduce without
//     bypassing `config_editor_paths`.
//   * A string `content` containing an unpaired surrogate cannot cross the
//     bridge: Node's inner catch reports 400 `codex config write backend
//     unavailable` after the backup. This route reproduces the response (and
//     the backup) without the bridge-teardown side effect.
//   * TOML acceptance edges differ between the two parsers; see the
//     `codex_config_toml` header. The reason text is toml_edit's, one line.
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
use crate::wiki_root::resolve_units;
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
const USER_SCOPE: &str = "user scope requires cwd ~";
const PROJECT_SCOPE: &str = "project scope requires a non-home cwd";
const CHANGED: &str = "changed on disk";
const WRITE_FAILED: &str = "codex config write failed";
const BACKEND_UNAVAILABLE: &str = "codex config write backend unavailable";
const INVALID_TOML_PREFIX: &str = "invalid TOML: ";
const CODEX_ROOTS_FILE: &str = "codex-config-roots.json";
const CODEX_DIR: &str = ".codex";
const CODEX_FILE: &str = "config.toml";

#[derive(Clone)]
struct CodexConfigWrite {
    home: PathBuf,
    // `CODEX_HOME`, resolved by the host; `user` scope writes here.
    codex_home: PathBuf,
    state_dir: PathBuf,
    backups_dir: PathBuf,
    // Shared with the codex-config-roots routes so a pinned-root change cannot
    // interleave with the authorization read.
    lock: Arc<Mutex<()>>,
    // Node's process cwd and hidden per-drive cwds, used by `path.resolve`.
    process_cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
}

// VERIFY: codex-config-write-router-injection
pub fn router(
    home: PathBuf,
    codex_home: PathBuf,
    state_dir: PathBuf,
    backups_dir: PathBuf,
    lock: Arc<Mutex<()>>,
    process_cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
) -> Router {
    Router::new()
        // VERIFY: wave3-hostreview-5
        // Deliberate deviation: axum ranks the static `/api/codex-config/search`
        // and `/api/codex-config/scan` routes above this parameter, so `PUT` on
        // them is a 404 where Fastify writes scope "search"/"scan". Failing
        // closed is safer than a nonsense write, so the quirk is not reproduced.
        .route("/api/codex-config/{scope}", put(put_config))
        .with_state(CodexConfigWrite {
            home,
            codex_home,
            state_dir,
            backups_dir,
            lock,
            process_cwd,
            drive_cwds,
        })
}

async fn put_config(
    State(state): State<CodexConfigWrite>,
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

// VERIFY: codex-config-write-body-fields
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

// VERIFY: codex-config-write-order
fn write(state: &CodexConfigWrite, scope: &str, fields: WriteFields) -> Response {
    write_with_backup(state, scope, fields, crate::memory_backup::backup_file)
}

fn write_with_backup(
    state: &CodexConfigWrite,
    scope: &str,
    fields: WriteFields,
    backup: impl FnOnce(&str, &Path, &Path) -> Option<PathBuf>,
) -> Response {
    if !fields.cwd.truthy() || fields.content.is_null() {
        return failure(REQUIRED);
    }
    if !matches!(scope, "project" | "user") {
        return failure(BAD_SCOPE);
    }
    let Field::Text(cwd_units) = &fields.cwd else {
        // `resolveRoot` calls `p.startsWith` on the truthy non-string cwd.
        return internal_error(json!({
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

    // `resolveRoot(cwd) === resolve(homedir())`: both sides tilde-expanded and
    // lexically resolved, compared as exact UTF-16 units.
    let is_home =
        resolved_units(state, cwd_units, true) == resolved_units(state, &home_units(state), false);
    if scope == "user" && !is_home {
        return failure(USER_SCOPE);
    }
    if scope == "project" && is_home {
        return failure(PROJECT_SCOPE);
    }

    // What `@iarna/toml`'s `parse` consumes, measured against the installed
    // package: a string is the document, an array is its `toString` text, and
    // any other non-string is no input at all (so it cannot fail here).
    if let Some(text) = toml_input(&fields.content) {
        if let Err(reason) = crate::codex_config_toml::validate(&text) {
            return failure(&format!("{INVALID_TOML_PREFIX}{reason}"));
        }
    }

    let Ok(cwd) = String::from_utf16(cwd_units) else {
        return failure(BACKEND_UNAVAILABLE);
    };
    let path = config_path(state, &cwd, scope);
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
        // The bridge forwards the raw non-string value;
        // `codex_config_write::write_file` reports `content must be a string`,
        // which Node maps to this 400.
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
    let payload = crate::codex_config_write::write_file(
        Some(path.as_str()),
        Some(content.as_str()),
        backend_mtime,
        force,
    );
    payload_response(payload, backup_path, path)
}

/// The document `@iarna/toml` parses for this field: the string itself, or an
/// array's `Array.prototype.toString` text. Every other non-string leaves the
/// parser with no input, which is not an error.
fn toml_input(content: &Field) -> Option<String> {
    match content {
        Field::Text(units) => Some(String::from_utf16_lossy(units)),
        Field::Other(value @ Value::Array(_)) => Some(js_string(value)),
        Field::Absent | Field::Null | Field::Other(_) => None,
    }
}

// VERIFY: codex-config-write-path
/// `scopePaths(cwd)[scope]`: `join(CODEX_HOME, 'config.toml')` for `user`,
/// `join(cwd, '.codex', 'config.toml')` for `project`, both with Node's
/// normalization. `join_config` drops empty components, so the `user` call
/// joins exactly two.
fn config_path(state: &CodexConfigWrite, cwd: &str, scope: &str) -> String {
    let windows = cfg!(windows);
    if scope == "user" {
        crate::config_editor_paths::join_config(
            &state.codex_home.to_string_lossy(),
            CODEX_FILE,
            "",
            windows,
        )
    } else {
        crate::config_editor_paths::join_config(cwd, CODEX_DIR, CODEX_FILE, windows)
    }
}

fn home_units(state: &CodexConfigWrite) -> Vec<u16> {
    state.home.to_string_lossy().encode_utf16().collect()
}

/// `path.resolve` with the platform's per-drive cwd values. Targets pass
/// `expand_tilde = false` (Node's `resolve` never expands `~`); `resolveRoot`
/// passes `true`, and `resolve(homedir())` passes `false`.
fn resolved_units(state: &CodexConfigWrite, units: &[u16], expand_tilde: bool) -> Vec<u16> {
    resolve_units(
        units,
        &state.home,
        &state.process_cwd,
        &state.drive_cwds,
        cfg!(windows),
        expand_tilde,
    )
}

// VERIFY: codex-config-write-authorization-roots
/// The pinned picker roots as raw UTF-16 units. `picker_roots::get_roots`
/// already returns `["~"]` for a missing/invalid file; a scanner failure here
/// can only mean that fallback, so no roots authorize nothing extra.
fn config_roots(state_dir: &Path) -> Vec<Vec<u16>> {
    let text = crate::picker_roots::get_roots(&state_dir.join(CODEX_ROOTS_FILE));
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

// VERIFY: codex-config-write-status
/// Relay `codex_config_write::write_file`'s payload the way Node does: success
/// keeps the ECMAScript number text for `mtime` and appends `backup` then
/// `path`; only the exact error `changed on disk` is a 409, everything else a
/// 400 `codex config write failed`.
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

fn internal_error(payload: Value) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(payload)).into_response()
}

// VERIFY: codex-config-write-js-coercion
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
        CodexConfigWrite, Field, RoutePath, WriteFields, put_config, system_time_ms,
        write_with_backup,
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
                "http-codex-config-write-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn home(&self) -> PathBuf {
            self.0.join("home")
        }

        fn codex_home(&self) -> PathBuf {
            self.0.join("codex-home")
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

        fn state(&self) -> CodexConfigWrite {
            CodexConfigWrite {
                home: self.home(),
                codex_home: self.codex_home(),
                state_dir: self.state_dir(),
                backups_dir: self.backups(),
                lock: Arc::new(Mutex::new(())),
                process_cwd: self.0.clone(),
                drive_cwds: Vec::new(),
            }
        }

        /// Persist the picker roots exactly as `picker_roots::set_roots` does
        /// (a bare JSON array), then build the shared state.
        fn state_for<S: AsRef<str>>(&self, roots: &[S]) -> CodexConfigWrite {
            let roots: Vec<&str> = roots.iter().map(|root| root.as_ref()).collect();
            fs::create_dir_all(self.state_dir()).unwrap();
            fs::write(
                self.state_dir().join(super::CODEX_ROOTS_FILE),
                serde_json::to_string(&roots).unwrap(),
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
        state: &CodexConfigWrite,
        scope: &str,
        content_type: Option<&str>,
        body: &str,
    ) -> (u16, String) {
        let mut builder = Request::builder()
            .method(Method::PUT)
            .uri(format!("/api/codex-config/{scope}"));
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        let request = builder.body(Body::from(body.to_owned())).unwrap();
        let response = put_config(State(state.clone()), RoutePath(scope.to_owned()), request).await;
        collect(response).await
    }

    async fn send(state: &CodexConfigWrite, scope: &str, body: &str) -> (u16, String) {
        send_with(state, scope, Some("application/json"), body).await
    }

    async fn collect(response: Response) -> (u16, String) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn mtime_ms(path: &Path) -> f64 {
        system_time_ms(fs::metadata(path).unwrap().modified().unwrap())
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

    const REQUIRED_BODY: &str = r#"{"ok":false,"error":"cwd + content required"}"#;
    const BAD_SCOPE_BODY: &str = r#"{"ok":false,"error":"bad scope"}"#;
    const OUTSIDE_BODY: &str = r#"{"ok":false,"error":"cwd outside config roots"}"#;
    const USER_SCOPE_BODY: &str = r#"{"ok":false,"error":"user scope requires cwd ~"}"#;
    const PROJECT_SCOPE_BODY: &str =
        r#"{"ok":false,"error":"project scope requires a non-home cwd"}"#;
    const CHANGED_BODY: &str = r#"{"ok":false,"error":"changed on disk"}"#;
    const WRITE_FAILED_BODY: &str = r#"{"ok":false,"error":"codex config write failed"}"#;
    const BACKEND_UNAVAILABLE_BODY: &str =
        r#"{"ok":false,"error":"codex config write backend unavailable"}"#;

    #[test]
    fn project_scope_writes_backs_up_and_keeps_the_node_result_shape() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let target = fixture.put("roots/project/.codex/config.toml", "model = \"x\"\n");
        let state = fixture.state_for(&[text(&root)]);
        let body = json!({
            "cwd": text(&root),
            "content": "model = \"y\"\n",
            "mtime": mtime_ms(&target),
        })
        .to_string();
        run(async {
            let (status, response) = send(&state, "project", &body).await;
            assert_eq!(status, 200, "{response}");
            assert!(response.starts_with(r#"{"ok":true,"mtime":"#), "{response}");
            // result keys first, then backup, then path (`~` never applies here)
            let expected_path = super::config_path(&state, &text(&root), "project");
            let path_token = serde_json::to_string(&expected_path).unwrap();
            let expected_suffix = format!(r#","path":{path_token}}}"#);
            assert!(
                response.ends_with(&expected_suffix),
                "{response}\nexpected suffix {expected_suffix}"
            );
            assert!(response.contains(r#","backup":"#), "{response}");
        });
        assert_eq!(fs::read_to_string(&target).unwrap(), "model = \"y\"\n");
        let dirs = backup_dirs(&fixture.backups());
        assert_eq!(dirs.len(), 1);
        let baks = bak_names(&dirs[0]);
        assert_eq!(baks.len(), 1);
        assert_eq!(
            fs::read_to_string(dirs[0].join(&baks[0])).unwrap(),
            "model = \"x\"\n"
        );
    }

    #[test]
    fn a_first_write_creates_only_its_parent_and_returns_a_null_backup() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let state = fixture.state_for(&[text(&root)]);
        let body = json!({ "cwd": text(&root), "content": "model = \"y\"\n" }).to_string();
        run(async {
            let (status, response) = send(&state, "project", &body).await;
            assert_eq!(status, 200, "{response}");
            assert!(response.contains(r#","backup":null,"#), "{response}");
        });
        assert_eq!(
            fs::read_to_string(root.join(".codex").join("config.toml")).unwrap(),
            "model = \"y\"\n"
        );
        assert!(!fixture.backups().exists());
    }

    #[test]
    fn required_scope_authorization_and_scope_mismatch_errors_keep_node_order() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let outside = fixture.0.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let state = fixture.state_for(&[text(&root), "~".to_owned()]);
        let root_text = text(&root);
        let outside_text = text(&outside);
        run(async {
            for body in [
                "{}".to_owned(),
                json!({ "content": "x" }).to_string(),
                json!({ "cwd": root_text.as_str() }).to_string(),
                json!({ "cwd": "", "content": "x" }).to_string(),
                json!({ "cwd": 0, "content": "x" }).to_string(),
                json!({ "cwd": false, "content": "x" }).to_string(),
                json!({ "cwd": root_text.as_str(), "content": null }).to_string(),
            ] {
                assert_eq!(
                    send(&state, "project", &body).await,
                    (400, REQUIRED_BODY.to_owned()),
                    "{body}"
                );
            }
            // scope is checked before authorization, as in route -> writeConfig
            for scope in ["local", "Project", "", "users"] {
                assert_eq!(
                    send(
                        &state,
                        scope,
                        &json!({ "cwd": outside_text.as_str(), "content": "x" }).to_string()
                    )
                    .await,
                    (400, BAD_SCOPE_BODY.to_owned()),
                    "{scope}"
                );
            }
            assert_eq!(
                send(
                    &state,
                    "project",
                    &json!({ "cwd": outside_text.as_str(), "content": "x" }).to_string()
                )
                .await,
                (400, OUTSIDE_BODY.to_owned())
            );
            // user scope needs cwd ~; the project cwd is authorized but not home
            assert_eq!(
                send(
                    &state,
                    "user",
                    &json!({ "cwd": root_text.as_str(), "content": "x" }).to_string()
                )
                .await,
                (400, USER_SCOPE_BODY.to_owned())
            );
            // project scope needs a non-home cwd; `~` resolves to home
            assert_eq!(
                send(
                    &state,
                    "project",
                    &json!({ "cwd": "~", "content": "x" }).to_string()
                )
                .await,
                (400, PROJECT_SCOPE_BODY.to_owned())
            );
        });
        assert!(!fixture.codex_home().exists());
    }

    #[test]
    fn a_truthy_non_string_cwd_is_the_fastify_500() {
        let fixture = Fixture::new();
        let state = fixture.state_for(&["~"]);
        run(async {
            for cwd in [json!(5), json!(true), json!({}), json!([])] {
                let body = json!({ "cwd": cwd, "content": "x" }).to_string();
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
    fn user_scope_writes_the_injected_codex_home() {
        let fixture = Fixture::new();
        let state = fixture.state_for(&["~"]);
        let body = json!({ "cwd": "~", "content": "model = \"user\"\n" }).to_string();
        run(async {
            let (status, response) = send(&state, "user", &body).await;
            assert_eq!(status, 200, "{response}");
            let target = fixture.codex_home().join("config.toml");
            let path_token = serde_json::to_string(&text(&target)).unwrap();
            assert!(
                response.ends_with(&format!(r#","path":{path_token}}}"#)),
                "{response}"
            );
        });
        assert_eq!(
            fs::read_to_string(fixture.codex_home().join("config.toml")).unwrap(),
            "model = \"user\"\n"
        );
    }

    #[test]
    fn invalid_toml_is_400_before_any_filesystem_side_effect() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let target = fixture.put("roots/project/.codex/config.toml", "model = \"x\"\n");
        let state = fixture.state_for(&[text(&root)]);
        let body = json!({
            "cwd": text(&root),
            "content": "model = ",
            "mtime": mtime_ms(&target),
        })
        .to_string();
        run(async {
            let (status, response) = send(&state, "project", &body).await;
            assert_eq!(status, 400, "{response}");
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(payload["ok"], json!(false));
            let error = payload["error"].as_str().unwrap();
            assert!(error.starts_with("invalid TOML: "), "{error}");
            assert!(!error.contains('\n'), "{error}");
            assert!(error.contains(" at line "), "{error}");
        });
        assert_eq!(fs::read_to_string(&target).unwrap(), "model = \"x\"\n");
        assert!(backup_dirs(&fixture.backups()).is_empty());
    }

    #[test]
    fn non_string_content_matches_the_measured_iarna_behaviour() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let target = fixture.put("roots/project/.codex/config.toml", "model = \"x\"\n");
        let state = fixture.state_for(&[text(&root)]);
        let root_text = text(&root);
        let body =
            |content: Value| json!({ "cwd": root_text.as_str(), "content": content }).to_string();
        run(async {
            // Numbers, booleans and objects give the parser no input at all,
            // so they reach the write and fail with `content must be a string`.
            for content in [json!(5), json!(0), json!(true), json!({}), json!([])] {
                assert_eq!(
                    send(&state, "project", &body(content.clone())).await,
                    (400, WRITE_FAILED_BODY.to_owned()),
                    "{content}"
                );
            }
            // An array is parsed as its `toString` text, so it can be invalid.
            for content in [json!([1, 2]), json!([{}]), json!(["a"])] {
                let (status, response) = send(&state, "project", &body(content.clone())).await;
                assert_eq!(status, 400, "{content} {response}");
                assert!(
                    response.contains(r#""error":"invalid TOML: "#),
                    "{content} {response}"
                );
            }
            // `["x = 1"]` is valid TOML, so it proceeds to the write and fails
            // there; the file was backed up and left untouched.
            assert_eq!(
                send(&state, "project", &body(json!(["x = 1"]))).await,
                (400, WRITE_FAILED_BODY.to_owned())
            );
        });
        assert_eq!(fs::read_to_string(&target).unwrap(), "model = \"x\"\n");
        assert_eq!(backup_dirs(&fixture.backups()).len(), 1);
    }

    #[test]
    fn surrogate_content_reports_the_unavailable_backend_after_a_backup() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let target = fixture.put("roots/project/.codex/config.toml", "model = \"x\"\n");
        let state = fixture.state_for(&[text(&root)]);
        let body = format!(
            "{{\"cwd\":{},\"content\":\"model = \\\"\\ud800\\\"\"}}",
            serde_json::to_string(&text(&root)).unwrap(),
        );
        run(async {
            assert_eq!(
                send(&state, "project", &body).await,
                (400, BACKEND_UNAVAILABLE_BODY.to_owned())
            );
        });
        assert_eq!(fs::read_to_string(&target).unwrap(), "model = \"x\"\n");
        assert_eq!(backup_dirs(&fixture.backups()).len(), 1);
    }

    #[test]
    fn mtime_uses_javascript_number_semantics_and_force_skips_both_guards() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let target = fixture.put("roots/project/.codex/config.toml", "model = \"x\"\n");
        let state = fixture.state_for(&[text(&root)]);
        let root_text = text(&root);
        let body = |mtime: Value, force: Value| {
            json!({
                "cwd": root_text.as_str(),
                "content": "model = \"y\"\n",
                "mtime": mtime,
                "force": force,
            })
            .to_string()
        };
        run(async {
            // NaN disables the guard and writes.
            assert_eq!(
                send(&state, "project", &body(json!("abc"), json!(false)))
                    .await
                    .0,
                200
            );
            // A numeric string is honoured; 0 ms is stale for any real file.
            assert_eq!(
                send(&state, "project", &body(json!("0"), json!(false))).await,
                (409, CHANGED_BODY.to_owned())
            );
            // Infinity is present and stale in the outer guard.
            assert_eq!(
                send(&state, "project", &body(json!("Infinity"), json!(false))).await,
                (409, CHANGED_BODY.to_owned())
            );
            // An object coerces to NaN and writes.
            assert_eq!(
                send(&state, "project", &body(json!({}), json!(false)))
                    .await
                    .0,
                200
            );
            // force is JavaScript truthiness and skips the backend guard too.
            let stale = json!(mtime_ms(&target) + 60_000.0);
            assert_eq!(
                send(&state, "project", &body(stale.clone(), json!(false))).await,
                (409, CHANGED_BODY.to_owned())
            );
            assert_eq!(
                send(&state, "project", &body(stale, json!("false")))
                    .await
                    .0,
                200
            );
        });
        assert_eq!(fs::read_to_string(&target).unwrap(), "model = \"y\"\n");
    }

    #[test]
    fn duplicate_body_keys_use_the_last_member() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let outside = fixture.0.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let state = fixture.state_for(&[text(&root)]);
        let accepted = format!(
            "{{\"cwd\":{},\"cwd\":{},\"content\":\"model = \\\"y\\\"\\n\"}}",
            serde_json::to_string(&text(&outside)).unwrap(),
            serde_json::to_string(&text(&root)).unwrap(),
        );
        let rejected = format!(
            "{{\"cwd\":{},\"cwd\":{},\"content\":\"model = \\\"y\\\"\\n\"}}",
            serde_json::to_string(&text(&root)).unwrap(),
            serde_json::to_string(&text(&outside)).unwrap(),
        );
        run(async {
            assert_eq!(send(&state, "project", &accepted).await.0, 200);
            assert_eq!(
                send(&state, "project", &rejected).await,
                (400, OUTSIDE_BODY.to_owned())
            );
        });
    }

    #[test]
    fn the_post_backup_guard_rejects_a_newer_file() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let target = fixture.put("roots/project/.codex/config.toml", "model = \"x\"\n");
        let old = SystemTime::now() - Duration::from_secs(120);
        let set_time = |time| {
            File::options()
                .write(true)
                .open(&target)
                .and_then(|file| file.set_times(FileTimes::new().set_modified(time)))
                .unwrap();
        };
        set_time(old);
        let fields = WriteFields {
            cwd: Field::Text(text(&root).encode_utf16().collect()),
            content: Field::Text("model = \"y\"\n".encode_utf16().collect()),
            mtime: Field::Other(json!(mtime_ms(&target))),
            force: false,
        };
        let response = write_with_backup(
            &fixture.state_for(&[text(&root)]),
            "project",
            fields,
            |_, _, _| {
                set_time(old + Duration::from_secs(60));
                None
            },
        );
        assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
        assert_eq!(fs::read_to_string(&target).unwrap(), "model = \"x\"\n");
    }

    #[test]
    fn backups_are_pruned_to_the_five_newest() {
        let fixture = Fixture::new();
        let root = fixture.root();
        fixture.put("roots/project/.codex/config.toml", "0");
        let state = fixture.state_for(&[text(&root)]);
        let root_text = text(&root);
        run(async {
            for index in 1..=7 {
                let body = json!({
                    "cwd": root_text.as_str(),
                    "content": format!("model = \"{index}\"\n"),
                })
                .to_string();
                assert_eq!(send(&state, "project", &body).await.0, 200);
            }
        });
        let dirs = backup_dirs(&fixture.backups());
        assert_eq!(dirs.len(), 1);
        assert_eq!(bak_names(&dirs[0]).len(), 5);
    }

    #[test]
    fn router_builds_with_the_injected_state() {
        let fixture = Fixture::new();
        let _router = super::router(
            fixture.home(),
            fixture.codex_home(),
            fixture.state_dir(),
            fixture.backups(),
            Arc::new(Mutex::new(())),
            fixture.0.clone(),
            Vec::new(),
        );
    }
}
