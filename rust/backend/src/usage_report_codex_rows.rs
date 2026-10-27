//! Pure Codex rollout ingestion: report rows from rollout JSONL text.
//!
//! Mirrors the row-producing half of `codex.mjs`: the per-thread parse
//! (`_parse_thread`), the root-session fold (`_merge_thread_into_session`) and
//! the primary plus `codex-auto-review` row split (`codexIngest`). File
//! discovery, the mtime cache, the `codex-usage.jsonl` history and console
//! warnings stay with the caller.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Internal reviewer thread, never the model that did the session's work.
const AUTO_REVIEW_MODEL: &str = "codex-auto-review";

/// `MODEL_DISPLAY_NAMES` (codex.mjs:32-40); unknown ids fall back to "".
const MODEL_DISPLAY_NAMES: &[(&str, &str)] = &[
    ("gpt-6.1-sol", "GPT-6.1 Sol"),
    ("gpt-6-sol", "GPT-6 Sol"),
    ("gpt-6-luna", "GPT-6 Luna"),
    ("gpt-5.6-sol", "GPT-5.6 Sol"),
    ("gpt-5.6-terra", "GPT-5.6 Terra"),
    ("gpt-5.6-luna", "GPT-5.6 Luna"),
    (AUTO_REVIEW_MODEL, "Codex auto-review"),
];

