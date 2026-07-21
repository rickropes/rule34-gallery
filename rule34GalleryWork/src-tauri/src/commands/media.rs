use crate::{models::media::{ImportMediaResult, MediaPage, MediaRecord, TagRecord}, state::AppState};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{fs, fs::File, io::{BufReader, Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, time::{SystemTime, UNIX_EPOCH}};

struct CopiedMedia {
    hash: String,
    original_filename: String,
    stored_filename: String,
    extension: String,
    media_type: String,
    width: Option<i64>,
    height: Option<i64>,
    filesize: i64,
}

fn calculate_sha256(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buffer).map_err(|e| format!("Failed to read file: {e}"))?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn classify_extension(ext: &str) -> Option<&'static str> {
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" => Some("image"),
        "mp4" | "webm" | "mov" | "m4v" => Some("video"),
        _ => None,
    }
}

fn media_directory(root: &Path, media_type: &str) -> PathBuf {
    root.join("media").join(if media_type == "video" { "videos" } else { "images" })
}

#[tauri::command]
pub fn list_media(
    search: Option<String>,
    added_from: Option<String>,
    added_to: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> Result<MediaPage, String> {
    let library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_ref().ok_or_else(|| "No library is currently open.".to_string())?;
    let root = state.library_path.lock().map_err(|_| "Failed to access the library path.".to_string())?
        .clone().ok_or_else(|| "No library is currently open.".to_string())?;

    let page_offset = offset.unwrap_or(0);
    let page_limit = limit.unwrap_or(80).clamp(1, 250);
    let terms = parse_search_terms(&search.unwrap_or_default());
    let mut statement = connection.prepare(r#"
        SELECT m.id,m.hash,m.original_filename,m.stored_filename,m.extension,m.media_type,
               m.width,m.height,m.filesize,m.favorite,m.added_at,
               (SELECT s.url FROM sources s WHERE s.media_id=m.id ORDER BY s.id DESC LIMIT 1) AS source_url,
               EXISTS(
                 SELECT 1 FROM media_tags mt
                 INNER JOIN tags t ON t.id=mt.tag_id
                 WHERE mt.media_id=m.id
                   AND lower(t.category)='metadata'
                   AND lower(t.name) IN ('gif','animated_gif')
               ) AS is_animated_gif,
               (SELECT cp.collection_id FROM collection_pages cp WHERE cp.media_id=m.id LIMIT 1) AS collection_id,
               COALESCE((SELECT COUNT(*) FROM collection_pages cp2 WHERE cp2.collection_id=(SELECT cp3.collection_id FROM collection_pages cp3 WHERE cp3.media_id=m.id LIMIT 1)),0) AS collection_page_count
        FROM media m
        WHERE NOT EXISTS (
          SELECT 1 FROM collection_pages hidden_cp
          INNER JOIN collections hidden_c ON hidden_c.id=hidden_cp.collection_id
          WHERE hidden_cp.media_id=m.id AND hidden_c.cover_media_id<>m.id
        )
        ORDER BY m.added_at DESC,m.id DESC
    "#).map_err(|e| format!("Failed to prepare media query: {e}"))?;
    let rows = statement.query_map([], |row| {
        let media_type: String = row.get(5)?;
        let stored_filename: String = row.get(3)?;
        Ok(MediaRecord {
            id: row.get(0)?, hash: row.get(1)?, original_filename: row.get(2)?, stored_filename: stored_filename.clone(),
            extension: row.get(4)?, media_type: media_type.clone(), width: row.get(6)?, height: row.get(7)?,
            filesize: row.get(8)?, favorite: row.get::<_, i64>(9)? != 0, added_at: row.get(10)?,
            file_path: media_directory(&root, &media_type).join(stored_filename).to_string_lossy().into_owned(),
            source_url: row.get(11)?, is_animated_gif: row.get::<_, i64>(12)? != 0,
            collection_id: row.get(13)?, collection_page_count: row.get(14)?,
        })
    }).map_err(|e| format!("Failed to query media: {e}"))?;

    let mut items = Vec::with_capacity(page_limit);
    let mut total = 0usize;
    for row in rows {
        let record = row.map_err(|e| format!("Failed to read media row: {e}"))?;
        let after_start = added_from.as_deref().map(|value| record.added_at.as_str() >= value).unwrap_or(true);
        let before_end = added_to.as_deref().map(|value| record.added_at.as_str() <= value).unwrap_or(true);
        if after_start && before_end && (terms.is_empty() || media_matches(connection, &record, &terms)?) {
            if total >= page_offset && items.len() < page_limit { items.push(record); }
            total += 1;
        }
    }
    Ok(MediaPage { items, total, offset: page_offset, limit: page_limit })
}

#[derive(Debug)]
struct SearchTerm {
    value: String,
    exact: bool,
    negated: bool,
}

fn parse_search_terms(input: &str) -> Vec<SearchTerm> {
    let mut terms = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut exact = false;
    let mut escaped = false;
    let mut negated = false;

    for ch in input.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if quoted && ch == '\\' {
            escaped = true;
            continue;
        }
        if current.is_empty() && !quoted && ch == '-' {
            negated = true;
            continue;
        }
        if ch == '"' {
            quoted = !quoted;
            exact = true;
            continue;
        }
        if ch.is_whitespace() && !quoted {
            let value = current.trim().to_lowercase();
            if !value.is_empty() {
                terms.push(SearchTerm { value, exact, negated });
            }
            current.clear();
            exact = false;
            negated = false;
        } else {
            current.push(ch);
        }
    }

    let value = current.trim().to_lowercase();
    if !value.is_empty() {
        terms.push(SearchTerm { value, exact, negated });
    }
    terms
}

fn media_matches(connection: &rusqlite::Connection, media: &MediaRecord, terms: &[SearchTerm]) -> Result<bool, String> {
    let mut stmt = connection.prepare("SELECT lower(category), lower(name) FROM tags t INNER JOIN media_tags mt ON mt.tag_id=t.id WHERE mt.media_id=?1")
        .map_err(|e| format!("Failed to prepare search: {e}"))?;
    let tags = stmt.query_map([media.id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| format!("Failed to search tags: {e}"))?
        .collect::<Result<Vec<_>, _>>().map_err(|e| format!("Failed to read tags: {e}"))?;

    Ok(terms.iter().all(|term| {
        let matched = if let Some(value) = term.value.strip_prefix("bigsize:") {
            let Ok(minimum) = value.parse::<i64>() else { return false; };
            media.media_type == "image"
                && media.width.unwrap_or(0).max(media.height.unwrap_or(0)) > minimum
        } else {
            let (cat, name) = term.value.split_once(':').unwrap_or(("", term.value.as_str()));
            tags.iter().any(|(tag_category, tag_name)| {
                if term.exact {
                    if cat.is_empty() {
                        tag_name == name || tag_category == name
                    } else {
                        tag_category == cat && tag_name == name
                    }
                } else if cat.is_empty() {
                    tag_name.contains(name) || tag_category.contains(name)
                } else {
                    tag_category.contains(cat) && tag_name.contains(name)
                }
            })
        };
        if term.negated { !matched } else { matched }
    }))
}

#[tauri::command]
pub fn list_search_suggestions(query: Option<String>, state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_ref().ok_or_else(|| "No library is currently open.".to_string())?;
    let needle = query.unwrap_or_default().trim().trim_start_matches('-').trim_matches('"').to_lowercase();
    let like = format!("%{}%", needle);
    let mut suggestions = Vec::new();

    let mut category_stmt = connection.prepare(
        "SELECT DISTINCT category FROM tags WHERE lower(category) LIKE ?1 ORDER BY category COLLATE NOCASE LIMIT 12"
    ).map_err(|e| e.to_string())?;
    for row in category_stmt.query_map([&like], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())? {
        suggestions.push(row.map_err(|e| e.to_string())?);
    }

    let mut tag_stmt = connection.prepare(
        "SELECT category || ':' || name FROM tags WHERE lower(category || ':' || name) LIKE ?1 ORDER BY category COLLATE NOCASE,name COLLATE NOCASE LIMIT 24"
    ).map_err(|e| e.to_string())?;
    for row in tag_stmt.query_map([&like], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())? {
        let value = row.map_err(|e| e.to_string())?;
        if !suggestions.iter().any(|existing| existing.eq_ignore_ascii_case(&value)) {
            suggestions.push(value);
        }
        if suggestions.len() >= 24 { break; }
    }
    Ok(suggestions)
}

#[tauri::command]
pub fn list_media_tags(media_id: i64, state: tauri::State<'_, AppState>) -> Result<Vec<TagRecord>, String> {
    let library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_ref().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut stmt = connection.prepare("SELECT t.id,t.name,t.category FROM tags t INNER JOIN media_tags mt ON mt.tag_id=t.id WHERE mt.media_id=?1 ORDER BY t.category COLLATE NOCASE,t.name COLLATE NOCASE")
        .map_err(|e| format!("Failed to prepare tag query: {e}"))?;
    let rows = stmt
        .query_map([media_id], |r| Ok(TagRecord { id: r.get(0)?, name: r.get(1)?, category: r.get(2)? }))
        .map_err(|e| format!("Failed to query tags: {e}"))?;
    let tags = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read tags: {e}"))?;
    Ok(tags)
}

#[tauri::command]
pub fn list_tag_categories(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_ref().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut stmt = connection.prepare("SELECT DISTINCT category FROM tags ORDER BY category COLLATE NOCASE").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
    let categories = rows
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(categories)
}

#[tauri::command]
pub fn list_tags_for_category(category: String, state: tauri::State<'_, AppState>) -> Result<Vec<TagRecord>, String> {
    let library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_ref().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut stmt = connection.prepare("SELECT id,name,category FROM tags WHERE category=?1 COLLATE NOCASE ORDER BY name COLLATE NOCASE").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([category.trim()], |r| Ok(TagRecord { id: r.get(0)?, name: r.get(1)?, category: r.get(2)? }))
        .map_err(|e| e.to_string())?;
    let tags = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(tags)
}

#[tauri::command]
pub fn add_media_tag(media_id: i64, tag_name: String, category: Option<String>, state: tauri::State<'_, AppState>) -> Result<TagRecord, String> {
    let name = tag_name.trim();
    let cat = category.as_deref().unwrap_or("").trim();
    if name.is_empty() || cat.is_empty() { return Err("Category and tag name are required.".to_string()); }
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "No library is currently open.".to_string())?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO tags(name,category) VALUES(?1,?2) ON CONFLICT(name,category) DO NOTHING", params![name,cat]).map_err(|e| e.to_string())?;
    let id:i64 = tx.query_row("SELECT id FROM tags WHERE name=?1 COLLATE NOCASE AND category=?2 COLLATE NOCASE", params![name,cat], |r| r.get(0)).map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO media_tags(media_id,tag_id) VALUES(?1,?2)", params![media_id,id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(TagRecord{id,name:name.to_string(),category:cat.to_string()})
}

#[tauri::command]
pub fn remove_media_tag(media_id: i64, tag_id: i64, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "No library is currently open.".to_string())?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM media_tags WHERE media_id=?1 AND tag_id=?2",
        params![media_id, tag_id],
    ).map_err(|e| e.to_string())?;

    // Remove the tag definition when no media item references it anymore.
    // Categories are stored directly on tags rather than in a separate table,
    // so a category automatically disappears from suggestions when its final tag is deleted.
    tx.execute(
        "DELETE FROM tags WHERE id=?1 AND NOT EXISTS (SELECT 1 FROM media_tags WHERE tag_id=?1)",
        [tag_id],
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}


