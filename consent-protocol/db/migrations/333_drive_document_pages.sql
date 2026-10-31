-- Reusable encrypted original-document extraction; no private page text in columns.
BEGIN;
CREATE TABLE IF NOT EXISTS drive_document_extractions (
    document_id UUID NOT NULL,
    user_id TEXT NOT NULL,
    connection_generation BIGINT NOT NULL CHECK (connection_generation > 0),
    source_version TEXT NOT NULL CHECK (source_version ~ '^[0-9]{1,30}$'),
    extraction_version TEXT NOT NULL CHECK (extraction_version ~ '^[0-9a-f]{64}$'),
    extraction_profile TEXT NOT NULL,
    next_page INTEGER,
    total_pages INTEGER NOT NULL CHECK (total_pages > 0),
    complete BOOLEAN NOT NULL DEFAULT FALSE,
    has_gaps BOOLEAN NOT NULL DEFAULT FALSE,
    unit_kind TEXT NOT NULL CHECK (unit_kind IN ('page','text_segment')),
    engine_versions JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (document_id, extraction_version),
    FOREIGN KEY (document_id,user_id) REFERENCES connected_documents(document_id,user_id) ON DELETE CASCADE,
    CHECK ((complete AND next_page IS NULL) OR (NOT complete AND next_page > 0))
);
CREATE INDEX IF NOT EXISTS drive_document_extractions_owner
    ON drive_document_extractions(user_id,connection_generation,document_id);
CREATE TABLE IF NOT EXISTS drive_document_pages (
    document_id UUID NOT NULL,
    extraction_version TEXT NOT NULL,
    page_number INTEGER NOT NULL CHECK (page_number > 0),
    content_envelope JSONB NOT NULL CHECK (jsonb_typeof(content_envelope)='object'),
    PRIMARY KEY (document_id,extraction_version,page_number),
    FOREIGN KEY (document_id,extraction_version)
        REFERENCES drive_document_extractions(document_id,extraction_version) ON DELETE CASCADE
);
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['drive_document_extractions','drive_document_pages'] LOOP
    EXECUTE 'ALTER TABLE ' || quote_ident(table_name) || ' ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON ' || quote_ident(table_name) || ' FROM PUBLIC';
    IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE 'REVOKE ALL ON ' || quote_ident(table_name) || ' FROM anon';
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE 'REVOKE ALL ON ' || quote_ident(table_name) || ' FROM authenticated';
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
      EXECUTE 'REVOKE ALL ON ' || quote_ident(table_name) || ' FROM service_role';
      EXECUTE 'GRANT SELECT,INSERT,UPDATE,DELETE ON ' || quote_ident(table_name) || ' TO service_role';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
