use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::Ordering,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use reqwest::{blocking::Client, header::{CONTENT_TYPE, REFERER}};
use rusqlite::{params, OptionalExtension};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use image::{DynamicImage, RgbaImage};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use url::Url;

use crate::{commands::media::{import_downloaded_media, is_valid_tag_name}, state::{AppState, ImportJob}};

const LISTEN_ADDRESS: &str = "127.0.0.1:37891";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportRequest {
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) site: Option<String>,
    #[serde(default)]
    pub(crate) artist: Option<String>,
    #[serde(default)]
    pub(crate) media_urls: Vec<String>,
    #[serde(default)]
    pub(crate) media_types: Vec<String>,
    #[serde(default)]
    pub(crate) media_page_numbers: Vec<Option<i64>>,
    #[serde(default)]
    pub(crate) collection_metadata: Option<CollectionMetadata>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionMetadata {
    pub(crate) title: Option<String>,
    pub(crate) source_url: Option<String>,
    #[serde(default)]
    pub(crate) tags: Vec<CollectionTag>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionTag {
    pub(crate) category: String,
    pub(crate) name: String,
}


#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportAccepted { job_id: u64, status: &'static str }

#[derive(Debug)]
struct ParsedPost {
    page_url: Url,
    media_url: Url,
    tags: Vec<(String, String)>,
    post_id: String,
}

pub fn start_import_server(app: AppHandle) {
    thread::spawn(move || {
        let server = match Server::http(LISTEN_ADDRESS) {
            Ok(server) => server,
            Err(error) => {
                eprintln!("Failed to start import server on {LISTEN_ADDRESS}: {error}");
                let _ = app.emit("import-server-error", error.to_string());
                return;
            }
        };

        let _ = app.emit("import-server-ready", LISTEN_ADDRESS);
        for mut request in server.incoming_requests() {
            let cors = Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap();
            let content_type = Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap();

            if request.method() == &Method::Options {
                let mut response = Response::empty(StatusCode(204));
                response.add_header(cors);
                response.add_header(Header::from_bytes("Access-Control-Allow-Methods", "POST, OPTIONS").unwrap());
                response.add_header(Header::from_bytes("Access-Control-Allow-Headers", "Content-Type").unwrap());
                let _ = request.respond(response);
                continue;
            }

            if request.method() != &Method::Post || request.url() != "/import" {
                let mut response = Response::from_string(r#"{"error":"Not found"}"#).with_status_code(404);
                response.add_header(cors); response.add_header(content_type);
                let _ = request.respond(response);
                continue;
            }

            let mut body = String::new();
            let parsed = request.as_reader().read_to_string(&mut body)
                .map_err(|e| e.to_string())
                .and_then(|_| serde_json::from_str::<ImportRequest>(&body).map_err(|e| e.to_string()));

            match parsed.and_then(|payload| enqueue_import(&app, payload)) {
                Ok(job_id) => {
                    let payload = serde_json::to_string(&ImportAccepted { job_id, status: "queued" }).unwrap();
                    let mut response = Response::from_string(payload).with_status_code(202);
                    response.add_header(cors); response.add_header(content_type);
                    let _ = request.respond(response);
                }
                Err(error) => {
                    let payload = serde_json::json!({"error": error}).to_string();
                    let mut response = Response::from_string(payload).with_status_code(400);
                    response.add_header(cors); response.add_header(content_type);
                    let _ = request.respond(response);
                }
            }
        }
    });
}

pub(crate) fn enqueue_import(app: &AppHandle, payload: ImportRequest) -> Result<u64, String> {
    enqueue_import_with_refresh(app, payload, true)
}

pub(crate) fn enqueue_import_with_refresh(app: &AppHandle, payload: ImportRequest, refresh_gallery: bool) -> Result<u64, String> {
    let url = Url::parse(payload.url.trim()).map_err(|e| format!("Invalid URL: {e}"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let is_rule34 = host == "rule34.xxx" || host == "www.rule34.xxx";
    let is_danbooru = host == "danbooru.donmai.us" || host == "www.danbooru.donmai.us";
    let is_gelbooru = host == "gelbooru.com" || host == "www.gelbooru.com";
    let is_x = matches!(host.as_str(), "x.com" | "www.x.com" | "twitter.com" | "www.twitter.com");
    let is_bsky = matches!(host.as_str(), "bsky.app" | "www.bsky.app");
    let is_collection = payload.site.as_deref() == Some("collection");

    if is_rule34 {
        let is_post = url.query_pairs().any(|(key, value)| key == "page" && value == "post")
            && url.query_pairs().any(|(key, value)| key == "s" && value == "view");
        if !is_post { return Err("Open an individual Rule34 post page before importing.".to_string()); }
    } else if is_danbooru {
        let mut segments = url.path_segments().into_iter().flatten();
        let is_post = segments.next() == Some("posts")
            && segments.next().map(|value| value.chars().all(|ch| ch.is_ascii_digit())).unwrap_or(false);
        if !is_post { return Err("Open an individual Danbooru post page before importing.".to_string()); }
    } else if is_gelbooru {
        let is_post = url.query_pairs().any(|(key, value)| key == "page" && value == "post")
            && url.query_pairs().any(|(key, value)| key == "s" && value == "view")
            && url.query_pairs().any(|(key, value)| key == "id" && !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()));
        if !is_post { return Err("Open an individual Gelbooru post page before importing.".to_string()); }
    } else if is_x {
        if !url.path().contains("/status/") {
            return Err("Right-click an individual X/Twitter post before importing.".to_string());
        }
        if payload.artist.as_deref().unwrap_or("").trim().is_empty() {
            return Err("The extension could not identify the X/Twitter username.".to_string());
        }
        if payload.media_urls.is_empty() {
            return Err("No downloadable images or videos were found in that X/Twitter post. For videos, play the post briefly and try again.".to_string());
        }
    } else if is_bsky {
        let parts: Vec<&str> = url.path_segments().map(|segments| segments.collect()).unwrap_or_default();
        let valid_post = parts.len() >= 4 && parts[0] == "profile" && parts[2] == "post" && !parts[1].is_empty() && !parts[3].is_empty();
        if !valid_post {
            return Err("Right-click an individual Bluesky post before importing.".to_string());
        }
    } else if is_collection {
        if payload.media_urls.is_empty() { return Err("The image pool is empty.".to_string()); }
        if payload.collection_metadata.is_none() && !collection_exists_for_source(app, &url)? {
            return Err("Add metadata before importing this new collection. Metadata can be omitted only when this gallery already exists in the library.".to_string());
        }
    } else {
        return Err("Only Rule34, Danbooru, Gelbooru, X/Twitter, Bluesky, and extension collection payloads are supported.".to_string());
    }

    let state = app.state::<AppState>();
    let id = state.next_import_id.fetch_add(1, Ordering::Relaxed);
    {
        let mut queue = state.import_queue.lock().map_err(|_| "Failed to access import queue.".to_string())?;
        queue.push_front(ImportJob { id, url: url.to_string(), status: "queued".into(), message: None });
        while queue.len() > 100 { queue.pop_back(); }
    }
    let _ = app.emit("import-queue-updated", ());

    let worker_app = app.clone();
    thread::spawn(move || {
        set_job(&worker_app, id, "fetching", None);
        let result = if is_rule34 {
            process_booru_import(&worker_app, id, &url, BooruSite::Rule34)
        } else if is_danbooru {
            process_booru_import(&worker_app, id, &url, BooruSite::Danbooru)
        } else if is_gelbooru {
            process_booru_import(&worker_app, id, &url, BooruSite::Gelbooru)
        } else if is_x {
            process_x_import(&worker_app, id, &url, payload.artist.unwrap_or_default(), payload.media_urls, payload.media_types)
        } else if is_bsky {
            process_bsky_import(&worker_app, id, &url)
        } else {
            process_collection_import(&worker_app, id, &url, payload.media_urls, payload.media_page_numbers, payload.collection_metadata)
        };
        match result {
            Ok(message) => {
                set_job(&worker_app, id, "completed", Some(message));
                if refresh_gallery {
                    let _ = worker_app.emit("library-changed", ());
                }
            }
            Err(error) => set_job(&worker_app, id, "failed", Some(error)),
        }
    });
    Ok(id)
}

fn set_job(app: &AppHandle, id: u64, status: &str, message: Option<String>) {
    if let Ok(mut queue) = app.state::<AppState>().import_queue.lock() {
        if let Some(job) = queue.iter_mut().find(|job| job.id == id) {
            job.status = status.to_string(); job.message = message;
        }
    }
    let _ = app.emit("import-queue-updated", ());
}

#[derive(Clone, Copy)]
enum BooruSite {
    Rule34,
    Danbooru,
    Gelbooru,
}

impl BooruSite {
    fn source_name(self) -> &'static str {
        match self {
            Self::Rule34 => "rule34.xxx",
            Self::Danbooru => "danbooru.donmai.us",
            Self::Gelbooru => "gelbooru.com",
        }
    }
}

fn process_booru_import(app: &AppHandle, job_id: u64, page_url: &Url, site: BooruSite) -> Result<String, String> {
    let client = Client::builder().user_agent("Rule34Library/0.1 (+local desktop importer)").build().map_err(|e| e.to_string())?;
    let html = client.get(page_url.clone()).send().map_err(|e| format!("Failed to fetch post page: {e}"))?
        .error_for_status().map_err(|e| format!("Post page returned an error: {e}"))?.text().map_err(|e| format!("Failed to read post page: {e}"))?;
    let parsed = match site {
        BooruSite::Rule34 => parse_rule34_page(page_url.clone(), &html)?,
        BooruSite::Danbooru => parse_danbooru_page(page_url.clone(), &html)?,
        BooruSite::Gelbooru => parse_gelbooru_page(page_url.clone(), &html)?,
    };

    set_job(app, job_id, "downloading", None);
    let response = client
        .get(parsed.media_url.clone())
        .header(REFERER, parsed.page_url.as_str())
        .send()
        .map_err(|e| format!("Failed to download media: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Media download returned an error: {e}"))?;
    let content_type = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("").to_owned();
    let bytes = response.bytes().map_err(|e| format!("Failed to read media download: {e}"))?;
    let extension = media_extension(&parsed.media_url, &content_type)?;
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temp = std::env::temp_dir().join(format!("rule34-library-{unique}.{extension}"));
    std::fs::write(&temp, &bytes).map_err(|e| format!("Failed to write temporary media: {e}"))?;

    let state = app.state::<AppState>();
    let root = state.library_path.lock().map_err(|_| "Failed to access library path.".to_string())?.clone().ok_or_else(|| "Open or configure a library before importing.".to_string())?;
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "Open or configure a library before importing.".to_string())?;
    let (media_id, imported) = import_downloaded_media(&temp, &root, connection)?;

    let tx = connection.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO sources(media_id,site,post_id,url,imported_at) VALUES(?1,?2,?3,?4,datetime('now'))", params![media_id, site.source_name(), parsed.post_id, parsed.page_url.as_str()]).map_err(|e| e.to_string())?;
    for (category, name) in &parsed.tags {
        if !is_valid_tag_name(name) { continue; }
        tx.execute("INSERT INTO tags(name,category) VALUES(?1,?2) ON CONFLICT(name,category) DO NOTHING", params![name, category]).map_err(|e| e.to_string())?;
        let tag_id:i64 = tx.query_row("SELECT id FROM tags WHERE name=?1 COLLATE NOCASE AND category=?2 COLLATE NOCASE", params![name, category], |row| row.get(0)).map_err(|e| e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO media_tags(media_id,tag_id) VALUES(?1,?2)", params![media_id, tag_id]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(temp);
    Ok(format!("{} media and {} tags", if imported { "Imported" } else { "Updated existing" }, parsed.tags.len()))
}

fn normalized_collection_source(url: &Url) -> String {
    let mut normalized = url.clone();
    let segments: Vec<_> = normalized.path_segments().map(|parts| parts.collect()).unwrap_or_default();
    if segments.len() >= 2 && segments[0] == "g" {
        normalized.set_path(&format!("/g/{}/", segments[1]));
    }
    normalized.set_query(None);
    normalized.set_fragment(None);
    normalized.to_string()
}

fn collection_exists_for_source(app: &AppHandle, url: &Url) -> Result<bool, String> {
    let source = normalized_collection_source(url);
    let state = app.state::<AppState>();
    let library = state.library_connection.lock().map_err(|_| "Failed to access library database.".to_string())?;
    let connection = library.as_ref().ok_or_else(|| "Open or configure a library before importing.".to_string())?;
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM collections c WHERE (c.source_external_id=?1 OR c.source_url=?1) AND EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id=mt.tag_id WHERE mt.media_id=c.cover_media_id AND lower(t.category)='metadata' AND lower(t.name)='comic_hentai')",
        [source],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    Ok(count > 0)
}

fn process_collection_import(
    app: &AppHandle,
    job_id: u64,
    request_url: &Url,
    media_urls: Vec<String>,
    media_page_numbers: Vec<Option<i64>>,
    metadata: Option<CollectionMetadata>,
) -> Result<String, String> {
    let source = metadata.as_ref().and_then(|value| value.source_url.as_deref())
        .and_then(|value| Url::parse(value).ok())
        .map(|value| normalized_collection_source(&value))
        .unwrap_or_else(|| normalized_collection_source(request_url));
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36")
        .build().map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    let root = state.library_path.lock().map_err(|_| "Failed to access library path.".to_string())?.clone().ok_or_else(|| "Open or configure a library before importing.".to_string())?;

    let mut library = state.library_connection.lock().map_err(|_| "Failed to access library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "Open or configure a library before importing.".to_string())?;
    let existing: Option<(i64, i64)> = connection.query_row(
        "SELECT c.id,c.cover_media_id FROM collections c WHERE (c.source_external_id=?1 OR c.source_url=?1) AND EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id=mt.tag_id WHERE mt.media_id=c.cover_media_id AND lower(t.category)='metadata' AND lower(t.name)='comic_hentai') LIMIT 1",
        [&source],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    if existing.is_none() && metadata.is_none() {
        return Err("Add metadata before importing this new collection.".to_string());
    }
    let existing_pages: HashSet<i64> = if let Some((collection_id, _)) = existing {
        let mut statement = connection.prepare("SELECT page_number FROM collection_pages WHERE collection_id=?1").map_err(|e| e.to_string())?;
        let rows = statement.query_map([collection_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<HashSet<_>, _>>().map_err(|e| e.to_string())?
    } else { HashSet::new() };

    let mut candidates = Vec::new();
    for (index, raw_url) in media_urls.iter().enumerate() {
        let page_number = media_page_numbers.get(index).and_then(|value| *value).unwrap_or((index + 1) as i64);
        if page_number <= 0 || existing_pages.contains(&page_number) { continue; }
        candidates.push((page_number, raw_url.clone()));
    }
    candidates.sort_by_key(|(page_number, _)| *page_number);
    candidates.dedup_by_key(|(page_number, _)| *page_number);
    if candidates.is_empty() { return Ok("No new collection pages to import".to_string()); }

    let mut imported = Vec::new();
    let mut temp_files = Vec::new();
    set_job(app, job_id, "downloading", Some(format!("0 / {}", candidates.len())));
    for (index, (page_number, raw_url)) in candidates.iter().enumerate() {
        let media_url = Url::parse(raw_url).map_err(|e| format!("Invalid image URL for page {page_number}: {e}"))?;
        let response = client.get(media_url.clone()).header(REFERER, &source).send()
            .map_err(|e| format!("Failed to download page {page_number}: {e}"))?
            .error_for_status().map_err(|e| format!("Page {page_number} returned an error: {e}"))?;
        let content_type=response.headers().get(CONTENT_TYPE).and_then(|v|v.to_str().ok()).unwrap_or("").to_owned();
        let bytes=response.bytes().map_err(|e|format!("Failed to read page {page_number}: {e}"))?;
        let extension=media_extension(&media_url,&content_type)?;
        let unique=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let temp=std::env::temp_dir().join(format!("gallery-collection-{unique}-{page_number}.{extension}"));
        std::fs::write(&temp,&bytes).map_err(|e|format!("Failed to write page {page_number}: {e}"))?;
        temp_files.push((page_number, temp));
        set_job(app, job_id, "downloading", Some(format!("{} / {}", index + 1, candidates.len())));
    }
    for (page_number, temp) in &temp_files {
        let (media_id, _) = import_downloaded_media(temp, &root, connection)?;
        imported.push((*page_number, media_id));
    }

    let tx=connection.transaction().map_err(|e|e.to_string())?;
    let collection_id = if let Some((collection_id, _)) = existing {
        collection_id
    } else {
        let value = metadata.as_ref().expect("validated metadata");
        let title=value.title.as_deref().map(str::trim).filter(|text| !text.is_empty()).unwrap_or("Untitled collection");
        let first_media_id=imported.iter().min_by_key(|(page, _)| *page).map(|(_, id)| *id).ok_or_else(|| "No collection pages were imported.".to_string())?;
        tx.execute("INSERT INTO collections(collection_type,title,source_url,source_external_id,cover_media_id,created_at) VALUES('browser_pool',?1,?2,?2,?3,datetime('now'))", params![title, source, first_media_id]).map_err(|e|e.to_string())?;
        tx.last_insert_rowid()
    };
    for (page_number, media_id) in &imported {
        let temporary_position = 1_000_000_000_i64 + *page_number;
        tx.execute("INSERT OR IGNORE INTO collection_pages(collection_id,media_id,page_number,position) VALUES(?1,?2,?3,?4)", params![collection_id,media_id,page_number,temporary_position]).map_err(|e|e.to_string())?;
    }
    tx.execute("UPDATE collection_pages SET position=position+2000000000 WHERE collection_id=?1", [collection_id]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE collection_pages SET position=page_number WHERE collection_id=?1", [collection_id]).map_err(|e|e.to_string())?;
    let new_cover: i64 = tx.query_row("SELECT media_id FROM collection_pages WHERE collection_id=?1 ORDER BY page_number,position LIMIT 1", [collection_id], |row| row.get(0)).map_err(|e|e.to_string())?;
    let old_cover: i64 = tx.query_row("SELECT cover_media_id FROM collections WHERE id=?1", [collection_id], |row| row.get(0)).map_err(|e|e.to_string())?;
    if new_cover != old_cover {
        tx.execute("INSERT OR IGNORE INTO media_tags(media_id,tag_id) SELECT ?1,tag_id FROM media_tags WHERE media_id=?2", params![new_cover,old_cover]).map_err(|e|e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO sources(media_id,site,post_id,url,imported_at) SELECT ?1,site,post_id,url,imported_at FROM sources WHERE media_id=?2", params![new_cover,old_cover]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE collections SET cover_media_id=?1 WHERE id=?2", params![new_cover,collection_id]).map_err(|e|e.to_string())?;
    }
    tx.execute("INSERT OR IGNORE INTO sources(media_id,site,post_id,url,imported_at) VALUES(?1,'browser-collection',?2,?3,datetime('now'))",params![new_cover,collection_id.to_string(),source]).map_err(|e|e.to_string())?;
    if let Some(value)=metadata {
        let updated_title = value.title.unwrap_or_default();
        tx.execute("UPDATE collections SET title=COALESCE(NULLIF(?1,''),title),source_url=?2,source_external_id=?2 WHERE id=?3", params![updated_title.trim(),source,collection_id]).map_err(|e|e.to_string())?;
        let mut tags=value.tags;
        tags.push(CollectionTag{category:"metadata".into(),name:"comic_hentai".into()});
        for tag in tags {
            if !is_valid_tag_name(&tag.name) { continue; }
            let category=tag.category.trim(); let name=tag.name.trim();
            if category.is_empty()||name.is_empty(){continue}
            tx.execute("INSERT INTO tags(name,category) VALUES(?1,?2) ON CONFLICT(name,category) DO NOTHING",params![name,category]).map_err(|e|e.to_string())?;
            let tag_id:i64=tx.query_row("SELECT id FROM tags WHERE name=?1 COLLATE NOCASE AND category=?2 COLLATE NOCASE",params![name,category],|r|r.get(0)).map_err(|e|e.to_string())?;
            tx.execute("INSERT OR IGNORE INTO media_tags(media_id,tag_id) VALUES(?1,?2)",params![new_cover,tag_id]).map_err(|e|e.to_string())?;
        }
    }
    tx.commit().map_err(|e|e.to_string())?;
    for (_, temp) in temp_files { let _=std::fs::remove_file(temp); }
    Ok(format!("Added {} page{} to collection", imported.len(), if imported.len()==1 {""} else {"s"}))
}


fn process_bsky_import(app: &AppHandle, job_id: u64, page_url: &Url) -> Result<String, String> {
    let parts: Vec<&str> = page_url.path_segments().map(|segments| segments.collect()).unwrap_or_default();
    if parts.len() < 4 || parts[0] != "profile" || parts[2] != "post" {
        return Err("Could not identify the Bluesky post.".to_string());
    }
    let profile = parts[1];
    let record_key = parts[3];
    let client = Client::builder()
        .user_agent("Mozilla/5.0 Rule34Library/0.1")
        .build().map_err(|e| e.to_string())?;
    let did = if profile.starts_with("did:") {
        profile.to_string()
    } else {
        let endpoint = Url::parse_with_params(
            "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle",
            &[("handle", profile)],
        ).map_err(|e| e.to_string())?;
        let json: serde_json::Value = client.get(endpoint).send()
            .map_err(|e| format!("Failed to resolve Bluesky handle: {e}"))?
            .error_for_status().map_err(|e| format!("Bluesky handle resolver returned an error: {e}"))?
            .json().map_err(|e| format!("Invalid Bluesky handle response: {e}"))?;
        json.get("did").and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Bluesky did not return an account identifier.".to_string())?.to_string()
    };
    let at_uri = format!("at://{did}/app.bsky.feed.post/{record_key}");
    let endpoint = Url::parse_with_params(
        "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread",
        &[("uri", at_uri.as_str()), ("depth", "0")],
    ).map_err(|e| e.to_string())?;
    set_job(app, job_id, "fetching", Some("Resolving Bluesky post".to_string()));
    let json: serde_json::Value = client.get(endpoint).send()
        .map_err(|e| format!("Failed to resolve Bluesky post: {e}"))?
        .error_for_status().map_err(|e| format!("Bluesky post resolver returned an error: {e}"))?
        .json().map_err(|e| format!("Invalid Bluesky post response: {e}"))?;
    let post = json.pointer("/thread/post").ok_or_else(|| "Bluesky post data was missing.".to_string())?;
    let full_handle = post.pointer("/author/handle").and_then(serde_json::Value::as_str)
        .unwrap_or(profile).trim_start_matches('@');
    let artist = full_handle.split('.').next().unwrap_or(full_handle).to_string();
    let embed = post.get("embed");
    let mut media_urls = Vec::new();
    let mut media_types = Vec::new();
    let mut seen = HashSet::new();
    let mut add_images = |images: Option<&Vec<serde_json::Value>>| {
        if let Some(images) = images {
            for image in images {
                if let Some(raw) = image.get("fullsize").or_else(|| image.get("thumb")).and_then(serde_json::Value::as_str) {
                    if seen.insert(raw.to_string()) { media_urls.push(raw.to_string()); media_types.push("image".to_string()); }
                }
            }
        }
    };
    if let Some(embed) = embed {
        add_images(embed.get("images").and_then(serde_json::Value::as_array));
        add_images(embed.pointer("/media/images").and_then(serde_json::Value::as_array));
        for pointer in ["/playlist", "/media/playlist"] {
            if let Some(raw) = embed.pointer(pointer).and_then(serde_json::Value::as_str) {
                if seen.insert(raw.to_string()) { media_urls.push(raw.to_string()); media_types.push("video".to_string()); }
            }
        }
    }
    if media_urls.is_empty() {
        return Err("No downloadable images or videos were found in that Bluesky post.".to_string());
    }
    process_bsky_media_import(app, job_id, page_url, artist, media_urls, media_types)
}

fn process_bsky_media_import(
    app: &AppHandle,
    job_id: u64,
    page_url: &Url,
    artist: String,
    media_urls: Vec<String>,
    media_types: Vec<String>,
) -> Result<String, String> {
    let client = Client::builder().user_agent("Mozilla/5.0 Rule34Library/0.1").build().map_err(|e| e.to_string())?;
    let mut images: Vec<(Url, Vec<u8>, String)> = Vec::new();
    let mut videos: Vec<(Url, Vec<u8>, String)> = Vec::new();
    for (index, raw) in media_urls.iter().enumerate() {
        let url = Url::parse(raw).map_err(|e| format!("Invalid Bluesky media URL: {e}"))?;
        validate_bsky_media_url(&url)?;
        set_job(app, job_id, "downloading", Some(format!("Downloading {} of {}", index + 1, media_urls.len())));
        let response = client.get(url.clone()).header(REFERER, page_url.as_str()).send()
            .map_err(|e| format!("Failed to download Bluesky media: {e}"))?
            .error_for_status().map_err(|e| format!("Bluesky media download returned an error: {e}"))?;
        let content_type = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let bytes = response.bytes().map_err(|e| format!("Failed to read Bluesky media: {e}"))?.to_vec();
        let hinted = media_types.get(index).map(String::as_str).unwrap_or("");
        if hinted == "video" || content_type.starts_with("video/") || is_video_path(&url) || is_hls_media(&url, &content_type) {
            videos.push((url, bytes, content_type));
        } else { images.push((url, bytes, content_type)); }
    }
    let state = app.state::<AppState>();
    let root = state.library_path.lock().map_err(|_| "Failed to access library path.".to_string())?.clone()
        .ok_or_else(|| "Open or configure a library before importing.".to_string())?;
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "Open or configure a library before importing.".to_string())?;
    let post_id = page_url.path_segments().map(|segments| segments.collect::<Vec<_>>()).unwrap_or_default()
        .windows(2).find(|pair| pair[0] == "post").map(|pair| pair[1].to_string()).unwrap_or_else(|| page_url.path().to_string());
    let mut imported_count = 0usize;
    if images.len() == 1 {
        let temp = write_temp_media("bsky-image", &images[0].0, &images[0].1, &images[0].2)?;
        let (media_id, _) = import_downloaded_media(&temp, &root, connection)?;
        attach_source_and_artist_for_site(connection, media_id, page_url, &post_id, &artist, "bsky.app")?;
        let _ = fs::remove_file(temp); imported_count += 1;
    } else if images.len() > 1 {
        let mut page_ids = Vec::with_capacity(images.len());
        for (index, (url, bytes, content_type)) in images.iter().enumerate() {
            set_job(app, job_id, "saving", Some(format!("Saving comic page {} of {}", index + 1, images.len())));
            let temp = write_temp_media("bsky-comic-page", url, bytes, content_type)?;
            let (media_id, imported) = import_downloaded_media(&temp, &root, connection)?;
            let _ = fs::remove_file(&temp);
            if imported {
                attach_source_and_artist_for_site(connection, media_id, page_url, &post_id, &artist, "bsky.app")?;
                page_ids.push(media_id);
            }
        }
        if page_ids.len() < 2 { imported_count += page_ids.len(); }
        else {
            let title = format!("Bluesky post by @{}", artist.trim_start_matches('@'));
            connection.execute("INSERT INTO collections(collection_type,title,source_url,source_external_id,cover_media_id,created_at) VALUES('bluesky_comic',?1,?2,?3,?4,datetime('now'))",
                params![title, page_url.as_str(), post_id, page_ids[0]]).map_err(|e| format!("Failed to create Bluesky comic: {e}"))?;
            let collection_id = connection.last_insert_rowid();
            for (index, media_id) in page_ids.iter().enumerate() {
                let position = index as i64 + 1;
                connection.execute("INSERT INTO collection_pages(collection_id,media_id,page_number,position) VALUES(?1,?2,?3,?3)", params![collection_id, media_id, position])
                    .map_err(|e| format!("Failed to add Bluesky comic page: {e}"))?;
            }
            attach_metadata_tag(connection, page_ids[0], "comic_hentai")?;
            imported_count += 1;
        }
    }
    for (index, (url, bytes, content_type)) in videos.iter().enumerate() {
        set_job(app, job_id, "saving", Some(format!("Saving video {} of {}", index + 1, videos.len())));
        let temp = write_temp_media("bsky-video", url, bytes, content_type)?;
        let (media_id, _) = import_downloaded_media(&temp, &root, connection)?;
        attach_source_and_artist_for_site(connection, media_id, page_url, &post_id, &artist, "bsky.app")?;
        let _ = fs::remove_file(temp); imported_count += 1;
    }
    Ok(format!("Imported {imported_count} item(s) from Bluesky as artist:{artist}"))
}

fn validate_bsky_media_url(url: &Url) -> Result<(), String> {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "cdn.bsky.app" || host == "video.bsky.app" || host.ends_with(".bsky.app") || host.ends_with(".bsky.network") {
        Ok(())
    } else { Err(format!("Unsupported Bluesky media host: {host}")) }
}

fn process_x_import(
    app: &AppHandle,
    job_id: u64,
    page_url: &Url,
    artist: String,
    media_urls: Vec<String>,
    media_types: Vec<String>,
) -> Result<String, String> {
    let client = Client::builder()
        .user_agent("Mozilla/5.0 Rule34Library/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let mut images: Vec<(Url, Vec<u8>, String)> = Vec::new();
    let mut videos: Vec<(Url, Vec<u8>, String, bool)> = Vec::new();
    for (index, raw) in media_urls.iter().enumerate() {
        let url = Url::parse(raw).map_err(|e| format!("Invalid X media URL: {e}"))?;
        validate_x_media_url(&url)?;
        set_job(app, job_id, "downloading", Some(format!("Downloading {} of {}", index + 1, media_urls.len())));
        let response = client.get(url.clone()).header(REFERER, page_url.as_str()).send()
            .map_err(|e| format!("Failed to download X media: {e}"))?
            .error_for_status().map_err(|e| format!("X media download returned an error: {e}"))?;
        let content_type = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let bytes = response.bytes().map_err(|e| format!("Failed to read X media: {e}"))?.to_vec();
        let hinted = media_types.get(index).map(String::as_str).unwrap_or("");
        let is_animated_gif = hinted == "animated_gif";
        let is_video = hinted == "video" || is_animated_gif || content_type.starts_with("video/") || is_video_path(&url);
        if is_video { videos.push((url, bytes, content_type, is_animated_gif)); } else { images.push((url, bytes, content_type)); }
    }

    let state = app.state::<AppState>();
    let root = state.library_path.lock().map_err(|_| "Failed to access library path.".to_string())?
        .clone().ok_or_else(|| "Open or configure a library before importing.".to_string())?;
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "Open or configure a library before importing.".to_string())?;
    let post_id = x_post_id(page_url);
    let mut imported_count = 0usize;

    if images.len() == 1 {
        let temp = write_temp_media("x-image", &images[0].0, &images[0].1, &images[0].2)?;
        let (media_id, _) = import_downloaded_media(&temp, &root, connection)?;
        attach_source_and_artist(connection, media_id, page_url, &post_id, &artist)?;
        let _ = std::fs::remove_file(temp);
        imported_count += 1;
    } else if images.len() > 1 {
        let mut page_ids = Vec::with_capacity(images.len());
        for (index, (url, bytes, content_type)) in images.iter().enumerate() {
            set_job(app, job_id, "saving", Some(format!("Saving comic page {} of {}", index + 1, images.len())));
            let temp = write_temp_media("x-comic-page", url, bytes, content_type)?;
            let (media_id, imported) = import_downloaded_media(&temp, &root, connection)?;
            let _ = std::fs::remove_file(&temp);
            if imported {
                attach_source_and_artist(connection, media_id, page_url, &post_id, &artist)?;
                page_ids.push(media_id);
            }
        }
        if page_ids.len() < 2 {
            imported_count += page_ids.len();
        } else {
            let title = format!("X post by @{}", artist.trim_start_matches('@'));
            connection.execute(
                "INSERT INTO collections(collection_type,title,source_url,source_external_id,cover_media_id,created_at) VALUES('twitter_comic',?1,?2,?3,?4,datetime('now'))",
                rusqlite::params![title, page_url.as_str(), post_id, page_ids[0]],
            ).map_err(|e| format!("Failed to create X comic: {e}"))?;
            let collection_id = connection.last_insert_rowid();
            for (index, media_id) in page_ids.iter().enumerate() {
                let position = index as i64 + 1;
                connection.execute(
                    "INSERT INTO collection_pages(collection_id,media_id,page_number,position) VALUES(?1,?2,?3,?3)",
                    rusqlite::params![collection_id, media_id, position],
                ).map_err(|e| format!("Failed to add X comic page: {e}"))?;
            }
            attach_metadata_tag(connection, page_ids[0], "comic_hentai")?;
            imported_count += 1;
        }
    }

    for (index, (url, bytes, content_type, is_animated_gif)) in videos.iter().enumerate() {
        set_job(app, job_id, "saving", Some(format!("Saving video {} of {}", index + 1, videos.len())));
        let temp = write_temp_media("x-video", url, bytes, content_type)?;
        let (media_id, _) = import_downloaded_media(&temp, &root, connection)?;
        attach_source_and_artist(connection, media_id, page_url, &post_id, &artist)?;
        if *is_animated_gif { attach_metadata_tag(connection, media_id, "animated_gif")?; }
        let _ = std::fs::remove_file(temp);
        imported_count += 1;
    }

    Ok(format!("Imported {imported_count} item(s) from X/Twitter as artist:{artist}"))
}

fn validate_x_media_url(url: &Url) -> Result<(), String> {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "pbs.twimg.com" || host == "video.twimg.com" || host.ends_with(".twimg.com") {
        Ok(())
    } else {
        Err(format!("Unsupported X media host: {host}"))
    }
}

fn is_video_path(url: &Url) -> bool {
    matches!(Path::new(url.path()).extension().and_then(|v| v.to_str()).map(|v| v.to_ascii_lowercase()).as_deref(), Some("mp4" | "webm" | "mov" | "m4v" | "m3u8"))
}

fn x_post_id(url: &Url) -> String {
    let parts: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
    parts.windows(2).find(|pair| pair[0] == "status").map(|pair| pair[1].to_string()).unwrap_or_else(|| url.path().to_string())
}

fn write_temp_media(prefix: &str, url: &Url, bytes: &[u8], content_type: &str) -> Result<std::path::PathBuf, String> {
    if is_hls_media(url, content_type) {
        return download_hls_media(prefix, url);
    }

    let extension = media_extension(url, content_type)?;
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temp = std::env::temp_dir().join(format!("{prefix}-{unique}.{extension}"));
    std::fs::write(&temp, bytes).map_err(|e| format!("Failed to write temporary media: {e}"))?;
    Ok(temp)
}

fn is_hls_media(url: &Url, content_type: &str) -> bool {
    let path_is_hls = Path::new(url.path())
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("m3u8"))
        .unwrap_or(false);
    let normalized_type = content_type.to_ascii_lowercase();
    path_is_hls || normalized_type.contains("mpegurl") || normalized_type.contains("vnd.apple.mpegurl")
}

fn download_hls_media(prefix: &str, url: &Url) -> Result<std::path::PathBuf, String> {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temp = std::env::temp_dir().join(format!("{prefix}-{unique}.mp4"));
    let output = Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-i", url.as_str(), "-map", "0:v:0", "-map", "0:a?", "-c", "copy"])
        .arg(&temp)
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "This X video uses an HLS playlist. Install ffmpeg and make sure it is available in PATH so the playlist can be converted to MP4.".to_string()
            } else {
                format!("Failed to start ffmpeg for HLS video: {error}")
            }
        })?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&temp);
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if details.is_empty() {
            "ffmpeg failed to download the HLS video.".to_string()
        } else {
            format!("ffmpeg failed to download the HLS video: {details}")
        });
    }

    if !temp.exists() || temp.metadata().map(|metadata| metadata.len()).unwrap_or(0) == 0 {
        let _ = std::fs::remove_file(&temp);
        return Err("ffmpeg completed without producing an HLS video file.".to_string());
    }

    Ok(temp)
}

