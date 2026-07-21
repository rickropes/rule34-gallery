use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRecord {
    pub id: i64,
    pub hash: String,
    pub original_filename: Option<String>,
    pub stored_filename: String,
    pub extension: String,
    pub media_type: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub filesize: i64,
    pub favorite: bool,
    pub added_at: String,
    pub file_path: String,
    pub source_url: Option<String>,
    pub is_animated_gif: bool,
    pub collection_id: Option<i64>,
    pub collection_page_count: i64
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPage {
    pub items: Vec<MediaRecord>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMediaResult {
    pub imported_count: usize,
    pub skipped_count: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub id: i64,
    pub name: String,
    pub category: String,
}