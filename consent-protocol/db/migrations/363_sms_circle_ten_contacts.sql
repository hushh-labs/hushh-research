BEGIN;

-- member_limit includes the owner. Give existing SMS Circles room for ten
-- contacts without touching ordinary or Trusted Circles or removing members.
UPDATE one_location_circles
SET member_limit = 11, updated_at = NOW()
WHERE system_kind = 'sms'
  AND is_system
  AND status = 'active'
  AND member_limit = 10;

COMMIT;
