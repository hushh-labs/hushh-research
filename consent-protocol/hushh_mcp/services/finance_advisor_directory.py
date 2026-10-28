"""Connection-scoped Finance advisor candidates; final authority remains the grant service."""

from hushh_mcp.services.ria_iam_service import RIAIAMService
from hushh_mcp.services.ria_status import RIA_VERIFIED_STATUS_SQL

LOCATION_RIA_ANNOTATION_SQL = f"""EXISTS (
  SELECT 1 FROM ria_profiles ria_annotation
  WHERE ria_annotation.user_id = identity.user_id AND {RIA_VERIFIED_STATUS_SQL}
)"""
FINANCE_ADVISOR_ANNOTATION_SQL = """(EXISTS (
  SELECT 1 FROM ria_profiles finance_ria WHERE finance_ria.user_id = identity.user_id
    AND LOWER(BTRIM(COALESCE(to_jsonb(finance_ria)->>'advisory_status', finance_ria.verification_status, 'draft'))) = ANY(:finance_verified_statuses)
) AND EXISTS (
  SELECT 1 FROM connections finance_connection WHERE finance_connection.status = 'active'
    AND finance_connection.user_a_id = LEAST(:owner_user_id, identity.user_id)
    AND finance_connection.user_b_id = GREATEST(:owner_user_id, identity.user_id)
))"""


def finance_advisor_statuses():
    return sorted(RIAIAMService._RIA_VERIFIED_STATUSES)
