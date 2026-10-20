use serde_json::{Value, json};
use std::fs;

const DEFAULT_THRESHOLD: u64 = 200_000;

fn positive_integer(value: Option<&Value>) -> Option<serde_json::Number> {
    let value = value?;
    if let Some(n) = value.as_u64() {
        return (n > 0).then(|| value.as_number().unwrap().clone());
    }
    let n = value.as_f64()?;
    (n.is_finite() && n > 0.0 && n.fract() == 0.0).then(|| value.as_number().unwrap().clone())
}

fn fallback() -> Value {
    json!({"pricing":{"base":{},"above_200k":{},"long_context_threshold":DEFAULT_THRESHOLD,"default_key":""},"base_keys":[]})
}

/// Read and normalize a pricing file. File errors and invalid JSON keep the
/// existing API fallback; this operation never creates or modifies the file.
pub fn read_pricing(path: &str) -> Value {
    let Ok(text) = fs::read_to_string(path) else {
        return fallback();
    };
    let Ok(Value::Object(doc)) = serde_json::from_str::<Value>(&text) else {
        return fallback();
    };
    let layered = [
        "base",
        "above_200k",
        "long_context_threshold",
        "default_key",
    ]
    .iter()
    .any(|key| doc.contains_key(*key));
    let base_value = if layered { doc.get("base") } else { None };
    let base = if layered {
        base_value
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    } else {
        doc.clone()
    };
    let base_keys = if layered {
        base_value
            .and_then(Value::as_object)
            .map(|base| base.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
    } else {
        doc.keys().cloned().collect()
    };
    let above = doc
        .get("above_200k")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let threshold = positive_integer(doc.get("long_context_threshold"))
        .map(Value::Number)
        .unwrap_or_else(|| json!(DEFAULT_THRESHOLD));
    let default_key = doc.get("default_key").and_then(Value::as_str).unwrap_or("");
    json!({"pricing":{"base":Value::Object(base),"above_200k":Value::Object(above),"long_context_threshold":threshold,"default_key":default_key},"base_keys":base_keys})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir, remove_dir_all, write};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let time = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let count = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("singularity-prices-{time}-{count}"));
            create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> String {
            self.0.join("pricing.json").to_string_lossy().into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_corrupt_and_unreadable_files_use_defaults() {
        let fixture = Fixture::new();
        assert_eq!(read_pricing(&fixture.file()), fallback());
        write(fixture.0.join("pricing.json"), "not json").unwrap();
        assert_eq!(read_pricing(&fixture.file()), fallback());
        assert_eq!(read_pricing(fixture.0.to_str().unwrap()), fallback());
    }

    #[test]
    fn legacy_and_layered_tables_preserve_key_order_and_normalize_defaults() {
        let fixture = Fixture::new();
        write(fixture.0.join("pricing.json"), r#"{"base":{"z":[1,2,3,4],"a":[5,6,7,8]},"above_200k":null,"long_context_threshold":12.0,"default_key":7}"#).unwrap();
        let doc = read_pricing(&fixture.file());
        assert_eq!(doc["base_keys"], json!(["z", "a"]));
        assert_eq!(doc["pricing"]["long_context_threshold"], json!(12.0));
        assert_eq!(doc["pricing"]["default_key"], "");
        write(
            fixture.0.join("pricing.json"),
            r#"{"z":[1,2,3,4],"a":[5,6,7,8]}"#,
        )
        .unwrap();
        assert_eq!(
            read_pricing(&fixture.file())["base_keys"],
            json!(["z", "a"])
        );
    }

    #[test]
    fn integer_thresholds_and_duplicate_leaf_keys_match_javascript_order() {
        let fixture = Fixture::new();
        write(fixture.0.join("pricing.json"), r#"{"base":{"1":[1,2,3,4],"z":[1,2,3,4],"0":[1,2,3,4],"01":[1,2,3,4],"4294967295":[1,2,3,4],"4294967294":[1,2,3,4],"__proto__":[1,2,3,4],"z":[5,6,7,8]},"long_context_threshold":1e30}"#).unwrap();
        let doc = read_pricing(&fixture.file());
        assert_eq!(doc["pricing"]["long_context_threshold"], json!(1e30));
        assert_eq!(
            doc["base_keys"],
            json!(["1", "z", "0", "01", "4294967295", "4294967294", "__proto__"])
        );
        assert_eq!(doc["pricing"]["base"]["z"], json!([5, 6, 7, 8]));
    }

    #[test]
    fn overflowing_exponents_parse_like_javascript_and_duplicate_base_uses_last_table() {
        let fixture = Fixture::new();
        write(
            fixture.0.join("pricing.json"),
            r#"{"base":{"model":[1,2,3,4]},"ignored":{"nested":[1e400,{"x":1e400}]},"long_context_threshold":1e400,"default_key":1e400}"#,
        )
        .unwrap();
        let doc = read_pricing(&fixture.file());
        assert_eq!(doc["pricing"]["base"]["model"], json!([1, 2, 3, 4]));
        assert_eq!(
            doc["pricing"]["long_context_threshold"],
            json!(DEFAULT_THRESHOLD)
        );
        assert_eq!(doc["pricing"]["default_key"], "");

        write(
            fixture.0.join("pricing.json"),
            r#"{"base":{"z":[1,2,3,4],"a":[1,2,3,4]},"base":{"c":[1,2,3,4],"b":[1,2,3,4]}}"#,
        )
        .unwrap();
        let doc = read_pricing(&fixture.file());
        assert_eq!(doc["base_keys"], json!(["c", "b"]));
        assert_eq!(doc["pricing"]["base"]["c"], json!([1, 2, 3, 4]));
    }
}
