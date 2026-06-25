-- 069_drop_kai_location_plaintext.sql
--
-- Decommission the legacy Kai location-sharing prototype (migration 060).
--
-- The legacy `kai_location_latest` table stored raw `latitude` / `longitude`
-- columns as plaintext-at-rest, violating IAM Architecture Invariant #1
-- ("no plaintext-at-rest for private user data"). It was a pre-product
-- prototype: its router (api/routes/kai/location.py) was never mounted into
-- `kai_router`, and no frontend or native surface called `/api/kai/location`.
--
-- The product live-location feature is the zero-knowledge One Location Agent
-- (migrations 061/064/065, tables `one_location_*`), which persists ciphertext
-- envelopes only and never stores coordinates in the clear.
--
-- This migration removes the plaintext tables entirely. Children are dropped
-- before parents; CASCADE covers the FKs defined in 060. Idempotent.

BEGIN;

DROP TABLE IF EXISTS kai_location_events CASCADE;
DROP TABLE IF EXISTS kai_location_access_requests CASCADE;
DROP TABLE IF EXISTS kai_location_update_sessions CASCADE;
DROP TABLE IF EXISTS kai_location_shares CASCADE;
DROP TABLE IF EXISTS kai_location_latest CASCADE;
DROP TABLE IF EXISTS kai_location_contacts CASCADE;

COMMIT;
