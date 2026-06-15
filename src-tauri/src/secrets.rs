use keyring::Entry;

const SERVICE: &str = "trading-review-wiki";

fn entry_for(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("Keyring entry error: {e}"))
}

#[tauri::command]
pub fn store_secret(key: String, value: String) -> Result<(), String> {
    if key.is_empty() || key.len() > 64 {
        return Err("Invalid secret key".to_string());
    }
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("Invalid secret key characters".to_string());
    }
    entry_for(&key)?
        .set_password(&value)
        .map_err(|e| format!("Failed to store secret: {e}"))
}

#[tauri::command]
pub fn load_secret(key: String) -> Result<Option<String>, String> {
    if key.is_empty() || key.len() > 64 {
        return Err("Invalid secret key".to_string());
    }
    match entry_for(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to load secret: {e}")),
    }
}

#[tauri::command]
pub fn delete_secret(key: String) -> Result<(), String> {
    if key.is_empty() || key.len() > 64 {
        return Err("Invalid secret key".to_string());
    }
    match entry_for(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete secret: {e}")),
    }
}