#[tauri::command]
pub fn add_tag_to_media(media_ids: Vec<i64>, tag_name: String, category: Option<String>, state: tauri::State<'_, AppState>) -> Result<TagRecord, String> {
    let name = tag_name.trim();
    let cat = category.as_deref().unwrap_or("").trim();
    if media_ids.is_empty() { return Err("Select at least one media item.".to_string()); }
    if name.is_empty() || cat.is_empty() { return Err("Category and tag name are required.".to_string()); }
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "No library is currently open.".to_string())?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO tags(name,category) VALUES(?1,?2) ON CONFLICT(name,category) DO NOTHING", params![name,cat]).map_err(|e| e.to_string())?;
    let id:i64 = tx.query_row("SELECT id FROM tags WHERE name=?1 COLLATE NOCASE AND category=?2 COLLATE NOCASE", params![name,cat], |r| r.get(0)).map_err(|e| e.to_string())?;
    for media_id in media_ids { tx.execute("INSERT OR IGNORE INTO media_tags(media_id,tag_id) VALUES(?1,?2)", params![media_id,id]).map_err(|e| e.to_string())?; }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(TagRecord{id,name:name.to_string(),category:cat.to_string()})
}

#[tauri::command]
pub fn list_collection_pages(collection_id: i64, state: tauri::State<'_, AppState>) -> Result<Vec<MediaRecord>, String> {
    let library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_ref().ok_or_else(|| "No library is currently open.".to_string())?;
    let root = state.library_path.lock().map_err(|_| "Failed to access the library path.".to_string())?
        .clone().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut statement = connection.prepare(r#"
        SELECT m.id,m.hash,m.original_filename,m.stored_filename,m.extension,m.media_type,
               m.width,m.height,m.filesize,m.favorite,m.added_at,
               (SELECT s.url FROM sources s WHERE s.media_id=m.id ORDER BY s.id DESC LIMIT 1),
               EXISTS(SELECT 1 FROM media_tags mt INNER JOIN tags t ON t.id=mt.tag_id WHERE mt.media_id=m.id AND lower(t.category)='metadata' AND lower(t.name) IN ('gif','animated_gif')),
               cp.collection_id,
               (SELECT COUNT(*) FROM collection_pages total_cp WHERE total_cp.collection_id=cp.collection_id)
        FROM collection_pages cp INNER JOIN media m ON m.id=cp.media_id
        WHERE cp.collection_id=?1 ORDER BY cp.position
    "#).map_err(|e| e.to_string())?;
    let rows = statement.query_map([collection_id], |row| {
        let media_type:String=row.get(5)?; let stored_filename:String=row.get(3)?;
        Ok(MediaRecord{id:row.get(0)?,hash:row.get(1)?,original_filename:row.get(2)?,stored_filename:stored_filename.clone(),extension:row.get(4)?,media_type:media_type.clone(),width:row.get(6)?,height:row.get(7)?,filesize:row.get(8)?,favorite:row.get::<_,i64>(9)?!=0,added_at:row.get(10)?,file_path:media_directory(&root,&media_type).join(stored_filename).to_string_lossy().into_owned(),source_url:row.get(11)?,is_animated_gif:row.get::<_,i64>(12)?!=0,collection_id:row.get(13)?,collection_page_count:row.get(14)?})
    }).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
pub fn delete_media(media_ids: Vec<i64>, state: tauri::State<'_, AppState>) -> Result<usize, String> {
    if media_ids.is_empty() { return Ok(0); }
    let root = state.library_path.lock().map_err(|_| "Failed to access the library path.".to_string())?.clone().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "No library is currently open.".to_string())?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    let mut expanded_ids = media_ids.clone();
    for media_id in &media_ids {
        let collection_id: Option<i64> = tx.query_row("SELECT id FROM collections WHERE cover_media_id=?1", [media_id], |r| r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(collection_id)=collection_id {
            let mut stmt=tx.prepare("SELECT media_id FROM collection_pages WHERE collection_id=?1").map_err(|e|e.to_string())?;
            let ids=stmt.query_map([collection_id],|r|r.get::<_,i64>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
            expanded_ids.extend(ids);
        }
    }
    expanded_ids.sort_unstable(); expanded_ids.dedup();
    let mut files = Vec::new();
    for media_id in &expanded_ids {
        let item: Option<(String,String)> = tx.query_row("SELECT stored_filename,media_type FROM media WHERE id=?1", [media_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e| e.to_string())?;
        if let Some((stored,kind)) = item { files.push(media_directory(&root,&kind).join(stored)); }
        tx.execute("DELETE FROM media WHERE id=?1", [media_id]).map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM media_tags WHERE media_tags.tag_id=tags.id)", []).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    for file in files { if let Err(error)=fs::remove_file(&file) { if error.kind()!=std::io::ErrorKind::NotFound { return Err(format!("Media was removed from the gallery, but failed to delete {}: {error}",file.display())); } } }
    Ok(expanded_ids.len())
}



#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMediaResult {
    processed_count: usize,
    errors: Vec<String>,
}

fn run_ffmpeg(input: &Path, output: &Path, operation: &str, extension: &str) -> Result<(), String> {
    let mut command = Command::new("ffmpeg");
    command.arg("-y").arg("-hide_banner").arg("-loglevel").arg("error").arg("-i").arg(input);

    match operation {
        "half_size" | "quarter_size" => {
            let divisor = if operation == "quarter_size" { 8 } else { 4 };
            command.arg("-vf").arg(format!("scale=ceil(iw/{divisor})*2:ceil(ih/{divisor})*2"));
            match extension {
                "webm" => {
                    command.args(["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus"]);
                }
                "gif" => {}
                _ => {
                    command.args(["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-c:a", "aac", "-b:a", "128k"]);
                }
            }
        }
        "remove_audio" => {
            command.args(["-map", "0:v:0", "-c:v", "copy", "-an"]);
        }
        _ => return Err(format!("Unknown media operation: {operation}")),
    }

    let output_result = command.arg(output).stdout(Stdio::null()).stderr(Stdio::piped()).output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "ffmpeg was not found. Install ffmpeg and make sure it is available in PATH.".to_string()
            } else {
                format!("Failed to start ffmpeg: {error}")
            }
        })?;

    if !output_result.status.success() {
        let message = String::from_utf8_lossy(&output_result.stderr).trim().to_string();
        return Err(if message.is_empty() { "ffmpeg failed to process the media.".to_string() } else { format!("ffmpeg failed: {message}") });
    }
    Ok(())
}

