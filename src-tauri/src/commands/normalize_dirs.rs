use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use crate::path_guard;

use chrono::Local;
use serde::Serialize;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

// 9 个 canonical wiki 目录（与 src/lib/schema.ts WIKI_TYPES 一致）
const CANONICAL_DIRS: &[&str] = &[
    "股票", "概念", "策略", "模式", "错误", "人物", "总结", "查询", "源文档",
];

// 散乱目录 → canonical（与 schema.ts TYPE_ALIASES 一致）
const DIR_ALIASES: &[(&str, &str)] = &[
    ("个股档案", "股票"),
    ("concept", "概念"),
    ("市场模式", "模式"),
    ("市场环境", "模式"),
    ("进化", "模式"),
    ("预测", "模式"),
    ("people", "人物"),
    ("analysis", "总结"),
    ("synthesis", "总结"),
    ("comparisons", "总结"),
    ("queries", "查询"),
    ("sources", "源文档"),
];

// 根目录文件归类
const ROOT_FILE_ALIASES: &[(&str, &str)] = &[
    ("position-tracking.md", "查询"),
    ("trading-rules.md", "策略"),
    ("market-environment.md", "模式"),
];

// 根目录保留 housekeeping 页
const ROOT_KEEP: &[&str] = &["index.md", "overview.md", "log.md"];

// 垃圾目录 substring 检测（LLM 残留前缀）
const GARBAGE_DIR_PATTERNS: &[&str] = &["好的，以下是", "[[", "页面内容"];

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DirMerge {
    pub from: String,
    pub to: String,
    pub file_count: usize,
}

#[derive(Debug, Serialize)]
pub struct Conflict {
    pub original_rel: String,
    pub kept_rel: String,
    pub archived_to_rel: String,
    pub kept_updated: String,
    pub loser_updated: String,
}

