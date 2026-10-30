//! Session JSON projections for the bundled usage report.
//!
//! Mirrors `_load_stats` (stats.mjs:952-1007) and `parseDateTime`/`jsWeekdayPy`
//! (stats.mjs:1009-1019). Pure: the caller supplies the already-read CSV text
//! and the local zone (Node reads the system zone).

use serde_json::Value;
use serde_json::value::RawValue;

use crate::usage_report_cost::{Pricing, fnum, inum, js_json, js_trim, json_number, json_string};
use crate::usage_report_csv::{CsvTable, dict_reader, row_value};
use crate::usage_snapshot::LocalZone;

/// Forecast-facing projection of one CSV session row.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionView {
    /// Epoch seconds of the local CSV timestamp under the supplied offset.
    pub ts: Option<f64>,
    pub model: String,
    pub rl5: f64,
    pub rl7: f64,
    pub tok: f64,
}

/// One CSV row after the shared projection both public loaders consume.
struct SessionRow {
    ts: String,
    sid: String,
    /// Untrimmed `last_model` cell: Node hands the raw value to the price table.
    model_raw: String,
    model: String,
    disp: String,
    i: f64,
    o: f64,
    cr: f64,
    cc: f64,
    dur: f64,
    api: f64,
    la: f64,
    lr: f64,
    rl5: f64,
    rl7: f64,
    turns: f64,
    tools: f64,
    total: f64,
    est: f64,
    hour: Option<f64>,
    dow: Option<f64>,
    facets: Option<Value>,
    ts_epoch: Option<f64>,
}

impl SessionRow {
    fn tok(&self) -> f64 {
        self.i + self.o + self.cr + self.cc
    }
}

/// `_load_stats` (stats.mjs:952-1007) sessions half: one JSON object per CSV
/// row, with third-party cost precedence and local `hour`/`dow`.
pub fn load_sessions(
    csv_text: &str,
    pricing: &Pricing,
    local_zone: LocalZone,
) -> Vec<Box<RawValue>> {
    parse_rows(csv_text, local_zone)
        .iter()
        .map(|row| {
            RawValue::from_string(session_json(row, pricing))
                .expect("session projection is valid JSON")
        })
        .collect()
}

/// Forecast-facing half of the same projection (`SessionView`): `ts` becomes
/// epoch seconds; unparseable timestamps stay `None`.
pub fn load_session_views(csv_text: &str, local_zone: LocalZone) -> Vec<SessionView> {
    parse_rows(csv_text, local_zone)
        .iter()
        .map(|row| SessionView {
            ts: row.ts_epoch,
            model: row.model.clone(),
            rl5: row.rl5,
            rl7: row.rl7,
            tok: row.tok(),
        })
        .collect()
}

/// Shared CSV projection: the header-row skip (stats.mjs:960-961) and every
/// field both loaders need, parsed once.
fn parse_rows(csv_text: &str, local_zone: LocalZone) -> Vec<SessionRow> {
    let table = dict_reader(csv_text);
    let mut rows = Vec::new();
    for row in &table.rows {
        let ts = trimmed(&table, row, "timestamp");
        if ts == "timestamp" || trimmed(&table, row, "total_cost_usd") == "total_cost_usd" {
            continue;
        }
        let (ts_epoch, hour, dow) = match parse_local_timestamp(ts, local_zone) {
            Some((epoch, hour, dow)) => (Some(epoch), Some(hour as f64), Some(dow as f64)),
            None => (None, None, None),
        };
        let model_raw = row_value(&table, row, "last_model").unwrap_or("");
        rows.push(SessionRow {
            ts: ts.to_owned(),
            sid: trimmed(&table, row, "session_id").to_owned(),
            model_raw: model_raw.to_owned(),
            model: js_trim(model_raw).to_owned(),
            disp: trimmed(&table, row, "model_display_name").to_owned(),
            i: inum(row_value(&table, row, "input_tokens")),
            o: inum(row_value(&table, row, "output_tokens")),
            cr: inum(row_value(&table, row, "cache_read_tokens")),
            cc: inum(row_value(&table, row, "cache_creation_tokens")),
            dur: inum(row_value(&table, row, "duration_ms")),
            api: inum(row_value(&table, row, "api_duration_ms")),
            la: inum(row_value(&table, row, "lines_added")),
            lr: inum(row_value(&table, row, "lines_removed")),
            rl5: fnum(row_value(&table, row, "rl_5h_pct")),
            rl7: fnum(row_value(&table, row, "rl_7d_pct")),
            turns: inum(row_value(&table, row, "turns")),
            tools: inum(row_value(&table, row, "tool_calls")),
            total: fnum(row_value(&table, row, "total_cost_usd")),
            est: fnum(row_value(&table, row, "est_cost_usd")),
            hour,
            dow,
            // JSON.parse of the raw cell; an empty cell or a parse failure is
            // JSON `null` (stats.mjs:967-980).
            facets: row_value(&table, row, "facets_json")
                .filter(|text| !text.is_empty())
                .and_then(|text| serde_json::from_str::<Value>(text).ok()),
            ts_epoch,
        });
    }
    rows
}

