//! Trimming the end off a recording, for when the recorder kept running after
//! the meeting ended. The untrimmed files move to `original/` in the meeting
//! folder, together with the transcript lines that were cut, so the trim can be
//! undone until the user deletes the original.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::ffmpeg::find_ffmpeg_path;

const ORIGINAL_DIR: &str = "original";
const MANIFEST: &str = "trim.json";
const MEDIA_STEMS: [&str; 3] = ["audio", "mic", "system"];
const MEDIA_EXTENSIONS: [&str; 8] = ["mp4", "m4a", "mp3", "wav", "aac", "flac", "ogg", "webm"];
const TRANSCRIPTS_FILE: &str = "transcripts.json";
const METADATA_FILE: &str = "metadata.json";
/// Cuts closer than this to either end of the recording are refused.
const MIN_TRIM_SECONDS: f64 = 1.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimState {
    pub duration_seconds: f64,
    pub original: Option<OriginalRecording>,
    /// The summary finished before the transcript was last trimmed or restored.
    pub summary_stale: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalRecording {
    pub duration_seconds: f64,
    pub trimmed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimPreview {
    pub last_kept: Option<PreviewLine>,
    pub removed_lines: i64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLine {
    pub speaker: Option<String>,
    pub text: String,
    pub start_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
struct TranscriptRow {
    id: String,
    meeting_id: String,
    transcript: String,
    timestamp: String,
    summary: Option<String>,
    action_items: Option<String>,
    key_points: Option<String>,
    audio_start_time: Option<f64>,
    audio_end_time: Option<f64>,
    duration: Option<f64>,
    speaker: Option<String>,
}

/// What a restore needs besides the files in `original/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    original_duration_seconds: f64,
    trimmed_at: DateTime<Utc>,
    /// Lines that started after a cut.
    removed: Vec<TranscriptRow>,
    /// Lines that ran across a cut: their end time and duration before it.
    clamped: HashMap<String, (Option<f64>, Option<f64>)>,
}

fn read_manifest(folder: &Path) -> Result<Option<Manifest>, String> {
    let path = folder.join(ORIGINAL_DIR).join(MANIFEST);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, contents).map_err(|e| format!("Failed to write {}: {e}", temp.display()))?;
    std::fs::rename(&temp, path).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

fn media_files(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(folder) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default();
            let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or_default().to_ascii_lowercase();
            path.is_file() && MEDIA_STEMS.contains(&stem) && MEDIA_EXTENSIONS.contains(&ext.as_str())
        })
        .collect();
    files.sort();
    files
}

async fn meeting_folder(pool: &SqlitePool, meeting_id: &str) -> Result<PathBuf, String> {
    let folder: Option<Option<String>> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to look up the meeting: {e}"))?;
    let folder = folder
        .ok_or("Meeting not found")?
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .ok_or("This meeting has no recording folder")?;
    Ok(folder)
}

/// The recording's length: the saved metadata, else the last transcript line.
async fn recording_duration(pool: &SqlitePool, meeting_id: &str, folder: &Path) -> Result<f64, String> {
    let from_metadata = std::fs::read_to_string(folder.join(METADATA_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|metadata| metadata.get("duration_seconds").and_then(|value| value.as_f64()))
        .filter(|seconds| *seconds > 0.0);
    if let Some(seconds) = from_metadata {
        return Ok(seconds);
    }
    let last: Option<f64> = sqlx::query_scalar(
        "SELECT MAX(COALESCE(audio_end_time, audio_start_time)) FROM transcripts WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to read the transcript: {e}"))?;
    Ok(last.unwrap_or(0.0))
}

async fn summary_stale(pool: &SqlitePool, meeting_id: &str) -> Result<bool, String> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT m.transcript_changed_at, s.end_time FROM meetings m \
         JOIN summary_processes s ON s.meeting_id = m.id AND s.status = 'completed' \
         WHERE m.id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to read the summary: {e}"))?;
    let parse = |value: Option<String>| value.and_then(|raw| DateTime::parse_from_rfc3339(&raw).ok());
    Ok(match row {
        Some((changed, finished)) => match (parse(changed), parse(finished)) {
            (Some(changed), Some(finished)) => changed > finished,
            _ => false,
        },
        None => false,
    })
}

