-- The transcription language a group's meetings are held in. Choosing the
-- group for a recording selects it; NULL leaves the language alone.
ALTER TABLE groups ADD COLUMN language TEXT;