fn resize_image(input: &Path, output: &Path, divisor: u32) -> Result<(i64, i64), String> {
    let image = image::open(input).map_err(|error| format!("Failed to decode image: {error}"))?;
    let width = (image.width() / divisor).max(1);
    let height = (image.height() / divisor).max(1);
    image.resize_exact(width, height, image::imageops::FilterType::Lanczos3)
        .save(output)
        .map_err(|error| format!("Failed to save resized image: {error}"))?;
    Ok((i64::from(width), i64::from(height)))
}

fn file_has_audio_stream(path: &Path) -> Result<bool, String> {
    let output = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "ffprobe was not found. Install ffmpeg and make sure ffprobe is available in PATH.".to_string()
            } else {
                format!("Failed to start ffprobe: {error}")
            }
        })?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if details.is_empty() { "ffprobe failed to inspect media.".to_string() } else { format!("ffprobe failed: {details}") });
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

#[tauri::command]
pub fn media_ids_with_audio(media_ids: Vec<i64>, state: tauri::State<'_, AppState>) -> Result<Vec<i64>, String> {
    if media_ids.is_empty() { return Ok(Vec::new()); }
    let root = state.library_path.lock().map_err(|_| "Failed to access the library path.".to_string())?
        .clone().ok_or_else(|| "No library is currently open.".to_string())?;
    let library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_ref().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut output = Vec::new();
    for media_id in media_ids {
        let row: Option<(String, String)> = connection.query_row(
            "SELECT stored_filename, media_type FROM media WHERE id=?1",
            [media_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional().map_err(|e| e.to_string())?;
        let Some((stored_filename, media_type)) = row else { continue; };
        if media_type != "video" { continue; }
        let path = media_directory(&root, &media_type).join(stored_filename);
        if file_has_audio_stream(&path)? { output.push(media_id); }
    }
    Ok(output)
}

#[tauri::command]
pub fn process_media(media_ids: Vec<i64>, operation: String, state: tauri::State<'_, AppState>) -> Result<ProcessMediaResult, String> {
    if media_ids.is_empty() {
        return Ok(ProcessMediaResult { processed_count: 0, errors: Vec::new() });
    }
    if operation != "half_size" && operation != "quarter_size" && operation != "remove_audio" {
        return Err(format!("Unsupported media operation: {operation}"));
    }

    let root = state.library_path.lock().map_err(|_| "Failed to access the library path.".to_string())?
        .clone().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut result = ProcessMediaResult { processed_count: 0, errors: Vec::new() };

    // Resizing a collection cover must resize every page in that collection, not
    // just the visible cover. Expand the requested IDs here so every caller gets
    // the same behavior, including bulk actions and future UI entry points.
    let media_ids = if operation == "half_size" || operation == "quarter_size" {
        let mut expanded = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for media_id in media_ids {
            let collection_id: Option<i64> = connection.query_row(
                "SELECT collection_id FROM collection_pages WHERE media_id=?1 LIMIT 1",
                [media_id],
                |row| row.get(0),
            ).optional().map_err(|e| e.to_string())?;
            if let Some(collection_id) = collection_id {
                let mut statement = connection.prepare(
                    "SELECT media_id FROM collection_pages WHERE collection_id=?1 ORDER BY position, page_number",
                ).map_err(|e| e.to_string())?;
                let page_ids = statement.query_map([collection_id], |row| row.get::<_, i64>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                for page_id in page_ids {
                    if seen.insert(page_id) { expanded.push(page_id); }
                }
            } else if seen.insert(media_id) {
                expanded.push(media_id);
            }
        }
        expanded
    } else {
        media_ids
    };

    for media_id in media_ids {
        let row: Option<(String, String, String, String, Option<i64>, Option<i64>)> = connection.query_row(
            "SELECT hash, stored_filename, media_type, extension, width, height FROM media WHERE id=?1",
            [media_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        ).optional().map_err(|e| e.to_string())?;
        let Some((old_hash, stored_filename, media_type, extension, old_width, old_height)) = row else {
            result.errors.push(format!("Media #{media_id}: record not found."));
            continue;
        };
        if operation == "remove_audio" && media_type != "video" {
            continue;
        }

        let input = media_directory(&root, &media_type).join(&stored_filename);
        let temp = input.with_file_name(format!(".processing-{media_id}.{extension}"));
        let _ = fs::remove_file(&temp);

        let dimensions = if (operation == "half_size" || operation == "quarter_size") && media_type == "image" && extension != "gif" {
            let divisor = if operation == "quarter_size" { 4 } else { 2 };
            resize_image(&input, &temp, divisor).map(Some)
        } else {
            run_ffmpeg(&input, &temp, &operation, &extension).map(|_| {
                if operation == "half_size" || operation == "quarter_size" {
                    let divisor = if operation == "quarter_size" { 4 } else { 2 };
                    old_width.zip(old_height).map(|(w, h)| ((w / divisor).max(1), (h / divisor).max(1)))
                } else {
                    old_width.zip(old_height)
                }
            })
        };

        let dimensions = match dimensions {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_file(&temp);
                result.errors.push(format!("{}: {error}", stored_filename));
                continue;
            }
        };

        let new_hash = match calculate_sha256(&temp) {
            Ok(hash) => hash,
            Err(error) => {
                let _ = fs::remove_file(&temp);
                result.errors.push(format!("{}: {error}", stored_filename));
                continue;
            }
        };
        if new_hash == old_hash {
            let _ = fs::remove_file(&temp);
            result.processed_count += 1;
            continue;
        }

        let duplicate: Option<i64> = connection.query_row(
            "SELECT id FROM media WHERE hash=?1 AND id<>?2",
            params![new_hash, media_id],
            |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if duplicate.is_some() {
            let _ = fs::remove_file(&temp);
            result.errors.push(format!("{}: processed result already exists in the library.", stored_filename));
            continue;
        }

        let new_stored = format!("{new_hash}.{extension}");
        let new_path = media_directory(&root, &media_type).join(&new_stored);
        if let Err(error) = fs::rename(&temp, &new_path) {
            let _ = fs::remove_file(&temp);
            result.errors.push(format!("{}: failed to replace file: {error}", stored_filename));
            continue;
        }
        let filesize = match fs::metadata(&new_path).and_then(|m| i64::try_from(m.len()).map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "file too large"))) {
            Ok(size) => size,
            Err(error) => {
                let _ = fs::remove_file(&new_path);
                result.errors.push(format!("{}: failed to inspect processed file: {error}", stored_filename));
                continue;
            }
        };
        let (new_width, new_height) = dimensions.map(|d| (Some(d.0), Some(d.1))).unwrap_or((old_width, old_height));

        if let Err(error) = connection.execute(
            "UPDATE media SET hash=?1, stored_filename=?2, width=?3, height=?4, filesize=?5 WHERE id=?6",
            params![new_hash, new_stored, new_width, new_height, filesize, media_id],
        ) {
            let _ = fs::remove_file(&new_path);
            result.errors.push(format!("{}: failed to update database: {error}", stored_filename));
            continue;
        }
        if input != new_path {
            let _ = fs::remove_file(&input);
        }
        if operation == "remove_audio" && is_short_silent_video(&new_path) {
            if let Err(error) = add_tag_direct(connection, media_id, "metadata", "animated_gif") {
                result.errors.push(format!("{}: audio was removed, but animated GIF tagging failed: {error}", stored_filename));
            }
        }
        result.processed_count += 1;
    }

    Ok(result)
}


fn run_trim_ffmpeg(input: &Path, output: &Path, mode: &str, position_seconds: f64, extension: &str) -> Result<(), String> {
    if !position_seconds.is_finite() || position_seconds <= 0.0 {
        return Err("The trim position must be greater than zero.".to_string());
    }
    let mut command = Command::new("ffmpeg");
    command.args(["-y", "-hide_banner", "-loglevel", "error"]);
    match mode {
        "remove_start" => {
            command.arg("-i").arg(input).arg("-ss").arg(format!("{position_seconds:.6}"));
        }
        "remove_end" => {
            command.arg("-i").arg(input).arg("-t").arg(format!("{position_seconds:.6}"));
        }
        _ => return Err(format!("Unsupported trim mode: {mode}")),
    }
    command.args(["-map", "0:v:0", "-map", "0:a?"]);
    if extension == "webm" {
        command.args(["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-c:a", "libopus"]);
    } else {
        command.args(["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]);
    }
    let output_result = command.arg(output).stdout(Stdio::null()).stderr(Stdio::piped()).output()
        .map_err(|error| if error.kind() == std::io::ErrorKind::NotFound {
            "ffmpeg was not found. Install ffmpeg and make sure it is available in PATH.".to_string()
        } else { format!("Failed to start ffmpeg: {error}") })?;
    if !output_result.status.success() {
        let message = String::from_utf8_lossy(&output_result.stderr).trim().to_string();
        return Err(if message.is_empty() { "ffmpeg failed to trim the video.".to_string() } else { format!("ffmpeg failed: {message}") });
    }
    Ok(())
}

#[tauri::command]
pub fn trim_video(media_id: i64, mode: String, position_seconds: f64, state: tauri::State<'_, AppState>) -> Result<ProcessMediaResult, String> {
    if mode != "remove_start" && mode != "remove_end" {
        return Err(format!("Unsupported trim mode: {mode}"));
    }
    let root = state.library_path.lock().map_err(|_| "Failed to access the library path.".to_string())?
        .clone().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "No library is currently open.".to_string())?;
    let row: Option<(String, String, String, String, Option<i64>, Option<i64>)> = connection.query_row(
        "SELECT hash, stored_filename, media_type, extension, width, height FROM media WHERE id=?1",
        [media_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    ).optional().map_err(|e| e.to_string())?;
    let Some((old_hash, stored_filename, media_type, extension, width, height)) = row else {
        return Err(format!("Media #{media_id} was not found."));
    };
    if media_type != "video" { return Err("Only videos can be trimmed.".to_string()); }

    let input = media_directory(&root, &media_type).join(&stored_filename);
    let temp = input.with_file_name(format!(".trimming-{media_id}.{extension}"));
    let _ = fs::remove_file(&temp);
    if let Err(error) = run_trim_ffmpeg(&input, &temp, &mode, position_seconds, &extension) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    let new_hash = calculate_sha256(&temp)?;
    if new_hash == old_hash {
        let _ = fs::remove_file(&temp);
        return Ok(ProcessMediaResult { processed_count: 1, errors: Vec::new() });
    }
    let duplicate: Option<i64> = connection.query_row(
        "SELECT id FROM media WHERE hash=?1 AND id<>?2", params![new_hash, media_id], |r| r.get(0)
    ).optional().map_err(|e| e.to_string())?;
    if duplicate.is_some() {
        let _ = fs::remove_file(&temp);
        return Ok(ProcessMediaResult { processed_count: 0, errors: vec![format!("{}: trimmed result already exists in the library.", stored_filename)] });
    }
    let new_stored = format!("{new_hash}.{extension}");
    let new_path = media_directory(&root, &media_type).join(&new_stored);
    fs::rename(&temp, &new_path).map_err(|error| format!("Failed to replace the trimmed video: {error}"))?;
    let filesize = fs::metadata(&new_path).map_err(|e| format!("Failed to inspect trimmed video: {e}"))?.len() as i64;
    if let Err(error) = connection.execute(
        "UPDATE media SET hash=?1, stored_filename=?2, width=?3, height=?4, filesize=?5 WHERE id=?6",
        params![new_hash, new_stored, width, height, filesize, media_id],
    ) {
        let _ = fs::remove_file(&new_path);
        return Err(format!("Failed to update the trimmed video record: {error}"));
    }
    if input != new_path { let _ = fs::remove_file(&input); }
    if is_short_silent_video(&new_path) {
        let _ = add_tag_direct(connection, media_id, "metadata", "animated_gif");
    }
    Ok(ProcessMediaResult { processed_count: 1, errors: Vec::new() })
}

#[tauri::command]
pub fn import_media_files(paths: Vec<String>, state: tauri::State<'_, AppState>) -> Result<ImportMediaResult, String> {
    let root = state.library_path.lock().map_err(|_| "Failed to access the library path.".to_string())?.clone().ok_or_else(|| "No library is currently open.".to_string())?;
    let library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_ref().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut result = ImportMediaResult{imported_count:0,skipped_count:0,errors:vec![]};
    for raw in paths {
        match import_one(Path::new(&raw), &root, connection) {
            Ok(true) => result.imported_count += 1,
            Ok(false) => result.skipped_count += 1,
            Err(e) => result.errors.push(format!("{raw}: {e}")),
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn import_media_url(url: String, tags: Vec<String>, state: tauri::State<'_, AppState>) -> Result<ImportMediaResult, String> {
    let parsed = url::Url::parse(url.trim()).map_err(|e| format!("Invalid URL: {e}"))?;
    let ext = Path::new(parsed.path()).extension().and_then(|v| v.to_str()).map(str::to_lowercase).ok_or_else(|| "URL must point directly to a supported image or video file.".to_string())?;
    classify_extension(&ext).ok_or_else(|| format!("Unsupported media type: {ext}"))?;
    let response = reqwest::blocking::get(parsed.clone()).map_err(|e| format!("Download failed: {e}"))?;
    if !response.status().is_success() { return Err(format!("Download returned HTTP {}", response.status())); }
    let bytes = response.bytes().map_err(|e| format!("Failed to read download: {e}"))?;
    let temp = std::env::temp_dir().join(format!("rule34-library-{}.{}", std::process::id(), ext));
    File::create(&temp).and_then(|mut f| f.write_all(&bytes)).map_err(|e| format!("Failed to write temporary file: {e}"))?;
    let root = state.library_path.lock().map_err(|_| "Failed to access the library path.".to_string())?.clone().ok_or_else(|| "No library is currently open.".to_string())?;
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access the library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "No library is currently open.".to_string())?;
    let (id, imported) = import_one_with_id(&temp, &root, connection)?;
    connection.execute("INSERT OR IGNORE INTO sources(media_id,site,post_id,url,imported_at) VALUES(?1,?2,?3,?4,datetime('now'))", params![id,parsed.host_str().unwrap_or("unknown"),parsed.path(),parsed.as_str()]).map_err(|e| e.to_string())?;
    for raw in tags { if let Some((c,n)) = raw.split_once(':') { let _ = add_tag_direct(connection,id,c,n); } else { let _ = add_tag_direct(connection,id,"custom",&raw); } }
    let _ = fs::remove_file(temp);
    Ok(ImportMediaResult{imported_count:usize::from(imported),skipped_count:usize::from(!imported),errors:vec![]})
}

fn add_tag_direct(connection:&rusqlite::Connection, media_id:i64, category:&str, name:&str)->Result<(),String>{
    let c=category.trim(); let n=name.trim(); if c.is_empty()||n.is_empty(){return Ok(())}
    connection.execute("INSERT INTO tags(name,category) VALUES(?1,?2) ON CONFLICT(name,category) DO NOTHING",params![n,c]).map_err(|e|e.to_string())?;
    let id:i64=connection.query_row("SELECT id FROM tags WHERE name=?1 COLLATE NOCASE AND category=?2 COLLATE NOCASE",params![n,c],|r|r.get(0)).map_err(|e|e.to_string())?;
    connection.execute("INSERT OR IGNORE INTO media_tags(media_id,tag_id) VALUES(?1,?2)",params![media_id,id]).map_err(|e|e.to_string())?; Ok(())
}

fn metadata_tag_names(extension: &str, media_type: &str) -> Vec<&'static str> {
    if extension.eq_ignore_ascii_case("gif") {
        vec!["gif", "animated_gif", "video"]
    } else if media_type == "video" {
        vec!["video"]
    } else {
        vec!["image"]
    }
}

fn is_short_silent_video(path: &Path) -> bool {
    let output = match Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json"])
        .arg(path)
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return false,
    };

    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else { return false; };
    let duration = value.get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|duration| duration.as_str())
        .and_then(|duration| duration.parse::<f64>().ok());
    let has_audio = value.get("streams")
        .and_then(|streams| streams.as_array())
        .map(|streams| streams.iter().any(|stream| stream.get("codec_type").and_then(|kind| kind.as_str()) == Some("audio")))
        .unwrap_or(false);

    matches!(duration, Some(seconds) if seconds > 0.0 && seconds < 30.0) && !has_audio
}

fn ensure_metadata_tags(connection: &rusqlite::Connection, media_id: i64, original_extension: &str, media_type: &str, stored_source: &Path) -> Result<(), String> {
    for name in metadata_tag_names(original_extension, media_type) {
        add_tag_direct(connection, media_id, "metadata", name)?;
    }
    if media_type == "video" && is_short_silent_video(stored_source) {
        add_tag_direct(connection, media_id, "metadata", "animated_gif")?;
    }
    Ok(())
}

fn convert_gif_to_mp4(source: &Path) -> Result<PathBuf, String> {
    let unique = format!("{}-{}", std::process::id(), SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos());
    let output_path = std::env::temp_dir().join(format!("rule34-library-gif-{unique}.mp4"));
    let output = Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(source)
        .args([
            "-an",
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-movflags", "+faststart",
        ])
        .arg(&output_path)
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "GIF imports are converted to MP4. Install ffmpeg and make sure it is available in PATH.".to_string()
            } else {
                format!("Failed to start ffmpeg for GIF conversion: {error}")
            }
        })?;

    if !output.status.success() {
        let _ = fs::remove_file(&output_path);
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if details.is_empty() {
            "ffmpeg failed to convert the GIF to MP4.".to_string()
        } else {
            format!("ffmpeg failed to convert the GIF to MP4: {details}")
        });
    }
    if !output_path.exists() || output_path.metadata().map(|metadata| metadata.len()).unwrap_or(0) == 0 {
        let _ = fs::remove_file(&output_path);
        return Err("ffmpeg completed without producing a converted GIF video.".to_string());
    }
    Ok(output_path)
}