/// One rollout file's text plus the thread id derived from its filename.
pub struct CodexThreadText<'a> {
    pub text: &'a str,
    pub fallback_id: &'a str,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnContext {
    pub epoch: Option<f64>,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenReading {
    pub epoch: Option<f64>,
    pub model: Option<String>,
    /// Input tokens excluding the cached ones, so input and cache stay disjoint.
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_creation: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gauge {
    pub utilization: f64,
    /// `resets_at` as the rollout carried it; the usage-history consumers
    /// require it, so it is passed through verbatim like `codex.mjs:230`.
    pub resets_at: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RateReading {
    pub epoch: Option<f64>,
    pub session: Option<Gauge>,
    pub weekly: Option<Gauge>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextWindow {
    pub epoch: Option<f64>,
    pub size: f64,
}

/// One parsed rollout thread (`_new_thread_res`, codex.mjs:131-145).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CodexThread {
    pub root_id: Option<String>,
    pub cwd: String,
    pub start_epoch: Option<f64>,
    pub end_epoch: Option<f64>,
    pub turns: f64,
    pub tool_calls: f64,
    /// Tool counts in first-seen order, as the JS object literal preserves them.
    pub tools: Vec<(String, f64)>,
    pub turn_contexts: Vec<TurnContext>,
    pub token_readings: Vec<TokenReading>,
    pub rate_readings: Vec<RateReading>,
    pub context_window: Option<ContextWindow>,
}

/// One `stats.mjs`-shaped report row; `None` and an empty string both render blank.
#[derive(Debug, Clone, PartialEq)]
pub struct CodexRow {
    pub timestamp: String,
    pub session_id: String,
    pub total_cost_usd: String,
    pub last_model: String,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_creation_tokens: f64,
    pub model_id: String,
    pub model_display_name: String,
    pub duration_ms: Option<f64>,
    pub api_duration_ms: String,
    pub lines_added: String,
    pub lines_removed: String,
    pub rl_5h_pct: Option<f64>,
    pub rl_7d_pct: Option<f64>,
    pub context_pct: String,
    pub context_window_size: Option<f64>,
    pub turns: f64,
    pub tool_calls: f64,
    pub start_epoch: Option<f64>,
    pub facets_json: String,
    pub est_cost_usd: Option<String>,
}

/// Parse one rollout file's text (`_parse_thread`, codex.mjs:147-239).
pub fn parse_thread(
    text: &str,
    fallback_id: &str,
    epoch_from_iso: fn(&str) -> Option<f64>,
) -> CodexThread {
    let mut thread = CodexThread::default();
    let mut meta_seen = false;
    let mut current_model: Option<String> = None;

    for line in text.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A malformed line is skipped; only a file read error is fatal upstream.
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(epoch_from_iso);
        if let Some(ts) = ts {
            thread.start_epoch = Some(thread.start_epoch.map_or(ts, |old| old.min(ts)));
            thread.end_epoch = Some(thread.end_epoch.map_or(ts, |old| old.max(ts)));
        }
        let payload = record.get("payload");
        let field = |key: &str| payload.and_then(|payload| payload.get(key));

        match record.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                // A fork's file replays the root's meta; only the first is this thread's.
                if !meta_seen {
                    meta_seen = true;
                    thread.root_id = Some(
                        field("session_id")
                            .and_then(non_empty_str)
                            .or_else(|| field("id").and_then(non_empty_str))
                            .unwrap_or(fallback_id)
                            .to_owned(),
                    );
                    thread.cwd = field("cwd")
                        .and_then(non_empty_str)
                        .unwrap_or("")
                        .to_owned();
                }
            }
            Some("turn_context") => {
                if let Some(model) = field("model").and_then(non_empty_str) {
                    current_model = Some(model.to_owned());
                    thread.turn_contexts.push(TurnContext {
                        epoch: ts,
                        model: model.to_owned(),
                    });
                }
            }
            Some("response_item") => {
                if matches!(
                    field("type").and_then(Value::as_str),
                    Some("custom_tool_call" | "function_call")
                ) {
                    thread.tool_calls += 1.0;
                    let name = field("name").and_then(non_empty_str).unwrap_or("?");
                    add_count(&mut thread.tools, &format!("codex:{name}"), 1.0);
                }
            }
            Some("event_msg") => match field("type").and_then(Value::as_str) {
                Some("user_message") => thread.turns += 1.0,
                Some("mcp_tool_call_end") => {
                    thread.tool_calls += 1.0;
                    let tool = field("invocation")
                        .and_then(|invocation| invocation.get("tool"))
                        .and_then(non_empty_str)
                        .unwrap_or("?");
                    add_count(&mut thread.tools, &format!("codex:{tool}"), 1.0);
                }
                Some("token_count") => {
                    let info = field("info");
                    let last = info.and_then(|info| info.get("last_token_usage"));
                    let raw_in = num(last.and_then(|last| last.get("input_tokens")));
                    let cache_read = num(last.and_then(|last| last.get("cached_input_tokens")));
                    let cache_creation =
                        num(last.and_then(|last| last.get("cache_write_input_tokens")));
                    let output = num(last.and_then(|last| last.get("output_tokens")));
                    // last_token_usage only: total_token_usage resets after a compaction.
                    if raw_in != 0.0 || cache_read != 0.0 || cache_creation != 0.0 || output != 0.0
                    {
                        thread.token_readings.push(TokenReading {
                            epoch: ts,
                            model: current_model.clone(),
                            input: (raw_in - cache_read).max(0.0),
                            output,
                            cache_read,
                            cache_creation,
                        });
                    }
                    if let Some(Value::Number(size)) =
                        info.and_then(|info| info.get("model_context_window"))
                    {
                        let newer = thread.context_window.as_ref().is_none_or(|current| {
                            ts.unwrap_or(f64::NEG_INFINITY)
                                >= current.epoch.unwrap_or(f64::NEG_INFINITY)
                        });
                        if newer {
                            thread.context_window = Some(ContextWindow {
                                epoch: ts,
                                size: size.as_f64().unwrap_or(0.0),
                            });
                        }
                    }
                    // primary = 5h window, secondary = 7d; >= 1440 minutes is weekly.
                    let rate_limits = field("rate_limits");
                    let mut reading: Option<RateReading> = None;
                    for key in ["primary", "secondary"] {
                        let Some(window) = rate_limits.and_then(|limits| limits.get(key)) else {
                            continue;
                        };
                        let Some(Value::Number(percent)) = window.get("used_percent") else {
                            continue;
                        };
                        let Some(percent) = percent.as_f64() else {
                            continue;
                        };
                        let weekly = num(window.get("window_minutes")) >= 1440.0;
                        let gauge = Some(Gauge {
                            utilization: percent,
                            resets_at: window.get("resets_at").cloned().unwrap_or(Value::Null),
                        });
                        let reading = reading.get_or_insert_with(|| RateReading {
                            epoch: ts,
                            session: None,
                            weekly: None,
                        });
                        if weekly {
                            reading.weekly = gauge;
                        } else {
                            reading.session = gauge;
                        }
                    }
                    if let Some(reading) = reading {
                        thread.rate_readings.push(reading);
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }

    if !meta_seen {
        thread.root_id = Some(fallback_id.to_owned());
    }
    // Readings before any turn_context fall back to the thread's last known model.
    let fallback_model = current_model.unwrap_or_default();
    for reading in &mut thread.token_readings {
        if reading.model.as_deref().unwrap_or("").is_empty() {
            reading.model = Some(fallback_model.clone());
        }
    }
    thread
}

/// Fold threads into root-session rows (`codexIngest`, codex.mjs:405-508).
///
/// Convenience for callers that hold rollout text; `codex_ingest` calls
/// `codex_rows_from_threads` directly so a cache hit never re-parses.
pub fn codex_rows(
    threads: &[CodexThreadText<'_>],
    epoch_from_iso: fn(&str) -> Option<f64>,
    local_fmt: fn(f64) -> String,
    cost: &dyn Fn(&str, f64, f64, f64, f64) -> Option<f64>,
) -> Vec<CodexRow> {
    let parsed = threads
        .iter()
        .map(|thread| parse_thread(thread.text, thread.fallback_id, epoch_from_iso))
        .collect::<Vec<_>>();
    codex_rows_from_threads(&parsed, local_fmt, cost)
}

/// `codexIngest`'s row half (codex.mjs:405-508) over already-parsed threads.
/// `local_fmt` is a closure so the caller can inject its UTC offset.
pub fn codex_rows_from_threads(
    threads: &[CodexThread],
    local_fmt: impl Fn(f64) -> String,
    cost: &dyn Fn(&str, f64, f64, f64, f64) -> Option<f64>,
) -> Vec<CodexRow> {
    let mut sessions: Vec<(String, SessionAcc)> = Vec::new();
    for thread in threads {
        let root_id = thread.root_id.clone().unwrap_or_default();
        let index = match sessions.iter().position(|(id, _)| *id == root_id) {
            Some(index) => index,
            None => {
                sessions.push((root_id, SessionAcc::default()));
                sessions.len() - 1
            }
        };
        merge_thread_into_session(&mut sessions[index].1, thread);
    }

    let mut rows = Vec::new();
    for (root_id, acc) in &sessions {
        let latest_non_review = last_by_epoch(
            acc.turn_contexts
                .iter()
                .filter(|context| context.model != AUTO_REVIEW_MODEL),
            |context| context.epoch,
        );
        let latest_any = last_by_epoch(acc.turn_contexts.iter(), |context| context.epoch);
        let last_model = latest_non_review
            .or(latest_any)
            .map(|context| context.model.as_str())
            .unwrap_or("");

        let mut sums = [0.0_f64; 4];
        let mut auto_sums = [0.0_f64; 4];
        let mut est_cost = 0.0;
        let mut auto_cost = 0.0;
        for reading in &acc.token_readings {
            let stored = reading.model.as_deref().unwrap_or("");
            let model = if stored.is_empty() {
                last_model
            } else {
                stored
            };
            let is_auto_review = model == AUTO_REVIEW_MODEL;
            let target = if is_auto_review {
                &mut auto_sums
            } else {
                &mut sums
            };
            target[0] += reading.input;
            target[1] += reading.output;
            target[2] += reading.cache_read;
            target[3] += reading.cache_creation;
            if !model.is_empty()
                && let Some(cost) = cost(
                    model,
                    reading.input,
                    reading.output,
                    reading.cache_read,
                    reading.cache_creation,
                )
            {
                if is_auto_review {
                    auto_cost += cost;
                } else {
                    est_cost += cost;
                }
            }
        }

        let latest_session = last_by_epoch(
            acc.rate_readings
                .iter()
                .filter(|reading| reading.session.is_some()),
            |reading| reading.epoch,
        );
        let latest_weekly = last_by_epoch(
            acc.rate_readings
                .iter()
                .filter(|reading| reading.weekly.is_some()),
            |reading| reading.epoch,
        );

        rows.push(CodexRow {
            timestamp: acc.end_epoch.map(&local_fmt).unwrap_or_default(),
            session_id: root_id.clone(),
            total_cost_usd: String::new(),
            last_model: last_model.to_owned(),
            input_tokens: sums[0],
            output_tokens: sums[1],
            cache_read_tokens: sums[2],
            cache_creation_tokens: sums[3],
            model_id: last_model.to_owned(),
            model_display_name: display_name(last_model).to_owned(),
            duration_ms: duration_ms(acc),
            api_duration_ms: String::new(),
            lines_added: String::new(),
            lines_removed: String::new(),
            rl_5h_pct: latest_session
                .and_then(|reading| reading.session.as_ref())
                .map(|gauge| gauge.utilization),
            rl_7d_pct: latest_weekly
                .and_then(|reading| reading.weekly.as_ref())
                .map(|gauge| gauge.utilization),
            context_pct: String::new(),
            context_window_size: acc.context_window.as_ref().map(|window| window.size),
            turns: acc.turns,
            tool_calls: acc.tool_calls,
            start_epoch: acc.start_epoch.map(f64::trunc),
            facets_json: facets_json(&acc.tools, &acc.cwd),
            est_cost_usd: (est_cost > 0.0).then(|| to_fixed4(est_cost)),
        });

        // Review spend is real but not the session's own work: its own row, own
        // tokens/cost, no tool facets, and the cwd kept so By-project stays right.
        if auto_sums[0] != 0.0
            || auto_sums[1] != 0.0
            || auto_sums[2] != 0.0
            || auto_sums[3] != 0.0
            || auto_cost > 0.0
        {
            rows.push(CodexRow {
                timestamp: acc.end_epoch.map(&local_fmt).unwrap_or_default(),
                session_id: format!("{root_id}:auto-review"),
                total_cost_usd: String::new(),
                last_model: AUTO_REVIEW_MODEL.to_owned(),
                input_tokens: auto_sums[0],
                output_tokens: auto_sums[1],
                cache_read_tokens: auto_sums[2],
                cache_creation_tokens: auto_sums[3],
                model_id: AUTO_REVIEW_MODEL.to_owned(),
                model_display_name: display_name(AUTO_REVIEW_MODEL).to_owned(),
                duration_ms: None,
                api_duration_ms: String::new(),
                lines_added: String::new(),
                lines_removed: String::new(),
                rl_5h_pct: None,
                rl_7d_pct: None,
                context_pct: String::new(),
                context_window_size: None,
                turns: 0.0,
                tool_calls: 0.0,
                start_epoch: acc.start_epoch.map(f64::trunc),
                facets_json: facets_json(&[], &acc.cwd),
                est_cost_usd: (auto_cost > 0.0).then(|| to_fixed4(auto_cost)),
            });
        }
    }
    rows
}

/// Running totals for one root session (`_new_session_acc`, codex.mjs:268-273).
#[derive(Debug, Clone, Default)]
struct SessionAcc {
    start_epoch: Option<f64>,
    end_epoch: Option<f64>,
    turns: f64,
    tool_calls: f64,
    tools: Vec<(String, f64)>,
    cwd: String,
    cwd_epoch: Option<f64>,
    turn_contexts: Vec<TurnContext>,
    token_readings: Vec<TokenReading>,
    rate_readings: Vec<RateReading>,
    context_window: Option<ContextWindow>,
}

/// `_merge_thread_into_session` (codex.mjs:275-288).
fn merge_thread_into_session(acc: &mut SessionAcc, thread: &CodexThread) {
    if let Some(start) = thread.start_epoch {
        acc.start_epoch = Some(acc.start_epoch.map_or(start, |old| old.min(start)));
    }
    if let Some(end) = thread.end_epoch {
        acc.end_epoch = Some(acc.end_epoch.map_or(end, |old| old.max(end)));
    }
    acc.turns += thread.turns;
    acc.tool_calls += thread.tool_calls;
    for (name, count) in &thread.tools {
        add_count(&mut acc.tools, name, *count);
    }
    // The earliest-starting thread names the session's project; a null epoch
    // compares as 0, matching the JS relational comparison.
    if !thread.cwd.is_empty()
        && acc
            .cwd_epoch
            .is_none_or(|seen| thread.start_epoch.unwrap_or(0.0) < seen)
    {
        acc.cwd = thread.cwd.clone();
        acc.cwd_epoch = thread.start_epoch;
    }
    acc.turn_contexts
        .extend(thread.turn_contexts.iter().cloned());
    acc.token_readings
        .extend(thread.token_readings.iter().cloned());
    acc.rate_readings
        .extend(thread.rate_readings.iter().cloned());
    if let Some(window) = &thread.context_window {
        let newer = acc.context_window.as_ref().is_none_or(|current| {
            window.epoch.unwrap_or(f64::NEG_INFINITY) >= current.epoch.unwrap_or(f64::NEG_INFINITY)
        });
        if newer {
            acc.context_window = Some(window.clone());
        }
    }
}

/// `_last_by_epoch` (codex.mjs:290-296): `>=`, so later items win ties.
fn last_by_epoch<'a, T>(
    items: impl IntoIterator<Item = &'a T>,
    epoch: impl Fn(&T) -> Option<f64>,
) -> Option<&'a T> {
    let mut best: Option<&'a T> = None;
    for item in items {
        let newer = best.is_none_or(|seen| {
            epoch(item).unwrap_or(f64::NEG_INFINITY) >= epoch(seen).unwrap_or(f64::NEG_INFINITY)
        });
        if newer {
            best = Some(item);
        }
    }
    best
}

fn add_count(counts: &mut Vec<(String, f64)>, key: &str, amount: f64) {
    match counts.iter_mut().find(|(name, _)| name == key) {
        Some((_, count)) => *count += amount,
        None => counts.push((key.to_owned(), amount)),
    }
}

fn duration_ms(acc: &SessionAcc) -> Option<f64> {
    let (Some(start), Some(end)) = (acc.start_epoch, acc.end_epoch) else {
        return None;
    };
    Some(((end - start) * 1000.0).trunc())
}

fn display_name(model: &str) -> &'static str {
    MODEL_DISPLAY_NAMES
        .iter()
        .find(|(id, _)| *id == model)
        .map(|(_, name)| *name)
        .unwrap_or("")
}

/// `JSON.stringify` of the facets object in its fixed literal key order.
fn facets_json(tools: &[(String, f64)], cwd: &str) -> String {
    let tools = tools
        .iter()
        .map(|(name, count)| format!("{}:{}", json_string(name), js_number(*count)))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"tools\":{{{tools}}},\"tool_errors\":0,\"agents\":{{}},\"skills\":{{}},\"compactions\":0,\"cwd\":{},\"branch\":\"\"}}",
        json_string(cwd)
    )
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).expect("a string always serializes")
}

