//! Memory list and search routes. The caller injects the Node-compatible
//! home, cwd and per-drive cwd, the app state directory and the system locale.
//! Unlike file reads and writes, listing accepts a caller-selected root. ICU4X
//! ordering can differ from Node's ICU version, including which hits reach the cap.
use crate::http_policy::query_values;
use crate::transcripts::TranscriptRawText;
use crate::wiki_root::resolve_units;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct ListState {
    state_dir: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
    locale: String,
    lock: Arc<Mutex<()>>,
}

pub fn router(
    state_dir: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    drive_cwds: Vec<(u16, PathBuf)>,
    locale: String,
    lock: Arc<Mutex<()>>,
) -> Router {
    let state = ListState {
        state_dir,
        home,
        cwd,
        drive_cwds,
        locale,
        lock,
    };
    Router::new()
        .route("/api/memory/files", get(files))
        .route("/api/memory/search", get(search))
        .with_state(state)
}

async fn files(State(state): State<ListState>, RawQuery(query): RawQuery) -> Response {
    run(state, query, false).await
}

async fn search(State(state): State<ListState>, RawQuery(query): RawQuery) -> Response {
    run(state, query, true).await
}

async fn run(state: ListState, query: Option<String>, search: bool) -> Response {
    tokio::task::spawn_blocking(move || respond(&state, query.as_deref(), search))
        .await
        .unwrap_or_else(|_| error("Internal Server Error"))
}

fn error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "statusCode": 500, "error": "Internal Server Error", "message": message,
        })),
    )
        .into_response()
}

fn respond(state: &ListState, query: Option<&str>, search: bool) -> Response {
    let guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
    let roots = query.map(|q| query_values(q, "root")).unwrap_or_default();
    if roots.len() > 1 {
        return error("p.startsWith is not a function");
    }
    let units = match roots.first().filter(|root| !root.is_empty()) {
        Some(root) => root.encode_utf16().collect(),
        None => match crate::memory_root::get_root(&state.state_dir).units() {
            Ok(units) => units,
            Err(_) => return error("Rust Memory list failed"),
        },
    };
    let root = resolve_units(
        &units,
        &state.home,
        &state.cwd,
        &state.drive_cwds,
        cfg!(windows),
        true,
    );
    drop(guard);
    let queries = query.map(|q| query_values(q, "q")).unwrap_or_default();
    if search && (queries.is_empty() || (queries.len() == 1 && queries[0].is_empty())) {
        return Json(json!({ "results": [], "capped": false })).into_response();
    }
    let Ok(root) = String::from_utf16(&root) else {
        return error("Rust backend returned an uncorrelated response");
    };
    let raw = crate::memory::list_files(&root);
    let Ok(Value::Array(mut files)) = serde_json::from_str::<Value>(raw.get()) else {
        let payload: Value = serde_json::from_str(raw.get()).unwrap_or(Value::Null);
        return error(
            payload["error"]
                .as_str()
                .unwrap_or("Rust Memory list failed"),
        );
    };
    if let Err(message) = crate::memory_collation::sort_files(&mut files, &state.locale) {
        return error(&message);
    }
    if !search {
        return Json(json!({"files": files})).into_response();
    }
    let needle = if queries.len() == 1 { &queries[0] } else { "" };
    let raw = crate::memory::search(&Value::Array(files), needle);
    let Ok(mut result) = serde_json::from_str::<Value>(raw.get()) else {
        return error("Rust Memory search failed");
    };
    let Some(hits) = result["results"].as_array_mut() else {
        return error("Rust Memory search failed");
    };
    // Preserve JS slice's lone-surrogate result by serializing each text as raw JSON.
    let mut tokens = Vec::with_capacity(hits.len());
    for hit in hits.iter() {
        let Some(text) = hit["text"].as_str() else {
            return error("Rust Memory search failed");
        };
        let text = text.trim_matches(js_whitespace);
        let Some(token) = serde_json::to_string(text)
            .ok()
            .and_then(|token| TranscriptRawText::from_json_token(token).ok())
            .and_then(|text| text.slice_units(0, 200).ok())
        else {
            return error("Rust Memory search failed");
        };
        tokens.push(json_hit(hit, token));
    }
    let body = SearchResult {
        results: tokens,
        capped: result["capped"].as_bool().unwrap_or(false),
    };
    Json(body).into_response()
}

