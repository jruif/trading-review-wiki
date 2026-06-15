use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
const MAX_WRITE_BYTES: u64 = 100 * 1024 * 1024;
const GRANT_TTL: Duration = Duration::from_secs(300);
const MAX_GRANTS: usize = 64;

static PROJECT_ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
static READ_GRANTS: OnceLock<Mutex<Vec<ReadGrant>>> = OnceLock::new();

#[derive(Clone)]
struct ReadGrant {
    path: PathBuf,
    is_directory: bool,
    expires_at: Instant,
}

fn project_roots() -> &'static Mutex<Vec<PathBuf>> {
    PROJECT_ROOTS.get_or_init(|| Mutex::new(Vec::new()))
}

fn read_grants() -> &'static Mutex<Vec<ReadGrant>> {
    READ_GRANTS.get_or_init(|| Mutex::new(Vec::new()))
}

fn lock_err<T>(_: std::sync::PoisonError<T>) -> String {
    "Internal lock error".to_string()
}

/// Resolve a path to an absolute, normalized form without following symlinks outside roots.
pub fn resolve_path(path: &str) -> Result<PathBuf, String> {
    let raw = Path::new(path);
    if raw.is_absolute() {
        return Ok(normalize_components(raw));
    }
    let cwd = std::env::current_dir().map_err(|e| format!("Failed to resolve cwd: {e}"))?;
    Ok(normalize_components(&cwd.join(raw)))
}

fn normalize_components(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        std::fs::canonicalize(path)
            .map_err(|e| format!("Failed to canonicalize '{}': {e}", path.display()))
    } else if let Some(parent) = path.parent() {
        if parent.as_os_str().is_empty() {
            return Err(format!("Invalid path: '{}'", path.display()));
        }
        let file_name = path
            .file_name()
            .ok_or_else(|| format!("Invalid path: '{}'", path.display()))?;
        let canon_parent = canonicalize_existing(parent)?;
        Ok(canon_parent.join(file_name))
    } else {
        Err(format!("Invalid path: '{}'", path.display()))
    }
}

fn is_within_root(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

fn prune_expired_grants(grants: &mut Vec<ReadGrant>) {
    let now = Instant::now();
    grants.retain(|grant| grant.expires_at > now);
}

fn push_grant(grants: &mut Vec<ReadGrant>, path: PathBuf, is_directory: bool) {
    prune_expired_grants(grants);
    grants.retain(|g| g.path != path);
    grants.push(ReadGrant {
        path,
        is_directory,
        expires_at: Instant::now() + GRANT_TTL,
    });
    if grants.len() > MAX_GRANTS {
        let drain = grants.len() - MAX_GRANTS;
        grants.drain(0..drain);
    }
}

pub fn register_project_root(path: &str) -> Result<(), String> {
    let resolved = resolve_path(path)?;
    let canonical = canonicalize_existing(&resolved)?;
    if !canonical.is_dir() {
        return Err(format!(
            "Project path is not a directory: '{}'",
            canonical.display()
        ));
    }
    let mut roots = project_roots().lock().map_err(lock_err)?;
    if !roots.iter().any(|r| r == &canonical) {
        roots.push(canonical);
    }
    Ok(())
}

pub fn sync_project_roots(paths: &[String]) {
    if let Ok(mut roots) = project_roots().lock() {
        for path in paths {
            if let Ok(resolved) = resolve_path(path) {
                if let Ok(canonical) = canonicalize_existing(&resolved) {
                    if canonical.is_dir() && !roots.iter().any(|r| r == &canonical) {
                        roots.push(canonical);
                    }
                }
            }
        }
    }
}

pub fn is_registered_project(path: &str) -> bool {
    assert_project(path).is_ok()
}

pub fn assert_project(path: &str) -> Result<PathBuf, String> {
    let resolved = resolve_path(path)?;
    let canonical = canonicalize_existing(&resolved)?;
    let roots = project_roots().lock().map_err(lock_err)?;
    if roots.iter().any(|root| is_within_root(&canonical, root)) {
        Ok(canonical)
    } else {
        Err(format!(
            "Access denied: '{}' is not a registered project",
            path
        ))
    }
}

pub fn grant_read_file(path: &str) -> Result<(), String> {
    let resolved = resolve_path(path)?;
    let canonical = canonicalize_existing(&resolved)?;
    if !canonical.is_file() {
        return Err(format!(
            "grant_read_file only supports existing files: '{}'",
            path
        ));
    }
    let mut grants = read_grants().lock().map_err(lock_err)?;
    push_grant(&mut grants, canonical, false);
    Ok(())
}

pub fn grant_read_directory(path: &str) -> Result<(), String> {
    let resolved = resolve_path(path)?;
    let canonical = canonicalize_existing(&resolved)?;
    if !canonical.is_dir() {
        return Err(format!(
            "grant_read_directory only supports existing directories: '{}'",
            path
        ));
    }
    let mut grants = read_grants().lock().map_err(lock_err)?;
    push_grant(&mut grants, canonical, true);
    Ok(())
}

fn is_granted_read(path: &Path) -> bool {
    let Ok(mut grants) = read_grants().lock() else {
        return false;
    };
    prune_expired_grants(&mut grants);
    grants.iter().any(|grant| {
        if grant.is_directory {
            path == grant.path || path.starts_with(&grant.path)
        } else {
            path == grant.path
        }
    })
}

pub fn assert_readable(path: &str) -> Result<PathBuf, String> {
    let resolved = resolve_path(path)?;
    let canonical = canonicalize_existing(&resolved)?;
    let roots = project_roots().lock().map_err(lock_err)?;
    if roots.iter().any(|root| is_within_root(&canonical, root)) {
        return Ok(canonical);
    }
    if is_granted_read(&canonical) {
        return Ok(canonical);
    }
    Err(format!(
        "Access denied: '{}' is outside registered project directories",
        path
    ))
}

pub fn assert_writable(path: &str) -> Result<PathBuf, String> {
    let resolved = resolve_path(path)?;
    let canonical = canonicalize_existing(&resolved)?;
    let roots = project_roots().lock().map_err(lock_err)?;
    if roots.iter().any(|root| is_within_root(&canonical, root)) {
        return Ok(canonical);
    }
    Err(format!(
        "Access denied: '{}' is outside registered project directories",
        path
    ))
}

pub fn assert_copy_paths(source: &str, destination: &str) -> Result<(PathBuf, PathBuf), String> {
    let src = assert_readable(source)?;
    let dest = assert_writable(destination)?;
    Ok((src, dest))
}

pub fn check_read_size(path: &Path) -> Result<(), String> {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_READ_BYTES {
            return Err(format!(
                "File too large to read ({} bytes, limit {} bytes)",
                meta.len(),
                MAX_READ_BYTES
            ));
        }
    }
    Ok(())
}