fn js_number(value: f64) -> String {
    if value.is_finite() {
        ryu_js::Buffer::new().format_finite(value).to_owned()
    } else {
        "null".into()
    }
}

/// JS `Number.prototype.toFixed(4)`; like JS, ties round away from zero.
fn to_fixed4(value: f64) -> String {
    let scaled = value * 10_000.0;
    if scaled.is_finite() && scaled.fract().abs() == 0.5 {
        let rounded = scaled.trunc() + scaled.signum() * 0.5;
        return format!("{:.4}", rounded / 10_000.0);
    }
    format!("{value:.4}")
}

/// JS `Number(v)` kept only when finite (`_num`, codex.mjs:62-65).
fn num(value: Option<&Value>) -> f64 {
    // shortcut: hex/octal/binary string forms read as 0, JS Number() converts them.
    let parsed = match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
        Some(Value::Bool(flag)) => Some(if *flag { 1.0 } else { 0.0 }),
        _ => Some(0.0),
    };
    parsed.filter(|value| value.is_finite()).unwrap_or(0.0)
}

/// JS `||` for the text fields this parser reads.
fn non_empty_str(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT_ID: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const SUB_ID: &str = "aaaaaaaa-0000-4000-8000-000000000002";

    fn epoch_from_iso(text: &str) -> Option<f64> {
        let parsed =
            time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
                .ok()?;
        Some(parsed.unix_timestamp() as f64 + f64::from(parsed.nanosecond()) / 1e9)
    }

    /// UTC `YYYY-MM-DD HH:mm:ss`, the shape of the caller's local formatter.
    fn local_fmt(epoch: f64) -> String {
        let stamp = time::OffsetDateTime::from_unix_timestamp(epoch as i64).unwrap();
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            stamp.year(),
            u8::from(stamp.month()),
            stamp.day(),
            stamp.hour(),
            stamp.minute(),
            stamp.second()
        )
    }

    /// Deterministic stand-in for `stats.mjs`'s tiered pricing.
    fn cost(
        _model: &str,
        input: f64,
        output: f64,
        cache_read: f64,
        cache_creation: f64,
    ) -> Option<f64> {
        Some((input + output + cache_read + cache_creation) * 0.000001)
    }

    fn rows(texts: &[(&str, &str)]) -> Vec<CodexRow> {
        let threads = texts
            .iter()
            .map(|(text, fallback_id)| CodexThreadText { text, fallback_id })
            .collect::<Vec<_>>();
        codex_rows(&threads, epoch_from_iso, local_fmt, &cost)
    }

    const ROOT_ROLLOUT: &str = concat!(
        r#"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"session_id":"aaaaaaaa-0000-4000-8000-000000000001","id":"aaaaaaaa-0000-4000-8000-000000000001","cwd":"C:\\proj"}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:00:01Z","type":"turn_context","payload":{"model":"codex-test-sol"}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"user_message","message":"hi"}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":200,"cache_write_input_tokens":0,"output_tokens":100},"total_token_usage":{"input_tokens":1000,"output_tokens":100},"model_context_window":200000},"rate_limits":{"primary":{"used_percent":10,"window_minutes":10080,"resets_at":2000000000},"secondary":null}}}"#,
        "\n",
        "not valid json{{{\n",
        r#"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":500,"cached_input_tokens":100,"cache_write_input_tokens":0,"output_tokens":50},"total_token_usage":{"input_tokens":500,"output_tokens":50},"model_context_window":200000},"rate_limits":{"primary":{"used_percent":12,"window_minutes":10080,"resets_at":2000000000},"secondary":null}}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:00:05Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec"}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:00:06Z","type":"response_item","payload":{"type":"function_call","name":"wait"}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:00:07Z","type":"event_msg","payload":{"type":"mcp_tool_call_end","invocation":{"server":"lean-ctx","tool":"ctx_read"}}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:00:08Z","type":"turn_context","payload":{"model":"codex-auto-review"}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:00:09Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"cached_input_tokens":50,"cache_write_input_tokens":10,"output_tokens":30},"total_token_usage":{"input_tokens":200,"output_tokens":30},"model_context_window":200000},"rate_limits":{"primary":{"used_percent":20,"window_minutes":10080,"resets_at":2000000000}}}}"#,
        "\n",
    );

    const SUB_ROLLOUT: &str = concat!(
        r#"{"timestamp":"2026-01-01T00:01:00Z","type":"session_meta","payload":{"session_id":"aaaaaaaa-0000-4000-8000-000000000001","id":"aaaaaaaa-0000-4000-8000-000000000002","cwd":"C:\\proj\\sub"}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:01:01Z","type":"turn_context","payload":{"model":"codex-test-terra"}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:01:02Z","type":"event_msg","payload":{"type":"user_message","message":"subtask"}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:01:03Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":300,"cached_input_tokens":0,"cache_write_input_tokens":50,"output_tokens":20},"total_token_usage":{"input_tokens":300,"output_tokens":20},"model_context_window":200000},"rate_limits":{"primary":{"used_percent":15,"window_minutes":300,"resets_at":2000000500},"secondary":{"used_percent":15,"window_minutes":10080,"resets_at":2000000000}}}}"#,
        "\n",
        r#"{"timestamp":"2026-01-01T00:01:04Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch"}}"#,
        "\n",
    );

    #[test]
    fn root_and_sub_threads_fold_into_one_primary_row_and_an_auto_review_row() {
        let rows = rows(&[(ROOT_ROLLOUT, ROOT_ID), (SUB_ROLLOUT, SUB_ID)]);
        assert_eq!(rows.len(), 2, "primary plus auto-review split");
        let row = &rows[0];

        assert_eq!(row.session_id, ROOT_ID);
        assert_eq!(row.input_tokens, 1500.0, "input excludes cached tokens");
        assert_eq!(row.output_tokens, 170.0);
        assert_eq!(row.cache_read_tokens, 300.0);
        assert_eq!(row.cache_creation_tokens, 50.0);
        assert_eq!(row.turns, 2.0);
        assert_eq!(row.tool_calls, 4.0);
        assert_eq!(
            row.last_model, "codex-test-terra",
            "latest non-review model"
        );
        assert_eq!(row.model_id, "codex-test-terra");
        assert_eq!(row.model_display_name, "", "unmapped stub model");
        assert_eq!(row.rl_5h_pct, Some(15.0), "sub-thread 300-minute window");
        assert_eq!(row.rl_7d_pct, Some(15.0), "latest weekly reading");
        assert_eq!(row.context_window_size, Some(200000.0));
        assert_eq!(row.total_cost_usd, "");
        assert_eq!(row.est_cost_usd.as_deref(), Some("0.0020"));
        assert_eq!(row.timestamp, "2026-01-01 00:01:04");
        assert_eq!(row.start_epoch, Some(1767225600.0));
        assert_eq!(row.duration_ms, Some(64000.0));
        assert_eq!(row.context_pct, "");
        assert_eq!(
            row.facets_json,
            r#"{"tools":{"codex:exec":1,"codex:wait":1,"codex:ctx_read":1,"codex:apply_patch":1},"tool_errors":0,"agents":{},"skills":{},"compactions":0,"cwd":"C:\\proj","branch":""}"#
        );

        let auto = &rows[1];
        assert_eq!(auto.session_id, format!("{ROOT_ID}:auto-review"));
        assert_eq!(auto.last_model, AUTO_REVIEW_MODEL);
        assert_eq!(auto.model_display_name, "Codex auto-review");
        assert_eq!(auto.input_tokens, 150.0, "200 input less 50 cached");
        assert_eq!(auto.output_tokens, 30.0);
        assert_eq!(auto.cache_read_tokens, 50.0);
        assert_eq!(auto.cache_creation_tokens, 10.0);
        assert_eq!(auto.est_cost_usd.as_deref(), Some("0.0002"));
        assert_eq!(auto.turns, 0.0);
        assert_eq!(auto.tool_calls, 0.0);
        assert_eq!(auto.duration_ms, None);
        assert_eq!(auto.context_window_size, None);
        assert_eq!(
            auto.facets_json,
            r#"{"tools":{},"tool_errors":0,"agents":{},"skills":{},"compactions":0,"cwd":"C:\\proj","branch":""}"#
        );
    }

    #[test]
    fn malformed_lines_are_skipped_and_a_missing_meta_falls_back_to_the_filename_id() {
        let text = concat!(
            "not json\n",
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"user_message"}}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":250,"cache_write_input_tokens":7,"output_tokens":0}}}}"#,
            "\n",
            r#"[1,2,3]"#,
            "\n",
        );
        let rows = rows(&[(text, "fallback-thread")]);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.session_id, "fallback-thread");
        assert_eq!(row.turns, 1.0, "only the one valid user_message counts");
        assert_eq!(row.input_tokens, 0.0, "input never goes negative");
        assert_eq!(row.cache_read_tokens, 250.0);
        assert_eq!(row.cache_creation_tokens, 7.0);
        assert_eq!(row.last_model, "", "no turn_context to name a model");
        assert_eq!(row.est_cost_usd, None, "no model, no pricing call");
        assert_eq!(row.rl_5h_pct, None);
        assert_eq!(row.timestamp, "2026-01-01 00:00:01");
        assert_eq!(row.duration_ms, Some(1000.0));
    }

    #[test]
    fn equal_epochs_let_the_later_reading_win() {
        let text = concat!(
            r#"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"session_id":"tie","cwd":"/x"}}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:01Z","type":"turn_context","payload":{"model":"gpt-6-sol"}}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:01Z","type":"turn_context","payload":{"model":"gpt-6.1-sol"}}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":5},"model_context_window":1000},"rate_limits":{"primary":{"used_percent":40,"window_minutes":10080}}}}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"output_tokens":5},"model_context_window":2000}}}"#,
            "\n",
        );
        let rows = rows(&[(text, "tie")]);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.last_model, "gpt-6.1-sol");
        assert_eq!(row.model_display_name, "GPT-6.1 Sol");
        assert_eq!(row.context_window_size, Some(2000.0));
        assert_eq!(row.rl_7d_pct, Some(40.0));
        assert_eq!(row.rl_5h_pct, None);
        assert_eq!(row.input_tokens, 30.0);
        assert_eq!(row.output_tokens, 10.0);
    }

    #[test]
    fn auto_review_tokens_never_inflate_the_primary_row() {
        let text = concat!(
            r#"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"session_id":"ar"}}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:01Z","type":"turn_context","payload":{"model":"codex-auto-review"}}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":1}}}}"#,
            "\n",
        );
        let rows = rows(&[(text, "ar")]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].input_tokens, 0.0);
        assert_eq!(rows[0].output_tokens, 0.0);
        assert_eq!(rows[0].est_cost_usd, None);
        assert_eq!(rows[0].last_model, AUTO_REVIEW_MODEL);
        assert_eq!(rows[1].session_id, "ar:auto-review");
        assert_eq!(rows[1].input_tokens, 5.0);
        assert_eq!(rows[1].output_tokens, 1.0);
    }
}
