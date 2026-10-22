use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{self, FileType};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub mod claude_credentials;
pub mod claude_usage;
pub mod codex_config_write;
pub mod codex_thread_identity;
pub mod codex_usage;
pub mod config_state;
pub mod config_write;
pub mod detached;
pub mod explorer_fs;
pub mod explorer_state;
pub mod hooks_write;
pub(crate) mod http_attempt;
pub mod keys;
pub mod memory;
pub mod model_prices;
pub mod models;
pub mod oneshot;
pub mod plans;
pub mod procs;
pub mod provider_usage;
pub mod pty;
pub mod rules;
pub mod skills;
pub mod status;
pub mod sysstats;
pub mod transcript_bridge;
pub mod transcript_service;
pub mod transcripts;
pub mod usage_auth;
pub mod usage_report;
pub mod usage_snapshot;
pub mod wiki_read;
pub mod window_anchor;

const FILE_CAP: usize = 2000;
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".obsidian",
    ".vscode",
    "node_modules",
    ".next",
    ".cache",
    "dist",
    "build",
];

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub category: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Edge {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct GraphError {
    pub error: &'static str,
}

#[derive(Clone)]
struct Page {
    path: PathBuf,
    rel: String,
}

fn expand_root(raw: &str) -> PathBuf {
    if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            let suffix = raw.strip_prefix('~').unwrap_or("");
            return PathBuf::from(home).join(suffix.trim_start_matches(['/', '\\']));
        }
    }
    PathBuf::from(raw)
}

fn skipped(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

fn walk(dir: &Path, prefix: &str, pages: &mut Vec<Page>) {
    if pages.len() >= FILE_CAP {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if skipped(&name) {
            continue;
        }
        let kind: FileType = match entry.file_type() {
            Ok(kind) => kind,
            Err(_) => continue,
        };
        let path = entry.path();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if kind.is_dir() {
            walk(&path, &rel, pages);
            if pages.len() >= FILE_CAP {
                return;
            }
        } else if kind.is_file() && name.to_lowercase().ends_with(".md") {
            pages.push(Page { path, rel });
            if pages.len() >= FILE_CAP {
                return;
            }
        }
    }
}

fn normalized(value: &str) -> String {
    let without_ext = if value.to_lowercase().ends_with(".md") {
        &value[..value.len() - 3]
    } else {
        value
    };
    without_ext.to_lowercase()
}

fn wikilink_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").expect("constant regex is valid")
    })
}

