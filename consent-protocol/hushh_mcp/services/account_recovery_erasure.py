"""Bounded recovery erasure queries; the caller owns transaction and authority."""

from sqlalchemy import text
from sqlalchemy.sql.elements import TextClause


def recovery_erasure_queries() -> dict[str, TextClause]:
    return {
        "pkm_domain_revision_segments": text(
            """
                WITH batch AS MATERIALIZED (
                  SELECT segments.ctid
                  FROM pkm_domain_revision_segments AS segments
                  JOIN pkm_domain_revisions AS revisions USING (revision_id)
                  WHERE revisions.user_id = :user_id
                    AND (CAST(:after_revision_id AS UUID) IS NULL OR
                      revisions.revision_id >= CAST(:after_revision_id AS UUID))
                    AND (CAST(:after_revision_id AS UUID) IS NULL OR
                      (segments.revision_id, segments.segment_id) >
                      (CAST(:after_revision_id AS UUID), :after_segment_id))
                  ORDER BY segments.revision_id, segments.segment_id
                  LIMIT 100
                  FOR UPDATE OF segments
                ), deleted AS (
                  DELETE FROM pkm_domain_revision_segments AS segments
                  USING batch WHERE segments.ctid = batch.ctid
                  RETURNING segments.revision_id, segments.segment_id
                )
                SELECT revision_id, segment_id FROM deleted
                ORDER BY revision_id, segment_id
                """
        ),
        "pkm_domain_revisions": text(
            """
                WITH batch AS MATERIALIZED (
                  SELECT revision_id FROM pkm_domain_revisions
                  WHERE user_id = :user_id
                    AND (CAST(:after_revision_id AS UUID) IS NULL OR
                      revision_id > CAST(:after_revision_id AS UUID))
                  ORDER BY revision_id
                  LIMIT 100
                  FOR UPDATE
                ), deleted AS (
                  DELETE FROM pkm_domain_revisions AS revisions
                  USING batch WHERE revisions.revision_id = batch.revision_id
                  RETURNING revisions.revision_id
                )
                SELECT revision_id, '' AS segment_id FROM deleted ORDER BY revision_id
                """
        ),
    }
