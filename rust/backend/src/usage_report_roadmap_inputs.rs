//! Acquisition adapter for the roadmap derivation.
//!
//! Mirrors the bundled scripts' `_data_inventory` (improve.mjs:64-81) and the
//! roadmap-relevant part of `_load_stats` (stats.mjs:952-1007). Callers supply
//! already-read file text, directory entry counts, and parsed CSV rows; this
//! module owns only the archive line count and the `_inum` coercion.

use crate::usage_report_csv::{CsvTable, row_value};
use crate::usage_report_roadmap::{Inventory, StatsProjection, StatsRow};

/// Facts the caller already gathered. `sessions_jsonl` is the decoded file
/// text, or `None` when the file is absent or unreadable (both count 0); the
/// other counts are immediate directory entries.
pub struct InventoryInput<'a> {
    pub sessions_jsonl: Option<&'a str>,
    pub history: bool,
    pub tasks: usize,
    pub file_history: usize,
}

/// `_data_inventory` (improve.mjs:64-81) minus its filesystem access.
pub fn build_inventory(input: &InventoryInput<'_>) -> Inventory {
    // improve.mjs:69 — empty text → 0, else `text.trimEnd().split("\n").filter(Boolean).length`.
    let archive = input.sessions_jsonl.map_or(0, |text| {
        if text.is_empty() {
            0
        } else {
            js_trim_end(text)
                .split('\n')
                .filter(|line| !line.is_empty())
                .count()
        }
    });
    Inventory {
        history: input.history,
        tasks: input.tasks,
        file_history: input.file_history,
        archive,
    }
}

/// `_load_stats` (stats.mjs:952-1007) projected onto the roadmap's fields: the
/// header-row skip (stats.mjs:960-961), `_inum` of `lines_added`/`lines_removed`
/// (stats.mjs:995-996), and `totals.sessions = sessions.length` (stats.mjs:1006).
pub fn build_stats_projection(table: &CsvTable) -> StatsProjection {
    let mut rows = Vec::new();
    for row in &table.rows {
        if js_trim(row_value(table, row, "timestamp").unwrap_or("")) == "timestamp"
            || js_trim(row_value(table, row, "total_cost_usd").unwrap_or("")) == "total_cost_usd"
        {
            continue;
        }
        rows.push(StatsRow {
            la: inum(row_value(table, row, "lines_added")),
            lr: inum(row_value(table, row, "lines_removed")),
        });
    }
    StatsProjection {
        totals_sessions: rows.len() as f64,
        rows,
    }
}

/// `_inum` (stats.mjs:944-948): absent/empty → 0, else `parseFloat` (stats.mjs:946)
/// with `NaN` → 0 and `Math.trunc` (stats.mjs:947).
fn inum(value: Option<&str>) -> f64 {
    match value {
        None | Some("") => 0.0,
        Some(text) => parse_float(text)
            .filter(|number| !number.is_nan())
            .map_or(0.0, f64::trunc),
    }
}

/// ECMAScript `parseFloat`: longest numeric prefix, and only the exact
/// `Infinity` spelling (`"infinity"` therefore yields no number).
fn parse_float(text: &str) -> Option<f64> {
    let text = text.trim_start_matches(js_whitespace);
    if text.starts_with("-Infinity") {
        return Some(f64::NEG_INFINITY);
    }
    if text.starts_with("Infinity") || text.starts_with("+Infinity") {
        return Some(f64::INFINITY);
    }
    for end in (1..=text.len()).rev() {
        if !text.is_char_boundary(end) {
            continue;
        }
        let Ok(value) = text[..end].parse::<f64>() else {
            continue;
        };
        if value.is_infinite() {
            // Rust accepts case-insensitive `inf`/`infinity`; parseFloat does not.
            // Numeric overflow (for example, 1e309) stays infinity.
            let candidate = &text[..end];
            let unsigned = candidate
                .strip_prefix('+')
                .or_else(|| candidate.strip_prefix('-'))
                .unwrap_or(candidate);
            if unsigned
                .get(..3)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("inf"))
            {
                return None;
            }
        }
        return Some(value);
    }
    None
}

