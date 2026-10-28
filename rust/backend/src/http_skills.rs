//! Skills viewer routes: `GET`/`PUT /api/skills/roots`, `GET /api/skills`,
//! `GET`/`PUT /api/skill` — `server/index.mjs:853-858` -> `server/skills.mjs:203-248`
//! over `skills.rs`, `skills_roots.rs` and the Node-side pieces that stayed in
//! `skills.mjs`: `NAME_RE`, `IMG_EXT`, the flatten/`FILES_CAP`/`SKILLS_CAP` sort,
//! the backup + double mtime guard and the status mapping.
//!
//! Node sorted with `localeCompare`, so each directory level is ordered with an
//! ICU collator over the host locale (same approach as `memory_collation.rs`);
//! ICU data can differ from Node's for non-ASCII names.
//!
//! Paths are server-derived from (root, scope, skill[, file]); the client never
//! supplies one. Root tokens from the persisted file and the `PUT` reply keep
//! their original JSON spelling (Node re-serializes, so only hand-edited escape
//! spellings differ). Relative roots resolve against the process cwd, exactly as
//! the stdio bridge child did.

use crate::http_body::parse_raw;
use crate::http_policy::query_values;
use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use icu_collator::{Collator, options::CollatorOptions};
use icu_locale_core::Locale;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const ROOTS_FILE: &str = "skills-roots.json";
const LEGACY_ROOTS_FILE: &str = "skills-root.json";
// Backstops from skills.mjs: per scope, and per skill file tree.
const SKILLS_CAP: usize = 200;
const FILES_CAP: usize = 100;
const IMG_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"];
const LIST_UNAVAILABLE: &str = "skills list backend unavailable";
const READ_UNAVAILABLE: &str = "skills read backend unavailable";

#[derive(Clone)]
struct SkillsState {
    state_dir: PathBuf,
    default_root: PathBuf,
    backups_dir: PathBuf,
    locale: String,
    // One lock for the roots file, matching the single-child bridge queue.
    lock: Arc<Mutex<()>>,
}

// VERIFY: skills-router-injection
/// The host supplies the state dir (roots files), the Node home (default root
/// `~/.claude/skills`), the backups dir and a shared lock.
pub fn router(
    state_dir: PathBuf,
    home: PathBuf,
    backups_dir: PathBuf,
    lock: Arc<Mutex<()>>,
) -> Router {
    let state = SkillsState {
        state_dir,
        default_root: home.join(".claude").join("skills"),
        backups_dir,
        locale: crate::memory_collation::system_locale(),
        lock,
    };
    Router::new()
        .route(
            "/api/skills/roots",
            get(get_roots_route).put(put_roots_route),
        )
        .route("/api/skills", get(list_route))
        .route("/api/skill", get(read_route).put(write_route))
        .with_state(state)
}

fn roots_file(state: &SkillsState) -> PathBuf {
    state.state_dir.join(ROOTS_FILE)
}

fn legacy_roots_file(state: &SkillsState) -> PathBuf {
    state.state_dir.join(LEGACY_ROOTS_FILE)
}

fn default_root_string(state: &SkillsState) -> String {
    state.default_root.to_string_lossy().into_owned()
}

async fn get_roots_route(State(state): State<SkillsState>) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::skills_roots::get_roots(
            &roots_file(&state),
            &legacy_roots_file(&state),
            &default_root_string(&state),
        )
    })
    .await;
    match result {
        Ok(roots_json) => match RawValue::from_string(roots_json) {
            Ok(roots) => Json(RootsReply { roots: &roots }).into_response(),
            Err(_) => internal_error(),
        },
        Err(_) => internal_error(),
    }
}

async fn put_roots_route(State(state): State<SkillsState>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let (roots_is_array, roots_json) = roots_member(&body);
    let result = tokio::task::spawn_blocking(move || {
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        crate::skills_roots::set_roots(&roots_file(&state), roots_is_array, roots_json.as_deref())
    })
    .await;
    match result {
        Ok(crate::skills_roots::SetRootsResult::Success { roots_json }) => {
            match RawValue::from_string(roots_json) {
                Ok(roots) => Json(SetReply {
                    ok: true,
                    roots: Some(&roots),
                    error: None,
                })
                .into_response(),
                Err(_) => internal_error(),
            }
        }
        Ok(crate::skills_roots::SetRootsResult::BadRoots) => Json(SetReply {
            ok: false,
            roots: None,
            error: Some("bad roots".to_owned()),
        })
        .into_response(),
        // Storage errors surface verbatim, as the bridge did.
        Ok(crate::skills_roots::SetRootsResult::StorageFailure(error)) => Json(SetReply {
            ok: false,
            roots: None,
            error: Some(error.to_string()),
        })
        .into_response(),
        Err(_) => internal_error(),
    }
}

