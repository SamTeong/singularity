//! Pure roadmap derivation ported from the bundled
//! `.claude/skills/harness-usage-report-suggestions/scripts/improve.mjs`.
//!
//! No filesystem, environment, clock, process, or network access: callers pass
//! already-acquired inventory facts and `_inum`-projected stats rows. Suggestion
//! text and append order are the bundled helper's byte-for-byte literals; the
//! renderer keeps owning status sorting, chip dedup, and the `None` fallback.

use ryu_js::Buffer;

/// Already-acquired inventory facts. `archive` is the nonempty-line count of
/// `sessions.jsonl`; the other counts are immediate directory entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inventory {
    pub history: bool,
    pub tasks: usize,
    pub file_history: usize,
    pub archive: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StatsRow {
    pub la: f64,
    pub lr: f64,
}

/// Stats rows after the bundled loader's `_inum` projection.
#[derive(Debug, Clone, PartialEq)]
pub struct StatsProjection {
    pub totals_sessions: f64,
    pub rows: Vec<StatsRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub area: &'static str,
    pub status: &'static str,
    pub text: String,
}

pub fn build_roadmap(inventory: &Inventory, stats: &StatsProjection) -> Vec<Suggestion> {
    let n = js_or(stats.totals_sessions, 1.0);
    let displayed = js_or(stats.totals_sessions, 0.0);
    let loc_cov = stats
        .rows
        .iter()
        .filter(|row| js_or(row.la, 0.0) + js_or(row.lr, 0.0) > 0.0)
        .count();
    let percent = js_round(loc_cov as f64 / n * 100.0);
    let mut suggestions = Vec::new();
    let mut add = |area: &'static str, status: &'static str, text: String| {
        suggestions.push(Suggestion { area, status, text });
    };

    if inventory.history {
        add(
            "Prompt patterns",
            "available",
            concat!(
                "history.jsonl present — add prompt-length distribution, prompts/session, and ",
                "think-time between prompts (when in the day you're most productive)."
            )
            .to_string(),
        );
    }
    if inventory.tasks > 0 {
        add(
            "Task completion",
            "available",
            format!(
                concat!(
                    "{} TaskCreate todo lists in ~/.claude/tasks — add a todo ",
                    "completion-rate stat (done vs abandoned per session)."
                ),
                inventory.tasks
            ),
        );
    }
    if inventory.file_history > 0 {
        add(
            "File churn",
            "available",
            format!(
                concat!(
                    "{} file-history snapshots — surface most-edited files/repos ",
                    "and real churn, independent of statusline line counts."
                ),
                inventory.file_history
            ),
        );
    }
    add(
        "Response latency",
        "available",
        "Transcript message timestamps support a think-time vs generation-time split per session."
            .to_string(),
    );
    add(
        "LOC coverage",
        "partial",
        format!(
            concat!(
                "lines added/removed present for {}/{} sessions ",
                "({}%); $/line is now cost-scoped to line-bearing rows and ",
                "shown as '—' below 5% coverage. Value still firms up as more sessions record ",
                "via the statusline."
            ),
            loc_cov,
            js_number(displayed),
            js_number(percent)
        ),
    );
    add(
        "Active-time tracking",
        "partial",
        concat!(
            "$/hour now uses an active-time proxy (cost>0 sessions, per-session duration uncapped ",
            "— legit sessions can exceed 8h) instead of raw transcript wall-clock span, which ",
            "counted idle/hung sessions (e.g. 577h @ $0). The $0-cost filter alone drops ",
            "idle/hung sessions; proxy still underestimates real hourly cost because idle is ",
            "distributed within billed sessions; a true fix needs turn-level active-time capture ",
            "in the statusline, not transcript span."
        )
        .to_string(),
    );
    add(
        "Rate-limit utilization",
        "partial",
        concat!(
            "rl_5h_pct / rl_7d_pct now charted (utilization %, throttle-safety >80%/100%, ",
            "spend per 7d%-point at peak). Forward-only from the statusline rate_limits field ",
            "(Claude Code v2.1.80+, Claude.ai Pro/Max only — absent for API-key/Bedrock/Vertex ",
            "and some Max 20x oauth users). Coverage grows as sessions record; efficient-use ",
            "judgment firms up once a full 7-day window is captured."
        )
        .to_string(),
    );
    add(
        "Rate-limit forecast",
        "done",
        concat!(
            "Empirical-Bayes forecast (claumon MODEL v2.1 port, forecast.mjs) projects each ",
            "gauge to its reset boundary with an 80% credible interval + ETA-to-threshold, ",
            "fit from OAuth usage-snapshots; prior-only statusline-rl fallback when OAuth is off. ",
            "`stats.mjs forecast [--force]` prints/forces the fit (state/forecast.json)."
        )
        .to_string(),
    );
    add(
        "Prior calibration",
        "done",
        concat!(
            "Out-of-sample audit of the percentile cost priors (Phase E): hold out the most ",
            "recent ~20% of cost-calibrated ops per category, refit p50/p90, score coverage / ",
            "bias / pinball. Printed by `priors` (p90 cov / bias columns) and `estimate` (OOS ",
            "calibration row); p90 coverage < 0.70 flagged as unreliable."
        )
        .to_string(),
    );
    add(
        "Live pricing refresh",
        "done",
        concat!(
            "pricing.json (state/pricing.json) is the only rate source — no embedded table, no ",
            "live-fetch cache, no promos. Edited by hand or via Singularity's Settings > Models > ",
            "Prices UI; `stats.mjs pricing` prints the resolved table. Missing/invalid file or an ",
            "unmatched model leaves cost unpriced (blank), never a crash."
        )
        .to_string(),
    );
    add(
        "Subagent tokens in est cost",
        "done",
        concat!(
            "Phase G: est_cost_usd (no-billed sessions) now folds in subagent-run transcript ",
            "tokens, summed per assistant message with _msg_cost_tiered. The isSidechain skip is ",
            "scoped to the main transcript (subagent files are themselves the sidechain). Billed ",
            "sessions unchanged; priors still calibrate on billed only."
        )
        .to_string(),
    );
    add(
        "EB shrinkage in estimate",
        "done",
        concat!(
            "Phase H: small-n category cost priors are shrunk toward a cross-category grand ",
            "mean (FC.fitPrior between-category variance + normal-normal conjugacy; shift scaled ",
            "by per-category withinVar/n). Stored per category as `shrink`; `estimate` prints a ",
            "`shrunk (EB, small-n)` row when n_cost < 20. Large-n categories keep raw (data-weight≈1)."
        )
        .to_string(),
    );
    add(
        "Active-session detection",
        "done",
        concat!(
            "Phase I: report excludes the mid-flight session via cost-state freshness (statusline ",
            "rewrites cost-state/<sid>.json per render; fresh <900s = live) instead of the old 180s ",
            "transcript-mtime window, which mislabeled a paused-but-live session as closed and folded ",
            "its incomplete transcript in. Stale lingering cost-state (hook-missed) still folds in; ",
            "180s transcript-mtime fallback kept for the no-statusline case."
        )
        .to_string(),
    );
    if inventory.archive == 0 {
        add(
            "Statusline archive",
            "partial",
            concat!(
                "sessions.jsonl is empty — the full-JSON archive fills as new sessions end; future ",
                "metrics (rate-limit trends, context fullness) then need no re-capture."
            )
            .to_string(),
        );
    } else {
        add(
            "Statusline archive",
            "available",
            format!(
                concat!(
                    "{} sessions archived in sessions.jsonl — mine rate-limit % and ",
                    "context-fullness trends next."
                ),
                inventory.archive
            ),
        );
    }
    add(
        "Report UX",
        "idea",
        "Add a date-range filter, a session search box, sortable tables, and CSV/PNG export."
            .to_string(),
    );
    add(
        "Report UX",
        "idea",
        "Per-project filter mirroring the model filter; drill from a project into its sessions."
            .to_string(),
    );
    add(
        "Cross-tool",
        "idea",
        concat!(
            "Reconcile against other AI-coding spend trackers (e.g. CodeBurn, agent-insights) ",
            "for spend across Copilot, Cursor, Codex, if you use any."
        )
        .to_string(),
    );
    suggestions
}

