//! Meeting series: a meeting may continue one earlier meeting, forming a straight
//! chain (Part 1 → 2 → 3). `meetings.previous_meeting_id` holds the link; a unique
//! index guarantees each meeting is continued at most once.

use sqlx::{SqliteConnection, SqlitePool};

use crate::database::repositories::person::visible_summary_text;

#[derive(Debug)]
pub enum SeriesError {
    NotFound,
    SelfLink,
    Cycle,
    AlreadyContinued(String),
    Db(sqlx::Error),
}

impl From<sqlx::Error> for SeriesError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

impl std::fmt::Display for SeriesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => f.write_str("Meeting not found"),
            Self::SelfLink => f.write_str("A meeting cannot continue itself"),
            Self::Cycle => f.write_str("That meeting is already a later part of this series"),
            Self::AlreadyContinued(title) => {
                write!(f, "That meeting is already continued by \"{title}\"")
            }
            Self::Db(error) => write!(f, "Failed to update meeting series: {error}"),
        }
    }
}

/// Previous part's title and summary text, used as context when summarizing a continuation.
pub struct PreviousPart {
    pub title: String,
    pub summary: Option<String>,
}

pub struct MeetingSeriesRepository;

impl MeetingSeriesRepository {
    /// Marks `meeting_id` as the continuation of `previous`, or detaches it with `None`.
    pub async fn set_previous_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
        previous: Option<&str>,
    ) -> Result<(), SeriesError> {
        let mut tx = pool.begin().await?;
        if !meeting_exists(&mut tx, meeting_id).await? {
            return Err(SeriesError::NotFound);
        }
        if let Some(previous) = previous {
            if previous == meeting_id {
                return Err(SeriesError::SelfLink);
            }
            if !meeting_exists(&mut tx, previous).await? {
                return Err(SeriesError::NotFound);
            }
            // Walking up from `previous` must never reach this meeting, or the
            // series would loop. `seen` stops the walk on already-corrupt data.
            let mut seen = std::collections::HashSet::new();
            let mut cursor = Some(previous.to_string());
            while let Some(id) = cursor {
                if id == meeting_id || !seen.insert(id.clone()) {
                    return Err(SeriesError::Cycle);
                }
                cursor = sqlx::query_scalar::<_, Option<String>>(
                    "SELECT previous_meeting_id FROM meetings WHERE id = ?",
                )
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?
                .flatten();
            }
            let taken: Option<String> = sqlx::query_scalar(
                "SELECT title FROM meetings WHERE previous_meeting_id = ? AND id != ?",
            )
            .bind(previous)
            .bind(meeting_id)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(title) = taken {
                return Err(SeriesError::AlreadyContinued(title));
            }
        }
        sqlx::query(
            "UPDATE meetings SET previous_meeting_id = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(previous)
        .bind(meeting_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn previous_part(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<PreviousPart>, sqlx::Error> {
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT p.title, s.result FROM meetings m \
             JOIN meetings p ON p.id = m.previous_meeting_id \
             LEFT JOIN summary_processes s ON s.meeting_id = p.id \
             WHERE m.id = ?",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(|(title, result)| PreviousPart {
            title,
            summary: result.as_deref().and_then(visible_summary_text),
        }))
    }

    /// Before a meeting is deleted, its continuation moves up to its previous part
    /// so the series stays one unbroken line.
    pub(crate) async fn detach(
        conn: &mut SqliteConnection,
        meeting_id: &str,
    ) -> Result<(), sqlx::Error> {
        let previous: Option<String> =
            sqlx::query_scalar("SELECT previous_meeting_id FROM meetings WHERE id = ?")
                .bind(meeting_id)
                .fetch_optional(&mut *conn)
                .await?
                .flatten();
        // Clear first: the unique index would reject two rows pointing at `previous`.
        sqlx::query("UPDATE meetings SET previous_meeting_id = NULL WHERE id = ?")
            .bind(meeting_id)
            .execute(&mut *conn)
            .await?;
        sqlx::query("UPDATE meetings SET previous_meeting_id = ? WHERE previous_meeting_id = ?")
            .bind(previous)
            .bind(meeting_id)
            .execute(&mut *conn)
            .await?;
        Ok(())
    }
}