#[derive(Serialize)]
struct RootsReply<'a> {
    roots: &'a RawValue,
}

#[derive(Serialize)]
struct SetReply<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    roots: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// VERIFY: skills-roots-body
/// `req.body?.roots` for the Node handler: a JSON array drops non-string
/// elements (`roots.filter`) before the native dedupe/cap; anything else is a
/// non-array and reports `bad roots`.
fn roots_member(body: &crate::http_body::RawBody) -> (bool, Option<String>) {
    if !matches!(
        body.value
            .as_object()
            .and_then(|object| object.get("roots")),
        Some(Value::Array(_))
    ) {
        return (false, None);
    }
    let tokens = body
        .raw
        .as_deref()
        .and_then(|raw| crate::wiki_root::raw_fields(raw.get()).ok().flatten())
        .and_then(|fields| {
            fields
                .into_iter()
                .rev()
                .find(|(key, _)| key == &"roots".encode_utf16().collect::<Vec<_>>())
                .map(|(_, value)| value)
        })
        .and_then(|token| serde_json::from_str::<Vec<Box<RawValue>>>(token.get()).ok());
    let Some(tokens) = tokens else {
        return (true, None);
    };
    let kept = tokens
        .iter()
        .map(|token| token.get())
        .filter(|token| token.starts_with('"'))
        .collect::<Vec<_>>()
        .join(",");
    (true, Some(format!("[{kept}]")))
}

async fn list_route(State(state): State<SkillsState>, RawQuery(query): RawQuery) -> Response {
    let values = query
        .as_deref()
        .map(|query| query_values(query, "root"))
        .unwrap_or_default();
    let result = tokio::task::spawn_blocking(move || list_payload(&state, &values)).await;
    match result {
        Ok(Ok(reply)) => Json(reply).into_response(),
        Ok(Err(())) | Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": LIST_UNAVAILABLE })),
        )
            .into_response(),
    }
}

#[derive(Serialize)]
struct ListReply {
    scopes: Vec<Scope>,
    flat: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct Scope {
    name: String,
    skills: Vec<SkillItem>,
    capped: bool,
}

#[derive(Serialize)]
struct SkillItem {
    name: String,
    description: String,
    raw: String,
    files: Vec<String>,
}

/// `listSkillsOn`: resolve the root, list via `skills.rs`, then sort scopes and
/// skills with `localeCompare` and apply `SKILLS_CAP`/the file flatten.
fn list_payload(state: &SkillsState, values: &[String]) -> Result<ListReply, ()> {
    let collator = collator(&state.locale)?;
    let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    let root = root_value(state, values);
    if !js_truthy(&root) {
        return Ok(ListReply {
            scopes: Vec::new(),
            flat: false,
            error: Some("skills root not configured".to_owned()),
        });
    }
    let payload = crate::skills::list(&root);
    if let Some(error) = payload["error"].as_str() {
        return Ok(ListReply {
            scopes: Vec::new(),
            flat: false,
            error: Some(error.to_owned()),
        });
    }
    let mut scopes = payload["scopes"].as_array().cloned().unwrap_or_default();
    scopes.sort_by(|a, b| collator.compare(field(a, "name"), field(b, "name")));
    let scopes = scopes
        .iter()
        .map(|scope| {
            let mut skills = scope["skills"].as_array().cloned().unwrap_or_default();
            skills.sort_by(|a, b| collator.compare(field(a, "name"), field(b, "name")));
            let capped = skills.len() >= SKILLS_CAP;
            let skills = skills
                .iter()
                .take(SKILLS_CAP)
                .map(|skill| SkillItem {
                    name: field(skill, "name").to_owned(),
                    description: field(skill, "description").to_owned(),
                    raw: field(skill, "raw").to_owned(),
                    files: skill_files(&skill["tree"], &collator),
                })
                .collect();
            Scope {
                name: field(scope, "name").to_owned(),
                skills,
                capped,
            }
        })
        .collect();
    Ok(ListReply {
        scopes,
        flat: payload["flat"].as_bool() == Some(true),
        error: None,
    })
}

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("")
}

