BEGIN;

-- Convert any wrapped-key bundles that were temporarily stored in the legacy
-- export_key column before strict zero-knowledge columns existed.
UPDATE consent_exports
SET wrapped_key_bundle = export_key::jsonb
WHERE wrapped_key_bundle IS NULL
  AND export_key IS NOT NULL
  AND LEFT(TRIM(export_key), 1) = '{';

UPDATE consent_exports
SET connector_key_id = COALESCE(connector_key_id, wrapped_key_bundle->>'connector_key_id'),
    connector_wrapping_alg = COALESCE(
      NULLIF(TRIM(connector_wrapping_alg), ''),
      NULLIF(TRIM(wrapped_key_bundle->>'wrapping_alg'), ''),
      'X25519-AES256-GCM'
    )
WHERE wrapped_key_bundle IS NOT NULL;

-- Rows that still have only a raw export_key cannot be safely repaired without
-- preserving server-readable key material. Expire their export path by removing
-- the key; callers already return LEGACY_EXPORT_INVALIDATED/410 for non-strict
-- exports and require a fresh wrapped-key consent export.
UPDATE consent_exports
SET export_key = NULL,
    refresh_status = CASE
      WHEN wrapped_key_bundle IS NULL THEN 'stale'
      ELSE refresh_status
    END
WHERE export_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'consent_exports_no_legacy_export_key'
  ) THEN
    ALTER TABLE consent_exports
      ADD CONSTRAINT consent_exports_no_legacy_export_key
      CHECK (export_key IS NULL);
  END IF;
END $$;

COMMENT ON COLUMN consent_exports.export_key IS
  'Deprecated legacy field. Must remain NULL; strict-ZK exports use wrapped_key_bundle only.';

COMMIT;
