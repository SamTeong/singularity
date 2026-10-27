//! Per-agent and per-transcript stats (port of `server/stats.mjs` statsFor /
//! sessionStats). Turns + per-bucket tokens + pricing-table estimate parsed from
//! a Claude `.jsonl` or Codex rollout, merged with the statusline cost-state file.
//! The live agents registry stays in Node: callers pass `{id, cwd, tool}` rows
//! and Node adds `busyMs` itself.
use crate::transcript_bridge::ResponseBody;
use crate::transcript_service::{Inputs, TranscriptService};
use crate::transcripts::TranscriptRawText;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeMap};
use serde_json::value::RawValue;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::SystemTime;

const CACHE_MAX: usize = 1000;

// $ per million tokens: (prefix, input, output, cacheReadMult). Mirrors stats.mjs PRICES.
const PRICES: &[(&str, f64, f64, f64)] = &[
    ("claude-fable-5", 10.0, 50.0, 0.1),
    ("claude-mythos", 10.0, 50.0, 0.1),
    ("claude-opus-5-5", 4.0, 20.0, 0.05),
    ("claude-opus-5", 5.0, 25.0, 0.1),
    ("claude-opus-4-5", 5.0, 25.0, 0.1),
    ("claude-opus-4-6", 5.0, 25.0, 0.1),
    ("claude-opus-4-7", 5.0, 25.0, 0.1),
    ("claude-opus-4-8", 5.0, 25.0, 0.1),
    ("claude-opus-4-1", 15.0, 75.0, 0.1),
    ("claude-opus-4-0", 15.0, 75.0, 0.1),
    ("claude-3-opus", 15.0, 75.0, 0.1),
    ("claude-3-7-sonnet", 3.0, 15.0, 0.1),
    ("claude-3-5-sonnet", 3.0, 15.0, 0.1),
    ("claude-sonnet-5-5", 2.0, 10.0, 0.1),
    ("claude-sonnet-5", 2.0, 10.0, 0.1),
    ("claude-sonnet", 3.0, 15.0, 0.1),
    ("claude-haiku-5-5", 0.1, 0.5, 0.1),
    ("claude-haiku-4-5", 1.0, 5.0, 0.1),
    ("claude-3-5-haiku", 1.0, 5.0, 0.1),
];

/// A JavaScript number leaf: ryu-js text, non-finite as `null` (JSON.stringify).
#[derive(Clone, Copy, Debug)]
pub struct Num(pub f64);

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if !self.0.is_finite() {
            return serializer.serialize_none();
        }
        let text = ryu_js::Buffer::new().format_finite(self.0).to_owned();
        serde_json::Number::from_str(&text)
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    turns: u64,
    tokens: Num,
    input_tokens: Num,
    output_tokens: Num,
    cache_read_tokens: Num,
    cache_write_tokens: Num,
    models: Vec<RawModel>,
    exists: bool,
    est_cost_usd: Option<Num>,
}

enum ModelKey {
    String(Vec<u16>),
    Number(u64),
    Other(Vec<u16>),
}

#[derive(Clone, Serialize)]
#[serde(untagged)]
enum RawModel {
    String(TranscriptRawText),
    Value(Box<RawValue>),
}

impl SessionStats {
    fn new(exists: bool) -> Self {
        Self {
            turns: 0,
            tokens: Num(0.0),
            input_tokens: Num(0.0),
            output_tokens: Num(0.0),
            cache_read_tokens: Num(0.0),
            cache_write_tokens: Num(0.0),
            models: Vec::new(),
            exists,
            est_cost_usd: None,
        }
    }
    fn add(&mut self, input: f64, output: f64, cache_read: f64, cache_write: f64) {
        self.input_tokens.0 += input;
        self.output_tokens.0 += output;
        self.cache_read_tokens.0 += cache_read;
        self.cache_write_tokens.0 += cache_write;
        self.tokens.0 += input + output + cache_read + cache_write;
    }
    fn add_model(&mut self, seen: &mut Vec<ModelKey>, raw: &RawValue) {
        let Some(units) = TranscriptRawText::from_json_token(raw.get().to_owned())
            .ok()
            .and_then(|text| text.units().ok())
        else {
            return;
        };
        if seen
            .iter()
            .any(|key| matches!(key, ModelKey::String(value) if value == &units))
        {
            return;
        }
        if let Some(text) = js_string_token(&units) {
            seen.push(ModelKey::String(units));
            self.models.push(RawModel::String(text));
        }
    }

