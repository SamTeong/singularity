//! Read-only transcript filesystem service. Process-specific roots are explicit inputs.
use crate::transcripts::{
    TranscriptRawText, parse_claude, parse_claude_with_tool_limit, parse_codex,
    parse_codex_with_tool_limit,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{self, BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::UNIX_EPOCH,
};

const DEFAULT_ROOT: &str = "~/.claude/projects";
const PEEK_BYTES: u64 = 65_536;
const META_CAP: usize = 20_000;
const CODEX_CAP: usize = 5_000;
/// Head reads are I/O-latency bound (per-open cost dominates), so use more threads than cores.
const HEAD_READ_THREADS: usize = 16;
const SEARCH_CAP: usize = 200;
const RUNNING_MS: u64 = 30_000;

#[derive(Clone, Debug)]
pub struct Inputs {
    pub state_dir: PathBuf,
    pub claude_home: PathBuf,
    pub codex_home: PathBuf,
    pub model_catalog: Vec<Value>,
}
#[derive(Clone, Debug)]
pub struct ListOptions {
    pub root: Option<String>,
    pub cap: usize,
    pub now_ms: u64,
    pub hide_reviews: bool,
    pub live_ids: Vec<String>,
}
impl Default for ListOptions {
    fn default() -> Self {
        Self {
            root: None,
            cap: 5000,
            now_ms: 0,
            hide_reviews: false,
            live_ids: Vec::new(),
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct ReadOptions {
    pub root: Option<String>,
    pub source: Option<String>,
    pub file: Option<String>,
}
#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
    pub root: Option<String>,
    pub project: Option<String>,
    pub id: Option<String>,
    pub hide_reviews: bool,
}
#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    Parse(String),
}
impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => e.fmt(f),
            Self::Parse(e) => f.write_str(e),
        }
    }
}
impl std::error::Error for Error {}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub project: String,
    /// Always emitted; Node's list rows carry `cwd: null` rather than omitting it.
    /// VERIFY: wave3-transcripts-1
    pub cwd: Option<Box<RawValue>>,
    pub title: Option<Box<RawValue>>,
    /// Claude rows always carry `blurb` (null when absent); Codex rows omit it.
    /// VERIFY: wave3-transcripts-2
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blurb: Option<Box<RawValue>>,
    pub mtime: f64,
    pub size: u64,
    pub process_live: bool,
    pub activity_recent: bool,
    pub process_state: String,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subagents: Vec<SubagentRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRow {
    pub id: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<Box<RawValue>>,
    /// Always emitted; Node's subagent rows carry `title: null` rather than omitting it.
    /// VERIFY: wave3-transcripts-3
    pub title: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blurb: Option<Box<RawValue>>,
    pub mtime: f64,
    pub size: u64,
    pub process_live: bool,
    pub activity_recent: bool,
    pub process_state: String,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub project: String,
    pub id: String,
    /// Always emitted; Node's search results carry `cwd: null` rather than omitting it.
    /// VERIFY: wave3-transcripts-4
    pub cwd: Option<Box<RawValue>>,
    pub line_index: usize,
    pub role: String,
    pub snippet: Box<RawValue>,
    pub source: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub capped: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Key {
    mtime: f64,
    size: u64,
}
// Raw tokens here are always truthy (never `null`), so an Option round-trips.
#[derive(Clone, Serialize, Deserialize)]
struct Meta {
    key: Key,
    cwd: Option<Box<RawValue>>,
    title: Option<Box<RawValue>>,
    blurb: Option<Box<RawValue>>,
    sidecar: Option<Key>,
}
#[derive(Clone, Serialize, Deserialize)]
struct CodexMeta {
    cwd: Option<Box<RawValue>>,
    title: Box<RawValue>,
    session_id: Option<String>,
    thread_source: Option<String>,
    review: Option<bool>,
}
#[derive(Clone)]
struct TextItem {
    role: String,
    text: TranscriptRawText,
    cwd: Option<Box<RawValue>>,
}
#[derive(Default)]
struct Cache {
    meta: HashMap<PathBuf, Meta>,
    search: HashMap<PathBuf, (Key, Vec<TextItem>)>,
    codex_meta: HashMap<PathBuf, (Key, CodexMeta)>,
    meta_fifo: VecDeque<PathBuf>,
    search_fifo: VecDeque<PathBuf>,
    codex_fifo: VecDeque<PathBuf>,
}
/// Per-file metadata read; injected so tests can fail one entry without OS permissions.
type StatFn = dyn Fn(&Path) -> io::Result<Key> + Send + Sync;
pub struct TranscriptService {
    inputs: Inputs,
    cache: Mutex<Cache>,
    catalog_source: Option<Arc<dyn Fn() -> Vec<Value> + Send + Sync>>,
    stat: Arc<StatFn>,
    persist: Option<PathBuf>,
    dirty: AtomicBool,
    /// Overlapping lists wait, then hit the warm cache, instead of all scanning cold.
    list_lock: Mutex<()>,
}
/// On-disk list metadata, so the first list after a restart skips re-reading file heads.
#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    v: u32,
    meta: Vec<(PathBuf, Meta)>,
    codex: Vec<(PathBuf, Key, CodexMeta)>,
}
const PERSIST_VERSION: u32 = 1;

