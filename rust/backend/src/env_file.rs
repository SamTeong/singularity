//! Native `.env` loading and fail-fast environment validation.
//!
//! Mirrors the load Node performs with `--env-file-if-exists=.env`
//! (`package.json:11`; the same parser is exposed as `util.parseEnv` and used at
//! `scripts/env-port.mjs:13`), the aggregated `requireEnv()` at
//! `server/index.mjs:75-90`, and the `SINGULARITY_HOME` check at
//! `server/app-dir.mjs:13-16`.
//!
//! Everything here is pure over injected data: [`load_env_file`] writes into the
//! caller's map and never touches `std::env`, so a caller decides what the process
//! environment is. A daemon that wants the real one builds it with [`process_env`].

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::Path;

/// `server/index.mjs:87` — the aggregated failure, verbatim.
const REQUIRED_ENV_HEADER: &str =
    "Required env vars missing — copy .env.example → .env and fill them in:";

const DAEMON_PORT_HINT: &str = "DAEMON_PORT (listen port, e.g. 4317)";
const CLAUDE_BIN_HINT: &str = "CLAUDE_BIN (absolute path to claude exe)";
const SING_TOKEN_HINT: &str = "SING_TOKEN (set but contains characters outside [A-Za-z0-9_-])";

/// Whether the `.env` file was there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvFileLoad {
    Loaded,
    Missing,
}

impl EnvFileLoad {
    /// Node's stderr line when `--env-file-if-exists` finds nothing
    /// (`<path> not found. Continuing without it.`), `None` when the file loaded.
    pub fn notice(&self, path: &Path) -> Option<String> {
        match self {
            Self::Loaded => None,
            Self::Missing => Some(format!(
                "{} not found. Continuing without it.",
                path.display()
            )),
        }
    }
}

/// The live environment without mutating it (edition 2024 makes `set_var` unsafe,
/// and tests must never touch the real environment).
pub fn process_env() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

/// Parses `.env` content exactly as Node's `--env-file`/`util.parseEnv` parser does
/// (Node 22.13+/24 `src/node_dotenv.cc`); every rule below was checked against a
/// live `util.parseEnv` run:
///
/// - `\r` is removed everywhere before parsing (`A=foo\rbar` → `foobar`);
/// - blank lines and lines whose first non-blank byte is `#` are skipped;
/// - one lowercase `export ` prefix is stripped, then further spaces/tabs;
/// - the key runs to the first `=` and is trimmed; a line without `=` is skipped;
/// - a value that begins at end-of-line is empty; otherwise leading whitespace —
///   newlines included — is skipped first, so `A= \nB=1` yields `A="B=1"`;
/// - `#` ends an unquoted value, which is then right-trimmed;
/// - `"…"` expands `\n` (that escape only) and `'…'` is literal; the closing quote is
///   searched forward across newlines, and with none the raw rest of the line
///   (opening quote included) becomes the value;
/// - text after a closing quote is discarded to end of line;
/// - an empty key assigns nothing and scanning resumes just after its `=`.
///
/// Pairs come back in file order, duplicates included — Node's object keeps the
/// last one, and [`load_env_file`] applies that.
pub fn parse_env(content: &str) -> Vec<(String, String)> {
    let content = content.replace('\r', "");
    let bytes = content.as_bytes();
    let mut pairs = Vec::new();
    let mut pos = 0;
    while pos < bytes.len() {
        while pos < bytes.len() && is_space(bytes[pos]) {
            pos += 1;
        }
        if pos >= bytes.len() {
            break;
        }
        if bytes[pos] == b'#' {
            pos = skip_line(bytes, pos);
            continue;
        }
        if content[pos..].starts_with("export ") {
            pos += "export ".len();
            while pos < bytes.len() && matches!(bytes[pos], b' ' | b'\t') {
                pos += 1;
            }
        }
        let key_start = pos;
        while pos < bytes.len() && bytes[pos] != b'=' && bytes[pos] != b'\n' {
            pos += 1;
        }
        if pos >= bytes.len() {
            break;
        }
        if bytes[pos] == b'\n' {
            pos += 1;
            continue;
        }
        let key = trim(&content[key_start..pos]).to_owned();
        pos += 1;
        if key.is_empty() {
            // Node assigns nothing for an empty key and keeps scanning after the `=`.
            continue;
        }
        let value = parse_value(&content, bytes, &mut pos);
        pairs.push((key, value));
    }
    pairs
}

