//! Topics within one meeting. Each is a time range of the recording with its
//! own summary; time outside every range is skipped. Saving replaces the whole
//! list, so ranges are validated together.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

const MAX_TITLE_CHARS: usize = 120;
const MAX_CHAPTERS: usize = 50;
/// A topic shorter than this can't hold a useful summary.
const MIN_CHAPTER_SECONDS: f64 = 5.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub id: String,
    pub title: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// A chapter as the editor sends it; `id` is kept so a chapter's summary
/// survives edits to other chapters.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterInput {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

fn validate(inputs: Vec<ChapterInput>) -> Result<Vec<Chapter>, String> {
    if inputs.len() > MAX_CHAPTERS {
        return Err(format!("A meeting can have at most {MAX_CHAPTERS} topics"));
    }
    let mut chapters: Vec<Chapter> = Vec::with_capacity(inputs.len());
    for input in inputs {
        let title = input.title.trim();
        if title.is_empty() {
            return Err("Every topic needs a name".into());
        }
        if !input.start_seconds.is_finite() || !input.end_seconds.is_finite() || input.start_seconds < 0.0 {
            return Err(format!("\"{title}\" has an invalid time range"));
        }
        if input.end_seconds - input.start_seconds < MIN_CHAPTER_SECONDS {
            return Err(format!("\"{title}\" must end at least {MIN_CHAPTER_SECONDS:.0} seconds after it starts"));
        }
        let id = input
            .id
            .filter(|id| !id.trim().is_empty() && !chapters.iter().any(|chapter| &chapter.id == id))
            .unwrap_or_else(|| format!("chapter-{}", Uuid::new_v4()));
        chapters.push(Chapter {
            id,
            title: title.chars().take(MAX_TITLE_CHARS).collect(),
            start_seconds: input.start_seconds,
            end_seconds: input.end_seconds,
        });
    }
    chapters.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    if let Some(pair) = chapters.windows(2).find(|pair| pair[1].start_seconds < pair[0].end_seconds) {
        return Err(format!("\"{}\" and \"{}\" overlap", pair[0].title, pair[1].title));
    }
    Ok(chapters)
}

pub struct ChaptersRepository;

impl ChaptersRepository {
    pub async fn list(pool: &SqlitePool, meeting_id: &str) -> Result<Vec<Chapter>, sqlx::Error> {
        sqlx::query_as(
            "SELECT id, title, start_seconds, end_seconds FROM meeting_chapters \
             WHERE meeting_id = ? ORDER BY position",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await
    }

    pub async fn get(pool: &SqlitePool, meeting_id: &str, chapter_id: &str) -> Result<Option<Chapter>, sqlx::Error> {
        sqlx::query_as(
            "SELECT id, title, start_seconds, end_seconds FROM meeting_chapters WHERE meeting_id = ? AND id = ?",
        )
        .bind(meeting_id)
        .bind(chapter_id)
        .fetch_optional(pool)
        .await
    }

    /// Replaces the meeting's topics. An empty list removes them all.
    pub async fn replace(pool: &SqlitePool, meeting_id: &str, inputs: Vec<ChapterInput>) -> Result<Vec<Chapter>, String> {
        let chapters = validate(inputs)?;
        let mut tx = pool.begin().await.map_err(|e| format!("Failed to save topics: {e}"))?;
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| format!("Failed to save topics: {e}"))?;
        if exists.is_none() {
            return Err("Meeting not found".into());
        }
        sqlx::query("DELETE FROM meeting_chapters WHERE meeting_id = ?")
            .bind(meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Failed to save topics: {e}"))?;
        let now = Utc::now().to_rfc3339();
        for (position, chapter) in chapters.iter().enumerate() {
            sqlx::query(
                "INSERT INTO meeting_chapters (id, meeting_id, position, title, start_seconds, end_seconds, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&chapter.id)
            .bind(meeting_id)
            .bind(position as i64)
            .bind(&chapter.title)
            .bind(chapter.start_seconds)
            .bind(chapter.end_seconds)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Failed to save topics: {e}"))?;
        }
        tx.commit().await.map_err(|e| format!("Failed to save topics: {e}"))?;
        Ok(chapters)
    }
}

#[tauri::command]
pub async fn api_list_meeting_chapters(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
) -> Result<Vec<Chapter>, String> {
    ChaptersRepository::list(state.db_manager.pool(), &meeting_id)
        .await
        .map_err(|e| format!("Failed to load topics: {e}"))
}

#[tauri::command]
pub async fn api_save_meeting_chapters(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    chapters: Vec<ChapterInput>,
) -> Result<Vec<Chapter>, String> {
    ChaptersRepository::replace(state.db_manager.pool(), &meeting_id, chapters).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    fn input(id: Option<&str>, title: &str, start: f64, end: f64) -> ChapterInput {
        ChapterInput { id: id.map(str::to_string), title: title.into(), start_seconds: start, end_seconds: end }
    }

    #[tokio::test]
    async fn saving_sorts_keeps_ids_and_rejects_bad_ranges() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES ('m', 'M', 'now', 'now')")
            .execute(&pool)
            .await
            .unwrap();

        let saved = ChaptersRepository::replace(
            &pool,
            "m",
            vec![input(None, " Budget ", 600.0, 900.0), input(Some("chapter-kept"), "Hiring", 0.0, 600.0)],
        )
        .await
        .unwrap();
        assert_eq!(saved.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), ["Hiring", "Budget"]);
        assert_eq!(saved[0].id, "chapter-kept");
        assert_eq!(ChaptersRepository::list(&pool, "m").await.unwrap(), saved);

        for bad in [
            vec![input(None, "A", 0.0, 100.0), input(None, "B", 99.0, 200.0)],
            vec![input(None, "  ", 0.0, 100.0)],
            vec![input(None, "Short", 10.0, 12.0)],
            vec![input(None, "Backwards", -1.0, 100.0)],
        ] {
            assert!(ChaptersRepository::replace(&pool, "m", bad).await.is_err());
        }
        assert_eq!(ChaptersRepository::list(&pool, "m").await.unwrap(), saved, "a rejected save changes nothing");

        // Duplicate ids in one save get a fresh id instead of a primary key clash.
        let twins = ChaptersRepository::replace(
            &pool,
            "m",
            vec![input(Some("x"), "A", 0.0, 100.0), input(Some("x"), "B", 100.0, 200.0)],
        )
        .await
        .unwrap();
        assert_ne!(twins[0].id, twins[1].id);

        assert!(ChaptersRepository::replace(&pool, "m", Vec::new()).await.unwrap().is_empty());
        assert!(ChaptersRepository::list(&pool, "m").await.unwrap().is_empty());
    }
}
