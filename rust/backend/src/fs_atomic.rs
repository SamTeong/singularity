//! Atomic temp-then-rename write shared by every `state/*.json` save.
//!
//! Port of `writeAtomic` (`server/agents.mjs:69-84`). On Windows, renaming over
//! an existing file can transiently fail with EPERM/EACCES/EBUSY while AV,
//! Search or a brief reader holds the target open, so the rename is retried a
//! few times with a short synchronous backoff (`Atomics.wait` in Node — the
//! write path is sync, so the backoff must be too). Any other error, or the
//! last attempt, is returned raw: callers keep their own catch/log/wrap.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `for (let attempt = 1; ; attempt++)` with `attempt >= 5` giving up.
const ATTEMPTS: u32 = 5;
/// `Atomics.wait(retrySignal, 0, 0, 20 * attempt)`.
const BACKOFF_MS: u64 = 20;

// VERIFY: fs-atomic-write
/// `writeAtomic(file, data)`: stage `bytes` in a pid-scoped scratch file beside
/// `file`, then rename it into place with the sharing-violation retry ladder.
pub fn write_atomic(file: &Path, bytes: &[u8]) -> io::Result<()> {
    // A closure (not the `fs::rename` item) so the higher-ranked
    // `FnMut(&Path, &Path)` bound infers cleanly.
    let rename = |from: &Path, to: &Path| fs::rename(from, to);
    write_atomic_with(file, bytes, rename)
}

/// `writeAtomic(file, data, rename)` — the injectable-rename seam the Node
/// tests use (`agents.test.mjs:861-879`) to fail N times without a mocking
/// framework.
fn write_atomic_with<F>(file: &Path, bytes: &[u8], mut rename: F) -> io::Result<()>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    // pid-scoped tmp name: `~/.claude.json` (ensureTrusted) is Claude Code's own
    // machine-global file, written by every claude process on the box — a fixed
    // `.tmp` lets two writers clobber each other's staged content and rename the
    // wrong one into place.
    let mut scratch = file.as_os_str().to_owned();
    scratch.push(format!(".{}.tmp", std::process::id()));
    let scratch = PathBuf::from(scratch);
    fs::write(&scratch, bytes)?;
    let mut attempt = 1;
    loop {
        match rename(&scratch, file) {
            Ok(()) => return Ok(()),
            Err(error) if attempt >= ATTEMPTS || !retryable(&error) => return Err(error),
            Err(_) => {
                std::thread::sleep(Duration::from_millis(BACKOFF_MS * u64::from(attempt)));
                attempt += 1;
            }
        }
    }
}

/// Node's `RETRY_CODES` = `EPERM`, `EACCES`, `EBUSY`. The raw Windows sharing
/// and lock violations (`ERROR_ACCESS_DENIED` 5, `ERROR_SHARING_VIOLATION` 32,
/// `ERROR_LOCK_VIOLATION` 33), the shared `EACCES` number 13, and Rust's own
/// `PermissionDenied` classification as a catch-all.
fn retryable(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(5) | Some(13) | Some(32) | Some(33)
    ) || error.kind() == io::ErrorKind::PermissionDenied
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "singularity-fs-atomic-{}-{stamp}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // agents.test.mjs:861-872 — retries past transient EPERM, then succeeds.
    #[test]
    fn retries_transient_permission_errors_then_lands_the_file() {
        let fixture = Fixture::new();
        let file = fixture.0.join("retry-ok.json");
        let calls = Cell::new(0);
        write_atomic_with(&file, b"hello", |from, to| {
            calls.set(calls.get() + 1);
            if calls.get() < 3 {
                return Err(io::Error::from(io::ErrorKind::PermissionDenied));
            }
            fs::rename(from, to)
        })
        .unwrap();
        assert_eq!(calls.get(), 3);
        assert_eq!(fs::read(&file).unwrap(), b"hello");
    }

    // agents.test.mjs:873-879 — non-retryable error rethrows immediately.
    #[test]
    fn non_retryable_errors_are_rethrown_without_a_retry() {
        let fixture = Fixture::new();
        let file = fixture.0.join("retry-fatal.json");
        let calls = Cell::new(0);
        let error = write_atomic_with(&file, b"x", |_, _| {
            calls.set(calls.get() + 1);
            Err(io::Error::from(io::ErrorKind::NotFound))
        })
        .unwrap_err();
        assert_eq!(calls.get(), 1);
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn gives_up_after_the_fifth_retryable_failure() {
        let fixture = Fixture::new();
        let file = fixture.0.join("retry-exhausted.json");
        let calls = Cell::new(0);
        let error = write_atomic_with(&file, b"x", |_, _| {
            calls.set(calls.get() + 1);
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        })
        .unwrap_err();
        assert_eq!(calls.get(), 5);
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn replaces_an_existing_file_and_leaves_no_scratch_behind() {
        let fixture = Fixture::new();
        let file = fixture.0.join("state.json");
        fs::write(&file, b"old").unwrap();
        write_atomic(&file, b"new").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new");
        let entries: Vec<_> = fs::read_dir(&fixture.0).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1, "only the target file remains");
    }
}
