use serde_json::{Value, json};
use singularity_backend::usage_report_forecast::{
    CalibrationSession, CompletedWindow, ForecastConfig, ForecastInput, JsRng, Snapshot,
    calibrate_sigma_session_default, fit_prior, run_forecast,
};
use std::io::Write;
use std::process::{Command, Stdio};

fn assert_equivalent(js: &Value, rust: &Value, path: &str) {
    match (js, rust) {
        (Value::Object(js), Value::Object(rust)) => {
            let mut js_keys: Vec<_> = js.keys().collect();
            let mut rust_keys: Vec<_> = rust.keys().collect();
            js_keys.sort();
            rust_keys.sort();
            assert_eq!(js_keys, rust_keys, "object keys differ at {path}");
            for key in js.keys() {
                assert_equivalent(&js[key], &rust[key], &format!("{path}.{key}"));
            }
        }
        (Value::Array(js), Value::Array(rust)) => {
            assert_eq!(js.len(), rust.len(), "array length differs at {path}");
            for (index, (left, right)) in js.iter().zip(rust).enumerate() {
                assert_equivalent(left, right, &format!("{path}[{index}]"));
            }
        }
        (Value::Number(js), Value::Number(rust)) => {
            let left = js.as_f64().unwrap();
            let right = rust.as_f64().unwrap();
            let (abs, rel) = if path.starts_with("$.calibration") || path.starts_with("$.prior") {
                (1e-12, 1e-12)
            } else {
                // Design allows accumulated libm noise for seeded MC transforms.
                (1e-12, 1e-10)
            };
            assert!(
                (left - right).abs() <= abs + rel * left.abs().max(right.abs()),
                "numeric mismatch at {path}: JS={left:?}, Rust={right:?}"
            );
        }
        _ => assert_eq!(js, rust, "branch/type/value differs at {path}"),
    }
}

