use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Response, Server};

use crate::path_guard;

static CURRENT_PROJECT: Mutex<String> = Mutex::new(String::new());
static ALL_PROJECTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new()); // (name, path)
static PENDING_CLIPS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new()); // (projectPath, filePath)
static CLIP_TOKEN: Mutex<String> = Mutex::new(String::new());
static EXTENSION_TOKEN: Mutex<String> = Mutex::new(String::new());
static PAIRING_CODE: Mutex<String> = Mutex::new(String::new());
static PAIRING_GUARD: Mutex<PairingGuard> = Mutex::new(PairingGuard::new());

const PAIRING_CODE_BYTES: usize = 8;
const PAIRING_MIN_LEN: usize = 16;
const PAIRING_MAX_FAILURES: u32 = 5;
const PAIRING_LOCKOUT: Duration = Duration::from_secs(60);

struct PairingGuard {
    failures: u32,
    locked_until: Option<Instant>,
}

impl PairingGuard {
    const fn new() -> Self {
        Self {
            failures: 0,
            locked_until: None,
        }
    }

    fn check_allowed(&mut self) -> Result<(), &'static str> {
        if let Some(until) = self.locked_until {
            if Instant::now() < until {
                return Err("Too many pairing attempts. Try again later.");
            }
            self.locked_until = None;
            self.failures = 0;
        }
        Ok(())
    }

    fn record_failure(&mut self) {
        self.failures = self.failures.saturating_add(1);
        if self.failures >= PAIRING_MAX_FAILURES {
            self.locked_until = Some(Instant::now() + PAIRING_LOCKOUT);
            self.failures = 0;
        }
    }

    fn record_success(&mut self) {
        self.failures = 0;
        self.locked_until = None;
    }
}

/// Daemon status: 0=starting, 1=running, 2=port_conflict, 3=error
static DAEMON_STATUS: AtomicU8 = AtomicU8::new(0);

const PORT: u16 = 19827;
const MAX_BIND_RETRIES: u32 = 3;
const MAX_RESTART_RETRIES: u32 = 10;
const BIND_RETRY_DELAY_SECS: u64 = 2;
const RESTART_DELAY_SECS: u64 = 5;
const MAX_CLIP_BODY_BYTES: u64 = 10 * 1024 * 1024;

/// Get current daemon status as a string
pub fn get_daemon_status() -> &'static str {
    match DAEMON_STATUS.load(Ordering::Relaxed) {
        0 => "starting",
        1 => "running",
        2 => "port_conflict",
        _ => "error",
    }
}

fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..32).map(|_| rng.gen()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn generate_pairing_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..PAIRING_CODE_BYTES)
        .map(|_| format!("{:02X}", rng.gen::<u8>()))
        .collect()
}

fn clip_config_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join("Library/Application Support/trading-review-wiki");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("trading-review-wiki");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".local/share/trading-review-wiki");
        }
    }
    PathBuf::from(".trading-review-wiki")
}

fn load_or_create_pairing_code() -> String {
    let dir = clip_config_dir();
    let path = dir.join("clip-pairing.txt");
    if let Ok(content) = std::fs::read_to_string(&path) {
        let trimmed = content.trim();
        if trimmed.len() >= PAIRING_MIN_LEN {
            return trimmed.to_string();
        }
    }
    let code = generate_pairing_code();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&path, &code);
    code
}

fn clip_state_path() -> PathBuf {
    clip_config_dir().join("clip-state.json")
}

fn app_state_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library/Application Support/com.tradingreviewwiki.app/app-state.json");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("com.tradingreviewwiki.app/app-state.json");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local/share/com.tradingreviewwiki.app/app-state.json");
        }
    }
    PathBuf::from("app-state.json")
}

fn apply_clip_projects(current: &str, projects: &[(String, String)]) {
    if !current.is_empty() {
        if let Ok(mut guard) = CURRENT_PROJECT.lock() {
            *guard = current.to_string();
        }
    }
    if !projects.is_empty() {
        if let Ok(mut guard) = ALL_PROJECTS.lock() {
            *guard = projects.to_vec();
        }
    }
    let root_paths: Vec<String> = projects.iter().map(|(_, path)| path.clone()).collect();
    path_guard::sync_project_roots(&root_paths);
}

