use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

fn secrets_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library/Application Support/com.tradingreviewwiki.app/secrets");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("com.tradingreviewwiki.app/secrets");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local/share/com.tradingreviewwiki.app/secrets");
        }
    }
    PathBuf::from(".secrets")
}

fn secret_file_path(key: &str) -> PathBuf {
    secrets_dir().join(format!("{key}.txt"))
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 64 {
        return Err("Invalid secret key".to_string());
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("Invalid secret key characters".to_string());
    }
    Ok(())
}

fn write_secret_file(path: &Path, value: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create secrets directory: {e}"))?;
    }

    #[cfg(unix)]
    {
        use std::fs::OpenOptions;
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("Failed to write secret file: {e}"))?;
        file.write_all(value.as_bytes())
            .map_err(|e| format!("Failed to write secret file: {e}"))?;
    }

    #[cfg(not(unix))]
    {
        fs::write(path, value).map_err(|e| format!("Failed to write secret file: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub fn store_secret(key: String, value: String) -> Result<(), String> {
    validate_key(&key)?;
    write_secret_file(&secret_file_path(&key), &value)
}

#[tauri::command]
pub fn load_secret(key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    let path = secret_file_path(&key);
    match fs::read_to_string(&path) {
        Ok(value) => Ok(Some(value)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to load secret: {e}")),
    }
}

#[tauri::command]
pub fn delete_secret(key: String) -> Result<(), String> {
    validate_key(&key)?;
    match fs::remove_file(secret_file_path(&key)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete secret: {e}")),
    }
}
