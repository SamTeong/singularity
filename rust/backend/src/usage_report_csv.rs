//! Pure CSV parsing and writing for the bundled usage report schema.

pub const CSV_COLUMNS: [&str; 23] = [
    "timestamp",
    "session_id",
    "total_cost_usd",
    "last_model",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "model_id",
    "model_display_name",
    "duration_ms",
    "api_duration_ms",
    "lines_added",
    "lines_removed",
    "rl_5h_pct",
    "rl_7d_pct",
    "context_pct",
    "context_window_size",
    "turns",
    "tool_calls",
    "start_epoch",
    "facets_json",
    "est_cost_usd",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsvTable {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

/// Parse the permissive CSV dialect used by the bundled stats script.
pub fn parse_csv(input: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut chars = input.char_indices().peekable();
    let mut in_quotes = false;
    let mut started = false;

    while let Some((_, ch)) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek().is_some_and(|(_, next)| *next == '"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(ch);
            }
        } else {
            match ch {
                '"' => {
                    in_quotes = true;
                    started = true;
                }
                ',' => {
                    row.push(std::mem::take(&mut field));
                    started = true;
                }
                '\r' | '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                    started = false;
                    if ch == '\r' && chars.peek().is_some_and(|(_, next)| *next == '\n') {
                        chars.next();
                    }
                }
                _ => {
                    field.push(ch);
                    started = true;
                }
            }
        }
    }
    if started || !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// Parse a CSV header and rows, preserving duplicate headers and row shape.
pub fn dict_reader(input: &str) -> CsvTable {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let mut parsed = parse_csv(input).into_iter();
    let Some(headers) = parsed.next() else {
        return CsvTable {
            headers: Vec::new(),
            rows: Vec::new(),
        };
    };
    let rows = parsed
        .filter(|row| !(row.len() == 1 && row[0].is_empty()))
        .map(|row| {
            (0..headers.len())
                .map(|index| row.get(index).cloned())
                .collect()
        })
        .collect();
    CsvTable { headers, rows }
}

/// Return the value assigned last to `header`, as in the JS object reader.
pub fn row_value<'a>(
    table: &'a CsvTable,
    row: &'a [Option<String>],
    header: &str,
) -> Option<&'a str> {
    let index = table
        .headers
        .iter()
        .enumerate()
        .filter(|(_, name)| name.as_str() == header)
        .map(|(index, _)| index)
        .last()?;
    row.get(index).and_then(Option::as_deref)
}

#[derive(Debug, Clone, PartialEq)]
pub enum CsvValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<CsvValue>),
    Object,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeysetMismatch {
    pub missing: Vec<String>,
    pub extra: Vec<String>,
}

