//! Pure reconciliation for the usage-report CSV rebuild.
//!
//! Mirrors the reconcile step of `_rebuild_stats_csv` in the bundled
//! `stats.mjs`: duplicate-row dedup with billed-cost precedence, row ordering
//! (rebuilt sessions, then Codex, then carried-forward rows) and the stable
//! timestamp-descending sort. The caller owns file reads, cost-state, pricing,
//! Codex ingest and the CSV write; this module decides only which rows survive
//! and in which order. Rebuilt rows carry the values projected from
//! `usage_report_transcript::session_totals`.

use crate::usage_report_csv::{CSV_COLUMNS, CsvTable, CsvValue, dict_reader, row_value};

/// Session ids that never become rows (stats.mjs:66).
pub const ZERO_UUID: &str = "00000000-0000-0000-0000-000000000000";

/// One CSV-shaped row: `(column, string cell)` pairs, ready for `encode_row`.
pub type Row = Vec<(String, CsvValue)>;

pub struct ReconcileInput<'a> {
    /// Existing `stats.csv` text; empty when the file is absent (stats.mjs:773).
    pub existing_csv: &'a str,
    /// Rows rebuilt from `session_totals`, in transcript enumeration order.
    pub fresh: &'a [Row],
    /// Codex ingest rows; empty when ingest failed (stats.mjs:858-870).
    pub codex: &'a [Row],
    /// Session whose transcript is mid-flight (stats.mjs:771).
    pub active_sid: Option<&'a str>,
}