pub async fn trim_state(pool: &SqlitePool, meeting_id: &str) -> Result<TrimState, String> {
    let folder = meeting_folder(pool, meeting_id).await?;
    Ok(TrimState {
        duration_seconds: recording_duration(pool, meeting_id, &folder).await?,
        original: read_manifest(&folder)?.map(|manifest| OriginalRecording {
            duration_seconds: manifest.original_duration_seconds,
            trimmed_at: manifest.trimmed_at,
        }),
        summary_stale: summary_stale(pool, meeting_id).await?,
    })
}

pub async fn preview(pool: &SqlitePool, meeting_id: &str, end_seconds: f64) -> Result<TrimPreview, String> {
    let last_kept: Option<PreviewLine> = sqlx::query_as(
        "SELECT speaker, transcript AS text, audio_start_time AS start_seconds FROM transcripts \
         WHERE meeting_id = ? AND audio_start_time < ? ORDER BY audio_start_time DESC LIMIT 1",
    )
    .bind(meeting_id)
    .bind(end_seconds)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to read the transcript: {e}"))?;
    let removed_lines: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE meeting_id = ? AND audio_start_time >= ?")
            .bind(meeting_id)
            .bind(end_seconds)
            .fetch_one(pool)
            .await
            .map_err(|e| format!("Failed to read the transcript: {e}"))?;
    Ok(TrimPreview { last_kept, removed_lines })
}

fn cut_media(ffmpeg: &Path, input: &Path, output: &Path, end_seconds: f64) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command
        .arg("-nostdin")
        .arg("-i")
        .arg(input)
        .args(["-t", &format!("{end_seconds:.3}"), "-map", "0", "-c", "copy"]);
    let ext = output.extension().and_then(|ext| ext.to_str()).unwrap_or_default();
    if matches!(ext, "mp4" | "m4a") {
        command.args(["-movflags", "+faststart"]);
    }
    command.arg("-y").arg(output).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let result = command.output().map_err(|e| format!("Failed to run FFmpeg: {e}"))?;
    if !result.status.success() {
        let _ = std::fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&result.stderr);
        let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
        return Err(format!("FFmpeg could not trim {}: {tail}", input.display()));
    }
    Ok(())
}

/// Cut every recording file to `end_seconds` next to the original, as hidden
/// temp files. Nothing visible changes unless all of them succeed.
fn cut_all(ffmpeg: &Path, folder: &Path, end_seconds: f64) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let media = media_files(folder);
    if media.is_empty() {
        return Err("The recording folder has no audio file".into());
    }
    let mut done: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(media.len());
    for file in media {
        let name = file.file_name().and_then(|name| name.to_str()).unwrap_or_default();
        let temp = folder.join(format!(".trim-{name}"));
        if let Err(error) = cut_media(ffmpeg, &file, &temp, end_seconds) {
            for (_, temp) in &done {
                let _ = std::fs::remove_file(temp);
            }
            return Err(error);
        }
        done.push((file, temp));
    }
    Ok(done)
}

fn trimmed_transcripts_json(raw: &str, end_seconds: f64) -> Option<String> {
    let mut document: serde_json::Value = serde_json::from_str(raw).ok()?;
    let segments = document.get_mut("segments")?.as_array_mut()?;
    segments.retain(|segment| {
        segment.get("audio_start_time").and_then(|value| value.as_f64()).map_or(true, |start| start < end_seconds)
    });
    for segment in segments.iter_mut() {
        let start = segment.get("audio_start_time").and_then(|value| value.as_f64());
        let end = segment.get("audio_end_time").and_then(|value| value.as_f64());
        if let (Some(start), Some(end)) = (start, end) {
            if end > end_seconds {
                segment["audio_end_time"] = end_seconds.into();
                segment["duration"] = (end_seconds - start).into();
            }
        }
    }
    let count = segments.len();
    document["total_segments"] = count.into();
    serde_json::to_string_pretty(&document).ok()
}

