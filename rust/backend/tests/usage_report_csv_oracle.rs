use serde_json::{Map, Value, json};
use singularity_backend::usage_report_csv::{
    CSV_COLUMNS, CsvValue, dict_reader, encode_row, parse_csv, row_value,
};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn unique_slice<'a>(source: &'a str, anchor: &str, end: &str) -> &'a str {
    assert_eq!(
        source.matches(anchor).count(),
        1,
        "source drift: expected one {anchor:?}"
    );
    assert_eq!(
        source.matches(end).count(),
        1,
        "source drift: expected one {end:?}"
    );
    let start = source.find(anchor).unwrap();
    let finish = source[start..].find(end).unwrap() + start;
    &source[start..finish]
}

fn node_path() -> PathBuf {
    if let Some(path) = std::env::var_os("NODE_BINARY") {
        return PathBuf::from(path);
    }
    let path = std::env::var_os("PATH").expect("PATH needed only to resolve node.exe");
    std::env::split_paths(&path)
        .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|candidate| candidate.is_file())
        .expect("set NODE_BINARY to the Node executable used by the test runner")
}

fn csv_value(value: &Value) -> CsvValue {
    match value {
        Value::Null => CsvValue::Null,
        Value::Bool(value) => CsvValue::Bool(*value),
        Value::Number(value) => CsvValue::Number(value.as_f64().unwrap()),
        Value::String(value) => CsvValue::String(value.clone()),
        Value::Array(values) => CsvValue::Array(values.iter().map(csv_value).collect()),
        Value::Object(values) => match values.get("__number").and_then(Value::as_str) {
            Some("NaN") => CsvValue::Number(f64::NAN),
            Some("Infinity") => CsvValue::Number(f64::INFINITY),
            Some("-Infinity") => CsvValue::Number(f64::NEG_INFINITY),
            _ => CsvValue::Object,
        },
    }
}

fn entry_list(row: &Map<String, Value>) -> Vec<(String, CsvValue)> {
    row.iter()
        .map(|(key, value)| (key.clone(), csv_value(value)))
        .collect()
}