fn parse_value(content: &str, bytes: &[u8], pos: &mut usize) -> String {
    if *pos >= bytes.len() || bytes[*pos] == b'\n' {
        return String::new();
    }
    while *pos < bytes.len() && is_space(bytes[*pos]) {
        *pos += 1;
    }
    if *pos >= bytes.len() {
        return String::new();
    }
    match bytes[*pos] {
        b'#' => {
            *pos = skip_line(bytes, *pos);
            String::new()
        }
        quote @ (b'"' | b'\'') => parse_quoted(content, bytes, pos, quote),
        _ => {
            let start = *pos;
            while *pos < bytes.len() && bytes[*pos] != b'\n' && bytes[*pos] != b'#' {
                *pos += 1;
            }
            let value = trim_end(&content[start..*pos]).to_owned();
            if *pos < bytes.len() && bytes[*pos] == b'#' {
                *pos = skip_line(bytes, *pos);
            }
            value
        }
    }
}

fn parse_quoted(content: &str, bytes: &[u8], pos: &mut usize, quote: u8) -> String {
    let open = *pos;
    let body = open + 1;
    match content[body..].find(quote as char) {
        Some(offset) => {
            let inner = &content[body..body + offset];
            let value = if quote == b'"' {
                expand_newlines(inner)
            } else {
                inner.to_owned()
            };
            *pos = body + offset + 1;
            *pos = skip_line(bytes, *pos);
            value
        }
        None => {
            let end = bytes[*pos..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(bytes.len(), |offset| *pos + offset);
            let value = trim_end(&content[open..end]).to_owned();
            *pos = end;
            value
        }
    }
}

fn expand_newlines(value: &str) -> String {
    let mut expanded = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\' && chars.peek() == Some(&'n') {
            chars.next();
            expanded.push('\n');
        } else {
            expanded.push(character);
        }
    }
    expanded
}

fn skip_line(bytes: &[u8], mut pos: usize) -> usize {
    while pos < bytes.len() && bytes[pos] != b'\n' {
        pos += 1;
    }
    pos
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n')
}

fn trim(value: &str) -> &str {
    trim_end(value.trim_start_matches([' ', '\t']))
}

fn trim_end(value: &str) -> &str {
    value.trim_end_matches([' ', '\t'])
}

/// Reads `path` when it exists and folds it into `env` with Node's precedence: a
/// variable already present keeps its value (`Z=preset` survives `Z=file`), while a
/// key repeated inside the file keeps the last occurrence.
///
/// A missing file is success with [`EnvFileLoad::Missing`]; any other read failure
/// is an error string (Node's own wording for those is unverified).
pub fn load_env_file(
    path: &Path,
    env: &mut BTreeMap<String, String>,
) -> Result<EnvFileLoad, String> {
    let content = match std::fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(EnvFileLoad::Missing),
        Err(error) => {
            return Err(format!(
                "failed to read env file {}: {error}",
                path.display()
            ));
        }
    };
    let mut file_values = BTreeMap::new();
    for (key, value) in parse_env(&String::from_utf8_lossy(&content)) {
        file_values.insert(key, value);
    }
    for (key, value) in file_values {
        env.entry(key).or_insert(value);
    }
    Ok(EnvFileLoad::Loaded)
}