fn trimmed_metadata_json(raw: &str, end_seconds: f64) -> Option<String> {
    let mut metadata: serde_json::Value = serde_json::from_str(raw).ok()?;
    metadata.as_object_mut()?.insert("duration_seconds".into(), end_seconds.into());
    serde_json::to_string_pretty(&metadata).ok()
}

/// Keep the first copy of a side file in `original/`, then rewrite it for the cut.
fn trim_side_file(folder: &Path, name: &str, rewrite: impl Fn(&str) -> Option<String>) -> Result<(), String> {
    let path = folder.join(name);
    let Ok(raw) = std::fs::read_to_string(&path) else { return Ok(()) };
    let backup = folder.join(ORIGINAL_DIR).join(name);
    if !backup.exists() {
        std::fs::copy(&path, &backup).map_err(|e| format!("Failed to keep the original {name}: {e}"))?;
    }
    if let Some(trimmed) = rewrite(&raw) {
        write_atomic(&path, trimmed.as_bytes())?;
    }
    Ok(())
}

pub async fn trim(pool: &SqlitePool, meeting_id: &str, end_seconds: f64, ffmpeg: &Path) -> Result<(), String> {
    let folder = meeting_folder(pool, meeting_id).await?;
    let duration = recording_duration(pool, meeting_id, &folder).await?;
    if !end_seconds.is_finite() || end_seconds < MIN_TRIM_SECONDS || end_seconds > duration - MIN_TRIM_SECONDS {
        return Err("Pick a point between the start and the end of the recording".into());
    }

    let cut = {
        let (ffmpeg, folder) = (ffmpeg.to_path_buf(), folder.clone());
        tokio::task::spawn_blocking(move || cut_all(&ffmpeg, &folder, end_seconds))
            .await
            .map_err(|e| format!("Trimming stopped unexpectedly: {e}"))??
    };
    let discard_cut = || {
        for (_, temp) in &cut {
            let _ = std::fs::remove_file(temp);
        }
    };

    let now = Utc::now();
    let previous = match read_manifest(&folder) {
        Ok(previous) => previous,
        Err(error) => {
            discard_cut();
            return Err(error);
        }
    };
    let mut manifest = previous.clone().unwrap_or(Manifest {
        original_duration_seconds: duration,
        trimmed_at: now,
        removed: Vec::new(),
        clamped: HashMap::new(),
    });
    manifest.trimmed_at = now;

    let result: Result<(), String> = async {
        let mut tx = pool.begin().await.map_err(|e| format!("Failed to start saving: {e}"))?;
        let rows: Vec<TranscriptRow> = sqlx::query_as(
            "SELECT id, meeting_id, transcript, timestamp, summary, action_items, key_points, \
             audio_start_time, audio_end_time, duration, speaker FROM transcripts \
             WHERE meeting_id = ? AND audio_end_time > ?",
        )
        .bind(meeting_id)
        .bind(end_seconds)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| format!("Failed to read the transcript: {e}"))?;
        for row in rows {
            match row.audio_start_time {
                Some(start) if start >= end_seconds => {
                    sqlx::query("DELETE FROM transcripts WHERE id = ?")
                        .bind(&row.id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| format!("Failed to remove a transcript line: {e}"))?;
                    manifest.removed.push(row);
                }
                Some(start) => {
                    sqlx::query("UPDATE transcripts SET audio_end_time = ?, duration = ? WHERE id = ?")
                        .bind(end_seconds)
                        .bind(end_seconds - start)
                        .bind(&row.id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| format!("Failed to shorten a transcript line: {e}"))?;
                    manifest.clamped.entry(row.id).or_insert((row.audio_end_time, row.duration));
                }
                None => {}
            }
        }
        sqlx::query("UPDATE meetings SET transcript_changed_at = ? WHERE id = ?")
            .bind(now)
            .bind(meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Failed to update the meeting: {e}"))?;

        // The manifest is the only copy of the removed lines: write it first.
        let original_dir = folder.join(ORIGINAL_DIR);
        std::fs::create_dir_all(&original_dir)
            .map_err(|e| format!("Failed to create {}: {e}", original_dir.display()))?;
        let encoded = serde_json::to_vec_pretty(&manifest).map_err(|e| format!("Failed to save the trim: {e}"))?;
        write_atomic(&original_dir.join(MANIFEST), &encoded)?;
        if let Err(error) = tx.commit().await {
            match &previous {
                Some(previous) => {
                    let _ = serde_json::to_vec_pretty(previous)
                        .map_err(|e| e.to_string())
                        .and_then(|bytes| write_atomic(&original_dir.join(MANIFEST), &bytes));
                }
                None => {
                    let _ = std::fs::remove_dir_all(&original_dir);
                }
            }
            return Err(format!("Failed to save the trimmed transcript: {error}"));
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        discard_cut();
        return Err(error);
    }

    // The transcript is trimmed; now swap the files. Every step leaves a
    // restorable state: the untrimmed file is in `original/` before its trimmed
    // copy takes its place.
    let original_dir = folder.join(ORIGINAL_DIR);
    for (file, temp) in &cut {
        let name = file.file_name().ok_or("Invalid recording file name")?;
        let backup = original_dir.join(name);
        let kept = if backup.exists() { std::fs::remove_file(file) } else { std::fs::rename(file, &backup) };
        kept.map_err(|e| format!("Failed to keep the original {}: {e}", file.display()))?;
        std::fs::rename(temp, file).map_err(|e| format!("Failed to save the trimmed {}: {e}", file.display()))?;
    }
    trim_side_file(&folder, TRANSCRIPTS_FILE, |raw| trimmed_transcripts_json(raw, end_seconds))?;
    trim_side_file(&folder, METADATA_FILE, |raw| trimmed_metadata_json(raw, end_seconds))?;
    Ok(())
}

pub async fn restore(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    let folder = meeting_folder(pool, meeting_id).await?;
    let manifest = read_manifest(&folder)?.ok_or("The original recording was already deleted")?;
    let original_dir = folder.join(ORIGINAL_DIR);

    // Files first, then lines. Both are idempotent, so a failed restore can be retried.
    let entries = std::fs::read_dir(&original_dir).map_err(|e| format!("Failed to read {}: {e}", original_dir.display()))?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() || entry.file_name() == MANIFEST {
            continue;
        }
        std::fs::rename(&path, folder.join(entry.file_name()))
            .map_err(|e| format!("Failed to restore {}: {e}", path.display()))?;
    }

    let mut tx = pool.begin().await.map_err(|e| format!("Failed to start restoring: {e}"))?;
    for row in &manifest.removed {
        sqlx::query(
            "INSERT OR IGNORE INTO transcripts (id, meeting_id, transcript, timestamp, summary, action_items, \
             key_points, audio_start_time, audio_end_time, duration, speaker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&row.id)
        .bind(&row.meeting_id)
        .bind(&row.transcript)
        .bind(&row.timestamp)
        .bind(&row.summary)
        .bind(&row.action_items)
        .bind(&row.key_points)
        .bind(row.audio_start_time)
        .bind(row.audio_end_time)
        .bind(row.duration)
        .bind(&row.speaker)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("Failed to restore a transcript line: {e}"))?;
    }
    for (id, (end, duration)) in &manifest.clamped {
        sqlx::query("UPDATE transcripts SET audio_end_time = ?, duration = ? WHERE id = ?")
            .bind(end)
            .bind(duration)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Failed to restore a transcript line: {e}"))?;
    }
    sqlx::query("UPDATE meetings SET transcript_changed_at = ? WHERE id = ?")
        .bind(Utc::now())
        .bind(meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("Failed to update the meeting: {e}"))?;
    tx.commit().await.map_err(|e| format!("Failed to restore the transcript: {e}"))?;

    std::fs::remove_dir_all(&original_dir).map_err(|e| format!("Failed to remove {}: {e}", original_dir.display()))
}

