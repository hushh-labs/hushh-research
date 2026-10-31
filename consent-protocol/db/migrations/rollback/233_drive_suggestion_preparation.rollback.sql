-- Data-preserving rollback: turn DRIVE_DOCUMENT_SHARING off. Never drop receipts.
BEGIN;
SELECT 1;
COMMIT;
