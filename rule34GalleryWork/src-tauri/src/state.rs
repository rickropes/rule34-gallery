use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{atomic::AtomicU64, Mutex},
};

use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub id: u64,
    pub url: String,
    pub status: String,
    pub message: Option<String>,
}

pub struct AppState {
    pub settings_connection: Mutex<Connection>,
    pub library_connection: Mutex<Option<Connection>>,
    pub library_path: Mutex<Option<PathBuf>>,
    pub import_queue: Mutex<VecDeque<ImportJob>>,
    pub next_import_id: AtomicU64,
}
