// Claude config search: `POST /api/config/search`, mirroring
// `server/index.mjs:598-601` -> `config.mjs:searchConfig` and the `configSearch`
// bridge in `server/rust-backend.mjs` (`text.slice(0, 200)`, then
// `results.sort((a, b) => a.path.localeCompare(b.path))`).
//
// Body contract (`req.body || {}`): only an object body can carry fields. `q`
// goes through `String(q || '')` and `toLowerCase()`; an empty needle answers
// `{"results":[]}` before any root is touched. `roots` is iterated with
// `for ... of`: a string yields its code points, an array its elements, a falsy
// value nothing, and any other truthy value is not iterable, which reproduces
// Node's TypeError as a Fastify 500 (`(roots || []) is not iterable`). Each
// root goes through `scopePaths`: a leading `~` expands against the injected
// home, the project/local paths come from `join_config`, and a non-string root
// throws inside `scopePaths` and is skipped. `config_read::search` reads the
// files and drops duplicate paths, so the same root passed twice yields one hit.
//
// Results keep the native hit shape (`cwd`, `scope`, `path`, `line`, `text`) in
// that key order. `text` is sliced to 200 UTF-16 units exactly like the bridge's
// `slice(0, 200)` — which can split a surrogate pair — so that one field is
// emitted as a raw JSON string, lone code units escaped as `\udXXX` the way
// `JSON.stringify` writes them. Ordering is the bridge's `localeCompare`, here
// the host ICU collator at its default options (stable, like `Array#sort`).
//
// Parity limits: a lone surrogate escape anywhere in the body decodes as U+FFFD
// in the routing value (`http_body::parse_raw`), while Node keeps the lone code
// unit; the needle is lowercased once in JavaScript form and again inside
// `config_read::search`, which is idempotent for the shipped Unicode tables.
use crate::config_editor_paths::join_config;
use crate::http_body::parse_raw;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use icu_collator::{Collator, options::CollatorOptions};
use icu_locale_core::Locale;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::borrow::Cow;
use std::path::PathBuf;

const TRUNCATE_UNITS: usize = 200;
// V8's message for `for (const cwd of roots || [])` on a truthy non-iterable.
const ROOTS_ERROR: &str = "(roots || []) is not iterable";

#[derive(Clone)]
struct Search {
    home: String,
    windows: bool,
}

pub fn router(home: PathBuf) -> Router {
    Router::new()
        .route("/api/config/search", post(search_config))
        .with_state(Search {
            home: home.to_string_lossy().into_owned(),
            windows: cfg!(windows),
        })
}

