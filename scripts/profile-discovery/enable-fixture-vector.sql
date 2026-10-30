-- Run only against the dedicated local fixture database.
DO $$ BEGIN
 IF current_database() NOT LIKE 'hushh_profile_fixture_%' THEN
   RAISE EXCEPTION 'Expected isolated fixture database';
 END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE one_public_profile_entities ADD COLUMN IF NOT EXISTS embedding vector(768);
ALTER TABLE one_public_profile_entities ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE one_public_profile_entities ADD COLUMN IF NOT EXISTS embedding_content_hash TEXT;
CREATE INDEX IF NOT EXISTS one_public_profile_embedding_hnsw
 ON one_public_profile_entities USING hnsw (embedding vector_cosine_ops)
 WHERE status='active' AND prepared_payload IS NOT NULL;