fn load_projects_from_app_state() {
    let path = app_state_path();
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };

    let mut projects: Vec<(String, String)> = Vec::new();
    if let Some(arr) = parsed["recentProjects"].as_array() {
        for item in arr {
            let name = item["name"].as_str().unwrap_or("").to_string();
            let path = item["path"].as_str().unwrap_or("").to_string();
            if !path.is_empty() {
                projects.push((name, path));
            }
        }
    }

    let current = parsed["lastProject"]["path"]
        .as_str()
        .unwrap_or("")
        .to_string();

    if projects.is_empty() && current.is_empty() {
        return;
    }

    apply_clip_projects(&current, &projects);
}

/// Called when the desktop app opens or creates a wiki project.
pub fn register_opened_project(name: &str, path: &str) {
    if path.is_empty() {
        return;
    }

    if let Ok(mut guard) = CURRENT_PROJECT.lock() {
        *guard = path.to_string();
    }
    if let Ok(mut guard) = ALL_PROJECTS.lock() {
        guard.retain(|(_, existing)| existing != path);
        guard.insert(0, (name.to_string(), path.to_string()));
        guard.truncate(10);
    }

    path_guard::sync_project_roots(&[path.to_string()]);
    save_clip_state();
}

fn clip_projects_empty() -> bool {
    ALL_PROJECTS
        .lock()
        .map(|guard| guard.is_empty())
        .unwrap_or(true)
}

fn ensure_clip_projects_loaded() {
    if !clip_projects_empty() {
        return;
    }
    load_projects_from_app_state();
    if clip_projects_empty() {
        load_clip_state();
    }
}

fn load_clip_state() {
    let path = clip_state_path();
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };

    let current = parsed["current"].as_str().unwrap_or("").to_string();

    let mut projects: Vec<(String, String)> = Vec::new();
    if let Some(arr) = parsed["projects"].as_array() {
        for item in arr {
            let name = item["name"].as_str().unwrap_or("").to_string();
            let path = item["path"].as_str().unwrap_or("").to_string();
            if !path.is_empty() {
                projects.push((name, path));
            }
        }
    }

    if current.is_empty() && projects.is_empty() {
        return;
    }

    apply_clip_projects(&current, &projects);
}