async fn search_config(State(state): State<Search>, request: Request<Body>) -> Response {
    let body = match parse_raw(request).await {
        Ok(body) => body.value,
        Err(response) => return response,
    };
    let (roots, q) = match &body {
        Value::Object(map) => (map.get("roots"), map.get("q")),
        _ => (None, None),
    };
    let needle = needle(q);
    if needle.is_empty() {
        return json_reply(r#"{"results":[]}"#.to_owned());
    }
    let scans = match scopes(roots, &state.home, state.windows) {
        Ok(scans) => scans,
        Err(()) => return roots_not_iterable(),
    };
    let result = tokio::task::spawn_blocking(move || {
        let hits = crate::config_read::search(&scans, &needle);
        let mut hits: Vec<SearchHit> =
            serde_json::from_str(hits.get()).expect("config search payload");
        sort_hits(&mut hits);
        results_json(&hits)
    })
    .await;
    match result {
        Ok(document) => json_reply(document),
        Err(_) => internal_error(),
    }
}

fn json_reply(document: String) -> Response {
    Json(RawValue::from_string(document).expect("results document")).into_response()
}

/// The native `config_read::search` hit, in the same key order.
#[derive(serde::Deserialize)]
struct SearchHit {
    cwd: String,
    scope: String,
    path: String,
    line: u64,
    text: String,
}

/// `String(q || '')` followed by `toLowerCase()`.
fn needle(q: Option<&Value>) -> String {
    match q {
        Some(value) if js_truthy(value) => js_string(value).to_lowercase(),
        _ => String::new(),
    }
}

/// `for (const cwd of roots || [])` reduced to the scan list it builds.
///
/// `Err(())` is the non-iterable TypeError. A non-string element is skipped:
/// `scopePaths` starts with `c === '~'` and then `c.startsWith`, which throws
/// inside the loop's `try`, and the loop continues.
fn scopes(roots: Option<&Value>, home: &str, windows: bool) -> Result<Value, ()> {
    let mut scans = Vec::new();
    match roots {
        None => {}
        Some(Value::Array(items)) => {
            for value in items {
                if let Some(cwd) = value.as_str() {
                    scans.push(scan_entry(cwd, home, windows));
                }
            }
        }
        // A string is iterated by code point, not by UTF-16 unit.
        Some(Value::String(text)) => {
            for character in text.chars() {
                scans.push(scan_entry(&character.to_string(), home, windows));
            }
        }
        Some(value) if !js_truthy(value) => {}
        Some(_) => return Err(()),
    }
    Ok(Value::Array(scans))
}

fn scan_entry(cwd: &str, home: &str, windows: bool) -> Value {
    let expanded = expand_tilde(cwd, home);
    json!({
        "cwd": cwd,
        "project": join_config(&expanded, ".claude", "settings.json", windows),
        "local": join_config(&expanded, ".claude", "settings.local.json", windows),
    })
}

/// `normalize(homedir() + cwd.slice(1))` for a `~` root; `join_config` normalizes
/// the joined result again, so the pre-normalization is absorbed.
fn expand_tilde<'a>(cwd: &'a str, home: &'a str) -> Cow<'a, str> {
    if cwd == "~" {
        return Cow::Borrowed(home);
    }
    if cwd.starts_with("~/") || cwd.starts_with("~\\") {
        return Cow::Owned(format!("{home}{}", &cwd[1..]));
    }
    Cow::Borrowed(cwd)
}

fn sort_hits(hits: &mut [SearchHit]) {
    let locale: Locale = crate::memory_collation::system_locale()
        .parse()
        .expect("valid system locale");
    let collator =
        Collator::try_new(locale.into(), CollatorOptions::default()).expect("available collation");
    hits.sort_by(|a, b| collator.compare(&a.path, &b.path));
}

fn results_json(hits: &[SearchHit]) -> String {
    let mut out = String::from(r#"{"results":["#);
    for (index, hit) in hits.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(r#"{"cwd":"#);
        push_json_string(&mut out, &hit.cwd);
        out.push_str(r#","scope":"#);
        push_json_string(&mut out, &hit.scope);
        out.push_str(r#","path":"#);
        push_json_string(&mut out, &hit.path);
        out.push_str(r#","line":"#);
        out.push_str(&hit.line.to_string());
        out.push_str(r#","text":"#);
        push_json_text(&mut out, &truncated_units(&hit.text));
        out.push('}');
    }
    out.push_str("]}");
    out
}

/// `text.slice(0, 200)` on the UTF-16 unit sequence.
fn truncated_units(text: &str) -> Vec<u16> {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.truncate(TRUNCATE_UNITS);
    units
}

fn push_json_string(out: &mut String, value: &str) {
    out.push_str(&serde_json::to_string(value).expect("string serialization"));
}

/// The escaped body of a JSON string literal, without the surrounding quotes.
fn push_json_escaped(out: &mut String, value: &str) {
    let quoted = serde_json::to_string(value).expect("string serialization");
    out.push_str(&quoted[1..quoted.len() - 1]);
}

/// A JSON string literal for a UTF-16 unit slice. Complete pairs become their
/// character; a lone unit — possible when `slice` splits a pair — is escaped as
/// `\udXXX`, matching `JSON.stringify`.
fn push_json_text(out: &mut String, units: &[u16]) {
    out.push('"');
    let mut run = String::new();
    let mut index = 0;
    while index < units.len() {
        match decoded_unit(units, index) {
            Some((character, width)) => {
                run.push(character);
                index += width;
            }
            None => {
                push_json_run(out, &mut run);
                out.push_str(&format!("\\u{:04x}", units[index]));
                index += 1;
            }
        }
    }
    push_json_run(out, &mut run);
    out.push('"');
}

fn decoded_unit(units: &[u16], index: usize) -> Option<(char, usize)> {
    let unit = units[index];
    match unit {
        0xD800..=0xDBFF => {
            let low = *units.get(index + 1)?;
            if !(0xDC00..=0xDFFF).contains(&low) {
                return None;
            }
            let code = 0x10000 + ((unit as u32 - 0xD800) << 10) + (low as u32 - 0xDC00);
            char::from_u32(code).map(|character| (character, 2))
        }
        0xDC00..=0xDFFF => None,
        _ => char::from_u32(unit as u32).map(|character| (character, 1)),
    }
}

fn push_json_run(out: &mut String, run: &mut String) {
    if !run.is_empty() {
        push_json_escaped(out, run);
        run.clear();
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => json_number(number) != 0.0,
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)` for the JSON values a body field can hold.
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

fn roots_not_iterable() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500,
            "error": "Internal Server Error",
            "message": ROOTS_ERROR,
        })),
    )
        .into_response()
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
    use super::{Search, search_config};
    use axum::body::{Body, to_bytes};
    use axum::extract::State;
    use axum::http::{Request, header};
    use axum::response::Response;
    use icu_collator::{Collator, options::CollatorOptions};
    use icu_locale_core::Locale;
    use serde_json::{Value, json};
    use std::cmp::Ordering;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "http-claude-config-search-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn dir(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn home(&self) -> PathBuf {
            self.dir("home")
        }

        fn write(&self, cwd: &Path, file: &str, content: &str) -> PathBuf {
            let path = cwd.join(".claude").join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }

        fn state(&self) -> Search {
            Search {
                home: self.home().to_string_lossy().into_owned(),
                windows: cfg!(windows),
            }
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

    fn body(value: Value) -> String {
        serde_json::to_string(&value).unwrap()
    }

    async fn send_with(state: &Search, content_type: Option<&str>, body: &str) -> (u16, String) {
        let mut builder = Request::builder().method("POST").uri("/api/config/search");
        if let Some(value) = content_type {
            builder = builder.header(header::CONTENT_TYPE, value);
        }
        let request = builder.body(Body::from(body.to_owned())).unwrap();
        let response: Response = search_config(State(state.clone()), request).await;
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    async fn send(state: &Search, body: &str) -> (u16, String) {
        send_with(state, Some("application/json"), body).await
    }

    fn empty() -> (u16, String) {
        (200, r#"{"results":[]}"#.to_owned())
    }

    #[test]
    fn empty_needle_answers_before_touching_roots() {
        let fixture = Fixture::new("empty-needle");
        let project = fixture.dir("project");
        fixture.write(&project, "settings.json", "theme here\n");
        let root = json!(project.to_string_lossy());
        run(async {
            for body in [
                "null".to_owned(),
                r#""abc""#.to_owned(),
                "[1,2]".to_owned(),
                "{}".to_owned(),
                body(json!({ "roots": [root.clone()] })),
                body(json!({ "roots": [root.clone()], "q": "" })),
                body(json!({ "roots": [root.clone()], "q": 0 })),
                body(json!({ "roots": [root.clone()], "q": -0.0 })),
                body(json!({ "roots": [root.clone()], "q": false })),
                body(json!({ "roots": [root.clone()], "q": null })),
                body(json!({ "roots": [root.clone()], "q": [] })),
                body(json!({ "roots": [root.clone()], "q": [[]] })),
                // A truthy non-iterable root is only reached once the needle is nonempty.
                body(json!({ "roots": 5 })),
                body(json!({ "roots": { "a": 1 }, "q": [] })),
            ] {
                assert_eq!(send(&fixture.state(), &body).await, empty(), "{body}");
            }
        });
    }

    #[test]
    fn needle_uses_javascript_string_coercion_and_lowercasing() {
        let fixture = Fixture::new("needle");
        let project = fixture.dir("project");
        fixture.write(
            &project,
            "settings.json",
            "TRUE marker\nnums 1,2 here\nobject [object Object]\n0 zero\n",
        );
        let root = json!(project.to_string_lossy());
        run(async {
            for (q, line, text) in [
                (json!(true), 1, "TRUE marker"),
                (json!([1, 2]), 2, "nums 1,2 here"),
                (json!([[1, [2]]]), 2, "nums 1,2 here"),
                (json!({ "a": 1 }), 3, "object [object Object]"),
                (json!("0"), 4, "0 zero"),
            ] {
                let request = body(json!({ "roots": [root.clone()], "q": q }));
                let (status, response) = send(&fixture.state(), &request).await;
                assert_eq!(status, 200, "{request}");
                let payload: Value = serde_json::from_str(&response).unwrap();
                let results = payload["results"].as_array().unwrap();
                assert_eq!(results.len(), 1, "{response}");
                assert_eq!(results[0]["line"], json!(line), "{response}");
                assert_eq!(results[0]["text"], json!(text), "{response}");
                assert_eq!(results[0]["scope"], json!("project"), "{response}");
                assert_eq!(results[0]["cwd"], root, "{response}");
            }
        });
    }

    #[test]
    fn roots_iteration_skips_non_strings_and_rejects_truthy_non_iterables() {
        let fixture = Fixture::new("roots");
        let alpha = fixture.dir("alpha");
        fixture.write(&alpha, "settings.json", "theme alpha\n");
        let home = fixture.home();
        fixture.write(&home, "settings.local.json", "theme home\n");
        let alpha = json!(alpha.to_string_lossy());
        run(async {
            // Non-string members throw inside `scopePaths` and are skipped.
            let request = body(json!({
                "roots": [alpha.clone(), 5, null, true, ["x"], { "y": 2 }, "~"],
                "q": "theme",
            }));
            let (status, response) = send(&fixture.state(), &request).await;
            assert_eq!(status, 200, "{request}");
            let payload: Value = serde_json::from_str(&response).unwrap();
            let results = payload["results"].as_array().unwrap();
            let cwds: Vec<&str> = results
                .iter()
                .map(|hit| hit["cwd"].as_str().unwrap())
                .collect();
            assert_eq!(cwds, [alpha.as_str().unwrap(), "~"], "{response}");
            let scopes: Vec<&str> = results
                .iter()
                .map(|hit| hit["scope"].as_str().unwrap())
                .collect();
            assert_eq!(scopes, ["project", "local"], "{response}");

            // A string is iterated by code point; the single-character roots
            // resolve against the process cwd and hold no settings file.
            for roots in [json!("ab"), json!(""), json!(null), json!([])] {
                let request = body(json!({ "roots": roots, "q": "theme" }));
                assert_eq!(send(&fixture.state(), &request).await, empty(), "{request}");
            }
            let request = body(json!({ "q": "theme" }));
            assert_eq!(send(&fixture.state(), &request).await, empty(), "{request}");

            // `for ... of` on a truthy non-iterable throws a Fastify 500.
            for roots in [json!(5), json!({}), json!(true), json!({ "roots": [] })] {
                let request = body(json!({ "roots": roots, "q": "theme" }));
                assert_eq!(
                    send(&fixture.state(), &request).await,
                    (
                        500,
                        r#"{"statusCode":500,"error":"Internal Server Error","message":"(roots || []) is not iterable"}"#
                            .to_owned()
                    ),
                    "{request}"
                );
            }
        });
    }

    #[test]
    fn duplicate_roots_dedupe_by_path() {
        let fixture = Fixture::new("dedupe");
        let project = fixture.dir("project");
        fixture.write(&project, "settings.json", "theme here\n");
        let root = json!(project.to_string_lossy());
        run(async {
            let request =
                body(json!({ "roots": [root.clone(), root.clone(), root], "q": "theme" }));
            let (status, response) = send(&fixture.state(), &request).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(
                payload["results"].as_array().unwrap().len(),
                1,
                "{response}"
            );
        });
    }

    #[test]
    fn long_lines_slice_to_two_hundred_utf16_units_and_may_split_a_surrogate() {
        let fixture = Fixture::new("truncate");
        let split = fixture.dir("split");
        fixture.write(&split, "settings.json", &format!("{}😀", "x".repeat(199)));
        let pair = fixture.dir("pair");
        fixture.write(
            &pair,
            "settings.json",
            &format!("{}😀{}", "x".repeat(198), "y".repeat(5)),
        );
        let split = json!(split.to_string_lossy());
        let pair = json!(pair.to_string_lossy());
        run(async {
            let (status, response) = send(
                &fixture.state(),
                &body(json!({ "roots": [split], "q": "x" })),
            )
            .await;
            assert_eq!(status, 200);
            // 199 units before the emoji: `slice(0, 200)` keeps the high surrogate alone.
            assert!(
                response.contains(&format!(r#""text":"{}\ud83d""#, "x".repeat(199))),
                "{response}"
            );

            // 198 units + a whole pair: the slice lands after the pair and keeps it.
            let (status, response) = send(
                &fixture.state(),
                &body(json!({ "roots": [pair], "q": "x" })),
            )
            .await;
            assert_eq!(status, 200);
            assert!(
                response.contains(&format!(r#""text":"{}😀""#, "x".repeat(198))),
                "{response}"
            );
        });
    }

    #[test]
    fn results_sort_by_path_with_locale_compare_not_byte_order() {
        let fixture = Fixture::new("sort");
        let alpha = fixture.dir("alpha");
        let beta = fixture.dir("Beta");
        fixture.write(&alpha, "settings.json", "theme alpha\n");
        fixture.write(&beta, "settings.json", "theme beta\n");
        let alpha = json!(alpha.to_string_lossy());
        let beta = json!(beta.to_string_lossy());
        run(async {
            let request = body(json!({ "roots": [beta, alpha], "q": "theme" }));
            let (status, response) = send(&fixture.state(), &request).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&response).unwrap();
            let paths: Vec<&str> = payload["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|hit| hit["path"].as_str().unwrap())
                .collect();
            assert_eq!(paths.len(), 2, "{response}");
            // `localeCompare` ranks `alpha` before `Beta`; byte order would not.
            assert!(paths[0].contains("alpha"), "{response}");
            assert!(paths[1].contains("Beta"), "{response}");
        });
    }

    // The route uses the host locale; this pins the collator options against
    // JavaScript's `localeCompare` defaults for a representative locale.
    #[test]
    fn collator_matches_javascript_locale_compare_for_case_and_accents() {
        let locale: Locale = "en-US".parse().unwrap();
        let collator = Collator::try_new(locale.into(), CollatorOptions::default()).unwrap();
        assert_eq!(collator.compare("alpha", "Beta"), Ordering::Less);
        assert_eq!(collator.compare("éclair", "fig"), Ordering::Less);
        assert_eq!(collator.compare("a", "A"), Ordering::Less);
        assert_eq!(collator.compare("same", "same"), Ordering::Equal);
    }

    #[test]
    fn tilde_roots_expand_against_the_injected_home() {
        let fixture = Fixture::new("tilde");
        let home = fixture.home();
        fixture.write(&home, "settings.json", "theme home\n");
        let sub = home.join("sub");
        fixture.write(&sub, "settings.json", "theme sub\n");
        run(async {
            let request = body(json!({ "roots": ["~", "~/sub"], "q": "theme" }));
            let (status, response) = send(&fixture.state(), &request).await;
            assert_eq!(status, 200);
            let payload: Value = serde_json::from_str(&response).unwrap();
            let results = payload["results"].as_array().unwrap();
            let mut cwds: Vec<&str> = results
                .iter()
                .map(|hit| hit["cwd"].as_str().unwrap())
                .collect();
            cwds.sort_unstable();
            assert_eq!(cwds, ["~", "~/sub"], "{response}");
            let home_text = home.to_string_lossy();
            for hit in results {
                assert!(
                    hit["path"].as_str().unwrap().starts_with(&*home_text),
                    "{hit}"
                );
            }
        });
    }

    #[test]
    fn malformed_bodies_use_the_shared_fastify_envelopes() {
        let fixture = Fixture::new("bodies");
        run(async {
            assert_eq!(
                send(&fixture.state(), "{").await,
                (
                    400,
                    r#"{"statusCode":400,"code":"FST_ERR_CTP_INVALID_JSON_BODY","error":"Bad Request","message":"Body is not valid JSON but content-type is set to 'application/json'"}"#
                        .to_owned()
                )
            );
            assert_eq!(
                send_with(&fixture.state(), None, "{}").await.0,
                415,
                "a body without a content type is unsupported"
            );
        });
    }

    #[test]
    fn router_builds_with_the_injected_home() {
        let fixture = Fixture::new("router");
        let _router = super::router(fixture.home());
    }
}