/// `skillFiles`: sort one level, skip a top-level `SKILL.md`, DFS-flatten with
/// `FILES_CAP`; relative paths are POSIX-normalized.
fn skill_files(tree: &Value, collator: &icu_collator::CollatorBorrowed<'static>) -> Vec<String> {
    let mut out = Vec::new();
    let mut entries = entries_of(tree);
    entries.sort_by(|a, b| collator.compare(field(a, "n"), field(b, "n")));
    for entry in entries {
        if out.len() >= FILES_CAP {
            break;
        }
        let name = field(entry, "n");
        if name == "SKILL.md" {
            continue;
        }
        if entry["f"].as_bool() == Some(true) {
            out.push(posix(name));
        } else {
            flatten_entries(&entry["c"], name, &mut out, collator);
        }
    }
    out
}

fn flatten_entries(
    entries: &Value,
    prefix: &str,
    out: &mut Vec<String>,
    collator: &icu_collator::CollatorBorrowed<'static>,
) {
    let mut entries = entries_of(entries);
    entries.sort_by(|a, b| collator.compare(field(a, "n"), field(b, "n")));
    for entry in entries {
        if out.len() >= FILES_CAP {
            return;
        }
        let name = field(entry, "n");
        let rel = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        if entry["f"].as_bool() == Some(true) {
            out.push(posix(&rel));
        } else {
            flatten_entries(&entry["c"], &rel, out, collator);
        }
    }
}

fn entries_of(tree: &Value) -> Vec<&Value> {
    tree.as_array()
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

/// `rel.split(/[\\/]/).join('/')`.
fn posix(rel: &str) -> String {
    rel.replace('\\', "/")
}

async fn read_route(State(state): State<SkillsState>, RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    let root_values = query_values(&query, "root");
    let scope = query_value(&query, "scope");
    let skill = query_value(&query, "skill");
    let file = query_value(&query, "file");
    let flat = query_values(&query, "flat") == ["1"];
    let result = tokio::task::spawn_blocking(move || {
        read_payload(&state, &root_values, &scope, &skill, &file, flat)
    })
    .await;
    match result {
        Ok(payload) => {
            let status = if payload["ok"].as_bool() == Some(true) {
                StatusCode::OK
            } else if payload["error"].as_str() == Some("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            (status, Json(payload)).into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": READ_UNAVAILABLE })),
        )
            .into_response(),
    }
}

/// `readSkillOn`/`readSkillFileOn`: resolve the root, re-check the bare names
/// (`NAME_RE`) and each `file` segment, then dispatch to `skills.rs`.
fn read_payload(
    state: &SkillsState,
    root_values: &[String],
    scope: &Value,
    skill: &Value,
    file: &Value,
    flat: bool,
) -> Value {
    let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    let root = root_value(state, root_values);
    if !js_truthy(&root) {
        return json!({ "ok": false, "error": "skills root not configured" });
    }
    if !name_ok(skill) {
        return json!({ "ok": false, "error": "bad name" });
    }
    if !flat && !name_ok(scope) {
        return json!({ "ok": false, "error": "bad name" });
    }
    if js_truthy(file) {
        let Some(text) = file.as_str().filter(|text| !text.is_empty()) else {
            return json!({ "ok": false, "error": "bad file" });
        };
        if text.split('/').any(|segment| !name_ok_str(segment)) {
            return json!({ "ok": false, "error": "bad file" });
        }
        return crate::skills::read_skill_file(&root, scope, skill, file, &Value::Bool(flat));
    }
    crate::skills::read_skill(&root, scope, skill, &Value::Bool(flat))
}

