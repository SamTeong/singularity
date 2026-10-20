use serde_json::{Map, Value, json};
use std::fs;
use std::path::Path;

const MODIFIERS: &[&str] = &["alt", "ctrl", "shift", "meta", "mod"];
const MAX_ENTRIES: usize = 64;

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some('a'..='z'))
        && id.len() <= 33
        && chars.all(|ch| ch.is_ascii_alphanumeric())
}

fn js_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn sanitise(value: &Value) -> Option<Value> {
    if value.is_null() {
        return Some(Value::Null);
    }
    let object = value.as_object()?;
    let mut entry = Map::new();
    for (field, max) in [("key", 32), ("doubleTap", 16)] {
        if let Some(text) = object.get(field).and_then(Value::as_str) {
            let length = js_length(text);
            if (1..=max).contains(&length) {
                entry.insert(field.to_owned(), Value::String(text.to_owned()));
            }
        }
    }
    for field in MODIFIERS {
        if let Some(value @ Value::Bool(_)) = object.get(*field) {
            entry.insert((*field).to_owned(), value.clone());
        }
    }
    (!entry.is_empty() && (entry.contains_key("key") || entry.contains_key("doubleTap")))
        .then_some(Value::Object(entry))
}

fn read(path: &str) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn persist(path: &str, keys: &Map<String, Value>) -> Result<(), String> {
    let file = Path::new(path);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let contents = serde_json::to_string(keys).expect("JSON values serialize");
    fs::write(file, contents).map_err(|error| error.to_string())
}

pub fn get(path: &str) -> Value {
    Value::Object(read(path))
}

pub fn set(path: &str, patch: &Value) -> Value {
    let mut keys = read(path);
    if let Some(patch) = patch.as_object() {
        for (id, value) in patch {
            if !valid_id(id) {
                continue;
            }
            match sanitise(value) {
                Some(Value::Null) => {
                    keys.remove(id);
                }
                Some(entry) => {
                    keys.insert(id.clone(), entry);
                }
                None => {}
            }
        }
    }
    let mut position = 0;
    keys.retain(|_, _| {
        position += 1;
        position <= MAX_ENTRIES
    });
    match persist(path, &keys) {
        Ok(()) => json!({"ok": true, "keys": keys}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Temp(PathBuf);
    use std::path::PathBuf;
    impl Temp {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-keys-{id}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> String {
            self.0
                .join("state/keys.json")
                .to_string_lossy()
                .into_owned()
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn patch_filters_merges_deletes_and_caps_in_insertion_order() {
        let temp = Temp::new();
        let mut patch = Map::new();
        for i in 0..80 {
            patch.insert(
                format!("k{i}"),
                json!({"key": format!("{i}"), "extra": true}),
            );
        }
        let result = set(&temp.file(), &Value::Object(patch));
        assert_eq!(result["keys"].as_object().unwrap().len(), 64);
        assert!(result["keys"].get("k0").is_some());
        assert!(result["keys"].get("k64").is_none());
        let result = set(
            &temp.file(),
            &json!({"k0": null, "valid": {"key":"x","extra":1}}),
        );
        assert_eq!(result["keys"]["valid"], json!({"key":"x"}));
        assert!(result["keys"].get("k0").is_none());
    }

    #[test]
    fn malformed_reads_fall_back_and_write_failures_keep_result_shape() {
        let temp = Temp::new();
        let path = temp.file();
        fs::create_dir_all(Path::new(&path).parent().unwrap()).unwrap();
        fs::write(&path, "{not valid JSON").unwrap();
        assert_eq!(get(&path), json!({}));
        fs::write(&path, "[]").unwrap();
        assert_eq!(get(&path), json!({}));
        let result = set(&temp.0.to_string_lossy(), &json!({"ok": {"key":"x"}}));
        assert_eq!(result["ok"], false);
        assert!(result["error"].is_string());
    }

    #[test]
    fn string_lengths_follow_javascript_utf16_units() {
        assert!(sanitise(&json!({"key": "😀".repeat(16)})).is_some());
        assert!(sanitise(&json!({"key": "😀".repeat(17)})).is_none());
    }
}