fn trimmed<'a>(table: &'a CsvTable, row: &'a [Option<String>], name: &str) -> &'a str {
    js_trim(row_value(table, row, name).unwrap_or(""))
}

/// Cost precedence from `_load_stats` (stats.mjs:987-989).
fn session_cost(row: &SessionRow, pricing: &Pricing) -> f64 {
    if pricing.is_third_party(&row.model_raw) {
        // Third-party rows: the per-call estimate beats recomputing from summed
        // tokens at the last model's rate alone.
        if row.est != 0.0 {
            row.est
        } else {
            // `_msg_cost(...) || 0`: an unpriced model or a `NaN` contributes 0.
            pricing
                .msg_cost(&row.model_raw, row.i, row.o, row.cr, row.cc)
                .filter(|cost| !cost.is_nan())
                .unwrap_or(0.0)
        }
    } else if row.total != 0.0 {
        row.total
    } else {
        row.est
    }
}

/// The session object of stats.mjs:981-1004, in the same key order.
fn session_json(row: &SessionRow, pricing: &Pricing) -> String {
    format!(
        concat!(
            "{{\"ts\":{},\"sid\":{},\"cost\":{},\"model\":{},\"disp\":{},",
            "\"in\":{},\"out\":{},\"cr\":{},\"cc\":{},\"tok\":{},",
            "\"dur\":{},\"api\":{},\"la\":{},\"lr\":{},\"rl5\":{},\"rl7\":{},",
            "\"turns\":{},\"tools\":{},\"hour\":{},\"dow\":{},\"facets\":{}}}"
        ),
        json_string(&row.ts),
        json_string(&row.sid),
        json_number(session_cost(row, pricing)),
        json_string(&row.model),
        json_string(&row.disp),
        json_number(row.i),
        json_number(row.o),
        json_number(row.cr),
        json_number(row.cc),
        json_number(row.tok()),
        json_number(row.dur),
        json_number(row.api),
        json_number(row.la),
        json_number(row.lr),
        json_number(row.rl5),
        json_number(row.rl7),
        json_number(row.turns),
        json_number(row.tools),
        optional_number(row.hour),
        optional_number(row.dow),
        row.facets.as_ref().map_or_else(|| "null".into(), js_json),
    )
}

fn optional_number(value: Option<f64>) -> String {
    value.map_or_else(|| "null".into(), json_number)
}

/// `parseDateTime` (stats.mjs:1009-1014) + `jsWeekdayPy` (stats.mjs:1016-1019)
/// under the run's local zone: `(epoch seconds, local hour, Python weekday)`.
/// The strict `%Y-%m-%d %H:%M:%S` shape is the whole grammar; unparseable
/// timestamps yield `None`, as the JS regex does.
fn parse_local_timestamp(ts: &str, local_zone: LocalZone) -> Option<(f64, i64, i64)> {
    let (year, month, day, hour, minute, second) = split_timestamp(ts)?;
    // Local civil time linearized, then shifted to UTC. Out-of-range components
    // (e.g. Feb 30) normalize exactly like `new Date(y, m - 1, ...)`.
    let local_secs =
        days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    let local_day = local_secs.div_euclid(86_400);
    Some((
        local_zone.to_epoch_secs(local_secs)? as f64,
        local_secs.div_euclid(3_600).rem_euclid(24),
        // 1970-01-01 was a Thursday: Python weekday 3.
        (local_day + 3).rem_euclid(7),
    ))
}

fn split_timestamp(ts: &str) -> Option<(i64, i64, i64, i64, i64, i64)> {
    let bytes = ts.as_bytes();
    if bytes.len() != 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b' '
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let field = |start: usize, end: usize| -> Option<i64> {
        let part = &bytes[start..end];
        part.iter().all(u8::is_ascii_digit).then(|| {
            part.iter()
                .fold(0, |acc, digit| acc * 10 + i64::from(digit - b'0'))
        })
    };
    let year = field(0, 4)?;
    // ECMA-262 MakeFullYear: `new Date(23, ...)` means 1923.
    let year = if (0..=99).contains(&year) {
        year + 1900
    } else {
        year
    };
    Some((
        year,
        field(5, 7)?,
        field(8, 10)?,
        field(11, 13)?,
        field(14, 16)?,
        field(17, 19)?,
    ))
}

