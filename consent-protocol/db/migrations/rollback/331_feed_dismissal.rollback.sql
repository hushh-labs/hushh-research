-- Dismissals are user-owned presentation preferences. Older readers ignore this
-- additive nullable column, so preserve the state through a code rollback and
-- let a forward deploy resume it. Account deletion still erases feed_events.
BEGIN;
SELECT 1;
COMMIT;
