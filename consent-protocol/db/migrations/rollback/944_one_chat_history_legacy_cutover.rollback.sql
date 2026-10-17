-- Dev-only cleanup 944. Public-profile 249 and Calendar 252 retain their active identities.
-- This cleanup stays parked until restore and incompatible-writer drain receipts pass.
-- Rollback for migration 944: intentionally a no-op.
--
-- 250 deletes chat history sealed with the platform key. That deletion is the
-- founder-approved cutover to person-key chat history and cannot be undone by
-- SQL: the rows are gone. Restoring them means restoring the database from
-- backup (production: Cloud SQL backups and PITR), and even then the person-key
-- code treats platform-key rows as absent and never opens them.
--
-- Rolling the APPLICATION back is not free either: the pre-cutover code opens
-- every session row with the platform key and has no per-row guard, so anyone
-- who already has person-key history would get a failed history list. An app
-- rollback past the chat-key change must ship with a fix that skips rows it
-- cannot open (or roll forward instead).

SELECT 1;