#[derive(Debug, Serialize)]
pub struct RootMove {
    pub from_rel: String,
    pub to_rel: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct MovedFile {
    /// 移动后的相对路径，如 `wiki/股票/X.md`
    pub new_rel: String,
    /// 该目录对应的 canonical type，如 `股票`
    pub canonical_type: String,
}

#[derive(Debug, Serialize)]
pub struct NormalizeReport {
    pub backup_path: String,
    pub dirs_merged: Vec<DirMerge>,
    pub conflicts: Vec<Conflict>,
    pub root_files_moved: Vec<RootMove>,
    pub uncategorized: Vec<String>,
    pub dirs_removed: Vec<String>,
    pub wikilinks_updated_files: usize,
    pub wikilinks_updated_total: usize,
    pub moved_files: Vec<MovedFile>,
    pub errors: Vec<(String, String)>,
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部数据
// ─────────────────────────────────────────────────────────────────────────────

struct PlannedMove {
    src_rel: String,            // wiki/进化/X.md
    dst_rel: String,            // wiki/模式/X.md
    canonical_type: String,     // 模式
}

struct PlannedConflict {
    loser_src_rel: String,
    loser_archive_rel: String,  // wiki/.conflicts/wiki/进化/X.md
    winner_dst_rel: String,
    loser_updated: String,
    winner_updated: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// 主命令
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn normalize_wiki_dirs(project_path: String) -> Result<NormalizeReport, String> {
    let project = path_guard::assert_writable(&project_path)?;
    let wiki_dir = project.join("wiki");
    if !wiki_dir.is_dir() {
        return Err(format!("INVALID_PATH wiki/ 目录不存在: {}", wiki_dir.display()));
    }

    // Step 1: backup
    let backups_dir = project.join(".llm-wiki").join("backups");
    fs::create_dir_all(&backups_dir)
        .map_err(|e| format!("WRITE_FAILED 创建备份目录失败: {}", e))?;
    let ts = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let backup_path = backups_dir.join(format!("normalize-dirs-{}.zip", ts));
    create_backup_zip(&wiki_dir, &backup_path)?;

    let mut report = NormalizeReport {
        backup_path: backup_path.to_string_lossy().to_string(),
        dirs_merged: Vec::new(),
        conflicts: Vec::new(),
        root_files_moved: Vec::new(),
        uncategorized: Vec::new(),
        dirs_removed: Vec::new(),
        wikilinks_updated_files: 0,
        wikilinks_updated_total: 0,
        moved_files: Vec::new(),
        errors: Vec::new(),
    };

    // Step 2: build move plan + conflict detection
    let (planned_moves, planned_conflicts, dirs_to_merge, root_moves, uncategorized, garbage_dirs) =
        build_plan(&project, &wiki_dir, &mut report)?;

    for u in &uncategorized {
        report.uncategorized.push(u.clone());
    }
    for (from, to, count) in dirs_to_merge {
        report.dirs_merged.push(DirMerge { from, to, file_count: count });
    }
    for rm in &root_moves {
        report.root_files_moved.push(RootMove {
            from_rel: rm.src_rel.clone(),
            to_rel: rm.dst_rel.clone(),
        });
    }

    // Step 3: execute moves（含目录内文件 + 根目录散落文件）
    for mv in planned_moves.iter().chain(root_moves.iter()) {
        match execute_move(&project, &mv.src_rel, &mv.dst_rel) {
            Ok(()) => {
                report.moved_files.push(MovedFile {
                    new_rel: mv.dst_rel.clone(),
                    canonical_type: mv.canonical_type.clone(),
                });
            }
            Err(e) => report.errors.push((mv.src_rel.clone(), e)),
        }
    }

    // Step 4: archive losers to .conflicts/
    for c in &planned_conflicts {
        match archive_loser(&project, &c.loser_src_rel, &c.loser_archive_rel) {
            Ok(()) => {
                report.conflicts.push(Conflict {
                    original_rel: c.loser_src_rel.clone(),
                    kept_rel: c.winner_dst_rel.clone(),
                    archived_to_rel: c.loser_archive_rel.clone(),
                    kept_updated: c.winner_updated.clone(),
                    loser_updated: c.loser_updated.clone(),
                });
            }
            Err(e) => report.errors.push((c.loser_src_rel.clone(), e)),
        }
    }

    // Step 5: garbage dirs - move contents to .conflicts/garbage-<basename>/
    for garbage_dir_rel in &garbage_dirs {
        if let Err(e) = archive_garbage_dir(&project, garbage_dir_rel) {
            report.errors.push((garbage_dir_rel.clone(), e));
        }
    }

    // Step 6: clean up empty source dirs
    cleanup_empty_dirs(&project, &wiki_dir, &mut report);

    // Step 7: wikilink replacement (across all .md, including index/overview/log)
    let (files_changed, total_replaced) = replace_wikilinks_globally(&project, &wiki_dir, &mut report);
    report.wikilinks_updated_files = files_changed;
    report.wikilinks_updated_total = total_replaced;

    Ok(report)
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan building
// ─────────────────────────────────────────────────────────────────────────────

#[allow(clippy::type_complexity)]
fn build_plan(
    project: &Path,
    wiki_dir: &Path,
    report: &mut NormalizeReport,
) -> Result<
    (
        Vec<PlannedMove>,         // dir-to-dir 移动
        Vec<PlannedConflict>,     // 冲突归档
        Vec<(String, String, usize)>, // (from_dir_rel, to_dir_canonical, count)
        Vec<PlannedMove>,         // 根目录文件移动（用同结构，dst_rel 在 wiki/<canonical>/）
        Vec<String>,              // uncategorized 根目录文件相对路径
        Vec<String>,              // 垃圾目录相对路径
    ),
    String,
> {
    let alias_map: HashMap<&str, &str> = DIR_ALIASES.iter().copied().collect();
    let canonical: std::collections::HashSet<&str> = CANONICAL_DIRS.iter().copied().collect();
    let root_alias_map: HashMap<&str, &str> = ROOT_FILE_ALIASES.iter().copied().collect();
    let root_keep: std::collections::HashSet<&str> = ROOT_KEEP.iter().copied().collect();

    // 收集 (target_dir, basename) → list of (src_rel, updated)
    let mut pending: HashMap<(String, String), Vec<(String, String)>> = HashMap::new();
    let mut dir_counts: HashMap<String, usize> = HashMap::new(); // src_dir_name → count
    let mut root_moves: Vec<PlannedMove> = Vec::new();
    let mut uncategorized: Vec<String> = Vec::new();
    let mut garbage_dirs: Vec<String> = Vec::new();

    for entry in fs::read_dir(wiki_dir).map_err(|e| format!("UNKNOWN 读 wiki/ 失败: {}", e))? {
        let entry = entry.map_err(|e| format!("UNKNOWN: {}", e))?;
        let path = entry.path();
        let file_name = match entry.file_name().to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };

        if path.is_dir() {
            // 跳过 .llm-wiki / .conflicts
            if file_name.starts_with('.') {
                continue;
            }
            // 垃圾目录
            if GARBAGE_DIR_PATTERNS.iter().any(|p| file_name.contains(p)) {
                garbage_dirs.push(format!("wiki/{}", file_name));
                continue;
            }

            // canonical 或 alias
            let target_dir: Option<&str> = if canonical.contains(file_name.as_str()) {
                Some(file_name.as_str())
            } else if let Some(&t) = alias_map.get(file_name.as_str()) {
                Some(t)
            } else {
                // 未识别目录 → 不动，报告
                report
                    .uncategorized
                    .push(format!("wiki/{}/  (未识别目录，跳过)", file_name));
                None
            };

            if let Some(target) = target_dir {
                let mut count = 0usize;
                for sub in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
                    if !sub.file_type().is_file() {
                        continue;
                    }
                    if sub.path().extension().and_then(|s| s.to_str()) != Some("md") {
                        continue;
                    }
                    let src_rel = match sub.path().strip_prefix(project) {
                        Ok(r) => r.to_string_lossy().replace('\\', "/"),
                        Err(_) => continue,
                    };
                    let basename = match sub.path().file_name().and_then(|s| s.to_str()) {
                        Some(s) => s.to_string(),
                        None => continue,
                    };
                    let updated = read_updated_field(sub.path()).unwrap_or_default();
                    pending
                        .entry((target.to_string(), basename))
                        .or_default()
                        .push((src_rel, updated));
                    count += 1;
                }
                if file_name != target {
                    *dir_counts.entry(file_name.clone()).or_insert(0) += count;
                }
            }
        } else if path.is_file() {
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            if root_keep.contains(file_name.as_str()) {
                continue;
            }
            if let Some(&t) = root_alias_map.get(file_name.as_str()) {
                let dst_rel = format!("wiki/{}/{}", t, file_name);
                let src_rel = format!("wiki/{}", file_name);
                root_moves.push(PlannedMove {
                    src_rel,
                    dst_rel,
                    canonical_type: t.to_string(),
                });
            } else {
                uncategorized.push(format!("wiki/{}", file_name));
            }
        }
    }