fn merge_images_compact(images: &[(Url, Vec<u8>, String)]) -> Result<std::path::PathBuf, String> {
    let decoded: Vec<DynamicImage> = images
        .iter()
        .map(|(_, bytes, _)| {
            image::load_from_memory(bytes)
                .map_err(|error| format!("Failed to decode X image: {error}"))
        })
        .collect::<Result<_, _>>()?;

    if decoded.is_empty() {
        return Err("No X images to merge.".to_string());
    }

    // Use the same orientation-aware strip layout as the gallery merger.
    // Mostly landscape images stack vertically; mostly portrait images sit
    // horizontally. Ties use a vertical stack.
    let image_count = decoded.len();
    let landscape_count = decoded.iter().filter(|image| image.width() > image.height()).count();
    let portrait_count = decoded.iter().filter(|image| image.height() > image.width()).count();
    let columns = if portrait_count > landscape_count { image_count } else { 1 };
    let rows = (image_count + columns - 1) / columns;
    let mut column_widths = vec![0u32; columns];
    let mut row_heights = vec![0u32; rows];
    for (index, image) in decoded.iter().enumerate() {
        let column = index % columns;
        let row = index / columns;
        column_widths[column] = column_widths[column].max(image.width());
        row_heights[row] = row_heights[row].max(image.height());
    }

    let canvas_width_u64: u64 = column_widths.iter().map(|&value| u64::from(value)).sum();
    let canvas_height_u64: u64 = row_heights.iter().map(|&value| u64::from(value)).sum();
    let canvas_width = u32::try_from(canvas_width_u64)
        .map_err(|_| "Merged X image would be too wide.".to_string())?;
    let canvas_height = u32::try_from(canvas_height_u64)
        .map_err(|_| "Merged X image would be too tall.".to_string())?;

    let mut column_offsets = vec![0u32; column_widths.len()];
    for index in 1..column_widths.len() {
        column_offsets[index] = column_offsets[index - 1].saturating_add(column_widths[index - 1]);
    }
    let mut row_offsets = vec![0u32; row_heights.len()];
    for index in 1..row_heights.len() {
        row_offsets[index] = row_offsets[index - 1].saturating_add(row_heights[index - 1]);
    }

    let mut canvas = RgbaImage::new(canvas_width, canvas_height);
    for (index, image) in decoded.into_iter().enumerate() {
        let column = index % columns;
        let row = index / columns;
        let rgba = image.to_rgba8();
        let x = column_offsets[column]
            .saturating_add((column_widths[column].saturating_sub(rgba.width())) / 2);
        let y = row_offsets[row]
            .saturating_add((row_heights[row].saturating_sub(rgba.height())) / 2);
        image::imageops::overlay(&mut canvas, &rgba, i64::from(x), i64::from(y));
    }

    // Preserve the full composed resolution; merged images are no longer
    // automatically reduced to half size.
    let output = canvas;

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("x-merged-{unique}.png"));
    DynamicImage::ImageRgba8(output)
        .save(&temp)
        .map_err(|error| format!("Failed to save merged X image: {error}"))?;
    Ok(temp)
}