impl KeysetMismatch {
    pub fn mismatch_message(&self) -> String {
        format!(
            "stats.mjs: row schema mismatch (missing=[{}] extra=[{}])",
            self.missing.join(","),
            self.extra.join(",")
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedRow {
    pub row: String,
    pub mismatch: Option<KeysetMismatch>,
}

/// Serialize one row in canonical schema order; `entries` follows property insertion order.
pub fn encode_row(entries: &[(String, CsvValue)]) -> EncodedRow {
    let properties = ordered_properties(entries);
    let got = sorted_join(properties.iter().map(|(key, _)| key.as_str()));
    let want = sorted_join(CSV_COLUMNS);
    let mismatch = if got == want {
        None
    } else {
        let missing = CSV_COLUMNS
            .iter()
            .filter(|column| !properties.iter().any(|(key, _)| key.as_str() == **column))
            .map(|column| (*column).to_string())
            .collect();
        let extra = properties
            .iter()
            .filter(|(key, _)| !CSV_COLUMNS.contains(&key.as_str()))
            .map(|(key, _)| key.clone())
            .collect();
        Some(KeysetMismatch { missing, extra })
    };
    let cells = CSV_COLUMNS
        .iter()
        .map(|column| {
            properties
                .iter()
                .find(|(key, _)| key.as_str() == *column)
                .map(|(_, value)| js_string(value))
                .unwrap_or_default()
        })
        .map(|value| csv_field(&value))
        .collect::<Vec<_>>();
    EncodedRow {
        row: format!("{}\n", cells.join(",")),
        mismatch,
    }
}

fn csv_field(value: &str) -> String {
    if value
        .chars()
        .any(|ch| matches!(ch, ',' | '"' | '\r' | '\n'))
    {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn js_string(value: &CsvValue) -> String {
    match value {
        CsvValue::Null => String::new(),
        CsvValue::Bool(true) => "true".into(),
        CsvValue::Bool(false) => "false".into(),
        CsvValue::Number(value) => number_to_js_string(*value),
        CsvValue::String(value) => value.clone(),
        CsvValue::Array(values) => values
            .iter()
            .map(|value| match value {
                CsvValue::Null => String::new(),
                _ => js_string(value),
            })
            .collect::<Vec<_>>()
            .join(","),
        CsvValue::Object => "[object Object]".into(),
    }
}

fn number_to_js_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value == f64::INFINITY {
        return "Infinity".into();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    ryu_js::Buffer::new().format_finite(value).to_string()
}

fn ordered_properties(entries: &[(String, CsvValue)]) -> Vec<(String, CsvValue)> {
    let mut unique: Vec<(String, CsvValue)> = Vec::new();
    for (key, value) in entries {
        if let Some(existing) = unique.iter_mut().find(|(name, _)| name == key) {
            existing.1 = value.clone();
        } else {
            unique.push((key.clone(), value.clone()));
        }
    }
    let (mut indices, strings): (Vec<_>, Vec<_>) = unique
        .into_iter()
        .partition(|(key, _)| array_index(key).is_some());
    indices.sort_by_key(|(key, _)| array_index(key).unwrap());
    indices.extend(strings);
    indices
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

fn sorted_join<'a>(keys: impl IntoIterator<Item = &'a str>) -> String {
    let mut keys = keys.into_iter().collect::<Vec<_>>();
    keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    keys.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_keeps_permissive_quote_and_separator_behavior() {
        assert_eq!(
            parse_csv("a,b\r\n\"x,y\",\"line1\r\nline2\"\rZ,\"q\"tail\""),
            vec![
                vec!["a", "b"],
                vec!["x,y", "line1\r\nline2"],
                vec!["Z", "qtail"]
            ]
        );
        assert_eq!(parse_csv("a,\"open\r\nend"), vec![vec!["a", "open\r\nend"]]);
        assert!(parse_csv("").is_empty());
        assert_eq!(parse_csv("a\n"), vec![vec!["a"]]);
    }

    #[test]
    fn dict_reader_strips_one_bom_skips_blank_and_preserves_duplicates() {
        let table = dict_reader("\u{feff}x,x,y\r\n1,2\r\n\r\n,,\r\n");
        assert_eq!(table.headers, ["x", "x", "y"]);
        assert_eq!(
            table.rows,
            vec![
                vec![Some("1".into()), Some("2".into()), None],
                vec![Some("".into()), Some("".into()), Some("".into())]
            ]
        );
        assert_eq!(row_value(&table, &table.rows[0], "x"), Some("2"));
        assert_eq!(dict_reader("\u{feff}\u{feff}x").headers, ["\u{feff}x"]);
    }

    #[test]
    fn writer_matches_js_coercion_and_reports_schema_drift() {
        let result = encode_row(&[(
            "timestamp".into(),
            CsvValue::Array(vec![CsvValue::Null, CsvValue::Bool(true), CsvValue::Object]),
        )]);
        assert_eq!(
            result.row,
            r#"",true,[object Object]""#.to_string() + &",".repeat(22) + "\n"
        );
        let mismatch = result.mismatch.unwrap();
        assert_eq!(mismatch.missing.len(), 22);
        assert!(
            mismatch
                .mismatch_message()
                .starts_with("stats.mjs: row schema mismatch (missing=[session_id")
        );
    }

    #[test]
    fn writer_uses_ecmascript_numbers_and_escapes_only_required_fields() {
        assert_eq!(number_to_js_string(-0.0), "0");
        assert_eq!(number_to_js_string(1e21), "1e+21");
        assert_eq!(number_to_js_string(1e-7), "1e-7");
        assert_eq!(number_to_js_string(f64::NAN), "NaN");
        assert_eq!(number_to_js_string(f64::INFINITY), "Infinity");
        assert_eq!(number_to_js_string(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(csv_field("x,\"y\r\nz"), "\"x,\"\"y\r\nz\"");
        let mut entries = CSV_COLUMNS
            .iter()
            .map(|key| ((*key).to_string(), CsvValue::String(String::new())))
            .collect::<Vec<_>>();
        entries[0].1 = CsvValue::String("astral \u{1f600}".into());
        let encoded = encode_row(&entries);
        assert_eq!(encoded.mismatch, None);
        assert_eq!(encoded.row.split(',').next(), Some("astral \u{1f600}"));
        assert!(encoded.row.ends_with('\n'));
    }
}
