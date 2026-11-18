use serde::Deserialize;
use serde_json::value::RawValue;
use std::{env, fs, process};

#[derive(Deserialize)]
struct Fixture {
    sessions: Vec<Box<RawValue>>,
    forecast: Option<Box<RawValue>>,
    roadmap: Option<Box<RawValue>>,
    generated_local: String,
}

fn main() {
    let Some(path) = env::args_os().nth(1) else {
        eprintln!("usage: usage_report_render_fixture <fixture.json>");
        process::exit(64);
    };
    let bytes = fs::read(path).expect("read fixture input");
    let fixture: Fixture = serde_json::from_slice(&bytes).expect("parse fixture input");
    let payload = singularity_backend::usage_report_render::ReportPayload {
        sessions: &fixture.sessions,
        forecast: fixture.forecast.as_deref(),
        roadmap: fixture.roadmap.as_deref(),
        generated_local: &fixture.generated_local,
    };
    match singularity_backend::usage_report_render::render_html(&payload) {
        Ok(html) => print!("{html}"),
        Err(error) => {
            eprintln!("render error: {error}");
            process::exit(2);
        }
    }
}
