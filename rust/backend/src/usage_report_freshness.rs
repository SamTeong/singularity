//! Pure freshness decision for usage-report preparation.
//!
//! Mirrors `_ensure_fresh` in the bundled harness usage-report script. The
//! caller owns the clock, file enumeration, stat error handling, and any
//! rebuild; this decides only which session is active and whether the CSV is
//! stale.

const COST_WIN_S: f64 = 900.0;
const TX_WIN_S: f64 = 180.0;

/// One freshness check over a caller-supplied enumeration snapshot.
pub struct FreshnessInput<'a> {
    pub now_s: f64,
    /// CSV mtime in seconds; zero covers both a missing CSV and an epoch-zero one.
    pub csv_mtime_s: f64,
    /// Transcript `(sid, mtime_s)` entries in enumeration order.
    pub transcripts: &'a [(String, f64)],
    /// Cost-state `(sid, mtime_s)` entries in enumeration order.
    pub state_files: &'a [(String, f64)],
    /// Codex rollout mtimes in enumeration order.
    pub codex_mtimes: &'a [f64],
}

#[derive(Debug, Clone, PartialEq)]
pub struct FreshnessDecision {
    pub active_sid: Option<String>,
    pub needs_rebuild: bool,
}

fn newest_above_zero(entries: &[(String, f64)]) -> Option<(&str, f64)> {
    let mut best: Option<(&str, f64)> = None;
    for (sid, mtime) in entries {
        let higher = best.map_or(*mtime > 0.0, |(_, seen)| *mtime > seen);
        if higher {
            best = Some((sid, *mtime));
        }
    }
    best
}

