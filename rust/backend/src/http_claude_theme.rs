// Claude UI theme HTTP surface: `GET /api/claude/theme`, mirroring
// `server/index.mjs` -> `config.mjs:claudeTheme`.
//
// Reads the global `<home>/.claude/settings.json` and resolves Claude's own UI
// theme to `light` (the last `theme` member is a string whose JavaScript
// lowercase contains `light`) or `dark` (everything else, including any read,
// parse or decode failure). File bytes use the same UTF-8 replacement
// (`String::from_utf8_lossy`) as `config_read::read`.
//
// The document is validated as raw JSON and only the last `theme` member is
// extracted, so escaped unpaired surrogates anywhere in the file — including
// unrelated fields — cannot invalidate an otherwise valid object, and
// `JSON.parse`'s last-duplicate-wins rule holds without a lossy
// `serde_json::Value` hop.
use crate::transcripts::TranscriptRawText;
use crate::wiki_root::raw_fields;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::path::{Path, PathBuf};

const LIGHT: &str = "light";
const DARK: &str = "dark";
const THEME_MEMBER: &str = "theme";
// `t.toLowerCase().includes('light')` in `config.mjs`.
const LIGHT_MARKER: &str = "light";

#[derive(Clone)]
struct Theme {
    settings: PathBuf,
}

#[derive(serde::Serialize)]
struct ThemeReply {
    theme: &'static str,
}

pub fn router(home: PathBuf) -> Router {
    Router::new()
        .route("/api/claude/theme", get(get_theme))
        .with_state(Theme {
            settings: home.join(".claude").join("settings.json"),
        })
}

async fn get_theme(State(state): State<Theme>) -> Response {
    let theme = tokio::task::spawn_blocking(move || theme_from_file(&state.settings)).await;
    match theme {
        Ok(theme) => Json(ThemeReply { theme }).into_response(),
        // Fastify's default 500 envelope; Node never reaches this (claudeTheme catches all).
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "statusCode": 500,
                "error": "Internal Server Error",
                "message": "Internal Server Error",
            })),
        )
            .into_response(),
    }
}

/// `config_read::read` substitutes U+FFFD for invalid UTF-8, then `JSON.parse`
/// either yields a `theme` string or throws; both the empty content Node sees for
/// a missing file and any unreadable file land on `dark`.
fn theme_from_file(path: &Path) -> &'static str {
    match std::fs::read(path) {
        Ok(bytes) => theme_from_settings(&String::from_utf8_lossy(&bytes)),
        Err(_) => DARK,
    }
}

fn theme_from_settings(text: &str) -> &'static str {
    let Some(token) = last_theme_token(text) else {
        return DARK;
    };
    let Ok(theme) = TranscriptRawText::from_json_token(token) else {
        return DARK;
    };
    match theme.find_case_insensitive(LIGHT_MARKER) {
        Ok(Some(_)) => LIGHT,
        _ => DARK,
    }
}

/// The last top-level `theme` member as its raw JSON token, when that member is a
/// string. A non-object document, another type (including `auto`, which `claude`
/// resolves by itself and lands on `dark` here) and a non-string last duplicate
/// all yield `None`.
fn last_theme_token(text: &str) -> Option<String> {
    let key = THEME_MEMBER.encode_utf16().collect::<Vec<_>>();
    raw_fields(text)
        .ok()
        .flatten()?
        .into_iter()
        .rev()
        .find(|(name, _)| name == &key)
        .filter(|(_, value)| value.get().starts_with('"'))
        .map(|(_, value)| value.get().to_owned())
}

