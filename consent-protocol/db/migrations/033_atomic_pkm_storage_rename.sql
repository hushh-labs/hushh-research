BEGIN;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE embedding_type AS ENUM (
    'financial_profile',
    'lifestyle_profile',
    'interest_profile',
    'composite'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF to_regclass('public.pkm_data') IS NULL THEN
    IF to_regclass('public.world_model_data') IS NOT NULL THEN
      EXECUTE 'ALTER TABLE world_model_data RENAME TO pkm_data';
    ELSE
      EXECUTE '
        CREATE TABLE pkm_data (
          user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
          encrypted_data_ciphertext TEXT NOT NULL,
          encrypted_data_iv TEXT NOT NULL,
          encrypted_data_tag TEXT NOT NULL,
          algorithm TEXT DEFAULT ''aes-256-gcm'',
          data_version INTEGER DEFAULT 1,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )';
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  v_has_vector BOOLEAN := EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector');
BEGIN
  IF to_regclass('public.pkm_embeddings') IS NULL THEN
    IF to_regclass('public.world_model_embeddings') IS NOT NULL THEN
      EXECUTE 'ALTER TABLE world_model_embeddings RENAME TO pkm_embeddings';
    ELSE
      IF v_has_vector THEN
        EXECUTE '
          CREATE TABLE pkm_embeddings (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
            embedding_type embedding_type NOT NULL,
            embedding_vector vector(384),
            model_name TEXT DEFAULT ''all-MiniLM-L6-v2'',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id, embedding_type)
          )';
      ELSE
        EXECUTE '
          CREATE TABLE pkm_embeddings (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
            embedding_type embedding_type NOT NULL,
            embedding_vector DOUBLE PRECISION[],
            model_name TEXT DEFAULT ''all-MiniLM-L6-v2'',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id, embedding_type)
          )';
      END IF;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_pkm_embeddings_vector
        ON pkm_embeddings USING hnsw (embedding_vector vector_cosine_ops)
    ';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION upsert_pkm_data_blob(
  p_user_id TEXT,
  p_ciphertext TEXT,
  p_iv TEXT,
  p_tag TEXT,
  p_algorithm TEXT DEFAULT 'aes-256-gcm'
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  next_version INTEGER;
BEGIN
  INSERT INTO pkm_data (
    user_id,
    encrypted_data_ciphertext,
    encrypted_data_iv,
    encrypted_data_tag,
    algorithm,
    data_version,
    created_at,
    updated_at
  )
  VALUES (
    p_user_id,
    p_ciphertext,
    p_iv,
    p_tag,
    COALESCE(NULLIF(TRIM(p_algorithm), ''), 'aes-256-gcm'),
    1,
    NOW(),
    NOW()
  )
  ON CONFLICT (user_id)
  DO UPDATE SET
    encrypted_data_ciphertext = EXCLUDED.encrypted_data_ciphertext,
    encrypted_data_iv = EXCLUDED.encrypted_data_iv,
    encrypted_data_tag = EXCLUDED.encrypted_data_tag,
    algorithm = COALESCE(NULLIF(TRIM(EXCLUDED.algorithm), ''), 'aes-256-gcm'),
    data_version = pkm_data.data_version + 1,
    updated_at = NOW()
  RETURNING data_version INTO next_version;

  RETURN next_version;
END;
$$;

DROP FUNCTION IF EXISTS upsert_world_model_data_blob(TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION get_user_pkm_metadata(p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_domains JSONB := '[]'::JSONB;
    v_available_domains TEXT[] := ARRAY[]::TEXT[];
    v_total_attributes INTEGER := 0;
    v_last_updated TIMESTAMPTZ := NULL;
BEGIN
    SELECT
        COALESCE(ARRAY_AGG(domain_key ORDER BY domain_key), ARRAY[]::TEXT[]),
        COALESCE(
            JSONB_AGG(
                JSONB_BUILD_OBJECT(
                    'key', domain_key,
                    'display_name', COALESCE(display_name, INITCAP(REPLACE(domain_key, '_', ' '))),
                    'icon', COALESCE(icon_name, 'folder'),
                    'color', COALESCE(color_hex, '#6B7280'),
                    'attribute_count', attribute_count,
                    'last_updated', last_updated
                )
                ORDER BY domain_key
            ),
            '[]'::JSONB
        ),
        COALESCE(SUM(attribute_count), 0),
        MAX(last_updated)
    INTO
        v_available_domains,
        v_domains,
        v_total_attributes,
        v_last_updated
    FROM (
        SELECT
            domain_key.domain AS domain_key,
            dr.display_name,
            dr.icon_name,
            dr.color_hex,
            COALESCE(
                pm.path_count,
                NULLIF(pi.domain_summaries -> domain_key.domain ->> 'attribute_count', '')::INTEGER,
                NULLIF(pi.domain_summaries -> domain_key.domain ->> 'item_count', '')::INTEGER,
                NULLIF(pi.domain_summaries -> domain_key.domain ->> 'holdings_count', '')::INTEGER,
                0
            ) AS attribute_count,
            COALESCE(pm.last_content_at, pi.updated_at) AS last_updated
        FROM pkm_index pi
        CROSS JOIN LATERAL UNNEST(COALESCE(pi.available_domains, ARRAY[]::TEXT[])) AS domain_key(domain)
        LEFT JOIN pkm_manifests pm
            ON pm.user_id = pi.user_id
           AND pm.domain = domain_key.domain
        LEFT JOIN domain_registry dr
            ON dr.domain_key = domain_key.domain
        WHERE pi.user_id = p_user_id
    ) domain_rows;

    RETURN JSONB_BUILD_OBJECT(
        'user_id', p_user_id,
        'domains', v_domains,
        'available_domains', TO_JSONB(v_available_domains),
        'total_attributes', v_total_attributes,
        'last_updated', v_last_updated
    );
END;
$$;

DROP FUNCTION IF EXISTS get_user_world_model_metadata(TEXT);

COMMIT;