pub async fn delete_original(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    let folder = meeting_folder(pool, meeting_id).await?;
    let original_dir = folder.join(ORIGINAL_DIR);
    if original_dir.exists() {
        std::fs::remove_dir_all(&original_dir)
            .map_err(|e| format!("Failed to delete the original recording: {e}"))?;
    }
    Ok(())
}

/// Trimming rewrites the transcript and the recording, so nothing else may be
/// reading or writing them.
async fn ensure_idle(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    if super::retranscription::is_retranscription_in_progress() {
        return Err("Wait for the transcript enhancement to finish".into());
    }
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM summary_processes WHERE meeting_id = ?")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to read the summary: {e}"))?;
    if status.as_deref() == Some("PENDING") {
        return Err("Wait for the summary to finish".into());
    }
    Ok(())
}

fn speaker_lock() -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    crate::diarization::try_operation_guard().map_err(|_| "Wait for speaker identification to finish".to_string())
}

#[tauri::command]
pub async fn api_get_meeting_trim(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
) -> Result<TrimState, String> {
    trim_state(state.db_manager.pool(), &meeting_id).await
}

#[tauri::command]
pub async fn api_preview_meeting_trim(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    end_seconds: f64,
) -> Result<TrimPreview, String> {
    preview(state.db_manager.pool(), &meeting_id, end_seconds).await
}

