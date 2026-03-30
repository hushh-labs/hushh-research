BEGIN;

CREATE TABLE IF NOT EXISTS pkm_index (
  user_id TEXT PRIMARY KEY,
  available_domains TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  domain_summaries JSONB NOT NULL DEFAULT '{}'::JSONB,
  computed_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  activity_score DOUBLE PRECISION,
  last_active_at TIMESTAMPTZ,
  total_attributes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pkm_index_available_domains
  ON pkm_index USING GIN (available_domains);

CREATE INDEX IF NOT EXISTS idx_pkm_index_domain_summaries
  ON pkm_index USING GIN (domain_summaries);

CREATE INDEX IF NOT EXISTS idx_pkm_index_computed_tags
  ON pkm_index USING GIN (computed_tags);

CREATE TABLE IF NOT EXISTS pkm_blobs (
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  content_revision INTEGER NOT NULL DEFAULT 1,
  manifest_revision INTEGER NOT NULL DEFAULT 1,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, domain, segment_id)
);

CREATE INDEX IF NOT EXISTS idx_pkm_blobs_lookup
  ON pkm_blobs(user_id, domain, segment_id);

CREATE INDEX IF NOT EXISTS idx_pkm_blobs_updated_at
  ON pkm_blobs(updated_at DESC);

CREATE TABLE IF NOT EXISTS pkm_manifests (
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  manifest_version INTEGER NOT NULL DEFAULT 1,
  structure_decision JSONB NOT NULL DEFAULT '{}'::JSONB,
  summary_projection JSONB NOT NULL DEFAULT '{}'::JSONB,
  top_level_scope_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  externalizable_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  segment_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  path_count INTEGER NOT NULL DEFAULT 0,
  externalizable_path_count INTEGER NOT NULL DEFAULT 0,
  last_structured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_content_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_pkm_manifests_lookup
  ON pkm_manifests(user_id, domain);

CREATE INDEX IF NOT EXISTS idx_pkm_manifests_updated_at
  ON pkm_manifests(updated_at DESC);

CREATE TABLE IF NOT EXISTS pkm_manifest_paths (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  json_path TEXT NOT NULL,
  parent_path TEXT,
  path_type TEXT NOT NULL DEFAULT 'leaf',
  segment_id TEXT NOT NULL DEFAULT 'root',
  scope_handle TEXT,
  exposure_eligibility BOOLEAN NOT NULL DEFAULT TRUE,
  consent_label TEXT,
  sensitivity_label TEXT,
  source_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, domain, json_path)
);

CREATE INDEX IF NOT EXISTS idx_pkm_manifest_paths_lookup
  ON pkm_manifest_paths(user_id, domain);

CREATE INDEX IF NOT EXISTS idx_pkm_manifest_paths_segment
  ON pkm_manifest_paths(user_id, domain, segment_id);

CREATE TABLE IF NOT EXISTS pkm_scope_registry (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  scope_handle TEXT NOT NULL,
  scope_label TEXT NOT NULL,
  segment_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  sensitivity_tier TEXT NOT NULL DEFAULT 'confidential',
  scope_kind TEXT NOT NULL DEFAULT 'subtree',
  exposure_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  manifest_version INTEGER NOT NULL DEFAULT 1,
  summary_projection JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, domain, scope_handle)
);

CREATE INDEX IF NOT EXISTS idx_pkm_scope_registry_lookup
  ON pkm_scope_registry(user_id, domain, scope_handle);

CREATE INDEX IF NOT EXISTS idx_pkm_scope_registry_segment_ids
  ON pkm_scope_registry USING GIN (segment_ids);

CREATE TABLE IF NOT EXISTS pkm_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  segment_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  path_set JSONB NOT NULL DEFAULT '[]'::JSONB,
  source_agent TEXT,
  confidence DOUBLE PRECISION,
  prior_manifest_version INTEGER,
  new_manifest_version INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pkm_events_lookup
  ON pkm_events(user_id, domain, created_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pkm_events_operation_type_check'
  ) THEN
    ALTER TABLE pkm_events DROP CONSTRAINT pkm_events_operation_type_check;
  END IF;