/// JS `value || fallback` for numbers: `NaN` and both zeros are falsy.
fn js_or(value: f64, fallback: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        fallback
    } else {
        value
    }
}

/// JS `Math.round`, whose ties go toward +Infinity and whose `x - floor(x)`
/// avoids the `floor(x + 0.5)` divergence at 0.49999999999999994.
fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// ECMAScript number-to-string for template interpolation (`-0` prints `0`).
fn js_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value.is_infinite() {
        if value > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else if value == 0.0 {
        "0".into()
    } else {
        Buffer::new().format_finite(value).to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn inventory(history: bool, tasks: usize, file_history: usize, archive: usize) -> Inventory {
        Inventory {
            history,
            tasks,
            file_history,
            archive,
        }
    }

    fn stats(totals_sessions: f64, rows: &[(f64, f64)]) -> StatsProjection {
        StatsProjection {
            totals_sessions,
            rows: rows.iter().map(|&(la, lr)| StatsRow { la, lr }).collect(),
        }
    }

    fn areas(suggestions: &[Suggestion]) -> Vec<&'static str> {
        suggestions
            .iter()
            .map(|suggestion| suggestion.area)
            .collect()
    }

    fn text<'a>(suggestions: &'a [Suggestion], area: &str) -> &'a str {
        suggestions
            .iter()
            .find(|suggestion| suggestion.area == area)
            .unwrap()
            .text
            .as_str()
    }

    #[test]
    fn fixed_rows_keep_bundled_order_and_statuses() {
        let roadmap = build_roadmap(&inventory(false, 0, 0, 0), &stats(0.0, &[]));
        assert_eq!(
            areas(&roadmap),
            vec![
                "Response latency",
                "LOC coverage",
                "Active-time tracking",
                "Rate-limit utilization",
                "Rate-limit forecast",
                "Prior calibration",
                "Live pricing refresh",
                "Subagent tokens in est cost",
                "EB shrinkage in estimate",
                "Active-session detection",
                "Statusline archive",
                "Report UX",
                "Report UX",
                "Cross-tool",
            ]
        );
        assert_eq!(
            roadmap
                .iter()
                .map(|suggestion| suggestion.status)
                .collect::<Vec<_>>(),
            vec![
                "available",
                "partial",
                "partial",
                "partial",
                "done",
                "done",
                "done",
                "done",
                "done",
                "done",
                "partial",
                "idea",
                "idea",
                "idea",
            ]
        );
    }

    #[test]
    fn conditional_rows_and_archive_variants() {
        let archive_status = |roadmap: &[Suggestion]| {
            roadmap
                .iter()
                .find(|suggestion| suggestion.area == "Statusline archive")
                .unwrap()
                .status
        };
        let roadmap = build_roadmap(&inventory(true, 2, 1, 0), &stats(2.0, &[]));
        assert_eq!(roadmap.len(), 17);
        assert_eq!(
            areas(&roadmap)[..3],
            ["Prompt patterns", "Task completion", "File churn"]
        );
        assert!(text(&roadmap, "Task completion").contains("2 TaskCreate todo lists"));
        assert!(text(&roadmap, "File churn").contains("1 file-history snapshots"));
        assert_eq!(archive_status(&roadmap), "partial");
        assert!(text(&roadmap, "Statusline archive").contains("sessions.jsonl is empty"));

        let roadmap = build_roadmap(&inventory(false, 0, 0, 3), &stats(0.0, &[]));
        assert_eq!(roadmap.len(), 14);
        assert_eq!(archive_status(&roadmap), "available");
        assert!(text(&roadmap, "Statusline archive").contains("3 sessions archived"));
    }

    #[test]
    fn coverage_follows_js_number_semantics() {
        let cases: &[(f64, &[(f64, f64)], &str)] = &[
            (0.0, &[(1.0, 0.0)], "1/0 sessions (100%)"),
            (-0.0, &[(1.0, 0.0)], "1/0 sessions (100%)"),
            (f64::NAN, &[(1.0, 0.0)], "1/0 sessions (100%)"),
            (f64::INFINITY, &[(1.0, 0.0)], "1/Infinity sessions (0%)"),
            (-200.0, &[(1.0, 0.0)], "1/-200 sessions (0%)"),
            (-2.0, &[(1.0, 0.0)], "1/-2 sessions (-50%)"),
            (
                8.0,
                &[
                    (1.0, 0.0),
                    (1.0, 0.0),
                    (1.0, 0.0),
                    (0.0, 0.0),
                    (0.0, 0.0),
                    (0.0, 0.0),
                    (0.0, 0.0),
                    (0.0, 0.0),
                ],
                "3/8 sessions (38%)",
            ),
            (
                3.0,
                &[
                    (f64::NAN, 0.0),
                    (-0.0, 0.0),
                    (f64::INFINITY, f64::NEG_INFINITY),
                ],
                "0/3 sessions (0%)",
            ),
            (1e-323, &[(1.0, 0.0)], "1/1e-323 sessions (Infinity%)"),
        ];
        for (totals_sessions, rows, expected) in cases {
            let roadmap = build_roadmap(&inventory(false, 0, 0, 0), &stats(*totals_sessions, rows));
            assert!(
                text(&roadmap, "LOC coverage").contains(expected),
                "missing {expected:?} in {:?}",
                text(&roadmap, "LOC coverage")
            );
        }
    }

    #[test]
    fn duplicate_ux_rows_are_neither_sorted_nor_deduplicated() {
        let roadmap = build_roadmap(&inventory(false, 0, 0, 0), &stats(0.0, &[]));
        assert_eq!(
            roadmap
                .iter()
                .filter(|suggestion| suggestion.area == "Report UX")
                .count(),
            2
        );
        assert_ne!(roadmap[11].text, roadmap[12].text);
        assert_eq!(roadmap[0].area, "Response latency");
        assert_eq!(roadmap[13].area, "Cross-tool");
    }

    fn cases() -> Vec<(&'static str, Inventory, StatsProjection)> {
        vec![
            ("empty", inventory(false, 0, 0, 0), stats(0.0, &[])),
            (
                "all-flags",
                inventory(true, 2, 1, 3),
                stats(2.0, &[(1.0, 0.0), (0.0, 2.0)]),
            ),
            ("tasks-one", inventory(false, 1, 0, 0), stats(1.0, &[])),
            (
                "file-history-only",
                inventory(false, 0, 7, 5),
                stats(1.0, &[(0.0, 0.0)]),
            ),
            (
                "coverage-mixed",
                inventory(true, 12, 3, 2),
                stats(
                    4.0,
                    &[
                        (1.0, -0.0),
                        (-0.0, 0.0),
                        (f64::NAN, 1.0),
                        (f64::INFINITY, f64::NEG_INFINITY),
                        (2.5, -1.0),
                    ],
                ),
            ),
            (
                "zero-total-covered",
                inventory(false, 0, 0, 0),
                stats(0.0, &[(1.0, 0.0)]),
            ),
            (
                "negative-zero-total",
                inventory(false, 0, 0, 0),
                stats(-0.0, &[(1.0, 0.0)]),
            ),
            (
                "nan-total",
                inventory(false, 0, 0, 0),
                stats(f64::NAN, &[(1.0, 0.0)]),
            ),
            (
                "infinite-total",
                inventory(false, 0, 0, 0),
                stats(f64::INFINITY, &[(1.0, 0.0)]),
            ),
            (
                "tiny-total",
                inventory(false, 0, 0, 0),
                stats(1e-323, &[(1.0, 0.0)]),
            ),
            (
                "negative-total",
                inventory(false, 0, 0, 0),
                stats(-2.0, &[(1.0, 0.0)]),
            ),
            (
                "half-negative-rounding",
                inventory(false, 0, 0, 0),
                stats(-200.0, &[(1.0, 0.0)]),
            ),
            (
                "round-half",
                inventory(false, 0, 0, 0),
                stats(
                    8.0,
                    &[
                        (1.0, 0.0),
                        (1.0, 0.0),
                        (1.0, 0.0),
                        (0.0, 0.0),
                        (0.0, 0.0),
                        (0.0, 0.0),
                        (0.0, 0.0),
                        (0.0, 0.0),
                    ],
                ),
            ),
        ]
    }

    fn json_number(value: f64) -> serde_json::Value {
        if value.is_nan() {
            "NaN".into()
        } else if value.is_infinite() {
            if value > 0.0 {
                "Infinity".into()
            } else {
                "-Infinity".into()
            }
        } else if value == 0.0 && value.is_sign_negative() {
            "-0".into()
        } else {
            value.into()
        }
    }

    fn run_node_oracle(payload: &serde_json::Value) -> serde_json::Value {
        let binary = std::env::var_os("NODE_BINARY")
            .expect("NODE_BINARY must name an absolute Node executable for the parity test");
        let binary = std::path::Path::new(&binary);
        assert!(binary.is_absolute(), "NODE_BINARY must be absolute");
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let oracle = manifest.join("tests/usage_report_roadmap_oracle.mjs");
        let temp = std::env::temp_dir().join(format!(
            "usage-report-roadmap-oracle-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp).unwrap();
        let mut command = std::process::Command::new(binary);
        command.arg(oracle).env_clear();
        for name in ["SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("HOME", &temp)
            .env("USERPROFILE", &temp)
            .env("PROFILE", &temp)
            .env("APPDATA", &temp)
            .env("TEMP", &temp)
            .env("TMP", &temp)
            .env("TMPDIR", &temp);
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("launch source-bound Node oracle");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(serde_json::to_string(payload).unwrap().as_bytes())
            .unwrap();
        let output = child
            .wait_with_output()
            .expect("read source-bound Node oracle");
        assert!(
            output.status.success(),
            "Node oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("parse oracle output")
    }

    #[test]
    fn matches_source_bound_node_vm() {
        let cases = cases();
        let payload = serde_json::Value::Array(
            cases
                .iter()
                .map(|(name, inventory, stats)| {
                    serde_json::json!({
                        "name": name,
                        "inventory": {
                            "history": inventory.history,
                            "tasks": inventory.tasks,
                            "file_history": inventory.file_history,
                            "archive": inventory.archive,
                        },
                        "stats": {
                            "totals": json_number(stats.totals_sessions),
                            "rows": stats
                                .rows
                                .iter()
                                .map(|row| serde_json::json!({
                                    "la": json_number(row.la),
                                    "lr": json_number(row.lr),
                                }))
                                .collect::<Vec<_>>(),
                        },
                    })
                })
                .collect(),
        );
        let oracle = run_node_oracle(&payload);
        for (index, (name, inventory, stats)) in cases.iter().enumerate() {
            let actual = build_roadmap(inventory, stats);
            let expected = oracle[index].as_array().unwrap();
            assert_eq!(actual.len(), expected.len(), "{name} length");
            for (row, suggestion) in actual.iter().enumerate() {
                assert_eq!(
                    suggestion.area,
                    expected[row]["area"].as_str().unwrap(),
                    "{name}[{row}] area"
                );
                assert_eq!(
                    suggestion.status,
                    expected[row]["status"].as_str().unwrap(),
                    "{name}[{row}] status"
                );
                assert_eq!(
                    suggestion.text,
                    expected[row]["text"].as_str().unwrap(),
                    "{name}[{row}] text"
                );
            }
        }
    }
}