/// ECMAScript `WhiteSpace` ∪ `LineTerminator`, the set `trim` and `parseFloat` use.
fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(js_whitespace)
}

fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_report_csv::dict_reader;
    use crate::usage_report_roadmap::build_roadmap;

    fn inventory(sessions_jsonl: Option<&str>) -> Inventory {
        build_inventory(&InventoryInput {
            sessions_jsonl,
            history: true,
            tasks: 2,
            file_history: 3,
        })
    }

    #[test]
    fn inum_matches_js_parse_float_and_trunc() {
        let cases: &[(Option<&str>, f64)] = &[
            (None, 0.0),
            (Some(""), 0.0),
            (Some("   "), 0.0),
            (Some("12"), 12.0),
            (Some("12.9"), 12.0),
            (Some("-12.9"), -12.0),
            (Some("  +7abc"), 7.0),
            (Some("1e"), 1.0),
            (Some("0x10"), 0.0),
            (Some("1e309"), f64::INFINITY),
            (Some("Infinity"), f64::INFINITY),
            (Some("+Infinity"), f64::INFINITY),
            (Some("-Infinityx"), f64::NEG_INFINITY),
            (Some("infinity"), 0.0),
            (Some("NaN"), 0.0),
            (Some("nan"), 0.0),
            (Some("\u{00a0}5"), 5.0),
            (Some("null"), 0.0),
        ];
        for (input, expected) in cases {
            assert_eq!(inum(*input), *expected, "{input:?}");
        }
        assert!(
            inum(Some("-0.9")).is_sign_negative(),
            "-0.9 truncates to -0"
        );
    }

    #[test]
    fn inventory_archive_counts_nonempty_lines() {
        assert_eq!(
            inventory(None),
            Inventory {
                history: true,
                tasks: 2,
                file_history: 3,
                archive: 0,
            }
        );
        assert_eq!(inventory(Some("")).archive, 0);
        assert_eq!(inventory(Some(" \n\t\n")).archive, 0);
        assert_eq!(inventory(Some("a\n\nb\n")).archive, 2);
        assert_eq!(inventory(Some("a\r\nb\r\n")).archive, 2);
        assert_eq!(inventory(Some("a\u{feff}")).archive, 1);
    }

    #[test]
    fn stats_projection_skips_header_rows_and_coerces_counts() {
        let csv = concat!(
            "timestamp,total_cost_usd,lines_added,lines_removed\n",
            "2026-01-01 00:00:00,1.5,10,2\n",
            "timestamp,total_cost_usd,lines_added,lines_removed\n",
            "x,  total_cost_usd  ,7,\n",
            ",,,\n",
            "2026-01-01 00:00:01,0.5,1e309,-3.9\n",
        );
        let projection = build_stats_projection(&dict_reader(csv));
        assert_eq!(projection.totals_sessions, 3.0);
        assert_eq!(
            projection.rows,
            vec![
                StatsRow { la: 10.0, lr: 2.0 },
                StatsRow { la: 0.0, lr: 0.0 },
                StatsRow {
                    la: f64::INFINITY,
                    lr: -3.0,
                },
            ]
        );
    }

    #[test]
    fn projection_feeds_roadmap_coverage() {
        let csv = concat!(
            "timestamp,lines_added,lines_removed\n",
            "2026-01-01 00:00:00,1,0\n",
            "2026-01-01 00:00:01,0,0\n",
        );
        let stats = build_stats_projection(&dict_reader(csv));
        let roadmap = build_roadmap(&inventory(None), &stats);
        assert!(
            roadmap
                .iter()
                .any(|suggestion| suggestion.area == "LOC coverage"
                    && suggestion.text.contains("1/2 sessions (50%)")),
            "coverage text: {:?}",
            roadmap
                .iter()
                .find(|suggestion| suggestion.area == "LOC coverage")
        );
    }
}
