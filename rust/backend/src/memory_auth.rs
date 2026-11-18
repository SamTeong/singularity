// Memory path authorization: the pure core of server/memory.mjs `isMemoryPath`
// and server/path-containment.mjs `contains`, operating on already-resolved
// UTF-16 units. Callers resolve roots and target lexically (wiki_root::
// resolve_units) and pass the platform explicitly; this module only decides,
// never touches the filesystem and never converts to Rust strings, so lone
// surrogates survive unchanged.
use crate::wiki_root::{contained_units, same_units};

const DOT: u16 = b'.' as u16;

fn separator(windows: bool) -> u16 {
    if windows { b'\\' as u16 } else { b'/' as u16 }
}

/// JS regex `.` never matches a line terminator, and `$` without `m` means end
/// of input (so a trailing newline is not ignored either).
fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x000a | 0x000d | 0x2028 | 0x2029)
}

/// ASCII-only case folding matches JS `i` without `u` for the ASCII literals
/// "memory" and ".md": there, a non-ASCII code point never canonicalises into
/// an ASCII one.
fn strip_ascii_prefix_ci<'a>(units: &'a [u16], prefix: &[u8]) -> Option<&'a [u16]> {
    let head = units.get(..prefix.len())?;
    let matches = head
        .iter()
        .zip(prefix)
        .all(|(unit, expected)| *unit < 0x80 && (*unit as u8).eq_ignore_ascii_case(expected));
    matches.then(|| &units[prefix.len()..])
}

fn ends_with_ascii_ci(units: &[u16], suffix: &[u8]) -> bool {
    units
        .len()
        .checked_sub(suffix.len())
        .is_some_and(|start| strip_ascii_prefix_ci(&units[start..], suffix).is_some())
}

/// `^\<sep>[^\<sep>]+\<sep>memory\<sep>.+\.md$` case-insensitively. `rel` is the
/// slice starting at the supplied root's length, so a filesystem root (whose
/// slice has no leading separator) never matches, exactly like Node's slice.
fn memory_md_shape(rel: &[u16], windows: bool) -> bool {
    let sep = separator(windows);
    let Some(rest) = rel.strip_prefix(&[sep]) else {
        return false;
    };
    // `[^<sep>]+` is a single non-empty segment; it may contain line terminators.
    let Some(project_len) = rest.iter().position(|unit| *unit == sep) else {
        return false;
    };
    if project_len == 0 {
        return false;
    }
    let Some(rest) = strip_ascii_prefix_ci(&rest[project_len + 1..], b"memory") else {
        return false;
    };
    let Some(name) = rest.strip_prefix(&[sep]) else {
        return false;
    };
    // `.+\.md` needs at least one more unit, and `.` accepts separators (nested
    // filenames) and lone surrogates but no line terminator.
    name.len() >= 4
        && !name.iter().any(|unit| is_line_terminator(*unit))
        && ends_with_ascii_ci(name, b".md")
}

/// Mirrors `isMemoryPath(p, rootRaw)` after resolution:
/// The caller must reject a falsy raw path before resolution. The supplied root
/// must resolve to the persisted root,
/// the target must stay contained, and the slice at the supplied root's exact
/// UTF-16 length must read `<sep><project><sep>memory<sep><name>.md`.
pub(crate) fn is_memory_path(
    target: &[u16],
    supplied_root: &[u16],
    persisted_root: &[u16],
    windows: bool,
) -> bool {
    if target.is_empty() {
        return false;
    }
    // resolveRoot(raw): a falsy raw root falls back to the persisted root, which
    // the caller has already resolved.
    let root = if supplied_root.is_empty() {
        persisted_root
    } else {
        supplied_root
    };
    if root.is_empty() || !same_units(root, persisted_root, windows) {
        return false;
    }
    if !contained_units(root, target, windows) {
        return false;
    }
    let Some(rel) = target.get(root.len()..) else {
        return false;
    };
    // path.relative() drops the separator, so `contains`' `startsWith('..')`
    // test applies to the remainder: an in-root directory literally named
    // "..project" is still rejected, while ".." deeper in the path is not
    // reached by that test.
    let relative = rel.strip_prefix(&[separator(windows)]).unwrap_or(rel);
    if relative.starts_with(&[DOT, DOT]) {
        return false;
    }
    memory_md_shape(rel, windows)
}

#[cfg(test)]
mod tests {
    use super::is_memory_path;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn posix(target: &str, supplied: &str, persisted: &str) -> bool {
        is_memory_path(&units(target), &units(supplied), &units(persisted), false)
    }

    fn windows(target: &str, supplied: &str, persisted: &str) -> bool {
        is_memory_path(&units(target), &units(supplied), &units(persisted), true)
    }

    #[test]
    fn accepts_valid_nested_and_mixed_case_names() {
        let root = "/srv/memory";
        assert!(posix("/srv/memory/proj/memory/a.md", root, root));
        assert!(posix(
            "/srv/memory/proj/memory/deep/nested/a.md",
            root,
            root
        ));
        assert!(posix("/srv/memory/proj/MEMORY/A.MD", root, root));
        assert!(posix("/srv/memory/proj/memory/..a.md", root, root));
        assert!(posix("/srv/memory/proj/memory/a b.c.md", root, root));
        // Empty supplied root mirrors resolveRoot(raw || persisted).
        assert!(posix("/srv/memory/proj/memory/a.md", "", root));
    }