END $$;

ALTER TABLE pkm_events
  ADD CONSTRAINT pkm_events_operation_type_check
  CHECK (
    operation_type IN (
      'content_write',
      'structure_create',
      'structure_extend',
      'structure_match',
      'manifest_refresh',
      'decision_projection',
      'attribute_inference',
      'segment_repartition',
      'legacy_cutover'
    )
  );

CREATE TABLE IF NOT EXISTS pkm_migration_state (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'awaiting_unlock_repartition',
  source_model TEXT NOT NULL DEFAULT 'world_model',
  legacy_blob_present BOOLEAN NOT NULL DEFAULT FALSE,
  cutover_started_at TIMESTAMPTZ,
  migrated_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pkm_migration_state_status
  ON pkm_migration_state(status);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pkm_migration_state_status_check'
  ) THEN
    ALTER TABLE pkm_migration_state DROP CONSTRAINT pkm_migration_state_status_check;
  END IF;
END $$;

ALTER TABLE pkm_migration_state
  ADD CONSTRAINT pkm_migration_state_status_check
  CHECK (
    status IN (
      'awaiting_unlock_repartition',
      'cutover_in_progress',
      'completed',
      'failed'
    )
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'world_model_index_v2'
  ) THEN
    EXECUTE $sql$
      INSERT INTO pkm_index (
        user_id,
        available_domains,
        domain_summaries,
        computed_tags,
        activity_score,
        last_active_at,
        total_attributes,
        created_at,
        updated_at
      )
      SELECT
        user_id,
        COALESCE(available_domains, ARRAY[]::TEXT[]),
        COALESCE(domain_summaries, '{}'::JSONB),
        COALESCE(computed_tags, ARRAY[]::TEXT[]),
        activity_score,
        last_active_at,
        COALESCE(total_attributes, 0),
        COALESCE(created_at, NOW()),
        COALESCE(updated_at, NOW())
      FROM world_model_index_v2
      ON CONFLICT (user_id) DO UPDATE
      SET
        available_domains = EXCLUDED.available_domains,
        domain_summaries = EXCLUDED.domain_summaries,
        computed_tags = EXCLUDED.computed_tags,
        activity_score = EXCLUDED.activity_score,
        last_active_at = EXCLUDED.last_active_at,
        total_attributes = EXCLUDED.total_attributes,
        updated_at = EXCLUDED.updated_at
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'world_model_domain_blobs'
  ) THEN
    EXECUTE $sql$
      INSERT INTO pkm_blobs (
        user_id,
        domain,
        segment_id,
        ciphertext,
        iv,
        tag,
        algorithm,
        content_revision,
        manifest_revision,
        size_bytes,
        created_at,
        updated_at
      )
      SELECT
        user_id,
        domain,
        'root' AS segment_id,
        encrypted_data_ciphertext,
        encrypted_data_iv,
        encrypted_data_tag,
        COALESCE(algorithm, 'aes-256-gcm'),
        COALESCE(data_version, 1),
        1,
        OCTET_LENGTH(COALESCE(encrypted_data_ciphertext, '')),
        COALESCE(created_at, NOW()),
        COALESCE(updated_at, NOW())
      FROM world_model_domain_blobs
      ON CONFLICT (user_id, domain, segment_id) DO UPDATE
      SET
        ciphertext = EXCLUDED.ciphertext,
        iv = EXCLUDED.iv,
        tag = EXCLUDED.tag,
        algorithm = EXCLUDED.algorithm,
        content_revision = EXCLUDED.content_revision,
        size_bytes = EXCLUDED.size_bytes,
        updated_at = EXCLUDED.updated_at
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'user_domain_manifests'
  ) THEN
    EXECUTE $sql$
      INSERT INTO pkm_manifests (
        user_id,
        domain,
        manifest_version,
        structure_decision,
        summary_projection,
        top_level_scope_paths,
        externalizable_paths,
        segment_ids,
        path_count,
        externalizable_path_count,
        last_structured_at,
        last_content_at,
        created_at,
        updated_at
      )
      SELECT
        user_id,
        domain,
        COALESCE(manifest_version, 1),
        COALESCE(structure_decision, '{}'::JSONB),
        COALESCE(summary_projection, '{}'::JSONB),
        COALESCE(top_level_scope_paths, ARRAY[]::TEXT[]),
        COALESCE(externalizable_paths, ARRAY[]::TEXT[]),
        ARRAY['root']::TEXT[],
        COALESCE(path_count, 0),
        COALESCE(externalizable_path_count, 0),
        COALESCE(last_structured_at, NOW()),
        COALESCE(last_content_at, NOW()),
        COALESCE(created_at, NOW()),
        COALESCE(updated_at, NOW())
      FROM user_domain_manifests
      ON CONFLICT (user_id, domain) DO UPDATE
      SET
        manifest_version = EXCLUDED.manifest_version,
        structure_decision = EXCLUDED.structure_decision,
        summary_projection = EXCLUDED.summary_projection,
        top_level_scope_paths = EXCLUDED.top_level_scope_paths,
        externalizable_paths = EXCLUDED.externalizable_paths,
        segment_ids = EXCLUDED.segment_ids,
        path_count = EXCLUDED.path_count,
        externalizable_path_count = EXCLUDED.externalizable_path_count,
        last_structured_at = EXCLUDED.last_structured_at,
        last_content_at = EXCLUDED.last_content_at,
        updated_at = EXCLUDED.updated_at
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'user_domain_manifest_paths'
  ) THEN
    EXECUTE $sql$
      INSERT INTO pkm_manifest_paths (
        user_id,
        domain,
        json_path,
        parent_path,
        path_type,
        segment_id,
        scope_handle,
        exposure_eligibility,
        consent_label,
        sensitivity_label,
        source_agent,
        created_at,
        updated_at
      )
      SELECT
        user_id,
        domain,
        json_path,
        parent_path,
        COALESCE(path_type, 'leaf'),
        'root' AS segment_id,
        NULL::TEXT AS scope_handle,
        COALESCE(exposure_eligibility, TRUE),
        consent_label,
        sensitivity_label,
        source_agent,
        COALESCE(created_at, NOW()),
        COALESCE(updated_at, NOW())
      FROM user_domain_manifest_paths
      ON CONFLICT (user_id, domain, json_path) DO UPDATE
      SET
        parent_path = EXCLUDED.parent_path,
        path_type = EXCLUDED.path_type,
        segment_id = EXCLUDED.segment_id,
        scope_handle = EXCLUDED.scope_handle,
        exposure_eligibility = EXCLUDED.exposure_eligibility,
        consent_label = EXCLUDED.consent_label,
        sensitivity_label = EXCLUDED.sensitivity_label,
        source_agent = EXCLUDED.source_agent,
        updated_at = EXCLUDED.updated_at
    $sql$;
  END IF;
