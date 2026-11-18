//! Node `path.posix.join` / `path.win32.join` for the config editor.
//!
//! The editor resolves its target as `join(cwd, config_dir, filename)`; Node
//! runs the platform `path.join`, so the Rust port reproduces Node's string
//! behaviour exactly, including its quirks: an empty `cwd` contributes
//! nothing, `C:foo` stays drive-relative (no separator after the drive),
//! `C:/` becomes `C:\`, `//server/share` becomes a UNC device with doubled
//! leading separators, a single leading separator keeps a root-relative
//! prefix, and `..` segments above a non-absolute root are preserved.
//!
//! Tilde expansion is intentionally out of scope: the caller expands `~` for
//! the Claude editor only, before calling this.

/// `path.posix.join(cwd, config_dir, filename)` (or win32) for the editor.
///
/// `config_dir` and `filename` are the editor's nonempty single-component
/// constants; only `cwd` varies per request and may be any string, including
/// an empty one.
pub(crate) fn join_config(cwd: &str, config_dir: &str, filename: &str, windows: bool) -> String {
    let parts = [cwd, config_dir, filename];
    if windows {
        join_windows(&parts)
    } else {
        join_posix(&parts)
    }
}

fn join_posix(parts: &[&str]) -> String {
    let mut joined = String::new();
    let mut any = false;
    for part in parts.iter().copied().filter(|part| !part.is_empty()) {
        if any {
            joined.push('/');
        }
        joined.push_str(part);
        any = true;
    }
    if !any {
        // `path.join()` with nothing to join returns a single dot.
        return ".".to_owned();
    }
    normalize_posix(&joined)
}

fn normalize_posix(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let body = resolve_segments(path.split('/'), !absolute).join("/");
    if body.is_empty() {
        if absolute {
            return "/".to_owned();
        }
        return if trailing {
            "./".to_owned()
        } else {
            ".".to_owned()
        };
    }
    let mut out = if absolute { format!("/{body}") } else { body };
    if trailing {
        out.push('/');
    }
    out
}

fn join_windows(parts: &[&str]) -> String {
    let mut joined = String::new();
    let mut first_part = None;
    for part in parts.iter().copied().filter(|part| !part.is_empty()) {
        if first_part.is_none() {
            first_part = Some(part);
            joined.push_str(part);
        } else {
            joined.push('\\');
            joined.push_str(part);
        }
    }
    let Some(first_part) = first_part else {
        return ".".to_owned();
    };
    let joined = collapse_leading_separators(joined, first_part);
    if joined.split('\\').any(|part| {
        part.find(':')
            .is_some_and(|index| reserved_name(&part[..index]))
    }) {
        return joined.replace('/', "\\");
    }
    normalize_windows(&joined)
}