async fn write_route(State(state): State<SkillsState>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let result = tokio::task::spawn_blocking(move || write_payload(&state, &body.value)).await;
    match result {
        Ok(payload) => {
            let status = if payload["ok"].as_bool() == Some(true) {
                StatusCode::OK
            } else if payload["error"].as_str() == Some("changed on disk") {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            (status, Json(payload)).into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": "skills write backend unavailable" })),
        )
            .into_response(),
    }
}

/// `writeSkillOn`/`writeSkillFileOn` + `writeSkillContent`: derive the path,
/// refuse image edits, run the mtime guard twice around the backup, then let
/// `skills::write_file` run the final guard adjacent to the write.
fn write_payload(state: &SkillsState, body: &Value) -> Value {
    let object = body.as_object();
    let member = |name: &str| object.and_then(|object| object.get(name));
    let flat = matches!(member("flat"), Some(Value::Bool(true)))
        || matches!(member("flat"), Some(Value::String(value)) if value == "1");
    let root = match member("root") {
        Some(root) if js_truthy(root) => root.clone(),
        _ => Value::String(first_configured_root(state)),
    };
    let scope = member("scope").cloned().unwrap_or(Value::Null);
    let skill = member("skill").cloned().unwrap_or(Value::Null);
    let file = member("file").cloned().unwrap_or(Value::Null);
    let content = member("content").cloned().unwrap_or(Value::Null);

    if !js_truthy(&root) {
        return json!({ "ok": false, "error": "skills root not configured" });
    }
    if !name_ok(&skill) {
        return json!({ "ok": false, "error": "bad name" });
    }
    if !flat && !name_ok(&scope) {
        return json!({ "ok": false, "error": "bad name" });
    }
    let file_text = if js_truthy(&file) {
        let Some(file) = file.as_str().filter(|file| !file.is_empty()) else {
            return json!({ "ok": false, "error": "bad file" });
        };
        Some(file.to_owned())
    } else {
        None
    };
    let Some(content) = content.as_str() else {
        return json!({ "ok": false, "error": "bad content" });
    };
    if let Some(file) = &file_text
        && file.split('/').any(|segment| !name_ok_str(segment))
    {
        return json!({ "ok": false, "error": "bad file" });
    }
    let Some(root) = root.as_str() else {
        // `path.join` throws on a non-string root; the handler's catch returns
        // the TypeError message with a 400.
        return json!({ "ok": false, "error": join_error(&root) });
    };
    let mut path = base_dir(root, scope.as_str(), skill.as_str().unwrap_or(""), flat);
    match &file_text {
        Some(file) => {
            for segment in file.split('/') {
                path = path.join(segment);
            }
        }
        None => path = path.join("SKILL.md"),
    }
    let raw_path = path.to_string_lossy().into_owned();
    if file_text.is_some() {
        // Image files are binary and not editable through this JSON route.
        let ext = raw_path
            .rfind('.')
            .map(|at| raw_path[at + 1..].to_lowercase())
            .unwrap_or_else(|| raw_path.to_lowercase());
        if IMG_EXT.contains(&ext.as_str()) {
            return json!({ "ok": false, "error": "cannot edit image" });
        }
    }
    let mtime = member("mtime").filter(|value| !matches!(value, Value::Null));
    let force = member("force").is_some_and(js_truthy);
    write_content(
        state,
        &path,
        &raw_path,
        content,
        mtime.map(js_number),
        force,
    )
}

fn base_dir(root: &str, scope: Option<&str>, skill: &str, flat: bool) -> PathBuf {
    if flat {
        Path::new(root).join(skill)
    } else {
        Path::new(root)
            .join(scope.unwrap_or(""))
            .join(".claude")
            .join("skills")
            .join(skill)
    }
}

fn write_content(
    state: &SkillsState,
    path: &Path,
    raw_path: &str,
    content: &str,
    mtime: Option<f64>,
    force: bool,
) -> Value {
    let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    if changed_on_disk(path, mtime, force) {
        return json!({ "ok": false, "error": "changed on disk" });
    }
    crate::memory_backup::backup_file(raw_path, path, &state.backups_dir);
    // Re-check after the backup: a concurrent save may have landed meanwhile.
    if changed_on_disk(path, mtime, force) {
        return json!({ "ok": false, "error": "changed on disk" });
    }
    let final_mtime = mtime.filter(|value| !value.is_nan());
    crate::skills::write_file(Some(raw_path), Some(content), final_mtime, force)
}

/// `mtime != null && !force && existsSync(p) && Math.abs(statSync(p).mtimeMs - mtime) > 1`.
fn changed_on_disk(path: &Path, mtime: Option<f64>, force: bool) -> bool {
    let (Some(expected), false) = (mtime, force) else {
        return false;
    };
    if !path.exists() {
        return false;
    }
    match modified_ms(path) {
        Some(actual) => (actual - expected).abs() > 1.0,
        None => false,
    }
}

fn modified_ms(path: &Path) -> Option<f64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => Some(since.as_secs_f64() * 1000.0),
        Err(before) => Some(-before.duration().as_secs_f64() * 1000.0),
    }
}

fn join_error(value: &Value) -> String {
    match value {
        Value::Array(_) => {
            "The \"path\" argument must be of type string. Received an instance of Array".to_owned()
        }
        Value::Object(_) => {
            "The \"path\" argument must be of type string. Received an instance of Object"
                .to_owned()
        }
        other => format!(
            "The \"path\" argument must be of type string. Received {}",
            js_type(other)
        ),
    }
}

fn js_type(value: &Value) -> String {
    match value {
        Value::Bool(value) => format!("type boolean ({value})"),
        Value::Number(value) => format!("type number ({value})"),
        _ => "type undefined".to_owned(),
    }
}

