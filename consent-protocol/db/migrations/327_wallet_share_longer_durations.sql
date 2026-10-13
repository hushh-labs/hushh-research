-- Preserve existing short shares and permit the new one/two-hour options.
BEGIN;
ALTER TABLE wallet_card_share_requests DROP CONSTRAINT wallet_card_share_requests_duration_minutes_check;
ALTER TABLE wallet_card_share_requests ADD CONSTRAINT wallet_card_share_requests_duration_minutes_check CHECK (duration_minutes IN (5,10,15,60,120));
ALTER TABLE wallet_profile_share_requests DROP CONSTRAINT wallet_profile_share_requests_duration_minutes_check;
ALTER TABLE wallet_profile_share_requests ADD CONSTRAINT wallet_profile_share_requests_duration_minutes_check CHECK (duration_minutes IN (5,10,15,60,120));
ALTER TABLE wallet_card_access_grants DROP CONSTRAINT wallet_card_access_grants_check1;
ALTER TABLE wallet_card_access_grants ADD CONSTRAINT wallet_card_access_grants_check1
 CHECK (expires_at-created_at IN (interval '5 minutes',interval '10 minutes',interval '15 minutes',interval '1 hour',interval '2 hours'));
ALTER TABLE wallet_profile_access_grants DROP CONSTRAINT wallet_profile_access_grants_check1;
ALTER TABLE wallet_profile_access_grants ADD CONSTRAINT wallet_profile_access_grants_check1
 CHECK (expires_at-created_at IN (interval '5 minutes',interval '10 minutes',interval '15 minutes',interval '1 hour',interval '2 hours'));
COMMIT;
