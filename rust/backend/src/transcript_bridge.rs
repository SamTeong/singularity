//! Correlated daemon operations for the transcript filesystem service.
use crate::transcript_service::{
    Inputs, ListOptions, ReadOptions, SearchOptions, TranscriptService,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use std::{
    path::PathBuf,
    sync::{Arc, RwLock},
};

/// Node defaults `now` to `Date.now()` (`server/sessions.mjs:473`).
fn wall_clock_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[derive(Default)]
pub struct TranscriptServices {
    cached: Option<(ServiceKey, Arc<TranscriptService>, Arc<RwLock<Vec<Value>>>)>,
}

// The model catalog is not part of the key: a catalog edit swaps it in place so
// the (expensive to rebuild) transcript metadata cache survives.
#[derive(PartialEq, Eq)]
struct ServiceKey {
    state_dir: PathBuf,
    claude_home: PathBuf,
    codex_home: PathBuf,
    cache_dir: Option<PathBuf>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub struct TranscriptRequest {
    pub state_dir: Option<String>,
    /// Optional: where list metadata persists across restarts.
    pub cache_dir: Option<String>,
    pub claude_home: Option<String>,
    pub codex_home: Option<String>,
    pub model_catalog: Option<Vec<Value>>,
    #[serde(rename = "transcript_root")]
    pub root: Option<String>,
    #[serde(rename = "transcript_project")]
    pub project: Option<String>,
    #[serde(rename = "transcript_id")]
    pub id: Option<String>,
    #[serde(rename = "transcript_source")]
    pub source: Option<String>,
    #[serde(rename = "transcript_file")]
    pub file: Option<String>,
    #[serde(rename = "transcript_cwd")]
    pub cwd: Option<String>,
    #[serde(rename = "transcript_q")]
    pub q: Option<String>,
    /// Exact JavaScript UTF-16 code units, including unpaired surrogates.
    #[serde(rename = "transcript_q_units")]
    pub q_units: Option<Vec<u16>>,
    pub cap: Option<usize>,
    pub now_ms: Option<u64>,
    pub hide_reviews: Option<bool>,
}

#[derive(Debug)]
pub enum ResponseBody {
    Raw(Box<RawValue>),
    Value(Value),
}

impl TranscriptServices {
    /// Resolves (or reuses) the service for these inputs. Cheap; runs on the
    /// caller's thread so `dispatch_on` can run the slow work elsewhere.
    pub fn service(
        &mut self,
        request: &TranscriptRequest,
    ) -> Result<Arc<TranscriptService>, ResponseBody> {
        let state_dir = request.state_dir.as_deref().ok_or_else(invalid_inputs)?;
        let claude_home = request.claude_home.as_deref().ok_or_else(invalid_inputs)?;
        let codex_home = request.codex_home.as_deref().ok_or_else(invalid_inputs)?;
        let catalog = request.model_catalog.clone().ok_or_else(invalid_inputs)?;
        let key = ServiceKey {
            state_dir: PathBuf::from(state_dir),
            claude_home: PathBuf::from(claude_home),
            codex_home: PathBuf::from(codex_home),
            cache_dir: request.cache_dir.as_deref().map(PathBuf::from),
        };
        if let Some((cached_key, service, current)) = &self.cached {
            if cached_key == &key {
                let mut current = current.write().unwrap_or_else(|e| e.into_inner());
                if *current != catalog {
                    *current = catalog;
                    // Search items are parsed with the catalog; list metadata is not.
                    service.clear_search_cache();
                }
                return Ok(service.clone());
            }
        }
        let current = Arc::new(RwLock::new(catalog.clone()));
        let source = current.clone();
        let mut service = TranscriptService::new(Inputs {
            state_dir: key.state_dir.clone(),
            claude_home: key.claude_home.clone(),
            codex_home: key.codex_home.clone(),
            model_catalog: catalog,
        })
        .with_catalog_source(Arc::new(move || {
            source.read().unwrap_or_else(|e| e.into_inner()).clone()
        }));
        if let Some(dir) = &key.cache_dir {
            service = service.with_persist(dir.join("transcript-meta.json"));
        }
        let service = Arc::new(service);
        self.cached = Some((key, service.clone(), current));
        Ok(service)
    }

    pub fn dispatch(&mut self, op: &str, request: &TranscriptRequest) -> ResponseBody {
        match self.service(request) {
            Ok(service) => dispatch_on(&service, op, request),
            Err(error) => error,
        }
    }
}

/// Runs one transcript operation; safe to call off the bridge's main thread.
pub fn dispatch_on(service: &TranscriptService, op: &str, request: &TranscriptRequest) -> ResponseBody {
    {
        let result = match op {
            "transcript_root_get" => serde_json::to_string(&service.get_root())
                .map_err(|e| crate::transcript_service::Error::Parse(e.to_string())),
            "transcript_root_set" => {
                let Some(root) = request.root.as_deref() else {
                    return invalid_inputs();
                };
                match service.set_root_checked(root) {
                    Ok(result) => serde_json::to_string(&result)
                        .map_err(|e| crate::transcript_service::Error::Parse(e.to_string())),
                    Err(error) => return service_error(error),
                }
            }
            "transcripts_list" => service
                .list(&ListOptions {
                    root: request.root.clone(),
                    cap: request.cap.unwrap_or(5000),
                    now_ms: request.now_ms.unwrap_or_else(wall_clock_ms),
                    hide_reviews: request.hide_reviews.unwrap_or(false),
                    live_ids: Vec::new(),
                })
                .and_then(|value| {
                    serde_json::to_string(&value)
                        .map_err(|e| crate::transcript_service::Error::Parse(e.to_string()))
                }),
            "transcripts_read" => {
                let Some(id) = request.id.as_deref() else {
                    return invalid_inputs();
                };
                let Some(project) = request.project.as_deref() else {
                    return invalid_inputs();
                };
                match service.read(
                    project,
                    id,
                    &ReadOptions {
                        root: request.root.clone(),
                        source: request.source.clone(),
                        file: request.file.clone(),
                    },
                ) {
                    Ok(Some(raw)) => return raw_body(raw),
                    Ok(None) => return error("not_found", "not found"),
                    Err(error) => return service_error(error),
                }
            }
            "transcripts_search" => {
                let query_units = request.q_units.clone().or_else(|| {
                    request
                        .q
                        .as_ref()
                        .map(|query| query.encode_utf16().collect())
                });
                let Some(query_units) = query_units else {
                    return invalid_inputs();
                };
                service
                    .search_units(
                        &query_units,
                        &SearchOptions {
                            root: request.root.clone(),
                            project: request.project.clone(),
                            id: request.id.clone(),
                            hide_reviews: request.hide_reviews.unwrap_or(false),
                        },
                    )
                    .and_then(|value| {
                        serde_json::to_string(&value)
                            .map_err(|e| crate::transcript_service::Error::Parse(e.to_string()))
                    })
            }
            "transcript_subagents" => {
                let Some(cwd) = request.cwd.as_deref() else {
                    return invalid_inputs();
                };
                let Some(id) = request.id.as_deref() else {
                    return invalid_inputs();
                };
                service
                    .subagents(
                        cwd,
                        id,
                        request.root.as_deref(),
                        request.now_ms.unwrap_or_else(wall_clock_ms),
                        &[],
                    )
                    .and_then(|value| {
                        serde_json::to_string(&value)
                            .map_err(|e| crate::transcript_service::Error::Parse(e.to_string()))
                    })
            }
            _ => return error("unknown_operation", "unknown transcript operation"),
        };
        match result {
            Ok(json) => raw_body(json),
            Err(error) => service_error(error),
        }
    }
}

fn raw_body(json: String) -> ResponseBody {
    match RawValue::from_string(json) {
        Ok(value) => ResponseBody::Raw(value),
        Err(parse_error) => error("serialization", &parse_error.to_string()),
    }
}

fn invalid_inputs() -> ResponseBody {
    error("invalid_request", "missing transcript request inputs")
}

fn service_error(service_failure: crate::transcript_service::Error) -> ResponseBody {
    let code = match &service_failure {
        crate::transcript_service::Error::Io(_) => "io",
        crate::transcript_service::Error::Parse(_) => "parse",
    };
    error(code, &service_failure.to_string())
}

fn error(code: &str, message: &str) -> ResponseBody {
    ResponseBody::Value(serde_json::json!({"error": message, "code": code}))
}

#[derive(Serialize)]
pub struct RawEnvelope<'a> {
    pub id: &'a Value,
    pub response: &'a RawValue,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::SystemTime};

    fn scratch() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("transcript-bridge-{nonce}"))
    }

    #[test]
    fn utf16_search_request_transport_accepts_unpaired_surrogate_unit() {
        let request = TranscriptRequest {
            state_dir: Some("state".into()),
            claude_home: Some("home".into()),
            codex_home: Some("codex".into()),
            model_catalog: Some(vec![]),
            q_units: Some(vec![0xd800]),
            ..TranscriptRequest::default()
        };
        assert_eq!(request.q_units.as_deref(), Some(&[0xd800][..]));
        let decoded: TranscriptRequest = serde_json::from_str(
            r#"{"transcript_q_units":[55296],"state_dir":"state","claude_home":"home","codex_home":"codex","model_catalog":[]}"#,
        )
        .unwrap();
        assert_eq!(decoded.q_units.as_deref(), Some(&[0xd800][..]));
    }

    #[test]
    fn service_reuse_tracks_configuration_and_dispatches_transcript_operations() {
        let root = scratch();
        let claude = root.join("claude");
        fs::create_dir_all(&claude).unwrap();
        let request = TranscriptRequest {
            state_dir: Some(root.join("state").to_string_lossy().into_owned()),
            claude_home: Some(root.join("home").to_string_lossy().into_owned()),
            codex_home: Some(root.join("codex").to_string_lossy().into_owned()),
            model_catalog: Some(vec![]),
            root: Some(claude.to_string_lossy().into_owned()),
            ..TranscriptRequest::default()
        };
        let mut services = TranscriptServices::default();
        let first = services.service(&request).unwrap();
        let again = services.service(&request).unwrap();
        assert!(Arc::ptr_eq(&first, &again));

        let ResponseBody::Raw(root_value) = services.dispatch("transcript_root_get", &request)
        else {
            panic!("root get must return its scalar response directly")
        };
        assert_eq!(root_value.get(), r#""~/.claude/projects""#);
        let ResponseBody::Raw(set_value) = services.dispatch(
            "transcript_root_set",
            &TranscriptRequest {
                root: Some("selected".into()),
                ..request.clone()
            },
        ) else {
            panic!("root set must return its service response")
        };
        assert!(set_value.get().contains(r#""ok":true"#));
        let ResponseBody::Raw(list) = services.dispatch("transcripts_list", &request) else {
            panic!("list must return a raw array")
        };
        assert_eq!(list.get(), "[]");
        let ResponseBody::Value(missing) = services.dispatch(
            "transcripts_read",
            &TranscriptRequest {
                project: Some("p".into()),
                id: Some("absent".into()),
                ..request.clone()
            },
        ) else {
            panic!("missing reads must return a distinguishable error")
        };
        assert_eq!(missing["code"], "not_found");
        let ResponseBody::Raw(search) = services.dispatch(
            "transcripts_search",
            &TranscriptRequest {
                q_units: Some(vec![0xd800]),
                ..request.clone()
            },
        ) else {
            panic!("search must return raw JSON")
        };
        assert!(search.get().contains(r#""results":[]"#));
        let ResponseBody::Raw(subagents) = services.dispatch(
            "transcript_subagents",
            &TranscriptRequest {
                cwd: Some("C:/work".into()),
                id: Some("parent".into()),
                ..request
            },
        ) else {
            panic!("subagents must return a raw array")
        };
        assert_eq!(subagents.get(), "[]");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn raw_envelope_keeps_surrogate_json_token_opaque() {
        let id = Value::String("request-7".into());
        let response = RawValue::from_string(r#"{"messages":[{"text":"\ud800"}]}"#.into()).unwrap();
        let encoded = serde_json::to_string(&RawEnvelope {
            id: &id,
            response: &response,
        })
        .unwrap();
        assert!(encoded.contains(r#""response":{"messages":[{"text":"\ud800"}]}"#));
    }

    #[test]
    fn not_found_and_io_errors_have_distinct_codes() {
        let not_found = error("not_found", "not found");
        let io = error("io", "permission denied");
        let ResponseBody::Value(not_found) = not_found else {
            panic!()
        };
        let ResponseBody::Value(io) = io else {
            panic!()
        };
        assert_eq!(not_found["code"], "not_found");
        assert_eq!(io["code"], "io");
    }
}