fn reserved_name(name: &str) -> bool {
    let upper = name.to_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    ["COM", "LPT"].iter().any(|prefix| {
        upper.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

/// `path.win32.join`'s pre-step: unless the first part clearly points at a
/// UNC path (exactly two leading separators followed by a name), runs of
/// leading separators in the joined string collapse to a single one. Without
/// this, `normalize` would misread `\\\foo` as a UNC root.
fn collapse_leading_separators(joined: String, first_part: &str) -> String {
    let first = first_part.as_bytes();
    let mut needs_replace = true;
    let mut slash_count = 0;
    if first
        .first()
        .is_some_and(|byte| is_windows_separator(*byte))
    {
        slash_count = 1;
        if first.len() > 1 && is_windows_separator(first[1]) {
            slash_count = 2;
            if first.len() > 2 {
                if is_windows_separator(first[2]) {
                    slash_count = 3;
                } else {
                    needs_replace = false;
                }
            }
        }
    }
    if !needs_replace {
        return joined;
    }
    let bytes = joined.as_bytes();
    while slash_count < bytes.len() && is_windows_separator(bytes[slash_count]) {
        slash_count += 1;
    }
    if slash_count >= 2 {
        return format!("\\{}", &joined[slash_count..]);
    }
    joined
}

fn normalize_windows(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let bytes = path.as_bytes();
    if bytes.len() == 1 {
        // Node's one-character special case preserves a root separator.
        if is_windows_separator(bytes[0]) {
            return "\\".to_owned();
        }
        return path.to_owned();
    }

    let (root, rest, allow_above_root) = split_windows_root(path);
    let tail = resolve_segments(rest.split(is_windows_separator_char), allow_above_root).join("\\");
    match root {
        WindowsRoot::Relative => {
            if tail.is_empty() {
                ".".to_owned()
            } else if path.contains(':')
                && ((tail.as_bytes().len() >= 2
                    && tail.as_bytes()[0].is_ascii_alphabetic()
                    && tail.as_bytes()[1] == b':')
                    || path.as_bytes().iter().enumerate().any(|(index, byte)| {
                        *byte == b':'
                            && path
                                .as_bytes()
                                .get(index + 1)
                                .is_none_or(|next| is_windows_separator(*next))
                    }))
            {
                format!(".\\{tail}")
            } else {
                tail
            }
        }
        WindowsRoot::RootRelative => format!("\\{tail}"),
        // Drive-relative (`C:foo`) never gains a separator after the drive.
        WindowsRoot::DriveRelative(drive) => format!("{drive}{tail}"),
        WindowsRoot::DriveAbsolute(drive) | WindowsRoot::Unc(drive) => format!("{drive}\\{tail}"),
    }
}

enum WindowsRoot {
    Relative,
    RootRelative,
    DriveRelative(String),
    DriveAbsolute(String),
    Unc(String),
}

/// Split a Windows path into its root and the remaining text, mirroring
/// `path.win32.normalize`'s root matching. The final component of every
/// returned root is a whole device (`C:` or `\\server\share`).
fn split_windows_root(path: &str) -> (WindowsRoot, &str, bool) {
    let bytes = path.as_bytes();
    let len = bytes.len();

    if is_windows_separator(bytes[0]) {
        if is_windows_separator(bytes[1]) {
            if let Some((device, rest)) = parse_unc(path) {
                return (WindowsRoot::Unc(device), rest, false);
            }
            return (WindowsRoot::RootRelative, skip_separators(path, 1), false);
        } else {
            return (WindowsRoot::RootRelative, skip_separators(path, 1), false);
        }
    } else if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let drive = path[..2].to_owned();
        if len > 2 && is_windows_separator(bytes[2]) {
            return (
                WindowsRoot::DriveAbsolute(drive),
                skip_separators(path, 2),
                false,
            );
        }
        return (WindowsRoot::DriveRelative(drive), &path[2..], true);
    }
    (WindowsRoot::Relative, path, true)
}

/// Split `\\server\share\rest` into (`\\server\share`, `rest`). Both names
/// must be nonempty, matching Node; otherwise the path is not a UNC root.
fn parse_unc(path: &str) -> Option<(String, &str)> {
    let bytes = path.as_bytes();
    let len = bytes.len();

    let mut index = 2;
    while index < len && !is_windows_separator(bytes[index]) {
        index += 1;
    }
    if index == 2 {
        return None;
    }
    let server = &path[2..index];

    let mut next = index;
    while next < len && is_windows_separator(bytes[next]) {
        next += 1;
    }
    if next == index {
        return None;
    }
    let share_start = next;
    while next < len && !is_windows_separator(bytes[next]) {
        next += 1;
    }
    if next == share_start {
        return None;
    }
    let share = &path[share_start..next];

    if server == "." || server == "?" {
        return Some((format!("\\\\{server}"), &path[share_start..]));
    }

    Some((
        format!("\\\\{server}\\{share}"),
        skip_separators(path, next),
    ))
}

fn skip_separators(path: &str, mut index: usize) -> &str {
    let bytes = path.as_bytes();
    while index < bytes.len() && is_windows_separator(bytes[index]) {
        index += 1;
    }
    &path[index..]
}

/// Node's `normalizeString` segment pass: empty and `.` segments are dropped,
/// `..` pops a preceding normal segment, and survives only when
/// `allow_above_root` is set (Node enables it for every non-absolute root).
fn resolve_segments<'a>(
    segments: impl Iterator<Item = &'a str>,
    allow_above_root: bool,
) -> Vec<&'a str> {
    let mut resolved: Vec<&str> = Vec::new();
    for segment in segments {
        match segment {
            "" | "." => {}
            ".." => {
                if resolved.last().is_some_and(|last| *last != "..") {
                    resolved.pop();
                } else if allow_above_root {
                    resolved.push(segment);
                }
            }
            _ => resolved.push(segment),
        }
    }
    resolved
}

fn is_windows_separator(byte: u8) -> bool {
    byte == b'/' || byte == b'\\'
}

fn is_windows_separator_char(value: char) -> bool {
    value == '/' || value == '\\'
}

#[cfg(test)]
mod tests {
    use super::join_config;

    fn posix(cwd: &str) -> String {
        join_config(cwd, ".codex", "config.toml", false)
    }

