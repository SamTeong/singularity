use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

const MAX_MODELS: usize = 200;
const MAX_LABEL_UNITS: usize = 80;
const GROUPS: &[&str] = &["claude", "ollama", "codex"];

const SEED_ROWS: &[(&str, &str, &str)] = &[
    ("claude", "claude", "Default"),
    ("best", "claude", "Best available"),
    ("fable", "claude", "Fable"),
    ("opus", "claude", "Opus"),
    ("sonnet", "claude", "Sonnet"),
    ("haiku", "claude", "Haiku"),
    ("opus[1m]", "claude", "Opus (1M context)"),
    ("sonnet[1m]", "claude", "Sonnet (1M context)"),
    ("opusplan", "claude", "Opus in plan mode, Sonnet after"),
    ("deepseek-v4-flash:cloud", "ollama", ""),
    ("glm-5.2:cloud", "ollama", ""),
    ("glm-5.3:cloud", "ollama", ""),
    ("glm-5.3-flash:cloud", "ollama", ""),
    ("kimi-k2.7-code:cloud", "ollama", ""),
    ("kimi-k3:cloud", "ollama", ""),
    ("gpt-6-luna", "codex", ""),
    ("gpt-6-sol", "codex", ""),
    ("gpt-6.1-sol", "codex", ""),
    ("gpt-6.1-terra", "codex", ""),
    ("gpt-5.4", "codex", ""),
    ("gpt-5.4-mini", "codex", ""),
    ("gpt-5.4-pro", "codex", ""),
];

fn seed() -> Value {
    let models: Vec<Value> = SEED_ROWS
        .iter()
        .map(|(id, group, label)| json!({ "id": id, "group": group, "label": label, "enabled": true }))
        .collect();
    json!({
        "models": models,
        "defaultModel": "claude",
        "summariserModel": "deepseek-v4-flash:cloud"
    })
}

