-- When the transcript last changed under an existing summary (trimming the
-- recording, restoring the original). A summary that finished earlier is stale.
ALTER TABLE meetings ADD COLUMN transcript_changed_at TEXT;
