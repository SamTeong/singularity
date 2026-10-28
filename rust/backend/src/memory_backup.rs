// Backup writes into an explicit backups dir (one hashed subdir per raw source path)
// instead of a sibling `${p}.bak` — sibling backups collide with other tools that
// write a write-once .bak to the same path and get silently clobbered.
// Mirrors server/backups.mjs `backupFile`.
use ring::digest;
use std::cmp::Ordering;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const KEEP: usize = 5;

/// Back up `raw_path` into `backups_dir/<sha256(raw_path)[..16]>/<epochMillis>.bak`,
/// pruning to the `KEEP` newest. Returns the backup path, or `None` if the source is
/// missing or anything fails — saving the user's file matters more than the backup.
/// The caller coordinates any locking; this takes none.
pub(crate) fn backup_file(raw_path: &str, source: &Path, backups_dir: &Path) -> Option<PathBuf> {
    if !source.exists() {
        return None;
    }
    let dir = backups_dir.join(key_for(raw_path));
    fs::create_dir_all(&dir).ok()?;
    let dest = claim_slot(&dir, epoch_millis())?;
    let source_file = dir.join("source.txt");
    // Never rewrite an existing pointer: a second spelling of the same path must not
    // steal the first one's record.
    if !source_file.exists() {
        fs::write(&source_file, raw_path).ok()?;
    }
    // A failed copy may leave the claimed empty .bak behind, exactly as in Node.
    fs::copy(source, &dest).ok()?;
    prune(&dir)?;
    Some(dest)
}

/// First 16 lowercase hex chars of SHA256 over the raw supplied path's UTF-8 bytes
/// (the path as given, not canonicalised).
fn key_for(raw_path: &str) -> String {
    let hash = digest::digest(&digest::SHA256, raw_path.as_bytes());
    let mut key = String::with_capacity(16);
    for &byte in &hash.as_ref()[..8] {
        key.push(char::from_digit(u32::from(byte >> 4), 16).unwrap());
        key.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap());
    }
    key
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

