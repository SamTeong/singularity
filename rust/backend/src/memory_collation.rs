//! Locale-aware ordering for memory files. ICU4X and Node may use different data versions.
use icu_collator::{Collator, options::CollatorOptions};
use icu_locale_core::Locale;
use serde_json::Value;

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("")
}

/// Choose the host locale once when constructing the memory routes.
pub(crate) fn system_locale() -> String {
    sys_locale::get_locale()
        .map(|locale| locale.replace('_', "-"))
        .filter(|locale| {
            locale.parse::<Locale>().ok().is_some_and(|locale| {
                Collator::try_new(locale.into(), CollatorOptions::default()).is_ok()
            })
        })
        .unwrap_or_else(|| "en-US".to_owned())
}

pub(crate) fn sort_files(files: &mut [Value], locale: &str) -> Result<(), String> {
    let locale: Locale = locale
        .parse()
        .map_err(|error| format!("invalid locale: {error}"))?;
    let collator = Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|error| error.to_string())?;
    files.sort_by(|a, b| {
        collator
            .compare(field(a, "project"), field(b, "project"))
            .then_with(|| collator.compare(field(a, "file"), field(b, "file")))
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sort_files;
    use serde_json::json;

    #[test]
    fn sorts_project_then_file_with_locale_rules() {
        let mut files = vec![
            json!({"project":"zeta","file":"a.md"}),
            json!({"project":"Alpha","file":"é.md"}),
            json!({"project":"Alpha","file":"B.md"}),
            json!({"project":"Alpha","file":"a.md"}),
        ];
        sort_files(&mut files, "en-SG").unwrap();
        assert_eq!(
            files
                .iter()
                .map(|v| v["file"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["a.md", "B.md", "é.md", "a.md"]
        );
    }

    #[test]
    fn falls_back_for_representative_locales_without_specific_data() {
        let mut files = vec![json!({"project":"p", "file":"a.md"})];
        for locale in ["und", "zz-ZZ", "de-u-co-phonebk", "zh-u-co-stroke"] {
            sort_files(&mut files, locale).unwrap();
        }
    }

    #[test]
    fn matches_node_on_representative_locale_corpus() {
        let node = std::env::var_os("NODE_BINARY").unwrap_or_else(|| "node".into());
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/memory_collation_oracle.mjs");
        for locale in ["en-SG", "sv-SE", "tr-TR"] {
            let output = std::process::Command::new(&node)
                .arg(&script)
                .arg(locale)
                .output()
                .expect("run Node collation oracle");
            assert!(output.status.success(), "Node oracle failed for {locale}");
            let expected: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
            let mut files: Vec<_> = [
                "Alpha", "zeta", "éclair", "a", "B", "é", "e", "ä", "ö", "i", "I",
            ]
            .into_iter()
            .map(|name| json!({"project":"p", "file":name}))
            .collect();
            sort_files(&mut files, locale).unwrap();
            let actual: Vec<_> = files.iter().map(|v| v["file"].as_str().unwrap()).collect();
            assert_eq!(actual, expected, "collation mismatch for {locale}");
        }
    }
}
