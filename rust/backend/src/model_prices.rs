use serde_json::{Value, value::RawValue};
use std::fs;

const DEFAULT_THRESHOLD: u64 = 200_000;

fn raw_json(json: String) -> Box<RawValue> {
    RawValue::from_string(json).expect("canonical JSON response is valid")
}

fn fallback() -> Box<RawValue> {
    raw_json(
        r#"{"pricing":{"base":{},"above_200k":{},"long_context_threshold":200000,"default_key":""},"base_keys":[]}"#
            .to_owned(),
    )
}

fn object_json(entries: &[(String, String)]) -> String {
    format!(
        "{{{}}}",
        entries
            .iter()
            .map(|(key, value)| format!("{key}:{value}"))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn selected_object(entries: &[(String, String)], key: &str) -> Vec<(String, String)> {
    entries
        .iter()
        .find(|(candidate, _)| candidate == key)
        .and_then(|(_, token)| {
            token
                .starts_with('{')
                .then(|| {
                    crate::transcripts::ordered_json_object_entries_preserving_numbers(token).ok()
                })
                .flatten()
        })
        .unwrap_or_default()
}

/// Read and normalize a pricing file. File errors and invalid JSON keep the
/// existing API fallback; this operation never creates or modifies the file.
pub fn read_pricing(path: &str) -> Box<RawValue> {
    let Ok(bytes) = fs::read(path) else {
        return fallback();
    };
    let text = String::from_utf8_lossy(&bytes);
    let Ok(doc) = crate::transcripts::ordered_json_object_entries_preserving_numbers(&text) else {
        return fallback();
    };
    const BASE: &str = "\"base\"";
    const ABOVE: &str = "\"above_200k\"";
    const THRESHOLD: &str = "\"long_context_threshold\"";
    const DEFAULT_KEY: &str = "\"default_key\"";
    let layered = [BASE, ABOVE, THRESHOLD, DEFAULT_KEY]
        .iter()
        .any(|key| doc.iter().any(|(candidate, _)| candidate == key));
    let base = if layered {
        selected_object(&doc, BASE)
    } else {
        doc.clone()
    };
    let above = selected_object(&doc, ABOVE);
    let threshold = doc
        .iter()
        .find(|(key, _)| key == THRESHOLD)
        .and_then(|(_, token)| token.parse::<f64>().ok())
        .filter(|number| number.is_finite() && *number > 0.0 && number.fract() == 0.0)
        .map(|_| {
            doc.iter()
                .find(|(key, _)| key == THRESHOLD)
                .map(|(_, token)| token.as_str())
                .unwrap_or("200000")
        })
        .unwrap_or("200000");
    let default_key = doc
        .iter()
        .find(|(key, _)| key == DEFAULT_KEY)
        .map(|(_, token)| token.as_str())
        .filter(|token| token.starts_with('"'))
        .unwrap_or("\"\"");
    let base_keys = base
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<Vec<_>>()
        .join(",");
    raw_json(format!(
        "{{\"pricing\":{{\"base\":{},\"above_200k\":{},\"long_context_threshold\":{},\"default_key\":{}}},\"base_keys\":[{}]}}",
        object_json(&base),
        object_json(&above),
        threshold,
        default_key,
        base_keys,
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

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

    fn value(path: &str) -> Value {
        serde_json::from_str(read_pricing(path).get()).unwrap()
    }

    #[test]
    fn missing_corrupt_and_unreadable_files_use_defaults() {
        let fixture = Fixture::new();
        assert_eq!(read_pricing(&fixture.file()).get(), fallback().get());
        write(fixture.0.join("pricing.json"), "not json").unwrap();
        assert_eq!(read_pricing(&fixture.file()).get(), fallback().get());
        assert_eq!(
            read_pricing(fixture.0.to_str().unwrap()).get(),
            fallback().get()
        );
    }

    #[test]
    fn legacy_and_layered_tables_preserve_key_order_and_normalize_defaults() {
        let fixture = Fixture::new();
        write(fixture.0.join("pricing.json"), r#"{"base":{"z":[1,2,3,4],"a":[5,6,7,8]},"above_200k":null,"long_context_threshold":12.0,"default_key":7}"#).unwrap();
        let doc = value(&fixture.file());
        assert_eq!(doc["base_keys"], json!(["z", "a"]));
        assert_eq!(
            doc["pricing"]["long_context_threshold"].as_f64(),
            Some(12.0)
        );
        assert_eq!(doc["pricing"]["default_key"], "");
        write(
            fixture.0.join("pricing.json"),
            r#"{"z":[1,2,3,4],"a":[5,6,7,8]}"#,
        )
        .unwrap();
        assert_eq!(value(&fixture.file())["base_keys"], json!(["z", "a"]));
    }

    #[test]
    fn integer_thresholds_and_duplicate_leaf_keys_match_javascript_order() {
        let fixture = Fixture::new();
        write(fixture.0.join("pricing.json"), r#"{"base":{"1":[1,2,3,4],"z":[1,2,3,4],"0":[1,2,3,4],"01":[1,2,3,4],"4294967295":[1,2,3,4],"4294967294":[1,2,3,4],"__proto__":[1,2,3,4],"z":[5,6,7,8]},"long_context_threshold":1e30}"#).unwrap();
        let doc = value(&fixture.file());
        assert_eq!(doc["pricing"]["long_context_threshold"], json!(1e30));
        assert_eq!(
            doc["base_keys"],
            json!(["0", "1", "4294967294", "z", "01", "4294967295", "__proto__"])
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
        let doc = value(&fixture.file());
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
        let doc = value(&fixture.file());
        assert_eq!(doc["base_keys"], json!(["c", "b"]));
        assert_eq!(doc["pricing"]["base"]["c"], json!([1, 2, 3, 4]));
    }

    #[test]
    fn measured_depth_127_128_and_129_values_are_preserved() {
        let fixture = Fixture::new();
        for depth in [127, 128, 129] {
            let mut nested = "1".to_owned();
            for _ in 0..(depth - 2) {
                nested = format!("[{nested}]");
            }
            write(
                fixture.0.join("pricing.json"),
                format!(r#"{{"base":{{"model":{nested}}}}}"#),
            )
            .unwrap();
            let output = read_pricing(&fixture.file());
            assert!(output.get().contains(&format!("\"model\":{nested}")));
            assert!(!output.get().contains("\"base\":{},\"above_200k\":{}"));
        }
    }

    #[test]
    fn escaped_lone_surrogate_base_key_survives_raw_response() {
        let fixture = Fixture::new();
        write(
            fixture.0.join("pricing.json"),
            r#"{"base":{"\ud800":[1,2,3,4]}}"#,
        )
        .unwrap();
        let output = read_pricing(&fixture.file());
        assert!(output.get().contains(r#""\ud800":[1,2,3,4]"#));
        assert!(output.get().contains(r#""base_keys":["\ud800"]"#));
    }

    #[test]
    fn malformed_utf8_in_key_uses_node_replacement_character_decoding() {
        let fixture = Fixture::new();
        let mut bytes = b"{\"base\":{\"".to_vec();
        bytes.push(0xff);
        bytes.extend_from_slice(b"\":[1,2,3,4]}}");
        fs::write(fixture.0.join("pricing.json"), bytes).unwrap();
        let output = read_pricing(&fixture.file());
        assert!(output.get().contains("\"�\":[1,2,3,4]"));
        assert!(output.get().contains("\"base_keys\":[\"�\"]"));
    }

    #[test]
    fn invalid_json_number_spelling_uses_fallback() {
        let fixture = Fixture::new();
        write(fixture.0.join("pricing.json"), r#"{"base":{"model":01}}"#).unwrap();
        assert_eq!(
            read_pricing(&fixture.file()).get(),
            r#"{"pricing":{"base":{},"above_200k":{},"long_context_threshold":200000,"default_key":""},"base_keys":[]}"#,
        );
    }

    #[test]
    fn only_json_whitespace_is_accepted_around_pricing_documents() {
        let fixture = Fixture::new();
        let document = br#"{"base":{"m":[1,2,3,4]}}"#;
        for whitespace in [b" ".as_slice(), b"\t", b"\n", b"\r"] {
            let mut bytes = whitespace.to_vec();
            bytes.extend_from_slice(document);
            bytes.extend_from_slice(whitespace);
            fs::write(fixture.0.join("pricing.json"), bytes).unwrap();
            assert!(
                read_pricing(&fixture.file())
                    .get()
                    .contains("\"m\":[1,2,3,4]")
            );
        }
        for invalid in [0x0b, 0x0c] {
            let mut bytes = vec![invalid];
            bytes.extend_from_slice(document);
            fs::write(fixture.0.join("pricing.json"), bytes).unwrap();
            assert_eq!(read_pricing(&fixture.file()).get(), fallback().get());
        }
    }
}
