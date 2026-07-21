use std::path::Path;

use rusqlite::{Connection, Result};

pub fn open_library_database(
    library_path: &Path,
) -> Result<Connection> {
    let database_path = library_path
        .join("metadata")
        .join("library.db");

    let connection = Connection::open(database_path)?;

    connection.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT NOT NULL UNIQUE,
            original_filename TEXT,
            stored_filename TEXT NOT NULL,
            extension TEXT NOT NULL,
            media_type TEXT NOT NULL CHECK (
                media_type IN ('image', 'video')
            ),
            width INTEGER,
            height INTEGER,
            filesize INTEGER NOT NULL DEFAULT 0,
            favorite INTEGER NOT NULL DEFAULT 0 CHECK (
                favorite IN (0, 1)
            ),
            added_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'general',
            UNIQUE(name, category)
        );

        CREATE TABLE IF NOT EXISTS media_tags (
            media_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,

            PRIMARY KEY (media_id, tag_id),

            FOREIGN KEY (media_id)
                REFERENCES media(id)
                ON DELETE CASCADE,

            FOREIGN KEY (tag_id)
                REFERENCES tags(id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            collection_type TEXT NOT NULL,
            title TEXT NOT NULL,
            source_url TEXT NOT NULL,
            source_external_id TEXT NOT NULL,
            cover_media_id INTEGER UNIQUE,
            created_at TEXT NOT NULL,
            UNIQUE(collection_type, source_external_id),
            FOREIGN KEY (cover_media_id) REFERENCES media(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS collection_pages (
            collection_id INTEGER NOT NULL,
            media_id INTEGER NOT NULL UNIQUE,
            page_number INTEGER NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (collection_id, position),
            FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
            FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id INTEGER NOT NULL,
            site TEXT NOT NULL,
            post_id TEXT NOT NULL,
            url TEXT NOT NULL,
            imported_at TEXT NOT NULL,

            FOREIGN KEY (media_id)
                REFERENCES media(id)
                ON DELETE CASCADE,

            UNIQUE(media_id, site, post_id)
        );

        CREATE INDEX IF NOT EXISTS idx_media_added_at
            ON media(added_at);

        CREATE INDEX IF NOT EXISTS idx_media_favorite
            ON media(favorite);

        CREATE INDEX IF NOT EXISTS idx_tags_name
            ON tags(name);
        
        CREATE INDEX IF NOT EXISTS idx_tags_name_category
            ON tags(name, category);

        CREATE INDEX IF NOT EXISTS idx_sources_post
            ON sources(site, post_id);

        CREATE INDEX IF NOT EXISTS idx_media_tags_media
            ON media_tags(media_id);

        CREATE INDEX IF NOT EXISTS idx_collection_pages_media
            ON collection_pages(media_id);
        "#,
    )?;

    // Keep libraries created by the browser-pool prototype compatible with
    // the generic collection schema used by earlier collection builds.
    let collection_columns: Vec<String> = {
        let mut statement = connection.prepare("PRAGMA table_info(collections)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>>>()?;
        columns
    };
    if !collection_columns.iter().any(|name| name == "source_external_id") {
        connection.execute(
            "ALTER TABLE collections ADD COLUMN source_external_id TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    let page_columns: Vec<String> = {
        let mut statement = connection.prepare("PRAGMA table_info(collection_pages)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>>>()?;
        columns
    };
    if !page_columns.iter().any(|name| name == "page_number") {
        connection.execute(
            "ALTER TABLE collection_pages ADD COLUMN page_number INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }

    // Older libraries allowed only one source row for an entire post, which
    // prevented the same X post link being attached to every imported asset.
    let sources_sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='sources'",
            [],
            |row| row.get(0),
        )
        .ok();
    if sources_sql
        .as_deref()
        .map(|sql| sql.chars().filter(|ch| !ch.is_whitespace()).collect::<String>().contains("UNIQUE(site,post_id)"))
        .unwrap_or(false)
    {
        connection.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;
            BEGIN;
            CREATE TABLE sources_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                media_id INTEGER NOT NULL,
                site TEXT NOT NULL,
                post_id TEXT NOT NULL,
                url TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
                UNIQUE(media_id, site, post_id)
            );
            INSERT OR IGNORE INTO sources_new(id,media_id,site,post_id,url,imported_at)
                SELECT id,media_id,site,post_id,url,imported_at FROM sources;
            DROP TABLE sources;
            ALTER TABLE sources_new RENAME TO sources;
            CREATE INDEX IF NOT EXISTS idx_sources_post ON sources(site, post_id);
            COMMIT;
            PRAGMA foreign_keys = ON;
            "#,
        )?;
    }

    Ok(connection)
}