pub(crate) fn js_trim(value: &str) -> &str {
    fn js_space(c: char) -> bool {
        matches!(
            c,
            '\u{0009}'
                | '\u{000a}'
                | '\u{000b}'
                | '\u{000c}'
                | '\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    }
    value.trim_matches(js_space)
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                value => js_string(Some(value)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

fn validate(doc: &Value) -> Result<Value, String> {
    let Some(models) = doc.get("models").and_then(Value::as_array) else {
        return Err("models must be an array".to_owned());
    };
    if models.len() > MAX_MODELS {
        return Err(format!("too many models (max {MAX_MODELS})"));
    }
    let mut normalized = Vec::with_capacity(models.len());
    let mut seen = HashSet::with_capacity(models.len());
    for model in models {
        let Some(id_value) = model.get("id").and_then(Value::as_str) else {
            return Err("every model needs a string id".to_owned());
        };
        let id = js_trim(id_value);
        if id.is_empty() {
            return Err("model id must not be empty".to_owned());
        }
        if !seen.insert(id.to_owned()) {
            return Err(format!("duplicate model id '{id}'"));
        }
        let group_value = model.get("group");
        let group = group_value.and_then(Value::as_str).unwrap_or("");
        if !GROUPS.contains(&group) {
            return Err(format!(
                "unknown group '{}' for '{id}'",
                js_string(group_value)
            ));
        }
        if group == "codex" && !id.starts_with("gpt-") {
            return Err(format!("codex model '{id}' must be a gpt-* id"));
        }
        let label = model.get("label").and_then(Value::as_str).unwrap_or("");
        if label.encode_utf16().count() > MAX_LABEL_UNITS {
            return Err(format!("label too long for '{id}' (max {MAX_LABEL_UNITS})"));
        }
        normalized.push(json!({
            "id": id,
            "group": group,
            "label": label,
            "enabled": model.get("enabled") != Some(&Value::Bool(false))
        }));
    }
    let default_model = doc
        .get("defaultModel")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or("");
    if !default_model.is_empty()
        && !normalized.iter().any(|model| {
            model.get("id").and_then(Value::as_str) == Some(default_model)
                && model.get("enabled").and_then(Value::as_bool) == Some(true)
        })
    {
        return Err(format!(
            "defaultModel '{default_model}' is not an enabled model"
        ));
    }
    let summariser_model = doc
        .get("summariserModel")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or("");
    if !summariser_model.is_empty()
        && !normalized.iter().any(|model| {
            model.get("id").and_then(Value::as_str) == Some(summariser_model)
                && model.get("enabled").and_then(Value::as_bool) == Some(true)
        })
    {
        return Err(format!(
            "summariserModel '{summariser_model}' is not an enabled model"
        ));
    }
    Ok(json!({
        "models": normalized,
        "defaultModel": default_model,
        "summariserModel": summariser_model
    }))
}

fn persist(path: &str, state: &Value) -> Result<(), String> {
    let file = Path::new(path);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = format!("{path}.{}.tmp", std::process::id());
    let contents = serde_json::to_string_pretty(state).expect("JSON values serialize");
    fs::write(&tmp, contents).map_err(|error| error.to_string())?;
    fs::rename(&tmp, file).map_err(|error| error.to_string())
}

fn read(path: &str) -> Value {
    if let Ok(contents) = fs::read_to_string(path) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&contents) {
            if let Ok(state) = validate(&parsed) {
                return state;
            }
        }
    }
    let fallback = seed();
    if !Path::new(path).exists() {
        let _ = persist(path, &fallback);
    }
    fallback
}

pub fn get(path: &str) -> Value {
    read(path)
}

pub fn set(path: &str, state: &Value) -> Value {
    match validate(state) {
        Err(error) => json!({ "ok": false, "error": error }),
        Ok(state) => match persist(path, &state) {
            Ok(()) => json!({ "ok": true, "state": state }),
            Err(error) => json!({ "ok": false, "error": error }),
        },
    }
}

pub fn restore(path: &str) -> Value {
    let current = read(path);
    let mut present: HashSet<String> = current["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|model| model["id"].as_str().map(str::to_owned))
        .collect();
    let mut next = current.clone();
    let models = next["models"].as_array_mut().unwrap();
    for row in seed()["models"].as_array().unwrap() {
        if present.insert(row["id"].as_str().unwrap().to_owned()) {
            models.push(row.clone());
        }
    }
    match set(path, &next) {
        Value::Object(result) if result.get("ok") == Some(&Value::Bool(true)) => {
            result.get("state").cloned().unwrap_or(current)
        }
        _ => current,
    }
}

fn group_for(state: &Value, id: &str) -> Option<String> {
    state["models"].as_array()?.iter().find_map(|model| {
        (model["id"].as_str() == Some(id))
            .then(|| model["group"].as_str().map(str::to_owned))
            .flatten()
    })
}

fn is_claude(state: &Value, model: &str) -> bool {
    if let Some(group) = group_for(state, model) {
        return group == "claude";
    }
    model.is_empty()
        || SEED_ROWS
            .iter()
            .any(|(id, group, _)| *group == "claude" && *id == model)
        || model.starts_with("claude-")
}

fn is_codex(state: &Value, model: &str) -> bool {
    if let Some(group) = group_for(state, model) {
        return group == "codex";
    }
    model.starts_with("gpt-")
}

fn claude_alias(state: &Value, model: &Value) -> Value {
    let Some(id) = model.as_str() else {
        return model.clone();
    };
    if id.is_empty()
        || group_for(state, id).as_deref() == Some("claude")
        || !id.starts_with("claude-")
    {
        return model.clone();
    }
    if (id.starts_with("claude-opus-") || id.starts_with("claude-sonnet-"))
        && id
            .strip_prefix(if id.starts_with("claude-opus-") {
                "claude-opus-"
            } else {
                "claude-sonnet-"
            })
            .and_then(|rest| rest.chars().next())
            .is_some_and(|first| first.is_ascii_digit())
        && id.ends_with("[1m]")
    {
        return json!(if id.starts_with("claude-opus-") {
            "opus[1m]"
        } else {
            "sonnet[1m]"
        });
    }
    for (prefix, alias) in [
        ("claude-opus-", "opus"),
        ("claude-sonnet-", "sonnet"),
        ("claude-haiku-", "haiku"),
        ("claude-fable-", "fable"),
    ] {
        if id.starts_with(prefix) {
            return json!(alias);
        }
    }
    model.clone()
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub fn route(path: &str, model: &Value, tool: &Value) -> Value {
    let state = read(path);
    let id = model.as_str().unwrap_or("");
    let group = group_for(&state, id);
    let claude = is_claude(&state, id);
    let codex = is_codex(&state, id);
    let tool_error = if js_truthy(tool) && js_truthy(model) && codex != (tool == "codex") {
        Some(format!(
            "model '{}' is not valid for tool '{}'",
            js_string(Some(model)),
            js_string(Some(tool))
        ))
    } else {
        None
    };
    json!({
        "group": group,
        "isClaudeModel": claude,
        "isCodexModel": codex,
        "claudeAlias": claude_alias(&state, model),
        "toolModelError": tool_error
    })
}

pub fn summariser(path: &str) -> Value {
    let state = read(path);
    let id = state["summariserModel"].as_str().unwrap_or("");
    if id.is_empty() {
        return Value::Null;
    }
    let Some(group) = group_for(&state, id) else {
        return Value::Null;
    };
    json!({ "id": id, "group": group })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-models-{stamp}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> String {
            self.0
                .join("state/models.json")
                .to_string_lossy()
                .into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn one_model(id: &str, group: &str, enabled: bool) -> Value {
        json!({
            "models": [{ "id": id, "group": group, "enabled": enabled }],
            "defaultModel": "",
            "summariserModel": ""
        })
    }

    #[test]
    fn missing_read_seeds_and_corrupt_or_invalid_files_are_not_clobbered() {
        let fixture = Fixture::new();
        let path = fixture.file();
        let doc = get(&path);
        assert_eq!(doc["models"].as_array().unwrap().len(), 22);
        assert_eq!(doc["defaultModel"], "claude");
        assert_eq!(doc["summariserModel"], "deepseek-v4-flash:cloud");
        let codex = doc["models"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|model| model["group"] == "codex")
            .map(|model| model["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            codex,
            [
                "gpt-6-luna",
                "gpt-6-sol",
                "gpt-6.1-sol",
                "gpt-6.1-terra",
                "gpt-5.4",
                "gpt-5.4-mini",
                "gpt-5.4-pro"
            ],
            "codex seed mirrors model-store.mjs, terra directly after gpt-6.1-sol"
        );
        let terra = doc["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["id"] == "gpt-6.1-terra")
            .unwrap();
        assert_eq!(terra["group"], "codex");
        assert_eq!(terra["label"], "");
        assert_eq!(terra["enabled"], true);
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
            doc
        );

        let blocked_parent = fixture.0.join("blocked-parent");
        fs::write(&blocked_parent, "file cannot be a directory").unwrap();
        let unwritable_path = blocked_parent.join("models.json");
        assert_eq!(get(&unwritable_path.to_string_lossy()), doc);
        assert!(blocked_parent.is_file());

        fs::write(&path, b"{broken").unwrap();
        assert_eq!(get(&path), doc);
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        fs::write(&path, br#"{"models":[{"id":"x","group":"unsupported"}]}"#).unwrap();
        assert_eq!(get(&path), doc);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"models":[{"id":"x","group":"unsupported"}]}"#
        );
    }

    #[test]
    fn validates_js_normalization_exact_errors_and_utf16_label_length() {
        let normalized = validate(&json!({
            "models": [{ "id": "\u{feff}opus\u{00a0}", "group": "claude", "label": 9, "enabled": 0 }],
            "defaultModel": " opus ",
            "summariserModel": null
        }))
        .unwrap();
        assert_eq!(
            normalized["models"][0],
            json!({
                "id": "opus", "group": "claude", "label": "", "enabled": true
            })
        );
        assert_eq!(normalized["defaultModel"], "opus");
        assert!(
            validate(&json!({"models":[{"id":"x","group":"bad"}]}))
                .unwrap_err()
                .contains("unknown group 'bad' for 'x'")
        );
        assert_eq!(
            validate(
                &json!({"models":[{"id":" opus ","group":"claude"},{"id":"opus","group":"claude"}]})
            )
            .unwrap_err(),
            "duplicate model id 'opus'"
        );
        assert_eq!(
            validate(&json!({"models":[{"id":"   ","group":"claude"}]})).unwrap_err(),
            "model id must not be empty"
        );
        assert_eq!(
            validate(&json!({"models":[{"id":"luna","group":"codex"}]})).unwrap_err(),
            "codex model 'luna' must be a gpt-* id"
        );
        assert_eq!(
            validate(&json!({"models":[{"id":"opus","group":"claude","label":"😀".repeat(41)}]}))
                .unwrap_err(),
            "label too long for 'opus' (max 80)"
        );
        let too_many = (0..201)
            .map(|i| json!({"id":format!("m{i}"),"group":"claude"}))
            .collect::<Vec<_>>();
        assert_eq!(
            validate(&json!({"models":too_many})).unwrap_err(),
            "too many models (max 200)"
        );
        assert_eq!(
            validate(&json!({"models":[{"id":"opus","group":"claude"}],"defaultModel":"ghost"}))
                .unwrap_err(),
            "defaultModel 'ghost' is not an enabled model"
        );
        assert_eq!(
            validate(&json!({"models":[{"id":"gpt-6-sol","group":"codex","enabled":false}],"summariserModel":"gpt-6-sol"})).unwrap_err(),
            "summariserModel 'gpt-6-sol' is not an enabled model"
        );
    }

    #[test]
    fn set_atomically_replaces_existing_file_and_reports_storage_errors() {
        let fixture = Fixture::new();
        let path = fixture.file();
        get(&path);
        let custom = one_model("opus", "claude", true);
        assert_eq!(set(&path, &custom)["ok"], true);
        assert_eq!(get(&path), validate(&custom).unwrap());

        let blocked = fixture.0.join("blocked");
        fs::write(&blocked, "parent file").unwrap();
        let failed = set(&blocked.join("models.json").to_string_lossy(), &custom);
        assert_eq!(failed["ok"], false);
        assert!(failed["error"].as_str().is_some());
    }

    #[test]
    fn restore_preserves_order_custom_rows_and_disabled_entries() {
        let fixture = Fixture::new();
        let path = fixture.file();
        let current = json!({
            "models": [
                { "id": "opus", "group": "claude", "label": "Renamed", "enabled": false },
                { "id": "custom", "group": "ollama", "label": "Mine", "enabled": true }
            ],
            "defaultModel": "",
            "summariserModel": ""
        });
        assert_eq!(set(&path, &current)["ok"], true);
        let restored = restore(&path);
        let rows = restored["models"].as_array().unwrap();
        assert_eq!(rows[0]["label"], "Renamed");
        assert_eq!(rows[0]["enabled"], false);
        assert_eq!(rows[1]["id"], "custom");
        assert_eq!(rows[2]["id"], "claude");
        assert_eq!(rows.len(), 23);
        assert_eq!(restore(&path), restored);
    }

    #[test]
    fn routing_classifies_once_preserves_stored_disabled_groups_and_aliases() {
        let fixture = Fixture::new();
        let path = fixture.file();
        let state = json!({
            "models": [
                {"id":"zephyr-9","group":"claude","enabled":false},
                {"id":"gpt-custom","group":"ollama","enabled":true},
                {"id":"claude-opus-9","group":"ollama","enabled":true}
            ],
            "defaultModel":"",
            "summariserModel":""
        });
        assert_eq!(set(&path, &state)["ok"], true);
        let custom = route(&path, &json!("zephyr-9"), &Value::Null);
        assert_eq!(custom["group"], "claude");
        assert_eq!(custom["isClaudeModel"], true);
        assert_eq!(
            route(&path, &json!("gpt-custom"), &Value::Null)["isCodexModel"],
            false
        );
        assert_eq!(
            route(&path, &json!("gpt-free"), &Value::Null)["isCodexModel"],
            true
        );
        assert_eq!(
            route(&path, &json!("unlisted"), &Value::Null)["group"],
            Value::Null
        );
        assert_eq!(
            route(&path, &json!("claude-opus-9"), &Value::Null)["claudeAlias"],
            "opus"
        );
        assert_eq!(
            route(&path, &json!("claude-sonnet-9[1m]"), &Value::Null)["claudeAlias"],
            "sonnet[1m]"
        );
        assert_eq!(
            route(&path, &json!("claude-opus-9[1m]"), &Value::Null)["claudeAlias"],
            "opus[1m]"
        );
        assert_eq!(
            route(&path, &json!("opus"), &Value::Null)["claudeAlias"],
            "opus"
        );
        assert_eq!(
            route(&path, &json!("gpt-free"), &json!("claude"))["toolModelError"],
            "model 'gpt-free' is not valid for tool 'claude'"
        );
        assert_eq!(
            route(&path, &Value::Null, &json!("codex"))["toolModelError"],
            Value::Null
        );
    }

    #[test]
    fn summariser_selects_any_enabled_group_and_returns_null_when_unset() {
        let fixture = Fixture::new();
        let path = fixture.file();
        for (id, group) in [
            ("opus", "claude"),
            ("gpt-6-sol", "codex"),
            ("custom", "ollama"),
        ] {
            let state = json!({
                "models": [{"id":id,"group":group,"enabled":true}],
                "defaultModel":"",
                "summariserModel":id
            });
            assert_eq!(set(&path, &state)["ok"], true);
            assert_eq!(summariser(&path), json!({"id":id,"group":group}));
        }
        assert_eq!(
            set(&path, &json!({"models":[],"summariserModel":""}))["ok"],
            true
        );
        assert_eq!(summariser(&path), Value::Null);
    }
}
