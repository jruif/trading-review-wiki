use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use lancedb::Connection;

use crate::path_guard;

static DB_CACHE: OnceLock<Mutex<HashMap<String, Arc<Connection>>>> = OnceLock::new();

fn db_cache() -> &'static Mutex<HashMap<String, Arc<Connection>>> {
    DB_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_project_key(project_path: &str) -> String {
    path_guard::resolve_path(project_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| project_path.replace('\\', "/"))
}

pub async fn get_connection(project_path: &str) -> Result<Arc<Connection>, String> {
    let key = normalize_project_key(project_path);
    if let Ok(cache) = db_cache().lock() {
        if let Some(db) = cache.get(&key) {
            return Ok(db.clone());
        }
    }

    let db_path = format!("{}/.llm-wiki/lancedb", project_path.replace('\\', "/"));
    let db = Arc::new(
        lancedb::connect(&db_path)
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?,
    );

    if let Ok(mut cache) = db_cache().lock() {
        cache.insert(key, db.clone());
    }
    Ok(db)
}

pub fn invalidate_connection(project_path: &str) {
    let key = normalize_project_key(project_path);
    if let Ok(mut cache) = db_cache().lock() {
        cache.remove(&key);
    }
}