    // 解析冲突：每个 (target_dir, basename) 选 winner（updated 较新）+ losers
    let mut planned_moves: Vec<PlannedMove> = Vec::new();
    let mut planned_conflicts: Vec<PlannedConflict> = Vec::new();

    for ((target, basename), mut candidates) in pending {
        // 排序：updated DESC（空 updated 视为最旧）
        candidates.sort_by(|a, b| b.1.cmp(&a.1));
        let winner = candidates.remove(0);
        let dst_rel = format!("wiki/{}/{}", target, basename);
        let canonical_type = target.clone();

        // winner 的 src 与 dst 不同 → 计划移动
        if winner.0 != dst_rel {
            planned_moves.push(PlannedMove {
                src_rel: winner.0.clone(),
                dst_rel: dst_rel.clone(),
                canonical_type: canonical_type.clone(),
            });
        }
        // 其余都是 losers → archive
        for loser in candidates {
            let archive_rel = format!("wiki/.conflicts/{}", loser.0);
            planned_conflicts.push(PlannedConflict {
                loser_src_rel: loser.0,
                loser_archive_rel: archive_rel,
                winner_dst_rel: dst_rel.clone(),
                loser_updated: loser.1,
                winner_updated: winner.1.clone(),
            });
        }
    }

    // 转 dir_counts → DirMerge 列表（与上面 src_dir_name → target_dir 对齐）
    let alias_lookup: HashMap<&str, &str> = DIR_ALIASES.iter().copied().collect();
    let mut dirs_to_merge: Vec<(String, String, usize)> = Vec::new();
    for (from_dir, count) in dir_counts {
        let to = alias_lookup
            .get(from_dir.as_str())
            .copied()
            .unwrap_or(from_dir.as_str())
            .to_string();
        dirs_to_merge.push((from_dir.clone(), to, count));
    }

