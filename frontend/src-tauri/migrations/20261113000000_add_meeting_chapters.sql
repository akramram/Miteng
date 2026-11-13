-- Topics within one meeting: time ranges of the recording, each summarized on
-- its own. Time outside every range is skipped by the summary.
CREATE TABLE meeting_chapters (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
    end_seconds REAL NOT NULL CHECK (end_seconds > start_seconds),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_meeting_chapters_meeting ON meeting_chapters(meeting_id, position);
