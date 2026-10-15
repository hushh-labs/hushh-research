-- Feed clears are user-owned presentation preferences. Older readers ignore
-- this additive nullable column, so preserve the state through a code rollback
-- and let a forward deploy resume it (as 331_feed_dismissal does). Account
-- deletion still removes the grant row.
BEGIN;
SELECT 1;
COMMIT;
