use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use crate::path_guard;

use chrono::Local;
use serde::Serialize;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

#[derive(Debug, Serialize)]
pub struct BodyResidueBackupResult {
    pub backup_path: String,
    pub files: Vec<String>,
    pub backed_up: usize,
}

/// Zip the wiki/ directory into .llm-wiki/backups/body-residue-<ts>.zip,
/// then enumerate every *.md under wiki/ for TS-side residue cleanup.
#[tauri::command]
pub fn body_residue_backup(project_path: String) -> Result<BodyResidueBackupResult, String> {
    let project = path_guard::assert_writable(&project_path)?;
    let wiki_dir = project.join("wiki");
    if !wiki_dir.is_dir() {
        return Err(format!("INVALID_PATH wiki/ 目录不存在: {}", wiki_dir.display()));
    }

    let backups_dir = project.join(".llm-wiki").join("backups");
    fs::create_dir_all(&backups_dir)
        .map_err(|e| format!("WRITE_FAILED 创建备份目录失败: {}", e))?;

    let ts = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let backup_path = backups_dir.join(format!("body-residue-{}.zip", ts));
    let backed_up = create_zip(&wiki_dir, &backup_path)?;

    let mut files = Vec::new();
    for entry in WalkDir::new(&wiki_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let rel = match p.strip_prefix(&project) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.starts_with(".llm-wiki/")
            || rel_str.contains("/backups/")
            || rel_str.contains("/.conflicts/")
        {
            continue;
        }
        files.push(rel_str);
    }
    files.sort();

    Ok(BodyResidueBackupResult {
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
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if name.contains("/.conflicts/") || name.contains("/backups/") {
            continue;
        }

        if entry.file_type().is_dir() {
            if name.is_empty() {
                continue;
            }
            let dir_name = if name.ends_with('/') { name.clone() } else { format!("{}/", name) };
            writer
                .add_directory(dir_name, options)
                .map_err(|e| format!("WRITE_FAILED zip 加目录失败: {}", e))?;
        } else if entry.file_type().is_file() {
            writer
                .start_file(&name, options)
                .map_err(|e| format!("WRITE_FAILED zip 加文件失败: {}", e))?;
            let mut f = fs::File::open(path)
                .map_err(|e| format!("FILE_NOT_FOUND 打开源文件失败: {}", e))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)
                .map_err(|e| format!("UNKNOWN 读取源文件失败: {}", e))?;
            writer
                .write_all(&buf)
                .map_err(|e| format!("WRITE_FAILED 写 zip 失败: {}", e))?;
            count += 1;
        }
    }

    writer.finish().map_err(|e| format!("WRITE_FAILED 关闭 zip 失败: {}", e))?;
    Ok(count)
}