fn save_clip_state() {
    let (current, projects) = {
        let current = CURRENT_PROJECT.lock().map(|g| g.clone()).unwrap_or_default();
        let projects = ALL_PROJECTS
            .lock()
            .map(|g| {
                g.iter()
                    .map(|(name, path)| {
                        format!(
                            r#"{{"name":"{}","path":"{}"}}"#,
                            name.replace('"', r#"\""#),
                            path.replace('"', r#"\""#)
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        (current, projects)
    };

    let body = format!(
        r#"{{"current":"{}","projects":[{}]}}"#,
        current.replace('"', r#"\""#),
        projects.join(",")
    );
    let dir = clip_config_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(clip_state_path(), body);
}

fn set_clip_server_token(token: String) {
    if let Ok(mut guard) = CLIP_TOKEN.lock() {
        *guard = token;
    }
}

fn set_extension_token(token: String) {
    if let Ok(mut guard) = EXTENSION_TOKEN.lock() {
        *guard = token;
    }
}

fn set_pairing_code(code: String) {
    if let Ok(mut guard) = PAIRING_CODE.lock() {
        *guard = code;
    }
}

pub fn get_clip_server_token() -> String {
    match CLIP_TOKEN.lock() {
        Ok(token) => token.clone(),
        Err(_) => String::new(),
    }
}

fn get_extension_token() -> String {
    match EXTENSION_TOKEN.lock() {
        Ok(token) => token.clone(),
        Err(_) => String::new(),
    }
}

pub fn get_clip_pairing_code() -> String {
    match PAIRING_CODE.lock() {
        Ok(code) => code.clone(),
        Err(_) => String::new(),
    }
}

fn safe_header(name: &str, value: &str) -> Header {
    match Header::from_bytes(name, value) {
        Ok(h) => h,
        Err(_) => Header::from_bytes("Content-Type", "application/json").unwrap(),
    }
}

fn header_value(request: &tiny_http::Request, name: &str) -> Option<String> {
    for header in request.headers().iter() {
        let field = header.field.as_str().to_string();
        if field.eq_ignore_ascii_case(name) {
            return Some(header.value.as_str().to_string());
        }
    }
    None
}

fn verify_pairing(request: &tiny_http::Request) -> bool {
    let expected = get_clip_pairing_code();
    if expected.is_empty() {
        return false;
    }
    match header_value(request, "X-Clip-Pairing") {
        Some(value) => value.trim().eq_ignore_ascii_case(&expected),
        None => false,
    }
}

fn token_matches(value: &str, token: &str) -> bool {
    !token.is_empty() && (value == token || value == format!("Bearer {}", token))
}

fn clip_token_from_request(request: &tiny_http::Request) -> Option<String> {
    for header in request.headers().iter() {
        let field = header.field.as_str().to_string();
        if field.eq_ignore_ascii_case("X-Clip-Token")
            || field.eq_ignore_ascii_case("Authorization")
        {
            return Some(header.value.as_str().to_string());
        }
    }
    None
}

fn verify_master_token(request: &tiny_http::Request) -> bool {
    let master = get_clip_server_token();
    if master.is_empty() {
        return false;
    }
    match clip_token_from_request(request) {
        Some(value) => token_matches(&value, &master),
        None => false,
    }
}

fn verify_clip_token(request: &tiny_http::Request) -> bool {
    if verify_master_token(request) {
        return true;
    }
    let extension = get_extension_token();
    match clip_token_from_request(request) {
        Some(value) => token_matches(&value, &extension),
        None => false,
    }
}

fn read_request_body(request: &mut tiny_http::Request) -> Result<String, String> {
    let mut limited = request.as_reader().take(MAX_CLIP_BODY_BYTES.saturating_add(1));
    let mut body = String::new();
    limited
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed to read body: {e}"))?;
    if body.len() as u64 > MAX_CLIP_BODY_BYTES {
        return Err("Request body too large".to_string());
    }
    Ok(body)
}

fn json_error_response(message: &str, status: u16, cors: &[Header]) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = format!(r#"{{"ok":false,"error":"{}"}}"#, message.replace('"', r#"\""#));
    let mut response = Response::from_string(body).with_status_code(status);
    for header in cors {
        response.add_header(header.clone());
    }
    response
}

pub fn start_clip_server() {
    set_pairing_code(load_or_create_pairing_code());
    set_clip_server_token(generate_token());
    set_extension_token(generate_token());
    load_clip_state();
    if clip_projects_empty() {
        load_projects_from_app_state();
    }

    thread::spawn(|| {
        let mut restart_count: u32;

        loop {
            // Try to bind the port with retries
            let server = {
                let mut last_err = String::new();
                let mut bound = None;
                for attempt in 1..=MAX_BIND_RETRIES {
                    match Server::http(format!("127.0.0.1:{}", PORT)) {
                        Ok(s) => {
                            bound = Some(s);
                            break;
                        }
                        Err(e) => {
                            last_err = format!("{}", e);
                            eprintln!(
                                "[Clip Server] Bind attempt {}/{} failed: {}",
                                attempt, MAX_BIND_RETRIES, e
                            );
                            if attempt < MAX_BIND_RETRIES {
                                thread::sleep(std::time::Duration::from_secs(BIND_RETRY_DELAY_SECS));
                            }
                        }
                    }
                }
                match bound {
                    Some(s) => s,
                    None => {
                        eprintln!(
                            "[Clip Server] Port {} unavailable after {} attempts: {}",
                            PORT, MAX_BIND_RETRIES, last_err
                        );
                        DAEMON_STATUS.store(2, Ordering::Relaxed); // port_conflict
                        return; // Don't retry on port conflict — needs user action
                    }
                }
            };

            DAEMON_STATUS.store(1, Ordering::Relaxed); // running
            restart_count = 0; // Reset on successful bind
            println!("[Clip Server] Listening on http://127.0.0.1:{}", PORT);

        for mut request in server.incoming_requests() {
            let cors_headers = vec![
                safe_header("Access-Control-Allow-Origin", "*"),
                safe_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
                safe_header(
                    "Access-Control-Allow-Headers",
                    "Content-Type, X-Clip-Token, X-Clip-Pairing, Authorization",
                ),
                safe_header("Content-Type", "application/json"),
            ];

            // Handle CORS preflight (browser extension host_permissions bypass CORS)
            if request.method() == &Method::Options {
                let mut response = Response::from_string("").with_status_code(204);
                for h in &cors_headers {
                    response.add_header(h.clone());
                }
                let _ = request.respond(response);
                continue;
            }

            let url = request.url().to_string();

            match (request.method(), url.as_str()) {
                (&Method::Get, "/status") => {
                    let body = r#"{"ok":true}"#;
                    let mut response = Response::from_string(body);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Get, "/clip-token") => {
                    let lockout = match PAIRING_GUARD.lock() {
                        Ok(mut guard) => guard.check_allowed().err().map(str::to_string),
                        Err(_) => Some("Lock error".to_string()),
                    };
                    if let Some(message) = lockout {
                        let _ = request.respond(json_error_response(&message, 429, &cors_headers));
                        continue;
                    }
                    if !verify_pairing(&request) {
                        if let Ok(mut guard) = PAIRING_GUARD.lock() {
                            guard.record_failure();
                        }
                        let _ = request.respond(json_error_response(
                            "Invalid pairing code (X-Clip-Pairing header)",
                            401,
                            &cors_headers,
                        ));
                        continue;
                    }
                    if let Ok(mut guard) = PAIRING_GUARD.lock() {
                        guard.record_success();
                    }
                    let token = get_extension_token();
                    if token.is_empty() {
                        let _ = request.respond(json_error_response("Token unavailable", 503, &cors_headers));
                        continue;
                    }
                    let body = format!(r#"{{"ok":true,"token":"{}"}}"#, token);
                    let mut response = Response::from_string(body);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Get, "/project") => {
                    if !verify_clip_token(&request) {
                        let mut response = Response::from_string(r#"{"ok":false,"error":"Unauthorized"}"#).with_status_code(401);
                        for h in &cors_headers { response.add_header(h.clone()); }
                        let _ = request.respond(response);
                        continue;
                    }
                    ensure_clip_projects_loaded();
                    let path = match CURRENT_PROJECT.lock() {
                        Ok(guard) => guard.clone(),
                        Err(_) => {
                            let mut response = Response::from_string(r#"{"ok":false,"error":"Lock error"}"#).with_status_code(500);
                            for h in &cors_headers { response.add_header(h.clone()); }
                            let _ = request.respond(response);
                            continue;
                        }
                    };
                    let body = format!(r#"{{"ok":true,"path":"{}"}}"#, path);
                    let mut response = Response::from_string(body);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/project") => {
                    if !verify_master_token(&request) {
                        let _ = request.respond(json_error_response("Unauthorized", 401, &cors_headers));
                        continue;
                    }
                    let body = match read_request_body(&mut request) {
                        Ok(body) => body,
                        Err(err) => {
                            let _ = request.respond(json_error_response(&err, 400, &cors_headers));
                            continue;
                        }
                    };

                    let result = handle_set_project(&body);
                    let status = if result.contains(r#""ok":true"#) {
                        200
                    } else {
                        400
                    };
                    let mut response = Response::from_string(result).with_status_code(status);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Get, "/projects") => {
                    if !verify_clip_token(&request) {
                        let mut response = Response::from_string(r#"{"ok":false,"error":"Unauthorized"}"#).with_status_code(401);
                        for h in &cors_headers { response.add_header(h.clone()); }
                        let _ = request.respond(response);
                        continue;
                    }
                    ensure_clip_projects_loaded();
                    let projects = match ALL_PROJECTS.lock() {
                        Ok(guard) => guard.clone(),
                        Err(_) => {
                            let mut response = Response::from_string(r#"{"ok":false,"error":"Lock error"}"#).with_status_code(500);
                            for h in &cors_headers { response.add_header(h.clone()); }
                            let _ = request.respond(response);
                            continue;
                        }
                    };
                    let current = match CURRENT_PROJECT.lock() {
                        Ok(guard) => guard.clone(),
                        Err(_) => {
                            let mut response = Response::from_string(r#"{"ok":false,"error":"Lock error"}"#).with_status_code(500);
                            for h in &cors_headers { response.add_header(h.clone()); }
                            let _ = request.respond(response);
                            continue;
                        }
                    };
                    let items: Vec<String> = projects.iter()
                        .map(|(name, path)| format!(r#"{{"name":"{}","path":"{}","current":{}}}"#,
                            name.replace('"', r#"\""#),
                            path.replace('"', r#"\""#),
                            path == &current))
                        .collect();
                    let body = format!(r#"{{"ok":true,"projects":[{}]}}"#, items.join(","));
                    let mut response = Response::from_string(body);
                    for h in &cors_headers { response.add_header(h.clone()); }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/projects") => {
                    if !verify_master_token(&request) {
                        let _ = request.respond(json_error_response("Unauthorized", 401, &cors_headers));
                        continue;
                    }
                    if let Ok(body) = read_request_body(&mut request) {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
                            if let Some(arr) = parsed["projects"].as_array() {
                                let mut root_paths = Vec::new();
                                if let Ok(mut projects) = ALL_PROJECTS.lock() {
                                    projects.clear();
                                    for item in arr {
                                        let name = item["name"].as_str().unwrap_or("").to_string();
                                        let path = item["path"].as_str().unwrap_or("").to_string();
                                        if !path.is_empty() {
                                            projects.push((name, path.clone()));
                                            root_paths.push(path);
                                        }
                                    }
                                }
                                path_guard::sync_project_roots(&root_paths);
                            }
                        }
                    }
                    save_clip_state();
                    let mut response = Response::from_string(r#"{"ok":true}"#);
                    for h in &cors_headers { response.add_header(h.clone()); }
                    let _ = request.respond(response);
                }
                (&Method::Get, "/clips/pending") => {
                    if !verify_master_token(&request) {
                        let mut response = Response::from_string(r#"{"ok":false,"error":"Unauthorized"}"#).with_status_code(401);
                        for h in &cors_headers { response.add_header(h.clone()); }
                        let _ = request.respond(response);
                        continue;
                    }
                    let mut pending = match PENDING_CLIPS.lock() {
                        Ok(guard) => guard,
                        Err(_) => {
                            let mut response = Response::from_string(r#"{"ok":false,"error":"Lock error"}"#).with_status_code(500);
                            for h in &cors_headers { response.add_header(h.clone()); }
                            let _ = request.respond(response);
                            continue;
                        }
                    };
                    let items: Vec<String> = pending.iter()
                        .map(|(proj, file)| format!(r#"{{"projectPath":"{}","filePath":"{}"}}"#,
                            proj.replace('"', r#"\""#), file.replace('"', r#"\""#)))
                        .collect();
                    let body = format!(r#"{{"ok":true,"clips":[{}]}}"#, items.join(","));
                    pending.clear();
                    let mut response = Response::from_string(body);
                    for h in &cors_headers { response.add_header(h.clone()); }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/clip") => {
                    if !verify_clip_token(&request) {
                        let _ = request.respond(json_error_response("Unauthorized", 401, &cors_headers));
                        continue;
                    }
                    let body = match read_request_body(&mut request) {
                        Ok(body) => body,
                        Err(err) => {
                            let _ = request.respond(json_error_response(&err, 400, &cors_headers));
                            continue;
                        }
                    };

                    let result = handle_clip(&body);
                    let status = if result.contains(r#""ok":true"#) {
                        200
                    } else {
                        500
                    };
                    let mut response = Response::from_string(result).with_status_code(status);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                _ => {
                    let body = r#"{"ok":false,"error":"Not found"}"#;
                    let mut response = Response::from_string(body).with_status_code(404);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
            }
        }

            // Server loop exited (shouldn't happen normally)
            DAEMON_STATUS.store(3, Ordering::Relaxed); // error
            restart_count += 1;

            if restart_count >= MAX_RESTART_RETRIES {
                eprintln!(
                    "[Clip Server] Exceeded max restarts ({}). Giving up.",
                    MAX_RESTART_RETRIES
                );
                return;
            }

            eprintln!(
                "[Clip Server] Crashed. Restarting in {}s (attempt {}/{})",
                RESTART_DELAY_SECS, restart_count, MAX_RESTART_RETRIES
            );
            thread::sleep(std::time::Duration::from_secs(RESTART_DELAY_SECS));
        }
    });
}

fn handle_set_project(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let path = match parsed["path"].as_str() {
        Some(p) => p.to_string(),
        None => return r#"{"ok":false,"error":"path field is required"}"#.to_string(),
    };

    if !path_guard::is_registered_project(&path) {
        return r#"{"ok":false,"error":"path is not a registered project"}"#.to_string();
    }

    let updated = match CURRENT_PROJECT.lock() {
        Ok(mut guard) => {
            *guard = path;
            true
        }
        Err(_) => false,
    };
    if updated {
        save_clip_state();
        r#"{"ok":true}"#.to_string()
    } else {
        r#"{"ok":false,"error":"Lock error"}"#.to_string()
    }
}

fn handle_clip(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let title = parsed["title"].as_str().unwrap_or("Untitled");
    let url = parsed["url"].as_str().unwrap_or("");
    let content = parsed["content"].as_str().unwrap_or("");

    // Use projectPath from request body, or fall back to globally-set project path
    let project_path_from_body = parsed["projectPath"].as_str().unwrap_or("").to_string();
    let project_path = if project_path_from_body.is_empty() {
        match CURRENT_PROJECT.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => return r#"{"ok":false,"error":"Lock error"}"#.to_string(),
        }
    } else {
        project_path_from_body
    };

    if project_path.is_empty() {
        return r#"{"ok":false,"error":"projectPath is required (set via POST /project or include in request body)"}"#
            .to_string();
    }

    if !path_guard::is_registered_project(&project_path) {
        return r#"{"ok":false,"error":"projectPath is not a registered project"}"#.to_string();
    }

    let project = match path_guard::assert_writable(&project_path) {
        Ok(path) => path,
        Err(err) => return format!(r#"{{"ok":false,"error":"{}"}}"#, err.replace('"', r#"\""#)),
    };

    if content.is_empty() {
        return r#"{"ok":false,"error":"content is required"}"#.to_string();
    }

    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date_compact = chrono::Local::now().format("%Y%m%d").to_string();

    // Generate slug from title
    let slug_raw: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    let slug: String = slug_raw.chars().take(50).collect();

    let base_name = format!("{}-{}", slug, date_compact);
    let dir_path = project.join("raw").join("sources");

    // Ensure directory exists
    if let Err(e) = std::fs::create_dir_all(&dir_path) {
        return format!(
            r#"{{"ok":false,"error":"Failed to create directory: {}"}}"#,
            e
        );
    }

    // Find unique filename
    let mut file_path = dir_path.join(format!("{}.md", base_name));
    let mut counter = 2u32;
    while file_path.exists() {
        file_path = dir_path.join(format!("{}-{}.md", base_name, counter));
        counter += 1;
    }
    let file_path = file_path.to_string_lossy().to_string();

    // Build markdown content with web-clip origin
    let markdown = format!(
        "---\ntype: clip\ntitle: \"{}\"\nurl: \"{}\"\nclipped: {}\norigin: web-clip\nsources: []\ntags: [web-clip]\n---\n\n# {}\n\nSource: {}\n\n{}\n",
        title.replace('"', r#"\""#),
        url.replace('"', r#"\""#),
        date,
        title,
        url,
        content,
    );

    if let Err(e) = std::fs::write(&file_path, &markdown) {
        return format!(
            r#"{{"ok":false,"error":"Failed to write file: {}"}}"#,
            e
        );
    }

    // Compute relative path using Path for cross-platform separator handling
    let relative_path = {
        let full = std::path::Path::new(&file_path);
        full.strip_prefix(&project)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path.replace('\\', "/"))
    };

    // Add to pending clips for frontend to pick up and auto-ingest
    match PENDING_CLIPS.lock() {
        Ok(mut pending) => {
            pending.push((project_path, file_path.clone()));
        }
        Err(_) => {
            return r#"{"ok":false,"error":"Lock error"}"#.to_string();
        }
    }

    format!(r#"{{"ok":true,"path":"{}"}}"#, relative_path)
}