#[cfg(test)]
mod tests {
    use super::{DARK, LIGHT, Theme, get_theme, router, theme_from_file, theme_from_settings};
    use axum::body::to_bytes;
    use axum::extract::State;
    use axum::response::Response;
    use std::fs;
    use std::path::PathBuf;
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
            let path = std::env::temp_dir().join(format!(
                "http-claude-theme-{}-{unique}-{id}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn home(&self) -> PathBuf {
            self.0.join("home")
        }

        fn settings_path(&self) -> PathBuf {
            self.home().join(".claude").join("settings.json")
        }

        fn write(&self, text: &str) {
            let path = self.settings_path();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn state(&self) -> Theme {
            Theme {
                settings: self.settings_path(),
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

    async fn collect(response: Response) -> (u16, String) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    async fn send_get(state: &Theme) -> (u16, String) {
        collect(get_theme(State(state.clone())).await).await
    }

    fn light_body() -> (u16, String) {
        (200, r#"{"theme":"light"}"#.to_owned())
    }

    fn dark_body() -> (u16, String) {
        (200, r#"{"theme":"dark"}"#.to_owned())
    }

    #[test]
    fn missing_or_unreadable_settings_resolve_to_dark() {
        let fixture = Fixture::new();
        run(async {
            // No `home/.claude` at all: Node reads empty content and `JSON.parse` throws.
            assert_eq!(send_get(&fixture.state()).await, dark_body());
            assert!(!fixture.home().exists());

            // An empty file is empty content too.
            fixture.write("");
            assert_eq!(send_get(&fixture.state()).await, dark_body());

            // A directory where the file should be is an unreadable file.
            fs::remove_file(fixture.settings_path()).unwrap();
            fs::create_dir(fixture.settings_path()).unwrap();
            assert_eq!(send_get(&fixture.state()).await, dark_body());
        });
    }

    #[test]
    fn invalid_json_and_non_object_documents_resolve_to_dark() {
        let fixture = Fixture::new();
        run(async {
            for content in [
                "{",
                "null",
                "[]",
                "42",
                r#""light""#,
                "true",
                r#"{"theme":"light"} trailing"#,
                " \u{feff}{\"theme\":\"light\"}",
                "\u{00a0}{\"theme\":\"light\"}",
                r#"{"theme":"light",}"#,
                r#"{"theme":42}"#,
                r#"{"theme":null}"#,
                r#"{"theme":["light"]}"#,
                r#"{"theme":{"name":"light"}}"#,
                r#"{"other":"light"}"#,
                "{}",
                "{} ",
            ] {
                fixture.write(content);
                assert_eq!(send_get(&fixture.state()).await, dark_body(), "{content}");
            }
        });
    }

    #[test]
    fn theme_strings_use_javascript_lowercase_contains() {
        let fixture = Fixture::new();
        run(async {
            for content in [
                r#"{"theme":"light"}"#,
                r#"{"theme":"Light"}"#,
                r#"{"theme":"LIGHT"}"#,
                r#"{"theme":"light-daltonized"}"#,
                r#"{"theme":" Light "}"#,
                r#"{"theme":"daylight"}"#,
                r#"{"theme":"LiGhT"}"#,
                r#" { "theme" : "light" } "#,
            ] {
                fixture.write(content);
                assert_eq!(send_get(&fixture.state()).await, light_body(), "{content}");
            }
            for content in [
                r#"{"theme":"dark"}"#,
                r#"{"theme":"auto"}"#,
                r#"{"theme":""}"#,
                r#"{"theme":"ligh"}"#,
            ] {
                fixture.write(content);
                assert_eq!(send_get(&fixture.state()).await, dark_body(), "{content}");
            }
        });
    }

    #[test]
    fn duplicate_theme_members_use_the_last_one() {
        let fixture = Fixture::new();
        run(async {
            fixture.write(r#"{"theme":"light","theme":"dark"}"#);
            assert_eq!(send_get(&fixture.state()).await, dark_body());
            fixture.write(r#"{"theme":"dark","theme":"light"}"#);
            assert_eq!(send_get(&fixture.state()).await, light_body());
            // An escaped spelling is the same member name, as in `JSON.parse`.
            // The escape is assembled so the literal source stays plain ASCII.
            let escaped_key = ['\\', 'u', '0', '0', '6', '5']
                .iter()
                .copied()
                .collect::<String>();
            fixture.write(&format!(
                r#"{{"theme":"dark","th{escaped_key}me":"light"}}"#
            ));
            assert_eq!(send_get(&fixture.state()).await, light_body());
            // A non-string last duplicate wins and falls through to dark.
            fixture.write(r#"{"theme":"light","theme":null}"#);
            assert_eq!(send_get(&fixture.state()).await, dark_body());
            fixture.write(r#"{"theme":"light","theme":7}"#);
            assert_eq!(send_get(&fixture.state()).await, dark_body());
        });
    }

    #[test]
    fn escaped_surrogates_never_invalidate_an_otherwise_valid_object() {
        let fixture = Fixture::new();
        run(async {
            fixture.write(r#"{"theme":"light","note":"\ud800"}"#);
            assert_eq!(send_get(&fixture.state()).await, light_body());

            fixture.write(r#"{"theme":"dark","\ud800":"x","\udfff":{"nested":"\ud800"}}"#);
            assert_eq!(send_get(&fixture.state()).await, dark_body());

            // The theme value itself may carry a lone surrogate; `toLowerCase`
            // preserves it and `includes('light')` still matches.
            fixture.write(r#"{"theme":"light\ud800"}"#);
            assert_eq!(send_get(&fixture.state()).await, light_body());
            fixture.write(r#"{"theme":"\ud800light"}"#);
            assert_eq!(send_get(&fixture.state()).await, light_body());

            // Values that merely look adjacent do not match.
            fixture.write(r#"{"theme":"ligh\ud800t"}"#);
            assert_eq!(send_get(&fixture.state()).await, dark_body());
            fixture.write(r#"{"theme":"li\u0000ght"}"#);
            assert_eq!(send_get(&fixture.state()).await, dark_body());

            // Large ignored numbers stay valid, as `JSON.parse` yields Infinity.
            fixture.write(r#"{"theme":"light","ignored":1e400}"#);
            assert_eq!(send_get(&fixture.state()).await, light_body());
        });
    }

    #[test]
    fn helper_reads_the_file_and_the_router_builds() {
        let fixture = Fixture::new();
        fixture.write(r#"{"theme":"Light"}"#);
        assert_eq!(theme_from_file(&fixture.settings_path()), LIGHT);
        assert_eq!(theme_from_settings(r#"{"theme":"light"}"#), LIGHT);
        assert_eq!(theme_from_settings("{"), DARK);
        // The settings path lives under the injected home, never the process home.
        let _router = router(fixture.home());
    }

    // A body-level sanity check: the reply is a single JSON object with one key.
    #[test]
    fn reply_body_is_the_bare_theme_object() {
        let fixture = Fixture::new();
        fixture.write(r#"{"theme":"light","enabledPlugins":{}}"#);
        run(async {
            assert_eq!(send_get(&fixture.state()).await, light_body());
        });
    }
}
