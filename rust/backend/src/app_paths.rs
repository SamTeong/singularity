//! Single source of truth for the app data dir and its subdirs, mirroring
//! `server/app-dir.mjs`.
//!
//! Pure: every input is injected — the three `process.env` reads arrive as
//! [`AppEnv`], `homedir()` as `home`, and Node's `import.meta.url`-derived
//! `REPO_ROOT` (the clone that hosts `server/`) as `repo_root`. The only ambient
//! read is the `cwd` that `path.resolve` needs for a *relative*
//! `SING_TRUSTED_ROOT`; [`AppPaths::resolve_with_cwd`] takes that as a parameter
//! so tests never depend on the process cwd.
//!
//! Layout parity notes: `APP_DIR` is `SINGULARITY_HOME` verbatim (Node does not
//! tilde-expand it), every subdir is a `path.join` off it, and `USAGE_REPORT_STATE`
//! is likewise used verbatim. `~` expansion happens only for `SING_TRUSTED_ROOT`.
use std::path::{Component, Path, PathBuf};

/// The exact `Error.message` Node throws from `server/app-dir.mjs:15`.
pub const SINGULARITY_HOME_REQUIRED: &str =
    "SINGULARITY_HOME required — set it in .env (no default). State root.";

/// The three `process.env` reads `server/app-dir.mjs` makes. Node treats an empty
/// string as unset in every one of them (`if (!home)`, `x || fallback`), so an
/// empty value means "unset" here too.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppEnv {
    pub singularity_home: Option<String>,
    pub usage_report_state: Option<String>,
    pub sing_trusted_root: Option<String>,
}

impl AppEnv {
    /// Convenience for the daemon: the same three reads Node does. Tests inject
    /// [`AppEnv`] directly instead.
    pub fn from_process_env() -> Self {
        Self {
            singularity_home: std::env::var("SINGULARITY_HOME").ok(),
            usage_report_state: std::env::var("USAGE_REPORT_STATE").ok(),
            sing_trusted_root: std::env::var("SING_TRUSTED_ROOT").ok(),
        }
    }
}

/// The one failure `server/app-dir.mjs` has: a missing/empty `SINGULARITY_HOME`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppPathsError {
    MissingSingularityHome,
}

impl std::fmt::Display for AppPathsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingSingularityHome => formatter.write_str(SINGULARITY_HOME_REQUIRED),
        }
    }
}

impl std::error::Error for AppPathsError {}

/// Every path `server/app-dir.mjs` exports, derived once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub app_dir: PathBuf,
    pub state_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub usage_skill_state: PathBuf,
    pub trusted_root: PathBuf,
    pub worktrees_dir: PathBuf,
    pub tickets_dir: PathBuf,
    pub reports_dir: PathBuf,
}

// VERIFY: app-paths-resolve
impl AppPaths {
    /// Node's `homedir()` is the process home; `repo_root` stands in for the
    /// `dirname(import.meta.url)/..` clone root.
    pub fn resolve(env: &AppEnv, home: &Path, repo_root: &Path) -> Result<Self, AppPathsError> {
        let cwd = std::env::current_dir().unwrap_or_default();
        Self::resolve_with_cwd(env, home, repo_root, &cwd)
    }

    /// [`Self::resolve`] with `path.resolve`'s cwd injected.
    pub fn resolve_with_cwd(
        env: &AppEnv,
        home: &Path,
        repo_root: &Path,
        cwd: &Path,
    ) -> Result<Self, AppPathsError> {
        let app_dir = PathBuf::from(
            nonempty(&env.singularity_home).ok_or(AppPathsError::MissingSingularityHome)?,
        );
        let state_dir = join(&app_dir, "state");
        let cache_dir = join(&app_dir, "cache");
        let backups_dir = join(&cache_dir, "backups");
        let usage_skill_state = match nonempty(&env.usage_report_state) {
            Some(value) => PathBuf::from(value),
            None => join(home, ".agents/.harness-usage-report/state"),
        };
        let trusted_root = match nonempty(&env.sing_trusted_root) {
            Some(value) => resolve_from(&untildify(value, home), cwd),
            None => repo_root.to_path_buf(),
        };
        Ok(Self {
            worktrees_dir: join(&trusted_root, ".worktrees"),
            tickets_dir: join(&trusted_root, ".tickets"),
            reports_dir: join(&trusted_root, ".reports"),
            app_dir,
            state_dir,
            cache_dir,
            backups_dir,
            usage_skill_state,
            trusted_root,
        })
    }
}

