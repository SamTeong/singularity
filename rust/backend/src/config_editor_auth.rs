//! Config editor cwd authorization: the Rust port of `isKnownConfigRoot` in
//! `server/config.mjs`, shared by `config.mjs` and `codex-config.mjs`.
//!
//! `writeConfig` refuses a `cwd` that does not resolve under one of the pinned
//! picker roots, so a request cannot point the editor at an arbitrary directory
//! and plant a `settings.json` Claude would auto-execute on its next run there.
//! Node resolves both sides with `path.resolve` after expanding `~` (its
//! `resolveRoot`) and accepts `abs === root || abs.startsWith(root + sep)`.
//! That comparison is exact on UTF-16 code units even on Windows: no case
//! folding, no separator folding, and a root that already ends in a separator
//! simply gains another one, so only exact equality can match such a root.
use crate::wiki_root::resolve_units;
use std::path::{Path, PathBuf};

/// `isKnownConfigRoot(cwd)`: an empty `cwd` or an empty root cannot match.
/// Both sides are tilde-expanded and lexically resolved with the platform
/// resolver (`expand_tilde = true`), matching Node's `resolveRoot`.
pub(crate) fn is_known(
    cwd: &[u16],
    roots: &[Vec<u16>],
    home: &Path,
    process_cwd: &Path,
    drive_cwds: &[(u16, PathBuf)],
) -> bool {
    if cwd.is_empty() {
        return false;
    }
    let windows = cfg!(windows);
    let separator = if windows { b'\\' as u16 } else { b'/' as u16 };
    let abs = resolve_units(cwd, home, process_cwd, drive_cwds, windows, true);
    roots.iter().filter(|root| !root.is_empty()).any(|root| {
        let root = resolve_units(root, home, process_cwd, drive_cwds, windows, true);
        abs == root || {
            let mut prefix = root;
            prefix.push(separator);
            abs.starts_with(&prefix)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::is_known;
    use std::path::PathBuf;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    // Absolute drive (Windows) or root (POSIX) prefix, so these pure tests run
    // with the host platform's resolver either way.
    fn prefix() -> &'static str {
        if cfg!(windows) { "C:" } else { "" }
    }

    fn native(parts: &[&str]) -> String {
        let separator = if cfg!(windows) { '\\' } else { '/' };
        let mut path = parts[0].to_owned();
        for part in &parts[1..] {
            path.push(separator);
            path.push_str(part);
        }
        path
    }

    fn path(parts: &[&str]) -> String {
        let mut all = vec![prefix()];
        all.extend_from_slice(parts);
        native(&all)
    }

    fn known(cwd: &str, roots: &[&str]) -> bool {
        is_known(
            &units(cwd),
            &roots.iter().map(|root| units(root)).collect::<Vec<_>>(),
            &PathBuf::from(path(&["home", "tester"])),
            &PathBuf::from(path(&["work", "project"])),
            &[],
        )
    }

    #[test]
    fn root_itself_and_children_match() {
        let root = path(&["roots", "one"]);
        assert!(known(&root, &[root.as_str()]));
        assert!(known(&path(&["roots", "one", "project"]), &[root.as_str()]));
        let other = path(&["roots", "other"]);
        assert!(known(
            &path(&["roots", "one", "project"]),
            &[other.as_str(), root.as_str()]
        ));
    }

    #[test]
    fn sibling_with_shared_name_prefix_does_not_match() {
        let root = path(&["roots", "one"]);
        assert!(!known(&path(&["roots", "one-extra"]), &[root.as_str()]));
        assert!(!known(&path(&["roots", "on"]), &[root.as_str()]));
    }

    #[test]
    fn parent_segments_are_resolved_before_matching() {
        let root = path(&["roots", "one"]);
        assert!(!known(
            &path(&["roots", "one", "..", "two"]),
            &[root.as_str()]
        ));
        assert!(known(
            &path(&["roots", "two", "..", "one"]),
            &[root.as_str()]
        ));
    }

    #[test]
    fn tilde_expands_for_cwd_and_roots() {
        let home_project = path(&["home", "tester", "project"]);
        assert!(known("~/project", &[home_project.as_str()]));
        assert!(known(&home_project, &["~/project"]));
        assert!(known("~", &[path(&["home", "tester"]).as_str()]));
        // only `~`, `~/...` and `~\...` expand; `~name` stays relative
        assert!(!known("~project", &[home_project.as_str()]));
    }

    #[test]
    fn empty_cwd_and_empty_roots_cannot_match() {
        let root = path(&["roots", "one"]);
        // an empty root would otherwise resolve to the process cwd itself
        let process_cwd = path(&["work", "project"]);
        assert!(!known("", &[root.as_str()]));
        assert!(!known(&process_cwd, &[""]));
        assert!(!known(&process_cwd, &[]));
        assert!(known(&root, &["", root.as_str()]));
    }

    #[test]
    fn separator_terminated_root_gains_another_separator() {
        // `root + sep` doubles the separator, so only exact equality matches.
        let root = path(&[""]);
        assert!(root.ends_with(if cfg!(windows) { '\\' } else { '/' }));
        assert!(known(&root, &[root.as_str()]));
        assert!(!known(&path(&["roots", "one"]), &[root.as_str()]));
    }

    #[test]
    fn matching_is_case_sensitive() {
        let root = path(&["Roots", "One"]);
        assert!(known(&root, &[root.as_str()]));
        assert!(!known(&path(&["roots", "one"]), &[root.as_str()]));
    }
}