    fn add_raw_model(&mut self, seen: &mut Vec<ModelKey>, raw: &RawValue, exclude_synthetic: bool) {
        if raw.get().starts_with('"') {
            if exclude_synthetic
                && serde_json::from_str::<String>(raw.get()).ok().as_deref() == Some("<synthetic>")
            {
                return;
            }
            self.add_model(seen, raw);
            return;
        }
        let token = raw.get();
        if token.starts_with('[') || token.starts_with('{') {
            if let Ok(model) = RawValue::from_string(token.to_owned()) {
                self.models.push(RawModel::Value(model));
            }
            return;
        }
        if let Ok(number) = token.parse::<f64>() {
            let value = if number == 0.0 { 0.0 } else { number };
            if seen
                .iter()
                .any(|key| matches!(key, ModelKey::Number(bits) if *bits == value.to_bits()))
            {
                return;
            }
            seen.push(ModelKey::Number(value.to_bits()));
            if let Ok(model) = RawValue::from_string(serde_json::to_string(&Num(number)).unwrap()) {
                self.models.push(RawModel::Value(model));
            }
        } else {
            let key = token.encode_utf16().collect::<Vec<_>>();
            if !seen
                .iter()
                .any(|seen| matches!(seen, ModelKey::Other(value) if value == &key))
            {
                seen.push(ModelKey::Other(key));
                if let Ok(model) = RawValue::from_string(token.to_owned()) {
                    self.models.push(RawModel::Value(model));
                }
            }
        }
    }
}

