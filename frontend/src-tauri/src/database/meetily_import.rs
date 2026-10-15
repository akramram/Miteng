//! One-time import of meetings from the app Miteng was built from.
//!
//! Meetily stored its data under `<OS data dir>/Meetily` (macOS:
//! `~/Library/Application Support/Meetily`); Miteng uses `.../Miteng`. On the
//! first start after this import exists, every meeting, transcript, note,
//! person, group and action item from the Meetily database is merged into
//! Miteng's database, and the speech models, templates and voice prints are
//! copied over. Rows Miteng already has (same id) win, so Miteng's own
//! meetings and settings are never overwritten. Recordings are not moved: the
//! imported meetings keep pointing at their audio folders.
//!
//! The Meetily files are only read. The import works from a `VACUUM INTO`
//! snapshot, which is consistent even if Meetily is running, and brings that
//! snapshot up to Miteng's schema with the normal migrations before merging.
//! A marker file makes it run once; on failure it logs and retries next start.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Connection, Row, SqlitePool};
use std::path::{Path, PathBuf};

use super::manager::DatabaseManager;

const MARKER: &str = ".imported_from_meetily";
const SNAPSHOT: &str = ".meetily-import.sqlite";
/// Data folder name of the previous app under the OS data directory.
const PREVIOUS_APP_DIR: &str = "Meetily";
/// Bookkeeping that must stay Miteng's own.
const SKIPPED_TABLES: [&str; 2] = ["_sqlx_migrations", "licensing"];
/// App-managed folders worth bringing along; copied file by file when missing.
const COPIED_DIRS: [&str; 3] = ["models", "templates", "voiceprint"];

fn previous_root() -> Option<PathBuf> {
    let root = dirs::data_dir()?.join(PREVIOUS_APP_DIR);
    (root != crate::paths::install_data_root()).then_some(root)
}

/// Merge the previous install into `pool` once. Never fails the caller.
pub async fn import_previous_install(pool: &SqlitePool) {
    let root = crate::paths::install_data_root();
    let marker = root.join(MARKER);
    if marker.exists() {
        return;
    }
    let Some(previous) = previous_root() else {
        let _ = std::fs::write(&marker, b"no-previous-install");
        return;
    };
    let previous_db = previous.join("meeting_minutes.sqlite");
    if !previous_db.is_file() {
        let _ = std::fs::write(&marker, b"no-previous-install");
        return;
    }

    log::info!("Importing meetings from previous install at {}", previous.display());
    let snapshot = root.join(SNAPSHOT);
    let result = merge_database(pool, &previous_db, &snapshot).await;
    let _ = std::fs::remove_file(&snapshot);
    match result {
        Ok(meetings) => {
            for dir in COPIED_DIRS {
                if let Err(error) = crate::paths::copy_missing(&previous.join(dir), &root.join(dir)) {
                    log::warn!("Could not copy '{}' from previous install: {}", dir, error);
                }
            }
            log::info!("Imported {} meetings from {}", meetings, previous.display());
            let _ = std::fs::write(&marker, format!("imported {meetings} meetings"));
        }
        Err(error) => log::warn!("Import from previous install failed, will retry next start: {}", error),
    }
}

/// Returns how many meetings were added.
async fn merge_database(pool: &SqlitePool, previous_db: &Path, snapshot: &Path) -> sqlx::Result<i64> {
    let _ = std::fs::remove_file(snapshot);
    {
        let mut source = sqlx::SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(previous_db).read_only(true),
        )
        .await?;
        sqlx::query("VACUUM INTO ?")
            .bind(snapshot.to_string_lossy().as_ref())
            .execute(&mut source)
            .await?;
        source.close().await?;
    }
    {
        // Bring an older Meetily schema up to Miteng's before comparing columns.
        let snapshot_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(snapshot))
            .await?;
        DatabaseManager::run_migrations(&snapshot_pool).await?;
        snapshot_pool.close().await;
    }

    let mut conn = pool.acquire().await?;
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings").fetch_one(&mut *conn).await?;
    // Rows are copied table by table, so parents may arrive after children.
    sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut *conn).await?;
    sqlx::query("ATTACH DATABASE ? AS previous")
        .bind(snapshot.to_string_lossy().as_ref())
        .execute(&mut *conn)
        .await?;

    let merged = copy_tables(&mut conn).await;

    let _ = sqlx::query("DETACH DATABASE previous").execute(&mut *conn).await;
    let _ = sqlx::query("PRAGMA foreign_keys = ON").execute(&mut *conn).await;
    merged?;

    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings").fetch_one(&mut *conn).await?;
    Ok(after - before)
}

async fn copy_tables(conn: &mut sqlx::SqliteConnection) -> sqlx::Result<()> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(&mut *conn)
    .await?;

    let mut tx = conn.begin().await?;
    for table in tables.iter().filter(|t| !SKIPPED_TABLES.contains(&t.as_str())) {
        let columns: Vec<String> = sqlx::query(
            "SELECT m.name FROM pragma_table_info(?1, 'main') AS m \
             JOIN pragma_table_info(?1, 'previous') AS p ON p.name = m.name",
        )
        .bind(table)
        .fetch_all(&mut *tx)
        .await?
        .iter()
        .map(|row| row.get::<String, _>(0))
        .collect();
        if columns.is_empty() {
            continue;
        }
        let list = columns
            .iter()
            .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        let name = table.replace('"', "\"\"");
        sqlx::query(&format!(
            "INSERT OR IGNORE INTO main.\"{name}\" ({list}) SELECT {list} FROM previous.\"{name}\""
        ))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn database(path: &Path) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(path).create_if_missing(true))
            .await
            .unwrap();
        DatabaseManager::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn add_meeting(pool: &SqlitePool, id: &str, title: &str) {
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .bind(id)
            .bind(title)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn merges_previous_meetings_without_overwriting_existing_rows() {
        let dir = tempfile::tempdir().unwrap();
        let previous_path = dir.path().join("previous.sqlite");
        let previous = database(&previous_path).await;
        add_meeting(&previous, "m-shared", "Old title").await;
        add_meeting(&previous, "m-old", "Only in Meetily").await;
        previous.close().await;

        let current = database(&dir.path().join("current.sqlite")).await;
        add_meeting(&current, "m-shared", "Miteng title").await;
        add_meeting(&current, "m-new", "Only in Miteng").await;

        let added = merge_database(&current, &previous_path, &dir.path().join("snap.sqlite"))
            .await
            .unwrap();

        assert_eq!(added, 1);
        let titles: Vec<(String, String)> = sqlx::query_as("SELECT id, title FROM meetings ORDER BY id")
            .fetch_all(&current)
            .await
            .unwrap();
        assert_eq!(
            titles,
            vec![
                ("m-new".into(), "Only in Miteng".into()),
                ("m-old".into(), "Only in Meetily".into()),
                ("m-shared".into(), "Miteng title".into()),
            ]
        );
        let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&current).await.unwrap();
        assert_eq!(fk, 1, "foreign keys must be back on after the merge");
    }
}