    Ok((planned_moves, planned_conflicts, dirs_to_merge, root_moves, uncategorized, garbage_dirs))
}

/// 仅扫前 60 行，从 `updated:` 行抓 timestamp。
fn read_updated_field(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for (i, line) in content.lines().enumerate() {
        if i > 60 {
            break;
        }
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("updated:") {
            return Some(rest.trim().trim_matches('"').to_string());
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────────────────────────────────────

fn execute_move(project: &Path, src_rel: &str, dst_rel: &str) -> Result<(), String> {
    let src = project.join(src_rel);
    let dst = project.join(dst_rel);
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("WRITE_FAILED 创建目标目录失败: {}", e))?;
    }
    fs::rename(&src, &dst).or_else(|_e| {
        // 跨设备 rename 失败 → fallback copy + delete
        fs::copy(&src, &dst).map_err(|e| format!("WRITE_FAILED 复制失败: {}", e))?;
        fs::remove_file(&src).map_err(|e| format!("WRITE_FAILED 删除原文件失败: {}", e))?;
        Ok::<(), String>(())
    })?;
    Ok(())
}

fn archive_loser(project: &Path, loser_src_rel: &str, archive_rel: &str) -> Result<(), String> {
    let src = project.join(loser_src_rel);
    let dst = project.join(archive_rel);
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("WRITE_FAILED 创建 .conflicts/ 失败: {}", e))?;
    }
    fs::rename(&src, &dst).or_else(|_| {
        fs::copy(&src, &dst).map_err(|e| format!("WRITE_FAILED 复制失败: {}", e))?;
        fs::remove_file(&src).map_err(|e| format!("WRITE_FAILED 删除失败: {}", e))?;
        Ok::<(), String>(())
    })?;
    Ok(())
}

fn archive_garbage_dir(project: &Path, garbage_dir_rel: &str) -> Result<(), String> {
    let src = project.join(garbage_dir_rel);
    if !src.is_dir() {
        return Ok(());
    }
    let basename = Path::new(garbage_dir_rel)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("garbage");
    let archive_dir = project.join(format!("wiki/.conflicts/garbage-{}", sanitize_filename(basename)));
    fs::create_dir_all(&archive_dir)
        .map_err(|e| format!("WRITE_FAILED 创建归档目录失败: {}", e))?;

    for entry in WalkDir::new(&src).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(&src).map_err(|_| "PATH 错误".to_string())?;
        let dst = archive_dir.join(rel);
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p).ok();
        }
        fs::rename(entry.path(), &dst).or_else(|_| {
            fs::copy(entry.path(), &dst).map_err(|e| format!("WRITE_FAILED: {}", e))?;
            fs::remove_file(entry.path()).map_err(|e| format!("WRITE_FAILED: {}", e))?;
            Ok::<(), String>(())
        })?;
    }
    // 删除原垃圾目录（递归 remove_dir_all 防止剩 .ds_store 等）
    fs::remove_dir_all(&src).ok();
    Ok(())
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if "/\\:*?\"<>|[]".contains(c) { '_' } else { c })
        .collect()
}