#[tauri::command]
pub async fn api_trim_meeting(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    end_seconds: f64,
    delete_original_now: bool,
) -> Result<TrimState, String> {
    let pool = state.db_manager.pool();
    let _lock = speaker_lock()?;
    ensure_idle(pool, &meeting_id).await?;
    let ffmpeg = find_ffmpeg_path().ok_or("FFmpeg is unavailable")?;
    trim(pool, &meeting_id, end_seconds, &ffmpeg).await?;
    log::info!("Trimmed meeting {meeting_id} to {end_seconds:.1}s");
    if delete_original_now {
        delete_original(pool, &meeting_id).await?;
    }
    trim_state(pool, &meeting_id).await
}

#[tauri::command]
pub async fn api_restore_meeting_original(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
) -> Result<TrimState, String> {
    let pool = state.db_manager.pool();
    let _lock = speaker_lock()?;
    ensure_idle(pool, &meeting_id).await?;
    restore(pool, &meeting_id).await?;
    log::info!("Restored the original recording of meeting {meeting_id}");
    trim_state(pool, &meeting_id).await
}

#[tauri::command]
pub async fn api_delete_meeting_original(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
) -> Result<TrimState, String> {
    let pool = state.db_manager.pool();
    delete_original(pool, &meeting_id).await?;
    log::info!("Deleted the original recording of meeting {meeting_id}");
    trim_state(pool, &meeting_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    fn duration_of(path: &Path) -> f64 {
        crate::audio::decoder::decode_audio_file(path).unwrap().duration_seconds
    }

    #[tokio::test]
    async fn trim_cuts_files_and_lines_and_restore_brings_them_back() {
        let Some(ffmpeg) = find_ffmpeg_path() else { return };
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path();
        for name in ["audio.mp4", "mic.mp4"] {
            let status = Command::new(&ffmpeg)
                .args(["-nostdin", "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-c:a", "aac", "-y"])
                .arg(folder.join(name))
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
        }
        std::fs::write(folder.join(METADATA_FILE), r#"{"duration_seconds": 10.0, "audio_file": "audio.mp4"}"#).unwrap();
        std::fs::write(
            folder.join(TRANSCRIPTS_FILE),
            r#"{"segments":[{"audio_start_time":0.0,"audio_end_time":3.0},{"audio_start_time":3.0,"audio_end_time":6.0},{"audio_start_time":6.0,"audio_end_time":9.0}],"total_segments":3}"#,
        )
        .unwrap();

        let pool = pool().await;
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at, folder_path) VALUES ('m', 'M', 'now', 'now', ?)")
            .bind(folder.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .unwrap();
        for (id, start, end) in [("a", 0.0, 3.0), ("b", 3.0, 6.0), ("c", 6.0, 9.0)] {
            sqlx::query(
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker) \
                 VALUES (?, 'm', ?, 't', ?, ?, ?, 'Speaker 1')",
            )
            .bind(id)
            .bind(format!("line {id}"))
            .bind(start)
            .bind(end)
            .bind(end - start)
            .execute(&pool)
            .await
            .unwrap();
        }
        let lines = |pool: SqlitePool| async move {
            sqlx::query_as::<_, (String, f64)>("SELECT id, audio_end_time FROM transcripts WHERE meeting_id = 'm' ORDER BY audio_start_time")
                .fetch_all(&pool)
                .await
                .unwrap()
        };

        assert!(trim(&pool, "m", 9.5, &ffmpeg).await.is_err(), "a cut within a second of the end is refused");
        let preview = preview(&pool, "m", 5.0).await.unwrap();
        assert_eq!((preview.last_kept.unwrap().text, preview.removed_lines), ("line b".to_string(), 1));

        trim(&pool, "m", 5.0, &ffmpeg).await.unwrap();
        assert_eq!(lines(pool.clone()).await, vec![("a".into(), 3.0), ("b".into(), 5.0)]);
        assert!((duration_of(&folder.join("audio.mp4")) - 5.0).abs() < 0.1);
        assert!((duration_of(&folder.join("mic.mp4")) - 5.0).abs() < 0.1);
        assert!((duration_of(&folder.join("original/audio.mp4")) - 10.0).abs() < 0.1);
        let state = trim_state(&pool, "m").await.unwrap();
        assert_eq!(state.duration_seconds, 5.0);
        assert_eq!(state.original.unwrap().duration_seconds, 10.0);
        let transcripts: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(folder.join(TRANSCRIPTS_FILE)).unwrap()).unwrap();
        assert_eq!(transcripts["total_segments"], 2);

        // A second, shorter cut still restores to the very first recording.
        trim(&pool, "m", 2.0, &ffmpeg).await.unwrap();
        assert_eq!(lines(pool.clone()).await, vec![("a".into(), 2.0)]);

        restore(&pool, "m").await.unwrap();
        assert_eq!(lines(pool.clone()).await, vec![("a".into(), 3.0), ("b".into(), 6.0), ("c".into(), 9.0)]);
        assert!((duration_of(&folder.join("audio.mp4")) - 10.0).abs() < 0.1);
        assert!(!folder.join(ORIGINAL_DIR).exists());
        let state = trim_state(&pool, "m").await.unwrap();
        assert!(state.original.is_none());
        assert_eq!(state.duration_seconds, 10.0);
        assert!(media_files(folder).iter().all(|path| !path.file_name().unwrap().to_string_lossy().starts_with('.')));
    }

    #[tokio::test]
    async fn a_summary_written_before_the_trim_is_stale() {
        let pool = pool().await;
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at, transcript_changed_at) VALUES ('m', 'M', 'now', 'now', ?)")
            .bind("2026-11-11T10:00:00+00:00")
            .execute(&pool)
            .await
            .unwrap();
        let finish = |at: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query(
                    "INSERT OR REPLACE INTO summary_processes (meeting_id, status, created_at, updated_at, end_time) \
                     VALUES ('m', 'completed', 'x', 'x', ?)",
                )
                .bind(at)
                .execute(&pool)
                .await
                .unwrap();
            }
        };
        finish("2026-11-11T09:00:00.123+00:00").await;
        assert!(summary_stale(&pool, "m").await.unwrap());
        finish("2026-11-11T10:05:00+00:00").await;
        assert!(!summary_stale(&pool, "m").await.unwrap());
    }
}
