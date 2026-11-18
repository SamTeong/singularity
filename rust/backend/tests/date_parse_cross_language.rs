//! Differential oracle: `parse_date_ms` vs V8's `Date.parse` on Node.
//! V8's `-000000` legacy rule is version-pinned, so the exact Node version is checked.
use serde_json::{Value, json};
use singularity_backend::usage_snapshot::parse_date_ms;
use std::path::{Path, PathBuf};
use std::process::Command;

const NODE_VERSION: &str = "v24.19.0";

// VERIFY: wave17-date-2
fn node_binary() -> PathBuf {
    let node = PathBuf::from(
        std::env::var_os("NODE_BINARY")
            .expect("NODE_BINARY must be an absolute Node executable path"),
    );
    assert!(
        node.is_absolute(),
        "NODE_BINARY must be an absolute Node executable path"
    );
    assert!(
        node.is_file(),
        "wave17 date oracle needs Node {NODE_VERSION} at {}",
        node.display()
    );
    node
}

/// One oracle row: V8's `Date.parse` value and, for a real instant, the host
/// zone offset Node used at that instant (minutes, JS sign convention).
struct Report {
    value: Option<i64>,
    offset_min: Option<i64>,
}

// VERIFY: wave15-date-5
fn oracle(inputs: &[&str]) -> Vec<Report> {
    let node = node_binary();
    let bridge = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/date_parse_cross_language.mjs");
    // Zone parity: the Rust side honours `TZ` through its bundled tz data, so
    // the child must see the same `TZ`. Unset on both sides means the same OS
    // zone, which is what the host-relative vectors below rely on.
    // VERIFY: wave21-date-4
    let output = Command::new(node)
        .arg(bridge)
        .arg(json!(inputs).to_string())
        .output()
        .expect("run the Node oracle");
    assert!(
        output.status.success(),
        "Node oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value =
        serde_json::from_slice(&output.stdout).expect("parse the Node oracle result");
    assert_eq!(
        report["version"].as_str(),
        Some(NODE_VERSION),
        "wave15 date oracle pins V8 behavior; expected Node {NODE_VERSION}"
    );
    report["results"]
        .as_array()
        .expect("results array")
        .iter()
        .map(|row| Report {
            value: row["value"].as_i64(),
            offset_min: row["offsetMin"].as_i64(),
        })
        .collect()
}

fn compare(inputs: &[&str]) {
    let expected = oracle(inputs);
    assert_eq!(expected.len(), inputs.len(), "oracle vector count");
    let mismatched = inputs
        .iter()
        .zip(&expected)
        .filter(|(input, want)| parse_date_ms(input) != want.value)
        .map(|(input, want)| {
            format!(
                "{input:?}: rust={:?} node={:?}",
                parse_date_ms(input),
                want.value
            )
        })
        .collect::<Vec<_>>();
    assert!(
        mismatched.is_empty(),
        "Date.parse mismatches:\n{}",
        mismatched.join("\n")
    );
}

#[test]
fn exact_vectors_match_node() {
    compare(&[
        "-000000-01-01T00:00:00",
        "-000001-01-01",
        "-000001-01-01T00:00:00Z",
        "+000000-01-01",
        "-000100-01-01",
        "+275760-09-13T00:00:00.001Z",
        "+275760-09-14T00:00:00Z",
        "-271821-04-20T00:00:00Z",
        "-271821-04-19T00:00:00Z",
    ]);
}

#[test]
fn host_local_vectors_match_node() {
    compare(&[
        "-000000-01-01",
        "-000000-01-01 00:00:00",
        "000000-01-01",
        "+010000-01-01T00:00:00",
        // Bare month.day goes through the local-midnight branch on both sides.
        "1.5",
    ]);
}

/// V8 reads a bare numeric year/month as *local* midnight; the Rust digit path
/// returns the UTC start of the same date. The values differ by the host zone
/// offset, so no single literal is honest on every host: assert the exact
/// relationship per row and print the divergence instead of hiding it.
// VERIFY: wave17-date-3
#[test]
fn legacy_numeric_rows_diverge_from_node_by_the_local_offset() {
    let inputs = [
        "0", "1", "12", "49", "50", "99", "123456", "-1", "-50", "10000",
    ];
    let reports = oracle(&inputs);
    assert_eq!(reports.len(), inputs.len(), "oracle vector count");
    for (input, report) in inputs.iter().zip(&reports) {
        let node = report
            .value
            .unwrap_or_else(|| panic!("V8 accepts legacy numeric input {input}"));
        let offset_min = report
            .offset_min
            .unwrap_or_else(|| panic!("Node zone offset at {input}"));
        let rust = parse_date_ms(input)
            .unwrap_or_else(|| panic!("Rust accepts legacy numeric input {input}"));
        assert_eq!(
            rust - node,
            -offset_min * 60_000,
            "divergence for {input:?} is not the local offset: rust={rust} node={node} offsetMin={offset_min}"
        );
        println!(
            "DIVERGENCE {input:?}: rust={rust} (UTC start) node={node} (local midnight) offsetMin={offset_min}"
        );
    }
}

/// Zone-pinned vectors. V8 and the Rust parser must resolve each civil time
/// with the same zone database, so every row runs under an explicit `TZ` that
/// is identical on both sides and independent of the host's own zone.
///
/// The gap/fold rows are the `Disambiguation::Compatible` contract: V8 applies
/// the offset in effect immediately before the transition in both directions,
/// which is exactly what Jiff's `Compatible` resolves to.
const ZONE_VECTORS: &[(&str, &[&str])] = &[
    (
        "Asia/Singapore",
        &[
            // LMT +06:55:25 until 1901; +07:30 1945-1981; +08:00 from 1982.
            "-000001-01-01T00:00:00",
            "0000-01-01T00:00:00",
            "1601-01-01T00:00:00",
            "1900-01-01T00:00:00",
            "1950-01-01T00:00:00",
            "1981-12-31T00:00:00",
            "1982-01-01T00:00:00",
            // Expanded years exercise the equivalent-year mapping onto Jiff's
            // civil range in both directions.
            "+010000-01-01T00:00:00",
            "+123456-06-15T12:34:56",
            "-010000-06-15T00:00:00",
        ],
    ),
    (
        "America/New_York",
        &[
            "2021-03-14T02:30:00", // spring-forward gap
            "2021-11-07T01:30:00", // autumn fold
            "+010000-01-01T12:00:00",
            "+010000-07-01T12:00:00",
            "-010000-01-01T12:00:00",
        ],
    ),
    (
        "Europe/London",
        &[
            "2021-03-28T01:30:00", // spring-forward gap
            "2021-10-31T01:30:00", // autumn fold
            "+010000-01-01T12:00:00",
            "+010000-07-01T12:00:00",
        ],
    ),
];

const ZONE_CHILD_ENV: &str = "SINGULARITY_DATE_TZ_CHILD";

/// Exact `Date.parse` values measured with the pinned Node above while each
/// zone was pinned in `TZ`. They document the offset history the Rust side must
/// reproduce without needing Node at hand, while `compare` keeps checking the
/// live oracle for the same rows.
const ZONE_LITERALS: &[(&str, &str, i64)] = &[
    // Asia/Singapore: LMT +06:55:25 until 1901, +07:30 from 1945, +08:00 from
    // 1982-01-01. The expanded years prove the equivalent-year mapping onto
    // Jiff's -9999..=9999 civil range in both directions.
    (
        "Asia/Singapore",
        "-000001-01-01T00:00:00",
        -62_198_780_125_000,
    ),
    ("Asia/Singapore", "0000-01-01T00:00:00", -62_167_244_125_000),
    ("Asia/Singapore", "1601-01-01T00:00:00", -11_644_498_525_000),
    ("Asia/Singapore", "1900-01-01T00:00:00", -2_209_013_725_000),
    ("Asia/Singapore", "1950-01-01T00:00:00", -631_179_000_000),
    ("Asia/Singapore", "1981-12-31T00:00:00", 378_577_800_000),
    ("Asia/Singapore", "1982-01-01T00:00:00", 378_662_400_000),
    (
        "Asia/Singapore",
        "+010000-01-01T00:00:00",
        253_402_272_000_000,
    ),
    (
        "Asia/Singapore",
        "+123456-06-15T12:34:56",
        3_833_742_198_896_000,
    ),
    (
        "Asia/Singapore",
        "-010000-06-15T00:00:00",
        -377_722_421_725_000,
    ),
    // America/New_York: gap takes the pre-transition EST offset (07:30Z), fold
    // the pre-transition EDT offset (05:30Z).
    ("America/New_York", "2021-03-14T02:30:00", 1_615_707_000_000),
    ("America/New_York", "2021-11-07T01:30:00", 1_636_263_000_000),
    (
        "America/New_York",
        "+010000-01-01T12:00:00",
        253_402_362_000_000,
    ),
    (
        "America/New_York",
        "+010000-07-01T12:00:00",
        253_418_083_200_000,
    ),
    // Europe/London: gap 01:30Z (GMT, before the jump), fold 00:30Z (BST, the
    // first of the repeated hours).
    ("Europe/London", "2021-03-28T01:30:00", 1_616_895_000_000),
    ("Europe/London", "2021-10-31T01:30:00", 1_635_640_200_000),
];

fn run_zone_child(zone: &str) {
    let exe = std::env::current_exe().expect("current test executable");
    let output = Command::new(exe)
        .arg("historical_local_offsets_match_node")
        .arg("--exact")
        .arg("--nocapture")
        .env("TZ", zone)
        .env(ZONE_CHILD_ENV, zone)
        .output()
        .expect("spawn the pinned-zone child");
    assert!(
        output.status.success(),
        "TZ={zone} oracle failed:\n--- stdout ---\n{}\n--- stderr ---\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Historical and transition local offsets need bundled tz data on every
/// platform; each pinned zone runs in its own child process so the zone is set
/// once for the whole process instead of racing the test threads.
// VERIFY: wave21-date-3
#[test]
fn historical_local_offsets_match_node() {
    if let Ok(zone) = std::env::var(ZONE_CHILD_ENV) {
        let (_, inputs) = ZONE_VECTORS
            .iter()
            .find(|(name, _)| *name == zone)
            .unwrap_or_else(|| panic!("unknown pinned zone {zone}"));
        compare(inputs);
        for (row_zone, input, want) in ZONE_LITERALS.iter().filter(|(name, _, _)| *name == zone) {
            assert_eq!(
                parse_date_ms(input),
                Some(*want),
                "TZ={row_zone} Date.parse({input:?})"
            );
        }
        return;
    }
    for (zone, _) in ZONE_VECTORS {
        run_zone_child(zone);
    }
}