    fn win32(cwd: &str) -> String {
        join_config(cwd, ".codex", "config.toml", true)
    }

    fn assert_cases(cases: &[(&str, &str)], actual: fn(&str) -> String) {
        for (cwd, expected) in cases {
            assert_eq!(actual(cwd), *expected, "cwd {cwd:?}");
        }
    }

    // Expected values mirror `path.posix.join(cwd, '.codex', 'config.toml')`.
    #[test]
    fn posix_normalizes_like_node() {
        assert_cases(
            &[
                ("", ".codex/config.toml"),
                (".", ".codex/config.toml"),
                ("..", "../.codex/config.toml"),
                ("../..", "../../.codex/config.toml"),
                ("relative/../work", "work/.codex/config.toml"),
                ("a/./b/..", "a/.codex/config.toml"),
                ("a//b", "a/b/.codex/config.toml"),
                ("work/", "work/.codex/config.toml"),
                ("~", "~/.codex/config.toml"),
                ("~/work", "~/work/.codex/config.toml"),
                ("C:foo", "C:foo/.codex/config.toml"),
                ("C:/", "C:/.codex/config.toml"),
                ("C:/work", "C:/work/.codex/config.toml"),
                ("//server/share", "/server/share/.codex/config.toml"),
                ("/a//b/../c", "/a/c/.codex/config.toml"),
                ("/", "/.codex/config.toml"),
                ("///x", "/x/.codex/config.toml"),
                ("/../a", "/a/.codex/config.toml"),
            ],
            posix,
        );
    }

    // Expected values mirror `path.win32.join(cwd, '.codex', 'config.toml')`.
    // The `C:`, `C:/`, UNC and `/a//b/../c` rows are Node-measured.
    #[test]
    fn win32_normalizes_like_node() {
        assert_cases(
            &[
                ("", r".codex\config.toml"),
                (".", r".codex\config.toml"),
                ("..", r"..\.codex\config.toml"),
                (r"..\..", r"..\..\.codex\config.toml"),
                ("relative/../work", r"work\.codex\config.toml"),
                ("a/./b/..", r"a\.codex\config.toml"),
                ("work/", r"work\.codex\config.toml"),
                ("~", r"~\.codex\config.toml"),
                ("~/work", r"~\work\.codex\config.toml"),
                (r"C:foo", r"C:foo\.codex\config.toml"),
                ("C:/", r"C:\.codex\config.toml"),
                (r"C:\work", r"C:\work\.codex\config.toml"),
                ("c:/work\\sub", r"c:\work\sub\.codex\config.toml"),
                (r"C:..\work", r"C:..\work\.codex\config.toml"),
                (r"\\server\share", r"\\server\share\.codex\config.toml"),
                (
                    r"\\server\share\work",
                    r"\\server\share\work\.codex\config.toml",
                ),
                ("/a//b/../c", r"\a\c\.codex\config.toml"),
                ("\\", r"\.codex\config.toml"),
                ("/a/../..", r"\.codex\config.toml"),
                ("/../../x", r"\x\.codex\config.toml"),
                (
                    "//server/share/../../x",
                    r"\\server\share\x\.codex\config.toml",
                ),
                ("C:/../../x", r"C:\x\.codex\config.toml"),
                ("//server", r"\\server\.codex\config.toml"),
                ("///x", r"\x\.codex\config.toml"),
                ("C:../../x", r"C:..\..\x\.codex\config.toml"),
                ("1:", r".\1:\.codex\config.toml"),
                ("./C:Za", r".\C:Za\.codex\config.toml"),
                ("COM1:a/../b", r"COM1:a\..\b\.codex\config.toml"),
                ("//./.", r"\\.\.codex\config.toml"),
                ("//?/.", r"\\?\.codex\config.toml"),
            ],
            win32,
        );
    }

    #[test]
    fn tildes_are_left_literal() {
        // The caller expands `~` for Claude only; this helper must not.
        assert_eq!(posix("~/work"), "~/work/.codex/config.toml");
        assert_eq!(win32("~/work"), r"~\work\.codex\config.toml");
        assert_eq!(posix("~"), "~/.codex/config.toml");
        assert_eq!(win32("~"), r"~\.codex\config.toml");
    }

    #[test]
    fn editor_components_are_parameters() {
        assert_eq!(
            join_config("~/work", ".claude", "settings.json", false),
            "~/work/.claude/settings.json"
        );
        assert_eq!(
            join_config(r"C:\work", ".claude", "settings.json", true),
            r"C:\work\.claude\settings.json"
        );
    }
}