async fn meeting_exists(conn: &mut SqliteConnection, id: &str) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT 1 FROM meetings WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?
        .is_some())
}

#[tauri::command]
pub async fn api_set_previous_meeting(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    previous_meeting_id: Option<String>,
) -> Result<(), String> {
    MeetingSeriesRepository::set_previous_meeting(
        state.db_manager.pool(),
        &meeting_id,
        previous_meeting_id.as_deref().filter(|id| !id.trim().is_empty()),
    )
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::repositories::meeting::MeetingsRepository;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool_with(ids: &[&str]) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        for id in ids {
            sqlx::query(
                "INSERT INTO meetings (id, title, created_at, updated_at) \
                 VALUES (?, ?, datetime('now'), datetime('now'))",
            )
            .bind(id)
            .bind(format!("Meeting {id}"))
            .execute(&pool)
            .await
            .unwrap();
        }
        pool
    }

    async fn previous_of(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT previous_meeting_id FROM meetings WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn series_stays_a_straight_line_without_loops() {
        let pool = pool_with(&["a", "b", "c"]).await;
        MeetingSeriesRepository::set_previous_meeting(&pool, "b", Some("a")).await.unwrap();
        MeetingSeriesRepository::set_previous_meeting(&pool, "c", Some("b")).await.unwrap();

        let looped = MeetingSeriesRepository::set_previous_meeting(&pool, "a", Some("c")).await;
        assert!(matches!(looped, Err(SeriesError::Cycle)));
        let branched = MeetingSeriesRepository::set_previous_meeting(&pool, "c", Some("a")).await;
        assert!(matches!(branched, Err(SeriesError::AlreadyContinued(t)) if t == "Meeting b"));
        let own = MeetingSeriesRepository::set_previous_meeting(&pool, "a", Some("a")).await;
        assert!(matches!(own, Err(SeriesError::SelfLink)));

        // Re-saving the same link and unlinking both succeed.
        MeetingSeriesRepository::set_previous_meeting(&pool, "c", Some("b")).await.unwrap();
        MeetingSeriesRepository::set_previous_meeting(&pool, "c", None).await.unwrap();
        assert_eq!(previous_of(&pool, "c").await, None);
    }

    #[tokio::test]
    async fn deleting_a_middle_part_joins_its_neighbours() {
        let pool = pool_with(&["a", "b", "c"]).await;
        MeetingSeriesRepository::set_previous_meeting(&pool, "b", Some("a")).await.unwrap();
        MeetingSeriesRepository::set_previous_meeting(&pool, "c", Some("b")).await.unwrap();

        assert!(MeetingsRepository::delete_meeting(&pool, "b").await.unwrap());
        assert_eq!(previous_of(&pool, "c").await.as_deref(), Some("a"));

        assert!(MeetingsRepository::delete_meeting(&pool, "a").await.unwrap());
        assert_eq!(previous_of(&pool, "c").await, None);
    }

    #[tokio::test]
    async fn previous_part_reads_the_visible_summary() {
        let pool = pool_with(&["a", "b"]).await;
        assert!(MeetingSeriesRepository::previous_part(&pool, "b").await.unwrap().is_none());

        MeetingSeriesRepository::set_previous_meeting(&pool, "b", Some("a")).await.unwrap();
        let part = MeetingSeriesRepository::previous_part(&pool, "b").await.unwrap().unwrap();
        assert_eq!(part.title, "Meeting a");
        assert_eq!(part.summary, None);

        sqlx::query(
            "INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result) \
             VALUES ('a', 'completed', datetime('now'), datetime('now'), ?)",
        )
        .bind(r#"{"markdown":"Budget approved; vendor shortlist due Friday."}"#)
        .execute(&pool)
        .await
        .unwrap();
        let part = MeetingSeriesRepository::previous_part(&pool, "b").await.unwrap().unwrap();
        assert_eq!(part.summary.as_deref(), Some("Budget approved; vendor shortlist due Friday."));
    }
}