fn import_one_with_id(source: &Path, root: &Path, connection: &rusqlite::Connection) -> Result<(i64, bool), String> {
    let original_extension = source.extension().and_then(|value| value.to_str()).map(str::to_lowercase)
        .ok_or_else(|| "File has no extension.".to_string())?;
    classify_extension(&original_extension).ok_or_else(|| format!("Unsupported media type: {original_extension}"))?;

    let converted = if original_extension == "gif" { Some(convert_gif_to_mp4(source)?) } else { None };
    let import_source = converted.as_deref().unwrap_or(source);
    let stored_extension = import_source.extension().and_then(|value| value.to_str()).map(str::to_lowercase)
        .ok_or_else(|| "Prepared media has no extension.".to_string())?;
    let media_type = classify_extension(&stored_extension).ok_or_else(|| format!("Unsupported media type: {stored_extension}"))?;
    let hash = calculate_sha256(import_source)?;

    let result = (|| {
        let media = copy_media_file(import_source, root)?;
        let imported = media.is_some();
        let media_id = if let Some(mut media) = media {
            if original_extension == "gif" {
                media.original_filename = source.file_name().and_then(|value| value.to_str()).unwrap_or("animation.gif").to_string();
            }
            connection.execute(r#"INSERT INTO media(hash,original_filename,stored_filename,extension,media_type,width,height,filesize,favorite,added_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,datetime('now'))"#,
                params![media.hash,media.original_filename,media.stored_filename,media.extension,media.media_type,media.width,media.height,media.filesize]).map_err(|e|format!("Failed to insert media: {e}"))?;
            connection.last_insert_rowid()
        } else {
            connection.query_row("SELECT id FROM media WHERE hash=?1", [&hash], |row| row.get(0)).map_err(|e| e.to_string())?
        };
        ensure_metadata_tags(connection, media_id, &original_extension, media_type, import_source)?;
        Ok((media_id, imported))
    })();

    if let Some(path) = converted { let _ = fs::remove_file(path); }
    result
}

