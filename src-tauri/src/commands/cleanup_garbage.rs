use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use crate::path_guard;

use chrono::Local;
use serde::Serialize;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

#[derive(Debug, Serialize)]
pub struct CleanupGarbageBackupResult {
    pub backup_path: String,
    /// 仅 wiki/源文档/ 和 wiki/查询/ 下的 .md 相对路径
    pub files: Vec<String>,
    pub backed_up: usize,
}

/// T26: 备份 wiki/，然后枚举 wiki/源文档/ + wiki/查询/ 下所有 .md 给 TS 端做垃圾检测。
/// 排除 .llm-wiki / .conflicts / backups。
#[tauri::command]
pub fn cleanup_garbage_backup(project_path: String) -> Result<CleanupGarbageBackupResult, String> {
    let project = path_guard::assert_writable(&project_path)?;
    let wiki_dir = project.join("wiki");
    if !wiki_dir.is_dir() {
        return Err(format!("INVALID_PATH wiki/ 目录不存在: {}", wiki_dir.display()));
    }

    let backups_dir = project.join(".llm-wiki").join("backups");
    fs::create_dir_all(&backups_dir)
        .map_err(|e| format!("WRITE_FAILED 创建备份目录失败: {}", e))?;

    let ts = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let backup_path = backups_dir.join(format!("cleanup-garbage-{}.zip", ts));
    let backed_up = create_zip(&wiki_dir, &backup_path)?;

    // 只枚举 源文档/ + 查询/ 下的 .md
    let scan_dirs = ["源文档", "查询"];
    let mut files = Vec::new();
    for sub in scan_dirs.iter() {
        let target = wiki_dir.join(sub);
        if !target.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&target).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let rel = match p.strip_prefix(&project) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if rel_str.contains("/.conflicts/") {
                continue;
            }
            files.push(rel_str);
        }
    }
    files.sort();

    Ok(CleanupGarbageBackupResult {
        backup_path: backup_path.to_string_lossy().to_string(),
        files,
        backed_up,
    })
}

fn create_zip(source_dir: &Path, target_zip: &Path) -> Result<usize, String> {
    let file = fs::File::create(target_zip)
        .map_err(|e| format!("WRITE_FAILED 创建 zip 失败: {}", e))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let parent = source_dir.parent().unwrap_or(source_dir);
    let mut count = 0usize;

    for entry in WalkDir::new(source_dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = match path.strip_prefix(parent) {
            Ok(n) => n,
            Err(_) => continue,
        };
        let name_str = name.to_string_lossy().replace('\\', "/");
        // 排除 .conflicts/ 和过往备份
        if name_str.contains("/.conflicts/") || name_str.contains("/backups/") {
            continue;
        }

        if path.is_file() {
            writer
                .start_file(&name_str, options)
                .map_err(|e| format!("WRITE_FAILED zip start: {}", e))?;
            let mut f = fs::File::open(path)
                .map_err(|e| format!("WRITE_FAILED open {}: {}", path.display(), e))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)
                .map_err(|e| format!("WRITE_FAILED read {}: {}", path.display(), e))?;
            writer
                .write_all(&buf)
                .map_err(|e| format!("WRITE_FAILED zip write: {}", e))?;
            count += 1;
        }
    }

    writer
        .finish()
        .map_err(|e| format!("WRITE_FAILED zip finish: {}", e))?;
    Ok(count)
}
