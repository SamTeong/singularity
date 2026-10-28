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
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

const DEFAULT_ROOT: &str = "~/.claude/projects";
const PEEK_BYTES: u64 = 65_536;
const CODEX_CAP: usize = 5_000;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<Box<RawValue>>,
    pub title: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blurb: Option<Box<RawValue>>,
    pub mtime: f64,
    pub size: u64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blurb: Option<Box<RawValue>>,
    pub mtime: f64,
    pub size: u64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
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
#[derive(Clone)]
struct Key {
    mtime: f64,
    size: u64,
}
#[derive(Clone)]
struct Meta {
    key: Key,
    cwd: Option<Box<RawValue>>,
    title: Option<Box<RawValue>>,
    blurb: Option<Box<RawValue>>,
    sidecar: Option<Key>,
}
#[derive(Clone)]
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
pub struct TranscriptService {
    inputs: Inputs,
    cache: Mutex<Cache>,
    catalog_source: Option<Arc<dyn Fn() -> Vec<Value> + Send + Sync>>,
}

impl TranscriptService {
    pub fn new(inputs: Inputs) -> Self {
        Self {
            inputs,
            cache: Mutex::new(Cache::default()),
            catalog_source: None,
        }
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
        fs::write(
            self.inputs.state_dir.join("sessions-root.json"),
            serde_json::to_vec(&RootDocRef { root })
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
        let root = self.resolve_root(o.root.as_deref());
        let mut rows = Vec::new();
        let project_entries = match fs::read_dir(&root) {
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
                let entries = match fs::read_dir(p.path()) {
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
                    let Some(meta) = self.peek_meta(&path, None)? else {
                        continue;
                    };
                    let key = match file_key(&path) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let id = name.trim_end_matches(".jsonl").to_owned();
                    let subagents = self.list_subagents(&p.path(), &id, o)?;
                    rows.push(SessionRow {
                        id: id.clone(),
                        project: project.clone(),
                        cwd: meta.cwd,
                        title: meta.title,
                        blurb: meta.blurb,
                        mtime: key.mtime,
                        size: key.size,
                        running: live(o, &id) || recent(o.now_ms, key.mtime),
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
                match fs::read_dir(self.resolve_root(o.root.as_deref())) {
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
                    cwd: items
                        .as_ref()
                        .and_then(|items| items.first())
                        .and_then(|i| i.cwd.clone()),
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
        let key = match file_key(path) {
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
                        if !command_wrapper(&display) {
                            blurb = Some(
                                RawValue::from_string(utf16_json_token(&flatten_units(&text, 140)))
                                    .unwrap(),
                            );
                        }
                    }
                }
            }
        }
        if let Some(sidecar) = sidecar {
            if let Ok(raw) = read_node_utf8(sidecar) {
                if let Ok(m) = serde_json::from_str::<Sidecar>(&raw) {
                    if let Some(kind) = m.agent_type {
                        title = Some(match m.description {
                            Some(description) => {
                                concat_raw_strings(&kind, Some(&description), ": ")
                            }
                            None => kind,
                        })
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
        let entries = match fs::read_dir(dir) {
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
            let aid = name.trim_end_matches(".jsonl").to_owned();
            let side = e.path().with_file_name(format!("{aid}.meta.json"));
            let Some(meta) = self.peek_meta(&e.path(), Some(&side))? else {
                continue;
            };
            let key = match file_key(&e.path()) {
                Ok(k) => k,
                Err(_) => continue,
            };
            rows.push(SubagentRow {
                id: format!("{parent}/subagents/{aid}"),
                agent_id: aid.clone(),
                project: None,
                cwd: None,
                title: meta.title,
                blurb: meta.blurb,
                mtime: key.mtime,
                size: key.size,
                running: live(o, &aid) || recent(o.now_ms, key.mtime),
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
                running: live(o, &id) || recent(o.now_ms, key.mtime),
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
                    cwd: child.cwd,
                    title: child.title,
                    blurb: child.blurb,
                    mtime: child.mtime,
                    size: child.size,
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
                cwd: parsed.raw_meta_token("cwd").map(raw_clone),
                title: title.unwrap_or_else(|| string_token("")),
                session_id,
                thread_source,
                review: review.or_else(|| not_review.then_some(false)),
            });
        }
        let mut metadata = metadata?;
        if raw_string(&metadata.title).as_deref() == Some("") {
            let id = codex_id(path);
            metadata.title = string_token(&format!("Codex {}", &id[id.len().saturating_sub(8)..]));
        }
        if hide_reviews && metadata.review.is_none() {
            let first_user = scan_codex_first_user_text(path).ok()?;
            metadata.review = Some(first_user.is_some_and(|text| raw_text_starts_review(&text)));
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
        let projects = match fs::read_dir(self.resolve_root(o.root.as_deref())) {
            Ok(projects) => Some(projects),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if let Some(projects) = projects {
            for p in projects.flatten() {
                if !p.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                if let Ok(files) = fs::read_dir(p.path()) {
                    for f in files.flatten() {
                        let n = os_string(f.file_name());
                        if n.ends_with(".jsonl") {
                            out.push((
                                os_string(p.file_name()),
                                n.trim_end_matches(".jsonl").into(),
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
        let cwd = parsed.raw_meta_token("cwd").map(raw_clone);
        let message_cwds = if codex {
            vec![cwd; parsed.raw_messages().count()]
        } else {
            let mut learned = None;
            let mut message_cwds = Vec::new();
            for line in raw.lines() {
                let Ok(event) = parse_claude_with_tool_limit(line, &catalog, 500) else {
                    continue;
                };
                if learned.is_none() {
                    if let Some(token) = event
                        .raw_meta_token("cwd")
                        .filter(|token| raw_truthy(token))
                    {
                        learned = Some(raw_clone(token));
                    }
                }
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
    p.len() == 3
        && p[0..2].iter().all(|s| !s.is_empty())
        && p[1] == "subagents"
        && p[2].starts_with("agent-")
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
    while cache.meta.len() > 20_000 {
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
fn raw_clone(value: &RawValue) -> Box<RawValue> {
    RawValue::from_string(value.get().to_owned()).expect("valid raw JSON token")
}
fn concat_raw_strings(
    first: &RawValue,
    second: Option<&RawValue>,
    separator: &str,
) -> Box<RawValue> {
    let mut units = TranscriptRawText::from_json_token(first.get().to_owned())
        .and_then(|text| text.units())
        .unwrap_or_default();
    if let Some(second) = second {
        units.extend(separator.encode_utf16());
        if let Ok(value) = TranscriptRawText::from_json_token(second.get().to_owned())
            .and_then(|text| text.units())
        {
            units.extend(value);
        }
    }
    RawValue::from_string(utf16_json_token(&units)).unwrap()
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
    let mut start = at.saturating_sub(60);
    let mut end = (at + query_len + 60).min(units.len());
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
fn raw_truthy(token: &RawValue) -> bool {
    !matches!(token.get(), "null" | "false" | "0" | "\"\"")
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
    let Ok(entries) = fs::read_dir(dir) else {
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
    let base = path
        .file_name()
        .map(|name| os_string(name.to_owned()))
        .unwrap_or_default()
        .trim_end_matches(".jsonl")
        .to_owned();
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
}