fn attach_source_and_artist(
    connection: &mut rusqlite::Connection,
    media_id: i64,
    page_url: &Url,
    post_id: &str,
    artist: &str,
) -> Result<(), String> {
    attach_source_and_artist_for_site(connection, media_id, page_url, post_id, artist, "x.com")
}

fn attach_source_and_artist_for_site(
    connection: &mut rusqlite::Connection,
    media_id: i64,
    page_url: &Url,
    post_id: &str,
    artist: &str,
    site: &str,
) -> Result<(), String> {
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO sources(media_id,site,post_id,url,imported_at) VALUES(?1,?2,?3,?4,datetime('now'))", params![media_id, site, post_id, page_url.as_str()]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO tags(name,category) VALUES(?1,'artist') ON CONFLICT(name,category) DO NOTHING", params![artist]).map_err(|e| e.to_string())?;
    let tag_id: i64 = tx.query_row("SELECT id FROM tags WHERE name=?1 COLLATE NOCASE AND category='artist' COLLATE NOCASE", params![artist], |row| row.get(0)).map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO media_tags(media_id,tag_id) VALUES(?1,?2)", params![media_id, tag_id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn attach_metadata_tag(connection: &mut rusqlite::Connection, media_id: i64, name: &str) -> Result<(), String> {
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO tags(name,category) VALUES(?1,'metadata') ON CONFLICT(name,category) DO NOTHING", [name]).map_err(|e| e.to_string())?;
    let tag_id: i64 = tx.query_row("SELECT id FROM tags WHERE name=?1 COLLATE NOCASE AND category='metadata' COLLATE NOCASE", [name], |row| row.get(0)).map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO media_tags(media_id,tag_id) VALUES(?1,?2)", params![media_id, tag_id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}