/// `server/index.mjs:75-90` (`requireEnv`) plus the `SINGULARITY_HOME` rule from
/// `server/app-dir.mjs:13-16`, aggregated into Node's single message.
///
/// `SINGULARITY_HOME` is folded into the same list instead of Node's separate
/// import-time throw, so the daemon reports every missing var at once.
pub fn require_env(env: &BTreeMap<String, String>) -> Result<(), String> {
    let mut missing = Vec::new();
    if env
        .get("SINGULARITY_HOME")
        .is_none_or(|home| home.is_empty())
    {
        missing.push(crate::app_paths::SINGULARITY_HOME_REQUIRED.to_owned());
    }
    if !env
        .get("DAEMON_PORT")
        .is_some_and(|port| js_number_truthy(port))
    {
        missing.push(DAEMON_PORT_HINT.to_owned());
    }
    if !env
        .get("CLAUDE_BIN")
        .is_some_and(|bin| !bin.is_empty() && Path::new(bin).exists())
    {
        missing.push(CLAUDE_BIN_HINT.to_owned());
    }
    if env
        .get("SING_TOKEN")
        .filter(|token| !token.is_empty())
        .is_some_and(|token| !is_token(token))
    {
        missing.push(SING_TOKEN_HINT.to_owned());
    }
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{REQUIRED_ENV_HEADER}\n  - {}",
        missing.join("\n  - ")
    ))
}

