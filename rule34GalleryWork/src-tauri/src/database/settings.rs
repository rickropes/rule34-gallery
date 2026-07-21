use anyhow::Result;
use rusqlite::{params, Connection};

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT value FROM settings WHERE key = ?1"
    )?;

    let mut rows = stmt.query(params![key])?;

    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn set_setting(
    conn: &Connection,
    key: &str,
    value: &str,
) -> Result<()> {
    conn.execute(
        "
        INSERT INTO settings(key, value)
        VALUES(?1, ?2)
        ON CONFLICT(key)
        DO UPDATE SET value = excluded.value
        ",
        params![key, value],
    )?;

    Ok(())
}