/// `process.env.X` as a JS string: only an empty string is falsy.
fn nonempty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}

// VERIFY: app-paths-untildify
/// `untildify` from `server/app-dir.mjs:36-39`: only a leading `~/` or `~\`
/// expands; a bare `~` and anything else are returned unchanged.
pub fn untildify(value: &str, home: &Path) -> PathBuf {
    let bytes = value.as_bytes();
    if bytes.first() == Some(&b'~') && matches!(bytes.get(1), Some(b'/') | Some(b'\\')) {
        let rest = &value[2..];
        return if rest.is_empty() {
            normalize(home)
        } else {
            normalize(&home.join(rest))
        };
    }
    PathBuf::from(value)
}

/// `path.resolve` for an already-expanded value: absolute paths are normalized,
/// relative ones resolve against `cwd`.
pub fn resolve_from(value: &Path, cwd: &Path) -> PathBuf {
    if value.is_absolute() {
        normalize(value)
    } else {
        normalize(&cwd.join(value))
    }
}

/// `path.join(base, name)` for a single trailing segment, with Node's dot-segment
/// and separator normalization (a second absolute segment is appended, not
/// substituted — that is `join`, not `resolve`).
pub(crate) fn join(base: &Path, name: &str) -> PathBuf {
    if name.is_empty() {
        return normalize(base);
    }
    normalize(&base.join(name))
}