END $$;

INSERT INTO pkm_scope_registry (
  user_id,
  domain,
  scope_handle,
  scope_label,
  segment_ids,
  sensitivity_tier,
  scope_kind,
  exposure_enabled,
  manifest_version,
  summary_projection,
  created_at,
  updated_at
)
SELECT
  manifests.user_id,
  manifests.domain,
  's_' || SUBSTRING(MD5(manifests.user_id || ':' || manifests.domain || ':' || scope_path) FROM 1 FOR 12) AS scope_handle,
  INITCAP(REPLACE(scope_path, '_', ' ')) AS scope_label,
  ARRAY['root']::TEXT[] AS segment_ids,
  'confidential' AS sensitivity_tier,
  'subtree' AS scope_kind,
  TRUE AS exposure_enabled,
  manifests.manifest_version,
  JSONB_BUILD_OBJECT(
    'top_level_scope_path', scope_path,
    'storage_mode', 'root'
  ) AS summary_projection,
  NOW(),
  NOW()
FROM pkm_manifests AS manifests
CROSS JOIN LATERAL UNNEST(COALESCE(manifests.top_level_scope_paths, ARRAY[]::TEXT[])) AS scope_path
ON CONFLICT (user_id, domain, scope_handle) DO UPDATE
SET
  scope_label = EXCLUDED.scope_label,
  segment_ids = EXCLUDED.segment_ids,
  manifest_version = EXCLUDED.manifest_version,
  summary_projection = EXCLUDED.summary_projection,
  updated_at = EXCLUDED.updated_at;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'world_model_mutation_events'
  ) THEN
    EXECUTE $sql$
      INSERT INTO pkm_events (
        user_id,
        domain,
        operation_type,
        segment_ids,
        path_set,
        source_agent,
        confidence,
        prior_manifest_version,
        new_manifest_version,
        metadata,
        created_at
      )
      SELECT
        user_id,
        domain,
        operation_type,
        ARRAY[]::TEXT[],
        COALESCE(path_set, '[]'::JSONB),
        source_agent,
        confidence,
        prior_manifest_version,
        new_manifest_version,
        COALESCE(metadata, '{}'::JSONB),
        COALESCE(created_at, NOW())
      FROM world_model_mutation_events
      ON CONFLICT DO NOTHING
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'world_model_data'
  ) THEN
    EXECUTE $sql$
      INSERT INTO pkm_migration_state (
        user_id,
        status,
        source_model,
        legacy_blob_present,
        created_at,
        updated_at
      )
      SELECT
        legacy.user_id,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM pkm_blobs blobs
            WHERE blobs.user_id = legacy.user_id
          ) THEN 'completed'
          ELSE 'awaiting_unlock_repartition'
        END AS status,
        'world_model' AS source_model,
        TRUE AS legacy_blob_present,
        NOW(),
        NOW()
      FROM world_model_data AS legacy
      ON CONFLICT (user_id) DO UPDATE
      SET
        status = EXCLUDED.status,
        source_model = EXCLUDED.source_model,
        legacy_blob_present = EXCLUDED.legacy_blob_present,
        updated_at = EXCLUDED.updated_at
    $sql$;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION update_pkm_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_pkm_index_timestamp ON pkm_index;
