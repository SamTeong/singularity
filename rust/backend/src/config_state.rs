use serde_json::{Map, Value, json};
use std::fs;
use std::path::Path;

fn defaults() -> Value {
    json!({ "tabs": [], "active": null, "autosave": false, "expanded": [] })
}

fn read_state(path: &str) -> Value {
    let mut state = defaults().as_object().unwrap().clone();
    if let Ok(contents) = fs::read_to_string(path) {
        if let Ok(fields) = serde_json::from_str::<Map<String, Value>>(&contents) {
            state.extend(fields);
        }
    }
    Value::Object(state)
}

pub fn get(path: &str) -> Value {
    read_state(path)
}

fn tabs(value: &Value) -> Option<Value> {
    let items = value.as_array()?;
    let mut output = Vec::new();
    for item in items {
        let Some(tab) = item.as_object() else {
            continue;
        };
        let (Some(cwd), Some(tool), Some(scope)) = (
            tab.get("cwd").and_then(Value::as_str),
            tab.get("tool").and_then(Value::as_str),
            tab.get("scope").and_then(Value::as_str),
        ) else {
            continue;
        };
        output.push(json!({
            "cwd": cwd,
            "tool": tool,
            "scope": scope,
            "path": tab.get("path").and_then(Value::as_str).unwrap_or("")
        }));
        if output.len() == 50 {
            break;
        }
    }
    Some(Value::Array(output))
}

fn strings(value: &Value) -> Option<Value> {
    let items = value.as_array()?;
    Some(Value::Array(
        items
            .iter()
            .filter(|item| item.is_string())
            .take(500)
            .cloned()
            .collect(),
    ))
}

fn merge_patch(mut state: Value, patch: &Value) -> Value {
    let values = state.as_object_mut().unwrap();
    if let Some(tabs) = patch.get("tabs").and_then(tabs) {
        values.insert("tabs".to_owned(), tabs);
    }
    if let Some(active) = patch.get("active") {
        if active.is_string() || active.is_null() {
            values.insert("active".to_owned(), active.clone());
        }
    }
    if let Some(autosave) = patch.get("autosave").and_then(Value::as_bool) {
        values.insert("autosave".to_owned(), Value::Bool(autosave));
    }
    if let Some(expanded) = patch.get("expanded").and_then(strings) {
        values.insert("expanded".to_owned(), expanded);
    }
    Value::Object(values.clone())
}

pub fn set(path: &str, patch: &Value) -> Value {
    let next = merge_patch(read_state(path), patch);
    let result = (|| {
        if let Some(parent) = Path::new(path).parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(
            path,
            serde_json::to_string(&next).expect("JSON values serialize"),
        )
    })();
    match result {
        Ok(()) => json!({ "ok": true, "state": next }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::{get, set};
    use serde_json::{Value, json};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "singularity-config-state-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir.join("state").join("config-state.json"))
        }

        fn write(&self, raw: &str) {
            fs::create_dir_all(self.0.parent().unwrap()).unwrap();
            fs::write(&self.0, raw).unwrap();
        }

        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(parent) = self.0.parent().and_then(|path| path.parent()) {
                let _ = fs::remove_dir_all(parent);
            }
        }
    }

    #[test]
    fn missing_malformed_and_nonobject_storage_use_defaults() {
        let fixture = Fixture::new();
        let expected = json!({ "tabs": [], "active": null, "autosave": false, "expanded": [] });
        assert_eq!(get(fixture.path()), expected);
        fixture.write("{malformed");
        assert_eq!(get(fixture.path()), expected);
        for raw in [
            r#"["first",null,3]"#,
            r#""text""#,
            r#""😀""#,
            r#""café""#,
            "42",
            "true",
            "null",
        ] {
            fixture.write(raw);
            assert_eq!(get(fixture.path()), expected, "{raw}");
        }
    }

    #[test]
    fn stored_fields_survive_and_valid_patches_merge_partially() {
        let fixture = Fixture::new();
        fixture.write(
            r#"{"tabs":"old","active":12,"autosave":"yes","expanded":["old"],"extra":true}"#,
        );
        let result = set(
            fixture.path(),
            &json!({
                "tabs": [
                    {"cwd":"", "tool":"", "scope":"", "path":7},
                    {"cwd":"/a", "tool":"claude", "scope":"project", "path":"/a/config"},
                    {"cwd":"/bad"}, null
                ],
                "active": null,
                "autosave": true,
                "expanded": ["", 1, "/a"]
            }),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(
            result["state"]["tabs"],
            json!([
                {"cwd":"", "tool":"", "scope":"", "path":""},
                {"cwd":"/a", "tool":"claude", "scope":"project", "path":"/a/config"}
            ])
        );
        assert_eq!(result["state"]["active"], Value::Null);
        assert_eq!(result["state"]["autosave"], true);
        assert_eq!(result["state"]["expanded"], json!(["", "/a"]));
        assert_eq!(result["state"]["extra"], true);
        let partial = set(fixture.path(), &json!({"autosave": false, "active": 5}));
        assert_eq!(partial["state"]["autosave"], false);
        assert_eq!(partial["state"]["active"], Value::Null);
        assert_eq!(partial["state"]["tabs"], result["state"]["tabs"]);
    }

    #[test]
    fn tab_and_expanded_limits_apply_after_filtering() {
        let fixture = Fixture::new();
        let tab_values: Vec<Value> = (0..60)
            .map(|index| json!({"cwd":format!("/{index}"), "tool":"claude", "scope":"project"}))
            .collect();
        let expanded_values: Vec<Value> =
            (0..510).map(|index| json!(format!("/{index}"))).collect();
        let mut tabs = vec![Value::Null, json!({"cwd":"bad"})];
        tabs.extend(tab_values);
        let mut expanded = vec![Value::Null];
        expanded.extend(expanded_values);
        let result = set(
            fixture.path(),
            &json!({ "tabs": tabs, "expanded": expanded }),
        );
        assert_eq!(result["state"]["tabs"].as_array().unwrap().len(), 50);
        assert_eq!(result["state"]["expanded"].as_array().unwrap().len(), 500);
    }

    #[test]
    fn failed_writes_keep_error_result_shape() {
        let fixture = Fixture::new();
        let blocker = fixture.0.parent().unwrap().join("blocker");
        fs::create_dir_all(fixture.0.parent().unwrap()).unwrap();
        fs::write(&blocker, "file").unwrap();
        let result = set(blocker.join("state.json").to_str().unwrap(), &Value::Null);
        assert_eq!(result["ok"], false);
        assert!(result["error"].is_string());
    }
}
