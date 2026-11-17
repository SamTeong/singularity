//! Drop-in for `std::fs::read_dir` that returns entries in the order Node's `fs.readdir` does.
//! On Unix libuv byte-sorts names (strcmp), while `read_dir` order is unordered (e.g. ext4).
//! On Windows both Node and `read_dir` pass through NTFS order (case-insensitive), so it is kept.

use std::fs::DirEntry;
use std::io;
use std::path::Path;

pub fn read_dir(path: impl AsRef<Path>) -> io::Result<std::vec::IntoIter<io::Result<DirEntry>>> {
    #[cfg_attr(windows, allow(unused_mut))]
    let mut entries: Vec<io::Result<DirEntry>> = std::fs::read_dir(path)?.collect();
    #[cfg(not(windows))]
    entries.sort_by(|a, b| match (a, b) {
        (Ok(a), Ok(b)) => a.file_name().cmp(&b.file_name()),
        (Ok(_), Err(_)) => std::cmp::Ordering::Less,
        (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
        (Err(_), Err(_)) => std::cmp::Ordering::Equal,
    });
    Ok(entries.into_iter())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_names_in_node_readdir_order() {
        // Node v24 on Windows lists a, B, _b (NTFS order); on Unix libuv byte-sorts to B, _b, a.
        let dir = std::env::temp_dir().join(format!("fs-sorted-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["a", "_b", "B"] {
            std::fs::write(dir.join(name), "").unwrap();
        }
        let names: Vec<String> = read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        std::fs::remove_dir_all(&dir).unwrap();
        let expected = if cfg!(windows) {
            ["a", "B", "_b"]
        } else {
            ["B", "_b", "a"]
        };
        assert_eq!(names, expected);
    }
}