    #[test]
    fn rejects_wrong_shape_under_the_root() {
        let root = "/srv/memory";
        assert!(!posix("", root, root));
        assert!(!posix("/srv/memory", root, root));
        assert!(!posix("/srv/memory/", root, root));
        assert!(!posix("/srv/memory/proj/a.md", root, root));
        assert!(!posix("/srv/memory/proj/memory/a.txt", root, root));
        assert!(!posix("/srv/memory/proj/memory/.md", root, root));
        assert!(!posix("/srv/memory/proj/memory/", root, root));
        assert!(!posix("/srv/memory/proj/memoryX/a.md", root, root));
        assert!(!posix("/srv/memory/proj/memory/a.md/x", root, root));
        assert!(!posix("/srv/memory//memory/a.md", root, root));
    }

    #[test]
    fn rejects_divergent_and_sibling_roots() {
        assert!(!posix(
            "/srv/memory/proj/memory/a.md",
            "/srv/other",
            "/srv/memory"
        ));
        assert!(!posix(
            "/srv/other/proj/memory/a.md",
            "/srv/other",
            "/srv/memory"
        ));
        assert!(!posix(
            "/srv/memory-evil/proj/memory/a.md",
            "/srv/memory",
            "/srv/memory"
        ));
        assert!(!posix(
            "/srv/memoryX/proj/memory/a.md",
            "/srv/memory",
            "/srv/memory"
        ));
        assert!(!posix("/srv/memory/proj/memory/a.md", "/srv/memory", ""));
    }

    #[test]
    fn rejects_relative_paths_beginning_with_dotdot() {
        let root = "/srv/memory";
        assert!(!posix("/srv/memory/..project/memory/a.md", root, root));
        assert!(!posix("/srv/memory/..foo/memory/a.md", root, root));
        assert!(!posix("/srv/memory/.../memory/a.md", root, root));
        // Only the first relative segment is tested, not ".." in the filename.
        assert!(posix("/srv/memory/proj/memory/..a.md", root, root));
    }

    #[test]
    fn filesystem_roots_never_authorize() {
        assert!(!posix("/proj/memory/a.md", "/", "/"));
        assert!(!posix("/proj/memory/a.md", "", "/"));
        assert!(!windows(r"C:\proj\memory\a.md", r"C:\", r"C:\"));
    }

    #[test]
    fn slices_at_the_supplied_root_length() {
        // A surrogate pair counts as two UTF-16 units, as in Node's slice.
        let root = "/srv/🧪";
        assert!(posix("/srv/🧪/proj/memory/a.md", root, root));
        assert!(!posix("/srv/🧪x/proj/memory/a.md", root, root));
        // Supplied and persisted roots differ only in case; the slice still
        // uses the supplied root's length and keeps the target's casing.
        let persisted = r"C:\Users\Me\.claude\projects";
        let supplied = r"c:\users\me\.claude\projects";
        assert!(windows(
            r"C:\USERS\ME\.claude\PROJECTS\proj\memory\a.md",
            supplied,
            persisted
        ));
    }

    #[test]
    fn rejects_js_line_terminators_but_not_in_the_project_segment() {
        let root = "/srv/memory";
        for terminator in ["\n", "\r", "\u{2028}", "\u{2029}"] {
            assert!(!posix(
                &format!("/srv/memory/proj/memory/a{terminator}b.md"),
                root,
                root
            ));
            assert!(!posix(
                &format!("/srv/memory/proj/memory/a.md{terminator}"),
                root,
                root
            ));
        }
        // `[^/]+` for the project segment does allow a line terminator.
        assert!(posix("/srv/memory/pr\noject/memory/a.md", root, root));
        assert!(!windows(
            "C:\\root\\proj\\memory\\a\nb.md",
            "C:\\root",
            "C:\\root"
        ));
    }

    #[test]
    fn preserves_lone_surrogates_in_names_and_roots() {
        let root = units("/srv/memory");
        let mut target = units("/srv/memory/proj/memory/");
        target.push(0xd800);
        target.extend(units("a.md"));
        assert!(is_memory_path(&target, &root, &root, false));

        // A lone surrogate in the root survives equality and the length slice.
        let mut root = units("/srv/");
        root.push(0xdc00);
        let mut target = root.clone();
        target.extend(units("/proj/memory/a.md"));
        assert!(is_memory_path(&target, &root, &root, false));

        let mut target = units("C:\\root\\proj\\memory\\");
        target.push(0xd800);
        target.extend(units("a.md"));
        assert!(is_memory_path(
            &target,
            &units("C:\\root"),
            &units("C:\\root"),
            true
        ));
    }

    #[test]
    fn windows_authorization_uses_backslash_separators() {
        let root = r"C:\Users\me\.claude\projects";
        assert!(windows(
            r"C:\Users\me\.claude\projects\proj\memory\a.md",
            root,
            root
        ));
        assert!(windows(
            r"C:\Users\me\.claude\projects\proj\memory\deep\A.MD",
            root,
            root
        ));
        assert!(!windows(
            r"C:\Users\me\.claude\projects\..project\memory\a.md",
            root,
            root
        ));
        assert!(!windows(r"D:\projects\proj\memory\a.md", root, root));
        assert!(!windows(
            r"C:\Users\me\.claude\projects-evil\proj\memory\a.md",
            root,
            root
        ));
        assert!(!windows(
            r"C:\Users\me\.claude\projects\proj\memory\a.md",
            r"C:\other",
            root
        ));
    }
}
