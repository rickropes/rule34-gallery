pub mod connection;
pub mod schema;
pub mod settings;
pub mod library;

use anyhow::Result;
use rusqlite::Connection;

pub fn initialize() -> Result<Connection> {
    let conn = connection::open_database()?;

    schema::create_schema(&conn)?;

    Ok(conn)
}