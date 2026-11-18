use serde_json::{Map, Value, json};
use std::fs;
use std::path::Path;

fn defaults() -> Value {
    json!({ "root": "~", "expanded": [], "tabs": [], "active": null, "autosave": false })
}

fn spread_into(state: &mut Map<String, Value>, stored: Value) {
    match stored {
        Value::Object(fields) => state.extend(fields),
        Value::Array(values) => {
            for (index, value) in values.into_iter().enumerate() {
                state.insert(index.to_string(), value);
            }
        }
        Value::String(value) => {
            for (index, character) in value.chars().enumerate() {
                state.insert(index.to_string(), Value::String(character.to_string()));
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn read_state(path: &str) -> Value {
    let mut state = defaults()
        .as_object()
        .expect("defaults are an object")
        .clone();
    if let Ok(contents) = fs::read_to_string(path) {
        if let Ok(stored) = serde_json::from_str::<Value>(&contents) {
            spread_into(&mut state, stored);
        }
    }
    Value::Object(state)
}

pub fn get(path: &str) -> Value {
    read_state(path)
}

fn valid_strings(value: &Value) -> Option<Value> {
    let Value::Array(items) = value else {
        return None;
    };
    Some(Value::Array(
        items
            .iter()
            .filter(|item| item.is_string())
            .take(500)
            .cloned()
            .collect(),
    ))
}

fn merge_patch(mut current: Value, patch: &Value) -> Value {
    let state = current
        .as_object_mut()
        .expect("read_state returns an object");
    if let Some(root) = patch
        .get("root")
        .and_then(Value::as_str)
        .filter(|root| !root.is_empty())
    {
        state.insert("root".to_owned(), Value::String(root.to_owned()));
    }
    if let Some(expanded) = patch.get("expanded").and_then(valid_strings) {
        state.insert("expanded".to_owned(), expanded);
    }
    if let Some(tabs) = patch.get("tabs").and_then(valid_strings) {
        state.insert("tabs".to_owned(), tabs);
    }
    if let Some(active) = patch.get("active") {
        if active.is_string() || active.is_null() {
            state.insert("active".to_owned(), active.clone());
        }
    }
    if let Some(autosave) = patch.get("autosave").and_then(Value::as_bool) {
        state.insert("autosave".to_owned(), Value::Bool(autosave));
    }
    Value::Object(state.clone())
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
                "singularity-explorer-state-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir.join("state").join("explorer-state.json"))
        }

        fn write(&self, raw: &str) {
            fs::create_dir_all(self.0.parent().unwrap()).unwrap();
            fs::write(&self.0, raw).unwrap();
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
    fn missing_and_malformed_storage_return_defaults_without_repair() {
        let fixture = Fixture::new();
        let expected =
            json!({ "root": "~", "expanded": [], "tabs": [], "active": null, "autosave": false });
        assert_eq!(get(fixture.0.to_str().unwrap()), expected);
        fixture.write("{ malformed");
        assert_eq!(get(fixture.0.to_str().unwrap()), expected);
        assert_eq!(fs::read_to_string(&fixture.0).unwrap(), "{ malformed");
    }

    #[test]
    fn stored_unknown_and_wrong_typed_values_survive_allowlisted_merge() {
        let fixture = Fixture::new();
        fixture.write(r#"{"root":9,"expanded":"old","custom":{"keep":true},"tabs":["legacy"]}"#);
        let result = set(
            fixture.0.to_str().unwrap(),
            &json!({ "root": "~/work", "unknownPatch": 1 }),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["state"]["root"], "~/work");
        assert_eq!(result["state"]["expanded"], "old");
        assert_eq!(result["state"]["custom"], json!({ "keep": true }));
        assert_eq!(result["state"]["tabs"], json!(["legacy"]));
    }

    #[test]
    fn valid_nonobject_json_keeps_legacy_spread_properties() {
        let fixture = Fixture::new();
        fixture.write(r#"["first",null,3]"#);
        assert_eq!(get(fixture.0.to_str().unwrap())["0"], "first");
        assert_eq!(get(fixture.0.to_str().unwrap())["1"], Value::Null);
        fixture.write(r#""ab""#);
        assert_eq!(get(fixture.0.to_str().unwrap())["0"], "a");
        assert_eq!(get(fixture.0.to_str().unwrap())["1"], "b");
        fixture.write(r#""😀""#);
        assert_eq!(get(fixture.0.to_str().unwrap())["0"], "😀");
        assert!(get(fixture.0.to_str().unwrap()).get("1").is_none());
    }

    #[test]
    fn arrays_filter_and_cap_then_noop_patch_still_persists() {
        let fixture = Fixture::new();
        let values: Vec<Value> = (0..501)
            .map(|index| json!(format!("tab-{index}")))
            .collect();
        let result = set(
            fixture.0.to_str().unwrap(),
            &json!({ "tabs": values, "expanded": [null, "/a"] }),
        );
        assert_eq!(result["state"]["tabs"].as_array().unwrap().len(), 500);
        assert_eq!(result["state"]["expanded"], json!(["/a"]));
        assert_eq!(set(fixture.0.to_str().unwrap(), &Value::Null)["ok"], true);
        assert_eq!(get(fixture.0.to_str().unwrap()), result["state"]);
    }

    #[test]
    fn persistence_failure_is_reported() {
        let fixture = Fixture::new();
        let blocker = fixture.0.parent().unwrap().join("blocker");
        fs::create_dir_all(fixture.0.parent().unwrap()).unwrap();
        fs::write(&blocker, "file").unwrap();
        let result = set(blocker.join("state.json").to_str().unwrap(), &Value::Null);
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().is_some());
    }
}