CREATE TRIGGER trigger_update_pkm_index_timestamp
  BEFORE UPDATE ON pkm_index
  FOR EACH ROW
  EXECUTE FUNCTION update_pkm_updated_at();

DROP TRIGGER IF EXISTS trigger_update_pkm_blobs_timestamp ON pkm_blobs;
CREATE TRIGGER trigger_update_pkm_blobs_timestamp
  BEFORE UPDATE ON pkm_blobs
  FOR EACH ROW
  EXECUTE FUNCTION update_pkm_updated_at();

DROP TRIGGER IF EXISTS trigger_update_pkm_manifests_timestamp ON pkm_manifests;
CREATE TRIGGER trigger_update_pkm_manifests_timestamp
  BEFORE UPDATE ON pkm_manifests
  FOR EACH ROW
  EXECUTE FUNCTION update_pkm_updated_at();

DROP TRIGGER IF EXISTS trigger_update_pkm_manifest_paths_timestamp ON pkm_manifest_paths;
CREATE TRIGGER trigger_update_pkm_manifest_paths_timestamp
  BEFORE UPDATE ON pkm_manifest_paths
  FOR EACH ROW
  EXECUTE FUNCTION update_pkm_updated_at();

DROP TRIGGER IF EXISTS trigger_update_pkm_scope_registry_timestamp ON pkm_scope_registry;
CREATE TRIGGER trigger_update_pkm_scope_registry_timestamp
  BEFORE UPDATE ON pkm_scope_registry
  FOR EACH ROW
  EXECUTE FUNCTION update_pkm_updated_at();

DROP TRIGGER IF EXISTS trigger_update_pkm_migration_state_timestamp ON pkm_migration_state;
CREATE TRIGGER trigger_update_pkm_migration_state_timestamp
  BEFORE UPDATE ON pkm_migration_state
  FOR EACH ROW
  EXECUTE FUNCTION update_pkm_updated_at();

COMMIT;
