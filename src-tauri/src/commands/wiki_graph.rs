use std::collections::HashSet;
use std::fs::File;
use std::io::Read as IoRead;

use serde::Serialize;

use crate::path_guard;

const FRONTMATTER_LIMIT: usize = 32 * 1024;
const SCAN_CHUNK: usize = 64 * 1024;
const CHUNK_OVERLAP: usize = 256;

#[derive(Debug, Serialize)]
pub struct WikiGraphNodeScan {
    pub title: String,
    #[serde(rename = "type")]
    pub doc_type: String,
    pub sources: Vec<String>,
    pub wikilinks: Vec<String>,
}

/// Stream-scan a markdown wiki page for graph metadata without loading the full file into JS.
#[tauri::command]
pub fn scan_wiki_graph_node(path: String) -> Result<WikiGraphNodeScan, String> {
    let p = path_guard::assert_readable(&path)?;
    path_guard::check_read_size(&p)?;

    let mut file = File::open(&p)
        .map_err(|e| format!("Failed to open file '{}': {}", p.display(), e))?;

    let mut head = vec![0u8; FRONTMATTER_LIMIT];
    let head_n = file
        .read(&mut head)
        .map_err(|e| format!("Failed to read file '{}': {}", p.display(), e))?;
    let head_str = String::from_utf8_lossy(&head[..head_n]);
    let (title, doc_type, sources) = parse_frontmatter(&head_str);

    let mut links = HashSet::new();
    extract_wikilinks_from_text(&head_str, &mut links);

    let mut carry: Vec<u8> = head[head_n.saturating_sub(CHUNK_OVERLAP)..head_n].to_vec();
    let mut buf = vec![0u8; SCAN_CHUNK];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read file '{}': {}", p.display(), e))?;
        if n == 0 {
            break;
        }
        let mut combined = carry;
        combined.extend_from_slice(&buf[..n]);
        let combined_str = String::from_utf8_lossy(&combined);
        extract_wikilinks_from_text(&combined_str, &mut links);
        carry = combined[combined.len().saturating_sub(CHUNK_OVERLAP)..].to_vec();
    }

    Ok(WikiGraphNodeScan {
        title,
        doc_type,
        sources,
        wikilinks: links.into_iter().collect(),
    })
}

fn parse_frontmatter(content: &str) -> (String, String, Vec<String>) {
    let fm = match content.strip_prefix("---\n") {
        Some(rest) => match rest.find("\n---") {
            Some(end) => &rest[..end],
            None => "",
        },
        None => "",
    };

    let mut title = extract_yaml_scalar(fm, "title").unwrap_or_default();
    if title.is_empty() {
        title = extract_heading_title(content).unwrap_or_default();
    }
    let doc_type = extract_yaml_scalar(fm, "type")
        .unwrap_or_else(|| "other".to_string())
        .to_lowercase();
    let sources = parse_sources(fm);

    (title, doc_type, sources)
}

fn body_after_frontmatter(content: &str) -> &str {
    match content.strip_prefix("---\n") {
        Some(rest) => rest
            .find("\n---")
            .map(|end| {
                let after = &rest[end..];
                after.strip_prefix("\n---").unwrap_or(after).trim_start_matches('\n')
            })
            .unwrap_or(rest),
        None => content,
    }
}

/// First ATX h1 (`# title`) in the body, matching legacy TS graph parsing.
fn extract_heading_title(content: &str) -> Option<String> {
    for line in body_after_frontmatter(content).lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix('#') else {
            continue;
        };
        if rest.starts_with('#') {
            continue;
        }
        let title = rest.trim();
        if !title.is_empty() {
            return Some(title.to_string());
        }
    }
    None
}

fn extract_yaml_scalar(fm: &str, key: &str) -> Option<String> {
    let pattern = format!("{key}:");
    for line in fm.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(&pattern) {
            let mut value = rest.trim();
            if (value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\''))
            {
                value = &value[1..value.len() - 1];
            }
            return Some(value.to_string());
        }
    }
    None
}

