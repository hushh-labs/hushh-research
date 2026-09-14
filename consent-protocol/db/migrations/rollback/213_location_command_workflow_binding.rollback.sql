BEGIN;
-- Application rollback is additive-schema compatible. Deliberately retain the
-- nullable locator and widened check: removing either would destroy receipts
-- or make a consumed workflow appear replayable to a later forward release.
-- Existing action/screen rows and all indexes retain their previous behavior.
-- The previous command client cannot create workflow plans; no conversion of
-- workflow receipts into action or screen receipts is permitted on rollback.
SELECT 1;
COMMIT;