#[test]
fn compares_populated_forecast_against_the_bundled_js_source() {
    let prior_sessions = vec![
        CompletedWindow {
            reset_sec: 1_000.0,
            duration_hours: 1.0,
            u_final: 4.0,
        },
        CompletedWindow {
            reset_sec: 2_000.0,
            duration_hours: 2.0,
            u_final: 12.0,
        },
        CompletedWindow {
            reset_sec: 3_000.0,
            duration_hours: 0.0,
            u_final: 999.0,
        },
    ];
    let sigma_session_sq = 0.35;
    let variance_eps = 1e-6;
    let prior = fit_prior(&prior_sessions, sigma_session_sq, variance_eps).unwrap();
    let config = ForecastConfig {
        tau_recent_sec: 1800.0,
        mc_traj: 24,
        mc_step_sec: 300.0,
        variance_eps,
    };
    let calibration_sessions = vec![
        CalibrationSession {
            reset_sec: 30_000.0,
            duration_hours: 8.0,
            u_final: 72.0,
            snapshots: (0..25)
                .map(|i| Snapshot {
                    t: 1_000.0 + f64::from(i) * 1_000.0,
                    u: f64::from(i) * 2.2,
                })
                .collect(),
        },
        CalibrationSession {
            reset_sec: 40_000.0,
            duration_hours: 8.0,
            u_final: 88.0,
            snapshots: (0..35)
                .map(|i| Snapshot {
                    t: 2_000.0 + f64::from(i) * 1_000.0,
                    u: f64::from(i) * 1.8,
                })
                .collect(),
        },
    ];
    let calibration = calibrate_sigma_session_default(&calibration_sessions, prior, config);
    let now_sec = 10_000.0;
    let forecast_input = ForecastInput {
        now_sec,
        reset_sec: 22_000.0,
        u_now: 20.0,
        snapshots: vec![
            Snapshot { t: 7_900.0, u: 9.0 },
            Snapshot {
                t: 8_200.0,
                u: 11.0,
            },
            Snapshot {
                t: 9_100.0,
                u: 15.5,
            },
            Snapshot {
                t: 9_700.0,
                u: 19.0,
            },
            Snapshot {
                t: 9_900.0,
                u: 20.0,
            },
        ],
        prior,
        calibration,
        thresholds: vec![20.0, 20.5, 80.25, 35.75, 1_000.0],
    };
    let boundary_snapshots = vec![
        Snapshot {
            t: 8_199.0,
            u: 10.0,
        },
        Snapshot {
            t: 8_200.0,
            u: 12.0,
        },
        Snapshot {
            t: 9_000.0,
            u: 30.0,
        },
        Snapshot { t: 9_100.0, u: 4.0 },
        Snapshot {
            t: 10_001.0,
            u: 2.0,
        },
    ];

    let fixture = json!({
        "priorSessions": prior_sessions.iter().map(|s| json!({"uFinal":s.u_final,"durationHours":s.duration_hours})).collect::<Vec<_>>(),
        "sigmaSessionSq": sigma_session_sq,
        "varianceEps": variance_eps,
        "prior": {"mu0":prior.mu0,"tau0Sq":prior.tau0_sq,"nSessions":prior.n_sessions},
        "config": {"tauRecentSec":config.tau_recent_sec,"mcTraj":config.mc_traj,"mcStepSec":config.mc_step_sec,"varianceEps":config.variance_eps},
        "forecastsPerSession": 6,
        "minHorizonSec": 1800.0,
        "calibrationSessions": calibration_sessions.iter().map(|s| json!({
            "resetSec":s.reset_sec,"durationHours":s.duration_hours,"uFinal":s.u_final,
            "snapshots":s.snapshots.iter().map(|p| json!({"t":p.t,"u":p.u})).collect::<Vec<_>>()
        })).collect::<Vec<_>>(),
        "forecastInput": {
            "nowSec":forecast_input.now_sec,"resetSec":forecast_input.reset_sec,"uNow":forecast_input.u_now,
            "snapshots":forecast_input.snapshots.iter().map(|p| json!({"t":p.t,"u":p.u})).collect::<Vec<_>>(),
            "prior":{"mu0":prior.mu0,"tau0Sq":prior.tau0_sq,"nSessions":prior.n_sessions},
            "calibration":{"sigmaSessionSq":calibration.sigma_session_sq,"barTauSq":calibration.bar_tau_sq},
            "thresholds":forecast_input.thresholds,
        },
        "boundarySnapshots": boundary_snapshots.iter().map(|p| json!({"t":p.t,"u":p.u})).collect::<Vec<_>>(),
        "nowSec": now_sec,
    });

    let mut rng = JsRng::new(0);
    let mut default_rng = JsRng::new(0);
    let falsy_config = ForecastConfig {
        tau_recent_sec: 0.0,
        mc_traj: 0,
        mc_step_sec: 0.0,
        variance_eps: 0.0,
    };
    let rust = json!({
        "prior": {"mu0":prior.mu0,"tau0Sq":prior.tau0_sq,"nSessions":prior.n_sessions,"ok":true},
        "calibration":{"sigmaSessionSq":calibration.sigma_session_sq,"barTauSq":calibration.bar_tau_sq},
        "forecast":run_forecast(&forecast_input, config, &mut rng),
        "defaultedForecast":run_forecast(&forecast_input, falsy_config, &mut default_rng),
        "recent":singularity_backend::usage_report_forecast::filter_recent(&boundary_snapshots, now_sec, config.tau_recent_sec)
            .iter().map(|p| json!({"t":p.t,"u":p.u})).collect::<Vec<_>>(),
        "ineligible":run_forecast(&ForecastInput { reset_sec: now_sec, ..forecast_input.clone() }, config, &mut JsRng::new(1)),
        "nonfinite":[serde_json::to_value(f64::NAN).unwrap(),serde_json::to_value(f64::INFINITY).unwrap(),serde_json::to_value(f64::NEG_INFINITY).unwrap()],
    });

    let node = std::path::PathBuf::from(
        std::env::var_os("NODE_BINARY")
            .expect("NODE_BINARY must be an absolute Node executable path"),
    );
    assert!(
        node.is_absolute(),
        "NODE_BINARY must be an absolute Node executable path"
    );
    let bridge = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/usage_report_forecast_oracle.mjs");
    let cwd = std::env::temp_dir().join(format!(
        "singularity-forecast-oracle-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&cwd).expect("create synthetic cwd");
    let synthetic = [
        ("HOME", "home"),
        ("USERPROFILE", "profile"),
        ("APPDATA", "appdata"),
        ("LOCALAPPDATA", "localappdata"),
        ("TEMP", "temp"),
        ("TMP", "tmp"),
        ("TMPDIR", "tmpdir"),
    ]
    .map(|(name, directory)| {
        let path = cwd.join(directory);
        std::fs::create_dir_all(&path).expect("create synthetic Node home");
        (name, path)
    });
    let mut command = Command::new(node);
    command
        .arg(bridge)
        .current_dir(&cwd)
        .env_clear()
        .env("FORECAST_ORACLE_BRIDGE", "1");
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
        .expect("launch absolute Node binary");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(fixture.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().expect("wait for Node oracle");
    assert!(
        output.status.success(),
        "Node oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let js: Value = serde_json::from_slice(&output.stdout).expect("parse Node oracle result");
    assert_equivalent(&js, &rust, "$");
}