// Claim the name with an exclusive create rather than an existence probe: two backups
// of the same path can both pass a probe before either has written its file and one
// silently clobbers the other. Exclusive creation makes the claim atomic.
fn claim_slot(dir: &Path, mut stamp: u64) -> Option<PathBuf> {
    loop {
        let candidate = dir.join(format!("{stamp}.bak"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Some(candidate),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => stamp += 1,
            Err(_) => return None,
        }
    }
}

// Newest-first by numeric stem, keep KEEP, delete the rest. Unparsable stems rank as
// NaN, which the comparison treats as equal — same tolerance as the Node original.
fn prune(dir: &Path) -> Option<()> {
    let mut baks: Vec<(f64, String)> = fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let stem = name.strip_suffix(".bak")?;
            Some((stem.parse::<f64>().unwrap_or(f64::NAN), name))
        })
        .collect();
    baks.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));
    for (_, name) in baks.iter().skip(KEEP) {
        let stale = dir.join(name);
        // A concurrent prune of the same path is harmless: only a file that still exists
        // after the failed unlink is a real failure.
        if fs::remove_file(&stale).is_err() && stale.exists() {
            return None;
        }
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let sequence = SEQ.fetch_add(1, AtomicOrdering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "singularity-memory-backup-{}-{}-{sequence}",
                std::process::id(),
                epoch_millis()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn put(&self, rel: &str, content: &str) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }

        fn backups(&self) -> PathBuf {
            self.0.join("backups")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn bak_names(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.ends_with(".bak"))
            .collect()
    }

    #[test]
    fn backs_up_content_under_hash_of_raw_path_and_records_source() {
        assert_eq!(key_for("/x"), "b3d1db318671a024");
        let fixture = Fixture::new();
        let source = fixture.put("memory/fact.md", "記憶 🧪");
        let raw = source.to_str().unwrap();
        let dest = backup_file(raw, Path::new(raw), &fixture.backups()).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), "記憶 🧪".as_bytes());
        let key = key_for(raw);
        let dir = fixture.backups().join(&key);
        assert_eq!(dest.parent().unwrap(), dir.as_path());
        assert_eq!(key.len(), 16);
        assert!(key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
        assert_eq!(dest.extension().and_then(|ext| ext.to_str()), Some("bak"));
        assert!(
            dest.file_stem()
                .unwrap()
                .to_str()
                .unwrap()
                .parse::<u64>()
                .is_ok()
        );
        // Raw path verbatim, no trailing newline.
        assert_eq!(fs::read_to_string(dir.join("source.txt")).unwrap(), raw);
    }

    #[test]
    fn copies_the_supplied_source_while_keying_by_the_raw_spelling() {
        let fixture = Fixture::new();
        let source = fixture.put("exact.md", "exact content");
        let lossy = fixture.put("lossy.md", "different content");
        let raw = lossy.to_str().unwrap();
        let dest = backup_file(raw, &source, &fixture.backups()).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "exact content");
        assert_eq!(dest.parent().unwrap(), fixture.backups().join(key_for(raw)));
    }

    #[test]
    fn leaves_an_existing_source_txt_untouched() {
        let fixture = Fixture::new();
        let source = fixture.put("fact.md", "one");
        let raw = source.to_str().unwrap();
        let dir = fixture.backups().join(key_for(raw));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("source.txt"), "original").unwrap();

        let dest = backup_file(raw, Path::new(raw), &fixture.backups()).unwrap();

        assert_eq!(fs::read(dest).unwrap(), b"one");
        assert_eq!(
            fs::read_to_string(dir.join("source.txt")).unwrap(),
            "original"
        );
    }

    #[test]
    fn claim_slot_increments_past_claimed_names() {
        let fixture = Fixture::new();
        let dir = fixture.backups();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("1000.bak"), "taken").unwrap();
        fs::write(dir.join("1001.bak"), "taken").unwrap();

        let claimed = claim_slot(&dir, 1000).unwrap();

        assert_eq!(claimed, dir.join("1002.bak"));
        assert_eq!(fs::read(&claimed).unwrap(), b"");
        assert_eq!(fs::read(dir.join("1000.bak")).unwrap(), b"taken");
    }

    #[test]
    fn prunes_to_the_five_newest_numeric_stems() {
        let fixture = Fixture::new();
        let source = fixture.put("fact.md", "new");
        let raw = source.to_str().unwrap();
        let dir = fixture.backups().join(key_for(raw));
        fs::create_dir_all(&dir).unwrap();
        for stamp in 1..=7 {
            fs::write(dir.join(format!("{stamp}.bak")), format!("old{stamp}")).unwrap();
        }

        let dest = backup_file(raw, Path::new(raw), &fixture.backups()).unwrap();

        let newest = dest.file_stem().unwrap().to_str().unwrap().to_owned();
        let mut names = bak_names(&dir);
        names.sort();
        let mut expected = vec![
            "4.bak".to_owned(),
            "5.bak".to_owned(),
            "6.bak".to_owned(),
            "7.bak".to_owned(),
            format!("{newest}.bak"),
        ];
        expected.sort();
        assert_eq!(names, expected);
        assert_eq!(fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn missing_source_returns_none_without_creating_the_backup_dir() {
        let fixture = Fixture::new();
        let missing = fixture.0.join("absent.md");

        assert!(backup_file(missing.to_str().unwrap(), &missing, &fixture.backups()).is_none());
        assert!(!fixture.backups().exists());
    }

    #[test]
    fn blocked_backups_dir_fails_best_effort() {
        let fixture = Fixture::new();
        let source = fixture.put("fact.md", "x");
        let blocked = fixture.0.join("blocked");
        fs::write(&blocked, "not a directory").unwrap();

        assert!(backup_file(source.to_str().unwrap(), &source, &blocked).is_none());
        assert_eq!(fs::read_to_string(&blocked).unwrap(), "not a directory");
    }

    #[test]
    fn failed_copy_returns_none_and_may_leave_the_claimed_file() {
        let fixture = Fixture::new();
        let source_dir = fixture.0.join("source-dir");
        fs::create_dir_all(&source_dir).unwrap();

        assert!(
            backup_file(
                source_dir.to_str().unwrap(),
                &source_dir,
                &fixture.backups()
            )
            .is_none()
        );

        let dir = fixture
            .backups()
            .join(key_for(source_dir.to_str().unwrap()));
        assert_eq!(
            fs::read_to_string(dir.join("source.txt")).unwrap(),
            source_dir.to_str().unwrap()
        );
        for name in bak_names(&dir) {
            assert_eq!(fs::read(dir.join(name)).unwrap(), b"");
        }
    }
}
