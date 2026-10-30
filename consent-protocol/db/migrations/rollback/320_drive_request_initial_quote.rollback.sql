-- Rollback for 320_drive_request_initial_quote.sql. Keeps initial_quote_cents
-- and its check: each value records the price a requester saw before paying,
-- and older code neither reads nor writes the nullable column. The corrected
-- quoted_amount_cents comment stays true for the older code as well.
BEGIN;
COMMIT;
