-- Remove the retired plaintext message_excerpt projection without touching
-- encrypted PKM blobs or any other manifest/event metadata. This redaction is
-- intentionally irreversible: application rollback is safe because readers
-- already tolerate the key being absent, while restoring plaintext would
-- reintroduce the privacy defect.

BEGIN;

DO $$
DECLARE
  v_manifest_rows BIGINT := 0;
  v_event_rows BIGINT := 0;
BEGIN
  UPDATE pkm_manifests
  SET
    summary_projection = COALESCE(summary_projection, '{}'::JSONB) - 'message_excerpt',
    structure_decision = structure_decision #- '{summary_projection,message_excerpt}'
  WHERE COALESCE(summary_projection, '{}'::JSONB) ? 'message_excerpt'
     OR COALESCE(structure_decision->'summary_projection', '{}'::JSONB) ? 'message_excerpt';

  GET DIAGNOSTICS v_manifest_rows = ROW_COUNT;

  UPDATE pkm_events
  SET metadata = metadata
    - 'message_excerpt'
    #- '{summary_projection,message_excerpt}'
    #- '{structure_decision,summary_projection,message_excerpt}'
  WHERE COALESCE(metadata, '{}'::JSONB) ? 'message_excerpt'
     OR COALESCE(metadata->'summary_projection', '{}'::JSONB) ? 'message_excerpt'
     OR COALESCE(metadata#>'{structure_decision,summary_projection}', '{}'::JSONB)
       ? 'message_excerpt';

  GET DIAGNOSTICS v_event_rows = ROW_COUNT;

  RAISE NOTICE 'PKM plaintext projection redaction complete: manifest_rows=%, event_rows=%',
    v_manifest_rows,
    v_event_rows;
END $$;

COMMIT;
