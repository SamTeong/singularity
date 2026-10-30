//! The four board-workflow prompts, ported byte-for-byte from
//! `server/tasks.mjs:182-419`:
//!
//! - [`build_task_prompt`] — `buildTaskPrompt` (`:251-373`), orchestrator flow.
//! - [`build_codex_task_prompt`] — `buildCodexTaskPrompt` (`:182-213`).
//! - [`build_background_prompt`] — `buildBackgroundPrompt` (`:384-419`).
//! - [`build_codex_background_prompt`] — `buildCodexBackgroundPrompt`
//!   (`:217-247`).
//!
//! The builders are pure: the model route is resolved once by the caller
//! (`crate::models::route`) and passed as JSON, so no async or filesystem work
//! happens here. Every ambient value the Node module read from `process.env`
//! arrives through [`PromptContext`] — the same values the daemon builds from
//! `TasksConfig` (`DAEMON_PORT`, `SING_TOKEN`, `SING_CAVECREW`).
//!
//! `DAEMON_PORT` unset is `NaN` in Node (`Number(undefined)`), and the port is
//! interpolated into every status URL, so [`PromptContext::port`] keeps that
//! literal when the daemon has no port. Agent definitions are probed through
//! `has_def` (Node's `existsSync(join(cwd, '.claude/agents/<role>.md'))`).

use serde_json::Value;

use crate::task_service::{MAX_REVIEW_REJECTS, Task};

/// Everything a builder needs that Node read ambiently.
pub struct PromptContext<'a> {
    pub task: &'a Task,
    /// `DAEMON_PORT` rendered the way a JS template renders it (`"NaN"` when
    /// unset).
    pub port: &'a str,
    /// `""` or ` -H "x-sing-token: $SING_TOKEN"` (`tasks.mjs:183`).
    pub token_header: &'a str,
    /// `SING_CAVECREW === '1'` (`tasks.mjs:130-132`).
    pub cavecrew: bool,
    /// `task.worktree || task.repo`.
    pub cwd: &'a str,
    /// `<cwd>/.claude/agents/<role>.md` exists.
    pub has_def: &'a dyn Fn(&str) -> bool,
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().unwrap_or(0.0) != 0.0,
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn route_flag(route: &Value, key: &str) -> bool {
    js_truthy(route.get(key))
}

/// A JS template renders `null`/`undefined` as those words; task fields that
/// are `Option` are interpolated, never silently dropped.
fn js_opt(value: Option<&String>) -> &str {
    value.map_or("null", String::as_str)
}

/// An `Option<String>` task field interpolated by a JS template: an absent
/// model field is `undefined` (Node never stores `null` there), while the
/// worktree/branch fields are initialized to `null`.
fn js_undefined(value: Option<&String>) -> &str {
    value.map_or("undefined", String::as_str)
}

/// `t.implModel || (ollama ? t.model : 'sonnet')` — a JS empty string is falsy.
fn model_or(value: &Option<String>, fallback: String) -> String {
    value
        .as_ref()
        .filter(|model| !model.is_empty())
        .cloned()
        .unwrap_or(fallback)
}

fn status(ctx: &PromptContext, column: &str, state: &str) -> String {
    format!(
        "curl -s -X POST http://127.0.0.1:{}/api/tasks/{}/status{} -H \"content-type: application/json\" -d '{{\"column\":\"{column}\",\"state\":\"{state}\"}}'",
        ctx.port, ctx.task.id, ctx.token_header
    )
}

