use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{Local, TimeZone};
use rustls::client::ClientConfig;
use rustls::RootCertStore;
use serde::{Deserialize, Serialize};
use tokio_postgres::{Client, NoTls};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::path_guard;
use crate::settings::PgConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockCodeFile {
    pub synced_at: String,
    pub count: usize,
    pub mapping: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncResult {
    pub count: usize,
    pub synced_at: String,
    pub skipped: bool,
}

fn cache() -> &'static Mutex<HashMap<String, StockCodeFile>> {
    static CACHE: OnceLock<Mutex<HashMap<String, StockCodeFile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stock_codes_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join(".llm-wiki")
        .join("stock-codes.json")
}

fn now_local_timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn parse_synced_at(s: &str) -> Option<chrono::DateTime<chrono::Local>> {
    let naive = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()?;
    Local.from_local_datetime(&naive).single()
}

fn load_from_disk(project_path: &str) -> Option<StockCodeFile> {
    let content = fs::read_to_string(stock_codes_path(project_path)).ok()?;
    serde_json::from_str(&content).ok()
}

fn get_or_load(project_path: &str) -> Option<StockCodeFile> {
    if let Ok(guard) = cache().lock() {
        if let Some(file) = guard.get(project_path) {
            return Some(file.clone());
        }
    }
    let file = load_from_disk(project_path)?;
    if let Ok(mut guard) = cache().lock() {
        guard.insert(project_path.to_string(), file.clone());
    }
    Some(file)
}

fn is_local_pg_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

fn should_use_tls(pg_config: &PgConfig) -> bool {
    if let Some(use_tls) = pg_config.use_tls {
        return use_tls;
    }
    !is_local_pg_host(pg_config.host.as_deref().unwrap_or(""))
}

async fn connect_pg(pg_config: &PgConfig) -> Result<Client, String> {
    let conn_str = pg_config
        .connection_string()
        .ok_or_else(|| "INVALID_PATH PG 配置未填写".to_string())?;

    if should_use_tls(pg_config) {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = ClientConfig::builder()
            .with_root_certificates(Arc::new(roots))
            .with_no_client_auth();
        let tls = MakeRustlsConnect::new(config);
        let (client, connection) = tokio_postgres::connect(&conn_str, tls)
            .await
            .map_err(|e| format!("TIMEOUT PG TLS 连接失败: {e}"))?;
        tauri::async_runtime::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("[stock_codes] PG connection terminated: {}", e);
            }
        });
        return Ok(client);
    }

    let (client, connection) = tokio_postgres::connect(&conn_str, NoTls)
        .await
        .map_err(|e| format!("TIMEOUT PG 连接失败: {e}"))?;
    tauri::async_runtime::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("[stock_codes] PG connection terminated: {}", e);
        }
    });
    Ok(client)
}

#[tauri::command]
pub async fn sync_stock_codes(
    project_path: String,
    pg_config: PgConfig,
    force: bool,
) -> Result<SyncResult, String> {
    path_guard::assert_readable(&project_path)?;
    if !force {
        if let Some(existing) = load_from_disk(&project_path) {
            if let Some(ts) = parse_synced_at(&existing.synced_at) {
                let age_hours = Local::now().signed_duration_since(ts).num_hours();
                if age_hours < 24 {
                    if let Ok(mut guard) = cache().lock() {
                        guard.insert(project_path.clone(), existing.clone());
                    }
                    return Ok(SyncResult {
                        count: existing.count,
                        synced_at: existing.synced_at,
                        skipped: true,
                    });
                }
            }
        }
    }

    let client = connect_pg(&pg_config).await?;

    let rows = client
        .query(
            "SELECT DISTINCT ON (ticker) ticker, stock_name FROM cn_stock_name_wind ORDER BY ticker, date DESC",
            &[],
        )
        .await
        .map_err(|e| format!("UNKNOWN PG 查询失败: {}", e))?;

    let mut mapping = BTreeMap::new();
    for row in rows {
        let ticker: String = row.get(0);
        let name: String = row.get(1);
        if !ticker.is_empty() && !name.is_empty() {
            mapping.insert(name, ticker);
        }
    }

    let synced_at = now_local_timestamp();
    let file = StockCodeFile {
        synced_at: synced_at.clone(),
        count: mapping.len(),
        mapping,
    };

    let path = stock_codes_path(&project_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("WRITE_FAILED 创建目录失败: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("UNKNOWN 序列化失败: {}", e))?;
    fs::write(&path, json)
        .map_err(|e| format!("WRITE_FAILED 写入 stock-codes.json 失败: {}", e))?;

    if let Ok(mut guard) = cache().lock() {
        guard.insert(project_path.clone(), file.clone());
    }

    Ok(SyncResult {
        count: file.count,
        synced_at,
        skipped: false,
    })
}

fn try_match(mapping: &BTreeMap<String, String>, name: &str) -> Option<String> {
    if let Some(v) = mapping.get(name) {
        return Some(v.clone());
    }
    // 科创板未盈利新股常带 -U/-W/-N 后缀（wind 命名约定）
    for suffix in ["-U", "-W", "-N"] {
        let key = format!("{}{}", name, suffix);
        if let Some(v) = mapping.get(&key) {
            return Some(v.clone());
        }
    }
    // ST / *ST 前缀
    for prefix in ["ST", "*ST"] {
        let key = format!("{}{}", prefix, name);
        if let Some(v) = mapping.get(&key) {
            return Some(v.clone());
        }
    }
    None
}

#[tauri::command]
pub fn lookup_stock_code(
    project_path: String,
    name: String,
) -> Result<Option<String>, String> {
    Ok(get_or_load(&project_path).and_then(|f| try_match(&f.mapping, &name)))
}

#[tauri::command]
pub fn get_stock_codes_status(project_path: String) -> Result<Option<SyncResult>, String> {
    Ok(load_from_disk(&project_path).map(|f| SyncResult {
        count: f.count,
        synced_at: f.synced_at,
        skipped: true,
    }))
}