// VERIFY: skills-root-resolution
/// `root || ((await getSkillsRoots(b))[0] || '')`: a query root is used as given
/// (duplicate params become an array), otherwise the first persisted root.
fn root_value(state: &SkillsState, values: &[String]) -> Value {
    match values {
        [] => Value::String(first_configured_root(state)),
        [only] if only.is_empty() => Value::String(first_configured_root(state)),
        [only] => Value::String(only.clone()),
        many => Value::Array(many.iter().cloned().map(Value::String).collect()),
    }
}

fn first_configured_root(state: &SkillsState) -> String {
    let roots_json = crate::skills_roots::get_roots(
        &roots_file(state),
        &legacy_roots_file(state),
        &default_root_string(state),
    );
    let Ok(items) = serde_json::from_str::<Vec<Box<RawValue>>>(&roots_json) else {
        return String::new();
    };
    let Some(first) = items.first().map(|item| item.get()) else {
        return String::new();
    };
    if !first.starts_with('"') {
        return String::new();
    }
    crate::transcripts::TranscriptRawText::from_json_token(first.to_owned())
        .ok()
        .and_then(|text| text.units().ok())
        .map(|units| String::from_utf16_lossy(&units))
        .unwrap_or_default()
}

/// One query parameter as `req.query.<name>`: absent -> null, one occurrence ->
/// string, several -> array.
fn query_value(query: &str, name: &str) -> Value {
    match query_values(query, name) {
        values if values.is_empty() => Value::Null,
        values if values.len() == 1 => Value::String(values.into_iter().next().unwrap_or_default()),
        values => Value::Array(values.into_iter().map(Value::String).collect()),
    }
}

/// `NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/` — bare names only, never all dots.
fn name_ok(value: &Value) -> bool {
    value.as_str().is_some_and(name_ok_str)
}

