BEGIN;
-- Preserve issued/executed review history. Roll back callers first; this
-- additive authority schema is intentionally retained rather than deleting it.
COMMIT;
