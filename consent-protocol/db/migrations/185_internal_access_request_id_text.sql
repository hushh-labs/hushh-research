BEGIN;

-- Information-request bundle item identifiers are UUIDs and exceed the
-- original 32-character legacy bound. Consent lifecycle notification receipts
-- reuse that request id; widen the audit projection so the receipt cannot fail
-- after the authority row has already committed.
ALTER TABLE internal_access_events
  ALTER COLUMN request_id TYPE TEXT;

COMMIT;