fn name_ok_str(name: &str) -> bool {
    !name.is_empty()
        && !name.bytes().all(|byte| byte == b'.')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JavaScript `Number(value)` for the `mtime` guard.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => {
            let text = text.trim_matches(is_js_space);
            if text.is_empty() {
                0.0
            } else {
                // Prefixed radixes (`0x10`) are not parsed; they fall through as
                // NaN, which skips the guard exactly like a non-numeric string.
                text.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        _ => f64::NAN,
    }
}

fn is_js_space(character: char) -> bool {
    character.is_whitespace() || character == '\u{feff}'
}

fn collator(locale: &str) -> Result<icu_collator::CollatorBorrowed<'static>, ()> {
    let locale: Locale = locale.parse().map_err(|_| ())?;
    Collator::try_new(locale.into(), CollatorOptions::default()).map_err(|_| ())
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": "Internal Server Error",
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("http-skills-{}-{unique}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn state(&self) -> SkillsState {
            SkillsState {
                state_dir: self.0.join("state"),
                default_root: self.0.join("home/.claude/skills"),
                backups_dir: self.0.join("backups"),
                locale: "en-US".to_owned(),
                lock: Arc::new(Mutex::new(())),
            }
        }

        fn put(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn encode(text: &str) -> String {
        let mut out = String::new();
        for byte in text.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
                out.push(byte as char);
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    }

    fn query(pairs: &[(&str, &str)]) -> RawQuery {
        RawQuery(Some(
            pairs
                .iter()
                .map(|(key, value)| format!("{key}={}", encode(value)))
                .collect::<Vec<_>>()
                .join("&"),
        ))
    }

    fn put_request(body: &str) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri("/api/skill")
            .header("content-type", "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap()
    }

    async fn collect(response: Response) -> (u16, Value) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    async fn get_roots(state: &SkillsState) -> (u16, Value) {
        collect(get_roots_route(State(state.clone())).await).await
    }

    async fn put_roots(state: &SkillsState, body: &str) -> (u16, Value) {
        collect(put_roots_route(State(state.clone()), put_request(body)).await).await
    }

    async fn list(state: &SkillsState, pairs: &[(&str, &str)]) -> (u16, Value) {
        collect(list_route(State(state.clone()), query(pairs)).await).await
    }

    async fn read(state: &SkillsState, pairs: &[(&str, &str)]) -> (u16, Value) {
        collect(read_route(State(state.clone()), query(pairs)).await).await
    }

    async fn write(state: &SkillsState, body: &str) -> (u16, Value) {
        collect(write_route(State(state.clone()), put_request(body)).await).await
    }

    // VERIFY: skills-roots-default-and-migration
    #[test]
    fn roots_default_migrate_persist_and_report_bad_input() {
        let fixture = Fixture::new();
        let state = fixture.state();
        run(async {
            let default = fixture.0.join("home/.claude/skills");
            assert_eq!(
                get_roots(&state).await,
                (200, json!({ "roots": [default.to_string_lossy()] }))
            );

            fs::create_dir_all(&state.state_dir).unwrap();
            fs::write(
                state.state_dir.join(LEGACY_ROOTS_FILE),
                serde_json::to_vec(&json!({ "root": "/legacy" })).unwrap(),
            )
            .unwrap();
            assert_eq!(
                get_roots(&state).await,
                (200, json!({ "roots": ["/legacy"] }))
            );

            assert_eq!(
                put_roots(&state, r#"{"roots":["/a","/a","",3,"/b"]}"#).await,
                (200, json!({ "ok": true, "roots": ["/a", "/b"] }))
            );
            assert_eq!(
                fs::read_to_string(state.state_dir.join(ROOTS_FILE)).unwrap(),
                r#"{"roots":["/a","/b"]}"#
            );
            assert_eq!(
                get_roots(&state).await,
                (200, json!({ "roots": ["/a", "/b"] }))
            );

            assert_eq!(
                put_roots(&state, r#"{"roots":"bad"}"#).await,
                (200, json!({ "ok": false, "error": "bad roots" }))
            );
            assert_eq!(
                put_roots(&state, "null").await,
                (200, json!({ "ok": false, "error": "bad roots" }))
            );
            assert_eq!(
                put_roots(&state, r#"{"roots":["/c"],"roots":null}"#).await,
                (200, json!({ "error": "bad roots", "ok": false }))
            );
        });
    }

    // VERIFY: skills-roots-storage-failure
    #[test]
    fn roots_storage_failure_keeps_status_200_with_verbatim_error() {
        let fixture = Fixture::new();
        let state = fixture.state();
        fs::create_dir_all(state.state_dir.join(ROOTS_FILE)).unwrap();
        run(async {
            let (status, body) = put_roots(&state, r#"{"roots":["/a"]}"#).await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], json!(false));
            assert!(body.get("roots").is_none());
            assert!(body["error"].as_str().is_some_and(|text| !text.is_empty()));
        });
    }

    // VERIFY: skills-list-flatten-and-caps
    #[test]
    fn list_sorts_scopes_and_skills_and_flattens_files() {
        let fixture = Fixture::new();
        let state = fixture.state();
        let root = fixture.0.join("scopes");
        fixture.put(
            "scopes/coding/.claude/skills/freeze/SKILL.md",
            "---\nname: freeze\ndescription: Lock edits.\n---\nbody",
        );
        fixture.put("scopes/coding/.claude/skills/freeze/scripts/run.mjs", "x");
        fixture.put(
            "scopes/coding/.claude/skills/freeze/references/notes.md",
            "x",
        );
        fixture.put("scopes/coding/.claude/skills/noisy/SKILL.md", "# noisy");
        fixture.put("scopes/empty/.claude/keep.txt", "");
        let root_text = root.to_string_lossy().into_owned();
        run(async {
            let (status, body) = list(&state, &[("root", &root_text)]).await;
            assert_eq!(status, 200);
            assert_eq!(body["flat"], json!(false));
            assert_eq!(
                body["scopes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|scope| scope["name"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["coding"]
            );
            let coding = &body["scopes"][0];
            assert_eq!(coding["capped"], json!(false));
            assert_eq!(coding["skills"][0]["name"], json!("freeze"));
            assert_eq!(coding["skills"][0]["description"], json!("Lock edits."));
            assert_eq!(
                coding["skills"][0]["files"],
                json!(["references/notes.md", "scripts/run.mjs"])
            );
            assert_eq!(
                coding["skills"][1],
                json!({
                    "name": "noisy", "description": "", "raw": "# noisy", "files": [],
                })
            );
            // Key order matches the Node reply (Fastify serializes in insertion order).
            assert!(
                serde_json::to_string(&body)
                    .unwrap()
                    .starts_with(r#"{"scopes":[{"name":"coding","skills":[{"name":"freeze""#)
            );
        });
    }

    // VERIFY: skills-list-errors
    #[test]
    fn list_reports_missing_unconfigured_flat_and_duplicate_roots() {
        let fixture = Fixture::new();
        let state = fixture.state();
        fixture.put("flat/declawed/SKILL.md", "---\nname: declawed\n---\n");
        fixture.put("flat/not-a-skill/note.txt", "");
        let flat_root = fixture.0.join("flat").to_string_lossy().into_owned();
        let absent = fixture.0.join("absent").to_string_lossy().into_owned();
        run(async {
            let (status, body) = list(&state, &[("root", &flat_root)]).await;
            assert_eq!(status, 200);
            assert_eq!(body["flat"], json!(true));
            assert_eq!(body["scopes"][0]["name"], json!("flat"));
            assert_eq!(body["scopes"][0]["skills"].as_array().unwrap().len(), 1);

            assert_eq!(
                list(&state, &[("root", &absent)]).await,
                (
                    200,
                    json!({
                        "scopes": [], "flat": false, "error": "skills root not found",
                    })
                )
            );
            // An empty configured root string is the only "not configured" path.
            fs::create_dir_all(&state.state_dir).unwrap();
            fs::write(state.state_dir.join(ROOTS_FILE), br#"{"roots":[""]}"#).unwrap();
            assert_eq!(
                list(&state, &[]).await,
                (
                    200,
                    json!({
                        "scopes": [], "flat": false, "error": "skills root not configured",
                    })
                )
            );
            // Duplicate `root` params arrive as an array, which the native list
            // treats as an unusable root path.
            assert_eq!(
                list(&state, &[("root", "/a"), ("root", "/b")]).await,
                (
                    200,
                    json!({
                        "scopes": [], "flat": false, "error": "skills root not found",
                    })
                )
            );
        });
    }

    // VERIFY: skills-skill-read-statuses
    #[test]
    fn skill_read_returns_payloads_and_maps_statuses() {
        let fixture = Fixture::new();
        let state = fixture.state();
        fixture.put(
            "grouped/coding/.claude/skills/freeze/SKILL.md",
            "---\nname: freeze\ndescription: Lock edits.\ntriggers:\n  - freeze edits\n---\n\n# freeze\n",
        );
        fixture.put("grouped/coding/.claude/skills/freeze/scripts/run.mjs", "x");
        fixture.put("grouped/coding/.claude/skills/freeze/pic.png", "png");
        let root = fixture.0.join("grouped").to_string_lossy().into_owned();
        run(async {
            let (status, body) = read(
                &state,
                &[("root", &root), ("scope", "coding"), ("skill", "freeze")],
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["name"], json!("freeze"));
            assert_eq!(body["triggers"], json!(["freeze edits"]));
            assert!(body["mtime"].as_f64().unwrap() > 0.0);

            let (status, body) = read(
                &state,
                &[
                    ("root", &root),
                    ("scope", "coding"),
                    ("skill", "freeze"),
                    ("file", "scripts/run.mjs"),
                ],
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["type"], json!("code"));

            let (status, body) = read(
                &state,
                &[
                    ("root", &root),
                    ("scope", "coding"),
                    ("skill", "freeze"),
                    ("file", "pic.png"),
                ],
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["type"], json!("image"));
            assert!(body.get("content").is_none());

            assert_eq!(
                read(
                    &state,
                    &[("root", &root), ("scope", "coding"), ("skill", "nope")]
                )
                .await
                .0,
                404
            );
            for (scope, skill, file) in [
                ("..", "freeze", ""),
                ("coding", "..", ""),
                ("coding", ".", ""),
                ("coding", "freeze", "../SKILL.md"),
                ("coding", "freeze", "scripts/../run.mjs"),
            ] {
                let mut pairs = vec![("root", root.as_str()), ("scope", scope), ("skill", skill)];
                if !file.is_empty() {
                    pairs.push(("file", file));
                }
                let (status, body) = read(&state, &pairs).await;
                assert_eq!(status, 400, "{scope}/{skill}/{file}");
                assert_eq!(body["ok"], json!(false));
            }
            // Duplicate query params arrive as arrays and fail the type checks.
            let (status, body) = read(
                &state,
                &[
                    ("root", &root),
                    ("scope", "coding"),
                    ("skill", "a"),
                    ("skill", "b"),
                ],
            )
            .await;
            assert_eq!(status, 400);
            assert_eq!(body["error"], json!("bad name"));
        });
    }

    // VERIFY: skills-skill-write-guards
    #[test]
    fn skill_write_round_trips_backs_up_and_guards_mtime() {
        let fixture = Fixture::new();
        let state = fixture.state();
        let root = fixture.0.join("grouped");
        fixture.put("grouped/coding/.claude/skills/noisy/SKILL.md", "prior");
        let root_text = root.to_string_lossy().into_owned();
        let skill_path = root.join("coding/.claude/skills/noisy/SKILL.md");
        run(async {
            let (status, body) = write(
                &state,
                &format!(
                    r#"{{"root":{},"scope":"coding","skill":"noisy","content":"技能 🧪"}}"#,
                    serde_json::to_string(&root_text).unwrap()
                ),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], json!(true));
            assert!(body["mtime"].as_f64().unwrap() > 0.0);
            assert_eq!(fs::read_to_string(&skill_path).unwrap(), "技能 🧪");
            let backups = fs::read_dir(&state.backups_dir).unwrap().count();
            assert_eq!(backups, 1, "one hashed backup dir for the written path");

            let stale = body["mtime"].as_f64().unwrap();
            fs::write(&skill_path, "external").unwrap();
            let future = SystemTime::now() + std::time::Duration::from_secs(5);
            fs::File::options()
                .write(true)
                .open(&skill_path)
                .unwrap()
                .set_modified(future)
                .unwrap();
            let (status, body) = write(
                &state,
                &format!(
                    r#"{{"root":{},"scope":"coding","skill":"noisy","content":"v2","mtime":{stale}}}"#,
                    serde_json::to_string(&root_text).unwrap()
                ),
            )
            .await;
            assert_eq!(status, 409);
            assert_eq!(body, json!({ "ok": false, "error": "changed on disk" }));
            assert_eq!(fs::read_to_string(&skill_path).unwrap(), "external");

            let (status, body) = write(
                &state,
                &format!(
                    r#"{{"root":{},"scope":"coding","skill":"noisy","content":"forced","mtime":{stale},"force":true}}"#,
                    serde_json::to_string(&root_text).unwrap()
                ),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], json!(true));
            assert_eq!(fs::read_to_string(&skill_path).unwrap(), "forced");
        });
    }

    // VERIFY: skills-skill-write-rejections
    #[test]
    fn skill_write_rejects_bad_names_images_and_missing_parents() {
        let fixture = Fixture::new();
        let state = fixture.state();
        let root = fixture.0.join("grouped");
        fixture.put("grouped/coding/.claude/skills/freeze/scripts/run.mjs", "x");
        let root_text = root.to_string_lossy().into_owned();
        let root_json = serde_json::to_string(&root_text).unwrap();
        run(async {
            for body in [
                format!(r#"{{"root":{root_json},"scope":"..","skill":"x","content":"y"}}"#),
                format!(r#"{{"root":{root_json},"scope":"coding","skill":"..","content":"y"}}"#),
                format!(r#"{{"root":{root_json},"scope":"coding","skill":"nope","content":null}}"#),
                format!(
                    r#"{{"root":{root_json},"scope":"coding","skill":"freeze","file":"../SKILL.md","content":"x"}}"#
                ),
                format!(
                    r#"{{"root":{root_json},"scope":"coding","skill":"freeze","file":"a.png","content":"x"}}"#
                ),
                format!(
                    r#"{{"root":{root_json},"scope":"coding","skill":"freeze","file":"missing/child.txt","content":"x"}}"#
                ),
            ] {
                let (status, payload) = write(&state, &body).await;
                assert_eq!(status, 400, "{body}");
                assert_eq!(payload["ok"], json!(false), "{body}");
            }
            assert_eq!(
                fs::read_to_string(root.join("coding/.claude/skills/freeze/scripts/run.mjs"))
                    .unwrap(),
                "x"
            );
            assert!(
                !root.join("coding/.claude/skills/freeze/missing").exists(),
                "parents are never created"
            );

            // Flat layout writes straight under <root>/<skill>.
            fixture.put("flat/declawed/SKILL.md", "prior");
            let flat = fixture.0.join("flat").to_string_lossy().into_owned();
            let (status, body) = write(
                &state,
                &format!(
                    r#"{{"root":{},"skill":"declawed","content":"flat ✓","flat":"1"}}"#,
                    serde_json::to_string(&flat).unwrap()
                ),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(body["ok"], json!(true));
            assert_eq!(
                fs::read_to_string(fixture.0.join("flat/declawed/SKILL.md")).unwrap(),
                "flat ✓"
            );
        });
    }

    #[test]
    fn name_re_matches_the_node_lookahead() {
        for name in ["a", "A1._-", "..a", ".skill"] {
            assert!(name_ok_str(name), "{name}");
        }
        for name in ["", ".", "..", "...", "a/b", "a\\b", "a b", "é", "a:b"] {
            assert!(!name_ok_str(name), "{name}");
        }
    }

    #[test]
    fn js_number_ports_the_mtime_coercion() {
        assert_eq!(js_number(&json!("12.5")), 12.5);
        assert_eq!(js_number(&json!(" 12 ")), 12.0);
        assert_eq!(js_number(&json!("")), 0.0);
        assert_eq!(js_number(&json!(true)), 1.0);
        assert_eq!(js_number(&json!(false)), 0.0);
        assert!(js_number(&json!("12px")).is_nan());
        assert!(!changed_on_disk(
            Path::new("missing-file"),
            Some(f64::NAN),
            false
        ));
    }
}