impl TranscriptService {
    pub fn new(inputs: Inputs) -> Self {
        Self {
            inputs,
            cache: Mutex::new(Cache::default()),
            catalog_source: None,
            stat: Arc::new(file_key),
            persist: None,
            dirty: AtomicBool::new(false),
            list_lock: Mutex::new(()),
        }
    }
    /// Loads list metadata from `file` and saves it back after a list that changed it.
    /// Entries are still validated by mtime+size, so a stale file only costs re-reads.
    pub fn with_persist(mut self, file: PathBuf) -> Self {
        let doc = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Persisted>(&b).ok())
            .filter(|d| d.v == PERSIST_VERSION)
            .unwrap_or_default();
        let cache = self.cache.get_mut().unwrap_or_else(|e| e.into_inner());
        for (path, meta) in doc.meta.into_iter().take(META_CAP) {
            cache.meta_fifo.push_back(path.clone());
            cache.meta.insert(path, meta);
        }
        for (path, key, meta) in doc.codex.into_iter().take(CODEX_CAP) {
            cache.codex_fifo.push_back(path.clone());
            cache.codex_meta.insert(path, (key, meta));
        }
        self.persist = Some(file);
        self
    }
    fn save_persisted(&self) {
        let Some(file) = &self.persist else { return };
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let bytes = {
            let Ok(cache) = self.cache.lock() else { return };
            let doc = Persisted {
                v: PERSIST_VERSION,
                meta: cache
                    .meta_fifo
                    .iter()
                    .filter_map(|p| Some((p.clone(), cache.meta.get(p)?.clone())))
                    .collect(),
                codex: cache
                    .codex_fifo
                    .iter()
                    .filter_map(|p| {
                        let (k, m) = cache.codex_meta.get(p)?;
                        Some((p.clone(), k.clone(), m.clone()))
                    })
                    .collect(),
            };
            serde_json::to_vec(&doc)
        };
        // Best effort: a failed save only means the next restart rescans.
        if let Ok(bytes) = bytes {
            let _ = file
                .parent()
                .map_or(Ok(()), fs::create_dir_all)
                .and_then(|_| crate::fs_atomic::write_atomic(file, &bytes));
        }
    }
    #[cfg(test)]
    fn with_stat(mut self, stat: Arc<StatFn>) -> Self {
        self.stat = stat;
        self
    }
    /// Re-read the model catalogue on every parse, like Node's per-call
    /// `modelsGet` (`model-store.mjs:16-17`), instead of `Inputs.model_catalog`.
    pub fn with_catalog_source(
        mut self,
        source: Arc<dyn Fn() -> Vec<Value> + Send + Sync>,
    ) -> Self {
        self.catalog_source = Some(source);
        self
    }
    /// Drops catalog-derived search items after a model catalog change.
    pub fn clear_search_cache(&self) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.search.clear();
            cache.search_fifo.clear();
        }
    }
    fn catalog(&self) -> std::borrow::Cow<'_, [Value]> {
        match &self.catalog_source {
            Some(source) => std::borrow::Cow::Owned(source()),
            None => std::borrow::Cow::Borrowed(&self.inputs.model_catalog),
        }
    }
    pub fn get_root(&self) -> String {
        fs::read(self.inputs.state_dir.join("sessions-root.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<RootDoc>(&b).ok())
            .map(|d| d.root)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_ROOT.into())
    }
    pub fn set_root(&self, root: &str) -> RootResult {
        self.set_root_checked(root)
            .unwrap_or_else(|error| RootResult {
                ok: false,
                root: None,
                error: Some(error.to_string()),
            })
    }
    pub fn set_root_checked(&self, root: &str) -> Result<RootResult, Error> {
        if root.is_empty() {
            return Ok(RootResult {
                ok: false,
                root: None,
                error: Some("bad root".into()),
            });
        }
        fs::create_dir_all(&self.inputs.state_dir)?;
        static ROOT_WRITE: Mutex<()> = Mutex::new(());
        let _write = ROOT_WRITE
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        crate::fs_atomic::write_atomic(
            &self.inputs.state_dir.join("sessions-root.json"),
            &serde_json::to_vec(&RootDocRef { root })
                .map_err(|error| Error::Parse(error.to_string()))?,
        )?;
        Ok(RootResult {
            ok: true,
            root: Some(root.into()),
            error: None,
        })
    }
    pub fn resolve_root(&self, root: Option<&str>) -> PathBuf {
        let raw = root
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| self.get_root());
        expand_home(&raw, &self.inputs.claude_home)
    }
    /// Lexical resolve plus component confinement; deliberately no case-folding/canonicalization.
    pub fn path_for(&self, project: &str, id: &str, root: Option<&str>) -> Option<PathBuf> {
        if project.is_empty()
            || project.contains(['/', '\\'])
            || id.is_empty()
            || (id.contains(['/', '\\']) && !valid_subagent(id))
        {
            return None;
        }
        let base = absolute_lexical(&self.resolve_root(root));
        let path = absolute_lexical(&base.join(project).join(format!("{id}.jsonl")));
        confined(&base, &path).then_some(path)
    }
    pub fn path_for_codex(&self, file: &str) -> Option<PathBuf> {
        if file.is_empty() {
            return None;
        }
        let base = absolute_lexical(&self.inputs.codex_home);
        let path = absolute_lexical(&base.join(file));
        confined(&base, &path).then_some(path)
    }
    pub fn list(&self, o: &ListOptions) -> Result<Vec<SessionRow>, Error> {
        let _one_at_a_time = self.list_lock.lock().unwrap_or_else(|e| e.into_inner());
        let rows = self.list_rows(o);
        self.save_persisted();
        rows
    }
    /// Fills the meta cache for every Claude head in parallel; the serial walk then hits cache.
    fn prewarm_claude(&self, root: &Path) {
        let mut jobs: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
        let Ok(projects) = crate::fs_sorted::read_dir(root) else { return };
        for project in projects.flatten() {
            let Ok(entries) = crate::fs_sorted::read_dir(project.path()) else { continue };
            for e in entries.flatten() {
                let name = os_string(e.file_name());
                let Some(id) = name.strip_suffix(".jsonl") else { continue };
                let subs = project.path().join(id).join("subagents");
                jobs.push((e.path(), None));
                let Ok(subs) = crate::fs_sorted::read_dir(subs) else { continue };
                for s in subs.flatten() {
                    let sname = os_string(s.file_name());
                    if let Some(aid) = sname.strip_suffix(".jsonl") {
                        let side = s.path().with_file_name(format!("{aid}.meta.json"));
                        jobs.push((s.path(), Some(side)));
                    }
                }
            }
        }
        par_each(&jobs, |(path, side)| {
            let _ = self.peek_meta(path, side.as_deref());
        });
    }
    fn list_rows(&self, o: &ListOptions) -> Result<Vec<SessionRow>, Error> {
        let root = self.resolve_root(o.root.as_deref());
        self.prewarm_claude(&root);
        let mut rows = Vec::new();
        let project_entries = match crate::fs_sorted::read_dir(&root) {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if let Some(project_entries) = project_entries {
            for p in project_entries {
                let p = match p {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if !p.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let project = os_string(p.file_name());
                let entries = match crate::fs_sorted::read_dir(p.path()) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                for e in entries {
                    let e = match e {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let name = os_string(e.file_name());
                    if !name.ends_with(".jsonl") {
                        continue;
                    }
                    let path = e.path();
                    // Per-file metadata failure drops the row, like Node's `stat` catch
                    // in `listSessions`; an unreadable root stays fatal above.
                    let Some(meta) = self.peek_meta(&path, None).ok().flatten() else {
                        continue;
                    };
                    let key = match file_key(&path) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    // `f.slice(0, -6)`: exactly one suffix, not every repetition.
                    // VERIFY: wave3-transcripts-9
                    let id = name.strip_suffix(".jsonl").unwrap_or_default().to_owned();
                    let subagents = self.list_subagents(&p.path(), &id, o)?;
                    let process_live = live(o, &id);
                    rows.push(SessionRow {
                        id: id.clone(),
                        project: project.clone(),
                        cwd: meta.cwd,
                        title: meta.title,
                        blurb: Some(meta.blurb.unwrap_or_else(raw_null)),
                        mtime: key.mtime,
                        size: key.size,
                        process_live,
                        activity_recent: recent(o.now_ms, key.mtime),
                        process_state: process_state(process_live),
                        running: process_live,
                        source: Some("claude".into()),
                        session_id: None,
                        file: None,
                        subagents,
                        agent_id: None,
                    });
                }
            }
        }
        rows.extend(self.list_codex(o)?);
        rows.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
        rows.truncate(o.cap);
        Ok(rows)
    }
    /// `Ok(None)` is not found; other filesystem errors are preserved. Success stays in parser JSON form.
    pub fn read(&self, project: &str, id: &str, o: &ReadOptions) -> Result<Option<String>, Error> {
        let codex = o.source.as_deref() == Some("codex");
        let path = if codex {
            match o.file.as_deref() {
                Some(file) => self.path_for_codex(file).filter(|p| p.is_file()),
                None => self.find_codex_by_id(id),
            }
        } else {
            let mut p = self
                .path_for(project, id, o.root.as_deref())
                .filter(|p| p.is_file());
            if p.is_none() && !id.contains(['/', '\\']) {
                match crate::fs_sorted::read_dir(self.resolve_root(o.root.as_deref())) {
                    Ok(dirs) => {
                        for d in dirs {
                            let d = match d {
                                Ok(value) => value,
                                Err(_) => continue,
                            };
                            let candidate = d.path().join(format!("{id}.jsonl"));
                            if candidate.is_file() {
                                p = Some(candidate);
                                break;
                            }
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            p
        };
        let Some(path) = path else { return Ok(None) };
        let raw = match read_node_utf8(&path) {
            Ok(v) => v,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let parsed = if codex {
            parse_codex(&raw)
        } else {
            parse_claude(&raw, &self.catalog())
        };
        match parsed {
            Ok(v) => Ok(Some(v.to_json().map_err(Error::Parse)?)),
            Err(e) => Err(Error::Parse(e)),
        }
    }
    fn find_codex_by_id(&self, id: &str) -> Option<PathBuf> {
        if id.is_empty() {
            return None;
        }
        let mut files = Vec::new();
        for directory in ["sessions", "archived_sessions"] {
            collect_rollouts(&self.inputs.codex_home.join(directory), &mut files);
        }
        files.into_iter().find(|path| codex_id(path) == id)
    }
    pub fn subagents(
        &self,
        cwd: &str,
        id: &str,
        root: Option<&str>,
        now_ms: u64,
        live_ids: &[String],
    ) -> Result<Vec<SubagentRow>, Error> {
        if cwd.is_empty() || id.is_empty() {
            return Ok(Vec::new());
        }
        let o = ListOptions {
            now_ms,
            live_ids: live_ids.to_vec(),
            ..ListOptions::default()
        };
        self.list_subagents(&self.resolve_root(root).join(encode_cwd(cwd)), id, &o)
    }
    /// Current implementation supports valid Unicode scalar search terms. Raw
    /// scalar query convenience wrapper.
    pub fn search(&self, q: &str, o: &SearchOptions) -> Result<SearchResponse, Error> {
        self.search_units(&q.encode_utf16().collect::<Vec<_>>(), o)
    }
    /// Searches the exact JavaScript UTF-16 query, including unpaired surrogates.
    pub fn search_units(&self, query: &[u16], o: &SearchOptions) -> Result<SearchResponse, Error> {
        if query.is_empty() {
            return Ok(SearchResponse {
                results: Vec::new(),
                capped: false,
            });
        }
        let lowered_query = lowercase_units(query);
        let targets = self.search_targets(o)?;
        let mut results = Vec::new();
        for (project, id, source, path) in targets {
            let items = self.search_items(&path, source == "codex").ok();
            if o.hide_reviews
                && source == "codex"
                && items.as_ref().is_some_and(|items| {
                    items
                        .iter()
                        .find(|item| item.role == "user")
                        .is_some_and(|item| raw_text_starts_review(&item.text))
                })
            {
                continue;
            }
            if contains_lowered(&id.encode_utf16().collect::<Vec<_>>(), &lowered_query) {
                results.push(SearchResult {
                    project,
                    id: id.clone(),
                    // Node's `items?.[0]?.cwd || null`: a falsy cwd becomes null.
                    // VERIFY: wave3-transcripts-11
                    cwd: items
                        .as_ref()
                        .and_then(|items| items.first())
                        .and_then(|i| i.cwd.clone())
                        .filter(|cwd| raw_truthy(cwd)),
                    line_index: 0,
                    role: "id".into(),
                    snippet: string_token(&id),
                    source,
                });
            } else if let Some(items) = items {
                for (index, item) in items.iter().enumerate() {
                    if let Ok(Some(at)) = find_case_insensitive_units(&item.text, &lowered_query) {
                        results.push(SearchResult {
                            project: project.clone(),
                            id: id.clone(),
                            cwd: item.cwd.clone(),
                            line_index: index,
                            role: item.role.clone(),
                            snippet: snippet_token_raw_units(&item.text, at, lowered_query.len()),
                            source: source.clone(),
                        });
                        if results.len() == SEARCH_CAP {
                            return Ok(SearchResponse {
                                results,
                                capped: true,
                            });
                        }
                    }
                }
            }
            if results.len() == SEARCH_CAP {
                return Ok(SearchResponse {
                    results,
                    capped: true,
                });
            }
        }
        Ok(SearchResponse {
            results,
            capped: false,
        })
    }
    fn peek_meta(&self, path: &Path, sidecar: Option<&Path>) -> Result<Option<Meta>, Error> {
        let key = match (self.stat)(path) {
            Ok(v) => v,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let side_key = sidecar.and_then(|p| file_key(p).ok());
        if let Ok(c) = self.cache.lock() {
            if let Some(hit) = c.meta.get(path) {
                let side_matches = match (&hit.sidecar, &side_key) {
                    (None, None) => true,
                    (Some(a), Some(b)) => same_key(a, b),
                    _ => false,
                };
                if same_key(&hit.key, &key) && side_matches {
                    return Ok(Some(hit.clone()));
                }
            }
        }
        let head = read_head(path, PEEK_BYTES).unwrap_or_default();
        let (mut cwd, mut title, mut blurb) = (None, None, None);
        for line in head.split('\n') {
            let Ok(e) = serde_json::from_str::<PeekEvent>(line.trim_end_matches('\r')) else {
                continue;
            };
            if cwd.is_none() && e.cwd.as_deref().is_some_and(raw_truthy) {
                cwd = e.cwd
            }
            if e.kind.as_deref() == Some("ai-title") && e.title.as_deref().is_some_and(raw_truthy) {
                title = e.title
            }
            if blurb.is_none()
                && e.kind.as_deref() == Some("user")
                && !e.is_meta.unwrap_or(false)
                && !e.is_compact.unwrap_or(false)
            {
                if let Some(token) = e.message.and_then(|m| first_user_text(m.content)) {
                    if let Ok(text) = TranscriptRawText::from_json_token(token.get().to_owned()) {
                        let display = text
                            .units()
                            .map(|u| String::from_utf16_lossy(&u))
                            .unwrap_or_default();
                        // Node: `const flat = text.replace(...).trim(); if (flat) blurb = ...`
                        // VERIFY: wave3-transcripts-5
                        let flat = flatten_units(&text, 140);
                        if !flat.is_empty() && !command_wrapper(&display) {
                            blurb = Some(RawValue::from_string(utf16_json_token(&flat)).unwrap());
                        }
                    }
                }
            }
        }
        if let Some(sidecar) = sidecar {
            if let Ok(raw) = read_node_utf8(sidecar) {
                if let Ok(m) = serde_json::from_str::<Sidecar>(&raw) {
                    // Node: `if (meta.agentType) metaTitle = meta.description
                    // ? `${agentType}: ${description}` : agentType`, then
                    // `title: metaTitle || peekTitle`. Both checks are JS
                    // truthiness, and the template literal stringifies non-strings.
                    // VERIFY: wave3-transcripts-6
                    if let Some(kind) = m.agent_type.filter(|kind| js_truthy(kind)) {
                        let mut units = js_string_units(&kind);
                        if let Some(description) = m.description.filter(|d| js_truthy(d)) {
                            units.extend(": ".encode_utf16());
                            units.extend(js_string_units(&description));
                        }
                        if !units.is_empty() {
                            title = Some(RawValue::from_string(utf16_json_token(&units)).unwrap());
                        }
                    }
                }
            }
        }
        let meta = Meta {
            key,
            cwd,
            title,
            blurb,
            sidecar: side_key,
        };
        if let Ok(mut c) = self.cache.lock() {
            if !c.meta.contains_key(path) {
                c.meta_fifo.push_back(path.into());
            }
            c.meta.insert(path.into(), meta.clone());
            evict_meta(&mut c);
            self.dirty.store(true, Ordering::Relaxed);
        }
        Ok(Some(meta))
    }
    fn list_subagents(
        &self,
        project: &Path,
        parent: &str,
        o: &ListOptions,
    ) -> Result<Vec<SubagentRow>, Error> {
        let dir = project.join(parent).join("subagents");
        let entries = match crate::fs_sorted::read_dir(dir) {
            Ok(v) => v,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Ok(Vec::new()),
        };
        let mut rows = Vec::new();
        for e in entries.flatten() {
            let name = os_string(e.file_name());
            if !name.ends_with(".jsonl") {
                continue;
            }
            let aid = name.strip_suffix(".jsonl").unwrap_or_default().to_owned();
            let side = e.path().with_file_name(format!("{aid}.meta.json"));
            // Same per-entry skip as `listSubagents` in Node; one bad entry keeps its siblings.
            let Some(meta) = self.peek_meta(&e.path(), Some(&side)).ok().flatten() else {
                continue;
            };
            let key = match file_key(&e.path()) {
                Ok(k) => k,
                Err(_) => continue,
            };
            let process_live = live(o, &aid);
            rows.push(SubagentRow {
                id: format!("{parent}/subagents/{aid}"),
                agent_id: aid.clone(),
                project: None,
                cwd: None,
                title: Some(meta.title.unwrap_or_else(raw_null)),
                blurb: Some(meta.blurb.unwrap_or_else(raw_null)),
                mtime: key.mtime,
                size: key.size,
                process_live,
                activity_recent: recent(o.now_ms, key.mtime),
                process_state: process_state(process_live),
                running: process_live,
                source: None,
                session_id: None,
                file: None,
            });
        }
        Ok(rows)
    }
    fn list_codex(&self, o: &ListOptions) -> Result<Vec<SessionRow>, Error> {
        let mut files = Vec::new();
        for d in ["sessions", "archived_sessions"] {
            collect_rollouts(&self.inputs.codex_home.join(d), &mut files)
        }
        par_each(&files, |p| {
            if let Ok(key) = file_key(p) {
                self.codex_metadata(p, &key, o.hide_reviews);
            }
        });
        let mut rows = Vec::new();
        let mut sources = HashMap::new();
        for p in files {
            let key = match file_key(&p) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let id = codex_id(&p);
            let Some(metadata) = self.codex_metadata(&p, &key, o.hide_reviews) else {
                continue;
            };
            if o.hide_reviews && metadata.review != Some(false) {
                continue;
            }
            sources.insert(id.clone(), metadata.thread_source.clone());
            let process_live = live(o, &id);
            let file = p
                .strip_prefix(&self.inputs.codex_home)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            rows.push(SessionRow {
                id: id.clone(),
                project: "<codex>".into(),
                cwd: metadata.cwd,
                title: Some(metadata.title),
                blurb: None,
                mtime: key.mtime,
                size: key.size,
                process_live,
                activity_recent: recent(o.now_ms, key.mtime),
                process_state: process_state(process_live),
                running: process_live,
                source: Some("codex".into()),
                session_id: metadata.session_id,
                file: Some(file),
                subagents: Vec::new(),
                agent_id: None,
            });
        }
        let by_id = rows
            .iter()
            .map(|row| (row.id.clone(), row.clone()))
            .collect::<HashMap<_, _>>();
        let mut nested = Vec::new();
        for row in rows.iter_mut() {
            let parent = row.session_id.as_ref().and_then(|sid| by_id.get(sid));
            if sources.get(&row.id).and_then(Option::as_deref) == Some("subagent")
                && parent.is_some_and(|parent| parent.id != row.id)
            {
                let parent_id = parent.unwrap().id.clone();
                nested.push((parent_id, row.clone()));
            }
        }
        let child_ids = nested
            .iter()
            .map(|(_, child)| child.id.clone())
            .collect::<std::collections::HashSet<_>>();
        rows.retain(|row| !child_ids.contains(&row.id));
        for (parent_id, child) in nested {
            if let Some(parent) = rows.iter_mut().find(|row| row.id == parent_id) {
                parent.subagents.push(SubagentRow {
                    id: child.id.clone(),
                    agent_id: child.id,
                    project: Some(child.project),
                    cwd: child.cwd.or_else(|| Some(raw_null())),
                    title: child.title,
                    blurb: child.blurb,
                    mtime: child.mtime,
                    size: child.size,
                    process_live: child.process_live,
                    activity_recent: child.activity_recent,
                    process_state: child.process_state,
                    running: child.running,
                    source: child.source,
                    session_id: child.session_id,
                    file: child.file,
                });
            }
        }
        for row in &mut rows {
            row.subagents.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
        }
        Ok(rows)
    }
    fn codex_metadata(&self, path: &Path, key: &Key, hide_reviews: bool) -> Option<CodexMeta> {
        let mut metadata = self.cache.lock().ok().and_then(|cache| {
            cache
                .codex_meta
                .get(path)
                .and_then(|(old_key, value)| same_key(old_key, key).then(|| value.clone()))
        });
        let mut changed = metadata.is_none();
        if metadata.is_none() {
            let head = read_head(path, PEEK_BYTES).unwrap_or_default();
            let parsed = parse_codex_with_tool_limit(&head, 500).ok()?;
            let mut session_id = None;
            let mut thread_source = None;
            let mut not_review = false;
            for line in head.split('\n') {
                let Ok(event) =
                    serde_json::from_str::<CodexHeaderEvent>(line.trim_end_matches('\r'))
                else {
                    continue;
                };
                if event.kind != "session_meta" {
                    continue;
                }
                let Some(payload) = event.payload else {
                    continue;
                };
                let Ok(payload) = serde_json::from_str::<CodexHeaderPayload>(payload.get()) else {
                    continue;
                };
                if session_id.is_none() {
                    session_id = payload.session_id.or(payload.id);
                }
                if thread_source.is_none() {
                    thread_source = payload.thread_source.as_deref().and_then(raw_string);
                }
                if payload
                    .source
                    .as_deref()
                    .is_some_and(source_is_known_non_review)
                {
                    not_review = true;
                }
                break;
            }
            let title = parsed
                .raw_messages()
                .find(|message| message.role == "user" && message.kind == "text")
                .and_then(|message| {
                    RawValue::from_string(serde_json::to_string(message.text).ok()?).ok()
                });
            let review = title.as_ref().map(|value| raw_token_starts_review(value));
            metadata = Some(CodexMeta {
                // `if (!cwd && e.payload.cwd) cwd = e.payload.cwd` (`sessions.mjs:129`):
                // a falsy token (notably `""`) stays `null` in the list row, and
                // the raw token keeps Node's JSON type for a non-string cwd.
                // VERIFY: wave5-task-reg-11
                // VERIFY: wave8-numeric_cwd-13
                cwd: codex_cwd(&head),
                title: title.unwrap_or_else(|| string_token("")),
                session_id,
                thread_source,
                review: review.or_else(|| not_review.then_some(false)),
            });
        }
        let mut metadata = metadata?;
        if raw_string(&metadata.title).as_deref() == Some("") {
            // Node's `` `Codex ${id.slice(-8)}` `` slices UTF-16 units, so use
            // units here too; a byte slice can panic inside a multibyte name.
            // VERIFY: wave3-transcripts-7
            let id_units: Vec<u16> = codex_id(path).encode_utf16().collect();
            let mut units: Vec<u16> = "Codex ".encode_utf16().collect();
            units.extend_from_slice(&id_units[id_units.len().saturating_sub(8)..]);
            metadata.title = RawValue::from_string(utf16_json_token(&units)).unwrap();
        }
        if hide_reviews && metadata.review.is_none() {
            let first_user = scan_codex_first_user_text(path).ok()?;
            metadata.review = Some(first_user.is_some_and(|text| raw_text_starts_review(&text)));
            changed = true;
        }
        if changed {
            self.dirty.store(true, Ordering::Relaxed);
        }
        if let Ok(mut cache) = self.cache.lock() {
            if !cache.codex_meta.contains_key(path) {
                cache.codex_fifo.push_back(path.into());
            }
            cache
                .codex_meta
                .insert(path.into(), (key.clone(), metadata.clone()));
            while cache.codex_meta.len() > CODEX_CAP {
                let Some(old) = cache.codex_fifo.pop_front() else {
                    break;
                };
                cache.codex_meta.remove(&old);
            }
        }
        Some(metadata)
    }
    fn search_targets(
        &self,
        o: &SearchOptions,
    ) -> Result<Vec<(String, String, String, PathBuf)>, Error> {
        let mut out = Vec::new();
        if let (Some(project), Some(id)) = (o.project.as_deref(), o.id.as_deref()) {
            if project == "<codex>" {
                let mut fs = Vec::new();
                for d in ["sessions", "archived_sessions"] {
                    collect_rollouts(&self.inputs.codex_home.join(d), &mut fs)
                }
                if let Some(p) = fs.into_iter().find(|p| codex_id(p) == id) {
                    out.push((project.into(), id.into(), "codex".into(), p))
                }
            } else if let Some(p) = self
                .path_for(project, id, o.root.as_deref())
                .filter(|p| p.is_file())
            {
                out.push((project.into(), id.into(), "claude".into(), p))
            }
            return Ok(out);
        }
        let projects = match crate::fs_sorted::read_dir(self.resolve_root(o.root.as_deref())) {
            Ok(projects) => Some(projects),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if let Some(projects) = projects {
            for p in projects.flatten() {
                if !p.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                if let Ok(files) = crate::fs_sorted::read_dir(p.path()) {
                    for f in files.flatten() {
                        let n = os_string(f.file_name());
                        if n.ends_with(".jsonl") {
                            out.push((
                                os_string(p.file_name()),
                                n.strip_suffix(".jsonl").unwrap_or_default().into(),
                                "claude".into(),
                                f.path(),
                            ))
                        }
                    }
                }
            }
        }
        let mut codex = Vec::new();
        for d in ["sessions", "archived_sessions"] {
            collect_rollouts(&self.inputs.codex_home.join(d), &mut codex)
        }
        out.extend(
            codex
                .into_iter()
                .map(|p| ("<codex>".into(), codex_id(&p), "codex".into(), p)),
        );
        Ok(out)
    }
    fn search_items(&self, path: &Path, codex: bool) -> Result<Vec<TextItem>, Error> {
        let key = file_key(path)?;
        if let Ok(c) = self.cache.lock() {
            if let Some((k, v)) = c.search.get(path) {
                if same_key(k, &key) {
                    return Ok(v.clone());
                }
            }
        }
        let raw = read_node_utf8(path)?;
        let catalog = self.catalog();
        let parsed = if codex {
            parse_codex_with_tool_limit(&raw, 500)
        } else {
            parse_claude_with_tool_limit(&raw, &catalog, 500)
        }
        .map_err(Error::Parse)?;
        let message_cwds = if codex {
            // Node: `cwd = e.payload.cwd || null` — a falsy token stays null, and
            // the raw token keeps a non-string cwd's JSON type.
            // VERIFY: wave3-transcripts-12
            // VERIFY: wave8-numeric_cwd-14
            let cwd = codex_cwd(&raw);
            vec![cwd; parsed.raw_messages().count()]
        } else {
            let mut learned = None;
            let mut message_cwds = Vec::new();
            for line in raw.lines() {
                // `if (e.cwd && !cwd) cwd = e.cwd` (`sessions.mjs:648`) reads the
                // event Node's `JSON.parse` kept, so learn it before the stricter
                // transcript parse can drop the line. Any truthy raw token counts.
                // VERIFY: wave8-numeric_cwd-16
                if learned.is_none() {
                    learned = claude_event_cwd(line);
                }
                let Ok(event) = parse_claude_with_tool_limit(line, &catalog, 500) else {
                    continue;
                };
                for _ in 0..event.raw_messages().count() {
                    message_cwds.push(learned.clone());
                }
            }
            message_cwds
        };
        let items = parsed
            .raw_messages()
            .enumerate()
            .map(|(index, message)| {
                let text = if message.kind == "toolUse" {
                    let name = message.name.and_then(Value::as_str).unwrap_or("?");
                    prepend_text(&format!("[tool: {name}] "), message.text)
                        .unwrap_or_else(|_| message.text.clone())
                } else {
                    message.text.clone()
                };
                TextItem {
                    role: message.role.into(),
                    text,
                    cwd: message_cwds.get(index).cloned().flatten(),
                }
            })
            .collect::<Vec<_>>();
        if let Ok(mut c) = self.cache.lock() {
            if !c.search.contains_key(path) {
                c.search_fifo.push_back(path.into());
            }
            c.search.insert(path.into(), (key, items.clone()));
            evict_search(&mut c);
        }
        Ok(items)
    }
}

#[derive(Deserialize)]
struct RootDoc {
    root: String,
}
#[derive(Serialize)]
struct RootDocRef<'a> {
    root: &'a str,
}
#[derive(Deserialize)]
struct PeekEvent {
    #[serde(rename = "type")]
    kind: Option<String>,
    cwd: Option<Box<RawValue>>,
    #[serde(rename = "aiTitle")]
    title: Option<Box<RawValue>>,
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
    #[serde(rename = "isCompactSummary")]
    is_compact: Option<bool>,
    message: Option<PeekMessage>,
}
#[derive(Deserialize)]
struct PeekMessage {
    content: Box<RawValue>,
}
#[derive(Deserialize)]
struct Content {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<Box<RawValue>>,
}
#[derive(Deserialize)]
struct Sidecar {
    #[serde(rename = "agentType")]
    agent_type: Option<Box<RawValue>>,
    description: Option<Box<RawValue>>,
}
#[derive(Deserialize)]
struct CodexHeaderEvent {
    #[serde(rename = "type")]
    kind: String,
    payload: Option<Box<RawValue>>,
}
#[derive(Deserialize)]
struct CodexHeaderPayload {
    session_id: Option<String>,
    id: Option<String>,
    thread_source: Option<Box<RawValue>>,
    source: Option<Box<RawValue>>,
}
#[derive(Deserialize)]
struct CwdEvent {
    cwd: Option<Box<RawValue>>,
}
#[derive(Deserialize)]
struct CodexCwdPayload {
    cwd: Option<Box<RawValue>>,
}
/// `if (!cwd && e.payload.cwd) cwd = e.payload.cwd` (`sessions.mjs:129`): the
/// first truthy `session_meta.payload.cwd`, kept as a raw token so a non-string
/// value keeps Node's JSON type. The transcript parser stores only string cwd
/// tokens, so the list and search rows read the events themselves.
/// VERIFY: wave8-numeric_cwd-12
fn codex_cwd(raw: &str) -> Option<Box<RawValue>> {
    for line in raw.lines() {
        let Ok(event) = serde_json::from_str::<CodexHeaderEvent>(line.trim_end_matches('\r'))
        else {
            continue;
        };
        if event.kind != "session_meta" {
            continue;
        }
        let Some(payload) = event.payload else {
            continue;
        };
        let Ok(payload) = serde_json::from_str::<CodexCwdPayload>(payload.get()) else {
            continue;
        };
        if let Some(cwd) = payload.cwd.filter(|token| raw_truthy(token)) {
            return Some(cwd);
        }
    }
    None
}
/// `if (e.cwd && !cwd) cwd = e.cwd` (`sessions.mjs:648`) for one Claude event.
/// VERIFY: wave8-numeric_cwd-11
fn claude_event_cwd(line: &str) -> Option<Box<RawValue>> {
    let event = serde_json::from_str::<CwdEvent>(line.trim_end_matches('\r')).ok()?;
    event.cwd.filter(|token| raw_truthy(token))
}
fn first_user_text(raw: Box<RawValue>) -> Option<Box<RawValue>> {
    if raw.get().starts_with('"') {
        return Some(raw);
    }
    serde_json::from_str::<Vec<Content>>(raw.get())
        .ok()?
        .into_iter()
        .find(|b| b.kind.as_deref() == Some("text"))?
        .text
}
fn expand_home(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.into();
    }
    raw.strip_prefix("~/")
        .or_else(|| raw.strip_prefix("~\\"))
        .map(|s| home.join(s))
        .unwrap_or_else(|| raw.into())
}
fn absolute_lexical(path: &Path) -> PathBuf {
    let p = if path.is_absolute() {
        path.into()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            v => out.push(v.as_os_str()),
        }
    }
    out
}
fn confined(base: &Path, path: &Path) -> bool {
    path == base || path.starts_with(base)
}
fn valid_subagent(id: &str) -> bool {
    let p: Vec<_> = id.split('/').collect();
    // Node's `/^[^\\/]+\/subagents\/agent-[^\\/]+$/` needs a non-empty suffix.
    // VERIFY: wave3-transcripts-10
    p.len() == 3
        && p[0..2].iter().all(|s| !s.is_empty())
        && p[1] == "subagents"
        && p[2]
            .strip_prefix("agent-")
            .is_some_and(|suffix| !suffix.is_empty())
        && !id.contains('\\')
}
fn file_key(path: &Path) -> io::Result<Key> {
    let m = fs::metadata(path)?;
    let modified = m
        .modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    Ok(Key {
        mtime: node_mtime_ms(modified),
        size: m.len(),
    })
}
fn node_mtime_ms(modified: std::time::Duration) -> f64 {
    modified.as_secs() as f64 * 1000.0 + modified.subsec_nanos() as f64 / 1_000_000.0
}
fn same_key(a: &Key, b: &Key) -> bool {
    a.mtime == b.mtime && a.size == b.size
}
fn evict_meta(cache: &mut Cache) {
    while cache.meta.len() > META_CAP {
        let Some(path) = cache.meta_fifo.pop_front() else {
            break;
        };
        cache.meta.remove(&path);
    }
}
fn evict_search(cache: &mut Cache) {
    while cache.search.len() > 200 {
        let Some(path) = cache.search_fifo.pop_front() else {
            break;
        };
        cache.search.remove(&path);
    }
}
/// Runs `f` over `items` on a small scoped thread pool (no rayon dependency).
fn par_each<T: Sync>(items: &[T], f: impl Fn(&T) + Sync) {
    let threads = HEAD_READ_THREADS.min(items.len());
    if threads <= 1 {
        items.iter().for_each(f);
        return;
    }
    let next = AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                while let Some(item) = items.get(next.fetch_add(1, Ordering::Relaxed)) {
                    f(item);
                }
            });
        }
    });
}
fn read_head(path: &Path, n: u64) -> io::Result<String> {
    let f = fs::File::open(path)?;
    let mut b = Vec::new();
    f.take(n).read_to_end(&mut b)?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}
fn read_node_utf8(path: &Path) -> io::Result<String> {
    Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
}
fn os_string(s: std::ffi::OsString) -> String {
    s.to_string_lossy().into_owned()
}
fn string_token(s: &str) -> Box<RawValue> {
    RawValue::from_string(serde_json::to_string(s).unwrap()).unwrap()
}
/// An explicit JSON `null` token for keys Node always emits.
fn raw_null() -> Box<RawValue> {
    RawValue::from_string("null".into()).unwrap()
}
/// JavaScript truthiness of a raw JSON value: false for null, false, 0 and "".
fn js_truthy(token: &RawValue) -> bool {
    if token.get().starts_with('"') {
        return token.get() != "\"\"";
    }
    serde_json::from_str::<Value>(token.get())
        .map(|value| match value {
            Value::Null => false,
            Value::Bool(value) => value,
            Value::Number(value) => value.as_f64().unwrap_or(0.0) != 0.0,
            Value::String(value) => !value.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        })
        .unwrap_or(true)
}
/// JavaScript `String(value)` as UTF-16 units; a string token keeps lone surrogates.
fn js_string_units(token: &RawValue) -> Vec<u16> {
    if token.get().starts_with('"') {
        return TranscriptRawText::from_json_token(token.get().to_owned())
            .and_then(|text| text.units())
            .unwrap_or_default();
    }
    let mut units = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(token.get()) {
        js_string_value(&value, &mut units);
    }
    units
}
fn js_string_value(value: &Value, units: &mut Vec<u16>) {
    match value {
        Value::Null => units.extend("null".encode_utf16()),
        Value::Bool(value) => units.extend(value.to_string().encode_utf16()),
        Value::Number(value) => units.extend(
            match (value.as_i64(), value.as_u64()) {
                (Some(int), _) => int.to_string(),
                (_, Some(uint)) => uint.to_string(),
                _ => value.as_f64().unwrap_or(0.0).to_string(),
            }
            .encode_utf16(),
        ),
        Value::String(value) => units.extend(value.encode_utf16()),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    units.push(',' as u16);
                }
                if !item.is_null() {
                    js_string_value(item, units);
                }
            }
        }
        Value::Object(_) => units.extend("[object Object]".encode_utf16()),
    }
}
fn flatten_units(text: &TranscriptRawText, limit: usize) -> Vec<u16> {
    let Ok(units) = text.units() else {
        return Vec::new();
    };
    let mut flat = Vec::new();
    let mut space = false;
    for unit in units {
        if is_js_whitespace(unit) {
            space = !flat.is_empty();
        } else {
            if space {
                flat.push(' ' as u16);
            }
            space = false;
            flat.push(unit);
        }
    }
    flat.truncate(limit);
    flat
}
fn prepend_text(prefix: &str, text: &TranscriptRawText) -> Result<TranscriptRawText, String> {
    let mut units = prefix.encode_utf16().collect::<Vec<_>>();
    units.extend(text.units()?);
    TranscriptRawText::from_json_token(utf16_json_token(&units))
}
fn utf16_json_token(units: &[u16]) -> String {
    let mut token = String::from("\"");
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        if (0xd800..=0xdbff).contains(&unit)
            && units
                .get(i + 1)
                .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
        {
            let scalar = 0x10000
                + (((unit as u32 - 0xd800) << 10) | (*units.get(i + 1).unwrap() as u32 - 0xdc00));
            token.push(char::from_u32(scalar).unwrap());
            i += 2;
            continue;
        }
        match unit {
            0x0022 => token.push_str("\\\""),
            0x005c => token.push_str("\\\\"),
            0x0008 => token.push_str("\\b"),
            0x000c => token.push_str("\\f"),
            0x000a => token.push_str("\\n"),
            0x000d => token.push_str("\\r"),
            0x0009 => token.push_str("\\t"),
            0x0000..=0x001f | 0xd800..=0xdfff => {
                use std::fmt::Write as _;
                write!(&mut token, "\\u{unit:04x}").unwrap();
            }
            _ => token.push(char::from_u32(unit as u32).unwrap()),
        }
        i += 1;
    }
    token.push('\"');
    token
}
fn is_js_whitespace(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028..=0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn find_case_insensitive_units(
    text: &TranscriptRawText,
    lowered_query: &[u16],
) -> Result<Option<usize>, String> {
    if lowered_query.is_empty() {
        return Ok(Some(0));
    }
    let lowered_text = lowercase_units(&text.units()?);
    Ok(lowered_text
        .windows(lowered_query.len())
        .position(|window| window == lowered_query))
}
fn contains_lowered(text: &[u16], lowered_query: &[u16]) -> bool {
    if lowered_query.is_empty() {
        return true;
    }
    lowercase_units(text)
        .windows(lowered_query.len())
        .any(|window| window == lowered_query)
}
fn lowercase_units(units: &[u16]) -> Vec<u16> {
    let mut lowered = Vec::new();
    let mut scalar_span = String::new();
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if (0xd800..=0xdbff).contains(&unit)
            && units
                .get(index + 1)
                .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
        {
            let scalar = 0x10000
                + (((unit as u32 - 0xd800) << 10)
                    | (*units.get(index + 1).unwrap() as u32 - 0xdc00));
            scalar_span.push(char::from_u32(scalar).unwrap());
            index += 2;
        } else if (0xd800..=0xdfff).contains(&unit) {
            append_lowercase_span(&mut lowered, &scalar_span);
            scalar_span.clear();
            lowered.push(unit);
            index += 1;
        } else {
            scalar_span.push(char::from_u32(unit as u32).unwrap());
            index += 1;
        }
    }
    append_lowercase_span(&mut lowered, &scalar_span);
    lowered
}
fn append_lowercase_span(lowered: &mut Vec<u16>, span: &str) {
    let lowercase = span.to_lowercase();
    lowered.extend(lowercase.encode_utf16());
}
fn snippet_token_raw_units(text: &TranscriptRawText, at: usize, query_len: usize) -> Box<RawValue> {
    let Ok(units) = text.units() else {
        return string_token("");
    };
    let mut end = (at + query_len + 60).min(units.len());
    // `at` indexes the lowercased buffer, which can be longer than `units`
    // (İ lowercases to two units), so `start` may exceed `end`; JS slice
    // returns "" there instead of panicking.
    // VERIFY: wave3-transcripts-8
    let mut start = at.saturating_sub(60).min(end);
    while start < end && is_js_whitespace(units[start]) {
        start += 1;
    }
    while end > start && is_js_whitespace(units[end - 1]) {
        end -= 1;
    }
    let mut out = Vec::new();
    if start > 0 {
        out.push('…' as u16);
    }
    out.extend_from_slice(&units[start..end]);
    if end < units.len() {
        out.push('…' as u16);
    }
    RawValue::from_string(utf16_json_token(&out)).unwrap()
}
fn raw_text_starts_review(text: &TranscriptRawText) -> bool {
    const PREFIX: &str =
        "the following is the codex agent history whose request action you are assessing.";
    let Ok(units) = text.units() else {
        return false;
    };
    let start = units
        .iter()
        .position(|unit| !is_js_whitespace(*unit))
        .unwrap_or(units.len());
    let expected = PREFIX.encode_utf16().collect::<Vec<_>>();
    units
        .get(start..start + expected.len())
        .is_some_and(|actual| {
            actual.iter().zip(expected).all(|(actual, expected)| {
                let actual = if (b'A' as u16..=b'Z' as u16).contains(actual) {
                    actual + 32
                } else {
                    *actual
                };
                actual == expected
            })
        })
}
fn raw_token_starts_review(token: &RawValue) -> bool {
    TranscriptRawText::from_json_token(token.get().to_owned())
        .is_ok_and(|text| raw_text_starts_review(&text))
}
/// JavaScript truthiness of a raw token, used where Node guards with `if (x)`.
/// Numeric tokens are compared as `f64` via [`js_truthy`], so every JSON
/// spelling of zero (`0`, `0.0`, `-0`, `-0.0`, `0e0`) is falsy; a text compare
/// against `"0"` alone would let those forms through.
// VERIFY: wave7-truthy-1
fn raw_truthy(token: &RawValue) -> bool {
    js_truthy(token)
}
fn scan_codex_first_user_text(path: &Path) -> io::Result<Option<TranscriptRawText>> {
    let mut reader = BufReader::new(fs::File::open(path)?);
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(None);
        }
        if !line.windows(4).any(|window| window == b"user")
            && !line.windows(2).any(|window| window == b"\\u")
        {
            continue;
        }
        let raw = String::from_utf8_lossy(&line);
        if let Ok(parsed) = parse_codex_with_tool_limit(&raw, 500) {
            if let Some(token) = parsed.raw_meta_token("title") {
                if let Ok(text) = TranscriptRawText::from_json_token(token.get().to_owned()) {
                    return Ok(Some(text));
                }
            }
        }
    }
}
fn source_is_known_non_review(source: &RawValue) -> bool {
    if let Ok(source) = serde_json::from_str::<String>(source.get()) {
        return matches!(source.as_str(), "cli" | "exec" | "vscode");
    }
    let Ok(value) = serde_json::from_str::<Value>(source.get()) else {
        return false;
    };
    let thread_spawn = &value["subagent"]["thread_spawn"];
    !thread_spawn.is_null() && thread_spawn != false && thread_spawn != 0 && thread_spawn != ""
}
fn raw_string(v: &RawValue) -> Option<String> {
    serde_json::from_str(v.get()).ok()
}
fn live(o: &ListOptions, id: &str) -> bool {
    o.live_ids.iter().any(|v| v == id)
}
fn recent(now: u64, mtime: f64) -> bool {
    now as f64 - mtime < RUNNING_MS as f64
}
fn process_state(live: bool) -> String {
    (if live { "live" } else { "unknown" }).into()
}
fn encode_cwd(cwd: &str) -> String {
    cwd.replace(':', "-").replace('\\', "-").replace('/', "-")
}
fn command_wrapper(s: &str) -> bool {
    let s = s.trim_start();
    s.starts_with("<command-name") || s.starts_with("<local-command")
}
fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= CODEX_CAP {
        return;
    }
    let Ok(entries) = crate::fs_sorted::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        if out.len() >= CODEX_CAP {
            return;
        }
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() {
            collect_rollouts(&e.path(), out)
        } else {
            let n = os_string(e.file_name());
            if n.starts_with("rollout-") && n.ends_with(".jsonl") {
                out.push(e.path())
            }
        }
    }
}
fn codex_id(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|name| os_string(name.to_owned()))
        .unwrap_or_default();
    // `filename.slice(0, -6)` removes exactly one extension. Every caller only
    // passes `rollout-*.jsonl` names, so a plain suffix strip is equivalent.
    let base = name.strip_suffix(".jsonl").unwrap_or(&name).to_owned();
    let tail = base.get(base.len().saturating_sub(36)..).unwrap_or("");
    if tail.len() == 36
        && base.len() > 36
        && base.as_bytes().get(base.len() - 37) == Some(&b'-')
        && tail.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
    {
        tail.into()
    } else {
        base
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{create_dir_all, write},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let n = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let p = std::env::temp_dir().join(format!("transcript-service-{n}"));
            create_dir_all(&p).unwrap();
            Self(p)
        }
        fn service(&self) -> TranscriptService {
            TranscriptService::new(Inputs {
                state_dir: self.0.join("state"),
                claude_home: self.0.join("home"),
                codex_home: self.0.join("codex"),
                model_catalog: vec![],
            })
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn catalog_source_is_read_on_every_call() {
        let t = Temp::new();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        let s = t.service().with_catalog_source(Arc::new(move || {
            let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            vec![serde_json::json!({ "id": format!("m{n}") })]
        }));
        assert_eq!(s.catalog()[0]["id"], "m0");
        assert_eq!(s.catalog()[0]["id"], "m1");
        assert!(t.service().catalog().is_empty());
    }
    #[test]
    fn list_metadata_persists_across_service_instances() {
        let t = Temp::new();
        let root = t.0.join("projects");
        create_dir_all(root.join("p").join("s1").join("subagents")).unwrap();
        write(
            root.join("p").join("s1.jsonl"),
            "{\"type\":\"ai-title\",\"title\":\"Hi\",\"cwd\":\"C:/w\"}\n{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n",
        )
        .unwrap();
        write(root.join("p").join("s1").join("subagents").join("a1.jsonl"), "{}\n").unwrap();
        let file = t.0.join("cache").join("transcript-meta.json");
        let o = ListOptions {
            root: Some(root.to_string_lossy().into_owned()),
            ..ListOptions::default()
        };
        let first = t.service().with_persist(file.clone());
        let rows = serde_json::to_string(&first.list(&o).unwrap()).unwrap();
        assert!(file.is_file());
        let second = t.service().with_persist(file.clone());
        {
            let cache = second.cache.lock().unwrap();
            assert_eq!(cache.meta.len(), 2, "session + subagent heads restored");
        }
        assert_eq!(serde_json::to_string(&second.list(&o).unwrap()).unwrap(), rows);
        // Nothing changed, so the second list skipped the save.
        assert!(!second.dirty.load(Ordering::Relaxed));
        // A corrupt file is ignored, not fatal.
        write(&file, "not json").unwrap();
        let third = t.service().with_persist(file);
        assert!(third.cache.lock().unwrap().meta.is_empty());
        assert_eq!(serde_json::to_string(&third.list(&o).unwrap()).unwrap(), rows);
    }
    #[test]
    fn explicit_root_and_confined_paths() {
        let t = Temp::new();
        let s = t.service();
        assert_eq!(s.get_root(), DEFAULT_ROOT);
        assert!(s.set_root("selected").ok);
        assert_eq!(s.get_root(), "selected");
        assert!(s.path_for("p", "../escape", None).is_none());
        assert!(s.path_for("p", "parent/subagents/agent-x", None).is_some());
        assert!(
            s.path_for("p", "parent\\subagents\\agent-x", None)
                .is_none()
        );
        assert!(s.path_for_codex("../../escape.jsonl").is_none())
    }
    #[test]
    fn missing_read_is_not_found_and_bad_list_root_is_an_io_error() {
        let t = Temp::new();
        let service = t.service();
        assert!(
            service
                .read("p", "gone", &ReadOptions::default())
                .unwrap()
                .is_none()
        );
        let file = t.0.join("not-a-directory");
        write(&file, "x").unwrap();
        let result = service.list(&ListOptions {
            root: Some(file.to_string_lossy().into_owned()),
            ..ListOptions::default()
        });
        assert!(
            matches!(result, Err(Error::Io(error)) if error.kind() == io::ErrorKind::NotADirectory)
        );
    }
    #[test]
    fn list_uses_explicit_root_and_skips_partial_lines() {
        let t = Temp::new();
        let s = t.service();
        let root = t.0.join("transcripts");
        let file = root.join("p").join("id.jsonl");
        create_dir_all(file.parent().unwrap()).unwrap();
        write(&file,b"partial\n{\"type\":\"user\",\"cwd\":\"C:/work\",\"message\":{\"content\":\"hello\"}}\n").unwrap();
        let rows = s
            .list(&ListOptions {
                root: Some(root.to_string_lossy().into_owned()),
                now_ms: u64::MAX,
                ..ListOptions::default()
            })
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "id");
        assert_eq!(
            rows[0]
                .blurb
                .as_ref()
                .and_then(|v| raw_string(v))
                .as_deref(),
            Some("hello")
        )
    }
    /// Injects a stat failure for one path and delegates every other path to the real read.
    fn stat_error_for(path: PathBuf) -> Arc<StatFn> {
        Arc::new(move |p: &Path| {
            if p == path.as_path() {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected stat failure",
                ))
            } else {
                file_key(p)
            }
        })
    }
    #[test]
    fn list_skips_entries_whose_metadata_cannot_be_read() {
        let t = Temp::new();
        let root = t.0.join("transcripts");
        let project = root.join("p");
        create_dir_all(&project).unwrap();
        write(
            project.join("good.jsonl"),
            b"{\"type\":\"user\",\"cwd\":\"C:/work\",\"message\":{\"content\":\"hello\"}}\n",
        )
        .unwrap();
        write(project.join("bad.jsonl"), b"{}\n").unwrap();
        let s = t
            .service()
            .with_stat(stat_error_for(project.join("bad.jsonl")));
        let rows = s
            .list(&ListOptions {
                root: Some(root.to_string_lossy().into_owned()),
                now_ms: 1,
                ..ListOptions::default()
            })
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "good");
    }
    #[test]
    fn subagent_list_skips_entries_whose_metadata_cannot_be_read() {
        let t = Temp::new();
        let root = t.0.join("transcripts");
        let project = root.join("p");
        let subagents = project.join("parent").join("subagents");
        create_dir_all(&subagents).unwrap();
        write(
            project.join("parent.jsonl"),
            b"{\"type\":\"user\",\"cwd\":\"C:/work\",\"message\":{\"content\":\"parent\"}}\n",
        )
        .unwrap();
        write(subagents.join("agent-good.jsonl"), b"{}\n").unwrap();
        write(subagents.join("agent-bad.jsonl"), b"{}\n").unwrap();
        let s = t
            .service()
            .with_stat(stat_error_for(subagents.join("agent-bad.jsonl")));
        let rows = s
            .list(&ListOptions {
                root: Some(root.to_string_lossy().into_owned()),
                now_ms: 1,
                ..ListOptions::default()
            })
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subagents.len(), 1);
        assert_eq!(rows[0].subagents[0].agent_id, "agent-good");
    }
    #[test]
    fn lowercase_units_matches_node_context_for_sigma_and_surrogate_boundaries() {
        eprintln!("Rust Unicode version: {:?}", char::UNICODE_VERSION);
        let cases = [
            ("ΟΣ", "ος"),
            ("Ο'Σ", "ο'ς"),
            ("ΟΣ'Α", "οσ'α"),
            ("Ο\u{0301}Σ", "ο\u{0301}ς"),
            ("ΟΣ\u{0301}", "ος\u{0301}"),
            ("ΟΣ\u{0301}Α", "οσ\u{0301}α"),
            ("𐐀Σ", "𐐨ς"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                lowercase_units(&input.encode_utf16().collect::<Vec<_>>()),
                expected.encode_utf16().collect::<Vec<_>>(),
                "input {input:?}"
            );
        }
        assert_eq!(
            lowercase_units(&[0x039f, 0xd800, 0x03a3]),
            [0x03bf, 0xd800, 0x03c3]
        );
        assert_eq!(
            lowercase_units(&[0x039f, 0x03a3, 0xd800, 0x0391]),
            [0x03bf, 0x03c2, 0xd800, 0x03b1]
        );

        let lowered_text = lowercase_units(&"ΟΣ".encode_utf16().collect::<Vec<_>>());
        assert!(!contains_lowered(
            &"ΟΣ".encode_utf16().collect::<Vec<_>>(),
            &"οσ".encode_utf16().collect::<Vec<_>>()
        ));
        assert!(contains_lowered(
            &"ΟΣ".encode_utf16().collect::<Vec<_>>(),
            &"ος".encode_utf16().collect::<Vec<_>>()
        ));
        assert_eq!(lowered_text, "ος".encode_utf16().collect::<Vec<_>>());
    }

    #[test]
    fn search_uses_contextual_sigma_and_keeps_original_snippet() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let file = root.join("p").join("sigma.jsonl");
        create_dir_all(file.parent().unwrap()).unwrap();
        write(
            &file,
            "{\"type\":\"user\",\"cwd\":\"C:/work\",\"message\":{\"content\":\"ΟΣ́ tail\"}}\n",
        )
        .unwrap();
        let options = SearchOptions {
            root: Some(root.to_string_lossy().into_owned()),
            ..SearchOptions::default()
        };
        assert!(service.search("οσ́", &options).unwrap().results.is_empty());
        let response = service.search("ος́", &options).unwrap();
        assert_eq!(response.results.len(), 1);
        assert!(response.results[0].snippet.get().contains("ΟΣ́ tail"));
    }
    #[test]
    fn read_keeps_lone_surrogate_parser_json_raw() {
        let t = Temp::new();
        let s = t.service();
        let root = t.0.join("transcripts");
        let f = root.join("p").join("id.jsonl");
        create_dir_all(f.parent().unwrap()).unwrap();
        write(&f, br#"{"type":"user","message":{"content":"\ud800"}}"#).unwrap();
        let json = s
            .read(
                "p",
                "id",
                &ReadOptions {
                    root: Some(root.to_string_lossy().into_owned()),
                    ..ReadOptions::default()
                },
            )
            .unwrap()
            .unwrap();
        assert!(json.contains("\\ud800"))
    }
    #[test]
    fn list_preserves_escaped_title_cwd_and_sidecar_metadata() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let project = root.join("p");
        let parent_dir = project.join("parent");
        let child = parent_dir.join("subagents/agent-1.jsonl");
        create_dir_all(child.parent().unwrap()).unwrap();
        write(project.join("parent.jsonl"), "{\"type\":\"user\",\"cwd\":\"C:/work\\\\ud800\",\"message\":{\"content\":\"prompt\"}}\n{\"type\":\"ai-title\",\"aiTitle\":\"Title \\ud800\"}\n").unwrap();
        write(
            &child,
            "{\"type\":\"user\",\"message\":{\"content\":\"child prompt\"}}\n",
        )
        .unwrap();
        write(
            parent_dir.join("subagents/agent-1.meta.json"),
            "{\"agentType\":\"worker\",\"description\":\"escaped \\ud800\"}",
        )
        .unwrap();
        let rows = service
            .list(&ListOptions {
                root: Some(root.to_string_lossy().into_owned()),
                now_ms: u64::MAX,
                ..ListOptions::default()
            })
            .unwrap();
        let row = rows.iter().find(|row| row.id == "parent").unwrap();
        assert!(row.title.as_ref().unwrap().get().contains("\\ud800"));
        assert!(row.cwd.as_ref().unwrap().get().contains("\\ud800"));
        assert!(
            row.subagents[0]
                .title
                .as_ref()
                .unwrap()
                .get()
                .contains("\\ud800")
        );
    }
    #[test]
    fn list_serializes_missing_title_as_null() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let project = root.join("p");
        create_dir_all(&project).unwrap();
        write(
            project.join("untitled.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"prompt\"}}\n",
        )
        .unwrap();

        let rows = service
            .list(&ListOptions {
                root: Some(root.to_string_lossy().into_owned()),
                now_ms: u64::MAX,
                ..ListOptions::default()
            })
            .unwrap();
        let row = rows.iter().find(|row| row.id == "untitled").unwrap();

        assert!(
            serde_json::to_string(row)
                .unwrap()
                .contains("\"title\":null")
        );
    }
    #[test]
    fn search_preserves_utf16_and_uses_search_tool_limit() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let path = root.join("p").join("id.jsonl");
        create_dir_all(path.parent().unwrap()).unwrap();
        let tool_text = format!("{}needle{}", "x".repeat(450), "z".repeat(100));
        write(
            &path,
            format!(
                "{{\"type\":\"user\",\"message\":{{\"content\":\"\\ud800 needle\"}}}}\n{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"tool_use\",\"name\":\"grep\",\"input\":\"{tool_text}\"}}]}}}}\n"
            ),
        )
        .unwrap();
        let response = service
            .search(
                "needle",
                &SearchOptions {
                    root: Some(root.to_string_lossy().into_owned()),
                    ..SearchOptions::default()
                },
            )
            .unwrap();
        assert_eq!(response.results.len(), 2);
        assert!(response.results[0].snippet.get().contains("\\ud800"));
        assert!(response.results[1].snippet.get().contains("needle"));
        assert!(!response.capped);
    }
    #[test]
    fn search_accepts_an_unpaired_utf16_query_unit() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let path = root.join("p").join("id.jsonl");
        create_dir_all(path.parent().unwrap()).unwrap();
        write(&path, br#"{"type":"user","message":{"content":"\ud800"}}"#).unwrap();

        let response = service
            .search_units(
                &[0xd800],
                &SearchOptions {
                    root: Some(root.to_string_lossy().into_owned()),
                    ..SearchOptions::default()
                },
            )
            .unwrap();
        assert_eq!(response.results.len(), 1);
        assert!(response.results[0].snippet.get().contains("\\ud800"));
    }
    #[test]
    fn search_keeps_cwd_unknown_until_a_message_learns_it() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let path = root.join("p").join("cwd-order.jsonl");
        create_dir_all(path.parent().unwrap()).unwrap();
        write(
            &path,
            "{\"type\":\"user\",\"message\":{\"content\":\"needle before cwd\"}}\n{\"type\":\"user\",\"cwd\":\"C:/work\",\"message\":{\"content\":\"needle after cwd\"}}\n",
        )
        .unwrap();

        let response = service
            .search(
                "needle",
                &SearchOptions {
                    root: Some(root.to_string_lossy().into_owned()),
                    ..SearchOptions::default()
                },
            )
            .unwrap();

        assert_eq!(response.results.len(), 2);
        assert!(response.results[0].cwd.is_none());
        assert_eq!(
            raw_string(response.results[1].cwd.as_ref().unwrap()).as_deref(),
            Some("C:/work")
        );
    }
    /// Node's search items carry the raw cwd token (`sessions.mjs:648,795,803`),
    /// so a non-string cwd keeps its JSON type instead of collapsing to null.
    // VERIFY: wave8-numeric_cwd-17
    #[test]
    fn search_keeps_non_string_cwd_tokens() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let claude = root.join("p").join("numeric-cwd.jsonl");
        create_dir_all(claude.parent().unwrap()).unwrap();
        write(
            &claude,
            "{\"type\":\"user\",\"cwd\":7,\"message\":{\"content\":\"needle claude\"}}\n",
        )
        .unwrap();
        let sessions = t.0.join("codex/sessions");
        create_dir_all(&sessions).unwrap();
        write(
            sessions.join("rollout-numeric-cwd.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"c\",\"cwd\":true}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"needle codex\"}}\n",
        )
        .unwrap();

        let response = service
            .search(
                "needle",
                &SearchOptions {
                    root: Some(root.to_string_lossy().into_owned()),
                    ..SearchOptions::default()
                },
            )
            .unwrap();

        assert_eq!(response.results.len(), 2);
        let cwd_of = |source: &str| {
            let result = response
                .results
                .iter()
                .find(|result| result.source == source)
                .unwrap();
            serde_json::from_str::<Value>(result.cwd.as_ref().unwrap().get()).unwrap()
        };
        assert_eq!(cwd_of("claude"), serde_json::json!(7));
        assert_eq!(cwd_of("codex"), Value::Bool(true));
    }
    #[test]
    fn search_still_synthesizes_id_hit_when_discovered_content_cannot_be_read() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let unreadable_file = root.join("p").join("needle.jsonl");
        create_dir_all(&unreadable_file).unwrap();

        let response = service
            .search(
                "needle",
                &SearchOptions {
                    root: Some(root.to_string_lossy().into_owned()),
                    ..SearchOptions::default()
                },
            )
            .unwrap();

        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].id, "needle");
        assert_eq!(response.results[0].role, "id");
        assert!(response.results[0].cwd.is_none());
    }
    #[test]
    fn cache_key_matches_node_mtime_ms_precision() {
        let base = std::time::Duration::new(1_700_000_000, 123_456_700);
        let base_mtime = node_mtime_ms(base);
        let equivalent = (1..=1_000)
            .map(|nanoseconds| base + Duration::from_nanos(nanoseconds))
            .find(|candidate| node_mtime_ms(*candidate) == base_mtime)
            .expect("distinct nanosecond timestamps share Node's millisecond float");
        assert_ne!(equivalent, base);
        assert!(same_key(
            &Key {
                mtime: base_mtime,
                size: 123,
            },
            &Key {
                mtime: node_mtime_ms(equivalent),
                size: 123,
            }
        ));
    }
    #[test]
    fn root_cache_boundary_and_external_files_remain_read_only() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("external");
        let path = root.join("p").join("id.jsonl");
        create_dir_all(path.parent().unwrap()).unwrap();
        write(&path, "{\"type\":\"ai-title\",\"aiTitle\":\"old\"}\n").unwrap();
        let original_time = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(service.set_root(root.to_string_lossy().as_ref()).ok);
        let first = service.list(&ListOptions::default()).unwrap();
        assert_eq!(
            raw_string(first[0].title.as_ref().unwrap()).as_deref(),
            Some("old")
        );
        write(&path, "{\"type\":\"ai-title\",\"aiTitle\":\"new\"}\n").unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(original_time))
            .unwrap();
        let same_key = service.list(&ListOptions::default()).unwrap();
        assert_eq!(
            raw_string(same_key[0].title.as_ref().unwrap()).as_deref(),
            Some("old")
        );
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(original_time + Duration::from_secs(1)))
            .unwrap();
        let changed_time = service.list(&ListOptions::default()).unwrap();
        assert_eq!(
            raw_string(changed_time[0].title.as_ref().unwrap()).as_deref(),
            Some("new")
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            b"{\"type\":\"ai-title\",\"aiTitle\":\"new\"}\n"
        );
        assert!(service.get_root().contains("external"));
    }
    #[test]
    fn search_result_cap_is_two_hundred() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        for index in 0..205 {
            let path = root.join("p").join(format!("{index}.jsonl"));
            create_dir_all(path.parent().unwrap()).unwrap();
            write(
                path,
                "{\"type\":\"user\",\"message\":{\"content\":\"needle\"}}\n",
            )
            .unwrap();
        }
        let response = service
            .search(
                "needle",
                &SearchOptions {
                    root: Some(root.to_string_lossy().into_owned()),
                    ..SearchOptions::default()
                },
            )
            .unwrap();
        assert_eq!(response.results.len(), SEARCH_CAP);
        assert!(response.capped);
    }
    #[test]
    fn codex_list_groups_children_keeps_orphans_and_scans_reviews_past_head() {
        let t = Temp::new();
        let service = t.service();
        let sessions = t.0.join("codex/sessions");
        create_dir_all(&sessions).unwrap();
        let parent = "11111111-1111-4111-8111-111111111111";
        let child = "22222222-2222-4222-8222-222222222222";
        let orphan = "33333333-3333-4333-8333-333333333333";
        let review = "44444444-4444-4444-8444-444444444444";
        write(sessions.join(format!("rollout-2026-{parent}.jsonl")), format!("{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"C:/work\",\"session_id\":\"{parent}\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"parent prompt\"}}}}\n")).unwrap();
        write(sessions.join(format!("rollout-2026-{child}.jsonl")), format!("{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{parent}\",\"thread_source\":\"subagent\"}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"text\":\"child prompt\"}}]}}}}\n")).unwrap();
        write(sessions.join(format!("rollout-2026-{orphan}.jsonl")), format!("{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"missing-parent\",\"thread_source\":\"subagent\"}}}}\n")).unwrap();
        let review_path = sessions.join(format!("rollout-2026-{review}.jsonl"));
        write(&review_path, format!("{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{review}\"}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"text\":\"{}\"}}]}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"The following is the Codex agent history whose request action you are assessing.\"}}}}\n", "x".repeat(66_000))).unwrap();
        let all = service.list(&ListOptions::default()).unwrap();
        assert_eq!(
            all.len(),
            3,
            "rows: {:?}",
            all.iter()
                .map(|row| (&row.id, &row.session_id, &row.source))
                .collect::<Vec<_>>()
        );
        let parent_row = all.iter().find(|row| row.id == parent).unwrap();
        assert_eq!(parent_row.subagents.len(), 1);
        assert_eq!(parent_row.subagents[0].id, child);
        assert!(all.iter().any(|row| row.id == orphan));
        let filtered = service
            .list(&ListOptions {
                hide_reviews: true,
                ..ListOptions::default()
            })
            .unwrap();
        assert!(!filtered.iter().any(|row| row.id == review));
    }
    #[test]
    fn codex_thread_spawn_source_skips_bounded_review_fallback_scan() {
        let t = Temp::new();
        let service = t.service();
        let sessions = t.0.join("codex/sessions");
        create_dir_all(&sessions).unwrap();
        let review =
            "The following is the Codex agent history whose request action you are assessing.";
        let padding = "x".repeat(66_000);
        let cases = [
            (
                "11111111-1111-4111-8111-111111111111",
                "{\"subagent\":{\"thread_spawn\":{\"depth\":1}}}",
                true,
            ),
            (
                "22222222-2222-4222-8222-222222222222",
                "{\"subagent\":{\"other\":\"guardian\"}}",
                false,
            ),
        ];
        for (id, source, _) in cases {
            write(
                sessions.join(format!("rollout-2026-{id}.jsonl")),
                format!("{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{id}\",\"source\":{source}}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"developer\",\"content\":[{{\"text\":\"{padding}\"}}]}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"text\":\"{review}\"}}]}}}}\n"),
            )
            .unwrap();
        }
        let rows = service
            .list(&ListOptions {
                hide_reviews: true,
                ..ListOptions::default()
            })
            .unwrap();
        for (id, _, keep) in cases {
            assert_eq!(
                rows.iter().any(|row| row.id == id),
                keep,
                "source case {id}"
            );
        }
    }
    fn age_file(path: &Path, age: Duration) {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(SystemTime::now().checked_sub(age).unwrap()),
            )
            .unwrap();
    }
    /// `sessions.test.mjs:317-365`: owned liveness and recent activity stay
    /// separate for root, Claude child, and Codex rows.
    #[test]
    fn liveness_and_recent_activity_stay_separate_for_root_child_and_codex_rows() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let project = root.join("p");
        let ids = ["root-live-quiet", "root-unowned-recent", "root-unowned-old"];
        for id in ids {
            create_dir_all(&project).unwrap();
            write(
                project.join(format!("{id}.jsonl")),
                "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n",
            )
            .unwrap();
        }
        let child_dir = project.join(ids[0]).join("subagents");
        create_dir_all(&child_dir).unwrap();
        let child_ids = [
            "agent-live-quiet",
            "agent-unowned-recent",
            "agent-unowned-old",
        ];
        for id in child_ids {
            write(child_dir.join(format!("{id}.jsonl")), "{}\n").unwrap();
        }
        let old = Duration::from_secs(60);
        for (dir, id) in [
            (&project, ids[0]),
            (&project, ids[2]),
            (&child_dir, child_ids[0]),
            (&child_dir, child_ids[2]),
        ] {
            age_file(&dir.join(format!("{id}.jsonl")), old);
        }
        let thread_id = "dddddddd-eeee-ffff-0000-111111111111";
        let codex_dir = t.0.join("codex/sessions/2026/10/27");
        create_dir_all(&codex_dir).unwrap();
        write(
            codex_dir.join(format!("rollout-{thread_id}.jsonl")),
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{thread_id}\",\"cwd\":\"C:/codex/project\",\"source\":\"cli\",\"thread_source\":\"user\"}}}}\n"
            ),
        )
        .unwrap();
        let old_codex_id = "eeeeeeee-ffff-0000-1111-222222222222";
        let old_codex = codex_dir.join(format!("rollout-{old_codex_id}.jsonl"));
        write(
            &old_codex,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{old_codex_id}\",\"cwd\":\"C:/codex/project\",\"source\":\"cli\",\"thread_source\":\"user\"}}}}\n"
            ),
        )
        .unwrap();
        age_file(&old_codex, old);

        let now_ms = node_mtime_ms(SystemTime::now().duration_since(UNIX_EPOCH).unwrap());
        let rows = service
            .list(&ListOptions {
                root: Some(root.to_string_lossy().into_owned()),
                now_ms: now_ms as u64,
                live_ids: vec![ids[0].into(), child_ids[0].into(), thread_id.into()],
                ..ListOptions::default()
            })
            .unwrap();
        let row = |id: &str| rows.iter().find(|row| row.id == id).unwrap();
        let live_root = row(ids[0]);
        assert_eq!(
            (
                live_root.process_live,
                live_root.activity_recent,
                live_root.running,
                live_root.process_state.as_str()
            ),
            (true, false, true, "live")
        );
        let recent_root = row(ids[1]);
        assert_eq!(
            (
                recent_root.process_live,
                recent_root.activity_recent,
                recent_root.running,
                recent_root.process_state.as_str()
            ),
            (false, true, false, "unknown")
        );
        let old_root = row(ids[2]);
        assert_eq!(
            (
                old_root.process_live,
                old_root.activity_recent,
                old_root.running
            ),
            (false, false, false)
        );
        let children = &live_root.subagents;
        let child = |id: &str| children.iter().find(|child| child.agent_id == id).unwrap();
        assert_eq!(
            (
                child(child_ids[0]).process_live,
                child(child_ids[0]).activity_recent
            ),
            (true, false)
        );
        assert_eq!(
            (
                child(child_ids[1]).process_live,
                child(child_ids[1]).activity_recent,
                child(child_ids[1]).running
            ),
            (false, true, false)
        );
        assert_eq!(
            (
                child(child_ids[2]).process_live,
                child(child_ids[2]).activity_recent
            ),
            (false, false)
        );
        let codex = row(thread_id);
        assert_eq!(
            (codex.process_live, codex.activity_recent, codex.running),
            (true, true, true)
        );
        let old_codex = row(old_codex_id);
        assert_eq!(
            (
                old_codex.process_live,
                old_codex.activity_recent,
                old_codex.running
            ),
            (false, false, false)
        );
    }
    /// `İ` lowercases to two UTF-16 units, so the lowered match offset can sit
    /// past the original buffer. Node's `slice` returns "" there; the port must
    /// not panic on the out-of-order range.
    #[test]
    fn search_snippet_does_not_panic_when_lowercasing_expands_the_buffer() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let path = root.join("p").join("turkish.jsonl");
        create_dir_all(path.parent().unwrap()).unwrap();
        let content = format!("{}x", "İ".repeat(62));
        write(
            &path,
            serde_json::json!({ "type": "user", "message": { "content": content } }).to_string(),
        )
        .unwrap();
        let response = service
            .search(
                "x",
                &SearchOptions {
                    root: Some(root.to_string_lossy().into_owned()),
                    ..SearchOptions::default()
                },
            )
            .unwrap();
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].snippet.get(), "\"…\"");
    }
    /// Node's `` `Codex ${id.slice(-8)}` `` slices UTF-16 units; a byte slice
    /// panics when `len - 8` lands inside a multibyte character.
    #[test]
    fn codex_fallback_title_slices_the_id_by_utf16_units() {
        let t = Temp::new();
        let service = t.service();
        let sessions = t.0.join("codex/sessions");
        create_dir_all(&sessions).unwrap();
        write(
            sessions.join("rollout-€€€.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"x\"}}\n",
        )
        .unwrap();
        let rows = service.list(&ListOptions::default()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            raw_string(rows[0].title.as_ref().unwrap()).as_deref(),
            Some("Codex lout-€€€")
        );
    }
    /// A falsy `session_meta.payload.cwd` stays null in the list row
    /// (`sessions.mjs:129`); `""` must not survive as a cwd.
    // VERIFY: wave5-task-reg-11
    #[test]
    fn codex_list_treats_an_empty_metadata_cwd_as_null() {
        let t = Temp::new();
        let service = t.service();
        let sessions = t.0.join("codex/sessions");
        create_dir_all(&sessions).unwrap();
        write(
            sessions.join("rollout-empty-cwd.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"a\",\"cwd\":\"\"}}\n",
        )
        .unwrap();
        write(
            sessions.join("rollout-set-cwd.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"b\",\"cwd\":\"C:/work\"}}\n",
        )
        .unwrap();
        let rows = service.list(&ListOptions::default()).unwrap();
        let cwd_of = |id: &str| {
            let row = rows.iter().find(|row| row.id == id).unwrap();
            serde_json::to_value(row).unwrap()["cwd"].clone()
        };
        assert_eq!(cwd_of("rollout-empty-cwd"), Value::Null);
        assert_eq!(cwd_of("rollout-set-cwd"), serde_json::json!("C:/work"));
    }
    /// Node's `if (!cwd && e.payload.cwd)` is JavaScript truthiness, so every
    /// JSON spelling of numeric zero is falsy, not just the integer `0`.
    // VERIFY: wave7-truthy-2
    #[test]
    fn raw_truthy_matches_javascript_numeric_truthiness() {
        let truthy = |token: &str| raw_truthy(&RawValue::from_string(token.to_owned()).unwrap());
        for falsy in [
            "null", "false", "0", "0.0", "-0", "-0.0", "0e0", "0E0", "-0e5", "\"\"",
        ] {
            assert!(!truthy(falsy), "{falsy} must be falsy");
        }
        for value in ["true", "1", "-1", "0.1", "\"0\"", "\"false\"", "[]", "{}"] {
            assert!(truthy(value), "{value} must be truthy");
        }
    }
    /// The codex list row applies that same guard to `payload.cwd`: a numeric
    /// zero stays null while any truthy value survives with Node's JSON type.
    // VERIFY: wave7-truthy-3
    // VERIFY: wave8-numeric_cwd-15
    #[test]
    fn codex_list_applies_javascript_cwd_truthiness() {
        let t = Temp::new();
        let service = t.service();
        let sessions = t.0.join("codex/sessions");
        create_dir_all(&sessions).unwrap();
        for (id, cwd) in [
            ("rollout-zero-fraction", "0.0"),
            ("rollout-negative-zero", "-0"),
            ("rollout-zero-exponent", "0e0"),
            ("rollout-nonzero-number", "7"),
            ("rollout-true", "true"),
            ("rollout-array", "[1]"),
            ("rollout-object", "{\"a\":1}"),
        ] {
            let line = format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{id}\",\"cwd\":{cwd}}}}}\n"
            );
            write(sessions.join(format!("{id}.jsonl")), line).unwrap();
        }
        let rows = service.list(&ListOptions::default()).unwrap();
        let cwd_of = |id: &str| {
            let row = rows.iter().find(|row| row.id == id).unwrap();
            serde_json::to_value(row).unwrap()["cwd"].clone()
        };
        for id in [
            "rollout-zero-fraction",
            "rollout-negative-zero",
            "rollout-zero-exponent",
        ] {
            assert_eq!(cwd_of(id), Value::Null, "{id}");
        }
        // Node keeps the raw value, so the row's JSON type follows the token.
        assert_eq!(cwd_of("rollout-nonzero-number"), serde_json::json!(7));
        assert_eq!(cwd_of("rollout-true"), serde_json::json!(true));
        assert_eq!(cwd_of("rollout-array"), serde_json::json!([1]));
        assert_eq!(cwd_of("rollout-object"), serde_json::json!({"a": 1}));
    }

    /// Node guards its blurb with `if (flat)`, so an empty or whitespace-only
    /// prompt keeps `blurb` null instead of `""`.
    #[test]
    fn empty_prompt_content_yields_null_blurb() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let project = root.join("p");
        create_dir_all(&project).unwrap();
        write(
            project.join("empty.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"\"}}\n",
        )
        .unwrap();
        write(
            project.join("spaces.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"   \"}}\n",
        )
        .unwrap();
        write(
            project.join("block.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"\"}]}}\n",
        )
        .unwrap();
        let rows = service
            .list(&ListOptions {
                root: Some(root.to_string_lossy().into_owned()),
                now_ms: u64::MAX,
                ..ListOptions::default()
            })
            .unwrap();
        for id in ["empty", "spaces", "block"] {
            let row = rows.iter().find(|row| row.id == id).unwrap();
            let json = serde_json::to_string(row).unwrap();
            assert!(json.contains("\"blurb\":null"), "{id}: {json}");
        }
    }
    /// Node joins the sidecar description only when it is truthy and stringifies
    /// a non-string `agentType`, falling back to the peeked title when the
    /// joined value is empty.
    #[test]
    fn subagent_sidecar_title_uses_js_truthiness_and_stringification() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let project = root.join("p");
        let subagents = project.join("parent").join("subagents");
        create_dir_all(&subagents).unwrap();
        write(
            project.join("parent.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"parent\"}}\n",
        )
        .unwrap();
        let cases = [
            (
                "agent-empty-description",
                "{\"agentType\":\"worker\",\"description\":\"\"}",
                "worker",
            ),
            (
                "agent-false-description",
                "{\"agentType\":\"worker\",\"description\":false}",
                "worker",
            ),
            ("agent-number", "{\"agentType\":5}", "5"),
            ("agent-falsy", "{\"agentType\":\"\"}", "peeked"),
        ];
        for (id, sidecar, _) in cases {
            write(
                subagents.join(format!("{id}.jsonl")),
                "{\"type\":\"ai-title\",\"aiTitle\":\"peeked\"}\n",
            )
            .unwrap();
            write(subagents.join(format!("{id}.meta.json")), sidecar).unwrap();
        }
        let rows = service
            .list(&ListOptions {
                root: Some(root.to_string_lossy().into_owned()),
                now_ms: u64::MAX,
                ..ListOptions::default()
            })
            .unwrap();
        let parent = rows.iter().find(|row| row.id == "parent").unwrap();
        for (id, _, expected) in cases {
            let child = parent
                .subagents
                .iter()
                .find(|child| child.agent_id == id)
                .unwrap();
            assert_eq!(
                raw_string(child.title.as_ref().unwrap()).as_deref(),
                Some(expected),
                "{id}"
            );
        }
    }
    /// Node's `f.slice(0, -6)` removes exactly one `.jsonl`, never every repetition.
    #[test]
    fn file_ids_strip_exactly_one_jsonl_suffix() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let project = root.join("p");
        create_dir_all(&project).unwrap();
        write(
            project.join("a.jsonl.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"needle\"}}\n",
        )
        .unwrap();
        write(
            project.join("b.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"plain\"}}\n",
        )
        .unwrap();
        let subagents = project.join("b").join("subagents");
        create_dir_all(&subagents).unwrap();
        write(subagents.join("agent-y.jsonl.jsonl"), "{}\n").unwrap();
        let sessions = t.0.join("codex/sessions");
        create_dir_all(&sessions).unwrap();
        write(
            sessions.join("rollout-z.jsonl.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"z\"}}\n",
        )
        .unwrap();

        let rows = service
            .list(&ListOptions {
                root: Some(root.to_string_lossy().into_owned()),
                now_ms: 1,
                ..ListOptions::default()
            })
            .unwrap();
        assert!(rows.iter().any(|row| row.id == "a.jsonl"));
        let parent = rows.iter().find(|row| row.id == "b").unwrap();
        assert_eq!(parent.subagents[0].agent_id, "agent-y.jsonl");
        assert!(rows.iter().any(|row| row.id == "rollout-z.jsonl"));

        let response = service
            .search(
                "needle",
                &SearchOptions {
                    root: Some(root.to_string_lossy().into_owned()),
                    ..SearchOptions::default()
                },
            )
            .unwrap();
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].id, "a.jsonl");
    }
    /// Node's `/^[^\\/]+\/subagents\/agent-[^\\/]+$/` needs a character after `agent-`.
    #[test]
    fn subagent_path_requires_a_suffix_after_agent_dash() {
        let t = Temp::new();
        let s = t.service();
        assert!(s.path_for("p", "parent/subagents/agent-x", None).is_some());
        assert!(s.path_for("p", "parent/subagents/agent-", None).is_none());
    }
    /// Node always emits `cwd`, `title` and (for Claude rows) `blurb`, as null
    /// when absent; Codex rows carry no `blurb` key at all.
    #[test]
    fn list_and_search_serialize_absent_optionals_as_null() {
        let t = Temp::new();
        let service = t.service();
        let root = t.0.join("transcripts");
        let project = root.join("p");
        create_dir_all(&project).unwrap();
        write(
            project.join("no-cwd.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"<command-name> needle\"}}\n",
        )
        .unwrap();
        let sessions = t.0.join("codex/sessions");
        create_dir_all(&sessions).unwrap();
        write(
            sessions.join("rollout-11111111-1111-4111-8111-111111111111.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"11111111-1111-4111-8111-111111111111\"}}\n",
        )
        .unwrap();

        let rows = service
            .list(&ListOptions {
                root: Some(root.to_string_lossy().into_owned()),
                now_ms: u64::MAX,
                ..ListOptions::default()
            })
            .unwrap();
        let claude = rows.iter().find(|row| row.id == "no-cwd").unwrap();
        let json = serde_json::to_string(claude).unwrap();
        assert!(json.contains("\"cwd\":null"), "{json}");
        assert!(json.contains("\"title\":null"), "{json}");
        assert!(json.contains("\"blurb\":null"), "{json}");
        let codex = rows
            .iter()
            .find(|row| row.source.as_deref() == Some("codex"))
            .unwrap();
        let json = serde_json::to_string(codex).unwrap();
        assert!(json.contains("\"cwd\":null"), "{json}");
        assert!(!json.contains("\"blurb\""), "{json}");

        let options = SearchOptions {
            root: Some(root.to_string_lossy().into_owned()),
            project: Some("p".into()),
            id: Some("no-cwd".into()),
            ..SearchOptions::default()
        };
        let text_hit = service.search("needle", &options).unwrap();
        assert_eq!(text_hit.results.len(), 1);
        assert!(
            serde_json::to_string(&text_hit.results[0])
                .unwrap()
                .contains("\"cwd\":null")
        );
        let id_hit = service.search("no-cwd", &options).unwrap();
        assert_eq!(id_hit.results[0].role, "id");
        assert!(
            serde_json::to_string(&id_hit.results[0])
                .unwrap()
                .contains("\"cwd\":null")
        );
    }
    /// A rejected root must not disturb the root an earlier call acknowledged.
    // VERIFY: wave32-root-1
    #[test]
    fn invalid_root_is_rejected_without_touching_the_stored_root() {
        let t = Temp::new();
        let service = t.service();
        assert!(service.set_root("kept").ok);
        let file = t.0.join("state").join("sessions-root.json");
        let before = fs::read(&file).unwrap();
        let rejected = service.set_root("");
        assert!(!rejected.ok);
        assert!(rejected.root.is_none());
        assert_eq!(rejected.error.as_deref(), Some("bad root"));
        assert_eq!(fs::read(&file).unwrap(), before);
        assert_eq!(service.get_root(), "kept");
    }
    /// `set_root` reports a filesystem failure as `{ok:false,error}` instead of
    /// panicking, and `get_root` still falls back to the default root.
    // VERIFY: wave32-root-2
    #[test]
    fn root_write_failure_is_reported_and_keeps_the_default_root() {
        let t = Temp::new();
        // A regular file where the state directory belongs makes `create_dir_all` fail.
        write(t.0.join("state"), b"blocked").unwrap();
        let service = t.service();
        let result = service.set_root("elsewhere");
        assert!(!result.ok);
        assert!(result.root.is_none());
        assert!(result.error.is_some());
        assert_eq!(service.get_root(), DEFAULT_ROOT);
    }
    /// Separate service instances share one state dir and, being one process,
    /// one pid-scoped scratch file. Concurrent setter calls must serialize: every
    /// observed document is complete and the final document is one of the roots
    /// actually written.
    // VERIFY: wave32-root-3
    #[test]
    fn concurrent_cross_instance_root_writes_stay_complete() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let t = Temp::new();
        let state = t.0.join("state");
        let file = state.join("sessions-root.json");
        assert!(t.service().set_root("seed").ok);
        let (writers, rounds) = (8, 40);
        let gate = Arc::new(std::sync::Barrier::new(writers + 1));
        let stop = Arc::new(AtomicBool::new(false));
        let mut handles = Vec::new();
        for writer in 0..writers {
            let service = t.service();
            let gate = gate.clone();
            handles.push(std::thread::spawn(move || {
                gate.wait();
                for round in 0..rounds {
                    assert!(service.set_root(&format!("root-{writer}-{round}")).ok);
                }
            }));
        }
        let reader_file = file.clone();
        let reader_gate = gate.clone();
        let reader_stop = stop.clone();
        let reader = std::thread::spawn(move || {
            reader_gate.wait();
            let mut observed = 0usize;
            loop {
                let bytes = fs::read(&reader_file).unwrap();
                let doc: RootDoc = serde_json::from_slice(&bytes)
                    .unwrap_or_else(|error| panic!("torn root document {bytes:?}: {error}"));
                assert!(!doc.root.is_empty());
                observed += 1;
                if reader_stop.load(Ordering::SeqCst) {
                    return observed;
                }
            }
        });
        for handle in handles {
            handle.join().unwrap();
        }
        stop.store(true, Ordering::SeqCst);
        assert!(reader.join().unwrap() > 0);
        let doc: RootDoc = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(doc.root, t.service().get_root());
        assert!(doc.root == "seed" || doc.root.starts_with("root-"));
        assert!(
            crate::fs_sorted::read_dir(&state)
                .unwrap()
                .flatten()
                .all(|entry| entry.file_name().to_string_lossy() == "sessions-root.json"),
            "a scratch file survived the setters"
        );
    }
}
