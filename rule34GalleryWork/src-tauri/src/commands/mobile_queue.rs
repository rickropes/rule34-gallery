use std::{thread, time::Duration};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use crate::{database::settings, state::AppState};
use super::import_server::{enqueue_import_with_refresh, ImportRequest};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QueueEntry { id: String, url: String, #[serde(default)] created_at: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileQueueSettings { endpoint: String, token: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSyncResult { fetched: usize, imported: usize, failed: usize, messages: Vec<String> }

#[tauri::command]
pub fn get_mobile_queue_settings(state: tauri::State<'_, AppState>) -> Result<MobileQueueSettings, String> {
    let conn = state.settings_connection.lock().map_err(|_| "Failed to access settings.".to_string())?;
    Ok(MobileQueueSettings {
        endpoint: settings::get_setting(&conn, "mobile_queue_endpoint").map_err(|e| e.to_string())?.unwrap_or_default(),
        token: settings::get_setting(&conn, "mobile_queue_token").map_err(|e| e.to_string())?.unwrap_or_default(),
    })
}

#[tauri::command]
pub fn set_mobile_queue_settings(endpoint: String, token: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if !endpoint.trim().is_empty() { Url::parse(endpoint.trim()).map_err(|e| format!("Invalid endpoint URL: {e}"))?; }
    let conn = state.settings_connection.lock().map_err(|_| "Failed to access settings.".to_string())?;
    settings::set_setting(&conn, "mobile_queue_endpoint", endpoint.trim()).map_err(|e| e.to_string())?;
    settings::set_setting(&conn, "mobile_queue_token", token.trim()).map_err(|e| e.to_string())?;
    Ok(())
}

fn resolve_x(url: &str) -> Result<(String, Vec<String>, Vec<String>), String> {
    let parsed = Url::parse(url).map_err(|e| e.to_string())?;
    let id = parsed.path_segments().and_then(|mut s| {
        let v: Vec<_> = s.by_ref().collect();
        v.windows(2).find(|p| p[0] == "status").map(|p| p[1].to_string())
    }).ok_or_else(|| "Could not find X post id.".to_string())?;
    let api = format!("https://api.fxtwitter.com/status/{id}");
    let json: Value = Client::builder().user_agent("GalleryMobileQueue/0.1").build().map_err(|e|e.to_string())?
        .get(api).send().map_err(|e|format!("X resolver request failed: {e}"))?
        .error_for_status().map_err(|e|format!("X resolver returned an error: {e}"))?
        .json().map_err(|e|format!("Invalid X resolver response: {e}"))?;
    let tweet = json.get("tweet").unwrap_or(&json);
    let artist = tweet.pointer("/author/screen_name").or_else(||tweet.pointer("/author/name"))
        .and_then(Value::as_str).unwrap_or("unknown").trim_start_matches('@').to_string();

    let mut urls = Vec::new();
    let mut types = Vec::new();
    let mut seen = std::collections::HashSet::new();

    fn add(urls: &mut Vec<String>, types: &mut Vec<String>, seen: &mut std::collections::HashSet<String>, raw: &str, kind: &str) {
        let key = raw.split('?').next().unwrap_or(raw).to_ascii_lowercase();
        if seen.insert(key) {
            urls.push(raw.to_string());
            types.push(kind.to_string());
        }
    }

    fn score_variant(value: &Value) -> u64 {
        let bitrate = value.get("bitrate").and_then(Value::as_u64).unwrap_or(0);
        let width = value.get("width").and_then(Value::as_u64).unwrap_or(0);
        let height = value.get("height").and_then(Value::as_u64).unwrap_or(0);
        bitrate.max(width.saturating_mul(height))
    }

    fn media_items<'a>(tweet: &'a Value) -> Vec<&'a Value> {
        for pointer in ["/media/all", "/media", "/extended_entities/media", "/legacy/extended_entities/media"] {
            if let Some(array) = tweet.pointer(pointer).and_then(Value::as_array) {
                return array.iter().collect();
            }
        }
        Vec::new()
    }

    for item in media_items(tweet) {
        let kind = item.get("type").or_else(|| item.get("kind")).and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
        let is_video = kind.contains("video") || kind.contains("gif") || item.get("variants").is_some() || item.pointer("/video_info/variants").is_some();
        if is_video {
            let variants = item.get("variants").or_else(|| item.pointer("/video_info/variants")).and_then(Value::as_array);
            let best = variants.and_then(|variants| variants.iter()
                .filter(|v| {
                    let u = v.get("url").and_then(Value::as_str).unwrap_or("");
                    let ct = v.get("content_type").or_else(||v.get("contentType")).and_then(Value::as_str).unwrap_or("");
                    u.contains("video.twimg.com") && (u.contains(".mp4") || ct.starts_with("video/"))
                })
                .max_by_key(|v| score_variant(v))
                .and_then(|v| v.get("url").and_then(Value::as_str)));
            let fallback = item.get("url").or_else(||item.get("video_url")).and_then(Value::as_str);
            if let Some(u) = best.or(fallback) {
                let media_kind = if kind.contains("gif") { "animated_gif" } else { "video" };
                add(&mut urls, &mut types, &mut seen, u, media_kind);
            }
        } else if let Some(u) = item.get("url").or_else(||item.get("media_url_https")).and_then(Value::as_str) {
            if u.contains("pbs.twimg.com") { add(&mut urls, &mut types, &mut seen, u, "image"); }
        }
    }

    // FxTwitter commonly exposes already-normalized arrays. Read those only
    // as a fallback, without recursively walking quoted tweets or replies.
    if urls.is_empty() {
        if let Some(images) = tweet.pointer("/media/photos").and_then(Value::as_array) {
            for image in images {
                if let Some(u)=image.get("url").and_then(Value::as_str) { add(&mut urls,&mut types,&mut seen,u,"image"); }
            }
        }
        if let Some(videos) = tweet.pointer("/media/videos").and_then(Value::as_array) {
            for video in videos {
                if let Some(u)=video.get("url").and_then(Value::as_str) {
                    let kind = video.get("type").or_else(|| video.get("kind")).and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
                    add(&mut urls,&mut types,&mut seen,u,if kind.contains("gif") { "animated_gif" } else { "video" });
                }
            }
        }
    }

    if urls.is_empty(){ return Err("X resolver returned no downloadable media.".into()); }
    Ok((artist, urls, types))
}

