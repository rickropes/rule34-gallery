use anyhow::Result;
use directories::ProjectDirs;
use rusqlite::Connection;
use std::fs;

pub fn open_database() -> Result<Connection> {
    let dirs = ProjectDirs::from("com", "Rick", "Rule34Library")
        .expect("Could not determine application directory");

    let data_dir = dirs.data_dir();

    fs::create_dir_all(data_dir)?;

    let db_path = data_dir.join("library.db");

    let connection = Connection::open(db_path)?;

    Ok(connection)
}