fn parse_sources(fm: &str) -> Vec<String> {
    let mut sources = Vec::new();
    let mut in_block = false;

    for line in fm.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("sources:") {
            let inline = trimmed.strip_prefix("sources:").unwrap_or("").trim();
            if inline.starts_with('[') {
                let inner = inline
                    .trim_start_matches('[')
                    .trim_end_matches(']');
                for item in inner.split(',') {
                    let value = item.trim().trim_matches(|c| c == '"' || c == '\'');
                    if !value.is_empty() {
                        sources.push(value.to_string());
                    }
                }
                return sources;
            }
            in_block = true;
            continue;
        }
        if in_block {
            if let Some(item) = trimmed.strip_prefix("- ") {
                let value = item.trim().trim_matches(|c| c == '"' || c == '\'');
                if !value.is_empty() {
                    sources.push(value.to_string());
                }
            } else if !trimmed.is_empty() {
                break;
            }
        }
    }

    sources
}

fn extract_wikilinks_from_text(text: &str, out: &mut HashSet<String>) {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i + 2 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            i += 2;
            let start = i;
            while i < bytes.len() {
                if bytes[i] == b']' && i + 1 < bytes.len() && bytes[i + 1] == b']' {
                    let raw = &text[start..i];
                    let target = raw.split('|').next().unwrap_or(raw).trim();
                    if !target.is_empty() {
                        out.insert(target.to_string());
                    }
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else {
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_wikilinks_across_long_body() {
        let padding = "x".repeat(100_000);
        let content = format!(
            "---\ntitle: Test\ntype: concept\n---\n\n{padding}\n\nSee [[Target Page]] for more.\n"
        );
        let path = std::env::temp_dir().join(format!(
            "wiki-graph-scan-test-{}.md",
            std::process::id()
        ));
        std::fs::write(&path, &content).unwrap();

        let mut links = HashSet::new();
        let mut file = File::open(&path).unwrap();
        let mut head = vec![0u8; FRONTMATTER_LIMIT];
        let head_n = file.read(&mut head).unwrap();
        extract_wikilinks_from_text(&String::from_utf8_lossy(&head[..head_n]), &mut links);

        let mut carry = head[head_n.saturating_sub(CHUNK_OVERLAP)..head_n].to_vec();
        let mut buf = vec![0u8; SCAN_CHUNK];
        loop {
            let n = file.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            let mut combined = carry;
            combined.extend_from_slice(&buf[..n]);
            extract_wikilinks_from_text(&String::from_utf8_lossy(&combined), &mut links);
            carry = combined[combined.len().saturating_sub(CHUNK_OVERLAP)..].to_vec();
        }

        assert!(links.contains("Target Page"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn parses_frontmatter_sources() {
        let fm = "title: Hello\ntype: Entity\nsources:\n  - a.pdf\n  - b.pdf";
        let (title, doc_type, sources) = parse_frontmatter(&format!("---\n{fm}\n---\n"));
        assert_eq!(title, "Hello");
        assert_eq!(doc_type, "entity");
        assert_eq!(sources, vec!["a.pdf", "b.pdf"]);
    }

    #[test]
    fn falls_back_to_first_heading_when_title_missing() {
        let content = "---\ntype: concept\n---\n\n# My Heading\n\nBody text.\n";
        let (title, doc_type, _) = parse_frontmatter(content);
        assert_eq!(title, "My Heading");
        assert_eq!(doc_type, "concept");
    }

    #[test]
    fn frontmatter_title_takes_precedence_over_heading() {
        let content = "---\ntitle: From FM\ntype: entity\n---\n\n# Ignored Heading\n";
        let (title, _, _) = parse_frontmatter(content);
        assert_eq!(title, "From FM");
    }

    #[test]
    fn ignores_h2_for_heading_fallback() {
        let content = "---\ntype: query\n---\n\n## Not H1\n\n# Real Title\n";
        let (title, _, _) = parse_frontmatter(content);
        assert_eq!(title, "Real Title");
    }
}