pub fn wiki_graph(root: &str, wiki: &str) -> Result<Graph, GraphError> {
    let root = expand_root(root);
    if !root.exists() {
        return Err(GraphError { error: "not found" });
    }
    let wiki_path = match fs::read_dir(&root).ok().and_then(|entries| {
        entries.filter_map(Result::ok).find(|entry| {
            entry.file_name().to_string_lossy() == wiki
                && !skipped(&entry.file_name().to_string_lossy())
                && entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
        })
    }) {
        Some(entry) => entry.path(),
        None => {
            return Err(GraphError {
                error: "wiki not found",
            });
        }
    };

    let mut pages = Vec::new();
    walk(&wiki_path, "", &mut pages);
    let mut by_rel = HashMap::new();
    let mut by_base = HashMap::new();
    for page in &pages {
        let key = normalized(&page.rel);
        by_rel.insert(key.clone(), page.rel.clone());
        by_base.insert(
            key.rsplit('/').next().unwrap_or(&key).to_owned(),
            page.rel.clone(),
        );
    }
    let nodes = pages
        .iter()
        .map(|page| {
            let label = page.rel.rsplit('/').next().unwrap_or(&page.rel);
            let label = if label.to_lowercase().ends_with(".md") {
                &label[..label.len() - 3]
            } else {
                label
            };
            let category = page.rel.split_once('/').map(|(head, _)| head).unwrap_or("");
            Node {
                id: page.rel.clone(),
                label: label.to_owned(),
                category: category.to_owned(),
            }
        })
        .collect();

    let mut seen = HashSet::new();
    let mut edges = Vec::new();
    for page in &pages {
        let source = match fs::read(&page.path) {
            Ok(source) => String::from_utf8_lossy(&source).into_owned(),
            Err(_) => continue,
        };
        for captures in wikilink_regex().captures_iter(&source) {
            let want = normalized(captures.get(1).map(|m| m.as_str().trim()).unwrap_or(""));
            let target = by_rel
                .get(&want)
                .or_else(|| by_base.get(want.rsplit('/').next().unwrap_or(&want)));
            let Some(target) = target else {
                continue;
            };
            if target == &page.rel || !seen.insert((page.rel.clone(), target.clone())) {
                continue;
            }
            edges.push(Edge {
                source: page.rel.clone(),
                target: target.clone(),
            });
        }
    }
    Ok(Graph { nodes, edges })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("singularity-wiki-{id}"));
            create_dir_all(&path).unwrap();
            Self(path)
        }
        fn put(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            create_dir_all(path.parent().unwrap()).unwrap();
            write(path, text).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn graph_resolves_paths_aliases_and_basenames() {
        let f = Fixture::new();
        f.put("wiki/start.md", "[[guide/intro|Read]] [[INTRO]] [[missing]] [[start]] [[guide/intro.md]] [[guide/intro]]");
        f.put("wiki/guide/intro.md", "");
        f.put("wiki/other/intro.md", "");
        let graph = wiki_graph(f.0.to_str().unwrap(), "wiki").unwrap();
        assert!(graph.nodes.iter().any(|node| node.id == "start.md"
            && node.label == "start"
            && node.category.is_empty()));
        assert!(
            graph
                .nodes
                .iter()
                .any(|node| node.id == "guide/intro.md" && node.category == "guide")
        );
        let basename_target = graph
            .nodes
            .iter()
            .filter(|node| node.label == "intro")
            .last()
            .unwrap()
            .id
            .clone();
        assert_eq!(
            graph
                .edges
                .iter()
                .filter(|edge| edge.source == "start.md")
                .count(),
            if basename_target == "guide/intro.md" {
                1
            } else {
                2
            }
        );
        assert!(
            graph
                .edges
                .iter()
                .any(|edge| edge.source == "start.md" && edge.target == basename_target)
        );
        assert!(
            graph
                .edges
                .iter()
                .any(|edge| edge.source == "start.md" && edge.target == "guide/intro.md")
        );
        assert!(
            !graph
                .edges
                .iter()
                .any(|edge| edge.source == "start.md" && edge.target == "start.md")
        );
        let invalid_utf8 = f.0.join("wiki/invalid.md");
        fs::write(
            invalid_utf8,
            [
                0xff, b' ', b'[', b'[', b'g', b'u', b'i', b'd', b'e', b'/', b'i', b'n', b't', b'r',
                b'o', b']', b']',
            ],
        )
        .unwrap();
        let graph = wiki_graph(f.0.to_str().unwrap(), "wiki").unwrap();
        assert!(
            graph
                .edges
                .iter()
                .any(|edge| edge.source == "invalid.md" && edge.target == "guide/intro.md")
        );
    }

    #[test]
    fn missing_root_and_wiki_keep_public_errors() {
        let f = Fixture::new();
        assert_eq!(
            wiki_graph(f.0.join("absent").to_str().unwrap(), "wiki")
                .unwrap_err()
                .error,
            "not found"
        );
        assert_eq!(
            wiki_graph(f.0.to_str().unwrap(), "wiki").unwrap_err().error,
            "wiki not found"
        );
    }

    #[test]
    fn walk_stops_at_the_file_cap() {
        let f = Fixture::new();
        let dir = f.0.join("wiki");
        create_dir_all(&dir).unwrap();
        for index in 0..=FILE_CAP {
            write(dir.join(format!("page-{index}.md")), "").unwrap();
        }
        let graph = wiki_graph(f.0.to_str().unwrap(), "wiki").unwrap();
        assert_eq!(graph.nodes.len(), FILE_CAP);
    }

    #[test]
    fn walk_skips_hidden_and_heavy_dirs_and_does_not_follow_symlinks() {
        let f = Fixture::new();
        f.put("wiki/root.md", "");
        for dir in [
            ".hidden",
            ".git",
            ".obsidian",
            ".vscode",
            "node_modules",
            ".next",
            ".cache",
            "dist",
            "build",
        ] {
            f.put(&format!("wiki/{dir}/hidden.md"), "");
        }
        let graph = wiki_graph(f.0.to_str().unwrap(), "wiki").unwrap();
        assert_eq!(graph.nodes.len(), 1);
        #[cfg(unix)]
        {
            let outside = Fixture::new();
            outside.put("secret.md", "");
            std::os::unix::fs::symlink(outside.0.join("secret.md"), f.0.join("wiki/linked.md"))
                .unwrap();
            std::os::unix::fs::symlink(&outside.0, f.0.join("wiki/escape")).unwrap();
            let graph = wiki_graph(f.0.to_str().unwrap(), "wiki").unwrap();
            assert_eq!(graph.nodes.len(), 1);
        }
        #[cfg(windows)]
        {
            let outside = Fixture::new();
            outside.put("secret.md", "");
            if std::os::windows::fs::symlink_dir(&outside.0, f.0.join("wiki/escape")).is_ok() {
                let graph = wiki_graph(f.0.to_str().unwrap(), "wiki").unwrap();
                assert_eq!(graph.nodes.len(), 1);
            }
        }
    }
}
