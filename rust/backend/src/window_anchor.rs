use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::thread;
use std::time::Duration;

const TELEMETRY_MAX_RECORDS: usize = 1000;
const PROVIDERS: [&str; 2] = ["claude", "codex"];
const WINDOW_MS: i64 = 18_000_000;
const ANCHOR_DELAY_MS: i64 = 5_000;
const MIN_POKE_GAP_MS: i64 = 60_000;

pub struct Service {
    state: Value,
    usage: Value,
    generations: std::collections::HashMap<String, i64>,
    deadlines: std::collections::HashMap<String, i64>,
    last_attempt: std::collections::HashMap<String, (i64, i64)>,
    accepted_timers: std::collections::HashMap<String, (String, i64, i64)>,
    next_action_id: u64,
    actions: std::collections::HashMap<String, ActionContext>,
}

struct ActionContext {
    provider: String,
    trigger: String,
    window_end_ms: i64,
    started_at_ms: i64,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            state: json!({"claude":default_state(),"codex":default_state()}),
            usage: Value::Null,
            generations: Default::default(),
            deadlines: Default::default(),
            last_attempt: Default::default(),
            accepted_timers: Default::default(),
            next_action_id: 0,
            actions: Default::default(),
        }
    }
}

impl Service {
    fn snapshot(&self) -> Value {
        self.state.clone()
    }
    fn next_generation(&mut self, provider: &str) -> i64 {
        let next = self.generations.get(provider).copied().unwrap_or(0) + 1;
        self.generations.insert(provider.to_owned(), next);
        next
    }
    fn clear(&mut self, provider: &str, effects: &mut Vec<Value>) -> bool {
        let was_armed = self.deadlines.remove(provider).is_some()
            || !self.state[provider]["nextAnchorAt"].is_null();
        self.state[provider]["nextAnchorAt"] = Value::Null;
        if was_armed {
            let generation = self.next_generation(provider);
            effects.push(json!({"type":"clear_timer","provider":provider,"generation":generation}));
        }
        was_armed
    }
    fn arm(&mut self, provider: &str, resets_at: i64, effects: &mut Vec<Value>) -> bool {
        if self.deadlines.get(provider) == Some(&resets_at) {
            return false;
        }
        let generation = self.next_generation(provider);
        let fire_at_ms = resets_at.saturating_add(ANCHOR_DELAY_MS);
        self.deadlines.insert(provider.to_owned(), resets_at);
        self.state[provider]["nextAnchorAt"] = json!(fire_at_ms);
        effects.push(json!({"type":"arm_timer","provider":provider,"generation":generation,"fire_at_ms":fire_at_ms}));
        true
    }
    fn persist(&self, effects: &mut Vec<Value>, provider: &str, record: Option<Value>) {
        if let Some(record) = record {
            effects.push(json!({"type":"append_telemetry","record":record}));
        }
        effects.push(json!({"type":"save_state","state":self.snapshot()}));
        effects
            .push(json!({"type":"emit_snapshot","provider":provider,"snapshot":self.snapshot()}));
    }
    fn active_window(&self, provider: &str, now_ms: i64) -> bool {
        let session = &self.usage[provider]["session"];
        self.usage[provider]["ok"] == true
            && !session.is_null()
            && session["started"] != false
            && timestamp_ms(&session["resetsAt"]).is_some_and(|reset| reset > now_ms)
    }
    fn should_poke(&self, provider: &str, window_end_ms: i64, now_ms: i64) -> bool {
        let Some((last_window, attempted_at)) = self.last_attempt.get(provider) else {
            return true;
        };
        if *last_window != window_end_ms {
            return true;
        }
        let gap = if self.state[provider]["lastResult"] == "Ok" {
            WINDOW_MS
        } else {
            MIN_POKE_GAP_MS
        };
        now_ms.saturating_sub(*attempted_at) >= gap
    }
    fn admit(
        &mut self,
        provider: &str,
        window_end_ms: i64,
        trigger: &str,
        force: bool,
        now_ms: i64,
        started_at_ms: i64,
        effects: &mut Vec<Value>,
    ) -> Value {
        if !force && self.active_window(provider, now_ms) {
            self.state[provider]["lastResult"] = json!("Skipped");
            self.state[provider]["lastError"] = Value::Null;
            self.persist(
                effects,
                provider,
                Some(telemetry(
                    provider,
                    trigger,
                    window_end_ms,
                    started_at_ms,
                    now_ms,
                    "Skipped",
                    Some("window-already-started"),
                    None,
                    None,
                    None,
                )),
            );
            return json!("Skipped");
        }
        if !self.should_poke(provider, window_end_ms, now_ms) {
            return json!("Skipped");
        }
        self.last_attempt
            .insert(provider.to_owned(), (window_end_ms, now_ms));
        self.next_action_id += 1;
        let action_id = format!("window-anchor-{}", self.next_action_id);
        self.actions.insert(
            action_id.clone(),
            ActionContext {
                provider: provider.to_owned(),
                trigger: trigger.to_owned(),
                window_end_ms,
                started_at_ms,
            },
        );
        effects.push(json!({"type":"run_action","action_id":action_id,"provider":provider,"trigger":trigger,"force":force}));
        json!("Running")
    }
    fn response(&self, effects: Vec<Value>) -> Value {
        json!({"snapshot":self.snapshot(),"effects":effects})
    }