/// `path.normalize`: drop `.` segments, collapse repeated separators, and resolve
/// `..` no higher than the root/prefix.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let mut rooted = false;
    // Number of real segments in `out`; `..` entries are never popped, so a wholly
    // relative path keeps its leading parents.
    let mut depth = 0;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                out.push(prefix.as_os_str());
                rooted = true;
            }
            Component::RootDir => {
                out.push(component.as_os_str());
                rooted = true;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if depth > 0 {
                    out.pop();
                    depth -= 1;
                } else if !rooted {
                    // Above the root/prefix Node clamps instead of escaping.
                    out.push(component.as_os_str());
                }
            }
            Component::Normal(name) => {
                out.push(name);
                depth += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        AppEnv, AppPaths, AppPathsError, SINGULARITY_HOME_REQUIRED, join, resolve_from, untildify,
    };
    use std::path::{Path, PathBuf};

    fn paths(home: &str) -> AppEnv {
        AppEnv {
            singularity_home: Some(home.to_owned()),
            ..AppEnv::default()
        }
    }

    fn home() -> PathBuf {
        PathBuf::from("home")
    }

    // VERIFY: app-paths-untildify
    #[test]
    fn untildify_expands_only_a_leading_home_segment() {
        assert_eq!(untildify("~/x", &home()), join(&home(), "x"));
        assert_eq!(untildify("~\\x/y", &home()), join(&home(), "x/y"));
        assert_eq!(untildify("~/", &home()), home());
        assert_eq!(untildify("~/a/../b", &home()), join(&home(), "b"));
        for unchanged in ["~", "~user/x", "/abs/x", "rel/x", ""] {
            assert_eq!(untildify(unchanged, &home()), PathBuf::from(unchanged));
        }
    }

    // VERIFY: app-paths-layout
    #[test]
    fn derives_every_dir_off_the_injected_home() {
        let app = PathBuf::from("data/singularity");
        let repo = PathBuf::from("repo");
        let resolved = AppPaths::resolve(&paths("data/singularity"), &home(), &repo).unwrap();

        assert_eq!(resolved.app_dir, app);
        assert_eq!(resolved.state_dir, app.join("state"));
        assert_eq!(resolved.cache_dir, app.join("cache"));
        assert_eq!(resolved.backups_dir, app.join("cache/backups"));
        assert_eq!(
            resolved.usage_skill_state,
            home().join(".agents/.harness-usage-report/state")
        );
        assert_eq!(resolved.trusted_root, repo);
        assert_eq!(resolved.worktrees_dir, repo.join(".worktrees"));
        assert_eq!(resolved.tickets_dir, repo.join(".tickets"));
        assert_eq!(resolved.reports_dir, repo.join(".reports"));
    }

    // VERIFY: app-paths-required-home
    #[test]
    fn missing_or_empty_singularity_home_uses_the_node_message() {
        let repo = PathBuf::from("repo");
        for env in [
            AppEnv::default(),
            AppEnv {
                singularity_home: Some(String::new()),
                ..AppEnv::default()
            },
        ] {
            let error = AppPaths::resolve(&env, &home(), &repo).unwrap_err();
            assert_eq!(error, AppPathsError::MissingSingularityHome);
            assert_eq!(error.to_string(), SINGULARITY_HOME_REQUIRED);
        }
        assert_eq!(
            SINGULARITY_HOME_REQUIRED,
            "SINGULARITY_HOME required — set it in .env (no default). State root."
        );
    }

    // VERIFY: app-paths-env-overrides
    #[test]
    fn usage_state_and_trusted_root_follow_the_node_precedence() {
        let repo = PathBuf::from("repo");
        let mut env = paths("data");
        env.usage_report_state = Some("usage/state".to_owned());
        env.sing_trusted_root = Some("~/trusted".to_owned());
        let resolved = AppPaths::resolve_with_cwd(&env, &home(), &repo, Path::new("cwd")).unwrap();
        assert_eq!(resolved.usage_skill_state, PathBuf::from("usage/state"));
        // `path.resolve` follows the expansion, so a relative home resolves too
        // (a real `homedir()` is absolute, making this a plain normalisation).
        let trusted = resolve_from(&join(&home(), "trusted"), Path::new("cwd"));
        assert_eq!(resolved.trusted_root, trusted);
        assert_eq!(resolved.tickets_dir, join(&trusted, ".tickets"));

        // Empty means unset in both reads.
        env.usage_report_state = Some(String::new());
        env.sing_trusted_root = Some(String::new());
        let resolved = AppPaths::resolve_with_cwd(&env, &home(), &repo, Path::new("cwd")).unwrap();
        assert_eq!(
            resolved.usage_skill_state,
            home().join(".agents/.harness-usage-report/state")
        );
        assert_eq!(resolved.trusted_root, repo);
    }

    // VERIFY: app-paths-relative-trusted-root
    #[test]
    fn relative_trusted_root_resolves_against_the_injected_cwd() {
        let env = AppEnv {
            singularity_home: Some("data".to_owned()),
            sing_trusted_root: Some("trusted/".to_owned()),
            ..AppEnv::default()
        };
        let resolved =
            AppPaths::resolve_with_cwd(&env, &home(), Path::new("repo"), Path::new("cwd")).unwrap();
        assert_eq!(resolved.trusted_root, PathBuf::from("cwd/trusted"));
        assert_eq!(
            resolved.worktrees_dir,
            PathBuf::from("cwd/trusted/.worktrees")
        );
        assert_eq!(resolved.reports_dir, PathBuf::from("cwd/trusted/.reports"));
    }

    #[test]
    fn absolute_paths_normalize_dot_segments() {
        let absolute = std::env::temp_dir().join("trusted");
        assert_eq!(resolve_from(&absolute, Path::new("cwd")), absolute);
        assert_eq!(
            resolve_from(&absolute.join("a/../b"), Path::new("cwd")),
            absolute.join("b")
        );
        assert_eq!(
            resolve_from(Path::new("a/./b//c"), Path::new("cwd")),
            Path::new("cwd").join("a/b/c")
        );
        assert_eq!(
            resolve_from(Path::new("../../a"), Path::new("")),
            PathBuf::from("../../a")
        );
    }
}
