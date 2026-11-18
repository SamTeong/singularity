//! Wire shapes of the agent registry: `agents.json` records and the UI snapshot.
//!
//! Port of the shapes `server/agents.mjs` persists (`persist`, `:87-105`), loads
//! (`init`, `:107-123`) and hands the UI (`snapshot`, `:126-128`).
//!
//! Three types:
//! - [`AgentRecord`] — one `agents.json` entry, camelCase, absent (`undefined`)
//!   fields omitted exactly like `JSON.stringify` does for `undefined`
//!   (`:89-95`). Runtime-only state (pid, ring buffer, decoder carry, …) lives
//!   in the registry, never here.
//! - [`AgentsFile`] — the `{ agents, recentRepos }` document (`:88-96`) written
//!   as 2-space pretty JSON (`JSON.stringify(data, null, 2)`, `:98`).
//! - [`AgentWire`] — the per-agent object `snapshot()` sends (`:126-128`):
//!   `{ id, title, cwd, status, pid, createdAt, model, scopes, tool }`.
//!
//! Legacy load: pre-rename records stored the display field as `name`
//! (`:110-119`); [`AgentRecord::normalize_legacy`] folds it into `title` and
//! `name` is never written back.

use serde::{Deserialize, Serialize};

// VERIFY: agent-wire-status
/// The five registry states (`agents.mjs:443`, `:204-209`, `:118`). Serialized
/// lowercase, as Node stores and sends them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Starting,
    Running,
    Idle,
    Exited,
    #[default]
    Detached,
}

impl Status {
    // VERIFY: agent-wire-status-str
    /// The string Node compares against (`'running'`, `'detached'`, …).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Idle => "idle",
            Self::Exited => "exited",
            Self::Detached => "detached",
        }
    }
}

// VERIFY: agent-wire-record
/// One `agents.json` entry (`agents.mjs:89-94`). Field order matches the Node
/// object literal so the persisted JSON key order is identical: `id, title,
/// cwd, createdAt, model, scopes, permissionMode, extraArgs, mock, tool,
/// threadId, runId, activeMs, status`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentRecord {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mock: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_ms: Option<i64>,
    pub status: Status,
    /// Legacy display field (`agents.mjs:117`): accepted on load, mapped into
    /// `title` by [`AgentRecord::normalize_legacy`], never serialized.
    #[serde(default, skip_serializing)]
    pub name: Option<String>,
}

impl AgentRecord {
    // VERIFY: agent-wire-normalize-legacy
    /// `if (a.title == null && a.name != null) a.title = a.name` (`:117`).
    pub fn normalize_legacy(&mut self) {
        if self.title.is_none() {
            self.title = self.name.take();
        }
    }
}

// VERIFY: agent-wire-file
/// The `agents.json` document (`agents.mjs:88-96`): `{ agents, recentRepos }`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentsFile {
    pub agents: Vec<AgentRecord>,
    pub recent_repos: Vec<String>,
}

impl AgentsFile {
    /// `JSON.stringify(data, null, 2)` (`:98`): 2-space pretty, no trailing
    /// newline.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("an AgentsFile always serializes")
    }

    /// `JSON.parse(readFileSync(STATE_FILE, 'utf8'))` (`:111`); a missing
    /// `agents`/`recentRepos` key falls back to `[]` (`:112-113`).
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }
}

// VERIFY: agent-wire-summary
/// The UI-facing per-agent object `snapshot()` builds (`agents.mjs:126-128`),
/// with absent fields omitted like `undefined`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentWire {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn record_serializes_camel_case_and_omits_absent_fields() {
        let record = AgentRecord {
            id: "a".to_owned(),
            title: Some("demo".to_owned()),
            cwd: Some("C:\\work".to_owned()),
            created_at: Some(1_700_000_000_000),
            model: None,
            scopes: None,
            permission_mode: None,
            extra_args: None,
            mock: Some(false),
            tool: None,
            thread_id: None,
            run_id: None,
            active_ms: Some(0),
            status: Status::Detached,
            name: None,
        };
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(
            value,
            json!({
                "id": "a",
                "title": "demo",
                "cwd": "C:\\work",
                "createdAt": 1_700_000_000_000i64,
                "mock": false,
                "activeMs": 0,
                "status": "detached",
            })
        );
    }

    #[test]
    fn status_round_trips_through_the_node_spellings() {
        for (status, text) in [
            (Status::Starting, "starting"),
            (Status::Running, "running"),
            (Status::Idle, "idle"),
            (Status::Exited, "exited"),
            (Status::Detached, "detached"),
        ] {
            assert_eq!(status.as_str(), text);
            assert_eq!(serde_json::to_value(status).unwrap(), json!(text));
            assert_eq!(
                serde_json::from_value::<Status>(json!(text)).unwrap(),
                status
            );
        }
    }

    #[test]
    fn legacy_name_becomes_title_and_is_never_written_back() {
        let mut record: AgentRecord =
            serde_json::from_value(json!({ "id": "a", "name": "oldname" })).unwrap();
        assert_eq!(record.title, None);
        record.normalize_legacy();
        assert_eq!(record.title.as_deref(), Some("oldname"));
        assert_eq!(record.name, None);

        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value.get("name"), None);
        assert_eq!(value["title"], json!("oldname"));

        // An existing title wins over the legacy field.
        let mut both: AgentRecord =
            serde_json::from_value(json!({ "id": "b", "title": "new", "name": "old" })).unwrap();
        both.normalize_legacy();
        assert_eq!(both.title.as_deref(), Some("new"));
    }

    #[test]
    fn agents_file_writes_the_node_document_shape() {
        let file = AgentsFile {
            agents: vec![AgentRecord {
                id: "a".to_owned(),
                title: Some("demo".to_owned()),
                status: Status::Detached,
                ..AgentRecord::default()
            }],
            recent_repos: vec!["C:\\repo".to_owned()],
        };
        let text = file.to_json();
        assert!(text.starts_with("{\n  \"agents\": [\n"));
        assert!(text.contains("\"recentRepos\""));
        assert!(!text.ends_with('\n'));
        assert_eq!(AgentsFile::parse(&text).unwrap(), file);

        // Missing keys fall back to empty, like `data.agents || []`.
        let empty = AgentsFile::parse("{}").unwrap();
        assert!(empty.agents.is_empty());
        assert!(empty.recent_repos.is_empty());
    }

    #[test]
    fn summary_wire_matches_the_snapshot_field_set() {
        let wire = AgentWire {
            id: "a".to_owned(),
            title: Some("demo".to_owned()),
            cwd: Some("C:\\work".to_owned()),
            status: Status::Running,
            pid: Some(42),
            created_at: Some(1),
            model: None,
            scopes: Some(vec!["coding".to_owned()]),
            tool: Some("claude".to_owned()),
        };
        assert_eq!(
            serde_json::to_value(&wire).unwrap(),
            json!({
                "id": "a",
                "title": "demo",
                "cwd": "C:\\work",
                "status": "running",
                "pid": 42,
                "createdAt": 1,
                "scopes": ["coding"],
                "tool": "claude",
            })
        );
    }
}