    pub fn dispatch(&mut self, op: &str, request: &Value) -> Value {
        let now_ms = request["now_ms"].as_i64().unwrap_or(0);
        match op {
            "window_anchor_init" => {
                let loaded = load(request["state_path"].as_str().unwrap_or(""));
                let mut warnings = Vec::new();
                let loaded_state = loaded["state"].clone();
                let had_loaded_state = loaded_state.is_object();
                if !loaded_state.is_null() && !had_loaded_state {
                    warnings.push("invalid window-anchor state; using defaults".to_owned());
                }
                self.state = if had_loaded_state {
                    loaded_state.clone()
                } else {
                    json!({"claude":default_state(),"codex":default_state()})
                };
                if let Some(error) = loaded["error"].as_str() {
                    warnings.push(error.to_owned());
                    self.state = json!({"claude":default_state(),"codex":default_state()});
                }
                let before = self.state.clone();
                let enabled: Vec<&str> = request["window_anchor_env"]
                    .as_str()
                    .unwrap_or("")
                    .split(',')
                    .map(str::trim)
                    .collect();
                for provider in PROVIDERS {
                    if !self.state[provider].is_object() {
                        self.state[provider] = default_state();
                    }
                    let provider_state = &mut self.state[provider];
                    for field in ["nextAnchorAt", "lastAnchorAt", "lastError"] {
                        if provider_state.get(field).is_none() {
                            provider_state[field] = Value::Null;
                        }
                    }
                    if provider_state["lastAnchorAt"].as_i64().is_none()
                        && !provider_state["lastAnchorAt"].is_null()
                    {
                        provider_state["lastAnchorAt"] = Value::Null;
                    }
                    if provider_state["lastError"].as_str().is_none()
                        && !provider_state["lastError"].is_null()
                    {
                        provider_state["lastError"] = Value::Null;
                    }
                    provider_state["nextAnchorAt"] = Value::Null;
                    let last_result = self.state[provider]["lastResult"]
                        .as_str()
                        .map(capitalize)
                        .unwrap_or(Value::Null);
                    self.state[provider]["lastResult"] = last_result;
                    self.state[provider]["enabled"] = json!(
                        enabled
                            .iter()
                            .any(|item| item.eq_ignore_ascii_case(provider))
                    );
                }
                self.usage = Value::Null;
                self.deadlines.clear();
                let mut effects = Vec::new();
                if had_loaded_state && self.state != before {
                    effects.push(json!({"type":"save_state","state":self.snapshot()}));
                    for provider in PROVIDERS {
                        effects.push(json!({"type":"emit_snapshot","provider":provider,"snapshot":self.snapshot()}));
                    }
                }
                json!({"snapshot":self.snapshot(),"effects":effects,"warnings":warnings})
            }
            "window_anchor_snapshot" => json!({"snapshot":self.snapshot()}),
            "window_anchor_usage" => {
                let mut effects = Vec::new();
                if request["authoritative"] != true {
                    return self.response(effects);
                }
                self.usage = request["usage"].clone();
                let preflighting: Vec<&str> = request["preflighting"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                for provider in PROVIDERS {
                    let mut changed = false;
                    if self.state[provider]["enabled"] != true {
                        changed |= self.clear(provider, &mut effects);
                    } else {
                        let source = self.usage[provider].clone();
                        if source["ok"] == true {
                            let session = &source["session"];
                            if session.is_null() {
                                changed |= self.clear(provider, &mut effects);
                            } else if session["started"] == false {
                                changed |= self.clear(provider, &mut effects);
                                if !preflighting.contains(&provider) {
                                    let window_end_ms =
                                        self.state[provider]["lastAnchorAt"].as_i64().unwrap_or(0);
                                    let expired = window_end_ms == 0
                                        || now_ms.saturating_sub(window_end_ms) >= WINDOW_MS;
                                    if expired {
                                        self.admit(
                                            provider,
                                            window_end_ms,
                                            "automatic",
                                            false,
                                            now_ms,
                                            now_ms,
                                            &mut effects,
                                        );
                                    }
                                }
                            } else if let Some(reset_ms) = timestamp_ms(&session["resetsAt"]) {
                                if reset_ms > now_ms {
                                    changed |= self.arm(provider, reset_ms, &mut effects);
                                } else if session["pctUsed"].as_f64().unwrap_or(0.0) > 0.0 {
                                    changed |= self.clear(provider, &mut effects);
                                    if self.state[provider]["lastResult"] != "Skipped" {
                                        self.state[provider]["lastResult"] = json!("Skipped");
                                        self.state[provider]["lastError"] = Value::Null;
                                        changed = true;
                                    }
                                } else {
                                    changed |= self.clear(provider, &mut effects);
                                    if !preflighting.contains(&provider) {
                                        self.admit(
                                            provider,
                                            reset_ms,
                                            "automatic",
                                            false,
                                            now_ms,
                                            now_ms,
                                            &mut effects,
                                        );
                                    }
                                }
                            }
                        }
                    }
                    if changed {
                        self.persist(&mut effects, provider, None);
                    }
                }
                self.response(effects)
            }
            "window_anchor_timer_fired" => {
                let provider = request["provider"].as_str().unwrap_or("");
                let generation = request["generation"].as_i64().unwrap_or(-1);
                if !PROVIDERS.contains(&provider)
                    || self.generations.get(provider).copied() != Some(generation)
                {
                    return json!({"snapshot":self.snapshot(),"result":"stale"});
                }
                let event_id = request["timer_event_id"].as_str().unwrap_or("");
                if event_id.is_empty() || self.accepted_timers.contains_key(event_id) {
                    return json!({"snapshot":self.snapshot(),"result":"stale"});
                }
                let Some(window_end_ms) = self.deadlines.remove(provider) else {
                    return json!({"snapshot":self.snapshot(),"result":"stale"});
                };
                self.state[provider]["nextAnchorAt"] = Value::Null;
                self.next_generation(provider);
                self.accepted_timers.insert(
                    event_id.to_owned(),
                    (provider.to_owned(), window_end_ms, generation),
                );
                json!({"snapshot":self.snapshot(),"result":"preflight_required"})
            }
            "window_anchor_timer_admit" => {
                let event_id = request["timer_event_id"].as_str().unwrap_or("");
                let Some((provider, window_end_ms, generation)) =
                    self.accepted_timers.get(event_id).cloned()
                else {
                    return self.response(Vec::new());
                };
                if request["generation"].as_i64() != Some(generation) {
                    return self.response(Vec::new());
                }
                self.accepted_timers.remove(event_id);
                if request["usage_refresh"] == "ok" {
                    self.usage = request["usage"].clone();
                }
                let mut effects = Vec::new();
                self.admit(
                    &provider,
                    window_end_ms,
                    "automatic",
                    false,
                    now_ms,
                    now_ms,
                    &mut effects,
                );
                self.response(effects)
            }
            "window_anchor_poke" => {
                let provider = request["provider"].as_str().unwrap_or("");
                if !PROVIDERS.contains(&provider) {
                    return json!({"error":"provider must be 'claude' or 'codex'"});
                }
                if request["usage_refresh"] == "ok" {
                    self.usage = request["usage"].clone();
                }
                let started_at_ms = request["started_at_ms"].as_i64().unwrap_or(now_ms);
                let window_end_ms = now_ms;
                let mut effects = Vec::new();
                let result = self.admit(
                    provider,
                    window_end_ms,
                    "manual",
                    request["force"] == true,
                    now_ms,
                    started_at_ms,
                    &mut effects,
                );
                json!({"snapshot":self.snapshot(),"effects":effects,"result":{"provider":provider,"result":result}})
            }
            "window_anchor_action_result" => {
                let action_id = request["action_id"].as_str().unwrap_or("");
                let Some(context) = self.actions.remove(action_id) else {
                    return self.response(Vec::new());
                };
                let provider = context.provider.as_str();
                let outcome = request["outcome"].as_str().unwrap_or("");
                let succeeded = outcome == "ok" || request["ok"] == true;
                let result = if succeeded { "Ok" } else { "Error" };
                self.state[provider]["lastResult"] = json!(result);
                let error = request["error"]
                    .as_str()
                    .map(|message| message.chars().take(200).collect::<String>());
                self.state[provider]["lastError"] = if succeeded {
                    Value::Null
                } else {
                    json!(error.as_deref().unwrap_or("action failed"))
                };
                let ended_at_ms = request["ended_at_ms"].as_i64().unwrap_or(now_ms);
                if succeeded {
                    self.state[provider]["lastAnchorAt"] = json!(ended_at_ms);
                }
                let record = telemetry(
                    provider,
                    &context.trigger,
                    context.window_end_ms,
                    context.started_at_ms,
                    ended_at_ms,
                    result,
                    None,
                    request["model"].as_str(),
                    request.get("usage"),
                    if succeeded { None } else { error.as_deref() },
                );
                let mut effects = Vec::new();
                self.persist(&mut effects, provider, Some(record));
                self.response(effects)
            }
            _ => json!({"error":"unknown window-anchor operation"}),
        }
    }
}

fn default_state() -> Value {
    json!({"enabled":false,"nextAnchorAt":null,"lastAnchorAt":null,"lastResult":null,"lastError":null})
}
fn capitalize(value: &str) -> Value {
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| json!(first.to_uppercase().to_string() + chars.as_str()))
        .unwrap_or(Value::Null)
}
fn timestamp_ms(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_str()
            .and_then(crate::usage_snapshot::window_anchor_timestamp_ms)
    })
}
fn telemetry(
    provider: &str,
    trigger: &str,
    window_end_ms: i64,
    started_at_ms: i64,
    finished_at_ms: i64,
    result: &str,
    reason: Option<&str>,
    model: Option<&str>,
    usage: Option<&Value>,
    error: Option<&str>,
) -> Value {
    let iso = |at| {
        crate::usage_snapshot::window_anchor_timestamp_iso(at)
            .map(Value::String)
            .unwrap_or(Value::Null)
    };
    let mut record = json!({"started_at":iso(started_at_ms),"finished_at":iso(finished_at_ms),"provider":provider,"trigger":trigger,"window_end":iso(window_end_ms),"result":result,"reason":reason,"model":model,"usage":usage.cloned().unwrap_or(Value::Null)});
    if let Some(error) = error {
        record["error"] = json!(error);
    }
    record
}
fn replace(path: &str, contents: &str) -> Result<(), String> {
    let tmp = format!("{path}.{}.tmp", std::process::id());
    fs::write(&tmp, contents).map_err(|error| error.to_string())?;
    for attempt in 1..=5 {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(error)
                if attempt < 5
                    && (error.kind() == std::io::ErrorKind::PermissionDenied
                        || matches!(error.raw_os_error(), Some(16 | 32))) =>
            {
                thread::sleep(Duration::from_millis(20 * attempt));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("atomic replacement retries exhausted".to_owned())
}

pub fn load(path: &str) -> Value {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return json!({ "state": null });
        }
        Err(error) => return json!({ "error": error.to_string() }),
    };
    match serde_json::from_str::<Value>(&contents) {
        Ok(state) => json!({ "state": state }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

pub fn save(path: &str, state: &Value) -> Value {
    let contents = match serde_json::to_string_pretty(state) {
        Ok(contents) => contents,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    match replace(path, &contents) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "error": error }),
    }
}

pub fn append_telemetry(path: &str, record: &Value) -> Value {
    let file = Path::new(path);
    if let Some(parent) = file.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return json!({ "error": error.to_string() });
        }
    }
    let line = match serde_json::to_string(record) {
        Ok(line) => line,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = match options.open(path) {
        Ok(output) => output,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    if let Err(error) = writeln!(output, "{line}") {
        return json!({ "error": error.to_string() });
    }
    drop(output);

    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    let lines: Vec<_> = contents.trim_end().lines().collect();
    if lines.len() > TELEMETRY_MAX_RECORDS {
        let retained = lines[lines.len() - TELEMETRY_MAX_RECORDS..].join("\n") + "\n";
        if let Err(error) = replace(path, &retained) {
            return json!({ "error": error });
        }
    }
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-window-anchor-{id}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn load_and_save_use_the_configured_path_and_pretty_json() {
        let fixture = Fixture::new();
        let path = fixture.path("state.json");
        assert_eq!(load(&path), json!({ "state": null }));
        let state = json!({ "codex": { "lastResult": "Ok" } });
        assert_eq!(save(&path, &state), json!({ "ok": true }));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            serde_json::to_string_pretty(&state).unwrap()
        );
        assert_eq!(load(&path), json!({ "state": state }));
        let updated = json!({ "codex": { "lastResult": "Skipped" } });
        assert_eq!(save(&path, &updated), json!({ "ok": true }));
        assert_eq!(load(&path), json!({ "state": updated }));
    }

    #[test]
    fn telemetry_appends_json_lines_and_retains_the_last_thousand() {
        let fixture = Fixture::new();
        let path = fixture.path("nested/runs.jsonl");
        assert_eq!(
            append_telemetry(&path, &json!({ "index": 0 })),
            json!({ "ok": true })
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let existing = (0..1001)
            .map(|index| json!({ "index": index }).to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&path, existing).unwrap();
        assert_eq!(
            append_telemetry(&path, &json!({ "index": 1001 })),
            json!({ "ok": true })
        );
        let lines: Vec<_> = fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(lines.len(), 1000);
        assert_eq!(
            serde_json::from_str::<Value>(&lines[0]).unwrap()["index"],
            2
        );
        assert_eq!(
            serde_json::from_str::<Value>(lines.last().unwrap()).unwrap()["index"],
            1001
        );
    }

    #[test]
    fn persistence_errors_are_returned_to_the_bridge() {
        let fixture = Fixture::new();
        assert!(load(&fixture.path("."))["error"].is_string());
        assert!(save(&fixture.path("missing-parent/state.json"), &json!({}))["error"].is_string());
    }
}

#[cfg(test)]
mod policy_tests {
    use super::*;

    fn reset_ms() -> i64 {
        timestamp_ms(&json!("2030-01-01T00:00:00.000Z")).unwrap()
    }
    fn usage(resets_at: &str, started: bool, pct_used: f64) -> Value {
        json!({"claude":{"ok":true,"session":{"started":started,"resetsAt":resets_at,"pctUsed":pct_used}},"codex":{"ok":false}})
    }
    fn init(service: &mut Service) {
        service.dispatch("window_anchor_init", &json!({"state_path":"missing-anchor-state.json","window_anchor_env":"claude","now_ms":reset_ms()}));
    }

    #[test]
    fn initialization_normalizes_saved_state_and_orders_snapshot_effects() {
        let mut service = Service::default();
        let dir = std::env::temp_dir().join(format!("window-anchor-policy-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        fs::write(
            &path,
            r#"{"claude":{"lastResult":"ok","enabled":false},"codex":{}}"#,
        )
        .unwrap();
        let response = service.dispatch(
            "window_anchor_init",
            &json!({"state_path":path,"window_anchor_env":"claude","now_ms":0}),
        );
        assert_eq!(response["snapshot"]["claude"]["lastResult"], "Ok");
        assert_eq!(response["snapshot"]["claude"]["enabled"], true);
        assert_eq!(response["effects"][0]["type"], "save_state");
        assert_eq!(response["effects"][1]["type"], "emit_snapshot");
        assert_eq!(response["effects"][2]["type"], "emit_snapshot");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reset_timestamp_replacement_rejects_stale_generation_and_consumes_accepted_deadline() {
        let mut service = Service::default();
        init(&mut service);
        let first_reset = reset_ms();
        let first = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":[],"now_ms":first_reset-20_000}));
        let old_generation = first["effects"][0]["generation"].as_i64().unwrap();
        let second = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:05:00.000Z",true,0.0),"preflighting":[],"now_ms":first_reset-10_000}));
        let generation = second["effects"][0]["generation"].as_i64().unwrap();
        let stale = service.dispatch("window_anchor_timer_fired", &json!({"provider":"claude","generation":old_generation,"timer_event_id":"stale","now_ms":first_reset}));
        assert_eq!(stale["result"], "stale");
        let accepted = service.dispatch("window_anchor_timer_fired", &json!({"provider":"claude","generation":generation,"timer_event_id":"accepted","now_ms":first_reset}));
        assert_eq!(accepted["result"], "preflight_required");
        assert_eq!(accepted["snapshot"]["claude"]["nextAnchorAt"], Value::Null);
        let same_reset_after_consumption = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:05:00.000Z",true,0.0),"preflighting":[],"now_ms":first_reset+1}));
        assert_eq!(
            same_reset_after_consumption["effects"][0]["type"],
            "arm_timer"
        );
        assert_eq!(
            same_reset_after_consumption["snapshot"]["claude"]["nextAnchorAt"],
            json!(first_reset + 305_000)
        );
        assert_eq!(
            timestamp_ms(
                &usage("2030-01-01T00:05:00.000Z", true, 0.0)["claude"]["session"]["resetsAt"]
            ),
            Some(first_reset + 300_000)
        );
    }

    #[test]
    fn accepted_timer_checks_refreshed_active_window_after_replacement_and_records_skip() {
        let mut service = Service::default();
        init(&mut service);
        let reset = reset_ms();
        let armed = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":[],"now_ms":reset-10_000}));
        let generation = armed["effects"][0]["generation"].as_i64().unwrap();
        service.dispatch("window_anchor_timer_fired", &json!({"provider":"claude","generation":generation,"timer_event_id":"timer-1","now_ms":reset-5_000}));
        let replacement = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":["claude"],"now_ms":reset-4_000}));
        assert_eq!(replacement["effects"][0]["type"], "arm_timer");
        let admitted = service.dispatch("window_anchor_timer_admit", &json!({"timer_event_id":"timer-1","generation":generation,"usage_refresh":"ok","usage":usage("2030-01-01T00:10:00.000Z",true,0.0),"now_ms":reset+1000}));
        assert_eq!(admitted["snapshot"]["claude"]["lastResult"], "Skipped");
        assert_eq!(admitted["effects"][0]["type"], "append_telemetry");
        assert_eq!(admitted["effects"][1]["type"], "save_state");
        assert_eq!(admitted["effects"][2]["type"], "emit_snapshot");
        assert_eq!(
            admitted["effects"][0]["record"]["reason"],
            "window-already-started"
        );
    }

    #[test]
    fn failed_manual_refresh_uses_cached_usage_and_force_bypasses_active_window() {
        let mut service = Service::default();
        init(&mut service);
        let reset = reset_ms();
        service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:10:00.000Z",true,0.0),"preflighting":[],"now_ms":reset}));
        let skipped = service.dispatch("window_anchor_poke", &json!({"provider":"claude","force":false,"usage_refresh":"failed","now_ms":reset+1000}));
        assert_eq!(skipped["result"]["result"], "Skipped");
        let forced = service.dispatch("window_anchor_poke", &json!({"provider":"claude","force":true,"usage_refresh":"not_requested","now_ms":reset+2000}));
        assert_eq!(forced["result"]["result"], "Running");
        assert_eq!(forced["effects"][0]["type"], "run_action");
    }

    #[test]
    fn action_result_emits_iso_telemetry_and_reinitialization_keeps_retry_history() {
        let mut service = Service::default();
        init(&mut service);
        let reset = reset_ms();
        let first = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":[],"now_ms":reset-1000}));
        let generation = first["effects"][0]["generation"].as_i64().unwrap();
        service.dispatch("window_anchor_timer_fired", &json!({"provider":"claude","generation":generation,"timer_event_id":"retry-id","now_ms":reset}));
        let admitted = service.dispatch("window_anchor_timer_admit", &json!({"timer_event_id":"retry-id","generation":generation,"usage_refresh":"failed","now_ms":reset}));
        let action_id = admitted["effects"][0]["action_id"].clone();
        assert!(action_id.is_string());
        let result = service.dispatch("window_anchor_action_result", &json!({"action_id":action_id,"outcome":"error","error":"no model","ended_at_ms":reset+10,"now_ms":reset+10}));
        assert_eq!(
            result["effects"][0]["record"]["started_at"],
            "2030-01-01T00:00:00.000Z"
        );
        assert_eq!(
            result["effects"][0]["record"]["finished_at"],
            "2030-01-01T00:00:00.010Z"
        );
        service.dispatch("window_anchor_init", &json!({"state_path":"missing-anchor-state.json","window_anchor_env":"claude","now_ms":reset+20}));
        assert!(!service.should_poke("claude", reset, reset + 20));
    }

    #[test]
    fn non_authoritative_usage_and_invalid_reset_leave_policy_unchanged() {
        let mut service = Service::default();
        init(&mut service);
        let reset = reset_ms();
        let armed = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":[],"now_ms":reset-1000}));
        assert_eq!(armed["effects"][0]["type"], "arm_timer");
        let stale = service.dispatch("window_anchor_usage", &json!({"authoritative":false,"usage":usage("2030-01-01T01:00:00.000Z",true,0.0),"now_ms":reset}));
        assert_eq!(stale["effects"], json!([]));
        assert_eq!(
            stale["snapshot"]["claude"]["nextAnchorAt"],
            json!(reset + ANCHOR_DELAY_MS)
        );
        let invalid = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("not-a-date",true,0.0),"preflighting":[],"now_ms":reset}));
        assert_eq!(invalid["effects"], json!([]));
        assert_eq!(
            invalid["snapshot"]["claude"]["nextAnchorAt"],
            json!(reset + ANCHOR_DELAY_MS)
        );
    }

    #[test]
    fn force_still_obeys_retry_dedupe_and_wrong_provider_is_rejected() {
        let mut service = Service::default();
        init(&mut service);
        let now = reset_ms();
        let first = service.dispatch(
            "window_anchor_poke",
            &json!({"provider":"claude","force":true,"usage_refresh":"not_requested","now_ms":now}),
        );
        assert_eq!(first["effects"][0]["type"], "run_action");
        let duplicate = service.dispatch(
            "window_anchor_poke",
            &json!({"provider":"claude","force":true,"usage_refresh":"not_requested","now_ms":now}),
        );
        assert_eq!(duplicate["effects"], json!([]));
        let alias = service.dispatch(
            "window_anchor_poke",
            &json!({"provider":"haiku","force":false,"now_ms":now}),
        );
        assert_eq!(alias["error"], "provider must be 'claude' or 'codex'");
    }

    #[test]
    fn same_reset_null_session_and_started_future_reset_follow_usage_policy() {
        let mut service = Service::default();
        init(&mut service);
        let reset = reset_ms();
        let first = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":[],"now_ms":reset-20_000}));
        assert_eq!(first["effects"][0]["type"], "arm_timer");
        let repeated = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":[],"now_ms":reset-10_000}));
        assert_eq!(
            repeated["effects"],
            json!([]),
            "same reset does not rearm or persist"
        );
        let future = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:05:00.000Z",true,0.0),"preflighting":[],"now_ms":reset}));
        assert_eq!(future["effects"][0]["type"], "arm_timer");
        assert_eq!(
            future["snapshot"]["claude"]["nextAnchorAt"],
            json!(reset + 305_000)
        );
        let null_session = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":{"claude":{"ok":true,"session":null},"codex":{"ok":false}},"preflighting":[],"now_ms":reset}));
        assert_eq!(null_session["effects"][0]["type"], "clear_timer");
        assert_eq!(null_session["snapshot"]["claude"]["enabled"], true);
        assert_eq!(
            null_session["snapshot"]["claude"]["nextAnchorAt"],
            Value::Null
        );
    }

    #[test]
    fn expired_started_and_idle_usage_have_distinct_policy_effects() {
        let mut service = Service::default();
        init(&mut service);
        let reset = reset_ms();
        let started = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,25.0),"preflighting":[],"now_ms":reset+1}));
        assert_eq!(started["snapshot"]["claude"]["lastResult"], "Skipped");
        assert_eq!(
            started["effects"]
                .as_array()
                .unwrap()
                .iter()
                .map(|effect| effect["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["save_state", "emit_snapshot"]
        );
        let idle = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":[],"now_ms":reset+60_001}));
        assert_eq!(idle["effects"][0]["type"], "run_action");
        assert_eq!(idle["effects"][0]["trigger"], "automatic");
    }

    #[test]
    fn retry_gap_exact_boundary_and_action_telemetry_contract_are_deterministic() {
        let mut service = Service::default();
        init(&mut service);
        let now = reset_ms();
        let first = service.dispatch(
            "window_anchor_usage",
            &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":[],"now_ms":now}),
        );
        assert_eq!(first["effects"][0]["type"], "run_action");
        let action_id = first["effects"][0]["action_id"].clone();
        let failed = service.dispatch("window_anchor_action_result", &json!({"action_id":action_id,"outcome":"error","error":"failure","started_at_ms":now,"ended_at_ms":now+1,"model":"sonnet","usage":{"input_tokens":7},"now_ms":now+1}));
        assert_eq!(
            failed["effects"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["append_telemetry", "save_state", "emit_snapshot"]
        );
        let record = &failed["effects"][0]["record"];
        assert_eq!(
            record,
            &json!({"started_at":"2030-01-01T00:00:00.000Z","finished_at":"2030-01-01T00:00:00.001Z","provider":"claude","trigger":"automatic","window_end":"2030-01-01T00:00:00.000Z","result":"Error","reason":null,"model":"sonnet","usage":{"input_tokens":7},"error":"failure"})
        );
        let before_gap = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":[],"now_ms":now+59_999}));
        assert_eq!(before_gap["effects"], json!([]));
        let at_gap = service.dispatch("window_anchor_usage", &json!({"authoritative":true,"usage":usage("2030-01-01T00:00:00.000Z",true,0.0),"preflighting":[],"now_ms":now+60_000}));
        assert_eq!(at_gap["effects"][0]["type"], "run_action");
    }
}
