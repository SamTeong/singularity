use serde::Deserialize;
use serde_json::value::RawValue;
use singularity_backend::usage_report_render::{ReportPayload, render_html};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Deserialize)]
struct Fixture {
    sessions: Vec<Box<RawValue>>,
    forecast: Option<Box<RawValue>>,
    roadmap: Option<Box<RawValue>>,
    generated_local: String,
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

#[test]
fn renders_every_fixture_like_the_bundled_javascript_renderer() {
    let tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let fixture_dir = tests.join("fixtures/render-oracle");
    let scratch = std::env::temp_dir().join(format!("usage-render-oracle-{}", std::process::id()));
    let _ = fs::remove_dir_all(&scratch);
    fs::create_dir_all(&scratch).expect("create render oracle scratch dir");

    let mut fixtures: Vec<PathBuf> = fs::read_dir(&fixture_dir)
        .expect("read render fixtures")
        .map(|entry| entry.expect("read render fixture entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    fixtures.sort();
    assert!(
        fixtures.len() >= 3,
        "expected at least three render fixtures"
    );
    for path in &fixtures {
        let fixture: Fixture =
            serde_json::from_slice(&fs::read(path).expect("read render fixture"))
                .expect("parse render fixture");
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let payload = ReportPayload {
            sessions: &fixture.sessions,
            forecast: fixture.forecast.as_deref(),
            roadmap: fixture.roadmap.as_deref(),
            generated_local: &fixture.generated_local,
        };
        match render_html(&payload) {
            Ok(html) => fs::write(scratch.join(format!("{name}.html")), html),
            Err(error) => fs::write(scratch.join(format!("{name}.error")), error.to_string()),
        }
        .expect("write native render result");
    }

    let output = Command::new(node_path())
        .arg(tests.join("usage_report_render_oracle.mjs"))
        .arg(&scratch)
        .output()
        .expect("run the bundled renderer oracle");
    assert!(
        output.status.success(),
        "render oracle failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        stdout.lines().count(),
        fixtures.len(),
        "oracle must compare every fixture:\n{stdout}"
    );
    fs::remove_dir_all(&scratch).expect("remove render oracle scratch dir");
}
