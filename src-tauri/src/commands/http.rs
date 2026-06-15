use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

use url::Url;

fn should_forward_header(key: &str) -> bool {
    !key.eq_ignore_ascii_case("content-type")
}

fn is_blocked_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.octets()[0] == 169 && v4.octets()[1] == 254
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

fn is_allowed_local_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

pub fn validate_outbound_url(url_str: &str) -> Result<Url, String> {
    let url = Url::parse(url_str).map_err(|e| format!("Invalid URL: {e}"))?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("Unsupported URL scheme: {scheme}"));
    }

    let host = url
        .host_str()
        .ok_or_else(|| "URL must include a host".to_string())?;

    if is_allowed_local_host(host) {
        return Ok(url);
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if ip.is_loopback() {
            return Ok(url);
        }
        if is_blocked_private_ip(ip) {
            return Err(format!(
                "Requests to private or link-local addresses are not allowed: {host}"
            ));
        }
        return Ok(url);
    }

    let lower = host.to_ascii_lowercase();
    if lower.ends_with(".local") || lower.ends_with(".internal") || lower == "metadata.google.internal" {
        return Err(format!("Requests to internal hostnames are not allowed: {host}"));
    }

    Ok(url)
}

fn validate_ip_address(ip: IpAddr) -> Result<(), String> {
    if ip.is_loopback() {
        return Err(format!(
            "Requests to loopback addresses are not allowed: {ip}"
        ));
    }
    if is_blocked_private_ip(ip) {
        return Err(format!(
            "Requests to private or link-local addresses are not allowed: {ip}"
        ));
    }
    Ok(())
}

async fn validate_resolved_addresses(url: &Url) -> Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "URL must include a host".to_string())?;

    if is_allowed_local_host(host) {
        return Ok(());
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if ip.is_loopback() {
            return Ok(());
        }
        return validate_ip_address(ip);
    }

    let port = url.port_or_known_default().unwrap_or(443);
    let lookup = format!("{host}:{port}");
    let addrs: Vec<_> = lookup
        .to_socket_addrs()
        .map_err(|e| format!("DNS lookup failed for {host}: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("DNS lookup returned no addresses for {host}"));
    }
    for addr in addrs {
        validate_ip_address(addr.ip())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn post_json_via_native_http(
    url: String,
    headers: HashMap<String, String>,
    body: serde_json::Value,
) -> Result<String, String> {
    let validated_url = validate_outbound_url(&url)?;
    validate_resolved_addresses(&validated_url).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| format!("[HTTP_CLIENT_ERROR] 创建HTTP客户端失败: {}", e))?;
    let mut request = client.post(validated_url).json(&body);

    for (key, value) in headers {
        if should_forward_header(&key) {
            request = request.header(&key, value);
        }
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("[HTTP_REQUEST_ERROR] HTTP请求失败: {}", e))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("[HTTP_RESPONSE_ERROR] 读取HTTP响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "[HTTP_STATUS_ERROR] HTTP请求返回错误状态 {}: {}",
            status.as_u16(),
            text
        ));
    }

    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::{should_forward_header, validate_outbound_url};

    #[test]
    fn filters_content_type_case_insensitively() {
        assert!(!should_forward_header("Content-Type"));
        assert!(!should_forward_header("content-type"));
        assert!(!should_forward_header("CONTENT-TYPE"));
    }

    #[test]
    fn keeps_other_headers() {
        assert!(should_forward_header("Authorization"));
        assert!(should_forward_header("X-Test"));
    }

    #[test]
    fn allows_local_llm_endpoints() {
        assert!(validate_outbound_url("http://127.0.0.1:11434/v1/chat/completions").is_ok());
        assert!(validate_outbound_url("http://localhost:1234/v1/embeddings").is_ok());
    }

    #[test]
    fn blocks_private_network_targets() {
        assert!(validate_outbound_url("http://192.168.1.10/secret").is_err());
        assert!(validate_outbound_url("http://10.0.0.1/metadata").is_err());
    }
}