// VERIFY: task-prompts-codex-task
/// `buildCodexTaskPrompt(t)` (`tasks.mjs:182-213`): codex has no Task tool, so
/// a single-agent flow with the same board-status curl contract.
pub fn build_codex_task_prompt(ctx: &PromptContext) -> String {
    let task = ctx.task;
    let cwd = ctx.cwd;
    let git_line = if task.kind == crate::task_service::TaskKind::Git {
        let policy = if task.merge_mode == Some(crate::task_service::MergeMode::Auto) {
            format!(
                "After review, merge {} into {} (git -C \"{}\" merge {}); abort if it conflicts.",
                js_opt(task.branch.as_ref()),
                js_opt(task.base_branch.as_ref()),
                task.repo,
                js_opt(task.branch.as_ref())
            )
        } else {
            "Leave the branch for the user to merge — do NOT merge or push.".to_owned()
        };
        format!(
            "\n- You are in a git worktree on branch {}. {policy}",
            js_opt(task.branch.as_ref())
        )
    } else {
        String::new()
    };
    format!(
        "You are working on the task \"{}\".

## Requirements

{}

## Environment

- You are working in `{cwd}`.{git_line}
- Ticket artifacts live in `{}`: read `Requirements.md` for the requirements; write `Plan.md` before implementing if helpful.
- Write your `Report.md` to `{}` when done.

## Workflow

1. Read `Requirements.md` in `{}`. If anything is ambiguous, ask the user here and wait.
2. Plan the implementation, write it to `{}/Plan.md`.
3. Implement: run
   {}
   then do the work. Keep changes minimal — no speculative abstractions or features.
4. Review your own work against the requirements.
5. Write `Report.md` to `{}` summarizing what you did, then run
   {}
   as your very last action — the daemon ends this session when the card reaches Done.",
        task.title,
        task.description,
        task.ticket_dir,
        task.report_dir,
        task.ticket_dir,
        task.ticket_dir,
        status(ctx, "inprogress", "implementing"),
        task.report_dir,
        status(ctx, "done", "complete"),
    )
}

// VERIFY: task-prompts-codex-background
/// `buildCodexBackgroundPrompt(t)` (`tasks.mjs:217-247`): unattended contract
/// without subagent references.
pub fn build_codex_background_prompt(ctx: &PromptContext) -> String {
    let task = ctx.task;
    let last_step = if task.conclude.as_deref() == Some("done") {
        format!(
            "As your LAST action, move the card to Done:\n  {}",
            status(ctx, "done", "report ready")
        )
    } else {
        format!(
            "As your LAST action, move the card to In Review:\n  {}\n  Do NOT move the card to done — a human concludes the run.",
            status(ctx, "inreview", "awaiting human review")
        )
    };
    format!(
        "You are an unattended background agent working on \"{}\".

## Requirements

{}

## Environment

- You are working directly in `{}`. Do the work described above in place.
- Ticket artifacts live in `{}`: `Requirements.md` (already written for you).
- Write your `Report.md` to `{}` — a persistent store kept across cleanups.

## Rules

- NO clarifying questions, NO plan-approval step — just do the work directly and efficiently. Nobody is watching this terminal.
- At the START, run:
  {}
- When the work is done, write `Report.md` to `{}` summarizing what you did / found / proposed, and print a short summary in this terminal.
- {last_step}",
        task.title,
        task.description,
        ctx.cwd,
        task.ticket_dir,
        task.report_dir,
        status(ctx, "inprogress", "working"),
        task.report_dir,
    )
}

