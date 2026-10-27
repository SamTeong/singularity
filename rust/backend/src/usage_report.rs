use crate::models::js_trim;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub reports_dir: String,
    #[serde(default)]
    pub skill_path: Option<String>,
    #[serde(default)]
    pub env: Value,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Status {
    pub exists: bool,
    pub at: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Report {
    pub html: Option<String>,
}

fn latest_file(reports_dir: &Path) -> Option<PathBuf> {
    let mut names = fs::read_dir(reports_dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            (name.starts_with("report-") && name.ends_with(".html")).then_some(name)
        })
        .collect::<Vec<_>>();
    names.sort_by(|a, b| b.encode_utf16().cmp(a.encode_utf16()));
    names.into_iter().next().map(|name| reports_dir.join(name))
}

fn mtime_ms(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -error.duration().as_secs_f64() * 1000.0,
    })
}

pub fn status(request: &Request) -> Status {
    match latest_file(Path::new(&request.reports_dir)).and_then(|path| mtime_ms(&path)) {
        Some(at) => Status {
            exists: true,
            at: Some(at),
        },
        None => Status {
            exists: false,
            at: None,
        },
    }
}

pub fn read(request: &Request) -> Report {
    let html = latest_file(Path::new(&request.reports_dir))
        .and_then(|path| fs::read(path).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
    Report { html }
}

pub fn generate<F>(request: &Request, mut run: F) -> Value
where
    F: FnMut(&str, &[String], f64, f64, &Value) -> Value,
{
    let Some(skill_path) = request.skill_path.as_deref() else {
        return json!({"ok": false, "error": "usage-report skill not found: undefined"});
    };
    if !Path::new(skill_path).exists() {
        return json!({"ok": false, "error": format!("usage-report skill not found: {skill_path}")});
    }
    let args = vec![skill_path.to_owned(), "report".to_owned()];
    let mut env = request.env.clone();
    if !env.is_object() {
        env = json!({});
    }
    env["USAGE_REPORT_BROWSER"] = json!("node");
    let result = run("node", &args, 180_000.0, 16.0 * 1024.0 * 1024.0, &env);
    if result["ok"] != true {
        let argv = format!("node {} report", skill_path);
        let error = if result["timed_out"] == true {
            format!("Command timed out after 180000ms: {argv}")
        } else {
            let tail = js_trim(
                js_trim(result["stderr"].as_str().unwrap_or(""))
                    .rsplit('\n')
                    .next()
                    .unwrap_or(""),
            );
            if tail.is_empty() {
                format!("Command failed: {argv}")
            } else {
                format!("Command failed: {argv}\n{tail}")
            }
        };
        return json!({"ok": false, "error": error});
    }
    let stdout = js_trim(result["stdout"].as_str().unwrap_or(""));
    let last = js_trim(stdout.rsplit('\n').next().unwrap_or(""));
    let report = Path::new(last);
    if !last.ends_with(".html") || !report.exists() {
        return json!({"ok": false, "error": "report path not found in skill output"});
    }
    json!({"ok": true, "at": mtime_ms(report)})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "usage-report-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        create_dir_all(&path).unwrap();
        path
    }

    fn request(path: &Path) -> Request {
        Request {
            reports_dir: path.to_string_lossy().into_owned(),
            skill_path: None,
            env: json!({"EXISTING": "yes"}),
        }
    }

    #[test]
    fn selects_descending_utf16_filename_and_reads_utf8_with_replacement() {
        let dir = temp_dir();
        write(dir.join("report-a.html"), "older").unwrap();
        write(dir.join("report-z.html"), [b'<', 0xff, b'>']).unwrap();
        write(dir.join("other.html"), "ignored").unwrap();
        let request = request(&dir);
        assert_eq!(read(&request).html.as_deref(), Some("<�>"));
        assert!(status(&request).exists);
    }

    #[test]
    fn missing_directory_and_empty_matching_name_are_handled() {
        let missing = request(&temp_dir().join("missing"));
        assert_eq!(
            status(&missing),
            Status {
                exists: false,
                at: None
            }
        );
        let dir = temp_dir();
        write(dir.join("report-.html"), "empty name suffix").unwrap();
        assert_eq!(
            read(&request(&dir)).html.as_deref(),
            Some("empty name suffix")
        );
    }

    #[test]
    fn generation_preserves_runner_options_and_reads_last_stdout_line() {
        let dir = temp_dir();
        let skill = dir.join("stats.mjs");
        let report = dir.join("report-ü.html");
        write(&skill, "").unwrap();
        write(&report, "html").unwrap();
        let mut request = request(&dir);
        request.skill_path = Some(skill.to_string_lossy().into_owned());
        let result = generate(&request, |bin, args, timeout, cap, env| {
            assert_eq!(bin, "node");
            assert_eq!(
                args,
                &[skill.to_string_lossy().into_owned(), "report".into()]
            );
            assert_eq!(timeout, 180_000.0);
            assert_eq!(cap, 16.0 * 1024.0 * 1024.0);
            assert_eq!(env["EXISTING"], "yes");
            assert_eq!(env["USAGE_REPORT_BROWSER"], "node");
            json!({"ok": true, "stdout": format!("notice\n\u{feff}{}\n", report.display())})
        });
        assert_eq!(result["ok"], true);
        let nel = generate(
            &request,
            |_, _, _, _, _| json!({"ok": true, "stdout": format!("{}\u{0085}", report.display())}),
        );
        assert_eq!(nel["error"], "report path not found in skill output");
    }

    #[test]
    fn generation_reports_missing_skill_and_invalid_output() {
        let dir = temp_dir();
        let mut request = request(&dir);
        request.skill_path = Some(dir.join("missing.mjs").to_string_lossy().into_owned());
        assert_eq!(
            generate(&request, |_, _, _, _, _| unreachable!())["error"],
            format!(
                "usage-report skill not found: {}",
                request.skill_path.as_deref().unwrap()
            )
        );
        let skill = dir.join("stats.mjs");
        write(&skill, "").unwrap();
        request.skill_path = Some(skill.to_string_lossy().into_owned());
        assert_eq!(
            generate(
                &request,
                |_, _, _, _, _| json!({"ok": true, "stdout": "no path"})
            )["error"],
            "report path not found in skill output"
        );
    }

    #[test]
    fn generation_maps_timeout_and_process_failure_messages() {
        let dir = temp_dir();
        let skill = dir.join("stats.mjs");
        write(&skill, "").unwrap();
        let mut request = request(&dir);
        request.skill_path = Some(skill.to_string_lossy().into_owned());
        let timed_out = generate(
            &request,
            |_, _, _, _, _| json!({"ok": false, "timed_out": true, "stderr": "timeout"}),
        );
        assert_eq!(
            timed_out["error"],
            format!(
                "Command timed out after 180000ms: node {} report",
                skill.display()
            )
        );
        let failed = generate(
            &request,
            |_, _, _, _, _| json!({"ok": false, "stderr": "first line\nrenderer failed\n"}),
        );
        assert_eq!(
            failed["error"],
            format!(
                "Command failed: node {} report\nrenderer failed",
                skill.display()
            )
        );
    }

    // Contract pin (usage_report.rs:73-75): absent skill_path short-circuits before
    // the runner with the JS `undefined` wording. The set-but-missing path wording at
    // :76-78 is already pinned by generation_reports_missing_skill_and_invalid_output.
    #[test]
    fn generation_pins_absent_skill_path_error_without_spawning() {
        let dir = temp_dir();
        let result = generate(&request(&dir), |_, _, _, _, _| {
            unreachable!("runner must not run for absent skill_path")
        });
        assert_eq!(
            result,
            json!({"ok": false, "error": "usage-report skill not found: undefined"})
        );
        remove_dir_all(&dir).ok();
    }

    // Contract pin (usage_report.rs:105-111): any existing .html printed on the last
    // stdout line is accepted even outside reports_dir; status/read keep scanning
    // reports_dir only, so the next read can miss the generated report.
    #[test]
    fn generation_accepts_printed_report_outside_reports_dir() {
        let reports = temp_dir();
        let outside = temp_dir();
        let skill = outside.join("stats.mjs");
        let report = outside.join("report-outside.html");
        write(&skill, "").unwrap();
        write(&report, "html").unwrap();
        let mut request = request(&reports);
        request.skill_path = Some(skill.to_string_lossy().into_owned());
        let result = generate(
            &request,
            |_, _, _, _, _| json!({"ok": true, "stdout": report.display().to_string()}),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["at"].as_f64(), mtime_ms(&report));
        assert_eq!(
            status(&request),
            Status {
                exists: false,
                at: None
            }
        );
        assert_eq!(read(&request).html, None);
        remove_dir_all(&reports).ok();
        remove_dir_all(&outside).ok();
    }

    // Contract pin (stats.mjs:17,55-56): USAGE_REPORT_STATE relocates the skill's
    // reports beside the state dir while the caller keeps reading its own
    // reports_dir, so generate succeeds and status/read miss the new report.
    #[test]
    fn generation_accepts_state_derived_reports_dir_diverging_from_reports_dir() {
        let root = temp_dir();
        let state = root.join("state");
        let state_reports = root.join("reports"); // dirname(state)/reports, stats.mjs:56
        let configured = root.join("configured-reports");
        create_dir_all(&state).unwrap();
        create_dir_all(&state_reports).unwrap();
        create_dir_all(&configured).unwrap();
        let skill = root.join("stats.mjs");
        let report = state_reports.join("report-state.html");
        write(&skill, "").unwrap();
        write(&report, "html").unwrap();
        let mut request = request(&configured);
        request.skill_path = Some(skill.to_string_lossy().into_owned());
        let result = generate(
            &request,
            |_, _, _, _, _| json!({"ok": true, "stdout": report.display().to_string()}),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["at"].as_f64(), mtime_ms(&report));
        assert_eq!(
            status(&request),
            Status {
                exists: false,
                at: None
            }
        );
        assert_eq!(read(&request).html, None);
        remove_dir_all(&root).ok();
    }
}
