BEGIN;

-- Lower only future room. Existing members, including an eleventh member,
-- remain in place if the backend is rolled back.
UPDATE one_location_circles
SET member_limit = 10, updated_at = NOW()
WHERE system_kind = 'sms'
  AND is_system
  AND status = 'active'
  AND member_limit = 11;

COMMIT;