pub fn decide_freshness(input: &FreshnessInput<'_>) -> FreshnessDecision {
    let (active_entries, window) = if input.state_files.is_empty() {
        (input.transcripts, TX_WIN_S)
    } else {
        (input.state_files, COST_WIN_S)
    };
    let active_sid = newest_above_zero(active_entries)
        .filter(|(sid, mtime)| !sid.is_empty() && input.now_s - *mtime < window)
        .map(|(sid, _)| sid.to_owned());

    let mut needs_rebuild = input.csv_mtime_s == 0.0;
    if !needs_rebuild {
        needs_rebuild = input
            .transcripts
            .iter()
            .chain(input.state_files)
            .any(|(sid, mtime)| {
                active_sid.as_deref() != Some(sid.as_str()) && *mtime > input.csv_mtime_s
            });
    }
    if !needs_rebuild {
        needs_rebuild = input.codex_mtimes.iter().any(|mtime| {
            let age = input.now_s - *mtime;
            !(age < TX_WIN_S) && *mtime > input.csv_mtime_s
        });
    }

    FreshnessDecision {
        active_sid,
        needs_rebuild,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    const NOW_MS: f64 = 1_700_000_000_000.0;
    const NOW_S: f64 = 1_700_000_000.0;

    struct Case {
        name: &'static str,
        now_ms: f64,
        csv_mtime_s: f64,
        csv_exists: bool,
        transcripts: Vec<(String, f64)>,
        state_files: Vec<(String, f64)>,
        codex_mtimes: Vec<f64>,
    }

    fn case(name: &'static str) -> Case {
        Case {
            name,
            now_ms: NOW_MS,
            csv_mtime_s: NOW_S - 10_000.0,
            csv_exists: true,
            transcripts: Vec::new(),
            state_files: Vec::new(),
            codex_mtimes: Vec::new(),
        }
    }

    fn pairs(entries: &[(&str, f64)]) -> Vec<(String, f64)> {
        entries
            .iter()
            .map(|(sid, mtime)| ((*sid).to_owned(), *mtime))
            .collect()
    }

    impl Case {
        fn csv(mut self, mtime_s: f64, exists: bool) -> Self {
            self.csv_mtime_s = mtime_s;
            self.csv_exists = exists;
            self
        }

        fn transcripts(mut self, entries: &[(&str, f64)]) -> Self {
            self.transcripts = pairs(entries);
            self
        }

        fn state(mut self, entries: &[(&str, f64)]) -> Self {
            self.state_files = pairs(entries);
            self
        }

        fn codex(mut self, mtimes: &[f64]) -> Self {
            self.codex_mtimes = mtimes.to_vec();
            self
        }
    }

    fn cases() -> Vec<Case> {
        let age = |seconds: f64| NOW_S - seconds;
        vec![
            case("empty-absent-zero-csv").csv(0.0, false),
            case("empty-existing-zero-csv").csv(0.0, true),
            case("negative-zero-csv").csv(-0.0, true),
            case("empty-positive-csv"),
            case("transcript-age-179").transcripts(&[("a", age(179.0))]),
            case("transcript-age-180").transcripts(&[("a", age(180.0))]),
            case("state-age-899").state(&[("s", age(899.0))]),
            case("state-age-900").state(&[("s", age(900.0))]),
            case("stale-state-suppresses-transcript")
                .state(&[("s", age(5_000.0))])
                .transcripts(&[("a", age(10.0))]),
            case("fresh-state-excluded-from-rebuild")
                .csv(age(20.0), true)
                .state(&[("s", age(10.0))]),
            case("transcript-tie-first-wins").transcripts(&[("a", age(50.0)), ("b", age(50.0))]),
            case("state-tie-first-wins").state(&[("s1", age(50.0)), ("s2", age(50.0))]),
            case("zero-and-negative-mtime-never-active")
                .csv(1.0, true)
                .transcripts(&[("a", 0.0), ("b", -5.0)]),
            case("future-transcript-is-active").transcripts(&[("a", NOW_S + 100.0)]),
            case("mtime-equal-to-csv-does-not-rebuild")
                .csv(100.0, true)
                .transcripts(&[("a", 100.0)]),
            case("mtime-newer-than-csv-rebuilds")
                .csv(100.0, true)
                .transcripts(&[("a", 101.0)]),
            case("negative-csv-mtime-compares")
                .csv(-100.0, true)
                .transcripts(&[("a", -50.0)]),
            case("codex-age-179-suppressed")
                .csv(age(1_000.0), true)
                .codex(&[age(179.0)]),
            case("codex-age-180-eligible")
                .csv(age(1_000.0), true)
                .codex(&[age(180.0)]),
            case("future-codex-suppressed")
                .csv(age(1_000.0), true)
                .codex(&[NOW_S + 100.0]),
            case("duplicate-active-sids-skipped")
                .csv(age(1_000.0), true)
                .transcripts(&[("d", age(10.0)), ("d", age(5.0))]),
            case("nan-transcript-mtime")
                .csv(1.0, true)
                .transcripts(&[("a", f64::NAN)]),
            case("infinite-transcript-wins-active")
                .csv(age(1_000.0), true)
                .transcripts(&[("a", f64::INFINITY), ("b", age(10.0))]),
            case("negative-infinite-transcript-inactive")
                .csv(1.0, true)
                .transcripts(&[("a", f64::NEG_INFINITY), ("b", 5.0)]),
            case("nan-csv-and-codex")
                .csv(f64::NAN, true)
                .transcripts(&[("a", 5.0)])
                .codex(&[f64::NAN]),
            case("empty-sid-inactive").transcripts(&[("", age(10.0))]),
            case("zero-csv-with-stale-state")
                .csv(0.0, true)
                .state(&[("s", age(5_000.0))]),
        ]
    }

    fn js_number(value: f64) -> String {
        if value.is_nan() {
            "NaN".to_owned()
        } else if value == f64::INFINITY {
            "Infinity".to_owned()
        } else if value == f64::NEG_INFINITY {
            "-Infinity".to_owned()
        } else {
            format!("{value}")
        }
    }

    // The oracle encodes an empty sid as "~" so whitespace-separated records stay parseable.
    fn sid_token(sid: &str) -> &str {
        if sid.is_empty() { "~" } else { sid }
    }

    fn cases_text(cases: &[Case]) -> String {
        let mut text = String::new();
        for case in cases {
            text.push_str(&format!(
                "CASE {}\nNOWMS {}\nCSV {}\nCSV_EXISTS {}\n",
                case.name,
                js_number(case.now_ms),
                js_number(case.csv_mtime_s),
                u8::from(case.csv_exists),
            ));
            for (sid, mtime) in &case.transcripts {
                text.push_str(&format!("T {} {}\n", sid_token(sid), js_number(*mtime)));
            }
            for (sid, mtime) in &case.state_files {
                text.push_str(&format!("S {} {}\n", sid_token(sid), js_number(*mtime)));
            }
            for mtime in &case.codex_mtimes {
                text.push_str(&format!("X {}\n", js_number(*mtime)));
            }
        }
        text
    }

    fn run_node_oracle(cases: &str) -> String {
        let binary = std::env::var_os("NODE_BINARY")
            .expect("NODE_BINARY must name an absolute Node executable for the parity test");
        let binary = Path::new(&binary);
        assert!(binary.is_absolute(), "NODE_BINARY must be absolute");
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let oracle = manifest.join("tests/usage_report_freshness_oracle.mjs");
        let temp = std::env::temp_dir().join(format!(
            "usage-report-freshness-oracle-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp).unwrap();
        let cases_file = temp.join("cases.txt");
        std::fs::write(&cases_file, cases).unwrap();
        let mut command = Command::new(binary);
        command.arg(oracle).arg(&cases_file).env_clear();
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
        let output = command.output().expect("launch source-bound Node oracle");
        assert!(
            output.status.success(),
            "Node oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn rust_freshness_matches_source_bound_node_oracle() {
        let cases = cases();
        let output = run_node_oracle(&cases_text(&cases));
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines.len(), cases.len(), "oracle case count");
        for (case, line) in cases.iter().zip(lines) {
            let fields: Vec<&str> = line.split('\t').collect();
            assert_eq!(fields.len(), 3, "oracle line shape: {line}");
            assert_eq!(fields[0], case.name, "oracle case order");
            let input = FreshnessInput {
                now_s: case.now_ms / 1000.0,
                csv_mtime_s: case.csv_mtime_s,
                transcripts: &case.transcripts,
                state_files: &case.state_files,
                codex_mtimes: &case.codex_mtimes,
            };
            let decision = decide_freshness(&input);
            assert_eq!(
                fields[1],
                decision.active_sid.as_deref().unwrap_or("<none>"),
                "{} active",
                case.name
            );
            assert_eq!(
                fields[2],
                if decision.needs_rebuild { "1" } else { "0" },
                "{} rebuild",
                case.name
            );
        }
    }
}
