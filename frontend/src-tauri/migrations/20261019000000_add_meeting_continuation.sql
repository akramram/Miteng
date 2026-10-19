-- A meeting can continue exactly one earlier meeting (after a break or on another
-- day). The unique index keeps the series a straight line: Part 1 → 2 → 3.
ALTER TABLE meetings ADD COLUMN previous_meeting_id TEXT;

CREATE UNIQUE INDEX idx_meetings_previous_meeting_id
    ON meetings(previous_meeting_id)
    WHERE previous_meeting_id IS NOT NULL;
