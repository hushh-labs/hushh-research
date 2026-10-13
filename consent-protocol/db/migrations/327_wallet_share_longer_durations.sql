-- Preserve existing short shares and permit the new one/two-hour options.
BEGIN;
ALTER TABLE wallet_card_share_requests DROP CONSTRAINT wallet_card_share_requests_duration_minutes_check;
ALTER TABLE wallet_card_share_requests ADD CONSTRAINT wallet_card_share_requests_duration_minutes_check CHECK (duration_minutes IN (5,10,15,60,120));
ALTER TABLE wallet_profile_share_requests DROP CONSTRAINT wallet_profile_share_requests_duration_minutes_check;
ALTER TABLE wallet_profile_share_requests ADD CONSTRAINT wallet_profile_share_requests_duration_minutes_check CHECK (duration_minutes IN (5,10,15,60,120));
COMMIT;
