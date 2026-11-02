-- A real owner may already have a thirty-character account identity and a
-- notification checkpoint admitted by 445. Reverting would block that owner.
DO $$ BEGIN
 RAISE EXCEPTION 'GCP notification account admission requires forward recovery; do not restore the prior 29-character limit';
END $$;