fn cell<'a>(row: &'a Row, column: &str) -> &'a str {
    row.iter()
        .find(|(key, _)| key == column)
        .and_then(|(_, value)| match value {
            CsvValue::String(text) => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or("")
}

/// Carry-forward rows emit `COLS` only, so unknown headers are dropped and
/// missing cells become empty (stats.mjs:874-876).
fn cells(table: &CsvTable, row: &[Option<String>]) -> Row {
    CSV_COLUMNS
        .iter()
        .map(|column| {
            let value = row_value(table, row, column).unwrap_or("").to_owned();
            ((*column).to_owned(), CsvValue::String(value))
        })
        .collect()
}

/// Dedup existing rows by trimmed session id (stats.mjs:772-784). A prior row
/// with billed cost beats a later blank-cost row; otherwise the later row wins
/// in place, keeping the first insertion position as JS object keys do.
pub fn dedup_existing(csv: &str) -> Vec<(String, Row)> {
    let table = dict_reader(csv);
    let mut existing: Vec<(String, Row)> = Vec::new();
    for row in &table.rows {
        let sid = row_value(&table, row, "session_id").unwrap_or("").trim();
        if sid.is_empty() || sid == ZERO_UUID {
            continue;
        }
        let blank_cost = row_value(&table, row, "total_cost_usd")
            .unwrap_or("")
            .trim()
            .is_empty();
        match existing.iter().position(|(known, _)| known == sid) {
            Some(index) => {
                if !cell(&existing[index].1, "total_cost_usd").trim().is_empty() && blank_cost {
                    continue;
                }
                existing[index].1 = cells(&table, row);
            }
            None => existing.push((sid.to_owned(), cells(&table, row))),
        }
    }
    existing
}

/// Stable descending sort on the raw timestamp string (stats.mjs:879-883).
fn sort_by_timestamp_desc(rows: &mut [Row]) {
    rows.sort_by(|a, b| cell(b, "timestamp").cmp(cell(a, "timestamp")));
}

/// Assemble the rebuild row order: rebuilt sessions, Codex rows, then existing
/// rows not seen above and not the active session (stats.mjs:788-877).
pub fn reconcile(input: &ReconcileInput<'_>) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for row in input.fresh {
        let sid = cell(row, "session_id");
        if sid == ZERO_UUID || Some(sid) == input.active_sid {
            continue;
        }
        seen.push(sid.to_owned());
        rows.push(row.clone());
    }
    for row in input.codex {
        seen.push(cell(row, "session_id").to_owned());
        rows.push(row.clone());
    }
    for (sid, row) in dedup_existing(input.existing_csv) {
        if Some(sid.as_str()) == input.active_sid || seen.iter().any(|known| *known == sid) {
            continue;
        }
        rows.push(row);
    }
    sort_by_timestamp_desc(&mut rows);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> String {
        CSV_COLUMNS.join(",")
    }

    fn line(timestamp: &str, sid: &str, cost: &str) -> String {
        CSV_COLUMNS
            .iter()
            .map(|column| match *column {
                "timestamp" => timestamp,
                "session_id" => sid,
                "total_cost_usd" => cost,
                _ => "",
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    fn csv(lines: &[String]) -> String {
        format!("{}\n{}\n", header(), lines.join("\n"))
    }

    fn row(timestamp: &str, sid: &str, cost: &str) -> Row {
        CSV_COLUMNS
            .iter()
            .map(|column| {
                let value = match *column {
                    "timestamp" => timestamp,
                    "session_id" => sid,
                    "total_cost_usd" => cost,
                    _ => "",
                };
                ((*column).to_owned(), CsvValue::String(value.to_owned()))
            })
            .collect()
    }

    fn shape(rows: &[Row]) -> Vec<(String, String, String)> {
        rows.iter()
            .map(|row| {
                (
                    cell(row, "session_id").to_owned(),
                    cell(row, "timestamp").to_owned(),
                    cell(row, "total_cost_usd").to_owned(),
                )
            })
            .collect()
    }

    #[test]
    fn dedup_prefers_billed_cost_and_keeps_the_first_position() {
        let text = csv(&[
            line("10", "a", "1.5"),
            line("11", "b", ""),
            line("12", "a", ""),
            line("13", "b", "2.0"),
            line("14", "c", ""),
            line("15", "c", "3.0"),
            line("16", "a", "9.0"),
        ]);
        let existing = dedup_existing(&text);
        let sids: Vec<&str> = existing.iter().map(|(sid, _)| sid.as_str()).collect();
        assert_eq!(sids, ["a", "b", "c"]);
        let timestamps: Vec<&str> = existing
            .iter()
            .map(|(_, row)| cell(row, "timestamp"))
            .collect();
        assert_eq!(timestamps, ["16", "13", "15"]);
        assert_eq!(cell(&existing[0].1, "total_cost_usd"), "9.0");
    }

    #[test]
    fn dedup_drops_blank_and_zero_sid_rows() {
        let text = format!(
            "{},extra\n{},\n{},\n{},\n{},\n",
            header(),
            line("1", "", "5"),
            line("2", "   ", "5"),
            line("3", ZERO_UUID, "5"),
            line("4", " x ", ""),
        );
        let existing = dedup_existing(&text);
        assert_eq!(existing.len(), 1);
        assert_eq!(existing[0].0, "x");
        assert_eq!(existing[0].1.len(), CSV_COLUMNS.len());
        assert_eq!(cell(&existing[0].1, "timestamp"), "4");
    }

    #[test]
    fn reconcile_orders_fresh_then_codex_then_carried_and_skips_active() {
        let text = csv(&[
            line("01", "dup", "1"),
            line("01", "keep", "1"),
            line("01", "active", "1"),
            line("01", "codex-dup", "1"),
        ]);
        let fresh = vec![
            row("01", "dup", "2"),
            row("01", ZERO_UUID, "0"),
            row("01", "active", "3"),
        ];
        let codex = vec![row("01", "codex-dup", "4"), row("01", "codex-new", "5")];
        let rows = reconcile(&ReconcileInput {
            existing_csv: &text,
            fresh: &fresh,
            codex: &codex,
            active_sid: Some("active"),
        });
        let sids: Vec<&str> = rows.iter().map(|row| cell(row, "session_id")).collect();
        assert_eq!(sids, ["dup", "codex-dup", "codex-new", "keep"]);
        assert_eq!(cell(&rows[0], "total_cost_usd"), "2");
    }

    #[test]
    fn reconcile_sorts_timestamps_lexically_descending_and_stably() {
        let fresh = vec![
            row("2026-10-27 10:00", "a", ""),
            row("9", "b", ""),
            row("10", "c", ""),
            row("9", "d", ""),
            row("", "e", ""),
        ];
        let rows = reconcile(&ReconcileInput {
            existing_csv: "",
            fresh: &fresh,
            codex: &[],
            active_sid: None,
        });
        let sids: Vec<&str> = rows.iter().map(|row| cell(row, "session_id")).collect();
        assert_eq!(sids, ["b", "d", "a", "c", "e"]);
    }

    #[test]
    fn reconcile_carries_unseen_existing_rows_forward_verbatim() {
        let text = csv(&[line("20", "old", "7.25")]);
        let fresh = vec![row("30", "new", "1")];
        let rows = reconcile(&ReconcileInput {
            existing_csv: &text,
            fresh: &fresh,
            codex: &[],
            active_sid: None,
        });
        assert_eq!(
            shape(&rows),
            [
                ("new".to_owned(), "30".to_owned(), "1".to_owned()),
                ("old".to_owned(), "20".to_owned(), "7.25".to_owned()),
            ]
        );
    }
}