fn is_token(token: &str) -> bool {
    token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Node's `requireEnv` tests `Number(process.env.DAEMON_PORT)` for truthiness, not
/// port validity: `0x10` and `Infinity` pass, `0`/`abc`/blank do not.
fn js_number_truthy(value: &str) -> bool {
    let text = value.trim();
    if text.is_empty() {
        return false;
    }
    let radix = |prefix: [&str; 2], radix: u32| {
        prefix
            .iter()
            .find_map(|prefix| text.strip_prefix(*prefix))
            .and_then(|digits| u64::from_str_radix(digits, radix).ok())
            .map(|number| number as f64)
    };
    let number = radix(["0x", "0X"], 16)
        .or_else(|| radix(["0o", "0O"], 8))
        .or_else(|| radix(["0b", "0B"], 2))
        .or_else(|| text.parse::<f64>().ok());
    number.is_some_and(|number| number != 0.0 && !number.is_nan())
}

#[cfg(test)]
mod tests {
    use super::{EnvFileLoad, load_env_file, parse_env, require_env};
    use crate::app_paths::SINGULARITY_HOME_REQUIRED;
    use std::collections::BTreeMap;
    use std::fs::{create_dir_all, write};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("singularity-env-file-{id}-{sequence}"));
            create_dir_all(&path).unwrap();
            Self(path)
        }

        fn file(&self, name: &str, content: &str) -> PathBuf {
            let path = self.0.join(name);
            write(&path, content).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn pairs(content: &str) -> Vec<(String, String)> {
        parse_env(content)
    }

    fn pair(key: &str, value: &str) -> (String, String) {
        (key.to_owned(), value.to_owned())
    }

    fn valid_env(fixture: &Fixture) -> BTreeMap<String, String> {
        let bin = fixture.file("claude-test-bin", "");
        BTreeMap::from([
            (
                "SINGULARITY_HOME".to_owned(),
                fixture.0.display().to_string(),
            ),
            ("DAEMON_PORT".to_owned(), "4317".to_owned()),
            ("CLAUDE_BIN".to_owned(), bin.display().to_string()),
        ])
    }

    #[test]
    fn parse_env_matches_node_for_comments_quotes_and_inline_comments() {
        let content = concat!(
            "# comment\n",
            "A=1\n",
            "B=  spaced  \n",
            "export C=exported\n",
            "D='single \\n literal'\n",
            "E=\"line1\\nline2\"\n",
            "F=value # trailing comment\n",
            "G=value#nospace\n",
            " I = spaced key \n",
            "J=\"\"\n",
            "K=\n",
            "L=\"escaped \\\" quote\"\n",
            "M=\"backslash \\\\ end\"\n",
            "N=$HOME\n",
            "O=\"a#b\"\n",
            "P=a=b=c\n",
            "Q=\"\\t tab \\r cr\"\n",
            "R='single # hash'\n",
        );
        assert_eq!(
            pairs(content),
            vec![
                pair("A", "1"),
                pair("B", "spaced"),
                pair("C", "exported"),
                pair("D", "single \\n literal"),
                pair("E", "line1\nline2"),
                pair("F", "value"),
                pair("G", "value"),
                pair("I", "spaced key"),
                pair("J", ""),
                pair("K", ""),
                pair("L", "escaped \\"),
                pair("M", "backslash \\\\ end"),
                pair("N", "$HOME"),
                pair("O", "a#b"),
                pair("P", "a=b=c"),
                pair("Q", "\\t tab \\r cr"),
                pair("R", "single # hash"),
            ]
        );
    }

    #[test]
    fn parse_env_handles_export_prefix_and_multiline_values() {
        let content = concat!(
            "export H=1\n",
            "export  I=2\n",
            "exported J=3\n",
            "Export K=4\n",
            "A=\"line1\nline2\"\n",
            "B='l1\nl2'\n",
        );
        assert_eq!(
            pairs(content),
            vec![
                pair("H", "1"),
                pair("I", "2"),
                pair("exported J", "3"),
                pair("Export K", "4"),
                pair("A", "line1\nline2"),
                pair("B", "l1\nl2"),
            ]
        );
    }

    #[test]
    fn parse_env_carries_empty_values_over_whitespace_but_not_a_bare_newline() {
        let content = "A=\nB=1\nC=  \n  value  \nD= \nE=2\n";
        assert_eq!(
            pairs(content),
            vec![
                pair("A", ""),
                pair("B", "1"),
                pair("C", "value"),
                pair("D", "E=2"),
            ]
        );
    }

    #[test]
    fn parse_env_removes_carriage_returns_everywhere() {
        assert_eq!(
            pairs("A=foo\rbar\r\nB=1\r\nC=\"x\r\ny\"\r\n"),
            vec![pair("A", "foobar"), pair("B", "1"), pair("C", "x\ny")]
        );
    }

    #[test]
    fn parse_env_unterminated_quotes_scan_forward_like_node() {
        assert_eq!(
            pairs("A=\"unterminated\nB=2\n"),
            vec![pair("A", "\"unterminated"), pair("B", "2")]
        );
        assert_eq!(
            pairs("A=\"a#b\nB=\"a\nb\nC=3\n"),
            vec![pair("A", "a#b\nB="), pair("C", "3")]
        );
        assert_eq!(
            pairs("A='x\n# 'q'\nB=1\n"),
            vec![pair("A", "x\n# "), pair("B", "1")]
        );
    }

    #[test]
    fn parse_env_double_quotes_expand_only_backslash_n() {
        assert_eq!(
            pairs("A=\"a\\nb\"\nB=\"a\\tb\"\nC=\"a\\\\nb\"\nD='a\\nb'\nE=\"a\\u0041b\"\n"),
            vec![
                pair("A", "a\nb"),
                pair("B", "a\\tb"),
                pair("C", "a\\\nb"),
                pair("D", "a\\nb"),
                pair("E", "a\\u0041b"),
            ]
        );
    }

    #[test]
    fn parse_env_skips_blank_comment_and_keyless_lines() {
        assert_eq!(
            pairs("\n\n   \n\t\n# c\n   # indented comment   \nA\nB=1\n"),
            vec![pair("B", "1")]
        );
        assert_eq!(pairs("A"), Vec::new());
        assert_eq!(pairs("=v\nA=1\n"), vec![pair("A", "1")]);
        assert_eq!(pairs("=a=b\nA=1\n"), vec![pair("a", "b"), pair("A", "1")]);
    }

    #[test]
    fn parse_env_keeps_node_quirks_for_keys() {
        assert_eq!(pairs("A#B=1\n"), vec![pair("A#B", "1")]);
        assert_eq!(pairs("\"QUOTEDKEY\"=5\n"), vec![pair("\"QUOTEDKEY\"", "5")]);
        assert_eq!(pairs("\u{feff}A=1\n"), vec![pair("\u{feff}A", "1")]);
        assert_eq!(pairs("\tA\t=\t1\t\n"), vec![pair("A", "1")]);
    }

    #[test]
    fn load_env_file_prefers_the_environment_and_the_last_file_value() {
        let fixture = Fixture::new();
        let path = fixture.file("test.env", "X=first\nX=second\nY=file\nZ=file\n");
        let mut env = BTreeMap::from([("Z".to_owned(), "preset".to_owned())]);
        assert_eq!(load_env_file(&path, &mut env), Ok(EnvFileLoad::Loaded));
        assert_eq!(env.get("X").map(String::as_str), Some("second"));
        assert_eq!(env.get("Y").map(String::as_str), Some("file"));
        assert_eq!(env.get("Z").map(String::as_str), Some("preset"));
    }

    #[test]
    fn load_env_file_treats_a_missing_file_as_absent_with_node_notice() {
        let fixture = Fixture::new();
        let path = fixture.0.join("absent.env");
        let mut env = BTreeMap::new();
        assert_eq!(load_env_file(&path, &mut env), Ok(EnvFileLoad::Missing));
        assert!(env.is_empty());
        assert_eq!(
            EnvFileLoad::Missing.notice(&path),
            Some(format!(
                "{} not found. Continuing without it.",
                path.display()
            ))
        );
        assert_eq!(EnvFileLoad::Loaded.notice(&path), None);
    }

    #[test]
    fn load_env_file_surfaces_a_non_not_found_read_error() {
        let fixture = Fixture::new();
        let mut env = BTreeMap::new();
        let error = load_env_file(&fixture.0, &mut env).unwrap_err();
        assert!(
            error.starts_with("failed to read env file "),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn require_env_accepts_a_complete_environment() {
        let fixture = Fixture::new();
        assert_eq!(require_env(&valid_env(&fixture)), Ok(()));
        let mut env = valid_env(&fixture);
        env.insert("SING_TOKEN".to_owned(), "aZ0_-".to_owned());
        env.insert("OLLAMA_BIN".to_owned(), "not-investigated".to_owned());
        assert_eq!(require_env(&env), Ok(()));
    }

    #[test]
    fn require_env_reports_every_missing_var_in_node_order() {
        let error = require_env(&BTreeMap::new()).unwrap_err();
        assert_eq!(
            error,
            format!(
                concat!(
                    "Required env vars missing — copy .env.example → .env and fill them in:\n",
                    "  - {}\n",
                    "  - DAEMON_PORT (listen port, e.g. 4317)\n",
                    "  - CLAUDE_BIN (absolute path to claude exe)"
                ),
                SINGULARITY_HOME_REQUIRED
            )
        );
    }

    #[test]
    fn require_env_treats_an_empty_singularity_home_as_missing() {
        let fixture = Fixture::new();
        let mut env = valid_env(&fixture);
        env.insert("SINGULARITY_HOME".to_owned(), String::new());
        let error = require_env(&env).unwrap_err();
        assert!(error.contains(SINGULARITY_HOME_REQUIRED), "{error}");
        assert!(!error.contains("DAEMON_PORT"), "{error}");
    }

    #[test]
    fn require_env_uses_node_number_truthiness_for_daemon_port() {
        let fixture = Fixture::new();
        for port in ["", "   ", "0", "-0", "4317abc", "NaN"] {
            let mut env = valid_env(&fixture);
            env.insert("DAEMON_PORT".to_owned(), port.to_owned());
            assert_eq!(
                require_env(&env).unwrap_err(),
                "Required env vars missing — copy .env.example → .env and fill them in:\n  \
                 - DAEMON_PORT (listen port, e.g. 4317)",
                "DAEMON_PORT={port:?} should be missing"
            );
        }
        for port in ["0x10", "Infinity", " 4317 ", "1e3"] {
            let mut env = valid_env(&fixture);
            env.insert("DAEMON_PORT".to_owned(), port.to_owned());
            assert_eq!(
                require_env(&env),
                Ok(()),
                "DAEMON_PORT={port:?} should pass"
            );
        }
    }

    #[test]
    fn require_env_requires_claude_bin_to_exist() {
        let fixture = Fixture::new();
        let mut env = valid_env(&fixture);
        env.insert(
            "CLAUDE_BIN".to_owned(),
            fixture.0.join("missing-bin").display().to_string(),
        );
        assert_eq!(
            require_env(&env).unwrap_err(),
            "Required env vars missing — copy .env.example → .env and fill them in:\n  \
             - CLAUDE_BIN (absolute path to claude exe)"
        );
        env.insert("CLAUDE_BIN".to_owned(), String::new());
        assert!(require_env(&env).is_err());
        env.insert(
            "CLAUDE_BIN".to_owned(),
            fixture.file("bin.exe", "").display().to_string(),
        );
        assert_eq!(require_env(&env), Ok(()));
    }

    #[test]
    fn require_env_validates_the_token_charset_only_when_set() {
        let fixture = Fixture::new();
        let mut env = valid_env(&fixture);
        env.insert("SING_TOKEN".to_owned(), "bad token".to_owned());
        assert_eq!(
            require_env(&env).unwrap_err(),
            "Required env vars missing — copy .env.example → .env and fill them in:\n  \
             - SING_TOKEN (set but contains characters outside [A-Za-z0-9_-])"
        );
        env.insert("SING_TOKEN".to_owned(), String::new());
        assert_eq!(require_env(&env), Ok(()));
    }

    #[test]
    fn require_env_reports_several_failures_in_one_message() {
        let fixture = Fixture::new();
        let bin = fixture.file("claude-test-bin", "");
        let env = BTreeMap::from([
            ("DAEMON_PORT".to_owned(), "0".to_owned()),
            ("CLAUDE_BIN".to_owned(), bin.display().to_string()),
            ("SING_TOKEN".to_owned(), "no/pe".to_owned()),
        ]);
        let error = require_env(&env).unwrap_err();
        assert_eq!(
            error.lines().collect::<Vec<_>>(),
            vec![
                "Required env vars missing — copy .env.example → .env and fill them in:",
                "  - SINGULARITY_HOME required — set it in .env (no default). State root.",
                "  - DAEMON_PORT (listen port, e.g. 4317)",
                "  - SING_TOKEN (set but contains characters outside [A-Za-z0-9_-])",
            ]
        );
    }

    #[test]
    fn load_env_file_feeds_require_env_end_to_end() {
        let fixture = Fixture::new();
        let bin = fixture.file("claude-test-bin", "");
        let path = fixture.file(
            "daemon.env",
            &format!(
                "# generated\nSINGULARITY_HOME={}\nDAEMON_PORT=4317\nCLAUDE_BIN={}\n#OLLAMA_BIN=\n",
                fixture.0.display(),
                bin.display()
            ),
        );
        let mut env = BTreeMap::new();
        assert_eq!(load_env_file(&path, &mut env), Ok(EnvFileLoad::Loaded));
        assert_eq!(require_env(&env), Ok(()));
        assert!(!env.contains_key("OLLAMA_BIN"));
        assert_eq!(
            Path::new(env.get("SINGULARITY_HOME").unwrap()),
            fixture.0.as_path()
        );
    }
}