/// Days since 1970-01-01 for a proleptic-Gregorian civil date (Howard
/// Hinnant's `days_from_civil`); linear in `month`/`day` so overflow normalizes.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "timestamp,session_id,total_cost_usd,last_model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model_id,model_display_name,duration_ms,api_duration_ms,lines_added,lines_removed,rl_5h_pct,rl_7d_pct,context_pct,context_window_size,turns,tool_calls,start_epoch,facets_json,est_cost_usd";

    const ROWS: &str = r#"2026-10-27 13:05:00,sid-1,1.5,claude-opus-4,100,200,300,400,claude-opus-4,Opus 4,1000,200,5,6,12.5,7,40,200000,3,9,0,"{""tools"":{""edit"":2}}",0.9
2026-10-27 13:06:00,sid-2,9,glm-5,100,0,0,0,,,0,0,0,0,,,0,0,0,0,0,,0.75
2026-10-27 13:07:00,sid-3,,glm-5,1000000,0,0,0,,,0,0,0,0,,,0,0,0,0,0,,
timestamp,session_id,total_cost_usd,last_model,,,,,,,,,,,,,,,,,,,,
not-a-date,sid-4,,claude-opus-4,1,2,3,4,,,0,0,0,0,,,0,0,0,0,0,,
"#;

    fn csv_text() -> String {
        format!("{HEADER}\n{ROWS}")
    }

    fn pricing() -> Pricing {
        Pricing::from_json(r#"{"base":{"opus":[1,2,3,4],"glm":[1,0,0,0]}}"#)
    }

    #[test]
    fn sessions_project_cost_precedence_facets_and_local_hour() {
        let sessions = load_sessions(&csv_text(), &pricing(), LocalZone::Fixed(3_600));
        assert_eq!(sessions.len(), 4, "the repeated header row is skipped");
        assert_eq!(
            sessions[0].get(),
            concat!(
                r#"{"ts":"2026-10-27 13:05:00","sid":"sid-1","cost":1.5,"#,
                r#""model":"claude-opus-4","disp":"Opus 4","in":100,"out":200,"#,
                r#""cr":300,"cc":400,"tok":1000,"dur":1000,"api":200,"#,
                r#""la":5,"lr":6,"rl5":12.5,"rl7":7,"turns":3,"tools":9,"#,
                r#""hour":13,"dow":1,"facets":{"tools":{"edit":2}}}"#
            )
        );

        let glm_est: Value = serde_json::from_str(sessions[1].get()).unwrap();
        assert_eq!(
            glm_est["cost"].as_f64(),
            Some(0.75),
            "glm-5 third-party row prefers est_cost_usd over total_cost_usd"
        );
        assert_eq!(glm_est["model"].as_str(), Some("glm-5"));
        assert!(glm_est["facets"].is_null(), "empty facets cell stays null");

        let glm_tokens: Value = serde_json::from_str(sessions[2].get()).unwrap();
        assert_eq!(
            glm_tokens["cost"].as_f64(),
            Some(1.0),
            "no estimate: recomputed from tokens at the glm rate"
        );

        let undated: Value = serde_json::from_str(sessions[3].get()).unwrap();
        assert_eq!(undated["ts"].as_str(), Some("not-a-date"));
        assert_eq!(undated["sid"].as_str(), Some("sid-4"));
        assert!(undated["hour"].is_null());
        assert!(undated["dow"].is_null());
    }

    #[test]
    fn views_project_epoch_tokens_and_unparseable_timestamps() {
        let views = load_session_views(&csv_text(), LocalZone::Fixed(3_600));
        assert_eq!(views.len(), 4);
        assert_eq!(
            views[0].ts,
            Some(1_793_102_700.0),
            "2026-10-27 13:05:00 at UTC+1"
        );
        assert_eq!(views[0].model, "claude-opus-4");
        assert_eq!(
            (views[0].rl5, views[0].rl7, views[0].tok),
            (12.5, 7.0, 1000.0)
        );
        assert_eq!(views[3].ts, None);
        assert_eq!(views[1].tok, 100.0);
        assert!(load_sessions("", &Pricing::default(), LocalZone::Fixed(0)).is_empty());

        // Short rows fill the missing columns with the JS defaults.
        let overflow = format!("{HEADER}\n2026-02-30 01:00:00,s\n");
        let march = format!("{HEADER}\n2026-03-02 01:00:00,s\n");
        assert_eq!(
            load_session_views(&overflow, LocalZone::Fixed(0))[0].ts,
            load_session_views(&march, LocalZone::Fixed(0))[0].ts,
            "Feb 30 normalizes to Mar 2"
        );
    }
}