// VERIFY: task-prompts-task
/// `buildTaskPrompt(t, cavecrew, route)` (`tasks.mjs:251-373`): the whole
/// autonomous orchestrator workflow. The route decides codex routing, the
/// ollama turn-economy bullet and the impl/reviewer model split.
pub fn build_task_prompt(ctx: &PromptContext, route: &Value) -> String {
    let task = ctx.task;
    if task.tool.as_deref() == Some("codex") || route_flag(route, "isCodexModel") {
        return build_codex_task_prompt(ctx);
    }
    let ollama = !route_flag(route, "isClaudeModel");
    let turn_economy = if ollama {
        "\n- Your model has no prompt caching — every turn resends the full context. Minimize turns: batch the board status curl together with your next Bash command instead of running it alone, avoid re-reading files you have already seen, and prefer one larger subagent over many small ones."
    } else {
        ""
    };
    let impl_model = model_or(
        &task.impl_model,
        if ollama {
            js_undefined(task.model.as_ref()).to_owned()
        } else {
            "sonnet".to_owned()
        },
    );
    let reviewer_model = model_or(
        &task.reviewer_model,
        if ollama {
            js_undefined(task.model.as_ref()).to_owned()
        } else {
            "opus".to_owned()
        },
    );
    let mut turn_caps = Vec::new();
    if let Some(turns) = task.orchestrator_max_turns {
        turn_caps.push(format!("orchestrator ≤{turns}"));
    }
    if let Some(turns) = task.impl_max_turns {
        turn_caps.push(format!("implementor subagent ≤{turns}"));
    }
    if let Some(turns) = task.reviewer_max_turns {
        turn_caps.push(format!("reviewer subagent ≤{turns}"));
    }
    let turn_budget = if turn_caps.is_empty() {
        String::new()
    } else {
        format!(
            "\n- Turn budgets (soft — self-enforced, no hard kill): {}. Stay within your own cap; for subagents, include \"stop after ≤N turns\" in the spawn prompt and wrap up when reached.",
            turn_caps.join(", ")
        )
    };
    let impl_agent = if (ctx.has_def)("senior-software-engineer") {
        Some("senior-software-engineer")
    } else if (ctx.has_def)("junior-software-engineer") {
        Some("junior-software-engineer")
    } else {
        None
    };
    let reviewer_agent = (ctx.has_def)("reviewer").then_some("reviewer");
    let subagent_economy = format!(
        " Run at most 3 subagents concurrently. Have each subagent write its full output to a file under `{}` and return only a short summary (≤10 lines) — keep large results out of your context.",
        task.ticket_dir
    );
    let impl_spawn = match impl_agent {
        Some(agent) => format!(
            "Use the Task tool with subagents (subagent_type: \"{agent}\", model: {impl_model}) for the implementation work where it helps; small changes you may do directly. The subagent def carries this repo's stack rules — still tell subagents to keep changes minimal (no speculative abstractions or features).{subagent_economy}"
        ),
        None => format!(
            "Use the Task tool with subagents (model: {impl_model}) for the implementation work where it helps; small changes you may do directly. Tell subagents to keep changes minimal (no speculative abstractions or features).{}{subagent_economy}",
            if ctx.cavecrew {
                " For read-only exploration (locating code, mapping structure, listing usages), spawn subagent_type: \"caveman:cavecrew-investigator\" instead of a generic subagent — its output is compressed."
            } else {
                ""
            }
        ),
    };
    let fix_sub = match impl_agent {
        Some(agent) => format!("subagent (subagent_type: \"{agent}\", model: {impl_model})"),
        None => format!("{impl_model} subagent"),
    };
    let review_spawn = |examine: &str| match reviewer_agent {
        Some(agent) => format!(
            "spawn a reviewer subagent via the Task tool (subagent_type: \"{agent}\", model: {reviewer_model}). The reviewer def carries this repo's security checklist; the reviewer must {examine} against the requirements and plan in `{}` (`Requirements.md` + `Plan.md`) and return a verdict: PASS, or REJECT with concrete feedback",
            task.ticket_dir
        ),
        None if ctx.cavecrew => format!(
            "spawn a reviewer subagent via the Task tool (subagent_type: \"caveman:cavecrew-reviewer\", model: {reviewer_model}). The reviewer must {examine} against the requirements and plan in `{}` (`Requirements.md` + `Plan.md`) and return a verdict: PASS, or REJECT with concrete feedback",
            task.ticket_dir
        ),
        None => format!(
            "spawn a reviewer subagent via the Task tool with model: {reviewer_model}. The reviewer must {examine} against the requirements and plan in `{}` (`Requirements.md` + `Plan.md`) and return a verdict: PASS, or REJECT with concrete feedback",
            task.ticket_dir
        ),
    };
    let intro = format!(
        "You are the orchestrator for the task \"{}\" on a kanban board.\n\n## Requirements\n\n{}",
        task.title, task.description
    );
    let plan_step = if task.require_plan_approval {
        format!(
            " Present the plan here and wait for the user to approve it before writing any code. While waiting, run:\n   {}",
            status(ctx, "todo", "awaiting plan approval")
        )
    } else {
        " No user approval of the plan is required — proceed once your questions (if any) are answered."
            .to_owned()
    };
    let analyze_step = format!(
        "1. **Analyze** the requirements against the codebase. If anything is ambiguous or underspecified, ask the user clarifying questions here in this terminal and wait for their answers. While waiting, run:\n   {}",
        status(ctx, "todo", "clarifying")
    );
    let reject_step = format!(
        "5. **On REJECT**: run\n   {}\n   have a {fix_sub} implement the fixes{} and go back to step 4. After {MAX_REVIEW_REJECTS} rejections, stop: run\n   {}\n   summarize the blockers here in the terminal, and end your involvement.",
        status(ctx, "inprogress", "fixing"),
        if task.kind == crate::task_service::TaskKind::Git {
            ", commit,"
        } else {
            ""
        },
        status(ctx, "inreview", "parked — needs human"),
    );
    if task.kind == crate::task_service::TaskKind::Plain {
        return format!(
            "{intro}

## Environment

- You are working directly in `{}` (not a git repo). Make all changes in place.
- Ticket artifacts live in `{}`: `Requirements.md` (the requirements, already written for you) and `Plan.md` (you write it during planning). This is the stable source of truth — you and your subagents read from here, not the working directory.
- You move your own task card by calling the board API with Bash (curl). Update the card at every phase change as instructed below. The \"state\" field is a short free-text phase label shown on the card.{turn_economy}{turn_budget}

## Workflow

{analyze_step}
2. **Plan** the implementation.{plan_step} Write the finalized plan to `{}/Plan.md` before implementing.
3. **Implement**: first run
   {}
   then implement the plan. {impl_spawn}
4. **Review**: run
   {}
   and {}.
{reject_step}
6. **On PASS**: conclude with a one-line summary of what was done and run
   {}
   as your very last action — the daemon terminates this session when the card reaches done.",
            task.repo,
            task.ticket_dir,
            task.ticket_dir,
            status(ctx, "inprogress", "implementing"),
            status(ctx, "inreview", "reviewing"),
            review_spawn("independently examine the files you changed"),
            status(ctx, "done", "complete"),
        );
    }
    let merge_policy = if task.merge_mode == Some(crate::task_service::MergeMode::Auto) {
        format!(
            "after the review passes, merge {} into {} in the main repo (git -C \"{}\" merge {}). If the merge conflicts, abort it and park the task instead (see below).",
            js_opt(task.branch.as_ref()),
            js_opt(task.base_branch.as_ref()),
            task.repo,
            js_opt(task.branch.as_ref())
        )
    } else {
        "leave the branch for the user to merge — do NOT merge or push.".to_owned()
    };
    let pass_step = if task.merge_mode == Some(crate::task_service::MergeMode::Auto) {
        format!(
            "6. **On PASS**: apply the merge policy above. If it conflicts, run {} and stop. Otherwise conclude with a one-line summary of what was done and run\n   {}\n   as your very last action — the daemon ends this session and reclaims the worktree when the card reaches Done.",
            status(ctx, "inreview", "parked — merge conflict"),
            status(ctx, "done", "complete"),
        )
    } else {
        format!(
            "6. **On PASS**: apply the merge policy above. Do NOT merge — leave {} for a human. Conclude with a one-line summary of what was done and run\n   {}\n   as your very last action — a human reviews, merges, and moves the card to Done.",
            js_opt(task.branch.as_ref()),
            status(ctx, "inreview", "awaiting human merge"),
        )
    };
    format!(
        "{intro}

## Environment

- You are in a dedicated git worktree ({}) on branch {}, branched from {} of the main repo at {}. Do all work here.
- Merge policy: {merge_policy}
- Ticket artifacts live in `{}`: `Requirements.md` (the requirements, already written for you) and `Plan.md` (you write it during planning). This is the stable source of truth — you and your subagents read from here, not the working directory.
- You move your own task card by calling the board API with Bash (curl). Update the card at every phase change as instructed below. The \"state\" field is a short free-text phase label shown on the card.{turn_economy}{turn_budget}

## Workflow

{analyze_step}
2. **Plan** the implementation.{plan_step} Write the finalized plan to `{}/Plan.md` before implementing.
3. **Implement**: first run
   {}
   then implement the plan. {impl_spawn}
4. **Review**: commit your work on {}, then run
   {}
   and {}.
{reject_step}
{pass_step}",
        js_opt(task.worktree.as_ref()),
        js_opt(task.branch.as_ref()),
        js_opt(task.base_branch.as_ref()),
        task.repo,
        task.ticket_dir,
        task.ticket_dir,
        status(ctx, "inprogress", "implementing"),
        js_opt(task.branch.as_ref()),
        status(ctx, "inreview", "reviewing"),
        review_spawn("independently examine the diff"),
    )
}