#[test]
fn source_bound_csv_codec_matches_the_bundled_helpers() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let stats =
        fs::read_to_string(root.join(".claude/skills/harness-usage-report/scripts/stats.mjs"))
            .expect("read bundled stats source only");
    let header = unique_slice(&stats, "const HEADER =", "const ZERO_UUID =");
    let parser = unique_slice(
        &stats,
        "function parseCsv(text) {",
        "function* dictReader(text) {",
    );
    let reader = unique_slice(
        &stats,
        "function* dictReader(text) {",
        "function _csv_field(v) {",
    );
    let field = unique_slice(
        &stats,
        "function _csv_field(v) {",
        "// Build a COLS-ordered value array",
    );
    let row = unique_slice(
        &stats,
        "function _row_array(rowd) {",
        "// ---- general helpers ----",
    );
    assert!(
        stats.matches("const COLS = HEADER.split(\",\");").count() == 1,
        "source drift: expected one COLS declaration"
    );
    assert!(
        header.contains("const COLS = HEADER.split(\",\");"),
        "source drift: COLS must derive from HEADER"
    );
    assert!(
        reader.contains("parseCsv(text)"),
        "source drift: dictReader must call parseCsv"
    );
    assert!(
        row.contains("COLS"),
        "source drift: _row_array must use COLS"
    );
    assert_eq!(
        stats
            .matches("_row_array(rowd).map((x) => _csv_field(x))")
            .count(),
        1,
        "source drift: report row writer must apply _csv_field to _row_array values"
    );
    assert_eq!(
        stats
            .matches("_row_array(r).map((v) => _csv_field(v))")
            .count(),
        1,
        "source drift: report backfill writer must apply _csv_field to _row_array values"
    );
    assert!(CSV_COLUMNS.iter().copied().eq([
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
    ]));

    let source = [header, parser, reader, field, row].join("\n");
    let inputs = vec![
        "".to_string(),
        "a,b\r\n1,2\r\n".into(),
        "a,b\n\"x,y\",\"line1\r\nline2\"\rZ,\"q\"tail\"".into(),
        "a,b,c\n\"x\"\"y\",\"mid\"quote\",z\n".into(),
        "\u{feff}h,h,wide\r\n1,2\r\n\r\n,,\r\n".into(),
        "\u{feff}\u{feff}header\n\"open\r\nend".into(),
        "a,b\n,\nextra,short,surplus".into(),
        "x,x\n1".into(),
        "astral\n\u{1f600}".into(),
    ];
    let mut complete = Map::new();
    for column in CSV_COLUMNS {
        complete.insert(column.to_string(), Value::String(String::new()));
    }
    complete.insert("timestamp".into(), json!("astral 😀"));
    complete.insert("facets_json".into(), json!("comma,quote\" and\nnewline"));
    let mut coercions = complete.clone();
    coercions.insert("timestamp".into(), Value::Null);
    coercions.insert(
        "total_cost_usd".into(),
        json!([null, true, ["x", null], {}]),
    );
    coercions.insert("last_model".into(), json!({}));
    coercions.insert("input_tokens".into(), json!(false));
    coercions.insert("output_tokens".into(), json!(-0.0));
    coercions.insert("est_cost_usd".into(), json!(1e-7));
    coercions.insert("duration_ms".into(), json!({"__number":"NaN"}));
    coercions.insert("api_duration_ms".into(), json!({"__number":"Infinity"}));
    coercions.insert("lines_added".into(), json!({"__number":"-Infinity"}));
    coercions.insert("lines_removed".into(), json!(1e21));
    let mut mismatch = Map::new();
    mismatch.insert("timestamp".into(), json!(0.000001));
    mismatch.insert("zExtra".into(), json!([null, true, ["x", null], {}]));
    mismatch.insert("2".into(), json!("numbered extra"));
    let rows = vec![
        Value::Object(complete.clone()),
        Value::Object(coercions.clone()),
        Value::Object(mismatch.clone()),
    ];

    let request = json!({ "source": source, "inputs": inputs, "rows": rows });
    let node = node_path();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/usage_report_csv_oracle.mjs");
    let cwd = std::env::temp_dir().join(format!("usage-csv-oracle-{}", std::process::id()));
    fs::create_dir_all(&cwd).unwrap();
    let synthetic = [
        ("TEMP", "temp"),
        ("TMP", "tmp"),
        ("TMPDIR", "tmpdir"),
        ("HOME", "home"),
        ("USERPROFILE", "profile"),
        ("APPDATA", "appdata"),
        ("LOCALAPPDATA", "localappdata"),
    ]
    .map(|(name, directory)| {
        let path = cwd.join(directory);
        fs::create_dir_all(&path).unwrap();
        (name, path)
    });
    let mut command = Command::new(node);
    command.arg(script).current_dir(&cwd).env_clear();
    if cfg!(windows) {
        for name in ["SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
    for (name, path) in synthetic {
        command.env(name, path);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start isolated Node VM oracle");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    fs::remove_dir_all(&cwd).unwrap();
    assert!(
        output.status.success(),
        "oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(oracle["columns"], json!(CSV_COLUMNS));

    let expected_parsed = inputs
        .iter()
        .map(|input| parse_csv(input))
        .collect::<Vec<_>>();
    assert_eq!(
        oracle["parsed"],
        serde_json::to_value(expected_parsed).unwrap()
    );
    let expected_dictionaries = inputs
        .iter()
        .map(|input| {
            let table = dict_reader(input);
            let mut unique_headers = Vec::new();
            for header in &table.headers {
                if !unique_headers.contains(header) {
                    unique_headers.push(header.clone());
                }
            }
            let rows = table
                .rows
                .iter()
                .map(|row| {
                    unique_headers
                        .iter()
                        .map(|header| {
                            json!([
                                header,
                                row_value(&table, row, header).map_or(Value::Null, |value| {
                                    Value::String(value.to_string())
                                })
                            ])
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            json!(rows)
        })
        .collect::<Vec<_>>();
    assert_eq!(oracle["dictionaries"], json!(expected_dictionaries));
    let table = dict_reader(&inputs[4]);
    assert_eq!(table.headers, ["h", "h", "wide"]);
    assert_eq!(row_value(&table, &table.rows[0], "h"), Some("2"));
    assert_eq!(row_value(&table, &table.rows[1], "h"), Some(""));
    assert_eq!(table.rows[0][2], None);
    assert_eq!(oracle["dictionaries"][4][0][0][0], "h");
    assert_eq!(oracle["dictionaries"][4][0][0][1], "2");
    let missing_duplicate = dict_reader(&inputs[7]);
    assert_eq!(
        row_value(&missing_duplicate, &missing_duplicate.rows[0], "x"),
        None
    );
    assert_eq!(oracle["dictionaries"][7][0][0][1], Value::Null);

    let good = encode_row(&entry_list(&complete));
    let coerced = encode_row(&entry_list(&coercions));
    let bad = encode_row(&entry_list(&mismatch));
    assert_eq!(oracle["encoded"][0], good.row);
    assert_eq!(oracle["encoded"][1], coerced.row);
    assert_eq!(oracle["encoded"][2], bad.row);
    let mismatch = bad.mismatch.unwrap();
    assert_eq!(mismatch.mismatch_message(), oracle["errors"][0]);
    assert_eq!(oracle["header"], CSV_COLUMNS.join(","));
}
