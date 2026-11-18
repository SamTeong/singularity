//! Config scan routes: `GET /api/config/scan` and `GET /api/codex-config/scan`,
//! mirroring `server/index.mjs:590-595,621-626` -> `findConfigRoots` in
//! `server/config.mjs` / `server/codex-config.mjs`, which delegate to the native
//! `config_read::scan` / `config_read::scan_codex` traversal with cap 20000.
//!
//! Node's `if (!root || !existsSync(root))` gate becomes `400 {"error":"bad root"}`.
//! Fastify yields an array for a repeated `root`, which `existsSync` cannot accept,
//! so only a single non-empty value is a valid root; the existence check and the
//! directory walk both run on the blocking pool.
use crate::http_policy::query_values;
use axum::extract::RawQuery;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use icu_collator::{Collator, options::CollatorOptions};
use icu_locale_core::Locale;
use serde_json::json;
use serde_json::value::RawValue;
use std::path::Path;

const CAP: f64 = 20_000.0;

// VERIFY: config-scan-router
pub fn router() -> Router {
    Router::new()
        .route("/api/config/scan", get(scan_config))
        .route("/api/codex-config/scan", get(scan_codex))
}

async fn scan_config(RawQuery(query): RawQuery) -> Response {
    scan(query, crate::config_read::scan).await
}

async fn scan_codex(RawQuery(query): RawQuery) -> Response {
    scan(query, crate::config_read::scan_codex).await
}

async fn scan(query: Option<String>, find: fn(&str, f64) -> Box<RawValue>) -> Response {
    let Some(root) = single_root(query.as_deref()) else {
        return bad_root();
    };
    match tokio::task::spawn_blocking(move || {
        // `existsSync` is true for files as well as directories; the walk then
        // simply finds no roots under a non-directory, as in Node.
        Path::new(&root).exists().then(|| {
            let raw = find(&root, CAP);
            let mut result: serde_json::Value =
                serde_json::from_str(raw.get()).expect("scan result");
            let locale: Locale = crate::memory_collation::system_locale()
                .parse()
                .expect("valid system locale");
            let collator = Collator::try_new(locale.into(), CollatorOptions::default())
                .expect("available collation");
            if let Some(roots) = result
                .get_mut("roots")
                .and_then(serde_json::Value::as_array_mut)
            {
                roots.sort_by(|a, b| {
                    collator.compare(a.as_str().unwrap_or(""), b.as_str().unwrap_or(""))
                });
            }
            result
        })
    })
    .await
    {
        Ok(Some(result)) => Json(result).into_response(),
        Ok(None) => bad_root(),
        Err(_) => internal_error(),
    }
}

// VERIFY: config-scan-root-gate
/// A missing, empty or repeated `root` is not a string query value.
fn single_root(query: Option<&str>) -> Option<String> {
    match query_values(query?, "root").as_slice() {
        [root] if !root.is_empty() => Some(root.clone()),
        _ => None,
    }
}

fn bad_root() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "bad root" })),
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
    use super::{scan_codex, scan_config};
    use axum::body::to_bytes;
    use axum::extract::RawQuery;
    use axum::response::Response;
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "http-config-scan-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn put(&self, rel: &str) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "").unwrap();
            path
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

    fn encode(value: &str) -> String {
        let mut encoded = String::new();
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        encoded
    }

    /// `scan_config` builds hit paths one component at a time, so the expected
    /// strings must be built the same way rather than by joining a `a/b` literal.
    fn join(root: &str, rel: &str) -> String {
        rel.split('/')
            .fold(PathBuf::from(root), |path, part| path.join(part))
            .to_string_lossy()
            .into_owned()
    }

    async fn send(query: Option<String>, codex: bool) -> (u16, String) {
        let response: Response = if codex {
            scan_codex(RawQuery(query)).await
        } else {
            scan_config(RawQuery(query)).await
        };
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn roots_of(body: &str) -> Vec<String> {
        let payload: Value = serde_json::from_str(body).unwrap();
        assert_eq!(payload["truncated"], Value::Bool(false), "{body}");
        payload["roots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|root| root.as_str().unwrap().to_owned())
            .collect()
    }

    // VERIFY: config-scan-discovery
    #[test]
    fn both_scans_discover_expected_roots() {
        let fixture = Fixture::new("discover");
        fixture.put("project-a/.claude/settings.json");
        fixture.put("project-b/.claude/settings.local.json");
        fixture.put("nested/deep/.claude/settings.json");
        fixture.put("project-a/.codex/config.toml");
        fixture.put("unrelated/file.txt");
        let root = fixture.0.to_string_lossy().into_owned();
        run(async {
            let query = Some(format!("root={}", encode(&root)));
            let (status, body) = send(query.clone(), false).await;
            assert_eq!(status, 200);
            assert_eq!(
                roots_of(&body),
                vec![
                    join(&root, "nested/deep"),
                    join(&root, "project-a"),
                    join(&root, "project-b"),
                ]
            );

            let (status, body) = send(query, true).await;
            assert_eq!(status, 200);
            assert_eq!(roots_of(&body), vec![join(&root, "project-a")]);
        });
    }

    // VERIFY: config-scan-bad-root
    #[test]
    fn missing_empty_repeated_and_nonexistent_roots_are_rejected() {
        let fixture = Fixture::new("bad-root");
        let root = fixture.0.to_string_lossy().into_owned();
        let absent = fixture.0.join("absent").to_string_lossy().into_owned();
        let encoded = encode(&root);
        let queries = [
            None,
            Some("root=".to_owned()),
            Some(format!("root={encoded}&root={encoded}")),
            Some(format!("other={encoded}")),
            Some(format!("root={}", encode(&absent))),
        ];
        run(async {
            for codex in [false, true] {
                for query in queries.clone() {
                    let (status, body) = send(query.clone(), codex).await;
                    assert_eq!(status, 400, "{query:?}");
                    assert_eq!(body, r#"{"error":"bad root"}"#, "{query:?}");
                }
            }
        });
    }
}