pub fn check_write_size(len: usize) -> Result<(), String> {
    if len as u64 > MAX_WRITE_BYTES {
        return Err(format!(
            "Write payload too large ({} bytes, limit {} bytes)",
            len, MAX_WRITE_BYTES
        ));
    }
    Ok(())
}

pub const READ_HEAD_DEFAULT: usize = 8192;
pub const READ_HEAD_MAX: usize = 65536;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        match LOCK.get_or_init(|| Mutex::new(())).lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn clear_read_grants() {
        if let Ok(mut grants) = read_grants().lock() {
            grants.clear();
        }
    }

    #[test]
    fn normalize_strips_parent_dirs() {
        let _guard = test_lock();
        let p = normalize_components(Path::new("/tmp/a/../b"));
        assert_eq!(p, PathBuf::from("/tmp/b"));
    }

    #[test]
    fn directory_grant_allows_children_and_expires() {
        let _guard = test_lock();
        clear_read_grants();
        let base = std::env::temp_dir().join(format!(
            "path-guard-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let child = base.join("child.txt");
        fs::write(&child, "ok").unwrap();

        grant_read_directory(base.to_str().unwrap()).unwrap();
        assert!(assert_readable(child.to_str().unwrap()).is_ok());

        let canonical =
            canonicalize_existing(&resolve_path(base.to_str().unwrap()).unwrap()).unwrap();
        if let Ok(mut grants) = read_grants().lock() {
            for grant in grants.iter_mut() {
                if grant.is_directory && grant.path == canonical {
                    grant.expires_at = Instant::now() - Duration::from_secs(1);
                }
            }
        }
        assert!(assert_readable(child.to_str().unwrap()).is_err());

        clear_read_grants();
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn file_grant_does_not_allow_siblings() {
        let _guard = test_lock();
        clear_read_grants();
        let base = std::env::temp_dir().join(format!(
            "path-guard-file-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let a = base.join("a.txt");
        let b = base.join("b.txt");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();

        grant_read_file(a.to_str().unwrap()).unwrap();
        assert!(assert_readable(a.to_str().unwrap()).is_ok());
        assert!(assert_readable(b.to_str().unwrap()).is_err());

        clear_read_grants();
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sync_project_roots_merges_without_clearing() {
        let _guard = test_lock();
        let base = std::env::temp_dir().join(format!(
            "path-guard-sync-a-{}",
            std::process::id()
        ));
        let other = std::env::temp_dir().join(format!(
            "path-guard-sync-b-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&other);
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&other).unwrap();

        register_project_root(base.to_str().unwrap()).unwrap();
        sync_project_roots(&[other.to_string_lossy().to_string()]);

        assert!(assert_project(base.to_str().unwrap()).is_ok());
        assert!(assert_project(other.to_str().unwrap()).is_ok());

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&other);
    }
}
