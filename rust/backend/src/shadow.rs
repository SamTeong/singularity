//! `SINGULARITY_SHADOW=1`: read-only follower mode (port of `server/app-dir.mjs`).
//!
//! Another daemon is the only writer of the state dir, so this process serves
//! reads but never writes state, spawns agents or rotates OAuth tokens.

use std::sync::OnceLock;

pub const ERROR: &str = "shadow mode: read-only";

/// Read once: the mode is fixed for the life of the process, as in Node.
pub fn enabled() -> bool {
    static SHADOW: OnceLock<bool> = OnceLock::new();
    *SHADOW.get_or_init(|| std::env::var("SINGULARITY_SHADOW").as_deref() == Ok("1"))
}

/// POSTs that only read (searches and batched stats), allowed in shadow mode.
const SHADOW_POSTS: [&str; 7] = [
    "/config/search",
    "/codex-config/search",
    "/hooks/list",
    "/hooks/search",
    "/rules/files",
    "/rules/search",
    "/transcripts/stats",
];

/// Pure allow decision for the `/api` guard: `path` is the URL without the
/// `/api` prefix or query.
pub fn allows(method: &str, path: &str) -> bool {
    matches!(method, "GET" | "HEAD" | "OPTIONS") || (method == "POST" && SHADOW_POSTS.contains(&path))
}

/// WS message types a shadow socket may send: chat spends tokens, the rest mutate.
pub fn ws_allows(message_type: &str) -> bool {
    matches!(message_type, "attach" | "txmeta" | "chat:stop")
}

/// Bridge ops that write state, spawn processes or rotate credentials.
pub fn bridge_op_writes(op: &str) -> bool {
    matches!(
        op,
        "append_claude"
            | "append_codex"
            | "append_ollama"
            | "claude_credentials_write"
            | "claude_oauth_refresh"
            | "codex_config_write"
            | "config_state_set"
            | "config_write"
            | "detached_spawn"
            | "explorer_create"
            | "explorer_delete"
            | "explorer_rename"
            | "explorer_state_set"
            | "explorer_write"
            | "hooks_write"
            | "keys_set"
            | "memory_write"
            | "model_prices_write"
            | "models_restore"
            | "models_set"
            | "oneshot"
            | "oneshot_async"
            | "ollama_mode_config_write"
            | "picker_roots_set"
            | "procs_kill"
            | "procs_kill_guarded"
            | "rules_write"
            | "skill_write"
            | "skills_roots_set"
            | "transcript_root_set"
            | "usage_report_generate"
            | "wiki_root_set"
            | "window_anchor_save"
            | "window_anchor_telemetry"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_guard_allows_reads_and_read_only_posts_only() {
        assert!(allows("GET", "/usage"));
        assert!(allows("POST", "/config/search"));
        assert!(allows("POST", "/transcripts/stats"));
        assert!(!allows("POST", "/usage/ollama/connect"));
        assert!(!allows("PUT", "/models"));
        assert!(!allows("DELETE", "/tasks/1"));
    }

    #[test]
    fn ws_and_bridge_classification() {
        assert!(ws_allows("attach") && ws_allows("txmeta") && ws_allows("chat:stop"));
        assert!(!ws_allows("create") && !ws_allows("chat") && !ws_allows("input"));
        assert!(bridge_op_writes("models_set") && bridge_op_writes("append_claude"));
        assert!(!bridge_op_writes("models_get") && !bridge_op_writes("transcripts_list"));
    }
}
