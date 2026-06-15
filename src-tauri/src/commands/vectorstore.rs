use lancedb::query::{ExecutableQuery, QueryBase};
use arrow_array::{Float32Array, RecordBatch, StringArray, FixedSizeListArray, ArrayRef};
use arrow_schema::{DataType, Field, Schema};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::path_guard;
use crate::vector_db;

/// Result from vector search
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VectorSearchResult {
    pub page_id: String,
    pub score: f32,
}

/// Safe maintenance stats for the LanceDB vector store.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VectorStoreStats {
    pub db_path: String,
    pub table_exists: bool,
    pub row_count: usize,
    pub db_bytes: u64,
    pub data_bytes: u64,
    pub versions_bytes: u64,
    pub transactions_bytes: u64,
    pub error: Option<String>,
}

fn db_path(project_path: &str) -> String {
    format!("{}/.llm-wiki/lancedb", project_path.replace('\\', "/"))
}

const TABLE_NAME: &str = "wiki_vectors";

fn table_path(project_path: &str) -> PathBuf {
    Path::new(&db_path(project_path)).join(format!("{}.lance", TABLE_NAME))
}

fn dir_size_bytes(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.is_file() {
        return metadata.len();
    }
    if !metadata.is_dir() {
        return 0;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| dir_size_bytes(&entry.path()))
        .sum()
}

/// Validate page_id to prevent filter injection
fn validate_page_id(page_id: &str) -> Result<(), String> {
    if page_id.is_empty() || page_id.len() > 256 {
        return Err("Invalid page_id: empty or too long".to_string());
    }
    // Only allow alphanumeric, hyphens, underscores, dots
    if !page_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err(format!("Invalid page_id: contains disallowed characters: {}", page_id));
    }
    Ok(())
}

fn make_schema(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("page_id", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                dim,
            ),
            false,
        ),
    ]))
}

fn make_batch(schema: Arc<Schema>, page_id: &str, embedding: Vec<f32>, dim: i32) -> Result<RecordBatch, String> {
    let ids: ArrayRef = Arc::new(StringArray::from(vec![page_id]));
    let values = Float32Array::from(embedding);
    let vector: ArrayRef = Arc::new(
        FixedSizeListArray::new(
            Arc::new(Field::new("item", DataType::Float32, true)),
            dim,
            Arc::new(values),
            None,
        )
    );
    RecordBatch::try_new(schema, vec![ids, vector])
        .map_err(|e| format!("Batch error: {e}"))
}

/// Upsert a page embedding into LanceDB
#[tauri::command]
pub async fn vector_upsert(
    project_path: String,
    page_id: String,
    embedding: Vec<f32>,
) -> Result<(), String> {
    validate_page_id(&page_id)?;
    path_guard::assert_readable(&project_path)?;

    let db = vector_db::get_connection(&project_path).await?;

    let dim = embedding.len() as i32;
    let schema = make_schema(dim);
    let batch = make_batch(schema.clone(), &page_id, embedding, dim)?;
    let data = vec![batch];

    let tables = db.table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if tables.contains(&TABLE_NAME.to_string()) {
        let table = db.open_table(TABLE_NAME)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        // Delete existing entry then add new one
        if let Err(e) = table.delete(&format!("page_id = '{}'", page_id)).await {
            eprintln!("[vectorstore] Warning: delete before upsert failed for '{}': {}", page_id, e);
        }

        table.add(data)
            .execute()
            .await
            .map_err(|e| format!("Add error: {e}"))?;
    } else {
        db.create_table(TABLE_NAME, data)
            .execute()
            .await
            .map_err(|e| format!("Create table error: {e}"))?;
    }

    Ok(())
}