fn import_one(source:&Path, root:&Path, connection:&rusqlite::Connection)->Result<bool,String>{
    import_one_with_id(source, root, connection).map(|(_, imported)| imported)
}

fn copy_media_file(source:&Path,root:&Path)->Result<Option<CopiedMedia>,String>{
    if !source.is_file(){return Err("Path is not a file.".to_string())}
    let ext=source.extension().and_then(|v|v.to_str()).map(str::to_lowercase).ok_or_else(||"File has no extension.".to_string())?;
    let media_type=classify_extension(&ext).ok_or_else(||format!("Unsupported media type: {ext}"))?.to_string();
    let hash=calculate_sha256(source)?; let stored=format!("{hash}.{ext}"); let dest_dir=media_directory(root,&media_type); fs::create_dir_all(&dest_dir).map_err(|e|e.to_string())?; let dest=dest_dir.join(&stored);
    if dest.exists(){return Ok(None)}
    fs::copy(source,&dest).map_err(|e|format!("Failed to copy file: {e}"))?;
    let size=i64::try_from(fs::metadata(&dest).map_err(|e|e.to_string())?.len()).map_err(|_|"File is too large.".to_string())?;
    let dimensions=if media_type=="image" { image::image_dimensions(&dest).ok().map(|(w,h)|(i64::from(w),i64::from(h))) } else { None };
    Ok(Some(CopiedMedia{hash,original_filename:source.file_name().and_then(|v|v.to_str()).unwrap_or("download").to_string(),stored_filename:stored,extension:ext,media_type,width:dimensions.map(|d|d.0),height:dimensions.map(|d|d.1),filesize:size}))
}

