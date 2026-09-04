-- Reverse 167: stop pushing referral changes.
--
-- Symmetric and safe. Dropping the triggers removes the doorbell, nothing else:
-- no row changes, and the Referrals tab keeps its polling fallback, so it
-- degrades from "updates as it happens" to "updates within thirty seconds"
-- rather than to a stale screen.

BEGIN;

DROP TRIGGER IF EXISTS one_agent_engagement_sessions_notify ON one_agent_engagement_sessions;
DROP TRIGGER IF EXISTS one_referral_relationships_notify ON one_referral_relationships;
DROP FUNCTION IF EXISTS one_agent_engagement_session_notify();
DROP FUNCTION IF EXISTS one_referral_relationship_notify();

-- The lookup index is left in place: the summary reads by referred user too,
-- and dropping a useful index is not part of reversing a notification.

COMMIT;