/// JSON.stringify of a JS string from its UTF-16 units (lone surrogates as `\udxxx`),
/// so a source token like `"A"` re-serializes as `"A"` exactly as Node does.
fn js_string_token(units: &[u16]) -> Option<TranscriptRawText> {
    use std::fmt::Write as _;
    let mut token = String::from("\"");
    for item in char::decode_utf16(units.iter().copied()) {
        match item {
            Ok('"') => token.push_str("\\\""),
            Ok('\\') => token.push_str("\\\\"),
            Ok('\u{8}') => token.push_str("\\b"),
            Ok('\u{c}') => token.push_str("\\f"),
            Ok('\n') => token.push_str("\\n"),
            Ok('\r') => token.push_str("\\r"),
            Ok('\t') => token.push_str("\\t"),
            Ok(c) if (c as u32) < 0x20 => write!(token, "\\u{:04x}", c as u32).ok()?,
            Ok(c) => token.push(c),
            Err(lone) => write!(token, "\\u{:04x}", lone.unpaired_surrogate()).ok()?,
        }
    }
    token.push('"');
    TranscriptRawText::from_json_token(token).ok()
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostFile {
    cost_usd: Option<Num>,
    api_ms: Option<Num>,
    wall_ms: Option<Num>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEntry {
    #[serde(flatten)]
    session: SessionStats,
    cost_usd: Option<Num>,
    cost_source: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEntry {
    #[serde(flatten)]
    entry: SessionEntry,
    api_ms: Option<Num>,
    wall_ms: Option<Num>,
}

struct Entries(Vec<(String, AgentEntry)>);

impl Serialize for Entries {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (id, entry) in &self.0 {
            map.serialize_entry(id, entry)?;
        }
        map.end()
    }
}

#[derive(Clone, Deserialize)]
pub struct StatsAgent {
    pub id: String,
    pub cwd: String,
    #[serde(default)]
    pub tool: Option<String>,
}

/// Flattened into the daemon request; every key is `stats_`-prefixed.
#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub struct StatsRequest {
    pub stats_claude_home: Option<String>,
    pub stats_codex_home: Option<String>,
    pub stats_usage_state: Option<String>,
    pub stats_state_dir: Option<String>,
    pub stats_agents: Option<Vec<StatsAgent>>,
    pub stats_project: Option<String>,
    pub stats_id: Option<String>,
    pub stats_root: Option<String>,
}

#[derive(Default)]
pub struct StatsService {
    cache: HashMap<PathBuf, (Option<SystemTime>, u64, SessionStats)>,
    order: VecDeque<PathBuf>,
}

impl StatsService {
    pub fn dispatch(&mut self, op: &str, request: &StatsRequest) -> ResponseBody {
        let (Some(claude_home), Some(usage_state)) = (
            request.stats_claude_home.as_deref(),
            request.stats_usage_state.as_deref(),
        ) else {
            return invalid();
        };
        let cost_dir = Path::new(usage_state).join("cost-state");
        let json = match op {
            "agent_stats" => {
                let (Some(agents), Some(codex_home)) = (
                    request.stats_agents.as_ref(),
                    request.stats_codex_home.as_deref(),
                ) else {
                    return invalid();
                };
                serde_json::to_string(&self.agent_stats(
                    agents,
                    Path::new(claude_home),
                    Path::new(codex_home),
                    &cost_dir,
                ))
            }
            "transcript_stats" => {
                let (Some(state_dir), Some(project), Some(id)) = (
                    request.stats_state_dir.as_deref(),
                    request.stats_project.as_deref(),
                    request.stats_id.as_deref(),
                ) else {
                    return invalid();
                };
                let service = TranscriptService::new(Inputs {
                    state_dir: state_dir.into(),
                    claude_home: claude_home.into(),
                    codex_home: PathBuf::new(),
                    model_catalog: Vec::new(),
                });
                let path = service.path_for(project, id, request.stats_root.as_deref());
                serde_json::to_string(&self.session_stats(path.as_deref(), id, &cost_dir))
            }
            _ => return error("unknown_operation", "unknown stats operation"),
        };
        match json.map(RawValue::from_string) {
            Ok(Ok(raw)) => ResponseBody::Raw(raw),
            Ok(Err(e)) | Err(e) => error("serialization", &e.to_string()),
        }
    }

    fn session_stats(&mut self, path: Option<&Path>, id: &str, cost_dir: &Path) -> SessionEntry {
        let session = match path {
            Some(path) => self.parse_by_path(path),
            None => SessionStats::new(false),
        };
        merge_cost(session, read_cost_file(cost_dir, id).cost_usd)
    }

    fn agent_stats(
        &mut self,
        agents: &[StatsAgent],
        claude_home: &Path,
        codex_home: &Path,
        cost_dir: &Path,
    ) -> Entries {
        let mut out: Vec<(String, AgentEntry)> = Vec::new();
        for agent in agents {
            let session = self.parse_session(agent, claude_home, codex_home);
            let cost = read_cost_file(cost_dir, &agent.id);
            let entry = AgentEntry {
                entry: merge_cost(session, cost.cost_usd),
                api_ms: cost.api_ms,
                wall_ms: cost.wall_ms,
            };
            // JS object assignment: a repeated id keeps its first position, last value.
            match out.iter_mut().find(|(id, _)| id == &agent.id) {
                Some(slot) => slot.1 = entry,
                None => out.push((agent.id.clone(), entry)),
            }
        }
        Entries(out)
    }

    fn parse_session(
        &mut self,
        agent: &StatsAgent,
        claude_home: &Path,
        codex_home: &Path,
    ) -> SessionStats {
        if agent.tool.as_deref() == Some("codex") {
            return match find_codex_rollout_for_cwd(codex_home, &agent.cwd) {
                Some(path) => self.parse_codex_rollout(&path),
                None => SessionStats::new(false),
            };
        }
        let path = claude_home
            .join(".claude")
            .join("projects")
            .join(encode_cwd(&agent.cwd))
            .join(format!("{}.jsonl", agent.id));
        self.parse_by_path(&path)
    }

    fn cached(&mut self, path: &Path, parse: fn(&str) -> SessionStats) -> SessionStats {
        let Ok(meta) = fs::metadata(path) else {
            return SessionStats::new(false);
        };
        let key = (meta.modified().ok(), meta.len());
        if let Some((mtime, size, hit)) = self.cache.get(path) {
            if (*mtime, *size) == key {
                return hit.clone();
            }
        }
        // Partial/locked/unreadable file: Node returns what it has (zeros), exists:true.
        let result = match fs::read(path) {
            Ok(bytes) => parse(&String::from_utf8_lossy(&bytes)),
            Err(_) => SessionStats::new(true),
        };
        if self
            .cache
            .insert(path.to_owned(), (key.0, key.1, result.clone()))
            .is_none()
        {
            self.order.push_back(path.to_owned());
        }
        if self.cache.len() > CACHE_MAX {
            if let Some(oldest) = self.order.pop_front() {
                self.cache.remove(&oldest);
            }
        }
        result
    }

    pub fn parse_by_path(&mut self, path: &Path) -> SessionStats {
        self.cached(path, parse_claude_text)
    }

    pub fn parse_codex_rollout(&mut self, path: &Path) -> SessionStats {
        self.cached(path, parse_codex_text)
    }
}

fn merge_cost(session: SessionStats, cost_usd: Option<Num>) -> SessionEntry {
    let cost_source = match (cost_usd, session.est_cost_usd) {
        (Some(_), _) => Some("statusline"),
        (None, Some(_)) => Some("estimate"),
        (None, None) => None,
    };
    SessionEntry {
        cost_usd: cost_usd.or(session.est_cost_usd),
        cost_source,
        session,
    }
}

fn invalid() -> ResponseBody {
    error("invalid_request", "missing stats request inputs")
}

fn error(code: &str, message: &str) -> ResponseBody {
    ResponseBody::Value(serde_json::json!({"error": message, "code": code}))
}

/// agents.mjs encodeCwd: every non-ASCII-alphanumeric UTF-16 unit becomes '-'.
pub fn encode_cwd(cwd: &str) -> String {
    cwd.encode_utf16()
        .map(|unit| match char::from_u32(unit as u32) {
            Some(c) if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect()
}

// ---- JSON helpers mirroring JavaScript truthiness / coercion on raw tokens ----

type Raw = Option<Box<RawValue>>;

fn is_null(line: &str) -> bool {
    serde_json::from_str::<()>(line).is_ok()
}

fn as_str(raw: &Raw) -> Option<String> {
    let raw = raw.as_ref()?;
    raw.get()
        .starts_with('"')
        .then(|| serde_json::from_str::<String>(raw.get()).ok())
        .flatten()
}

fn is_str(raw: &Raw, want: &str) -> bool {
    as_str(raw).is_some_and(|text| text == want)
}

fn number(raw: &RawValue) -> Option<f64> {
    let text = raw.get();
    (text.starts_with('-') || text.starts_with(|c: char| c.is_ascii_digit()))
        .then(|| text.parse::<f64>().ok())
        .flatten()
}

fn truthy(raw: &Raw) -> bool {
    let Some(raw) = raw else { return false };
    match raw.get() {
        "null" | "false" | "\"\"" => false,
        _ => number(raw).is_none_or(|n| n != 0.0),
    }
}

fn is_string(raw: &Raw) -> bool {
    raw.as_ref().is_some_and(|raw| raw.get().starts_with('"'))
}

fn object<T: for<'de> Deserialize<'de> + Default>(raw: &Raw) -> T {
    raw.as_ref()
        .filter(|raw| raw.get().starts_with('{'))
        .and_then(|raw| serde_json::from_str(raw.get()).ok())
        .unwrap_or_default()
}

/// `v || 0` used arithmetically. shortcut: string/object operands (which JS
/// would concatenate) count as 0; upgrade if transcripts ever carry them.
fn or_zero(raw: &Raw) -> f64 {
    match raw.as_ref() {
        Some(raw) if raw.get() == "true" => 1.0,
        Some(raw) => number(raw).unwrap_or(0.0),
        None => 0.0,
    }
}

/// stats.mjs `num`: Number(v) when finite, else 0. shortcut: hex/binary string
/// literals and single-element arrays coerce to 0 here; JS would parse them.
fn js_num(raw: &Raw) -> f64 {
    let value = match raw.as_ref() {
        None => 0.0,
        Some(raw) => match raw.get() {
            "true" => 1.0,
            "false" | "null" => 0.0,
            text if text.starts_with('"') => match serde_json::from_str::<String>(text) {
                Ok(text) => {
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        0.0
                    } else if trimmed
                        .chars()
                        .any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E')
                    {
                        f64::NAN
                    } else {
                        trimmed.parse::<f64>().unwrap_or(f64::NAN)
                    }
                }
                Err(_) => f64::NAN,
            },
            _ => number(raw).unwrap_or(f64::NAN),
        },
    };
    if value.is_finite() { value } else { 0.0 }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Line {
    #[serde(rename = "type")]
    kind: Raw,
    message: Raw,
    payload: Raw,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Message {
    model: Raw,
    usage: Raw,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Usage {
    input_tokens: Raw,
    output_tokens: Raw,
    cache_read_input_tokens: Raw,
    cache_creation_input_tokens: Raw,
    cache_creation: Raw,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CacheCreation {
    ephemeral_5m_input_tokens: Raw,
    ephemeral_1h_input_tokens: Raw,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Payload {
    #[serde(rename = "type")]
    kind: Raw,
    model: Raw,
    role: Raw,
    info: Raw,
    cwd: Raw,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Info {
    last_token_usage: Raw,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct LastUsage {
    cached_input_tokens: Raw,
    cache_write_input_tokens: Raw,
    input_tokens: Raw,
    output_tokens: Raw,
}

fn lines(content: &str) -> impl Iterator<Item = &str> {
    content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.is_empty())
}

fn price_for(model: &[u16]) -> Option<(f64, f64, f64)> {
    let mut prices = PRICES.to_vec();
    prices.sort_by_key(|price| std::cmp::Reverse(price.0.len()));
    prices
        .into_iter()
        .find(|price| model.starts_with(&price.0.encode_utf16().collect::<Vec<_>>()))
        .map(|(_, input, output, mult)| (input, output, mult))
}

fn parse_claude_text(content: &str) -> SessionStats {
    let mut result = SessionStats::new(true);
    let mut seen = Vec::new();
    let mut est: Option<f64> = None;
    for line in lines(content) {
        if is_null(line) {
            break; // `o.type` on null throws; Node's outer catch keeps the partial result
        }
        let Ok(o) = serde_json::from_str::<Line>(line) else {
            continue;
        };
        if is_str(&o.kind, "assistant") {
            result.turns += 1;
        }
        let message: Message = object(&o.message);
        if !truthy(&message.usage) {
            continue;
        }
        let u: Usage = object(&message.usage);
        let input = or_zero(&u.input_tokens);
        let output = or_zero(&u.output_tokens);
        let cache_read = or_zero(&u.cache_read_input_tokens);
        let cache_create = or_zero(&u.cache_creation_input_tokens);
        result.add(input, output, cache_read, cache_create);
        if truthy(&message.model) {
            result.add_raw_model(&mut seen, message.model.as_deref().unwrap(), true);
        }
        if truthy(&message.model) && !is_string(&message.model) {
            break; // non-string model: `model.startsWith` throws in priceFor
        }
        let model_units = message
            .model
            .as_ref()
            .filter(|_| truthy(&message.model))
            .and_then(|raw| TranscriptRawText::from_json_token(raw.get().to_owned()).ok())
            .and_then(|text| text.units().ok());
        let Some(model_units) = model_units else {
            continue;
        };
        let Some((p_in, p_out, read_mult)) = price_for(&model_units) else {
            continue;
        };
        let mut cost = (input * p_in + output * p_out) / 1e6;
        cost += (cache_read * p_in * read_mult) / 1e6;
        let cc: CacheCreation = object(&u.cache_creation);
        let present = |raw: &Raw| raw.as_ref().is_some_and(|raw| raw.get() != "null");
        if present(&cc.ephemeral_5m_input_tokens) || present(&cc.ephemeral_1h_input_tokens) {
            cost += (or_zero(&cc.ephemeral_5m_input_tokens) * p_in * 1.25) / 1e6;
            cost += (or_zero(&cc.ephemeral_1h_input_tokens) * p_in * 2.0) / 1e6;
        } else {
            cost += (cache_create * p_in * 1.25) / 1e6;
        }
        est = Some(est.unwrap_or(0.0) + cost);
    }
    result.est_cost_usd = est.map(Num);
    result
}

fn parse_codex_text(content: &str) -> SessionStats {
    let mut result = SessionStats::new(true);
    let mut seen = Vec::new();
    for line in lines(content) {
        if is_null(line) {
            break;
        }
        let Ok(o) = serde_json::from_str::<Line>(line) else {
            continue;
        };
        let payload: Payload = object(&o.payload);
        if is_str(&o.kind, "turn_context") && truthy(&payload.model) {
            result.add_raw_model(&mut seen, payload.model.as_deref().unwrap(), false);
        }
        if is_str(&o.kind, "response_item")
            && is_str(&payload.kind, "message")
            && is_str(&payload.role, "assistant")
        {
            result.turns += 1;
        }
        if is_str(&o.kind, "event_msg") && is_str(&payload.kind, "token_count") {
            let info: Info = object(&payload.info);
            let last: LastUsage = object(&info.last_token_usage);
            let cache_read = js_num(&last.cached_input_tokens);
            let cache_write = js_num(&last.cache_write_input_tokens);
            let input = (js_num(&last.input_tokens) - cache_read).max(0.0);
            let output = js_num(&last.output_tokens);
            result.add(input, output, cache_read, cache_write);
        }
    }
    result
}

fn norm_cwd(cwd: &str) -> String {
    cwd.to_lowercase().replace('\\', "/")
}

fn read_head(path: &Path) -> String {
    let mut buffer = vec![0u8; 4096];
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let Ok(n) = file.read(&mut buffer) else {
        return String::new();
    };
    String::from_utf8_lossy(&buffer[..n]).into_owned()
}

fn codex_rollout_cwd(path: &Path, want: &str) -> bool {
    for line in lines(&read_head(path)) {
        let Ok(o) = serde_json::from_str::<Line>(line) else {
            continue;
        };
        let payload: Payload = object(&o.payload);
        if is_str(&o.kind, "session_meta") && truthy(&payload.cwd) {
            return as_str(&payload.cwd).is_some_and(|cwd| norm_cwd(&cwd) == want);
        }
    }
    false
}

fn names(dir: &Path, dirs_only: bool) -> Option<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| !dirs_only || entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Some(names)
}

fn last_n(mut items: Vec<String>, n: usize) -> Vec<String> {
    let skip = items.len().saturating_sub(n);
    items.drain(..skip);
    items.reverse();
    items
}

/// Newest 2 years x 2 months x 3 days, newest 10 rollouts by mtime in each.
fn find_codex_rollout_for_cwd(codex_home: &Path, cwd: &str) -> Option<PathBuf> {
    let want = norm_cwd(cwd);
    let sessions = codex_home.join("sessions");
    let years = names(&sessions, false)?;
    for year in last_n(years, 2) {
        let months = names(&sessions.join(&year), true).unwrap_or_default();
        for month in last_n(months, 2) {
            let days = names(&sessions.join(&year).join(&month), true).unwrap_or_default();
            for day in last_n(days, 3) {
                let dir = sessions.join(&year).join(&month).join(&day);
                let Some(files) = names(&dir, false) else {
                    continue;
                };
                // shortcut: a stat failure sorts as oldest; Node's statSync would throw.
                let mut sorted: Vec<(PathBuf, Option<SystemTime>)> = files
                    .into_iter()
                    .filter(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
                    .map(|name| {
                        let path = dir.join(name);
                        let mtime = fs::metadata(&path).and_then(|m| m.modified()).ok();
                        (path, mtime)
                    })
                    .collect();
                sorted.sort_by(|a, b| b.1.cmp(&a.1));
                if let Some((path, _)) = sorted
                    .into_iter()
                    .take(10)
                    .find(|(path, _)| codex_rollout_cwd(path, &want))
                {
                    return Some(path);
                }
            }
        }
    }
    None
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CostDoc {
    cost: Raw,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CostFields {
    total_cost_usd: Raw,
    total_api_duration_ms: Raw,
    total_duration_ms: Raw,
}

/// stats.mjs readCostFile: `cost-state/<id>.json`, typeof-number fields only.
pub fn read_cost_file(cost_dir: &Path, id: &str) -> CostFile {
    let fields = fs::read(cost_dir.join(format!("{id}.json")))
        .ok()
        .and_then(|bytes| {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            serde_json::from_str::<CostDoc>(&text).ok()
        })
        .map(|doc| object::<CostFields>(&doc.cost))
        .unwrap_or_default();
    let field = |raw: &Raw| raw.as_deref().and_then(number).map(Num);
    CostFile {
        cost_usd: field(&fields.total_cost_usd),
        api_ms: field(&fields.total_api_duration_ms),
        wall_ms: field(&fields.total_duration_ms),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn scratch(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("stats-rs-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
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

    const CLAUDE_FIXTURE: &str = concat!(
        r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200,"cache_creation_input_tokens":100}}}"#,
        "\r\n",
        r#"{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":7,"output_tokens":3,"cache_read_input_tokens":11,"cache_creation_input_tokens":13,"cache_creation":{"ephemeral_5m_input_tokens":5,"ephemeral_1h_input_tokens":8}}}}"#,
        "\n",
        r#"{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":3,"output_tokens":1,"cache_creation":{"ephemeral_1h_input_tokens":null}}}}"#,
        "\n",
        r#"{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":9,"output_tokens":true}}}"#,
        "\n",
        r#"{"type":"assistant","message":{"model":"gpt-4o \ud800 lone","content":"x\udc00","usage":{"input_tokens":10,"output_tokens":20}}}"#,
        "\n",
        r#"{"type":"assistant","message":{"model":"gpt-4o \ud800 lone","usage":{"input_tokens":0.5,"output_tokens":1e2}}}"#,
        "\n",
        r#"{"type":"user","message":{"usage":0}}"#,
        "\n",
        r#"{"type":"user","message":{"usage":"truthy"}}"#,
        "\n",
        "not json\n",
        "[1,2]\n",
        "42\n",
        r#"{"type":"assistant","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":123456789,"output_tokens":987654321}}}"#,
        "\n",
        "null\n",
        r#"{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":99}}}"#,
        "\n",
    );

    const CODEX_FIXTURE: &str = concat!(
        r#"{"type":"session_meta","payload":{"cwd":"C:\\Work\\Repo"}}"#,
        "\n",
        r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#,
        "\n",
        r#"{"type":"turn_context","payload":{"model":42}}"#,
        "\n",
        r#"{"type":"turn_context","payload":{"model":42.0}}"#,
        "\n",
        r#"{"type":"turn_context","payload":{"model":["gpt-5.5"]}}"#,
        "\n",
        r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#,
        "\n",
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant"}}"#,
        "\n",
        r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":"12","cache_write_input_tokens":" 3 "}}}}"#,
        "\r\n",
        r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":5,"cached_input_tokens":9,"output_tokens":true}}}}"#,
        "\n",
        r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#,
        "\n",
    );

    fn write_cost(dir: &Path, id: &str, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(format!("{id}.json")), body).unwrap();
    }

    #[test]
    fn stats_rust_matches_node_oracle_on_fixtures() {
        let root = scratch("oracle");
        let usage_state = root.join("usage-state");
        let cost_dir = usage_state.join("cost-state");
        let codex_home = root.join("codex");
        let claude = root.join("a.jsonl");
        fs::write(&claude, CLAUDE_FIXTURE).unwrap();
        let empty = root.join("empty.jsonl");
        fs::write(&empty, "").unwrap();
        let missing = root.join("missing.jsonl");
        let claude_error = root.join("claude-error.jsonl");
        fs::write(&claude_error, concat!(
            r#"{"type":"assistant","message":{"model":42,"usage":{"input_tokens":1}}}"#,
            "\n",
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":99}}}"#,
            "\n",
        )).unwrap();
        let day = codex_home.join("sessions/2026/10/25");
        fs::create_dir_all(&day).unwrap();
        let rollout = day.join("rollout-2026-10-25-a.jsonl");
        fs::write(&rollout, CODEX_FIXTURE).unwrap();
        let rollout_reverse = day.join("rollout-2026-10-25-c.jsonl");
        fs::write(
            &rollout_reverse,
            concat!(
                r#"{"type":"turn_context","payload":{"model":42.0}}"#,
                "\n",
                r#"{"type":"turn_context","payload":{"model":42}}"#,
            ),
        )
        .unwrap();
        fs::write(
            day.join("rollout-2026-10-25-b.jsonl"),
            r#"{"type":"session_meta","payload":{"cwd":"C:/elsewhere"}}"#,
        )
        .unwrap();
        write_cost(
            &cost_dir,
            "full",
            r#"{"cost":{"total_cost_usd":1.230,"total_api_duration_ms":111,"total_duration_ms":2e2}}"#,
        );
        write_cost(
            &cost_dir,
            "strings",
            r#"{"cost":{"total_cost_usd":"1.5","total_api_duration_ms":null}}"#,
        );
        write_cost(
            &cost_dir,
            "huge",
            r#"{"cost":{"total_cost_usd":1e400},"x":"\ud800"}"#,
        );
        write_cost(&cost_dir, "array", r#"[1]"#);
        write_cost(&cost_dir, "bad", "{nope");
        write_cost(
            &cost_dir,
            "bom",
            "\u{feff}{\"cost\":{\"total_cost_usd\":7}}",
        );
        let ids = ["full", "strings", "huge", "array", "bad", "bom", "absent"];
        let priced = root.join("bom-priced.jsonl");
        fs::write(&priced, r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":1000}}}"#).unwrap();

        #[derive(Serialize)]
        struct Oracle {
            claude: Vec<SessionStats>,
            codex: Vec<SessionStats>,
            find: SessionStats,
            costs: Vec<CostFile>,
        }
        let mut service = StatsService::default();
        let merged_bom = merge_cost(
            service.parse_by_path(&priced),
            read_cost_file(&cost_dir, "bom").cost_usd,
        );
        assert_eq!(merged_bom.cost_source, Some("estimate"));
        assert_eq!(merged_bom.cost_usd.unwrap().0, 0.003);
        let agent = StatsAgent {
            id: "x".into(),
            cwd: "C:\\WORK\\Repo".into(),
            tool: Some("codex".into()),
        };
        let rust = serde_json::to_string(&Oracle {
            claude: [&claude, &claude_error, &empty, &missing]
                .iter()
                .map(|path| service.parse_by_path(path))
                .collect(),
            codex: vec![
                service.parse_codex_rollout(&rollout),
                service.parse_codex_rollout(&rollout_reverse),
            ],
            find: service.parse_session(&agent, &root, &codex_home),
            costs: ids.iter().map(|id| read_cost_file(&cost_dir, id)).collect(),
        })
        .unwrap();
        assert!(rust.contains(r#""gpt-4o \ud800 lone""#), "{rust}");

        let oracle = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/stats_oracle.mjs");
        let request = serde_json::json!({
            "claude": [&claude, &claude_error, &empty, &missing],
            "codex": [&rollout, &rollout_reverse],
            "findCwd": agent.cwd,
            "costIds": ids,
        });
        let mut child = Command::new(node_path())
            .arg(oracle)
            .env("SINGULARITY_HOME", root.join("sing"))
            .env("USAGE_REPORT_STATE", &usage_state)
            .env("CODEX_HOME", &codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn node oracle");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(request.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // Byte-exact against Node's JSON.stringify (numbers, key order, surrogate escapes).
        assert_eq!(rust, String::from_utf8(output.stdout).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stats_estimate_and_bucket_math_matches_node_unit_test() {
        let stats = parse_claude_text(
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200,"cache_creation_input_tokens":100}}}"#,
        );
        assert_eq!(stats.turns, 1);
        assert_eq!(stats.tokens.0, 1800.0);
        assert!((stats.est_cost_usd.unwrap().0 - 0.010935).abs() < 1e-9);
        let json = serde_json::to_string(&stats).unwrap();
        assert!(
            json.starts_with(r#"{"turns":1,"tokens":1800,"inputTokens":1000,"#),
            "{json}"
        );
    }

    #[test]
    fn stats_dispatch_merges_statusline_cost_and_keeps_raw_surrogate_model() {
        let root = scratch("dispatch");
        let cwd = "C:\\x\\stats-dispatch";
        let project_dir = root.join(".claude/projects").join(encode_cwd(cwd));
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(
            project_dir.join("agent-1.jsonl"),
            r#"{"type":"assistant","message":{"model":"m\ud800","usage":{"input_tokens":4}}}"#,
        )
        .unwrap();
        write_cost(
            &root.join("usage/cost-state"),
            "agent-1",
            r#"{"cost":{"total_cost_usd":1.23,"total_api_duration_ms":111,"total_duration_ms":222}}"#,
        );
        let mut service = StatsService::default();
        let request = StatsRequest {
            stats_claude_home: Some(root.to_string_lossy().into_owned()),
            stats_codex_home: Some(root.join("codex").to_string_lossy().into_owned()),
            stats_usage_state: Some(root.join("usage").to_string_lossy().into_owned()),
            stats_state_dir: Some(root.join("state").to_string_lossy().into_owned()),
            stats_agents: Some(vec![StatsAgent {
                id: "agent-1".into(),
                cwd: cwd.into(),
                tool: None,
            }]),
            stats_project: Some(encode_cwd(cwd)),
            stats_id: Some("agent-1".into()),
            stats_root: Some(root.join(".claude/projects").to_string_lossy().into_owned()),
        };
        let ResponseBody::Raw(agents) = service.dispatch("agent_stats", &request) else {
            panic!("agent stats must be raw JSON")
        };
        assert_eq!(
            agents.get(),
            r#"{"agent-1":{"turns":1,"tokens":4,"inputTokens":4,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"models":["m\ud800"],"exists":true,"estCostUsd":null,"costUsd":1.23,"costSource":"statusline","apiMs":111,"wallMs":222}}"#
        );
        let ResponseBody::Raw(session) = service.dispatch("transcript_stats", &request) else {
            panic!("transcript stats must be raw JSON")
        };
        assert!(
            session
                .get()
                .ends_with(r#""costUsd":1.23,"costSource":"statusline"}"#)
        );
        let ResponseBody::Raw(escaped) = service.dispatch(
            "transcript_stats",
            &StatsRequest {
                stats_project: Some("..".into()),
                ..request.clone()
            },
        ) else {
            panic!()
        };
        assert!(escaped.get().contains(r#""exists":false"#));
        let ResponseBody::Value(bad) = service.dispatch("agent_stats", &StatsRequest::default())
        else {
            panic!()
        };
        assert_eq!(bad["code"], "invalid_request");
        fs::remove_dir_all(root).unwrap();
    }
}
