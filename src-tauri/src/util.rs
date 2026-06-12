use std::path::PathBuf;

/// Resolve the current user's home directory across platforms.
///
/// Unix/macOS expose `HOME`; Windows exposes `USERPROFILE` (and as a last
/// resort `HOMEDRIVE` + `HOMEPATH`). Checking all of them keeps cache, db and
/// export paths working consistently on both macOS and Windows.
pub fn home_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            return Some(PathBuf::from(profile));
        }
    }
    if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        if !drive.is_empty() && !path.is_empty() {
            return Some(PathBuf::from(format!("{drive}{path}")));
        }
    }
    None
}
