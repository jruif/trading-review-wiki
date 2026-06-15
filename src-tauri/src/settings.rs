use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PgConfig {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    /// When true, connect with TLS. Defaults to true for non-local hosts.
    pub use_tls: Option<bool>,
}

impl PgConfig {
    pub fn is_complete(&self) -> bool {
        self.host.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
            && self.port.is_some()
            && self.user.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
            && self.password.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
            && self.database.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
    }

    pub fn connection_string(&self) -> Option<String> {
        if !self.is_complete() {
            return None;
        }
        Some(format!(
            "host={} port={} user={} password={} dbname={}",
            self.host.as_deref()?,
            self.port?,
            self.user.as_deref()?,
            self.password.as_deref()?,
            self.database.as_deref()?,
        ))
    }
}