fn wait_for_job(app:&AppHandle,id:u64)->Result<String,String>{
    for _ in 0..600 {
        if let Ok(queue)=app.state::<AppState>().import_queue.lock() {
            if let Some(job)=queue.iter().find(|j|j.id==id) {
                if job.status=="completed" { return Ok(job.message.clone().unwrap_or_else(||"Imported".into())); }
                if job.status=="failed" { return Err(job.message.clone().unwrap_or_else(||"Import failed".into())); }
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("Import timed out.".into())
}

fn sync_mobile_queue_blocking(app: AppHandle) -> Result<MobileSyncResult, String> {
    let state=app.state::<AppState>();
    if state.library_connection.lock().map_err(|_|"Failed to access library.".to_string())?.is_none(){return Err("Open a library before syncing.".into())}
    let conn=state.settings_connection.lock().map_err(|_|"Failed to access settings.".to_string())?;
    let endpoint=settings::get_setting(&conn,"mobile_queue_endpoint").map_err(|e|e.to_string())?.unwrap_or_default();
    let token=settings::get_setting(&conn,"mobile_queue_token").map_err(|e|e.to_string())?.unwrap_or_default(); drop(conn);
    if endpoint.is_empty()||token.is_empty(){return Ok(MobileSyncResult{fetched:0,imported:0,failed:0,messages:vec!["Mobile queue is not configured.".into()]})}
    let client=Client::builder().user_agent("GalleryMobileQueue/0.1").build().map_err(|e|e.to_string())?;
    let entries:Vec<QueueEntry>=client.get(&endpoint).query(&[("action","list"),("token",token.as_str())]).send().map_err(|e|format!("Queue request failed: {e}"))?.error_for_status().map_err(|e|format!("Queue returned an error: {e}"))?.json().map_err(|e|format!("Invalid queue response: {e}"))?;
    let mut completed=Vec::new(); let mut messages=Vec::new(); let mut failed=0;
    for entry in &entries {
        let parsed=match Url::parse(&entry.url){Ok(v)=>v,Err(e)=>{failed+=1;messages.push(format!("{}: {e}",entry.url));continue}};
        let host=parsed.host_str().unwrap_or("").to_ascii_lowercase();
        let payload=if matches!(host.as_str(),"x.com"|"www.x.com"|"twitter.com"|"www.twitter.com") {
            match resolve_x(&entry.url){Ok((artist,media_urls,media_types))=>ImportRequest{url:entry.url.clone(),site:Some("x".into()),artist:Some(artist),media_urls,media_types,media_page_numbers:vec![],collection_metadata:None},Err(e)=>{failed+=1;messages.push(format!("{}: {e}",entry.url));continue}}
        } else { ImportRequest{url:entry.url.clone(),site:None,artist:None,media_urls:vec![],media_types:vec![],media_page_numbers:vec![],collection_metadata:None} };
        match enqueue_import_with_refresh(&app,payload,false).and_then(|id|wait_for_job(&app,id)) {Ok(m)=>{completed.push(entry.id.clone());messages.push(m)},Err(e)=>{failed+=1;messages.push(format!("{}: {e}",entry.url))}}
    }
    if !completed.is_empty(){
        client.post(&endpoint).json(&serde_json::json!({"action":"ack","token":token,"ids":completed})).send().map_err(|e|format!("Failed to acknowledge queue: {e}"))?.error_for_status().map_err(|e|format!("Queue acknowledgement failed: {e}"))?;
    }
    if !completed.is_empty() {
        let _ = app.emit("library-changed", ());
    }
    Ok(MobileSyncResult{fetched:entries.len(),imported:completed.len(),failed,messages})
}


pub fn start_mobile_queue_worker(app: AppHandle) {
    std::thread::spawn(move || {
        // Give startup library initialization a moment to finish, then perform
        // the single startup sync. Further syncs are explicitly triggered when
        // the gallery is opened or the Mobile queue button is pressed.
        std::thread::sleep(Duration::from_secs(2));
        if let Err(error) = sync_mobile_queue_blocking(app) {
            eprintln!("Startup mobile queue sync failed: {error}");
        }
    });
}

pub fn sync_mobile_queue_in_background(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(error) = sync_mobile_queue_blocking(app) {
            eprintln!("Gallery-open mobile queue sync failed: {error}");
        }
    });
}

#[tauri::command]
pub async fn sync_mobile_queue(app: AppHandle) -> Result<MobileSyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || sync_mobile_queue_blocking(app))
        .await
        .map_err(|error| format!("Mobile queue worker failed: {error}"))?
}
