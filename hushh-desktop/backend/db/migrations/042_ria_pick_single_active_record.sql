WITH ranked_uploads AS (
  SELECT
    id,
    ria_profile_id,
    ROW_NUMBER() OVER (
      PARTITION BY ria_profile_id
      ORDER BY
        CASE WHEN status = 'active' THEN 0 ELSE 1 END ASC,
        COALESCE(activated_at, updated_at, created_at) DESC,
        created_at DESC,
        id DESC
    ) AS row_rank
  FROM ria_pick_uploads
),
duplicate_uploads AS (
  SELECT id
  FROM ranked_uploads
  WHERE row_rank > 1
)
DELETE FROM ria_pick_uploads doomed
USING duplicate_uploads
WHERE doomed.id = duplicate_uploads.id;

UPDATE ria_pick_uploads
SET
  status = 'active',
  updated_at = NOW(),
  activated_at = COALESCE(activated_at, NOW())
WHERE status <> 'active';

DROP INDEX IF EXISTS uq_ria_pick_uploads_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ria_pick_uploads_profile_single
  ON ria_pick_uploads(ria_profile_id);