#[derive(serde::Serialize)]
struct SearchResult {
    results: Vec<SearchHit>,
    capped: bool,
}
#[derive(serde::Serialize)]
struct SearchHit {
    project: Value,
    file: Value,
    path: Value,
    line: Value,
    text: TranscriptRawText,
}
fn json_hit(hit: &Value, text: TranscriptRawText) -> SearchHit {
    SearchHit {
        project: hit["project"].clone(),
        file: hit["file"].clone(),
        path: hit["path"].clone(),
        line: hit["line"].clone(),
        text,
    }
}
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn staged_routers_merge_file_methods_with_one_lock() {
        let state = PathBuf::from("state");
        let home = PathBuf::from("home");
        let cwd = PathBuf::from("cwd");
        let _router = crate::http_memory_root::MemoryServices {
            state_dir: state,
            home,
            cwd,
            drive_cwds: vec![],
            backups_dir: PathBuf::from("backups"),
            locale: "en-SG".into(),
        }
        .router();
    }

    #[tokio::test]
    async fn assembled_routes_use_isolated_root_for_read_write_and_search() {
        let name = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("memory-http-{}-{name}", std::process::id()));
        let cleanup = Cleanup(base.clone());
        let state = base.join("state");
        let root = base.join("projects");
        let file = root.join("project/memory/fact.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "old").unwrap();
        let memory = crate::http_memory_root::MemoryServices {
            state_dir: state.clone(),
            home: base.clone(),
            cwd: base.clone(),
            drive_cwds: vec![],
            backups_dir: base.join("backups"),
            locale: "en-SG".into(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(![4317, 5317, 6317].contains(&address.port()));
        let mut services = crate::http_server::HttpServices::new(
            state,
            crate::usage_report::Request {
                reports_dir: String::new(),
                env: json!({}),
            },
        );
        services.memory = Some(memory);
        let app = crate::http_server::router(
            crate::http_policy::HttpPolicy {
                daemon_port: address.port(),
                vite_port: 5317,
                token: Some("memory-test-token".into()),
            },
            services,
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let url = format!("http://{address}/api/memory");
        let unauthenticated = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(
            unauthenticated
                .get(format!("{url}/root"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-sing-token", "memory-test-token".parse().unwrap());
        let client = reqwest::Client::builder()
            .no_proxy()
            .default_headers(headers)
            .build()
            .unwrap();
        let root = root.to_str().unwrap();
        let file = file.to_str().unwrap();
        assert!(
            client
                .put(format!("{url}/root"))
                .json(&json!({"root": root}))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()["ok"]
                .as_bool()
                .unwrap()
        );
        assert!(
            client
                .put(format!("{url}/file"))
                .json(&json!({"path": file, "root": root, "content": "needle"}))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()["ok"]
                .as_bool()
                .unwrap()
        );
        let invalid_content = format!(
            "{{\"path\":{},\"root\":{},\"content\":\"\\ud800\"}}",
            serde_json::to_string(file).unwrap(),
            serde_json::to_string(root).unwrap()
        );
        let rejected = client
            .put(format!("{url}/file"))
            .header("content-type", "application/json")
            .body(invalid_content)
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        let read = client
            .get(format!("{url}/file"))
            .query(&[("path", file), ("root", root)])
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(read["content"], "needle");
        let files = client
            .get(format!("{url}/files"))
            .query(&[("root", root)])
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(files["files"].as_array().unwrap().len(), 1);
        let search = client
            .get(format!("{url}/search"))
            .query(&[("root", root), ("q", "needle")])
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(search["results"].as_array().unwrap().len(), 1);
        let mut previous = "needle".to_owned();
        for index in 0..8 {
            let next = if index % 2 == 0 { "a" } else { "b" }.repeat(96 * 1024);
            let read_request = client
                .get(format!("{url}/file"))
                .query(&[("path", file), ("root", root)])
                .send();
            let write_request = client
                .put(format!("{url}/file"))
                .json(&json!({"path": file, "root": root, "content": next, "force": true}))
                .send();
            let (read, write) = tokio::join!(read_request, write_request);
            assert_eq!(write.unwrap().status(), StatusCode::OK);
            let read: Value = read.unwrap().json().await.unwrap();
            let content = read["content"].as_str().unwrap();
            assert!(content == previous || content == next);
            previous = next;
        }
        let denied = client
            .get(format!("{url}/file"))
            .query(&[("path", file), ("root", base.to_str().unwrap())])
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::BAD_REQUEST);
        server.abort();
        let _ = server.await;
        drop(cleanup);
    }

    #[tokio::test]
    async fn lists_in_locale_order_and_slices_search_text_as_utf16() {
        let name = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("memory-list-{}-{name}", std::process::id()));
        let root = base.join("projects");
        let memory = root.join("project/memory");
        fs::create_dir_all(&memory).unwrap();
        fs::write(memory.join("B.md"), format!("{}😀\n", "a".repeat(199))).unwrap();
        fs::write(memory.join("a.md"), "unmatched").unwrap();
        let state = ListState {
            state_dir: base.join("state"),
            home: base.clone(),
            cwd: base.clone(),
            drive_cwds: vec![],
            locale: "en-SG".into(),
            lock: Arc::new(Mutex::new(())),
        };
        let root = root.to_string_lossy().replace('\\', "/");
        let query = format!("root={root}");
        let response = respond(&state, Some(&query), false);
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["files"][0]["file"], "a.md");
        assert_eq!(value["files"][1]["file"], "B.md");
        let response = respond(&state, Some(&format!("{query}&q=aaa")), true);
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(body.contains("\\ud83d"), "{body}");
        assert!(!body.contains("\\ude00"), "{body}");
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn empty_query_skips_listing_and_search_caps_at_300() {
        let name = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("memory-cap-{}-{name}", std::process::id()));
        let root = base.join("projects");
        let memory = root.join("project/memory");
        fs::create_dir_all(&memory).unwrap();
        fs::write(memory.join("hits.md"), "needle\n".repeat(301)).unwrap();
        let state = ListState {
            state_dir: base.join("state"),
            home: base.clone(),
            cwd: base.clone(),
            drive_cwds: vec![],
            locale: "en-SG".into(),
            lock: Arc::new(Mutex::new(())),
        };
        let root = root.to_string_lossy().replace('\\', "/");
        let response = respond(&state, Some(&format!("root={root}&q=needle")), true);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["results"].as_array().unwrap().len(), 300);
        assert_eq!(value["capped"], true);
        let blocked = base.join("not-a-directory");
        fs::write(&blocked, "x").unwrap();
        let blocked = blocked.to_string_lossy().replace('\\', "/");
        let response = respond(&state, Some(&format!("root={blocked}&q=")), true);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value, json!({"results": [], "capped": false}));
        let response = respond(&state, Some(&format!("root={blocked}&q=&q=")), true);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        fs::create_dir_all(&state.state_dir).unwrap();
        fs::write(
            state.state_dir.join("memory-root.json"),
            r#"{"root":"\ud800"}"#,
        )
        .unwrap();
        assert_eq!(respond(&state, None, true).status(), StatusCode::OK);
        let response = respond(&state, Some("q=x"), true);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value["message"],
            "Rust backend returned an uncorrelated response"
        );
        fs::remove_dir_all(base).unwrap();
    }
}