/// Search for similar pages by embedding vector
#[tauri::command]
pub async fn vector_search(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<VectorSearchResult>, String> {
    path_guard::assert_readable(&project_path)?;
    let db = vector_db::get_connection(&project_path).await?;

    let tables = db.table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_NAME.to_string()) {
        return Ok(vec![]);
    }

    let table = db.open_table(TABLE_NAME)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    let results_stream = table
        .vector_search(query_embedding)
        .map_err(|e| format!("Search error: {e}"))?
        .limit(top_k)
        .execute()
        .await
        .map_err(|e| format!("Execute search error: {e}"))?;

    let mut search_results = Vec::new();

    use futures::TryStreamExt;
    let batches: Vec<RecordBatch> = results_stream
        .try_collect()
        .await
        .map_err(|e| format!("Collect error: {e}"))?;

    for batch in &batches {
        let ids = batch
            .column_by_name("page_id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing page_id column")?;

        let distances = batch
            .column_by_name("_distance")
            .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
            .ok_or("Missing _distance column")?;

        for i in 0..batch.num_rows() {
            let page_id = ids.value(i).to_string();
            let distance = distances.value(i);
            let score = 1.0 / (1.0 + distance);
            search_results.push(VectorSearchResult { page_id, score });
        }
    }

    Ok(search_results)
}

/// Delete a page from the vector index
#[tauri::command]
pub async fn vector_delete(
    project_path: String,
    page_id: String,
) -> Result<(), String> {
    validate_page_id(&page_id)?;
    path_guard::assert_readable(&project_path)?;

    let db = vector_db::get_connection(&project_path).await?;

    let tables = db.table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_NAME.to_string()) {
        return Ok(());
    }

    let table = db.open_table(TABLE_NAME)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    table.delete(&format!("page_id = '{}'", page_id))
        .await
        .map_err(|e| format!("Delete error: {e}"))?;

    Ok(())
}

/// Get count of indexed vectors
#[tauri::command]
pub async fn vector_count(
    project_path: String,
) -> Result<usize, String> {
    path_guard::assert_readable(&project_path)?;
    let db = vector_db::get_connection(&project_path).await?;

    let tables = db.table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_NAME.to_string()) {
        return Ok(0);
    }

    let table = db.open_table(TABLE_NAME)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    let count = table.count_rows(None)
        .await
        .map_err(|e| format!("Count error: {e}"))?;

    Ok(count)
}

/// Audit vector store size and row count before maintenance.
#[tauri::command]
pub async fn vector_stats(
    project_path: String,
) -> Result<VectorStoreStats, String> {
    path_guard::assert_readable(&project_path)?;
    let db_path_string = db_path(&project_path);
    let db_root = Path::new(&db_path_string);
    let table_root = table_path(&project_path);
    let mut stats = VectorStoreStats {
        db_path: db_path_string.clone(),
        table_exists: table_root.exists(),
        row_count: 0,
        db_bytes: dir_size_bytes(db_root),
        data_bytes: dir_size_bytes(&table_root.join("data")),
        versions_bytes: dir_size_bytes(&table_root.join("_versions")),
        transactions_bytes: dir_size_bytes(&table_root.join("_transactions")),
        error: None,
    };

    if !db_root.exists() {
        return Ok(stats);
    }

    match vector_db::get_connection(&project_path).await {
        Ok(db) => match db.table_names().execute().await {
            Ok(tables) => {
                stats.table_exists = tables.contains(&TABLE_NAME.to_string());
                if stats.table_exists {
                    match db.open_table(TABLE_NAME).execute().await {
                        Ok(table) => match table.count_rows(None).await {
                            Ok(count) => stats.row_count = count,
                            Err(e) => stats.error = Some(format!("Count error: {e}")),
                        },
                        Err(e) => stats.error = Some(format!("Open table error: {e}")),
                    }
                }
            }
            Err(e) => stats.error = Some(format!("List tables error: {e}")),
        },
        Err(e) => stats.error = Some(format!("DB connect error: {e}")),
    }

    Ok(stats)
}

/// Clear the rebuildable LanceDB vector store.
#[tauri::command]
pub async fn vector_clear(
    project_path: String,
) -> Result<(), String> {
    path_guard::assert_writable(&project_path)?;
    let db_path_string = db_path(&project_path);
    let db_root = Path::new(&db_path_string);
    if !db_root.exists() {
        return Ok(());
    }
    fs::remove_dir_all(db_root)
        .map_err(|e| format!("Failed to clear vector store '{}': {e}", db_path_string))?;
    vector_db::invalidate_connection(&project_path);
    Ok(())
}
