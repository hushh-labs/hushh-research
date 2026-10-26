-- Disable legacy publication for owner OFF before an application rollback. Retain the owner
-- preference and all private evidence, so an explicit OFF is never forgotten.
BEGIN;
UPDATE drive_packet_heads h SET public_summary_enabled=FALSE
FROM drive_live_preferences p
WHERE h.user_id=p.user_id AND NOT p.financial_summary_enabled
  AND h.packet_kind='provider_discovery' AND h.category='financial'
  AND h.public_summary_enabled;
-- Keep the compatible columns and bridge: an old API must not republish a
-- retained owner OFF after rollback. Removing that guard is a later contract
-- migration after every old reader/writer is retired.
COMMIT;