fn optimize_downloaded_video(source: &Path) -> Result<Option<PathBuf>, String> {
    let extension = source.extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
        .ok_or_else(|| "Downloaded media has no extension.".to_string())?;
    if classify_extension(&extension) != Some("video") {
        return Ok(None);
    }

    let unique = format!("{}-{}", std::process::id(), SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos());
    let output_path = std::env::temp_dir().join(format!("rule34-library-optimized-{unique}.mp4"));
    let output = Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(source)
        .args([
            "-map", "0:v:0",
            "-map", "0:a?",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:a", "aac",
            "-b:a", "128k",
            "-map_metadata", "-1",
            "-movflags", "+faststart",
            "-threads", "4",
        ])
        .arg(&output_path)
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "Automatic video compression requires ffmpeg in PATH.".to_string()
            } else {
                format!("Failed to start automatic video compression: {error}")
            }
        })?;

    if !output.status.success() {
        let _ = fs::remove_file(&output_path);
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if details.is_empty() {
            "ffmpeg failed to optimize the downloaded video.".to_string()
        } else {
            format!("ffmpeg failed to optimize the downloaded video: {details}")
        });
    }

    let original_size = fs::metadata(source).map_err(|e| e.to_string())?.len();
    let optimized_size = fs::metadata(&output_path).map_err(|e| e.to_string())?.len();
    if optimized_size == 0 || optimized_size >= original_size {
        let _ = fs::remove_file(&output_path);
        return Ok(None);
    }
    Ok(Some(output_path))
}

pub(crate) fn import_downloaded_media(source: &Path, root: &Path, connection: &rusqlite::Connection) -> Result<(i64, bool), String> {
    let optimized = optimize_downloaded_video(source)?;
    let import_source = optimized.as_deref().unwrap_or(source);
    let result = import_one_with_id(import_source, root, connection);
    if let Some(path) = optimized { let _ = fs::remove_file(path); }
    result
}

#[tauri::command]
pub fn insert_test_media(_state: tauri::State<'_, AppState>) -> Result<i64,String>{Err("Test media insertion is disabled.".to_string())}