fn cleanup_empty_dirs(project: &Path, wiki_dir: &Path, report: &mut NormalizeReport) {
    let alias_set: std::collections::HashSet<&str> = DIR_ALIASES.iter().map(|(k, _)| *k).collect();
    let canonical: std::collections::HashSet<&str> = CANONICAL_DIRS.iter().copied().collect();

    if let Ok(read) = fs::read_dir(wiki_dir) {
        for entry in read.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if name.starts_with('.') {
                continue;
            }
            // 只清散乱目录的空壳；canonical 留着即使空
            let _ = &canonical;
            if !alias_set.contains(name.as_str()) {
                continue;
            }
            // 递归判断目录是否为空（无 .md 文件）
            let any_md = WalkDir::new(&p)
                .into_iter()
                .filter_map(|e| e.ok())
                .any(|e| e.file_type().is_file() && e.path().extension().and_then(|s| s.to_str()) == Some("md"));
            if !any_md {
                if fs::remove_dir_all(&p).is_ok() {
                    let rel = p.strip_prefix(project).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                    report.dirs_removed.push(rel);
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wikilink 替换
// ─────────────────────────────────────────────────────────────────────────────

fn replace_wikilinks_globally(
    project: &Path,
    wiki_dir: &Path,
    report: &mut NormalizeReport,
) -> (usize, usize) {
    let alias_map: HashMap<&str, &str> = DIR_ALIASES.iter().copied().collect();
    let mut files_changed = 0usize;
    let mut total = 0usize;

    for entry in WalkDir::new(wiki_dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let rel = match p.strip_prefix(project) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        // 排除 .conflicts/ / backups/ / .llm-wiki/
        if rel.contains("/.conflicts/") || rel.contains("/backups/") || rel.starts_with(".llm-wiki/") {
            continue;
        }

        let content = match fs::read_to_string(p) {
            Ok(c) => c,
            Err(e) => {
                report.errors.push((rel.clone(), format!("READ {}", e)));
                continue;
            }
        };

        let (new_content, count) = replace_in_content(&content, &alias_map);
        if count > 0 {
            if let Err(e) = fs::write(p, &new_content) {
                report.errors.push((rel.clone(), format!("WRITE {}", e)));
                continue;
            }
            files_changed += 1;
            total += count;
        }
    }

    (files_changed, total)
}

/// 替换规则：
/// - frontmatter 区段（开头 ```yaml ... 直到第二个 ``` ）— 全段替换 wikilink
/// - body — 按 ``` toggle in_code_block，仅 in_code_block=false 时替换
fn replace_in_content(content: &str, alias_map: &HashMap<&str, &str>) -> (String, usize) {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return (content.to_string(), 0);
    }

    let mut output = String::with_capacity(content.len());
    let mut count = 0usize;
    let mut i = 0;

    // 处理 frontmatter wrapper
    if lines[0].trim_start() == "```yaml" {
        // 找到匹配的关闭 ```
        let mut close_idx = None;
        for j in 1..lines.len() {
            if lines[j].trim_start() == "```" {
                close_idx = Some(j);
                break;
            }
        }
        if let Some(end) = close_idx {
            // [0..=end] 全段替换
            for k in 0..=end {
                let (replaced, c) = replace_line(lines[k], alias_map);
                count += c;
                output.push_str(&replaced);
                output.push('\n');
            }
            i = end + 1;
        }
    }

    // body：按 ``` toggle
    let mut in_code = false;
    while i < lines.len() {
        let line = lines[i];
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            output.push_str(line);
            output.push('\n');
            i += 1;
            continue;
        }
        if in_code {
            output.push_str(line);
            output.push('\n');
            i += 1;
            continue;
        }
        let (replaced, c) = replace_line(line, alias_map);
        count += c;
        output.push_str(&replaced);
        output.push('\n');
        i += 1;
    }

    // 保留原文件结尾换行符状态
    let final_str = if !content.ends_with('\n') && output.ends_with('\n') {
        output[..output.len() - 1].to_string()
    } else {
        output
    };

    (final_str, count)
}

fn replace_line(line: &str, alias_map: &HashMap<&str, &str>) -> (String, usize) {
    if !line.contains("[[") {
        return (line.to_string(), 0);
    }
    let bytes = line.as_bytes();
    let mut result = String::with_capacity(line.len());
    let mut count = 0usize;
    let mut cursor = 0usize; // byte index

    while cursor < bytes.len() {
        // 找下一个 "[["
        let rest = &line[cursor..];
        match rest.find("[[") {
            None => {
                result.push_str(rest);
                break;
            }
            Some(rel_open) => {
                let open_abs = cursor + rel_open;
                // push 前缀
                result.push_str(&line[cursor..open_abs]);
                // 找匹配的 "]]"（从 open_abs+2 起）
                let after_open = open_abs + 2;
                let close_search = &line[after_open..];
                match close_search.find("]]") {
                    None => {
                        // 没匹配，push 余下原样
                        result.push_str(&line[open_abs..]);
                        break;
                    }
                    Some(rel_close) => {
                        let close_abs = after_open + rel_close;
                        let inner = &line[after_open..close_abs];
                        let (target, display_part) = match inner.find('|') {
                            Some(p) => (&inner[..p], &inner[p..]),
                            None => (inner, ""),
                        };
                        let mut replaced = false;
                        if let Some(slash) = target.find('/') {
                            let type_part = &target[..slash];
                            let rest_target = &target[slash..];
                            if let Some(&new_type) = alias_map.get(type_part) {
                                result.push_str("[[");
                                result.push_str(new_type);
                                result.push_str(rest_target);
                                result.push_str(display_part);
                                result.push_str("]]");
                                count += 1;
                                replaced = true;
                            }
                        }
                        if !replaced {
                            result.push_str(&line[open_abs..close_abs + 2]);
                        }
                        cursor = close_abs + 2;
                    }
                }
            }
        }
    }
    (result, count)
}

// ─────────────────────────────────────────────────────────────────────────────
// 备份
// ─────────────────────────────────────────────────────────────────────────────

fn create_backup_zip(source_dir: &Path, target_zip: &Path) -> Result<usize, String> {
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
        // 排除 .conflicts/ 和 backups/
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_alias_map() -> HashMap<&'static str, &'static str> {
        DIR_ALIASES.iter().copied().collect()
    }

    #[test]
    fn replaces_wikilink_outside_code_block() {
        let alias = make_alias_map();
        let line = "见 [[进化/交易史]] 和 [[市场模式/X]]";
        let (out, c) = replace_line(line, &alias);
        assert_eq!(c, 2);
        assert_eq!(out, "见 [[模式/交易史]] 和 [[模式/X]]");
    }

    #[test]
    fn preserves_display_alias() {
        let alias = make_alias_map();
        let line = "[[进化/交易史|交易进化史]]";
        let (out, _) = replace_line(line, &alias);
        assert_eq!(out, "[[模式/交易史|交易进化史]]");
    }

    #[test]
    fn skips_non_aliased_type() {
        let alias = make_alias_map();
        let line = "[[股票/万泽股份]]";
        let (out, c) = replace_line(line, &alias);
        assert_eq!(c, 0);
        assert_eq!(out, line);
    }

    #[test]
    fn does_not_replace_inside_code_block() {
        let alias = make_alias_map();
        let content = "before [[进化/X]]\n```python\nrefer to [[进化/X]]\n```\nafter [[进化/Y]]";
        let (out, count) = replace_in_content(content, &alias);
        assert_eq!(count, 2);
        assert!(out.contains("before [[模式/X]]"));
        assert!(out.contains("refer to [[进化/X]]")); // 未改
        assert!(out.contains("after [[模式/Y]]"));
    }

    #[test]
    fn replaces_inside_yaml_wrapper() {
        let alias = make_alias_map();
        let content = "```yaml\n---\ntitle: X\nrelated:\n  - \"[[进化/A]]\"\n---\n```\n# Body\n[[进化/B]]";
        let (out, count) = replace_in_content(content, &alias);
        assert_eq!(count, 2);
        assert!(out.contains("[[模式/A]]"));
        assert!(out.contains("[[模式/B]]"));
    }

    #[test]
    fn wikilink_with_chinese_name() {
        let alias = make_alias_map();
        let line = "[[市场模式/液冷产业双拐点]]";
        let (out, c) = replace_line(line, &alias);
        assert_eq!(c, 1);
        assert_eq!(out, "[[模式/液冷产业双拐点]]");
    }
}