// VERIFY: task-prompts-background
/// `buildBackgroundPrompt(t, route)` (`tasks.mjs:384-419`): unattended
/// quota-soak runs, no clarifying/approval/subagent steps.
pub fn build_background_prompt(ctx: &PromptContext, route: &Value) -> String {
    let task = ctx.task;
    if task.tool.as_deref() == Some("codex") || route_flag(route, "isCodexModel") {
        return build_codex_background_prompt(ctx);
    }
    let last_step = if task.conclude.as_deref() == Some("done") {
        format!(
            "As your LAST action, move the card to Done:\n  {}",
            status(ctx, "done", "report ready")
        )
    } else {
        format!(
            "As your LAST action, move the card to In Review:\n  {}\n  Do NOT move the card to done — a human concludes the run.",
            status(ctx, "inreview", "awaiting human review")
        )
    };
    format!(
        "You are an unattended background agent working on \"{}\".

## Requirements

{}

## Environment

- You are working directly in `{}`. Do the work described above in place.
- Ticket artifacts live in `{}`: `Requirements.md` (already written for you).
- Write your `Report.md` to `{}` — a persistent store kept across cleanups, NOT the ticket dir.

## Rules

- NO clarifying questions, NO plan-approval step, NO impl/reviewer subagent workflow — just do the work directly and efficiently. Nobody is watching this terminal.
- At the START, run:
  {}
- When the work is done, write `Report.md` to `{}` summarizing what you did / found / proposed, and print a short summary in this terminal.
- {last_step}",
        task.title,
        task.description,
        ctx.cwd,
        task.ticket_dir,
        task.report_dir,
        status(ctx, "inprogress", "working"),
        task.report_dir,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_service::test_support::task;
    use crate::task_service::{MergeMode, TaskKind};
    use serde_json::json;

    fn plain_task() -> Task {
        let mut t = task("abcd1234-0000-4000-8000-000000000000");
        t.title = "Fix it".to_owned();
        t.description = "Do the thing.".to_owned();
        t.repo = "/repo".to_owned();
        t.ticket_dir = "/tickets/abcd1234".to_owned();
        t.report_dir = "/tickets/abcd1234".to_owned();
        t.kind = TaskKind::Plain;
        t.worktree = None;
        t.branch = None;
        t.base_branch = None;
        t
    }

    fn git_task() -> Task {
        let mut t = plain_task();
        t.kind = TaskKind::Git;
        t.worktree = Some("/worktrees/abcd1234".to_owned());
        t.branch = Some("task/abcd1234".to_owned());
        t.base_branch = Some("main".to_owned());
        t.merge_mode = Some(MergeMode::Manual);
        t
    }

    fn no_defs(_: &str) -> bool {
        false
    }

    fn ctx<'a>(task: &'a Task, has_def: &'a dyn Fn(&str) -> bool) -> PromptContext<'a> {
        PromptContext {
            task,
            port: "4317",
            token_header: "",
            cavecrew: false,
            cwd: task.worktree.as_deref().unwrap_or(&task.repo),
            has_def,
        }
    }

    fn claude_route() -> Value {
        json!({ "isClaudeModel": true, "isCodexModel": false })
    }

    fn ollama_route() -> Value {
        json!({ "isClaudeModel": false, "isCodexModel": false })
    }

    // VERIFY: task-prompts-tests-codex-golden
    #[test]
    fn codex_task_prompt_matches_the_node_template() {
        let mut t = plain_task();
        t.tool = Some("codex".to_owned());
        let context = ctx(&t, &no_defs);
        let expected = "You are working on the task \"Fix it\".

## Requirements

Do the thing.

## Environment

- You are working in `/repo`.
- Ticket artifacts live in `/tickets/abcd1234`: read `Requirements.md` for the requirements; write `Plan.md` before implementing if helpful.
- Write your `Report.md` to `/tickets/abcd1234` when done.

## Workflow

1. Read `Requirements.md` in `/tickets/abcd1234`. If anything is ambiguous, ask the user here and wait.
2. Plan the implementation, write it to `/tickets/abcd1234/Plan.md`.
3. Implement: run
   curl -s -X POST http://127.0.0.1:4317/api/tasks/abcd1234-0000-4000-8000-000000000000/status -H \"content-type: application/json\" -d '{\"column\":\"inprogress\",\"state\":\"implementing\"}'
   then do the work. Keep changes minimal — no speculative abstractions or features.
4. Review your own work against the requirements.
5. Write `Report.md` to `/tickets/abcd1234` summarizing what you did, then run
   curl -s -X POST http://127.0.0.1:4317/api/tasks/abcd1234-0000-4000-8000-000000000000/status -H \"content-type: application/json\" -d '{\"column\":\"done\",\"state\":\"complete\"}'
   as your very last action — the daemon ends this session when the card reaches Done.";
        assert_eq!(build_task_prompt(&context, &claude_route()), expected);
    }

    // VERIFY: task-prompts-tests-route-dispatch
    #[test]
    fn codex_tool_or_route_selects_the_codex_builders() {
        let mut t = plain_task();
        t.tool = Some("codex".to_owned());
        assert_eq!(
            build_task_prompt(&ctx(&t, &no_defs), &claude_route()),
            build_codex_task_prompt(&ctx(&t, &no_defs))
        );
        let claude_tool = plain_task();
        assert_eq!(
            build_task_prompt(&ctx(&claude_tool, &no_defs), &json!({"isCodexModel": true})),
            build_codex_task_prompt(&ctx(&claude_tool, &no_defs))
        );
        t.tool = None;
        assert_eq!(
            build_background_prompt(&ctx(&t, &no_defs), &json!({"isCodexModel": true})),
            build_codex_background_prompt(&ctx(&t, &no_defs))
        );
    }

    // VERIFY: task-prompts-tests-terminal-column
    #[test]
    fn git_merge_mode_picks_the_terminal_column() {
        let mut auto = git_task();
        auto.merge_mode = Some(MergeMode::Auto);
        let prompt = build_task_prompt(&ctx(&auto, &no_defs), &claude_route());
        assert!(
            prompt.contains("merge policy above. If it conflicts, run"),
            "{prompt}"
        );
        assert!(
            prompt.contains("\"column\":\"done\",\"state\":\"complete\""),
            "{prompt}"
        );
        assert!(
            prompt.contains("reclaims the worktree when the card reaches Done"),
            "{prompt}"
        );

        let manual = git_task();
        let prompt = build_task_prompt(&ctx(&manual, &no_defs), &claude_route());
        assert!(
            prompt.contains("leave the branch for the user to merge — do NOT merge or push."),
            "{prompt}"
        );
        assert!(
            prompt.contains("\"column\":\"inreview\",\"state\":\"awaiting human merge\""),
            "{prompt}"
        );
        assert!(
            prompt.contains("a human reviews, merges, and moves the card to Done."),
            "{prompt}"
        );
        assert!(!prompt.contains("\"column\":\"done\""), "{prompt}");
    }

    // VERIFY: task-prompts-tests-models-and-caps
    #[test]
    fn model_split_turn_economy_and_caps_follow_the_route() {
        let mut t = git_task();
        t.orchestrator_max_turns = Some(12);
        t.impl_max_turns = Some(6);
        t.reviewer_max_turns = Some(4);
        let claude = build_task_prompt(&ctx(&t, &no_defs), &claude_route());
        assert!(claude.contains("model: sonnet"), "{claude}");
        assert!(claude.contains("model: opus"), "{claude}");
        assert!(!claude.contains("no prompt caching"), "{claude}");
        assert!(
            claude.contains("Turn budgets (soft — self-enforced, no hard kill): orchestrator ≤12, implementor subagent ≤6, reviewer subagent ≤4."),
            "{claude}"
        );

        let ollama = build_task_prompt(&ctx(&t, &no_defs), &ollama_route());
        assert!(
            ollama.contains("Your model has no prompt caching"),
            "{ollama}"
        );
        assert!(ollama.contains("model: undefined"), "{ollama}");

        let mut explicit = git_task();
        explicit.model = Some("qwen".to_owned());
        explicit.impl_model = Some("impl-x".to_owned());
        explicit.reviewer_model = Some("rev-y".to_owned());
        let prompt = build_task_prompt(&ctx(&explicit, &no_defs), &ollama_route());
        assert!(prompt.contains("model: impl-x"), "{prompt}");
        assert!(prompt.contains("model: rev-y"), "{prompt}");
    }

    // VERIFY: task-prompts-tests-defs
    #[test]
    fn agent_defs_and_cavecrew_select_the_subagent_wording() {
        let t = plain_task();
        let senior = |role: &str| role == "senior-software-engineer";
        let prompt = build_task_prompt(&ctx(&t, &senior), &claude_route());
        assert!(
            prompt.contains("subagent_type: \"senior-software-engineer\""),
            "{prompt}"
        );
        assert!(!prompt.contains("caveman:cavecrew"), "{prompt}");

        let mut cave = ctx(&t, &no_defs);
        cave.cavecrew = true;
        let prompt = build_task_prompt(&cave, &claude_route());
        assert!(prompt.contains("caveman:cavecrew-investigator"), "{prompt}");
        assert!(prompt.contains("caveman:cavecrew-reviewer"), "{prompt}");
        assert!(prompt.contains("spawn a reviewer subagent via the Task tool (subagent_type: \"caveman:cavecrew-reviewer\""), "{prompt}");
    }

    // VERIFY: task-prompts-tests-port-and-token
    #[test]
    fn every_status_url_carries_the_port_and_optional_token_header() {
        let t = plain_task();
        let mut cave = ctx(&t, &no_defs);
        cave.port = "NaN";
        cave.token_header = " -H \"x-sing-token: $SING_TOKEN\"";
        let prompt = build_task_prompt(&cave, &claude_route());
        assert!(
            prompt.contains("http://127.0.0.1:NaN/api/tasks/"),
            "{prompt}"
        );
        assert!(
            prompt.contains(
                "/status -H \"x-sing-token: $SING_TOKEN\" -H \"content-type: application/json\""
            ),
            "{prompt}"
        );
    }

    // VERIFY: task-prompts-tests-background
    #[test]
    fn background_conclude_controls_the_last_step() {
        let mut t = plain_task();
        t.conclude = Some("done".to_owned());
        let done = build_background_prompt(&ctx(&t, &no_defs), &claude_route());
        assert!(
            done.contains("As your LAST action, move the card to Done:"),
            "{done}"
        );
        assert!(
            done.contains("\"column\":\"done\",\"state\":\"report ready\""),
            "{done}"
        );

        t.conclude = Some("inreview".to_owned());
        let review = build_background_prompt(&ctx(&t, &no_defs), &claude_route());
        assert!(
            review.contains("Do NOT move the card to done — a human concludes the run."),
            "{review}"
        );
        assert!(review.contains("NOT the ticket dir"), "{review}");
        assert!(
            !review.contains("caveman:cavecrew-investigator"),
            "{review}"
        );
    }
}