#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReimportResult {
    media_updated: bool,
    metadata_updated: bool,
    tag_count: usize,
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(hex::encode(hasher.finalize()))
}

fn reimport_media_dir(root: &Path, media_type: &str) -> PathBuf {
    root.join("media").join(if media_type == "video" { "videos" } else { "images" })
}

#[tauri::command]
pub fn reimport_media(
    media_id: i64,
    media: bool,
    metadata: bool,
    state: tauri::State<'_, AppState>,
) -> Result<ReimportResult, String> {
    if !media && !metadata { return Err("Select Media, Metadata, or both.".to_string()); }
    let root = state.library_path.lock().map_err(|_| "Failed to access library path.".to_string())?
        .clone().ok_or_else(|| "Open a library before reimporting.".to_string())?;
    let mut library = state.library_connection.lock().map_err(|_| "Failed to access library database.".to_string())?;
    let connection = library.as_mut().ok_or_else(|| "Open a library before reimporting.".to_string())?;
    let (source_url, old_stored, old_type): (String, String, String) = connection.query_row(
        "SELECT s.url,m.stored_filename,m.media_type FROM media m JOIN sources s ON s.media_id=m.id WHERE m.id=?1 ORDER BY s.id DESC LIMIT 1",
        [media_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(|e| e.to_string())?.ok_or_else(|| "This item has no source link to reimport.".to_string())?;
    let page_url = Url::parse(&source_url).map_err(|e| format!("Invalid source URL: {e}"))?;
    let host = page_url.host_str().unwrap_or_default().to_ascii_lowercase();
    let site = if matches!(host.as_str(), "danbooru.donmai.us" | "www.danbooru.donmai.us") {
        BooruSite::Danbooru
    } else if matches!(host.as_str(), "gelbooru.com" | "www.gelbooru.com") {
        BooruSite::Gelbooru
    } else if matches!(host.as_str(), "rule34.xxx" | "www.rule34.xxx") {
        BooruSite::Rule34
    } else {
        return Err("Reimport currently supports Rule34, Danbooru, and Gelbooru source links.".to_string());
    };
    let client = Client::builder().user_agent("Rule34Library/0.1 (+local desktop importer)").build().map_err(|e| e.to_string())?;
    let html = client.get(page_url.clone()).send().map_err(|e| format!("Failed to fetch source page: {e}"))?
        .error_for_status().map_err(|e| format!("Source page returned an error: {e}"))?.text().map_err(|e| e.to_string())?;
    let parsed = match site {
        BooruSite::Rule34 => parse_rule34_page(page_url.clone(), &html)?,
        BooruSite::Danbooru => parse_danbooru_page(page_url.clone(), &html)?,
        BooruSite::Gelbooru => parse_gelbooru_page(page_url.clone(), &html)?,
    };

    let mut new_file: Option<(PathBuf, String, String, String, Option<i64>, Option<i64>, i64)> = None;
    if media {
        let response = client.get(parsed.media_url.clone()).header(REFERER, parsed.page_url.as_str()).send()
            .map_err(|e| format!("Failed to download media: {e}"))?.error_for_status().map_err(|e| format!("Media download returned an error: {e}"))?;
        let content_type = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
        let bytes = response.bytes().map_err(|e| e.to_string())?;
        if bytes.is_empty() { return Err("The source returned an empty media file.".to_string()); }
        let extension = media_extension(&parsed.media_url, &content_type)?;
        let media_type = match extension.as_str() {
            "jpg"|"jpeg"|"png"|"webp"|"bmp"|"avif" => "image",
            _ => "video",
        }.to_string();
        let temp = std::env::temp_dir().join(format!("reimport-{media_id}-{}.{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos(), extension));
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        let dimensions = if media_type == "image" {
            let reader = image::ImageReader::open(&temp).map_err(|e| format!("Downloaded image could not be opened: {e}"))?
                .with_guessed_format().map_err(|e| format!("Downloaded image format could not be detected: {e}"))?;
            let decoded = reader.decode().map_err(|e| format!("Downloaded image is invalid: {e}"))?;
            Some((i64::from(decoded.width()), i64::from(decoded.height())))
        } else { None };
        let hash = sha256_file(&temp)?;
        let duplicate: Option<i64> = connection.query_row("SELECT id FROM media WHERE hash=?1 AND id<>?2", params![hash, media_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        if duplicate.is_some() { let _=fs::remove_file(&temp); return Err("The reimported media already exists as another library item.".to_string()); }
        let stored = format!("{hash}.{extension}");
        let dir = reimport_media_dir(&root, &media_type); fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = dir.join(&stored); fs::rename(&temp, &dest).or_else(|_| { fs::copy(&temp,&dest).map(|_|()).and_then(|_|fs::remove_file(&temp)) }).map_err(|e| e.to_string())?;
        let metadata_on_disk = fs::metadata(&dest).map_err(|e| format!("Reimported file was not written to the library: {e}"))?;
        if !metadata_on_disk.is_file() || metadata_on_disk.len() == 0 {
            let _ = fs::remove_file(&dest);
            return Err("Reimported file validation failed after it was written to the library.".to_string());
        }
        let size = metadata_on_disk.len() as i64;
        new_file = Some((dest, hash, stored, media_type, dimensions.map(|d|d.0), dimensions.map(|d|d.1), size));
    }

    let tx = connection.transaction().map_err(|e| e.to_string())?;
    if let Some((_, hash, stored, media_type, width, height, size)) = &new_file {
        let extension = Path::new(stored).extension().and_then(|v|v.to_str()).unwrap_or("");
        tx.execute("UPDATE media SET hash=?1,stored_filename=?2,extension=?3,media_type=?4,width=?5,height=?6,filesize=?7 WHERE id=?8",
            params![hash,stored,extension,media_type,width,height,size,media_id]).map_err(|e|e.to_string())?;
    }
    if metadata {
        tx.execute("DELETE FROM media_tags WHERE media_id=?1", [media_id]).map_err(|e|e.to_string())?;
        for (category,name) in &parsed.tags {
            if !is_valid_tag_name(name) { continue; }
            tx.execute("INSERT INTO tags(name,category) VALUES(?1,?2) ON CONFLICT(name,category) DO NOTHING", params![name,category]).map_err(|e|e.to_string())?;
            let tag_id:i64=tx.query_row("SELECT id FROM tags WHERE name=?1 COLLATE NOCASE AND category=?2 COLLATE NOCASE",params![name,category],|r|r.get(0)).map_err(|e|e.to_string())?;
            tx.execute("INSERT OR IGNORE INTO media_tags(media_id,tag_id) VALUES(?1,?2)",params![media_id,tag_id]).map_err(|e|e.to_string())?;
        }
    }
    if let Err(error) = tx.commit() {
        if let Some((new_path, ..)) = &new_file { let _ = fs::remove_file(new_path); }
        return Err(format!("Failed to update the library database: {error}"));
    }
    if let Some((new_path, ..)) = &new_file {
        if !new_path.is_file() || fs::metadata(new_path).map(|m| m.len()).unwrap_or(0) == 0 {
            return Err("The database was updated, but the reimported media file is missing. The original file was preserved.".to_string());
        }
        let stored_after: String = connection.query_row("SELECT stored_filename FROM media WHERE id=?1", [media_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if new_path.file_name().and_then(|v| v.to_str()) != Some(stored_after.as_str()) {
            return Err("Reimport verification failed because the database filename does not match the saved file. The original file was preserved.".to_string());
        }
        let old_path = reimport_media_dir(&root, &old_type).join(old_stored);
        if old_path != *new_path { let _ = fs::remove_file(old_path); }
    }
    Ok(ReimportResult { media_updated: media, metadata_updated: metadata, tag_count: if metadata { parsed.tags.len() } else { 0 } })
}

fn parse_danbooru_page(page_url: Url, html: &str) -> Result<ParsedPost, String> {
    let document = Html::parse_document(html);
    let mut tags = Vec::new();
    let mut seen_tags = HashSet::new();
    // Danbooru exposes both semantic list classes and numeric tag-type classes.
    // Read the numeric class from each tag row first; it is stable even when the
    // surrounding list markup changes.
    let tag_selector = Selector::parse("#tag-list li[data-tag-name], section#tag-list li[data-tag-name]").unwrap();
    for item in document.select(&tag_selector) {
        let Some(raw_name) = item.value().attr("data-tag-name") else { continue; };
        let name = raw_name.trim();
        if name.is_empty() { continue; }
        let classes: HashSet<_> = item.value().classes().collect();
        let category = if classes.contains("tag-type-1") {
            "artist"
        } else if classes.contains("tag-type-3") {
            "copyright"
        } else if classes.contains("tag-type-4") {
            "character"
        } else if classes.contains("tag-type-5") {
            "metadata"
        } else {
            "general"
        };
        let key = format!("{}\0{}", category, name.to_ascii_lowercase());
        if seen_tags.insert(key) { tags.push((category.to_string(), name.to_string())); }
    }

    let media_selectors = [
        "a#image-download-link[href]",
        "a#image-resize-link[href]",
        "video#image source[src]",
        "video#image[src]",
        "img#image[data-original-file-url]",
        "img#image[data-file-url]",
        "img#image[src]",
        "meta[property='og:image'][content]",
        "meta[property='og:video'][content]",
    ];
    let mut media_src = None;
    for selector_text in media_selectors {
        let selector = Selector::parse(selector_text).unwrap();
        if let Some(node) = document.select(&selector).next() {
            media_src = node.value().attr("href")
                .or_else(|| node.value().attr("src"))
                .or_else(|| node.value().attr("data-original-file-url"))
                .or_else(|| node.value().attr("data-file-url"))
                .or_else(|| node.value().attr("content"))
                .map(str::to_string);
            if media_src.is_some() { break; }
        }
    }
    let media_src = media_src.ok_or_else(|| "Could not find the original Danbooru image or video on the post page.".to_string())?;
    let media_url = page_url.join(&media_src).map_err(|e| format!("Invalid media URL: {e}"))?;
    let post_id = page_url.path_segments().into_iter().flatten().nth(1).unwrap_or(page_url.path()).to_string();
    Ok(ParsedPost { page_url, media_url, tags, post_id })
}

fn parse_gelbooru_page(page_url: Url, html: &str) -> Result<ParsedPost, String> {
    let document = Html::parse_document(html);
    let anchor_selector = Selector::parse("a[href]").unwrap();
    let mut tags = Vec::new();
    let mut seen_tags = HashSet::new();

    for (class_name, category) in [
        ("tag-type-artist", "artist"),
        ("tag-type-copyright", "copyright"),
        ("tag-type-character", "character"),
        ("tag-type-general", "general"),
        ("tag-type-metadata", "metadata"),
    ] {
        let selector = Selector::parse(&format!("#tag-list li.{class_name}")).unwrap();
        for item in document.select(&selector) {
            let name = item
                .select(&anchor_selector)
                .find(|anchor| {
                    anchor.value().attr("href").map(|href| {
                        href.contains("page=post") && href.contains("s=list") && href.contains("tags=")
                    }).unwrap_or(false)
                })
                .map(|anchor| anchor.text().collect::<String>().trim().to_string());
            let Some(name) = name else { continue; };
            if name.is_empty() { continue; }
            let canonical = item
                .select(&anchor_selector)
                .find_map(|anchor| anchor.value().attr("href"))
                .and_then(|href| Url::parse(&format!("https://gelbooru.com/{href}")).ok())
                .and_then(|url| url.query_pairs().find(|(key, _)| key == "tags").map(|(_, value)| value.into_owned()))
                .unwrap_or_else(|| name.replace(' ', "_"));
            let key = format!("{}\0{}", category, canonical.to_ascii_lowercase());
            if seen_tags.insert(key) { tags.push((category.to_string(), canonical)); }
        }
    }

    let original_link = document.select(&anchor_selector).find_map(|anchor| {
        let href = anchor.value().attr("href")?;
        let text = anchor.text().collect::<String>().trim().to_ascii_lowercase();
        let lower = href.to_ascii_lowercase();
        let looks_like_media = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov", ".m4v"]
            .iter().any(|ext| lower.split(['?', '#']).next().unwrap_or(&lower).ends_with(ext));
        ((text.contains("original image") || looks_like_media) && !lower.contains("thumbnail")).then(|| href.to_string())
    });

    let media_src = original_link.or_else(|| {
        for selector_text in ["video source[src]", "video[src]", "img#image[src]", "meta[property='og:video'][content]", "meta[property='og:image'][content]"] {
            let selector = Selector::parse(selector_text).unwrap();
            if let Some(node) = document.select(&selector).next() {
                if let Some(value) = node.value().attr("src").or_else(|| node.value().attr("content")) {
                    return Some(value.to_string());
                }
            }
        }
        None
    }).ok_or_else(|| "Could not find the original Gelbooru image or video on the post page.".to_string())?;

    let media_url = page_url.join(&media_src).map_err(|e| format!("Invalid media URL: {e}"))?;
    let post_id = page_url.query_pairs().find(|(key, _)| key == "id")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(|| "Could not determine the Gelbooru post ID.".to_string())?;
    Ok(ParsedPost { page_url, media_url, tags, post_id })
}

fn parse_rule34_page(page_url: Url, html: &str) -> Result<ParsedPost, String> {
    let document = Html::parse_document(html);
    let tag_selector = Selector::parse("li.tag").unwrap();
    let anchor_selector = Selector::parse("a").unwrap();
    let image_selector = Selector::parse("img#image[src]").unwrap();
    let source_selector = Selector::parse("source[src]").unwrap();
    let video_selector = Selector::parse("video[src]").unwrap();
    let link_selector = Selector::parse("a[href]").unwrap();

    let mut tags = Vec::new();
    let mut seen_tags = HashSet::new();
    for item in document.select(&tag_selector) {
        let category = item
            .value()
            .classes()
            .find_map(|class| class.strip_prefix("tag-type-"))
            .map(str::to_string);
        let name = item
            .select(&anchor_selector)
            .nth(1)
            .map(|a| a.text().collect::<String>().trim().to_string());
        if let (Some(category), Some(name)) = (category, name) {
            if !name.is_empty() {
                let key = format!("{}\0{}", category.to_ascii_lowercase(), name.to_ascii_lowercase());
                if seen_tags.insert(key) {
                    tags.push((category, name));
                }
            }
        }
    }

    let original_media_link = document
        .select(&link_selector)
        .filter_map(|node| {
            let href = node.value().attr("href")?;
            let label = node.text().collect::<String>();
            if label.trim().eq_ignore_ascii_case("Original image")
                && is_rule34_media_url(&page_url, href)
            {
                Some(href.to_string())
            } else {
                None
            }
        })
        .next();

    let image = document.select(&image_selector).next();
    let image_src = image
        .as_ref()
        .and_then(|node| node.value().attr("src"))
        .map(str::to_string);
    let image_is_animated_gif = image
        .as_ref()
        .and_then(|node| node.value().attr("alt"))
        .map(has_gif_tag)
        .unwrap_or(false);

    // Rule34 displays animated GIF posts as sample JPEGs until Post.highres()
    // runs in the browser. The desktop importer does not execute page JavaScript,
    // so resolve the original GIF URL directly instead of downloading the sample.
    let mut media_src = if image_is_animated_gif {
        original_media_link
            .as_ref()
            .filter(|href| media_url_has_extension(&page_url, href, &["gif"]))
            .cloned()
            .or_else(|| extract_rule34_url_with_extensions(html, &["gif"]))
            .or_else(|| image_src.as_deref().and_then(|src| derive_original_gif_url(&page_url, src)))
    } else {
        image_src.clone()
    };

    // Video markup differs between the raw response and browser-saved DOM. Scan all
    // <source> and <video src> attributes, but only accept actual media URLs from
    // Rule34-owned hosts so ad-player videos cannot be imported accidentally.
    if media_src.is_none() {
        media_src = document
            .select(&source_selector)
            .filter_map(|node| node.value().attr("src"))
            .find(|src| is_rule34_video_url(&page_url, src))
            .map(str::to_string);
    }
    if media_src.is_none() {
        media_src = document
            .select(&video_selector)
            .filter_map(|node| node.value().attr("src"))
            .find(|src| is_rule34_video_url(&page_url, src))
            .map(str::to_string);
    }

    // Rule34 exposes the original file in the Options panel. This is also useful
    // when its player or full-resolution image is generated by JavaScript.
    if media_src.is_none() {
        media_src = original_media_link;
    }

    // Last resort for HTML variants where the URL only appears inside a script or
    // escaped markup.
    if media_src.is_none() {
        media_src = extract_rule34_media_url(html);
    }

    let media_src = media_src.ok_or_else(|| {
        "Could not find a Rule34 image, video source, original-file link, or embedded media URL on the post page.".to_string()
    })?;
    let media_url = page_url
        .join(&media_src)
        .map_err(|e| format!("Invalid media URL: {e}"))?;
    let post_id = page_url
        .query_pairs()
        .find(|(key, _)| key == "id")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| page_url.path().to_string());
    Ok(ParsedPost { page_url, media_url, tags, post_id })
}

fn has_gif_tag(alt: &str) -> bool {
    alt.split_whitespace()
        .any(|tag| tag.eq_ignore_ascii_case("gif") || tag.eq_ignore_ascii_case("animated_gif"))
}

fn media_url_has_extension(page_url: &Url, raw: &str, extensions: &[&str]) -> bool {
    let Ok(url) = page_url.join(raw) else { return false; };
    let Some(extension) = Path::new(url.path()).extension().and_then(|value| value.to_str()) else {
        return false;
    };
    extensions.iter().any(|allowed| extension.eq_ignore_ascii_case(allowed))
}

fn derive_original_gif_url(page_url: &Url, sample_src: &str) -> Option<String> {
    let sample_url = page_url.join(sample_src).ok()?;
    let binding = sample_url.clone();
    let segments: Vec<&str> = binding.path_segments()?.collect();
    let samples_index = segments.iter().position(|segment| *segment == "samples")?;
    let folder = *segments.get(samples_index + 1)?;
    let sample_filename = *segments.get(samples_index + 2)?;
    let hash = sample_filename
        .strip_prefix("sample_")?
        .rsplit_once('.')?
        .0;
    if hash.is_empty() {
        return None;
    }

    let mut original = sample_url;
    original.set_host(Some("wimg.rule34.xxx")).ok()?;
    original.set_path(&format!("/images/{folder}/{hash}.gif"));
    original.set_query(None);
    original.set_fragment(None);
    Some(original.to_string())
}

fn is_rule34_media_url(page_url: &Url, raw: &str) -> bool {
    let Ok(url) = page_url.join(raw) else { return false; };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let owned_host = host == "rule34.xxx"
        || host.ends_with(".rule34.xxx")
        || host == "rule34hentai.net"
        || host.ends_with(".rule34hentai.net");
    if !owned_host {
        return false;
    }
    matches!(
        Path::new(url.path())
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "mp4" | "webm" | "mov" | "m4v")
    )
}

fn is_rule34_video_url(page_url: &Url, raw: &str) -> bool {
    if !is_rule34_media_url(page_url, raw) {
        return false;
    }
    let Ok(url) = page_url.join(raw) else { return false; };
    matches!(
        Path::new(url.path())
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("mp4" | "webm" | "mov" | "m4v")
    )
}

fn extract_rule34_media_url(html: &str) -> Option<String> {
    extract_rule34_url_with_extensions(html, &["mp4", "webm", "mov", "m4v"])
}

fn extract_rule34_url_with_extensions(html: &str, extensions: &[&str]) -> Option<String> {
    let mut offset = 0;
    while let Some(relative_start) = html[offset..].find("https://") {
        let start = offset + relative_start;
        let remainder = &html[start..];
        let end = remainder
            .find(|ch: char| matches!(ch, '"' | '\'' | '<' | '>' | ' ' | '\n' | '\r' | '\t'))
            .unwrap_or(remainder.len());
        let candidate = remainder[..end].replace("&amp;", "&");
        if let Ok(url) = Url::parse(&candidate) {
            let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
            let owned_host = host == "rule34.xxx" || host.ends_with(".rule34.xxx");
            let matching_extension = Path::new(url.path())
                .extension()
                .and_then(|value| value.to_str())
                .map(|extension| extensions.iter().any(|allowed| extension.eq_ignore_ascii_case(allowed)))
                .unwrap_or(false);
            if owned_host && matching_extension {
                return Some(candidate);
            }
        }
        offset = start + "https://".len();
    }
    None
}

fn media_extension(url: &Url, content_type: &str) -> Result<String, String> {
    if let Some(ext) = Path::new(url.path()).extension().and_then(|v| v.to_str()).map(|v| v.to_ascii_lowercase()) {
        if matches!(ext.as_str(), "jpg"|"jpeg"|"png"|"gif"|"webp"|"bmp"|"mp4"|"webm"|"mov"|"m4v") { return Ok(ext); }
    }
    let ext = match content_type.split(';').next().unwrap_or("") {
        "image/jpeg" => "jpg", "image/png" => "png", "image/gif" => "gif", "image/webp" => "webp",
        "video/mp4" => "mp4", "video/webm" => "webm", "video/quicktime" => "mov",
        _ => return Err(format!("Unsupported downloaded media type: {content_type}")),
    };
    Ok(ext.to_string())
}

#[tauri::command]
pub fn list_import_queue(state: tauri::State<'_, AppState>) -> Result<Vec<ImportJob>, String> {
    Ok(state.import_queue.lock().map_err(|_| "Failed to access import queue.".to_string())?.iter().cloned().collect())
}
